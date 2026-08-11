import type { MarketPhase } from '@predex-pump/shared';

import type {
  IndexableMarket,
  MarketDedupIndexer,
  MarketIntelligenceProvider,
  MarketVectorStore,
} from './types.js';
import {
  callMarketIntelligenceProvider,
  deterministicFallbackFor,
  MarketIntelligenceProviderFailure,
} from './provider.js';

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
    this.fallbackProvider = fallbackProvider;
  }

  private async indexWithProvider(
    market: IndexableMarket,
    provider: MarketIntelligenceProvider,
  ): Promise<void> {
    const [vector, fields] = await Promise.all([
      callMarketIntelligenceProvider(provider, 'embed', () =>
        provider.embed(market.question),
      ),
      callMarketIntelligenceProvider(provider, 'extract-fields', () =>
        provider.extractFields(market.question),
      ),
    ]);
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

  async indexMarket(market: IndexableMarket): Promise<void> {
    try {
      await this.indexWithProvider(market, this.provider);
    } catch (error) {
      if (
        !(error instanceof MarketIntelligenceProviderFailure) ||
        this.fallbackProvider === undefined
      ) {
        throw error;
      }
      await this.indexWithProvider(market, this.fallbackProvider);
      return;
    }

    // Keep a deterministic embedding alongside a successful configured-provider
    // embedding so a later quota/auth/transport outage has a compatible index.
    if (this.fallbackProvider !== undefined) {
      await this.indexWithProvider(market, this.fallbackProvider);
    }
  }
}
