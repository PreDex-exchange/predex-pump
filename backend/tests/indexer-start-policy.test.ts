import { ARC } from '@predex-pump/shared';
import type { PublicClient } from 'viem';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { loadRuntimeConfig, type RuntimeConfig } from '../src/config.js';
import { runIndexer } from '../src/indexer/runner.js';
import { testChainStateReader } from './chain-state-fixtures.js';
import { resetDatabase, testPrisma } from './database.js';
import { seedContractData } from './fixtures.js';

interface FakeGetLogsParameters {
  address?: unknown;
  fromBlock?: bigint;
  toBlock?: bigint;
}

function testConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    ...loadRuntimeConfig(),
    deployBlock: 100,
    blockChunk: 1_000,
    pollMs: 60_000,
    fallbackPollMs: 60_000,
    chunkDelayMs: 0,
    webSocketRpcUrls: [],
    indexerStartPolicy: 'auto',
    indexerMaxBackfillBlocks: 5,
    ...overrides,
  };
}

function fakeClient(
  getBlockNumber: () => Promise<unknown>,
  ranges: Array<[bigint | undefined, bigint | undefined]> = [],
) {
  const getLogs = vi.fn(async (parameters: FakeGetLogsParameters) => {
    if (Array.isArray(parameters.address)) {
      ranges.push([parameters.fromBlock, parameters.toBlock]);
    }
    return [];
  });
  const client = {
    getBlockNumber,
    getLogs,
    getBlock: vi.fn(),
  } as unknown as PublicClient;
  return { client, getLogs };
}

async function seedCursor(input: {
  lastBlock: number;
  headBlock?: number;
}): Promise<void> {
  await testPrisma.indexerState.create({
    data: {
      id: 1,
      chainId: ARC.chainId,
      deployBlock: 100,
      lastBlock: input.lastBlock,
      headBlock: input.headBlock ?? input.lastBlock,
    },
  });
}

