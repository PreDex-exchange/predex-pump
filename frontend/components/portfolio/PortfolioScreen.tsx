'use client';

import type {
  ActivityEvent,
  Market,
  Position,
  Trade,
} from '@predex-pump/shared/domain';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useAccount as useWalletAccount, useConnect } from 'wagmi';

import { ActivityList } from '@/components/feed/ActivityList';
import { OutcomeBadge } from '@/components/ui/Badge';
import { Button, buttonClassName } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { NumberDisplay } from '@/components/ui/NumberDisplay';
import { StatePanel } from '@/components/ui/StatePanel';
import {
  useAccount as useIndexedAccount,
  useActivity,
  useMarkets,
} from '@/lib/api/hooks';
import {
  formatRaw,
  formatSignedUsdc,
  formatUsdc,
  phaseLabel,
  shortAddress,
} from '@/lib/format';

import styles from './PortfolioScreen.module.css';

const RAW_SCALE = 1_000_000n;

interface PositionRow {
  position: Position;
  market: Market | undefined;
  averageCostRaw: string;
  currentValueRaw: string;
  estimatedPnlRaw: string;
}

function rawProduct(leftRaw: string, rightRaw: string) {
  return ((BigInt(leftRaw) * BigInt(rightRaw)) / RAW_SCALE).toString();
}

function averageCostRaw(position: Position) {
  const quantity = BigInt(position.qtyRaw);
  if (quantity === 0n) return '0';
  return ((BigInt(position.costBasisRaw) * RAW_SCALE) / quantity).toString();
}

function pnlClassName(raw: string) {
  const value = BigInt(raw);
  if (value > 0n) return styles.positive;
  if (value < 0n) return styles.negative;
  return styles.flat;
}

function tradeToActivity(trade: Trade): ActivityEvent {
  return {
    id: trade.id,
    type: trade.venue === 'BOOK' ? 'OrderFilled' : 'Trade',
    marketId: trade.marketId,
    account: trade.account,
    outcome: trade.outcome,
    side: trade.side,
    amountRaw: trade.sizeRaw,
    priceRaw: trade.priceRaw,
    txHash: trade.txHash,
    ts: trade.ts,
  };
}

