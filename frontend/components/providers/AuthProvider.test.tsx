import type { SessionResponse } from '@predex-pump/shared/rest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { parseSiweMessage } from 'viem/siwe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WalletBar } from '@/components/layout/WalletBar';
import { WALLET_REQUEST_DECLINED_MESSAGE } from '@/lib/wallet-errors';

import { AuthProvider, useAuth } from './AuthProvider';

const SIGNATURE = `0x${'34'.repeat(65)}` as const;
const FIRST_ADDRESS = `0x${'12'.repeat(20)}` as const;
const SECOND_ADDRESS = `0x${'56'.repeat(20)}` as const;
const mocks = vi.hoisted(() => ({
  address: `0x${'12'.repeat(20)}` as `0x${string}`,
  isConnected: true,
  getSession: vi.fn(),
  getSiweNonce: vi.fn(),
  verifySiwe: vi.fn(),
  signOut: vi.fn(),
  signMessageAsync: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  switchChain: vi.fn(),
}));

function authenticatedSession(address = mocks.address) {
  return {
    authenticated: true as const,
    address,
    expiresAt: '2026-08-28T00:00:00.000Z',
  };
}

function siweNonce() {
  return {
    nonce: 'a1b2c3d4e5f6',
    domain: 'localhost:3000',
    uri: 'http://localhost:3000',
    chainId: 5_042_002,
    statement:
      'Sign in to predex.fun to save your profile, watchlist, and recent activity. Trading stays wallet-only.',
    issuedAt: '2026-08-01T00:00:00.000Z',
    expirationTime: '2026-08-01T00:05:00.000Z',
  };
}

vi.mock('@/lib/api/rest-client', () => ({
  backendRestClient: {
    getSession: mocks.getSession,
    getSiweNonce: mocks.getSiweNonce,
    verifySiwe: mocks.verifySiwe,
    signOut: mocks.signOut,
  },
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: mocks.isConnected ? mocks.address : undefined,
    chainId: 5_042_002,
    isConnected: mocks.isConnected,
    status: mocks.isConnected ? 'connected' : 'disconnected',
  }),
  useConnect: () => ({
    connect: mocks.connect,
    connectors: [{ id: 'injected' }],
    error: null,
    isPending: false,
  }),
  useDisconnect: () => ({ disconnect: mocks.disconnect }),
  useReadContract: () => ({ data: 5_000_000n, isLoading: false }),
  useSignMessage: () => ({ signMessageAsync: mocks.signMessageAsync }),
  useSwitchChain: () => ({
    switchChain: mocks.switchChain,
    error: null,
    isPending: false,
  }),
}));

function Consumer({ showFeatureAction = false }: { showFeatureAction?: boolean }) {
  const { session, isLoading, error, ensureSession } = useAuth();
  return (
    <div>
      <span>
        {isLoading
          ? 'loading'
          : session?.authenticated
            ? `signed:${session.address}`
            : 'anonymous'}
      </span>
      {showFeatureAction && (
        <button onClick={() => void ensureSession()} type="button">
          Use saved feature
        </button>
      )}
      {error && <span role="alert">{error.message}</span>}
    </div>
  );
}

function AuthTree({
  queryClient,
  showFeatureAction = false,
  showHeader = false,
}: {
  queryClient: QueryClient;
  showFeatureAction?: boolean;
  showHeader?: boolean;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Consumer showFeatureAction={showFeatureAction} />
        {showHeader && <WalletBar />}
      </AuthProvider>
    </QueryClientProvider>
  );
}

function renderAuth({
  queryClient = new QueryClient(),
  showFeatureAction = false,
  showHeader = false,
}: {
  queryClient?: QueryClient;
  showFeatureAction?: boolean;
  showHeader?: boolean;
} = {}) {
  return {
    queryClient,
    rendered: render(
      <AuthTree
        queryClient={queryClient}
        showFeatureAction={showFeatureAction}
        showHeader={showHeader}
      />,
    ),
  };
}

beforeEach(() => {
  mocks.address = FIRST_ADDRESS;
  mocks.isConnected = true;
  mocks.getSession.mockReset();
  mocks.getSiweNonce.mockReset().mockResolvedValue(siweNonce());
  mocks.verifySiwe.mockReset();
  mocks.signOut
    .mockReset()
    .mockResolvedValue({ authenticated: false } satisfies SessionResponse);
  mocks.signMessageAsync.mockReset();
  mocks.connect.mockReset();
  mocks.disconnect.mockReset();
  mocks.switchChain.mockReset();
});

afterEach(cleanup);

