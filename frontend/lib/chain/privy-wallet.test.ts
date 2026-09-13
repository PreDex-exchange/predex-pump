// Mocked-SDK routing tests. The fake EIP-1193 providers stand in for Privy's
// embedded wallet and MetaMask; they prove wagmi routing and delegation only,
// never a live Privy login or a real Arc transaction.
import {
  getAddress,
  stringToHex,
  toHex,
  zeroAddress,
  type EIP1193Provider,
} from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfig, http, type Config } from 'wagmi';
import {
  connect,
  getAccount,
  getWalletClient,
  sendTransaction,
  signMessage,
} from 'wagmi/actions';
import { injected } from 'wagmi/connectors';

import { walletProviderErrorCode } from '@/lib/wallet-errors';

import { arcTestnet } from './arc';
import {
  connectPrivyWallet,
  disconnectPrivyWallet,
  forgetPrivySelection,
  getAttachedPrivyProvider,
  hasPrivySelection,
  privyEmbeddedConnector,
  readPrivySettings,
  rememberPrivySelection,
} from './privy-wallet';
import { METAMASK_CONNECTOR_ID, PRIVY_CONNECTOR_ID } from './wallet-connectors';

const PRIVY_ADDRESS = getAddress(`0x${'ab'.repeat(20)}`);
const METAMASK_ADDRESS = getAddress(`0x${'cd'.repeat(20)}`);
const SIGNATURE = `0x${'11'.repeat(65)}`;
const TX_HASH = `0x${'22'.repeat(32)}`;

type Listener = (...args: unknown[]) => void;
type RequestHandler = (method: string, params: unknown) => unknown;

function fakeProvider(address: `0x${string}`, handler?: RequestHandler) {
  const listeners = new Map<string, Set<Listener>>();
  const requests: Array<{ method: string; params: unknown }> = [];
  return {
    requests,
    listenerCount: () =>
      [...listeners.values()].reduce((total, set) => total + set.size, 0),
    on(event: string, listener: Listener) {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(event, set);
    },
    removeListener(event: string, listener: Listener) {
      listeners.get(event)?.delete(listener);
    },
    async request({ method, params }: { method: string; params?: unknown }) {
      requests.push({ method, params });
      const handled = await handler?.(method, params);
      if (handled !== undefined) return handled;
      switch (method) {
        case 'eth_chainId':
          return toHex(arcTestnet.id);
        case 'eth_accounts':
        case 'eth_requestAccounts':
          return [address];
        case 'personal_sign':
        case 'eth_signTypedData_v4':
          return SIGNATURE;
        case 'eth_sendTransaction':
          return TX_HASH;
        case 'eth_estimateGas':
          return '0x5208';
        default:
          throw Object.assign(new Error('Unsupported method'), { code: 4200 });
      }
    },
  };
}

type FakeProvider = ReturnType<typeof fakeProvider>;

function asEip1193(provider: FakeProvider) {
  return provider as unknown as EIP1193Provider;
}

let activeConfig: Config | undefined;

function testConfig() {
  const metaMaskProvider = fakeProvider(METAMASK_ADDRESS);
  const config = createConfig({
    chains: [arcTestnet],
    connectors: [
      injected({
        target: {
          id: METAMASK_CONNECTOR_ID,
          name: 'MetaMask',
          provider: () => asEip1193(metaMaskProvider),
        },
      }),
      privyEmbeddedConnector(),
    ],
    multiInjectedProviderDiscovery: false,
    storage: null,
    transports: { [arcTestnet.id]: http('http://127.0.0.1:9/unused') },
  });
  activeConfig = config;
  return { config, metaMaskProvider };
}

