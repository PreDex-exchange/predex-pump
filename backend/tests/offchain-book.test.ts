import { ADDRESSES, OFFCHAIN_WITHDRAWAL_WARNING } from '@predex-pump/shared';
import { Side, ctfExchangeAbi, hashCtfExchangeOrder } from '@predex-pump/shared/tx';
import { decodeFunctionData } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getMarketBook, getOrderBook } from '../src/api/queries.js';
import { ServerEventBus } from '../src/events/bus.js';
import { fillabilityForOrders } from '../src/orderbook/fillability.js';
import { OffchainOrderService } from '../src/orderbook/service.js';
import { resetDatabase, testPrisma } from './database.js';
import { seedContractData } from './fixtures.js';
import {
  BOOK_NOW,
  FakeOrderChainReader,
  signedOrderRequest,
  validChainState,
} from './orderbook-fixtures.js';

describe('hybrid off-chain book', () => {
  const reader = new FakeOrderChainReader();
  const service = new OffchainOrderService(
    testPrisma,
    reader,
    new ServerEventBus(),
    () => BOOK_NOW,
  );

  beforeEach(async () => {
    await resetDatabase();
    await seedContractData();
    await testPrisma.bookMigration.create({
      data: {
        marketId: '1',
        status: 'MIGRATED',
        yesSeedOrderId: '2',
        noSeedOrderId: '3',
        createdAt: BOOK_NOW,
        updatedAt: BOOK_NOW,
        migratedAt: BOOK_NOW,
      },
    });
    reader.state = validChainState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function ingestSell(priceRaw: bigint, sizeRaw: bigint, salt: bigint) {
    const created = await signedOrderRequest({ priceRaw, sizeRaw, salt });
    reader.state = validChainState();
    await service.ingest(created.request);
    await testPrisma.position.create({
      data: {
        account: created.account.address.toLowerCase(),
        marketId: '1',
        outcome: 'YES',
        qtyRaw: '10000000',
        updatedAt: BOOK_NOW,
      },
    });
    return created;
  }

  async function ingestBuy(priceRaw: bigint, sizeRaw: bigint, salt: bigint) {
    const created = await signedOrderRequest({
      side: Side.BUY,
      priceRaw,
      sizeRaw,
      salt,
    });
    reader.state = validChainState({
      approvalKind: 'COLLATERAL_ALLOWANCE',
      collateralAllowance: 10_000_000n,
      ctfApprovedForAll: null,
    });
    await service.ingest(created.request);
    return created;
  }

  it('aggregates indexed and signed levels and excludes unfillable/expired orders', async () => {
    await ingestBuy(700_000n, 500_000n, 101n);
    await ingestSell(640_000n, 200_000n, 102n);
    await ingestSell(640_000n, 300_000n, 103n);
    const unfillable = await ingestSell(620_000n, 400_000n, 104n);
    const expired = await ingestSell(610_000n, 100_000n, 105n);
    await testPrisma.ctfExchangeApproval.update({
      where: { owner: unfillable.account.address.toLowerCase() },
      data: { approved: false },
    });
    await testPrisma.signedOrder.update({
      where: { orderHash: expired.request.orderHash.toLowerCase() },
      data: { expiration: 1 },
    });

    const book = await getMarketBook(testPrisma, '1');
    expect(book?.yes).toMatchObject({
      bestBidRaw: '700000',
      bestAskRaw: '640000',
      bids: [
        { priceRaw: '700000', sizeRaw: '500000', orderCount: 1 },
      ],
      asks: [
        { priceRaw: '640000', sizeRaw: '500000', orderCount: 2 },
      ],
    });
    expect(book?.yes.offchainOrders).toHaveLength(3);
    expect(
      book?.yes.offchainOrders.map((order) => order.orderHash),
    ).not.toContain(unfillable.request.orderHash.toLowerCase());
    expect(
      book?.yes.offchainOrders.map((order) => order.orderHash),
    ).not.toContain(expired.request.orderHash.toLowerCase());
  });

  it('aggregates only the remaining size of a partially-filled signed order', async () => {
    const created = await ingestSell(640_000n, 1_000_000n, 106n);
    await testPrisma.signedOrder.update({
      where: { orderHash: created.request.orderHash.toLowerCase() },
      data: {
        filledRaw: '250000',
        remainingRaw: '750000',
        status: 'PARTIALLY_FILLED',
      },
    });

    const book = await getMarketBook(testPrisma, '1');
    expect(book?.yes.asks[0]).toEqual({
      priceRaw: '640000',
      sizeRaw: '750000',
      orderCount: 1,
    });
    expect(book?.yes.offchainOrders[0]).toMatchObject({
      filledRaw: '250000',
      remainingRaw: '750000',
    });
  });

  it('rejects an invalid numeric exchange side in reduced fillability rows', async () => {
    const created = await ingestBuy(700_000n, 500_000n, 107n);
    const row = await testPrisma.signedOrder.findUniqueOrThrow({
      where: { orderHash: created.request.orderHash.toLowerCase() },
    });

    await expect(
      fillabilityForOrders(
        testPrisma,
        [{ ...row, exchangeSide: 2 }],
        BOOK_NOW,
      ),
    ).rejects.toThrow('Order side must be Side.BUY or Side.SELL.');
  });

  it('deduplicates SELL position keys and skips inapplicable USER-order readers', async () => {
    const created = await ingestSell(640_000n, 200_000n, 108n);
    const row = await testPrisma.signedOrder.findUniqueOrThrow({
      where: { orderHash: created.request.orderHash.toLowerCase() },
    });
    const positionRead = vi.spyOn(testPrisma.position, 'findMany');
    const ctfRead = vi.spyOn(testPrisma.ctfExchangeApproval, 'findMany');
    const collateralApprovalRead = vi.spyOn(
      testPrisma.collateralExchangeApproval,
      'findMany',
    );
    const collateralBalanceRead = vi.spyOn(
      testPrisma.collateralBalance,
      'findMany',
    );
    const migrationRead = vi.spyOn(testPrisma.bookMigration, 'findMany');
    const indexerRead = vi.spyOn(testPrisma.indexerState, 'findUnique');

    const result = await fillabilityForOrders(
      testPrisma,
      [row, row, row],
      BOOK_NOW,
    );

    expect(result.get(row.orderHash)).toEqual({ fillable: true, reason: null });
    expect(positionRead).toHaveBeenCalledTimes(1);
    expect(positionRead.mock.calls[0]?.[0]).toMatchObject({
      where: {
        OR: [
          {
            account: row.maker,
            marketId: row.marketId,
            outcome: row.outcome,
          },
        ],
      },
    });
    expect(ctfRead).toHaveBeenCalledWith({
      where: { owner: { in: [row.maker] } },
    });
    expect(collateralApprovalRead).not.toHaveBeenCalled();
    expect(collateralBalanceRead).not.toHaveBeenCalled();
    expect(migrationRead).not.toHaveBeenCalled();
    expect(indexerRead).not.toHaveBeenCalled();
  });

  it('queries only collateral asset readers for BUY orders', async () => {
    const created = await ingestBuy(700_000n, 500_000n, 109n);
    const row = await testPrisma.signedOrder.findUniqueOrThrow({
      where: { orderHash: created.request.orderHash.toLowerCase() },
    });
    const positionRead = vi.spyOn(testPrisma.position, 'findMany');
    const ctfRead = vi.spyOn(testPrisma.ctfExchangeApproval, 'findMany');
    const collateralApprovalRead = vi.spyOn(
      testPrisma.collateralExchangeApproval,
      'findMany',
    );
    const collateralBalanceRead = vi.spyOn(
      testPrisma.collateralBalance,
      'findMany',
    );
    const migrationRead = vi.spyOn(testPrisma.bookMigration, 'findMany');
    const indexerRead = vi.spyOn(testPrisma.indexerState, 'findUnique');

    const result = await fillabilityForOrders(testPrisma, [row], BOOK_NOW);

    expect(result.get(row.orderHash)).toEqual({ fillable: true, reason: null });
    expect(positionRead).not.toHaveBeenCalled();
    expect(ctfRead).not.toHaveBeenCalled();
    expect(collateralApprovalRead).toHaveBeenCalledWith({
      where: { owner: { in: [row.maker] } },
    });
    expect(collateralBalanceRead).toHaveBeenCalledWith({
      where: { owner: { in: [row.maker] } },
    });
    expect(migrationRead).not.toHaveBeenCalled();
    expect(indexerRead).not.toHaveBeenCalled();
  });

  it('walks past unfillable Hybrid candidates to build a bounded top-of-book', async () => {
    const lowerBid = await ingestBuy(650_000n, 500_000n, 201n);
    const bestBid = await ingestBuy(700_000n, 500_000n, 202n);
    const higherAsk = await ingestSell(640_000n, 200_000n, 203n);
    const bestAsk = await ingestSell(620_000n, 300_000n, 204n);
    const tiedBestAsk = await ingestSell(620_000n, 100_000n, 206n);
    const expired = await ingestSell(610_000n, 100_000n, 205n);
    await testPrisma.signedOrder.update({
      where: { orderHash: expired.request.orderHash.toLowerCase() },
      data: { expiration: 1 },
    });

    const bounded = await getMarketBook(testPrisma, '1', BOOK_NOW, 1);
    await expect(
      testPrisma.signedOrder.findUniqueOrThrow({
        where: { orderHash: expired.request.orderHash.toLowerCase() },
      }),
    ).resolves.toMatchObject({ status: 'OPEN', expiration: 1 });
    const boundedToken = await getOrderBook(testPrisma, '101', BOOK_NOW, 1);
    await expect(
      testPrisma.signedOrder.findUniqueOrThrow({
        where: { orderHash: expired.request.orderHash.toLowerCase() },
      }),
    ).resolves.toMatchObject({ status: 'OPEN', expiration: 1 });
    const legacy = await getMarketBook(testPrisma, '1', BOOK_NOW);

    expect(bounded?.yes.bids.map(({ priceRaw }) => priceRaw)).toEqual([
      '700000',
    ]);
    expect(bounded?.yes.asks.map(({ priceRaw }) => priceRaw)).toEqual([
      '620000',
    ]);
    expect(
      bounded?.yes.offchainOrders.map(({ orderHash }) => orderHash),
    ).toEqual([
      bestBid.request.orderHash.toLowerCase(),
      [bestAsk, tiedBestAsk]
        .map(({ request }) => request.orderHash.toLowerCase())
        .sort((left, right) => left.localeCompare(right))[0],
    ]);
    expect(
      bounded?.yes.offchainOrders.map(({ orderHash }) => orderHash),
    ).not.toContain(expired.request.orderHash.toLowerCase());
    expect(bounded?.yes.orderWindow).toEqual({
      limitPerSide: 1,
      orders: { returned: 0, truncated: false },
      offchainOrders: { returned: 2, truncated: true },
    });
    expect(boundedToken?.offchainOrders).toEqual(bounded?.yes.offchainOrders);
    expect(boundedToken?.bids).toEqual(bounded?.yes.bids);
    expect(boundedToken?.asks).toEqual(bounded?.yes.asks);
    expect(boundedToken?.orderWindow).toEqual(bounded?.yes.orderWindow);
    expect(legacy?.yes.offchainOrders).toHaveLength(5);
    expect(legacy?.yes).not.toHaveProperty('orderWindow');
    await expect(
      testPrisma.signedOrder.findUniqueOrThrow({
        where: { orderHash: expired.request.orderHash.toLowerCase() },
      }),
    ).resolves.toMatchObject({ status: 'EXPIRED' });
    expect(legacy?.yes.offchainOrders.map(({ orderHash }) => orderHash)).toEqual(
      expect.arrayContaining([
        lowerBid.request.orderHash.toLowerCase(),
        higherAsk.request.orderHash.toLowerCase(),
      ]),
    );
  });

  it('keeps ended Hybrid orders manageable but removes them from public ladders', async () => {
    const created = await ingestSell(640_000n, 200_000n, 1061n);
    await testPrisma.market.update({
      where: { id: '1' },
      data: { tradingEndsAt: BOOK_NOW },
    });
    const row = await testPrisma.signedOrder.findUniqueOrThrow({
      where: { orderHash: created.request.orderHash.toLowerCase() },
    });

    const [marketBook, tokenBook, fillability] = await Promise.all([
      getMarketBook(testPrisma, '1', BOOK_NOW),
      getOrderBook(testPrisma, '101', BOOK_NOW),
      fillabilityForOrders(testPrisma, [row], BOOK_NOW),
    ]);

    expect(marketBook).toMatchObject({
      orderBookAvailable: true,
      liveVenue: 'HYBRID',
      tradingOpen: false,
      yes: { bids: [], asks: [], offchainOrders: [] },
      no: { bids: [], asks: [], offchainOrders: [] },
    });
    expect(tokenBook).toMatchObject({ bids: [], asks: [], offchainOrders: [] });
    expect(fillability.get(row.orderHash)).toEqual({
      fillable: false,
      reason: 'TRADING_ENDED',
    });
    await expect(
      testPrisma.signedOrder.findUniqueOrThrow({
        where: { orderHash: row.orderHash },
      }),
    ).resolves.toMatchObject({ status: 'OPEN', withdrawnAt: null });
  });

  it('retains ended MiniCLOB orders for cancellation without exposing a live ladder', async () => {
    await testPrisma.bookMigration.delete({ where: { marketId: '1' } });
    await testPrisma.market.update({
      where: { id: '1' },
      data: { tradingEndsAt: BOOK_NOW },
    });

    const [marketBook, tokenBook] = await Promise.all([
      getMarketBook(testPrisma, '1', BOOK_NOW),
      getOrderBook(testPrisma, '101', BOOK_NOW),
    ]);

    expect(marketBook).toMatchObject({
      orderBookAvailable: true,
      liveVenue: 'MINICLOB',
      tradingOpen: false,
      yes: {
        bids: [],
        asks: [],
        bestBidRaw: null,
        bestAskRaw: null,
      },
    });
    expect(marketBook?.yes.orders.length).toBeGreaterThan(0);
    expect(marketBook?.yes.orders.every(({ open }) => open)).toBe(true);
    expect(tokenBook).toMatchObject({
      bids: [],
      asks: [],
      orders: [],
      offchainOrders: [],
    });
  });

  it('withdraws only from this book and returns the authoritative on-chain cancel call', async () => {
    const created = await ingestSell(640_000n, 200_000n, 107n);
    expect(
      (await getMarketBook(testPrisma, '1'))?.yes.offchainOrders,
    ).toHaveLength(1);

    const response = await service.withdraw(
      created.request.orderHash.toLowerCase(),
      created.account.address.toLowerCase(),
    );
    expect(response).toMatchObject({
      offchainWithdrawalIsOnchainCancellation: false,
      signedOrderMayRemainValidOnchain: true,
      warning: OFFCHAIN_WITHDRAWAL_WARNING,
      authoritativeCancelOrderTx: {
        to: ADDRESSES.ctfExchange,
        valueRaw: '0',
      },
    });
    expect(
      decodeFunctionData({
        abi: ctfExchangeAbi,
        data: response.authoritativeCancelOrderTx.data,
      }).functionName,
    ).toBe('cancelOrder');
    expect(
      (await getMarketBook(testPrisma, '1'))?.yes.offchainOrders,
    ).toHaveLength(0);

    const stored = await testPrisma.signedOrder.findUniqueOrThrow({
      where: { orderHash: created.request.orderHash.toLowerCase() },
    });
    expect(stored).toMatchObject({
      status: 'WITHDRAWN',
      signature: created.request.order.signature,
    });
    expect(hashCtfExchangeOrder(created.order).toLowerCase()).toBe(
      stored.orderHash,
    );
  });
});
