'use client';

import Link from 'next/link';
import { useAccount as useWalletAccount } from 'wagmi';

import { PhaseBadge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { StatePanel } from '@/components/ui/StatePanel';
import {
  useAccount as useMockAccount,
  useMarket,
  useOrderBook,
  usePriceHistory,
} from '@/lib/api/hooks';
import {
  formatDateTime,
  relativeTime,
  shortAddress,
} from '@/lib/format';
import { MOCK_REFERENCE_TS, MOCK_WALLET_ADDRESS } from '@/lib/mock/data';

import { GraduationPanel } from './GraduationPanel';
import { LifecycleStepper } from './LifecycleStepper';
import { OrderBookPanel } from './OrderBookPanel';
import {
  BookActionPanel,
  HatchedHeader,
  RedeemPanel,
  ResolvedOutcomePanel,
} from './PhasePanels';
import { PriceOverview } from './PriceOverview';
import { RecentTrades } from './RecentTrades';
import { TradePanel } from './TradePanel';
import styles from './MarketScreen.module.css';

export function MarketScreen({ marketId }: { marketId: string }) {
  const { address, isConnected } = useWalletAccount();
  const { data: detail, isLoading, error } = useMarket(marketId);
  const { data: priceHistory } = usePriceHistory(marketId);
  const { data: book, isLoading: bookLoading } = useOrderBook(marketId);
  const { data: account } = useMockAccount(address ?? MOCK_WALLET_ADDRESS);

  if (isLoading) {
    return (
      <main className={styles.state}>
        <StatePanel
          message="Loading the contract-shaped market snapshot and its mock activity."
          title="Checking this egg…"
        />
      </main>
    );
  }

  if (error) {
    return (
      <main className={styles.state}>
        <StatePanel
          message="The local mock request failed. Return to the feed and try this market again."
          title="This market would not open"
        />
      </main>
    );
  }

  if (!detail) {
    return (
      <main className={styles.state}>
        <StatePanel
          message="That market ID is not part of the Phase C1 mock set."
          title="No egg with that number"
        />
        <Link className={styles.backLink} href="/">
          ← Return to feed
        </Link>
      </main>
    );
  }

  const { market, recentTrades, resolution } = detail;
  const position = account?.positions.find((item) => item.marketId === market.id);
  const isIncubating = market.phase === 'Opened';
  const isGraduated = market.phase === 'Graduated';

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
          <span>opened {relativeTime(market.createdAt, MOCK_REFERENCE_TS)}</span>
          <span>trading ends {formatDateTime(market.tradingEndsAt)}</span>
        </div>
        <h1>{market.question}</h1>
      </header>

      <LifecycleStepper phase={market.phase} />

      {isGraduated && <HatchedHeader market={market} />}

      {isIncubating && (
        <div className={styles.grid}>
          <div className={styles.stack}>
            <PriceOverview market={market} points={priceHistory?.points ?? []} />
            <GraduationPanel market={market} />
            <RecentTrades trades={recentTrades} />
          </div>
          <TradePanel
            market={market}
            position={position}
            walletConnected={isConnected}
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
                <p className={styles.bookLoading}>Loading the mock ladder…</p>
              </Card>
            ) : (
              <OrderBookPanel books={book} />
            )}
            <RecentTrades trades={recentTrades} />
          </div>
          <BookActionPanel market={market} />
        </div>
      )}

      {!isIncubating && !isGraduated && (
        <div className={styles.grid}>
          <div className={styles.stack}>
            <ResolvedOutcomePanel market={market} resolution={resolution} />
            <RecentTrades trades={recentTrades} />
          </div>
          <RedeemPanel market={market} position={position} />
        </div>
      )}
    </main>
  );
}
