'use client';

import type { Market } from '@predex-pump/shared/domain';
import { useEffect, useMemo, useState } from 'react';

import { StatePanel } from '@/components/ui/StatePanel';
import { useActivity, useMarkets } from '@/lib/api/hooks';
import { isMarketSettled } from '@/lib/market-state';

import { ActivityList } from './ActivityList';
import { Hero } from './Hero';
import { MarketCard } from './MarketCard';
import styles from './FeedScreen.module.css';

type FeedFilter = 'all' | 'incubating' | 'graduated' | 'resolved';
type FeedSort = 'newest' | 'volume';

const FILTERS: { value: FeedFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'incubating', label: 'Bootstrap' },
  { value: 'graduated', label: 'Graduated' },
  { value: 'resolved', label: 'Resolved' },
];

function feedFilter(value: string | null): FeedFilter {
  return FILTERS.some((filter) => filter.value === value)
    ? (value as FeedFilter)
    : 'all';
}

function feedSort(value: string | null): FeedSort {
  return value === 'volume' ? 'volume' : 'newest';
}

function replaceFeedUrl(filter: FeedFilter, sort: FeedSort) {
  const url = new URL(window.location.href);
  if (filter === 'all') url.searchParams.delete('filter');
  else url.searchParams.set('filter', filter);
  if (sort === 'newest') url.searchParams.delete('sort');
  else url.searchParams.set('sort', sort);
  window.history.replaceState(window.history.state, '', url);
}

function emptyMarketMessage(filter: FeedFilter) {
  if (filter === 'resolved') {
    return 'Try another phase, or wait for an open market to resolve.';
  }
  if (filter === 'graduated') {
    return 'Try another phase, or wait for a Bootstrap market to graduate.';
  }
  return 'Try another phase, or launch the first market in this view.';
}

export function matchesFilter(market: Market, filter: FeedFilter) {
  if (filter === 'all') return true;
  if (filter === 'resolved') return isMarketSettled(market);
  if (isMarketSettled(market)) return false;
  if (filter === 'incubating') return market.phase === 'Opened';
  return market.phase === 'Graduated';
}

export function FeedScreen() {
  const [filter, setFilter] = useState<FeedFilter>('all');
  const [sort, setSort] = useState<FeedSort>('newest');
  const {
    data: marketPage,
    isLoading,
    isLoadingMore,
    error,
    loadMore,
  } = useMarkets();
  const {
    data: activityPage,
    error: activityError,
    isLoading: activityIsLoading,
    refetch: refetchActivity,
  } = useActivity({ limit: 20 });

  useEffect(() => {
    const syncFromUrl = () => {
      const params = new URLSearchParams(window.location.search);
      setFilter(feedFilter(params.get('filter')));
      setSort(feedSort(params.get('sort')));
    };
    syncFromUrl();
    window.addEventListener('popstate', syncFromUrl);
    return () => window.removeEventListener('popstate', syncFromUrl);
  }, []);

  const markets = useMemo(() => {
    const filtered = (marketPage?.items ?? []).filter((market) => matchesFilter(market, filter));
    return [...filtered].sort((left, right) => {
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
      <Hero markets={error ? null : (marketPage?.items ?? null)} />
      <section className={styles.discovery} id="how-it-works">
        <div aria-label="Filter markets" className={styles.filters} role="group">
          {FILTERS.map((item) => (
            <button
              aria-pressed={item.value === filter}
              className={item.value === filter ? styles.active : ''}
              key={item.value}
              onClick={() => {
                setFilter(item.value);
                replaceFeedUrl(item.value, sort);
              }}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
        <label className={styles.sort}>
          <span className="sr-only">Sort markets</span>
          <select
            onChange={(event) => {
              const nextSort = feedSort(event.target.value);
              setSort(nextSort);
              replaceFeedUrl(filter, nextSort);
            }}
            value={sort}
          >
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
              showMascot={false}
              state="loading"
              title="Warming the nest…"
            />
          )}
          {!isLoading && error && (
            <StatePanel
              message="The indexed API could not load the market feed. Refresh to retry."
              showMascot={false}
              state="error"
              title="The nest needs a reset"
            />
          )}
          {!isLoading && !error && markets.length === 0 && (
            <StatePanel
              message={emptyMarketMessage(filter)}
              showMascot={false}
              state="empty"
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
          {!isLoading && !error && marketPage?.nextCursor && (
            <button
              className={styles.loadMore}
              disabled={isLoadingMore}
              onClick={loadMore}
              type="button"
            >
              {isLoadingMore ? 'Loading more markets…' : 'Load more markets'}
            </button>
          )}
        </section>
        <ActivityList
          error={activityError}
          events={activityPage?.items ?? []}
          isLoading={activityIsLoading}
          limit={5}
          markets={marketPage?.items ?? []}
          onRetry={refetchActivity}
        />
      </div>
    </main>
  );
}
