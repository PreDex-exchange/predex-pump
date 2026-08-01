import type { DedupCheckResponse } from '@predex-pump/shared/rest';
import Link from 'next/link';

import styles from './CreateScreen.module.css';

export interface DedupHintProps {
  response: DedupCheckResponse | null;
  feedbackEnabled?: boolean;
  feedbackError?: string | null;
  onAccept?: (marketId: string) => void;
  onReject?: (marketId: string) => void;
}

export function DedupHint({
  response,
  feedbackEnabled = false,
  feedbackError = null,
  onAccept,
  onReject,
}: DedupHintProps) {
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
                <Link
                  href={`/market/${candidate.marketId}`}
                  onClick={() => onAccept?.(candidate.marketId)}
                >
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
        <div className={styles.dedupActions}>
          <Link
            className={styles.dedupTradeLink}
            href={`/market/${response.canonicalMarketId}`}
            onClick={() => onAccept?.(response.canonicalMarketId ?? '')}
          >
            Trade it instead
            <span aria-hidden="true">→</span>
          </Link>
          <button
            className={styles.dedupReject}
            onClick={() => onReject?.(response.canonicalMarketId ?? '')}
            type="button"
          >
            Keep my draft
          </button>
        </div>
      )}
      <small className={feedbackError ? styles.dedupFeedbackError : styles.dedupFeedbackNote}>
        {feedbackError ??
          (feedbackEnabled
            ? 'Your accept/reject choice is saved to improve your account experience.'
            : 'Sign in if you want this accept/reject choice saved to your account.')}
      </small>
    </aside>
  );
}
