import type { AccountProfileResponse } from '@predex-pump/shared/rest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WALLET_REQUEST_DECLINED_MESSAGE } from '@/lib/wallet-errors';

import { AccountScreen } from './AccountScreen';

const ADDRESS = `0x${'12'.repeat(20)}` as const;

const mocks = vi.hoisted(() => ({
  address: `0x${'12'.repeat(20)}` as const,
  authenticated: false,
  profileData: undefined as AccountProfileResponse | undefined,
  profileError: null as Error | null,
  profileLoading: false,
  sessionLoading: false,
  isConnected: false,
  authError: null as Error | null,
  connect: vi.fn(),
  signIn: vi.fn(),
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: mocks.address, isConnected: mocks.isConnected }),
  useConnect: () => ({
    connect: mocks.connect,
    connectors: [{ id: 'injected' }],
    isPending: false,
  }),
}));

vi.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({
    session: mocks.authenticated
      ? {
          address: mocks.address,
          authenticated: true,
          expiresAt: '2033-01-01T00:00:00.000Z',
        }
      : { authenticated: false },
    isLoading: mocks.sessionLoading,
    isSigningIn: false,
    error: mocks.authError,
    signIn: mocks.signIn,
  }),
}));

vi.mock('@/lib/api/hooks', () => ({
  useAccountProfile: () => ({
    data: mocks.profileData,
    isLoading: mocks.profileLoading,
    error: mocks.profileError,
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
  mocks.authenticated = false;
  mocks.profileData = undefined;
  mocks.profileError = null;
  mocks.profileLoading = false;
  mocks.sessionLoading = false;
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

  it('does not render a backend code identifier as profile-error prose', () => {
    mocks.authenticated = true;
    mocks.isConnected = true;
    mocks.profileError = new Error('marketId must be an unsigned decimal string');

    renderScreen();

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('The account API could not load this profile.');
    expect(alert.textContent).not.toContain('marketId');
  });

  it.each([
    {
      expectedTitle: 'Assembling your profile…',
      prepare: () => {
        mocks.authenticated = true;
        mocks.isConnected = true;
        mocks.profileLoading = true;
      },
      state: 'loading',
    },
    {
      expectedTitle: 'Your profile could not load',
      prepare: () => {
        mocks.authenticated = true;
        mocks.isConnected = true;
        mocks.profileError = new Error('profile unavailable');
      },
      state: 'error',
    },
    {
      expectedTitle: 'No saved markets yet. Open a market and choose Add to watchlist.',
      prepare: () => {
        mocks.authenticated = true;
        mocks.isConnected = true;
        mocks.profileData = {
          behavior: [],
          createdMarkets: [],
          profile: {
            address: ADDRESS,
            createdAt: '2032-01-01T00:00:00.000Z',
            displayName: null,
            preferences: { rememberRecentlyViewed: true },
            updatedAt: '2032-01-01T00:00:00.000Z',
          },
          recentlyViewed: [],
          trackRecord: {
            dedupSuggestionsAccepted: 0,
            dedupSuggestionsRejected: 0,
            marketsCreated: 0,
            marketsTraded: 0,
            realizedPnlRaw: '0',
            tradeCount: 0,
            unrealizedPnlRaw: '0',
            volumeTradedRaw: '0',
          },
          tradedMarkets: [],
          watchlist: [],
        };
      },
      state: 'empty',
    },
  ])('renders the $state state without character art', ({ expectedTitle, prepare }) => {
    prepare();

    const rendered = renderScreen();

    expect(screen.getByText(expectedTitle)).toBeTruthy();
    expect(rendered.container.querySelector('svg')).toBeNull();
  });
});