function connectorById(config: Config, id: string) {
  const connector = config.connectors.find((candidate) => candidate.id === id);
  if (!connector) throw new Error(`Missing connector ${id}`);
  return connector;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(async () => {
  if (activeConfig) await disconnectPrivyWallet(activeConfig);
  activeConfig = undefined;
  vi.unstubAllEnvs();
});

describe('Privy settings', () => {
  it('keeps Privy disabled without an App ID and trims the optional client ID', () => {
    vi.stubEnv('NEXT_PUBLIC_PRIVY_APP_ID', '');
    vi.stubEnv('NEXT_PUBLIC_PRIVY_CLIENT_ID', '');

    expect(readPrivySettings()).toBeNull();
    expect(readPrivySettings('   ', 'client-id')).toBeNull();
    expect(readPrivySettings(' app-id ')).toEqual({ appId: 'app-id' });
    expect(readPrivySettings('app-id', ' client-id ')).toEqual({
      appId: 'app-id',
      clientId: 'client-id',
    });
  });

  it('persists only a boolean email-wallet choice', () => {
    expect(hasPrivySelection()).toBe(false);
    rememberPrivySelection();
    expect(hasPrivySelection()).toBe(true);
    forgetPrivySelection();
    expect(hasPrivySelection()).toBe(false);
  });
});

describe('Privy embedded wallet wagmi routing (mocked SDK provider)', () => {
  it('keeps the connector unavailable until a deliberate attach', async () => {
    const { config } = testConfig();

    await expect(
      connectorById(config, PRIVY_CONNECTOR_ID).getProvider(),
    ).resolves.toBeUndefined();
    await expect(
      connectorById(config, PRIVY_CONNECTOR_ID).isAuthorized(),
    ).resolves.toBe(false);
  });

  it('attaches the embedded wallet through its own connector without touching MetaMask', async () => {
    const { config, metaMaskProvider } = testConfig();
    const privy = fakeProvider(PRIVY_ADDRESS);

    await expect(
      connectPrivyWallet(config, asEip1193(privy), () => true),
    ).resolves.toBe('connected');

    const account = getAccount(config);
    expect(account.status).toBe('connected');
    expect(account.connector?.id).toBe(PRIVY_CONNECTOR_ID);
    expect(account.address).toBe(PRIVY_ADDRESS);
    expect(account.chainId).toBe(arcTestnet.id);
    expect(config.connectors[0]?.id).toBe(METAMASK_CONNECTOR_ID);
    expect(metaMaskProvider.requests).toEqual([]);
  });

  it('delegates SIWE, EIP-712 order signing, and transactions to the attached provider', async () => {
    const { config, metaMaskProvider } = testConfig();
    const privy = fakeProvider(PRIVY_ADDRESS);
    await connectPrivyWallet(config, asEip1193(privy), () => true);

    const message = 'Sign in to predex.fun';
    await expect(signMessage(config, { message })).resolves.toBe(SIGNATURE);
    const personalSign = privy.requests.find(
      ({ method }) => method === 'personal_sign',
    );
    expect(personalSign?.params).toEqual([stringToHex(message), PRIVY_ADDRESS]);

    const walletClient = await getWalletClient(config, {
      chainId: arcTestnet.id,
    });
    await expect(
      walletClient.signTypedData({
        account: walletClient.account,
        domain: {
          name: 'Predex CTFExchange',
          version: '1',
          chainId: arcTestnet.id,
          verifyingContract: zeroAddress,
        },
        types: {
          Order: [
            { name: 'maker', type: 'address' },
            { name: 'tokenId', type: 'uint256' },
          ],
        },
        primaryType: 'Order',
        message: { maker: PRIVY_ADDRESS, tokenId: 7n },
      }),
    ).resolves.toBe(SIGNATURE);
    const typedSign = privy.requests.find(
      ({ method }) => method === 'eth_signTypedData_v4',
    );
    const [signer, payload] = typedSign?.params as [string, string];
    expect(signer.toLowerCase()).toBe(PRIVY_ADDRESS.toLowerCase());
    expect(JSON.parse(payload)).toMatchObject({
      primaryType: 'Order',
      message: { tokenId: '7' },
    });

    await expect(
      sendTransaction(config, {
        chainId: arcTestnet.id,
        to: zeroAddress,
        data: '0x1234',
        value: 0n,
        gas: 100_000n,
      }),
    ).resolves.toBe(TX_HASH);
    const sent = privy.requests.find(
      ({ method }) => method === 'eth_sendTransaction',
    );
    const [transaction] = sent?.params as [Record<string, unknown>];
    expect(String(transaction.from).toLowerCase()).toBe(
      PRIVY_ADDRESS.toLowerCase(),
    );
    expect(transaction).toMatchObject({
      to: zeroAddress,
      data: '0x1234',
      gas: toHex(100_000n),
    });
    expect(metaMaskProvider.requests).toEqual([]);
  });

  it('never replaces an active MetaMask connection, and its disconnect leaves MetaMask alone', async () => {
    const { config, metaMaskProvider } = testConfig();
    await connect(config, {
      connector: connectorById(config, METAMASK_CONNECTOR_ID),
    });
    const privy = fakeProvider(PRIVY_ADDRESS);

    await expect(
      connectPrivyWallet(config, asEip1193(privy), () => true),
    ).resolves.toBe('wallet-busy');
    expect(privy.requests).toEqual([]);
    expect(getAttachedPrivyProvider()).toBeUndefined();

    const metaMaskRequests = metaMaskProvider.requests.length;
    await disconnectPrivyWallet(config);
    expect(getAccount(config)).toMatchObject({
      status: 'connected',
      address: METAMASK_ADDRESS,
    });
    expect(getAccount(config).connector?.id).toBe(METAMASK_CONNECTOR_ID);
    expect(metaMaskProvider.requests).toHaveLength(metaMaskRequests);
  });

  it('does not attach a provider whose selection was already cancelled', async () => {
    const { config } = testConfig();
    const privy = fakeProvider(PRIVY_ADDRESS);

    await expect(
      connectPrivyWallet(config, asEip1193(privy), () => false),
    ).resolves.toBe('cancelled');
    expect(privy.requests).toEqual([]);
    expect(getAccount(config).status).toBe('disconnected');
  });

  it('rolls back a connection that completes after cancellation', async () => {
    const { config } = testConfig();
    let current = true;
    const privy = fakeProvider(PRIVY_ADDRESS, (method) => {
      if (method === 'eth_requestAccounts') current = false;
      return undefined;
    });

    await expect(
      connectPrivyWallet(config, asEip1193(privy), () => current),
    ).resolves.toBe('cancelled');
    expect(getAccount(config).status).toBe('disconnected');
    expect(getAttachedPrivyProvider()).toBeUndefined();
    expect(privy.listenerCount()).toBe(0);
  });

  it('surfaces a declined wallet request and leaves nothing attached', async () => {
    const { config } = testConfig();
    const privy = fakeProvider(PRIVY_ADDRESS, (method) => {
      if (method === 'eth_requestAccounts') {
        throw Object.assign(new Error('declined'), { code: 4001 });
      }
      return undefined;
    });

    const failure = await connectPrivyWallet(
      config,
      asEip1193(privy),
      () => true,
    ).catch((error: unknown) => error);

    expect(walletProviderErrorCode(failure)).toBe(4001);
    expect(getAccount(config).status).toBe('disconnected');
    expect(getAttachedPrivyProvider()).toBeUndefined();
    expect(privy.listenerCount()).toBe(0);
  });

  it('logout detaches listeners and rejects late requests from the released provider', async () => {
    const { config } = testConfig();
    const privy = fakeProvider(PRIVY_ADDRESS);
    await connectPrivyWallet(config, asEip1193(privy), () => true);
    const connector = connectorById(config, PRIVY_CONNECTOR_ID);
    const attached = (await connector.getProvider()) as EIP1193Provider;
    expect(privy.listenerCount()).toBeGreaterThan(0);

    await disconnectPrivyWallet(config);

    expect(getAccount(config).status).toBe('disconnected');
    await expect(connector.getProvider()).resolves.toBeUndefined();
    expect(privy.listenerCount()).toBe(0);
    const requestCount = privy.requests.length;
    await expect(
      attached.request({ method: 'eth_accounts' }),
    ).rejects.toMatchObject({ code: 4900 });
    expect(privy.requests).toHaveLength(requestCount);
  });

  it('lets a newer MetaMask connection win over a Privy connect that resolves late', async () => {
    const { config } = testConfig();
    let current = true;
    let releaseAccounts: (() => void) | undefined;
    const accountsGate = new Promise<void>((resolve) => {
      releaseAccounts = resolve;
    });
    const privy = fakeProvider(PRIVY_ADDRESS, (method) =>
      method === 'eth_requestAccounts'
        ? accountsGate.then(() => [PRIVY_ADDRESS])
        : undefined,
    );

    const pendingPrivy = connectPrivyWallet(
      config,
      asEip1193(privy),
      () => current,
    );
    await vi.waitFor(() =>
      expect(privy.requests.map(({ method }) => method)).toContain(
        'eth_requestAccounts',
      ),
    );

    // The user chose MetaMask while the email wallet was still connecting.
    current = false;
    await connect(config, {
      connector: connectorById(config, METAMASK_CONNECTOR_ID),
    });
    releaseAccounts?.();

    await expect(pendingPrivy).resolves.toBe('cancelled');
    const account = getAccount(config);
    expect(account.status).toBe('connected');
    expect(account.connector?.id).toBe(METAMASK_CONNECTOR_ID);
    expect(account.address).toBe(METAMASK_ADDRESS);
    expect(
      config.state.connections.has(
        connectorById(config, PRIVY_CONNECTOR_ID).uid,
      ),
    ).toBe(false);
    expect(getAttachedPrivyProvider()).toBeUndefined();
    expect(privy.listenerCount()).toBe(0);
  });
});
