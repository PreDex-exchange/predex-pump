import type { MarketPhase } from '@predex-pump/shared';

import type {
  IndexableMarket,
  MarketIndexResult,
  MarketDedupIndexer,
  MarketIntelligenceProvider,
  MarketVectorStore,
} from './types.js';
import { groundMarketQuestion } from './normalization.js';
import {
  callMarketIntelligenceProvider,
  deterministicFallbackFor,
  MarketIntelligenceProviderFailure,
} from './provider.js';

function indexResult(
  configuredProvider: MarketIntelligenceProvider['mode'],
  indexedProviders: readonly MarketIntelligenceProvider['mode'][],
  failedProviders: readonly MarketIntelligenceProvider['mode'][],
): MarketIndexResult {
  return {
    configuredProvider,
    indexedProviders,
    failedProviders,
    degradedToFallback:
      configuredProvider !== 'fallback' &&
      !indexedProviders.includes(configuredProvider) &&
      indexedProviders.includes('fallback'),
  };
}

export class MarketIndexingFailure extends Error {
  constructor(
    readonly result: MarketIndexResult,
    cause: unknown,
  ) {
    super(
      `Market indexing failed for provider(s) ${result.failedProviders.join(', ')}`,
      { cause },
    );
    this.name = 'MarketIndexingFailure';
  }
}

export function parseMarketPhase(phase: string): MarketPhase {
  switch (phase) {
    case 'Opened':
    case 'Graduated':
    case 'ResolvedObserved':
    case 'ClosedOut':
      return phase;
    default:
      throw new Error(`Cannot index unknown market phase ${phase}`);
  }
}

export class MarketVectorIndexer implements MarketDedupIndexer {
  private readonly fallbackProvider: MarketIntelligenceProvider | undefined;

  constructor(
    private readonly provider: MarketIntelligenceProvider,
    private readonly vectorStore: MarketVectorStore,
    fallbackProvider = deterministicFallbackFor(provider),
  ) {
    if (fallbackProvider?.mode === provider.mode) {
      throw new Error('Market vector fallback provider must use a different mode');
    }
    this.fallbackProvider = fallbackProvider;
  }

  private async indexWithProvider(
    market: IndexableMarket,
    provider: MarketIntelligenceProvider,
  ): Promise<void> {
    const vector = await callMarketIntelligenceProvider(provider, 'embed', () =>
      provider.embed(market.question),
    );
    // Every embedding for a market stores the same text-grounded fields. The
    // semantic judge reads the question itself; model inference is not canonical.
    const fields = groundMarketQuestion(market.question).fields;
    await this.vectorStore.upsertMarket({
      vector,
      payload: {
        marketId: market.marketId,
        question: market.question,
        phase: market.phase,
        embeddingProvider: provider.mode,
        ...fields,
      },
    });
  }

  async indexMarket(market: IndexableMarket): Promise<MarketIndexResult> {
    const indexedProviders: MarketIntelligenceProvider['mode'][] = [];
    const failedProviders: MarketIntelligenceProvider['mode'][] = [];
    try {
      await this.indexWithProvider(market, this.provider);
      indexedProviders.push(this.provider.mode);
    } catch (error) {
      failedProviders.push(this.provider.mode);
      if (
        !(error instanceof MarketIntelligenceProviderFailure) ||
        this.fallbackProvider === undefined
      ) {
        throw new MarketIndexingFailure(
          indexResult(this.provider.mode, indexedProviders, failedProviders),
          error,
        );
      }
      try {
        await this.indexWithProvider(market, this.fallbackProvider);
        indexedProviders.push(this.fallbackProvider.mode);
      } catch (fallbackError) {
        failedProviders.push(this.fallbackProvider.mode);
        throw new MarketIndexingFailure(
          indexResult(this.provider.mode, indexedProviders, failedProviders),
          fallbackError,
        );
      }
      return indexResult(this.provider.mode, indexedProviders, failedProviders);
    }

    // Keep a deterministic embedding alongside a successful configured-provider
    // embedding so a later quota/auth/transport outage has a compatible index.
    if (this.fallbackProvider !== undefined) {
      try {
        await this.indexWithProvider(market, this.fallbackProvider);
        indexedProviders.push(this.fallbackProvider.mode);
      } catch (error) {
        failedProviders.push(this.fallbackProvider.mode);
        throw new MarketIndexingFailure(
          indexResult(this.provider.mode, indexedProviders, failedProviders),
          error,
        );
      }
    }
    return indexResult(this.provider.mode, indexedProviders, failedProviders);
  }
}
