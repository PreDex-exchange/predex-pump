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
      data.historyGaps.length === 0)
  ) {
    return null;
  }

  const lagBlocks = Math.max(0, data.lagBlocks);
  const latestGap = data.historyGaps[0];
  const label =
    data.indexerStatus === 'stalled'
      ? 'Indexer stalled'
      : latestGap !== undefined
        ? `Indexer history gap (${latestGap.skippedBlockCount.toLocaleString('en-US')} blocks)`
        : data.indexerStatus === 'degraded'
          ? 'Indexer retrying'
          : lagBlocks > 0
            ? `Indexer ${lagBlocks} ${lagBlocks === 1 ? 'block' : 'blocks'} behind`
            : 'Indexer catching up';
  const lastPoll =
    data.secondsSinceLastSuccessfulPoll === null
      ? 'No successful indexer poll recorded'
      : `Last successful poll ${data.secondsSinceLastSuccessfulPoll.toLocaleString('en-US')} seconds ago`;
  const historyGap =
    latestGap === undefined
      ? ''
      : `. History skipped blocks ${latestGap.skippedFromBlock.toLocaleString('en-US')}-${latestGap.skippedToBlock.toLocaleString('en-US')} at ${latestGap.recordedAt}`;

  return (
    <span
      aria-live="polite"
      className={styles.indicator}
      role="status"
      title={`${lastPoll}. Indexed block ${data.indexedBlock.toLocaleString('en-US')} of ${data.headBlock.toLocaleString('en-US')}${historyGap}`}
    >
      <span aria-hidden="true" className={styles.dot} />
      {label}
    </span>
  );
}
