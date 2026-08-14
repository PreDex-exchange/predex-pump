import type { MarketDetailResponse } from '@predex-pump/shared/rest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MarketScreen } from './MarketScreen';
import { internalIdentifiersInRenderedOutput } from './user-facing-copy.test-utils';

const mocks = vi.hoisted(() => ({
  market: {
    data: null as MarketDetailResponse | null,
    error: null as Error | null,
    isNotFound: true,
    isLoading: false,
    refetch: vi.fn(),
  },
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

vi.mock('@/lib/api/hooks', () => ({
  useAccount: () => ({ data: null }),
  useAccountProfile: () => ({ data: null, error: null, isLoading: false }),
  useMarket: () => mocks.market,
  useOrderBook: () => ({
    data: null,
    error: null,
    isLoading: false,
    refetch: vi.fn(),
  }),
  usePriceHistory: () => ({ data: { points: [] } }),
}));

function renderScreen() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MarketScreen marketId="17" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.market.data = null;
  mocks.market.error = null;
  mocks.market.isNotFound = true;
  mocks.market.isLoading = false;
  mocks.market.refetch.mockReset();
});

afterEach(cleanup);

describe('MarketScreen money states', () => {
  it.each([
    {
      expectedTitle: 'Checking this egg…',
      prepare: () => {
        mocks.market.isLoading = true;
      },
      state: 'loading',
    },
    {
      expectedTitle: 'This market would not open',
      prepare: () => {
        mocks.market.error = new Error('market unavailable');
      },
      state: 'error',
    },
    {
      expectedTitle: 'No egg with that number',
      prepare: () => {},
      state: 'empty',
    },
  ])('renders the $state state without character art', ({ expectedTitle, prepare }) => {
    prepare();

    const rendered = renderScreen();

    expect(screen.getByText(expectedTitle)).toBeTruthy();
    expect(rendered.container.querySelector('svg')).toBeNull();
    expect(internalIdentifiersInRenderedOutput(rendered.container)).toEqual([]);
  });

  it('offers in-place retry and return-to-feed actions when market detail fails', () => {
    mocks.market.error = new Error('market unavailable');

    renderScreen();

    const alert = screen.getByRole('alert');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(mocks.market.refetch).toHaveBeenCalledOnce();
    expect(
      within(alert).getByRole('link', { name: 'Return to feed' }).getAttribute('href'),
    ).toBe('/');
  });
});
