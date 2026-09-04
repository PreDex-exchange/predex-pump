import type {
  AccountResponse,
  ActivityResponse,
  ListMarketsResponse,
  MakerOrdersResponse,
} from '@predex-pump/shared/rest';
import type {
  Market,
  OffchainOrder,
  Order,
  Position,
} from '@predex-pump/shared/domain';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TradePanel } from '../market/TradePanel';
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

const openMiniClobOrder: Order = {
  orderId: '24',
  marketId: market.id,
  conditionId: CONDITION,
  tokenId: market.noTokenId,
  outcome: 'NO',
  maker: ADDRESS,
  side: 'BID',
  priceRaw: '456000',
  sizeRaw: '2000000',
  filledRaw: '0',
  remainingRaw: '2000000',
  open: true,
  isSeed: false,
  createdAt: 1_900_004_200,
  updatedAt: 1_900_004_200,
};

const mocks = vi.hoisted(() => ({
  address: `0x${'12'.repeat(20)}` as const,
  accountRefetch: vi.fn(),
  account: null as AccountResponse | null,
  accountError: null as Error | null,
  accountLoading: false,
  authenticated: true,
  authError: null as Error | null,
  activity: { items: [], nextCursor: null } as ActivityResponse,
  activityError: null as Error | null,
  activityLoading: false,
  activityRefetch: vi.fn(),
  cancelOrder: vi.fn(),
  chainId: 5_042_002,
  ensureSession: vi.fn(),
  isConnected: true,
  isEstablishingSession: false,
  markets: { items: [], nextCursor: null } as ListMarketsResponse,
  marketsError: null as Error | null,
  marketsLoading: false,
  makerOrders: null as MakerOrdersResponse | null,
  ordersRefetch: vi.fn(),
  sessionAddress: `0x${'12'.repeat(20)}` as const,
  sessionLoading: false,
  txExecute: vi.fn(),
  txIsBusy: false,
  txReset: vi.fn(),
  useMyOrders: vi.fn(),
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: mocks.address,
    chainId: mocks.chainId,
    isConnected: mocks.isConnected,
  }),
  useConnect: () => ({
    connect: vi.fn(),
    connectors: [],
    error: null,
    isPending: false,
  }),
}));

vi.mock('@/lib/chain/useQuote', () => ({
  useQuote: () => ({
    quote: null,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/lib/chain/transactions', () => ({
  buyOnArc: vi.fn(),
  cancelOrderOnArc: mocks.cancelOrder,
  sellOnArc: vi.fn(),
}));

vi.mock('@/lib/chain/useTxFlow', () => ({
  useTxFlow: () => ({
    state: { phase: 'idle', message: 'Ready.' },
    execute: mocks.txExecute,
    reset: mocks.txReset,
    isBusy: mocks.txIsBusy,
  }),
}));

vi.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({
    session: mocks.authenticated
      ? {
          authenticated: true,
          address: mocks.sessionAddress,
          expiresAt: '2033-01-01T00:00:00.000Z',
        }
      : { authenticated: false },
    isLoading: mocks.sessionLoading,
    isEstablishingSession: mocks.isEstablishingSession,
    error: mocks.authError,
    ensureSession: mocks.ensureSession,
  }),
}));

vi.mock('@/lib/api/hooks', () => ({
  useAccount: () => ({
    data: mocks.account,
    isLoading: mocks.accountLoading,
    error: mocks.accountError,
    refetch: mocks.accountRefetch,
  }),
  useActivity: () => ({
    data: mocks.activity,
    isLoading: mocks.activityLoading,
    error: mocks.activityError,
    refetch: mocks.activityRefetch,
  }),
  useMarkets: () => ({
    data: mocks.markets,
    isLoading: mocks.marketsLoading,
    error: mocks.marketsError,
    refetch: vi.fn(),
  }),
  useMyOrders: (address: string | undefined, enabled: boolean) => {
    mocks.useMyOrders(address, enabled);
    return {
      data: mocks.makerOrders,
      isLoading: false,
      error: null,
      refetch: mocks.ordersRefetch,
    };
  },
}));

