import { cumulativeMiniClobPaymentRaw } from '@predex-pump/shared/tx';
import type {
  AccountResponse,
  Address,
  ListMarketsQuery,
  ListMarketsResponse,
  Market,
  MarketBookResponse,
  Order,
  TruthSignalResponse,
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

export interface TraderExecutor {
  placeOrder(
    action: PlaceOrderAction,
  ): Promise<{ txHash: `0x${string}`; orderId: string }>;
  fillOrder(action: FillOrderAction): Promise<{ txHash: `0x${string}` }>;
  cancelOrder(action: CancelOrderAction): Promise<{ txHash: `0x${string}` }>;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function bestExternalOrder(
  orders: readonly Order[],
  side: 'BID' | 'ASK',
  traderAddress: string,
): Order | undefined {
  return orders
    .filter(
      (order) =>
        order.open &&
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

export class TraderAgent {
  private sessionSpendRaw = 0n;
  private readonly sessionPotentialYesIncreaseRaw = new Map<string, bigint>();
  private readonly pendingPlacedOrderIds = new Set<string>();
  private readonly confirmedClosedOrderIds = new Set<string>();

  constructor(private readonly options: TraderAgentOptions) {
    if (!options.dryRun && options.executor === undefined) {
      throw new Error('A trader executor is required when dry-run is disabled.');
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
    order: Order,
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
        message: 'stale quote → would cancel → no broadcast',
      });
    } else {
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
          message: `cancel → rpc/on-chain error(${errorMessage(error)}) → continuing`,
        });
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
    order: Order,
    fillSizeRaw: bigint,
    fairValueYesRaw: bigint,
    risk: CycleRisk,
    inventory: InventoryState,
  ): Promise<boolean> {
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

    const notionalRaw = cumulativeMiniClobPaymentRaw(
      BigInt(order.priceRaw),
      fillSizeRaw,
    );
    const capRefusal = this.capRefusal(notionalRaw, risk);
    if (capRefusal !== null) {
      this.refuse(snapshot.market.id, 'FILL', capRefusal, {
        side: order.side,
        orderId: order.orderId,
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
        fairValueYesRaw: fairValueYesRaw.toString(),
        priceRaw: order.priceRaw,
        sizeRaw: fillSizeRaw.toString(),
        notionalRaw: notionalRaw.toString(),
        sessionSpendRaw: (risk.spendRaw + notionalRaw).toString(),
        message: 'mispriced resting order → would fill exact configured size → no broadcast',
      });
    } else {
      try {
        const result = await this.options.executor?.fillOrder({
          marketId: snapshot.market.id,
          conditionId: snapshot.market.conditionId as `0x${string}`,
          tokenId: snapshot.market.yesTokenId,
          outcome: 'YES',
          restingSide: order.side,
          orderId: order.orderId,
          expectedPriceRaw: BigInt(order.priceRaw),
          fillSizeRaw,
        });
        if (result === undefined) throw new Error('trader executor was unavailable');
        this.options.logger.write({
          level: 'info',
          event: 'broadcast',
          marketId: snapshot.market.id,
          action: 'FILL',
          outcome: 'YES',
          side: order.side,
          orderId: order.orderId,
          fairValueYesRaw: fairValueYesRaw.toString(),
          priceRaw: order.priceRaw,
          sizeRaw: fillSizeRaw.toString(),
          notionalRaw: notionalRaw.toString(),
          sessionSpendRaw: (risk.spendRaw + notionalRaw).toString(),
          txHash: result.txHash,
          message: 'mispriced resting order → filled on Arc',
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
        'max-orders-in-flight cap cannot be verified because at least one book read failed',
        {
          side,
          fairValueYesRaw: fairValueYesRaw.toString(),
          priceRaw: priceRaw.toString(),
          sizeRaw: this.options.quoteSizeRaw.toString(),
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
          side,
          fairValueYesRaw: fairValueYesRaw.toString(),
          priceRaw: priceRaw.toString(),
          sizeRaw: this.options.quoteSizeRaw.toString(),
        },
      );
      return false;
    }
    if (side === 'BID') {
      const after = inventory.projectedYesRaw + this.options.quoteSizeRaw;
      if (after > this.options.maxInventoryPerSideRaw) {
        this.refuse(
          snapshot.market.id,
          'PLACE',
          `max-inventory-per-side cap: projected YES ${after}, limit ${this.options.maxInventoryPerSideRaw}`,
          {
            side,
            fairValueYesRaw: fairValueYesRaw.toString(),
            priceRaw: priceRaw.toString(),
            sizeRaw: this.options.quoteSizeRaw.toString(),
          },
        );
        return false;
      }
    } else if (inventory.availableYesRaw < this.options.quoteSizeRaw) {
      this.refuse(
        snapshot.market.id,
        'PLACE',
        `available YES inventory ${inventory.availableYesRaw} is below exact quote size ${this.options.quoteSizeRaw}`,
        {
          side,
          fairValueYesRaw: fairValueYesRaw.toString(),
          priceRaw: priceRaw.toString(),
          sizeRaw: this.options.quoteSizeRaw.toString(),
        },
      );
      return false;
    }

    const notionalRaw = cumulativeMiniClobPaymentRaw(
      priceRaw,
      this.options.quoteSizeRaw,
    );
    const capRefusal = this.capRefusal(notionalRaw, risk);
    if (capRefusal !== null) {
      this.refuse(snapshot.market.id, 'PLACE', capRefusal, {
        side,
        fairValueYesRaw: fairValueYesRaw.toString(),
        priceRaw: priceRaw.toString(),
        sizeRaw: this.options.quoteSizeRaw.toString(),
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
        sizeRaw: this.options.quoteSizeRaw.toString(),
        notionalRaw: notionalRaw.toString(),
        sessionSpendRaw: (risk.spendRaw + notionalRaw).toString(),
        message: 'fair value → quote exact configured size → no broadcast',
      });
    } else {
      try {
        const result = await this.options.executor?.placeOrder({
          marketId: snapshot.market.id,
          conditionId: snapshot.market.conditionId as `0x${string}`,
          tokenId: snapshot.market.yesTokenId,
          outcome: 'YES',
          side,
          priceRaw,
          sizeRaw: this.options.quoteSizeRaw,
        });
        if (result === undefined) throw new Error('trader executor was unavailable');
        this.pendingPlacedOrderIds.add(result.orderId);
        this.options.logger.write({
          level: 'info',
          event: 'broadcast',
          marketId: snapshot.market.id,
          action: 'PLACE',
          outcome: 'YES',
          side,
          orderId: result.orderId,
          fairValueYesRaw: fairValueYesRaw.toString(),
          priceRaw: priceRaw.toString(),
          sizeRaw: this.options.quoteSizeRaw.toString(),
          notionalRaw: notionalRaw.toString(),
          sessionSpendRaw: (risk.spendRaw + notionalRaw).toString(),
          txHash: result.txHash,
          message: 'fair value → quote placed on Arc',
        });
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
            message: `place → rpc/on-chain error(${errorMessage(error)}) → continuing`,
          });
          return false;
        }
      }
    }

    risk.spendRaw += notionalRaw;
    risk.inFlight += 1;
    if (side === 'BID') inventory.projectedYesRaw += this.options.quoteSizeRaw;
    else inventory.availableYesRaw -= this.options.quoteSizeRaw;
    if (side === 'BID' && !this.options.dryRun) {
      this.sessionPotentialYesIncreaseRaw.set(
        snapshot.market.id,
        (this.sessionPotentialYesIncreaseRaw.get(snapshot.market.id) ?? 0n) +
          this.options.quoteSizeRaw,
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
    const restOpenOwnOrders = snapshots.flatMap(({ book }) =>
      [...book.yes.orders, ...book.no.orders].filter(
        (order) =>
          order.open && sameAddress(order.maker, this.options.traderAddress),
      ),
    );
    const restOpenIds = new Set(restOpenOwnOrders.map(({ orderId }) => orderId));
    for (const orderId of this.pendingPlacedOrderIds) {
      if (restOpenIds.has(orderId)) this.pendingPlacedOrderIds.delete(orderId);
    }
    for (const orderId of this.confirmedClosedOrderIds) {
      if (!restOpenIds.has(orderId)) this.confirmedClosedOrderIds.delete(orderId);
    }
    const effectiveRestOpen = restOpenOwnOrders.filter(
      ({ orderId }) => !this.confirmedClosedOrderIds.has(orderId),
    );
    const risk: CycleRisk = {
      spendRaw: this.sessionSpendRaw,
      inFlight: effectiveRestOpen.length + this.pendingPlacedOrderIds.size,
      orderSnapshotComplete: snapshots.length === markets.length,
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
      const ownYesOrders = book.yes.orders.filter(
        (order) =>
          order.open &&
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
      const bidPrice = fair - this.options.quoteHalfSpreadRaw;
      const askPrice = fair + this.options.quoteHalfSpreadRaw;
      this.options.logger.write({
        level: 'info',
        event: 'market-read',
        marketId: market.id,
        fairValueYesRaw: fair.toString(),
        message:
          `read phase=${market.phase} bestBid=${book.yes.bids[0]?.priceRaw ?? 'none'} ` +
          `bestAsk=${book.yes.asks[0]?.priceRaw ?? 'none'} ` +
          `availableYes=${inventory.availableYesRaw} projectedYes=${inventory.projectedYesRaw} ` +
          `inFlight=${risk.inFlight} sessionSpendRaw=${risk.spendRaw} → inferred quote=${bidPrice}/${askPrice}`,
      });

      if (bidPrice <= 0n || askPrice > PRICE_SCALE) {
        this.refuse(
          market.id,
          'PLACE',
          `configured half-spread produces out-of-range exact quotes ${bidPrice}/${askPrice}; no clamp`,
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
        book.yes.orders,
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
          fairValueYesRaw: fair.toString(),
          priceRaw: externalAsk.priceRaw,
          message: 'best external ASK is below fair value by more than the take threshold',
        });
        await this.executeFill(
          snapshot,
          externalAsk,
          this.options.takeSizeRaw,
          fair,
          risk,
          inventory,
        );
      }

      const externalBid = bestExternalOrder(
        book.yes.orders,
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
          fairValueYesRaw: fair.toString(),
          priceRaw: externalBid.priceRaw,
          message: 'best external BID is above fair value by more than the take threshold',
        });
        await this.executeFill(
          snapshot,
          externalBid,
          this.options.takeSizeRaw,
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
