import { ADDRESSES, ARC, DEPLOY_BLOCK } from '@predex-pump/shared';
import type { Address, Hex } from 'viem';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { getMarketBook } from '../src/api/queries.js';
import { applyDecodedEvents } from '../src/indexer/runner.js';
import type { DecodedEvent } from '../src/indexer/types.js';
import { resetDatabase, testPrisma } from './database.js';

const BLOCK_NUMBER = 110;
const SEEDED_AT = 1_700_003_600;
const TX_HASH = `0x${'f'.repeat(64)}` as Hex;
const MARKET_ONE_CONDITION = `0x${'1'.repeat(64)}`;
const PROTOCOL_QUOTE_RECIPIENT =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const YES_SEED_ORDER_ID = 2n;
const NO_SEED_ORDER_ID = 3n;

function bookSeededEvent(): DecodedEvent {
  return {
    source: 'REGISTRY',
    address: ADDRESSES.registry as Address,
    eventName: 'MarketGraduationBookSeeded',
    args: {
      marketId: 1n,
      conditionId: MARKET_ONE_CONDITION,
      miniClob: ADDRESSES.miniClob,
      sizeRaw: 5_000_000n,
      frozenYesPriceRaw: 600_000n,
      yesOrderId: YES_SEED_ORDER_ID,
      noOrderId: NO_SEED_ORDER_ID,
    },
    txHash: TX_HASH,
    logIndex: 10,
    blockNumber: BLOCK_NUMBER,
    ts: SEEDED_AT,
  };
}

function marketGraduatedEvent(): DecodedEvent {
  return {
    source: 'REGISTRY',
    address: ADDRESSES.registry as Address,
    eventName: 'MarketGraduated',
    args: {
      marketId: 1n,
      conditionId: MARKET_ONE_CONDITION,
      activityMoneyInRaw: 25_000_000n,
      activityThresholdRaw: 25_000_000n,
      graduationTollRaw: 2_000_000n,
      minimumTimeOpen: 3_600n,
      graduatedAt: BigInt(SEEDED_AT),
    },
    txHash: TX_HASH,
    logIndex: 11,
    blockNumber: BLOCK_NUMBER,
    ts: SEEDED_AT,
  };
}

function failingLaterEvent(): DecodedEvent {
  return {
    source: 'MINI_CLOB',
    address: ADDRESSES.miniClob as Address,
    eventName: 'OrderFilled',
    args: { orderId: 999n },
    txHash: TX_HASH,
    logIndex: 12,
    blockNumber: BLOCK_NUMBER,
    ts: SEEDED_AT,
  };
}

const graduationEvents = [bookSeededEvent(), marketGraduatedEvent()];

async function seedMarketBeforeGraduation(): Promise<void> {
  await testPrisma.indexerState.create({
    data: {
      id: 1,
      chainId: ARC.chainId,
      deployBlock: DEPLOY_BLOCK,
      lastBlock: 100,
      headBlock: 100,
    },
  });
  await testPrisma.market.create({
    data: {
      id: '1',
      creator: PROTOCOL_QUOTE_RECIPIENT,
      question: 'Will this market graduate?',
      ancillaryData: '0x',
      ancillaryDataHash: `0x${'2'.repeat(64)}`,
      metadataHash: `0x${'3'.repeat(64)}`,
      phase: 'Opened',
      conditionId: MARKET_ONE_CONDITION,
      questionId: `0x${'4'.repeat(64)}`,
      marketTypeVersion: 2,
      collateralAddress: ADDRESSES.usdc.toLowerCase(),
      collateralDecimals: 6,
      yesTokenId: '101',
      noTokenId: '102',
      yesPriceRaw: '500000',
      noPriceRaw: '500000',
      createdAt: 1_700_000_000,
    },
  });
  await testPrisma.order.createMany({
    data: [
      {
        orderId: YES_SEED_ORDER_ID.toString(),
        marketId: '1',
        conditionId: MARKET_ONE_CONDITION,
        tokenId: '101',
        outcome: 'YES',
        maker: PROTOCOL_QUOTE_RECIPIENT,
        side: 'ASK',
        priceRaw: '600000',
        sizeRaw: '5000000',
        escrowRaw: '5000000',
        remainingRaw: '5000000',
        txHash: TX_HASH,
        logIndex: 8,
        blockNumber: BLOCK_NUMBER,
        createdAt: SEEDED_AT,
        updatedAt: SEEDED_AT,
      },
      {
        orderId: NO_SEED_ORDER_ID.toString(),
        marketId: '1',
        conditionId: MARKET_ONE_CONDITION,
        tokenId: '102',
        outcome: 'NO',
        maker: PROTOCOL_QUOTE_RECIPIENT,
        side: 'ASK',
        priceRaw: '400000',
        sizeRaw: '5000000',
        escrowRaw: '5000000',
        remainingRaw: '5000000',
        txHash: TX_HASH,
        logIndex: 9,
        blockNumber: BLOCK_NUMBER,
        createdAt: SEEDED_AT,
        updatedAt: SEEDED_AT,
      },
    ],
  });
}

