import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GatewayDepositPanel } from './GatewayDepositPanel';

const mocks = vi.hoisted(() => ({
  address: `0x${'12'.repeat(20)}` as const,
  gateway: {
    data: null as { totalRaw: string; availableRaw: string } | null,
    isLoading: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
  wallet: {
    data: 5_000_000n as bigint | undefined,
    isLoading: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
}));

vi.mock('@/lib/api/hooks', () => ({
  useGatewayBalance: () => mocks.gateway,
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: mocks.address,
    chainId: 5_042_002,
    isConnected: true,
  }),
  useReadContract: () => mocks.wallet,
}));

vi.mock('@/lib/chain/useTxFlow', () => ({
  useTxFlow: () => ({
    state: { phase: 'idle', message: 'Ready.' },
    execute: vi.fn(),
    reset: vi.fn(),
    isBusy: false,
  }),
}));

vi.mock('@/lib/chain/transactions', () => ({
  depositToCircleGatewayOnArc: vi.fn(),
}));

beforeEach(() => {
  mocks.gateway.data = {
    totalRaw: '2500000',
    availableRaw: '2000000',
  };
  mocks.gateway.isLoading = false;
  mocks.gateway.error = null;
  mocks.gateway.refetch.mockReset();
  mocks.wallet.data = 5_000_000n;
  mocks.wallet.isLoading = false;
  mocks.wallet.error = null;
});

afterEach(cleanup);

describe('GatewayDepositPanel', () => {
  it('makes the owner, destination, amount, balance, and two signatures explicit', () => {
    render(<GatewayDepositPanel sessionAddress={mocks.address} />);

    expect(screen.getByText('2.50 USDC')).toBeTruthy();
    expect(screen.getByText('2.00 USDC')).toBeTruthy();
    expect(screen.getByText(mocks.address)).toBeTruthy();
    expect(
      screen.getByText('0x0077777d7EBA4688BDeF3E311b846F25870A19B9'),
    ).toBeTruthy();
    expect(screen.getByText('Approve Arc USDC')).toBeTruthy();
    expect(screen.getByText('Deposit to your balance')).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Review two-step deposit' })
        .hasAttribute('disabled'),
    ).toBe(false);
  });

  it('degrades to an honest unavailable card without throwing', () => {
    mocks.gateway.data = null;
    mocks.gateway.error = new Error('Circle Gateway balance is temporarily unavailable.');
    render(<GatewayDepositPanel sessionAddress={mocks.address} />);

    expect(screen.getByText('Gateway deposit unavailable')).toBeTruthy();
    expect(screen.getByText('Unavailable')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check Gateway again' })).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Review two-step deposit' }),
    ).toBeNull();
  });

  it('shows a clear empty-balance state', () => {
    mocks.gateway.data = { totalRaw: '0', availableRaw: '0' };
    render(<GatewayDepositPanel sessionAddress={mocks.address} />);

    expect(screen.getByText(/This Gateway balance is empty/u)).toBeTruthy();
    expect(screen.getAllByText('0.00 USDC')).toHaveLength(2);
  });

  it('does not round a sub-unit funding balance up to a whole USDC', () => {
    mocks.gateway.data = { totalRaw: '999700', availableRaw: '999700' };
    mocks.wallet.data = 999_700n;
    render(<GatewayDepositPanel sessionAddress={mocks.address} />);

    expect(screen.getAllByText('0.9997 USDC')).toHaveLength(3);
    expect(screen.queryByText('1.00 USDC')).toBeNull();
  });

  it.each([
    ['', 'Enter a USDC amount.'],
    ['-5', 'USDC amount cannot be negative.'],
    ['abc', 'Enter a numeric USDC amount.'],
    ['1.2.3', 'Enter a USDC amount with one decimal point.'],
    ['0.0000001', 'USDC supports at most six decimal places.'],
  ])('explains why %j is not a valid deposit amount', (amount, message) => {
    render(<GatewayDepositPanel sessionAddress={mocks.address} />);

    fireEvent.change(screen.getByLabelText(/Deposit amount/u), {
      target: { value: amount },
    });

    expect(screen.getByRole('alert').textContent).toBe(message);
    expect(
      screen.getByRole('button', { name: 'Review two-step deposit' })
        .hasAttribute('disabled'),
    ).toBe(true);
  });
});
