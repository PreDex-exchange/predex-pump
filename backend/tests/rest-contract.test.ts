import type {
  AccountResponse,
  ActivityResponse,
  ConfigResponse,
  DedupIndexHealth,
  DedupCheckResponse,
  ExchangeApprovalStateResponse,
  HealthResponse,
  ListMarketsResponse,
  MarketBookResponse,
  MarketDetailResponse,
  OrderBookResponse,
  PriceHistoryResponse,
  TruthSignalResponse,
} from '@predex-pump/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../src/api/server.js';
import { ServerEventBus } from '../src/events/bus.js';
import { resetDatabase, testPrisma } from './database.js';
import {
  DEPLOYER,
  MARKET_ONE_CONDITION,
  SIGNER_ONE,
  SIGNER_TWO,
  TRADE_TX,
  TRADER,
  seedContractData,
} from './fixtures.js';

const READY_DEDUP_INDEX: DedupIndexHealth = {
  status: 'ready',
  configuredProvider: 'fallback',
  queryProvider: 'fallback',
  canonicalMarketCount: 2,
  providers: {
    openai: {
      indexedMarketCount: 0,
      missingMarketCount: 2,
      unexpectedMarketCount: 0,
      complete: false,
    },
    fallback: {
      indexedMarketCount: 2,
      missingMarketCount: 0,
      unexpectedMarketCount: 0,
      complete: true,
    },
  },
  error: null,
};

