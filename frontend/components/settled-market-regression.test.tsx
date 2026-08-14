import type {
  AccountResponse,
  ActivityResponse,
  ListMarketsResponse,
  MarketDetailResponse,
} from '@predex-pump/shared/rest';
import type { Market, Resolution } from '@predex-pump/shared/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FeedScreen } from './feed/FeedScreen';
import { MarketCard } from './feed/MarketCard';
import { MarketScreen } from './market/MarketScreen';
import { PriceOverview } from './market/PriceOverview';
import { PortfolioScreen } from './portfolio/PortfolioScreen';

const mocks = vi.hoisted(() => ({
  account: null as AccountResponse | null,
  activity: { items: [], nextCursor: null } as ActivityResponse,
  connected: true,
  marketDetail: null as MarketDetailResponse | null,
  markets: { items: [], nextCursor: null } as ListMarketsResponse,
}));

vi.mock('wagmi', async (importOriginal) => {
  const original = await importOriginal<typeof import('wagmi')>();
  return {
    ...original,
    useAccount: () => ({
      address: mocks.connected
        ? (`0x${'c'.repeat(40)}` as const)
        : undefined,
      chainId: 5_042_002,
      isConnected: mocks.connected,
    }),
    useConnect: () => ({
      connect: vi.fn(),
      connectors: [],
      error: null,
      isPending: false,
    }),
  };
});

vi.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({
    session: { authenticated: false },
    isLoading: false,
    isSigningIn: false,
    signIn: vi.fn(),
  }),
}));

