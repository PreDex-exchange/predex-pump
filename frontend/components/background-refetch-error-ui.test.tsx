import {
  notifyManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FeedScreen } from './feed/FeedScreen';
import { MarketScreen } from './market/MarketScreen';

const mocks = vi.hoisted(() => ({
  getMarket: vi.fn(),
  listMarkets: vi.fn(),
}));

vi.mock('wagmi', async (importOriginal) => {
  const original = await importOriginal<typeof import('wagmi')>();
  return {
    ...original,
    useAccount: () => ({ address: undefined }),
  };
});

vi.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({
    session: { authenticated: false },
    isSigningIn: false,
    signIn: vi.fn(),
  }),
}));

vi.mock('@/lib/api/rest-client', () => ({
  REST_READ_TIMEOUT_MS: 5_000,
  backendRestClient: {
    getMarket: mocks.getMarket,
    listMarkets: mocks.listMarkets,
  },
}));

vi.mock('@/lib/api/websocket', () => ({
  backendWsClient: {
    subscribe: vi.fn(() => vi.fn()),
  },
}));

vi.mock('@/lib/api/hooks', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api/hooks')>();
  return {
    ...original,
    useAccount: () => ({ data: null }),
    useAccountProfile: () => ({ data: null, error: null, isLoading: false }),
    useActivity: () => ({
      data: { items: [], nextCursor: null },
      error: null,
      isLoading: false,
      isLoadingMore: false,
      refetch: vi.fn(),
    }),
    useOrderBook: () => ({
      data: null,
      error: null,
      isLoading: false,
      refetch: vi.fn(),
    }),
    usePriceHistory: () => ({ data: { points: [] } }),
  };
});

function renderWithQueryClient(children: ReactNode) {
  const queryClient = new QueryClient();
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  notifyManager.setScheduler((callback) => callback());
  mocks.getMarket.mockReset().mockRejectedValue(new Error('market unavailable'));
  mocks.listMarkets.mockReset().mockRejectedValue(new Error('feed unavailable'));
});

afterEach(() => {
  cleanup();
  onlineManager.setOnline(true);
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
  vi.useRealTimers();
});

describe('background refetch failure UI', () => {
  it('renders a retryable error while a failed first load is paused', async () => {
    const transportError = new Error('market transport unavailable');
    mocks.getMarket.mockReset().mockRejectedValue(transportError);
    const { queryClient } = renderWithQueryClient(<MarketScreen marketId="17" />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.getMarket).toHaveBeenCalledOnce();

    onlineManager.setOnline(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(queryClient.getQueryState(['market', '17'])).toMatchObject({
      data: undefined,
      error: null,
      errorUpdateCount: 0,
      fetchFailureCount: 1,
      fetchFailureReason: transportError,
      fetchStatus: 'paused',
      status: 'pending',
    });
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('This market would not open')).toBeTruthy();
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText('No egg with that number')).toBeNull();
  });

  it('renders not found after the market request succeeds with a 404 result', async () => {
    mocks.getMarket.mockReset().mockResolvedValue(null);

    renderWithQueryClient(<MarketScreen marketId="404" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText('No egg with that number')).toBeTruthy();
    expect(screen.queryByText('This market would not open')).toBeNull();
  });

  it('does not render an empty feed while its failed first load is paused', async () => {
    renderWithQueryClient(<FeedScreen />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.listMarkets).toHaveBeenCalledOnce();

    onlineManager.setOnline(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    const marketSurface = screen.getByRole('region', { name: 'Markets' });
    const alert = within(marketSurface).getByRole('alert');
    expect(within(alert).getByText('The nest needs a reset')).toBeTruthy();
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(within(marketSurface).queryByText('No markets in this nest yet')).toBeNull();
  });

  it('keeps the market error actions visible throughout an automatic refetch', async () => {
    renderWithQueryClient(<MarketScreen marketId="17" />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_000);
      await Promise.resolve();
    });
    expect(screen.getByText('This market would not open')).toBeTruthy();
    expect(screen.queryByText('Checking this egg…')).toBeNull();
    const settledAttemptCount = mocks.getMarket.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
      await Promise.resolve();
    });

    expect(mocks.getMarket.mock.calls.length).toBeGreaterThan(settledAttemptCount);
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('This market would not open')).toBeTruthy();
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText('Checking this egg…')).toBeNull();
  });

  it('keeps the feed error action visible throughout an automatic refetch', async () => {
    renderWithQueryClient(<FeedScreen />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_000);
      await Promise.resolve();
    });
    expect(screen.getByText('The nest needs a reset')).toBeTruthy();
    expect(screen.queryByText('Warming the nest…')).toBeNull();
    const settledAttemptCount = mocks.listMarkets.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
      await Promise.resolve();
    });

    expect(mocks.listMarkets.mock.calls.length).toBeGreaterThan(settledAttemptCount);
    const marketSurface = screen.getByRole('region', { name: 'Markets' });
    const alert = within(marketSurface).getByRole('alert');
    expect(within(alert).getByText('The nest needs a reset')).toBeTruthy();
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(within(marketSurface).queryByText('Warming the nest…')).toBeNull();
  });
});
