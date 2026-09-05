import { ADDRESSES } from '@predex-pump/shared';
import { Side } from '@predex-pump/shared/tx';
import type { Address, Hex, PublicClient } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getExchangeApprovalState,
  getMarketBook,
} from '../src/api/queries.js';
import { ServerEventBus } from '../src/events/bus.js';
import { publishIndexedEvents } from '../src/events/projector.js';
import type { CollateralAllowanceSnapshot } from '../src/indexer/handlers.js';
import {
  applyDecodedEvents,
  readExchangeFillAllowanceSnapshots,
} from '../src/indexer/runner.js';
import type { DecodedEvent } from '../src/indexer/types.js';
import { OffchainOrderService } from '../src/orderbook/service.js';
import { resetDatabase, testPrisma } from './database.js';
import { MARKET_ONE_CONDITION, seedContractData } from './fixtures.js';
import {
  BOOK_NOW,
  FakeOrderChainReader,
  signedOrderRequest,
  throwawayAccount,
  validChainState,
} from './orderbook-fixtures.js';

function event(
  source: DecodedEvent['source'],
  address: Address,
  eventName: string,
  args: Record<string, unknown>,
  blockNumber: number,
): DecodedEvent {
  return {
    source,
    address,
    eventName,
    args,
    txHash: `0x${blockNumber.toString(16).padStart(64, '0')}` as Hex,
    logIndex: 0,
    blockNumber,
    ts: BOOK_NOW + blockNumber,
  };
}

function exchangeFillEvent(input: {
  orderHash: string;
  maker: Address;
  taker: Address;
  blockNumber: number;
  makerAmountFilled?: bigint;
  takerAmountFilled?: bigint;
}): DecodedEvent {
  return event(
    'CTF_EXCHANGE',
    ADDRESSES.ctfExchange,
    'OrderFilled',
    {
      orderHash: input.orderHash,
      maker: input.maker,
      taker: input.taker,
      tokenId: 101n,
      makerAmountFilled: input.makerAmountFilled ?? 1_000n,
      takerAmountFilled: input.takerAmountFilled ?? 498n,
    },
    input.blockNumber,
  );
}

