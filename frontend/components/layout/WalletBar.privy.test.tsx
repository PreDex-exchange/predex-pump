import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WalletBar } from './WalletBar';

const ADDRESS = `0x${'ab'.repeat(20)}`;

const mocks = vi.hoisted(() => ({
  account: {
    address: undefined as string | undefined,
    chainId: 5_042_002,
    connector: undefined as { id: string } | undefined,
    isConnected: false,
  },
  connect: vi.fn(),
  disconnect: vi.fn(),
  clearSession: vi.fn(),
  privy: {
    enabled: true,
    phase: 'idle' as string,
    error: null as Error | null,
    login: vi.fn(),
    cancel: vi.fn(),
    disconnect: vi.fn(),
  },
}));

vi.mock('wagmi', () => ({
  useAccount: () => mocks.account,
  useConnect: () => ({
    connect: mocks.connect,
    connectors: [{ id: 'metaMaskSDK' }],
    error: null,
    isPending: false,
  }),
  useDisconnect: () => ({ disconnect: mocks.disconnect }),
  useReadContract: () => ({ data: 5_000_000n, isLoading: false }),
  useSwitchChain: () => ({ switchChain: vi.fn(), error: null, isPending: false }),
}));

vi.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({ error: null, clearSession: mocks.clearSession }),
}));

vi.mock('@/components/providers/PrivyWalletProvider', () => ({
  usePrivyWallet: () => mocks.privy,
}));

function connectAs(connectorId: string) {
  mocks.account = {
    address: ADDRESS,
    chainId: 5_042_002,
    connector: { id: connectorId },
    isConnected: true,
  };
}

beforeEach(() => {
  mocks.account = {
    address: undefined,
    chainId: 5_042_002,
    connector: undefined,
    isConnected: false,
  };
  mocks.connect.mockReset();
  mocks.disconnect.mockReset();
  mocks.clearSession.mockReset().mockResolvedValue(undefined);
  mocks.privy = {
    enabled: true,
    phase: 'idle',
    error: null,
    login: vi.fn(),
    cancel: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
});

afterEach(cleanup);

describe('WalletBar optional email wallet', () => {
  it('keeps MetaMask primary and hides the email option when Privy is disabled', () => {
    mocks.privy.enabled = false;
    render(<WalletBar />);

    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Connect MetaMask',
    ]);
  });

  it('adds a secondary email option without relabeling MetaMask', () => {
    render(<WalletBar />);

    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Connect MetaMask',
      'Continue with email',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Continue with email' }));
    expect(mocks.privy.login).toHaveBeenCalledOnce();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('cancels any pending email flow before connecting MetaMask', () => {
    render(<WalletBar />);

    fireEvent.click(screen.getByRole('button', { name: 'Connect MetaMask' }));

    expect(mocks.connect).toHaveBeenCalledWith({
      connector: expect.objectContaining({ id: 'metaMaskSDK' }),
    });
    expect(mocks.privy.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.connect.mock.invocationCallOrder[0] as number,
    );
  });

  it.each([
    ['loading', 'Opening email login…'],
    ['authenticating', 'Finish email login…'],
    ['connecting', 'Connecting…'],
    ['restoring', 'Restoring email wallet…'],
    ['disconnecting', 'Signing out…'],
  ])(
    'keeps MetaMask usable and cancels the email flow while Privy is %s',
    (phase, emailLabel) => {
      mocks.privy.phase = phase;
      render(<WalletBar />);

      const buttons = screen.getAllByRole('button') as HTMLButtonElement[];
      expect(buttons.map((button) => button.textContent)).toEqual([
        'Connect MetaMask',
        emailLabel,
      ]);
      expect(buttons.map((button) => button.disabled)).toEqual([false, true]);

      fireEvent.click(screen.getByRole('button', { name: 'Connect MetaMask' }));

      expect(mocks.privy.cancel).toHaveBeenCalledOnce();
      expect(mocks.connect).toHaveBeenCalledWith({
        connector: expect.objectContaining({ id: 'metaMaskSDK' }),
      });
      expect(mocks.privy.cancel.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.connect.mock.invocationCallOrder[0] as number,
      );
    },
  );

  it('shows email wallet errors in the existing feedback slot', () => {
    mocks.privy.error = new Error('Email login did not complete. Try again.');
    render(<WalletBar />);

    expect(screen.getByRole('alert').textContent).toBe(
      'Email login did not complete. Try again.',
    );
  });

  it('signs out of Privy and clears the backend session for the email wallet', () => {
    connectAs('privyEmbedded');
    render(<WalletBar />);

    fireEvent.click(screen.getByRole('button', { name: /Disconnect wallet/u }));

    expect(mocks.privy.disconnect).toHaveBeenCalledOnce();
    expect(mocks.clearSession).toHaveBeenCalledOnce();
    expect(mocks.disconnect).not.toHaveBeenCalled();
  });

  it('keeps MetaMask disconnect independent of Privy', () => {
    connectAs('metaMaskSDK');
    render(<WalletBar />);

    fireEvent.click(screen.getByRole('button', { name: /Disconnect wallet/u }));

    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.clearSession).toHaveBeenCalledOnce();
    expect(mocks.privy.disconnect).not.toHaveBeenCalled();
  });
});
