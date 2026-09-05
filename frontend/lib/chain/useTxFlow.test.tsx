import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TxStatus } from '@/components/ui/TxStatus';

import type { TxProgress } from './transactions';
import { OnchainTransactionRevertedError } from './transactions';
import { useTxFlow } from './useTxFlow';

afterEach(cleanup);

function OffchainOrderAction() {
  const flow = useTxFlow();
  return (
    <>
      <button
        onClick={() =>
          void flow.execute(
            async () => {
              throw new Error('Order expired before it was accepted.');
            },
            {
              checkingMessage: 'Posting signed order…',
              failureMessage: 'The signed order was not posted.',
              failurePhase: 'rejected',
            },
          )
        }
        type="button"
      >
        Post order
      </button>
      <TxStatus state={flow.state} />
    </>
  );
}

function FailedTransaction({ error }: { error: unknown }) {
  const flow = useTxFlow();
  return (
    <>
      <button
        onClick={() =>
          void flow.execute(async () => {
            throw error;
          })
        }
        type="button"
      >
        Transact
      </button>
      <TxStatus state={flow.state} />
    </>
  );
}

function nestedTransportTimeoutError() {
  const timeout = new Error('unsafe wallet timeout details');
  timeout.name = 'TransportTimeoutError';
  return Object.assign(new Error('wrapped wallet failure'), {
    cause: { error: timeout },
  });
}

function WalletSubmission({
  phase,
  onAttempt,
}: {
  phase: 'awaiting-signature' | 'awaiting-transaction' | 'awaiting-approval';
  onAttempt?: () => void;
}) {
  const flow = useTxFlow();
  return (
    <>
      <button
        onClick={() =>
          void flow.execute(async (report) => {
            onAttempt?.();
            report({ phase, message: 'Confirm this transaction in your wallet.' });
            throw nestedTransportTimeoutError();
          })
        }
        type="button"
      >
        Transact
      </button>
      <button onClick={flow.reset} type="button">
        Reset
      </button>
      <button disabled={flow.isBusy} type="button">
        Close
      </button>
      <TxStatus state={flow.state} />
    </>
  );
}

const SUBMISSION_UNKNOWN_MESSAGE =
  'The wallet stopped waiting before returning a transaction hash. The transaction may still have been submitted or confirmed on Arc. Close this dialog and check Activity or the affected market before retrying.';

