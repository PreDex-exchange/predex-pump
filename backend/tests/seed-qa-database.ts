import { ARC } from '@predex-pump/shared';
import { createPublicClient, http } from 'viem';

import { testPrisma, resetDatabase } from './database.js';
import { seedContractData } from './fixtures.js';

function assertQaDatabase() {
  if (process.env.PREDEX_QA_FIXTURES !== '1') {
    throw new Error('PREDEX_QA_FIXTURES=1 is required to seed QA data.');
  }
  const rawUrl = process.env.TEST_DATABASE_URL;
  if (!rawUrl) throw new Error('TEST_DATABASE_URL is required to seed QA data.');
  const url = new URL(rawUrl);
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error('QA fixtures may only target a loopback PostgreSQL host.');
  }
}

async function main() {
  assertQaDatabase();
  await resetDatabase();
  await seedContractData();

  const arc = createPublicClient({ transport: http(ARC.rpcUrls[0]) });
  const headBlock = Number(await arc.getBlockNumber());
  await testPrisma.indexerState.update({
    where: { id: 1 },
    data: {
      lastBlock: headBlock,
      headBlock,
      lastSuccessfulPollAt: new Date(),
    },
  });

  const graduated = await testPrisma.market.findUniqueOrThrow({
    where: { id: '1' },
  });
  const { id: _id, indexedAt: _indexedAt, ...template } = graduated;
  const now = Math.floor(Date.now() / 1_000);
  await testPrisma.market.create({
    data: {
      ...template,
      id: '3',
      creator: '0xcccccccccccccccccccccccccccccccccccccccc',
      question: 'Will Predex ship its mobile terminal on Arc Testnet?',
      ancillaryData:
        '0x57696c6c20507265646578207368697020697473206d6f62696c65207465726d696e616c206f6e2041726320546573746e65743f',
      ancillaryDataHash: `0x${'c'.repeat(64)}`,
      metadataHash: `0x${'d'.repeat(64)}`,
      phase: 'Opened',
      conditionId: `0x${'3'.repeat(64)}`,
      questionId: `0x${'5'.repeat(64)}`,
      yesTokenId: '301',
      noTokenId: '302',
      yesPriceRaw: '623100',
      noPriceRaw: '376900',
      graduationActivityRaw: '6800000',
      bookAddress: null,
      frozenYesPriceRaw: null,
      handoffSizeRaw: null,
      yesSeedOrderId: null,
      noSeedOrderId: null,
      tradeCount: 0,
      volumeRaw: '6800000',
      qYesRaw: '0',
      qNoRaw: '0',
      fundingCommittedRaw: '0',
      bCurrentWad: '0',
      inventoryYesRaw: '0',
      inventoryNoRaw: '0',
      lastSplitAmountRaw: '0',
      lastMergeAmountRaw: '0',
      createdAt: now - 3_600,
      tradingEndsAt: now + 30 * 24 * 60 * 60,
      graduatedAt: null,
      resolvedAt: null,
      closedOutAt: null,
    },
  });

  await testPrisma.activityEvent.create({
    data: {
      id: `0x${'7'.repeat(64)}:0`,
      type: 'MarketCreated',
      eventName: 'MarketCreated',
      source: 'REGISTRY',
      marketId: '3',
      account: '0xcccccccccccccccccccccccccccccccccccccccc',
      txHash: `0x${'7'.repeat(64)}`,
      logIndex: 0,
      blockNumber: 100,
      ts: now - 3_600,
      data: {},
    },
  });
}

void main()
  .then(() => testPrisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : 'QA fixture seeding failed.');
    await testPrisma.$disconnect();
    process.exitCode = 1;
  });
