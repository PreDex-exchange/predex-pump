import { describe, expect, it } from 'vitest';

import {
  assertHotHybridResponses,
  parseBenchmarkServerMessage,
  parseBenchmarkServerRequest,
} from './protocol.js';

function outcomeBook() {
  return {
    bids: [{ priceRaw: '400000', sizeRaw: '1000000', orderCount: 1 }],
    asks: [{ priceRaw: '600000', sizeRaw: '1000000', orderCount: 1 }],
    offchainOrders: [
      { orderHash: `0x${'1'.repeat(64)}`, fillable: true },
    ],
  };
}

describe('benchmark child protocol', () => {
  it('accepts a process-isolated readiness message', () => {
    expect(
      parseBenchmarkServerMessage({
        type: 'ready',
        pid: 1234,
        baseUrl: 'http://127.0.0.1:3001',
        websocketUrl: 'ws://127.0.0.1:3001/ws',
        redisConfigured: true,
      }),
    ).toEqual({
      type: 'ready',
      pid: 1234,
      baseUrl: 'http://127.0.0.1:3001',
      websocketUrl: 'ws://127.0.0.1:3001/ws',
      redisConfigured: true,
    });
  });

  it('validates publish commands and rejects malformed child metrics', () => {
    expect(
      parseBenchmarkServerRequest({
        type: 'publish',
        requestId: 'request-1',
        eventCount: 2_000,
        baseTimestamp: 1_750_000_000,
      }),
    ).toMatchObject({ type: 'publish', eventCount: 2_000 });
    expect(() =>
      parseBenchmarkServerMessage({
        type: 'publish-result',
        requestId: 'request-1',
        result: { publishP95Us: Number.NaN },
      }),
    ).toThrow(/publishP50Us/u);
  });
});

describe('hot Hybrid workload assertion', () => {
  const tokenBook = {
    marketId: '1',
    tokenId: '1000000000',
    outcome: 'YES',
    ...outcomeBook(),
  };
  const marketBook = {
    marketId: '1',
    liveVenue: 'HYBRID',
    orderBookAvailable: true,
    tradingOpen: true,
    yes: outcomeBook(),
    no: outcomeBook(),
  };

  it('records nonempty active Hybrid evidence', () => {
    expect(assertHotHybridResponses(marketBook, tokenBook)).toEqual({
      marketId: '1',
      liveVenue: 'HYBRID',
      tradingOpen: true,
      marketBookOffchainOrders: 2,
      tokenBookOffchainOrders: 1,
      marketBookLevels: 4,
      tokenBookLevels: 2,
    });
  });

  it('rejects ended or empty order-book fixtures before timing begins', () => {
    expect(() =>
      assertHotHybridResponses(
        { ...marketBook, tradingOpen: false },
        tokenBook,
      ),
    ).toThrow(/active, available HYBRID/u);
    expect(() =>
      assertHotHybridResponses(marketBook, {
        marketId: '1',
        tokenId: '1000000000',
        outcome: 'YES',
        bids: [],
        asks: [],
        offchainOrders: [],
      }),
    ).toThrow(/fillable orders and levels/u);
  });
});
