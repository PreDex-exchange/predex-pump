import { describe, expect, it } from 'vitest';

import {
  assertHotHybridResponses,
  evaluateRestGate,
  parseBenchmarkServerMessage,
  parseBenchmarkServerRequest,
  payloadRestScenarios,
} from './protocol.js';

function outcomeBook() {
  return {
    bids: [{ priceRaw: '400000', sizeRaw: '1000000', orderCount: 1 }],
    asks: [{ priceRaw: '600000', sizeRaw: '1000000', orderCount: 1 }],
    offchainOrders: [
      { orderHash: `0x${'1'.repeat(64)}`, fillable: true, side: 'BID' },
      { orderHash: `0x${'2'.repeat(64)}`, fillable: true, side: 'ASK' },
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
      orderLimitPerSide: null,
      marketBookOffchainOrders: 4,
      tokenBookOffchainOrders: 2,
      marketBookLevels: 4,
      tokenBookLevels: 2,
    });
  });

  it('proves the timed Hybrid fixtures are truncated top-of-book windows', () => {
    const boundedOutcome = {
      ...outcomeBook(),
      orderWindow: {
        limitPerSide: 20,
        orders: { returned: 0, truncated: false },
        offchainOrders: { returned: 2, truncated: true },
      },
    };
    expect(
      assertHotHybridResponses(
        { ...marketBook, yes: boundedOutcome, no: boundedOutcome },
        { ...tokenBook, ...boundedOutcome },
        20,
      ),
    ).toMatchObject({
      orderLimitPerSide: 20,
      marketBookOffchainOrders: 4,
      tokenBookOffchainOrders: 2,
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

describe('REST fluency gate configuration', () => {
  it('gates bounded product reads and retains full reads as informational', () => {
    const scenarios = payloadRestScenarios(`0x${'1'.repeat(40)}`);
    expect(
      scenarios.filter(({ gated }) => gated).map(({ name, path }) => ({ name, path })),
    ).toEqual([
      {
        name: 'market.book',
        path: '/markets/1/book?orderLimitPerSide=20',
      },
      {
        name: 'market.prices',
        path: '/markets/1/prices?limit=500',
      },
      {
        name: 'orderbook.token',
        path: '/orderbook/1000000000?orderLimitPerSide=20',
      },
      {
        name: 'account.detail',
        path: `/accounts/0x${'1'.repeat(40)}?positionsLimit=100`,
      },
    ]);
    expect(
      scenarios.filter(({ gated }) => !gated).map(({ name, path }) => ({ name, path })),
    ).toEqual([
      { name: 'market.book.bulk', path: '/markets/1/book' },
      { name: 'market.prices.bulk', path: '/markets/1/prices?limit=2000' },
      { name: 'orderbook.token.bulk', path: '/orderbook/1000000000' },
      {
        name: 'account.detail.bulk',
        path: `/accounts/0x${'1'.repeat(40)}`,
      },
    ]);
  });

  it('excludes informational bulk misses from the REST target', () => {
    expect(
      evaluateRestGate(
        [
          { name: 'market.book', p95: 99, gated: true },
          { name: 'market.book.bulk', p95: 500, gated: false },
        ],
        100,
      ),
    ).toEqual({
      targetP95Ms: 100,
      passed: true,
      failures: [],
      informationalScenarios: ['market.book.bulk'],
    });
  });
});
