import {
  cumulativeMiniClobPaymentRaw,
  ctfExchangeCollateralAmountForFill,
  ctfExchangeOrderAmounts,
  ctfExchangeOrderFromWire,
  Side,
} from '@predex-pump/shared/tx';
import type {
  AccountResponse,
  Address,
  LiveBookVenue,
  ListMarketsQuery,
  ListMarketsResponse,
  MakerOrdersResponse,
  Market,
  MarketBookResponse,
  OffchainOrder,
  Order,
  OrderBook,
  OrderIngestRejectionCode,
  TruthSignalResponse,
  WithdrawOrderResponse,
} from '@predex-pump/shared';
import {
  fillSizePreservingRepresentableRemainder,
  floorOrderSizeToGranularity,
  quantizePriceRaw,
} from '@predex-pump/shared';

import type { TraderLogger } from './logger.js';

const PRICE_SCALE = 1_000_000n;

export interface TraderDataClient {
  listMarkets(query?: ListMarketsQuery): Promise<ListMarketsResponse>;
  getAccount(address: string): Promise<AccountResponse>;
  getOrderBook(marketId: string): Promise<MarketBookResponse>;
}

export interface TruthSignalReadInput {
  marketId: string;
  /** Remaining unified session-spend capacity; paid readers must enforce it before signing. */
  maxPaymentRaw: bigint;
}

export interface TruthSignalReadResult {
  signal: TruthSignalResponse;
  /** Actual USDC paid for this read; zero for the unpaid Stage 1 endpoint. */
  paymentSpendRaw: bigint;
}

export type TruthSignalReader = (
  input: TruthSignalReadInput,
) => Promise<TruthSignalReadResult>;

export interface PlaceOrderAction {
  marketId: string;
  conditionId: `0x${string}`;
  tokenId: string;
  outcome: 'YES' | 'NO';
  side: 'BID' | 'ASK';
  priceRaw: bigint;
  sizeRaw: bigint;
  minimumTickSizeRaw: bigint;
}

export interface FillOrderAction {
  marketId: string;
  conditionId: `0x${string}`;
  tokenId: string;
  outcome: 'YES' | 'NO';
  restingSide: 'BID' | 'ASK';
  orderId: string;
  expectedPriceRaw: bigint;
  fillSizeRaw: bigint;
}

export interface CancelOrderAction {
  orderId: string;
}

export interface HybridPlaceOrderAction extends PlaceOrderAction {
  complementTokenId: string;
}

export interface HybridFillOrderAction
  extends Omit<FillOrderAction, 'orderId'> {
  complementTokenId: string;
  order: OffchainOrder;
}

export interface HybridWithdrawOrderAction {
  order: OffchainOrder;
}

export interface HybridCancelOrderAction {
  order: OffchainOrder;
}

export interface HybridPlaceOrderRejection {
  code: OrderIngestRejectionCode;
  classification: 'permanent' | 'retryable';
  reason: string;
}

export interface HybridPlaceOrderResult {
  orderHash: `0x${string}`;
  rejections: HybridPlaceOrderRejection[];
}

export interface TraderExecutor {
  placeOrder(
    action: PlaceOrderAction,
  ): Promise<{ txHash: `0x${string}`; orderId: string }>;
  fillOrder(action: FillOrderAction): Promise<{ txHash: `0x${string}` }>;
  cancelOrder(action: CancelOrderAction): Promise<{ txHash: `0x${string}` }>;
}

export interface HybridTraderExecutor {
  getMakerOrders(): Promise<MakerOrdersResponse>;
  placeOrder(action: HybridPlaceOrderAction): Promise<HybridPlaceOrderResult>;
  fillOrder(
    action: HybridFillOrderAction,
  ): Promise<{ txHash: `0x${string}` }>;
  withdrawOrder(
    action: HybridWithdrawOrderAction,
  ): Promise<WithdrawOrderResponse>;
  cancelOrder(
    action: HybridCancelOrderAction,
  ): Promise<{ txHash: `0x${string}` }>;
}

/** A tx hash exists, but the RPC could not prove whether the intended action settled. */
export class BroadcastUncertainError extends Error {
  constructor(
    readonly txHash: `0x${string}`,
    readonly actionMayHaveCommitted: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'BroadcastUncertainError';
  }
}

export interface TraderAgentOptions {
  dataClient: TraderDataClient;
  readSignal: TruthSignalReader;
  executor?: TraderExecutor;
  hybridExecutor?: HybridTraderExecutor;
  logger: TraderLogger;
  traderAddress: Address;
  quoteSizeRaw: bigint;
  takeSizeRaw: bigint;
  quoteHalfSpreadRaw: bigint;
  takeThresholdRaw: bigint;
  repriceThresholdRaw: bigint;
  staleQuoteSeconds: number;
  maxInventoryPerSideRaw: bigint;
  maxNotionalPerOrderRaw: bigint;
  maxOrdersInFlight: number;
  maxSessionSpendRaw: bigint;
  dryRun: boolean;
  nowSeconds?: () => number;
}

interface CycleRisk {
  spendRaw: bigint;
  inFlight: number;
  orderSnapshotComplete: boolean;
}

interface InventoryState {
  availableYesRaw: bigint;
  projectedYesRaw: bigint;
}

interface Snapshot {
  market: Market;
  book: MarketBookResponse;
}

