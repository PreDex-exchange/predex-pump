import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INDEXER_REQUEST_SPACING_MS,
  loadRuntimeConfig,
} from '../src/config.js';

// Arc's public RPC enforces a burst limit that back-to-back requests trip on
// the THIRD call. A range issues four filtered getLogs calls, and a single 429
// fails the whole range — which then retries and re-fires the same burst, so an
// unspaced range never completes. Measured against the live endpoint on
// 2026-08-14 from the production host, with the indexer stopped so nothing else
// consumed the budget:
//
//   no spacing -> 200 200 429 200
//   400ms      -> 200 200 200 200
//
// The spacing is therefore a correctness control for catch-up convergence, not
// a tuning preference.
const ARC_BURST_LIMIT_OBSERVED_AT_REQUEST = 3;

describe('indexer request spacing', () => {
  it('spaces requests by default, so a range cannot self-inflict a 429', () => {
    expect(DEFAULT_INDEXER_REQUEST_SPACING_MS).toBeGreaterThan(0);
  });

  it('keeps enough spacing to clear the observed burst window', () => {
    // Four filtered calls must all land. Anything below ~250ms was seen to
    // trip the limiter mid-range.
    expect(DEFAULT_INDEXER_REQUEST_SPACING_MS).toBeGreaterThanOrEqual(250);
    expect(ARC_BURST_LIMIT_OBSERVED_AT_REQUEST).toBe(3);
  });

  it('surfaces the spacing as runtime config so an operator can tune it', () => {
    expect(loadRuntimeConfig().requestSpacingMs).toBe(
      DEFAULT_INDEXER_REQUEST_SPACING_MS,
    );
  });

  it('allows spacing to be disabled for a private, unmetered endpoint', () => {
    const previous = process.env.INDEXER_REQUEST_SPACING_MS;
    process.env.INDEXER_REQUEST_SPACING_MS = '0';
    try {
      expect(loadRuntimeConfig().requestSpacingMs).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.INDEXER_REQUEST_SPACING_MS;
      else process.env.INDEXER_REQUEST_SPACING_MS = previous;
    }
  });
});
