'use client';

import type {
  ActivityEvent,
  ActivityType,
  Market,
} from '@predex-pump/shared/domain';
import Link from 'next/link';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { useActivity, useMarkets } from '@/lib/api/hooks';
import {
  backendWsClient,
  type BackendConnectionStatus,
} from '@/lib/api/websocket';
import {
  formatDateTime,
  formatPrice,
  formatRaw,
  shortAddress,
} from '@/lib/format';

import styles from './ActivityScreen.module.css';

const ACTIVITY_LIMIT = 200;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/iu;
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

export function parseAgentAddresses(value: string | undefined) {
  return new Set(
    (value ?? '')
      .split(',')
      .map((address) => address.trim().toLowerCase())
      .filter((address) => ADDRESS_PATTERN.test(address)),
  );
}

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
  const seen = new Set<string>();
  return [...liveEvents, ...indexedEvents].filter((event) => {
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
}

function marketLabel(event: ActivityEvent, markets: readonly Market[]) {
  if (event.marketId === null) return 'the protocol';
  return (
    markets.find((market) => market.id === event.marketId)?.question ??
    `market #${event.marketId}`
  );
}

function quantity(event: ActivityEvent) {
  if (!event.amountRaw) return null;
  return formatRaw(event.amountRaw, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function estimatedNotional(event: ActivityEvent) {
  if (!event.amountRaw || !event.priceRaw) return null;
  try {
    return (
      (BigInt(event.amountRaw) * BigInt(event.priceRaw) + 500_000n) /
      1_000_000n
    ).toString();
  } catch {
    return null;
  }
}

function Money({ children }: { children: ReactNode }) {
  return <span className={styles.money}>{children}</span>;
}

function MarketName({
  event,
  markets,
}: {
  event: ActivityEvent;
  markets: readonly Market[];
}) {
  const label = marketLabel(event, markets);
  return event.marketId === null ? (
    <strong>{label}</strong>
  ) : (
    <Link className={styles.marketLink} href={`/market/${event.marketId}`}>
      “{label}”
    </Link>
  );
}

function actionSentence(event: ActivityEvent, markets: readonly Market[]) {
  const amount = quantity(event);
  const notional = estimatedNotional(event);
  const price = event.priceRaw ? `$${formatPrice(event.priceRaw)}` : null;
  const market = <MarketName event={event} markets={markets} />;

  if (event.type === 'MarketCreated') {
    return <>created {market} and opened its LMSR curve.</>;
  }
  if (event.type === 'Trade') {
    const verb = event.side === 'ASK' ? 'sold' : 'bought';
    return (
      <>
        {verb} <Money>{amount ?? '—'} {event.outcome ?? ''}</Money> shares on {market}
        {price && <> at <Money>{price}</Money></>}
        {notional && (
          <> for about <Money>{formatRaw(notional)} USDC</Money></>
        )}.
      </>
    );
  }
  if (event.type === 'OrderPlaced') {
    return (
      <>
        placed a <Money>{amount ?? '—'} {event.outcome ?? ''}</Money>{' '}
        {event.side === 'ASK' ? 'ask' : 'bid'} on {market}
        {price && <> at <Money>{price}</Money></>}.
      </>
    );
  }
  if (event.type === 'OrderFilled') {
    return (
      <>
        filled <Money>{amount ?? '—'} {event.outcome ?? ''}</Money> shares from
        the order book on {market}
        {price && <> at <Money>{price}</Money></>}
        {notional && (
          <> for about <Money>{formatRaw(notional)} USDC</Money></>
        )}.
      </>
    );
  }
  if (event.type === 'OrderCancelled') {
    return (
      <>
        cancelled a <Money>{amount ?? '—'} {event.outcome ?? ''}</Money>{' '}
        {event.side === 'ASK' ? 'ask' : 'bid'} on {market}.
      </>
    );
  }
  if (event.type === 'MarketGraduated') {
    return <>graduated {market} from the LMSR curve to its order book.</>;
  }
  if (event.type === 'BookSeeded') {
    return (
      <>
        seeded the first order-book depth on {market}
        {amount && <> with <Money>{amount}</Money> complete sets</>}.
      </>
    );
  }
  if (event.type === 'ResolutionObserved') {
    return (
      <>
        observed the <Money>{event.outcome ?? 'committee'}</Money> resolution
        for {market}.
      </>
    );
  }
  if (event.type === 'Redeem') {
    return (
      <>
        redeemed <Money>{amount ?? '—'} USDC</Money> from {market}.
      </>
    );
  }
  return event.type === 'Closeout' ? (
    <>closed out {market} on-chain.</>
  ) : (
    <>acted on {market}.</>
  );
}

type ActorKind = 'agent' | 'human' | 'protocol';

function actorKind(event: ActivityEvent, agentAddresses: ReadonlySet<string>): ActorKind {
  if (event.account === null) return 'protocol';
  return agentAddresses.has(event.account.toLowerCase()) ? 'agent' : 'human';
}

function actorLabel(kind: ActorKind) {
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
  const refetchActivity = useRef(activity.refetch);
  const wasDisconnected = useRef(false);

  useEffect(() => {
    refetchActivity.current = activity.refetch;
  }, [activity.refetch]);

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
      if (status === 'reconnecting') wasDisconnected.current = true;
      if (status === 'live' && wasDisconnected.current) {
        wasDisconnected.current = false;
        refetchActivity.current();
      }
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
          No agent wallets are configured. Set{' '}
          <code>NEXT_PUBLIC_AGENT_ADDRESSES</code> to label autonomous actions.
        </p>
      )}
      {activity.error && (
        <p className={styles.warning} role="alert">
          The indexed history is unavailable, but live events will still appear
          while the WebSocket is connected.
        </p>
      )}

      <section aria-label="Live on-chain activity" className={styles.tape}>
        <div className={styles.tapeHeader}>
          <span>Actor</span>
          <span>What landed on-chain</span>
          <span>Transaction</span>
        </div>
        {events.length === 0 ? (
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
          <ol
            aria-live="polite"
            aria-relevant="additions text"
            className={styles.events}
          >
            {events.map((event) => {
              const kind = actorKind(event, agentAddresses);
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
                      {kind === 'agent'
                        ? 'Agent'
                        : kind === 'human'
                          ? 'Human'
                          : 'Protocol'}{' '}
                      {event.account === null
                        ? ''
                        : shortAddress(event.account, 5, 4)}{' '}
                    </span>
                    {actionSentence(event, markets.data?.items ?? [])}
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
                    <time dateTime={new Date(event.ts * 1000).toISOString()}>
                      {formatDateTime(event.ts)}
                    </time>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </main>
  );
}
