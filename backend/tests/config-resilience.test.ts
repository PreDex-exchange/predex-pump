import { ARC } from '@predex-pump/shared';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INDEXER_CHUNK_DELAY_MS,
  DEFAULT_INDEXER_POLL_MS,
  DEFAULT_INDEXER_STALL_MS,
  resolveRpcUrls,
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
  });

  it('uses rate-limit-friendly polling, chunk pacing, and stall defaults', () => {
    expect(DEFAULT_INDEXER_POLL_MS).toBe(10_000);
    expect(DEFAULT_INDEXER_CHUNK_DELAY_MS).toBe(200);
    expect(DEFAULT_INDEXER_STALL_MS).toBe(90_000);
  });
});
