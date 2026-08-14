import { describe, expect, it } from 'vitest';

import { DEFAULT_INDEXER_BLOCK_CHUNK } from '../src/config.js';

// Measured against all three live Arc endpoints on 2026-08-14: a 20,000-block
// eth_getLogs span is accepted and a 30,000-block span is rejected with
// -32012 "requested range too large". Raising the chunk past the ceiling makes
// every catch-up request fail outright rather than merely slowly, so the
// ceiling is pinned here rather than left as folklore in a commit message.
// The endpoint list itself is covered by config-resilience.test.ts.
const ARC_GET_LOGS_MAX_VERIFIED_SPAN = 20_000;

describe('indexer RPC limits', () => {
  it('keeps the default block chunk under Arc’s verified getLogs ceiling', () => {
    expect(DEFAULT_INDEXER_BLOCK_CHUNK).toBeLessThanOrEqual(
      ARC_GET_LOGS_MAX_VERIFIED_SPAN,
    );
  });
});
