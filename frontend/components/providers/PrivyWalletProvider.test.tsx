// Mocked-SDK orchestration tests: a fake bridge replaces the Privy SDK and the
// wagmi adapter is mocked. No live Privy login or Arc transaction is exercised.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useEffect } from 'react';
import type { EIP1193Provider } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WalletBar } from '@/components/layout/WalletBar';

import {
  PrivyWalletProvider,
  usePrivyWallet,
  type PrivyBridgeSnapshot,
  type PrivyWalletBridgeProps,
} from './PrivyWalletProvider';

const ADDRESS = `0x${'ab'.repeat(20)}`;
const PROVIDER = { request: vi.fn() } as unknown as EIP1193Provider;
const PRIVY_UNAVAILABLE =
  'Email login is unavailable right now. MetaMask still works.';

const mocks = vi.hoisted(() => ({
  config: { test: true },
  account: {
    status: 'disconnected',
    address: undefined as string | undefined,
    connector: undefined as { id: string } | undefined,
  },
  accountListeners: new Set<() => void>(),
  selected: false,
  connectPrivyWallet: vi.fn(),
  disconnectPrivyWallet: vi.fn(),
  rememberPrivySelection: vi.fn(),
  forgetPrivySelection: vi.fn(),
  bridgeProps: null as unknown,
  handle: { login: vi.fn(), logout: vi.fn() },
  connectMetaMask: vi.fn(),
  productMounts: 0,
}));

// WalletBar hooks are stubbed so the real header control can be exercised
// against the provider while wagmi stays disconnected.
vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: undefined,
    chainId: 5_042_002,
    connector: undefined,
    isConnected: false,
  }),
  useConfig: () => mocks.config,
  useConnect: () => ({
    connect: mocks.connectMetaMask,
    connectors: [{ id: 'metaMaskSDK' }],
    error: null,
    isPending: false,
  }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useReadContract: () => ({ data: undefined, isLoading: false }),
  useSwitchChain: () => ({ switchChain: vi.fn(), error: null, isPending: false }),
}));

vi.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({ error: null, clearSession: vi.fn() }),
}));

vi.mock('wagmi/actions', () => ({
  getAccount: () => mocks.account,
  watchAccount: (_config: unknown, { onChange }: { onChange: () => void }) => {
    mocks.accountListeners.add(onChange);
    return () => {
      mocks.accountListeners.delete(onChange);
    };
  },
}));

vi.mock('@/lib/chain/privy-wallet', () => ({
  connectPrivyWallet: mocks.connectPrivyWallet,
  disconnectPrivyWallet: mocks.disconnectPrivyWallet,
  forgetPrivySelection: mocks.forgetPrivySelection,
  hasPrivySelection: () => mocks.selected,
  privySettings: null,
  rememberPrivySelection: mocks.rememberPrivySelection,
}));

function FakeBridge(props: PrivyWalletBridgeProps) {
  const { onHandle } = props;
  useEffect(() => {
    mocks.bridgeProps = props;
  });
  useEffect(() => {
    onHandle(mocks.handle);
    return () => onHandle(null);
  }, [onHandle]);
  return null;
}

const loadBridge = vi.fn(async () => FakeBridge);

function ThrowingBridge(): null {
  throw new Error('sdk render failed');
}

function Consumer() {
  const wallet = usePrivyWallet();
  return (
    <div>
      <span data-testid="phase">
        {wallet.enabled ? wallet.phase : 'disabled'}
      </span>
      {wallet.error && <span role="alert">{wallet.error.message}</span>}
      <button onClick={wallet.login} type="button">
        Email
      </button>
      <button onClick={wallet.cancel} type="button">
        Choose MetaMask
      </button>
      <button onClick={() => void wallet.disconnect()} type="button">
        Disconnect
      </button>
    </div>
  );
}

function renderWallet(settings: { appId: string } | null = { appId: 'test-app-id' }) {
  return render(
    <PrivyWalletProvider loadBridge={loadBridge} settings={settings}>
      <Consumer />
    </PrivyWalletProvider>,
  );
}

function Product() {
  useEffect(() => {
    mocks.productMounts += 1;
  }, []);
  return (
    <>
      <Consumer />
      <WalletBar />
    </>
  );
}

