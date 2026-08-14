import type { ReactNode } from 'react';
import {
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MARKET_DETAIL_FAILURE_DISCLOSURE_OVERHEAD_MS,
  MARKET_DETAIL_MAX_FAILURE_DISCLOSURE_MS,
  useMarket,
} from './hooks';

vi.mock('./websocket', () => ({
  backendWsClient: {
    subscribe: vi.fn(),
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  notifyManager.setScheduler((callback) => callback());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
});

describe('market detail failure disclosure deadline', () => {
  it('reports four consecutively stalled attempts within the documented bound', async () => {
    const attemptStarts: number[] = [];
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) => {
        attemptStarts.push(Date.now());
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error('market request did not provide an abort signal'));
            return;
          }
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useMarket('17'), { wrapper });

    const scheduledFailureMs =
      MARKET_DETAIL_MAX_FAILURE_DISCLOSURE_MS -
      MARKET_DETAIL_FAILURE_DISCLOSURE_OVERHEAD_MS;

    expect(MARKET_DETAIL_MAX_FAILURE_DISCLOSURE_MS).toBe(30_000);
    expect(result.current.isLoading).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(scheduledFailureMs - 1);
    });
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(attemptStarts).toEqual([0, 6_000, 13_000, 22_000]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error?.message).toContain(
      'did not respond within 5 seconds',
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(Date.now()).toBeLessThanOrEqual(
      MARKET_DETAIL_MAX_FAILURE_DISCLOSURE_MS,
    );
  });
});
