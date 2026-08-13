'use client';

import type {
  ActivityEvent,
  Market,
  OffchainOrder,
  Position,
  Trade,
} from '@predex-pump/shared/domain';
import Link from 'next/link';
import { useMemo } from 'react';
import { useAccount as useWalletAccount, useConnect } from 'wagmi';

import { ActivityList } from '@/components/feed/ActivityList';
import { OutcomeBadge } from '@/components/ui/Badge';
import { Button, buttonClassName } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { NumberDisplay } from '@/components/ui/NumberDisplay';
import { StatePanel } from '@/components/ui/StatePanel';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  useAccount as useIndexedAccount,
  useActivity,
  useMarkets,
  useMyOrders,
} from '@/lib/api/hooks';
import {
  formatPrice,
  formatRaw,
  formatShareQuantity,
  formatSignedUsdc,
  formatUsdc,
  phaseLabel,
  shortAddress,
} from '@/lib/format';
import {
  isMarketSettled,
  positionCurrentValueRaw,
} from '@/lib/market-state';

import styles from './PortfolioScreen.module.css';

const RAW_SCALE = 1_000_000n;

interface PositionRow {
  position: Position;
  market: Market | undefined;
  averageCostRaw: string;
  currentValueRaw: string;
  estimatedPnlRaw: string;
}

interface OpenOrderRow {
  key: string;
  marketId: string;
  venue: 'HYBRID' | 'MINICLOB';
  side: OffchainOrder['side'];
  outcome: OffchainOrder['outcome'];
  priceRaw: string;
  sizeRaw: string;
  remainingRaw: string;
  status: string;
  createdAt: number;
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

function isOpenOrder(order: OffchainOrder) {
  return (
    (order.status === 'OPEN' || order.status === 'PARTIALLY_FILLED') &&
    BigInt(order.remainingRaw) > 0n
  );
}

function orderStatusLabel(status: OffchainOrder['status']) {
  return status === 'PARTIALLY_FILLED'
    ? 'Partially filled'
    : status.charAt(0) + status.slice(1).toLowerCase().replaceAll('_', ' ');
}

export function PortfolioScreen() {
  const { address, isConnected } = useWalletAccount();
  const { session, isLoading: sessionLoading, isSigningIn, signIn } = useAuth();
  const authenticated =
    session?.authenticated === true &&
    Boolean(address) &&
    session.address.toLowerCase() === address?.toLowerCase();
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
    refetch: refetchActivity,
  } = useActivity({ account: address, limit: 20 });
  const {
    data: makerOrders,
    isLoading: ordersLoading,
    error: ordersError,
    refetch: refetchOrders,
  } = useMyOrders(address, authenticated);

  const marketById = useMemo(
    () =>
      new Map(
        (marketsPage?.items ?? []).map((market) => [market.id, market]),
      ),
    [marketsPage?.items],
  );

  const positionRows = useMemo<PositionRow[]>(() => {
    return (account?.positions ?? []).map((position) => {
      const market = marketById.get(position.marketId);

      return {
        position,
        market,
        averageCostRaw: averageCostRaw(position),
        currentValueRaw: positionCurrentValueRaw(position, market),
        estimatedPnlRaw: (
          BigInt(position.realizedPnlRaw) +
          BigInt(position.unrealizedPnlRaw)
        ).toString(),
      };
    });
  }, [account?.positions, marketById]);

