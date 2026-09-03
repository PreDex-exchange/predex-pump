import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TransactionRecoveryNotice } from './TransactionRecoveryNotice';

const mocks = vi.hoisted(() => ({
  readPendingArcTransactions: vi.fn(),
  removePendingArcTransaction: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
}));

vi.mock('@/lib/chain/client', () => ({
  arcPublicClient: {
    waitForTransactionReceipt: mocks.waitForTransactionReceipt,
  },
}));

vi.mock('@/lib/chain/tx-journal', () => ({
  readPendingArcTransactions: mocks.readPendingArcTransactions,
  removePendingArcTransaction: mocks.removePendingArcTransaction,
}));

const ENTRY = {
  account: `0x${'12'.repeat(20)}` as const,
  chainId: 5_042_002 as const,
  hash: `0x${'ab'.repeat(32)}` as const,
  message: 'Buy YES is pending on Arc…',
  submittedAt: 1_800_000_000_000,
};

beforeEach(() => {
  mocks.readPendingArcTransactions.mockReset();
  mocks.readPendingArcTransactions.mockReturnValue([ENTRY]);
  mocks.removePendingArcTransaction.mockReset();
  mocks.waitForTransactionReceipt.mockReset();
});

afterEach(cleanup);

describe('TransactionRecoveryNotice', () => {
  it('recovers a confirmed transaction after reload and dismisses the terminal notice', async () => {
    let resolveReceipt!: (receipt: { status: 'success' }) => void;
    const receipt = new Promise<{ status: 'success' }>((resolve) => {
      resolveReceipt = resolve;
    });
    mocks.waitForTransactionReceipt.mockReturnValue(receipt);
    render(<TransactionRecoveryNotice />);

    await screen.findByText(
      'Checking a transaction submitted before this page loaded…',
    );
    await act(async () => {
      resolveReceipt({ status: 'success' });
      await receipt;
    });
    await screen.findByText('Recovered: this Arc transaction confirmed.');
    expect(mocks.waitForTransactionReceipt).toHaveBeenCalledWith({
      confirmations: 1,
      hash: ENTRY.hash,
      timeout: 15_000,
    });
    expect(mocks.removePendingArcTransaction).toHaveBeenCalledWith(ENTRY.hash);
    expect(
      screen
        .getByRole('link', { name: `View transaction ${ENTRY.hash} on Arcscan` })
        .getAttribute('href'),
    ).toBe(`https://testnet.arcscan.app/tx/${ENTRY.hash}`);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Recovered: this Arc transaction confirmed.')).toBeNull();
  });

  it('reports a recovered on-chain revert without retrying the transaction', async () => {
    mocks.waitForTransactionReceipt.mockResolvedValue({ status: 'reverted' });
    render(<TransactionRecoveryNotice />);

    await screen.findByText(
      'Recovered: this Arc transaction reverted. Its state changes were not applied.',
    );
    expect(mocks.waitForTransactionReceipt).toHaveBeenCalledOnce();
    expect(mocks.removePendingArcTransaction).toHaveBeenCalledWith(ENTRY.hash);
  });

  it('retains an unverified hash and retries only its read-only receipt check', async () => {
    mocks.waitForTransactionReceipt
      .mockRejectedValueOnce(new Error('temporary RPC outage'))
      .mockResolvedValueOnce({ status: 'success' });
    render(<TransactionRecoveryNotice />);

    await screen.findByText(
      'Arc could not confirm this saved transaction yet. Check its hash before retrying.',
    );
    expect(mocks.removePendingArcTransaction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await screen.findByText('Recovered: this Arc transaction confirmed.');
    await waitFor(() =>
      expect(mocks.waitForTransactionReceipt).toHaveBeenCalledTimes(2),
    );
    expect(mocks.removePendingArcTransaction).toHaveBeenCalledWith(ENTRY.hash);
  });
});
