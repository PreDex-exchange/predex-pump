import type { ActivityEvent, Market } from '@predex-pump/shared/domain';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FeedScreen } from './FeedScreen';

const mocks = vi.hoisted(() => ({
  activity: {
    data: { items: [] as ActivityEvent[], nextCursor: null as string | null },
    error: null as Error | null,
    isLoading: false,
    refetch: vi.fn(),
  },
  markets: {
    data: { items: [] as Market[], nextCursor: null as string | null },
    error: null as Error | null,
    isLoading: false,
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
  mocks.markets.data = { items: [], nextCursor: null };
  mocks.markets.error = null;
  mocks.markets.isLoading = false;
});

afterEach(cleanup);

describe('FeedScreen failure states', () => {
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
});
