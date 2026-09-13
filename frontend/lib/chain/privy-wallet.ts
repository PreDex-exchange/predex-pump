import type { EIP1193Provider } from 'viem';
import type { Config } from 'wagmi';
import { connect, disconnect, getAccount } from 'wagmi/actions';
import { injected } from 'wagmi/connectors';

import { arcTestnet } from './arc';
import { PRIVY_CONNECTOR_ID } from './wallet-connectors';

export interface PrivySettings {
  appId: string;
  clientId?: string;
}

export type PrivyConnectResult = 'connected' | 'cancelled' | 'wallet-busy';

// Only a boolean "the user chose the email wallet" marker is persisted. Privy
// owns its own session storage; provider objects never leave memory.
const PRIVY_SELECTION_STORAGE_KEY = 'predex.wallet.privy-selected';

export function readPrivySettings(
  // Literal references so Next inlines the public values at build time.
  appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID,
  clientId = process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID,
): PrivySettings | null {
  const publicAppId = appId?.trim();
  if (!publicAppId) return null;
  const publicClientId = clientId?.trim();
  return publicClientId
    ? { appId: publicAppId, clientId: publicClientId }
    : { appId: publicAppId };
}

export const privySettings = readPrivySettings();

type ProviderListener = (...args: unknown[]) => void;

interface ForwardingProvider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on(event: string, listener: ProviderListener): void;
  removeListener(event: string, listener: ProviderListener): void;
}

interface PrivyProviderAttachment {
  provider: EIP1193Provider;
  release: () => void;
}

let attachment: PrivyProviderAttachment | undefined;

function createAttachment(source: EIP1193Provider): PrivyProviderAttachment {
  // viem types EIP-1193 methods with per-method generics. This wrapper forwards
  // every request unchanged, so the structural casts do not alter behavior.
  const target = source as unknown as ForwardingProvider;
  const listeners: Array<[string, ProviderListener]> = [];
  let released = false;
  const forwarding: ForwardingProvider = {
    request(args) {
      if (released) {
        return Promise.reject(
          Object.assign(new Error('The email wallet was disconnected.'), {
            code: 4900,
          }),
        );
      }
      return target.request(args);
    },
    on(event, listener) {
      listeners.push([event, listener]);
      target.on(event, listener);
    },
    removeListener(event, listener) {
      const index = listeners.findIndex(
        ([registeredEvent, registered]) =>
          registeredEvent === event && registered === listener,
      );
      if (index !== -1) listeners.splice(index, 1);
      target.removeListener(event, listener);
    },
  };
  return {
    provider: forwarding as unknown as EIP1193Provider,
    release() {
      released = true;
      for (const [event, listener] of listeners.splice(0)) {
        target.removeListener(event, listener);
      }
    },
  };
}

export function getAttachedPrivyProvider() {
  return attachment?.provider;
}

function releasePrivyProvider() {
  attachment?.release();
  attachment = undefined;
}

export function privyEmbeddedConnector() {
  return injected({
    // The embedded wallet has no account-permission prompt to shim.
    shimDisconnect: false,
    target: {
      id: PRIVY_CONNECTOR_ID,
      name: 'Email wallet',
      // Undefined until a deliberate Privy login attaches the wallet, so cookie
      // hydration and reconnect can never select this connector on their own.
      provider: () => getAttachedPrivyProvider(),
    },
  });
}

function findPrivyConnector(config: Config) {
  return config.connectors.find(({ id }) => id === PRIVY_CONNECTOR_ID);
}

export async function connectPrivyWallet(
  config: Config,
  source: EIP1193Provider,
  isCurrent: () => boolean,
): Promise<PrivyConnectResult> {
  if (!isCurrent()) return 'cancelled';
  // Never replace, or race, a MetaMask/QA session that is active or restoring.
  if (getAccount(config).status !== 'disconnected') return 'wallet-busy';
  const connector = findPrivyConnector(config);
  if (!connector) throw new Error('The email wallet is not configured.');

  releasePrivyProvider();
  const attached = createAttachment(source);
  attachment = attached;
  try {
    await connect(config, { connector, chainId: arcTestnet.id });
  } catch (error) {
    if (attachment === attached) releasePrivyProvider();
    throw error;
  }
  if (isCurrent()) return 'connected';
  await disconnectPrivyWallet(config);
  return 'cancelled';
}

export async function disconnectPrivyWallet(config: Config) {
  const connector = findPrivyConnector(config);
  try {
    // wagmi resets the global status when asked to disconnect a connector with
    // no connection, so only touch wagmi when the email wallet is connected.
    if (connector && config.state.connections.has(connector.uid)) {
      await disconnect(config, { connector });
    }
  } finally {
    releasePrivyProvider();
  }
}

export function hasPrivySelection() {
  try {
    return window.localStorage.getItem(PRIVY_SELECTION_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function rememberPrivySelection() {
  try {
    window.localStorage.setItem(PRIVY_SELECTION_STORAGE_KEY, '1');
  } catch {
    // Private browsing can reject storage; the wallet still works this visit.
  }
}

export function forgetPrivySelection() {
  try {
    window.localStorage.removeItem(PRIVY_SELECTION_STORAGE_KEY);
  } catch {
    // Nothing was persisted if storage is unavailable.
  }
}
