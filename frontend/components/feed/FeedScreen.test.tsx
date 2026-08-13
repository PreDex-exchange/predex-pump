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
}));

vi.mock('@/lib/api/hooks', () => ({
  useActivity: () => mocks.activity,
  useMarkets: () => mocks.markets,
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
  mocks.markets.loadMore.mockClear();
});

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});

describe('FeedScreen failure states', () => {
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
    expect(marketSurface.querySelector('svg')).toBeNull();
  });

  it('renders an activity error instead of the empty state when activity fails', () => {
    mocks.activity.data = null as never;
    mocks.activity.error = new Error('activity unavailable');

    render(<FeedScreen />);

    expect(
      screen.getByRole('alert').textContent,
    ).toContain('The indexed history is unavailable');
    expect(screen.queryByText('Waiting for on-chain activity…')).toBeNull();
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
