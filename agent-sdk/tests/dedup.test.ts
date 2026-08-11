import type { DedupCheckResponse } from '@predex-pump/shared';
import { describe, expect, it, vi } from 'vitest';

import { createRestClient, dedupCheck } from '../src/index.js';

const unavailable: DedupCheckResponse = {
  available: false,
  isDuplicate: false,
  canonicalMarketId: null,
  candidates: [],
};

describe('dedupCheck', () => {
  it('posts the question and preserves the shared D2 response fields', async () => {
    const response: DedupCheckResponse = {
      available: true,
      isDuplicate: true,
      canonicalMarketId: '42',
      candidates: [
        {
          marketId: '42',
          question: 'Will the fact happen?',
          score: 0.984,
          reason: 'The normalized fact and deadline match.',
        },
      ],
    };
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = createRestClient({
      baseUrl: 'http://predex.test/',
      fetch: fetchMock as typeof fetch,
    });

    await expect(dedupCheck('Will the fact happen?', client)).resolves.toEqual(
      response,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://predex.test/markets/dedup-check',
      expect.objectContaining({
        body: JSON.stringify({ question: 'Will the fact happen?' }),
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        method: 'POST',
      }),
    );
  });

  it('returns the shared degraded response without throwing', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(unavailable), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = createRestClient({
      fetch: fetchMock as typeof fetch,
    });

    await expect(dedupCheck('Will the fact happen?', client)).resolves.toEqual(
      unavailable,
    );
  });

  it('fails open when the backend cannot be reached', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('network unavailable');
    });
    const client = createRestClient({
      fetch: fetchMock as typeof fetch,
    });

    await expect(dedupCheck('Will the fact happen?', client)).resolves.toEqual(
      unavailable,
    );
  });
});