describe('indexer startup policy', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it('resumes a small gap exactly at the cursor and records no skipped history', async () => {
    await seedCursor({ lastBlock: 100 });
    const ranges: Array<[bigint | undefined, bigint | undefined]> = [];
    const { client } = fakeClient(async () => 105n, ranges);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await runIndexer(testPrisma, testConfig(), {
      once: true,
      client,
      chainStateReader: testChainStateReader,
    });

    expect(ranges).toEqual([[101n, 105n]]);
    expect(
      await testPrisma.indexerState.findUniqueOrThrow({ where: { id: 1 } }),
    ).toMatchObject({ lastBlock: 105, headBlock: 105 });
    expect(await testPrisma.indexerGap.findMany()).toEqual([]);
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining(
        'startPolicy=auto maxBackfillBlocks=5 decision=resume reason=within-threshold',
      ),
    );
  });

  it('starts at head beyond the threshold and atomically records and logs the skipped range', async () => {
    await seedCursor({ lastBlock: 100 });
    const ranges: Array<[bigint | undefined, bigint | undefined]> = [];
    const { client } = fakeClient(async () => 110n, ranges);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const recordedAt = new Date('2026-08-11T12:00:00.000Z');

    await runIndexer(testPrisma, testConfig(), {
      once: true,
      client,
      chainStateReader: testChainStateReader,
      now: () => recordedAt,
    });

    expect(ranges).toEqual([[110n, 110n]]);
    expect(
      await testPrisma.indexerState.findUniqueOrThrow({ where: { id: 1 } }),
    ).toMatchObject({ lastBlock: 110, headBlock: 110 });
    expect(await testPrisma.indexerGap.findMany()).toEqual([
      expect.objectContaining({
        chainId: ARC.chainId,
        skippedFromBlock: 101,
        skippedToBlock: 109,
        skippedBlockCount: 9,
        cursorBefore: 100,
        cursorAfter: 109,
        headBlock: 110,
        startPolicy: 'auto',
        reason: 'threshold_exceeded',
        maxBackfillBlocks: 5,
        recordedAt,
        balanceReconciliationStatus: 'COMPLETE',
        balanceReconciliationBlock: 109,
        balanceReconciledAt: recordedAt,
      }),
    ]);
    expect(error).toHaveBeenCalledWith(
      '[indexer] HISTORY GAP RECORDED skipped=101-109 blocks=9 ' +
        'cursorBefore=100 cursorAfter=109 head=110 startPolicy=auto ' +
        'reason=threshold_exceeded maxBackfillBlocks=5',
    );
  });

  it('automatically reconciles scoped balances before indexing past a recorded gap', async () => {
    await seedContractData();
    await testPrisma.indexerState.update({
      where: { id: 1 },
      data: { deployBlock: 100, lastBlock: 100, headBlock: 100 },
    });
    const ranges: Array<[bigint | undefined, bigint | undefined]> = [];
    const { client } = fakeClient(async () => 110n, ranges);
    const multicall = vi.fn(
      async (parameters: { contracts: readonly unknown[]; blockNumber: bigint }) =>
        parameters.contracts.map(() => ({
          status: 'success' as const,
          result: 1_000_000n,
        })),
    );
    Object.assign(client, { multicall });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await runIndexer(testPrisma, testConfig(), {
      once: true,
      client,
      chainStateReader: testChainStateReader,
    });

    expect(multicall).toHaveBeenCalledTimes(1);
    expect(multicall).toHaveBeenCalledWith(
      expect.objectContaining({ blockNumber: 109n, allowFailure: true }),
    );
    expect(ranges).toEqual([[110n, 110n]]);
    expect(await testPrisma.indexerGap.findMany()).toEqual([
      expect.objectContaining({
        balanceReconciliationStatus: 'COMPLETE',
        balanceReconciliationBlock: 109,
        balanceReconciliationError: null,
      }),
    ]);
  });

  it.each([
    ['zero', 0n],
    ['negative', -1n],
    ['absurd', 2_147_483_648n],
    ['non-numeric', '0xnot-a-block'],
    ['empty', undefined],
  ])('rejects the %s head without writing indexer state', async (_label, head) => {
    await seedCursor({ lastBlock: 100 });
    const before = await testPrisma.indexerState.findUniqueOrThrow({
      where: { id: 1 },
    });
    const { client, getLogs } = fakeClient(async () => head);
    const update = vi.spyOn(testPrisma.indexerState, 'update');

    await expect(
      runIndexer(testPrisma, testConfig({ indexerStartPolicy: 'head' }), {
        once: true,
        client,
        chainStateReader: testChainStateReader,
      }),
    ).rejects.toThrow(/Invalid Arc head/);

    expect(update).not.toHaveBeenCalled();
    expect(
      await testPrisma.indexerState.findUniqueOrThrow({ where: { id: 1 } }),
    ).toEqual(before);
    expect(await testPrisma.indexerGap.count()).toBe(0);
    expect(getLogs).not.toHaveBeenCalled();
  });

  it('leaves the cursor untouched when the head RPC read fails', async () => {
    await seedCursor({ lastBlock: 100 });
    const before = await testPrisma.indexerState.findUniqueOrThrow({
      where: { id: 1 },
    });
    const { client, getLogs } = fakeClient(async () => {
      throw new Error('RPC returned an empty body');
    });
    const update = vi.spyOn(testPrisma.indexerState, 'update');

    await expect(
      runIndexer(testPrisma, testConfig({ indexerStartPolicy: 'head' }), {
        once: true,
        client,
        chainStateReader: testChainStateReader,
      }),
    ).rejects.toThrow('RPC returned an empty body');

    expect(update).not.toHaveBeenCalled();
    expect(
      await testPrisma.indexerState.findUniqueOrThrow({ where: { id: 1 } }),
    ).toEqual(before);
    expect(await testPrisma.indexerGap.count()).toBe(0);
    expect(getLogs).not.toHaveBeenCalled();
  });

  it('rejects a non-monotonic head without moving either stored block backwards', async () => {
    await seedCursor({ lastBlock: 100, headBlock: 105 });
    const before = await testPrisma.indexerState.findUniqueOrThrow({
      where: { id: 1 },
    });
    const { client, getLogs } = fakeClient(async () => 104n);

    await expect(
      runIndexer(testPrisma, testConfig(), {
        once: true,
        client,
        chainStateReader: testChainStateReader,
      }),
    ).rejects.toThrow(
      'Head guard: Arc head=104 is behind last accepted head=105',
    );

    expect(
      await testPrisma.indexerState.findUniqueOrThrow({ where: { id: 1 } }),
    ).toEqual(before);
    expect(getLogs).not.toHaveBeenCalled();
  });

  it('preserves the cursor-ahead-of-head guard', async () => {
    await seedCursor({ lastBlock: 105, headBlock: 100 });
    const { client, getLogs } = fakeClient(async () => 104n);

    await expect(
      runIndexer(testPrisma, testConfig(), {
        once: true,
        client,
        chainStateReader: testChainStateReader,
      }),
    ).rejects.toThrow(
      'Cursor guard: database lastBlock=105 is ahead of Arc head=104',
    );
    expect(getLogs).not.toHaveBeenCalled();
  });

  it('never moves the durable cursor backwards during an explicit replay', async () => {
    await seedCursor({ lastBlock: 105 });
    const ranges: Array<[bigint | undefined, bigint | undefined]> = [];
    const { client } = fakeClient(async () => 105n, ranges);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await runIndexer(testPrisma, testConfig(), {
      once: true,
      client,
      chainStateReader: testChainStateReader,
      replayFrom: 100,
    });

    expect(ranges).toEqual([[100n, 105n]]);
    expect(
      await testPrisma.indexerState.findUniqueOrThrow({ where: { id: 1 } }),
    ).toMatchObject({ lastBlock: 105, headBlock: 105 });
  });

  it('head override skips even below the threshold', async () => {
    await seedCursor({ lastBlock: 100 });
    const ranges: Array<[bigint | undefined, bigint | undefined]> = [];
    const { client } = fakeClient(async () => 102n, ranges);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await runIndexer(
      testPrisma,
      testConfig({
        indexerStartPolicy: 'resume',
        indexerMaxBackfillBlocks: 1_000,
      }),
      {
        once: true,
        client,
        startPolicy: 'head',
        chainStateReader: testChainStateReader,
      },
    );

    expect(ranges).toEqual([[102n, 102n]]);
    expect(await testPrisma.indexerGap.findMany()).toEqual([
      expect.objectContaining({
        skippedFromBlock: 101,
        skippedToBlock: 101,
        startPolicy: 'head',
        reason: 'operator_override',
      }),
    ]);
  });

  it('resume override backfills even beyond the threshold', async () => {
    await seedCursor({ lastBlock: 100 });
    const ranges: Array<[bigint | undefined, bigint | undefined]> = [];
    const { client } = fakeClient(async () => 108n, ranges);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await runIndexer(
      testPrisma,
      testConfig({
        indexerStartPolicy: 'head',
        indexerMaxBackfillBlocks: 1,
      }),
      {
        once: true,
        client,
        startPolicy: 'resume',
        chainStateReader: testChainStateReader,
      },
    );

    expect(ranges).toEqual([[101n, 108n]]);
    expect(await testPrisma.indexerGap.count()).toBe(0);
  });
});
