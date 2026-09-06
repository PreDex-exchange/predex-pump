import type {
  AccountResponse,
  MakerOrdersResponse,
  MarketBookResponse,
} from '@predex-pump/shared/rest';
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
  useAccount,
  useDedupCheck,
  useMarket,
  useMarkets,
  useMyOrders,
  useOrderBook,
  usePaginatedAccount,
} from './hooks';

type ConnectionStatus = 'idle' | 'connecting' | 'live' | 'reconnecting';

const mocks = vi.hoisted(() => ({
  dedupCheck: vi.fn(async () => ({
    available: true,
    isDuplicate: false,
    canonicalMarketId: null,
    candidates: [],
  })),
  getAccount: vi.fn(),
  getMarket: vi.fn(async () => null),
  getMyOrders: vi.fn(),
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
    getAccount: mocks.getAccount,
    getMarket: mocks.getMarket,
    getMyOrders: mocks.getMyOrders,
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
  mocks.getAccount.mockReset();
  mocks.getMyOrders.mockReset().mockResolvedValue({
    orders: [],
    onchainOrders: [],
    offchainWithdrawalIsOnchainCancellation: false,
    warning: 'Withdrawal is not cancellation.',
  } satisfies MakerOrdersResponse);
});

afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
  vi.useRealTimers();
  mocks.dedupCheck.mockClear();
  mocks.getMarket.mockClear();
  mocks.getAccount.mockClear();
  mocks.getMyOrders.mockClear();
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
    expect(mocks.getOrderBook).toHaveBeenLastCalledWith('17', {
      orderLimitPerSide: 20,
    });
    expect(
      queryClient.getQueryCache().find({
        exact: true,
        queryKey: ['order-book', '17', 20],
      }),
    ).toBeTruthy();
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

describe('account query filters and position pages', () => {
  const address = `0x${'AB'.repeat(20)}`;
  const normalizedAddress = address.toLowerCase();
  const accountPage = (
    positions: AccountResponse['positions'],
    positionsNextCursor: string | null,
    tradeCount = 7,
  ): AccountResponse => ({
    account: {
      address: normalizedAddress as `0x${string}`,
      firstSeenAt: 1,
      marketsCreated: 2,
      tradeCount,
    },
    positions,
    recentTrades: [],
    pnl: { realizedRaw: '123', unrealizedRaw: '456' },
    positionsNextCursor,
  });

  it('isolates market-filtered account queries in the cache', async () => {
    mocks.getAccount.mockResolvedValue(accountPage([], null));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );

    renderHook(
      () => {
        useAccount(address, { marketId: '1' });
        useAccount(address, { marketId: '2' });
      },
      { wrapper },
    );

    await waitFor(() => expect(mocks.getAccount).toHaveBeenCalledTimes(2));
    expect(mocks.getAccount.mock.calls).toEqual(
      expect.arrayContaining([
        [normalizedAddress, { marketId: '1' }],
        [normalizedAddress, { marketId: '2' }],
      ]),
    );
    expect(
      queryClient.getQueryCache().find({
        exact: true,
        queryKey: ['account', normalizedAddress, 'single', '1', null, null],
      }),
    ).toBeTruthy();
    expect(
      queryClient.getQueryCache().find({
        exact: true,
        queryKey: ['account', normalizedAddress, 'single', '2', null, null],
      }),
    ).toBeTruthy();
  });

  it('appends position pages without duplicates and retains first-page totals', async () => {
    const yesPosition = {
      account: normalizedAddress as `0x${string}`,
      marketId: '1',
      outcome: 'YES' as const,
      qtyRaw: '1',
      costBasisRaw: '1',
      costBasisEstimated: true as const,
      realizedPnlRaw: '0',
      unrealizedPnlRaw: '0',
      updatedAt: 3,
    };
    const noPosition = {
      ...yesPosition,
      marketId: '2',
      outcome: 'NO' as const,
      updatedAt: 2,
    };
    mocks.getAccount
      .mockResolvedValueOnce(accountPage([yesPosition], 'next'))
      .mockResolvedValueOnce({
        ...accountPage([yesPosition, noPosition], null, 999),
        pnl: { realizedRaw: '999', unrealizedRaw: '999' },
      });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );
    const { result } = renderHook(
      () => usePaginatedAccount(address, { positionsLimit: 1 }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data?.positions).toHaveLength(1));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.data?.positions).toHaveLength(2));

    expect(mocks.getAccount).toHaveBeenNthCalledWith(1, normalizedAddress, {
      positionsLimit: 1,
    });
    expect(mocks.getAccount).toHaveBeenNthCalledWith(2, normalizedAddress, {
      positionsLimit: 1,
      positionsCursor: 'next',
    });
    expect(result.current.data?.positions.map((position) => position.marketId)).toEqual([
      '1',
      '2',
    ]);
    expect(result.current.data?.account.tradeCount).toBe(7);
    expect(result.current.data?.pnl).toEqual({
      realizedRaw: '123',
      unrealizedRaw: '456',
    });
    expect(result.current.hasNextPage).toBe(false);
  });

  it('retains loaded account data when the next positions page fails', async () => {
    const position = {
      account: normalizedAddress as `0x${string}`,
      marketId: '1',
      outcome: 'YES' as const,
      qtyRaw: '1',
      costBasisRaw: '1',
      costBasisEstimated: true as const,
      realizedPnlRaw: '0',
      unrealizedPnlRaw: '0',
      updatedAt: 3,
    };
    mocks.getAccount
      .mockResolvedValueOnce(accountPage([position], 'next'))
      .mockRejectedValueOnce(new Error('next page unavailable'));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );
    const { result } = renderHook(
      () => usePaginatedAccount(address, { positionsLimit: 1 }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data?.positions).toHaveLength(1));
    act(() => result.current.loadMore());
    await waitFor(() =>
      expect(result.current.loadMoreError?.message).toBe(
        'next page unavailable',
      ),
    );

    expect(result.current.data?.positions).toEqual([position]);
    expect(result.current.error).toBeNull();
    expect(result.current.hasNextPage).toBe(true);
  });
});

describe('private maker orders', () => {
  const address = `0x${'12'.repeat(20)}`;

  it('makes one failed private request and never retries it', async () => {
    vi.useFakeTimers();
    mocks.getMyOrders.mockRejectedValue(new Error('authentication required'));
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: 3,
          retryDelay: 1,
        },
      },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );

    const { result } = renderHook(() => useMyOrders(address, true), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(result.current.error?.message).toBe('authentication required');
    expect(mocks.getMyOrders).toHaveBeenCalledOnce();
    expect(
      queryClient.getQueryCache().find({
        exact: true,
        queryKey: ['my-orders', address],
      })?.options.retry,
    ).toBe(false);
  });

  it('never requests private orders while the query is disabled', async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );

    renderHook(() => useMyOrders(address, false), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(mocks.getMyOrders).not.toHaveBeenCalled();
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
