'use client';

import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import type { EIP1193Provider } from 'viem';
import { useConfig } from 'wagmi';
import { getAccount, watchAccount } from 'wagmi/actions';

import {
  connectPrivyWallet,
  disconnectPrivyWallet,
  forgetPrivySelection,
  hasPrivySelection,
  privySettings,
  rememberPrivySelection,
  type PrivySettings,
} from '@/lib/chain/privy-wallet';
import { PRIVY_CONNECTOR_ID } from '@/lib/chain/wallet-connectors';
import { publicWalletErrorMessage } from '@/lib/wallet-errors';

export type PrivyWalletPhase =
  | 'idle'
  | 'loading'
  | 'authenticating'
  | 'connecting'
  | 'restoring'
  | 'disconnecting';

export interface PrivyEmbeddedWallet {
  address: string;
  getEthereumProvider: () => Promise<EIP1193Provider>;
}

export interface PrivyBridgeSnapshot {
  ready: boolean;
  authenticated: boolean;
  wallet: PrivyEmbeddedWallet | null;
}

export interface PrivyBridgeHandle {
  login: () => void;
  logout: () => Promise<void>;
}

export interface PrivyWalletBridgeProps {
  settings: PrivySettings;
  onHandle: (handle: PrivyBridgeHandle | null) => void;
  onSnapshot: (snapshot: PrivyBridgeSnapshot) => void;
  onLoginComplete: () => void;
  onLoginError: (error: unknown, cancelled: boolean) => void;
}

type PrivyWalletBridge = ComponentType<PrivyWalletBridgeProps>;
type PrivyIntent = 'none' | 'login' | 'restore';

interface PrivyWalletContextValue {
  enabled: boolean;
  phase: PrivyWalletPhase;
  error: Error | null;
  login: () => void;
  cancel: () => void;
  disconnect: () => Promise<void>;
}

const WALLET_BUSY_MESSAGE =
  'Disconnect the current wallet before using the email wallet.';
const PRIVY_UNAVAILABLE_MESSAGE =
  'Email login is unavailable right now. MetaMask still works.';
const NOT_READY: PrivyBridgeSnapshot = {
  ready: false,
  authenticated: false,
  wallet: null,
};

const PrivyWalletContext = createContext<PrivyWalletContextValue>({
  enabled: false,
  phase: 'idle',
  error: null,
  login: () => undefined,
  cancel: () => undefined,
  disconnect: async () => undefined,
});

function loadPrivyBridge(): Promise<PrivyWalletBridge> {
  // Client-only chunk: the Privy SDK is fetched only after a deliberate email
  // login or when this browser previously chose the email wallet.
  return import('./PrivyWalletBridge').then(
    (module) => module.PrivyWalletBridge,
  );
}

