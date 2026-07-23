'use client';

import type { Market, PricePoint } from '@predex-pump/shared/domain';
import Link from 'next/link';

import { CrackingEgg } from '@/components/mascot/HatchingChick';
import { PhaseBadge } from '@/components/ui/Badge';
import { NumberDisplay } from '@/components/ui/NumberDisplay';
import { usePriceHistory } from '@/lib/api/hooks';
import {
  formatPrice,
  formatUsdc,
  graduationPercent,
  relativeTime,
} from '@/lib/format';
import { MOCK_REFERENCE_TS } from '@/lib/mock/data';

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
  if (market.phase === 'Opened') return 'incubating';
  if (market.phase === 'Graduated') return 'graduated';
  if (market.phase === 'ClosedOut') return 'closed';
  return 'resolved';
}

export function MarketCard({ market }: { market: Market }) {
  const { data: priceHistory } = usePriceHistory(market.id);
  const graduation = graduationPercent(market);
  const isSettled = market.phase === 'ResolvedObserved' || market.phase === 'ClosedOut';
  const winner =
    isSettled && market.yesPriceRaw === '1000000'
      ? 'YES'
      : isSettled && market.noPriceRaw === '1000000'
        ? 'NO'
        : null;

  return (
    <Link
      aria-label={`${market.question}, ${market.phase}`}
      className={styles.link}
      href={`/market/${market.id}`}
    >
      <article className={styles.card} data-phase={phaseDataValue(market)}>
        <div className={styles.top}>
          <PhaseBadge phase={market.phase} surface="feed" />
          <span className={styles.time}>{relativeTime(market.createdAt, MOCK_REFERENCE_TS)}</span>
        </div>
        <h2>{market.question}</h2>
        <div className={`${styles.prices} ${isSettled ? styles.settled : ''}`}>
          <div className={`${styles.price} ${styles.yes} ${winner === 'YES' ? styles.winner : ''}`}>
            <span className={styles.priceLabel}>YES</span>
            <NumberDisplay className={styles.priceValue} size="price">
              {formatPrice(market.yesPriceRaw)}
            </NumberDisplay>
          </div>
          <div className={`${styles.price} ${styles.no} ${winner === 'NO' ? styles.winner : ''}`}>
            <span className={styles.priceLabel}>NO</span>
            <NumberDisplay className={styles.priceValue} size="price">
              {formatPrice(market.noPriceRaw)}
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
          {market.phase === 'Opened' && (
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
                <span style={{ width: `${graduation}%` }}>
                  <CrackingEgg progress={graduation} />
                </span>
              </div>
              <NumberDisplay className={styles.percent} size="small" tone="yes">
                {graduation}%
              </NumberDisplay>
            </div>
          )}
          {market.phase === 'Graduated' && (
            <span className={styles.bookLive}>
              <span aria-hidden="true" />
              Order book live
            </span>
          )}
          {isSettled && (
            <span className={styles.resolvedTag}>
              <span aria-hidden="true">✓</span>
              {market.phase === 'ClosedOut' ? 'Closed out' : `Resolved · ${winner ?? 'Invalid'}`}
            </span>
          )}
        </div>
      </article>
    </Link>
  );
}
