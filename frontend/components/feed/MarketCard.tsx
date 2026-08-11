'use client';

import type { Market, PricePoint } from '@predex-pump/shared/domain';
import Link from 'next/link';

import { PhaseBadge } from '@/components/ui/Badge';
import { NumberDisplay } from '@/components/ui/NumberDisplay';
import { usePriceHistory } from '@/lib/api/hooks';
import {
  formatPrice,
  formatUsdc,
  graduationPercent,
  relativeTime,
} from '@/lib/format';
import {
  displayMarketPhase,
  isMarketSettled,
  marketPriceRaw,
  resolvedOutcome,
} from '@/lib/market-state';

import styles from './MarketCard.module.css';

function sparklinePoints(points: PricePoint[]) {
  if (points.length < 2) return '0,16 120,16';

  const values = points.map((point) => Number(point.yesPriceRaw));
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = Math.max(40_000, maximum - minimum);

  return points
    .map((point, index) => {
      const x = (index / (points.length - 1)) * 120;
      const normalizedPrice = (Number(point.yesPriceRaw) - minimum) / range;
      const y = 28 - normalizedPrice * 22;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

function phaseDataValue(market: Market) {
  if (isMarketSettled(market)) {
    return market.phase === 'ClosedOut' ? 'closed' : 'resolved';
  }
  if (market.phase === 'Opened') return 'incubating';
  if (market.phase === 'Graduated') return 'graduated';
  if (market.phase === 'ClosedOut') return 'closed';
  return 'resolved';
}

interface MarketCardProps {
  market: Market;
  href?: string | null;
}

export function MarketCard({
  market,
  href = `/market/${market.id}`,
}: MarketCardProps) {
  const { data: priceHistory } = usePriceHistory(market.id);
  const graduation = graduationPercent(market);
  const isSettled = isMarketSettled(market);
  const visiblePhase = displayMarketPhase(market);
  const winner = resolvedOutcome(market);
  const yesPriceRaw = marketPriceRaw(market, 'YES');
  const noPriceRaw = marketPriceRaw(market, 'NO');

  const card = (
    <article className={styles.card} data-phase={phaseDataValue(market)}>
        <div className={styles.top}>
          <PhaseBadge phase={visiblePhase} surface="feed" />
          <span className={styles.time}>{relativeTime(market.createdAt)}</span>
        </div>
        <h2>{market.question}</h2>
        <div className={`${styles.prices} ${isSettled ? styles.settled : ''}`}>
          <div className={`${styles.price} ${styles.yes} ${winner === 'YES' ? styles.winner : ''}`}>
            <span className={styles.priceLabel}>YES</span>
            <NumberDisplay className={styles.priceValue} size="price">
              {formatPrice(yesPriceRaw)}
            </NumberDisplay>
          </div>
          <div className={`${styles.price} ${styles.no} ${winner === 'NO' ? styles.winner : ''}`}>
            <span className={styles.priceLabel}>NO</span>
            <NumberDisplay className={styles.priceValue} size="price">
              {formatPrice(noPriceRaw)}
            </NumberDisplay>
          </div>
        </div>
        <svg
          aria-hidden="true"
          className={styles.sparkline}
          preserveAspectRatio="none"
          viewBox="0 0 120 32"
        >
          <polyline points={sparklinePoints(priceHistory?.points ?? [])} />
        </svg>
        <div className={styles.foot}>
          <span className={styles.volume}>
            <span aria-hidden="true" />
            <span className="numeric">${formatUsdc(market.volumeRaw, 0)} vol</span>
          </span>
          {market.phase === 'Opened' && !isSettled && (
            <div className={styles.graduation}>
              <span className={styles.graduationLabel}>Graduation</span>
              <div
                aria-label={`${graduation}% to graduation`}
                className={styles.bar}
                role="progressbar"
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={graduation}
              >
                <span style={{ width: `${graduation}%` }} />
              </div>
              <NumberDisplay className={styles.percent} size="small" tone="yes">
                {graduation}%
              </NumberDisplay>
            </div>
          )}
          {market.phase === 'Graduated' && !isSettled && (
            <span className={styles.bookLive}>
              <span aria-hidden="true" />
              Order book live
            </span>
          )}
          {isSettled && (
            <span className={styles.resolvedTag}>
              <span aria-hidden="true">✓</span>
              {market.phase === 'ClosedOut'
                ? 'Closed out'
                : winner
                  ? `Resolved · ${winner === 'INVALID' ? 'Invalid' : winner}`
                  : 'Resolved'}
            </span>
          )}
        </div>
      </article>
  );

  if (href === null) {
    return (
      <div
        aria-label={`${market.question}, ${visiblePhase} preview`}
        className={`${styles.link} ${styles.preview}`}
        role="region"
      >
        {card}
      </div>
    );
  }

  return (
    <Link
      aria-label={`${market.question}, ${visiblePhase}`}
      className={styles.link}
      href={href}
    >
      {card}
    </Link>
  );
}
