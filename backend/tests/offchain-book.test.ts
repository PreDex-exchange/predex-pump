import { ADDRESSES, OFFCHAIN_WITHDRAWAL_WARNING } from '@predex-pump/shared';
import { Side, ctfExchangeAbi, hashCtfExchangeOrder } from '@predex-pump/shared/tx';
import { decodeFunctionData } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';

import { getMarketBook } from '../src/api/queries.js';
import { ServerEventBus } from '../src/events/bus.js';
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
