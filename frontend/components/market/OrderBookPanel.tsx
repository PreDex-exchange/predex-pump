'use client';

import type {
  Market,
  Order,
  OrderBook,
  Outcome,
  Position,
} from '@predex-pump/shared/domain';
import type { MarketBookResponse } from '@predex-pump/shared/rest';
import {
  isOrderSizeGranular,
  isPriceOnTick,
  leavesRepresentableRemainder,
  quantizePriceRaw,
} from '@predex-pump/shared';
import { useMemo, useState } from 'react';
import { formatUnits } from 'viem';
import { useAccount, useReadContract } from 'wagmi';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Tabs } from '@/components/ui/Tabs';
import { TxStatus } from '@/components/ui/TxStatus';
import { arcAddresses, arcTestnet } from '@/lib/chain/arc';
import { collateralErc20Abi } from '@/lib/chain/contracts';
import {
  cancelOrderOnArc,
  cumulativeMiniClobPaymentRaw,
  fillOrderOnArc,
  miniClobFillPaymentRaw,
  placeOrderOnArc,
} from '@/lib/chain/transactions';
import { useSettlementStatus } from '@/lib/chain/useSettlementStatus';
import { useTxFlow } from '@/lib/chain/useTxFlow';
import {
  formatPrice,
  formatRaw,
  formatUsdc,
  parseUsdcInput,
  shortAddress,
} from '@/lib/format';
import { orderBookForVenue } from '@/lib/exchange/hybrid';
import {
  ORDER_SIZE_STEP,
  ORDER_SIZE_STEP_ERROR,
  snappedOrderSizeInput,
  validateOrderPriceInput,
} from '@/lib/order-input';
import { isConnectedWalletMaker } from '@/lib/order-ownership';

import { HybridOrderBookPanel } from './HybridOrderBookPanel';
import styles from './OrderBookPanel.module.css';

type BookAction =
  | { kind: 'place' }
  | { kind: 'fill'; order: Order }
  | { kind: 'cancel'; order: Order };

const PRICE_SCALE = 1_000_000n;

function inputRaw(value: string) {
  const raw = parseUsdcInput(value);
  return raw === null ? null : BigInt(raw);
}

function snappedPriceInput(
  priceRaw: bigint,
  tickSizeRaw: bigint,
  side: 'BID' | 'ASK',
): string {
  return formatUnits(
    quantizePriceRaw(priceRaw, tickSizeRaw, side === 'BID' ? 'DOWN' : 'UP'),
    6,
  );
}

function orderRefundRaw(order: Order) {
  const remainingRaw = BigInt(order.remainingRaw);
  if (order.side === 'ASK') return remainingRaw;
  return (
    cumulativeMiniClobPaymentRaw(
      BigInt(order.priceRaw),
      BigInt(order.sizeRaw),
    ) -
    cumulativeMiniClobPaymentRaw(
      BigInt(order.priceRaw),
      BigInt(order.filledRaw),
    )
  );
}

function Ladder({
  book,
  side,
}: {
  book: OrderBook;
  side: 'asks' | 'bids';
}) {
  const levels = book[side];

  if (levels.length === 0) {
    return <div className={styles.empty}>No open {side} on-chain.</div>;
  }

  return (
    <div className={styles.levels}>
      {levels.map((level) => {
        const hasExactOffTickSeed = book.orders.some(
          (order) =>
            order.isSeed &&
            order.side === (side === 'asks' ? 'ASK' : 'BID') &&
            order.priceRaw === level.priceRaw &&
            !isPriceOnTick(
              BigInt(order.priceRaw),
              BigInt(book.minimumTickSizeRaw),
            ),
        );
        const totalRaw = book.orders
          .filter(
            (order) =>
              order.side === (side === 'asks' ? 'ASK' : 'BID') &&
              order.priceRaw === level.priceRaw,
          )
          .reduce(
            (total, order) =>
              total +
              miniClobFillPaymentRaw(
                BigInt(order.priceRaw),
                BigInt(order.filledRaw),
                BigInt(order.remainingRaw),
              ),
            0n,
          )
          .toString();
        return (
          <div
            className={`${styles.level} ${
              side === 'asks' ? styles.askLevel : styles.bidLevel
            }`}
            key={`${side}:${level.priceRaw}`}
          >
            <span className={`${styles.levelPrice} numeric`}>
              <span>{formatPrice(level.priceRaw, 6)}</span>
              {hasExactOffTickSeed && (
                <small title="Exact executable graduation handoff price">
                  exact seed
                </small>
              )}
            </span>
            <span className="numeric">
              {formatRaw(level.sizeRaw, {
                minimumFractionDigits: 0,
                maximumFractionDigits: 3,
              })}
            </span>
            <span className="numeric">{formatUsdc(totalRaw, 6)}</span>
            <span className="numeric">{level.orderCount}</span>
          </div>
        );
      })}
    </div>
  );
}

