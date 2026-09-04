import { ADDRESSES, ARC, DEPLOY_BLOCK } from '@predex-pump/shared';
import type { Address, Hex } from 'viem';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { applyDecodedEvents } from '../src/indexer/runner.js';
import type { DecodedEvent } from '../src/indexer/types.js';
import { resetDatabase, testPrisma } from './database.js';

const KNOWN_CONDITION = `0x${'1'.repeat(64)}`;
const KNOWN_QUESTION = `0x${'2'.repeat(64)}`;
const UNKNOWN_CONDITION = `0x${'3'.repeat(64)}`;
const UNKNOWN_QUESTION = `0x${'4'.repeat(64)}`;
const EVENT_BLOCK = 101;
const EVENT_TS = 1_700_000_101;

type ResolutionSource = 'ctf' | 'oracle';

function resolutionEvent(
  source: ResolutionSource,
  known: boolean,
): DecodedEvent {
  if (source === 'ctf') {
    return {
      source: 'CTF',
      address: ADDRESSES.ctf as Address,
      eventName: 'ConditionResolution',
      args: {
        conditionId: known ? KNOWN_CONDITION : UNKNOWN_CONDITION,
        payoutNumerators: [1n, 0n],
      },
      txHash: `0x${'c'.repeat(64)}` as Hex,
      logIndex: 7,
      blockNumber: EVENT_BLOCK,
      ts: EVENT_TS,
    };
  }
  return {
    source: 'ORACLE',
    address: ADDRESSES.oracle as Address,
    eventName: 'QuestionResolved',
    args: {
      questionId: known ? KNOWN_QUESTION : UNKNOWN_QUESTION,
      payouts: [0n, 1n],
    },
    txHash: `0x${'d'.repeat(64)}` as Hex,
    logIndex: 8,
    blockNumber: EVENT_BLOCK,
    ts: EVENT_TS,
  };
}

async function seedKnownMarket(): Promise<void> {
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
      creator: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      question: 'Will this known market resolve?',
      ancillaryData: '0x',
      ancillaryDataHash: `0x${'5'.repeat(64)}`,
      metadataHash: `0x${'6'.repeat(64)}`,
      conditionId: KNOWN_CONDITION,
      questionId: KNOWN_QUESTION,
      marketTypeVersion: 2,
      yesPriceRaw: '600000',
      noPriceRaw: '400000',
      createdAt: 1_700_000_000,
    },
  });
}

describe('public CTF and Oracle resolution isolation', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedKnownMarket();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it.each([
    ['CTF condition', 'ctf'],
    ['Oracle question', 'oracle'],
  ] as const)(
    'commits an unrelated %s once without mutating market projections',
    async (_label, source) => {
      const event = resolutionEvent(source, false);
      const marketBefore = await testPrisma.market.findUniqueOrThrow({
        where: { id: '1' },
        select: {
          phase: true,
          resolvedAt: true,
          yesPriceRaw: true,
          noPriceRaw: true,
        },
      });

      await expect(
        applyDecodedEvents(testPrisma, [event], EVENT_BLOCK, EVENT_BLOCK),
      ).resolves.toBe(1);
      await expect(
        testPrisma.activityEvent.findUnique({
          where: { id: `${event.txHash}:${event.logIndex}` },
          select: { source: true, eventName: true, marketId: true },
        }),
      ).resolves.toEqual({
        source: event.source,
        eventName: event.eventName,
        marketId: null,
      });
      await expect(testPrisma.resolution.count()).resolves.toBe(0);
      await expect(
        testPrisma.market.findUniqueOrThrow({
          where: { id: '1' },
          select: {
            phase: true,
            resolvedAt: true,
            yesPriceRaw: true,
            noPriceRaw: true,
          },
        }),
      ).resolves.toEqual(marketBefore);
      await expect(
        testPrisma.indexerState.findUniqueOrThrow({ where: { id: 1 } }),
      ).resolves.toMatchObject({
        lastBlock: EVENT_BLOCK,
        headBlock: EVENT_BLOCK,
      });

      await expect(
        applyDecodedEvents(testPrisma, [event], EVENT_BLOCK, EVENT_BLOCK),
      ).resolves.toBe(0);
      await expect(
        testPrisma.activityEvent.count({ where: { txHash: event.txHash } }),
      ).resolves.toBe(1);
      await expect(testPrisma.resolution.count()).resolves.toBe(0);
    },
  );

  it.each([
    ['CTF condition', 'ctf', 'YES', 1, 0],
    ['Oracle question', 'oracle', 'NO', 0, 1],
  ] as const)(
    'preserves exact known %s projection',
    async (_label, source, outcome, payoutYes, payoutNo) => {
      const event = resolutionEvent(source, true);

      await expect(
        applyDecodedEvents(testPrisma, [event], EVENT_BLOCK, EVENT_BLOCK),
      ).resolves.toBe(1);
      await expect(
        testPrisma.resolution.findUniqueOrThrow({ where: { marketId: '1' } }),
      ).resolves.toMatchObject({
        marketId: '1',
        conditionId: KNOWN_CONDITION,
        outcome,
        payoutYes,
        payoutNo,
        denominator: 1,
        resolvedAt: EVENT_TS,
        txHash: event.txHash,
        logIndex: event.logIndex,
      });
      await expect(
        testPrisma.market.findUniqueOrThrow({ where: { id: '1' } }),
      ).resolves.toMatchObject({ resolvedAt: EVENT_TS });
    },
  );
});
