'use client';

import { useHealth } from '@/lib/api/hooks';

import styles from './IndexerLagIndicator.module.css';

export function IndexerLagIndicator() {
  const { data } = useHealth();
  if (!data || (data.indexerStatus === 'healthy' && data.ok && data.lagBlocks <= 0)) {
    return null;
  }

  const lagBlocks = Math.max(0, data.lagBlocks);
  const label =
    data.indexerStatus === 'stalled'
      ? 'Indexer stalled'
      : data.indexerStatus === 'degraded'
        ? 'Indexer retrying'
        : lagBlocks > 0
          ? `Indexer ${lagBlocks} ${lagBlocks === 1 ? 'block' : 'blocks'} behind`
          : 'Indexer catching up';
  const lastPoll =
    data.secondsSinceLastSuccessfulPoll === null
      ? 'No successful indexer poll recorded'
      : `Last successful poll ${data.secondsSinceLastSuccessfulPoll.toLocaleString('en-US')} seconds ago`;

  return (
    <span
      aria-live="polite"
      className={styles.indicator}
      role="status"
      title={`${lastPoll}. Indexed block ${data.indexedBlock.toLocaleString('en-US')} of ${data.headBlock.toLocaleString('en-US')}`}
    >
      <span aria-hidden="true" className={styles.dot} />
      {label}
    </span>
  );
}
