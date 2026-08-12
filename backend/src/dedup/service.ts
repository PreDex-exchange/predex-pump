import type {
  DedupCandidate,
  DedupCheckResponse,
} from '@predex-pump/shared';

import {
  compareMarketQuestionFacts,
  groundMarketQuestion,
} from './normalization.js';
import {
  callMarketIntelligenceProvider,
  deterministicFallbackFor,
  MarketIntelligenceProviderFailure,
} from './provider.js';
import type {
  CanonicalMarket,
  DedupChecker,
  MarketCatalog,
  MarketIntelligenceProvider,
  MarketQuestionFact,
  MarketVectorMatch,
  MarketVectorStore,
  SameFactJudgment,
} from './types.js';

interface CanonicalMatch {
  market: CanonicalMarket;
  score: number;
}

interface JudgedMatch {
  match: CanonicalMatch;
  judgment: SameFactJudgment;
}

class MarketVectorStoreFailure extends Error {
  constructor(cause: unknown) {
    super('Market vector search failed', { cause });
    this.name = 'MarketVectorStoreFailure';
  }
}

class MarketCatalogFailure extends Error {
  constructor(cause: unknown) {
    super('Canonical market lookup failed', { cause });
    this.name = 'MarketCatalogFailure';
  }
}

export function unavailableDedupResponse(): DedupCheckResponse {
  return {
    available: false,
    isDuplicate: false,
    canonicalMarketId: null,
    candidates: [],
  };
}

function compareMarketIds(left: string, right: string): number {
  if (/^\d+$/u.test(left) && /^\d+$/u.test(right)) {
    const leftId = BigInt(left);
    const rightId = BigInt(right);
    if (leftId < rightId) return -1;
    if (leftId > rightId) return 1;
    // Canonical IDs have no leading zeroes, but keep the fallback deterministic
    // even if a malformed projection contains numerically equivalent strings.
    if (left === right) return 0;
  }
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function bestScoreByMarket(
  matches: readonly MarketVectorMatch[],
): Map<string, number> {
  const byMarket = new Map<string, number>();
  for (const match of matches) {
    const existing = byMarket.get(match.payload.marketId);
    if (existing === undefined || match.score > existing) {
      byMarket.set(match.payload.marketId, match.score);
    }
  }
  return byMarket;
}

function compareCanonicalMatches(
  left: CanonicalMatch,
  right: CanonicalMatch,
): number {
  if (left.score !== right.score) return right.score - left.score;
  return compareMarketIds(left.market.marketId, right.market.marketId);
}

export class DedupService implements DedupChecker {
  private readonly provider: MarketIntelligenceProvider;
  private readonly fallbackProvider: MarketIntelligenceProvider | undefined;
  private readonly vectorStore: MarketVectorStore;
  private readonly marketCatalog: MarketCatalog;
  private readonly topK: number;

  constructor(
    provider: MarketIntelligenceProvider,
    vectorStore: MarketVectorStore,
    marketCatalog: MarketCatalog,
    topK: number,
    fallbackProvider = deterministicFallbackFor(provider),
  ) {
    if (!Number.isSafeInteger(topK) || topK <= 0) {
      throw new Error(`Dedup topK must be a positive integer, received ${topK}`);
    }
    this.provider = provider;
    this.fallbackProvider = fallbackProvider;
    this.vectorStore = vectorStore;
    this.marketCatalog = marketCatalog;
    this.topK = topK;
  }

  private async resolveLiveMatches(
    retrieved: readonly MarketVectorMatch[],
  ): Promise<CanonicalMatch[]> {
    const scores = bestScoreByMarket(retrieved);
    if (scores.size === 0) return [];

    let markets: readonly CanonicalMarket[];
    try {
      markets = await this.marketCatalog.findMarketsByIds(
        [...scores.keys()].sort(compareMarketIds),
      );
    } catch (error) {
      throw new MarketCatalogFailure(error);
    }

    return markets
      .flatMap((market): CanonicalMatch[] => {
        const score = scores.get(market.marketId);
        return score === undefined ? [] : [{ market, score }];
      })
      .sort(compareCanonicalMatches);
  }

  private async judgeMatches(
    provider: MarketIntelligenceProvider,
    draft: MarketQuestionFact,
    matches: readonly CanonicalMatch[],
  ): Promise<JudgedMatch[]> {
    return Promise.all(
      matches.map(async (match): Promise<JudgedMatch> => {
        // The database question is canonical. Vector payload fields are a
        // retrieval projection and may be stale, inferred, or contradictory.
        const candidate = groundMarketQuestion(match.market.question);
        const authoritative = compareMarketQuestionFacts(draft, candidate);
        if (!authoritative.compatible) {
          return {
            match,
            judgment: {
              sameFact: false,
              reason: authoritative.reason,
            },
          };
        }
        return {
          match,
          judgment: await callMarketIntelligenceProvider(
            provider,
            'judge-same-fact',
            () =>
              provider.judgeSameFact(
                draft,
                candidate,
              ),
          ),
        };
      }),
    );
  }

  private async checkWithProvider(
    question: string,
    provider: MarketIntelligenceProvider,
  ): Promise<DedupCheckResponse> {
    const vector = await callMarketIntelligenceProvider(provider, 'embed', () =>
      provider.embed(question),
    );
    const draft = groundMarketQuestion(question);
    let retrieved: readonly MarketVectorMatch[];
    try {
      retrieved = await this.vectorStore.searchMarkets(
        vector,
        this.topK,
        provider.mode,
      );
    } catch (error) {
      throw new MarketVectorStoreFailure(error);
    }
    const matches = await this.resolveLiveMatches(retrieved);
    const judged = await this.judgeMatches(provider, draft, matches);
    const duplicate = judged.find(({ judgment }) => judgment.sameFact);
    const candidates: DedupCandidate[] = judged.map(({ match, judgment }) => ({
      marketId: match.market.marketId,
      question: match.market.question,
      score: match.score,
      reason: judgment.reason,
    }));
    return {
      available: true,
      isDuplicate: duplicate !== undefined,
      canonicalMarketId: duplicate?.match.market.marketId ?? null,
      candidates,
    };
  }

  async check(question: string): Promise<DedupCheckResponse> {
    try {
      return await this.checkWithProvider(question, this.provider);
    } catch (error) {
      if (
        error instanceof MarketIntelligenceProviderFailure &&
        this.fallbackProvider !== undefined
      ) {
        try {
          return await this.checkWithProvider(question, this.fallbackProvider);
        } catch (fallbackError) {
          if (
            fallbackError instanceof MarketIntelligenceProviderFailure ||
            fallbackError instanceof MarketVectorStoreFailure ||
            fallbackError instanceof MarketCatalogFailure
          ) {
            return unavailableDedupResponse();
          }
          throw fallbackError;
        }
      }
      if (
        error instanceof MarketIntelligenceProviderFailure ||
        error instanceof MarketVectorStoreFailure ||
        error instanceof MarketCatalogFailure
      ) {
        // Dependency failures are explicit in the response. A successful empty
        // retrieval never reaches this path and remains available=true.
        return unavailableDedupResponse();
      }
      // Do not turn unexpected matching/orchestration bugs into a plausible
      // "no duplicates" result. The route logs these before returning unavailable.
      throw error;
    }
  }
}
