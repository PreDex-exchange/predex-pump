import { ADDRESSES } from '@predex-pump/shared';
import type { Address, Hex } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MarketDedupIndexer } from '../src/dedup/types.js';
import { applyDecodedEvents } from '../src/indexer/runner.js';
import type { DecodedEvent } from '../src/indexer/types.js';
import { resetDatabase, testPrisma } from './database.js';
import { DEPLOYER, seedContractData } from './fixtures.js';

describe('post-commit market dedup sync', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedContractData();
  });

  it('keeps MarketCreated indexing committed and idempotent when vector upsert fails', async () => {
    const question = 'Will BTC close above $70k Friday?';
    const event: DecodedEvent = {
      source: 'REGISTRY',
      address: ADDRESSES.registry as Address,
      eventName: 'MarketCreated',
      args: {
        marketId: 3n,
        creator: DEPLOYER,
        conditionId: `0x${'c'.repeat(64)}`,
        questionId: `0x${'d'.repeat(64)}`,
        marketTypeVersion: 2,
        ancillaryDataHash: `0x${'e'.repeat(64)}`,
        ancillaryData: `0x${Buffer.from(question).toString('hex')}`,
        metadataHash: `0x${'f'.repeat(64)}`,
        openedAt: 1_700_000_300n,
      },
      txHash: `0x${'a'.repeat(64)}` as Hex,
      logIndex: 1,
      blockNumber: 111,
      ts: 1_700_000_300,
    };
    const indexMarket = vi.fn<MarketDedupIndexer['indexMarket']>().mockRejectedValue(
      new Error('Qdrant upsert failed'),
    );
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const applied = await applyDecodedEvents(
      testPrisma,
      [event],
      111,
      111,
      undefined,
      { indexMarket },
    );
    expect(applied).toBe(1);
    expect(indexMarket).toHaveBeenCalledWith({
      marketId: '3',
      question,
      phase: 'Opened',
    });
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('best-effort sync failed'),
      expect.any(Error),
    );
    expect(
      await testPrisma.market.findUnique({ where: { id: '3' } }),
    ).not.toBeNull();
    expect(
      await testPrisma.activityEvent.findUnique({
        where: { id: `${event.txHash}:${event.logIndex}` },
      }),
    ).not.toBeNull();

    expect(
      await applyDecodedEvents(
        testPrisma,
        [event],
        111,
        111,
        undefined,
        { indexMarket },
      ),
    ).toBe(0);
    expect(indexMarket).toHaveBeenCalledTimes(1);
    warning.mockRestore();
  });
});
