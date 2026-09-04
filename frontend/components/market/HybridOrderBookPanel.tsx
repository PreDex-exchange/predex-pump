'use client';

import type {
  Market,
  OffchainOrder,
  OrderBook,
  OrderSide,
  Outcome,
  Position,
} from '@predex-pump/shared/domain';
import type {
  ExchangeApprovalStateResponse,
  MarketBookResponse,
  WithdrawOrderResponse,
} from '@predex-pump/shared/rest';
import {
  isOrderSizeGranular,
  leavesRepresentableRemainder,
  quantizePriceRaw,
} from '@predex-pump/shared';
import {
  ctfExchangeCollateralAmountForFill,
  ctfExchangeOrderFromWire,
} from '@predex-pump/shared/tx';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { formatUnits } from 'viem';
import { useAccount, useReadContract } from 'wagmi';

import { useAuth } from '@/components/providers/AuthProvider';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Tabs } from '@/components/ui/Tabs';
import { TxStatus } from '@/components/ui/TxStatus';
import {
  useExchangeApprovals,
  useMyOrders,
} from '@/lib/api/hooks';
import { backendRestClient } from '@/lib/api/rest-client';
import { arcAddresses, arcTestnet } from '@/lib/chain/arc';
import { collateralErc20Abi } from '@/lib/chain/contracts';
import {
  approveCtfExchangeCollateralOnArc,
  approveCtfExchangeTokensOnArc,
  fillCtfExchangeOrderOnArc,
  signCtfExchangeOrderOnArc,
  submitPreparedCtfExchangeCancelOnArc,
} from '@/lib/chain/transactions';
import { useTxFlow } from '@/lib/chain/useTxFlow';
import {
  buildHybridOrderCommitment,
  fillApprovalRequirement,
  hybridLevelCollateralRaw,
  makerApprovalRequirement,
  orderBookForVenue,
  type ExchangeApprovalRequirement,
} from '@/lib/exchange/hybrid';
import {
  formatPrice,
  formatRaw,
  formatUsdc,
  parseUsdcInput,
  shortAddress,
} from '@/lib/format';
import {
  ORDER_SIZE_STEP,
  ORDER_SIZE_STEP_ERROR,
  snappedOrderSizeInput,
  validateOrderPriceInput,
} from '@/lib/order-input';
import { isConnectedWalletMaker } from '@/lib/order-ownership';

import styles from './HybridOrderBookPanel.module.css';

interface HybridOrderBookPanelProps {
  books: MarketBookResponse;
  market: Market;
  positions?: Position[];
}

interface OptimisticCtfApproval {
  owner: `0x${string}`;
  validUntil: number;
}

interface OptimisticCollateralApproval extends OptimisticCtfApproval {
  amountRaw: bigint;
}

const APPROVAL_INDEX_GRACE_SECONDS = 120;
const DEFAULT_ORDER_EXPIRY_SECONDS = 24 * 60 * 60;
const MINIMUM_ORDER_EXPIRY_SECONDS = 60;

function rawInput(value: string): bigint | null {
  const parsed = parseUsdcInput(value);
  return parsed === null ? null : BigInt(parsed);
}

function snappedPriceInput(
  priceRaw: bigint,
  tickSizeRaw: bigint,
  side: OrderSide,
): string {
  return formatUnits(
    quantizePriceRaw(priceRaw, tickSizeRaw, side === 'BID' ? 'DOWN' : 'UP'),
    6,
  );
}

export function utcInputValue(timestamp: number): string {
  return new Date(timestamp * 1_000).toISOString().slice(0, 16);
}

function parseUtcInput(value: string): number | null {
  const milliseconds = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(milliseconds)) return null;
  return Math.floor(milliseconds / 1_000);
}

export function defaultOrderExpiryTimestamp(
  tradingEndsAt: number,
  nowSeconds = Math.floor(Date.now() / 1_000),
): number {
  return Math.max(tradingEndsAt, nowSeconds + DEFAULT_ORDER_EXPIRY_SECONDS);
}

export function formatUtcExpiry(timestamp: number): string {
  if (timestamp === 0) return 'No expiry · good till cancelled';
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(timestamp * 1_000);
}

function approvalStateWithConfirmed(
  indexed: ExchangeApprovalStateResponse | null,
  owner: `0x${string}` | undefined,
  ctfConfirmed: OptimisticCtfApproval | null,
  collateralConfirmed: OptimisticCollateralApproval | null,
  nowSeconds: number,
): ExchangeApprovalStateResponse | null {
  if (
    !indexed ||
    !owner ||
    indexed.owner.toLowerCase() !== owner.toLowerCase()
  ) {
    return null;
  }
  const hasFreshCtfConfirmation =
    ctfConfirmed !== null &&
    ctfConfirmed.owner.toLowerCase() === owner.toLowerCase() &&
    ctfConfirmed.validUntil > nowSeconds;
  const freshCollateralConfirmation =
    collateralConfirmed !== null &&
    collateralConfirmed.owner.toLowerCase() === owner.toLowerCase() &&
    collateralConfirmed.validUntil > nowSeconds
      ? collateralConfirmed
      : null;
  const indexedAllowance = BigInt(indexed.collateralAllowanceRaw);
  const collateralAllowanceRaw =
    freshCollateralConfirmation !== null &&
    freshCollateralConfirmation.amountRaw > indexedAllowance
      ? freshCollateralConfirmation.amountRaw.toString()
      : indexed.collateralAllowanceRaw;
  return {
    ...indexed,
    owner,
    ctfApprovedForAll: indexed.ctfApprovedForAll || hasFreshCtfConfirmation,
    collateralAllowanceRaw,
  };
}

