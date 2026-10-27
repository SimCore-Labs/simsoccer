import { createHash, randomBytes } from 'node:crypto';
import Decimal from 'decimal.js';
import { PublicKey } from '@solana/web3.js';
import { and, asc, eq, gt, inArray, ne } from 'drizzle-orm';
import { db } from '../db';
import {
  solanaPaymentAttempts,
  solanaPaymentOrders,
  users,
  walletTransactions,
  wallets,
} from '../db/schema';
import { env } from '../config/env';
import { calculateLamports, getSolUsdQuote } from './price-service';
import { assertSolanaRpc, getFinalizedTransaction, getLatestBlockhash, getReferenceSignatures } from './solana-rpc';

const PAYMENT_PACKAGES = [
  { id: 'credits-1000', credits: 1_000, usdCents: 100 },
  { id: 'credits-5000', credits: 5_000, usdCents: 500 },
] as const;
const CUSTOM_TOP_UP = {
  minCredits: 1_000,
  maxCredits: 100_000,
  stepCredits: 10,
  creditsPerUsd: 1_000,
} as const;
const MAX_RECOVERY_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_CANDIDATES_PER_CHECK = 3;
const DecimalValue = Decimal.clone({ precision: 40 });
let lastReconciledOrderId: string | null = null;

export type SolanaPaymentOrder = typeof solanaPaymentOrders.$inferSelect;
export type SolanaPaymentStatus =
  | 'PENDING'
  | 'SUBMITTED'
  | 'CONFIRMING'
  | 'VERIFIED'
  | 'CREDITED'
  | 'EXPIRED'
  | 'FAILED'
  | 'UNDERPAID'
  | 'OVERPAID'
  | 'REQUIRES_REVIEW';

export class SolanaPaymentError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'SolanaPaymentError';
  }
}

type PaymentSelection = {
  id: string;
  credits: number;
  usdCents: number;
};

export function resolveSolanaPaymentSelection(
  packageId: string,
  customCreditAmount?: number,
): PaymentSelection {
  const preset = PAYMENT_PACKAGES.find((item) => item.id === packageId);
  if (preset) {
    if (customCreditAmount !== undefined) {
      throw new SolanaPaymentError('Choose either a package or a custom credit amount.', 400, 'INVALID_CREDIT_AMOUNT');
    }
    return preset;
  }
  if (packageId !== 'custom'
    || typeof customCreditAmount !== 'number'
    || !Number.isSafeInteger(customCreditAmount)
    || customCreditAmount < CUSTOM_TOP_UP.minCredits
    || customCreditAmount > CUSTOM_TOP_UP.maxCredits
    || customCreditAmount % CUSTOM_TOP_UP.stepCredits !== 0) {
    throw new SolanaPaymentError('Enter a valid custom SIM Credits amount.', 400, 'INVALID_CREDIT_AMOUNT');
  }
  return {
    id: 'custom',
    credits: customCreditAmount,
    usdCents: customCreditAmount * 100 / CUSTOM_TOP_UP.creditsPerUsd,
  };
}

function assertPaymentsConfigured(): string {
  if (!env.SOLANA_PAYMENTS_ENABLED) {
    throw new SolanaPaymentError('Credit purchases are not available.', 503, 'PAYMENTS_DISABLED');
  }
  const treasury = env.SOLANA_TREASURY_ADDRESS;
  if (!treasury) {
    throw new SolanaPaymentError('Credit purchases are not configured.', 503, 'PAYMENTS_NOT_CONFIGURED');
  }
  try {
    return new PublicKey(treasury).toBase58();
  } catch {
    throw new SolanaPaymentError('The configured Solana treasury address is invalid.', 503, 'INVALID_TREASURY');
  }
}

function normalizeAddress(value: string, fieldName: string): string {
  try {
    return new PublicKey(value).toBase58();
  } catch {
    throw new SolanaPaymentError(`Enter a valid Solana ${fieldName}.`, 400, 'INVALID_SOLANA_ADDRESS');
  }
}

