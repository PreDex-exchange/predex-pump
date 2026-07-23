'use client';

import type { Market, PricePoint } from '@predex-pump/shared/domain';
import { useId, useMemo, useState } from 'react';

import { Card } from '@/components/ui/Card';
import { NumberDisplay } from '@/components/ui/NumberDisplay';
import { Tabs } from '@/components/ui/Tabs';
import { formatImpliedPercent, formatPrice } from '@/lib/format';

import styles from './PriceOverview.module.css';

type Timeframe = '1h' | '1d' | '1w' | 'all';

function chartPaths(points: PricePoint[], currentYesPriceRaw: string) {
  const values =
    points.length > 1
      ? points
      : [
          { yesPriceRaw: currentYesPriceRaw },
          { yesPriceRaw: currentYesPriceRaw },
        ];
  const rawValues = values.map((point) => Number(point.yesPriceRaw));
  const minimum = Math.min(...rawValues);
  const maximum = Math.max(...rawValues);
  const range = Math.max(40_000, maximum - minimum);
  const coordinates = values.map((point, index) => {
    const x = (index / (values.length - 1)) * 600;
    const value = (Number(point.yesPriceRaw) - minimum) / range;
    return { x, y: 150 - value * 105 };
  });
  const line = coordinates.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  return {
    line,
    area: `${line} L600,180 L0,180 Z`,
  };
}

export function PriceOverview({ market, points }: { market: Market; points: PricePoint[] }) {
  const [timeframe, setTimeframe] = useState<Timeframe>('1d');
  const gradientId = useId().replaceAll(':', '');
  const visiblePoints = useMemo(() => {
    const count = timeframe === '1h' ? 3 : timeframe === '1d' ? 7 : points.length;
    return points.slice(-count);
  }, [points, timeframe]);
  const paths = chartPaths(visiblePoints, market.yesPriceRaw);

  return (
    <Card>
      <div className={styles.prices}>
        <div className={`${styles.price} ${styles.yes}`}>
          <span>YES</span>
          <NumberDisplay size="price">{formatPrice(market.yesPriceRaw)}</NumberDisplay>
          <small className="numeric">
            {formatImpliedPercent(market.yesPriceRaw)}% implied · live marginal
          </small>
        </div>
        <div className={`${styles.price} ${styles.no}`}>
          <span>NO</span>
          <NumberDisplay size="price">{formatPrice(market.noPriceRaw)}</NumberDisplay>
          <small className="numeric">
            {formatImpliedPercent(market.noPriceRaw)}% implied · live marginal
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
      <svg
        aria-label="YES price history"
        className={styles.chart}
        preserveAspectRatio="none"
        role="img"
        viewBox="0 0 600 180"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#17b890" stopOpacity=".22" />
            <stop offset="1" stopColor="#17b890" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line className={styles.gridLine} x1="0" x2="600" y1="45" y2="45" />
        <line className={styles.gridLine} x1="0" x2="600" y1="100" y2="100" />
        <line className={styles.gridLine} x1="0" x2="600" y1="155" y2="155" />
        <path d={paths.area} fill={`url(#${gradientId})`} />
        <path className={styles.line} d={paths.line} />
      </svg>
    </Card>
  );
}