beforeEach(() => {
  mocks.accountRefetch.mockReset();
  mocks.accountError = null;
  mocks.accountLoading = false;
  mocks.authenticated = true;
  mocks.authError = null;
  mocks.activityError = null;
  mocks.activityLoading = false;
  mocks.activityRefetch.mockReset();
  mocks.cancelOrder.mockReset().mockResolvedValue({
    orderId: 24n,
    refundRaw: 912_000n,
  });
  mocks.chainId = 5_042_002;
  mocks.ensureSession.mockReset().mockResolvedValue(false);
  mocks.isConnected = true;
  mocks.isEstablishingSession = false;
  mocks.marketsError = null;
  mocks.marketsLoading = false;
  mocks.ordersRefetch.mockReset();
  mocks.sessionAddress = ADDRESS;
  mocks.sessionLoading = false;
  mocks.txExecute.mockReset().mockImplementation(
    async (
      operation: (report: (state: unknown) => void) => Promise<unknown>,
    ) => operation(vi.fn()),
  );
  mocks.txIsBusy = false;
  mocks.txReset.mockReset();
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
    onchainOrders: [openMiniClobOrder],
    offchainWithdrawalIsOnchainCancellation: false,
    warning: 'Withdrawal is not on-chain cancellation.',
  };
  mocks.useMyOrders.mockClear();
});

afterEach(cleanup);

