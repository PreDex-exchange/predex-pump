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
import { Badge, OutcomeBadge } from '@/components/ui/Badge';
import { Button, buttonClassName } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { NumberDisplay } from '@/components/ui/NumberDisplay';
import { StatePanel } from '@/components/ui/StatePanel';
import {
  useAccount as useMockAccount,
  useActivity,
  useMarkets,
} from '@/lib/api/hooks';
import {
  formatPrice,
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
  markRaw: string;
  averageCostRaw: string;
  currentValueRaw: string;
  pnlRaw: string;
}

function rawProduct(leftRaw: string, rightRaw: string) {
  return ((BigInt(leftRaw) * BigInt(rightRaw)) / RAW_SCALE).toString();
}

function averageCostRaw(position: Position) {
  const quantity = BigInt(position.qtyRaw);
  if (quantity === 0n) return '0';
  return ((BigInt(position.costBasisRaw) * RAW_SCALE) / quantity).toString();
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

function pnlClass(raw: string) {
  if (BigInt(raw) > 0n) return styles.positive;
  if (BigInt(raw) < 0n) return styles.negative;
  return styles.flat;
}

export function PortfolioScreen() {
  const [redeemOpen, setRedeemOpen] = useState(false);
  const [redeemComplete, setRedeemComplete] = useState(false);
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
  } = useMockAccount(address);
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
        markRaw,
        averageCostRaw: averageCostRaw(position),
        currentValueRaw: rawProduct(position.qtyRaw, markRaw),
        pnlRaw: (
          BigInt(position.realizedPnlRaw) + BigInt(position.unrealizedPnlRaw)
        ).toString(),
      };
    });
  }, [account?.positions, marketsPage?.items]);

  const totalPositionValueRaw = positionRows
    .reduce((total, row) => total + BigInt(row.currentValueRaw), 0n)
    .toString();
  const totalPnlRaw = account
    ? (BigInt(account.pnl.realizedRaw) + BigInt(account.pnl.unrealizedRaw)).toString()
    : '0';
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
          Current values use mock marks. Cost basis and every PnL figure are indexed estimates,
          not settlement balances.
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
              ? 'The wallet connection was not completed. Try again, or explore live mock markets first.'
              : 'Connect a wallet to label this mock account and reveal its positions, value, and history.'
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
          message="Loading contract-shaped positions and marking them against the local market set."
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
          message="The local account snapshot could not be assembled. Retry the mock requests."
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
          message="This account has no mock outcome tokens yet. Explore a question and open a position."
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
          <small>At current mock prices</small>
        </Card>
        <Card className={styles.summaryCard} quiet>
          <span>Total PnL (est.)</span>
          <NumberDisplay
            className={pnlClass(totalPnlRaw)}
            size="hero"
          >
            {formatSignedUsdc(totalPnlRaw)} <small>USDC</small>
          </NumberDisplay>
          <small>Realized + unrealized estimate</small>
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
              is ready to redeem
            </h2>
            <p>
              {redeemableRows.length}{' '}
              {redeemableRows.length === 1 ? 'market has' : 'markets have'} an observed
              resolution.
            </p>
          </div>
          {redeemComplete ? (
            <Badge tone="yes">Redeem simulated</Badge>
          ) : (
            <Button onClick={() => setRedeemOpen(true)} variant="mint">
              Review redeem
            </Button>
          )}
        </Card>
      )}

      <section className={styles.positions}>
        <div className={styles.sectionHeading}>
          <div>
            <span className={styles.kicker}>Holdings</span>
            <h2>Positions</h2>
          </div>
          <p id="positions-note">Avg. cost and PnL are estimated from indexed trades.</p>
        </div>

        <Card className={styles.tableCard} padded={false} quiet>
          <table aria-describedby="positions-note">
            <caption className="sr-only">
              Outcome-token positions for the connected mock account
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
                    {formatPrice(row.averageCostRaw, 3)}
                  </td>
                  <td className={styles.numericCell} data-label="Current value">
                    {formatUsdc(row.currentValueRaw)} <small>USDC</small>
                  </td>
                  <td
                    className={`${styles.numericCell} ${pnlClass(row.pnlRaw)}`}
                    data-label="PnL (est.)"
                  >
                    {formatSignedUsdc(row.pnlRaw)} <small>USDC</small>
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
        confirmLabel="Confirm mock redeem"
        onClose={() => setRedeemOpen(false)}
        onConfirm={() => setRedeemComplete(true)}
        open={redeemOpen}
        title="Redeem resolved positions"
      >
        <p className={styles.redeemIntro}>
          Review the resolved outcome tokens in this mock redemption.
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
          This confirmation only updates the local UI. No redemption transaction will be sent.
        </p>
      </ConfirmModal>
    </main>
  );
}
