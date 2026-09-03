import type { MarketBookResponse } from '@predex-pump/shared/rest';
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import {
  act,
  cleanup,
  renderHook,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  orderBookRefreshIntervalMs,
  useDedupCheck,
  useMarket,
  useMarkets,
  useOrderBook,
} from './hooks';

type ConnectionStatus = 'idle' | 'connecting' | 'live' | 'reconnecting';

const mocks = vi.hoisted(() => ({
  dedupCheck: vi.fn(async () => ({
    available: true,
    isDuplicate: false,
    canonicalMarketId: null,
    candidates: [],
  })),
  getMarket: vi.fn(async () => null),
  getOrderBook: vi.fn(async () => ({})),
  listMarkets: vi.fn(),
  connectionStatus: 'idle' as ConnectionStatus,
  statusListener: null as ((status: ConnectionStatus) => void) | null,
  subscribe: vi.fn(),
  subscribeStatus: vi.fn(),
}));

vi.mock('./rest-client', () => ({
  REST_READ_TIMEOUT_MS: 5_000,
  backendRestClient: {
    dedupCheck: mocks.dedupCheck,
    getMarket: mocks.getMarket,
    getOrderBook: mocks.getOrderBook,
    listMarkets: mocks.listMarkets,
  },
}));

vi.mock('./websocket', () => ({
  backendWsClient: {
    subscribe: mocks.subscribe,
    subscribeStatus: mocks.subscribeStatus,
  },
}));

beforeEach(() => {
  mocks.connectionStatus = 'idle';
  mocks.statusListener = null;
  mocks.subscribe.mockReset().mockReturnValue(vi.fn());
  mocks.subscribeStatus.mockReset().mockImplementation(
    (listener: (status: ConnectionStatus) => void) => {
      mocks.statusListener = listener;
      listener(mocks.connectionStatus);
      return () => {
        if (mocks.statusListener === listener) mocks.statusListener = null;
      };
    },
  );
  mocks.getOrderBook.mockReset().mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
  vi.useRealTimers();
  mocks.dedupCheck.mockClear();
  mocks.getMarket.mockClear();
  mocks.getOrderBook.mockClear();
  mocks.listMarkets.mockReset();
});

describe('order-book REST fallback', () => {
  it.each([
    ['idle', 4_000],
    ['connecting', 4_000],
    ['reconnecting', 4_000],
    ['live', 15_000],
  ] as const)(
    'selects the REST interval while the WebSocket is %s (%ims)',
    (connectionStatus, expectedInterval) => {
      expect(orderBookRefreshIntervalMs(connectionStatus)).toBe(expectedInterval);
    },
  );

  it('uses two-second polling only while MiniCLOB is actionable or Hybrid liquidity is preparing', () => {
    expect(
      orderBookRefreshIntervalMs('live', {
        liveVenue: 'MINICLOB',
        orderBookAvailable: true,
      }),
    ).toBe(2_000);
    expect(
      orderBookRefreshIntervalMs('live', {
        liveVenue: 'NONE',
        orderBookAvailable: false,
        venueTransition: { state: 'PREPARING' },
      }),
    ).toBe(2_000);
    expect(
      orderBookRefreshIntervalMs('live', {
        liveVenue: 'HYBRID',
        orderBookAvailable: true,
      }),
    ).toBe(15_000);
    expect(
      orderBookRefreshIntervalMs('reconnecting', {
        liveVenue: 'HYBRID',
        orderBookAvailable: true,
      }),
    ).toBe(4_000);
  });

  it('polls every four seconds while disconnected, pauses in the background, and refetches on focus', async () => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );

    renderHook(() => useOrderBook('17'), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.getOrderBook).toHaveBeenCalledOnce();
    expect(mocks.subscribe).toHaveBeenCalledWith(
      'book:17',
      expect.any(Function),
    );
    expect(mocks.subscribeStatus).toHaveBeenCalledOnce();

    focusManager.setFocused(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(mocks.getOrderBook).toHaveBeenCalledOnce();

    await act(async () => {
      focusManager.setFocused(true);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.getOrderBook).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_999);
    });
    expect(mocks.getOrderBook).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.getOrderBook).toHaveBeenCalledTimes(3);
  });

  it('backs the interval off to fifteen seconds once the WebSocket is live', async () => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );

    renderHook(() => useOrderBook('17'), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      mocks.statusListener?.('live');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.getOrderBook).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_999);
    });
    expect(mocks.getOrderBook).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.getOrderBook).toHaveBeenCalledTimes(2);
  });

  it('returns from two-second migration polling to the normal live interval after Hybrid arrives', async () => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
    mocks.connectionStatus = 'live';
    const miniClob = {
      liveVenue: 'MINICLOB',
      orderBookAvailable: true,
    } as MarketBookResponse;
    const hybrid = {
      liveVenue: 'HYBRID',
      orderBookAvailable: true,
    } as MarketBookResponse;
    mocks.getOrderBook
      .mockResolvedValueOnce(miniClob)
      .mockResolvedValue(hybrid);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );

    renderHook(() => useOrderBook('17'), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.getOrderBook).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(mocks.getOrderBook).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_999);
    });
    expect(mocks.getOrderBook).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.getOrderBook).toHaveBeenCalledTimes(3);
  });
});

describe('market detail failure disclosure', () => {
  it('matches the portfolio default of three exponential-backoff retries', async () => {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );

    renderHook(() => useMarket('17'), { wrapper });
    await waitFor(() => expect(mocks.getMarket).toHaveBeenCalledOnce());

    const query = queryClient.getQueryCache().find({
      exact: true,
      queryKey: ['market', '17'],
    });
    expect(query?.options.retry).toBe(3);
    expect(query?.options.retryDelay).toBeTypeOf('function');
    const retryDelay = query?.options.retryDelay;
    if (typeof retryDelay !== 'function') {
      throw new Error('market retry delay is not callable');
    }
    expect(retryDelay(0, new Error('first failure'))).toBe(1_000);
    expect(retryDelay(1, new Error('second failure'))).toBe(2_000);
    expect(retryDelay(2, new Error('third failure'))).toBe(4_000);
  });
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
