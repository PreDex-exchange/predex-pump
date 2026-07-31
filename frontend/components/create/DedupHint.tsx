import type { DedupCheckResponse } from '@predex-pump/shared/rest';
import Link from 'next/link';

import styles from './CreateScreen.module.css';

export interface DedupHintProps {
  response: DedupCheckResponse | null;
}

export function DedupHint({ response }: DedupHintProps) {
  if (!response?.available || !response.isDuplicate) return null;

  return (
    <aside
      aria-label="Possible duplicate market"
      className={styles.dedupHint}
      role="status"
    >
      <div>
        <strong>A market for this already exists</strong>
        <p>
          These look like the same real-world question. This is only a hint;
          you can still launch this draft.
        </p>
      </div>
      {response.candidates.length > 0 && (
        <ul className={styles.dedupCandidates}>
          {response.candidates.map((candidate) => (
            <li key={candidate.marketId}>
              <span className={styles.dedupCandidateMeta}>
                <Link href={`/market/${candidate.marketId}`}>
                  Market #{candidate.marketId}
                </Link>
                <span>score {candidate.score.toFixed(3)}</span>
              </span>
              <small>{candidate.reason}</small>
            </li>
          ))}
        </ul>
      )}
      {response.canonicalMarketId && (
        <Link
          className={styles.dedupTradeLink}
          href={`/market/${response.canonicalMarketId}`}
        >
          Trade it instead
          <span aria-hidden="true">→</span>
        </Link>
      )}
    </aside>
  );
}
