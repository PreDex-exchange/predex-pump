import type { MarketPhase } from '@predex-pump/shared';

import type {
  IndexableMarket,
  MarketDedupIndexer,
  MarketIntelligenceProvider,
  MarketVectorStore,
} from './types.js';

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
  constructor(
    private readonly provider: MarketIntelligenceProvider,
    private readonly vectorStore: MarketVectorStore,
  ) {}

  async indexMarket(market: IndexableMarket): Promise<void> {
    const [vector, fields] = await Promise.all([
      this.provider.embed(market.question),
      this.provider.extractFields(market.question),
    ]);
    await this.vectorStore.upsertMarket({
      vector,
      payload: {
        marketId: market.marketId,
        question: market.question,
        phase: market.phase,
        embeddingProvider: this.provider.mode,
        ...fields,
      },
    });
  }
}