describe('REST shared contract', () => {
  let app: FastifyInstance;
  let dedupIndexHealth = READY_DEDUP_INDEX;

  beforeAll(async () => {
    app = await buildServer({
      prisma: testPrisma,
      eventBus: new ServerEventBus(),
      dedupChecker: {
        check: async (question) => {
          if (question === 'force provider failure') {
            throw new Error('provider unavailable');
          }
          return {
            available: true,
            isDuplicate: true,
            canonicalMarketId: '1',
            candidates: [
              {
                marketId: '1',
                question,
                score: 0.98,
                reason: `Same fact as "${question}"`,
              },
            ],
          };
        },
      },
      dedupIndexHealthReader: {
        getHealth: async () => dedupIndexHealth,
      },
      logger: false,
    });
  });

  beforeEach(async () => {
    dedupIndexHealth = READY_DEDUP_INDEX;
    await resetDatabase();
    await seedContractData();
  });

  afterAll(async () => {
    await app.close();
    await testPrisma.$disconnect();
  });

  it('GET /markets returns a keyset-paginated Market page', async () => {
    const firstResponse = await app.inject({
      method: 'GET',
      url: '/markets?limit=1',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(firstResponse.statusCode).toBe(200);
    expect(firstResponse.headers['access-control-allow-origin']).toBe(
      'http://localhost:3000',
    );
    expect(firstResponse.headers['access-control-allow-credentials']).toBe('true');
    const first = firstResponse.json<ListMarketsResponse>();
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toEqual({
      id: '2',
      creator: '0xcccccccccccccccccccccccccccccccccccccccc',
      question: 'Did the second market resolve YES?',
      phase: 'ResolvedObserved',
      conditionId: `0x${'2'.repeat(64)}`,
      questionId: `0x${'4'.repeat(64)}`,
      yesTokenId: '201',
      noTokenId: '202',
      seedRaw: '2000000',
      yesPriceRaw: '550000',
      noPriceRaw: '450000',
      graduationActivityRaw: '0',
      bookAddress: null,
      frozenYesPriceRaw: null,
      handoffSizeRaw: null,
      tradeCount: 0,
      volumeRaw: '0',
      params: {
        seedFloorRaw: '1000000',
        seedCapRaw: '50000000',
        fCapRaw: '100000000',
        graduationMoneyInThresholdRaw: '25000000',
        graduationTollRaw: '2000000',
        inventoryTargetRaw: '5000000',
        protocolFeeBps: 100,
        depthFeeBps: 50,
        tradingWindowSeconds: 86400,
        minimumTimeOpenSeconds: 3600,
        minimumTickSizeRaw: '1000',
      },
      createdAt: 1_700_000_100,
      tradingEndsAt: 1_700_086_500,
      graduatedAt: null,
      resolvedAt: 1_700_010_000,
      resolution: {
        marketId: '2',
        conditionId: `0x${'2'.repeat(64)}`,
        outcome: 'YES',
        payoutYes: 1,
        payoutNo: 0,
        denominator: 1,
        resolvedAt: 1_700_010_000,
        observedAt: 1_700_010_100,
      },
    });
    expect(first.nextCursor).toEqual(expect.any(String));

    const secondResponse = await app.inject({
      method: 'GET',
      url: `/markets?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
    });
    const second = secondResponse.json<ListMarketsResponse>();
    expect(second.items.map((market) => market.id)).toEqual(['1']);
    expect(second.nextCursor).toBeNull();

    const filtered = await app.inject({
      method: 'GET',
      url: `/markets?creator=${DEPLOYER}&phase=Graduated`,
    });
    expect(filtered.json<ListMarketsResponse>().items.map((market) => market.id)).toEqual([
      '1',
    ]);
  });

  it('allows browser mutation preflights without widening origin policy', async () => {
    for (const [method, url] of [
      ['PATCH', '/account/profile'],
      ['PUT', '/account/watchlist/1'],
      ['DELETE', `/orders/0x${'1'.repeat(64)}`],
    ] as const) {
      const response = await app.inject({
        method: 'OPTIONS',
        url,
        headers: {
          origin: 'http://localhost:3000',
          'access-control-request-method': method,
        },
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe(
        'http://localhost:3000',
      );
      expect(response.headers['access-control-allow-credentials']).toBe('true');
      expect(
        response.headers['access-control-allow-methods']
          ?.split(',')
          .map((allowed) => allowed.trim()),
      ).toEqual(['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE']);
    }
  });

  it('POST /markets/dedup-check implements the shared advisory contract', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/markets/dedup-check',
      payload: { question: 'BTC > $70,000 by Friday close?' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<DedupCheckResponse>()).toEqual({
      available: true,
      isDuplicate: true,
      canonicalMarketId: '1',
      candidates: [
        {
          marketId: '1',
          question: 'BTC > $70,000 by Friday close?',
          score: 0.98,
          reason: 'Same fact as "BTC > $70,000 by Friday close?"',
        },
      ],
    });

    const degraded = await app.inject({
      method: 'POST',
      url: '/markets/dedup-check',
      payload: { question: 'force provider failure' },
    });
    expect(degraded.statusCode).toBe(200);
    expect(degraded.json<DedupCheckResponse>()).toEqual({
      available: false,
      isDuplicate: false,
      canonicalMarketId: null,
      candidates: [],
    });

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/markets/dedup-check',
          payload: { question: '   ' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it.each([
    {
      name: 'malformed JSON',
      payload: '{"question":',
      contentType: 'application/json',
      status: 400,
    },
    {
      name: 'trailing-comma JSON',
      payload: '{"question":"test",}',
      contentType: 'application/json',
      status: 400,
    },
    {
      name: 'empty JSON',
      payload: '',
      contentType: 'application/json',
      status: 400,
    },
    {
      name: 'unsupported XML',
      payload: '<question>test</question>',
      contentType: 'application/xml',
      status: 415,
    },
    {
      name: 'oversized JSON',
      payload: JSON.stringify({ question: 'x'.repeat(1_100_000) }),
      contentType: 'application/json',
      status: 413,
    },
  ])('maps $name parser failures to HTTP $status', async (testCase) => {
    const response = await app.inject({
      method: 'POST',
      url: '/markets/dedup-check',
      headers: { 'content-type': testCase.contentType },
      payload: testCase.payload,
    });

    expect(response.statusCode).toBe(testCase.status);
    expect(response.json<{ error: string }>().error).not.toBe(
      'Internal server error',
    );
    if (testCase.payload.length > 0) {
      expect(response.body).not.toContain(testCase.payload.slice(0, 100));
    }
  });

  it('GET /markets/:id returns market, recent trades, and resolution', async () => {
    const response = await app.inject({ method: 'GET', url: '/markets/1' });
    expect(response.statusCode).toBe(200);
    const body = response.json<MarketDetailResponse>();
    expect(body.market.id).toBe('1');
    expect(body.market.phase).toBe('Graduated');
    expect(body.recentTrades).toEqual([
      {
        id: `${TRADE_TX}:4`,
        marketId: '1',
        venue: 'LMSR',
        account: TRADER,
        outcome: 'YES',
        side: 'BID',
        sizeRaw: '2000000',
        priceRaw: '500000',
        costRaw: '1000000',
        feeRaw: '10000',
        txHash: TRADE_TX,
        logIndex: 4,
        ts: 1_700_000_010,
      },
    ]);
    expect(body.resolution).toBeNull();
    expect(body.settlementEvents).toEqual({
      protocolSweepCompleted: false,
      protocolSweptRaw: '0',
    });

    const resolved = await app.inject({ method: 'GET', url: '/markets/2' });
    expect(resolved.json<MarketDetailResponse>().resolution).toEqual({
      marketId: '2',
      conditionId: `0x${'2'.repeat(64)}`,
      outcome: 'YES',
      payoutYes: 1,
      payoutNo: 0,
      denominator: 1,
      resolvedAt: 1_700_010_000,
      observedAt: 1_700_010_100,
    });
    expect(resolved.json<MarketDetailResponse>().market.resolution).toEqual(
      resolved.json<MarketDetailResponse>().resolution,
    );
  });

  it('serves payout finality without fabricating an observed lifecycle phase', async () => {
    await testPrisma.market.update({
      where: { id: '1' },
      data: { resolvedAt: 1_700_020_000 },
    });
    await testPrisma.resolution.create({
      data: {
        marketId: '1',
        conditionId: MARKET_ONE_CONDITION,
        outcome: 'YES',
        payoutYes: 1,
        payoutNo: 0,
        denominator: 1,
        resolvedAt: 1_700_020_000,
        observedAt: null,
        txHash: `0x${'7'.repeat(64)}`,
        logIndex: 1,
      },
    });
    await testPrisma.activityEvent.create({
      data: {
        id: `0x${'8'.repeat(64)}:2`,
        type: 'ProtocolFeeSwept',
        eventName: 'ProtocolFeeSwept',
        source: 'LMSR',
        marketId: '1',
        account: null,
        outcome: null,
        side: null,
        amountRaw: '125000',
        priceRaw: null,
        txHash: `0x${'8'.repeat(64)}`,
        logIndex: 2,
        blockNumber: 53_500_000,
        ts: 1_700_030_000,
        data: {
          marketId: '1',
          amountRaw: '125000',
          cumulativeSweptRaw: '125000',
          closeoutComplete: true,
        },
      },
    });

    const response = await app.inject({ method: 'GET', url: '/markets/1' });
    const body = response.json<MarketDetailResponse>();
    expect(body.market.phase).toBe('Graduated');
    expect(body.market.resolvedAt).toBe(1_700_020_000);
    expect(body.resolution?.outcome).toBe('YES');
    expect(body.market.resolution).toEqual(body.resolution);
    expect(body.settlementEvents).toEqual({
      protocolSweepCompleted: true,
      protocolSweptRaw: '125000',
    });
  });

  it('GET /markets/:id/book returns both aggregated outcome books', async () => {
    const response = await app.inject({ method: 'GET', url: '/markets/1/book' });
    expect(response.statusCode).toBe(200);
    const body = response.json<MarketBookResponse>();
    expect(body.marketId).toBe('1');
    expect(body.liveVenue).toBe('MINICLOB');
    expect(body.orderBookAvailable).toBe(true);
    expect(body.minimumTickSizeRaw).toBe('1000');
    expect(body.minimumTickSizeAppliesTo).toBe('NEW_ORDERS');
    expect(body.yes).toMatchObject({
      marketId: '1',
      minimumTickSizeRaw: '1000',
      outcome: 'YES',
      tokenId: '101',
      bids: [{ priceRaw: '600000', sizeRaw: '1250000', orderCount: 2 }],
      asks: [{ priceRaw: '650000', sizeRaw: '1000000', orderCount: 1 }],
    });
    expect(body.yes.orders).toHaveLength(3);
    expect(body.yes.orders[0]).toEqual({
      orderId: '1',
      marketId: '1',
      conditionId: MARKET_ONE_CONDITION,
      tokenId: '101',
      outcome: 'YES',
      maker: DEPLOYER,
      side: 'BID',
      priceRaw: '600000',
      sizeRaw: '1000000',
      filledRaw: '250000',
      remainingRaw: '750000',
      open: true,
      isSeed: false,
      createdAt: 1_700_003_600,
      updatedAt: 1_700_003_700,
    });
    expect(body.no).toEqual({
      marketId: '1',
      minimumTickSizeRaw: '1000',
      outcome: 'NO',
      tokenId: '102',
      bids: [],
      asks: [],
      bestBidRaw: null,
      bestAskRaw: null,
      orders: [],
      offchainOrders: [],
    });
  });

  it.each([
    ['bootstrap curve', 'LMSR', false],
    ['graduated book', 'MINICLOB', true],
    ['migrated book', 'HYBRID', true],
  ] as const)(
    'reports the true live venue for a %s market',
    async (lifecycle, expectedVenue, expectedBookAvailable) => {
      if (lifecycle === 'bootstrap curve') {
        await testPrisma.market.update({
          where: { id: '1' },
          data: {
            phase: 'Opened',
            bookAddress: null,
            graduatedAt: null,
          },
        });
      } else if (lifecycle === 'migrated book') {
        await testPrisma.bookMigration.create({
          data: {
            marketId: '1',
            status: 'MIGRATED',
            yesSeedOrderId: '2',
            noSeedOrderId: '3',
            createdAt: 1_700_003_700,
            updatedAt: 1_700_003_800,
            migratedAt: 1_700_003_800,
          },
        });
      }

      const response = await app.inject({
        method: 'GET',
        url: '/markets/1/book',
      });
      const body = response.json<MarketBookResponse>();

      expect(response.statusCode).toBe(200);
      expect(body).toMatchObject({
        liveVenue: expectedVenue,
        orderBookAvailable: expectedBookAvailable,
        minimumTickSizeRaw: '1000',
        minimumTickSizeAppliesTo: 'NEW_ORDERS',
      });
      if (!expectedBookAvailable) {
        expect(body.yes.orders).toEqual([]);
        expect(body.no.orders).toEqual([]);
        expect(body.yes.offchainOrders).toEqual([]);
        expect(body.no.offchainOrders).toEqual([]);
      }
    },
  );

  it('preserves an executable off-tick seed price while scoping the tick to new orders', async () => {
    await testPrisma.order.update({
      where: { orderId: '3' },
      data: { priceRaw: '543213' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/markets/1/book',
    });
    const body = response.json<MarketBookResponse>();

    expect(response.statusCode).toBe(200);
    expect(body.minimumTickSizeRaw).toBe('1000');
    expect(body.minimumTickSizeAppliesTo).toBe('NEW_ORDERS');
    expect(body.yes.asks).toContainEqual({
      priceRaw: '543213',
      sizeRaw: '1000000',
      orderCount: 1,
    });
    expect(body.yes.orders).toContainEqual(
      expect.objectContaining({
        isSeed: true,
        priceRaw: '543213',
      }),
    );
  });

  it('GET /orderbook/:tokenId returns the exact single-token ladder', async () => {
    const response = await app.inject({ method: 'GET', url: '/orderbook/101' });
    expect(response.statusCode).toBe(200);
    const body = response.json<OrderBookResponse>();
    expect(body.marketId).toBe('1');
    expect(body.outcome).toBe('YES');
    expect(body.bids[0]).toEqual({
      priceRaw: '600000',
      sizeRaw: '1250000',
      orderCount: 2,
    });
    expect(body.asks[0]?.priceRaw).toBe('650000');
  });

  it('GET /markets/:id/prices returns the indexed price curve', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/markets/1/prices?fromTs=1700000020&limit=10',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<PriceHistoryResponse>()).toEqual({
      marketId: '1',
      points: [
        {
          ts: 1_700_000_020,
          yesPriceRaw: '600000',
          noPriceRaw: '400000',
        },
      ],
    });
  });

  it('GET /truth/:marketId exposes the exact indexed signal derivation', async () => {
    const response = await app.inject({ method: 'GET', url: '/truth/1' });

    expect(response.statusCode).toBe(200);
    expect(response.json<TruthSignalResponse>()).toEqual({
      marketId: '1',
      estimateType: 'INDEXED_MARKET_ESTIMATE',
      fairValueYesRaw: '614166',
      fairValueNoRaw: '385834',
      inputs: {
        currentImpliedYesRaw: '600000',
        recentPrice: {
          pointsUsed: 2,
          oldestTs: 1_700_000_010,
          latestTs: 1_700_000_020,
          oldestYesPriceRaw: '550000',
          latestYesPriceRaw: '600000',
          changeRaw: '50000',
        },
        yesBook: {
          bestBidRaw: '600000',
          bestAskRaw: '650000',
          midpointRaw: '625000',
          bidLiquidityRaw: '1250000',
          askLiquidityRaw: '1000000',
          imbalancePpm: 111111,
        },
        context: {
          phase: 'Graduated',
          tradeCount: 1,
          volumeRaw: '1000000',
        },
      },
      derivation: {
        method: 'INDEXED_MARKET_MICROSTRUCTURE_V1',
        formula: expect.stringContaining('70% current implied YES'),
        currentImpliedWeightBps: 7_000,
        bookMidpointWeightBps: 3_000,
        trendWeightBps: 1_000,
        maxAbsTrendAdjustmentRaw: '25000',
        maxAbsImbalanceAdjustmentRaw: '15000',
        baseRaw: '607500',
        trendAdjustmentRaw: '5000',
        imbalanceAdjustmentRaw: '1666',
        unclampedFairValueYesRaw: '614166',
      },
      caveats: expect.arrayContaining([
        expect.stringContaining('not an external fact oracle'),
        expect.stringContaining('may lag Arc'),
      ]),
    });
  });

  it('GET /truth/:marketId degrades honestly without book or price history', async () => {
    const response = await app.inject({ method: 'GET', url: '/truth/2' });

    expect(response.statusCode).toBe(200);
    const body = response.json<TruthSignalResponse>();
    expect(body.fairValueYesRaw).toBe('550000');
    expect(body.inputs.recentPrice).toMatchObject({
      pointsUsed: 0,
      oldestTs: null,
      latestTs: null,
      changeRaw: '0',
    });
    expect(body.inputs.yesBook).toEqual({
      bestBidRaw: null,
      bestAskRaw: null,
      midpointRaw: null,
      bidLiquidityRaw: '0',
      askLiquidityRaw: '0',
      imbalancePpm: null,
    });
    expect(body.derivation).toMatchObject({
      baseRaw: '550000',
      trendAdjustmentRaw: '0',
      imbalanceAdjustmentRaw: '0',
    });
    expect(body.caveats).toEqual(
      expect.arrayContaining([
        expect.stringContaining('two-sided YES book was unavailable'),
        expect.stringContaining('Fewer than two recent price points'),
        expect.stringContaining('no liquidity'),
        expect.stringContaining('not assert that the market is tradable'),
      ]),
    );
    expect((await app.inject({ method: 'GET', url: '/truth/999' })).statusCode).toBe(
      404,
    );
  });

  it('GET /accounts/:addr returns positions, trades, and estimated PnL', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/accounts/${TRADER.toUpperCase().replace('0X', '0x')}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<AccountResponse>();
    expect(body.account).toEqual({
      address: TRADER,
      firstSeenAt: 1_700_000_010,
      marketsCreated: 0,
      tradeCount: 1,
    });
    expect(body.positions).toEqual([
      {
        account: TRADER,
        marketId: '1',
        outcome: 'YES',
        qtyRaw: '2000000',
        costBasisRaw: '700000',
        costBasisEstimated: true,
        realizedPnlRaw: '100000',
        unrealizedPnlRaw: '500000',
        updatedAt: 1_700_000_020,
      },
    ]);
    expect(body.recentTrades).toHaveLength(1);
    expect(body.pnl).toEqual({
      realizedRaw: '100000',
      unrealizedRaw: '500000',
    });

    const empty = await app.inject({
      method: 'GET',
      url: '/accounts/0xffffffffffffffffffffffffffffffffffffffff',
    });
    expect(empty.json<AccountResponse>()).toEqual({
      account: {
        address: '0xffffffffffffffffffffffffffffffffffffffff',
        firstSeenAt: 0,
        marketsCreated: 0,
        tradeCount: 0,
      },
      positions: [],
      recentTrades: [],
      pnl: { realizedRaw: '0', unrealizedRaw: '0' },
    });
  });

  it('GET /accounts/:addr/exchange-approvals returns indexed state without guessing', async () => {
    await testPrisma.ctfExchangeApproval.create({
      data: {
        owner: TRADER,
        approved: true,
        blockNumber: 101,
        logIndex: 2,
        updatedAt: 1_700_000_020,
      },
    });
    await testPrisma.collateralExchangeApproval.create({
      data: {
        owner: TRADER,
        allowanceRaw: '7654321',
        blockNumber: 102,
        logIndex: 3,
        updatedAt: 1_700_000_030,
      },
    });

    const indexed = await app.inject({
      method: 'GET',
      url: `/accounts/${TRADER}/exchange-approvals`,
    });
    expect(indexed.statusCode).toBe(200);
    expect(indexed.headers['cache-control']).toBe('no-store');
    expect(indexed.json<ExchangeApprovalStateResponse>()).toEqual({
      owner: TRADER,
      ctfApprovedForAll: true,
      collateralAllowanceRaw: '7654321',
      ctfUpdatedAt: 1_700_000_020,
      collateralUpdatedAt: 1_700_000_030,
    });

    const neverApproved = await app.inject({
      method: 'GET',
      url: '/accounts/0xffffffffffffffffffffffffffffffffffffffff/exchange-approvals',
    });
    expect(neverApproved.json<ExchangeApprovalStateResponse>()).toEqual({
      owner: '0xffffffffffffffffffffffffffffffffffffffff',
      ctfApprovedForAll: false,
      collateralAllowanceRaw: '0',
      ctfUpdatedAt: null,
      collateralUpdatedAt: null,
    });
  });

  it('GET /activity returns a filtered keyset page of contract ActivityEvent DTOs', async () => {
    const firstResponse = await app.inject({
      method: 'GET',
      url: `/activity?marketId=1&account=${TRADER}&limit=1`,
    });
    expect(firstResponse.statusCode).toBe(200);
    const first = firstResponse.json<ActivityResponse>();
    expect(first.items).toEqual([
      {
        id: `${TRADE_TX}:4`,
        type: 'Trade',
        marketId: '1',
        account: TRADER,
        outcome: 'YES',
        side: 'BID',
        amountRaw: '2000000',
        priceRaw: '500000',
        txHash: TRADE_TX,
        ts: 1_700_000_010,
      },
    ]);
    expect(first.nextCursor).toBeNull();

    const pagedResponse = await app.inject({
      method: 'GET',
      url: '/activity?marketId=1&limit=1',
    });
    const paged = pagedResponse.json<ActivityResponse>();
    expect(paged.items[0]?.type).toBe('Trade');
    expect(paged.nextCursor).toEqual(expect.any(String));
    const lastResponse = await app.inject({
      method: 'GET',
      url: `/activity?marketId=1&limit=1&cursor=${encodeURIComponent(
        paged.nextCursor ?? '',
      )}`,
    });
    expect(lastResponse.json<ActivityResponse>().items[0]?.type).toBe(
      'MarketCreated',
    );
  });

  it('GET /config returns registry params and active committee members', async () => {
    const response = await app.inject({ method: 'GET', url: '/config' });
    expect(response.statusCode).toBe(200);
    const body = response.json<ConfigResponse>();
    expect(body).toEqual({
      chainId: 5_042_002,
      addresses: {
        usdc: '0x3600000000000000000000000000000000000000',
        ctf: '0x4021798fece71f31564251c2d1a9a7467ada7ae7',
        oracle: '0xd246a354fd469023bfba2dc5ecf4868db034fc57',
        lmsr: '0x33a45f0d31ce4e9bd877c4bbf632df7c5dced566',
        registry: '0x15ee004a3cfd9508ea0b47323762c1780a610ed3',
        miniClob: '0xa4f4e20bb706b38c7bbfeb923b63c2d427c9f7a3',
      },
      marketTypeVersion: 2,
      seedFloorRaw: '1000000',
      seedCapRaw: '50000000',
      graduationTollRaw: '2000000',
      protocolFeeBps: 100,
      minTradingWindowSeconds: 3600,
      maxTradingWindowSeconds: 604800,
      committee: {
        oracle: '0xd246a354fd469023bfba2dc5ecf4868db034fc57',
        signers: [SIGNER_ONE, SIGNER_TWO],
        threshold: 2,
      },
    });

    await testPrisma.$transaction([
      testPrisma.committeeMember.deleteMany(),
      testPrisma.registryConfig.delete({ where: { id: 1 } }),
    ]);
    expect(
      (await app.inject({ method: 'GET', url: '/config' })).json<ConfigResponse>(),
    ).toEqual(body);
  });

  it('GET /health returns the durable indexer cursor and chain lag', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json<HealthResponse>()).toEqual({
      ok: true,
      chainId: 5_042_002,
      indexedBlock: 100,
      headBlock: 103,
      lagBlocks: 3,
      indexerStatus: 'healthy',
      lastSuccessfulPollAt: expect.any(String),
      secondsSinceLastSuccessfulPoll: expect.any(Number),
      balancesReconciled: true,
      unreconciledBalanceGapCount: 0,
      chainState: {
        ready: true,
        status: 'complete',
        attemptedBlock: 100,
        snapshotBlock: 100,
        rpcRequestCount: 0,
        attemptedAt: expect.any(String),
        completedAt: expect.any(String),
        error: null,
        issues: [],
      },
      dedupIndex: READY_DEDUP_INDEX,
      historyGaps: [],
    });
  });

  it('GET /health surfaces a mixed dedup provider index as degraded', async () => {
    dedupIndexHealth = {
      status: 'degraded',
      configuredProvider: 'openai',
      queryProvider: 'fallback',
      canonicalMarketCount: 3,
      providers: {
        openai: {
          indexedMarketCount: 1,
          missingMarketCount: 2,
          unexpectedMarketCount: 0,
          complete: false,
        },
        fallback: {
          indexedMarketCount: 3,
          missingMarketCount: 0,
          unexpectedMarketCount: 0,
          complete: true,
        },
      },
      error: null,
    };

    await expect(
      (await app.inject({ method: 'GET', url: '/health' })).json<HealthResponse>(),
    ).toMatchObject({
      ok: true,
      dedupIndex: dedupIndexHealth,
    });
  });

  it('GET /health surfaces the durable indexer history-gap audit', async () => {
    const recordedAt = new Date('2026-08-11T12:00:00.000Z');
    await testPrisma.indexerGap.create({
      data: {
        chainId: 5_042_002,
        skippedFromBlock: 11,
        skippedToBlock: 99,
        skippedBlockCount: 89,
        cursorBefore: 10,
        cursorAfter: 99,
        headBlock: 100,
        startPolicy: 'auto',
        reason: 'threshold_exceeded',
        maxBackfillBlocks: 50,
        recordedAt,
      },
    });

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json<HealthResponse>()).toMatchObject({
      ok: false,
      indexerStatus: 'degraded',
      balancesReconciled: false,
      unreconciledBalanceGapCount: 1,
      historyGaps: [
        {
          skippedFromBlock: 11,
          skippedToBlock: 99,
          skippedBlockCount: 89,
          cursorBefore: 10,
          cursorAfter: 99,
          headBlock: 100,
          startPolicy: 'auto',
          reason: 'threshold_exceeded',
          maxBackfillBlocks: 50,
          recordedAt: recordedAt.toISOString(),
          balanceReconciliationStatus: 'pending',
          balanceReconciliationBlock: null,
          balanceReconciliationAttemptedAt: null,
          balanceReconciledAt: null,
          balanceReconciliationError: null,
        },
      ],
    });
  });

  it('marks stale indexer liveness stalled and becomes healthy after recovery', async () => {
    const staleAt = new Date(Date.now() - 91_000);
    await testPrisma.$transaction([
      testPrisma.indexerState.update({
        where: { id: 1 },
        data: {
          consecutiveRpcFailures: 4,
          lastSuccessfulPollAt: staleAt,
        },
      }),
      testPrisma.indexerSubscriptionState.update({
        where: { id: 1 },
        data: { lastMessageAt: staleAt },
      }),
    ]);
    const stalled = (
      await app.inject({ method: 'GET', url: '/health' })
    ).json<HealthResponse>();
    expect(stalled).toMatchObject({
      ok: false,
      indexerStatus: 'stalled',
    });
    expect(stalled.secondsSinceLastSuccessfulPoll).toBeGreaterThanOrEqual(91);

    const recoveredAt = new Date();
    await testPrisma.$transaction([
      testPrisma.indexerState.update({
        where: { id: 1 },
        data: {
          consecutiveRpcFailures: 0,
          lastSuccessfulPollAt: recoveredAt,
        },
      }),
      testPrisma.indexerSubscriptionState.update({
        where: { id: 1 },
        data: { lastMessageAt: recoveredAt },
      }),
    ]);
    expect(
      (await app.inject({ method: 'GET', url: '/health' })).json<HealthResponse>(),
    ).toMatchObject({
      ok: true,
      indexerStatus: 'healthy',
      secondsSinceLastSuccessfulPoll: 0,
    });
  });

  it('returns contract-safe 400/404 responses for invalid identifiers', async () => {
    expect((await app.inject({ method: 'GET', url: '/markets/not-a-number' })).statusCode).toBe(
      400,
    );
    expect((await app.inject({ method: 'GET', url: '/markets/999' })).statusCode).toBe(
      404,
    );
    expect(
      (await app.inject({ method: 'GET', url: '/markets?limit=201' })).statusCode,
    ).toBe(400);
  });
});
