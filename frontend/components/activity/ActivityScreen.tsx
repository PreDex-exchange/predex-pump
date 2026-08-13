'use client';

import type {
  ActivityEvent,
  ActivityType,
} from '@predex-pump/shared/domain';
import Link from 'next/link';
import {
  useEffect,
  useMemo,
  useState,
} from 'react';

import { ActivityDescription } from '@/components/activity/ActivityDescription';
import { Button } from '@/components/ui/Button';
import {
  activityActorKind,
  dedupeActivityEvents,
  describeActivityEvent,
  parseAgentAddresses,
  spokenActivityActor,
  type ActivityActorKind,
} from '@/lib/activity';
import { useActivity, useMarkets } from '@/lib/api/hooks';
import {
  backendWsClient,
  type BackendConnectionStatus,
} from '@/lib/api/websocket';
import { shortAddress } from '@/lib/format';

import styles from './ActivityScreen.module.css';

const ACTIVITY_LIMIT = 200;
const ACTIVITY_TYPES = new Set<ActivityType>([
  'MarketCreated',
  'Trade',
  'MarketGraduated',
  'BookSeeded',
  'OrderPlaced',
  'OrderFilled',
  'OrderCancelled',
  'ResolutionObserved',
  'Closeout',
  'Redeem',
]);

const explorerUrl = (
  process.env.NEXT_PUBLIC_ARC_EXPLORER_URL?.trim() ||
  'https://testnet.arcscan.app'
).replace(/\/+$/u, '');

export { parseAgentAddresses } from '@/lib/activity';

function isActivityEvent(value: unknown): value is ActivityEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Partial<ActivityEvent>;
  return (
    typeof event.id === 'string' &&
    typeof event.type === 'string' &&
    ACTIVITY_TYPES.has(event.type as ActivityType) &&
    (event.marketId === null || typeof event.marketId === 'string') &&
    (event.account === null || typeof event.account === 'string') &&
    typeof event.txHash === 'string' &&
    typeof event.ts === 'number' &&
    Number.isFinite(event.ts)
  );
}

function mergeEvents(
  liveEvents: readonly ActivityEvent[],
  indexedEvents: readonly ActivityEvent[],
) {
  return dedupeActivityEvents([...liveEvents, ...indexedEvents]);
}

function actorLabel(kind: ActivityActorKind) {
  if (kind === 'agent') return 'Autonomous agent';
  if (kind === 'human') return 'Human wallet';
  return 'Protocol';
}

const CONNECTION_COPY: Record<
  BackendConnectionStatus,
  { label: string; detail: string }
> = {
  idle: { label: 'Starting', detail: 'Opening the activity stream' },
  connecting: { label: 'Connecting', detail: 'Opening the activity stream' },
  live: { label: 'Live', detail: 'Listening for indexed Arc transactions' },
  reconnecting: {
    label: 'Reconnecting',
    detail: 'Restoring the stream and catching up from the index',
  },
};

interface ActivityScreenProps {
  agentAddresses?: ReadonlySet<string>;
}

