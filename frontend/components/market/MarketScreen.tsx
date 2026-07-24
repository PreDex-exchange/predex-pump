'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAccount as useWalletAccount } from 'wagmi';

import { PhaseBadge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { StatePanel } from '@/components/ui/StatePanel';
import {
  useAccount as useChainAccount,
  useMarket,
  useOrderBook,
  usePriceHistory,
} from '@/lib/api/hooks';
import {
  formatDateTime,
  relativeTime,
  shortAddress,
} from '@/lib/format';

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
  const { address } = useWalletAccount();
  const { data: detail, isLoading, error } = useMarket(marketId);
  const { data: priceHistory } = usePriceHistory(marketId);
  const { data: book, isLoading: bookLoading } = useOrderBook(marketId);
  const { data: account } = useChainAccount(address);

  useEffect(() => {
    const updateClock = () => setClockSeconds(Math.floor(Date.now() / 1000));
    const initialTimer = window.setTimeout(updateClock, 0);
    const interval = window.setInterval(updateClock, 30_000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
    };
  }, []);

  if (isLoading) {
    return (
      <main className={styles.state}>
        <StatePanel
          message="Scanning Arc events and reading the latest contract state."
          title="Checking this egg…"
        />
      </main>
    );
  }

  if (error) {
    return (
      <main className={styles.state}>
        <StatePanel
          message="The live Arc snapshot could not be assembled. Return to the feed and retry."
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
          title="No egg with that number"
        />
        <Link className={styles.backLink} href="/">
          ← Return to feed
        </Link>
      </main>
    );
  }

  const { market, recentTrades, resolution } = detail;
  const positions = account?.positions.filter(
    (item) => item.marketId === market.id,
  );
  const isIncubating = market.phase === 'Opened';
  const isGraduated = market.phase === 'Graduated';
  const isObserved =
    market.phase === 'ResolvedObserved' || market.phase === 'ClosedOut';
  const settlementReady =
    isGraduated ||
    isObserved ||
    resolution !== null ||
    clockSeconds >= market.tradingEndsAt;

  return (
    <main className={styles.page}>
      <Link className={styles.crumb} href="/">
        ← Feed
      </Link>
      <header className={styles.marketHeader}>
        <div className={styles.metaRow}>
          <PhaseBadge phase={market.phase} />
          <span>
            by <code className="mono">{shortAddress(market.creator, 4, 3)}</code>
          </span>
          <span>opened {relativeTime(market.createdAt)}</span>
          <span>trading ends {formatDateTime(market.tradingEndsAt)}</span>
        </div>
        <h1>{market.question}</h1>
      </header>

      <LifecycleStepper phase={market.phase} />

      {isIncubating && !settlementReady && (
        <div className={styles.grid}>
          <div className={styles.stack}>
            <PriceOverview market={market} points={priceHistory?.points ?? []} />
            <GraduationPanel market={market} />
            <RecentTrades trades={recentTrades} />
          </div>
          <TradePanel
            market={market}
            positions={positions}
          />
        </div>
      )}

      {isGraduated && (
        <div className={styles.grid}>
          <div className={styles.stack}>
            <PriceOverview market={market} points={priceHistory?.points ?? []} />
            {bookLoading || !book ? (
              <Card>
                <h2 className={styles.bookLoadingTitle}>Order book</h2>
                <p className={styles.bookLoading}>Reading live MiniCLOB orders…</p>
              </Card>
            ) : (
              <OrderBookPanel
                books={book}
                market={market}
                positions={positions}
              />
            )}
            <RecentTrades trades={recentTrades} />
          </div>
          <SettlementPanel market={market} />
        </div>
      )}

      {isIncubating && settlementReady && (
        <div className={styles.grid}>
          <div className={styles.stack}>
            <PriceOverview market={market} points={priceHistory?.points ?? []} />
            <RecentTrades trades={recentTrades} />
          </div>
          <SettlementPanel market={market} />
        </div>
      )}

      {isObserved && (
        <div className={styles.grid}>
          <div className={styles.stack}>
            <ResolvedOutcomePanel market={market} resolution={resolution} />
            {book && (
              <OrderBookPanel
                books={book}
                market={market}
                positions={positions}
              />
            )}
            <RecentTrades trades={recentTrades} />
          </div>
          <SettlementPanel market={market} />
        </div>
      )}
    </main>
  );
}