export function getSolanaPaymentConfig() {
  const enabled = env.SOLANA_PAYMENTS_ENABLED;
  let treasuryAddress: string | null = null;
  if (enabled) treasuryAddress = assertPaymentsConfigured();
  return {
    enabled,
    cluster: env.SOLANA_CLUSTER,
    treasuryAddress,
    packages: PAYMENT_PACKAGES.map((item) => ({
      id: item.id,
      credits: item.credits,
      usdCents: item.usdCents,
    })),
    customTopUp: CUSTOM_TOP_UP,
  };
}

export async function getSolanaPaymentBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  assertPaymentsConfigured();
  return getLatestBlockhash();
}

export async function createSolanaPaymentOrder(
  userId: string,
  packageId: string,
  payerAddressInput: string,
  idempotencyInput: string,
  customCreditAmount?: number,
): Promise<SolanaPaymentOrder> {
  const treasuryAddress = assertPaymentsConfigured();
  const selectedPackage = resolveSolanaPaymentSelection(packageId, customCreditAmount);
  const payerAddress = normalizeAddress(payerAddressInput, 'wallet address');
  if (payerAddress === treasuryAddress) {
    throw new SolanaPaymentError('The connected wallet cannot be the configured receiving wallet.', 400, 'INVALID_PAYER');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyInput)) {
    throw new SolanaPaymentError('A valid order idempotency key is required.', 400, 'INVALID_IDEMPOTENCY_KEY');
  }
  const idempotencyKey = createHash('sha256').update(`${userId}:${idempotencyInput}`).digest('hex');
  const [previousOrder] = await db.select().from(solanaPaymentOrders)
    .where(and(
      eq(solanaPaymentOrders.idempotencyKey, idempotencyKey),
      eq(solanaPaymentOrders.userId, userId),
    ))
    .limit(1);
  if (previousOrder) {
    if (previousOrder.packageId !== selectedPackage.id
      || Number(previousOrder.creditAmount) !== selectedPackage.credits
      || previousOrder.payerAddress !== payerAddress
      || previousOrder.network !== env.SOLANA_CLUSTER) {
      throw new SolanaPaymentError('That request key was already used for a different payment order.', 409, 'IDEMPOTENCY_KEY_REUSED');
    }
    return previousOrder;
  }

  const [quote] = await Promise.all([getSolUsdQuote(), assertSolanaRpc()]);
  const expectedLamports = calculateLamports(selectedPackage.usdCents, quote.priceUsd);
  if (BigInt(expectedLamports) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SolanaPaymentError('This amount cannot be represented safely in a Solana transaction.', 503, 'PACKAGE_AMOUNT_UNSUPPORTED');
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + env.SOLANA_PAYMENT_ORDER_TTL_SECONDS * 1000);
  const referenceAddress = new PublicKey(randomBytes(32)).toBase58();

  try {
    return await db.transaction(async (tx) => {
      const [account] = await tx.select({
        accountStatus: users.accountStatus,
        isEmailVerified: users.isEmailVerified,
      }).from(users)
        .where(eq(users.id, userId))
        .for('update')
        .limit(1);
      if (!account?.isEmailVerified || account.accountStatus !== 'ACTIVE') {
        throw new SolanaPaymentError('This account is not available for credit purchases.', 403, 'ACCOUNT_UNAVAILABLE');
      }

      const [existingOrder] = await tx.select().from(solanaPaymentOrders)
        .where(eq(solanaPaymentOrders.idempotencyKey, idempotencyKey))
        .limit(1);
      if (existingOrder) {
        if (existingOrder.packageId !== selectedPackage.id
          || Number(existingOrder.creditAmount) !== selectedPackage.credits
          || existingOrder.payerAddress !== payerAddress
          || existingOrder.network !== env.SOLANA_CLUSTER) {
          throw new SolanaPaymentError('That request key was already used for a different payment order.', 409, 'IDEMPOTENCY_KEY_REUSED');
        }
        return existingOrder;
      }

      const [order] = await tx.insert(solanaPaymentOrders).values({
        userId,
        idempotencyKey,
        packageId: selectedPackage.id,
        creditAmount: String(selectedPackage.credits),
        usdCents: selectedPackage.usdCents,
        solUsdPrice: quote.priceUsd,
        priceProvider: quote.provider,
        priceObservedAt: quote.observedAt,
        priceFetchedAt: quote.fetchedAt,
        expectedLamports,
        network: env.SOLANA_CLUSTER,
        treasuryAddress,
        payerAddress,
        referenceAddress,
        status: 'PENDING',
        expiresAt,
        createdAt: now,
        updatedAt: now,
      }).returning();
      return order;
    });
  } catch (error) {
    if (error instanceof SolanaPaymentError) throw error;
    const [existingOrder] = await db.select().from(solanaPaymentOrders)
      .where(eq(solanaPaymentOrders.idempotencyKey, idempotencyKey))
      .limit(1);
    if (existingOrder
      && existingOrder.packageId === selectedPackage.id
      && Number(existingOrder.creditAmount) === selectedPackage.credits
      && existingOrder.payerAddress === payerAddress) return existingOrder;
    console.error('Solana payment order creation failed:', error);
    throw new SolanaPaymentError('A payment order could not be created. Try again.', 503, 'ORDER_CREATION_FAILED');
  }
}

