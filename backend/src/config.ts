import { ARC, DEPLOY_BLOCK } from '@predex-pump/shared';

const DEFAULT_DATABASE_URL =
  'postgresql://predex:predex@localhost:5432/predex_pump?schema=public';

function positiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, received ${value}`);
  }
  return parsed;
}

export interface RuntimeConfig {
  databaseUrl: string;
  rpcUrl: string;
  deployBlock: number;
  blockChunk: number;
  pollMs: number;
  apiHost: string;
  apiPort: number;
  databasePoolSize: number;
  databasePoolTimeoutSeconds: number;
}

export function loadRuntimeConfig(): RuntimeConfig {
  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  // Prisma reads this variable itself, so also set the local default in-process.
  process.env.DATABASE_URL ??= databaseUrl;

  const apiPort = positiveInteger('API_PORT', 3_001);
  if (apiPort > 65_535) {
    throw new Error(`API_PORT must be at most 65535, received ${apiPort}`);
  }

  return {
    databaseUrl,
    rpcUrl: process.env.ARC_RPC_URL ?? ARC.rpcUrls[0],
    deployBlock: DEPLOY_BLOCK,
    blockChunk: positiveInteger('INDEXER_BLOCK_CHUNK', 2_000),
    pollMs: positiveInteger('INDEXER_POLL_MS', 2_000),
    apiHost: process.env.API_HOST ?? '0.0.0.0',
    apiPort,
    databasePoolSize: positiveInteger('DATABASE_POOL_SIZE', 32),
    databasePoolTimeoutSeconds: positiveInteger('DATABASE_POOL_TIMEOUT_SECONDS', 10),
  };
}
