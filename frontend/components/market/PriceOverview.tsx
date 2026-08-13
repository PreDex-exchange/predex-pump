'use client';

import type {
  Market,
  PricePoint,
  Resolution,
} from '@predex-pump/shared/domain';
import { useId, useMemo, useState } from 'react';

import { Card } from '@/components/ui/Card';
import { NumberDisplay } from '@/components/ui/NumberDisplay';
import { Tabs } from '@/components/ui/Tabs';
import { formatImpliedPercent, formatPrice } from '@/lib/format';
import { isMarketSettled, marketPriceRaw } from '@/lib/market-state';

import styles from './PriceOverview.module.css';

type Timeframe = '1h' | '1d' | '1w' | 'all';

function chartPaths(points: PricePoint[]) {
  const coordinates = points.map((point, index) => {
    const x = (index / (points.length - 1)) * 600;
    const price = Math.max(0, Math.min(1, Number(point.yesPriceRaw) / 1_000_000));
    return { x, y: 155 - price * 110 };
  });
  const line = coordinates.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  return {
    line,
    area: `${line} L600,180 L0,180 Z`,
  };
}

export function PriceOverview({
  market,
  points,
  resolution,
}: {
  market: Market;
  points: PricePoint[];
  resolution?: Resolution | null;
}) {
  const [timeframe, setTimeframe] = useState<Timeframe>('1d');
  const gradientId = useId().replaceAll(':', '');
  const settled = isMarketSettled(market, resolution);
  const graduated =
    market.phase === 'Graduated' || market.frozenYesPriceRaw !== null;
  const yesPriceRaw = marketPriceRaw(market, 'YES', resolution);
  const noPriceRaw = marketPriceRaw(market, 'NO', resolution);
  const visiblePoints = useMemo(() => {
    const count = timeframe === '1h' ? 3 : timeframe === '1d' ? 7 : points.length;
    return points.slice(-count);
  }, [points, timeframe]);
  const paths = visiblePoints.length >= 2 ? chartPaths(visiblePoints) : null;
  const priceCaption = settled
    ? 'payout · final'
    : graduated
      ? 'implied · frozen at graduation'
      : 'implied · live marginal';

  return (
    <Card>
      <div className={styles.prices}>
        <div className={`${styles.price} ${styles.yes}`}>
          <span>YES</span>
          <NumberDisplay size="price">{formatPrice(yesPriceRaw, 6)}</NumberDisplay>
          <small className="numeric">
            {formatImpliedPercent(yesPriceRaw)}%{' '}
            {priceCaption}
          </small>
        </div>
        <div className={`${styles.price} ${styles.no}`}>
          <span>NO</span>
          <NumberDisplay size="price">{formatPrice(noPriceRaw, 6)}</NumberDisplay>
          <small className="numeric">
            {formatImpliedPercent(noPriceRaw)}%{' '}
            {priceCaption}
          </small>
        </div>
      </div>
      <div className={styles.chartHeader}>
        <h2>Price</h2>
        <Tabs
          ariaLabel="Price chart timeframe"
          compact
          onChange={setTimeframe}
          options={[
            { value: '1h', label: '1H' },
            { value: '1d', label: '1D' },
            { value: '1w', label: '1W' },
            { value: 'all', label: 'All' },
          ]}
          value={timeframe}
        />
      </div>
      {paths === null ? (
        <div className={styles.emptyChart} role="status">
          <strong>No price history yet</strong>
          <span>At least two indexed price points are needed to draw a trend.</span>
        </div>
      ) : (
        <svg
          aria-label="YES price history on a 0 to 1 USDC scale"
          className={styles.chart}
          preserveAspectRatio="none"
          role="img"
          viewBox="0 0 600 180"
        >
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--yes)" stopOpacity=".22" />
              <stop offset="1" stopColor="var(--yes)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <line className={styles.gridLine} x1="0" x2="600" y1="45" y2="45" />
          <line className={styles.gridLine} x1="0" x2="600" y1="100" y2="100" />
          <line className={styles.gridLine} x1="0" x2="600" y1="155" y2="155" />
          <path d={paths.area} fill={`url(#${gradientId})`} />
          <path className={styles.line} d={paths.line} />
        </svg>
      )}
    </Card>
  );
}
