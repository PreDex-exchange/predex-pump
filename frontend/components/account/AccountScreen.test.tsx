import type { AccountProfileResponse } from '@predex-pump/shared/rest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
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
  ensureSession: vi.fn(),
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: mocks.address, isConnected: mocks.isConnected }),
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
    isEstablishingSession: false,
    error: mocks.authError,
    ensureSession: mocks.ensureSession,
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
  mocks.ensureSession.mockReset().mockResolvedValue(false);
});

afterEach(cleanup);

describe('AccountScreen money states', () => {
  it('keeps the mascot and duplicate auth controls off the disconnected account state', () => {
    const rendered = renderScreen();

    expect(screen.getByText('Connect your wallet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /connect|sign in/iu })).toBeNull();
    expect(rendered.container.querySelector('svg')).toBeNull();
  });

  it('renders normalized signature rejection copy on the account page', () => {
    mocks.isConnected = true;
    mocks.authError = new Error(WALLET_REQUEST_DECLINED_MESSAGE);
    const rendered = renderScreen();

    expect(screen.getByText(WALLET_REQUEST_DECLINED_MESSAGE)).toBeTruthy();
    expect(rendered.container.innerHTML).not.toMatch(/viem|Details:|Version:/u);
  });

  it('asks for SIWE only after a connected user chooses saved account features', () => {
    mocks.isConnected = true;
    renderScreen();

    fireEvent.click(
      screen.getByRole('button', { name: 'Sign in with MetaMask' }),
    );

    expect(mocks.ensureSession).toHaveBeenCalledOnce();
    expect(
      screen.getByText(/trading remains wallet-only/iu),
    ).toBeTruthy();
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

  it('keeps the non-PnL track-record metrics without displaying indexer PnL', () => {
    mocks.authenticated = true;
    mocks.isConnected = true;
    mocks.profileData = {
      behavior: [],
      createdMarkets: [],
      profile: {
        address: ADDRESS,
        createdAt: '2032-01-01T00:00:00.000Z',
        displayName: 'Truthful trader',
        preferences: { rememberRecentlyViewed: true },
        updatedAt: '2032-01-01T00:00:00.000Z',
      },
      recentlyViewed: [],
      trackRecord: {
        dedupSuggestionsAccepted: 0,
        dedupSuggestionsRejected: 0,
        marketsCreated: 11,
        marketsTraded: 12,
        realizedPnlRaw: '12500000',
        tradeCount: 13,
        unrealizedPnlRaw: '-1750000',
        volumeTradedRaw: '45670000',
      },
      tradedMarkets: [],
      watchlist: [],
    };

    renderScreen();

    const trackRecord = screen.getByRole('region', {
      name: 'Indexed track record',
    });
    expect(
      within(trackRecord).getByText('Markets created').parentElement
        ?.textContent,
    ).toBe('Markets created11');
    expect(
      within(trackRecord).getByText('Markets traded').parentElement
        ?.textContent,
    ).toBe('Markets traded12');
    expect(
      within(trackRecord).getByText('Trades').parentElement?.textContent,
    ).toBe('Trades13');
    expect(
      within(trackRecord).getByText('Volume traded').parentElement?.textContent,
    ).toBe('Volume traded45.67 USDC');
    expect(within(trackRecord).queryByText('Estimated total PnL')).toBeNull();
    expect(within(trackRecord).queryByText('+10.75 USDC')).toBeNull();
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
