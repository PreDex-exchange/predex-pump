import { ARC, DEPLOY_BLOCK } from '@predex-pump/shared';

const DEFAULT_DATABASE_URL =
  'postgresql://predex:predex@localhost:5432/predex_pump?schema=public';

// WebSocket subscriptions are the primary activity signal. This scan also
// bounds tracked-maker collateral staleness for bare transfers.
export const DEFAULT_INDEXER_POLL_MS = 30_000;
// When subscriptions are unavailable, retain the old HTTP polling cadence so
// an HTTP-only deployment remains correct.
export const DEFAULT_INDEXER_FALLBACK_POLL_MS = 10_000;
export const DEFAULT_INDEXER_CHUNK_DELAY_MS = 200;
export const DEFAULT_INDEXER_STALL_MS = 90_000;
// At the default 10,000-block range this permits 10 chunks, but stays below
// the observed 165,527-block Arc gap that could not make progress under
// sustained public-RPC rate limiting.
export const DEFAULT_INDEXER_MAX_BACKFILL_BLOCKS = 100_000;
// Arc's public RPC rejects an eth_getLogs span of 30,000 blocks with
// -32012 "requested range too large" and accepts 20,000, on all three
// endpoints. 10,000 keeps a 2x margin under that ceiling while cutting the
// requests needed to close a given gap by 5x versus the previous 2,000 —
// catch-up was losing ground to the chain at ~3 blocks/sec under 429s.
export const DEFAULT_INDEXER_BLOCK_CHUNK = 10_000;
export const DEFAULT_INDEXER_WS_COALESCE_MS = 250;
export const DEFAULT_INDEXER_WS_STALL_MS = 15_000;
export const DEFAULT_INDEXER_WS_HEARTBEAT_MS = 5_000;
export const DEFAULT_INDEXER_WS_RECONNECT_BASE_MS = 1_000;
export const DEFAULT_INDEXER_WS_RECONNECT_MAX_MS = 30_000;

export type IndexerStartPolicy = 'auto' | 'head' | 'resume';

/**
 * Startup policy for an existing durable cursor:
 * - auto: resume normally, but skip to the current head when the configured
 *   maximum backfill is exceeded;
 * - head: operator override that always skips to the current head;
 * - resume: operator override that never skips, regardless of gap size.
 */
export function resolveIndexerStartPolicy(
  configuredPolicy: string | undefined,
): IndexerStartPolicy {
  const policy = configuredPolicy?.trim().toLowerCase() || 'auto';
  if (policy === 'auto' || policy === 'head' || policy === 'resume') {
    return policy;
  }
  throw new Error(
    `INDEXER_START_POLICY must be auto, head, or resume, received ${configuredPolicy}`,
  );
}

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

export function resolveWebSocketRpcUrls(
  configuredUrl: string | undefined,
): readonly string[] {
  // An explicitly empty value is the supported way to run HTTP-only. An
  // omitted value uses the public Arc WebSocket endpoints from shared config.
  const candidates =
    configuredUrl === undefined
      ? [...ARC.webSocketRpcUrls]
      : configuredUrl.trim() === ''
        ? []
        : [configuredUrl.trim()];
  return [...new Set(candidates.map((url) => url.trim()).filter(Boolean))];
}

export interface RuntimeConfig {
  databaseUrl: string;
  rpcUrl: string;
  rpcUrls: readonly [string, ...string[]];
  webSocketRpcUrls: readonly string[];
  deployBlock: number;
  blockChunk: number;
  pollMs: number;
  fallbackPollMs: number;
  chunkDelayMs: number;
  indexerStallMs: number;
  indexerStartPolicy: IndexerStartPolicy;
  indexerMaxBackfillBlocks: number;
  webSocketCoalesceMs: number;
  webSocketStallMs: number;
  webSocketHeartbeatMs: number;
  webSocketReconnectBaseMs: number;
  webSocketReconnectMaxMs: number;
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
  const webSocketRpcUrls = resolveWebSocketRpcUrls(
    process.env.ARC_WS_RPC_URL,
  );
  const webSocketReconnectBaseMs = positiveInteger(
    'INDEXER_WS_RECONNECT_BASE_MS',
    DEFAULT_INDEXER_WS_RECONNECT_BASE_MS,
  );
  const webSocketReconnectMaxMs = positiveInteger(
    'INDEXER_WS_RECONNECT_MAX_MS',
    DEFAULT_INDEXER_WS_RECONNECT_MAX_MS,
  );
  if (webSocketReconnectMaxMs < webSocketReconnectBaseMs) {
    throw new Error(
      'INDEXER_WS_RECONNECT_MAX_MS must be greater than or equal to ' +
        'INDEXER_WS_RECONNECT_BASE_MS',
    );
  }

  return {
    databaseUrl,
    rpcUrl: rpcUrls[0],
    rpcUrls,
    webSocketRpcUrls,
    deployBlock: DEPLOY_BLOCK,
    blockChunk: positiveInteger('INDEXER_BLOCK_CHUNK', DEFAULT_INDEXER_BLOCK_CHUNK),
    pollMs: positiveInteger('INDEXER_POLL_MS', DEFAULT_INDEXER_POLL_MS),
    fallbackPollMs: positiveInteger(
      'INDEXER_FALLBACK_POLL_MS',
      DEFAULT_INDEXER_FALLBACK_POLL_MS,
    ),
    chunkDelayMs: nonNegativeInteger(
      'INDEXER_CHUNK_DELAY_MS',
      DEFAULT_INDEXER_CHUNK_DELAY_MS,
    ),
    indexerStallMs: positiveInteger(
      'INDEXER_STALL_MS',
      DEFAULT_INDEXER_STALL_MS,
    ),
    indexerStartPolicy: resolveIndexerStartPolicy(
      process.env.INDEXER_START_POLICY,
    ),
    indexerMaxBackfillBlocks: nonNegativeInteger(
      'INDEXER_MAX_BACKFILL_BLOCKS',
      DEFAULT_INDEXER_MAX_BACKFILL_BLOCKS,
    ),
    webSocketCoalesceMs: positiveInteger(
      'INDEXER_WS_COALESCE_MS',
      DEFAULT_INDEXER_WS_COALESCE_MS,
    ),
    webSocketStallMs: positiveInteger(
      'INDEXER_WS_STALL_MS',
      DEFAULT_INDEXER_WS_STALL_MS,
    ),
    webSocketHeartbeatMs: positiveInteger(
      'INDEXER_WS_HEARTBEAT_MS',
      DEFAULT_INDEXER_WS_HEARTBEAT_MS,
    ),
    webSocketReconnectBaseMs,
    webSocketReconnectMaxMs,
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
