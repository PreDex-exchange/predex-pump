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
      data.chainState.ready &&
      data.dedupIndex.status === 'ready' &&
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
  } else if (!data.chainState.ready) {
    label =
      data.chainState.status === 'failed' || data.chainState.issues.length > 0
        ? 'Chain configuration unavailable'
        : 'Chain configuration bootstrap pending';
  } else if (unreconciledGap !== undefined) {
    label = 'Balances unreconciled after indexer gap';
  } else if (latestGap !== undefined) {
    label = `Indexer history gap (${latestGap.skippedBlockCount.toLocaleString('en-US')} blocks)`;
  } else if (data.dedupIndex.status === 'unavailable') {
    label = 'Duplicate check unavailable';
  } else if (data.dedupIndex.status === 'degraded') {
    label =
      data.dedupIndex.queryProvider === 'fallback'
        ? 'Duplicate index using fallback'
        : 'Duplicate index degraded';
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
  const chainState = data.chainState.ready
    ? ''
    : `. Chain configuration bootstrap ${data.chainState.status}` +
      (data.chainState.attemptedBlock === null
        ? ''
        : ` at block ${data.chainState.attemptedBlock.toLocaleString('en-US')}`) +
      (data.chainState.issues.length === 0
        ? ''
        : `; invalid snapshots: ${data.chainState.issues.join(', ')}`) +
      (data.chainState.error === null ? '' : `; error: ${data.chainState.error}`);
  const dedupProvider = data.dedupIndex.providers[data.dedupIndex.configuredProvider];
  const dedupIndex =
    data.dedupIndex.status === 'ready'
      ? ''
      : `. Duplicate index ${data.dedupIndex.status}; configured provider ${data.dedupIndex.configuredProvider}; ` +
        `query provider ${data.dedupIndex.queryProvider ?? 'none'}; ` +
        `indexed ${dedupProvider.indexedMarketCount ?? 'unknown'}, ` +
        `missing ${dedupProvider.missingMarketCount ?? 'unknown'}` +
        (data.dedupIndex.error === null ? '' : `; error: ${data.dedupIndex.error}`);

  return (
    <span
      aria-live="polite"
      className={styles.indicator}
      role="status"
      title={`${lastPoll}. Indexed block ${data.indexedBlock.toLocaleString('en-US')} of ${data.headBlock.toLocaleString('en-US')}${historyGap}${balanceReconciliation}${chainState}${dedupIndex}`}
    >
      <span aria-hidden="true" className={styles.dot} />
      {label}
    </span>
  );
}
