import { afterEach, describe, expect, it, vi } from 'vitest';

import { backendRestClient } from './rest-client';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('browser fetch failure copy', () => {
  it.each([
    ['PATCH', () => backendRestClient.updateAccountProfile({ displayName: 'Ada' })],
    ['DELETE', () => backendRestClient.withdrawOrder(`0x${'1'.repeat(64)}`)],
  ])('does not report a failed %s method as an unreachable API', async (method, request) => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(request()).rejects.toThrow(
      `The indexed API did not complete the ${method} request.`,
    );
    await expect(request()).rejects.not.toThrow('could not be reached');
  });

  it('aborts a stalled market-detail request after 1.25 seconds', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          if (!requestSignal) {
            reject(new Error('market request did not provide an abort signal'));
            return;
          }
          requestSignal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      }),
    );

    const request = backendRestClient.getMarket('17');
    const rejectedRequest = expect(request).rejects.toThrow(
      'did not respond within 1.25 seconds',
    );
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(1_249);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(requestSignal?.aborted).toBe(true);
    await rejectedRequest;
  });
});
