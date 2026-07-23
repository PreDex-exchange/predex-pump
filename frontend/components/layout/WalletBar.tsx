'use client';

import {
  useAccount,
  useConnect,
  useDisconnect,
  useReadContract,
  useSwitchChain,
} from 'wagmi';

import { arcAddresses, arcTestnet } from '@/lib/chain/arc';
import { collateralErc20Abi } from '@/lib/chain/contracts';
import { formatUsdc, shortAddress } from '@/lib/format';

import styles from './WalletBar.module.css';

function formatWalletBalance(balance?: bigint) {
  if (balance === undefined) return '—';
  return formatUsdc(balance.toString(), 2);
}

export function WalletBar() {
  const { address, chainId, isConnected } = useAccount();
  const { connect, connectors, error: connectError, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const {
    switchChain,
    error: switchError,
    isPending: isSwitching,
  } = useSwitchChain();
  const isWrongNetwork = isConnected && chainId !== arcTestnet.id;

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
      <div className={styles.group}>
        <span className={styles.network}>
          <span className={styles.dot} aria-hidden="true" />
          Arc
        </span>
        <button
          className={styles.wallet}
          disabled={!connector || isConnecting}
          onClick={() => connector && connect({ connector })}
          title={connectError?.message ?? 'Connect an injected wallet'}
          type="button"
        >
          {isConnecting ? 'Connecting…' : connector ? 'Connect wallet' : 'No wallet found'}
        </button>
      </div>
    );
  }

  if (isWrongNetwork) {
    return (
      <div className={styles.group}>
        <span className={`${styles.network} ${styles.wrong}`}>
          <span className={styles.dot} aria-hidden="true" />
          Wrong network
        </span>
        <button
          className={`${styles.wallet} ${styles.switch}`}
          disabled={isSwitching}
          onClick={() => switchChain({ chainId: arcTestnet.id })}
          title={switchError?.message ?? `Add or switch to chain ${arcTestnet.id}`}
          type="button"
        >
          {isSwitching ? 'Switching…' : 'Switch to Arc'}
        </button>
      </div>
    );
  }

  return (
    <div className={styles.group}>
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
    </div>
  );
}
