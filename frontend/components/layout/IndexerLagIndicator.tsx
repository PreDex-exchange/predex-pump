'use client';

import { useHealth } from '@/lib/api/hooks';

import styles from './IndexerLagIndicator.module.css';

export function IndexerLagIndicator() {
  const { data } = useHealth();
  if (!data || (data.ok && data.lagBlocks <= 0)) return null;

  const lagBlocks = Math.max(0, data.lagBlocks);
  const label =
    lagBlocks > 0
      ? `Indexer ${lagBlocks} ${lagBlocks === 1 ? 'block' : 'blocks'} behind`
      : 'Indexer catching up';

  return (
    <span
      aria-live="polite"
      className={styles.indicator}
      role="status"
      title={`Indexed block ${data.indexedBlock.toLocaleString('en-US')} of ${data.headBlock.toLocaleString('en-US')}`}
    >
      <span aria-hidden="true" className={styles.dot} />
      {label}
    </span>
  );
}
