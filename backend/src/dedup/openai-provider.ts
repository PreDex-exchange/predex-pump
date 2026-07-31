import type { MarketFactFields } from '@predex-pump/shared';

import {
  compareAuthoritativeFields,
  normalizeExtractedFields,
} from './normalization.js';
import {
  MARKET_EMBEDDING_DIMENSIONS,
  type MarketIntelligenceProvider,
  type MarketQuestionFact,
  type SameFactJudgment,
} from './types.js';

const OPENAI_API_URL = 'https://api.openai.com/v1';
const EMBEDDING_MODEL = 'text-embedding-3-small';
const JUDGE_MODEL = 'gpt-4o-mini';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function requiredNullableString(record: JsonRecord, key: string): string | null {
  const value = record[key];
  if (value === null || typeof value === 'string') return value;
  throw new Error(`OpenAI response field ${key} must be a string or null`);
}

function parseFields(value: unknown): MarketFactFields {
  if (!isRecord(value)) throw new Error('OpenAI field extraction was not an object');
  return normalizeExtractedFields({
    subject: requiredNullableString(value, 'subject'),
    comparator: requiredNullableString(value, 'comparator'),
    strike: requiredNullableString(value, 'strike'),
    deadline: requiredNullableString(value, 'deadline'),
    basis: requiredNullableString(value, 'basis'),
  });
}

function parseChatContent(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    throw new Error('OpenAI chat response omitted choices');
  }
  const first = value.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) {
    throw new Error('OpenAI chat response omitted the first message');
  }
  if (typeof first.message.refusal === 'string') {
    throw new Error(`OpenAI refused the structured request: ${first.message.refusal}`);
  }
  if (typeof first.message.content !== 'string') {
    throw new Error('OpenAI chat response omitted structured content');
  }
  try {
    return JSON.parse(first.message.content) as unknown;
  } catch (error) {
    throw new Error('OpenAI returned invalid structured JSON', { cause: error });
  }
}

const FIELD_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: ['string', 'null'] },
    comparator: { type: ['string', 'null'] },
    strike: { type: ['string', 'null'] },
    deadline: { type: ['string', 'null'] },
    basis: { type: ['string', 'null'] },
  },
  required: ['subject', 'comparator', 'strike', 'deadline', 'basis'],
  additionalProperties: false,
} as const;

const JUDGMENT_SCHEMA = {
  type: 'object',
  properties: {
    sameFact: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['sameFact', 'reason'],
  additionalProperties: false,
} as const;

export interface OpenAiProviderOptions {
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class OpenAiMarketIntelligenceProvider
  implements MarketIntelligenceProvider
{
  readonly mode = 'openai' as const;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiProviderOptions) {
    if (options.apiKey.trim() === '') throw new Error('OpenAI API key cannot be empty');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const response = await this.fetchImpl(`${OPENAI_API_URL}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(
        `OpenAI ${path} failed with HTTP ${response.status}: ${truncate(raw, 500)}`,
      );
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(`OpenAI ${path} returned invalid JSON`, { cause: error });
    }
  }

  private async structuredChat(
    name: string,
    schema: JsonRecord,
    system: string,
    user: string,
  ): Promise<unknown> {
    const response = await this.post('/chat/completions', {
      model: JUDGE_MODEL,
      temperature: 0,
      store: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name,
          strict: true,
          schema,
        },
      },
    });
    return parseChatContent(response);
  }

  async embed(question: string): Promise<number[]> {
    const response = await this.post('/embeddings', {
      model: EMBEDDING_MODEL,
      input: question,
      dimensions: MARKET_EMBEDDING_DIMENSIONS,
      encoding_format: 'float',
    });
    if (!isRecord(response) || !Array.isArray(response.data)) {
      throw new Error('OpenAI embedding response omitted data');
    }
    const first = response.data[0];
    if (!isRecord(first) || !Array.isArray(first.embedding)) {
      throw new Error('OpenAI embedding response omitted the first vector');
    }
    const embedding = first.embedding;
    if (
      embedding.length !== MARKET_EMBEDDING_DIMENSIONS ||
      embedding.some((component) => typeof component !== 'number' || !Number.isFinite(component))
    ) {
      throw new Error(
        `OpenAI embedding must contain ${MARKET_EMBEDDING_DIMENSIONS} finite numbers`,
      );
    }
    return embedding as number[];
  }

  async extractFields(question: string): Promise<MarketFactFields> {
    const response = await this.structuredChat(
      'market_fact_fields',
      FIELD_SCHEMA,
      [
        'Extract the authoritative identity of a binary prediction-market fact.',
        'Return null only when a field is genuinely absent.',
        'Normalize subject aliases to stable lowercase identifiers (for example Bitcoin -> btc).',
        'Prefer the entity’s most common full name over an abbreviation (Man Utd -> manchester united, the Fed -> federal reserve) so the same entity yields the same identifier.',
        'Normalize comparator semantics (above, below, at_or_above, at_or_below, equal, reach, win, lose).',
        'Return null for comparator and strike when the question is not a comparison against a threshold (for example "will X announce Y", "will it snow"); never invent one.',
        'Normalize numeric strikes as currency:value, percent:value, or number:value without separators.',
        'Normalize absolute deadlines as YYYY-MM-DD and retain explicit relative/weekday wording otherwise.',
        'Preserve the deadline granularity the question actually states: "in 2027" stays 2027 and "March 2026" stays 2026-03; never invent a more precise day than was given.',
        'Basis is the observation rule such as close, intraday, settlement, average, or official_result. Return null when the question states no explicit observation rule.',
      ].join(' '),
      question,
    );
    return parseFields(response);
  }

  async judgeSameFact(
    draft: MarketQuestionFact,
    candidate: MarketQuestionFact,
  ): Promise<SameFactJudgment> {
    const authoritative = compareAuthoritativeFields(draft.fields, candidate.fields);
    if (!authoritative.compatible) {
      return { sameFact: false, reason: authoritative.reason };
    }

    const response = await this.structuredChat(
      'same_market_fact_judgment',
      JUDGMENT_SCHEMA,
      [
        'Decide whether two prediction-market questions resolve from exactly the same real-world fact.',
        'The objective fields (comparator, strike, deadline, basis) already match and are authoritative.',
        'The two subjects may be written differently. Decide whether they denote the SAME real-world entity: aliases, abbreviations, and renamings of one entity are the same ("man utd" and "manchester united", "the fed" and "federal reserve"); genuinely different entities are not.',
        'Judge remaining semantic details and phrasing.',
        'Be conservative: uncertainty means sameFact=false.',
        'Never treat related, correlated, broader, narrower, or differently conditioned events as the same fact.',
      ].join(' '),
      JSON.stringify({ draft, candidate }),
    );
    if (
      !isRecord(response) ||
      typeof response.sameFact !== 'boolean' ||
      typeof response.reason !== 'string'
    ) {
      throw new Error('OpenAI same-fact judgment did not match its schema');
    }
    return {
      sameFact: response.sameFact,
      reason: response.reason,
    };
  }
}
