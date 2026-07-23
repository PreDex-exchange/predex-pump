import { HatchingChick } from '@/components/mascot/HatchingChick';

import styles from './StatePanel.module.css';

interface StatePanelProps {
  title: string;
  message: string;
  compact?: boolean;
}

export function StatePanel({ title, message, compact = false }: StatePanelProps) {
  return (
    <div className={`${styles.panel} ${compact ? styles.compact : ''}`}>
      <HatchingChick className={styles.mascot} decorative />
      <div>
        <h3>{title}</h3>
        <p>{message}</p>
      </div>
    </div>
  );
}
