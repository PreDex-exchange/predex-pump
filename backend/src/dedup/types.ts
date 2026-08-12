import type {
  DedupCheckResponse,
  MarketFactFields,
  MarketPhase,
} from '@predex-pump/shared';

export const MARKET_EMBEDDING_DIMENSIONS = 1_536;
export const MARKET_COLLECTION = 'markets';
export type EmbeddingProviderMode = 'openai' | 'fallback';

export interface MarketQuestionFact {
  question: string;
  fields: MarketFactFields;
  /** How each extracted value is grounded in the question text. */
  fieldSources?: MarketFactFieldSources;
}

export type MarketFactFieldName = keyof MarketFactFields;
export type MarketFactFieldSource = 'stated' | 'inferred' | 'absent';
export type MarketFactFieldSources = Record<
  MarketFactFieldName,
  MarketFactFieldSource
>;

export interface SameFactJudgment {
  sameFact: boolean;
  reason: string;
}

/**
 * All model-backed work goes through this boundary. Runtime construction selects
 * OpenAI only when a non-empty API key is present; otherwise it selects the
 * deterministic local implementation.
 */
export interface MarketIntelligenceProvider {
  readonly mode: EmbeddingProviderMode;
  embed(question: string): Promise<number[]>;
  extractFields(question: string): Promise<MarketFactFields>;
  judgeSameFact(
    draft: MarketQuestionFact,
    candidate: MarketQuestionFact,
  ): Promise<SameFactJudgment>;
}

export interface MarketVectorPayload extends MarketFactFields {
  marketId: string;
  question: string;
  phase: MarketPhase;
  /** Prevents ANN comparisons across incompatible embedding spaces. */
  embeddingProvider: EmbeddingProviderMode;
}

export interface MarketVectorPoint {
  vector: number[];
  payload: MarketVectorPayload;
}

export interface MarketVectorMatch {
  score: number;
  payload: MarketVectorPayload;
}

export interface MarketVectorStore {
  upsertMarket(point: MarketVectorPoint): Promise<void>;
  searchMarkets(
    vector: readonly number[],
    limit: number,
    embeddingProvider: EmbeddingProviderMode,
  ): Promise<MarketVectorMatch[]>;
}

export interface IndexableMarket {
  marketId: string;
  question: string;
  phase: MarketPhase;
}

export interface CanonicalMarket {
  marketId: string;
  question: string;
}

/** Authoritative market records used to reject stale vector-store points. */
export interface MarketCatalog {
  findMarketsByIds(marketIds: readonly string[]): Promise<CanonicalMarket[]>;
}

export interface MarketDedupIndexer {
  indexMarket(market: IndexableMarket): Promise<void>;
}

export interface DedupChecker {
  check(question: string): Promise<DedupCheckResponse>;
}
