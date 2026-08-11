import type { DedupCheckResponse } from '@predex-pump/shared/rest';
import Link from 'next/link';

import styles from './CreateScreen.module.css';

export interface DedupHintProps {
  response: DedupCheckResponse | null;
  pending?: boolean;
  error?: Error | null;
  feedbackEnabled?: boolean;
  feedbackError?: string | null;
  showActions?: boolean;
  showFeedback?: boolean;
  onAccept?: (marketId: string) => void;
  onReject?: (marketId: string) => void;
  onRetry?: () => void;
}

export function DedupHint({
  response,
  pending = false,
  error = null,
  feedbackEnabled = false,
  feedbackError = null,
  showActions = true,
  showFeedback = true,
  onAccept,
  onReject,
  onRetry,
}: DedupHintProps) {
  if (pending) {
    return (
      <aside
        aria-label="Duplicate check pending"
        className={`${styles.dedupHint} ${styles.dedupPending}`}
        role="status"
      >
        <strong>Checking for existing markets…</strong>
        <p>Launch will unlock when the latest question has been checked.</p>
      </aside>
    );
  }

  if (error !== null || response?.available === false) {
    return (
      <aside
        aria-label="Duplicate check unavailable"
        className={`${styles.dedupHint} ${styles.dedupUnavailable}`}
        role="alert"
      >
        <strong>Duplicate check unavailable</strong>
        <p>
          We could not verify this question against existing markets. Retry the
          check before launching.
        </p>
        {onRetry && (
          <button
            className={styles.dedupRetry}
            onClick={onRetry}
            type="button"
          >
            Retry duplicate check
          </button>
        )}
      </aside>
    );
  }

  if (response?.available && !response.isDuplicate) {
    return (
      <aside
        aria-label="Duplicate check complete"
        className={`${styles.dedupHint} ${styles.dedupClear}`}
        role="status"
      >
        <strong>No matching market found</strong>
        <p>The latest question was checked against existing markets.</p>
      </aside>
    );
  }

  if (!response?.available || !response.isDuplicate) return null;

  const duplicateCandidates = response.canonicalMarketId
    ? response.candidates.filter(
        (candidate) => candidate.marketId === response.canonicalMarketId,
      )
    : [];

  return (
    <aside
      aria-label="Possible duplicate market"
      className={styles.dedupHint}
      role="status"
    >
      <div>
        <strong>A market for this already exists</strong>
        <p>
          These look like the same real-world question. You can still launch
          intentionally after reviewing the existing market.
        </p>
      </div>
      {duplicateCandidates.length > 0 && (
        <ul className={styles.dedupCandidates}>
          {duplicateCandidates.map((candidate) => (
            <li key={candidate.marketId}>
              <Link
                className={styles.dedupCandidateQuestion}
                href={`/market/${candidate.marketId}`}
                onClick={() => onAccept?.(candidate.marketId)}
              >
                {candidate.question}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {showActions && response.canonicalMarketId && (
        <div className={styles.dedupActions}>
          <Link
            className={styles.dedupTradeLink}
            href={`/market/${response.canonicalMarketId}`}
            onClick={() => onAccept?.(response.canonicalMarketId ?? '')}
          >
            Trade it instead
            <span aria-hidden="true">→</span>
          </Link>
          {onReject && (
            <button
              className={styles.dedupReject}
              onClick={() => onReject(response.canonicalMarketId ?? '')}
              type="button"
            >
              Keep my draft
            </button>
          )}
        </div>
      )}
      {showFeedback && (
        <small
          className={
            feedbackError
              ? styles.dedupFeedbackError
              : styles.dedupFeedbackNote
          }
        >
          {feedbackError ??
            (feedbackEnabled
              ? 'Your accept/reject choice is saved to improve your account experience.'
              : 'Sign in if you want this accept/reject choice saved to your account.')}
        </small>
      )}
    </aside>
  );
}