function actionTitle(action: BookAction | null) {
  if (!action || action.kind === 'place') return 'Place limit order';
  if (action.kind === 'fill') return `Fill order #${action.order.orderId}`;
  return `Cancel order #${action.order.orderId}`;
}

interface OrderBookPanelProps {
  books: MarketBookResponse;
  market: Market;
  positions?: Position[];
}

export function OrderBookPanel(props: OrderBookPanelProps) {
  if (!props.books.orderBookAvailable) {
    return (
      <Card className={styles.card}>
        <h2 className={styles.unavailableTitle}>No live order book</h2>
        <p className={styles.unavailableCopy}>
          {props.books.liveVenue === 'LMSR'
            ? 'The LMSR bonding curve is live; MiniCLOB has not opened.'
            : 'This market has no actionable trading venue.'}
        </p>
      </Card>
    );
  }

  return props.books.liveVenue === 'HYBRID'
    ? <HybridOrderBookPanel {...props} />
    : <MiniClobOrderBookPanel {...props} />;
}

function MiniClobOrderBookPanel({
  books,
  market,
  positions = [],
}: OrderBookPanelProps) {
  const minimumTickSizeRaw = BigInt(books.minimumTickSizeRaw);
  const [outcome, setOutcome] = useState<Outcome>('YES');
  const [orderSide, setOrderSide] = useState<'BID' | 'ASK'>('BID');
  const [price, setPrice] = useState(() =>
    snappedPriceInput(BigInt(market.yesPriceRaw), minimumTickSizeRaw, 'BID'),
  );
  const [size, setSize] = useState('0.20');
  const [fillSize, setFillSize] = useState('');
  const [action, setAction] = useState<BookAction | null>(null);
  const [completion, setCompletion] = useState<string | null>(null);
  const { address, chainId, isConnected } = useAccount();
  const collateralBalance = useReadContract({
    address: arcAddresses.usdc,
    abi: collateralErc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: arcTestnet.id,
    query: {
      enabled: Boolean(address) && chainId === arcTestnet.id,
    },
  });
  const tx = useTxFlow();
  const settlement = useSettlementStatus(market, address);
  const sourceBook = outcome === 'YES' ? books.yes : books.no;
  const book = useMemo(
    () => orderBookForVenue(sourceBook, 'MINICLOB'),
    [sourceBook],
  );
  const priceValidation = validateOrderPriceInput(price, minimumTickSizeRaw);
  const priceRaw = priceValidation.raw;
  const priceError = priceValidation.error;
  const sizeRaw = inputRaw(size);
  const fillSizeRaw = inputRaw(fillSize);
  const wrongNetwork = isConnected && chainId !== arcTestnet.id;
  const conditionUnresolved =
    settlement.data?.payoutDenominator === 0n;
  const selectedPosition = positions.find(
    (position) => position.outcome === outcome,
  );
  const outcomeBalanceRaw = BigInt(selectedPosition?.qtyRaw ?? '0');
  const validPrice = priceRaw !== null && priceError === null;
  const validSize = sizeRaw !== null && isOrderSizeGranular(sizeRaw);
  const sizeError =
    sizeRaw === null || sizeRaw <= 0n
      ? 'Enter an order size greater than zero'
      : !validSize
        ? ORDER_SIZE_STEP_ERROR
        : null;
  const placeEscrowRaw =
    validPrice && validSize
      ? orderSide === 'BID'
        ? cumulativeMiniClobPaymentRaw(priceRaw, sizeRaw)
        : sizeRaw
      : null;
  const fundingError =
    placeEscrowRaw === null
      ? null
      : orderSide === 'BID'
        ? collateralBalance.error
          ? 'Arc USDC balance is unavailable'
          : collateralBalance.data !== undefined &&
              placeEscrowRaw > collateralBalance.data
            ? `Insufficient USDC balance: requires ${formatUsdc(placeEscrowRaw.toString(), 6)} USDC, wallet holds ${formatUsdc(collateralBalance.data.toString(), 6)} USDC`
            : null
        : placeEscrowRaw > outcomeBalanceRaw
          ? `Insufficient ${outcome} balance: requires ${formatRaw(placeEscrowRaw.toString(), {
              minimumFractionDigits: 0,
              maximumFractionDigits: 6,
            })} ${outcome}, wallet holds ${formatRaw(outcomeBalanceRaw.toString(), {
              minimumFractionDigits: 0,
              maximumFractionDigits: 6,
            })} ${outcome}`
          : null;
  const fundingReady =
    placeEscrowRaw !== null &&
    fundingError === null &&
    (orderSide === 'BID'
      ? collateralBalance.data !== undefined
      : placeEscrowRaw <= outcomeBalanceRaw);
  const canPlace =
    isConnected &&
    Boolean(address) &&
    !wrongNetwork &&
    conditionUnresolved &&
    validPrice &&
    validSize &&
    fundingReady;

  const restingOrders = useMemo(
    () =>
      [...book.orders].sort((left, right) => {
        if (left.side !== right.side) return left.side === 'ASK' ? -1 : 1;
        const leftPrice = BigInt(left.priceRaw);
        const rightPrice = BigInt(right.priceRaw);
        if (leftPrice !== rightPrice) {
          if (left.side === 'ASK') return leftPrice < rightPrice ? -1 : 1;
          return leftPrice > rightPrice ? -1 : 1;
        }
        return BigInt(left.orderId) < BigInt(right.orderId) ? -1 : 1;
      }),
    [book.orders],
  );

  const activeOrder = action && action.kind !== 'place' ? action.order : null;
  const fillIsOwnOrder =
    action?.kind === 'fill' &&
    isConnectedWalletMaker(action.order.maker, address);
  const validFill =
    action?.kind === 'fill' &&
    fillSizeRaw !== null &&
    fillSizeRaw > 0n &&
    leavesRepresentableRemainder(
      BigInt(action.order.remainingRaw),
      fillSizeRaw,
    );
  const fillPaymentRaw =
    action?.kind === 'fill' && validFill && fillSizeRaw !== null
      ? miniClobFillPaymentRaw(
          BigInt(action.order.priceRaw),
          BigInt(action.order.filledRaw),
          fillSizeRaw,
        )
      : null;

  function selectOutcome(nextOutcome: Outcome) {
    setOutcome(nextOutcome);
    setPrice(
      snappedPriceInput(
        BigInt(
          nextOutcome === 'YES'
            ? market.yesPriceRaw
            : market.noPriceRaw,
        ),
        minimumTickSizeRaw,
        orderSide,
      ),
    );
    tx.reset();
  }

  function openAction(nextAction: BookAction) {
    if (
      nextAction.kind === 'fill' &&
      isConnectedWalletMaker(nextAction.order.maker, address)
    ) {
      return;
    }
    tx.reset();
    setCompletion(null);
    setAction(nextAction);
    if (nextAction.kind === 'fill') {
      setFillSize(formatUnits(BigInt(nextAction.order.remainingRaw), 6));
    }
  }

  function closeAction() {
    if (tx.isBusy) return;
    setAction(null);
    setCompletion(null);
    tx.reset();
  }

  async function handleAction() {
    if (!address || !action) return;

    if (action.kind === 'place') {
      if (!canPlace || priceRaw === null || sizeRaw === null) return;
      const result = await tx.execute((report) =>
        placeOrderOnArc({
          account: address,
          marketId: BigInt(market.id),
          outcome,
          side: orderSide,
          priceRaw,
          sizeRaw,
          minimumTickSizeRaw,
          report,
        }),
      );
      if (!result) return;
      setCompletion(
        `${result.orderId === null ? 'Order' : `Order #${result.orderId}`} confirmed. ${
          orderSide === 'BID'
            ? `${formatUsdc(result.escrowRaw.toString(), 6)} USDC`
            : `${formatRaw(result.escrowRaw.toString(), {
                minimumFractionDigits: 0,
                maximumFractionDigits: 6,
              })} ${outcome}`
        } is escrowed on MiniCLOB.`,
      );
      return;
    }

    if (action.kind === 'fill') {
      if (
        !conditionUnresolved ||
        !validFill ||
        fillSizeRaw === null ||
        fillIsOwnOrder ||
        wrongNetwork
      ) {
        return;
      }
      const result = await tx.execute((report) =>
        fillOrderOnArc({
          account: address,
          orderId: BigInt(action.order.orderId),
          fillSizeRaw,
          report,
        }),
      );
      if (!result) return;
      setCompletion(
        action.order.side === 'ASK'
          ? `Fill confirmed: paid ${formatUsdc(result.paymentRaw.toString(), 6)} USDC and received ${formatRaw(result.fillSizeRaw.toString(), {
              minimumFractionDigits: 0,
              maximumFractionDigits: 6,
            })} ${action.order.outcome}.`
          : `Fill confirmed: delivered ${formatRaw(result.fillSizeRaw.toString(), {
              minimumFractionDigits: 0,
              maximumFractionDigits: 6,
            })} ${action.order.outcome} and received ${formatUsdc(result.paymentRaw.toString(), 6)} USDC.`,
      );
      return;
    }

    if (
      wrongNetwork ||
      !isConnectedWalletMaker(action.order.maker, address)
    ) {
      return;
    }
    const result = await tx.execute((report) =>
      cancelOrderOnArc({
        account: address,
        orderId: BigInt(action.order.orderId),
        report,
      }),
    );
    if (!result) return;
    setCompletion(
      action.order.side === 'BID'
        ? `Cancellation confirmed: ${formatUsdc(result.refundRaw.toString(), 6)} USDC refunded.`
        : `Cancellation confirmed: ${formatRaw(result.refundRaw.toString(), {
            minimumFractionDigits: 0,
            maximumFractionDigits: 6,
          })} ${action.order.outcome} refunded.`,
    );
  }

  const placeButtonLabel = !isConnected
    ? 'Connect wallet in the header'
    : wrongNetwork
      ? 'Switch to Arc Testnet'
      : settlement.isLoading
        ? 'Checking condition…'
        : settlement.error
          ? 'Condition read unavailable'
          : !conditionUnresolved
            ? 'Market resolved'
            : priceError
              ? priceError
              : sizeError
                ? sizeError
                : orderSide === 'BID' && collateralBalance.isLoading
                  ? 'Reading Arc USDC balance…'
                  : fundingError
                    ? fundingError
                    : !fundingReady
                      ? 'Funding balance unavailable'
                : `Preview ${outcome} ${orderSide}`;

  const confirmDisabled =
    tx.isBusy ||
    tx.state.phase === 'confirmed' ||
    (action?.kind === 'place' && !canPlace) ||
    (action?.kind === 'fill' &&
      (!validFill || fillIsOwnOrder || !conditionUnresolved || wrongNetwork)) ||
    (action?.kind === 'cancel' &&
      (wrongNetwork ||
        !address ||
        !isConnectedWalletMaker(action.order.maker, address)));

  const confirmLabel =
    tx.state.phase === 'confirmed'
      ? 'Confirmed'
      : tx.state.phase === 'reverted'
        ? 'Retry action'
        : action?.kind === 'cancel'
          ? 'Cancel & refund'
          : action?.kind === 'fill'
            ? 'Approve & fill'
            : 'Approve & place';

  return (
    <>
      <Card className={styles.card}>
        <div className={styles.header}>
          <div>
            <h2>MiniCLOB order book</h2>
            <p>Live indexed orders · prices in USDC per token</p>
            <span className={styles.venueLabel}>
              Live venue · On-chain MiniCLOB
            </span>
          </div>
          <Tabs
            ariaLabel="Order book outcome"
            compact
            onChange={selectOutcome}
            options={[
              { value: 'YES', label: 'YES' },
              { value: 'NO', label: 'NO' },
            ]}
            value={outcome}
          />
        </div>

        <div className={styles.workspace}>
          <div className={styles.book}>
            <div className={styles.columns}>
              <span>Price</span>
              <span>Size</span>
              <span>Total USDC</span>
              <span>Orders</span>
            </div>
            <div className={styles.section}>
              <span className={styles.sectionLabel}>Asks · sell {outcome}</span>
              <Ladder book={book} side="asks" />
            </div>
            <div className={styles.spread}>
              <span>Spread</span>
              <strong className="numeric">
                {book.asks[0] && book.bids[0]
                  ? formatPrice(
                      (
                        BigInt(book.asks[0].priceRaw) -
                        BigInt(book.bids[0].priceRaw)
                      ).toString(),
                      6,
                    )
                  : '—'}
              </strong>
            </div>
            <div className={styles.section}>
              <span className={styles.sectionLabel}>Bids · buy {outcome}</span>
              <Ladder book={book} side="bids" />
            </div>
          </div>

          <section className={styles.ticket}>
            <div className={styles.ticketHeader}>
              <h3>Place order</h3>
              <span
                className={`${styles.outcomePill} ${
                  outcome === 'YES' ? styles.yes : styles.no
                }`}
              >
                {outcome}
              </span>
            </div>
            <Tabs
              ariaLabel="Order side"
              className={styles.sideTabs}
              compact
              onChange={(side) => {
                setOrderSide(side);
                if (priceRaw !== null) {
                  setPrice(
                    snappedPriceInput(priceRaw, minimumTickSizeRaw, side),
                  );
                }
                tx.reset();
              }}
              options={[
                { value: 'BID', label: 'Buy · BID' },
                { value: 'ASK', label: 'Sell · ASK' },
              ]}
              value={orderSide}
            />
            <label className={styles.field}>
              <span>Limit price</span>
              <span className={styles.input}>
                <input
                  aria-describedby={
                    priceError ? 'miniclob-order-price-error' : undefined
                  }
                  aria-invalid={priceError !== null}
                  inputMode="decimal"
                  onChange={(event) => setPrice(event.target.value)}
                  onBlur={() => {
                    if (
                      priceRaw !== null &&
                      priceRaw > 0n &&
                      priceRaw <= PRICE_SCALE
                    ) {
                      setPrice(
                        snappedPriceInput(
                          priceRaw,
                          minimumTickSizeRaw,
                          orderSide,
                        ),
                      );
                    }
                  }}
                  step={formatUnits(minimumTickSizeRaw, 6)}
                  value={price}
                />
                <b>USDC/token</b>
              </span>
            </label>
            {priceError && (
              <p
                className={styles.sizeError}
                id="miniclob-order-price-error"
                role="alert"
              >
                {priceError}
              </p>
            )}
            <p className={styles.onchainNote}>
              New-order price tick {formatUnits(minimumTickSizeRaw, 6)} USDC ·
              {' '}size step 0.001 token. Existing resting orders, including
              handoff seeds, keep their exact executable prices.
            </p>
            <label className={styles.field}>
              <span>Size</span>
              <span className={styles.input}>
                <input
                  aria-describedby={
                    sizeError
                      ? 'miniclob-order-size-error'
                      : orderSide === 'ASK' && fundingError
                        ? 'miniclob-order-funding-error'
                        : undefined
                  }
                  aria-invalid={
                    sizeError !== null ||
                    (orderSide === 'ASK' && fundingError !== null)
                  }
                  inputMode="decimal"
                  onChange={(event) => setSize(event.target.value)}
                  onBlur={() => {
                    if (sizeRaw !== null && sizeRaw > 0n && !validSize) {
                      setSize(snappedOrderSizeInput(sizeRaw));
                    }
                  }}
                  step={ORDER_SIZE_STEP}
                  value={size}
                />
                <b>{outcome}</b>
              </span>
            </label>
            {sizeError && (
              <p
                className={styles.sizeError}
                id="miniclob-order-size-error"
                role="alert"
              >
                {sizeError}
              </p>
            )}
            <dl className={styles.ticketRows}>
              <div>
                <dt>{orderSide === 'BID' ? 'USDC escrow' : `${outcome} escrow`}</dt>
                <dd className="numeric">
                  {placeEscrowRaw === null
                    ? '—'
                    : orderSide === 'BID'
                      ? `${formatUsdc(placeEscrowRaw.toString(), 6)} USDC`
                      : `${formatRaw(placeEscrowRaw.toString(), {
                          minimumFractionDigits: 0,
                          maximumFractionDigits: 6,
                        })} ${outcome}`}
                </dd>
              </div>
              <div>
                <dt>Wallet holds</dt>
                <dd className="numeric">
                  {orderSide === 'BID'
                    ? collateralBalance.isLoading
                      ? 'Loading Arc USDC…'
                      : collateralBalance.data === undefined
                        ? '— USDC'
                        : `${formatUsdc(collateralBalance.data.toString(), 6)} USDC`
                    : selectedPosition
                      ? `${formatRaw(selectedPosition.qtyRaw, {
                        minimumFractionDigits: 0,
                        maximumFractionDigits: 3,
                      })} ${outcome}`
                      : `0 ${outcome}`}
                </dd>
              </div>
            </dl>
            {fundingError && (
              <p
                className={styles.sizeError}
                id="miniclob-order-funding-error"
                role="alert"
              >
                {fundingError}
              </p>
            )}
            <Button
              disabled={!canPlace}
              fullWidth
              onClick={() => openAction({ kind: 'place' })}
              variant={outcome === 'YES' ? 'mint' : 'sky'}
            >
              {placeButtonLabel}
            </Button>
            <p className={styles.onchainNote}>
              Positive sizes below 0.001 stay unchanged so their step error remains
              visible. Larger off-step sizes round down on blur. Escrow and order
              state remain fully on-chain in MiniCLOB.
            </p>
          </section>
        </div>

        <section className={styles.resting}>
          <div className={styles.restingHeader}>
            <div>
              <h3>Resting {outcome} orders</h3>
              <p>Raw orders backing the aggregated ladder</p>
            </div>
            <span className="numeric">{restingOrders.length} open</span>
          </div>
          {!conditionUnresolved && !settlement.isLoading && !settlement.error && (
            <p className={styles.resolvedNotice}>
              Conditional Tokens is resolved. New orders and fills are disabled;
              makers may still cancel their own escrowed orders.
            </p>
          )}
          {settlement.error && (
            <p className={styles.resolvedNotice} role="alert">
              The payout denominator could not be verified. Fills stay disabled
              until the live condition read succeeds.
            </p>
          )}
          <div className={styles.orderTable}>
            <div className={`${styles.orderRow} ${styles.orderHead}`}>
              <span>Order</span>
              <span>Side</span>
              <span>Price</span>
              <span>Remaining</span>
              <span>Maker</span>
              <span>Action</span>
            </div>
            {restingOrders.length === 0 ? (
              <div className={styles.orderEmpty}>
                No resting {outcome} orders on-chain.
              </div>
            ) : (
              restingOrders.map((order) => {
                const ownOrder = isConnectedWalletMaker(order.maker, address);
                return (
                  <div className={styles.orderRow} key={order.orderId}>
                    <span className="numeric">
                      #{order.orderId}
                      {order.isSeed && (
                        <small
                          title="Graduation handoff quote keeps its exact executable price"
                        >
                          {isPriceOnTick(
                            BigInt(order.priceRaw),
                            minimumTickSizeRaw,
                          )
                            ? 'Seed'
                            : 'Exact seed'}
                        </small>
                      )}
                    </span>
                    <span className={styles.sideLabel}>{order.side}</span>
                    <span className="numeric">
                      {formatPrice(order.priceRaw, 6)}
                    </span>
                    <span className="numeric">
                      {formatRaw(order.remainingRaw, {
                        minimumFractionDigits: 0,
                        maximumFractionDigits: 3,
                      })}
                    </span>
                    <code
                      className="mono"
                      title={order.maker}
                    >
                      {shortAddress(order.maker, 4, 3)}
                    </code>
                    <span className={styles.actionGroup}>
                      <button
                        className={styles.rowAction}
                        disabled={
                          ownOrder ||
                          !isConnected ||
                          wrongNetwork ||
                          !conditionUnresolved ||
                          tx.isBusy
                        }
                        onClick={() => openAction({ kind: 'fill', order })}
                        type="button"
                      >
                        {ownOrder ? 'Your order' : 'Fill'}
                      </button>
                      {ownOrder && (
                        <button
                          className={`${styles.rowAction} ${styles.cancelAction}`}
                          disabled={wrongNetwork || tx.isBusy}
                          onClick={() => openAction({ kind: 'cancel', order })}
                          type="button"
                        >
                          Cancel
                        </button>
                      )}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </section>
      </Card>

      <ConfirmModal
        closeDisabled={tx.isBusy}
        closeOnConfirm={false}
        confirmDisabled={confirmDisabled}
        confirmLabel={confirmLabel}
        kicker="Live Arc transaction"
        onClose={closeAction}
        onConfirm={handleAction}
        open={action !== null}
        title={actionTitle(action)}
      >
        {action?.kind === 'place' && (
          <>
            <p>
              The market binding, CTF payout denominator, balance, and approval
              are re-read immediately before signing. The contract call is{' '}
              <code>
                place(conditionId, tokenId, {orderSide === 'BID' ? 0 : 1},{' '}
                {priceRaw?.toString() ?? '—'}, {sizeRaw?.toString() ?? '—'})
              </code>
              .
            </p>
            <dl className={styles.confirmRows}>
              <div>
                <dt>Order</dt>
                <dd>
                  {outcome} {orderSide} @{' '}
                  <span className="numeric">
                    {validPrice && priceRaw !== null
                      ? formatPrice(priceRaw.toString(), 6)
                      : '—'}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd className="numeric">
                  {validSize && sizeRaw !== null
                    ? formatRaw(sizeRaw.toString(), {
                        minimumFractionDigits: 0,
                        maximumFractionDigits: 6,
                      })
                    : '—'}{' '}
                  {outcome}
                </dd>
              </div>
              <div>
                <dt>
                  {orderSide === 'BID'
                    ? 'USDC escrow total'
                    : `${outcome} escrow total`}
                </dt>
                <dd className="numeric">
                  {placeEscrowRaw === null
                    ? '—'
                    : orderSide === 'BID'
                      ? `${formatUsdc(placeEscrowRaw.toString(), 6)} USDC`
                      : `${formatRaw(placeEscrowRaw.toString(), {
                          minimumFractionDigits: 0,
                          maximumFractionDigits: 6,
                        })} ${outcome}`}
                </dd>
              </div>
              <div>
                <dt>Expiry</dt>
                <dd>No expiry · good till cancelled</dd>
              </div>
              <div>
                <dt>Approval</dt>
                <dd>
                  {orderSide === 'BID'
                    ? 'USDC → MiniCLOB if needed'
                    : 'CTF → MiniCLOB if needed'}
                </dd>
              </div>
            </dl>
            <p className={styles.onchainNote}>
              A resting order can be filled by anyone until it is filled or
              cancelled on-chain. This is a binding commitment, not a draft.
            </p>
          </>
        )}

        {action?.kind === 'fill' && activeOrder && (
          <>
            <p>
              Order #{activeOrder.orderId}, its dynamic{' '}
              <code>minimumFillRaw</code>, remaining size, and payout
              denominator are re-read before signing.
            </p>
            <label className={styles.modalField}>
              <span>Fill size</span>
              <span className={styles.input}>
                <input
                  aria-invalid={!validFill}
                  inputMode="decimal"
                  onChange={(event) => setFillSize(event.target.value)}
                  value={fillSize}
                />
                <b>{activeOrder.outcome}</b>
              </span>
            </label>
            <dl className={styles.confirmRows}>
              <div>
                <dt>Maker side</dt>
                <dd>{activeOrder.side}</dd>
              </div>
              <div>
                <dt>Limit price</dt>
                <dd className="numeric">
                  {formatPrice(activeOrder.priceRaw, 6)} USDC/token
                </dd>
              </div>
              <div>
                <dt>Current payment</dt>
                <dd className="numeric">
                  {fillPaymentRaw === null
                    ? '—'
                    : `${formatUsdc(fillPaymentRaw.toString(), 6)} USDC`}
                </dd>
              </div>
              <div>
                <dt>Approval</dt>
                <dd>
                  {activeOrder.side === 'ASK'
                    ? 'USDC → MiniCLOB if needed'
                    : 'CTF → MiniCLOB if needed'}
                </dd>
              </div>
            </dl>
          </>
        )}

        {action?.kind === 'cancel' && activeOrder && (
          <>
            <p>
              MiniCLOB re-reads the maker and open order immediately before the
              wallet signs <code>cancel({activeOrder.orderId})</code>. Remaining
              escrow is returned by the contract.
            </p>
            <dl className={styles.confirmRows}>
              <div>
                <dt>Remaining size</dt>
                <dd className="numeric">
                  {formatRaw(activeOrder.remainingRaw, {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 6,
                  })}{' '}
                  {activeOrder.outcome}
                </dd>
              </div>
              <div>
                <dt>Expected refund</dt>
                <dd className="numeric">
                  {activeOrder.side === 'BID'
                    ? `${formatUsdc(orderRefundRaw(activeOrder).toString(), 6)} USDC`
                    : `${formatRaw(orderRefundRaw(activeOrder).toString(), {
                        minimumFractionDigits: 0,
                        maximumFractionDigits: 6,
                      })} ${activeOrder.outcome}`}
                </dd>
              </div>
            </dl>
          </>
        )}

        {completion && (
          <p className={styles.completion} role="status">
            {completion}
          </p>
        )}
        <TxStatus state={tx.state} />
      </ConfirmModal>
    </>
  );
}
