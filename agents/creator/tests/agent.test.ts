import type { DedupCheckResponse } from '@predex-pump/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  CreatorAgent,
  runCreatorLoop,
  type MarketCreator,
} from '../src/agent.js';
import type {
  CreatorLogEntry,
  CreatorLogger,
} from '../src/logger.js';
import type {
  CandidateMarket,
  CandidateSource,
} from '../src/source.js';
import { StaticCandidateSource } from '../src/source.js';

class MemoryLogger implements CreatorLogger {
  readonly entries: CreatorLogEntry[] = [];

  write(entry: CreatorLogEntry): void {
    this.entries.push(entry);
  }
}

function response(
  overrides: Partial<DedupCheckResponse> = {},
): DedupCheckResponse {
  return {
    available: true,
    isDuplicate: false,
    canonicalMarketId: null,
    candidates: [],
    ...overrides,
  };
}

function createAgent({
  candidates = [{ question: 'Will a new fact happen?' }],
  dedup = response(),
  dryRun = false,
  createMarket = vi.fn(async () => ({
    marketId: '99',
    txHash: `0x${'ab'.repeat(32)}` as const,
  })),
}: {
  candidates?: readonly CandidateMarket[];
  dedup?: DedupCheckResponse;
  dryRun?: boolean;
  createMarket?: MarketCreator['createMarket'];
} = {}) {
  const logger = new MemoryLogger();
  const marketCreator = { createMarket };
  const agent = new CreatorAgent({
    source: new StaticCandidateSource(candidates),
    dedupCheck: vi.fn(async () => dedup),
    marketCreator,
    logger,
    seedAmountRaw: 2_500_000n,
    tradingWindowSeconds: 21_600n,
    dryRun,
  });
  return { agent, createMarket, logger };
}

describe('CreatorAgent', () => {
  it('skips a duplicate and logs its canonical market without creating', async () => {
    const { agent, createMarket, logger } = createAgent({
      dedup: response({
        isDuplicate: true,
        canonicalMarketId: '42',
        candidates: [
          {
            marketId: '42',
            question: 'Will a new fact happen?',
            score: 1,
            reason: 'Exact same fact.',
          },
        ],
      }),
    });

    await agent.runCycle();

    expect(createMarket).not.toHaveBeenCalled();
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'duplicate',
        canonicalMarketId: '42',
        message: 'considered → duplicate(canonical=42) → skipped',
      }),
    );
  });

  it('creates a new market with the configured seed and window', async () => {
    const { agent, createMarket, logger } = createAgent();

    await agent.runCycle();

    expect(createMarket).toHaveBeenCalledWith({
      question: 'Will a new fact happen?',
      seedAmountRaw: 2_500_000n,
      tradingWindowSeconds: 21_600n,
    });
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'created',
        marketId: '99',
      }),
    );
  });

  it('fails open when dedup is unavailable, then still creates and logs', async () => {
    const { agent, createMarket, logger } = createAgent({
      dedup: response({ available: false }),
    });

    await agent.runCycle();

    expect(createMarket).toHaveBeenCalledOnce();
    expect(logger.entries.map(({ event }) => event)).toEqual([
      'considered',
      'dedup-unavailable',
      'created',
    ]);
  });

  it('catches a thrown dedup request and continues to creation', async () => {
    const createMarket = vi.fn(async () => ({
      marketId: '101',
      txHash: `0x${'ef'.repeat(32)}` as const,
    }));
    const logger = new MemoryLogger();
    const agent = new CreatorAgent({
      source: new StaticCandidateSource([
        { question: 'Will the network recover?' },
      ]),
      dedupCheck: vi.fn(async () => {
        throw new Error('dedup network error');
      }),
      marketCreator: { createMarket },
      logger,
      seedAmountRaw: 1n,
      tradingWindowSeconds: 2n,
      dryRun: false,
    });

    await agent.runCycle();

    expect(createMarket).toHaveBeenCalledOnce();
    expect(
      logger.entries.filter(({ event }) => event === 'dedup-unavailable'),
    ).toHaveLength(1);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'dedup-unavailable',
        message:
          'considered → dedup-error(dedup network error) → fail-open',
      }),
    );
  });

  it('logs source and RPC failures and continues later cycles and candidates', async () => {
    let sourceCalls = 0;
    const source: CandidateSource = {
      async readCandidates() {
        sourceCalls += 1;
        if (sourceCalls === 1) throw new Error('source offline');
        return [
          { question: 'First new fact?' },
          { question: 'Second new fact?' },
        ];
      },
    };
    const createMarket = vi
      .fn<MarketCreator['createMarket']>()
      .mockRejectedValueOnce(new Error('RPC timeout'))
      .mockResolvedValueOnce({
        marketId: '100',
        txHash: `0x${'cd'.repeat(32)}`,
      });
    const logger = new MemoryLogger();
    const agent = new CreatorAgent({
      source,
      dedupCheck: vi.fn(async () => response()),
      marketCreator: { createMarket },
      logger,
      seedAmountRaw: 1n,
      tradingWindowSeconds: 2n,
      dryRun: false,
    });

    await runCreatorLoop(agent, {
      pollIntervalMs: 1,
      maxCycles: 2,
      sleep: async () => {},
      logger,
    });

    expect(sourceCalls).toBe(2);
    expect(createMarket).toHaveBeenCalledTimes(2);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'source-error',
        message: 'source → error(source offline) → continuing',
      }),
    );
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'create-error',
        message:
          'considered → new → rpc-error(RPC timeout) → continuing',
      }),
    );
    expect(logger.entries).toContainEqual(
      expect.objectContaining({ event: 'created', marketId: '100' }),
    );
  });

  it('never invokes the market creator in dry-run mode', async () => {
    const { agent, createMarket, logger } = createAgent({ dryRun: true });

    await agent.runCycle();

    expect(createMarket).not.toHaveBeenCalled();
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'dry-run',
        message: expect.stringContaining('no broadcast'),
      }),
    );
  });
});
