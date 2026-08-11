'use client';

import type { Market } from '@predex-pump/shared/domain';
import { useMemo, useState } from 'react';

import { StatePanel } from '@/components/ui/StatePanel';
import { useActivity, useMarkets } from '@/lib/api/hooks';
import { isMarketSettled } from '@/lib/market-state';

import { ActivityList } from './ActivityList';
import { Hero } from './Hero';
import { MarketCard } from './MarketCard';
import styles from './FeedScreen.module.css';

type FeedFilter = 'all' | 'incubating' | 'graduated' | 'resolved';
type FeedSort = 'trending' | 'newest' | 'volume';

const FILTERS: { value: FeedFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'incubating', label: 'Bootstrap' },
  { value: 'graduated', label: 'Graduated' },
  { value: 'resolved', label: 'Resolved' },
];

export function matchesFilter(market: Market, filter: FeedFilter) {
  if (filter === 'all') return true;
  if (filter === 'resolved') return isMarketSettled(market);
  if (isMarketSettled(market)) return false;
  if (filter === 'incubating') return market.phase === 'Opened';
  return market.phase === 'Graduated';
}

export function FeedScreen() {
  const [filter, setFilter] = useState<FeedFilter>('all');
  const [sort, setSort] = useState<FeedSort>('trending');
  const { data: marketPage, isLoading, error } = useMarkets();
  const { data: activityPage } = useActivity({ limit: 5 });

  const markets = useMemo(() => {
    const filtered = (marketPage?.items ?? []).filter((market) => matchesFilter(market, filter));
    return [...filtered].sort((left, right) => {
      if (sort === 'trending') return 0;
      if (sort === 'newest') return right.createdAt - left.createdAt;
      if (sort === 'volume') {
        const leftVolume = BigInt(left.volumeRaw);
        const rightVolume = BigInt(right.volumeRaw);
        return rightVolume > leftVolume ? 1 : rightVolume < leftVolume ? -1 : 0;
      }
      return 0;
    });
  }, [filter, marketPage?.items, sort]);

  return (
    <main>
      <Hero markets={marketPage?.items ?? []} />
      <section className={styles.discovery} id="how-it-works">
        <div aria-label="Filter markets" className={styles.filters} role="tablist">
          {FILTERS.map((item) => (
            <button
              aria-selected={item.value === filter}
              className={item.value === filter ? styles.active : ''}
              key={item.value}
              onClick={() => setFilter(item.value)}
              role="tab"
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
        <label className={styles.sort}>
          <span className="sr-only">Sort markets</span>
          <select onChange={(event) => setSort(event.target.value as FeedSort)} value={sort}>
            <option value="trending">Sort: Trending</option>
            <option value="newest">Sort: Newest</option>
            <option value="volume">Sort: Volume</option>
          </select>
          <span aria-hidden="true">⌄</span>
        </label>
      </section>

      <div className={styles.layout}>
        <section aria-label="Markets" className={styles.marketArea}>
          {isLoading && (
            <StatePanel
              message="Loading indexed markets and their latest prices."
              title="Warming the nest…"
            />
          )}
          {!isLoading && error && (
            <StatePanel
              message="The indexed API could not load the market feed. Refresh to retry."
              title="The nest needs a reset"
            />
          )}
          {!isLoading && !error && markets.length === 0 && (
            <StatePanel
              message="Try another phase, or launch the first market in this view."
              title="No markets in this nest yet"
            />
          )}
          {!isLoading && !error && markets.length > 0 && (
            <div className={styles.grid}>
              {markets.map((market) => (
                <MarketCard key={market.id} market={market} />
              ))}
            </div>
          )}
        </section>
        <ActivityList events={activityPage?.items ?? []} markets={marketPage?.items ?? []} />
      </div>
    </main>
  );
}
