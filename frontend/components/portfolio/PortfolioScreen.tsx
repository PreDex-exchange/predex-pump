'use client';

import type {
  ActivityEvent,
  Market,
  OffchainOrder,
  Position,
  Trade,
} from '@predex-pump/shared/domain';
import Link from 'next/link';
import { useMemo, useRef, useState } from 'react';
import { useAccount as useWalletAccount, useConnect } from 'wagmi';

import { ActivityList } from '@/components/feed/ActivityList';
import { OutcomeBadge } from '@/components/ui/Badge';
import { Button, buttonClassName } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { NumberDisplay } from '@/components/ui/NumberDisplay';
import { StatePanel } from '@/components/ui/StatePanel';
import { TxStatus } from '@/components/ui/TxStatus';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  useActivity,
  useMarkets,
  useMyOrders,
  usePaginatedAccount,
} from '@/lib/api/hooks';
import { arcTestnet } from '@/lib/chain/arc';
import { cancelOrderOnArc } from '@/lib/chain/transactions';
import { useTxFlow } from '@/lib/chain/useTxFlow';
import {
  formatPrice,
  formatRaw,
  formatShareQuantity,
  formatUsdc,
  phaseLabel,
  shortAddress,
} from '@/lib/format';
import {
  isMarketSettled,
  positionCurrentValueRaw,
} from '@/lib/market-state';

import styles from './PortfolioScreen.module.css';

interface PositionRow {
  position: Position;
  market: Market | undefined;
  currentValueRaw: string;
}

interface OpenOrderRowBase {
  key: string;
  marketId: string;
  side: OffchainOrder['side'];
  outcome: OffchainOrder['outcome'];
  priceRaw: string;
  sizeRaw: string;
  remainingRaw: string;
  status: string;
  createdAt: number;
}

interface HybridOpenOrderRow extends OpenOrderRowBase {
  venue: 'HYBRID';
}

interface MiniClobOpenOrderRow extends OpenOrderRowBase {
  venue: 'MINICLOB';
  maker: string;
  orderId: string;
}

