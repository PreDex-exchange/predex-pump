import type { Market } from '@predex-pump/shared/domain';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TradePanel } from './TradePanel';

const mocks = vi.hoisted(() => ({
  address: `0x${'12'.repeat(20)}` as const,
  buyOnArc: vi.fn(),
  execute: vi.fn(),
  refetchQuote: vi.fn(),
}));
const ADDRESS = mocks.address;

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: mocks.address,
    chainId: 5_042_002,
    isConnected: true,
  }),
}));

vi.mock('@/lib/chain/useQuote', () => ({
  useQuote: () => ({
    quote: {
      avgPriceRaw: '500000',
      sharesRaw: '100000',
      feeRaw: '1000',
      totalRaw: '51000',
      maxOrMinRaw: '51255',
    },
    isLoading: false,
    error: null,
    refetch: mocks.refetchQuote,
  }),
}));

vi.mock('@/lib/chain/transactions', () => ({
  buyOnArc: mocks.buyOnArc,
  sellOnArc: vi.fn(),
}));

vi.mock('@/lib/chain/useTxFlow', () => ({
  useTxFlow: () => ({
    state: { phase: 'idle', message: 'Ready.' },
    execute: mocks.execute,
    reset: vi.fn(),
    isBusy: false,
  }),
}));

const market: Market = {
  id: '1',
  creator: `0x${'aa'.repeat(20)}`,
  question: 'Will the wallet-only trade remain open?',
  phase: 'Opened',
  conditionId: `0x${'01'.repeat(32)}`,
  questionId: `0x${'02'.repeat(32)}`,
  yesTokenId: '101',
  noTokenId: '102',
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
  createdAt: 1_700_000_000,
  tradingEndsAt: 1_700_086_400,
  graduatedAt: null,
  resolvedAt: null,
};

beforeEach(() => {
  mocks.buyOnArc.mockReset();
  mocks.buyOnArc.mockResolvedValue({ transactionHash: `0x${'ab'.repeat(32)}` });
  mocks.execute.mockReset();
  mocks.execute.mockImplementation(
    async (operation: (report: (state: unknown) => void) => Promise<unknown>) =>
      operation(vi.fn()),
  );
  mocks.refetchQuote.mockReset();
});

afterEach(cleanup);

describe('wallet-only core trade path', () => {
  it('opens and executes a curve trade with no account session/provider', async () => {
    render(<TradePanel market={market} />);
    const tradeButton = screen.getByRole('button', { name: 'Buy YES' });
    expect(tradeButton.hasAttribute('disabled')).toBe(false);

    fireEvent.click(tradeButton);
    fireEvent.click(
      screen.getByRole('button', { name: 'Approve & Buy YES' }),
    );

    await waitFor(() => expect(mocks.buyOnArc).toHaveBeenCalledOnce());
    expect(mocks.buyOnArc).toHaveBeenCalledWith(
      expect.objectContaining({
        account: ADDRESS,
        marketId: 1n,
        outcome: 'YES',
        amountRaw: 100000n,
      }),
    );
  });
});