describe('exchange approval and lifecycle indexing', () => {
  const reader = new FakeOrderChainReader();
  const eventBus = new ServerEventBus();
  const service = new OffchainOrderService(
    testPrisma,
    reader,
    eventBus,
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

  async function ingestSell(salt: bigint) {
    const created = await signedOrderRequest({ salt });
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

  async function apply(
    indexedEvent: DecodedEvent,
    collateralAllowanceSnapshots: readonly CollateralAllowanceSnapshot[] = [],
  ): Promise<number> {
    return applyDecodedEvents(
      testPrisma,
      [indexedEvent],
      indexedEvent.blockNumber,
      indexedEvent.blockNumber,
      (events) => publishIndexedEvents(testPrisma, eventBus, events),
      undefined,
      undefined,
      undefined,
      collateralAllowanceSnapshots,
    );
  }

  it('grant then revoke flips fillability and publishes book refreshes', async () => {
    const created = await ingestSell(201n);
    const owner = created.account.address.toLowerCase();
    await testPrisma.ctfExchangeApproval.update({
      where: { owner },
      data: { approved: false, blockNumber: 150, logIndex: 0 },
    });
    expect((await getMarketBook(testPrisma, '1'))?.yes.offchainOrders).toHaveLength(0);

    const updates: string[] = [];
    const unsubscribe = eventBus.subscribe('book:1', ({ event: published }) => {
      updates.push(published.event);
    });
    try {
      await apply(
        event(
          'CTF',
          ADDRESSES.ctf,
          'ApprovalForAll',
          {
            account: owner,
            operator: ADDRESSES.ctfExchange,
            approved: true,
          },
          200,
        ),
      );
      expect((await getMarketBook(testPrisma, '1'))?.yes.offchainOrders).toHaveLength(1);

      await apply(
        event(
          'CTF',
          ADDRESSES.ctf,
          'ApprovalForAll',
          {
            account: owner,
            operator: ADDRESSES.ctfExchange,
            approved: false,
          },
          201,
        ),
      );
      expect((await getMarketBook(testPrisma, '1'))?.yes.offchainOrders).toHaveLength(0);
      expect(updates).toEqual(['book.updated', 'book.updated']);
    } finally {
      unsubscribe();
    }
  });

  it('does not store an approval naming any other operator', async () => {
    const created = await ingestSell(202n);
    const owner = created.account.address.toLowerCase();
    const applied = await apply(
      event(
        'CTF',
        ADDRESSES.ctf,
        'ApprovalForAll',
        {
          account: owner,
          operator: '0x1111111111111111111111111111111111111111',
          approved: false,
        },
        210,
      ),
    );
    expect(applied).toBe(0);
    expect(await testPrisma.ctfExchangeApproval.findUnique({ where: { owner } })).toMatchObject({
      approved: true,
      blockNumber: 123,
    });
  });

  it('indexes collateral allowance grants and revocations for BUY fillability', async () => {
    const created = await signedOrderRequest({
      side: Side.BUY,
      priceRaw: 600_000n,
      sizeRaw: 1_000_000n,
      salt: 204n,
    });
    reader.state = validChainState({
      approvalKind: 'COLLATERAL_ALLOWANCE',
      collateralAllowance: 10_000_000n,
      ctfApprovedForAll: null,
    });
    await service.ingest(created.request);
    const owner = created.account.address.toLowerCase();

    await apply(
      event(
        'COLLATERAL',
        ADDRESSES.usdc,
        'Approval',
        { owner, spender: ADDRESSES.ctfExchange, value: 0n },
        211,
      ),
    );
    expect((await getMarketBook(testPrisma, '1'))?.yes.offchainOrders).toHaveLength(0);

    await apply(
      event(
        'COLLATERAL',
        ADDRESSES.usdc,
        'Approval',
        { owner, spender: ADDRESSES.ctfExchange, value: 1_000_000n },
        212,
      ),
    );
    expect((await getMarketBook(testPrisma, '1'))?.yes.offchainOrders).toHaveLength(1);
  });

  it('repairs a silently consumed 498 allowance from an idempotent fill replay', async () => {
    const created = await ingestSell(209n);
    const taker = '0x2222222222222222222222222222222222222222';
    await testPrisma.collateralExchangeApproval.create({
      data: {
        owner: taker,
        allowanceRaw: '498',
        blockNumber: 213,
        logIndex: 4,
        updatedAt: BOOK_NOW + 213,
      },
    });
    const fillEvent = exchangeFillEvent({
      orderHash: created.request.orderHash,
      maker: created.account.address,
      taker,
      blockNumber: 214,
    });

    expect(await apply(fillEvent)).toBe(1);
    await expect(getExchangeApprovalState(testPrisma, taker)).resolves.toMatchObject({
      collateralAllowanceRaw: '498',
    });

    expect(
      await apply(fillEvent, [
        {
          owner: taker,
          allowanceRaw: 0n,
          blockNumber: fillEvent.blockNumber,
          updatedAt: fillEvent.ts,
        },
      ]),
    ).toBe(0);
    await expect(
      testPrisma.collateralExchangeApproval.findUniqueOrThrow({
        where: { owner: taker },
      }),
    ).resolves.toMatchObject({
      allowanceRaw: '0',
      blockNumber: 214,
      logIndex: 2_147_483_647,
      updatedAt: fillEvent.ts,
    });
    await expect(
      testPrisma.trade.count({
        where: { id: `${fillEvent.txHash}:${fillEvent.logIndex}` },
      }),
    ).resolves.toBe(1);
  });

  it('creates missing snapshots, advances stale rows, and protects later rows', async () => {
    const owner = '0x4444444444444444444444444444444444444444';
    const applySnapshots = (
      toBlock: number,
      snapshots: readonly CollateralAllowanceSnapshot[],
    ) =>
      applyDecodedEvents(
        testPrisma,
        [],
        toBlock,
        toBlock,
        undefined,
        undefined,
        undefined,
        undefined,
        snapshots,
      );

    await applySnapshots(230, [
      { owner, allowanceRaw: 700n, blockNumber: 230, updatedAt: BOOK_NOW + 230 },
    ]);
    await expect(
      testPrisma.collateralExchangeApproval.findUniqueOrThrow({ where: { owner } }),
    ).resolves.toMatchObject({ allowanceRaw: '700', blockNumber: 230 });

    await testPrisma.collateralExchangeApproval.update({
      where: { owner },
      data: { blockNumber: 231, logIndex: 4, updatedAt: BOOK_NOW + 231 },
    });
    await applySnapshots(231, [
      { owner, allowanceRaw: 400n, blockNumber: 231, updatedAt: BOOK_NOW + 231 },
    ]);
    await expect(
      testPrisma.collateralExchangeApproval.findUniqueOrThrow({ where: { owner } }),
    ).resolves.toMatchObject({
      allowanceRaw: '400',
      blockNumber: 231,
      logIndex: 2_147_483_647,
    });

    await testPrisma.collateralExchangeApproval.update({
      where: { owner },
      data: {
        allowanceRaw: '900',
        blockNumber: 233,
        logIndex: 1,
        updatedAt: BOOK_NOW + 233,
      },
    });
    await applySnapshots(234, [
      { owner, allowanceRaw: 0n, blockNumber: 232, updatedAt: BOOK_NOW + 232 },
    ]);
    await expect(
      testPrisma.collateralExchangeApproval.findUniqueOrThrow({ where: { owner } }),
    ).resolves.toMatchObject({
      allowanceRaw: '900',
      blockNumber: 233,
      logIndex: 1,
    });
  });

  it('deduplicates known fill payers into one highest-block allowance read', async () => {
    const ask = await ingestSell(210n);
    const bid = await signedOrderRequest({
      side: Side.BUY,
      priceRaw: 600_000n,
      sizeRaw: 1_000_000n,
      salt: 211n,
    });
    reader.state = validChainState({
      approvalKind: 'COLLATERAL_ALLOWANCE',
      collateralAllowance: 10_000_000n,
      ctfApprovedForAll: null,
    });
    await service.ingest(bid.request);
    const askTaker = '0x5555555555555555555555555555555555555555';
    const unknownHash = `0x${'f'.repeat(64)}`;
    const fills = [
      exchangeFillEvent({
        orderHash: ask.request.orderHash,
        maker: ask.account.address,
        taker: askTaker,
        blockNumber: 240,
        takerAmountFilled: 650n,
      }),
      exchangeFillEvent({
        orderHash: ask.request.orderHash,
        maker: ask.account.address,
        taker: askTaker,
        blockNumber: 241,
        takerAmountFilled: 650n,
      }),
      exchangeFillEvent({
        orderHash: bid.request.orderHash,
        maker: bid.account.address,
        taker: '0x6666666666666666666666666666666666666666',
        blockNumber: 245,
        makerAmountFilled: 600n,
        takerAmountFilled: 1_000n,
      }),
      exchangeFillEvent({
        orderHash: unknownHash,
        maker: '0x7777777777777777777777777777777777777777',
        taker: '0x8888888888888888888888888888888888888888',
        blockNumber: 250,
        takerAmountFilled: 500n,
      }),
    ];
    const multicall = vi.fn(async () => [
      { status: 'success' as const, result: 0n },
      { status: 'success' as const, result: 123n },
    ]);
    const spacer = vi.fn(async () => undefined);

    const snapshots = await readExchangeFillAllowanceSnapshots(
      testPrisma,
      { multicall } as unknown as PublicClient,
      fills,
      400,
      spacer,
    );

    expect(spacer).toHaveBeenCalledOnce();
    expect(spacer).toHaveBeenCalledWith(400);
    expect(multicall).toHaveBeenCalledOnce();
    expect(multicall).toHaveBeenCalledWith(
      expect.objectContaining({
        allowFailure: true,
        blockNumber: 250n,
        contracts: expect.arrayContaining([
          expect.objectContaining({
            functionName: 'allowance',
            args: [askTaker, ADDRESSES.ctfExchange],
          }),
          expect.objectContaining({
            functionName: 'allowance',
            args: [bid.account.address.toLowerCase(), ADDRESSES.ctfExchange],
          }),
        ]),
      }),
    );
    expect(snapshots).toHaveLength(2);
    expect(snapshots.map(({ owner }) => owner).sort()).toEqual(
      [askTaker, bid.account.address.toLowerCase()].sort(),
    );
    expect(snapshots).toEqual(
      snapshots.map((snapshot) => ({
        ...snapshot,
        blockNumber: 250,
        updatedAt: BOOK_NOW + 250,
      })),
    );

    multicall.mockClear();
    spacer.mockClear();
    await expect(
      readExchangeFillAllowanceSnapshots(
        testPrisma,
        { multicall } as unknown as PublicClient,
        [event('CTF_EXCHANGE', ADDRESSES.ctfExchange, 'OrderCancelled', {}, 251)],
        400,
        spacer,
      ),
    ).resolves.toEqual([]);
    expect(multicall).not.toHaveBeenCalled();
    expect(spacer).not.toHaveBeenCalled();

    const partialMulticall = vi.fn(async () => [
      { status: 'success' as const, result: 0n },
      { status: 'failure' as const, error: new Error('one allowance read failed') },
    ]);
    await expect(
      readExchangeFillAllowanceSnapshots(
        testPrisma,
        { multicall: partialMulticall } as unknown as PublicClient,
        fills,
        0,
      ),
    ).rejects.toThrow('one allowance read failed');
    expect(partialMulticall).toHaveBeenCalledOnce();
  });

  it('indexes exchange fills, cancellation, and token registration', async () => {
    const created = await ingestSell(203n);
    const orderHash = created.request.orderHash.toLowerCase();
    const taker = '0x2222222222222222222222222222222222222222';
    await apply(
      event(
        'CTF',
        ADDRESSES.ctf,
        'TransferSingle',
        {
          from: created.account.address,
          to: taker,
          id: 101n,
          value: 400_000n,
        },
        219,
      ),
    );
    await apply(
      event(
        'CTF_EXCHANGE',
        ADDRESSES.ctfExchange,
        'TokenRegistered',
        {
          tokenId: 101n,
          complement: 102n,
          conditionId: MARKET_ONE_CONDITION,
        },
        220,
      ),
    );
    const fillEvent = event(
      'CTF_EXCHANGE',
      ADDRESSES.ctfExchange,
      'OrderFilled',
      {
        orderHash,
        maker: created.account.address,
        taker,
        tokenId: 101n,
        makerAmountFilled: 400_000n,
        takerAmountFilled: 260_000n,
      },
      221,
    );
    const published: string[] = [];
    const capture = ({ event: publishedEvent }: Parameters<
      Parameters<ServerEventBus['subscribe']>[1]
    >[0]): void => {
      published.push(`${publishedEvent.channel}:${publishedEvent.event}`);
    };
    const unsubscribeMarkets = eventBus.subscribe('markets', capture);
    const unsubscribeMarket = eventBus.subscribe('market:1', capture);
    const unsubscribeAccount = eventBus.subscribe(`account:${taker}`, capture);
    try {
      await apply(fillEvent);
    } finally {
      unsubscribeMarkets();
      unsubscribeMarket();
      unsubscribeAccount();
    }
    expect(published).toEqual([
      'markets:market.updated',
      'market:1:trade',
      `account:${taker}:trade`,
    ]);
    expect(await testPrisma.signedOrder.findUniqueOrThrow({ where: { orderHash } })).toMatchObject({
      filledRaw: '400000',
      remainingRaw: '600000',
      status: 'PARTIALLY_FILLED',
    });
    expect(
      await testPrisma.trade.findUnique({
        where: { id: `${fillEvent.txHash}:${fillEvent.logIndex}` },
      }),
    ).toMatchObject({
      venue: 'BOOK',
      account: taker,
      recipient: taker,
      outcome: 'YES',
      side: 'BID',
      sizeRaw: '400000',
      priceRaw: '650000',
      costRaw: '260000',
    });
    expect(
      await testPrisma.activityEvent.findUniqueOrThrow({
        where: { id: `${fillEvent.txHash}:${fillEvent.logIndex}` },
      }),
    ).toMatchObject({
      account: taker,
      outcome: 'YES',
      side: 'BID',
      amountRaw: '400000',
      priceRaw: '650000',
    });
    expect(
      await testPrisma.position.findUniqueOrThrow({
        where: {
          account_marketId_outcome: { account: taker, marketId: '1', outcome: 'YES' },
        },
      }),
    ).toMatchObject({
      qtyRaw: '400000',
      costBasisRaw: '260000',
      unrealizedPnlRaw: '-20000',
    });
    expect(await testPrisma.market.findUniqueOrThrow({ where: { id: '1' } })).toMatchObject({
      tradeCount: 2,
      volumeRaw: '1260000',
    });
    expect(await testPrisma.account.findUniqueOrThrow({ where: { address: taker } })).toMatchObject({
      tradeCount: 1,
      unrealizedPnlRaw: '-20000',
    });
    expect(await testPrisma.exchangeTokenRegistration.findUnique({
      where: { tokenId: '101' },
    })).toMatchObject({
      complementTokenId: '102',
      conditionId: MARKET_ONE_CONDITION,
      blockNumber: 220,
    });
    await apply(
      event(
        'CTF_EXCHANGE',
        ADDRESSES.ctfExchange,
        'OrderCancelled',
        { orderHash, maker: created.account.address },
        222,
      ),
    );
    expect(await testPrisma.signedOrder.findUniqueOrThrow({ where: { orderHash } })).toMatchObject({
      status: 'CANCELLED',
      remainingRaw: '600000',
    });
    expect((await getMarketBook(testPrisma, '1'))?.yes.offchainOrders).toHaveLength(0);
  });

  it('accounts for the signed-order maker buying from a direct seller', async () => {
    const buyer = await signedOrderRequest({
      side: Side.BUY,
      priceRaw: 400_000n,
      sizeRaw: 1_000_000n,
      salt: 208n,
    });
    reader.state = validChainState({
      approvalKind: 'COLLATERAL_ALLOWANCE',
      collateralAllowance: 10_000_000n,
      ctfApprovedForAll: null,
    });
    await service.ingest(buyer.request);
    const buyerAddress = buyer.account.address.toLowerCase();
    const sellerAddress = throwawayAccount().address.toLowerCase();
    await testPrisma.account.create({
      data: {
        address: sellerAddress,
        firstSeenAt: BOOK_NOW,
        unrealizedPnlRaw: '200000',
      },
    });
    await testPrisma.position.create({
      data: {
        account: sellerAddress,
        marketId: '1',
        outcome: 'YES',
        qtyRaw: '500000',
        costBasisRaw: '100000',
        unrealizedPnlRaw: '200000',
        updatedAt: BOOK_NOW,
      },
    });
    await apply(
      event(
        'CTF',
        ADDRESSES.ctf,
        'TransferSingle',
        { from: sellerAddress, to: buyerAddress, id: 101n, value: 100_000n },
        230,
      ),
    );
    const fillEvent = event(
      'CTF_EXCHANGE',
      ADDRESSES.ctfExchange,
      'OrderFilled',
      {
        orderHash: buyer.request.orderHash,
        maker: buyerAddress,
        taker: sellerAddress,
        tokenId: 101n,
        makerAmountFilled: 40_000n,
        takerAmountFilled: 100_000n,
      },
      231,
    );
    await apply(fillEvent);

    expect(
      await testPrisma.trade.findUniqueOrThrow({
        where: { id: `${fillEvent.txHash}:${fillEvent.logIndex}` },
      }),
    ).toMatchObject({
      venue: 'BOOK',
      account: sellerAddress,
      recipient: buyerAddress,
      side: 'ASK',
      sizeRaw: '100000',
      priceRaw: '400000',
      costRaw: '40000',
    });
    expect(
      await testPrisma.activityEvent.findUniqueOrThrow({
        where: { id: `${fillEvent.txHash}:${fillEvent.logIndex}` },
      }),
    ).toMatchObject({
      account: sellerAddress,
      outcome: 'YES',
      side: 'ASK',
      amountRaw: '100000',
      priceRaw: '400000',
    });
    expect(
      await testPrisma.position.findUniqueOrThrow({
        where: {
          account_marketId_outcome: {
            account: buyerAddress,
            marketId: '1',
            outcome: 'YES',
          },
        },
      }),
    ).toMatchObject({ qtyRaw: '100000', costBasisRaw: '40000', unrealizedPnlRaw: '20000' });
    expect(
      await testPrisma.position.findUniqueOrThrow({
        where: {
          account_marketId_outcome: {
            account: sellerAddress,
            marketId: '1',
            outcome: 'YES',
          },
        },
      }),
    ).toMatchObject({
      qtyRaw: '400000',
      costBasisRaw: '80000',
      realizedPnlRaw: '20000',
      unrealizedPnlRaw: '160000',
    });
    expect(
      await testPrisma.account.findUniqueOrThrow({ where: { address: sellerAddress } }),
    ).toMatchObject({ tradeCount: 1, realizedPnlRaw: '20000', unrealizedPnlRaw: '160000' });
  });

  it('projects an operator match fill onto both signed orders', async () => {
    const maker = await ingestSell(205n);
    const unrelatedMaker = await ingestSell(207n);
    const taker = await signedOrderRequest({
      side: Side.BUY,
      priceRaw: 700_000n,
      sizeRaw: 2_000_000n,
      salt: 206n,
    });
    reader.state = validChainState({
      approvalKind: 'COLLATERAL_ALLOWANCE',
      collateralAllowance: 10_000_000n,
      ctfApprovedForAll: null,
    });
    await service.ingest(taker.request);

    const blockNumber = 223;
    const txHash = `0x${blockNumber.toString(16).padStart(64, '0')}`;
    const makerOrderHash = maker.request.orderHash.toLowerCase();
    const takerOrderHash = taker.request.orderHash.toLowerCase();
    await testPrisma.signedOrder.update({
      where: { orderHash: takerOrderHash },
      data: { filledRaw: '250000', remainingRaw: '1750000', status: 'PARTIALLY_FILLED' },
    });
    await testPrisma.settlementMatch.create({
      data: {
        id: 'operator-match-fill',
        matchKey: 'operator-match-fill',
        makerOrderHash,
        takerOrderHash,
        tokenId: '101',
        fillSizeRaw: '1000000',
        makerFilledBeforeRaw: '0',
        takerFilledBeforeRaw: '0',
        status: 'SUBMITTING',
        createdAt: BOOK_NOW,
        updatedAt: BOOK_NOW,
      },
    });
    await testPrisma.settlementMatch.create({
      data: {
        id: 'unrelated-submitted-match',
        matchKey: 'unrelated-submitted-match',
        makerOrderHash: unrelatedMaker.request.orderHash.toLowerCase(),
        takerOrderHash,
        tokenId: '101',
        fillSizeRaw: '1000',
        makerFilledBeforeRaw: '0',
        takerFilledBeforeRaw: '0',
        status: 'SUBMITTED',
        txHash,
        createdAt: BOOK_NOW,
        updatedAt: BOOK_NOW,
      },
    });

    const fillEvent = event(
      'CTF_EXCHANGE',
      ADDRESSES.ctfExchange,
      'OrderFilled',
      {
        orderHash: makerOrderHash,
        maker: maker.account.address,
        taker: taker.account.address,
        tokenId: 101n,
        makerAmountFilled: 1_000_000n,
        takerAmountFilled: 650_000n,
      },
      blockNumber,
    );
    await expect(apply(fillEvent)).rejects.toThrow(
      'arrived before settlement operator-match-fill had a known transaction hash',
    );
    expect(
      await testPrisma.signedOrder.findUniqueOrThrow({
        where: { orderHash: makerOrderHash },
      }),
    ).toMatchObject({ filledRaw: '0', remainingRaw: '1000000', status: 'OPEN' });
    expect(
      await testPrisma.signedOrder.findUniqueOrThrow({
        where: { orderHash: takerOrderHash },
      }),
    ).toMatchObject({
      filledRaw: '250000',
      remainingRaw: '1750000',
      status: 'PARTIALLY_FILLED',
    });

    await testPrisma.settlementMatch.update({
      where: { id: 'operator-match-fill' },
      data: { status: 'SUBMISSION_UNKNOWN' },
    });
    await expect(apply(fillEvent)).rejects.toThrow(
      'arrived before settlement operator-match-fill had a known transaction hash',
    );
    await testPrisma.settlementMatch.update({
      where: { id: 'operator-match-fill' },
      data: { status: 'SUBMITTED', txHash },
    });
    await testPrisma.settlementMatch.create({
      data: {
        id: 'ambiguous-submitted-match',
        matchKey: 'ambiguous-submitted-match',
        makerOrderHash,
        takerOrderHash,
        tokenId: '101',
        fillSizeRaw: '1000000',
        makerFilledBeforeRaw: '0',
        takerFilledBeforeRaw: '0',
        status: 'SUBMITTED',
        txHash,
        createdAt: BOOK_NOW,
        updatedAt: BOOK_NOW,
      },
    });
    await expect(apply(fillEvent)).rejects.toThrow(
      `Exchange fill matches multiple submitted settlements for ${makerOrderHash}`,
    );
    await testPrisma.settlementMatch.update({
      where: { id: 'ambiguous-submitted-match' },
      data: { status: 'FAILED' },
    });
    for (const args of [
      { ...fillEvent.args, makerAmountFilled: 999_000n },
      { ...fillEvent.args, tokenId: 102n },
      { ...fillEvent.args, maker: '0x3333333333333333333333333333333333333333' },
      { ...fillEvent.args, taker: '0x3333333333333333333333333333333333333333' },
    ]) {
      await expect(apply({ ...fillEvent, args })).rejects.toThrow(
        'Exchange fill does not match submitted settlement operator-match-fill',
      );
    }
    await apply(
      event(
        'CTF',
        ADDRESSES.ctf,
        'TransferSingle',
        {
          from: maker.account.address,
          to: taker.account.address,
          id: 101n,
          value: 1_000_000n,
        },
        blockNumber - 1,
      ),
    );
    await apply(fillEvent);

    expect(
      await testPrisma.signedOrder.findUniqueOrThrow({
        where: { orderHash: makerOrderHash },
      }),
    ).toMatchObject({
      filledRaw: '1000000',
      remainingRaw: '0',
      status: 'FILLED',
      lastOnchainTxHash: txHash,
      lastOnchainBlock: blockNumber,
    });
    expect(
      await testPrisma.signedOrder.findUniqueOrThrow({
        where: { orderHash: takerOrderHash },
      }),
    ).toMatchObject({
      filledRaw: '1250000',
      remainingRaw: '750000',
      status: 'PARTIALLY_FILLED',
      lastOnchainTxHash: txHash,
      lastOnchainBlock: blockNumber,
    });
    expect(
      await testPrisma.settlementMatch.findUniqueOrThrow({
        where: { id: 'operator-match-fill' },
      }),
    ).toMatchObject({ status: 'CONFIRMED' });
    expect(
      await testPrisma.settlementMatch.findUniqueOrThrow({
        where: { id: 'unrelated-submitted-match' },
      }),
    ).toMatchObject({ status: 'SUBMITTED' });
    expect(await apply(fillEvent)).toBe(0);
    expect(
      await testPrisma.signedOrder.findUniqueOrThrow({
        where: { orderHash: takerOrderHash },
      }),
    ).toMatchObject({ filledRaw: '1250000', remainingRaw: '750000' });
    expect(
      await testPrisma.trade.findUniqueOrThrow({
        where: { id: `${fillEvent.txHash}:${fillEvent.logIndex}` },
      }),
    ).toMatchObject({
      venue: 'BOOK',
      account: taker.account.address.toLowerCase(),
      recipient: taker.account.address.toLowerCase(),
      side: 'BID',
      sizeRaw: '1000000',
      priceRaw: '650000',
      costRaw: '650000',
    });
    expect(
      await testPrisma.position.findUniqueOrThrow({
        where: {
          account_marketId_outcome: {
            account: taker.account.address.toLowerCase(),
            marketId: '1',
            outcome: 'YES',
          },
        },
      }),
    ).toMatchObject({
      qtyRaw: '1000000',
      costBasisRaw: '650000',
      unrealizedPnlRaw: '-50000',
    });
    expect((await getMarketBook(testPrisma, '1'))?.yes.offchainOrders).toMatchObject([
      { orderHash: takerOrderHash, remainingRaw: '750000' },
      { orderHash: unrelatedMaker.request.orderHash.toLowerCase() },
    ]);
  });
});