class PrivyBridgeBoundary extends Component<
  { children: ReactNode; onError: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onError();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

interface PrivyWalletProviderProps {
  children: ReactNode;
  settings?: PrivySettings | null;
  loadBridge?: () => Promise<PrivyWalletBridge>;
}

export function PrivyWalletProvider({
  children,
  settings = privySettings,
  loadBridge = loadPrivyBridge,
}: PrivyWalletProviderProps) {
  if (!settings) return <>{children}</>;
  return (
    <EnabledPrivyWallet loadBridge={loadBridge} settings={settings}>
      {children}
    </EnabledPrivyWallet>
  );
}

function EnabledPrivyWallet({
  children,
  loadBridge,
  settings,
}: {
  children: ReactNode;
  loadBridge: () => Promise<PrivyWalletBridge>;
  settings: PrivySettings;
}) {
  const config = useConfig();
  const [Bridge, setBridge] = useState<PrivyWalletBridge | null>(null);
  const [phase, setPhase] = useState<PrivyWalletPhase>('idle');
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(false);
  // Every user choice (email, MetaMask, disconnect) starts a new generation so
  // late SDK or provider results from an older choice can never attach.
  const generationRef = useRef(0);
  const intentRef = useRef<PrivyIntent>('none');
  const loginCompletedRef = useRef(false);
  const loginGenerationRef = useRef<number | null>(null);
  const attachGenerationRef = useRef<number | null>(null);
  const disconnectingRef = useRef(false);
  const handleRef = useRef<PrivyBridgeHandle | null>(null);
  const snapshotRef = useRef<PrivyBridgeSnapshot>(NOT_READY);
  const bridgeLoadRef = useRef<Promise<void> | null>(null);

  const syncPhase = useCallback(() => {
    if (!mountedRef.current) return;
    const intent = intentRef.current;
    setPhase(
      disconnectingRef.current
        ? 'disconnecting'
        : intent === 'restore'
          ? 'restoring'
          : intent === 'login'
            ? !handleRef.current
              ? 'loading'
              : loginCompletedRef.current
                ? 'connecting'
                : 'authenticating'
            : 'idle',
    );
  }, []);

  const finish = useCallback(() => {
    intentRef.current = 'none';
    loginCompletedRef.current = false;
    syncPhase();
  }, [syncPhase]);

  const attach = useCallback(
    async (wallet: PrivyEmbeddedWallet) => {
      const generation = generationRef.current;
      attachGenerationRef.current = generation;
      const restoring = intentRef.current === 'restore';
      const isCurrent = () =>
        mountedRef.current && generationRef.current === generation;
      try {
        const provider = await wallet.getEthereumProvider();
        if (!isCurrent()) return;
        const result = await connectPrivyWallet(config, provider, isCurrent);
        if (!isCurrent()) return;
        if (result === 'connected') {
          rememberPrivySelection();
        } else if (result === 'wallet-busy') {
          if (restoring) forgetPrivySelection();
          else setError(new Error(WALLET_BUSY_MESSAGE));
        }
        finish();
      } catch (attachError) {
        if (!isCurrent()) return;
        if (!restoring) {
          setError(
            new Error(
              publicWalletErrorMessage(
                attachError,
                'The email wallet could not be connected. Try again.',
              ),
            ),
          );
        }
        finish();
      }
    },
    [config, finish],
  );

  const reconcile = useCallback(() => {
    const snapshot = snapshotRef.current;
    const wallet = snapshot.wallet;
    const account = getAccount(config);

    if (
      snapshot.ready &&
      !disconnectingRef.current &&
      account.status === 'connected' &&
      account.connector?.id === PRIVY_CONNECTOR_ID &&
      (!snapshot.authenticated ||
        wallet?.address.toLowerCase() !== account.address?.toLowerCase())
    ) {
      // The Privy session ended or changed outside this app; stop signing
      // through the old provider immediately.
      forgetPrivySelection();
      void disconnectPrivyWallet(config).catch(() => undefined);
      return;
    }

    if (
      intentRef.current !== 'none' &&
      account.status === 'connected' &&
      account.connector !== undefined &&
      account.connector.id !== PRIVY_CONNECTOR_ID
    ) {
      // Another wallet connected first (header, Create, or Portfolio). It wins:
      // invalidate pending Privy work before any attach-in-progress check so a
      // late provider or connect result can never replace it.
      generationRef.current += 1;
      if (intentRef.current === 'restore') forgetPrivySelection();
      finish();
      return;
    }

    const intent = intentRef.current;
    if (intent === 'none' || !snapshot.ready || disconnectingRef.current) {
      return;
    }

    if (intent === 'login') {
      const handle = handleRef.current;
      if (!handle) return;
      if (loginGenerationRef.current !== generationRef.current) {
        loginGenerationRef.current = generationRef.current;
        handle.login();
        return;
      }
      if (!loginCompletedRef.current || !snapshot.authenticated || !wallet) {
        return;
      }
    } else if (!snapshot.authenticated || !wallet) {
      // A remembered choice without a resumable embedded wallet is dropped
      // quietly. Page load never opens a login prompt.
      forgetPrivySelection();
      finish();
      return;
    }

    if (attachGenerationRef.current === generationRef.current) return;
    // wagmi is still restoring a cookie session; the account watcher re-runs
    // this check once hydration settles.
    if (account.status === 'reconnecting') return;
    if (account.status !== 'disconnected') {
      if (
        account.status === 'connected' &&
        account.connector?.id === PRIVY_CONNECTOR_ID
      ) {
        rememberPrivySelection();
      } else if (intent === 'restore') {
        forgetPrivySelection();
      } else {
        setError(new Error(WALLET_BUSY_MESSAGE));
      }
      finish();
      return;
    }
    void attach(wallet);
  }, [attach, config, finish]);

  const ensureBridge = useCallback(() => {
    bridgeLoadRef.current ??= loadBridge().then(
      (bridge) => {
        if (mountedRef.current) setBridge(() => bridge);
      },
      () => {
        bridgeLoadRef.current = null;
        if (!mountedRef.current || intentRef.current === 'none') return;
        if (intentRef.current === 'login') {
          setError(new Error(PRIVY_UNAVAILABLE_MESSAGE));
        }
        generationRef.current += 1;
        finish();
      },
    );
  }, [finish, loadBridge]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (intentRef.current !== 'none' || !hasPrivySelection()) return;
    intentRef.current = 'restore';
    ensureBridge();
  }, [ensureBridge]);

  useEffect(
    () => watchAccount(config, { onChange: () => reconcile() }),
    [config, reconcile],
  );

  const handleBridge = useCallback(
    (handle: PrivyBridgeHandle | null) => {
      handleRef.current = handle;
      if (!handle) snapshotRef.current = NOT_READY;
      syncPhase();
      reconcile();
    },
    [reconcile, syncPhase],
  );

  const handleSnapshot = useCallback(
    (snapshot: PrivyBridgeSnapshot) => {
      snapshotRef.current = snapshot;
      reconcile();
    },
    [reconcile],
  );

  const handleLoginComplete = useCallback(() => {
    if (intentRef.current !== 'login' || loginCompletedRef.current) return;
    loginCompletedRef.current = true;
    syncPhase();
    reconcile();
  }, [reconcile, syncPhase]);

  const handleLoginError = useCallback(
    (loginError: unknown, cancelled: boolean) => {
      if (intentRef.current !== 'login') return;
      generationRef.current += 1;
      finish();
      if (!cancelled) {
        setError(
          new Error(
            publicWalletErrorMessage(
              loginError,
              'Email login did not complete. Try again.',
            ),
          ),
        );
      }
    },
    [finish],
  );

  const handleBridgeFailure = useCallback(() => {
    handleRef.current = null;
    snapshotRef.current = NOT_READY;
    // Drop the failed island and its loader so a later deliberate retry mounts
    // a fresh boundary. The product children render outside it and stay mounted.
    bridgeLoadRef.current = null;
    setBridge(null);
    if (getAccount(config).connector?.id === PRIVY_CONNECTOR_ID) {
      void disconnectPrivyWallet(config).catch(() => undefined);
    }
    if (intentRef.current === 'login') {
      setError(new Error(PRIVY_UNAVAILABLE_MESSAGE));
    }
    generationRef.current += 1;
    finish();
  }, [config, finish]);

  const login = useCallback(() => {
    if (intentRef.current === 'login' || disconnectingRef.current) return;
    generationRef.current += 1;
    intentRef.current = 'login';
    loginCompletedRef.current = false;
    setError(null);
    syncPhase();
    ensureBridge();
    reconcile();
  }, [ensureBridge, reconcile, syncPhase]);

  // Choosing MetaMask abandons any pending email login or restore.
  const cancel = useCallback(() => {
    if (intentRef.current === 'none') return;
    generationRef.current += 1;
    if (intentRef.current === 'restore') forgetPrivySelection();
    finish();
  }, [finish]);

  const disconnect = useCallback(async () => {
    generationRef.current += 1;
    intentRef.current = 'none';
    loginCompletedRef.current = false;
    disconnectingRef.current = true;
    forgetPrivySelection();
    setError(null);
    syncPhase();
    let failed = false;
    // Detach from wagmi first so nothing signs through a provider whose
    // Privy session is being cleared.
    try {
      await disconnectPrivyWallet(config);
    } catch {
      failed = true;
    }
    try {
      await handleRef.current?.logout();
    } catch {
      failed = true;
    }
    disconnectingRef.current = false;
    if (failed && mountedRef.current) {
      setError(
        new Error(
          'The email wallet could not be fully signed out. Reload the page and try again.',
        ),
      );
    }
    syncPhase();
  }, [config, syncPhase]);

  const value = useMemo<PrivyWalletContextValue>(
    () => ({ enabled: true, phase, error, login, cancel, disconnect }),
    [cancel, disconnect, error, login, phase],
  );

  return (
    <PrivyWalletContext.Provider value={value}>
      {children}
      {Bridge && (
        <PrivyBridgeBoundary onError={handleBridgeFailure}>
          <Bridge
            onHandle={handleBridge}
            onLoginComplete={handleLoginComplete}
            onLoginError={handleLoginError}
            onSnapshot={handleSnapshot}
            settings={settings}
          />
        </PrivyBridgeBoundary>
      )}
    </PrivyWalletContext.Provider>
  );
}

export function usePrivyWallet() {
  return useContext(PrivyWalletContext);
}
