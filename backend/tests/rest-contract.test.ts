import type {
  AccountResponse,
  ActivityResponse,
  ConfigResponse,
  DedupCheckResponse,
  HealthResponse,
  ListMarketsResponse,
  MarketBookResponse,
  MarketDetailResponse,
  OrderBookResponse,
  PriceHistoryResponse,
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

describe('REST shared contract', () => {
  let app: FastifyInstance;

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
                score: 0.98,
                reason: `Same fact as "${question}"`,
              },
            ],
          };
        },
      },
      logger: false,
    });
  });

  beforeEach(async () => {
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
      headers: { origin: 'http://localhost:5173' },
    });
    expect(firstResponse.statusCode).toBe(200);
    expect(firstResponse.headers['access-control-allow-origin']).toBe('*');
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
      },
      createdAt: 1_700_000_100,
      tradingEndsAt: 1_700_086_500,
      graduatedAt: null,
      resolvedAt: 1_700_010_000,
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
  });

  it('GET /markets/:id/book returns both aggregated outcome books', async () => {
    const response = await app.inject({ method: 'GET', url: '/markets/1/book' });
    expect(response.statusCode).toBe(200);
    const body = response.json<MarketBookResponse>();
    expect(body.marketId).toBe('1');
    expect(body.yes).toMatchObject({
      marketId: '1',
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
      outcome: 'NO',
      tokenId: '102',
      bids: [],
      asks: [],
      orders: [],
    });
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
