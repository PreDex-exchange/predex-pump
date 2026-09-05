import { shortAddress } from '@/lib/format';
import type { TxProgress } from '@/lib/chain/transactions';

import styles from './TxStatus.module.css';

export function TxStatus({ state }: { state: TxProgress }) {
  if (state.phase === 'idle') return null;
  const urgent =
    state.phase === 'rejected' ||
    state.phase === 'submission-unknown' ||
    state.phase === 'failed' ||
    state.phase === 'reverted';

  return (
    <div
      aria-live="polite"
      className={`${styles.status} ${styles[state.phase]}`}
      role={urgent ? 'alert' : 'status'}
    >
      <div className={styles.heading}>
        <span aria-hidden="true" />
        <strong>{state.phase.replaceAll('-', ' ')}</strong>
      </div>
      <p>{state.message}</p>
      {state.hash && (
        <code title={state.hash}>
          Tx {shortAddress(state.hash, 8, 6)}
        </code>
      )}
    </div>
  );
}
