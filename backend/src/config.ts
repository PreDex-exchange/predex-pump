import { ARC, DEPLOY_BLOCK } from '@predex-pump/shared';

const DEFAULT_DATABASE_URL =
  'postgresql://predex:predex@localhost:5432/predex_pump?schema=public';

// WebSocket subscriptions are the primary activity signal. This scan only
// closes holes from provider bugs or unusual subscription races.
export const DEFAULT_INDEXER_POLL_MS = 300_000;
// When subscriptions are unavailable, retain the old HTTP polling cadence so
// an HTTP-only deployment remains correct.
export const DEFAULT_INDEXER_FALLBACK_POLL_MS = 10_000;
export const DEFAULT_INDEXER_CHUNK_DELAY_MS = 200;
export const DEFAULT_INDEXER_STALL_MS = 90_000;
export const DEFAULT_INDEXER_WS_COALESCE_MS = 250;
export const DEFAULT_INDEXER_WS_STALL_MS = 15_000;
export const DEFAULT_INDEXER_WS_HEARTBEAT_MS = 5_000;
export const DEFAULT_INDEXER_WS_OWNER_REFRESH_MS = 30_000;
export const DEFAULT_INDEXER_WS_RECONNECT_BASE_MS = 1_000;
export const DEFAULT_INDEXER_WS_RECONNECT_MAX_MS = 30_000;

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
  webSocketCoalesceMs: number;
  webSocketStallMs: number;
  webSocketHeartbeatMs: number;
  webSocketOwnerRefreshMs: number;
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
    blockChunk: positiveInteger('INDEXER_BLOCK_CHUNK', 2_000),
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
    webSocketOwnerRefreshMs: positiveInteger(
      'INDEXER_WS_OWNER_REFRESH_MS',
      DEFAULT_INDEXER_WS_OWNER_REFRESH_MS,
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