export function ActivityScreen({
  agentAddresses = parseAgentAddresses(
    process.env.NEXT_PUBLIC_AGENT_ADDRESSES,
  ),
}: ActivityScreenProps) {
  const activity = useActivity({ limit: ACTIVITY_LIMIT });
  const markets = useMarkets({ limit: ACTIVITY_LIMIT });
  const [liveEvents, setLiveEvents] = useState<ActivityEvent[]>([]);
  const [connectionStatus, setConnectionStatus] =
    useState<BackendConnectionStatus>('connecting');

  useEffect(() => {
    const unsubscribeActivity = backendWsClient.subscribe(
      'activity',
      (message) => {
        if (message.event !== 'activity' || !isActivityEvent(message.data)) {
          return;
        }
        const event = message.data;
        setLiveEvents((current) =>
          current.some((currentEvent) => currentEvent.id === event.id)
            ? current
            : [event, ...current],
        );
      },
    );
    const unsubscribeStatus = backendWsClient.subscribeStatus((status) => {
      setConnectionStatus(status);
    });

    return () => {
      unsubscribeActivity();
      unsubscribeStatus();
    };
  }, []);

  const events = useMemo(
    () => mergeEvents(liveEvents, activity.data?.items ?? []),
    [activity.data?.items, liveEvents],
  );
  const connection = CONNECTION_COPY[connectionStatus];

  return (
    <main className={styles.page}>
      <header className={styles.intro}>
        <div>
          <p className={styles.eyebrow}>On-chain action tape</p>
          <h1>Agent activity</h1>
          <p className={styles.lede}>
            Watch autonomous agents and human wallets move markets on Arc as
            each transaction reaches the index.
          </p>
        </div>
        <div
          aria-live="polite"
          className={`${styles.connection} ${styles[connectionStatus]}`}
          role="status"
        >
          <span aria-hidden="true" className={styles.connectionDot} />
          <span>
            <strong>{connection.label}</strong>
            <small>{connection.detail}</small>
          </span>
        </div>
      </header>

      {agentAddresses.size === 0 && (
        <p className={styles.configuration} role="status">
          Autonomous wallet labels are unavailable, so wallet activity will
          appear under Human wallet.
        </p>
      )}
      {activity.error && events.length > 0 && (
        <p className={styles.warning} role="alert">
          The indexed history is unavailable, but live events will still appear
          while the live connection remains open.
        </p>
      )}

      <section aria-label="Live on-chain activity" className={styles.tape}>
        <div className={styles.tapeHeader}>
          <span>Actor</span>
          <span>What landed on-chain</span>
          <span>Transaction</span>
        </div>
        {activity.isLoading && events.length === 0 ? (
          <div className={styles.empty} role="status">
            <span aria-hidden="true" className={styles.waitingDot} />
            <div>
              <strong>Loading indexed history…</strong>
              <p>
                Checking the activity index before deciding whether this tape is
                empty.
              </p>
            </div>
          </div>
        ) : activity.error && events.length === 0 ? (
          <div className={styles.empty} role="alert">
            <span aria-hidden="true" className={styles.errorDot} />
            <div>
              <strong>Activity history could not load</strong>
              <p>
                The indexed request failed. This is not an empty activity state.
              </p>
              <Button
                onClick={activity.refetch}
                size="small"
                variant="neutral"
              >
                Try activity again
              </Button>
            </div>
          </div>
        ) : events.length === 0 ? (
          <div className={styles.empty} role="status">
            <span aria-hidden="true" className={styles.waitingDot} />
            <div>
              <strong>Waiting for activity…</strong>
              <p>
                Agent trades, market transitions, orders, fills, and redemptions
                will appear here live.
              </p>
            </div>
          </div>
        ) : (
          <>
            <ol
              aria-live="polite"
              aria-relevant="additions text"
              className={styles.events}
            >
              {events.map((event) => {
                const kind = activityActorKind(event, agentAddresses);
                const description = describeActivityEvent(
                  event,
                  markets.data?.items ?? [],
                );
                return (
                  <li className={`${styles.event} ${styles[kind]}`} key={event.id}>
                    <div className={styles.actor}>
                      <span className={styles.actorBadge}>{actorLabel(kind)}</span>
                      <strong title={event.account ?? undefined}>
                        {event.account === null
                          ? 'Predex contracts'
                          : shortAddress(event.account, 5, 4)}
                      </strong>
                    </div>
                    <p className={styles.sentence}>
                      <span className={styles.spokenActor}>
                        {spokenActivityActor(event, kind)}
                      </span>{' '}
                      <ActivityDescription
                        description={description}
                        marketClassName={styles.marketLink}
                        valueClassName={styles.money}
                      />
                    </p>
                    <div className={styles.transaction}>
                      <Link
                        aria-label={`View transaction ${event.txHash} on Arcscan`}
                        href={`${explorerUrl}/tx/${event.txHash}`}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {shortAddress(event.txHash, 5, 4)} ↗
                      </Link>
                      <time dateTime={description.time.dateTime}>
                        {description.time.full}
                      </time>
                    </div>
                  </li>
                );
              })}
            </ol>
            {activity.data?.nextCursor && (
              <button
                className={styles.loadMore}
                disabled={activity.isLoadingMore}
                onClick={activity.loadMore}
                type="button"
              >
                {activity.isLoadingMore ? 'Loading older activity…' : 'Load older activity'}
              </button>
            )}
          </>
        )}
      </section>
    </main>
  );
}
