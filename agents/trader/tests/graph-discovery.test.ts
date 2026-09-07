import { describe, expect, it, vi } from 'vitest';

import { createGraphOpportunityDiscovery } from '../src/graph-discovery.js';

const NOW = 2_000;
const TX_HASH = `0x${'ab'.repeat(32)}`;

function responseBody(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      _meta: {
        block: { number: 60_000_000, timestamp: 1_990 },
        hasIndexingErrors: false,
      },
      markets: [
        {
          id: '2',
          phase: 'GRADUATED',
          tradingEndsAt: '3000',
          tradeEventCount: '3',
          lastTradeAt: '1980',
          lastTradeBlock: '59999999',
          lastTradeTransaction: TX_HASH,
          lastTradeVenue: 'CTF_EXCHANGE',
        },
        {
          id: '1',
          phase: 'GRADUATED',
          tradingEndsAt: '3000',
          tradeEventCount: '0',
          lastTradeAt: null,
          lastTradeBlock: null,
          lastTradeTransaction: null,
          lastTradeVenue: null,
        },
      ],
      ...overrides,
    },
  };
}

function clientFor(body: unknown, status = 200) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
  return {
    client: createGraphOpportunityDiscovery({
      queryUrl: 'https://api.studio.thegraph.com/query/1/predex/0.0.1',
      marketLimit: 20,
      fetch,
    }),
    fetch,
  };
}

