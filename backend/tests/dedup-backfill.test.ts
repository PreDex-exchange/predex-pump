import { describe, expect, it, vi } from 'vitest';

import {
  dedupBackfillHasFailures,
  runDedupBackfill,
} from '../src/dedup/backfill-runner.js';
import { FallbackMarketIntelligenceProvider } from '../src/dedup/fallback-provider.js';
import { MarketVectorIndexer } from '../src/dedup/indexer.js';
import type {
  EmbeddingProviderMode,
  MarketIntelligenceProvider,
  MarketVectorPoint,
  MarketVectorStore,
} from '../src/dedup/types.js';

class RecordingVectorStore implements MarketVectorStore {
  readonly points: MarketVectorPoint[] = [];

  constructor(
    private readonly rejectedProvider?: EmbeddingProviderMode,
  ) {}

  async upsertMarket(point: MarketVectorPoint): Promise<void> {
    if (point.payload.embeddingProvider === this.rejectedProvider) {
      throw new Error(`${this.rejectedProvider} upsert unavailable`);
    }
    this.points.push(point);
  }

  async listMarketIds(mode: EmbeddingProviderMode): Promise<string[]> {
    return this.points
      .filter((point) => point.payload.embeddingProvider === mode)
      .map((point) => point.payload.marketId);
  }

  async searchMarkets(): Promise<[]> {
    return [];
  }
}

describe('dedup backfill reporting', () => {
  it('reports per-provider counts and degraded items when primary embeds fall back', async () => {
    const fallback = new FallbackMarketIntelligenceProvider();
    const primary: MarketIntelligenceProvider = {
      mode: 'openai',
      embed: async (question) => {
        if (question.includes('two') || question.includes('three')) {
          throw new Error('primary embedding unavailable');
        }
        return fallback.embed(question);
      },
      extractFields: (question) => fallback.extractFields(question),
      judgeSameFact: (draft, candidate) =>
        fallback.judgeSameFact(draft, candidate),
    };
    const store = new RecordingVectorStore();
    const info = vi.fn();
    const warn = vi.fn();
    let page = 0;
    const summary = await runDedupBackfill({
      configuredProvider: 'openai',
      indexer: new MarketVectorIndexer(primary, store, fallback),
      readPage: async () => {
        page += 1;
        return page === 1
          ? [
              { marketId: '1', question: 'Market one?', phase: 'Opened' as const },
              { marketId: '2', question: 'Market two?', phase: 'Opened' as const },
              { marketId: '3', question: 'Market three?', phase: 'Opened' as const },
            ]
          : [];
      },
      logger: { info, warn },
    });

    expect(summary).toEqual({
      processed: 3,
      indexed: 3,
      complete: 1,
      degraded: 2,
      partial: 0,
      unindexed: 0,
      indexedByProvider: { openai: 1, fallback: 3 },
      providerFailures: { openai: 2, fallback: 0 },
    });
    expect(dedupBackfillHasFailures(summary)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
    const output = info.mock.calls.flat().join('\n');
    expect(output).toContain('degraded=2');
    expect(output).toContain('providers.openai=1');
    expect(output).toContain('providers.fallback=3');
    expect(output).toContain('providerFailures.openai=2');
    expect(output).not.toContain('failed=0');
  });

  it('reports a companion-partition write failure without hiding the successful write', async () => {
    const fallback = new FallbackMarketIntelligenceProvider();
    const primary: MarketIntelligenceProvider = {
      mode: 'openai',
      embed: (question) => fallback.embed(question),
      extractFields: (question) => fallback.extractFields(question),
      judgeSameFact: (draft, candidate) =>
        fallback.judgeSameFact(draft, candidate),
    };
    let page = 0;
    const summary = await runDedupBackfill({
      configuredProvider: 'openai',
      indexer: new MarketVectorIndexer(
        primary,
        new RecordingVectorStore('fallback'),
        fallback,
      ),
      readPage: async () => {
        page += 1;
        return page === 1
          ? [{ marketId: '1', question: 'Market one?', phase: 'Opened' as const }]
          : [];
      },
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(summary).toMatchObject({
      processed: 1,
      indexed: 1,
      complete: 0,
      degraded: 0,
      partial: 1,
      unindexed: 0,
      indexedByProvider: { openai: 1, fallback: 0 },
      providerFailures: { openai: 0, fallback: 1 },
    });
    expect(dedupBackfillHasFailures(summary)).toBe(true);
  });
});
