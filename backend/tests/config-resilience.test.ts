import { ARC } from '@predex-pump/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_INDEXER_CHUNK_DELAY_MS,
  DEFAULT_INDEXER_FALLBACK_POLL_MS,
  DEFAULT_INDEXER_MAX_BACKFILL_BLOCKS,
  DEFAULT_INDEXER_POLL_MS,
  DEFAULT_INDEXER_STALL_MS,
  DEFAULT_INDEXER_WS_COALESCE_MS,
  DEFAULT_INDEXER_WS_HEARTBEAT_MS,
  DEFAULT_INDEXER_WS_STALL_MS,
  DEFAULT_MARKETS_CACHE_TTL_SECONDS,
  loadRuntimeConfig,
  MAX_MARKETS_CACHE_TTL_SECONDS,
  resolveRpcUrls,
  resolveIndexerStartPolicy,
  resolveWebSocketRpcUrls,
} from '../src/config.js';

describe('indexer RPC configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses only an explicitly configured ARC_RPC_URL', () => {
    expect(resolveRpcUrls(' https://private.example/rpc ')).toEqual([
      'https://private.example/rpc',
    ]);
  });

  it('de-duplicates defaults and uses the current Arc network hosts', () => {
    expect(resolveRpcUrls(undefined)).toEqual([...new Set(ARC.rpcUrls)]);
    expect(ARC.rpcUrls).toEqual([
      'https://rpc.testnet.arc.network',
      'https://rpc.testnet.arc.io',
      'https://rpc.drpc.testnet.arc.network',
    ]);
    expect(resolveWebSocketRpcUrls(undefined)).toEqual([
      'wss://rpc.testnet.arc.network',
      'wss://rpc.testnet.arc.io',
      'wss://rpc.drpc.testnet.arc.network',
    ]);
    expect(ARC.webSocketRpcUrls).toEqual(
      resolveWebSocketRpcUrls(undefined),
    );
  });

  it('allows WebSocket subscriptions to be explicitly disabled', () => {
    expect(resolveWebSocketRpcUrls('')).toEqual([]);
    expect(resolveWebSocketRpcUrls(' wss://private.example/rpc ')).toEqual([
      'wss://private.example/rpc',
    ]);
  });

  it('uses rate-limit-friendly polling, chunk pacing, and stall defaults', () => {
    expect(DEFAULT_INDEXER_POLL_MS).toBe(30_000);
    expect(DEFAULT_INDEXER_FALLBACK_POLL_MS).toBe(10_000);
    expect(DEFAULT_INDEXER_CHUNK_DELAY_MS).toBe(200);
    expect(DEFAULT_INDEXER_STALL_MS).toBe(90_000);
    expect(DEFAULT_INDEXER_MAX_BACKFILL_BLOCKS).toBe(100_000);
    expect(DEFAULT_INDEXER_WS_COALESCE_MS).toBe(250);
    expect(DEFAULT_INDEXER_WS_HEARTBEAT_MS).toBe(5_000);
    expect(DEFAULT_INDEXER_WS_STALL_MS).toBe(15_000);
  });

  it('defaults the startup policy to auto and validates explicit overrides', () => {
    expect(resolveIndexerStartPolicy(undefined)).toBe('auto');
    expect(resolveIndexerStartPolicy('auto')).toBe('auto');
    expect(resolveIndexerStartPolicy('head')).toBe('head');
    expect(resolveIndexerStartPolicy('resume')).toBe('resume');
    expect(() => resolveIndexerStartPolicy('silent-skip')).toThrow(
      'INDEXER_START_POLICY must be auto, head, or resume',
    );
  });

  it('loads the startup policy and backfill threshold from environment', () => {
    vi.stubEnv('INDEXER_START_POLICY', 'head');
    vi.stubEnv('INDEXER_MAX_BACKFILL_BLOCKS', '12345');
    expect(loadRuntimeConfig()).toMatchObject({
      indexerStartPolicy: 'head',
      indexerMaxBackfillBlocks: 12_345,
    });
  });

  it('keeps the public market cache TTL short enough for Redis outage recovery', () => {
    expect(DEFAULT_MARKETS_CACHE_TTL_SECONDS).toBe(5);
    expect(MAX_MARKETS_CACHE_TTL_SECONDS).toBe(60);
    vi.stubEnv('MARKETS_CACHE_TTL_SECONDS', '60');
    expect(loadRuntimeConfig().marketsCacheTtlSeconds).toBe(60);

    vi.stubEnv('MARKETS_CACHE_TTL_SECONDS', '61');
    expect(() => loadRuntimeConfig()).toThrow(
      'MARKETS_CACHE_TTL_SECONDS must be at most 60',
    );
  });
});
