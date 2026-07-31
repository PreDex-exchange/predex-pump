import { createHash } from 'node:crypto';

import type { MarketFactFields } from '@predex-pump/shared';

import {
  canonicalQuestionTokens,
  compareAuthoritativeFields,
  extractFieldsLocally,
  tokenSimilarity,
} from './normalization.js';
import {
  MARKET_EMBEDDING_DIMENSIONS,
  type MarketIntelligenceProvider,
  type MarketQuestionFact,
  type SameFactJudgment,
} from './types.js';

function hashFeature(vector: number[], feature: string, weight: number): void {
  const digest = createHash('sha256').update(feature).digest();
  const index = digest.readUInt32BE(0) % MARKET_EMBEDDING_DIMENSIONS;
  const sign = (digest[4] ?? 0) % 2 === 0 ? 1 : -1;
  vector[index] = (vector[index] ?? 0) + sign * weight;
}

/**
 * Deterministic signed feature hashing keeps the same 1536 dimensions as
 * text-embedding-3-small, so switching providers does not require a collection
 * migration. It is intentionally modest: retrieval may be broad, while the
 * structured-field gate protects correctness.
 */
export function localQuestionEmbedding(question: string): number[] {
  const tokens = canonicalQuestionTokens(question);
  const vector = Array<number>(MARKET_EMBEDDING_DIMENSIONS).fill(0);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    hashFeature(vector, `token:${token}`, 1);
    const next = tokens[index + 1];
    if (next !== undefined) hashFeature(vector, `bigram:${token}:${next}`, 0.6);
  }

  const magnitude = Math.sqrt(
    vector.reduce((total, component) => total + component * component, 0),
  );
  if (magnitude === 0) {
    hashFeature(vector, `empty:${question}`, 1);
    return vector;
  }
  return vector.map((component) => component / magnitude);
}

export class FallbackMarketIntelligenceProvider
  implements MarketIntelligenceProvider
{
  readonly mode = 'fallback' as const;

  async embed(question: string): Promise<number[]> {
    return localQuestionEmbedding(question);
  }

  async extractFields(question: string): Promise<MarketFactFields> {
    return extractFieldsLocally(question);
  }

  async judgeSameFact(
    draft: MarketQuestionFact,
    candidate: MarketQuestionFact,
  ): Promise<SameFactJudgment> {
    const structured = compareAuthoritativeFields(draft.fields, candidate.fields);
    if (!structured.compatible) {
      return { sameFact: false, reason: structured.reason };
    }
    if (structured.needsSemanticJudgment === true) {
      // This judge is deterministic and cannot resolve entity aliases or verb
      // phrasing, so an ambiguous subject/comparator stays not-a-duplicate.
      // Only the model-backed judge may equate them.
      return { sameFact: false, reason: structured.reason };
    }

    const similarity = tokenSimilarity(draft.question, candidate.question);
    const sameFact = similarity >= 0.7;
    return {
      sameFact,
      reason: sameFact
        ? `Structured fields match and normalized wording similarity is ${similarity.toFixed(3)}`
        : `Structured fields match, but normalized wording similarity ${similarity.toFixed(3)} is too uncertain`,
    };
  }
}
