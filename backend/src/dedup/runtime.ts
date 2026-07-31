import type { RuntimeConfig } from '../config.js';
import { MarketVectorIndexer } from './indexer.js';
import { createMarketIntelligenceProvider } from './provider.js';
import { QdrantMarketClient } from './qdrant-client.js';
import { DedupService } from './service.js';
import type {
  DedupChecker,
  MarketDedupIndexer,
  MarketIntelligenceProvider,
  MarketVectorStore,
} from './types.js';

export interface DedupRuntime {
  provider: MarketIntelligenceProvider;
  vectorStore: MarketVectorStore;
  checker: DedupChecker;
  indexer: MarketDedupIndexer;
}

export function createDedupRuntime(config: RuntimeConfig): DedupRuntime {
  const provider = createMarketIntelligenceProvider({
    apiKey: config.openAiApiKey,
    timeoutMs: config.dedupTimeoutMs,
  });
  const vectorStore = new QdrantMarketClient({
    url: config.qdrantUrl,
    timeoutMs: config.dedupTimeoutMs,
  });
  return {
    provider,
    vectorStore,
    checker: new DedupService(provider, vectorStore, config.dedupTopK),
    indexer: new MarketVectorIndexer(provider, vectorStore),
  };
}
