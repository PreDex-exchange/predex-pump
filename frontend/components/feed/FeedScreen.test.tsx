import type { ActivityEvent, Market } from '@predex-pump/shared/domain';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FeedScreen } from './FeedScreen';

const mocks = vi.hoisted(() => ({
  activity: {
    data: { items: [] as ActivityEvent[], nextCursor: null as string | null },
    error: null as Error | null,
    isLoading: false,
    isLoadingMore: false,
    loadMore: vi.fn(),
    refetch: vi.fn(),
  },
  markets: {
    data: { items: [] as Market[], nextCursor: null as string | null },
    error: null as Error | null,
    isLoading: false,
    isLoadingMore: false,
    loadMore: vi.fn(),
    refetch: vi.fn(),
  },
  useMarkets: vi.fn(),
}));

vi.mock('@/lib/api/hooks', () => ({
  useActivity: () => mocks.activity,
  useMarkets: mocks.useMarkets,
  usePriceHistory: () => ({ data: { points: [] } }),
}));

beforeEach(() => {
  mocks.activity.data = { items: [], nextCursor: null };
  mocks.activity.error = null;
  mocks.activity.isLoading = false;
  mocks.activity.isLoadingMore = false;
  mocks.markets.data = { items: [], nextCursor: null };
  mocks.markets.error = null;
  mocks.markets.isLoading = false;
  mocks.markets.isLoadingMore = false;
  mocks.activity.loadMore.mockClear();
  mocks.activity.refetch.mockClear();
  mocks.markets.loadMore.mockClear();
  mocks.markets.refetch.mockClear();
  mocks.useMarkets.mockReset();
  mocks.useMarkets.mockReturnValue(mocks.markets);
});

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});

describe('FeedScreen failure states', () => {
  it('bounds the first market page for mobile feed fluency', () => {
    render(<FeedScreen />);

    expect(mocks.useMarkets).toHaveBeenCalledWith({ limit: 12 });
  });

  it('keeps character art out of the market-price loading surface', () => {
    mocks.markets.isLoading = true;

    render(<FeedScreen />);

    const marketSurface = screen.getByRole('region', { name: 'Markets' });
    expect(within(marketSurface).getByText('Warming the nest…')).toBeTruthy();
    expect(marketSurface.querySelector('svg')).toBeNull();
  });

  it('keeps character art out of the empty market-price surface', () => {
    render(<FeedScreen />);

    const marketSurface = screen.getByRole('region', { name: 'Markets' });
    expect(within(marketSurface).getByText('No markets in this nest yet')).toBeTruthy();
    expect(marketSurface.querySelector('svg')).toBeNull();
  });

  it('renders unknown hero statistics when the markets query fails', () => {
    mocks.markets.data = null as never;
    mocks.markets.error = new Error('markets unavailable');

    render(<FeedScreen />);

    const statistics = screen.getByRole('list', {
      name: 'Platform statistics',
    });
    expect(statistics.textContent).toContain('—');
    expect(statistics.textContent).not.toContain('$0');
    expect(statistics.textContent).not.toMatch(/0\s*markets/u);
    expect(screen.getByText('The nest needs a reset')).toBeTruthy();
    const marketSurface = screen.getByRole('region', { name: 'Markets' });
    const alert = within(marketSurface).getByRole('alert');
    expect(alert.textContent).not.toMatch(/refresh/u);
    expect(marketSurface.querySelector('svg')).toBeNull();

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));

    expect(mocks.markets.refetch).toHaveBeenCalledOnce();
  });

  it('renders an activity error instead of the empty state when activity fails', () => {
    mocks.activity.data = null as never;
    mocks.activity.error = new Error('activity unavailable');

    render(<FeedScreen />);

    expect(
      screen.getByRole('alert').textContent,
    ).toContain('The indexed history is unavailable');
    expect(screen.queryByText('Waiting for on-chain activity…')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Try activity again' }),
    );
    expect(mocks.activity.refetch).toHaveBeenCalledOnce();
  });
});

describe('FeedScreen filters', () => {
  it('uses a pressed-button group rather than an incomplete tabs pattern', () => {
    render(<FeedScreen />);

    const group = screen.getByRole('group', { name: 'Filter markets' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons).toHaveLength(4);
    expect(screen.queryByRole('tab')).toBeNull();
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(within(group).getByRole('button', { name: 'Graduated' }));

    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('false');
    expect(buttons[2]?.getAttribute('aria-pressed')).toBe('true');
  });

  it('does not suggest launching into an empty Resolved filter', () => {
    render(<FeedScreen />);

    fireEvent.click(screen.getByRole('button', { name: 'Resolved' }));

    expect(
      screen.getByText('Try another phase, or wait for an open market to resolve.'),
    ).toBeTruthy();
    expect(screen.queryByText(/launch the first market/iu)).toBeNull();
  });

  it('stores filter and sort in the URL and restores them after remount', async () => {
    render(<FeedScreen />);
    const group = screen.getByRole('group', { name: 'Filter markets' });

    fireEvent.click(within(group).getByRole('button', { name: 'Graduated' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort markets' }), {
      target: { value: 'volume' },
    });

    expect(window.location.search).toBe('?filter=graduated&sort=volume');
    cleanup();
    render(<FeedScreen />);

    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: 'Graduated' })
          .getAttribute('aria-pressed'),
      ).toBe('true'),
    );
    expect(
      (screen.getByRole('combobox', { name: 'Sort markets' }) as HTMLSelectElement)
        .value,
    ).toBe('volume');
  });

  it('exposes the next market page through a load-more control', () => {
    mocks.markets.data = { items: [], nextCursor: 'next-market-page' };
    render(<FeedScreen />);

    fireEvent.click(screen.getByRole('button', { name: 'Load more markets' }));

    expect(mocks.markets.loadMore).toHaveBeenCalledOnce();
  });

  it('does not offer Trending as a duplicate of Newest', () => {
    render(<FeedScreen />);

    const sort = screen.getByRole('combobox', { name: 'Sort markets' });
    expect(sort.textContent).not.toContain('Trending');
    expect((sort as HTMLSelectElement).value).toBe('newest');
  });
});