  const openOrders = useMemo<OpenOrderRow[]>(() => {
    const normalizedAddress = address?.toLowerCase();
    const hybrid = (makerOrders?.orders ?? [])
      .filter(
        (order) =>
          isOpenOrder(order) &&
          order.maker.toLowerCase() === normalizedAddress,
      )
      .map((order): OpenOrderRow => ({
        key: `hybrid:${order.orderHash}`,
        marketId: order.marketId,
        venue: 'HYBRID',
        side: order.side,
        outcome: order.outcome,
        priceRaw: order.priceRaw,
        sizeRaw: order.sizeRaw,
        remainingRaw: order.remainingRaw,
        status: orderStatusLabel(order.status),
        createdAt: order.createdAt,
      }));
    const miniclob = (makerOrders?.onchainOrders ?? [])
      .filter(
        (order) =>
          order.open &&
          BigInt(order.remainingRaw) > 0n &&
          order.maker.toLowerCase() === normalizedAddress,
      )
      .map((order): OpenOrderRow => ({
        key: `miniclob:${order.orderId}`,
        marketId: order.marketId,
        venue: 'MINICLOB',
        side: order.side,
        outcome: order.outcome,
        priceRaw: order.priceRaw,
        sizeRaw: order.sizeRaw,
        remainingRaw: order.remainingRaw,
        status: BigInt(order.filledRaw) > 0n ? 'Partially filled' : 'Open',
        createdAt: order.createdAt,
      }));
    return [...hybrid, ...miniclob].sort(
      (left, right) => right.createdAt - left.createdAt,
    );
  }, [address, makerOrders?.onchainOrders, makerOrders?.orders]);

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
      row.market !== undefined &&
      isMarketSettled(row.market) &&
      BigInt(row.position.qtyRaw) > 0n &&
      BigInt(row.currentValueRaw) > 0n,
  );
  const redeemableValueRaw = redeemableRows
    .reduce((total, row) => total + BigInt(row.currentValueRaw), 0n)
    .toString();
  const redeemMarketId = redeemableRows[0]?.position.marketId;

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
          marginal prices or final payouts. Cost basis and PnL are estimates from
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
          showMascot={false}
          state={connectError ? 'error' : 'empty'}
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
          showMascot={false}
          state="loading"
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
          showMascot={false}
          state="error"
          title="This portfolio would not open"
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
          <small>At indexed prices or final payouts</small>
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

      {redeemableRows.length > 0 && redeemMarketId && (
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
              ready to redeem
            </h2>
            <p>
              {redeemableRows.length}{' '}
              {redeemableRows.length === 1
                ? 'market has a final payout.'
                : 'markets have final payouts.'}
            </p>
          </div>
          <Link
            className={buttonClassName('mint')}
            href={`/market/${redeemMarketId}`}
          >
            Redeem on market
          </Link>
        </Card>
      )}

      <section className={styles.orders} aria-labelledby="open-orders-heading">
        <div className={styles.sectionHeading}>
          <div>
            <span className={styles.kicker}>Working liquidity</span>
            <h2 id="open-orders-heading">Open orders</h2>
          </div>
          <p>Live maker orders from Hybrid and MiniCLOB are shown together.</p>
        </div>

        <p className={styles.orderSafety}>
          <strong>Withdraw · free</strong> removes an order from this operator’s
          book only. <strong>Cancel on-chain · gas</strong> invalidates the
          signature; otherwise it can remain valid until expiry. MiniCLOB orders
          hold escrow on-chain and can be managed from their market page.
        </p>

        {sessionLoading ? (
          <p className={styles.inlineState} role="status">
            Checking the connected wallet session…
          </p>
        ) : !authenticated ? (
          <Card className={styles.inlineState} quiet>
            <p>Sign in with this wallet to load its private live-order list.</p>
            <Button
              disabled={isSigningIn}
              onClick={() => void signIn()}
              size="small"
              variant="neutral"
            >
              {isSigningIn ? 'Signing in…' : 'Sign in to view open orders'}
            </Button>
          </Card>
        ) : ordersLoading ? (
          <p className={styles.inlineState} role="status">
            Loading live open orders…
          </p>
        ) : ordersError || !makerOrders ? (
          <Card className={styles.inlineState} quiet role="alert">
            <p>The live order list could not be loaded.</p>
            <Button onClick={refetchOrders} size="small" variant="neutral">
              Try orders again
            </Button>
          </Card>
        ) : openOrders.length === 0 ? (
          <p className={styles.inlineState}>No live open orders for this wallet.</p>
        ) : (
          <Card
            className={`${styles.tableCard} ${styles.ordersTableCard}`}
            padded={false}
            quiet
          >
            <table aria-describedby="open-orders-safety">
              <caption className="sr-only">
                Live Hybrid and MiniCLOB maker orders for the connected wallet
              </caption>
              <thead>
                <tr>
                  <th scope="col">Market</th>
                  <th scope="col">Venue</th>
                  <th scope="col">Side</th>
                  <th scope="col">Outcome</th>
                  <th className={styles.numericHeading} scope="col">Price</th>
                  <th className={styles.numericHeading} scope="col">Original</th>
                  <th className={styles.numericHeading} scope="col">Remaining</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {openOrders.map((order) => {
                  const orderMarket = marketById.get(order.marketId);
                  return (
                    <tr key={order.key}>
                      <td className={styles.marketCell} data-label="Market">
                        <Link href={`/market/${order.marketId}`}>
                          <strong>
                            {orderMarket?.question ?? `Market #${order.marketId}`}
                          </strong>
                          <span>
                            Manage on market <span aria-hidden="true">→</span>
                          </span>
                        </Link>
                      </td>
                      <td data-label="Venue">
                        <span className={styles.venue}>{order.venue}</span>
                      </td>
                      <td data-label="Side">{order.side}</td>
                      <td data-label="Outcome">
                        <OutcomeBadge outcome={order.outcome} />
                      </td>
                      <td className={styles.numericCell} data-label="Price">
                        {formatPrice(order.priceRaw, 6)}
                      </td>
                      <td className={styles.numericCell} data-label="Original">
                        {formatRaw(order.sizeRaw, {
                          minimumFractionDigits: 0,
                          maximumFractionDigits: 6,
                        })}
                      </td>
                      <td className={styles.numericCell} data-label="Remaining">
                        {formatRaw(order.remainingRaw, {
                          minimumFractionDigits: 0,
                          maximumFractionDigits: 6,
                        })}
                      </td>
                      <td data-label="Status">
                        <span className={styles.orderStatus} title={order.status}>
                          {order.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}
        <span className="sr-only" id="open-orders-safety">
          Withdrawal is off-chain only; on-chain cancellation is authoritative.
        </span>
      </section>

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

        {positionRows.length === 0 ? (
          <StatePanel
            actions={
              <Link className={buttonClassName('neutral')} href="/">
                Explore the feed
              </Link>
            }
            message="This account holds no indexed outcome-token positions. Open orders, if any, remain listed above."
            showMascot={false}
            state="empty"
            title="No positions yet"
          />
        ) : (
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
                          {row.market?.question ??
                            `Market #${row.position.marketId}`}
                        </strong>
                        <span>
                          {row.market
                            ? isMarketSettled(row.market)
                              ? row.market.phase === 'ClosedOut'
                                ? 'Closed out'
                                : 'Resolved'
                              : phaseLabel(row.market.phase)
                            : 'Market unavailable'}{' '}
                          <span aria-hidden="true">→</span>
                        </span>
                      </Link>
                    </td>
                    <td data-label="Outcome">
                      <OutcomeBadge outcome={row.position.outcome} />
                    </td>
                    <td className={styles.numericCell} data-label="Quantity">
                      {formatShareQuantity(row.position.qtyRaw, {
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
        )}
      </section>

      <section className={styles.history}>
        <ActivityList
          emptyMessage="No account activity yet."
          error={activityError}
          events={activityEvents}
          isLoading={activityLoading}
          markets={marketsPage.items}
          onRetry={refetchActivity}
          sticky={false}
          title="Activity & history"
        />
      </section>

    </main>
  );
}
