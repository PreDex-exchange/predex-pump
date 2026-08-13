'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useAccount as useWalletAccount } from 'wagmi';

import { Button } from '@/components/ui/Button';
import { PhaseBadge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { StatePanel } from '@/components/ui/StatePanel';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  useAccount as useIndexedAccount,
  useAccountProfile,
  useMarket,
  useOrderBook,
  usePriceHistory,
} from '@/lib/api/hooks';
import { backendRestClient } from '@/lib/api/rest-client';
import {
  formatDateTime,
  relativeTime,
  shortAddress,
} from '@/lib/format';
import {
  displayMarketPhase,
  isMarketSettled,
} from '@/lib/market-state';

import { GraduationPanel } from './GraduationPanel';
import { LifecycleStepper } from './LifecycleStepper';
import { OrderBookPanel } from './OrderBookPanel';
import {
  ResolvedOutcomePanel,
} from './PhasePanels';
import { PriceOverview } from './PriceOverview';
import { RecentTrades } from './RecentTrades';
import { SettlementPanel } from './SettlementPanel';
import { TradePanel } from './TradePanel';
import styles from './MarketScreen.module.css';

export function MarketScreen({ marketId }: { marketId: string }) {
  const [clockSeconds, setClockSeconds] = useState(0);
  const [watchlistBusy, setWatchlistBusy] = useState(false);
  const [watchlistError, setWatchlistError] = useState<Error | null>(null);
  const recordedView = useRef<string | null>(null);
  const queryClient = useQueryClient();
  const { address } = useWalletAccount();
  const { session, isSigningIn, signIn } = useAuth();
  const authenticated = session?.authenticated === true;
  const { data: detail, isLoading, error } = useMarket(marketId);
  const { data: priceHistory } = usePriceHistory(marketId);
  const {
    data: book,
    isLoading: bookLoading,
    error: bookError,
    refetch: refetchBook,
  } = useOrderBook(marketId);
  const { data: account } = useIndexedAccount(address);
  const {
    data: accountProfile,
    isLoading: profileLoading,
    error: profileError,
  } = useAccountProfile(authenticated);

  useEffect(() => {
    const updateClock = () => setClockSeconds(Math.floor(Date.now() / 1000));
    const initialTimer = window.setTimeout(updateClock, 0);
    const interval = window.setInterval(updateClock, 30_000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (
      !detail ||
      !session?.authenticated ||
      !accountProfile?.profile.preferences.rememberRecentlyViewed
    ) {
      return;
    }
    const key = `${session.address.toLowerCase()}:${detail.market.id}`;
    if (recordedView.current === key) return;
    recordedView.current = key;
    void backendRestClient
      .recordAccountBehavior({
        type: 'MARKET_VIEWED',
        marketId: detail.market.id,
      })
      .then(() =>
        queryClient.invalidateQueries({ queryKey: ['account-profile'] }),
      )
      .catch(() => {
        // Recently viewed is additive and must never disrupt the market/trade path.
      });
  }, [accountProfile, authenticated, detail, queryClient, session]);

  if (isLoading) {
    return (
      <main className={styles.state}>
        <StatePanel
          message="Loading the indexed market snapshot and recent activity."
          showMascot={false}
          state="loading"
          title="Checking this egg…"
        />
      </main>
    );
  }

  if (error) {
    return (
      <main className={styles.state}>
        <StatePanel
          message="The indexed market snapshot could not load. Return to the feed and retry."
          showMascot={false}
          state="error"
          title="This market would not open"
        />
      </main>
    );
  }

  if (!detail) {
    return (
      <main className={styles.state}>
        <StatePanel
          message="No MarketCreated event with that ID was found in the live deployment."
          showMascot={false}
          state="empty"
          title="No egg with that number"
        />
        <Link className={styles.backLink} href="/">
          ← Return to feed
        </Link>
      </main>
    );
  }

  const { market, recentTrades, resolution, settlementEvents } = detail;
  const positions = account?.positions.filter(
    (item) => item.marketId === market.id,
  );
  const isSettled = isMarketSettled(market, resolution);
  const isIncubating = market.phase === 'Opened' && !isSettled;
  const isGraduated = market.phase === 'Graduated' && !isSettled;
  const visiblePhase = displayMarketPhase(market, resolution);
  const settlementReady =
    isGraduated ||
    isSettled ||
    clockSeconds >= market.tradingEndsAt;
  const isWatchlisted =
    accountProfile?.watchlist.some((item) => item.id === market.id) ?? false;

  async function toggleWatchlist() {
    if (!authenticated) {
      await signIn();
      return;
    }
    setWatchlistBusy(true);
    setWatchlistError(null);
    try {
      await backendRestClient.setWatchlist(market.id, !isWatchlisted);
      await queryClient.invalidateQueries({ queryKey: ['account-profile'] });
    } catch (caught) {
      setWatchlistError(
        caught instanceof Error
          ? caught
          : new Error('The watchlist could not be updated.'),
      );
    } finally {
      setWatchlistBusy(false);
    }
  }

  const orderBookSurface = bookLoading ? (
    <Card>
      <h2 className={styles.bookLoadingTitle}>Order book</h2>
      <p className={styles.bookLoading}>
        Loading the labelled live venue and its indexed orders…
      </p>
    </Card>
  ) : bookError ? (
    <Card role="alert">
      <h2 className={styles.bookLoadingTitle}>Order book unavailable</h2>
      <p className={styles.bookLoading}>
        The live venue could not be verified, so no ladder or order action is shown.
      </p>
      <Button onClick={refetchBook} size="small" variant="neutral">
        Try the book again
      </Button>
    </Card>
  ) : book ? (
    <OrderBookPanel books={book} market={market} positions={positions} />
  ) : (
    <Card>
      <h2 className={styles.bookLoadingTitle}>No live order book</h2>
      <p className={styles.bookLoading}>
        This market does not have a venue snapshot yet.
      </p>
    </Card>
  );

  return (
    <main className={styles.page}>
      <Link className={styles.crumb} href="/">
        ← Feed
      </Link>
      <header className={styles.marketHeader}>
        <div className={styles.headerRow}>
          <div>
            <div className={styles.metaRow}>
              <PhaseBadge phase={visiblePhase} />
              <span>
                by <code className="mono">{shortAddress(market.creator, 4, 3)}</code>
              </span>
              <span>opened {relativeTime(market.createdAt)}</span>
              <span>trading ends {formatDateTime(market.tradingEndsAt)}</span>
            </div>
            <h1>{market.question}</h1>
          </div>
          <div className={styles.watchlistControl}>
            <Button
              disabled={watchlistBusy || isSigningIn || (authenticated && profileLoading)}
              onClick={() => void toggleWatchlist()}
              size="small"
              variant={isWatchlisted ? 'mint' : 'neutral'}
            >
              {watchlistBusy
                ? 'Saving…'
                : isWatchlisted
                  ? '✓ In watchlist'
                  : authenticated
                    ? '+ Add to watchlist'
                    : 'Sign in to watch'}
            </Button>
            {(watchlistError || profileError) && (
              <small role="alert">
                {watchlistError?.message ?? 'Watchlist is temporarily unavailable.'}
              </small>
            )}
          </div>
        </div>
      </header>

      <LifecycleStepper
        graduated={market.graduatedAt !== null}
        phase={visiblePhase}
      />

      {isIncubating && !settlementReady && (
        <div className={styles.grid}>
          <div className={styles.stack}>
            <PriceOverview
              market={market}
              points={priceHistory?.points ?? []}
              resolution={resolution}
            />
            <GraduationPanel market={market} />
            <RecentTrades trades={recentTrades} />
          </div>
          <div className={styles.sidebarStack}>
            <TradePanel
              market={market}
              positions={positions}
            />
            <SettlementPanel
              market={market}
              settlementEvents={settlementEvents}
            />
          </div>
        </div>
      )}

      {isGraduated && (
        <div className={styles.grid}>
          <div className={styles.stack}>
            <PriceOverview
              market={market}
              points={priceHistory?.points ?? []}
              resolution={resolution}
            />
            {orderBookSurface}
            <RecentTrades trades={recentTrades} />
          </div>
          <SettlementPanel
            market={market}
            settlementEvents={settlementEvents}
          />
        </div>
      )}

      {isIncubating && settlementReady && (
        <div className={styles.grid}>
          <div className={styles.stack}>
            <PriceOverview
              market={market}
              points={priceHistory?.points ?? []}
              resolution={resolution}
            />
            <RecentTrades trades={recentTrades} />
          </div>
          <SettlementPanel
            market={market}
            settlementEvents={settlementEvents}
          />
        </div>
      )}

      {isSettled && (
        <div className={styles.grid}>
          <div className={styles.stack}>
            <ResolvedOutcomePanel market={market} resolution={resolution} />
            <RecentTrades trades={recentTrades} />
          </div>
          <SettlementPanel
            market={market}
            settlementEvents={settlementEvents}
          />
        </div>
      )}
    </main>
  );
}
