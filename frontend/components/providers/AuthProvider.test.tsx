import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
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
const mocks = vi.hoisted(() => ({
  address: `0x${'12'.repeat(20)}` as const,
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
const ADDRESS = mocks.address;
const authenticated = {
  authenticated: true as const,
  address: ADDRESS,
  expiresAt: '2026-08-08T00:00:00.000Z',
};

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

function Consumer() {
  const { session, isLoading, error, signIn } = useAuth();
  return (
    <div>
      <span>
        {isLoading
          ? 'loading'
          : session?.authenticated
            ? `signed:${session.address}`
            : 'anonymous'}
      </span>
      <button onClick={() => void signIn()} type="button">
        sign
      </button>
      {error && <span role="alert">{error.message}</span>}
    </div>
  );
}

function AuthTree({
  queryClient,
  showHeader,
}: {
  queryClient: QueryClient;
  showHeader: boolean;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Consumer />
        {showHeader && <WalletBar />}
      </AuthProvider>
    </QueryClientProvider>
  );
}

function renderAuth(queryClient = new QueryClient(), showHeader = false) {
  return render(<AuthTree queryClient={queryClient} showHeader={showHeader} />);
}

beforeEach(() => {
  mocks.isConnected = true;
  mocks.getSession.mockReset();
  mocks.getSiweNonce.mockReset();
  mocks.verifySiwe.mockReset();
  mocks.signOut.mockReset();
  mocks.signMessageAsync.mockReset();
  mocks.connect.mockReset();
  mocks.disconnect.mockReset();
  mocks.switchChain.mockReset();
});

afterEach(cleanup);

describe('AuthProvider', () => {
  it('restores the HttpOnly-cookie session after a browser-provider reload', async () => {
    mocks.getSession.mockResolvedValue(authenticated);
    const first = renderAuth();
    await screen.findByText(`signed:${ADDRESS}`);
    first.unmount();

    renderAuth(new QueryClient());
    await screen.findByText(`signed:${ADDRESS}`);
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
  });

  it('creates the server-issued EIP-4361 message and saves the verified session', async () => {
    mocks.getSession.mockResolvedValue({ authenticated: false });
    mocks.getSiweNonce.mockResolvedValue({
      nonce: 'a1b2c3d4e5f6',
      domain: 'localhost:3000',
      uri: 'http://localhost:3000',
      chainId: 5_042_002,
      statement:
        'Sign in to predex.fun to save your profile, watchlist, and recent activity. Trading stays wallet-only.',
      issuedAt: '2026-08-01T00:00:00.000Z',
      expirationTime: '2026-08-01T00:05:00.000Z',
    });
    mocks.signMessageAsync.mockResolvedValue(SIGNATURE);
    mocks.verifySiwe.mockResolvedValue(authenticated);
    renderAuth();
    await screen.findByText('anonymous');

    fireEvent.click(screen.getByRole('button', { name: 'sign' }));
    await waitFor(() => expect(mocks.verifySiwe).toHaveBeenCalledOnce());
    const request = mocks.verifySiwe.mock.calls[0]?.[0] as {
      message: string;
      signature: string;
    };
    expect(request.signature).toBe(SIGNATURE);
    expect(parseSiweMessage(request.message)).toMatchObject({
      address: ADDRESS,
      chainId: 5_042_002,
      domain: 'localhost:3000',
      nonce: 'a1b2c3d4e5f6',
      uri: 'http://localhost:3000',
      version: '1',
    });
    await screen.findByText(`signed:${ADDRESS}`);
  });

  it('renders a rejected wallet signature as safe copy on the page and header', async () => {
    const rawProviderMessage =
      'User rejected the request. Details: User rejected the request. Version: viem@2.55.8';
    mocks.getSession.mockResolvedValue({ authenticated: false });
    mocks.getSiweNonce.mockResolvedValue({
      nonce: 'a1b2c3d4e5f6',
      domain: 'localhost:3000',
      uri: 'http://localhost:3000',
      chainId: 5_042_002,
      statement: 'Sign in to predex.fun.',
      issuedAt: '2026-08-01T00:00:00.000Z',
      expirationTime: '2026-08-01T00:05:00.000Z',
    });
    mocks.signMessageAsync.mockRejectedValue(
      Object.assign(new Error(rawProviderMessage), {
        cause: { code: 4001, message: rawProviderMessage },
      }),
    );
    const rendered = renderAuth(new QueryClient(), true);
    await screen.findByText('anonymous');

    fireEvent.click(screen.getByRole('button', { name: 'sign' }));

    await waitFor(() =>
      expect(screen.getAllByText(WALLET_REQUEST_DECLINED_MESSAGE)).toHaveLength(2),
    );
    expect(rendered.container.innerHTML).not.toMatch(
      /viem|Details:|Version:|2\.55\.8/u,
    );
  });

  it('names destructive header controls by their actions', async () => {
    mocks.getSession.mockResolvedValue(authenticated);
    renderAuth(new QueryClient(), true);

    await screen.findByText(`signed:${ADDRESS}`);
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: /Disconnect wallet\. 0x1212…212, 5\.00 USDC/u,
      }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Signed in' })).toBeNull();
  });

  it('states that the saved session survives a wallet disconnect', async () => {
    const queryClient = new QueryClient();
    mocks.getSession.mockResolvedValue(authenticated);
    mocks.disconnect.mockImplementation(() => {
      mocks.isConnected = false;
    });
    const rendered = renderAuth(queryClient, true);
    await screen.findByText(`signed:${ADDRESS}`);

    fireEvent.click(
      screen.getByRole('button', { name: /Disconnect wallet/u }),
    );
    rendered.rerender(
      <AuthTree queryClient={queryClient} showHeader />,
    );

    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Reconnect wallet' }),
    ).toBeTruthy();
    expect(screen.getByText(/Session saved/u).textContent).toContain(
      '0x1212…212',
    );
    expect(
      screen.getByRole('button', {
        name: `Sign out saved session for ${ADDRESS}`,
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Connect wallet' }),
    ).toBeNull();
  });
});
