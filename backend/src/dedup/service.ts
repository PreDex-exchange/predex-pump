import type {
  DedupCandidate,
  DedupCheckResponse,
  MarketFactFields,
} from '@predex-pump/shared';

import { compareAuthoritativeFields } from './normalization.js';
import {
  callMarketIntelligenceProvider,
  deterministicFallbackFor,
  MarketIntelligenceProviderFailure,
} from './provider.js';
import type {
  DedupChecker,
  MarketIntelligenceProvider,
  MarketVectorMatch,
  MarketVectorStore,
  SameFactJudgment,
} from './types.js';

interface JudgedMatch {
  match: MarketVectorMatch;
  judgment: SameFactJudgment;
}

class MarketVectorStoreFailure extends Error {
  constructor(cause: unknown) {
    super('Market vector search failed', { cause });
    this.name = 'MarketVectorStoreFailure';
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

function fieldsFromMatch(match: MarketVectorMatch): MarketFactFields {
  return {
    subject: match.payload.subject,
    comparator: match.payload.comparator,
    strike: match.payload.strike,
    deadline: match.payload.deadline,
    basis: match.payload.basis,
  };
}

function uniqueMarketMatches(
  matches: readonly MarketVectorMatch[],
): MarketVectorMatch[] {
  const byMarket = new Map<string, MarketVectorMatch>();
  for (const match of matches) {
    const existing = byMarket.get(match.payload.marketId);
    if (existing === undefined || match.score > existing.score) {
      byMarket.set(match.payload.marketId, match);
    }
  }
  return [...byMarket.values()];
}

export class DedupService implements DedupChecker {
  private readonly provider: MarketIntelligenceProvider;
  private readonly fallbackProvider: MarketIntelligenceProvider | undefined;
  private readonly vectorStore: MarketVectorStore;
  private readonly topK: number;

  constructor(
    provider: MarketIntelligenceProvider,
    vectorStore: MarketVectorStore,
    topK: number,
    fallbackProvider = deterministicFallbackFor(provider),
  ) {
    if (!Number.isSafeInteger(topK) || topK <= 0) {
      throw new Error(`Dedup topK must be a positive integer, received ${topK}`);
    }
    this.provider = provider;
    this.fallbackProvider = fallbackProvider;
    this.vectorStore = vectorStore;
    this.topK = topK;
  }

  private async judgeMatches(
    provider: MarketIntelligenceProvider,
    question: string,
    draftFields: MarketFactFields,
    matches: readonly MarketVectorMatch[],
  ): Promise<JudgedMatch[]> {
    return Promise.all(
      matches.map(async (match): Promise<JudgedMatch> => {
        const candidateFields = fieldsFromMatch(match);
        const authoritative = compareAuthoritativeFields(
          draftFields,
          candidateFields,
        );
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
                { question, fields: draftFields },
                {
                  question: match.payload.question,
                  fields: candidateFields,
                },
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
    const [vector, draftFields] = await Promise.all([
      callMarketIntelligenceProvider(provider, 'embed', () =>
        provider.embed(question),
      ),
      callMarketIntelligenceProvider(provider, 'extract-fields', () =>
        provider.extractFields(question),
      ),
    ]);
    let matches: readonly MarketVectorMatch[];
    try {
      matches = uniqueMarketMatches(
        await this.vectorStore.searchMarkets(
          vector,
          this.topK,
          provider.mode,
        ),
      );
    } catch (error) {
      throw new MarketVectorStoreFailure(error);
    }
    const judged = await this.judgeMatches(
      provider,
      question,
      draftFields,
      matches,
    );
    const duplicate = judged
      .filter(({ judgment }) => judgment.sameFact)
      .sort((left, right) => right.match.score - left.match.score)[0];
    const candidates: DedupCandidate[] = judged.map(({ match, judgment }) => ({
      marketId: match.payload.marketId,
      question: match.payload.question,
      score: match.score,
      reason: judgment.reason,
    }));
    return {
      available: true,
      isDuplicate: duplicate !== undefined,
      canonicalMarketId: duplicate?.match.payload.marketId ?? null,
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
            fallbackError instanceof MarketVectorStoreFailure
          ) {
            return unavailableDedupResponse();
          }
          throw fallbackError;
        }
      }
      if (
        error instanceof MarketIntelligenceProviderFailure ||
        error instanceof MarketVectorStoreFailure
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
