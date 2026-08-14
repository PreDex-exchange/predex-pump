import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  backendRestClient,
  REST_READ_TIMEOUT_MS,
  REST_WRITE_TIMEOUT_MS,
} from './rest-client';

const REST_METHOD_TIMEOUT_CASES = [
  ['getGatewayBalance', () => backendRestClient.getGatewayBalance(), REST_READ_TIMEOUT_MS],
  ['getSiweNonce', () => backendRestClient.getSiweNonce(), REST_WRITE_TIMEOUT_MS],
  [
    'verifySiwe',
    () => backendRestClient.verifySiwe({ message: 'message', signature: '0x01' }),
    REST_WRITE_TIMEOUT_MS,
  ],
  ['getSession', () => backendRestClient.getSession(), REST_READ_TIMEOUT_MS],
  ['signOut', () => backendRestClient.signOut(), REST_WRITE_TIMEOUT_MS],
  ['getAccountProfile', () => backendRestClient.getAccountProfile(), REST_READ_TIMEOUT_MS],
  [
    'updateAccountProfile',
    () => backendRestClient.updateAccountProfile({ displayName: 'Ada' }),
    REST_WRITE_TIMEOUT_MS,
  ],
  [
    'setWatchlist',
    () => backendRestClient.setWatchlist('17', true),
    REST_WRITE_TIMEOUT_MS,
  ],
  [
    'recordAccountBehavior',
    () =>
      backendRestClient.recordAccountBehavior({
        type: 'MARKET_VIEWED',
        marketId: '17',
      }),
    REST_WRITE_TIMEOUT_MS,
  ],
  ['listMarkets', () => backendRestClient.listMarkets(), REST_READ_TIMEOUT_MS],
  [
    'dedupCheck',
    () => backendRestClient.dedupCheck({ question: 'Will this happen?' }),
    REST_WRITE_TIMEOUT_MS,
  ],
  ['getMarket', () => backendRestClient.getMarket('17'), REST_READ_TIMEOUT_MS],
  [
    'getAccount',
    () => backendRestClient.getAccount(`0x${'12'.repeat(20)}`),
    REST_READ_TIMEOUT_MS,
  ],
  [
    'getExchangeApprovals',
    () => backendRestClient.getExchangeApprovals(`0x${'12'.repeat(20)}`),
    REST_READ_TIMEOUT_MS,
  ],
  ['getMyOrders', () => backendRestClient.getMyOrders(), REST_READ_TIMEOUT_MS],
  [
    'postOrder',
    () => backendRestClient.postOrder({} as never),
    REST_WRITE_TIMEOUT_MS,
  ],
  [
    'withdrawOrder',
    () => backendRestClient.withdrawOrder(`0x${'1'.repeat(64)}`),
    REST_WRITE_TIMEOUT_MS,
  ],
  ['getOrderBook', () => backendRestClient.getOrderBook('17'), REST_READ_TIMEOUT_MS],
  [
    'getTokenOrderBook',
    () => backendRestClient.getTokenOrderBook('23'),
    REST_READ_TIMEOUT_MS,
  ],
  ['getActivity', () => backendRestClient.getActivity(), REST_READ_TIMEOUT_MS],
  ['getConfig', () => backendRestClient.getConfig(), REST_READ_TIMEOUT_MS],
  [
    'getPriceHistory',
    () => backendRestClient.getPriceHistory('17'),
    REST_READ_TIMEOUT_MS,
  ],
  ['getHealth', () => backendRestClient.getHealth(), REST_READ_TIMEOUT_MS],
] as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('browser fetch failure copy', () => {
  it('returns a null market for a genuine HTTP 404 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
    );

    await expect(backendRestClient.getMarket('404')).resolves.toBeNull();
  });

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

  it('covers every REST client method in the timeout table', () => {
    expect(
      REST_METHOD_TIMEOUT_CASES.map(([name]) => name).sort(),
    ).toEqual(Object.keys(backendRestClient).sort());
  });

  it.each(REST_METHOD_TIMEOUT_CASES)(
    'aborts a stalled %s request after its policy timeout',
    async (_name, makeRequest, timeoutMs) => {
      vi.useFakeTimers();
      let requestSignal: AbortSignal | undefined;
      vi.stubGlobal(
        'fetch',
        vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
          requestSignal = init?.signal ?? undefined;
          return new Promise<Response>((_resolve, reject) => {
            if (!requestSignal) {
              reject(new Error('REST request did not provide an abort signal'));
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

      const request = makeRequest();
      const rejectedRequest = request.then(
        () => null,
        (error: unknown) => error,
      );
      expect(requestSignal).toBeInstanceOf(AbortSignal);
      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      expect(requestSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(requestSignal?.aborted).toBe(true);
      const error = await rejectedRequest;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        `did not respond within ${timeoutMs / 1_000} seconds`,
      );
    },
  );

  it('does not expose an arbitrary backend error string', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: 'marketId must be an unsigned decimal string' }),
          {
            headers: { 'content-type': 'application/json' },
            status: 400,
          },
        ),
      ),
    );

    const request = backendRestClient.getMarket('not-a-market');

    await expect(request).rejects.toThrow('The indexed API rejected this request.');
    await expect(request).rejects.not.toThrow('marketId');
  });

  it('keeps the timeout active while a successful response body is stalled', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return {
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              requestSignal?.addEventListener(
                'abort',
                () => reject(new DOMException('Aborted', 'AbortError')),
                { once: true },
              );
            }),
        } as Response;
      }),
    );

    const request = backendRestClient.getAccount(`0x${'12'.repeat(20)}`);
    const rejectedRequest = request.then(
      () => null,
      (error: unknown) => error,
    );
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(REST_READ_TIMEOUT_MS - 1);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(requestSignal?.aborted).toBe(true);
    const error = await rejectedRequest;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      `did not respond within ${REST_READ_TIMEOUT_MS / 1_000} seconds`,
    );
  });
});
