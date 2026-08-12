import type { ReactNode } from 'react';
import {
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import {
  act,
  cleanup,
  renderHook,
  waitFor,
} from '@testing-library/react';
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { useDedupCheck, useMarkets } from './hooks';

const mocks = vi.hoisted(() => ({
  dedupCheck: vi.fn(async () => ({
    available: true,
    isDuplicate: false,
    canonicalMarketId: null,
    candidates: [],
  })),
  listMarkets: vi.fn(),
}));

vi.mock('./rest-client', () => ({
  backendRestClient: {
    dedupCheck: mocks.dedupCheck,
    listMarkets: mocks.listMarkets,
  },
}));

vi.mock('./websocket', () => ({
  backendWsClient: {
    subscribe: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  mocks.dedupCheck.mockClear();
  mocks.listMarkets.mockReset();
});

describe('paginated API resources', () => {
  it('retains fetched market pages and requests the returned cursor', async () => {
    mocks.listMarkets
      .mockResolvedValueOnce({
        items: [{ id: 'first' }],
        nextCursor: 'next-page',
      })
      .mockResolvedValueOnce({
        items: [{ id: 'second' }],
        nextCursor: null,
      });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useMarkets({ limit: 1 }), { wrapper });

    await waitFor(() => expect(result.current.data?.items).toHaveLength(1));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.data?.items).toHaveLength(2));

    expect(mocks.listMarkets).toHaveBeenNthCalledWith(2, {
      limit: 1,
      cursor: 'next-page',
      phase: undefined,
      creator: undefined,
    });
    expect(result.current.data?.nextCursor).toBeNull();
  });
});

describe('useDedupCheck', () => {
  it('waits for a quiet typing window before making one request', async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );
    const { rerender, result } = renderHook(
      ({ question }) => useDedupCheck(question, 500),
      {
        initialProps: { question: 'W' },
        wrapper,
      },
    );

    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    rerender({ question: 'Will this happen?' });
    await act(async () => {
      vi.advanceTimersByTime(499);
    });
    expect(mocks.dedupCheck).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
    });
    expect(mocks.dedupCheck).toHaveBeenCalledOnce();
    expect(mocks.dedupCheck).toHaveBeenCalledWith({
      question: 'Will this happen?',
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.isLoading).toBe(false);
  });
});
