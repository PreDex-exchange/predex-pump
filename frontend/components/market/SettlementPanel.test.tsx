import type { Market } from '@predex-pump/shared/domain';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SettlementStatus } from '@/lib/chain/useSettlementStatus';

import { SettlementPanel } from './SettlementPanel';
import { internalIdentifiersInRenderedOutput } from './user-facing-copy.test-utils';

const mocks = vi.hoisted(() => ({
  refetch: vi.fn(),
  status: {
    data: undefined as SettlementStatus | undefined,
    error: null as Error | null,
    isLoading: false,
  },
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: `0x${'c'.repeat(40)}`,
    chainId: 5_042_002,
    isConnected: true,
  }),
}));

vi.mock('@/lib/api/hooks', () => ({
  useConfig: () => ({
    data: {
      committee: {
        signers: [`0x${'d'.repeat(40)}`],
        threshold: 1,
      },
    },
    error: null,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/lib/chain/useSettlementStatus', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@/lib/chain/useSettlementStatus')>();
  return {
    ...original,
    useSettlementStatus: () => ({
      ...mocks.status,
      refetch: mocks.refetch,
    }),
  };
});

vi.mock('@/lib/chain/useTxFlow', () => ({
  useTxFlow: () => ({
    state: { phase: 'idle', message: 'Ready.' },
    execute: vi.fn(),
    reset: vi.fn(),
    isBusy: false,
  }),
}));

vi.mock('@/lib/chain/transactions', () => ({
  claimFundingResidualOnArc: vi.fn(),
  closeoutOnArc: vi.fn(),
  observeResolutionOnArc: vi.fn(),
  redeemOnArc: vi.fn(),
  resolveOnArc: vi.fn(),
  sweepProtocolAfterCloseoutOnArc: vi.fn(),
}));

const market: Market = {
  id: '2',
  creator: `0x${'a'.repeat(40)}`,
  question: 'Did this market settle?',
  phase: 'Graduated',
  conditionId: `0x${'2'.repeat(64)}`,
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
  resolvedAt: 1_784_918_616,
};

function settledStatus(): SettlementStatus {
  return {
    creator: market.creator,
    lifecycleState: 3,
    chainTimestamp: 1_784_918_700,
    tradingEndsAt: market.tradingEndsAt,
    questionId: market.questionId as `0x${string}`,
    conditionId: market.conditionId as `0x${string}`,
    oracleResolved: true,
    questionThreshold: 1n,
    snapshotMember: false,
    payoutYes: 1n,
    payoutNo: 0n,
    payoutDenominator: 1n,
    outcome: 'YES',
    lmsrResolved: false,
    lmsrClosedOut: false,
    yesBalanceRaw: 1_000_000n,
    noBalanceRaw: 0n,
    yesRedeemableRaw: 1_000_000n,
    noRedeemableRaw: 0n,
    fundingResidualRaw: 0n,
    fundingLossRaw: 0n,
    protocolPnlRaw: 0n,
    claimedResidualRaw: 0n,
    creatorFundingSharesRaw: 0n,
    totalFundingSharesRaw: 0n,
    creatorResidualClaimableRaw: 0n,
    protocolSweepAvailableRaw: 0n,
    protocolSweepCompleted: false,
    protocolSweptRaw: 0n,
    closedOutAt: 0,
  };
}

beforeEach(() => {
  mocks.refetch.mockReset();
  mocks.status = {
    data: undefined,
    error: null,
    isLoading: false,
  };
});

afterEach(cleanup);

describe('SettlementPanel reads', () => {
  it('never renders raw provider errors', () => {
    const rawError =
      'HTTP request failed https://rpc.testnet.arc.network eth_getLogs {"fromBlock":"0x1"} You reached Public endpoint rate limit, please upgrade to paid plan viem@2.55.8';
    mocks.status.error = new Error(rawError);

    render(<SettlementPanel market={market} />);

    expect(screen.queryByText(rawError)).toBeNull();
    expect(screen.queryByText(/rpc\.testnet\.arc\.network/u)).toBeNull();
    expect(screen.queryByText(/eth_getLogs/u)).toBeNull();
    expect(screen.queryByText(/rate limit/u)).toBeNull();
    expect(
      screen.getByText(/Live settlement data is temporarily unavailable/u),
    ).toBeTruthy();
  });

  it('offers payout redemption before the incubator phase is observed', () => {
    mocks.status.data = settledStatus();

    const rendered = render(<SettlementPanel market={market} />);

    expect(screen.getByText('Resolution ready to observe')).toBeTruthy();
    expect(screen.getByText('Wallet positions')).toBeTruthy();
    const redeemButtons = screen.getAllByRole('button', { name: 'Redeem' });
    expect(redeemButtons).toHaveLength(2);
    expect(redeemButtons[0]?.hasAttribute('disabled')).toBe(false);
    expect(redeemButtons[1]?.hasAttribute('disabled')).toBe(true);
    expect(internalIdentifiersInRenderedOutput(rendered.container)).toEqual([]);
  });

  it.each([
    [4, 'Resolution observed'],
    [5, 'Closed out'],
  ])('renders lifecycle state %i as prose', (lifecycleState, expectedPhase) => {
    mocks.status.data = {
      ...settledStatus(),
      lifecycleState,
    };

    const rendered = render(<SettlementPanel market={market} />);

    expect(screen.getByText(expectedPhase)).toBeTruthy();
    expect(internalIdentifiersInRenderedOutput(rendered.container)).toEqual([]);
  });

  it('keeps lifecycle identifiers out of action explanations', () => {
    mocks.status.data = settledStatus();
    const observe = render(<SettlementPanel market={market} />);

    fireEvent.click(screen.getByRole('button', { name: 'Observe resolution' }));
    expect(internalIdentifiersInRenderedOutput(observe.container)).toEqual([]);

    observe.unmount();
    mocks.status.data = {
      ...settledStatus(),
      lifecycleState: 4,
    };
    const closeout = render(<SettlementPanel market={market} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close out market' }));
    expect(internalIdentifiersInRenderedOutput(closeout.container)).toEqual([]);
  });
});
