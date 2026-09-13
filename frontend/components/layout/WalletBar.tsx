'use client';

import {
  useAccount,
  useConnect,
  useDisconnect,
  useReadContract,
  useSwitchChain,
} from 'wagmi';
import type { ReactNode } from 'react';

import { useAuth } from '@/components/providers/AuthProvider';
import {
  usePrivyWallet,
  type PrivyWalletPhase,
} from '@/components/providers/PrivyWalletProvider';
import { arcAddresses, arcTestnet } from '@/lib/chain/arc';
import { collateralErc20Abi } from '@/lib/chain/contracts';
import {
  hasPredexQaProvider,
  METAMASK_CONNECTOR_ID,
  PREDEX_QA_CONNECTOR_ID,
  PRIVY_CONNECTOR_ID,
} from '@/lib/chain/wallet-connectors';
import { formatUsdc, shortAddress } from '@/lib/format';
import { publicWalletErrorMessage } from '@/lib/wallet-errors';

import styles from './WalletBar.module.css';

const PRIVY_PHASE_LABELS: Record<PrivyWalletPhase, string> = {
  idle: 'Continue with email',
  loading: 'Opening email login…',
  authenticating: 'Finish email login…',
  connecting: 'Connecting…',
  restoring: 'Restoring email wallet…',
  disconnecting: 'Signing out…',
};

function formatWalletBalance(balance?: bigint) {
  if (balance === undefined) return '—';
  return formatUsdc(balance.toString(), 2);
}

function WalletControls({
  children,
  error,
}: {
  children: ReactNode;
  error: string | null;
}) {
  return (
    <div className={styles.bar}>
      <div className={styles.group}>{children}</div>
      {error && (
        <p className={styles.feedback} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function WalletBar() {
  const { address, chainId, connector: activeConnector, isConnected } = useAccount();
  const { connect, connectors, error: connectError, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { error: authError, clearSession } = useAuth();
  const privyWallet = usePrivyWallet();
  const {
    switchChain,
    error: switchError,
    isPending: isSwitching,
  } = useSwitchChain();
  const isWrongNetwork = isConnected && chainId !== arcTestnet.id;
  const authFeedback = authError?.message ?? null;
  const privyFeedback = privyWallet.error?.message ?? null;
  const connectFeedback = connectError
    ? publicWalletErrorMessage(
        connectError,
        'The wallet connection did not complete. Check the wallet and try again.',
      )
    : null;
  const switchFeedback = switchError
    ? publicWalletErrorMessage(
        switchError,
        'The network switch did not complete. Check the wallet and try again.',
      )
    : null;

  const { data: usdcBalance, isLoading: isBalanceLoading } = useReadContract({
    address: arcAddresses.usdc,
    abi: collateralErc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: arcTestnet.id,
    query: {
      enabled: Boolean(address) && !isWrongNetwork,
    },
  });

  if (!isConnected || !address) {
    const qaConnector = hasPredexQaProvider()
      ? connectors.find(({ id }) => id === PREDEX_QA_CONNECTOR_ID)
      : undefined;
    const connector =
      qaConnector ?? connectors.find(({ id }) => id === METAMASK_CONNECTOR_ID);
    return (
      <WalletControls error={authFeedback ?? privyFeedback ?? connectFeedback}>
        <span className={styles.network}>
          <span className={styles.dot} aria-hidden="true" />
          Arc
        </span>
        <button
          className={styles.wallet}
          // A slow or stuck email flow must never block MetaMask. Choosing it
          // cancels pending Privy work so a late result cannot attach.
          disabled={!connector || isConnecting}
          onClick={() => {
            if (!connector) return;
            privyWallet.cancel();
            connect({ connector });
          }}
          title="Connect MetaMask"
          type="button"
        >
          {isConnecting
            ? 'Connecting…'
            : connector
              ? 'Connect MetaMask'
              : 'MetaMask unavailable'}
        </button>
        {privyWallet.enabled && (
          <button
            className={`${styles.wallet} ${styles.email}`}
            disabled={isConnecting || privyWallet.phase !== 'idle'}
            onClick={privyWallet.login}
            title="Continue with email"
            type="button"
          >
            {PRIVY_PHASE_LABELS[privyWallet.phase]}
          </button>
        )}
      </WalletControls>
    );
  }

  if (isWrongNetwork) {
    return (
      <WalletControls error={authFeedback ?? switchFeedback}>
        <span className={`${styles.network} ${styles.wrong}`}>
          <span className={styles.dot} aria-hidden="true" />
          Wrong network
        </span>
        <button
          className={`${styles.wallet} ${styles.switch}`}
          disabled={isSwitching}
          onClick={() => switchChain({ chainId: arcTestnet.id })}
          title={`Add or switch to chain ${arcTestnet.id}`}
          type="button"
        >
          {isSwitching ? 'Switching…' : 'Switch to Arc'}
        </button>
      </WalletControls>
    );
  }

  return (
    <WalletControls error={authFeedback ?? privyFeedback}>
      <span className={styles.network}>
        <span className={styles.dot} aria-hidden="true" />
        Arc
      </span>
      <button
        aria-label={`Disconnect wallet. ${shortAddress(address)}, ${
          isBalanceLoading ? 'balance loading' : `${formatWalletBalance(usdcBalance)} USDC`
        }`}
        className={styles.wallet}
        onClick={() => {
          // Email-wallet disconnect also signs out of Privy; MetaMask
          // disconnect stays independent of any Privy session.
          if (activeConnector?.id === PRIVY_CONNECTOR_ID) {
            void privyWallet.disconnect();
          } else {
            disconnect();
          }
          void clearSession();
        }}
        title="Disconnect wallet"
        type="button"
      >
        <span className={styles.address}>{shortAddress(address)}</span>
        <span className={styles.balance}>
          {isBalanceLoading ? '…' : formatWalletBalance(usdcBalance)} USDC
        </span>
      </button>
    </WalletControls>
  );
}