describe('indexer book-migration intent', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedMarketBeforeGraduation();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it('atomically exposes PREPARING with the committed graduation projection', async () => {
    await expect(getMarketBook(testPrisma, '1')).resolves.toMatchObject({
      orderBookAvailable: false,
      liveVenue: 'LMSR',
      yes: { orders: [] },
      no: { orders: [] },
    });
    await expect(
      testPrisma.bookMigration.findUnique({ where: { marketId: '1' } }),
    ).resolves.toBeNull();

    await expect(
      applyDecodedEvents(
        testPrisma,
        graduationEvents,
        BLOCK_NUMBER,
        BLOCK_NUMBER,
      ),
    ).resolves.toBe(2);

    await expect(
      testPrisma.bookMigration.findUniqueOrThrow({ where: { marketId: '1' } }),
    ).resolves.toMatchObject({
      marketId: '1',
      status: 'DISCOVERED',
      yesSeedOrderId: YES_SEED_ORDER_ID.toString(),
      noSeedOrderId: NO_SEED_ORDER_ID.toString(),
      approvalStatus: 'UNCHECKED',
      registrationStatus: 'UNCHECKED',
      yesCancelStatus: 'UNCHECKED',
      noCancelStatus: 'UNCHECKED',
      attemptCount: 0,
      nextAttemptAt: 0,
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
    });
    await expect(getMarketBook(testPrisma, '1')).resolves.toMatchObject({
      orderBookAvailable: false,
      liveVenue: 'NONE',
      venueTransition: { state: 'PREPARING' },
      yes: { orders: [], offchainOrders: [] },
      no: { orders: [], offchainOrders: [] },
    });
    await expect(
      testPrisma.order.findMany({
        orderBy: { orderId: 'asc' },
        select: { orderId: true, isSeed: true },
      }),
    ).resolves.toEqual([
      { orderId: YES_SEED_ORDER_ID.toString(), isSeed: true },
      { orderId: NO_SEED_ORDER_ID.toString(), isSeed: true },
    ]);

    await expect(
      applyDecodedEvents(
        testPrisma,
        graduationEvents,
        BLOCK_NUMBER,
        BLOCK_NUMBER,
      ),
    ).resolves.toBe(0);
    await expect(
      testPrisma.bookMigration.count({ where: { marketId: '1' } }),
    ).resolves.toBe(1);
  });

  it('does not reset a migration already advanced by the operator', async () => {
    await testPrisma.bookMigration.create({
      data: {
        marketId: '1',
        status: 'STAGED',
        yesSeedOrderId: YES_SEED_ORDER_ID.toString(),
        noSeedOrderId: NO_SEED_ORDER_ID.toString(),
        snapshotBlockNumber: 109,
        attemptCount: 3,
        createdAt: SEEDED_AT - 10,
        updatedAt: SEEDED_AT - 5,
      },
    });

    await applyDecodedEvents(
      testPrisma,
      graduationEvents,
      BLOCK_NUMBER,
      BLOCK_NUMBER,
    );

    await expect(
      testPrisma.bookMigration.findUniqueOrThrow({ where: { marketId: '1' } }),
    ).resolves.toMatchObject({
      status: 'STAGED',
      snapshotBlockNumber: 109,
      attemptCount: 3,
      createdAt: SEEDED_AT - 10,
      updatedAt: SEEDED_AT - 5,
    });
  });

  it('rolls back intent, seed projection, activity, and cursor when a later event fails', async () => {
    const cursorBefore = await testPrisma.indexerState.findUniqueOrThrow({
      where: { id: 1 },
    });

    await expect(
      applyDecodedEvents(
        testPrisma,
        [...graduationEvents, failingLaterEvent()],
        BLOCK_NUMBER,
        BLOCK_NUMBER,
      ),
    ).rejects.toThrow('Fill refers to unknown orderId 999');

    await expect(
      testPrisma.market.findUniqueOrThrow({
        where: { id: '1' },
        select: {
          phase: true,
          bookAddress: true,
          frozenYesPriceRaw: true,
          handoffSizeRaw: true,
          yesSeedOrderId: true,
          noSeedOrderId: true,
          yesPriceRaw: true,
          noPriceRaw: true,
          graduatedAt: true,
        },
      }),
    ).resolves.toEqual({
      phase: 'Opened',
      bookAddress: null,
      frozenYesPriceRaw: null,
      handoffSizeRaw: null,
      yesSeedOrderId: null,
      noSeedOrderId: null,
      yesPriceRaw: '500000',
      noPriceRaw: '500000',
      graduatedAt: null,
    });
    await expect(
      testPrisma.order.findMany({
        where: {
          orderId: {
            in: [YES_SEED_ORDER_ID.toString(), NO_SEED_ORDER_ID.toString()],
          },
        },
        orderBy: { orderId: 'asc' },
        select: { isSeed: true },
      }),
    ).resolves.toEqual([{ isSeed: false }, { isSeed: false }]);
    await expect(
      testPrisma.bookMigration.findUnique({ where: { marketId: '1' } }),
    ).resolves.toBeNull();
    await expect(
      testPrisma.activityEvent.count({ where: { txHash: TX_HASH } }),
    ).resolves.toBe(0);
    await expect(
      testPrisma.indexerState.findUniqueOrThrow({ where: { id: 1 } }),
    ).resolves.toMatchObject({
      lastBlock: cursorBefore.lastBlock,
      headBlock: cursorBefore.headBlock,
    });
  });
});