describe('useTxFlow action-specific failure copy', () => {
  it('does not label an off-chain rejection as a transaction failure', async () => {
    render(<OffchainOrderAction />);
    fireEvent.click(screen.getByRole('button', { name: 'Post order' }));

    await waitFor(() =>
      expect(screen.getByText('The signed order was not posted.')).toBeTruthy(),
    );
    expect(screen.queryByText('The transaction did not complete.')).toBeNull();
    expect(screen.getByText('rejected')).toBeTruthy();
    expect(screen.queryByText(/reverted/u)).toBeNull();
    expect(screen.queryByText(/on-chain revert/u)).toBeNull();
  });

  it('cannot render raw provider details even if legacy state includes them', () => {
    const rawProviderMessage =
      'HTTP request failed https://rpc.testnet.arc.network eth_call You reached Public endpoint rate limit, please upgrade to paid plan viem@2.55.8';
    const legacyState = {
      phase: 'reverted',
      message: 'The transaction did not complete.',
      error: rawProviderMessage,
    } satisfies TxProgress & { error: string };

    const rendered = render(<TxStatus state={legacyState} />);

    expect(rendered.container.textContent).toContain(
      'The transaction did not complete.',
    );
    expect(rendered.container.textContent).not.toMatch(
      /rpc\.testnet|eth_call|rate limit|viem@/u,
    );
  });

  it.each([
    [
      4001,
      'You declined the wallet request. Nothing was signed or sent.',
    ],
    [
      4100,
      'This wallet has not authorized the requested account access.',
    ],
  ] as const)(
    'renders EIP-1193 %i with distinct non-revert copy',
    async (code, expected) => {
      render(
        <FailedTransaction
          error={Object.assign(new Error('unsafe provider details'), {
            cause: { code },
          })}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Transact' }));

      await waitFor(() => expect(screen.getByText(expected)).toBeTruthy());
      expect(screen.getByText('rejected')).toBeTruthy();
      expect(document.body.textContent).not.toMatch(/reverted|did not complete/iu);
      expect(document.body.textContent).not.toContain('unsafe provider details');
    },
  );

  it('distinguishes a disconnected wallet from an on-chain revert', async () => {
    render(
      <FailedTransaction
        error={Object.assign(new Error('provider disconnected'), { code: 4900 })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Transact' }));

    await waitFor(() =>
      expect(
        screen.getByText('The wallet is disconnected. Reconnect it and try again.'),
      ).toBeTruthy(),
    );
    expect(screen.getByText('failed')).toBeTruthy();
    expect(screen.queryByText('reverted')).toBeNull();
  });

  it('reports a transport failure without claiming an on-chain revert', async () => {
    const transportError = new Error('unsafe RPC URL');
    transportError.name = 'HttpRequestError';
    render(<FailedTransaction error={transportError} />);
    fireEvent.click(screen.getByRole('button', { name: 'Transact' }));

    await waitFor(() =>
      expect(
        screen.getByText(
          'The wallet-to-Arc connection failed before submission. Nothing was confirmed on-chain.',
        ),
      ).toBeTruthy(),
    );
    expect(screen.getByText('failed')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/reverted|unsafe RPC URL/iu);
  });

  it('uses reverted only for a failed mined receipt', async () => {
    const hash = `0x${'12'.repeat(32)}` as const;
    render(<FailedTransaction error={new OnchainTransactionRevertedError(hash)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Transact' }));

    await waitFor(() =>
      expect(
        screen.getByText(
          'The submitted transaction reverted on Arc. Its state changes were not applied.',
        ),
      ).toBeTruthy(),
    );
    expect(screen.getByText('reverted')).toBeTruthy();
    expect(screen.getByText(/Tx 0x12121212/u)).toBeTruthy();
  });

  it.each(['awaiting-transaction', 'awaiting-approval'] as const)(
    'treats a nested wallet timeout from %s as an unknown submission',
    async (phase) => {
      render(<WalletSubmission phase={phase} />);
      fireEvent.click(screen.getByRole('button', { name: 'Transact' }));

      await waitFor(() =>
        expect(screen.getByText(SUBMISSION_UNKNOWN_MESSAGE)).toBeTruthy(),
      );
      expect(screen.getByText('submission unknown')).toBeTruthy();
      expect(screen.getByRole('alert')).toBeTruthy();
      expect(
        (screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
      expect(document.body.textContent).not.toMatch(/\b(?:failed|reverted)\b/iu);
      expect(document.body.textContent).not.toContain('unsafe wallet timeout details');
    },
  );

  it('keeps an unknown submission visible and blocks retries until remount', async () => {
    const onAttempt = vi.fn();
    const rendered = render(
      <WalletSubmission phase="awaiting-transaction" onAttempt={onAttempt} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Transact' }));
    await waitFor(() => expect(onAttempt).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByText(SUBMISSION_UNKNOWN_MESSAGE)).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    fireEvent.click(screen.getByRole('button', { name: 'Transact' }));

    expect(onAttempt).toHaveBeenCalledTimes(1);
    expect(screen.getByText(SUBMISSION_UNKNOWN_MESSAGE)).toBeTruthy();

    rendered.unmount();
    render(<WalletSubmission phase="awaiting-transaction" onAttempt={onAttempt} />);
    fireEvent.click(screen.getByRole('button', { name: 'Transact' }));

    await waitFor(() => expect(onAttempt).toHaveBeenCalledTimes(2));
  });

  it('keeps an off-chain signature timeout as an ordinary failure', async () => {
    render(<WalletSubmission phase="awaiting-signature" />);
    fireEvent.click(screen.getByRole('button', { name: 'Transact' }));

    await waitFor(() =>
      expect(
        screen.getByText(
          'The action failed before a transaction was confirmed. Nothing was reported as reverted on-chain.',
        ),
      ).toBeTruthy(),
    );
    expect(screen.getByText('failed')).toBeTruthy();
    expect(screen.queryByText('submission unknown')).toBeNull();
  });

  it('keeps the same timeout during checking as an ordinary failure', async () => {
    render(<FailedTransaction error={nestedTransportTimeoutError()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Transact' }));

    await waitFor(() =>
      expect(
        screen.getByText(
          'The action failed before a transaction was confirmed. Nothing was reported as reverted on-chain.',
        ),
      ).toBeTruthy(),
    );
    expect(screen.getByText('failed')).toBeTruthy();
    expect(screen.queryByText('submission unknown')).toBeNull();
  });
});
