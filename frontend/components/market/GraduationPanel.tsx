'use client';

import type { Market } from '@predex-pump/shared/domain';
import { useState } from 'react';
import { useAccount } from 'wagmi';

import { CrackingEgg } from '@/components/mascot/HatchingChick';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { TxStatus } from '@/components/ui/TxStatus';
import { arcTestnet } from '@/lib/chain/arc';
import { graduateOnArc } from '@/lib/chain/transactions';
import { useGraduationStatus } from '@/lib/chain/useGraduationStatus';
import { useTxFlow } from '@/lib/chain/useTxFlow';
import {
  formatDateTime,
  formatUsdc,
  graduationPercent,
} from '@/lib/format';

import styles from './GraduationPanel.module.css';

export function GraduationPanel({ market }: { market: Market }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { address, chainId, isConnected } = useAccount();
  const tx = useTxFlow();
  const status = useGraduationStatus(market.id);
  const liveMarket = status.data
    ? {
        ...market,
        graduationActivityRaw: status.data.activityMoneyInRaw,
        params: {
          ...market.params,
          graduationMoneyInThresholdRaw: status.data.activityThresholdRaw,
        },
      }
    : market;
  const progress = graduationPercent(liveMarket);
  const qualified = status.data?.qualified === true;
  const isWrongNetwork = isConnected && chainId !== arcTestnet.id;
  const canGraduate =
    qualified &&
    Boolean(address) &&
    isConnected &&
    !isWrongNetwork &&
    market.phase === 'Opened';

  async function handleGraduate() {
    if (!address || !canGraduate) return;
    const result = await tx.execute((report) =>
      graduateOnArc({
        account: address,
        marketId: BigInt(market.id),
        report,
      }),
    );
    if (!result) return;

    // Indexed market/book/activity display state arrives over WebSocket.
    // graduationStatus remains a direct chain read.
    void status.refetch();
  }

  function closeConfirm() {
    if (tx.isBusy) return;
    setConfirmOpen(false);
    tx.reset();
  }

  const timeGateBoundary =
    status.data && status.data.minimumTimeOpen > 0
      ? status.data.earliestGraduationAt
      : null;

  return (
    <>
      <Card className={styles.card}>
        <div className={styles.eggWrap}>
          <CrackingEgg progress={progress} />
        </div>
        <div className={styles.body}>
          <h2>This market is incubating</h2>
          <p>
            It trades on a bonding curve now. Once the live activity and time gates pass, a
            one-time{' '}
            <strong className="numeric">
              {formatUsdc(market.params.graduationTollRaw)} USDC
            </strong>{' '}
            toll hatches it into the order book.
          </p>
          <div
            aria-label={`${progress}% to graduation`}
            className={styles.bar}
            role="progressbar"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={progress}
          >
            <span style={{ width: `${progress}%` }} />
          </div>
          <div className={styles.row}>
            <strong className="numeric">{progress}% to graduation</strong>
            <span className="numeric">
              ${formatUsdc(liveMarket.graduationActivityRaw, 0)} of $
              {formatUsdc(
                liveMarket.params.graduationMoneyInThresholdRaw,
                0,
              )}{' '}
              non-creator activity
            </span>
          </div>
          <div className={styles.action}>
            <span>
              {status.error
                ? `Eligibility read failed: ${status.error.message}`
                : qualified
                  ? 'Live graduationStatus: qualified'
                  : timeGateBoundary
                    ? `Gates pending · earliest time ${formatDateTime(timeGateBoundary)}`
                    : status.isLoading
                      ? 'Reading live graduationStatus…'
                      : 'Activity or time gate is not yet satisfied'}
            </span>
            <Button
              disabled={!canGraduate}
              onClick={() => setConfirmOpen(true)}
              size="small"
              variant="coral"
            >
              {!isConnected
                ? 'Connect wallet'
                : isWrongNetwork
                  ? 'Switch to Arc'
                  : qualified
                    ? 'Graduate market'
                    : 'Not qualified yet'}
            </Button>
          </div>
        </div>
      </Card>

      <ConfirmModal
        closeDisabled={tx.isBusy}
        closeOnConfirm={false}
        confirmDisabled={tx.isBusy || tx.state.phase === 'confirmed'}
        confirmLabel={
          tx.state.phase === 'reverted'
            ? 'Retry graduation'
            : tx.state.phase === 'confirmed'
              ? 'Confirmed'
              : 'Approve toll & graduate'
        }
        kicker="Live Arc transaction"
        onClose={closeConfirm}
        onConfirm={handleGraduate}
        open={confirmOpen}
        title="Graduate this market"
      >
        <p>
          Eligibility and the immutable market toll are re-read before signing. If needed, the
          wallet first approves Registry spending for the six-decimal ERC-20 toll, then calls{' '}
          <code>graduateIfQualified({market.id})</code>.
        </p>
        <TxStatus state={tx.state} />
      </ConfirmModal>
    </>
  );
}
