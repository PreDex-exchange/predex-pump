import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TxStatus } from '@/components/ui/TxStatus';

import type { TxProgress } from './transactions';
import { useTxFlow } from './useTxFlow';

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
});