describe('AuthProvider wallet-bound sessions', () => {
  it('restores a matching HttpOnly-cookie session without requesting a signature', async () => {
    mocks.getSession.mockResolvedValue(authenticatedSession());
    const first = renderAuth().rendered;
    await screen.findByText(`signed:${FIRST_ADDRESS}`);
    first.unmount();

    renderAuth({ queryClient: new QueryClient() });
    await screen.findByText(`signed:${FIRST_ADDRESS}`);
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
    expect(mocks.signMessageAsync).not.toHaveBeenCalled();
  });

  it('shows exactly one disconnected auth action during load and after it resolves', async () => {
    mocks.isConnected = false;
    mocks.getSession.mockResolvedValue({ authenticated: false });
    renderAuth({ showHeader: true });

    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(
      screen.getByRole('button', { name: 'Connect wallet' }),
    ).toBeTruthy();
    expect(screen.queryByText(/checking sign-in|sign in|sign out/iu)).toBeNull();

    await screen.findByText('anonymous');
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(
      screen.getByRole('button', { name: 'Connect wallet' }),
    ).toBeTruthy();
  });

  it('automatically creates and saves the server-issued EIP-4361 session', async () => {
    mocks.getSession.mockResolvedValue({ authenticated: false });
    mocks.signMessageAsync.mockResolvedValue(SIGNATURE);
    mocks.verifySiwe.mockResolvedValue(authenticatedSession());
    renderAuth();

    await screen.findByText(`signed:${FIRST_ADDRESS}`);
    expect(mocks.getSiweNonce).toHaveBeenCalledOnce();
    expect(mocks.signMessageAsync).toHaveBeenCalledOnce();
    expect(mocks.verifySiwe).toHaveBeenCalledOnce();
    const request = mocks.verifySiwe.mock.calls[0]?.[0] as {
      message: string;
      signature: string;
    };
    expect(request.signature).toBe(SIGNATURE);
    expect(parseSiweMessage(request.message)).toMatchObject({
      address: FIRST_ADDRESS,
      chainId: 5_042_002,
      domain: 'localhost:3000',
      nonce: 'a1b2c3d4e5f6',
      uri: 'http://localhost:3000',
      version: '1',
    });
  });

  it('keeps a declined wallet connected and does not retry on render, refetch, or reconnect', async () => {
    const rawProviderMessage =
      'User rejected the request. Details: User rejected the request. Version: viem@2.55.8';
    mocks.getSession.mockResolvedValue({ authenticated: false });
    mocks.signMessageAsync.mockRejectedValue(
      Object.assign(new Error(rawProviderMessage), {
        cause: { code: 4001, message: rawProviderMessage },
      }),
    );
    const { queryClient, rendered } = renderAuth({ showHeader: true });

    await waitFor(() =>
      expect(screen.getAllByText(WALLET_REQUEST_DECLINED_MESSAGE)).toHaveLength(2),
    );
    expect(
      screen.getByRole('button', { name: /Disconnect wallet/u }),
    ).toBeTruthy();
    expect(rendered.container.innerHTML).not.toMatch(
      /viem|Details:|Version:|2\.55\.8/u,
    );

    rendered.rerender(
      <AuthTree queryClient={queryClient} showHeader />,
    );
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['auth-session'] });
    });
    mocks.isConnected = false;
    rendered.rerender(
      <AuthTree queryClient={queryClient} showHeader />,
    );
    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledOnce());
    mocks.isConnected = true;
    rendered.rerender(
      <AuthTree queryClient={queryClient} showHeader />,
    );

    await waitFor(() => expect(screen.getByText('anonymous')).toBeTruthy());
    expect(mocks.getSiweNonce).toHaveBeenCalledOnce();
    expect(mocks.signMessageAsync).toHaveBeenCalledOnce();
    expect(mocks.verifySiwe).not.toHaveBeenCalled();
  });

  it('allows a saved feature to retry after an automatic signature was declined', async () => {
    mocks.getSession.mockResolvedValue({ authenticated: false });
    mocks.signMessageAsync
      .mockRejectedValueOnce(Object.assign(new Error('declined'), { code: 4001 }))
      .mockResolvedValueOnce(SIGNATURE);
    mocks.verifySiwe.mockResolvedValue(authenticatedSession());
    renderAuth({ showFeatureAction: true });

    await screen.findByText(WALLET_REQUEST_DECLINED_MESSAGE);
    fireEvent.click(screen.getByRole('button', { name: 'Use saved feature' }));

    await screen.findByText(`signed:${FIRST_ADDRESS}`);
    expect(mocks.signMessageAsync).toHaveBeenCalledTimes(2);
    expect(mocks.verifySiwe).toHaveBeenCalledOnce();
  });

  it('hides an old session immediately and replaces it after an account switch', async () => {
    mocks.getSession.mockResolvedValue(authenticatedSession(FIRST_ADDRESS));
    mocks.signMessageAsync.mockResolvedValue(SIGNATURE);
    const { queryClient, rendered } = renderAuth();
    await screen.findByText(`signed:${FIRST_ADDRESS}`);

    mocks.address = SECOND_ADDRESS;
    mocks.verifySiwe.mockResolvedValue(authenticatedSession(SECOND_ADDRESS));
    rendered.rerender(<AuthTree queryClient={queryClient} />);

    expect(screen.queryByText(`signed:${FIRST_ADDRESS}`)).toBeNull();
    await screen.findByText(`signed:${SECOND_ADDRESS}`);
    expect(mocks.signOut).toHaveBeenCalledOnce();
    expect(mocks.getSiweNonce).toHaveBeenCalledOnce();
    expect(mocks.signOut.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.getSiweNonce.mock.invocationCallOrder[0] as number,
    );
    const request = mocks.verifySiwe.mock.calls[0]?.[0] as { message: string };
    expect(parseSiweMessage(request.message).address).toBe(SECOND_ADDRESS);
  });

  it('clears the server session whenever the wallet control disconnects', async () => {
    mocks.getSession.mockResolvedValue(authenticatedSession());
    renderAuth({ showHeader: true });
    await screen.findByText(`signed:${FIRST_ADDRESS}`);

    fireEvent.click(
      screen.getByRole('button', { name: /Disconnect wallet/u }),
    );

    await screen.findByText('anonymous');
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.signOut).toHaveBeenCalledOnce();
    expect(mocks.signMessageAsync).not.toHaveBeenCalled();
  });

  it('never exposes or preserves an orphaned session without a wallet', async () => {
    mocks.isConnected = false;
    mocks.getSession.mockResolvedValue(authenticatedSession());
    renderAuth({ showHeader: true });

    await screen.findByText('anonymous');
    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledOnce());
    expect(
      screen.getByRole('button', { name: 'Connect wallet' }),
    ).toBeTruthy();
    expect(screen.queryByText(FIRST_ADDRESS)).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});
