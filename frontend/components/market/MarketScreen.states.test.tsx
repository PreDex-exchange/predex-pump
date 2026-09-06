import type {
  MarketBookResponse,
  MarketDetailResponse,
} from '@predex-pump/shared/rest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
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
  book: {
    data: null as MarketBookResponse | null,
    error: null as Error | null,
    isLoading: false,
    refetch: vi.fn(),
  },
}));

vi.mock('wagmi', async (importOriginal) => {
  const original = await importOriginal<typeof import('wagmi')>();
  return {
    ...original,
    useAccount: () => ({
      address: `0x${'12'.repeat(20)}`,
      chainId: 5_042_002,
      isConnected: true,
    }),
  };
});

vi.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({
    session: { authenticated: false },
    isEstablishingSession: false,
    ensureSession: vi.fn().mockResolvedValue(false),
  }),
}));

vi.mock('@/lib/api/hooks', () => ({
  useAccount: () => ({ data: null }),
  useAccountProfile: () => ({ data: null, error: null, isLoading: false }),
  useMarket: () => mocks.market,
  useOrderBook: () => mocks.book,
  usePriceHistory: () => ({ data: { points: [] } }),
}));

vi.mock('@/lib/chain/useGraduationStatus', () => ({
  useGraduationStatus: () => ({
    data: {
      qualified: true,
      activityMoneyInRaw: '0',
      activityThresholdRaw: '0',
      openedAt: 1_900_000_000,
      minimumTimeOpen: 0,
      earliestGraduationAt: 1_900_000_000,
    },
    error: null,
    isLoading: false,
    isRefreshing: false,
    refetch: vi.fn(),
  }),
}));

vi.mock('./SettlementPanel', () => ({
  SettlementPanel: () => <section>Settlement controls</section>,
}));

vi.mock('./TradePanel', () => ({
  TradePanel: () => <button type="button">Buy YES</button>,
}));

vi.mock('./OrderBookPanel', () => ({
  OrderBookPanel: ({ books }: { books: MarketBookResponse }) => (
    <section
      aria-label="Historical Hybrid order book"
      data-trading-open={String(books.tradingOpen)}
    >
      Historical Hybrid order book
    </section>
  ),
}));

const TRADING_ENDS_AT = 1_900_003_600;

function closedHybridBook(): MarketBookResponse {
  const outcomeBook = (outcome: 'YES' | 'NO') => ({
    marketId: '17',
    minimumTickSizeRaw: '1000',
    outcome,
    tokenId: outcome === 'YES' ? '1701' : '1702',
    bids: [],
    asks: [],
    bestBidRaw: null,
    bestAskRaw: null,
    orders: [],
    offchainOrders: [],
  });
  return {
    marketId: '17',
    tradingOpen: false,
    liveVenue: 'HYBRID',
    orderBookAvailable: true,
    minimumTickSizeRaw: '1000',
    minimumTickSizeAppliesTo: 'NEW_ORDERS',
    yes: outcomeBook('YES'),
    no: outcomeBook('NO'),
  };
}

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
  mocks.book.data = null;
  mocks.book.error = null;
  mocks.book.isLoading = false;
  mocks.book.refetch.mockReset();
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

  it('keeps post-deadline lifecycle actions without reopening trading', async () => {
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValue((TRADING_ENDS_AT + 60) * 1_000);
    mocks.market.data = {
      market: {
        id: '17',
        creator: `0x${'12'.repeat(20)}`,
        question: 'Will an expired Bootstrap market remain gradable?',
        phase: 'Opened',
        conditionId: `0x${'34'.repeat(32)}`,
        questionId: `0x${'56'.repeat(32)}`,
        yesTokenId: '1701',
        noTokenId: '1702',
        seedRaw: '1000000',
        yesPriceRaw: '500000',
        noPriceRaw: '500000',
        graduationActivityRaw: '0',
        bookAddress: null,
        frozenYesPriceRaw: null,
        handoffSizeRaw: null,
        tradeCount: 0,
        volumeRaw: '0',
        params: {
          seedFloorRaw: '1000000',
          seedCapRaw: '5000000',
          fCapRaw: '10000000',
          graduationMoneyInThresholdRaw: '0',
          graduationTollRaw: '100000',
          inventoryTargetRaw: '20000000',
          protocolFeeBps: 20,
          depthFeeBps: 0,
          tradingWindowSeconds: 3600,
          minimumTimeOpenSeconds: 0,
          minimumTickSizeRaw: '1000',
        },
        createdAt: 1_900_000_000,
        tradingEndsAt: TRADING_ENDS_AT,
        graduatedAt: null,
        resolvedAt: null,
      },
      recentTrades: [],
      resolution: null,
      settlementEvents: {
        protocolSweepCompleted: false,
        protocolSweptRaw: '0',
      },
    };
    const openedDetail = mocks.market.data;
    mocks.market.isNotFound = false;

    renderScreen();
    await act(
      () => new Promise((resolve) => window.setTimeout(resolve, 0)),
    );

    expect(
      screen.getByRole('button', { name: 'Graduate market' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Buy YES' })).toBeNull();

    mocks.market.data = {
      ...openedDetail,
      market: {
        ...openedDetail.market,
        question: 'Will an expired Hybrid market remain manageable?',
        phase: 'Graduated',
        bookAddress: `0x${'78'.repeat(20)}`,
        frozenYesPriceRaw: '500000',
        handoffSizeRaw: '20000000',
        graduatedAt: TRADING_ENDS_AT - 100,
      },
    };
    mocks.book.data = closedHybridBook();
    cleanup();

    renderScreen();

    const historicalBook = screen.getByRole('region', {
      name: 'Historical Hybrid order book',
    });
    expect(historicalBook.getAttribute('data-trading-open')).toBe('false');
    expect(screen.getByText('Settlement controls')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Buy YES' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Graduate market' }),
    ).toBeNull();
    clock.mockRestore();
  });
});
