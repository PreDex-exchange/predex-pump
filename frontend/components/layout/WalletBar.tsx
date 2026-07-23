'use client';

import { formatUnits } from 'viem';
import {
  useAccount,
  useConnect,
  useDisconnect,
  useReadContract,
  useSwitchChain,
} from 'wagmi';

import { shortAddress } from '@/lib/format';
import { arcAddresses, arcTestnet } from '@/lib/chain/arc';

import styles from './WalletBar.module.css';

const erc20BalanceAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

function formatWalletBalance(balance?: bigint) {
  if (balance === undefined) return '—';
  const value = Number(formatUnits(balance, 6));
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function WalletBar() {
  const { address, chainId, isConnected } = useAccount();
  const { connect, connectors, error: connectError, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const isWrongNetwork = isConnected && chainId !== arcTestnet.id;

  const { data: usdcBalance, isLoading: isBalanceLoading } = useReadContract({
    address: arcAddresses.usdc,
    abi: erc20BalanceAbi,
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
