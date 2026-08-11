import { Side } from '@predex-pump/shared/tx';
import { beforeEach, describe, expect, it } from 'vitest';

import { getMarketBook, getMarketDetail } from '../src/api/queries.js';
import { ServerEventBus } from '../src/events/bus.js';
import { findFillableSignedOrders } from '../src/orderbook/fillability.js';
import { OrderIngestError } from '../src/orderbook/input.js';
import { OffchainOrderService } from '../src/orderbook/service.js';
import {
  MarketTickUpdateError,
  setMarketMinimumTickSize,
} from '../src/orderbook/tick.js';
import { resetDatabase, testPrisma } from './database.js';
import { seedContractData } from './fixtures.js';
import {
  BOOK_NOW,
  FakeOrderChainReader,
  signedOrderRequest,
  validChainState,
} from './orderbook-fixtures.js';

describe('per-market minimum tick changes', () => {
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
    reader.state = validChainState();
  });

  it('rejects a disallowed tick without changing the market', async () => {
    await expect(
      setMarketMinimumTickSize(testPrisma, '1', 100n),
    ).rejects.toMatchObject({
      code: 'INVALID_TICK_SIZE',
    } satisfies Partial<MarketTickUpdateError>);
    await expect(
      testPrisma.market.findUniqueOrThrow({ where: { id: '1' } }),
    ).resolves.toMatchObject({ minimumTickSizeRaw: '1000' });
  });

  it('accepts every explicitly supported coarser decimal tick', async () => {
    await expect(
      setMarketMinimumTickSize(testPrisma, '1', 100_000n),
    ).resolves.toMatchObject({ minimumTickSizeRaw: '100000' });
  });

  it('exposes the effective tick while leaving an old off-current-tick order valid and fillable', async () => {
    const existing = await signedOrderRequest({
      side: Side.SELL,
      priceRaw: 517_000n,
      sizeRaw: 1_000_000n,
      salt: 801n,
    });
    await service.ingest(existing.request);
    await testPrisma.position.create({
      data: {
        account: existing.account.address.toLowerCase(),
        marketId: '1',
        outcome: 'YES',
        qtyRaw: '1000000',
        updatedAt: BOOK_NOW,
      },
    });
    await testPrisma.bookMigration.create({
      data: {
        marketId: '1',
        status: 'MIGRATED',
        yesSeedOrderId: '20',
        noSeedOrderId: '21',
        createdAt: BOOK_NOW,
        updatedAt: BOOK_NOW,
        migratedAt: BOOK_NOW,
      },
    });

    await setMarketMinimumTickSize(testPrisma, '1', 10_000n);

    const [detail, book, fillable] = await Promise.all([
      getMarketDetail(testPrisma, '1'),
      getMarketBook(testPrisma, '1'),
      findFillableSignedOrders(testPrisma, { marketId: '1' }, BOOK_NOW),
    ]);
    expect(detail?.market.params.minimumTickSizeRaw).toBe('10000');
    expect(book).toMatchObject({
      minimumTickSizeRaw: '10000',
      yes: {
        minimumTickSizeRaw: '10000',
        offchainOrders: [{ orderHash: existing.request.orderHash.toLowerCase() }],
      },
      no: { minimumTickSizeRaw: '10000' },
    });
    expect(fillable.map((order) => order.orderHash)).toContain(
      existing.request.orderHash.toLowerCase(),
    );

    // Idempotent replay is not a new ingest, so the old signed order remains accepted.
    await expect(service.ingest(existing.request)).resolves.toMatchObject({
      order: { orderHash: existing.request.orderHash.toLowerCase() },
    });

    const newlyOffTick = await signedOrderRequest({
      side: Side.SELL,
      priceRaw: 517_000n,
      sizeRaw: 1_000_000n,
      salt: 802n,
    });
    await expect(service.ingest(newlyOffTick.request)).rejects.toMatchObject({
      code: 'PRICE_NOT_ON_TICK',
    } satisfies Partial<OrderIngestError>);
  });
});
