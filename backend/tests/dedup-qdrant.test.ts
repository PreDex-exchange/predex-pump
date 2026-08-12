import { describe, expect, it, vi } from 'vitest';

import { QdrantMarketClient } from '../src/dedup/qdrant-client.js';
import { MARKET_EMBEDDING_DIMENSIONS } from '../src/dedup/types.js';

describe('Qdrant dedup provider partitions', () => {
  it('scrolls every point in only the requested provider partition', async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method !== 'POST') {
        return new Response(
          JSON.stringify({
            result: {
              config: { params: { vectors: { size: MARKET_EMBEDDING_DIMENSIONS } } },
            },
          }),
        );
      }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      requestBodies.push(body);
      const offset = body.offset;
      return new Response(
        JSON.stringify({
          result:
            offset === undefined
              ? {
                  points: [
                    {
                      id: 'point-1',
                      payload: { marketId: '1', embeddingProvider: 'openai' },
                    },
                    {
                      id: 'point-2',
                      payload: { marketId: '2', embeddingProvider: 'openai' },
                    },
                  ],
                  next_page_offset: 'point-2',
                }
              : {
                  points: [
                    {
                      id: 'point-3',
                      payload: { marketId: '3', embeddingProvider: 'openai' },
                    },
                  ],
                  next_page_offset: null,
                },
        }),
      );
    });
    const client = new QdrantMarketClient({
      url: 'http://qdrant.test',
      timeoutMs: 1_000,
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(client.listMarketIds('openai')).resolves.toEqual(['1', '2', '3']);
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).toMatchObject({
      filter: {
        must: [
          { key: 'embeddingProvider', match: { value: 'openai' } },
        ],
      },
      with_payload: true,
      with_vector: false,
    });
    expect(requestBodies[1]).toMatchObject({ offset: 'point-2' });
  });
});
