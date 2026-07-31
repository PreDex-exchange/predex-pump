import { createHash } from 'node:crypto';

import type { MarketFactFields, MarketPhase } from '@predex-pump/shared';

import {
  MARKET_COLLECTION,
  MARKET_EMBEDDING_DIMENSIONS,
  type EmbeddingProviderMode,
  type MarketVectorMatch,
  type MarketVectorPayload,
  type MarketVectorPoint,
  type MarketVectorStore,
} from './types.js';

type JsonRecord = Record<string, unknown>;

const MARKET_PHASES = new Set<MarketPhase>([
  'Opened',
  'Graduated',
  'ResolvedObserved',
  'ClosedOut',
]);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function qdrantPointId(marketId: string): string {
  const hex = createHash('sha256').update(`predex-market:${marketId}`).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

function requiredString(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`Qdrant payload ${key} is not a string`);
  return value;
}

function nullableString(record: JsonRecord, key: keyof MarketFactFields): string | null {
  const value = record[key];
  if (value === null || typeof value === 'string') return value;
  throw new Error(`Qdrant payload ${key} is not a string or null`);
}

function parsePayload(value: unknown): MarketVectorPayload {
  if (!isRecord(value)) throw new Error('Qdrant result omitted its market payload');
  const phase = requiredString(value, 'phase');
  if (!MARKET_PHASES.has(phase as MarketPhase)) {
    throw new Error(`Qdrant payload contains unknown market phase ${phase}`);
  }
  const embeddingProvider = requiredString(value, 'embeddingProvider');
  if (embeddingProvider !== 'openai' && embeddingProvider !== 'fallback') {
    throw new Error(
      `Qdrant payload contains unknown embedding provider ${embeddingProvider}`,
    );
  }
  return {
    marketId: requiredString(value, 'marketId'),
    question: requiredString(value, 'question'),
    subject: nullableString(value, 'subject'),
    comparator: nullableString(value, 'comparator'),
    strike: nullableString(value, 'strike'),
    deadline: nullableString(value, 'deadline'),
    basis: nullableString(value, 'basis'),
    phase: phase as MarketPhase,
    embeddingProvider,
  };
}

function assertVector(vector: readonly number[]): void {
  if (
    vector.length !== MARKET_EMBEDDING_DIMENSIONS ||
    vector.some((component) => !Number.isFinite(component))
  ) {
    throw new Error(
      `Market vector must contain ${MARKET_EMBEDDING_DIMENSIONS} finite numbers`,
    );
  }
}

export interface QdrantMarketClientOptions {
  url: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class QdrantMarketClient implements MarketVectorStore {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private collectionReady: Promise<void> | undefined;

  constructor(options: QdrantMarketClientOptions) {
    const url = options.url.trim().replace(/\/+$/u, '');
    if (url === '') throw new Error('Qdrant URL cannot be empty');
    this.url = url;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    return this.fetchImpl(`${this.url}${path}`, {
      ...init,
      headers: {
        ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init?.headers,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  private async responseJson(response: Response, operation: string): Promise<unknown> {
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(
        `Qdrant ${operation} failed with HTTP ${response.status}: ${truncate(raw, 500)}`,
      );
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(`Qdrant ${operation} returned invalid JSON`, { cause: error });
    }
  }

  private async initializeCollection(): Promise<void> {
    const path = `/collections/${MARKET_COLLECTION}`;
    const existing = await this.request(path);
    if (existing.ok) {
      const body = await this.responseJson(existing, 'collection lookup');
      if (isRecord(body) && isRecord(body.result) && isRecord(body.result.config)) {
        const params = body.result.config.params;
        if (isRecord(params) && isRecord(params.vectors)) {
          const size = params.vectors.size;
          if (typeof size === 'number' && size !== MARKET_EMBEDDING_DIMENSIONS) {
            throw new Error(
              `Qdrant collection ${MARKET_COLLECTION} has vector size ${size}; expected ${MARKET_EMBEDDING_DIMENSIONS}`,
            );
          }
        }
      }
      return;
    }
    if (existing.status !== 404) {
      await this.responseJson(existing, 'collection lookup');
      return;
    }

    const created = await this.request(path, {
      method: 'PUT',
      body: JSON.stringify({
        vectors: {
          size: MARKET_EMBEDDING_DIMENSIONS,
          distance: 'Cosine',
        },
      }),
    });
    if (created.status === 409) return;
    await this.responseJson(created, 'collection creation');
  }

  private async ensureCollection(): Promise<void> {
    this.collectionReady ??= this.initializeCollection().catch((error: unknown) => {
      this.collectionReady = undefined;
      throw error;
    });
    await this.collectionReady;
  }

  async upsertMarket(point: MarketVectorPoint): Promise<void> {
    assertVector(point.vector);
    await this.ensureCollection();
    const response = await this.request(
      `/collections/${MARKET_COLLECTION}/points?wait=true`,
      {
        method: 'PUT',
        body: JSON.stringify({
          points: [
            {
              id: qdrantPointId(point.payload.marketId),
              vector: point.vector,
              payload: point.payload,
            },
          ],
        }),
      },
    );
    await this.responseJson(response, 'market upsert');
  }

  async searchMarkets(
    vector: readonly number[],
    limit: number,
    embeddingProvider: EmbeddingProviderMode,
  ): Promise<MarketVectorMatch[]> {
    assertVector(vector);
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error(`Qdrant search limit must be a positive integer, received ${limit}`);
    }
    await this.ensureCollection();
    const response = await this.request(
      `/collections/${MARKET_COLLECTION}/points/search`,
      {
        method: 'POST',
        body: JSON.stringify({
          vector,
          limit,
          filter: {
            must: [
              {
                key: 'embeddingProvider',
                match: { value: embeddingProvider },
              },
            ],
          },
          with_payload: true,
          with_vector: false,
        }),
      },
    );
    const body = await this.responseJson(response, 'market search');
    if (!isRecord(body) || !Array.isArray(body.result)) {
      throw new Error('Qdrant market search response omitted results');
    }
    return body.result.map((result) => {
      if (
        !isRecord(result) ||
        typeof result.score !== 'number' ||
        !Number.isFinite(result.score)
      ) {
        throw new Error('Qdrant market search returned an invalid score');
      }
      return {
        score: result.score,
        payload: parsePayload(result.payload),
      };
    });
  }
}
