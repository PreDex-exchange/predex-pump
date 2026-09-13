'use client';

import {
  PrivyProvider,
  useCreateWallet,
  useLogin,
  usePrivy,
  useWallets,
  type PrivyClientConfig,
  type User,
} from '@privy-io/react-auth';
import { useCallback, useEffect, useRef } from 'react';
import type { EIP1193Provider } from 'viem';

import { arcTestnet } from '@/lib/chain/arc';

import type { PrivyWalletBridgeProps } from './PrivyWalletProvider';

const PRIVY_CONFIG: PrivyClientConfig = {
  loginMethods: ['email'],
  defaultChain: arcTestnet,
  supportedChains: [arcTestnet],
  embeddedWallets: {
    ethereum: { createOnLogin: 'all-users' },
  },
};

interface WalletIdentity {
  walletClientType?: string;
  connectorType?: string;
}

function isEmbeddedWallet({ walletClientType, connectorType }: WalletIdentity) {
  return walletClientType === 'privy' || connectorType === 'embedded';
}

function hasEmbeddedEthereumWallet(user: User | null) {
  return (user?.linkedAccounts ?? []).some(
    (account) =>
      account.type === 'wallet' &&
      account.chainType === 'ethereum' &&
      isEmbeddedWallet(account),
  );
}

function PrivyWalletSync({
  onHandle,
  onLoginComplete,
  onLoginError,
  onSnapshot,
}: Omit<PrivyWalletBridgeProps, 'settings'>) {
  const { authenticated, logout, ready, user } = usePrivy();
  const { ready: walletsReady, wallets } = useWallets();
  const { createWallet } = useCreateWallet();
  // Only Privy's embedded wallet is bridged; any other wallet Privy detects is
  // ignored so MetaMask keeps its own wagmi connector.
  const embeddedWallet = wallets.find(isEmbeddedWallet);
  const walletAddress = embeddedWallet?.address;
  const walletRef = useRef(embeddedWallet);

  const completeWithEmbeddedWallet = useCallback(
    (signedInUser: User | null) => {
      if (hasEmbeddedEthereumWallet(signedInUser)) {
        onLoginComplete();
        return;
      }
      // createOnLogin covers new users; an existing email user without an
      // embedded wallet gets one explicit creation.
      createWallet().then(
        () => onLoginComplete(),
        (error: unknown) => onLoginError(error, false),
      );
    },
    [createWallet, onLoginComplete, onLoginError],
  );

  const { login } = useLogin({
    onComplete: ({ user: signedInUser, wasAlreadyAuthenticated }) => {
      // Privy also reports resumed sessions here; only a deliberate login may
      // complete the email-wallet flow.
      if (wasAlreadyAuthenticated) return;
      completeWithEmbeddedWallet(signedInUser);
    },
    onError: (error) => onLoginError(error, error === 'exited_auth_flow'),
  });

  useEffect(() => {
    walletRef.current = embeddedWallet;
  });

  useEffect(() => {
    onHandle({
      login: () => {
        if (authenticated) completeWithEmbeddedWallet(user);
        else login();
      },
      logout: () => logout(),
    });
  }, [authenticated, completeWithEmbeddedWallet, login, logout, onHandle, user]);

  useEffect(() => () => onHandle(null), [onHandle]);

  useEffect(() => {
    onSnapshot({
      ready: ready && walletsReady,
      authenticated,
      wallet: walletAddress
        ? {
            address: walletAddress,
            getEthereumProvider: async () => {
              const wallet = walletRef.current;
              if (!wallet || wallet.address !== walletAddress) {
                throw new Error('The email wallet changed before it connected.');
              }
              // Privy documents this as a standard EIP-1193 provider; its
              // declared type is structurally the same interface as viem's.
              return (await wallet.getEthereumProvider()) as unknown as EIP1193Provider;
            },
          }
        : null,
    });
  }, [authenticated, onSnapshot, ready, walletAddress, walletsReady]);

  return null;
}

export function PrivyWalletBridge({ settings, ...sync }: PrivyWalletBridgeProps) {
  return (
    <PrivyProvider
      appId={settings.appId}
      {...(settings.clientId ? { clientId: settings.clientId } : {})}
      config={PRIVY_CONFIG}
    >
      <PrivyWalletSync {...sync} />
    </PrivyProvider>
  );
}
