import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TxStatus } from '@/components/ui/TxStatus';

import { useTxFlow } from './useTxFlow';

vi.mock('./transactions', () => ({
  chainErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : 'Order rejected.',
}));

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
    expect(screen.getByText('Order expired before it was accepted.')).toBeTruthy();
    expect(screen.queryByText('The transaction did not complete.')).toBeNull();
  });
});