describe('Portfolio open orders', () => {
  it('lists Hybrid and MiniCLOB maker orders even when the wallet holds no positions', () => {
    render(<PortfolioScreen />);

    expect(mocks.useMyOrders).toHaveBeenCalledWith(ADDRESS, true);
    const section = screen.getByRole('region', { name: 'Open orders' });
    expect(
      within(section).getByText(
        'Live maker orders from Hybrid and MiniCLOB are shown together.',
      ),
    ).toBeTruthy();
    expect(within(section).getAllByText(market.question)).toHaveLength(2);
    const hybridRow = within(section).getByText('HYBRID').closest('tr');
    expect(hybridRow).not.toBeNull();
    expect(within(hybridRow as HTMLElement).getByText('ASK')).toBeTruthy();
    expect(within(hybridRow as HTMLElement).getByText('YES')).toBeTruthy();
    expect(within(hybridRow as HTMLElement).getByText('0.544000')).toBeTruthy();
    expect(within(hybridRow as HTMLElement).getByText('1')).toBeTruthy();
    expect(within(hybridRow as HTMLElement).getByText('0.75')).toBeTruthy();
    expect(
      within(hybridRow as HTMLElement).getByText('Partially filled'),
    ).toBeTruthy();

    const miniClobRow = within(section).getByText('MINICLOB').closest('tr');
    expect(miniClobRow).not.toBeNull();
    expect(within(miniClobRow as HTMLElement).getByText('BID')).toBeTruthy();
    expect(within(miniClobRow as HTMLElement).getByText('NO')).toBeTruthy();
    expect(within(miniClobRow as HTMLElement).getByText('0.456000')).toBeTruthy();
    expect(within(miniClobRow as HTMLElement).getAllByText('2')).toHaveLength(2);
    expect(within(miniClobRow as HTMLElement).getByText('Open')).toBeTruthy();
    expect(
      within(miniClobRow as HTMLElement).getByRole('button', {
        name: 'Cancel & refund',
      }),
    ).toBeTruthy();
    expect(
      within(miniClobRow as HTMLElement).getByText('Escrow managed here'),
    ).toBeTruthy();
    expect(
      within(miniClobRow as HTMLElement).queryByRole('link', {
        name: /Manage on market/u,
      }),
    ).toBeNull();
    expect(screen.getByText('No open positions')).toBeTruthy();
  });

  it('does not claim there are no open orders when only MiniCLOB has one', () => {
    if (!mocks.makerOrders) throw new Error('maker order fixture missing');
    mocks.makerOrders = {
      ...mocks.makerOrders,
      orders: [],
      onchainOrders: [openMiniClobOrder],
    };

    render(<PortfolioScreen />);

    const section = screen.getByRole('region', { name: 'Open orders' });
    expect(within(section).getByText('MINICLOB')).toBeTruthy();
    expect(
      within(section).queryByText('No live open orders for this wallet.'),
    ).toBeNull();
  });

  it('states the difference between free withdrawal and authoritative cancellation', () => {
    render(<PortfolioScreen />);

    const section = screen.getByRole('region', { name: 'Open orders' });
    expect(within(section).getByText('Withdraw · free')).toBeTruthy();
    expect(within(section).getByText('Cancel on-chain · gas')).toBeTruthy();
    expect(section.textContent).toContain('removes an order from this operator’s book only');
    expect(section.textContent).toContain('invalidates the signature');
  });

  it('offers explicit SIWE for order management without prompting automatically', () => {
    mocks.authenticated = false;

    render(<PortfolioScreen />);

    expect(mocks.useMyOrders).toHaveBeenCalledWith(ADDRESS, false);
    expect(mocks.ensureSession).not.toHaveBeenCalled();
    const signIn = screen.getByRole('button', {
      name: 'Sign in to manage orders',
    });
    fireEvent.click(signIn);
    expect(mocks.ensureSession).toHaveBeenCalledOnce();
  });

  it('keeps order-management sign-in recoverable without exposing provider errors', () => {
    mocks.authenticated = false;
    mocks.authError = new Error('Sensitive provider rejection details');

    render(<PortfolioScreen />);

    expect(screen.getByRole('alert').textContent).toContain(
      'Sign-in was not completed',
    );
    expect(document.body.textContent).not.toContain(
      'Sensitive provider rejection details',
    );
    expect(
      screen.getByRole('button', { name: 'Sign in to manage orders' }),
    ).toBeTruthy();
  });

  it('cancels the exact MiniCLOB order, removes it optimistically, and refreshes account data', async () => {
    render(<PortfolioScreen />);
    const orders = screen.getByRole('table', {
      name: /Live Hybrid and MiniCLOB maker orders/u,
    });
    const miniClobRow = within(orders).getByText('MINICLOB').closest('tr');
    expect(miniClobRow).not.toBeNull();

    fireEvent.click(
      within(miniClobRow as HTMLElement).getByRole('button', {
        name: 'Cancel & refund',
      }),
    );
    const dialog = screen.getByRole('dialog', {
      name: 'Cancel MiniCLOB order #24',
    });
    expect(within(dialog).getByText(/re-read order #24 from Arc/u)).toBeTruthy();
    expect(
      [...dialog.querySelectorAll('p')].some((paragraph) =>
        paragraph.textContent?.includes('remaining USDC escrow'),
      ),
    ).toBe(true);

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Cancel & refund escrow' }),
    );

    await waitFor(() => expect(mocks.cancelOrder).toHaveBeenCalledOnce());
    expect(mocks.cancelOrder).toHaveBeenCalledWith({
      account: ADDRESS,
      orderId: 24n,
      report: expect.any(Function),
    });
    await waitFor(() =>
      expect(within(orders).queryByText('MINICLOB')).toBeNull(),
    );
    expect(mocks.ordersRefetch).toHaveBeenCalledOnce();
    expect(mocks.accountRefetch).toHaveBeenCalledOnce();
    expect(
      within(dialog).getByText(
        'MiniCLOB order #24 cancelled. 0.912000 USDC escrow was returned by the contract.',
      ),
    ).toBeTruthy();
  });

  it('disables MiniCLOB cancellation on the wrong network', () => {
    mocks.chainId = 1;

    render(<PortfolioScreen />);

    const miniClobRow = screen.getByText('MINICLOB').closest('tr');
    expect(miniClobRow).not.toBeNull();
    const action = within(miniClobRow as HTMLElement).getByRole('button', {
      name: 'Switch to Arc',
    });
    expect(action.hasAttribute('disabled')).toBe(true);
    fireEvent.click(action);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.cancelOrder).not.toHaveBeenCalled();
  });

  it('synchronously rejects a rapid duplicate cancellation click', async () => {
    let releaseCancel: (value: { orderId: bigint; refundRaw: bigint }) => void =
      () => {
        throw new Error('Cancellation promise was not created');
      };
    mocks.cancelOrder.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseCancel = resolve;
        }),
    );
    render(<PortfolioScreen />);
    const miniClobRow = screen.getByText('MINICLOB').closest('tr');
    expect(miniClobRow).not.toBeNull();
    fireEvent.click(
      within(miniClobRow as HTMLElement).getByRole('button', {
        name: 'Cancel & refund',
      }),
    );
    const dialog = screen.getByRole('dialog', {
      name: 'Cancel MiniCLOB order #24',
    });
    const confirm = within(dialog).getByRole('button', {
      name: 'Cancel & refund escrow',
    });

    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(mocks.cancelOrder).toHaveBeenCalledOnce();

    releaseCancel({ orderId: 24n, refundRaw: 912_000n });
    await waitFor(() => expect(mocks.ordersRefetch).toHaveBeenCalledOnce());
  });

  it('keeps every cancel control disabled while a cancellation is busy', () => {
    mocks.txIsBusy = true;

    render(<PortfolioScreen />);

    const miniClobRow = screen.getByText('MINICLOB').closest('tr');
    expect(miniClobRow).not.toBeNull();
    expect(
      within(miniClobRow as HTMLElement)
        .getByRole('button', { name: 'Cancel & refund' })
        .hasAttribute('disabled'),
    ).toBe(true);
  });

  it('keeps the order and confirmation recoverable when cancellation fails', async () => {
    mocks.cancelOrder.mockRejectedValueOnce(new Error('wallet unavailable'));
    mocks.txExecute.mockImplementationOnce(
      async (
        operation: (report: (state: unknown) => void) => Promise<unknown>,
      ) => {
        try {
          return await operation(vi.fn());
        } catch {
          return null;
        }
      },
    );
    render(<PortfolioScreen />);
    const orders = screen.getByRole('table', {
      name: /Live Hybrid and MiniCLOB maker orders/u,
    });
    const miniClobRow = within(orders).getByText('MINICLOB').closest('tr');
    expect(miniClobRow).not.toBeNull();
    fireEvent.click(
      within(miniClobRow as HTMLElement).getByRole('button', {
        name: 'Cancel & refund',
      }),
    );
    const dialog = screen.getByRole('dialog', {
      name: 'Cancel MiniCLOB order #24',
    });

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Cancel & refund escrow' }),
    );
    await waitFor(() => expect(mocks.cancelOrder).toHaveBeenCalledOnce());

    expect(within(orders).getByText('MINICLOB')).toBeTruthy();
    expect(
      screen.getByRole('dialog', { name: 'Cancel MiniCLOB order #24' }),
    ).toBeTruthy();
    expect(
      within(dialog)
        .getByRole('button', { name: 'Cancel & refund escrow' })
        .hasAttribute('disabled'),
    ).toBe(false);
    expect(mocks.ordersRefetch).not.toHaveBeenCalled();
    expect(mocks.accountRefetch).not.toHaveBeenCalled();
  });
});

