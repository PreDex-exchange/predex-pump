import type {
  DedupCandidate,
  DedupCheckResponse,
  MarketFactFields,
} from '@predex-pump/shared';

import { compareAuthoritativeFields } from './normalization.js';
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

export class DedupService implements DedupChecker {
  private readonly provider: MarketIntelligenceProvider;
  private readonly vectorStore: MarketVectorStore;
  private readonly topK: number;

  constructor(
    provider: MarketIntelligenceProvider,
    vectorStore: MarketVectorStore,
    topK: number,
  ) {
    if (!Number.isSafeInteger(topK) || topK <= 0) {
      throw new Error(`Dedup topK must be a positive integer, received ${topK}`);
    }
    this.provider = provider;
    this.vectorStore = vectorStore;
    this.topK = topK;
  }

  private async judgeMatches(
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
          judgment: await this.provider.judgeSameFact(
            { question, fields: draftFields },
            {
              question: match.payload.question,
              fields: candidateFields,
            },
          ),
        };
      }),
    );
  }

  async check(question: string): Promise<DedupCheckResponse> {
    try {
      const [vector, draftFields] = await Promise.all([
        this.provider.embed(question),
        this.provider.extractFields(question),
      ]);
      const matches = await this.vectorStore.searchMarkets(
        vector,
        this.topK,
        this.provider.mode,
      );
      const judged = await this.judgeMatches(question, draftFields, matches);
      const duplicate = judged
        .filter(({ judgment }) => judgment.sameFact)
        .sort((left, right) => right.match.score - left.match.score)[0];
      const candidates: DedupCandidate[] = judged.map(({ match, judgment }) => ({
        marketId: match.payload.marketId,
        score: match.score,
        reason: judgment.reason,
      }));
      return {
        available: true,
        isDuplicate: duplicate !== undefined,
        canonicalMarketId: duplicate?.match.payload.marketId ?? null,
        candidates,
      };
    } catch {
      // Creation-time dedup is advisory. Every dependency failure is fail-open.
      return unavailableDedupResponse();
    }
  }
}