function HybridLadder({
  book,
  side,
}: {
  book: OrderBook;
  side: 'asks' | 'bids';
}) {
  const levels = book[side];
  const orderSide: OrderSide = side === 'asks' ? 'ASK' : 'BID';
  if (levels.length === 0) {
    return (
      <div className={styles.emptyBook}>
        No fillable signed {side} on the Hybrid exchange.
      </div>
    );
  }
  return (
    <div>
      {levels.map((level) => (
        <div className={styles.level} key={`${side}:${level.priceRaw}`}>
          <span className="numeric">{formatPrice(level.priceRaw, 6)}</span>
          <span className="numeric">
            {formatRaw(level.sizeRaw, {
              minimumFractionDigits: 0,
              maximumFractionDigits: 6,
            })}
          </span>
          <span className="numeric">
            {formatUsdc(
              hybridLevelCollateralRaw(
                book.offchainOrders,
                orderSide,
                level.priceRaw,
              ).toString(),
              6,
            )}
          </span>
          <span className="numeric">{level.orderCount}</span>
        </div>
      ))}
    </div>
  );
}

function ApprovalExplanation({
  requirement,
}: {
  requirement: ExchangeApprovalRequirement;
}) {
  return requirement.kind === 'COLLATERAL' ? (
    <p>
      This buy or fill pays USDC. The exchange needs an allowance for exactly the
      collateral shown; no unlimited allowance is requested.
    </p>
  ) : (
    <p>
      This sell or BID fill delivers position tokens. The exchange needs permission
      to transfer only the CTF tokens involved in orders you choose to sign or fill.
    </p>
  );
}