describe('Portfolio money states', () => {
  it('renders an activity failure as an alert with retry, never as empty history', () => {
    mocks.activity = { items: [], nextCursor: null };
    mocks.activityError = new Error('activity unavailable');

    render(<PortfolioScreen />);

    expect(screen.getByRole('alert').textContent).toContain(
      'This is not an empty activity state',
    );
    expect(screen.queryByText('No account activity yet.')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Try activity again' }),
    );
    expect(mocks.activityRefetch).toHaveBeenCalledOnce();
  });

  it('shows only open holdings and derives summary PnL from the rows shown', () => {
    if (!mocks.account) throw new Error('account fixture missing');
    mocks.account = {
      ...mocks.account,
      pnl: { realizedRaw: '99000000', unrealizedRaw: '-240000' },
      positions: [
        {
          account: ADDRESS,
          marketId: '999',
          outcome: 'NO',
          qtyRaw: '0',
          costBasisRaw: '12340000',
          costBasisEstimated: true,
          realizedPnlRaw: '-10000000',
          unrealizedPnlRaw: '-2340000',
          updatedAt: 1_900_004_200,
        },
        {
          account: ADDRESS,
          marketId: market.id,
          outcome: 'YES',
          qtyRaw: '1000000',
          costBasisRaw: '500000',
          costBasisEstimated: true,
          realizedPnlRaw: '1250000',
          unrealizedPnlRaw: '500000',
          updatedAt: 1_900_004_300,
        },
      ],
    };

    const rendered = render(<PortfolioScreen />);

    const summaryPnl = screen.getByText('Open holdings PnL (est.)').parentElement;
    expect(summaryPnl).not.toBeNull();
    expect(summaryPnl?.textContent).toContain('+1.75 USDC');
    expect(summaryPnl?.textContent).toContain('Across positions shown below.');

    const table = screen.getByRole('table', {
      name: /Indexed outcome-token positions/u,
    });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(2);
    const activeRow = within(table).getByText(market.question).closest('tr');
    expect(activeRow).not.toBeNull();
    expect(
      (activeRow as HTMLElement).querySelector('[data-label="PnL (est.)"]')
        ?.textContent,
    ).toBe('+1.75 USDC');
    expect(within(table).queryByText('Market #999')).toBeNull();
    expect(rendered.container.textContent).not.toContain('−12.34 USDC');
    expect(rendered.container.textContent).not.toContain('+98.76 USDC');
  });

  it('shows no positions table when every indexed position has zero quantity', () => {
    if (!mocks.account) throw new Error('account fixture missing');
    mocks.account = {
      ...mocks.account,
      positions: [
        {
          account: ADDRESS,
          marketId: market.id,
          outcome: 'YES',
          qtyRaw: '0',
          costBasisRaw: '500000',
          costBasisEstimated: true,
          realizedPnlRaw: '-1000000',
          unrealizedPnlRaw: '-250000',
          updatedAt: 1_900_004_300,
        },
      ],
    };

    render(<PortfolioScreen />);

    expect(
      screen.queryByRole('table', {
        name: /Indexed outcome-token positions/u,
      }),
    ).toBeNull();
    expect(screen.getByText('No open positions')).toBeTruthy();
  });

  it('renders the same non-zero sub-raw-unit value on the portfolio and trade panel', () => {
    if (!mocks.account) throw new Error('account fixture missing');
    const tinyPosition: Position = {
      account: ADDRESS,
      marketId: market.id,
      outcome: 'YES',
      qtyRaw: '1',
      costBasisRaw: '1',
      costBasisEstimated: true,
      realizedPnlRaw: '0',
      unrealizedPnlRaw: '0',
      updatedAt: 1_900_004_300,
    };
    mocks.account = {
      ...mocks.account,
      positions: [tinyPosition],
    };

    const portfolio = render(<PortfolioScreen />);

    const table = screen.getByRole('table', {
      name: /Indexed outcome-token positions/u,
    });
    const row = within(table).getByText(market.question).closest('tr');
    expect(row).not.toBeNull();
    expect(
      (row as HTMLElement).querySelector('[data-label="Quantity"]')?.textContent,
    ).toBe('<0.01');
    const portfolioValue = (row as HTMLElement).querySelector(
      '[data-label="Current value"]',
    )?.textContent;
    expect(portfolioValue).toBe('<0.01 USDC');

    portfolio.unmount();
    render(<TradePanel market={market} positions={[tinyPosition]} />);

    const markedValue = screen.getByText('Marked value').parentElement;
    expect(markedValue).not.toBeNull();
    expect(markedValue?.querySelector('strong')?.textContent).toBe(
      portfolioValue,
    );
  });

  it('groups every positions-table money value and unit in one element', () => {
    if (!mocks.account) throw new Error('account fixture missing');
    mocks.account = {
      ...mocks.account,
      positions: [
        {
          account: ADDRESS,
          marketId: market.id,
          outcome: 'YES',
          qtyRaw: '1000000',
          costBasisRaw: '500000',
          costBasisEstimated: true,
          realizedPnlRaw: '0',
          unrealizedPnlRaw: '44000',
          updatedAt: 1_900_004_300,
        },
      ],
    };

    render(<PortfolioScreen />);

    const table = screen.getByRole('table', {
      name: /Indexed outcome-token positions/u,
    });
    const row = within(table).getByText(market.question).closest('tr');
    expect(row).not.toBeNull();

    for (const label of ['Avg. cost', 'Current value', 'PnL (est.)']) {
      const cell = (row as HTMLElement).querySelector(
        `[data-label="${label}"]`,
      );
      expect(cell).not.toBeNull();
      expect(cell?.children).toHaveLength(1);
      expect(cell?.firstElementChild?.tagName).toBe('SPAN');
      expect(
        cell?.firstElementChild?.querySelector(':scope > small')?.textContent,
      ).toBe('USDC');
      expect(
        [...(cell?.childNodes ?? [])].filter(
          (node) => node.nodeType === 3 && node.textContent?.trim(),
        ),
      ).toEqual([]);
    }
  });

  it.each([
    {
      expectedTitle: 'Counting your positions…',
      prepare: () => {
        mocks.accountLoading = true;
      },
      state: 'loading',
    },
    {
      expectedTitle: 'This portfolio would not open',
      prepare: () => {
        mocks.accountError = new Error('account unavailable');
      },
      state: 'error',
    },
    {
      expectedTitle: 'No open positions',
      prepare: () => {},
      state: 'empty',
    },
  ])('renders the $state state without character art', ({ expectedTitle, prepare, state }) => {
    prepare();

    const rendered = render(<PortfolioScreen />);

    expect(screen.getByText(expectedTitle)).toBeTruthy();
    expect(rendered.container.querySelector('svg')).toBeNull();
    if (state === 'error') expect(screen.getByRole('alert')).toBeTruthy();
    if (state === 'loading') expect(screen.getByRole('status')).toBeTruthy();
  });
});
