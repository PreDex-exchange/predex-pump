import type { ActivityEvent, Market } from '@predex-pump/shared/domain';

import { ActivityDescription } from '@/components/activity/ActivityDescription';
import {
  dedupeActivityEvents,
  describeActivityEvent,
} from '@/lib/activity';

import styles from './ActivityList.module.css';

interface ActivityListProps {
  events: ActivityEvent[];
  markets: Market[];
  title?: string;
  emptyMessage?: string;
  error?: Error | null;
  isLoading?: boolean;
  sticky?: boolean;
}

export function ActivityList({
  events,
  markets,
  title = 'Activity',
  emptyMessage = 'Waiting for on-chain activity…',
  error = null,
  isLoading = false,
  sticky = true,
}: ActivityListProps) {
  const visibleEvents = dedupeActivityEvents(events);

  return (
    <aside className={`${styles.activity} ${sticky ? '' : styles.static}`}>
      <h2>
        <span aria-hidden="true" />
        {title}
      </h2>
      {error && (
        <p className={styles.error} role="alert">
          The indexed history is unavailable. Refresh to retry.
        </p>
      )}
      {!error && isLoading && visibleEvents.length === 0 && (
        <p className={styles.empty} role="status">
          Loading indexed activity…
        </p>
      )}
      {!error && !isLoading && visibleEvents.length === 0 && (
        <p className={styles.empty}>{emptyMessage}</p>
      )}
      {visibleEvents.length > 0 && (
        <ul>
          {visibleEvents.map((event) => {
            const description = describeActivityEvent(event, markets);
            return (
              <li key={event.id}>
                <span
                  className={`${styles.kind} ${styles[description.tone]}`}
                >
                  {description.label}
                </span>
                <span className={styles.text}>
                  <ActivityDescription
                    description={description}
                    marketClassName={styles.marketLink}
                    valueClassName={styles.value}
                  />
                </span>
                <time
                  className={styles.time}
                  dateTime={description.time.dateTime}
                >
                  {description.time.compact}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
