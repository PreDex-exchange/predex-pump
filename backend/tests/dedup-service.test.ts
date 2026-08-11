import type { MarketPhase } from '@predex-pump/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadRuntimeConfig } from '../src/config.js';
import { FallbackMarketIntelligenceProvider } from '../src/dedup/fallback-provider.js';
import { MarketVectorIndexer } from '../src/dedup/indexer.js';
import { createMarketIntelligenceProvider } from '../src/dedup/provider.js';
import { DedupService, unavailableDedupResponse } from '../src/dedup/service.js';
import type {
  MarketIntelligenceProvider,
  EmbeddingProviderMode,
  MarketQuestionFact,
  MarketVectorMatch,
  MarketVectorPoint,
  MarketVectorStore,
  SameFactJudgment,
} from '../src/dedup/types.js';

function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

class InMemoryMarketVectorStore implements MarketVectorStore {
  private readonly points = new Map<string, MarketVectorPoint>();

  async upsertMarket(point: MarketVectorPoint): Promise<void> {
    this.points.set(point.payload.marketId, point);
  }

  async searchMarkets(
    vector: readonly number[],
    limit: number,
    embeddingProvider: EmbeddingProviderMode,
  ): Promise<MarketVectorMatch[]> {
    return [...this.points.values()]
      .filter((point) => point.payload.embeddingProvider === embeddingProvider)
      .map((point) => ({
        score: cosine(vector, point.vector),
        payload: point.payload,
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }
}

async function serviceWithMarket(
  question: string,
  marketId = '1',
  phase: MarketPhase = 'Opened',
): Promise<DedupService> {
  const provider = new FallbackMarketIntelligenceProvider();
  const store = new InMemoryMarketVectorStore();
  await new MarketVectorIndexer(provider, store).indexMarket({
    marketId,
    question,
    phase,
  });
  return new DedupService(provider, store, 5);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('retrieve-then-judge dedup service', () => {
  it('automatically uses the deterministic provider when OPENAI_API_KEY is unset', () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const config = loadRuntimeConfig();
    const provider = createMarketIntelligenceProvider({
      apiKey: config.openAiApiKey,
      timeoutMs: config.dedupTimeoutMs,
    });
    expect(config.openAiApiKey).toBeUndefined();
    expect(provider.mode).toBe('fallback');
  });

  it.each([
    {
      failure: 'HTTP 429 quota exhaustion',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'insufficient_quota',
              type: 'insufficient_quota',
            },
          }),
          { status: 429 },
        ),
    },
    {
      failure: 'a transport exception',
      fetchImpl: async () => {
        throw new TypeError('network unavailable');
      },
    },
  ])(
    'falls back to deterministic dedup after $failure from a configured provider',
    async ({ fetchImpl }) => {
      const question = 'Will BTC close above $70k Friday?';
      const fallback = new FallbackMarketIntelligenceProvider();
      const store = new InMemoryMarketVectorStore();
      await new MarketVectorIndexer(fallback, store).indexMarket({
        marketId: '42',
        question,
        phase: 'Opened',
      });
      const configuredProvider = createMarketIntelligenceProvider({
        apiKey: 'configured-but-unusable',
        timeoutMs: 100,
        fetchImpl: fetchImpl as typeof fetch,
      });

      await expect(
        new DedupService(configuredProvider, store, 5).check(question),
      ).resolves.toMatchObject({
        available: true,
        isDuplicate: true,
        canonicalMarketId: '42',
        candidates: [
          {
            marketId: '42',
            question,
          },
        ],
      });
    },
  );

  it('does not treat a successful empty provider search as a failure', async () => {
    const provider: MarketIntelligenceProvider = {
      mode: 'openai',
      embed: async () => Array(1_536).fill(0),
      extractFields: async () => ({
        subject: 'new fact',
        comparator: null,
        strike: null,
        deadline: null,
        basis: null,
      }),
      judgeSameFact: async () => {
        throw new Error('No candidates should be judged');
      },
    };
    const searchedModes: EmbeddingProviderMode[] = [];
    const emptyStore: MarketVectorStore = {
      upsertMarket: async () => undefined,
      searchMarkets: async (_vector, _limit, mode) => {
        searchedModes.push(mode);
        return [];
      },
    };

    await expect(
      new DedupService(provider, emptyStore, 5).check('Will a new fact happen?'),
    ).resolves.toEqual({
      available: true,
      isDuplicate: false,
      canonicalMarketId: null,
      candidates: [],
    });
    expect(searchedModes).toEqual(['openai']);
  });

