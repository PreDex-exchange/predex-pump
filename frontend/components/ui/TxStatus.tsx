import { shortAddress } from '@/lib/format';
import type { TxProgress } from '@/lib/chain/transactions';

import styles from './TxStatus.module.css';

export function TxStatus({ state }: { state: TxProgress }) {
  if (state.phase === 'idle') return null;

  return (
    <div
      aria-live="polite"
      className={`${styles.status} ${styles[state.phase]}`}
      role={state.phase === 'reverted' ? 'alert' : 'status'}
    >
      <div className={styles.heading}>
        <span aria-hidden="true" />
        <strong>{state.phase.replaceAll('-', ' ')}</strong>
      </div>
      <p>{state.message}</p>
      {state.error && <pre>{state.error}</pre>}
      {state.hash && (
        <code title={state.hash}>
          Tx {shortAddress(state.hash, 8, 6)}
        </code>
      )}
    </div>
  );
}
