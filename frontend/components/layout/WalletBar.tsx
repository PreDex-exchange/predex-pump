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
  const {
    session,
    isLoading: isAuthLoading,
    isSigningIn,
    error: authError,
    signIn,
    signOut,
  } = useAuth();
  const {
    switchChain,
    error: switchError,
    isPending: isSwitching,
  } = useSwitchChain();
  const isWrongNetwork = isConnected && chainId !== arcTestnet.id;
  const isSignedIn = session?.authenticated === true;
  const sessionMatchesWallet =
    isSignedIn &&
    Boolean(address) &&
    session.address.toLowerCase() === address?.toLowerCase();
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

  const authControl = isAuthLoading ? (
    <button className={`${styles.auth} ${styles.pending}`} disabled type="button">
      Checking sign-in…
    </button>
  ) : sessionMatchesWallet ? (
    <button
      className={`${styles.auth} ${styles.signed}`}
      onClick={() => void signOut()}
      title="Signed in. Click to sign out."
      type="button"
    >
      <span aria-hidden="true">✓</span>
      Signed in
    </button>
  ) : isSignedIn && !address ? (
    <button
      className={`${styles.auth} ${styles.signed}`}
      onClick={() => void signOut()}
      title={`Signed in as ${session.address}. Click to sign out.`}
      type="button"
    >
      <span aria-hidden="true">✓</span>
      {shortAddress(session.address)}
    </button>
  ) : (
    <button
      className={styles.auth}
      disabled={!address || isSigningIn}
      onClick={() => void signIn()}
      title={
        isSignedIn
          ? `The saved session belongs to ${session.address}. Sign in with this wallet to replace it.`
          : 'Sign in with Ethereum to save profile features'
      }
      type="button"
    >
      {isSigningIn ? 'Signing…' : 'Sign in'}
    </button>
  );

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
    const connector = connectors[0];
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
          title="Connect an injected wallet"
          type="button"
        >
          {isConnecting ? 'Connecting…' : connector ? 'Connect wallet' : 'No wallet found'}
        </button>
        {authControl}
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
        {authControl}
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
        className={styles.wallet}
        onClick={() => disconnect()}
        title="Disconnect wallet"
        type="button"
      >
        <span className={styles.address}>{shortAddress(address)}</span>
        <span className={styles.balance}>
          {isBalanceLoading ? '…' : formatWalletBalance(usdcBalance)} USDC
        </span>
      </button>
      {authControl}
    </WalletControls>
  );
}
