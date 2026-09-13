// Mocked-SDK tests: '@privy-io/react-auth' is replaced with fakes, so these
// verify configuration and callback mapping only, never a live Privy login.
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PrivyWalletBridge } from './PrivyWalletBridge';
import type { PrivyBridgeHandle, PrivyBridgeSnapshot } from './PrivyWalletProvider';

const ADDRESS = `0x${'ab'.repeat(20)}`;
const OTHER_ADDRESS = `0x${'cd'.repeat(20)}`;

interface LoginCallbacks {
  onComplete?: (params: {
    user: unknown;
    wasAlreadyAuthenticated: boolean;
  }) => void;
  onError?: (error: unknown) => void;
}

const mocks = vi.hoisted(() => ({
  providerProps: null as Record<string, unknown> | null,
  privy: {
    ready: true,
    authenticated: false,
    user: null as unknown,
    logout: vi.fn(),
  },
  wallets: { ready: true, wallets: [] as unknown[] },
  createWallet: vi.fn(),
  login: vi.fn(),
  loginCallbacks: null as unknown,
}));

vi.mock('@privy-io/react-auth', () => ({
  PrivyProvider: ({
    children,
    ...props
  }: { children: ReactNode } & Record<string, unknown>) => {
    mocks.providerProps = props;
    return children;
  },
  useCreateWallet: () => ({ createWallet: mocks.createWallet }),
  useLogin: (callbacks: unknown) => {
    mocks.loginCallbacks = callbacks;
    return { login: mocks.login };
  },
  usePrivy: () => mocks.privy,
  useWallets: () => mocks.wallets,
}));

function embeddedUser() {
  return {
    linkedAccounts: [
      {
        type: 'wallet',
        chainType: 'ethereum',
        walletClientType: 'privy',
        connectorType: 'embedded',
        address: ADDRESS,
      },
    ],
  };
}

function renderBridge() {
  const callbacks = {
    onHandle: vi.fn(),
    onSnapshot: vi.fn(),
    onLoginComplete: vi.fn(),
    onLoginError: vi.fn(),
  };
  render(
    <PrivyWalletBridge
      settings={{ appId: 'test-app-id', clientId: 'test-client-id' }}
      {...callbacks}
    />,
  );
  return callbacks;
}

function latestHandle(onHandle: ReturnType<typeof vi.fn>) {
  const handles = onHandle.mock.calls
    .map(([handle]) => handle as PrivyBridgeHandle | null)
    .filter((handle): handle is PrivyBridgeHandle => handle !== null);
  const handle = handles.at(-1);
  if (!handle) throw new Error('Bridge handle was not registered');
  return handle;
}

function loginCallbacks() {
  return mocks.loginCallbacks as LoginCallbacks;
}

beforeEach(() => {
  mocks.providerProps = null;
  mocks.privy = {
    ready: true,
    authenticated: false,
    user: null,
    logout: vi.fn().mockResolvedValue(undefined),
  };
  mocks.wallets = { ready: true, wallets: [] };
  mocks.createWallet.mockReset().mockResolvedValue({ address: ADDRESS });
  mocks.login.mockReset();
  mocks.loginCallbacks = null;
});

afterEach(cleanup);