function renderProduct() {
  return render(
    <PrivyWalletProvider loadBridge={loadBridge} settings={{ appId: 'test-app-id' }}>
      <Product />
    </PrivyWalletProvider>,
  );
}

function metaMaskButton() {
  return screen.getByRole('button', {
    name: 'Connect MetaMask',
  }) as HTMLButtonElement;
}

function phase() {
  return screen.getByTestId('phase').textContent;
}

function snapshot(
  overrides: Partial<PrivyBridgeSnapshot> = {},
): PrivyBridgeSnapshot {
  return { ready: true, authenticated: false, wallet: null, ...overrides };
}

function embeddedWallet(
  getEthereumProvider: () => Promise<EIP1193Provider> = vi.fn(
    async () => PROVIDER,
  ),
) {
  return { address: ADDRESS, getEthereumProvider };
}

async function emit(action: (props: PrivyWalletBridgeProps) => void) {
  await waitFor(() => expect(mocks.bridgeProps).not.toBeNull());
  await act(async () => {
    action(mocks.bridgeProps as PrivyWalletBridgeProps);
  });
}

async function startLogin() {
  fireEvent.click(screen.getByRole('button', { name: 'Email' }));
  await waitFor(() => expect(loadBridge).toHaveBeenCalledOnce());
  await emit((props) => props.onSnapshot(snapshot()));
}

async function restoreConnected() {
  mocks.selected = true;
  renderWallet();
  await emit((props) =>
    props.onSnapshot(
      snapshot({ authenticated: true, wallet: embeddedWallet() }),
    ),
  );
  await waitFor(() => expect(mocks.rememberPrivySelection).toHaveBeenCalled());
  mocks.account = {
    status: 'connected',
    address: ADDRESS,
    connector: { id: 'privyEmbedded' },
  };
}

beforeEach(() => {
  mocks.account = {
    status: 'disconnected',
    address: undefined,
    connector: undefined,
  };
  mocks.accountListeners.clear();
  mocks.selected = false;
  mocks.connectPrivyWallet.mockReset().mockResolvedValue('connected');
  mocks.disconnectPrivyWallet.mockReset().mockResolvedValue(undefined);
  mocks.rememberPrivySelection.mockReset();
  mocks.forgetPrivySelection.mockReset();
  mocks.bridgeProps = null;
  mocks.handle.login.mockReset();
  mocks.handle.logout.mockReset().mockResolvedValue(undefined);
  mocks.connectMetaMask.mockReset();
  mocks.productMounts = 0;
  loadBridge.mockClear();
});

afterEach(cleanup);

