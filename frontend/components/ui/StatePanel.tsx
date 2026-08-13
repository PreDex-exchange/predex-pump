import type { ReactNode } from 'react';

import { HatchingChick } from '@/components/mascot/HatchingChick';

import styles from './StatePanel.module.css';

interface StatePanelProps {
  title: string;
  message: string;
  compact?: boolean;
  actions?: ReactNode;
  showMascot?: boolean;
  state: 'empty' | 'error' | 'loading';
}

export function StatePanel({
  title,
  message,
  compact = false,
  actions,
  showMascot = false,
  state,
}: StatePanelProps) {
  return (
    <div
      className={`${styles.panel} ${compact ? styles.compact : ''} ${
        showMascot ? '' : styles.withoutMascot
      }`}
      role={
        state === 'error' ? 'alert' : state === 'loading' ? 'status' : undefined
      }
    >
      {showMascot && <HatchingChick className={styles.mascot} decorative />}
      <div className={styles.content}>
        <h3>{title}</h3>
        <p>{message}</p>
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
    </div>
  );
}
