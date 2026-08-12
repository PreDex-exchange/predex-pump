import type {
  DedupIndexHealth,
  DedupProviderIndexHealth,
} from '@predex-pump/shared';

import type {
  DedupIndexHealthReader,
  EmbeddingProviderMode,
  MarketCatalog,
  MarketVectorStore,
} from './types.js';

function providerCoverage(
  canonicalIds: ReadonlySet<string>,
  indexedIds: readonly string[],
): DedupProviderIndexHealth {
  const indexed = new Set(indexedIds);
  let missingMarketCount = 0;
  let unexpectedMarketCount = 0;

  for (const marketId of canonicalIds) {
    if (!indexed.has(marketId)) missingMarketCount += 1;
  }
  for (const marketId of indexed) {
    if (!canonicalIds.has(marketId)) unexpectedMarketCount += 1;
  }

  return {
    indexedMarketCount: indexed.size,
    missingMarketCount,
    unexpectedMarketCount,
    complete: missingMarketCount === 0,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function unavailableDedupIndexHealth(
  configuredProvider: EmbeddingProviderMode,
  error: unknown,
): DedupIndexHealth {
  const unavailableProvider = {
    indexedMarketCount: null,
    missingMarketCount: null,
    unexpectedMarketCount: null,
    complete: false,
  } as const;
  return {
    status: 'unavailable',
    configuredProvider,
    queryProvider: null,
    canonicalMarketCount: null,
    providers: {
      openai: unavailableProvider,
      fallback: unavailableProvider,
    },
    error: errorMessage(error),
  };
}

/**
 * Compares each incompatible embedding partition with the canonical market set.
 * A partition is queryable only when it covers every canonical market.
 */
export class DedupIndexInspector implements DedupIndexHealthReader {
  constructor(
    private readonly configuredProvider: EmbeddingProviderMode,
    private readonly vectorStore: MarketVectorStore,
    private readonly marketCatalog: MarketCatalog,
  ) {}

  async inspect(): Promise<DedupIndexHealth> {
    const [canonicalMarketIds, openAiMarketIds, fallbackMarketIds] =
      await Promise.all([
        this.marketCatalog.listMarketIds(),
        this.vectorStore.listMarketIds('openai'),
        this.vectorStore.listMarketIds('fallback'),
      ]);
    const canonicalIds = new Set(canonicalMarketIds);
    const providers = {
      openai: providerCoverage(canonicalIds, openAiMarketIds),
      fallback: providerCoverage(canonicalIds, fallbackMarketIds),
    } satisfies DedupIndexHealth['providers'];
    const configuredCoverage = providers[this.configuredProvider];
    const fallbackAvailable =
      this.configuredProvider === 'openai' && providers.fallback.complete;
    const queryProvider = configuredCoverage.complete
      ? this.configuredProvider
      : fallbackAvailable
        ? 'fallback'
        : null;
    const configuredPartitionClean =
      configuredCoverage.complete &&
      configuredCoverage.unexpectedMarketCount === 0;
    const fallbackPartitionClean =
      providers.fallback.complete &&
      providers.fallback.unexpectedMarketCount === 0;
    const allRequiredPartitionsClean =
      configuredPartitionClean &&
      (this.configuredProvider === 'fallback' || fallbackPartitionClean);

    return {
      status:
        queryProvider === null
          ? 'unavailable'
          : allRequiredPartitionsClean
            ? 'ready'
            : 'degraded',
      configuredProvider: this.configuredProvider,
      queryProvider,
      canonicalMarketCount: canonicalIds.size,
      providers,
      error: null,
    };
  }

  async getHealth(): Promise<DedupIndexHealth> {
    try {
      return await this.inspect();
    } catch (error) {
      return unavailableDedupIndexHealth(this.configuredProvider, error);
    }
  }
}
