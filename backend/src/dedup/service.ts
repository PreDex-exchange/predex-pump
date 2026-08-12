import type {
  DedupCandidate,
  DedupCheckResponse,
  DedupIndexHealth,
} from '@predex-pump/shared';

import { DedupIndexInspector } from './health.js';
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

class MarketVectorIndexUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketVectorIndexUnavailable';
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
  private readonly indexInspector: DedupIndexInspector;

  constructor(
    provider: MarketIntelligenceProvider,
    vectorStore: MarketVectorStore,
    marketCatalog: MarketCatalog,
    topK: number,
    fallbackProvider = deterministicFallbackFor(provider),
    indexInspector = new DedupIndexInspector(
      provider.mode,
      vectorStore,
      marketCatalog,
    ),
  ) {
    if (!Number.isSafeInteger(topK) || topK <= 0) {
      throw new Error(`Dedup topK must be a positive integer, received ${topK}`);
    }
    this.provider = provider;
    this.fallbackProvider = fallbackProvider;
    this.vectorStore = vectorStore;
    this.marketCatalog = marketCatalog;
    this.topK = topK;
    this.indexInspector = indexInspector;
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
    indexHealth: DedupIndexHealth,
  ): Promise<DedupCheckResponse> {
    const providerHealth = indexHealth.providers[provider.mode];
    if (!providerHealth.complete) {
      throw new MarketVectorIndexUnavailable(
        `Dedup index provider ${provider.mode} is missing ${String(providerHealth.missingMarketCount)} canonical markets`,
      );
    }
    const vector = await callMarketIntelligenceProvider(provider, 'embed', () =>
      provider.embed(question),
    );
    const draft = groundMarketQuestion(question);
    let retrieved: readonly MarketVectorMatch[];
    try {
      const unexpectedMarketCount = providerHealth.unexpectedMarketCount ?? 0;
      retrieved = await this.vectorStore.searchMarkets(
        vector,
        this.topK + unexpectedMarketCount,
        provider.mode,
      );
    } catch (error) {
      throw new MarketVectorStoreFailure(error);
    }
    const matches = (await this.resolveLiveMatches(retrieved)).slice(0, this.topK);
    if ((indexHealth.canonicalMarketCount ?? 0) > 0 && matches.length === 0) {
      throw new MarketVectorIndexUnavailable(
        `Dedup index provider ${provider.mode} returned no usable canonical markets`,
      );
    }
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
    let indexHealth: DedupIndexHealth;
    try {
      indexHealth = await this.indexInspector.inspect();
    } catch {
      return unavailableDedupResponse();
    }
    const queryProvider =
      indexHealth.queryProvider === this.provider.mode
        ? this.provider
        : indexHealth.queryProvider === this.fallbackProvider?.mode
          ? this.fallbackProvider
          : undefined;
    if (queryProvider === undefined) return unavailableDedupResponse();

    try {
      return await this.checkWithProvider(question, queryProvider, indexHealth);
    } catch (error) {
      if (
        error instanceof MarketIntelligenceProviderFailure &&
        queryProvider.mode !== 'fallback' &&
        this.fallbackProvider !== undefined &&
        indexHealth.providers.fallback.complete
      ) {
        try {
          return await this.checkWithProvider(
            question,
            this.fallbackProvider,
            indexHealth,
          );
        } catch (fallbackError) {
          if (
            fallbackError instanceof MarketIntelligenceProviderFailure ||
            fallbackError instanceof MarketVectorStoreFailure ||
            fallbackError instanceof MarketCatalogFailure ||
            fallbackError instanceof MarketVectorIndexUnavailable
          ) {
            return unavailableDedupResponse();
          }
          throw fallbackError;
        }
      }
      if (
        error instanceof MarketIntelligenceProviderFailure ||
        error instanceof MarketVectorStoreFailure ||
        error instanceof MarketCatalogFailure ||
        error instanceof MarketVectorIndexUnavailable
      ) {
        // Dependency and index-coverage failures are explicit. A negative
        // verdict is returned only after a complete provider partition yields
        // usable canonical candidates (or the canonical catalog is empty).
        return unavailableDedupResponse();
      }
      // Do not turn unexpected matching/orchestration bugs into a plausible
      // "no duplicates" result. The route logs these before returning unavailable.
      throw error;
    }
  }
}
