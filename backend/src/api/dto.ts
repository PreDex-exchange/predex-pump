import type {
  Account as DbAccount,
  ActivityEvent as DbActivityEvent,
  Fill as DbFill,
  Market as DbMarket,
  Order as DbOrder,
  Position as DbPosition,
  Resolution as DbResolution,
  Trade as DbTrade,
} from '@prisma/client';
import type {
  Account,
  ActivityEvent,
  ActivityType,
  Address,
  Fill,
  Hash,
  Market,
  MarketPhase,
  Order,
  OrderSide,
  Outcome,
  Position,
  Resolution,
  ResolutionOutcome,
  Trade,
  Venue,
} from '@predex-pump/shared';

export const ACTIVITY_TYPES = [
  'MarketCreated',
  'Trade',
  'MarketGraduated',
  'BookSeeded',
  'OrderPlaced',
  'OrderFilled',
  'OrderCancelled',
  'ResolutionObserved',
  'Closeout',
  'Redeem',
] as const satisfies readonly ActivityType[];

const activityTypeSet = new Set<string>(ACTIVITY_TYPES);

export type MarketDtoRow = Pick<
  DbMarket,
  | 'id'
  | 'creator'
  | 'question'
  | 'phase'
  | 'conditionId'
  | 'questionId'
  | 'yesTokenId'
  | 'noTokenId'
  | 'seedRaw'
  | 'yesPriceRaw'
  | 'noPriceRaw'
  | 'graduationActivityRaw'
  | 'bookAddress'
  | 'frozenYesPriceRaw'
  | 'handoffSizeRaw'
  | 'tradeCount'
  | 'volumeRaw'
  | 'seedFloorRaw'
  | 'seedCapRaw'
  | 'fCapRaw'
  | 'graduationThresholdRaw'
  | 'graduationTollRaw'
  | 'inventoryTargetRaw'
  | 'protocolFeeBps'
  | 'depthFeeBps'
  | 'tradingWindowSeconds'
  | 'minimumTimeOpenSeconds'
  | 'createdAt'
  | 'tradingEndsAt'
  | 'graduatedAt'
  | 'resolvedAt'
>;

export type TradeDtoRow = Pick<
  DbTrade,
  | 'id'
  | 'marketId'
  | 'venue'
  | 'account'
  | 'outcome'
  | 'side'
  | 'sizeRaw'
  | 'priceRaw'
  | 'costRaw'
  | 'feeRaw'
  | 'txHash'
  | 'logIndex'
  | 'ts'
>;

export type OrderDtoRow = Pick<
  DbOrder,
  | 'orderId'
  | 'marketId'
  | 'conditionId'
  | 'tokenId'
  | 'outcome'
  | 'maker'
  | 'side'
  | 'priceRaw'
  | 'sizeRaw'
  | 'filledRaw'
  | 'remainingRaw'
  | 'open'
  | 'isSeed'
  | 'createdAt'
  | 'updatedAt'
>;

export type PositionDtoRow = Pick<
  DbPosition,
  | 'account'
  | 'marketId'
  | 'outcome'
  | 'qtyRaw'
  | 'costBasisRaw'
  | 'realizedPnlRaw'
  | 'unrealizedPnlRaw'
  | 'updatedAt'
>;

export type ActivityDtoRow = Pick<
  DbActivityEvent,
  | 'id'
  | 'type'
  | 'marketId'
  | 'account'
  | 'outcome'
  | 'side'
  | 'amountRaw'
  | 'priceRaw'
  | 'txHash'
  | 'blockNumber'
  | 'logIndex'
  | 'ts'
>;

export function isActivityType(value: string): value is ActivityType {
  return activityTypeSet.has(value);
}

function address(value: string): Address {
  return value as Address;
}

function hash(value: string): Hash {
  return value as Hash;
}

