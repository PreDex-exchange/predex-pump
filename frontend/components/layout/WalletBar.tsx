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
import { arcAddresses, arcTestnet } from '@/lib/chain/arc';
import { collateralErc20Abi } from '@/lib/chain/contracts';
import {
  hasPredexQaProvider,
  METAMASK_CONNECTOR_ID,
  PREDEX_QA_CONNECTOR_ID,
} from '@/lib/chain/wallet-connectors';
import { formatUsdc, shortAddress } from '@/lib/format';
import { publicWalletErrorMessage } from '@/lib/wallet-errors';

import styles from './WalletBar.module.css';

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
  const { address, chainId, isConnected } = useAccount();
  const { connect, connectors, error: connectError, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { error: authError, clearSession } = useAuth();
  const {
    switchChain,
    error: switchError,
    isPending: isSwitching,
  } = useSwitchChain();
  const isWrongNetwork = isConnected && chainId !== arcTestnet.id;
  const authFeedback = authError?.message ?? null;
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
      <WalletControls error={authFeedback ?? connectFeedback}>
        <span className={styles.network}>
          <span className={styles.dot} aria-hidden="true" />
          Arc
        </span>
        <button
          className={styles.wallet}
          disabled={!connector || isConnecting}
          onClick={() => connector && connect({ connector })}
          title="Connect MetaMask"
          type="button"
        >
          {isConnecting
            ? 'Connecting…'
            : connector
              ? 'Connect MetaMask'
              : 'MetaMask unavailable'}
        </button>
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
    <WalletControls error={authFeedback}>
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
          disconnect();
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