describe('PrivyWalletProvider (mocked Privy SDK)', () => {
  it('renders the app without loading Privy when no App ID is configured', () => {
    renderWallet(null);

    expect(phase()).toBe('disabled');
    fireEvent.click(screen.getByRole('button', { name: 'Email' }));
    expect(loadBridge).not.toHaveBeenCalled();
  });

  it('does not load Privy or prompt on page load without a remembered choice', async () => {
    renderWallet();
    await act(async () => {
      await Promise.resolve();
    });

    expect(loadBridge).not.toHaveBeenCalled();
    expect(mocks.handle.login).not.toHaveBeenCalled();
    expect(phase()).toBe('idle');
  });

  it('opens login only after the deliberate action, then attaches the embedded wallet', async () => {
    renderWallet();
    await startLogin();

    expect(mocks.handle.login).toHaveBeenCalledOnce();
    expect(phase()).toBe('authenticating');

    await emit((props) => {
      props.onSnapshot(
        snapshot({ authenticated: true, wallet: embeddedWallet() }),
      );
      props.onLoginComplete();
    });

    await waitFor(() =>
      expect(mocks.connectPrivyWallet).toHaveBeenCalledWith(
        mocks.config,
        PROVIDER,
        expect.any(Function),
      ),
    );
    await waitFor(() =>
      expect(mocks.rememberPrivySelection).toHaveBeenCalledOnce(),
    );
    expect(phase()).toBe('idle');
    expect(mocks.handle.login).toHaveBeenCalledOnce();
  });

  it('treats a closed email dialog as a silent cancellation', async () => {
    renderWallet();
    await startLogin();

    await emit((props) => props.onLoginError('exited_auth_flow', true));
    await emit((props) =>
      props.onSnapshot(
        snapshot({ authenticated: true, wallet: embeddedWallet() }),
      ),
    );

    expect(screen.queryByRole('alert')).toBeNull();
    expect(phase()).toBe('idle');
    expect(mocks.connectPrivyWallet).not.toHaveBeenCalled();
  });

  it('shows safe copy instead of raw SDK errors when login fails', async () => {
    renderWallet();
    await startLogin();

    await emit((props) =>
      props.onLoginError(new Error('raw sdk detail https://auth'), false),
    );

    expect(screen.getByRole('alert').textContent).toBe(
      'Email login did not complete. Try again.',
    );
    expect(phase()).toBe('idle');
  });

  it('ignores a provider that resolves after the user chooses MetaMask', async () => {
    let resolveProvider: ((provider: EIP1193Provider) => void) | undefined;
    const getEthereumProvider = vi.fn(
      () =>
        new Promise<EIP1193Provider>((resolve) => {
          resolveProvider = resolve;
        }),
    );
    renderWallet();
    await startLogin();
    await emit((props) => {
      props.onSnapshot(
        snapshot({
          authenticated: true,
          wallet: embeddedWallet(getEthereumProvider),
        }),
      );
      props.onLoginComplete();
    });
    await waitFor(() => expect(getEthereumProvider).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: 'Choose MetaMask' }));
    await act(async () => {
      resolveProvider?.(PROVIDER);
    });

    expect(mocks.connectPrivyWallet).not.toHaveBeenCalled();
    expect(mocks.rememberPrivySelection).not.toHaveBeenCalled();
    expect(phase()).toBe('idle');
  });

  it('restores a remembered email wallet without opening login', async () => {
    await restoreConnected();

    expect(loadBridge).toHaveBeenCalledOnce();
    expect(mocks.connectPrivyWallet).toHaveBeenCalledOnce();
    expect(mocks.handle.login).not.toHaveBeenCalled();
  });

  it('waits for wagmi hydration and never replaces a restored MetaMask session', async () => {
    mocks.selected = true;
    mocks.account = { status: 'reconnecting', address: undefined, connector: undefined };
    renderWallet();
    await emit((props) =>
      props.onSnapshot(
        snapshot({ authenticated: true, wallet: embeddedWallet() }),
      ),
    );
    expect(mocks.connectPrivyWallet).not.toHaveBeenCalled();

    mocks.account = {
      status: 'connected',
      address: `0x${'cd'.repeat(20)}`,
      connector: { id: 'metaMaskSDK' },
    };
    act(() => mocks.accountListeners.forEach((listener) => listener()));

    expect(mocks.connectPrivyWallet).not.toHaveBeenCalled();
    expect(mocks.forgetPrivySelection).toHaveBeenCalledOnce();
    expect(phase()).toBe('idle');
  });

  it('resumes the remembered wallet once wagmi hydration settles disconnected', async () => {
    mocks.selected = true;
    mocks.account = { status: 'reconnecting', address: undefined, connector: undefined };
    renderWallet();
    await emit((props) =>
      props.onSnapshot(
        snapshot({ authenticated: true, wallet: embeddedWallet() }),
      ),
    );

    mocks.account = { status: 'disconnected', address: undefined, connector: undefined };
    act(() => mocks.accountListeners.forEach((listener) => listener()));

    await waitFor(() =>
      expect(mocks.connectPrivyWallet).toHaveBeenCalledOnce(),
    );
  });

  it('quietly drops a remembered choice when the Privy session is gone', async () => {
    mocks.selected = true;
    renderWallet();
    await emit((props) => props.onSnapshot(snapshot()));

    expect(mocks.forgetPrivySelection).toHaveBeenCalledOnce();
    expect(mocks.handle.login).not.toHaveBeenCalled();
    expect(mocks.connectPrivyWallet).not.toHaveBeenCalled();
    expect(phase()).toBe('idle');
  });

  it('logout disconnects wagmi before Privy and forgets the choice', async () => {
    await restoreConnected();

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(mocks.handle.logout).toHaveBeenCalledOnce());

    expect(mocks.disconnectPrivyWallet).toHaveBeenCalledWith(mocks.config);
    expect(
      mocks.disconnectPrivyWallet.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.handle.logout.mock.invocationCallOrder[0] as number);
    expect(mocks.forgetPrivySelection).toHaveBeenCalled();
    await waitFor(() => expect(phase()).toBe('idle'));
  });

  it('detaches the wallet when the Privy session ends outside the app', async () => {
    await restoreConnected();

    await emit((props) => props.onSnapshot(snapshot()));

    expect(mocks.disconnectPrivyWallet).toHaveBeenCalledOnce();
    expect(mocks.forgetPrivySelection).toHaveBeenCalledOnce();
  });

  it('keeps MetaMask usable when the Privy chunk cannot load', async () => {
    loadBridge.mockRejectedValueOnce(new Error('chunk failed'));
    renderWallet();

    fireEvent.click(screen.getByRole('button', { name: 'Email' }));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      PRIVY_UNAVAILABLE,
    );
    expect(phase()).toBe('idle');
  });

  it('keeps the real MetaMask button usable during a slow SDK load and ignores the late bridge', async () => {
    let resolveBridge: ((bridge: typeof FakeBridge) => void) | undefined;
    loadBridge.mockImplementationOnce(
      () =>
        new Promise<typeof FakeBridge>((resolve) => {
          resolveBridge = resolve;
        }),
    );
    renderProduct();

    fireEvent.click(screen.getByRole('button', { name: 'Continue with email' }));
    await waitFor(() => expect(phase()).toBe('loading'));
    expect(metaMaskButton().disabled).toBe(false);

    fireEvent.click(metaMaskButton());
    expect(mocks.connectMetaMask).toHaveBeenCalledWith({
      connector: expect.objectContaining({ id: 'metaMaskSDK' }),
    });
    expect(phase()).toBe('idle');

    await act(async () => {
      resolveBridge?.(FakeBridge);
    });
    await emit((props) =>
      props.onSnapshot(
        snapshot({ authenticated: true, wallet: embeddedWallet() }),
      ),
    );

    expect(mocks.handle.login).not.toHaveBeenCalled();
    expect(mocks.connectPrivyWallet).not.toHaveBeenCalled();
    expect(mocks.rememberPrivySelection).not.toHaveBeenCalled();
  });

  it('keeps the real MetaMask button usable while login and the provider are pending', async () => {
    let resolveProvider: ((provider: EIP1193Provider) => void) | undefined;
    const getEthereumProvider = vi.fn(
      () =>
        new Promise<EIP1193Provider>((resolve) => {
          resolveProvider = resolve;
        }),
    );
    renderProduct();

    fireEvent.click(screen.getByRole('button', { name: 'Continue with email' }));
    await emit((props) => props.onSnapshot(snapshot()));
    expect(phase()).toBe('authenticating');
    expect(metaMaskButton().disabled).toBe(false);

    await emit((props) => {
      props.onSnapshot(
        snapshot({
          authenticated: true,
          wallet: embeddedWallet(getEthereumProvider),
        }),
      );
      props.onLoginComplete();
    });
    await waitFor(() => expect(getEthereumProvider).toHaveBeenCalledOnce());
    expect(phase()).toBe('connecting');
    expect(metaMaskButton().disabled).toBe(false);

    fireEvent.click(metaMaskButton());
    await act(async () => {
      resolveProvider?.(PROVIDER);
    });

    expect(mocks.connectMetaMask).toHaveBeenCalledOnce();
    expect(mocks.connectPrivyWallet).not.toHaveBeenCalled();
    expect(mocks.rememberPrivySelection).not.toHaveBeenCalled();
    expect(phase()).toBe('idle');
  });

  it('retries a bridge that crashed while rendering without remounting the app', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      loadBridge.mockResolvedValueOnce(ThrowingBridge);
      renderProduct();

      fireEvent.click(screen.getByRole('button', { name: 'Continue with email' }));
      // Both the test consumer and the real WalletBar render the safe message.
      await waitFor(() =>
        expect(
          screen.getAllByRole('alert').map((alert) => alert.textContent),
        ).toEqual([PRIVY_UNAVAILABLE, PRIVY_UNAVAILABLE]),
      );
      expect(phase()).toBe('idle');
      expect(metaMaskButton().disabled).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: 'Continue with email' }));
      await waitFor(() => expect(loadBridge).toHaveBeenCalledTimes(2));
      await emit((props) => props.onSnapshot(snapshot()));
      expect(mocks.handle.login).toHaveBeenCalledOnce();
      expect(screen.queryAllByRole('alert')).toHaveLength(0);

      await emit((props) => {
        props.onSnapshot(
          snapshot({ authenticated: true, wallet: embeddedWallet() }),
        );
        props.onLoginComplete();
      });

      await waitFor(() =>
        expect(mocks.rememberPrivySelection).toHaveBeenCalledOnce(),
      );
      expect(mocks.connectPrivyWallet).toHaveBeenCalledOnce();
      expect(phase()).toBe('idle');
      expect(mocks.productMounts).toBe(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  async function loginUntilAttach(
    getEthereumProvider: () => Promise<EIP1193Provider>,
  ) {
    renderWallet();
    await startLogin();
    await emit((props) => {
      props.onSnapshot(
        snapshot({
          authenticated: true,
          wallet: embeddedWallet(getEthereumProvider),
        }),
      );
      props.onLoginComplete();
    });
  }

  function connectElsewhere(connectorId: string, address: string) {
    mocks.account = { status: 'connected', address, connector: { id: connectorId } };
    act(() => mocks.accountListeners.forEach((listener) => listener()));
  }

  it('lets MetaMask connected outside the header win over a pending Privy provider', async () => {
    let resolveProvider: ((provider: EIP1193Provider) => void) | undefined;
    const getEthereumProvider = vi.fn(
      () =>
        new Promise<EIP1193Provider>((resolve) => {
          resolveProvider = resolve;
        }),
    );
    await loginUntilAttach(getEthereumProvider);
    await waitFor(() => expect(getEthereumProvider).toHaveBeenCalledOnce());

    // e.g. Create or Portfolio called wagmi connect directly, without cancel().
    connectElsewhere('metaMaskSDK', `0x${'cd'.repeat(20)}`);
    await act(async () => {
      resolveProvider?.(PROVIDER);
    });

    expect(mocks.connectPrivyWallet).not.toHaveBeenCalled();
    expect(mocks.rememberPrivySelection).not.toHaveBeenCalled();
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    expect(phase()).toBe('idle');
  });

  it('invalidates an in-flight Privy connect once MetaMask connects elsewhere', async () => {
    let isCurrent: (() => boolean) | undefined;
    let finishConnect: ((result: string) => void) | undefined;
    mocks.connectPrivyWallet.mockImplementationOnce(
      (_config: unknown, _provider: unknown, current: () => boolean) =>
        new Promise((resolve) => {
          isCurrent = current;
          finishConnect = resolve;
        }),
    );
    await loginUntilAttach(vi.fn(async () => PROVIDER));
    await waitFor(() => expect(mocks.connectPrivyWallet).toHaveBeenCalledOnce());
    expect(isCurrent?.()).toBe(true);

    connectElsewhere('metaMaskSDK', `0x${'cd'.repeat(20)}`);

    expect(isCurrent?.()).toBe(false);
    await act(async () => {
      finishConnect?.('connected');
    });
    expect(mocks.rememberPrivySelection).not.toHaveBeenCalled();
    expect(phase()).toBe('idle');
  });

  it('does not cancel its own Privy connection when wagmi reports it connected', async () => {
    let isCurrent: (() => boolean) | undefined;
    let finishConnect: ((result: string) => void) | undefined;
    mocks.connectPrivyWallet.mockImplementationOnce(
      (_config: unknown, _provider: unknown, current: () => boolean) =>
        new Promise((resolve) => {
          isCurrent = current;
          finishConnect = resolve;
        }),
    );
    await loginUntilAttach(vi.fn(async () => PROVIDER));
    await waitFor(() => expect(mocks.connectPrivyWallet).toHaveBeenCalledOnce());

    connectElsewhere('privyEmbedded', ADDRESS);

    expect(isCurrent?.()).toBe(true);
    await act(async () => {
      finishConnect?.('connected');
    });
    expect(mocks.rememberPrivySelection).toHaveBeenCalledOnce();
    expect(phase()).toBe('idle');
  });
});