export async function getSolanaPaymentOrder(userId: string, orderId: string): Promise<SolanaPaymentOrder> {
  const [order] = await db.select().from(solanaPaymentOrders)
    .where(and(eq(solanaPaymentOrders.id, orderId), eq(solanaPaymentOrders.userId, userId)))
    .limit(1);
  if (!order) throw new SolanaPaymentError('Payment order not found.', 404, 'ORDER_NOT_FOUND');
  return order;
}

export async function submitSolanaPaymentSignature(
  userId: string,
  orderId: string,
  signature: string,
): Promise<SolanaPaymentOrder> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)) {
    throw new SolanaPaymentError('Enter a valid Solana transaction signature.', 400, 'INVALID_SIGNATURE');
  }

  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(solanaPaymentOrders)
      .where(and(eq(solanaPaymentOrders.id, orderId), eq(solanaPaymentOrders.userId, userId)))
      .for('update')
      .limit(1);
    if (!order) throw new SolanaPaymentError('Payment order not found.', 404, 'ORDER_NOT_FOUND');
    if (order.network !== env.SOLANA_CLUSTER) {
      throw new SolanaPaymentError('This payment order belongs to a different Solana network.', 409, 'ORDER_NETWORK_MISMATCH');
    }
    if (order.status === 'CREDITED') return order;

    const [signatureAttempt] = await tx.select({ orderId: solanaPaymentAttempts.orderId })
      .from(solanaPaymentAttempts)
      .where(eq(solanaPaymentAttempts.signature, signature))
      .limit(1);
    if (signatureAttempt && signatureAttempt.orderId !== order.id) {
      throw new SolanaPaymentError('That transaction has already been used.', 409, 'SIGNATURE_ALREADY_USED');
    }
    if (signatureAttempt) return order;

    const [updated] = await tx.update(solanaPaymentOrders)
      .set({
        transactionSignature: signature,
        status: new Date() >= order.expiresAt ? 'EXPIRED' : 'SUBMITTED',
        updatedAt: new Date(),
      })
      .where(eq(solanaPaymentOrders.id, order.id))
      .returning();
    return updated;
  });
}