describe('PrivyWalletBridge (mocked Privy SDK)', () => {
  it('configures email login with an embedded wallet on Arc only', () => {
    renderBridge();

    const config = mocks.providerProps?.config as {
      loginMethods: string[];
      defaultChain: { id: number };
      supportedChains: Array<{ id: number }>;
      embeddedWallets: { ethereum: { createOnLogin: string } };
    };
    expect(mocks.providerProps).toMatchObject({
      appId: 'test-app-id',
      clientId: 'test-client-id',
    });
    expect(config.loginMethods).toEqual(['email']);
    expect(config.defaultChain.id).toBe(5_042_002);
    expect(config.supportedChains.map(({ id }) => id)).toEqual([5_042_002]);
    expect(config.embeddedWallets.ethereum.createOnLogin).toBe('all-users');
  });

  it('publishes only the embedded wallet and never touches other wallets', async () => {
    const externalProvider = vi.fn();
    const embeddedProvider = { request: vi.fn() };
    mocks.privy.authenticated = true;
    mocks.wallets = {
      ready: true,
      wallets: [
        {
          walletClientType: 'metamask',
          connectorType: 'injected',
          address: OTHER_ADDRESS,
          getEthereumProvider: externalProvider,
        },
        {
          walletClientType: 'privy',
          connectorType: 'embedded',
          address: ADDRESS,
          getEthereumProvider: vi.fn(async () => embeddedProvider),
        },
      ],
    };
    const callbacks = renderBridge();

    const published = callbacks.onSnapshot.mock.lastCall?.[0] as PrivyBridgeSnapshot;
    expect(published).toMatchObject({ ready: true, authenticated: true });
    expect(published.wallet?.address).toBe(ADDRESS);
    await expect(published.wallet?.getEthereumProvider()).resolves.toBe(
      embeddedProvider,
    );
    expect(externalProvider).not.toHaveBeenCalled();
  });

  it('is not ready until Privy wallets are ready', () => {
    mocks.wallets = { ready: false, wallets: [] };
    const callbacks = renderBridge();

    expect(callbacks.onSnapshot.mock.lastCall?.[0]).toMatchObject({
      ready: false,
      wallet: null,
    });
  });

  it('opens Privy login from the handle only when signed out', () => {
    const callbacks = renderBridge();

    act(() => latestHandle(callbacks.onHandle).login());

    expect(mocks.login).toHaveBeenCalledOnce();
    expect(callbacks.onLoginComplete).not.toHaveBeenCalled();
  });

  it('completes a deliberate choice for an existing session without reopening login', () => {
    mocks.privy.authenticated = true;
    mocks.privy.user = embeddedUser();
    const callbacks = renderBridge();

    act(() => latestHandle(callbacks.onHandle).login());

    expect(mocks.login).not.toHaveBeenCalled();
    expect(callbacks.onLoginComplete).toHaveBeenCalledOnce();
  });

  it('ignores resumed-session callbacks and creates a wallet for a user without one', async () => {
    const callbacks = renderBridge();

    act(() =>
      loginCallbacks().onComplete?.({
        user: embeddedUser(),
        wasAlreadyAuthenticated: true,
      }),
    );
    expect(callbacks.onLoginComplete).not.toHaveBeenCalled();

    act(() =>
      loginCallbacks().onComplete?.({
        user: { linkedAccounts: [] },
        wasAlreadyAuthenticated: false,
      }),
    );

    await waitFor(() => expect(callbacks.onLoginComplete).toHaveBeenCalledOnce());
    expect(mocks.createWallet).toHaveBeenCalledOnce();
  });

  it('reports wallet creation failure as a login error', async () => {
    const failure = new Error('creation failed');
    mocks.createWallet.mockRejectedValueOnce(failure);
    const callbacks = renderBridge();

    act(() =>
      loginCallbacks().onComplete?.({
        user: { linkedAccounts: [] },
        wasAlreadyAuthenticated: false,
      }),
    );

    await waitFor(() =>
      expect(callbacks.onLoginError).toHaveBeenCalledWith(failure, false),
    );
    expect(callbacks.onLoginComplete).not.toHaveBeenCalled();
  });

  it('distinguishes a closed login dialog from other login errors', () => {
    const callbacks = renderBridge();

    act(() => loginCallbacks().onError?.('exited_auth_flow'));
    act(() => loginCallbacks().onError?.('network_error'));

    expect(callbacks.onLoginError).toHaveBeenNthCalledWith(
      1,
      'exited_auth_flow',
      true,
    );
    expect(callbacks.onLoginError).toHaveBeenNthCalledWith(
      2,
      'network_error',
      false,
    );
  });

  it('signs out through Privy', async () => {
    const callbacks = renderBridge();

    await latestHandle(callbacks.onHandle).logout();

    expect(mocks.privy.logout).toHaveBeenCalledOnce();
  });
});
