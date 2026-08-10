import { ADDRESSES } from '@predex-pump/shared';
import type { Address, Hex } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';

import { getMarketBook } from '../src/api/queries.js';
import { ServerEventBus } from '../src/events/bus.js';
import { publishIndexedEvents } from '../src/events/projector.js';
import { applyDecodedEvents } from '../src/indexer/runner.js';
import type { DecodedEvent } from '../src/indexer/types.js';
import { OffchainOrderService } from '../src/orderbook/service.js';
import { resetDatabase, testPrisma } from './database.js';
import { MARKET_ONE_CONDITION, seedContractData } from './fixtures.js';
import {
  BOOK_NOW,
  FakeOrderChainReader,
  signedOrderRequest,
  validChainState,
} from './orderbook-fixtures.js';
import { Side } from '@predex-pump/shared/tx';

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

  async function apply(indexedEvent: DecodedEvent): Promise<number> {
    return applyDecodedEvents(
      testPrisma,
      [indexedEvent],
      indexedEvent.blockNumber,
      indexedEvent.blockNumber,
      (events) => publishIndexedEvents(testPrisma, eventBus, events),
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

  it('indexes exchange fills, cancellation, and token registration', async () => {
    const created = await ingestSell(203n);
    const orderHash = created.request.orderHash.toLowerCase();
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
    await apply(
      event(
        'CTF_EXCHANGE',
        ADDRESSES.ctfExchange,
        'OrderFilled',
        {
          orderHash,
          maker: created.account.address,
          taker: '0x2222222222222222222222222222222222222222',
          tokenId: 101n,
          makerAmountFilled: 400_000n,
          takerAmountFilled: 260_000n,
        },
        221,
      ),
    );
    expect(await testPrisma.signedOrder.findUniqueOrThrow({ where: { orderHash } })).toMatchObject({
      filledRaw: '400000',
      remainingRaw: '600000',
      status: 'PARTIALLY_FILLED',
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
});