interface DecisionOrder {
  venue: LiveBookVenue;
  orderId: string;
  marketId: string;
  conditionId: string;
  tokenId: string;
  outcome: 'YES' | 'NO';
  maker: Address;
  side: 'BID' | 'ASK';
  priceRaw: string;
  sizeRaw: string;
  filledRaw: string;
  remainingRaw: string;
  createdAt: number;
  updatedAt: number;
  source: Order | OffchainOrder;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function miniClobDecisionOrder(order: Order): DecisionOrder {
  return {
    venue: 'MINICLOB',
    orderId: order.orderId,
    marketId: order.marketId,
    conditionId: order.conditionId,
    tokenId: order.tokenId,
    outcome: order.outcome,
    maker: order.maker,
    side: order.side,
    priceRaw: order.priceRaw,
    sizeRaw: order.sizeRaw,
    filledRaw: order.filledRaw,
    remainingRaw: order.remainingRaw,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    source: order,
  };
}

function hybridDecisionOrder(order: OffchainOrder): DecisionOrder {
  return {
    venue: 'HYBRID',
    orderId: order.orderHash,
    marketId: order.marketId,
    conditionId: order.conditionId,
    tokenId: order.tokenId,
    outcome: order.outcome,
    maker: order.maker,
    side: order.side,
    priceRaw: order.priceRaw,
    sizeRaw: order.sizeRaw,
    filledRaw: order.filledRaw,
    remainingRaw: order.remainingRaw,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    source: order,
  };
}

function isActiveHybridOrder(order: OffchainOrder): boolean {
  return (
    (order.status === 'OPEN' || order.status === 'PARTIALLY_FILLED') &&
    BigInt(order.remainingRaw) > 0n
  );
}

function venueOrders(
  book: OrderBook,
  venue: LiveBookVenue,
): DecisionOrder[] {
  if (venue === 'MINICLOB') {
    return book.orders
      .filter((order) => order.open)
      .map(miniClobDecisionOrder);
  }
  return book.offchainOrders
    .filter((order) => order.fillable && isActiveHybridOrder(order))
    .map(hybridDecisionOrder);
}

function bestExternalOrder(
  orders: readonly DecisionOrder[],
  side: 'BID' | 'ASK',
  traderAddress: string,
): DecisionOrder | undefined {
  return orders
    .filter(
      (order) =>
        order.side === side &&
        !sameAddress(order.maker, traderAddress),
    )
    .sort((left, right) => {
      const leftPrice = BigInt(left.priceRaw);
      const rightPrice = BigInt(right.priceRaw);
      if (leftPrice === rightPrice) {
        return left.createdAt - right.createdAt ||
          left.orderId.localeCompare(right.orderId);
      }
      if (side === 'BID') return leftPrice > rightPrice ? -1 : 1;
      return leftPrice < rightPrice ? -1 : 1;
    })[0];
}

function hybridSource(order: DecisionOrder): OffchainOrder {
  if (order.venue !== 'HYBRID' || 'orderId' in order.source) {
    throw new Error('Expected a Hybrid off-chain order.');
  }
  return order.source;
}

function fillNotionalRaw(order: DecisionOrder, fillSizeRaw: bigint): bigint {
  if (order.venue === 'MINICLOB') {
    return cumulativeMiniClobPaymentRaw(BigInt(order.priceRaw), fillSizeRaw);
  }
  return ctfExchangeCollateralAmountForFill(
    ctfExchangeOrderFromWire(hybridSource(order).signedOrder),
    fillSizeRaw,
  );
}

function placementNotionalRaw(
  venue: LiveBookVenue,
  side: 'BID' | 'ASK',
  priceRaw: bigint,
  sizeRaw: bigint,
): bigint {
  if (venue === 'MINICLOB') {
    return cumulativeMiniClobPaymentRaw(priceRaw, sizeRaw);
  }
  const exchangeSide = side === 'BID' ? Side.BUY : Side.SELL;
  const amounts = ctfExchangeOrderAmounts({
    side: exchangeSide,
    priceRaw,
    sizeRaw,
  });
  return exchangeSide === Side.BUY
    ? amounts.makerAmount
    : amounts.takerAmount;
}

export class TraderAgent {
  private sessionSpendRaw = 0n;
  private readonly sessionPotentialYesIncreaseRaw = new Map<string, bigint>();
  private readonly pendingPlacedOrderIds = new Set<string>();
  private readonly confirmedClosedOrderIds = new Set<string>();
  private readonly quoteSizeRaw: bigint;
  private readonly takeSizeRaw: bigint;

  constructor(private readonly options: TraderAgentOptions) {
    if (!options.dryRun && options.executor === undefined) {
      throw new Error('A trader executor is required when dry-run is disabled.');
    }
    this.quoteSizeRaw = floorOrderSizeToGranularity(options.quoteSizeRaw);
    this.takeSizeRaw = floorOrderSizeToGranularity(options.takeSizeRaw);
    if (this.quoteSizeRaw === 0n || this.takeSizeRaw === 0n) {
      throw new Error('Trader quote and take sizes must reach the 1000-raw size quantum.');
    }
  }

  getSessionSpendRaw(): bigint {
    return this.sessionSpendRaw;
  }

