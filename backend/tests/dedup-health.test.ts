import { describe, expect, it } from 'vitest';

import { DedupIndexInspector } from '../src/dedup/health.js';
import type {
  CanonicalMarket,
  EmbeddingProviderMode,
  MarketCatalog,
  MarketVectorStore,
} from '../src/dedup/types.js';

function catalog(marketIds: readonly string[]): MarketCatalog {
  return {
    listMarketIds: async () => marketIds,
    findMarketsByIds: async (ids): Promise<CanonicalMarket[]> =>
      ids.map((marketId) => ({ marketId, question: `Market ${marketId}?` })),
  };
}

function store(
  indexed: Record<EmbeddingProviderMode, readonly string[]>,
): MarketVectorStore {
  return {
    upsertMarket: async () => undefined,
    listMarketIds: async (mode) => indexed[mode],
    searchMarkets: async () => [],
  };
}

describe('dedup provider-partition health', () => {
  it('surfaces a mixed configured partition and selects a complete fallback partition', async () => {
    const health = await new DedupIndexInspector(
      'openai',
      store({ openai: ['1'], fallback: ['1', '2', '3'] }),
      catalog(['1', '2', '3']),
    ).inspect();

    expect(health).toEqual({
      status: 'degraded',
      configuredProvider: 'openai',
      queryProvider: 'fallback',
      canonicalMarketCount: 3,
      providers: {
        openai: {
          indexedMarketCount: 1,
          missingMarketCount: 2,
          unexpectedMarketCount: 0,
          complete: false,
        },
        fallback: {
          indexedMarketCount: 3,
          missingMarketCount: 0,
          unexpectedMarketCount: 0,
          complete: true,
        },
      },
      error: null,
    });
  });

  it('reports unavailable when no provider partition covers canonical markets', async () => {
    await expect(
      new DedupIndexInspector(
        'openai',
        store({ openai: [], fallback: ['1'] }),
        catalog(['1', '2']),
      ).inspect(),
    ).resolves.toMatchObject({
      status: 'unavailable',
      configuredProvider: 'openai',
      queryProvider: null,
      providers: {
        openai: { complete: false, missingMarketCount: 2 },
        fallback: { complete: false, missingMarketCount: 1 },
      },
    });
  });

  it('reports degraded when the configured partition is complete but its outage fallback is not', async () => {
    await expect(
      new DedupIndexInspector(
        'openai',
        store({ openai: ['1', '2'], fallback: ['1'] }),
        catalog(['1', '2']),
      ).inspect(),
    ).resolves.toMatchObject({
      status: 'degraded',
      configuredProvider: 'openai',
      queryProvider: 'openai',
      providers: {
        openai: { complete: true, missingMarketCount: 0 },
        fallback: { complete: false, missingMarketCount: 1 },
      },
    });
  });

  it('reports health dependency failures instead of throwing from the health endpoint', async () => {
    const brokenStore = store({ openai: [], fallback: [] });
    brokenStore.listMarketIds = async () => {
      throw new Error('Qdrant unavailable');
    };

    await expect(
      new DedupIndexInspector('fallback', brokenStore, catalog(['1'])).getHealth(),
    ).resolves.toMatchObject({
      status: 'unavailable',
      configuredProvider: 'fallback',
      queryProvider: null,
      canonicalMarketCount: null,
      error: 'Qdrant unavailable',
    });
  });
});
