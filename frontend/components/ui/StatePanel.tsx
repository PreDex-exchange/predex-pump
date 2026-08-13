import type { ReactElement, ReactNode } from 'react';

import { HatchingChick } from '@/components/mascot/HatchingChick';

import styles from './StatePanel.module.css';

interface StatePanelBaseProps {
  title: string;
  message: string;
  compact?: boolean;
  showMascot?: boolean;
}

type StatePanelProps = StatePanelBaseProps &
  (
    | { actions: ReactElement; state: 'error' }
    | { actions?: ReactNode; state: 'empty' | 'loading' }
  );

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
