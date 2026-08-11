import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WALLET_REQUEST_DECLINED_MESSAGE } from '@/lib/wallet-errors';

import { AccountScreen } from './AccountScreen';

const mocks = vi.hoisted(() => ({
  isConnected: false,
  authError: null as Error | null,
  connect: vi.fn(),
  signIn: vi.fn(),
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: mocks.isConnected }),
  useConnect: () => ({
    connect: mocks.connect,
    connectors: [{ id: 'injected' }],
    isPending: false,
  }),
}));

vi.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({
    session: { authenticated: false },
    isLoading: false,
    isSigningIn: false,
    error: mocks.authError,
    signIn: mocks.signIn,
  }),
}));

vi.mock('@/lib/api/hooks', () => ({
  useAccountProfile: () => ({
    data: undefined,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/lib/api/rest-client', () => ({
  backendRestClient: { updateAccountProfile: vi.fn() },
}));

vi.mock('@/components/feed/MarketCard', () => ({ MarketCard: () => null }));
vi.mock('./GatewayDepositPanel', () => ({ GatewayDepositPanel: () => null }));

function renderScreen() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AccountScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.isConnected = false;
  mocks.authError = null;
  mocks.connect.mockReset();
  mocks.signIn.mockReset();
});

afterEach(cleanup);

describe('AccountScreen money states', () => {
  it('keeps the mascot off the signed-out account state', () => {
    const rendered = renderScreen();

    expect(screen.getByText('Connect, then sign in')).toBeTruthy();
    expect(rendered.container.querySelector('svg')).toBeNull();
  });

  it('renders normalized signature rejection copy on the account page', () => {
    mocks.isConnected = true;
    mocks.authError = new Error(WALLET_REQUEST_DECLINED_MESSAGE);
    const rendered = renderScreen();

    expect(screen.getByText(WALLET_REQUEST_DECLINED_MESSAGE)).toBeTruthy();
    expect(rendered.container.innerHTML).not.toMatch(/viem|Details:|Version:/u);
  });
});