  private async listMarketsForOrderSnapshot(): Promise<Market[]> {
    const markets: Market[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const page = await this.options.dataClient.listMarkets({
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      markets.push(...page.items);
      if (page.nextCursor === null) return markets;
      if (seenCursors.has(page.nextCursor)) {
        throw new Error('market pagination returned a repeated cursor');
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    } while (true);
  }

  private capRefusal(notionalRaw: bigint, risk: CycleRisk): string | null {
    if (notionalRaw > this.options.maxNotionalPerOrderRaw) {
      return (
        `max-notional-per-order cap: requested ${notionalRaw}, ` +
        `limit ${this.options.maxNotionalPerOrderRaw}`
      );
    }
    if (risk.spendRaw + notionalRaw > this.options.maxSessionSpendRaw) {
      return (
        `max-total-session-spend cap: spent/planned ${risk.spendRaw}, ` +
        `requested ${notionalRaw}, limit ${this.options.maxSessionSpendRaw}`
      );
    }
    return null;
  }

  private refuse(
    marketId: string,
    action: 'PLACE' | 'FILL' | 'CANCEL' | 'HOLD',
    reason: string,
    fields: {
      venue?: LiveBookVenue;
      side?: 'BID' | 'ASK';
      orderId?: string;
      fairValueYesRaw?: string;
      priceRaw?: string;
      sizeRaw?: string;
      notionalRaw?: string;
    } = {},
  ): void {
    this.options.logger.write({
      level: 'warn',
      event: 'refused',
      marketId,
      action,
      reason,
      ...fields,
      message: `decision → refused(${reason}) → continuing`,
    });
  }

  private async executeCancel(
    marketId: string,
    order: DecisionOrder,
    risk: CycleRisk,
    inventory: InventoryState,
  ): Promise<boolean> {
    if (this.options.dryRun) {
      this.options.logger.write({
        level: 'info',
        event: 'dry-run',
        marketId,
        action: 'CANCEL',
        side: order.side,
        outcome: order.outcome,
        orderId: order.orderId,
        venue: order.venue,
        message:
          order.venue === 'MINICLOB'
            ? 'stale quote → would cancel → no broadcast'
            : 'stale quote → would withdraw free from the operator book, then submit authoritative per-order cancelOrder with gas → no broadcast',
      });
    } else if (order.venue === 'MINICLOB') {
      try {
        const result = await this.options.executor?.cancelOrder({
          orderId: order.orderId,
        });
        if (result === undefined) throw new Error('trader executor was unavailable');
        this.confirmedClosedOrderIds.add(order.orderId);
        this.options.logger.write({
          level: 'info',
          event: 'broadcast',
          marketId,
          action: 'CANCEL',
          side: order.side,
          outcome: order.outcome,
          orderId: order.orderId,
          venue: order.venue,
          txHash: result.txHash,
          message: 'stale quote → cancelled on Arc',
        });
      } catch (error) {
        this.options.logger.write({
          level: 'error',
          event: 'action-error',
          marketId,
          action: 'CANCEL',
          orderId: order.orderId,
          venue: order.venue,
          message: `cancel → rpc/on-chain error(${errorMessage(error)}) → continuing`,
        });
        return false;
      }
    } else {
      const hybrid = this.options.hybridExecutor;
      if (hybrid === undefined) {
        this.options.logger.write({
          level: 'error',
          event: 'action-error',
          marketId,
          action: 'CANCEL',
          orderId: order.orderId,
          venue: order.venue,
          message: 'Hybrid retire → executor unavailable → continuing',
        });
        risk.orderSnapshotComplete = false;
        return false;
      }
      const source = hybridSource(order);
      let withdrawn = false;
      try {
        const response = await hybrid.withdrawOrder({ order: source });
        withdrawn = true;
        this.options.logger.write({
          level: 'info',
          event: 'withdrawal',
          marketId,
          action: 'CANCEL',
          side: order.side,
          outcome: order.outcome,
          orderId: order.orderId,
          venue: order.venue,
          message:
            'stale quote → withdrawn instantly and free from this operator book; the signature is still valid on-chain until expiry or per-order cancelOrder',
        });
        if (
          response.offchainWithdrawalIsOnchainCancellation !== false ||
          response.signedOrderMayRemainValidOnchain !== true
        ) {
          throw new Error('operator misstated withdrawal cancellation semantics');
        }
      } catch (error) {
        this.options.logger.write({
          level: 'error',
          event: 'action-error',
          marketId,
          action: 'CANCEL',
          orderId: order.orderId,
          venue: order.venue,
          message:
            `off-chain withdraw → error(${errorMessage(error)}) → ` +
            'attempting authoritative per-order cancelOrder anyway',
        });
      }

      try {
        const result = await hybrid.cancelOrder({ order: source });
        this.confirmedClosedOrderIds.add(order.orderId);
        this.options.logger.write({
          level: 'info',
          event: 'broadcast',
          marketId,
          action: 'CANCEL',
          side: order.side,
          outcome: order.outcome,
          orderId: order.orderId,
          venue: order.venue,
          txHash: result.txHash,
          message:
            'stale quote → authoritative per-order CTFExchange.cancelOrder confirmed on Arc (costs gas; cancelAll was not used)',
        });
      } catch (error) {
        this.options.logger.write({
          level: 'error',
          event: 'action-error',
          marketId,
          action: 'CANCEL',
          orderId: order.orderId,
          venue: order.venue,
          message:
            `on-chain cancelOrder → error(${errorMessage(error)}) → ` +
            (withdrawn
              ? 'operator liquidity is withdrawn but the signature may remain valid until expiry → replacement refused this cycle'
              : 'signature may remain in the operator book and valid on-chain → continuing'),
        });
        risk.orderSnapshotComplete = false;
        return false;
      }
    }
    risk.inFlight = Math.max(0, risk.inFlight - 1);
    if (order.outcome === 'YES' && order.side === 'BID') {
      inventory.projectedYesRaw -= BigInt(order.remainingRaw);
    }
    if (order.outcome === 'YES' && order.side === 'ASK') {
      inventory.availableYesRaw += BigInt(order.remainingRaw);
    }
    return true;
  }

  private async executeFill(
    snapshot: Snapshot,
    order: DecisionOrder,
    fillSizeRaw: bigint,
    fairValueYesRaw: bigint,
    risk: CycleRisk,
    inventory: InventoryState,
  ): Promise<boolean> {
    if (fillSizeRaw <= 0n) {
      this.refuse(
        snapshot.market.id,
        'FILL',
        'no fill at or below the configured take size can leave a representable remainder',
        { side: order.side, orderId: order.orderId },
      );
      return false;
    }
    if (BigInt(order.remainingRaw) < fillSizeRaw) {
      this.refuse(
        snapshot.market.id,
        'FILL',
        `configured take size ${fillSizeRaw} exceeds remaining ${order.remainingRaw}; exact size required`,
        {
          side: order.side,
          orderId: order.orderId,
          fairValueYesRaw: fairValueYesRaw.toString(),
          priceRaw: order.priceRaw,
          sizeRaw: fillSizeRaw.toString(),
        },
      );
      return false;
    }

    if (order.side === 'ASK') {
      const after = inventory.projectedYesRaw + fillSizeRaw;
      if (after > this.options.maxInventoryPerSideRaw) {
        this.refuse(
          snapshot.market.id,
          'FILL',
          `max-inventory-per-side cap: projected YES ${after}, limit ${this.options.maxInventoryPerSideRaw}`,
          {
            side: order.side,
            orderId: order.orderId,
            fairValueYesRaw: fairValueYesRaw.toString(),
            priceRaw: order.priceRaw,
            sizeRaw: fillSizeRaw.toString(),
          },
        );
        return false;
      }
    } else if (inventory.availableYesRaw < fillSizeRaw) {
      this.refuse(
        snapshot.market.id,
        'FILL',
        `available YES inventory ${inventory.availableYesRaw} is below exact take size ${fillSizeRaw}`,
        {
          side: order.side,
          orderId: order.orderId,
          fairValueYesRaw: fairValueYesRaw.toString(),
          priceRaw: order.priceRaw,
          sizeRaw: fillSizeRaw.toString(),
        },
      );
      return false;
    }

    const notionalRaw = fillNotionalRaw(order, fillSizeRaw);
    const capRefusal = this.capRefusal(notionalRaw, risk);
    if (capRefusal !== null) {
      this.refuse(snapshot.market.id, 'FILL', capRefusal, {
        side: order.side,
        orderId: order.orderId,
        venue: order.venue,
        fairValueYesRaw: fairValueYesRaw.toString(),
        priceRaw: order.priceRaw,
        sizeRaw: fillSizeRaw.toString(),
        notionalRaw: notionalRaw.toString(),
      });
      return false;
    }

    if (this.options.dryRun) {
      this.options.logger.write({
        level: 'info',
        event: 'dry-run',
        marketId: snapshot.market.id,
        action: 'FILL',
        outcome: 'YES',
        side: order.side,
        orderId: order.orderId,
        venue: order.venue,
        fairValueYesRaw: fairValueYesRaw.toString(),
        priceRaw: order.priceRaw,
        sizeRaw: fillSizeRaw.toString(),
        notionalRaw: notionalRaw.toString(),
        sessionSpendRaw: (risk.spendRaw + notionalRaw).toString(),
        message: 'mispriced resting order → would fill exact configured size → no broadcast',
      });
    } else {
      try {
        const result =
          order.venue === 'MINICLOB'
            ? await this.options.executor?.fillOrder({
                marketId: snapshot.market.id,
                conditionId: snapshot.market.conditionId as `0x${string}`,
                tokenId: snapshot.market.yesTokenId,
                outcome: 'YES',
                restingSide: order.side,
                orderId: order.orderId,
                expectedPriceRaw: BigInt(order.priceRaw),
                fillSizeRaw,
              })
            : await this.options.hybridExecutor?.fillOrder({
                marketId: snapshot.market.id,
                conditionId: snapshot.market.conditionId as `0x${string}`,
                tokenId: snapshot.market.yesTokenId,
                complementTokenId: snapshot.market.noTokenId,
                outcome: 'YES',
                restingSide: order.side,
                order: hybridSource(order),
                expectedPriceRaw: BigInt(order.priceRaw),
                fillSizeRaw,
              });
        if (result === undefined) {
          throw new Error(`${order.venue} trader executor was unavailable`);
        }
        this.options.logger.write({
          level: 'info',
          event: 'broadcast',
          marketId: snapshot.market.id,
          action: 'FILL',
          outcome: 'YES',
          side: order.side,
          orderId: order.orderId,
          venue: order.venue,
          fairValueYesRaw: fairValueYesRaw.toString(),
          priceRaw: order.priceRaw,
          sizeRaw: fillSizeRaw.toString(),
          notionalRaw: notionalRaw.toString(),
          sessionSpendRaw: (risk.spendRaw + notionalRaw).toString(),
          txHash: result.txHash,
          message:
            order.venue === 'MINICLOB'
              ? 'mispriced resting order → filled on Arc'
              : 'mispriced resting signed order → CTFExchange fillOrder confirmed on Arc',
        });
      } catch (error) {
        if (
          error instanceof BroadcastUncertainError &&
          error.actionMayHaveCommitted
        ) {
          this.options.logger.write({
            level: 'error',
            event: 'action-error',
            marketId: snapshot.market.id,
            action: 'FILL',
            orderId: order.orderId,
            venue: order.venue,
            txHash: error.txHash,
            message:
              `fill → receipt unavailable(${errorMessage(error)}) → ` +
              'reserving inventory/spend caps conservatively → continuing',
          });
        } else {
          this.options.logger.write({
            level: 'error',
            event: 'action-error',
            marketId: snapshot.market.id,
            action: 'FILL',
            orderId: order.orderId,
            venue: order.venue,
            message: `fill → rpc/on-chain error(${errorMessage(error)}) → continuing`,
          });
          return false;
        }
      }
    }

    risk.spendRaw += notionalRaw;
    if (order.side === 'ASK') {
      inventory.availableYesRaw += fillSizeRaw;
      inventory.projectedYesRaw += fillSizeRaw;
      if (!this.options.dryRun) {
        this.sessionPotentialYesIncreaseRaw.set(
          snapshot.market.id,
          (this.sessionPotentialYesIncreaseRaw.get(snapshot.market.id) ?? 0n) +
            fillSizeRaw,
        );
      }
    } else {
      inventory.availableYesRaw -= fillSizeRaw;
      inventory.projectedYesRaw -= fillSizeRaw;
    }
    return true;
  }

  private async executePlace(
    snapshot: Snapshot,
    side: 'BID' | 'ASK',
    priceRaw: bigint,
    fairValueYesRaw: bigint,
    risk: CycleRisk,
    inventory: InventoryState,
  ): Promise<boolean> {
    if (!risk.orderSnapshotComplete) {
      this.refuse(
        snapshot.market.id,
        'PLACE',
        'max-orders-in-flight cap cannot be verified because at least one order snapshot read failed',
        {
          venue: snapshot.book.liveVenue,
          side,
          fairValueYesRaw: fairValueYesRaw.toString(),
          priceRaw: priceRaw.toString(),
          sizeRaw: this.quoteSizeRaw.toString(),
        },
      );
      return false;
    }
    if (risk.inFlight + 1 > this.options.maxOrdersInFlight) {
      this.refuse(
        snapshot.market.id,
        'PLACE',
        `max-orders-in-flight cap: current/planned ${risk.inFlight}, requested 1, limit ${this.options.maxOrdersInFlight}`,
        {
          venue: snapshot.book.liveVenue,
          side,
          fairValueYesRaw: fairValueYesRaw.toString(),
          priceRaw: priceRaw.toString(),
          sizeRaw: this.quoteSizeRaw.toString(),
        },
      );
      return false;
    }
    if (side === 'BID') {
      const after = inventory.projectedYesRaw + this.quoteSizeRaw;
      if (after > this.options.maxInventoryPerSideRaw) {
        this.refuse(
          snapshot.market.id,
          'PLACE',
          `max-inventory-per-side cap: projected YES ${after}, limit ${this.options.maxInventoryPerSideRaw}`,
          {
            venue: snapshot.book.liveVenue,
            side,
            fairValueYesRaw: fairValueYesRaw.toString(),
            priceRaw: priceRaw.toString(),
            sizeRaw: this.quoteSizeRaw.toString(),
          },
        );
        return false;
      }
    } else if (inventory.availableYesRaw < this.quoteSizeRaw) {
      this.refuse(
        snapshot.market.id,
        'PLACE',
        `available YES inventory ${inventory.availableYesRaw} is below exact quote size ${this.quoteSizeRaw}`,
        {
          venue: snapshot.book.liveVenue,
          side,
          fairValueYesRaw: fairValueYesRaw.toString(),
          priceRaw: priceRaw.toString(),
          sizeRaw: this.quoteSizeRaw.toString(),
        },
      );
      return false;
    }

    const notionalRaw = placementNotionalRaw(
      snapshot.book.liveVenue,
      side,
      priceRaw,
      this.quoteSizeRaw,
    );
    const capRefusal = this.capRefusal(notionalRaw, risk);
    if (capRefusal !== null) {
      this.refuse(snapshot.market.id, 'PLACE', capRefusal, {
        venue: snapshot.book.liveVenue,
        side,
        fairValueYesRaw: fairValueYesRaw.toString(),
        priceRaw: priceRaw.toString(),
        sizeRaw: this.quoteSizeRaw.toString(),
        notionalRaw: notionalRaw.toString(),
      });
      return false;
    }

    if (this.options.dryRun) {
      this.options.logger.write({
        level: 'info',
        event: 'dry-run',
        marketId: snapshot.market.id,
        action: 'PLACE',
        outcome: 'YES',
        side,
        fairValueYesRaw: fairValueYesRaw.toString(),
        priceRaw: priceRaw.toString(),
        sizeRaw: this.quoteSizeRaw.toString(),
        notionalRaw: notionalRaw.toString(),
        sessionSpendRaw: (risk.spendRaw + notionalRaw).toString(),
        message: 'fair value → quote exact configured size → no broadcast',
      });
    } else {
      try {
        if (snapshot.book.liveVenue === 'MINICLOB') {
          const result = await this.options.executor?.placeOrder({
            marketId: snapshot.market.id,
            conditionId: snapshot.market.conditionId as `0x${string}`,
            tokenId: snapshot.market.yesTokenId,
            outcome: 'YES',
            side,
            priceRaw,
            sizeRaw: this.quoteSizeRaw,
            minimumTickSizeRaw: BigInt(snapshot.book.minimumTickSizeRaw),
          });
          if (result === undefined) {
            throw new Error('MINICLOB trader executor was unavailable');
          }
          this.pendingPlacedOrderIds.add(result.orderId);
          this.options.logger.write({
            level: 'info',
            event: 'broadcast',
            marketId: snapshot.market.id,
            action: 'PLACE',
            outcome: 'YES',
            side,
            venue: snapshot.book.liveVenue,
            orderId: result.orderId,
            fairValueYesRaw: fairValueYesRaw.toString(),
            priceRaw: priceRaw.toString(),
            sizeRaw: this.quoteSizeRaw.toString(),
            notionalRaw: notionalRaw.toString(),
            sessionSpendRaw: (risk.spendRaw + notionalRaw).toString(),
            txHash: result.txHash,
            message: 'fair value → quote placed on Arc',
          });
        } else {
          const result = await this.options.hybridExecutor?.placeOrder({
            marketId: snapshot.market.id,
            conditionId: snapshot.market.conditionId as `0x${string}`,
            tokenId: snapshot.market.yesTokenId,
            complementTokenId: snapshot.market.noTokenId,
            outcome: 'YES',
            side,
            priceRaw,
            sizeRaw: this.quoteSizeRaw,
            minimumTickSizeRaw: BigInt(snapshot.book.minimumTickSizeRaw),
          });
          if (result === undefined) {
            throw new Error('HYBRID trader executor was unavailable');
          }
          for (const rejection of result.rejections) {
            this.options.logger.write({
              level: 'warn',
              event: 'order-rejected',
              marketId: snapshot.market.id,
              action: 'PLACE',
              outcome: 'YES',
              side,
              venue: snapshot.book.liveVenue,
              rejectionCode: rejection.code,
              reason: rejection.reason,
              message:
                `Hybrid ingest rejected ${rejection.code} (${rejection.classification}): ` +
                `${rejection.reason} → rebuilt once from fresh state`,
            });
          }
          this.pendingPlacedOrderIds.add(result.orderHash);
          this.options.logger.write({
            level: 'info',
            event: 'order-posted',
            marketId: snapshot.market.id,
            action: 'PLACE',
            outcome: 'YES',
            side,
            venue: snapshot.book.liveVenue,
            orderId: result.orderHash,
            fairValueYesRaw: fairValueYesRaw.toString(),
            priceRaw: priceRaw.toString(),
            sizeRaw: this.quoteSizeRaw.toString(),
            notionalRaw: notionalRaw.toString(),
            sessionSpendRaw: (risk.spendRaw + notionalRaw).toString(),
            message:
              'fair value → P1 EIP-712 order signed with fresh makerNonce → accepted by Hybrid operator (no placement transaction)',
          });
        }
      } catch (error) {
        if (
          error instanceof BroadcastUncertainError &&
          error.actionMayHaveCommitted
        ) {
          this.pendingPlacedOrderIds.add(`unconfirmed:${error.txHash}`);
          this.options.logger.write({
            level: 'error',
            event: 'action-error',
            marketId: snapshot.market.id,
            action: 'PLACE',
            side,
            venue: snapshot.book.liveVenue,
            txHash: error.txHash,
            message:
              `place → receipt unavailable(${errorMessage(error)}) → ` +
              'reserving order/inventory/spend caps conservatively → continuing',
          });
        } else {
          this.options.logger.write({
            level: 'error',
            event: 'action-error',
            marketId: snapshot.market.id,
            action: 'PLACE',
            side,
            venue: snapshot.book.liveVenue,
            message:
              `${snapshot.book.liveVenue} place → error(${errorMessage(error)}) → continuing`,
          });
          return false;
        }
      }
    }

    risk.spendRaw += notionalRaw;
    risk.inFlight += 1;
    if (side === 'BID') inventory.projectedYesRaw += this.quoteSizeRaw;
    else inventory.availableYesRaw -= this.quoteSizeRaw;
    if (side === 'BID' && !this.options.dryRun) {
      this.sessionPotentialYesIncreaseRaw.set(
        snapshot.market.id,
        (this.sessionPotentialYesIncreaseRaw.get(snapshot.market.id) ?? 0n) +
          this.quoteSizeRaw,
      );
    }
    return true;
  }

  async runCycle(): Promise<void> {
    let markets: Market[];
    let account: AccountResponse;
    try {
      [markets, account] = await Promise.all([
        this.listMarketsForOrderSnapshot(),
        this.options.dataClient.getAccount(this.options.traderAddress),
      ]);
    } catch (error) {
      this.options.logger.write({
        level: 'error',
        event: 'backend-error',
        message: `market/account read → error(${errorMessage(error)}) → cycle skipped → continuing`,
      });
      return;
    }

    const snapshotResults = await Promise.all(
      markets.map(async (market) => {
        try {
          return {
            market,
            book: await this.options.dataClient.getOrderBook(market.id),
          } satisfies Snapshot;
        } catch (error) {
          this.options.logger.write({
            level: 'error',
            event: 'backend-error',
            marketId: market.id,
            message: `book read → error(${errorMessage(error)}) → market skipped → continuing`,
          });
          return null;
        }
      }),
    );
    const snapshots = snapshotResults.filter(
      (snapshot): snapshot is Snapshot => snapshot !== null,
    );
    const ownOrdersFromBooks = snapshots.flatMap(({ book }) =>
      [
        ...venueOrders(book.yes, book.liveVenue),
        ...venueOrders(book.no, book.liveVenue),
      ].filter((order) =>
        sameAddress(order.maker, this.options.traderAddress),
      ),
    );
    let orderSnapshotComplete = snapshots.length === markets.length;
    let openOwnOrders = ownOrdersFromBooks;
    const hasHybridMarket = snapshots.some(
      ({ book }) => book.liveVenue === 'HYBRID',
    );
    if (hasHybridMarket && !this.options.dryRun) {
      if (this.options.hybridExecutor === undefined) {
        orderSnapshotComplete = false;
        this.options.logger.write({
          level: 'error',
          event: 'backend-error',
          venue: 'HYBRID',
          message:
            'authenticated Hybrid maker-order snapshot → executor unavailable → placement cap fails closed',
        });
      } else {
        try {
          const response = await this.options.hybridExecutor.getMakerOrders();
          const authenticatedHybridOrders = response.orders
            .filter(
              (order) =>
                isActiveHybridOrder(order) &&
                sameAddress(order.maker, this.options.traderAddress),
            )
            .map(hybridDecisionOrder);
          openOwnOrders = [
            ...ownOrdersFromBooks.filter(({ venue }) => venue === 'MINICLOB'),
            ...authenticatedHybridOrders,
          ];
        } catch (error) {
          orderSnapshotComplete = false;
          this.options.logger.write({
            level: 'error',
            event: 'backend-error',
            venue: 'HYBRID',
            message:
              `authenticated Hybrid maker-order read → error(${errorMessage(error)}) → ` +
              'placement cap fails closed → continuing',
          });
        }
      }
    }
    const uniqueOpenOwnOrders = [
      ...new Map(
        openOwnOrders.map((order) => [
          `${order.venue}:${order.orderId}`,
          order,
        ]),
      ).values(),
    ];
    const openIds = new Set(uniqueOpenOwnOrders.map(({ orderId }) => orderId));
    for (const orderId of this.pendingPlacedOrderIds) {
      if (openIds.has(orderId)) this.pendingPlacedOrderIds.delete(orderId);
    }
    for (const orderId of this.confirmedClosedOrderIds) {
      if (!openIds.has(orderId)) this.confirmedClosedOrderIds.delete(orderId);
    }
    const effectiveOpen = uniqueOpenOwnOrders.filter(
      ({ orderId }) => !this.confirmedClosedOrderIds.has(orderId),
    );
    const risk: CycleRisk = {
      spendRaw: this.sessionSpendRaw,
      inFlight: effectiveOpen.length + this.pendingPlacedOrderIds.size,
      orderSnapshotComplete,
    };
    let actualSignalSpendThisCycle = 0n;

    for (const snapshot of snapshots) {
      const { market, book } = snapshot;
      if (market.phase !== 'Graduated' || market.bookAddress === null) {
        this.refuse(
          market.id,
          'HOLD',
          `market is not tradable in the indexed model (phase=${market.phase}, book=${market.bookAddress ?? 'none'})`,
        );
        continue;
      }

      const currentYesRaw = BigInt(
        account.positions.find(
          (position) => position.marketId === market.id && position.outcome === 'YES',
        )?.qtyRaw ?? '0',
      );
      const yesOrders = venueOrders(book.yes, book.liveVenue);
      const ownYesOrders = yesOrders.filter(
        (order) =>
          sameAddress(order.maker, this.options.traderAddress) &&
          !this.confirmedClosedOrderIds.has(order.orderId),
      );
      const inventory: InventoryState = {
        availableYesRaw: currentYesRaw,
        projectedYesRaw:
          currentYesRaw +
          ownYesOrders
            .filter((order) => order.side === 'BID')
            .reduce((total, order) => total + BigInt(order.remainingRaw), 0n) +
          (this.sessionPotentialYesIncreaseRaw.get(market.id) ?? 0n),
      };

      let signal: TruthSignalResponse;
      try {
        const remainingSessionSpend =
          this.options.maxSessionSpendRaw - risk.spendRaw;
        const result = await this.options.readSignal({
          marketId: market.id,
          maxPaymentRaw:
            remainingSessionSpend > 0n ? remainingSessionSpend : 0n,
        });
        if (
          result.paymentSpendRaw < 0n ||
          result.paymentSpendRaw > remainingSessionSpend
        ) {
          throw new Error(
            `signal provider reported payment ${result.paymentSpendRaw} above remaining session cap ${remainingSessionSpend}`,
          );
        }
        risk.spendRaw += result.paymentSpendRaw;
        actualSignalSpendThisCycle += result.paymentSpendRaw;
        signal = result.signal;
      } catch (error) {
        this.options.logger.write({
          level: 'error',
          event: 'signal-error',
          marketId: market.id,
          message: `signal read → error(${errorMessage(error)}) → market skipped → continuing`,
        });
        continue;
      }

      const fair = BigInt(signal.fairValueYesRaw);
      const rawBidPrice = fair - this.options.quoteHalfSpreadRaw;
      const rawAskPrice = fair + this.options.quoteHalfSpreadRaw;
      if (rawBidPrice <= 0n || rawAskPrice > PRICE_SCALE) {
        this.refuse(
          market.id,
          'PLACE',
          `configured half-spread produces out-of-range exact quotes ${rawBidPrice}/${rawAskPrice}; no clamp`,
          { fairValueYesRaw: fair.toString() },
        );
        continue;
      }
      const minimumTickSizeRaw = BigInt(book.minimumTickSizeRaw);
      const bidPrice = quantizePriceRaw(
        rawBidPrice,
        minimumTickSizeRaw,
        'DOWN',
      );
      const askPrice = quantizePriceRaw(
        rawAskPrice,
        minimumTickSizeRaw,
        'UP',
      );
      this.options.logger.write({
        level: 'info',
        event: 'market-read',
        marketId: market.id,
        venue: book.liveVenue,
        fairValueYesRaw: fair.toString(),
        message:
          `read phase=${market.phase} liveVenue=${book.liveVenue} ` +
          `bestBid=${bestExternalOrder(yesOrders, 'BID', '')?.priceRaw ?? 'none'} ` +
          `bestAsk=${bestExternalOrder(yesOrders, 'ASK', '')?.priceRaw ?? 'none'} ` +
          `availableYes=${inventory.availableYesRaw} projectedYes=${inventory.projectedYesRaw} ` +
          `inFlight=${risk.inFlight} sessionSpendRaw=${risk.spendRaw} → inferred quote=${bidPrice}/${askPrice}`,
      });

      if (bidPrice <= 0n || askPrice > PRICE_SCALE) {
        this.refuse(
          market.id,
          'PLACE',
          `market tick ${minimumTickSizeRaw} moves quotes outside the supported range ${bidPrice}/${askPrice}; no clamp`,
          { fairValueYesRaw: fair.toString() },
        );
        continue;
      }

      const cancelled = new Set<string>();
      const cutoff = (this.options.nowSeconds?.() ?? Math.floor(Date.now() / 1_000)) -
        this.options.staleQuoteSeconds;
      for (const order of ownYesOrders) {
        const target = order.side === 'BID' ? bidPrice : askPrice;
        const ageStale = order.updatedAt <= cutoff;
        const priceStale =
          absolute(BigInt(order.priceRaw) - target) >
          this.options.repriceThresholdRaw;
        if (!ageStale && !priceStale) continue;
        if (await this.executeCancel(market.id, order, risk, inventory)) {
          cancelled.add(order.orderId);
        }
      }

      const externalAsk = bestExternalOrder(
        yesOrders,
        'ASK',
        this.options.traderAddress,
      );
      if (
        externalAsk !== undefined &&
        BigInt(externalAsk.priceRaw) + this.options.takeThresholdRaw < fair
      ) {
        this.options.logger.write({
          level: 'info',
          event: 'decision',
          marketId: market.id,
          action: 'FILL',
          outcome: 'YES',
          side: 'ASK',
          orderId: externalAsk.orderId,
          venue: externalAsk.venue,
          fairValueYesRaw: fair.toString(),
          priceRaw: externalAsk.priceRaw,
          message: 'best external ASK is below fair value by more than the take threshold',
        });
        await this.executeFill(
          snapshot,
          externalAsk,
          fillSizePreservingRepresentableRemainder(
            BigInt(externalAsk.remainingRaw),
            this.takeSizeRaw,
          ),
          fair,
          risk,
          inventory,
        );
      }

      const externalBid = bestExternalOrder(
        yesOrders,
        'BID',
        this.options.traderAddress,
      );
      if (
        externalBid !== undefined &&
        BigInt(externalBid.priceRaw) > fair + this.options.takeThresholdRaw
      ) {
        this.options.logger.write({
          level: 'info',
          event: 'decision',
          marketId: market.id,
          action: 'FILL',
          outcome: 'YES',
          side: 'BID',
          orderId: externalBid.orderId,
          venue: externalBid.venue,
          fairValueYesRaw: fair.toString(),
          priceRaw: externalBid.priceRaw,
          message: 'best external BID is above fair value by more than the take threshold',
        });
        await this.executeFill(
          snapshot,
          externalBid,
          fillSizePreservingRepresentableRemainder(
            BigInt(externalBid.remainingRaw),
            this.takeSizeRaw,
          ),
          fair,
          risk,
          inventory,
        );
      }

      const remainingOwn = ownYesOrders.filter(
        ({ orderId }) => !cancelled.has(orderId),
      );
      for (const [side, price] of [
        ['BID', bidPrice],
        ['ASK', askPrice],
      ] as const) {
        const hasCurrentQuote = remainingOwn.some(
          (order) =>
            order.side === side &&
            absolute(BigInt(order.priceRaw) - price) <=
              this.options.repriceThresholdRaw,
        );
        if (hasCurrentQuote) {
          this.options.logger.write({
            level: 'info',
            event: 'decision',
            marketId: market.id,
            action: 'HOLD',
            outcome: 'YES',
            side,
            venue: book.liveVenue,
            fairValueYesRaw: fair.toString(),
            priceRaw: price.toString(),
            message: 'existing quote is fresh and within the reprice threshold → hold',
          });
          continue;
        }
        await this.executePlace(snapshot, side, price, fair, risk, inventory);
      }
    }

    this.sessionSpendRaw = this.options.dryRun
      ? this.sessionSpendRaw + actualSignalSpendThisCycle
      : risk.spendRaw;
  }
}

export interface TraderLoopOptions {
  pollIntervalMs: number;
  signal?: AbortSignal;
  maxCycles?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  logger: TraderLogger;
}

function sleepUntilNextCycle(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

export async function runTraderLoop(
  agent: TraderAgent,
  options: TraderLoopOptions,
): Promise<void> {
  let cycles = 0;
  const sleep = options.sleep ?? sleepUntilNextCycle;
  while (
    !options.signal?.aborted &&
    (options.maxCycles === undefined || cycles < options.maxCycles)
  ) {
    try {
      await agent.runCycle();
    } catch (error) {
      options.logger.write({
        level: 'error',
        event: 'loop-error',
        message: `loop → error(${errorMessage(error)}) → continuing`,
      });
    }
    cycles += 1;
    if (
      options.signal?.aborted ||
      (options.maxCycles !== undefined && cycles >= options.maxCycles)
    ) {
      break;
    }
    await sleep(options.pollIntervalMs, options.signal);
  }
}
