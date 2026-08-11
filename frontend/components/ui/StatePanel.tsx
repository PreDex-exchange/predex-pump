import type { ReactNode } from 'react';

import { HatchingChick } from '@/components/mascot/HatchingChick';

import styles from './StatePanel.module.css';

interface StatePanelProps {
  title: string;
  message: string;
  compact?: boolean;
  actions?: ReactNode;
  showMascot?: boolean;
}

export function StatePanel({
  title,
  message,
  compact = false,
  actions,
  showMascot = true,
}: StatePanelProps) {
  return (
    <div className={`${styles.panel} ${compact ? styles.compact : ''}`}>
      {showMascot && <HatchingChick className={styles.mascot} decorative />}
      <div>
        <h3>{title}</h3>
        <p>{message}</p>
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
    </div>
  );
}