vi.mock('@/lib/api/hooks', () => ({
  useAccount: () => ({
    data: mocks.account,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useAccountProfile: () => ({
    data: null,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useActivity: () => ({
    data: mocks.activity,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useMarket: () => ({
    data: mocks.marketDetail,
    isLoading: false,
    error: null,
    isNotFound: mocks.marketDetail === null,
    refetch: vi.fn(),
  }),
  useMarkets: () => ({
    data: mocks.markets,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useMyOrders: () => ({
    data: null,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useOrderBook: () => ({
    data: null,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  usePriceHistory: () => ({
    data: { marketId: '2', points: [] },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/components/market/SettlementPanel', () => ({
  SettlementPanel: () => <aside>Redeem controls available</aside>,
}));

const resolution: Resolution = {
  marketId: '2',
  conditionId: `0x${'2'.repeat(64)}`,
  outcome: 'YES',
  payoutYes: 1,
  payoutNo: 0,
  denominator: 1,
  resolvedAt: 1_784_918_616,
  observedAt: null,
};

function market(overrides: Partial<Market> = {}): Market {
  return {
    id: '2',
    creator: `0x${'a'.repeat(40)}`,
    question: 'Did the resolved market settle YES?',
    phase: 'Graduated',
    conditionId: resolution.conditionId,
    questionId: `0x${'3'.repeat(64)}`,
    yesTokenId: '201',
    noTokenId: '202',
    seedRaw: '1000000',
    yesPriceRaw: '520000',
    noPriceRaw: '480000',
    graduationActivityRaw: '25000000',
    bookAddress: `0x${'b'.repeat(40)}`,
    frozenYesPriceRaw: '520000',
    handoffSizeRaw: '5000000',
    tradeCount: 1,
    volumeRaw: '50000',
    params: {
      seedFloorRaw: '1000000',
      seedCapRaw: '50000000',
      fCapRaw: '100000000',
      graduationMoneyInThresholdRaw: '25000000',
      graduationTollRaw: '2000000',
      inventoryTargetRaw: '5000000',
      protocolFeeBps: 100,
      depthFeeBps: 50,
      tradingWindowSeconds: 86400,
      minimumTimeOpenSeconds: 3600,
      minimumTickSizeRaw: '1000',
    },
    createdAt: 1_784_800_000,
    tradingEndsAt: 1_784_886_400,
    graduatedAt: 1_784_803_600,
    resolvedAt: resolution.resolvedAt,
    resolution,
    ...overrides,
  };
}

const resolvedMarket = market();
const liveMarket = market({
  id: '1',
  question: 'Is this graduated market still live?',
  resolvedAt: null,
  resolution: null,
});

function renderWithQuery(element: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
  return render(element, { wrapper });
}

beforeEach(() => {
  mocks.connected = true;
  mocks.marketDetail = {
    market: resolvedMarket,
    recentTrades: [],
    resolution,
    settlementEvents: {
      protocolSweepCompleted: false,
      protocolSweptRaw: '0',
    },
  };
  mocks.markets = { items: [resolvedMarket, liveMarket], nextCursor: null };
  mocks.account = {
    account: {
      address: `0x${'c'.repeat(40)}`,
      firstSeenAt: 1_784_800_000,
      marketsCreated: 0,
      tradeCount: 1,
    },
    positions: [
      {
        account: `0x${'c'.repeat(40)}`,
        marketId: '2',
        outcome: 'YES',
        qtyRaw: '1000000',
        costBasisRaw: '50000',
        costBasisEstimated: true,
        realizedPnlRaw: '0',
        unrealizedPnlRaw: '950000',
        updatedAt: resolution.resolvedAt,
      },
    ],
    recentTrades: [],
    pnl: { realizedRaw: '0', unrealizedRaw: '950000' },
  };
});

afterEach(cleanup);

describe('Graduated snapshots with final payout data', () => {
  it.each([
    {
      surface: 'market detail',
      renderSurface: () => renderWithQuery(<MarketScreen marketId="2" />),
      assertSettled: () => {
        expect(screen.getByText('Final outcome')).toBeTruthy();
        expect(screen.getByText('Redeem controls available')).toBeTruthy();
        expect(screen.queryByText('Place order')).toBeNull();
        expect(screen.queryByText('Hybrid exchange order book')).toBeNull();
        expect(screen.queryByText(/live marginal/u)).toBeNull();
      },
    },
    {
      surface: 'settled price overview',
      renderSurface: () =>
        renderWithQuery(
          <PriceOverview
            market={resolvedMarket}
            points={[]}
            resolution={resolution}
          />,
        ),
      assertSettled: () => {
        expect(screen.queryByText(/live marginal/u)).toBeNull();
        expect(screen.getByText(/100% payout · final/u)).toBeTruthy();
        expect(screen.getByText(/^0% payout · final$/u)).toBeTruthy();
      },
    },
    {
      surface: 'market card',
      renderSurface: () => renderWithQuery(<MarketCard market={resolvedMarket} />),
      assertSettled: () => {
        expect(screen.getByText('Resolved · YES')).toBeTruthy();
        expect(screen.queryByText('Order book live')).toBeNull();
        expect(screen.getAllByText('1.00').length).toBeGreaterThan(0);
      },
    },
    {
      surface: 'resolved feed filter',
      renderSurface: () => {
        const rendered = renderWithQuery(<FeedScreen />);
        fireEvent.click(screen.getByRole('button', { name: 'Resolved' }));
        return rendered;
      },
      assertSettled: () => {
        expect(screen.getByText(resolvedMarket.question)).toBeTruthy();
        expect(screen.queryByText(liveMarket.question)).toBeNull();
      },
    },
    {
      surface: 'portfolio',
      renderSurface: () => renderWithQuery(<PortfolioScreen />),
      assertSettled: () => {
        const summary = screen.getByText('Total position value').parentElement;
        expect(summary).not.toBeNull();
        expect(within(summary as HTMLElement).getByText('1.00')).toBeTruthy();
        expect(screen.getByRole('link', { name: 'Redeem on market' })).toBeTruthy();
        expect(screen.getAllByText(/Resolved/u).length).toBeGreaterThan(0);
        const row = screen.getByText(resolvedMarket.question).closest('tr');
        expect(row).not.toBeNull();
        const currentValue = (row as HTMLElement).querySelector(
          '[data-label="Current value"]',
        );
        expect(currentValue).not.toBeNull();
        expect(
          within(currentValue as HTMLElement).getByText('1.00'),
        ).toBeTruthy();
        expect(within(currentValue as HTMLElement).queryByText('0.52')).toBeNull();
      },
    },
  ])('renders $surface as settled', ({ renderSurface, assertSettled }) => {
    renderSurface();
    assertSettled();
  });

  it('keeps the mascot off the disconnected portfolio money state', () => {
    mocks.connected = false;
    const rendered = renderWithQuery(<PortfolioScreen />);

    expect(screen.getByText('Connect to open your portfolio')).toBeTruthy();
    expect(rendered.container.querySelector('svg')).toBeNull();
  });

  it('keeps the mascot off a market-detail money state', () => {
    mocks.marketDetail = null;
    const rendered = renderWithQuery(<MarketScreen marketId="404" />);

    expect(screen.getByText('No egg with that number')).toBeTruthy();
    expect(rendered.container.querySelector('svg')).toBeNull();
  });
});

describe('PriceOverview live-state and history truthfulness', () => {
  it('labels a graduated frozen price without calling it live marginal', () => {
    render(<PriceOverview market={liveMarket} points={[]} />);

    expect(screen.getAllByText(/implied · frozen at graduation/u)).toHaveLength(2);
    expect(screen.queryByText(/live marginal/u)).toBeNull();
  });

  it('keeps live marginal copy for a market that is still on the LMSR curve', () => {
    render(
      <PriceOverview
        market={market({
          phase: 'Opened',
          graduatedAt: null,
          frozenYesPriceRaw: null,
          resolvedAt: null,
          resolution: null,
        })}
        points={[]}
      />,
    );

    expect(screen.getAllByText(/implied · live marginal/u)).toHaveLength(2);
  });

  it.each([
    ['zero', []],
    [
      'one',
      [{ ts: 1_900_000_000, yesPriceRaw: '543000', noPriceRaw: '457000' }],
    ],
  ])('renders a no-history state for %s indexed price points', (_label, points) => {
    const rendered = render(<PriceOverview market={liveMarket} points={points} />);

    expect(screen.getByText('No price history yet')).toBeTruthy();
    expect(rendered.container.querySelector('path')).toBeNull();
  });
});
