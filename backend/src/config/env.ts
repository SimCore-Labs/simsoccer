import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config({ override: true });

const envSchema = z.object({
  PORT: z.string().default('8080').transform((val) => parseInt(val, 10)),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  AUTH_ISSUER: z.string().url().optional(),
  AUTH_JWKS_URL: z.string().url().optional(),
  ADMIN_PIN_PEPPER: z.string().optional(),
  ADMIN_ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),

  MIGRATE_BEFORE_BUILD: z.string().optional().default('false').transform((val) => val === 'true'),
  ALLOW_PRODUCTION_MIGRATIONS: z.string().optional().default('false').transform((val) => val === 'true'),
  ALLOW_WORLD_RESET: z.string().optional().default('false').transform((val) => val === 'true'),
  ALLOW_UNSAFE_DB: z.string().optional().default('false').transform((val) => val === 'true'),
  ALLOW_UNSAFE_SEEDS: z.string().optional().default('false').transform((val) => val === 'true'),

  SOLANA_PAYMENTS_ENABLED: z.enum(['true', 'false']).default('false').transform((val) => val === 'true'),
  SOLANA_CLUSTER: z.enum(['devnet', 'mainnet-beta']).default('devnet'),
  SOLANA_RPC_URL: z.string().url().optional(),
  SOLANA_TREASURY_ADDRESS: z.string().optional(),
  SOLANA_PAYMENT_ORDER_TTL_SECONDS: z.coerce.number().int().min(60).max(1800).default(600),

  TICK_RATE_MS: z.string().default('1000').transform((val) => parseInt(val, 10)),
  MATCH_REAL_DURATION_SECONDS: z.string().default('5400').transform((val) => parseInt(val, 10)),
  SIMULATION_WORKER_CONCURRENCY: z.string().default('30').transform((val) => parseInt(val, 10)),
  MARKET_PREPARATION_BUFFER_SECONDS: z.string().default('120').transform((val) => parseInt(val, 10)),
  FIXTURE_KICKOFF_STAGGER_SECONDS: z.string().default('60').transform((val) => parseInt(val, 10)),
  ROUND_BREAK_SECONDS: z.string().default('600').transform((val) => parseInt(val, 10)),
  SIMULATION_VERSION: z.string().default('1.1.0'),

  TEST_DATABASE_URL: z.string().optional(),
  TEST_REDIS_URL: z.string().optional(),
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error('❌ Invalid environment variables:', _env.error.format());
  throw new Error('Invalid environment variables');
}

if (_env.data.SOLANA_CLUSTER === 'mainnet-beta' && !_env.data.SOLANA_RPC_URL) {
  throw new Error('SOLANA_RPC_URL must be configured for mainnet-beta.');
}

export const env = {
  ..._env.data,
  SOLANA_RPC_URL: _env.data.SOLANA_RPC_URL
    ?? (_env.data.SOLANA_CLUSTER === 'mainnet-beta'
      ? 'https://api.mainnet-beta.solana.com'
      : 'https://api.devnet.solana.com'),
};

if (env.SOLANA_PAYMENTS_ENABLED && !env.SOLANA_TREASURY_ADDRESS) {
  throw new Error('SOLANA_TREASURY_ADDRESS is required when Solana payments are enabled.');
}

if (env.NODE_ENV === 'production' && env.SOLANA_PAYMENTS_ENABLED && env.SOLANA_CLUSTER === 'mainnet-beta') {
  if (new URL(env.SOLANA_RPC_URL).protocol !== 'https:') {
    throw new Error('Production mainnet payments require an HTTPS Solana RPC provider.');
  }
  const rpcHostname = new URL(env.SOLANA_RPC_URL).hostname.toLowerCase();
  if (rpcHostname === 'api.mainnet-beta.solana.com' || rpcHostname === 'api.mainnet.solana.com') {
    console.warn('Production mainnet payments are using Solana’s shared public RPC; expect strict rate limits and no provider SLA.');
  }
}

if (env.NODE_ENV === 'production' && (!env.AUTH_ISSUER || !env.AUTH_JWKS_URL)) {
  throw new Error('Production requires AUTH_ISSUER and AUTH_JWKS_URL.');
}
