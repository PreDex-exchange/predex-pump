import type {
  Market,
  OffchainOrder,
  Order,
  Position,
} from '@predex-pump/shared/domain';
import type {
  ExchangeApprovalStateResponse,
  MarketBookResponse,
  MakerOrdersResponse,
  WithdrawOrderResponse,
} from '@predex-pump/shared/rest';
import {
  buildCtfExchangeOrder,
  ctfExchangeOrderToWire,
  Side,
} from '@predex-pump/shared/tx';
import {
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HybridOrderBookPanel } from './HybridOrderBookPanel';
import { OrderBookPanel } from './OrderBookPanel';

const mocks = vi.hoisted(() => ({
  address: `0x${'12'.repeat(20)}` as const,
  authenticated: true,
  approvals: {
    data: {
      owner: `0x${'12'.repeat(20)}` as const,
      ctfApprovedForAll: true,
      collateralAllowanceRaw: '1000000',
      ctfUpdatedAt: 1_900_000_000,
      collateralUpdatedAt: 1_900_000_000,
    },
    isLoading: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
  myOrders: {
    data: {
      orders: [] as OffchainOrder[],
      onchainOrders: [] as Order[],
      offchainWithdrawalIsOnchainCancellation: false as const,
      warning: 'Withdrawal is not cancellation.',
    },
    isLoading: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
  collateralBalance: {
    data: 5_000_000n as bigint | undefined,
    isLoading: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
  approveCollateral: vi.fn(),
  approveTokens: vi.fn(),
  signOrder: vi.fn(),
  fillOrder: vi.fn(),
  miniFillOrder: vi.fn(),
  submitCancel: vi.fn(),
  postOrder: vi.fn(),
  withdrawOrder: vi.fn(),
  approvalReset: vi.fn(),
  actionReset: vi.fn(),
  txHookCall: 0,
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: mocks.address,
    chainId: 5_042_002,
    isConnected: true,
  }),
  useReadContract: () => mocks.collateralBalance,
}));

vi.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({
    session: mocks.authenticated
      ? {
          authenticated: true,
          address: mocks.address,
          expiresAt: '2033-01-01T00:00:00.000Z',
        }
      : { authenticated: false },
    isLoading: false,
  }),
}));

vi.mock('@/lib/api/hooks', () => ({
  useExchangeApprovals: () => mocks.approvals,
  useMyOrders: () => mocks.myOrders,
}));

vi.mock('@/lib/api/rest-client', () => ({
  backendRestClient: {
    postOrder: mocks.postOrder,
    withdrawOrder: mocks.withdrawOrder,
  },
}));

vi.mock('@/lib/chain/transactions', async () => {
  const shared = await import('@predex-pump/shared/tx');
  return {
    approveCtfExchangeCollateralOnArc: mocks.approveCollateral,
    approveCtfExchangeTokensOnArc: mocks.approveTokens,
    signCtfExchangeOrderOnArc: mocks.signOrder,
    fillCtfExchangeOrderOnArc: mocks.fillOrder,
    submitPreparedCtfExchangeCancelOnArc: mocks.submitCancel,
    cumulativeMiniClobPaymentRaw: shared.cumulativeMiniClobPaymentRaw,
    miniClobFillPaymentRaw: shared.miniClobFillPaymentRaw,
    placeOrderOnArc: vi.fn(),
    fillOrderOnArc: mocks.miniFillOrder,
    cancelOrderOnArc: vi.fn(),
  };
});

vi.mock('@/lib/chain/useSettlementStatus', () => ({
  useSettlementStatus: () => ({
    data: { payoutDenominator: 0n },
    isLoading: false,
    error: null,
  }),
}));

