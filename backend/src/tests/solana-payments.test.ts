import assert from 'node:assert/strict';
import { calculateLamports } from '../payments/price-service';
import {
  inspectPaymentTransaction,
  resolveSolanaPaymentSelection,
} from '../payments/solana-payment-service';
import { expectedGenesisHash } from '../payments/solana-rpc';

const payerAddress = '11111111111111111111111111111111';
const treasuryAddress = 'Vote111111111111111111111111111111111111111';
const referenceAddress = 'SysvarRent111111111111111111111111111111111';
const signature = '1'.repeat(88);
const order = { payerAddress, treasuryAddress, referenceAddress };
const validTransaction = {
  blockTime: 1_800_000_000,
  transaction: {
    signatures: [signature],
    message: {
      accountKeys: [
        { pubkey: payerAddress, signer: true },
        { pubkey: treasuryAddress, signer: false },
        { pubkey: referenceAddress, signer: false },
      ],
      instructions: [{
        program: 'system',
        parsed: {
          type: 'transfer',
          info: { source: payerAddress, destination: treasuryAddress, lamports: '25000000' },
        },
      }],
    },
  },
  meta: { err: null },
};

assert.equal(expectedGenesisHash('devnet'), 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
assert.equal(expectedGenesisHash('mainnet-beta'), '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
assert.equal(calculateLamports(100, '200'), '5000000');
assert.equal(calculateLamports(500, '200'), '25000000');
assert.equal(calculateLamports(1, '3'), '3333333');
assert.throws(() => calculateLamports(0, '200'));
assert.throws(() => calculateLamports(100, '0'));

assert.deepEqual(resolveSolanaPaymentSelection('credits-1000'), {
  id: 'credits-1000',
  credits: 1_000,
  usdCents: 100,
});
assert.deepEqual(resolveSolanaPaymentSelection('custom', 1_000), {
  id: 'custom',
  credits: 1_000,
  usdCents: 100,
});
assert.deepEqual(resolveSolanaPaymentSelection('custom', 100_000), {
  id: 'custom',
  credits: 100_000,
  usdCents: 10_000,
});
for (const amount of [undefined, 990, 1_001, 100_010, 1.5]) {
  assert.throws(() => resolveSolanaPaymentSelection('custom', amount));
}
assert.throws(() => resolveSolanaPaymentSelection('credits-1000', 1_000));
assert.throws(() => resolveSolanaPaymentSelection('unknown'));

assert.deepEqual(inspectPaymentTransaction(validTransaction, order, signature), {
  blockTime: 1_800_000_000,
  lamports: 25_000_000n,
});

const wrongReference = structuredClone(validTransaction);
wrongReference.transaction.message.accountKeys.pop();
const referenceResult = inspectPaymentTransaction(wrongReference, order, signature);
assert.ok('failure' in referenceResult);
assert.equal(referenceResult.failure, 'REQUIRES_REVIEW');

const failedTransaction = {
  ...validTransaction,
  meta: { err: { InstructionError: [0, 'InsufficientFunds'] } },
};
const executionResult = inspectPaymentTransaction(failedTransaction, order, signature);
assert.ok('failure' in executionResult);
assert.equal(executionResult.failure, 'FAILED');

const extraTransfer = structuredClone(validTransaction);
extraTransfer.transaction.message.instructions.push({
  program: 'system',
  parsed: {
    type: 'transfer',
    info: { source: payerAddress, destination: 'BPFLoaderUpgradeab1e11111111111111111111111', lamports: '1' },
  },
});
const extraTransferResult = inspectPaymentTransaction(extraTransfer, order, signature);
assert.ok('failure' in extraTransferResult);
assert.equal(extraTransferResult.failure, 'REQUIRES_REVIEW');

console.log('Solana payment quote and verification checks passed');