type OpenOrderRow = HybridOpenOrderRow | MiniClobOpenOrderRow;

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
  const { address, chainId, isConnected } = useWalletAccount();
  const {
    session,
    isLoading: sessionLoading,
    isEstablishingSession,
    error: authError,
    ensureSession,
  } = useAuth();
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
    isLoadingMore: positionsLoadingMore,
    loadMoreError: positionsLoadMoreError,
    hasNextPage: hasMorePositions,
    loadMore: loadMorePositions,
  } = usePaginatedAccount(address, { positionsLimit: 100 });
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
  const cancelTx = useTxFlow();
  const cancelSubmissionOrderId = useRef<string | null>(null);
  const [cancelTarget, setCancelTarget] =
    useState<MiniClobOpenOrderRow | null>(null);
  const [cancelledMiniClobOrders, setCancelledMiniClobOrders] = useState(
    () => new Set<string>(),
  );
  const [cancelCompletion, setCancelCompletion] = useState<string | null>(null);
  const wrongNetwork = isConnected && chainId !== arcTestnet.id;

  const marketById = useMemo(
    () =>
      new Map(
        (marketsPage?.items ?? []).map((market) => [market.id, market]),
      ),
    [marketsPage?.items],
  );

  const positionRows = useMemo<PositionRow[]>(() => {
    return (account?.positions ?? [])
      .filter((position) => BigInt(position.qtyRaw) > 0n)
      .map((position) => {
        const market = marketById.get(position.marketId);

        return {
          position,
          market,
          currentValueRaw: positionCurrentValueRaw(position, market),
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
          !cancelledMiniClobOrders.has(order.orderId) &&
          order.maker.toLowerCase() === normalizedAddress,
      )
      .map((order): OpenOrderRow => ({
        key: `miniclob:${order.orderId}`,
        marketId: order.marketId,
        maker: order.maker,
        venue: 'MINICLOB',
        orderId: order.orderId,
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
  }, [
    address,
    cancelledMiniClobOrders,
    makerOrders?.onchainOrders,
    makerOrders?.orders,
  ]);

  const canCancelMiniClob =
    cancelTarget !== null &&
    authenticated &&
    isConnected &&
    Boolean(address) &&
    !wrongNetwork &&
    cancelTarget.maker.toLowerCase() === address?.toLowerCase();

  function openMiniClobCancel(order: MiniClobOpenOrderRow) {
    cancelTx.reset();
    setCancelCompletion(null);
    setCancelTarget(order);
  }

  function closeMiniClobCancel() {
    if (cancelTx.isBusy) return;
    cancelSubmissionOrderId.current = null;
    setCancelTarget(null);
    setCancelCompletion(null);
    cancelTx.reset();
  }

  async function cancelMiniClobOrder() {
    if (
      !address ||
      !cancelTarget ||
      !canCancelMiniClob ||
      cancelSubmissionOrderId.current !== null
    ) {
      return;
    }
    const orderId = cancelTarget.orderId;
    cancelSubmissionOrderId.current = orderId;
    let confirmed = false;
    try {
      const result = await cancelTx.execute((report) =>
        cancelOrderOnArc({
          account: address,
          orderId: BigInt(orderId),
          report,
        }),
      );
      if (!result) return;
      confirmed = true;

      setCancelledMiniClobOrders((current) => {
        const next = new Set(current);
        next.add(orderId);
        return next;
      });
      setCancelCompletion(
        cancelTarget.side === 'BID'
          ? `MiniCLOB order #${orderId} cancelled. ${formatUsdc(
              result.refundRaw.toString(),
              6,
            )} USDC escrow was returned by the contract.`
          : `MiniCLOB order #${orderId} cancelled. ${formatRaw(
              result.refundRaw.toString(),
              { minimumFractionDigits: 0, maximumFractionDigits: 6 },
            )} ${cancelTarget.outcome} escrow was returned by the contract.`,
      );
      refetchOrders();
      refetchAccount();
    } finally {
      if (!confirmed) cancelSubmissionOrderId.current = null;
    }
  }

  const totalPositionValueRaw = positionRows
    .reduce((total, row) => total + BigInt(row.currentValueRaw), 0n)
    .toString();
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
          Quantities come from indexed CTF transfers. Open positions use reference
          prices; resolved positions use their final payout.
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
          <span>Reference position value</span>
          <NumberDisplay size="hero">
            {formatUsdc(totalPositionValueRaw)} <small>USDC</small>
          </NumberDisplay>
          <small>Indexed marks or final payouts</small>
        </Card>
        <Card className={styles.summaryCard} quiet>
          <span>Outcomes held</span>
          <NumberDisplay size="hero">{positionRows.length}</NumberDisplay>
          <small>Non-zero indexed balances</small>
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
          signature; otherwise it can remain valid until expiry. MiniCLOB escrow
          is cancelled and refunded directly from this portfolio, even after its
          market moves to Hybrid or settles.
        </p>

        {sessionLoading && !isEstablishingSession ? (
          <p className={styles.inlineState} role="status">
            Preparing the private order list…
          </p>
        ) : !authenticated ? (
          <Card className={styles.inlineState} quiet>
            <div>
              <p>
                Sign in only when you want to load and manage this wallet&apos;s live
                Hybrid commitments and MiniCLOB escrow. Trading remains wallet-only.
              </p>
              {authError && (
                <p className={styles.sessionError} role="alert">
                  Sign-in was not completed. Try again when ready; wallet-only
                  trading remains available.
                </p>
              )}
            </div>
            <Button
              disabled={isEstablishingSession}
              onClick={() => void ensureSession()}
              size="small"
              variant="neutral"
            >
              {isEstablishingSession
                ? 'Check MetaMask…'
                : 'Sign in to manage orders'}
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
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {openOrders.map((order) => {
                  const orderMarket = marketById.get(order.marketId);
                  return (
                    <tr key={order.key}>
                      <td className={styles.marketCell} data-label="Market">
                        {order.venue === 'HYBRID' ? (
                          <Link href={`/market/${order.marketId}`}>
                            <strong>
                              {orderMarket?.question ?? `Market #${order.marketId}`}
                            </strong>
                            <span>
                              Manage on market <span aria-hidden="true">→</span>
                            </span>
                          </Link>
                        ) : (
                          <div>
                            <strong>
                              {orderMarket?.question ?? `Market #${order.marketId}`}
                            </strong>
                            <span>Escrow managed here</span>
                          </div>
                        )}
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
                      <td data-label="Action">
                        {order.venue === 'MINICLOB' ? (
                          <Button
                            className={styles.orderAction}
                            disabled={wrongNetwork || cancelTx.isBusy}
                            onClick={() => openMiniClobCancel(order)}
                            size="small"
                            variant="neutral"
                          >
                            {wrongNetwork
                              ? 'Switch to Arc'
                              : cancelTx.isBusy &&
                                  cancelTarget?.orderId === order.orderId
                                ? 'Cancelling…'
                                : 'Cancel & refund'}
                          </Button>
                        ) : (
                          <Link
                            className={styles.manageLink}
                            href={`/market/${order.marketId}`}
                          >
                            Manage
                          </Link>
                        )}
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

      <ConfirmModal
        closeDisabled={cancelTx.isBusy}
        closeOnConfirm={false}
        confirmDisabled={
          !canCancelMiniClob ||
          cancelTx.isBusy ||
          cancelTx.state.phase === 'confirmed' ||
          cancelCompletion !== null
        }
        confirmLabel={
          cancelTx.state.phase === 'confirmed' || cancelCompletion !== null
            ? 'Cancelled & refunded'
            : cancelTx.state.phase === 'failed' ||
                cancelTx.state.phase === 'rejected' ||
                cancelTx.state.phase === 'reverted'
              ? 'Retry cancel & refund'
              : 'Cancel & refund escrow'
        }
        kicker="On-chain MiniCLOB escrow"
        onClose={closeMiniClobCancel}
        onConfirm={cancelMiniClobOrder}
        open={cancelTarget !== null}
        title={
          cancelTarget
            ? `Cancel MiniCLOB order #${cancelTarget.orderId}`
            : 'Cancel MiniCLOB order'
        }
      >
        {cancelTarget && (
          <>
            <p>
              Predex will re-read order #{cancelTarget.orderId} from Arc, verify
              that this connected wallet is still its maker and that the order is
              still open, then ask MetaMask to call <code>MiniCLOB.cancel</code>.
            </p>
            <p>
              The contract returns the remaining{' '}
              <strong>
                {cancelTarget.side === 'BID'
                  ? 'USDC'
                  : `${cancelTarget.outcome} position-token`}{' '}
                escrow
              </strong>{' '}
              to this wallet. This remains available after a Hybrid handoff or
              market settlement.
            </p>
            <dl className={styles.confirmRows}>
              <div>
                <dt>Market</dt>
                <dd>#{cancelTarget.marketId}</dd>
              </div>
              <div>
                <dt>Remaining</dt>
                <dd className="numeric">
                  {formatRaw(cancelTarget.remainingRaw, {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 6,
                  })}{' '}
                  {cancelTarget.outcome}
                </dd>
              </div>
              <div>
                <dt>Escrow returned as</dt>
                <dd>
                  {cancelTarget.side === 'BID'
                    ? 'USDC'
                    : cancelTarget.outcome}
                </dd>
              </div>
            </dl>
          </>
        )}
        {cancelCompletion && (
          <p className={styles.completion} role="status">
            {cancelCompletion}
          </p>
        )}
        <TxStatus state={cancelTx.state} />
      </ConfirmModal>

      <section className={styles.positions}>
        <div className={styles.sectionHeading}>
          <div>
            <span className={styles.kicker}>Holdings</span>
            <h2>Positions</h2>
          </div>
          <p id="positions-note">
            Quantities derive from CTF transfers. Values are reference marks or final
            payouts, not guaranteed sale proceeds.
          </p>
        </div>

        {positionRows.length === 0 ? (
          <StatePanel
            actions={
              <Link className={buttonClassName('neutral')} href="/">
                Explore the feed
              </Link>
            }
            message={
              hasMorePositions
                ? 'No open positions appear in the loaded page. Load more to check the remaining indexed positions.'
                : 'This account holds no indexed outcome-token positions. Open orders, if any, remain listed above.'
            }
            showMascot={false}
            state="empty"
            title={hasMorePositions ? 'No open positions shown yet' : 'No open positions'}
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
                    Reference value
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
                    <td className={styles.numericCell} data-label="Reference value">
                      <span>
                        {formatUsdc(row.currentValueRaw)} <small>USDC</small>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
        {(hasMorePositions || positionsLoadingMore || positionsLoadMoreError) && (
          <div className={styles.inlineState}>
            <p role={positionsLoadMoreError ? 'alert' : 'status'}>
              {positionsLoadMoreError
                ? 'More positions could not be loaded. Positions already shown remain available.'
                : positionsLoadingMore
                  ? 'Loading the next page of indexed positions…'
                  : 'More indexed positions are available.'}
            </p>
            {hasMorePositions && (
              <Button
                disabled={positionsLoadingMore}
                onClick={loadMorePositions}
                size="small"
                variant="neutral"
              >
                {positionsLoadMoreError
                  ? 'Try loading more positions'
                  : positionsLoadingMore
                    ? 'Loading more positions…'
                    : 'Load more positions'}
              </Button>
            )}
          </div>
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