export function toMarketDto(market: MarketDtoRow): Market {
  return {
    id: market.id,
    creator: address(market.creator),
    question: market.question,
    phase: market.phase as MarketPhase,
    conditionId: market.conditionId,
    questionId: market.questionId,
    yesTokenId: market.yesTokenId ?? '',
    noTokenId: market.noTokenId ?? '',
    seedRaw: market.seedRaw,
    yesPriceRaw: market.yesPriceRaw,
    noPriceRaw: market.noPriceRaw,
    graduationActivityRaw: market.graduationActivityRaw,
    bookAddress: market.bookAddress === null ? null : address(market.bookAddress),
    frozenYesPriceRaw: market.frozenYesPriceRaw,
    handoffSizeRaw: market.handoffSizeRaw,
    tradeCount: market.tradeCount,
    volumeRaw: market.volumeRaw,
    params: {
      seedFloorRaw: market.seedFloorRaw,
      seedCapRaw: market.seedCapRaw,
      fCapRaw: market.fCapRaw,
      graduationMoneyInThresholdRaw: market.graduationThresholdRaw,
      graduationTollRaw: market.graduationTollRaw,
      inventoryTargetRaw: market.inventoryTargetRaw,
      protocolFeeBps: market.protocolFeeBps,
      depthFeeBps: market.depthFeeBps,
      tradingWindowSeconds: market.tradingWindowSeconds,
      minimumTimeOpenSeconds: market.minimumTimeOpenSeconds,
    },
    createdAt: market.createdAt,
    tradingEndsAt: market.tradingEndsAt,
    graduatedAt: market.graduatedAt,
    resolvedAt: market.resolvedAt,
  };
}

export function toTradeDto(trade: TradeDtoRow): Trade {
  return {
    id: trade.id,
    marketId: trade.marketId,
    venue: trade.venue as Venue,
    account: address(trade.account),
    outcome: trade.outcome as Outcome,
    side: trade.side as OrderSide,
    sizeRaw: trade.sizeRaw,
    priceRaw: trade.priceRaw,
    costRaw: trade.costRaw,
    feeRaw: trade.feeRaw,
    txHash: hash(trade.txHash),
    logIndex: trade.logIndex,
    ts: trade.ts,
  };
}

export function toOrderDto(order: OrderDtoRow): Order {
  return {
    orderId: order.orderId,
    marketId: order.marketId,
    conditionId: order.conditionId,
    tokenId: order.tokenId,
    outcome: order.outcome as Outcome,
    maker: address(order.maker),
    side: order.side as OrderSide,
    priceRaw: order.priceRaw,
    sizeRaw: order.sizeRaw,
    filledRaw: order.filledRaw,
    remainingRaw: order.remainingRaw,
    open: order.open,
    isSeed: order.isSeed,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

export function toFillDto(fill: DbFill): Fill {
  return {
    id: fill.id,
    orderId: fill.orderId,
    marketId: fill.marketId,
    taker: address(fill.taker),
    maker: address(fill.maker),
    outcome: fill.outcome as Outcome,
    fillSizeRaw: fill.fillSizeRaw,
    paymentRaw: fill.paymentRaw,
    filledAfterRaw: fill.filledAfterRaw,
    openAfter: fill.openAfter,
    txHash: hash(fill.txHash),
    logIndex: fill.logIndex,
    ts: fill.ts,
  };
}

export function toResolutionDto(resolution: DbResolution): Resolution {
  return {
    marketId: resolution.marketId,
    conditionId: resolution.conditionId,
    outcome: resolution.outcome as ResolutionOutcome,
    payoutYes: resolution.payoutYes,
    payoutNo: resolution.payoutNo,
    denominator: resolution.denominator,
    resolvedAt: resolution.resolvedAt,
    observedAt: resolution.observedAt,
  };
}

export function toAccountDto(account: DbAccount): Account {
  return {
    address: address(account.address),
    firstSeenAt: account.firstSeenAt,
    marketsCreated: account.marketsCreated,
    tradeCount: account.tradeCount,
  };
}

export function toPositionDto(position: PositionDtoRow): Position {
  return {
    account: address(position.account),
    marketId: position.marketId,
    outcome: position.outcome as Outcome,
    qtyRaw: position.qtyRaw,
    costBasisRaw: position.costBasisRaw,
    costBasisEstimated: true,
    realizedPnlRaw: position.realizedPnlRaw,
    unrealizedPnlRaw: position.unrealizedPnlRaw,
    updatedAt: position.updatedAt,
  };
}

export function toActivityDto(activity: ActivityDtoRow): ActivityEvent | null {
  if (!isActivityType(activity.type)) return null;

  return {
    id: activity.id,
    type: activity.type,
    marketId: activity.marketId,
    account: activity.account === null ? null : address(activity.account),
    ...(activity.outcome === null
      ? {}
      : { outcome: activity.outcome as Outcome }),
    ...(activity.side === null ? {} : { side: activity.side as OrderSide }),
    ...(activity.amountRaw === null ? {} : { amountRaw: activity.amountRaw }),
    ...(activity.priceRaw === null ? {} : { priceRaw: activity.priceRaw }),
    txHash: hash(activity.txHash),
    ts: activity.ts,
  };
}