type ParsedTransfer = {
  source: string;
  destination: string;
  lamports: bigint;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

export function inspectPaymentTransaction(
  rawTransaction: unknown,
  order: Pick<SolanaPaymentOrder, 'referenceAddress' | 'payerAddress' | 'treasuryAddress'>,
  expectedSignature: string,
): { blockTime: number | null; lamports: bigint } | { failure: 'FAILED' | 'REQUIRES_REVIEW'; details: string; blockTime: number | null } {
  const transaction = toRecord(rawTransaction);
  const transactionData = toRecord(transaction?.transaction);
  const message = toRecord(transactionData?.message);
  const meta = toRecord(transaction?.meta);
  const signatures = transactionData?.signatures;
  const accountKeys = message?.accountKeys;
  const instructions = message?.instructions;
  const blockTime = typeof transaction?.blockTime === 'number' && Number.isFinite(transaction.blockTime)
    ? transaction.blockTime
    : null;

  if (!transaction || !transactionData || !message || !meta || !Array.isArray(signatures)
    || !Array.isArray(accountKeys) || !Array.isArray(instructions)) {
    return { failure: 'REQUIRES_REVIEW', details: 'The finalized transaction response was incomplete.', blockTime };
  }
  if (!signatures.includes(expectedSignature)) {
    return { failure: 'REQUIRES_REVIEW', details: 'The reported signature did not match the transaction.', blockTime };
  }
  if (meta.err !== null) {
    return { failure: 'FAILED', details: 'The Solana transaction failed during execution.', blockTime };
  }

  const parsedKeys = accountKeys.map((key) => {
    const record = toRecord(key);
    const pubkey = typeof key === 'string' ? key : record?.pubkey;
    return {
      pubkey: typeof pubkey === 'string' ? pubkey : '',
      signer: record?.signer === true,
    };
  });
  if (!parsedKeys.some((key) => key.pubkey === order.referenceAddress)) {
    return { failure: 'REQUIRES_REVIEW', details: 'The transaction did not include this order reference.', blockTime };
  }
  if (!parsedKeys.some((key) => key.pubkey === order.payerAddress && key.signer)) {
    return { failure: 'REQUIRES_REVIEW', details: 'The expected payer did not sign the transaction.', blockTime };
  }

  const transfers: ParsedTransfer[] = [];
  for (const rawInstruction of instructions) {
    const instruction = toRecord(rawInstruction);
    if (instruction?.program === 'computeBudget') continue;
    if (instruction?.program !== 'system') {
      return { failure: 'REQUIRES_REVIEW', details: 'The transaction included an unexpected program instruction.', blockTime };
    }
    const parsed = toRecord(instruction?.parsed);
    const transfer = toRecord(parsed?.info);
    if (parsed?.type !== 'transfer' || !transfer) {
      return { failure: 'REQUIRES_REVIEW', details: 'The transaction included an unexpected System Program instruction.', blockTime };
    }
    if (typeof transfer.source !== 'string' || typeof transfer.destination !== 'string') continue;
    if (transfer.source !== order.payerAddress || transfer.destination !== order.treasuryAddress) {
      return { failure: 'REQUIRES_REVIEW', details: 'The transaction contains a SOL transfer outside this payment order.', blockTime };
    }
    try {
      const lamports = BigInt(String(transfer.lamports));
      if (lamports > 0n) transfers.push({ source: transfer.source, destination: transfer.destination, lamports });
    } catch {
      return { failure: 'REQUIRES_REVIEW', details: 'The transaction contained an invalid SOL transfer amount.', blockTime };
    }
  }
  if (transfers.length !== 1) {
    return { failure: 'REQUIRES_REVIEW', details: 'The transaction must contain exactly one SOL transfer for this order.', blockTime };
  }
  return { blockTime, lamports: transfers[0].lamports };
}

async function setOrderStatus(
  order: SolanaPaymentOrder,
  status: SolanaPaymentStatus,
  signature: string | null,
  reason: string | null,
): Promise<void> {
  await db.update(solanaPaymentOrders)
    .set({
      status,
      transactionSignature: signature ?? order.transactionSignature,
      reviewReason: reason,
      updatedAt: new Date(),
    })
    .where(and(eq(solanaPaymentOrders.id, order.id), ne(solanaPaymentOrders.status, 'CREDITED')));
}

async function recordAttempt(
  order: SolanaPaymentOrder,
  signature: string,
  status: SolanaPaymentStatus,
  actualLamports: string | null,
  blockTime: number | null,
  details: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [lockedOrder] = await tx.select().from(solanaPaymentOrders)
      .where(eq(solanaPaymentOrders.id, order.id))
      .for('update')
      .limit(1);
    if (!lockedOrder || lockedOrder.status === 'CREDITED') return;

    const [existingAttempt] = await tx.select().from(solanaPaymentAttempts)
      .where(eq(solanaPaymentAttempts.signature, signature))
      .limit(1);
    if (existingAttempt) {
      if (existingAttempt.orderId !== lockedOrder.id) {
        await tx.update(solanaPaymentOrders).set({
          status: 'REQUIRES_REVIEW',
          reviewReason: 'A transaction signature associated with this reference was already used for another order.',
          updatedAt: new Date(),
        }).where(eq(solanaPaymentOrders.id, lockedOrder.id));
      }
      return;
    }

    const attemptStatus = status === 'CREDITED' ? 'VERIFIED' : status;
    await tx.insert(solanaPaymentAttempts).values({
      orderId: lockedOrder.id,
      signature,
      status: attemptStatus,
      actualLamports,
      transactionBlockTime: blockTime === null ? null : new Date(blockTime * 1000),
      details,
    });

    if (status === 'CREDITED') {
      const [wallet] = await tx.select().from(wallets)
        .where(eq(wallets.userId, lockedOrder.userId))
        .for('update')
        .limit(1);
      if (!wallet) throw new Error(`Wallet missing for verified Solana payment order ${lockedOrder.id}.`);

      const balanceBefore = new DecimalValue(wallet.balance);
      const credit = new DecimalValue(lockedOrder.creditAmount);
      const balanceAfter = balanceBefore.plus(credit).toDecimalPlaces(2, DecimalValue.ROUND_HALF_UP);
      await tx.update(wallets)
        .set({ balance: balanceAfter.toFixed(2), updatedAt: new Date() })
        .where(eq(wallets.id, wallet.id));

      const [ledgerEntry] = await tx.insert(walletTransactions).values({
        walletId: wallet.id,
        type: 'SOLANA_PURCHASE_CREDIT',
        amount: credit.toFixed(2),
        balanceBefore: balanceBefore.toFixed(2),
        balanceAfter: balanceAfter.toFixed(2),
        referenceType: 'SOLANA_PAYMENT',
        referenceId: lockedOrder.id,
        idempotencyKey: `solana-payment:${lockedOrder.id}`,
      }).onConflictDoNothing().returning({ id: walletTransactions.id });
      if (!ledgerEntry) throw new Error(`Solana payment ledger entry already exists for order ${lockedOrder.id}.`);

      await tx.update(solanaPaymentOrders).set({
        status: 'CREDITED',
        transactionSignature: signature,
        reviewReason: null,
        verifiedAt: new Date(),
        creditedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(solanaPaymentOrders.id, lockedOrder.id));
      return;
    }

    await tx.update(solanaPaymentOrders).set({
      status,
      transactionSignature: signature,
      reviewReason: details,
      updatedAt: new Date(),
    }).where(eq(solanaPaymentOrders.id, lockedOrder.id));
  });
}

