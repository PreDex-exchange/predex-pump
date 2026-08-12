import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackendLiveSync } from './live';

const mocks = vi.hoisted(() => ({
  statusListener: null as
    | ((status: 'idle' | 'connecting' | 'live' | 'reconnecting') => void)
    | null,
  subscribe: vi.fn(() => vi.fn()),
}));

vi.mock('./websocket', () => ({
  backendWsClient: {
    subscribe: mocks.subscribe,
    subscribeStatus: (
      listener: (
        status: 'idle' | 'connecting' | 'live' | 'reconnecting',
      ) => void,
    ) => {
      mocks.statusListener = listener;
      listener('live');
      return vi.fn();
    },
  },
}));

afterEach(() => {
  cleanup();
  mocks.statusListener = null;
  mocks.subscribe.mockClear();
});

describe('BackendLiveSync reconnect recovery', () => {
  it('discloses stale data and refetches every active query before clearing recovery', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let finishCatchUp: (() => void) | undefined;
    const catchUp = new Promise<void>((resolve) => {
      finishCatchUp = resolve;
    });
    const refetch = vi
      .spyOn(queryClient, 'refetchQueries')
      .mockReturnValue(catchUp);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );
    render(<BackendLiveSync />, { wrapper });

    act(() => mocks.statusListener?.('reconnecting'));
    expect(screen.getByRole('status').textContent).toContain(
      'Live data reconnecting',
    );
    expect(screen.getByRole('status').textContent).toContain('may be stale');

    act(() => mocks.statusListener?.('live'));
    expect(refetch).toHaveBeenCalledWith({ type: 'active' });
    expect(screen.getByRole('status').textContent).toContain(
      'Catching up live data',
    );

    await act(async () => {
      finishCatchUp?.();
      await catchUp;
    });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
