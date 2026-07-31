import { ARC, DEPLOY_BLOCK } from '@predex-pump/shared';

const DEFAULT_DATABASE_URL =
  'postgresql://predex:predex@localhost:5432/predex_pump?schema=public';

export const DEFAULT_INDEXER_POLL_MS = 10_000;
export const DEFAULT_INDEXER_CHUNK_DELAY_MS = 200;
export const DEFAULT_INDEXER_STALL_MS = 90_000;

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

function nonNegativeInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, received ${value}`);
  }
  return parsed;
}

export function resolveRpcUrls(
  configuredUrl: string | undefined,
): [string, ...string[]] {
  const explicitUrl = configuredUrl?.trim();
  const candidates = explicitUrl ? [explicitUrl] : [...ARC.rpcUrls];
  const urls = [...new Set(candidates.map((url) => url.trim()).filter(Boolean))];
  const first = urls[0];
  if (first === undefined) throw new Error('At least one Arc RPC URL is required');
  return [first, ...urls.slice(1)];
}

export interface RuntimeConfig {
  databaseUrl: string;
  rpcUrl: string;
  rpcUrls: readonly [string, ...string[]];
  deployBlock: number;
  blockChunk: number;
  pollMs: number;
  chunkDelayMs: number;
  indexerStallMs: number;
  apiHost: string;
  apiPort: number;
  databasePoolSize: number;
  databasePoolTimeoutSeconds: number;
  qdrantUrl: string;
  openAiApiKey: string | undefined;
  dedupTopK: number;
  dedupTimeoutMs: number;
}

export function loadRuntimeConfig(): RuntimeConfig {
  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  // Prisma reads this variable itself, so also set the local default in-process.
  process.env.DATABASE_URL ??= databaseUrl;

  const apiPort = positiveInteger('API_PORT', 3_001);
  if (apiPort > 65_535) {
    throw new Error(`API_PORT must be at most 65535, received ${apiPort}`);
  }

  const rpcUrls = resolveRpcUrls(process.env.ARC_RPC_URL);

  return {
    databaseUrl,
    rpcUrl: rpcUrls[0],
    rpcUrls,
    deployBlock: DEPLOY_BLOCK,
    blockChunk: positiveInteger('INDEXER_BLOCK_CHUNK', 2_000),
    pollMs: positiveInteger('INDEXER_POLL_MS', DEFAULT_INDEXER_POLL_MS),
    chunkDelayMs: nonNegativeInteger(
      'INDEXER_CHUNK_DELAY_MS',
      DEFAULT_INDEXER_CHUNK_DELAY_MS,
    ),
    indexerStallMs: positiveInteger(
      'INDEXER_STALL_MS',
      DEFAULT_INDEXER_STALL_MS,
    ),
    apiHost: process.env.API_HOST ?? '0.0.0.0',
    apiPort,
    databasePoolSize: positiveInteger('DATABASE_POOL_SIZE', 32),
    databasePoolTimeoutSeconds: positiveInteger('DATABASE_POOL_TIMEOUT_SECONDS', 10),
    qdrantUrl: process.env.QDRANT_URL ?? 'http://localhost:6333',
    openAiApiKey: process.env.OPENAI_API_KEY?.trim() || undefined,
    dedupTopK: positiveInteger('DEDUP_TOP_K', 5),
    dedupTimeoutMs: positiveInteger('DEDUP_TIMEOUT_MS', 5_000),
  };
}