async function verifyCandidate(order: SolanaPaymentOrder, signature: string): Promise<void> {
  const rawTransaction = await getFinalizedTransaction(signature);
  if (!rawTransaction) {
    await setOrderStatus(order, 'CONFIRMING', signature, null);
    return;
  }

  const inspected = inspectPaymentTransaction(rawTransaction, order, signature);
  if ('failure' in inspected) {
    await recordAttempt(order, signature, inspected.failure, null, inspected.blockTime, inspected.details);
    return;
  }

  const actual = inspected.lamports;
  const expected = BigInt(order.expectedLamports);
  const blockTimeMs = inspected.blockTime === null ? null : inspected.blockTime * 1000;
  const timely = blockTimeMs !== null
    && blockTimeMs >= order.createdAt.getTime() - 30_000
    && blockTimeMs <= order.expiresAt.getTime();
  if (!timely) {
    await recordAttempt(order, signature, 'REQUIRES_REVIEW', actual.toString(), inspected.blockTime, 'Payment was not finalized within the order validity window.');
    return;
  }
  if (actual < expected) {
    await recordAttempt(order, signature, 'UNDERPAID', actual.toString(), inspected.blockTime, 'Received fewer lamports than the payment order requires.');
    return;
  }
  if (actual > expected) {
    await recordAttempt(order, signature, 'OVERPAID', actual.toString(), inspected.blockTime, 'Received more lamports than the payment order requires.');
    return;
  }

  await recordAttempt(order, signature, 'CREDITED', actual.toString(), inspected.blockTime, null);
}

