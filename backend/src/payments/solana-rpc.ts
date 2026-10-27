import { env } from '../config/env';

const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const RPC_TIMEOUT_MS = 8_000;
let verifiedRpcUrl = '';
let rpcVerifiedAt = 0;

export function expectedGenesisHash(cluster: 'devnet' | 'mainnet-beta'): string {
  return cluster === 'mainnet-beta' ? MAINNET_GENESIS_HASH : DEVNET_GENESIS_HASH;
}

type RpcResponse<T> = {
  result?: T;
  error?: { code: number; message: string };
};

export type SignatureInfo = {
  signature: string;
  err: unknown;
  blockTime: number | null;
};

async function callRpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(env.SOLANA_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'simsoccer-payment', method, params }),
    cache: 'no-store',
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Solana RPC ${method} failed with HTTP ${response.status}.`);

  const payload = await response.json() as RpcResponse<T>;
  if (payload.error) {
    throw new Error(`Solana RPC ${method} failed (${payload.error.code}): ${payload.error.message}`);
  }
  if (payload.result === undefined) throw new Error(`Solana RPC ${method} returned no result.`);
  return payload.result;
}

export async function assertSolanaRpc(): Promise<void> {
  if (verifiedRpcUrl === env.SOLANA_RPC_URL && Date.now() - rpcVerifiedAt < 60_000) return;
  const genesisHash = await callRpc<string>('getGenesisHash', []);
  if (genesisHash !== expectedGenesisHash(env.SOLANA_CLUSTER)) {
    throw new Error(`Configured Solana RPC is not connected to ${env.SOLANA_CLUSTER}.`);
  }
  verifiedRpcUrl = env.SOLANA_RPC_URL;
  rpcVerifiedAt = Date.now();
}

export async function getReferenceSignatures(referenceAddress: string): Promise<SignatureInfo[]> {
  await assertSolanaRpc();
  return callRpc<SignatureInfo[]>('getSignaturesForAddress', [
    referenceAddress,
    { commitment: 'confirmed', limit: 20 },
  ]);
}

export async function getFinalizedTransaction(signature: string): Promise<unknown | null> {
  await assertSolanaRpc();
  return callRpc<unknown | null>('getTransaction', [
    signature,
    { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
  ]);
}

export async function getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  await assertSolanaRpc();
  const response = await callRpc<{
    value?: { blockhash?: unknown; lastValidBlockHeight?: unknown };
  }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const blockhash = response.value?.blockhash;
  const lastValidBlockHeight = response.value?.lastValidBlockHeight;
  if (typeof blockhash !== 'string'
    || typeof lastValidBlockHeight !== 'number'
    || !Number.isSafeInteger(lastValidBlockHeight)) {
    throw new Error('Solana RPC returned an invalid latest blockhash.');
  }
  return { blockhash, lastValidBlockHeight };
}
