import type {
  AccountResponse,
  ActivityResponse,
  ListMarketsResponse,
  MakerOrdersResponse,
} from '@predex-pump/shared/rest';
import type { Market, OffchainOrder } from '@predex-pump/shared/domain';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PortfolioScreen } from './PortfolioScreen';

const ADDRESS = `0x${'12'.repeat(20)}` as const;
const CONDITION = `0x${'34'.repeat(32)}` as const;

const market: Market = {
  id: '7',
  creator: `0x${'56'.repeat(20)}`,
  question: 'Will the portfolio show this live maker order?',
  phase: 'Graduated',
  conditionId: CONDITION,
  questionId: `0x${'78'.repeat(32)}`,
  yesTokenId: '701',
  noTokenId: '702',
  seedRaw: '1000000',
  yesPriceRaw: '544000',
  noPriceRaw: '456000',
  graduationActivityRaw: '25000000',
  bookAddress: `0x${'90'.repeat(20)}`,
  frozenYesPriceRaw: '544000',
  handoffSizeRaw: '5000000',
  tradeCount: 0,
  volumeRaw: '0',
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
  createdAt: 1_900_000_000,
  tradingEndsAt: 2_000_000_000,
  graduatedAt: 1_900_003_600,
  resolvedAt: null,
};

const openOrder: OffchainOrder = {
  orderHash: `0x${'ab'.repeat(32)}`,
  marketId: market.id,
  conditionId: CONDITION,
  tokenId: market.yesTokenId,
  outcome: 'YES',
  maker: ADDRESS,
  side: 'ASK',
  priceRaw: '544000',
  sizeRaw: '1000000',
  filledRaw: '250000',
  remainingRaw: '750000',
  status: 'PARTIALLY_FILLED',
  fillable: true,
  unfillableReason: null,
  signedOrder: {
    saltRaw: '1',
    maker: ADDRESS,
    signer: ADDRESS,
    taker: `0x${'00'.repeat(20)}`,
    tokenId: market.yesTokenId,
    makerAmountRaw: '1000000',
    takerAmountRaw: '544000',
    expiration: 2_000_000_000,
    nonceRaw: '0',
    feeRateBpsRaw: '0',
    side: 1,
    signatureType: 0,
    signature: '0x1234',
  },
  createdAt: 1_900_004_000,
  updatedAt: 1_900_004_100,
};

const mocks = vi.hoisted(() => ({
  address: `0x${'12'.repeat(20)}` as const,
  account: null as AccountResponse | null,
  activity: { items: [], nextCursor: null } as ActivityResponse,
  markets: { items: [], nextCursor: null } as ListMarketsResponse,
  makerOrders: null as MakerOrdersResponse | null,
  useMyOrders: vi.fn(),
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: mocks.address,
    chainId: 5_042_002,
    isConnected: true,
  }),
  useConnect: () => ({
    connect: vi.fn(),
    connectors: [],
    error: null,
    isPending: false,
  }),
}));

vi.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({
    session: {
      authenticated: true,
      address: mocks.address,
      expiresAt: '2033-01-01T00:00:00.000Z',
    },
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
  useActivity: () => ({
    data: mocks.activity,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useMarkets: () => ({
    data: mocks.markets,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useMyOrders: (address: string | undefined, enabled: boolean) => {
    mocks.useMyOrders(address, enabled);
    return {
      data: mocks.makerOrders,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
  },
}));

beforeEach(() => {
  mocks.account = {
    account: {
      address: ADDRESS,
      firstSeenAt: 1_900_000_000,
      marketsCreated: 0,
      tradeCount: 0,
    },
    positions: [],
    recentTrades: [],
    pnl: { realizedRaw: '0', unrealizedRaw: '0' },
  };
  mocks.activity = { items: [], nextCursor: null };
  mocks.markets = { items: [market], nextCursor: null };
  mocks.makerOrders = {
    orders: [openOrder],
    offchainWithdrawalIsOnchainCancellation: false,
    warning: 'Withdrawal is not on-chain cancellation.',
  };
  mocks.useMyOrders.mockClear();
});

afterEach(cleanup);

describe('Portfolio open orders', () => {
  it('lists the authenticated wallet order even when it holds no positions', () => {
    render(<PortfolioScreen />);

    expect(mocks.useMyOrders).toHaveBeenCalledWith(ADDRESS, true);
    const section = screen.getByRole('region', { name: 'Open orders' });
    expect(
      within(section).getByText('Live signed orders are separate from historical placement events.'),
    ).toBeTruthy();
    const row = within(section).getByText(market.question).closest('tr');
    expect(row).not.toBeNull();
    const orderRow = within(row as HTMLElement);
    expect(orderRow.getByText('HYBRID')).toBeTruthy();
    expect(orderRow.getByText('ASK')).toBeTruthy();
    expect(orderRow.getByText('YES')).toBeTruthy();
    expect(orderRow.getByText('0.544000')).toBeTruthy();
    expect(orderRow.getByText('1')).toBeTruthy();
    expect(orderRow.getByText('0.75')).toBeTruthy();
    expect(orderRow.getByText('Partially filled')).toBeTruthy();
    expect(orderRow.getByRole('link', { name: /Manage on market/u })).toBeTruthy();
    expect(screen.getByText('No positions yet')).toBeTruthy();
  });

  it('states the difference between free withdrawal and authoritative cancellation', () => {
    render(<PortfolioScreen />);

    const section = screen.getByRole('region', { name: 'Open orders' });
    expect(within(section).getByText('Withdraw · free')).toBeTruthy();
    expect(within(section).getByText('Cancel on-chain · gas')).toBeTruthy();
    expect(section.textContent).toContain('removes an order from this operator’s book only');
    expect(section.textContent).toContain('invalidates the signature');
  });
});