export async function reconcileSolanaPaymentOrder(orderId: string, submittedSignature?: string): Promise<SolanaPaymentOrder> {
  assertPaymentsConfigured();
  const [order] = await db.select().from(solanaPaymentOrders)
    .where(eq(solanaPaymentOrders.id, orderId))
    .limit(1);
  if (!order) throw new SolanaPaymentError('Payment order not found.', 404, 'ORDER_NOT_FOUND');
  if (order.network !== env.SOLANA_CLUSTER) return order;
  if (order.status === 'CREDITED') return order;

  let signatures: string[];
  if (submittedSignature) {
    signatures = [submittedSignature];
  } else {
    const discovered = await getReferenceSignatures(order.referenceAddress);
    signatures = discovered.map((item) => item.signature);
  }

  let candidatesChecked = 0;
  for (const signature of signatures) {
    const [existingAttempt] = await db.select({
      id: solanaPaymentAttempts.id,
      orderId: solanaPaymentAttempts.orderId,
    })
      .from(solanaPaymentAttempts)
      .where(eq(solanaPaymentAttempts.signature, signature))
      .limit(1);
    if (existingAttempt) {
      if (existingAttempt.orderId !== order.id) {
        await setOrderStatus(order, 'REQUIRES_REVIEW', signature, 'The transaction signature has already been associated with another order.');
      }
      continue;
    }
    if (candidatesChecked >= MAX_CANDIDATES_PER_CHECK) break;
    candidatesChecked += 1;
    await verifyCandidate(order, signature);
    const [latest] = await db.select().from(solanaPaymentOrders)
      .where(eq(solanaPaymentOrders.id, order.id))
      .limit(1);
    if (latest?.status === 'CREDITED') return latest;
  }

  if (Date.now() >= order.expiresAt.getTime()) {
    await setOrderStatus(order, 'EXPIRED', order.transactionSignature, 'Order expired before an exact successful payment was finalized.');
  }

  const [latest] = await db.select().from(solanaPaymentOrders)
    .where(eq(solanaPaymentOrders.id, order.id))
    .limit(1);
  return latest ?? order;
}

export async function reconcileRecentSolanaPayments(): Promise<void> {
  if (!env.SOLANA_PAYMENTS_ENABLED) return;
  const recentCutoff = new Date(Date.now() - MAX_RECOVERY_AGE_MS);
  const statuses = inArray(solanaPaymentOrders.status, [
    'PENDING', 'SUBMITTED', 'CONFIRMING', 'EXPIRED', 'FAILED',
    'UNDERPAID', 'OVERPAID', 'REQUIRES_REVIEW',
  ]);
  const createdRecently = gt(solanaPaymentOrders.createdAt, recentCutoff);
  const loadBatch = (afterId: string | null) => db.select({ id: solanaPaymentOrders.id })
    .from(solanaPaymentOrders)
    .where(and(
      statuses,
      createdRecently,
      eq(solanaPaymentOrders.network, env.SOLANA_CLUSTER),
      afterId ? gt(solanaPaymentOrders.id, afterId) : undefined,
    ))
    .orderBy(asc(solanaPaymentOrders.id))
    .limit(25);
  let orders = await loadBatch(lastReconciledOrderId);
  if (orders.length === 0 && lastReconciledOrderId !== null) {
    lastReconciledOrderId = null;
    orders = await loadBatch(null);
  }
  if (orders.length === 0) return;
  lastReconciledOrderId = orders[orders.length - 1].id;

  for (const order of orders) {
    try {
      await reconcileSolanaPaymentOrder(order.id);
    } catch (error) {
      console.error(`Solana payment reconciliation failed for ${order.id}:`, error);
    }
  }
}