export function HybridOrderBookPanel({
  books,
  market,
  positions = [],
}: HybridOrderBookPanelProps) {
  const queryClient = useQueryClient();
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
  const approvals = useExchangeApprovals(address);
  const myOrders = useMyOrders(address, authenticated);
  const approvalTx = useTxFlow();
  const actionTx = useTxFlow();
  const minimumTickSizeRaw = BigInt(books.minimumTickSizeRaw);

  const [outcome, setOutcome] = useState<Outcome>('YES');
  const [orderSide, setOrderSide] = useState<OrderSide>('BID');
  const [price, setPrice] = useState(() =>
    snappedPriceInput(BigInt(market.yesPriceRaw), minimumTickSizeRaw, 'BID'),
  );
  const [size, setSize] = useState('0.20');
  const [expiry, setExpiry] = useState(() =>
    utcInputValue(defaultOrderExpiryTimestamp(market.tradingEndsAt)),
  );
  const [reviewOpen, setReviewOpen] = useState(false);
  const [fillTarget, setFillTarget] = useState<OffchainOrder | null>(null);
  const [fillSize, setFillSize] = useState('');
  const [cancelTarget, setCancelTarget] = useState<OffchainOrder | null>(null);
  const [ctfConfirmed, setCtfConfirmed] =
    useState<OptimisticCtfApproval | null>(null);
  const [collateralConfirmed, setCollateralConfirmed] =
    useState<OptimisticCollateralApproval | null>(null);
  const [completion, setCompletion] = useState<string | null>(null);
  const [withdrawn, setWithdrawn] = useState(
    () => new Map<string, WithdrawOrderResponse>(),
  );
  const [cancelled, setCancelled] = useState(() => new Set<string>());
  const [orderActionBusy, setOrderActionBusy] = useState<string | null>(null);
  const [orderActionError, setOrderActionError] = useState<string | null>(null);
  const [makerSessionAttemptFailed, setMakerSessionAttemptFailed] =
    useState(false);
  const [nowSeconds, setNowSeconds] = useState(() =>
    Math.floor(Date.now() / 1_000),
  );
  useEffect(() => {
    const update = () => setNowSeconds(Math.floor(Date.now() / 1_000));
    update();
    const interval = window.setInterval(update, 30_000);
    return () => window.clearInterval(interval);
  }, []);

  const wrongNetwork = isConnected && chainId !== arcTestnet.id;
  const sourceBook = outcome === 'YES' ? books.yes : books.no;
  const book = useMemo(
    () => orderBookForVenue(sourceBook, 'HYBRID'),
    [sourceBook],
  );
  const priceValidation = validateOrderPriceInput(price, minimumTickSizeRaw);
  const priceRaw = priceValidation.raw;
  const priceError = priceValidation.error;
  const sizeRaw = rawInput(size);
  const outcomeBalanceRaw = BigInt(
    positions.find((position) => position.outcome === outcome)?.qtyRaw ?? '0',
  );
  const sizeIsGranular =
    sizeRaw !== null && isOrderSizeGranular(sizeRaw);
  const sizeError =
    sizeRaw === null || sizeRaw <= 0n
      ? 'Enter an order size greater than zero'
      : !sizeIsGranular
        ? ORDER_SIZE_STEP_ERROR
        : null;
  const expiration = parseUtcInput(expiry);
  const validExpiration =
    expiration !== null &&
    expiration >= nowSeconds + MINIMUM_ORDER_EXPIRY_SECONDS;
  const commitment = (() => {
    if (
      priceRaw === null ||
      sizeRaw === null ||
      expiration === null ||
      priceError !== null ||
      !sizeIsGranular
    ) {
      return null;
    }
    try {
      return buildHybridOrderCommitment({
        side: orderSide,
        priceRaw,
        sizeRaw,
        minimumTickSizeRaw,
        expiration,
      });
    } catch {
      return null;
    }
  })();
  const fundingError =
    commitment === null
      ? null
      : orderSide === 'BID'
        ? collateralBalance.error
          ? 'Arc USDC balance is unavailable'
          : collateralBalance.data !== undefined &&
              commitment.collateralRaw > collateralBalance.data
            ? `Insufficient USDC balance: requires ${formatUsdc(commitment.collateralRaw.toString(), 6)} USDC, wallet holds ${formatUsdc(collateralBalance.data.toString(), 6)} USDC`
            : null
        : commitment.sizeRaw > outcomeBalanceRaw
          ? `Insufficient ${outcome} balance: requires ${formatRaw(commitment.sizeRaw.toString(), {
              minimumFractionDigits: 0,
              maximumFractionDigits: 6,
            })} ${outcome}, wallet holds ${formatRaw(outcomeBalanceRaw.toString(), {
              minimumFractionDigits: 0,
              maximumFractionDigits: 6,
            })} ${outcome}`
          : null;
  const fundingReady =
    commitment !== null &&
    fundingError === null &&
    (orderSide === 'BID'
      ? collateralBalance.data !== undefined
      : commitment.sizeRaw <= outcomeBalanceRaw);
  const effectiveApprovals = useMemo(
    () =>
      approvalStateWithConfirmed(
        approvals.data,
        address,
        ctfConfirmed,
        collateralConfirmed,
        nowSeconds,
      ),
    [
      address,
      approvals.data,
      collateralConfirmed,
      ctfConfirmed,
      nowSeconds,
    ],
  );
  const makerRequirement =
    effectiveApprovals && commitment
      ? makerApprovalRequirement(
          effectiveApprovals,
          orderSide,
          commitment.collateralRaw,
        )
      : null;
  const collateralAllowanceRaw = effectiveApprovals
    ? BigInt(effectiveApprovals.collateralAllowanceRaw)
    : null;
  const missingCollateralRaw =
    commitment && orderSide === 'BID' && collateralAllowanceRaw !== null
      ? commitment.collateralRaw > collateralAllowanceRaw
        ? commitment.collateralRaw - collateralAllowanceRaw
        : 0n
      : null;
  const makerApprovalReady = makerRequirement?.ready === true;
  const canReview =
    isConnected &&
    Boolean(address) &&
    !wrongNetwork &&
    Boolean(commitment) &&
    sizeError === null &&
    fundingReady &&
    validExpiration &&
    makerApprovalReady &&
    market.resolvedAt === null;

  const fillSizeRaw = rawInput(fillSize);
  const validFill =
    fillTarget !== null &&
    fillSizeRaw !== null &&
    fillSizeRaw > 0n &&
    leavesRepresentableRemainder(
      BigInt(fillTarget.remainingRaw),
      fillSizeRaw,
    );
  const fillIsOwnOrder =
    fillTarget !== null &&
    isConnectedWalletMaker(fillTarget.maker, address);
  const fillCollateralRaw =
    fillTarget && validFill && fillSizeRaw !== null
      ? ctfExchangeCollateralAmountForFill(
          ctfExchangeOrderFromWire(fillTarget.signedOrder),
          fillSizeRaw,
        )
      : null;
  const fillRequirement =
    effectiveApprovals && fillTarget && validFill && fillSizeRaw !== null
      ? fillApprovalRequirement(
          effectiveApprovals,
          fillTarget,
          fillSizeRaw,
        )
      : null;

  const displayedMyOrders = useMemo(() => {
    const byHash = new Map<string, OffchainOrder>();
    for (const order of myOrders.data?.orders ?? []) {
      if (
        isConnectedWalletMaker(order.maker, address) &&
        !cancelled.has(order.orderHash)
      ) {
        byHash.set(order.orderHash, order);
      }
    }
    for (const response of withdrawn.values()) {
      if (
        isConnectedWalletMaker(response.order.maker, address) &&
        !cancelled.has(response.order.orderHash)
      ) {
        byHash.set(response.order.orderHash, response.order);
      }
    }
    return [...byHash.values()].sort((left, right) =>
      left.createdAt === right.createdAt
        ? left.orderHash.localeCompare(right.orderHash)
        : right.createdAt - left.createdAt,
    );
  }, [address, cancelled, myOrders.data, withdrawn]);

  async function approveCollateral(amountRaw: bigint) {
    if (!address || !effectiveApprovals || wrongNetwork) return;
    if (BigInt(effectiveApprovals.collateralAllowanceRaw) >= amountRaw) return;
    approvalTx.reset();
    const result = await approvalTx.execute((report) =>
      approveCtfExchangeCollateralOnArc({
        account: address,
        amountRaw,
        report,
      }),
    );
    if (!result) return;
    setCollateralConfirmed((current) => ({
      owner: address,
      amountRaw:
        current !== null &&
        current.owner.toLowerCase() === address.toLowerCase() &&
        current.amountRaw > amountRaw
          ? current.amountRaw
          : amountRaw,
      validUntil:
        Math.floor(Date.now() / 1_000) + APPROVAL_INDEX_GRACE_SECONDS,
    }));
    approvals.refetch();
  }

  async function approveTokens() {
    if (!address || !effectiveApprovals || wrongNetwork) return;
    if (effectiveApprovals.ctfApprovedForAll) return;
    approvalTx.reset();
    const result = await approvalTx.execute((report) =>
      approveCtfExchangeTokensOnArc({ account: address, report }),
    );
    if (!result) return;
    setCtfConfirmed({
      owner: address,
      validUntil:
        Math.floor(Date.now() / 1_000) + APPROVAL_INDEX_GRACE_SECONDS,
    });
    approvals.refetch();
  }

  async function signAndPost() {
    if (
      !address ||
      !commitment ||
      !makerApprovalReady ||
      sizeError !== null ||
      !fundingReady ||
      !validExpiration
    ) {
      return;
    }
    actionTx.reset();
    setCompletion(null);
    const result = await actionTx.execute(
      async (report) => {
        const request = await signCtfExchangeOrderOnArc({
          account: address,
          tokenId: BigInt(outcome === 'YES' ? market.yesTokenId : market.noTokenId),
          side: commitment.exchangeSide,
          priceRaw: commitment.priceRaw,
          sizeRaw: commitment.sizeRaw,
          minimumTickSizeRaw,
          expiration: BigInt(commitment.expiration),
          report,
        });
        const posted = await backendRestClient.postOrder(request);
        report({
          phase: 'confirmed',
          message: 'The signed order is live in the Hybrid operator book.',
        });
        return posted;
      },
      {
        checkingMessage: 'Preparing the signed off-chain order…',
        failureMessage: 'The signed order was not posted.',
        failurePhase: 'rejected',
      },
    );
    if (!result) return;
    approvalTx.reset();
    setCompletion(`Signed order ${shortAddress(result.order.orderHash, 8, 6)} is live.`);
    if (authenticated) myOrders.refetch();
    await queryClient.invalidateQueries({
      queryKey: ['order-book', market.id],
    });
  }

  function openFill(order: OffchainOrder) {
    if (isConnectedWalletMaker(order.maker, address)) return;
    actionTx.reset();
    approvalTx.reset();
    setCompletion(null);
    setFillTarget(order);
    setFillSize(formatUnits(BigInt(order.remainingRaw), 6));
  }

  async function fillOrder() {
    if (
      !address ||
      !fillTarget ||
      !validFill ||
      fillSizeRaw === null ||
      fillRequirement?.ready !== true ||
      fillIsOwnOrder ||
      wrongNetwork
    ) {
      return;
    }
    actionTx.reset();
    const result = await actionTx.execute((report) =>
      fillCtfExchangeOrderOnArc({
        account: address,
        order: ctfExchangeOrderFromWire(fillTarget.signedOrder),
        fillAmount: fillSizeRaw,
        report,
      }),
    );
    if (!result) return;
    setCompletion(
      `Fill confirmed for ${formatRaw(fillSizeRaw.toString(), {
        minimumFractionDigits: 0,
        maximumFractionDigits: 6,
      })} ${fillTarget.outcome}.`,
    );
    await queryClient.invalidateQueries({
      queryKey: ['order-book', market.id],
    });
  }

  async function withdrawOrder(order: OffchainOrder) {
    setOrderActionBusy(order.orderHash);
    setOrderActionError(null);
    try {
      const response = await backendRestClient.withdrawOrder(order.orderHash);
      setWithdrawn((current) => {
        const next = new Map(current);
        next.set(order.orderHash, response);
        return next;
      });
      myOrders.refetch();
      await queryClient.invalidateQueries({
        queryKey: ['order-book', order.marketId],
      });
    } catch {
      setOrderActionError(
        'This order could not be withdrawn from the operator book.',
      );
    } finally {
      setOrderActionBusy(null);
    }
  }

  async function requestMakerSession() {
    if (isEstablishingSession) return;
    setMakerSessionAttemptFailed(false);
    try {
      if (!(await ensureSession())) setMakerSessionAttemptFailed(true);
    } catch {
      setMakerSessionAttemptFailed(true);
    }
  }

  async function cancelOrderOnchain() {
    if (
      !address ||
      !authenticated ||
      !cancelTarget ||
      !isConnectedWalletMaker(cancelTarget.maker, address) ||
      wrongNetwork
    ) {
      return;
    }
    actionTx.reset();
    setOrderActionError(null);
    const result = await actionTx.execute(async (report) => {
      let prepared = withdrawn.get(cancelTarget.orderHash);
      if (!prepared) {
        report({
          phase: 'checking',
          message: 'Withdrawing from this operator before preparing authoritative cancellation…',
        });
        prepared = await backendRestClient.withdrawOrder(cancelTarget.orderHash);
        setWithdrawn((current) => {
          const next = new Map(current);
          next.set(cancelTarget.orderHash, prepared as WithdrawOrderResponse);
          return next;
        });
      }
      return submitPreparedCtfExchangeCancelOnArc({
        account: address,
        transaction: prepared.authoritativeCancelOrderTx,
        report,
      });
    });
    if (!result) return;
    setCancelled((current) => new Set(current).add(cancelTarget.orderHash));
    setCompletion('The signature is authoritatively cancelled on-chain.');
    myOrders.refetch();
    await queryClient.invalidateQueries({
      queryKey: ['order-book', cancelTarget.marketId],
    });
  }

  const reviewButtonLabel = !isConnected
    ? 'Connect wallet in the header'
    : wrongNetwork
      ? 'Switch to Arc Testnet'
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
                : approvals.isLoading
                  ? 'Reading indexed approvals…'
                  : approvals.error
                    ? 'Approval state unavailable'
                    : !validExpiration
                      ? 'Choose a future expiry'
                      : !commitment
                        ? 'This order cannot be prepared'
                        : !makerApprovalReady
                          ? orderSide === 'BID'
                            ? 'Approve exact collateral above'
                            : 'Approve position transfers above'
                          : 'Review binding order';

  return (
    <>
      <Card className={styles.card}>
        <header className={styles.header}>
          <div>
            <h2>Hybrid exchange order book</h2>
            <p>Fillable signed orders · prices in USDC per token</p>
            <span className={styles.venueLabel}>
              Live venue · Hybrid CTF exchange
            </span>
          </div>
          <Tabs
            ariaLabel="Hybrid order book outcome"
            compact
            onChange={(nextOutcome) => {
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
              actionTx.reset();
            }}
            options={[
              { value: 'YES', label: 'YES' },
              { value: 'NO', label: 'NO' },
            ]}
            value={outcome}
          />
        </header>

        <div className={styles.workspace}>
          <section className={styles.book} aria-label="Hybrid exchange ladder">
            <div className={styles.columns}>
              <span>Price</span>
              <span>Size</span>
              <span>Total USDC</span>
              <span>Orders</span>
            </div>
            <div className={styles.bookSection}>
              <span className={styles.sectionLabel}>Asks · sell {outcome}</span>
              <HybridLadder book={book} side="asks" />
            </div>
            <div className={styles.spread}>
              <span>Spread</span>
              <strong className="numeric">
                {book.bestAskRaw && book.bestBidRaw
                  ? formatPrice(
                      (
                        BigInt(book.bestAskRaw) - BigInt(book.bestBidRaw)
                      ).toString(),
                      6,
                    )
                  : '—'}
              </strong>
            </div>
            <div className={styles.bookSection}>
              <span className={styles.sectionLabel}>Bids · buy {outcome}</span>
              <HybridLadder book={book} side="bids" />
            </div>
          </section>

          <section className={styles.ticket} aria-label="Signed order form">
            <div className={styles.ticketHeader}>
              <h3>Sign an order</h3>
              <span
                className={`${styles.outcomePill} ${
                  outcome === 'YES' ? styles.yes : styles.no
                }`}
              >
                {outcome}
              </span>
            </div>
            <Tabs
              ariaLabel="Signed order side"
              className={styles.sideTabs}
              compact
              onChange={(side) => {
                setOrderSide(side);
                if (priceRaw !== null) {
                  setPrice(
                    snappedPriceInput(priceRaw, minimumTickSizeRaw, side),
                  );
                }
                actionTx.reset();
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
                    priceError ? 'hybrid-order-price-error' : undefined
                  }
                  aria-invalid={priceError !== null}
                  inputMode="decimal"
                  onChange={(event) => setPrice(event.target.value)}
                  onBlur={() => {
                    if (
                      priceRaw !== null &&
                      priceRaw > 0n &&
                      priceRaw <= 1_000_000n
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
                id="hybrid-order-price-error"
                role="alert"
              >
                {priceError}
              </p>
            )}
            <label className={styles.field}>
              <span>Size</span>
              <span className={styles.input}>
                <input
                  aria-describedby={
                    sizeError
                      ? 'hybrid-order-size-error'
                      : orderSide === 'ASK' && fundingError
                        ? 'hybrid-order-funding-error'
                        : undefined
                  }
                  aria-invalid={
                    sizeError !== null ||
                    (orderSide === 'ASK' && fundingError !== null)
                  }
                  inputMode="decimal"
                  onChange={(event) => setSize(event.target.value)}
                  onBlur={() => {
                    if (
                      sizeRaw !== null &&
                      sizeRaw > 0n &&
                      !sizeIsGranular
                    ) {
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
                id="hybrid-order-size-error"
                role="alert"
              >
                {sizeError}
              </p>
            )}
            <p className={styles.bindingNote}>
              New-order price tick {formatUnits(minimumTickSizeRaw, 6)} USDC ·
              {' '}size step 0.001 token · existing resting quotes keep their
              exact executable prices
            </p>
            <label className={styles.field}>
              <span>Expiry (UTC)</span>
              <span className={styles.input}>
                <input
                  aria-invalid={!validExpiration}
                  min={utcInputValue(
                    nowSeconds + MINIMUM_ORDER_EXPIRY_SECONDS,
                  )}
                  onChange={(event) => setExpiry(event.target.value)}
                  onBlur={() => {
                    const parsed = parseUtcInput(expiry);
                    if (
                      parsed === null ||
                      parsed < nowSeconds + MINIMUM_ORDER_EXPIRY_SECONDS
                    ) {
                      setExpiry(
                        utcInputValue(
                          defaultOrderExpiryTimestamp(
                            market.tradingEndsAt,
                            nowSeconds,
                          ),
                        ),
                      );
                    }
                  }}
                  type="datetime-local"
                  value={expiry}
                />
                <b>UTC</b>
              </span>
            </label>
            <dl className={styles.ticketRows}>
              <div>
                <dt>
                  {orderSide === 'BID'
                    ? 'Total collateral'
                    : 'Estimated proceeds'}
                </dt>
                <dd className="numeric">
                  {commitment
                    ? `${formatUsdc(commitment.collateralRaw.toString(), 6)} USDC`
                    : '—'}
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
                    : `${formatRaw(outcomeBalanceRaw.toString(), {
                        minimumFractionDigits: 0,
                        maximumFractionDigits: 6,
                      })} ${outcome}`}
                </dd>
              </div>
            </dl>
            {fundingError && (
              <p
                className={styles.sizeError}
                id="hybrid-order-funding-error"
                role="alert"
              >
                {fundingError}
              </p>
            )}

            <section className={styles.approvals} aria-label="Exchange approvals">
              <div className={styles.approvalHeader}>
                <h4>Before any wallet prompt</h4>
                <button onClick={approvals.refetch} type="button">
                  Refresh
                </button>
              </div>
              {!isConnected ? (
                <p className={styles.stateText}>
                  Connect a wallet to read its indexed exchange approvals.
                </p>
              ) : approvals.isLoading ? (
                <p className={styles.stateText} role="status">
                  Reading indexed CTF and collateral approvals…
                </p>
              ) : approvals.error || !effectiveApprovals ? (
                <div className={styles.inlineError} role="alert">
                  <p>
                    Approval state could not be verified, so no approval or order
                    prompt will open.
                  </p>
                  <Button onClick={approvals.refetch} size="small" variant="neutral">
                    Check again
                  </Button>
                </div>
              ) : (
                <>
                  <div className={styles.approvalRow}>
                    <div>
                      <strong>Position-token transfers</strong>
                      <span>Needed to sell {outcome} tokens.</span>
                    </div>
                    <b
                      className={
                        effectiveApprovals.ctfApprovedForAll
                          ? styles.ready
                          : styles.missing
                      }
                    >
                      {effectiveApprovals.ctfApprovedForAll
                        ? 'Approved'
                        : orderSide === 'ASK'
                          ? 'Missing'
                          : 'Missing · not needed for this buy'}
                    </b>
                    {!effectiveApprovals.ctfApprovedForAll &&
                      orderSide === 'ASK' && (
                      <Button
                        disabled={
                          approvalTx.isBusy || wrongNetwork || !fundingReady
                        }
                        onClick={() => void approveTokens()}
                        size="small"
                        variant="neutral"
                      >
                        Approve position transfers
                      </Button>
                      )}
                  </div>
                  <div className={styles.approvalRow}>
                    <div>
                      <strong>Collateral spending</strong>
                      <span>Needed to buy; approvals use the exact reviewed total.</span>
                    </div>
                    <b
                      className={`numeric ${
                        commitment && orderSide === 'BID'
                          ? BigInt(effectiveApprovals.collateralAllowanceRaw) >=
                            commitment.collateralRaw
                            ? styles.ready
                            : styles.missing
                          : ''
                      }`}
                    >
                      {commitment && orderSide === 'BID'
                        ? collateralAllowanceRaw !== null &&
                          collateralAllowanceRaw >= commitment.collateralRaw
                          ? `Ready · ${formatUsdc(collateralAllowanceRaw.toString(), 6)} USDC allowance`
                          : `Missing · ${formatUsdc((missingCollateralRaw ?? 0n).toString(), 6)} USDC`
                        : `${formatUsdc(effectiveApprovals.collateralAllowanceRaw, 6)} USDC allowance · not needed for this sell`}
                    </b>
                    {commitment &&
                      BigInt(effectiveApprovals.collateralAllowanceRaw) <
                        commitment.collateralRaw &&
                      orderSide === 'BID' && (
                        <Button
                          disabled={
                            approvalTx.isBusy || wrongNetwork || !fundingReady
                          }
                          onClick={() =>
                            void approveCollateral(commitment.collateralRaw)
                          }
                          size="small"
                          variant="neutral"
                        >
                          Approve exactly{' '}
                          <span className="numeric">
                            {formatUsdc(commitment.collateralRaw.toString(), 6)}
                          </span>{' '}
                          USDC
                        </Button>
                      )}
                  </div>
                  <p className={styles.promptNote}>
                    Each missing approval has its own explained action. Signing never
                    launches an approval prompt automatically.
                  </p>
                </>
              )}
              <TxStatus state={approvalTx.state} />
            </section>

            <Button
              disabled={!canReview || actionTx.isBusy}
              fullWidth
              onClick={() => {
                actionTx.reset();
                setCompletion(null);
                setReviewOpen(true);
              }}
              variant={outcome === 'YES' ? 'mint' : 'sky'}
            >
              {reviewButtonLabel}
            </Button>
            <p className={styles.bindingNote}>
              This creates a signed commitment held off-chain; collateral and tokens
              move only when the order is filled on-chain.
            </p>
          </section>
        </div>

        <section className={styles.resting}>
          <div className={styles.sectionHeader}>
            <div>
              <h3>Fill a signed {outcome} order</h3>
              <p>Only orders from the labelled Hybrid venue are shown.</p>
            </div>
            <span className="numeric">{book.offchainOrders.length} fillable</span>
          </div>
          <div className={styles.orderTable}>
            <div className={`${styles.orderRow} ${styles.orderHead}`}>
              <span>Order</span>
              <span>Side</span>
              <span>Price</span>
              <span>Remaining</span>
              <span>Expiry</span>
              <span>Maker</span>
              <span>Action</span>
            </div>
            {book.offchainOrders.length === 0 ? (
              <div className={styles.orderEmpty}>
                No fillable signed {outcome} orders are live on this venue.
              </div>
            ) : (
              book.offchainOrders.map((order) => {
                const ownOrder = isConnectedWalletMaker(order.maker, address);
                return (
                  <div className={styles.orderRow} key={order.orderHash}>
                    <code data-label="Order" title={order.orderHash}>
                      {shortAddress(order.orderHash, 5, 4)}
                    </code>
                    <span data-label="Side">{order.side}</span>
                    <span className="numeric" data-label="Price">
                      {formatPrice(order.priceRaw, 6)}
                    </span>
                    <span className="numeric" data-label="Remaining">
                      {formatRaw(order.remainingRaw, {
                        minimumFractionDigits: 0,
                        maximumFractionDigits: 6,
                      })}
                    </span>
                    <span className="numeric" data-label="Expiry">
                      {formatUtcExpiry(order.signedOrder.expiration)}
                    </span>
                    <code data-label="Maker" title={order.maker}>
                      {shortAddress(order.maker, 4, 3)}
                    </code>
                    <button
                      className={styles.rowAction}
                      disabled={
                        ownOrder ||
                        !isConnected ||
                        wrongNetwork ||
                        actionTx.isBusy
                      }
                      onClick={() => openFill(order)}
                      type="button"
                    >
                      {ownOrder ? 'Your order' : 'Fill'}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </section>

        <section className={styles.myOrders}>
          <div className={styles.sectionHeader}>
            <div>
              <h3>My signed orders</h3>
              <p>
                Withdraw is free and off-chain. Cancel on-chain is authoritative and
                costs gas.
              </p>
            </div>
          </div>
          <p className={styles.withdrawWarning}>
            Withdrawing hides an order from our book, but its signature stays valid
            until it expires or is cancelled on-chain.
          </p>
          {!isConnected ? (
            <p className={styles.stateText}>Connect the maker wallet to see its orders.</p>
          ) : sessionLoading && !isEstablishingSession ? (
            <p className={styles.stateText} role="status">
              Preparing your private order list…
            </p>
          ) : !authenticated ? (
            <div className={styles.privateState}>
              <div>
                <p>
                  Sign in to view and manage orders created by this wallet. Public
                  orders and wallet-only trading remain available without signing in.
                </p>
                {(makerSessionAttemptFailed || authError) && (
                  <p className={styles.inlineError} role="alert">
                    Sign-in was not completed. Try again when ready; public order
                    placement and fills remain available.
                  </p>
                )}
              </div>
              <Button
                disabled={isEstablishingSession}
                onClick={() => void requestMakerSession()}
                size="small"
                variant="neutral"
              >
                {isEstablishingSession
                  ? 'Check MetaMask…'
                  : 'Sign in to manage orders'}
              </Button>
            </div>
          ) : myOrders.isLoading ? (
            <p className={styles.stateText} role="status">
              Loading your open signed orders…
            </p>
          ) : myOrders.error ? (
            <div className={styles.inlineError} role="alert">
              <p>Your signed orders could not be loaded.</p>
              <Button onClick={myOrders.refetch} size="small" variant="neutral">
                Try again
              </Button>
            </div>
          ) : displayedMyOrders.length === 0 ? (
            <p className={styles.stateText}>
              You have no open signed orders.
            </p>
          ) : (
            <div className={styles.myOrderList}>
              {displayedMyOrders.map((order) => {
                const isWithdrawn = withdrawn.has(order.orderHash);
                return (
                  <article className={styles.myOrder} key={order.orderHash}>
                    <div className={styles.myOrderSummary}>
                      <strong>
                        Market #{order.marketId} · {order.outcome} {order.side}
                      </strong>
                      <span className="numeric">
                        {formatRaw(order.remainingRaw, {
                          minimumFractionDigits: 0,
                          maximumFractionDigits: 6,
                        })}{' '}
                        remaining @ {formatPrice(order.priceRaw, 6)}
                      </span>
                      <span className="numeric">
                        {order.signedOrder.expiration === 0
                          ? formatUtcExpiry(0)
                          : `Expires ${formatUtcExpiry(
                              order.signedOrder.expiration,
                            )}`}
                      </span>
                      {isWithdrawn && <b>Withdrawn from this book</b>}
                    </div>
                    <div className={styles.myOrderActions}>
                      <Button
                        disabled={
                          isWithdrawn || orderActionBusy === order.orderHash
                        }
                        onClick={() => void withdrawOrder(order)}
                        size="small"
                        variant="ghost"
                      >
                        {orderActionBusy === order.orderHash
                          ? 'Withdrawing…'
                          : 'Withdraw · free'}
                      </Button>
                      <Button
                        disabled={wrongNetwork || actionTx.isBusy}
                        onClick={() => {
                          actionTx.reset();
                          setCompletion(null);
                          setCancelTarget(order);
                        }}
                        size="small"
                        variant="neutral"
                      >
                        Cancel on-chain · gas
                      </Button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          {orderActionError && (
            <p className={styles.inlineError} role="alert">
              {orderActionError}
            </p>
          )}
        </section>
      </Card>

      <ConfirmModal
        closeDisabled={actionTx.isBusy}
        closeOnConfirm={false}
        confirmDisabled={
          !canReview ||
          actionTx.isBusy ||
          actionTx.state.phase === 'confirmed'
        }
        confirmLabel={
          actionTx.state.phase === 'confirmed'
            ? 'Order posted'
            : 'Sign & post binding order'
        }
        kicker="Binding signed commitment"
        onClose={() => {
          if (!actionTx.isBusy) setReviewOpen(false);
        }}
        onConfirm={signAndPost}
        open={reviewOpen}
        title="Review before the wallet opens"
      >
        {commitment && (
          <>
            <dl className={styles.confirmRows}>
              <div>
                <dt>Limit price</dt>
                <dd className="numeric">
                  {formatPrice(commitment.priceRaw.toString(), 6)} USDC/token
                </dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd className="numeric">
                  {formatRaw(commitment.sizeRaw.toString(), {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 6,
                  })}{' '}
                  {outcome}
                </dd>
              </div>
              <div>
                <dt>
                  {orderSide === 'BID'
                    ? 'Total collateral'
                    : 'Estimated proceeds'}
                </dt>
                <dd className="numeric">
                  {formatUsdc(commitment.collateralRaw.toString(), 6)} USDC
                </dd>
              </div>
              <div>
                <dt>Expiry</dt>
                <dd className="numeric">
                  {formatUtcExpiry(commitment.expiration)}
                </dd>
              </div>
            </dl>
            <p className={styles.commitmentWarning}>
              A signed order can be filled by anyone until it expires or is cancelled
              on-chain. This is a binding commitment, not a draft.
            </p>
          </>
        )}
        {completion && (
          <p className={styles.completion} role="status">
            {completion}
          </p>
        )}
        <TxStatus state={actionTx.state} />
      </ConfirmModal>

      <ConfirmModal
        closeDisabled={actionTx.isBusy}
        closeOnConfirm={false}
        confirmDisabled={
          !validFill ||
          fillIsOwnOrder ||
          fillRequirement?.ready !== true ||
          !isConnected ||
          !address ||
          wrongNetwork ||
          actionTx.isBusy ||
          actionTx.state.phase === 'confirmed'
        }
        confirmLabel={
          actionTx.state.phase === 'confirmed' ? 'Filled' : 'Fill on-chain'
        }
        kicker="On-chain taker fill"
        onClose={() => {
          if (!actionTx.isBusy) setFillTarget(null);
        }}
        onConfirm={fillOrder}
        open={fillTarget !== null}
        title="Fill this signed order"
      >
        {fillTarget && (
          <>
            <label className={styles.modalField}>
              <span>Fill size</span>
              <span className={styles.input}>
                <input
                  aria-invalid={!validFill}
                  inputMode="decimal"
                  onChange={(event) => setFillSize(event.target.value)}
                  value={fillSize}
                />
                <b>{fillTarget.outcome}</b>
              </span>
            </label>
            <dl className={styles.confirmRows}>
              <div>
                <dt>Maker side</dt>
                <dd>{fillTarget.side}</dd>
              </div>
              <div>
                <dt>Limit price</dt>
                <dd className="numeric">
                  {formatPrice(fillTarget.priceRaw, 6)} USDC/token
                </dd>
              </div>
              <div>
                <dt>Total collateral</dt>
                <dd className="numeric">
                  {fillCollateralRaw === null
                    ? '—'
                    : `${formatUsdc(fillCollateralRaw.toString(), 6)} USDC`}
                </dd>
              </div>
            </dl>
            {approvals.isLoading ? (
              <p className={styles.stateText} role="status">
                Reading indexed taker approvals before any prompt…
              </p>
            ) : approvals.error || !effectiveApprovals ? (
              <p className={styles.inlineError} role="alert">
                Taker approval state is unavailable, so filling stays disabled.
              </p>
            ) : fillRequirement && !fillRequirement.ready ? (
              <div className={styles.fillApproval}>
                <strong>One approval is missing</strong>
                <ApprovalExplanation requirement={fillRequirement} />
                {fillRequirement.kind === 'COLLATERAL' ? (
                  <Button
                    disabled={approvalTx.isBusy || wrongNetwork}
                    onClick={() =>
                      void approveCollateral(fillRequirement.amountRaw)
                    }
                    size="small"
                    variant="neutral"
                  >
                    Approve exactly{' '}
                    <span className="numeric">
                      {formatUsdc(fillRequirement.amountRaw.toString(), 6)}
                    </span>{' '}
                    USDC to fill
                  </Button>
                ) : (
                  <Button
                    disabled={approvalTx.isBusy || wrongNetwork}
                    onClick={() => void approveTokens()}
                    size="small"
                    variant="neutral"
                  >
                    Approve position transfers to fill
                  </Button>
                )}
              </div>
            ) : fillRequirement ? (
              <p className={styles.approvalReady}>Required taker approval is ready.</p>
            ) : null}
            <TxStatus state={approvalTx.state} />
          </>
        )}
        {completion && (
          <p className={styles.completion} role="status">
            {completion}
          </p>
        )}
        <TxStatus state={actionTx.state} />
      </ConfirmModal>

      <ConfirmModal
        closeDisabled={actionTx.isBusy}
        closeOnConfirm={false}
        confirmDisabled={
          !cancelTarget ||
          !isConnected ||
          !address ||
          !authenticated ||
          !isConnectedWalletMaker(cancelTarget.maker, address) ||
          wrongNetwork ||
          actionTx.isBusy ||
          actionTx.state.phase === 'confirmed'
        }
        confirmLabel={
          actionTx.state.phase === 'confirmed'
            ? 'Cancelled on-chain'
            : cancelTarget && withdrawn.has(cancelTarget.orderHash)
              ? 'Cancel on-chain'
              : 'Withdraw, then cancel on-chain'
        }
        kicker="Authoritative cancellation · costs gas"
        onClose={() => {
          if (!actionTx.isBusy) setCancelTarget(null);
        }}
        onConfirm={cancelOrderOnchain}
        open={cancelTarget !== null}
        title="Cancel this signature on-chain"
      >
        {cancelTarget && (
          <>
            <p>
              This first withdraws the order from our book if needed, then submits the
              exact <code>cancelOrder</code> calldata returned by the API. Your wallet
              pays gas for the authoritative cancellation.
            </p>
            <p className={styles.commitmentWarning}>
              If you reject or the transaction fails after withdrawal, the order is
              hidden here but its signature can still be valid on-chain until expiry.
            </p>
            <dl className={styles.confirmRows}>
              <div>
                <dt>Remaining size</dt>
                <dd className="numeric">
                  {formatRaw(cancelTarget.remainingRaw, {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 6,
                  })}{' '}
                  {cancelTarget.outcome}
                </dd>
              </div>
              <div>
                <dt>Expiry</dt>
                <dd className="numeric">
                  {formatUtcExpiry(cancelTarget.signedOrder.expiration)}
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
        <TxStatus state={actionTx.state} />
      </ConfirmModal>
    </>
  );
}