describe('Graph opportunity discovery', () => {
  it('preserves the hosted ranking and returns bounded evidence', async () => {
    const { client, fetch } = clientFor(responseBody());

    await expect(client.discover(NOW)).resolves.toEqual({
      blockNumber: 60_000_000,
      blockTimestamp: 1_990,
      candidates: [
        {
          marketId: '2',
          tradeEventCount: '3',
          lastTradeAt: 1_980,
          lastTradeBlock: 59_999_999,
          lastTradeTransaction: TX_HASH,
          lastTradeVenue: 'CTF_EXCHANGE',
        },
        {
          marketId: '1',
          tradeEventCount: '0',
          lastTradeAt: null,
          lastTradeBlock: null,
          lastTradeTransaction: null,
          lastTradeVenue: null,
        },
      ],
    });
    const request = fetch.mock.calls[0]?.[1];
    expect(request?.method).toBe('POST');
    expect(JSON.parse(String(request?.body))).toMatchObject({
      variables: { now: '2000', limit: 20 },
    });
  });

  it.each([
    ['GraphQL errors', { errors: [{ message: 'unsafe detail' }] }],
    [
      'indexing errors',
      responseBody({
        _meta: {
          block: { number: 60_000_000, timestamp: 1_990 },
          hasIndexingErrors: true,
        },
      }),
    ],
    [
      'stale metadata',
      responseBody({
        _meta: {
          block: { number: 60_000_000, timestamp: 1_000 },
          hasIndexingErrors: false,
        },
      }),
    ],
    [
      'duplicate IDs',
      responseBody({
        markets: [
          {
            id: '1',
            phase: 'GRADUATED',
            tradingEndsAt: '3000',
            tradeEventCount: '0',
            lastTradeAt: null,
            lastTradeBlock: null,
            lastTradeTransaction: null,
            lastTradeVenue: null,
          },
          {
            id: '1',
            phase: 'GRADUATED',
            tradingEndsAt: '3000',
            tradeEventCount: '0',
            lastTradeAt: null,
            lastTradeBlock: null,
            lastTradeTransaction: null,
            lastTradeVenue: null,
          },
        ],
      }),
    ],
    [
      'incomplete evidence',
      responseBody({
        markets: [
          {
            id: '1',
            phase: 'GRADUATED',
            tradingEndsAt: '3000',
            tradeEventCount: '1',
            lastTradeAt: '1980',
            lastTradeBlock: null,
            lastTradeTransaction: null,
            lastTradeVenue: null,
          },
        ],
      }),
    ],
  ])('rejects %s without exposing response details', async (_label, body) => {
    const { client } = clientFor(body);

    await expect(client.discover(NOW)).rejects.not.toThrow(/unsafe detail/u);
  });

  it('returns a safe error for HTTP and transport failures', async () => {
    const http = clientFor({ private: 'body' }, 503).client;
    await expect(http.discover(NOW)).rejects.toThrow(
      'Graph discovery returned HTTP 503.',
    );

    const transport = createGraphOpportunityDiscovery({
      queryUrl: 'https://secret.example/query',
      marketLimit: 20,
      fetch: vi.fn(async () => {
        throw new Error('https://secret.example/query?key=leak');
      }),
    });
    await expect(transport.discover(NOW)).rejects.toThrow(
      'Graph discovery request failed.',
    );
  });

  it('aborts a request that exceeds the fixed deadline', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn<typeof globalThis.fetch>(
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('private timeout detail', 'AbortError')),
              { once: true },
            );
          }),
      );
      const client = createGraphOpportunityDiscovery({
        queryUrl: 'https://secret.example/query',
        marketLimit: 20,
        fetch,
      });
      const rejected = expect(client.discover(NOW)).rejects.toThrow(
        'Graph discovery request failed.',
      );

      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects invalid JSON and invalid response structure', async () => {
    const invalidJson = createGraphOpportunityDiscovery({
      queryUrl: 'https://api.studio.thegraph.com/query/1/predex/0.0.1',
      marketLimit: 20,
      fetch: vi.fn(async () => new Response('{not-json')),
    });
    await expect(invalidJson.discover(NOW)).rejects.toThrow(/invalid JSON/u);

    await expect(
      clientFor({ data: { markets: [] } }).client.discover(NOW),
    ).rejects.toThrow(/metadata/u);
    await expect(
      clientFor({ errors: { message: 'private' }, data: responseBody().data })
        .client.discover(NOW),
    ).rejects.toThrow(/GraphQL errors/u);
  });

  it.each([
    ['zero market ID', { id: '0' }],
    ['non-decimal market ID', { id: '1e3' }],
    ['non-graduated phase', { phase: 'CLOSED' }],
    ['ended deadline', { tradingEndsAt: NOW.toString() }],
    ['unsafe deadline', { tradingEndsAt: '9007199254740992' }],
    ['invalid trade count', { tradeEventCount: '-1' }],
  ])('rejects a candidate with %s', async (_label, candidateOverride) => {
    const candidate = {
      id: '1',
      phase: 'GRADUATED',
      tradingEndsAt: '3000',
      tradeEventCount: '0',
      lastTradeAt: null,
      lastTradeBlock: null,
      lastTradeTransaction: null,
      lastTradeVenue: null,
      ...candidateOverride,
    };
    const { client } = clientFor(responseBody({ markets: [candidate] }));

    await expect(client.discover(NOW)).rejects.toThrow(/Graph discovery/u);
  });

  it('rejects a response above the configured bound', async () => {
    const candidate = {
      id: '1',
      phase: 'GRADUATED',
      tradingEndsAt: '3000',
      tradeEventCount: '0',
      lastTradeAt: null,
      lastTradeBlock: null,
      lastTradeTransaction: null,
      lastTradeVenue: null,
    };
    const markets = Array.from({ length: 21 }, (_, index) => ({
      ...candidate,
      id: String(index + 1),
    }));

    await expect(
      clientFor(responseBody({ markets })).client.discover(NOW),
    ).rejects.toThrow(/candidate list/u);
  });

  it('accepts the freshness boundary and rejects older or future blocks', async () => {
    const boundary = clientFor(
      responseBody({
        _meta: {
          block: { number: 60_000_000, timestamp: NOW - 90 },
          hasIndexingErrors: false,
        },
      }),
    ).client;
    await expect(boundary.discover(NOW)).resolves.toBeTruthy();

    const stale = clientFor(
      responseBody({
        _meta: {
          block: { number: 60_000_000, timestamp: NOW - 91 },
          hasIndexingErrors: false,
        },
      }),
    ).client;
    await expect(stale.discover(NOW)).rejects.toThrow(/stale/u);

    const future = clientFor(
      responseBody({
        _meta: {
          block: { number: 60_000_000, timestamp: NOW + 31 },
          hasIndexingErrors: false,
        },
      }),
    ).client;
    await expect(future.discover(NOW)).rejects.toThrow(/stale/u);
  });

  it('never reuses a prior universe after a later failure', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(responseBody())))
      .mockRejectedValueOnce(new Error('private network detail'));
    const client = createGraphOpportunityDiscovery({
      queryUrl: 'https://api.studio.thegraph.com/query/1/predex/0.0.1',
      marketLimit: 20,
      fetch,
    });

    await expect(client.discover(NOW)).resolves.toBeTruthy();
    await expect(client.discover(NOW)).rejects.toThrow(
      'Graph discovery request failed.',
    );
  });

  it('rejects construction outside the hard market bound', () => {
    expect(() =>
      createGraphOpportunityDiscovery({
        queryUrl: 'https://example.com/query',
        marketLimit: 21,
        fetch: vi.fn(),
      }),
    ).toThrow(/between 1 and 20/u);
  });
});
