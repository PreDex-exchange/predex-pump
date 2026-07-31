import type { ActivityEvent, Market } from '@predex-pump/shared/domain';

import { formatPrice, formatRaw, relativeTime } from '@/lib/format';

import styles from './ActivityList.module.css';

function eventKind(event: ActivityEvent) {
  if (event.type === 'MarketCreated') return { label: 'Created', tone: 'created' };
  if (event.type === 'MarketGraduated' || event.type === 'BookSeeded') {
    return { label: 'Graduated', tone: 'graduated' };
  }
  if (event.type === 'ResolutionObserved' || event.type === 'Closeout') {
    return { label: 'Resolved', tone: 'resolved' };
  }
  if (event.type === 'Redeem') return { label: 'Redeemed', tone: 'resolved' };
  if (event.type === 'OrderPlaced') return { label: 'Order', tone: 'filled' };
  if (event.type === 'OrderCancelled') return { label: 'Cancelled', tone: 'created' };
  return { label: event.type === 'OrderFilled' ? 'Filled' : 'Trade', tone: 'filled' };
}

function eventText(event: ActivityEvent, markets: Market[]) {
  const market = markets.find((item) => item.id === event.marketId);
  if (event.type === 'MarketCreated' || event.type === 'MarketGraduated' || event.type === 'BookSeeded') {
    return market?.question ?? 'A market moved forward';
  }
  if (event.type === 'ResolutionObserved' || event.type === 'Closeout') {
    return `${market?.question ?? 'Market'} · ${event.outcome ?? 'settled'}`;
  }
  if (event.type === 'Redeem' && event.amountRaw) {
    return `${formatRaw(event.amountRaw, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    })} USDC · ${market?.question ?? 'resolved market'}`;
  }
  if (event.amountRaw && event.outcome && event.priceRaw) {
    return `${formatRaw(event.amountRaw, { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${event.outcome} @ ${formatPrice(event.priceRaw)}`;
  }
  return market?.question ?? 'On-chain activity';
}

interface ActivityListProps {
  events: ActivityEvent[];
  markets: Market[];
  title?: string;
  emptyMessage?: string;
  sticky?: boolean;
}

export function ActivityList({
  events,
  markets,
  title = 'Activity',
  emptyMessage = 'Waiting for on-chain activity…',
  sticky = true,
}: ActivityListProps) {
  return (
    <aside className={`${styles.activity} ${sticky ? '' : styles.static}`}>
      <h2>
        <span aria-hidden="true" />
        {title}
      </h2>
      {events.length === 0 ? (
        <p className={styles.empty}>{emptyMessage}</p>
      ) : (
        <ul>
          {events.map((event) => {
            const kind = eventKind(event);
            return (
              <li key={event.id}>
                <span className={`${styles.kind} ${styles[kind.tone]}`}>{kind.label}</span>
                <span className={styles.text}>{eventText(event, markets)}</span>
                <span className={styles.time}>
                  {relativeTime(event.ts).replace(' ago', '')}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
