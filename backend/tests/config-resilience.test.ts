import { ARC } from '@predex-pump/shared';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INDEXER_CHUNK_DELAY_MS,
  DEFAULT_INDEXER_FALLBACK_POLL_MS,
  DEFAULT_INDEXER_POLL_MS,
  DEFAULT_INDEXER_STALL_MS,
  DEFAULT_INDEXER_WS_COALESCE_MS,
  DEFAULT_INDEXER_WS_HEARTBEAT_MS,
  DEFAULT_INDEXER_WS_STALL_MS,
  resolveRpcUrls,
  resolveWebSocketRpcUrls,
} from '../src/config.js';

describe('indexer RPC configuration', () => {
  it('uses only an explicitly configured ARC_RPC_URL', () => {
    expect(resolveRpcUrls(' https://private.example/rpc ')).toEqual([
      'https://private.example/rpc',
    ]);
  });

  it('de-duplicates defaults and uses the current Arc network hosts', () => {
    expect(resolveRpcUrls(undefined)).toEqual([...new Set(ARC.rpcUrls)]);
    expect(ARC.rpcUrls).toEqual([
      'https://rpc.testnet.arc.network',
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
    expect(DEFAULT_INDEXER_POLL_MS).toBe(300_000);
    expect(DEFAULT_INDEXER_FALLBACK_POLL_MS).toBe(10_000);
    expect(DEFAULT_INDEXER_CHUNK_DELAY_MS).toBe(200);
    expect(DEFAULT_INDEXER_STALL_MS).toBe(90_000);
    expect(DEFAULT_INDEXER_WS_COALESCE_MS).toBe(250);
    expect(DEFAULT_INDEXER_WS_HEARTBEAT_MS).toBe(5_000);
    expect(DEFAULT_INDEXER_WS_STALL_MS).toBe(15_000);
  });
});
