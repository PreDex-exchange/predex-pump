'use client';

import { useHealth } from '@/lib/api/hooks';

import styles from './IndexerLagIndicator.module.css';

export function IndexerLagIndicator() {
  const { data } = useHealth();
  if (
    !data ||
    (data.indexerStatus === 'healthy' &&
      data.ok &&
      data.lagBlocks <= 0 &&
      data.balancesReconciled &&
      data.historyGaps.length === 0)
  ) {
    return null;
  }

  const lagBlocks = Math.max(0, data.lagBlocks);
  const latestGap = data.historyGaps[0];
  const unreconciledGap = data.historyGaps.find(
    (gap) => gap.balanceReconciliationStatus !== 'complete',
  );
  let label = 'Indexer catching up';
  if (data.indexerStatus === 'stalled') {
    label = 'Indexer stalled';
  } else if (unreconciledGap !== undefined) {
    label = 'Balances unreconciled after indexer gap';
  } else if (latestGap !== undefined) {
    label = `Indexer history gap (${latestGap.skippedBlockCount.toLocaleString('en-US')} blocks)`;
  } else if (data.indexerStatus === 'degraded') {
    label = 'Indexer retrying';
  } else if (lagBlocks > 0) {
    label = `Indexer ${lagBlocks} ${lagBlocks === 1 ? 'block' : 'blocks'} behind`;
  }
  const lastPoll =
    data.secondsSinceLastSuccessfulPoll === null
      ? 'No successful indexer poll recorded'
      : `Last successful poll ${data.secondsSinceLastSuccessfulPoll.toLocaleString('en-US')} seconds ago`;
  const historyGap =
    latestGap === undefined
      ? ''
      : `. History skipped blocks ${latestGap.skippedFromBlock.toLocaleString('en-US')}-${latestGap.skippedToBlock.toLocaleString('en-US')} at ${latestGap.recordedAt}`;
  const balanceReconciliation =
    unreconciledGap === undefined
      ? ''
      : `. Balance reconciliation ${unreconciledGap.balanceReconciliationStatus}` +
        (unreconciledGap.balanceReconciliationError === null
          ? ''
          : `: ${unreconciledGap.balanceReconciliationError}`);

  return (
    <span
      aria-live="polite"
      className={styles.indicator}
      role="status"
      title={`${lastPoll}. Indexed block ${data.indexedBlock.toLocaleString('en-US')} of ${data.headBlock.toLocaleString('en-US')}${historyGap}${balanceReconciliation}`}
    >
      <span aria-hidden="true" className={styles.dot} />
      {label}
    </span>
  );
}
