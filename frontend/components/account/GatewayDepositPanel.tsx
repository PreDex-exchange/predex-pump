'use client';

import { CIRCLE_GATEWAY_WALLET_ADDRESS } from '@predex-pump/shared/tx';
import { useState } from 'react';
import type { Address, Hash } from 'viem';
import { useAccount, useReadContract } from 'wagmi';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { NumberDisplay } from '@/components/ui/NumberDisplay';
import { TxStatus } from '@/components/ui/TxStatus';
import { useGatewayBalance } from '@/lib/api/hooks';
import { arcAddresses, arcTestnet } from '@/lib/chain/arc';
import { collateralErc20Abi } from '@/lib/chain/contracts';
import { depositToCircleGatewayOnArc } from '@/lib/chain/transactions';
import { useTxFlow } from '@/lib/chain/useTxFlow';
import {
  formatRaw,
  parseUsdcInputResult,
  shortAddress,
} from '@/lib/format';

import styles from './GatewayDepositPanel.module.css';

const explorerUrl = (
  process.env.NEXT_PUBLIC_ARC_EXPLORER_URL?.trim() ||
  'https://testnet.arcscan.app'
).replace(/\/+$/u, '');

interface DepositResult {
  amountRaw: bigint;
  approvalTxHash: Hash;
  depositTxHash: Hash;
}

