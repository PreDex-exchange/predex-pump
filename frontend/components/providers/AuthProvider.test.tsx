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

import { AuthProvider, useAuth } from './AuthProvider';

const SIGNATURE = `0x${'34'.repeat(65)}` as const;
const mocks = vi.hoisted(() => ({
  address: `0x${'12'.repeat(20)}` as const,
  getSession: vi.fn(),
  getSiweNonce: vi.fn(),
  verifySiwe: vi.fn(),
  signOut: vi.fn(),
  signMessageAsync: vi.fn(),
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
  useAccount: () => ({ address: mocks.address, isConnected: true }),
  useSignMessage: () => ({ signMessageAsync: mocks.signMessageAsync }),
}));

function Consumer() {
  const { session, isLoading, signIn } = useAuth();
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
    </div>
  );
}

function renderAuth(queryClient = new QueryClient()) {
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Consumer />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.getSession.mockReset();
  mocks.getSiweNonce.mockReset();
  mocks.verifySiwe.mockReset();
  mocks.signOut.mockReset();
  mocks.signMessageAsync.mockReset();
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
});