export function PortfolioScreen() {
  const [redeemOpen, setRedeemOpen] = useState(false);
  const { address, isConnected } = useWalletAccount();
  const {
    connect,
    connectors,
    error: connectError,
    isPending: isConnecting,
  } = useConnect();
  const {
    data: account,
    isLoading: accountLoading,
    error: accountError,
    refetch: refetchAccount,
  } = useIndexedAccount(address);
  const {
    data: marketsPage,
    isLoading: marketsLoading,
    error: marketsError,
    refetch: refetchMarkets,
  } = useMarkets();
  const {
    data: activityPage,
    isLoading: activityLoading,
    error: activityError,
  } = useActivity({ account: address, limit: 20 });

  const positionRows = useMemo<PositionRow[]>(() => {
    const marketById = new Map(
      (marketsPage?.items ?? []).map((market) => [market.id, market]),
    );

    return (account?.positions ?? []).map((position) => {
      const market = marketById.get(position.marketId);
      const markRaw =
        position.outcome === 'YES'
          ? market?.yesPriceRaw ?? '0'
          : market?.noPriceRaw ?? '0';

      return {
        position,
        market,
        averageCostRaw: averageCostRaw(position),
        currentValueRaw: rawProduct(position.qtyRaw, markRaw),
        estimatedPnlRaw: (
          BigInt(position.realizedPnlRaw) +
          BigInt(position.unrealizedPnlRaw)
        ).toString(),
      };
    });
  }, [account?.positions, marketsPage?.items]);

  const totalPositionValueRaw = positionRows
    .reduce((total, row) => total + BigInt(row.currentValueRaw), 0n)
    .toString();
  const estimatedPnlRaw = (
    BigInt(account?.pnl.realizedRaw ?? '0') +
    BigInt(account?.pnl.unrealizedRaw ?? '0')
  ).toString();
  const marketsHeld = new Set(
    positionRows
      .filter((row) => BigInt(row.position.qtyRaw) > 0n)
      .map((row) => row.position.marketId),
  ).size;
  const redeemableRows = positionRows.filter(
    (row) =>
      row.market?.phase === 'ResolvedObserved' &&
      BigInt(row.position.qtyRaw) > 0n &&
      BigInt(row.currentValueRaw) > 0n,
  );
  const redeemableValueRaw = redeemableRows
    .reduce((total, row) => total + BigInt(row.currentValueRaw), 0n)
    .toString();

  const activityEvents = useMemo(() => {
    const byId = new Map<string, ActivityEvent>();

    for (const trade of account?.recentTrades ?? []) {
      byId.set(trade.id, tradeToActivity(trade));
    }
    for (const event of activityPage?.items ?? []) {
      byId.set(event.id, event);
    }

    return [...byId.values()].sort((left, right) => right.ts - left.ts);
  }, [account?.recentTrades, activityPage?.items]);

  const connector = connectors[0];
  const header = (
    <header className={styles.header}>
      <div>
        <span className={styles.kicker}>Portfolio</span>
        <h1>Your positions, held calmly.</h1>
        <p>
          Quantities are indexed from CTF transfers and marked against indexed
          marginal or resolved prices. Cost basis and PnL are estimates from
          trade history.
        </p>
      </div>
      {address && (
        <code className={`${styles.address} mono`}>{shortAddress(address, 6, 4)}</code>
      )}
    </header>
  );

  if (!isConnected || !address) {
    return (
      <main className={styles.page}>
        {header}
        <StatePanel
          actions={
            <>
              <Button
                disabled={!connector || isConnecting}
                onClick={() => connector && connect({ connector })}
                variant="coral"
              >
                {isConnecting
                  ? 'Connecting…'
                  : connector
                    ? 'Connect wallet'
                    : 'No wallet found'}
              </Button>
              <Link className={buttonClassName('neutral')} href="/">
                Explore the feed
              </Link>
            </>
          }
          message={
            connectError
              ? 'The wallet connection was not completed. Try again, or explore the live market feed.'
              : 'Connect a wallet to load its indexed outcome-token positions and Arc activity.'
          }
          title="Connect to open your portfolio"
        />
      </main>
    );
  }

  if (accountLoading || marketsLoading) {
    return (
      <main className={styles.page}>
        {header}
        <StatePanel
          message="Loading indexed positions and marking them against current prices."
          title="Counting your positions…"
        />
      </main>
    );
  }

  if (accountError || marketsError || !account || !marketsPage) {
    return (
      <main className={styles.page}>
        {header}
        <StatePanel
          actions={
            <Button
              onClick={() => {
                refetchAccount();
                refetchMarkets();
              }}
              variant="neutral"
            >
              Try again
            </Button>
          }
          message="The indexed account snapshot could not load. Retry the backend reads."
          title="This portfolio would not open"
        />
      </main>
    );
  }

  if (positionRows.length === 0) {
    return (
      <main className={styles.page}>
        {header}
        <StatePanel
          actions={
            <>
              <Link className={buttonClassName('coral')} href="/">
                Explore the feed
              </Link>
              <Link className={buttonClassName('neutral')} href="/create">
                Create a market
              </Link>
            </>
          }
          message="This account holds no outcome tokens for markets in the live deployment."
          title="No positions in this nest yet"
        />
      </main>
    );
  }

  return (
    <main className={styles.page}>
      {header}

      <section aria-label="Portfolio summary" className={styles.summary}>
        <Card className={styles.summaryCard} quiet>
          <span>Total position value</span>
          <NumberDisplay size="hero">
            {formatUsdc(totalPositionValueRaw)} <small>USDC</small>
          </NumberDisplay>
          <small>At current indexed prices</small>
        </Card>
        <Card className={styles.summaryCard} quiet>
          <span>Estimated PnL</span>
          <NumberDisplay
            className={pnlClassName(estimatedPnlRaw)}
            size="hero"
          >
            {formatSignedUsdc(estimatedPnlRaw)} <small>USDC</small>
          </NumberDisplay>
          <small>
            {formatSignedUsdc(account.pnl.realizedRaw)} realized ·{' '}
            {formatSignedUsdc(account.pnl.unrealizedRaw)} unrealized
          </small>
        </Card>
        <Card className={styles.summaryCard} quiet>
          <span>Markets held</span>
          <NumberDisplay size="hero">{marketsHeld}</NumberDisplay>
          <small>{account.account.tradeCount} indexed trades</small>
        </Card>
      </section>

      {redeemableRows.length > 0 && (
        <Card className={styles.redeemCallout} quiet>
          <div className={styles.redeemIcon} aria-hidden="true">
            ✓
          </div>
          <div className={styles.redeemCopy}>
            <span className={styles.redeemLabel}>Resolved position</span>
            <h2>
              <NumberDisplay size="body">
                {formatUsdc(redeemableValueRaw)} USDC
              </NumberDisplay>{' '}
              will be redeemable
            </h2>
            <p>
              {redeemableRows.length}{' '}
              {redeemableRows.length === 1 ? 'market has' : 'markets have'} an observed
              resolution.
            </p>
          </div>
          <Button onClick={() => setRedeemOpen(true)} variant="mint">
            Review · coming soon
          </Button>
        </Card>
      )}

      <section className={styles.positions}>
        <div className={styles.sectionHeading}>
          <div>
            <span className={styles.kicker}>Holdings</span>
            <h2>Positions</h2>
          </div>
          <p id="positions-note">
            Cost basis and PnL are indexer estimates; quantities derive from CTF transfers.
          </p>
        </div>

        <Card className={styles.tableCard} padded={false} quiet>
          <table aria-describedby="positions-note">
            <caption className="sr-only">
              Indexed outcome-token positions for the connected Arc account
            </caption>
            <thead>
              <tr>
                <th scope="col">Market</th>
                <th scope="col">Outcome</th>
                <th className={styles.numericHeading} scope="col">
                  Quantity
                </th>
                <th className={styles.numericHeading} scope="col">
                  Avg. cost
                </th>
                <th className={styles.numericHeading} scope="col">
                  Current value
                </th>
                <th className={styles.numericHeading} scope="col">
                  PnL (est.)
                </th>
              </tr>
            </thead>
            <tbody>
              {positionRows.map((row) => (
                <tr key={`${row.position.marketId}:${row.position.outcome}`}>
                  <td className={styles.marketCell} data-label="Market">
                    <Link href={`/market/${row.position.marketId}`}>
                      <strong>
                        {row.market?.question ?? `Market #${row.position.marketId}`}
                      </strong>
                      <span>
                        {row.market ? phaseLabel(row.market.phase) : 'Market unavailable'}{' '}
                        <span aria-hidden="true">→</span>
                      </span>
                    </Link>
                  </td>
                  <td data-label="Outcome">
                    <OutcomeBadge outcome={row.position.outcome} />
                  </td>
                  <td className={styles.numericCell} data-label="Quantity">
                    {formatRaw(row.position.qtyRaw, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </td>
                  <td className={styles.numericCell} data-label="Avg. cost">
                    <span title="Estimated from indexed trade history">
                      {formatUsdc(row.averageCostRaw, 3)} <small>USDC</small>
                    </span>
                  </td>
                  <td className={styles.numericCell} data-label="Current value">
                    {formatUsdc(row.currentValueRaw)} <small>USDC</small>
                  </td>
                  <td className={styles.numericCell} data-label="PnL (est.)">
                    <span
                      className={pnlClassName(row.estimatedPnlRaw)}
                      title="Estimated from indexed trade history"
                    >
                      {formatSignedUsdc(row.estimatedPnlRaw)}{' '}
                      <small>USDC</small>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </section>

      <section className={styles.history}>
        <ActivityList
          emptyMessage={
            activityLoading
              ? 'Loading account history…'
              : activityError
                ? 'Account history is temporarily unavailable.'
                : 'No account activity yet.'
          }
          events={activityEvents}
          markets={marketsPage.items}
          sticky={false}
          title="Activity & history"
        />
      </section>

      <ConfirmModal
        confirmLabel="Close preview"
        onClose={() => setRedeemOpen(false)}
        onConfirm={() =>
          console.info('Deferred CTF redemption preview', {
            markets: redeemableRows.map((row) => row.position.marketId),
          })
        }
        open={redeemOpen}
        title="Redeem resolved positions"
      >
        <p className={styles.redeemIntro}>
          Review the resolved outcome tokens. Redemption is coming soon and remains deferred in
          Phase C3.
        </p>
        <ul className={styles.redeemList}>
          {redeemableRows.map((row) => (
            <li key={`${row.position.marketId}:${row.position.outcome}`}>
              <div>
                <OutcomeBadge outcome={row.position.outcome} />
                <span>{row.market?.question ?? `Market #${row.position.marketId}`}</span>
              </div>
              <NumberDisplay size="small">
                {formatUsdc(row.currentValueRaw)} USDC
              </NumberDisplay>
            </li>
          ))}
        </ul>
        <div className={styles.redeemTotal}>
          <span>Total redeemable</span>
          <NumberDisplay size="body">{formatUsdc(redeemableValueRaw)} USDC</NumberDisplay>
        </div>
        <p className={styles.redeemNote}>
          Coming soon. No Conditional Tokens redemption transaction will be sent from this preview.
        </p>
      </ConfirmModal>
    </main>
  );
}