  it.each([
    [
      'Will BTC close above $70k Friday?',
      'BTC > $70,000 by Friday close?',
    ],
    [
      'Will Ethereum close below $3,000 on 2026-08-31?',
      'ETH < $3k at close on 2026-08-31?',
    ],
  ])('suggests the canonical market for same-fact phrasing variants', async (
    canonicalQuestion,
    draftQuestion,
  ) => {
    const service = await serviceWithMarket(canonicalQuestion, '42');
    const response = await service.check(draftQuestion);
    expect(response).toMatchObject({
      available: true,
      isDuplicate: true,
      canonicalMarketId: '42',
    });
    expect(response.candidates[0]).toMatchObject({
      marketId: '42',
      reason: expect.stringContaining('Structured fields match'),
    });
  });

  it('recognizes the demo Manchester United alias without OpenAI', async () => {
    const service = await serviceWithMarket(
      'Will Manchester United score above 70 Premier League goals in the 2026-27 season?',
      '77',
    );

    await expect(
      service.check(
        'Will Man Utd score over 70 goals in the 2026/27 Premier League season?',
      ),
    ).resolves.toMatchObject({
      available: true,
      isDuplicate: true,
      canonicalMarketId: '77',
    });
  });

  it.each([
    // Objective fields stay a hard gate: a difference here is a different fact.
    ['strike', 'Will BTC close above $75k Friday?', 'Different strike'],
    ['deadline', 'Will BTC close above $70k Saturday?', 'Different deadline'],
    ['comparator', 'Will BTC close below $70k Friday?', 'Different comparator'],
    // A differing subject is NOT hard gated any more: extractors emit unstable
    // surface forms for one entity ("man_utd" vs "manchester_united"), so the
    // gate defers to the semantic judge. The deterministic judge used here
    // cannot resolve entities, so it still refuses to merge.
    ['subject', 'Will ETH close above $70k Friday?', 'needs semantic judgment'],
  ])('never merges a different %s even when wording is otherwise near-identical', async (
    _field,
    draftQuestion,
    expectedReason,
  ) => {
    const service = await serviceWithMarket('Will BTC close above $70k Friday?');
    const response = await service.check(draftQuestion);
    expect(response).toMatchObject({
      available: true,
      isDuplicate: false,
      canonicalMarketId: null,
    });
    expect(response.candidates[0]?.reason).toContain(expectedReason);
  });

  it('never lets a near-perfect ANN score override a structured strike conflict', async () => {
    const provider = new FallbackMarketIntelligenceProvider();
    const candidateQuestion = 'Will BTC close above $70k Friday?';
    const candidateFields = await provider.extractFields(candidateQuestion);
    const highScoreStore: MarketVectorStore = {
      upsertMarket: async () => undefined,
      searchMarkets: async () => [
        {
          score: 0.999,
          payload: {
            marketId: '1',
            question: candidateQuestion,
            phase: 'Opened',
            embeddingProvider: 'fallback',
            ...candidateFields,
          },
        },
      ],
    };
    const response = await new DedupService(provider, highScoreStore, 5).check(
      'Will BTC close above $75k Friday?',
    );
    expect(response).toMatchObject({
      available: true,
      isDuplicate: false,
      canonicalMarketId: null,
      candidates: [
        {
          marketId: '1',
          score: 0.999,
          reason: expect.stringContaining('Different strike'),
        },
      ],
    });
  });

  it('fails open when Qdrant search is unavailable', async () => {
    const provider = new FallbackMarketIntelligenceProvider();
    const downStore: MarketVectorStore = {
      upsertMarket: async () => undefined,
      searchMarkets: async () => {
        throw new Error('Qdrant is down');
      },
    };
    await expect(
      new DedupService(provider, downStore, 5).check(
        'Will BTC close above $70k Friday?',
      ),
    ).resolves.toEqual(unavailableDedupResponse());
  });

  it('fails open when the provider judge becomes unavailable', async () => {
    const fallback = new FallbackMarketIntelligenceProvider();
    const store = new InMemoryMarketVectorStore();
    await new MarketVectorIndexer(fallback, store).indexMarket({
      marketId: '1',
      question: 'Will BTC close above $70k Friday?',
      phase: 'Opened',
    });
    const downProvider: MarketIntelligenceProvider = {
      mode: 'fallback',
      embed: (question: string) => fallback.embed(question),
      extractFields: (question: string) => fallback.extractFields(question),
      judgeSameFact: async (
        _draft: MarketQuestionFact,
        _candidate: MarketQuestionFact,
      ): Promise<SameFactJudgment> => {
        throw new Error('provider unavailable');
      },
    };
    await expect(
      new DedupService(downProvider, store, 5).check(
        'BTC > $70,000 by Friday close?',
      ),
    ).resolves.toEqual(unavailableDedupResponse());
  });
});
