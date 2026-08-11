import type {
  Market,
  OffchainOrder,
  Order,
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
      offchainWithdrawalIsOnchainCancellation: false as const,
      warning: 'Withdrawal is not cancellation.',
    },
    isLoading: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
  signIn: vi.fn(),
  approveCollateral: vi.fn(),
  approveTokens: vi.fn(),
  signOrder: vi.fn(),
  fillOrder: vi.fn(),
  submitCancel: vi.fn(),
  postOrder: vi.fn(),
  withdrawOrder: vi.fn(),
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: mocks.address,
    chainId: 5_042_002,
    isConnected: true,
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
    signIn: mocks.signIn,
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
    fillOrderOnArc: vi.fn(),
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
  useTxFlow: () => ({
    state: { phase: 'idle', message: 'Ready.' },
    execute: async <T,>(
      operation: (report: (state: unknown) => void) => Promise<T>,
    ) => operation(vi.fn()),
    reset: vi.fn(),
    isBusy: false,
  }),
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
): OffchainOrder {
  const signed = buildCtfExchangeOrder({
    maker,
    tokenId: 101n,
    side: Side.SELL,
    priceRaw: 650_000n,
    sizeRaw: 1_000_000n,
    salt: BigInt(`0x${hashByte.repeat(4)}`),
    expiration: 2_000_000_000n,
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
    minimumTickSizeRaw: '1000',
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

function renderPanel(bookResponse: MarketBookResponse) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
  return render(
    <HybridOrderBookPanel books={bookResponse} market={market} />,
    { wrapper },
  );
}

function renderLivePanel(bookResponse: MarketBookResponse) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <OrderBookPanel books={bookResponse} market={market} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
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
    offchainWithdrawalIsOnchainCancellation: false,
    warning: 'Withdrawal is not cancellation.',
  } satisfies MakerOrdersResponse;
  mocks.myOrders.isLoading = false;
  mocks.myOrders.error = null;
  for (const mock of [
    mocks.approvals.refetch,
    mocks.myOrders.refetch,
    mocks.signIn,
    mocks.approveCollateral,
    mocks.approveTokens,
    mocks.signOrder,
    mocks.fillOrder,
    mocks.submitCancel,
    mocks.postOrder,
    mocks.withdrawOrder,
  ]) {
    mock.mockReset();
  }
  mocks.approveCollateral.mockResolvedValue({});
  mocks.approveTokens.mockResolvedValue({});
  mocks.fillOrder.mockResolvedValue({});
  mocks.submitCancel.mockResolvedValue({});
});

afterEach(cleanup);

describe('Hybrid human trading surface', () => {
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
    expect(screen.getAllByText('0.910').length).toBeGreaterThan(0);
    expect(screen.queryByText('Live venue · Hybrid CTF exchange')).toBeNull();
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

  it('labels the live venue and shows the full commitment before signing', async () => {
    const makerOrder = offchainOrder(OTHER_MAKER, 'ab');
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

    fireEvent.click(screen.getByRole('tab', { name: 'Sell · ASK' }));
    fireEvent.change(price, { target: { value: '0.604' } });
    fireEvent.blur(price);
    expect(price.value).toBe('0.61');
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