function formatGatewayUsdc(raw: string | bigint) {
  return formatRaw(raw.toString(), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

export function GatewayDepositPanel({
  sessionAddress,
}: {
  sessionAddress: Address;
}) {
  const { address, chainId, isConnected } = useAccount();
  const tx = useTxFlow();
  const [amount, setAmount] = useState('1.00');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<DepositResult | null>(null);
  const {
    data: gatewayBalance,
    isLoading: gatewayLoading,
    error: gatewayError,
    refetch: refetchGateway,
  } = useGatewayBalance(true);
  const walletBalance = useReadContract({
    address: arcAddresses.usdc,
    abi: collateralErc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: arcTestnet.id,
    query: {
      enabled: Boolean(address) && chainId === arcTestnet.id,
    },
  });

  const parsedAmount = parseUsdcInputResult(amount);
  const amountRaw = parsedAmount.ok ? BigInt(parsedAmount.raw) : null;
  const walletMatchesSession =
    Boolean(address) &&
    address?.toLowerCase() === sessionAddress.toLowerCase();
  const wrongNetwork = isConnected && chainId !== arcTestnet.id;
  const amountParseError = parsedAmount.ok
    ? null
    : {
        EMPTY: 'Enter a USDC amount.',
        NEGATIVE: 'USDC amount cannot be negative.',
        NON_NUMERIC: 'Enter a numeric USDC amount.',
        INVALID_FORMAT: 'Enter a USDC amount with one decimal point.',
        TOO_MANY_DECIMALS: 'USDC supports at most six decimal places.',
      }[parsedAmount.reason];
  const amountError =
    amountParseError ??
    (amountRaw !== null && amountRaw <= 0n
        ? 'Enter an amount greater than zero.'
        : amountRaw !== null &&
            walletBalance.data !== undefined &&
            amountRaw > walletBalance.data
          ? 'Amount exceeds this wallet’s Arc USDC balance.'
          : null);
  const canDeposit =
    Boolean(gatewayBalance) &&
    !gatewayLoading &&
    !gatewayError &&
    isConnected &&
    Boolean(address) &&
    walletMatchesSession &&
    !wrongNetwork &&
    walletBalance.data !== undefined &&
    !walletBalance.error &&
    amountError === null &&
    !tx.isBusy;

  async function deposit() {
    if (!address || amountRaw === null || !canDeposit) return;
    const hashes = await tx.execute((report) =>
      depositToCircleGatewayOnArc({ account: address, amountRaw, report }),
    );
    if (!hashes) return;
    setResult({ amountRaw, ...hashes });
    setConfirmOpen(false);
    tx.reset();
    refetchGateway();
    void walletBalance.refetch();
  }

  if (gatewayError) {
    return (
      <Card className={styles.unavailable} role="status">
        <div className={styles.cardHeading}>
          <div>
            <span>Circle Gateway</span>
            <h2>Gateway deposit unavailable</h2>
          </div>
          <span className={styles.unavailableBadge}>Unavailable</span>
        </div>
        <p>
          Circle’s balance service could not be reached, so predex will not ask
          you to sign a deposit with incomplete balance information. Your profile,
          watchlist, and every wallet-only market action remain available.
        </p>
        <Button onClick={refetchGateway} size="small" variant="neutral">
          Check Gateway again
        </Button>
      </Card>
    );
  }

  return (
    <Card className={styles.panel}>
      <div className={styles.cardHeading}>
        <div>
          <span>Circle Gateway</span>
          <h2>Fund your unified balance</h2>
        </div>
        <span className={styles.nonCustodial}>Non-custodial</span>
      </div>

      <div className={styles.balances} aria-label="Circle Gateway balance">
        <div>
          <span>Total</span>
          <NumberDisplay size="body">
            {gatewayLoading || !gatewayBalance
              ? '—'
              : `${formatGatewayUsdc(gatewayBalance.totalRaw)} USDC`}
          </NumberDisplay>
        </div>
        <div>
          <span>Available</span>
          <NumberDisplay size="body" tone="yes">
            {gatewayLoading || !gatewayBalance
              ? '—'
              : `${formatGatewayUsdc(gatewayBalance.availableRaw)} USDC`}
          </NumberDisplay>
        </div>
        <button
          className={styles.refresh}
          disabled={gatewayLoading}
          onClick={refetchGateway}
          type="button"
        >
          {gatewayLoading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      {gatewayBalance?.totalRaw === '0' && (
        <p className={styles.notice}>
          This Gateway balance is empty. A confirmed deposit will credit the signed-in
          address, never predex.
        </p>
      )}

      <div className={styles.destination}>
        <div>
          <span>From / balance owner</span>
          <code className="mono">{address ?? sessionAddress}</code>
        </div>
        <span aria-hidden="true">→</span>
        <div>
          <span>Circle Gateway wallet</span>
          <code className="mono">{CIRCLE_GATEWAY_WALLET_ADDRESS}</code>
        </div>
      </div>

      <label className={styles.amountField}>
        <span>Deposit amount</span>
        <span className={styles.amountInput}>
          <input
            aria-describedby="gateway-amount-help gateway-amount-error"
            aria-invalid={Boolean(amountError)}
            inputMode="decimal"
            onChange={(event) => {
              setAmount(event.target.value);
              setResult(null);
              tx.reset();
            }}
            value={amount}
          />
          <b>USDC</b>
        </span>
        <small id="gateway-amount-help">
          Wallet balance:{' '}
          <span className="numeric">
            {walletBalance.isLoading
              ? 'loading…'
              : walletBalance.data === undefined
                ? '—'
                : `${formatGatewayUsdc(walletBalance.data)} USDC`}
          </span>
        </small>
        {amountError && isConnected && !wrongNetwork && (
          <small className={styles.error} id="gateway-amount-error" role="alert">
            {amountError}
          </small>
        )}
      </label>

      <ol className={styles.steps} aria-label="Gateway deposit transaction steps">
        <li>
          <span>1</span>
          <div>
            <strong>Approve Arc USDC</strong>
            <small>
              Allow the Circle Gateway wallet to move exactly the amount above.
            </small>
          </div>
        </li>
        <li>
          <span>2</span>
          <div>
            <strong>Deposit to your balance</strong>
            <small>
              Call deposit(Arc USDC, amount); the connected address owns the credit.
            </small>
          </div>
        </li>
      </ol>

      {walletBalance.error && (
        <p className={styles.error} role="alert">
          The wallet’s Arc USDC balance could not be read. Deposit is unavailable.
        </p>
      )}
      {!isConnected && (
        <p className={styles.notice}>Reconnect the signed-in wallet to deposit.</p>
      )}
      {isConnected && !walletMatchesSession && (
        <p className={styles.error} role="alert">
          Connected wallet {address ? shortAddress(address) : ''} does not match the
          signed-in account {shortAddress(sessionAddress)}. Sign in with the connected
          wallet before depositing.
        </p>
      )}
      {wrongNetwork && (
        <p className={styles.error} role="alert">
          Switch the connected wallet to Arc Testnet before depositing.
        </p>
      )}

      <Button
        disabled={!canDeposit}
        fullWidth
        onClick={() => setConfirmOpen(true)}
        size="large"
        variant="coral"
      >
        {gatewayLoading
          ? 'Loading Gateway balance…'
          : tx.isBusy
            ? 'Deposit in progress…'
            : 'Review two-step deposit'}
      </Button>
      <p className={styles.keyNote}>
        Both transactions are signed by your connected wallet. predex never receives,
        stores, or asks for a private key.
      </p>

      {result && (
        <div className={styles.success} role="status">
          <strong>
            {formatGatewayUsdc(result.amountRaw)} USDC deposited on Arc
          </strong>
          <a href={`${explorerUrl}/tx/${result.approvalTxHash}`} rel="noreferrer" target="_blank">
            Approval {shortAddress(result.approvalTxHash, 8, 6)}
          </a>
          <a href={`${explorerUrl}/tx/${result.depositTxHash}`} rel="noreferrer" target="_blank">
            Deposit {shortAddress(result.depositTxHash, 8, 6)}
          </a>
        </div>
      )}

      <ConfirmModal
        closeDisabled={tx.isBusy}
        closeOnConfirm={false}
        confirmDisabled={!canDeposit}
        confirmLabel={tx.isBusy ? 'Processing…' : 'Approve, then deposit'}
        kicker="Circle Gateway · two Arc transactions"
        onClose={() => {
          if (!tx.isBusy) setConfirmOpen(false);
        }}
        onConfirm={deposit}
        open={confirmOpen}
        title={`Deposit ${amountRaw === null ? '—' : formatGatewayUsdc(amountRaw)} USDC`}
      >
        <p>
          You will see two wallet prompts. First approve the exact amount, then deposit it
          into the Circle Gateway balance owned by your connected address.
        </p>
        <dl className={styles.confirmRows}>
          <div>
            <dt>Balance owner</dt>
            <dd className="mono">{address}</dd>
          </div>
          <div>
            <dt>Destination</dt>
            <dd className="mono">{CIRCLE_GATEWAY_WALLET_ADDRESS}</dd>
          </div>
          <div>
            <dt>Amount</dt>
            <dd className="numeric">
              {amountRaw === null ? '—' : formatGatewayUsdc(amountRaw)} USDC
            </dd>
          </div>
        </dl>
        <TxStatus state={tx.state} />
      </ConfirmModal>
    </Card>
  );
}