vi.mock('@/lib/chain/useTxFlow', () => ({
  useTxFlow: () => {
    const isApprovalFlow = mocks.txHookCall % 2 === 0;
    mocks.txHookCall += 1;
    return {
      state: { phase: 'idle', message: 'Ready.' },
      execute: async <T,>(
        operation: (report: (state: unknown) => void) => Promise<T>,
      ) => operation(vi.fn()),
      reset: isApprovalFlow ? mocks.approvalReset : mocks.actionReset,
      isBusy: false,
    };
  },
}));

const OTHER_MAKER = `0x${'34'.repeat(20)}` as const;
const CONDITION = `0x${'56'.repeat(32)}` as const;
const CANCEL_TX = {
  to: `0x${'78'.repeat(20)}` as const,
  data: `0x${'90'.repeat(32)}` as const,
  valueRaw: '0',
};

const market: Market = {
  id: '1',
  creator: `0x${'aa'.repeat(20)}`,
  question: 'Will the Hybrid venue stay unambiguous?',
  phase: 'Graduated',
  conditionId: CONDITION,
  questionId: `0x${'bb'.repeat(32)}`,
  yesTokenId: '101',
  noTokenId: '102',
  seedRaw: '1000000',
  yesPriceRaw: '600000',
  noPriceRaw: '400000',
  graduationActivityRaw: '25000000',
  bookAddress: `0x${'cc'.repeat(20)}`,
  frozenYesPriceRaw: '600000',
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

function offchainOrder(
  maker: `0x${string}`,
  hashByte: string,
  status: OffchainOrder['status'] = 'OPEN',
  expiration = 2_000_000_000n,
): OffchainOrder {
  const signed = buildCtfExchangeOrder({
    maker,
    tokenId: 101n,
    side: Side.SELL,
    priceRaw: 650_000n,
    sizeRaw: 1_000_000n,
    salt: BigInt(`0x${hashByte.repeat(4)}`),
    expiration,
  });
  return {
    orderHash: `0x${hashByte.repeat(32)}`,
    marketId: '1',
    conditionId: CONDITION,
    tokenId: '101',
    outcome: 'YES',
    maker,
    side: 'ASK',
    priceRaw: '650000',
    sizeRaw: '1000000',
    filledRaw: '0',
    remainingRaw: '1000000',
    status,
    fillable: status === 'OPEN',
    unfillableReason: status === 'OPEN' ? null : 'WITHDRAWN',
    signedOrder: {
      ...ctfExchangeOrderToWire(signed),
      signature: '0x1234',
    },
    createdAt: 1_900_000_000,
    updatedAt: 1_900_000_000,
  };
}

const miniOnlyOrder: Order = {
  orderId: '99',
  marketId: '1',
  conditionId: CONDITION,
  tokenId: '101',
  outcome: 'YES',
  maker: OTHER_MAKER,
  side: 'ASK',
  priceRaw: '910000',
  sizeRaw: '1000000',
  filledRaw: '0',
  remainingRaw: '1000000',
  open: true,
  isSeed: false,
  createdAt: 1_900_000_000,
  updatedAt: 1_900_000_000,
};

function books(order: OffchainOrder): MarketBookResponse {
  return {
    marketId: '1',
    liveVenue: 'HYBRID',
    orderBookAvailable: true,
    minimumTickSizeRaw: '1000',
    minimumTickSizeAppliesTo: 'NEW_ORDERS',
    yes: {
      marketId: '1',
      minimumTickSizeRaw: '1000',
      outcome: 'YES',
      tokenId: '101',
      bids: [],
      asks: [],
      bestBidRaw: null,
      bestAskRaw: null,
      orders: [miniOnlyOrder],
      offchainOrders: [order],
    },
    no: {
      marketId: '1',
      minimumTickSizeRaw: '1000',
      outcome: 'NO',
      tokenId: '102',
      bids: [],
      asks: [],
      bestBidRaw: null,
      bestAskRaw: null,
      orders: [],
      offchainOrders: [],
    },
  };
}

function renderPanel(
  bookResponse: MarketBookResponse,
  marketSnapshot: Market = market,
  positions: Position[] = [],
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
  return render(
    <HybridOrderBookPanel
      books={bookResponse}
      market={marketSnapshot}
      positions={positions}
    />,
    { wrapper },
  );
}

function renderLivePanel(
  bookResponse: MarketBookResponse,
  positions: Position[] = [],
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <OrderBookPanel books={bookResponse} market={market} positions={positions} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.authenticated = true;
  mocks.approvals.data = {
    owner: mocks.address,
    ctfApprovedForAll: true,
    collateralAllowanceRaw: '1000000',
    ctfUpdatedAt: 1_900_000_000,
    collateralUpdatedAt: 1_900_000_000,
  } satisfies ExchangeApprovalStateResponse;
  mocks.approvals.isLoading = false;
  mocks.approvals.error = null;
  mocks.myOrders.data = {
    orders: [],
    onchainOrders: [],
    offchainWithdrawalIsOnchainCancellation: false,
    warning: 'Withdrawal is not cancellation.',
  } satisfies MakerOrdersResponse;
  mocks.myOrders.isLoading = false;
  mocks.myOrders.error = null;
  mocks.collateralBalance.data = 5_000_000n;
  mocks.collateralBalance.isLoading = false;
  mocks.collateralBalance.error = null;
  mocks.txHookCall = 0;
  for (const mock of [
    mocks.approvals.refetch,
    mocks.myOrders.refetch,
    mocks.approveCollateral,
    mocks.approveTokens,
    mocks.signOrder,
    mocks.fillOrder,
    mocks.miniFillOrder,
    mocks.submitCancel,
    mocks.postOrder,
    mocks.withdrawOrder,
    mocks.collateralBalance.refetch,
    mocks.approvalReset,
    mocks.actionReset,
  ]) {
    mock.mockReset();
  }
  mocks.approveCollateral.mockResolvedValue({});
  mocks.approveTokens.mockResolvedValue({});
  mocks.fillOrder.mockResolvedValue({});
  mocks.submitCancel.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Hybrid human trading surface', () => {
  it('defaults and clamps expiry into the future after the trading window ended', () => {
    const nowSeconds = 1_786_406_400;
    vi.spyOn(Date, 'now').mockReturnValue(nowSeconds * 1_000);
    renderPanel(
      books(offchainOrder(OTHER_MAKER, 'a1')),
      {
        ...market,
        tradingEndsAt: nowSeconds - 86_400,
      },
    );

    const expiry = screen.getByLabelText(/Expiry \(UTC\)/u) as HTMLInputElement;
    expect(Date.parse(`${expiry.value}:00Z`) / 1_000).toBeGreaterThan(
      nowSeconds,
    );
    expect(expiry.getAttribute('aria-invalid')).toBe('false');
    expect(screen.getByRole('button', { name: 'Review binding order' })).toBeTruthy();

    fireEvent.change(expiry, { target: { value: '2020-01-01T00:00' } });
    expect(expiry.getAttribute('aria-invalid')).toBe('true');
    fireEvent.blur(expiry);

    expect(Date.parse(`${expiry.value}:00Z`) / 1_000).toBeGreaterThan(
      nowSeconds,
    );
    expect(expiry.getAttribute('aria-invalid')).toBe('false');
  });

  it('renders zero as good-till-cancelled and real expiry as a UTC date', () => {
    const noExpiry = offchainOrder(OTHER_MAKER, 'a2', 'OPEN', 0n);
    const datedExpiry = offchainOrder(
      `0x${'45'.repeat(20)}`,
      'a3',
      'OPEN',
      2_000_000_000n,
    );
    const response = books(noExpiry);
    response.yes.offchainOrders = [noExpiry, datedExpiry];
    renderPanel(response);

    expect(screen.getByText('No expiry · good till cancelled')).toBeTruthy();
    expect(screen.getByText(/2033/u)).toBeTruthy();
    expect(screen.queryByText(/1970/u)).toBeNull();
  });

  it('renders explicit empty and loading states for live book data', () => {
    mocks.approvals.isLoading = true;
    mocks.myOrders.isLoading = true;
    const response = books(offchainOrder(OTHER_MAKER, 'ae'));
    response.yes.offchainOrders = [];
    renderPanel(response);

    expect(
      screen.getByText('No fillable signed asks on the Hybrid exchange.'),
    ).toBeTruthy();
    expect(
      screen.getByText('Reading indexed CTF and collateral approvals…'),
    ).toBeTruthy();
    expect(screen.getByText('Loading your open signed orders…')).toBeTruthy();
  });

  it('renders explicit approval and my-orders error recovery states', () => {
    mocks.approvals.error = new Error('approval index unavailable');
    mocks.myOrders.error = new Error('orders unavailable');
    renderPanel(books(offchainOrder(OTHER_MAKER, 'af')));

    expect(
      screen.getByText(
        /Approval state could not be verified, so no approval or order prompt will open/u,
      ),
    ).toBeTruthy();
    expect(screen.getByText('Your signed orders could not be loaded.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('renders only the labelled MiniCLOB ladder when that venue is live', () => {
    const response = books(offchainOrder(OTHER_MAKER, 'ad'));
    response.liveVenue = 'MINICLOB';
    renderLivePanel(response);

    expect(screen.getByText('Live venue · On-chain MiniCLOB')).toBeTruthy();
    expect(screen.getAllByText('0.910000').length).toBeGreaterThan(0);
    expect(screen.queryByText('Live venue · Hybrid CTF exchange')).toBeNull();
  });

  it('renders an explicit LMSR/no-book state without routing it to MiniCLOB', () => {
    const response = books(offchainOrder(OTHER_MAKER, 'a0'));
    const bootstrapResponse: MarketBookResponse = {
      ...response,
      liveVenue: 'LMSR',
      orderBookAvailable: false,
    };

    renderLivePanel(bootstrapResponse);

    expect(screen.getByText('No live order book')).toBeTruthy();
    expect(screen.getByText(/LMSR bonding curve is live/u)).toBeTruthy();
    expect(screen.queryByText('Live venue · On-chain MiniCLOB')).toBeNull();
  });

  it('pauses every order control while Hybrid liquidity is preparing', () => {
    const response: MarketBookResponse = {
      ...books(offchainOrder(OTHER_MAKER, 'a0')),
      liveVenue: 'NONE',
      orderBookAvailable: false,
      venueTransition: { state: 'PREPARING' },
    };

    renderLivePanel(response);

    expect(screen.getByText('Preparing Hybrid liquidity')).toBeTruthy();
    expect(screen.getByText(/updates automatically/u)).toBeTruthy();
    expect(screen.queryByText('Live venue · On-chain MiniCLOB')).toBeNull();
    expect(screen.queryByText('Live venue · Hybrid CTF exchange')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows only a safe failure code when Hybrid liquidity needs attention', () => {
    const response: MarketBookResponse = {
      ...books(offchainOrder(OTHER_MAKER, 'a0')),
      liveVenue: 'NONE',
      orderBookAvailable: false,
      venueTransition: {
        state: 'FAILED',
        failureCode: 'TOKEN_REGISTRATION_FAILED',
      },
    };

    renderLivePanel(response);

    expect(screen.getByText('Hybrid liquidity needs attention')).toBeTruthy();
    expect(screen.getByText(/TOKEN_REGISTRATION_FAILED/u)).toBeTruthy();
    expect(screen.queryByText('Live venue · On-chain MiniCLOB')).toBeNull();
    expect(screen.queryByText('Live venue · Hybrid CTF exchange')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('does not echo an unsafe venue-transition failure detail', () => {
    const unsafeDetail = 'RPC_FAILED: https://private.example calldata=0x1234';
    const response: MarketBookResponse = {
      ...books(offchainOrder(OTHER_MAKER, 'a0')),
      liveVenue: 'NONE',
      orderBookAvailable: false,
      venueTransition: {
        state: 'FAILED',
        failureCode: unsafeDetail,
      },
    };

    renderLivePanel(response);

    expect(screen.getByText('Hybrid liquidity needs attention')).toBeTruthy();
    expect(document.body.textContent).not.toContain(unsafeDetail);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it.each(['HYBRID', 'MINICLOB'] as const)(
    "labels and disables the connected maker's resting order on %s",
    (venue) => {
      const response = books(
        offchainOrder(venue === 'HYBRID' ? mocks.address : OTHER_MAKER, 'b2'),
      );
      if (venue === 'MINICLOB') {
        response.liveVenue = 'MINICLOB';
        response.yes.orders = [{ ...miniOnlyOrder, maker: mocks.address }];
      }
      renderLivePanel(response);

      const ownOrder = screen.getByRole('button', { name: 'Your order' });
      expect(ownOrder.hasAttribute('disabled')).toBe(true);
      fireEvent.click(ownOrder);

      expect(screen.queryByRole('button', { name: 'Fill' })).toBeNull();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(
        venue === 'HYBRID' ? mocks.fillOrder : mocks.miniFillOrder,
      ).not.toHaveBeenCalled();
    },
  );

  it('keeps executable MiniCLOB price precision across ladder, table, and modal', () => {
    const response = books(offchainOrder(OTHER_MAKER, 'a4'));
    response.liveVenue = 'MINICLOB';
    response.yes.orders = [
      {
        ...miniOnlyOrder,
        isSeed: true,
        priceRaw: '543213',
        sizeRaw: '750000',
        remainingRaw: '750000',
      },
    ];
    renderLivePanel(response);

    expect(screen.getAllByText('0.543213')).toHaveLength(2);
    expect(screen.getByText('0.407410')).toBeTruthy();
    expect(screen.getAllByText(/exact seed/iu).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/New-order price tick 0\.001 USDC/u),
    ).toBeTruthy();
    expect(response.minimumTickSizeAppliesTo).toBe('NEW_ORDERS');

    fireEvent.click(screen.getByRole('button', { name: 'Fill' }));
    expect(
      within(screen.getByRole('dialog')).getByText('0.543213 USDC/token'),
    ).toBeTruthy();
  });

  it('explains a copied off-tick MiniCLOB ladder price with the nearest valid price', () => {
    const response = books(offchainOrder(OTHER_MAKER, 'a5'));
    response.liveVenue = 'MINICLOB';
    response.yes.orders = [
      {
        ...miniOnlyOrder,
        priceRaw: '543213',
      },
    ];
    renderLivePanel(response);

    fireEvent.change(screen.getByLabelText(/Limit price/u), {
      target: { value: '0.543213' },
    });

    const message =
      'Price must use 0.001 USDC ticks. Nearest valid price: 0.543000';
    expect(screen.getByRole('alert').textContent).toBe(message);
    expect(
      screen.getByRole('button', { name: message }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('renders distinct Hybrid price failures without claiming a satisfied condition', () => {
    renderPanel(books(offchainOrder(OTHER_MAKER, 'a6')));
    const price = screen.getByLabelText(/Limit price/u);
    const cases = [
      ['1.001', 'Price must be at most 1 USDC'],
      [
        '0.0005',
        'Price must use 0.001 USDC ticks. Nearest valid price: 0.001000',
      ],
      ['0.000', 'Price must be greater than 0 USDC'],
      ['-0.5', 'Price cannot be negative'],
      ['abc', 'Enter a numeric price'],
    ] as const;

    const rendered = cases.map(([value, expected]) => {
      fireEvent.change(price, { target: { value } });
      const message = screen.getByRole('alert').textContent;
      expect(message).toBe(expected);
      return message;
    });
    expect(new Set(rendered).size).toBe(cases.length);
  });

  it.each(['HYBRID', 'MINICLOB'] as const)(
    'blocks an underfunded USDC bid before preview on %s',
    (venue) => {
      mocks.collateralBalance.data = 14_290_000n;
      const response = books(offchainOrder(OTHER_MAKER, 'a7'));
      response.liveVenue = venue;
      renderLivePanel(response);

      fireEvent.change(screen.getByLabelText(/^Size/u), {
        target: { value: '999999999999' },
      });

      const action = screen.getByRole('button', {
        name: /Insufficient USDC balance: requires .* wallet holds 14\.290000 USDC/u,
      });
      expect(action.hasAttribute('disabled')).toBe(true);
      expect(screen.queryByRole('dialog')).toBeNull();
    },
  );

  it('shows MiniCLOB escrow, expiry, and binding terms before placement', () => {
    const response = books(offchainOrder(OTHER_MAKER, 'a8'));
    response.liveVenue = 'MINICLOB';
    renderLivePanel(response);

    fireEvent.click(screen.getByRole('button', { name: 'Preview YES BID' }));

    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('USDC escrow total')).toBeTruthy();
    expect(dialog.getByText('0.120000 USDC')).toBeTruthy();
    expect(dialog.getByText('No expiry · good till cancelled')).toBeTruthy();
    expect(dialog.getByText(/This is a binding commitment, not a draft/u)).toBeTruthy();
  });

  it('blocks a known zero-balance MiniCLOB sell and exposes the reason', () => {
    const response = books(offchainOrder(OTHER_MAKER, 'a0'));
    response.liveVenue = 'MINICLOB';
    renderLivePanel(response);

    fireEvent.click(screen.getByRole('button', { name: 'NO' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sell · ASK' }));
    fireEvent.change(screen.getByLabelText(/^Size/u), {
      target: { value: '1.000' },
    });

    const reason = 'Insufficient NO balance: requires 1 NO, wallet holds 0 NO';
    expect(screen.getByRole('alert').textContent).toContain(reason);
    expect(
      screen.getByRole('button', { name: reason }).hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('labels a Hybrid sell total as proceeds in the ticket and dialog', () => {
    const position: Position = {
      account: mocks.address,
      marketId: market.id,
      outcome: 'YES',
      qtyRaw: '1000000',
      costBasisRaw: '500000',
      costBasisEstimated: true,
      realizedPnlRaw: '0',
      unrealizedPnlRaw: '0',
      updatedAt: 1_900_000_000,
    };
    renderPanel(books(offchainOrder(OTHER_MAKER, 'a9')), market, [position]);

    fireEvent.click(screen.getByRole('button', { name: 'Sell · ASK' }));
    expect(screen.getByText('Estimated proceeds')).toBeTruthy();
    expect(screen.queryByText('Total collateral')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Review binding order' }));

    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('Estimated proceeds')).toBeTruthy();
    expect(dialog.queryByText('Total collateral')).toBeNull();
  });

  it('reads indexed approval state and offers one explained exact-amount prompt', async () => {
    mocks.approvals.data = {
      ...mocks.approvals.data,
      collateralAllowanceRaw: '0',
    };
    renderPanel(books(offchainOrder(OTHER_MAKER, 'ac')));

    expect(
      screen
        .getByRole('button', { name: 'Approve exact collateral above' })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(
      screen.getByText(
        'Needed to buy; approvals use the exact reviewed total.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Missing · 0.120000 USDC')).toBeTruthy();
    expect(screen.queryByText('Missing · 0.000000 USDC')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Approve exactly 0.120000 USDC' }),
    );

    await waitFor(() =>
      expect(mocks.approveCollateral).toHaveBeenCalledWith({
        account: mocks.address,
        amountRaw: 120_000n,
        report: expect.any(Function),
      }),
    );
    expect(mocks.signOrder).not.toHaveBeenCalled();
  });

  it('signs and posts a binding order without a server session', async () => {
    const makerOrder = offchainOrder(OTHER_MAKER, 'ab');
    mocks.authenticated = false;
    mocks.signOrder.mockResolvedValue({
      orderHash: makerOrder.orderHash,
      order: makerOrder.signedOrder,
    });
    mocks.postOrder.mockResolvedValue({ order: makerOrder });
    renderPanel(books(makerOrder));

    expect(screen.getByText('Live venue · Hybrid CTF exchange')).toBeTruthy();
    expect(screen.queryByText('0.910000')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Review binding order' }));

    const dialog = within(screen.getByRole('dialog'));
    expect(mocks.signOrder).not.toHaveBeenCalled();
    expect(dialog.getByText('0.600000 USDC/token')).toBeTruthy();
    expect(dialog.getByText('0.2 YES')).toBeTruthy();
    expect(dialog.getByText('0.120000 USDC')).toBeTruthy();
    expect(
      screen.getByText(
        /A signed order can be filled by anyone until it expires or is cancelled on-chain/u,
      ),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', { name: 'Sign & post binding order' }),
    );
    await waitFor(() => expect(mocks.signOrder).toHaveBeenCalledOnce());
    expect(mocks.signOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        minimumTickSizeRaw: 1_000n,
        priceRaw: 600_000n,
        sizeRaw: 200_000n,
      }),
    );
    expect(mocks.postOrder).toHaveBeenCalledOnce();
    expect(mocks.approveCollateral).not.toHaveBeenCalled();
    expect(mocks.approveTokens).not.toHaveBeenCalled();
    expect(mocks.approvalReset).toHaveBeenCalledOnce();
  });

  it('snaps bids down and asks up to the effective market tick', () => {
    const response = books(offchainOrder(OTHER_MAKER, 'bc'));
    response.minimumTickSizeRaw = '10000';
    response.yes.minimumTickSizeRaw = '10000';
    response.no.minimumTickSizeRaw = '10000';
    renderPanel(response);

    const price = screen.getByLabelText(/Limit price/u) as HTMLInputElement;
    fireEvent.change(price, { target: { value: '0.604' } });
    fireEvent.blur(price);
    expect(price.value).toBe('0.6');

    fireEvent.click(screen.getByRole('button', { name: 'Sell · ASK' }));
    fireEvent.change(price, { target: { value: '0.604' } });
    fireEvent.blur(price);
    expect(price.value).toBe('0.61');
  });

  it('explains and visibly snaps an off-step Hybrid order size on blur', () => {
    renderPanel(books(offchainOrder(OTHER_MAKER, 'bd')));

    const size = screen.getByLabelText(/^Size/u) as HTMLInputElement;
    fireEvent.change(size, { target: { value: '0.2005' } });

    expect(screen.getByRole('alert').textContent).toContain(
      'Size must use 0.001 token steps',
    );
    expect(
      screen.getByRole('button', {
        name: 'Size must use 0.001 token steps',
      }),
    ).toBeTruthy();

    fireEvent.blur(size);

    expect(size.value).toBe('0.2');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('rejects a Hybrid sell above the selected outcome-token balance before review', () => {
    const position: Position = {
      account: mocks.address,
      marketId: market.id,
      outcome: 'NO',
      qtyRaw: '750000',
      costBasisRaw: '300000',
      costBasisEstimated: true,
      realizedPnlRaw: '0',
      unrealizedPnlRaw: '0',
      updatedAt: 1_900_000_000,
    };
    renderPanel(books(offchainOrder(OTHER_MAKER, 'bf')), market, [position]);

    fireEvent.click(screen.getByRole('button', { name: 'NO' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sell · ASK' }));
    const size = screen.getByLabelText(/^Size/u) as HTMLInputElement;
    fireEvent.change(size, { target: { value: '0.751' } });

    expect(size.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain(
      'Insufficient NO balance: requires 0.751 NO, wallet holds 0.75 NO',
    );
    expect(
      screen.getByRole('button', {
        name: 'Insufficient NO balance: requires 0.751 NO, wallet holds 0.75 NO',
      }).hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.signOrder).not.toHaveBeenCalled();
  });

  it('explains and visibly snaps an off-step MiniCLOB order size on blur', () => {
    const response = books(offchainOrder(OTHER_MAKER, 'be'));
    response.liveVenue = 'MINICLOB';
    renderLivePanel(response);

    const size = screen.getByLabelText(/^Size/u) as HTMLInputElement;
    fireEvent.change(size, { target: { value: '0.2005' } });

    expect(screen.getByRole('alert').textContent).toContain(
      'Size must use 0.001 token steps',
    );
    expect(
      screen.getByRole('button', {
        name: 'Size must use 0.001 token steps',
      }),
    ).toBeTruthy();

    fireEvent.blur(size);

    expect(size.value).toBe('0.2');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps a positive sub-step MiniCLOB size and its truthful error on blur', () => {
    const response = books(offchainOrder(OTHER_MAKER, 'b1'));
    response.liveVenue = 'MINICLOB';
    renderLivePanel(response);

    const size = screen.getByLabelText(/^Size/u) as HTMLInputElement;
    fireEvent.change(size, { target: { value: '0.0005' } });
    fireEvent.blur(size);

    expect(size.value).toBe('0.0005');
    expect(screen.getByRole('alert').textContent).toBe(
      'Size must use 0.001 token steps',
    );
    expect(
      screen.queryByText('Enter an order size greater than zero'),
    ).toBeNull();
  });

  it('keeps free withdrawal and gas cancellation as separate actions using API calldata', async () => {
    const ownOpen = offchainOrder(mocks.address, 'cd');
    const ownWithdrawn = { ...ownOpen, status: 'WITHDRAWN' as const, fillable: false };
    const withdrawal = {
      order: ownWithdrawn,
      offchainWithdrawalIsOnchainCancellation: false,
      signedOrderMayRemainValidOnchain: true,
      warning: 'The signature remains valid.',
      authoritativeCancelOrderTx: CANCEL_TX,
    } satisfies WithdrawOrderResponse;
    mocks.myOrders.data = {
      orders: [ownOpen],
      onchainOrders: [],
      offchainWithdrawalIsOnchainCancellation: false,
      warning: 'Withdrawal is not cancellation.',
    };
    mocks.withdrawOrder.mockResolvedValue(withdrawal);
    renderPanel(books(offchainOrder(OTHER_MAKER, 'ef')));

    fireEvent.click(screen.getByRole('button', { name: 'Withdraw · free' }));
    await waitFor(() => expect(mocks.withdrawOrder).toHaveBeenCalledOnce());
    expect(mocks.submitCancel).not.toHaveBeenCalled();
    expect(screen.getByText('Withdrawn from this book')).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', { name: 'Cancel on-chain · gas' }),
    );
    expect(mocks.submitCancel).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Cancel on-chain',
      }),
    );

    await waitFor(() => expect(mocks.submitCancel).toHaveBeenCalledOnce());
    expect(mocks.withdrawOrder).toHaveBeenCalledOnce();
    expect(mocks.submitCancel).toHaveBeenCalledWith({
      account: mocks.address,
      transaction: CANCEL_TX,
      report: expect.any(Function),
    });
  });

  it("fills someone else's signed order through the on-chain exchange path", async () => {
    const makerOrder = offchainOrder(OTHER_MAKER, 'aa');
    renderPanel(books(makerOrder));

    fireEvent.click(screen.getByRole('button', { name: 'Fill' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('0.650000 USDC')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Fill on-chain' }));

    await waitFor(() => expect(mocks.fillOrder).toHaveBeenCalledOnce());
    expect(mocks.fillOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        account: mocks.address,
        fillAmount: 1_000_000n,
        order: expect.objectContaining({
          maker: OTHER_MAKER,
          tokenId: 101n,
          side: Side.SELL,
        }),
        report: expect.any(Function),
      }),
    );
    expect(mocks.approveCollateral).not.toHaveBeenCalled();
  });
});
