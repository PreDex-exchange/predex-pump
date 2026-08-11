import type {
  BookLevel,
  LiveBookVenue,
  OffchainOrder,
  OrderBook,
  OrderSide,
} from '@predex-pump/shared/domain';
import type { ExchangeApprovalStateResponse } from '@predex-pump/shared/rest';
import {
  assertAllowedMinimumTickSizeRaw,
  isOrderSizeGranular,
  isPriceOnTick,
} from '@predex-pump/shared';
import {
  ctfExchangeCollateralAmountForFill,
  ctfExchangeOrderAmounts,
  ctfExchangeOrderFromWire,
  Side,
} from '@predex-pump/shared/tx';

export interface HybridOrderCommitment {
  exchangeSide: 0 | 1;
  priceRaw: bigint;
  sizeRaw: bigint;
  collateralRaw: bigint;
  expiration: number;
}

export function buildHybridOrderCommitment({
  side,
  priceRaw,
  sizeRaw,
  minimumTickSizeRaw,
  expiration,
}: {
  side: OrderSide;
  priceRaw: bigint;
  sizeRaw: bigint;
  minimumTickSizeRaw: bigint;
  expiration: number;
}): HybridOrderCommitment {
  assertAllowedMinimumTickSizeRaw(minimumTickSizeRaw);
  if (!isPriceOnTick(priceRaw, minimumTickSizeRaw)) {
    throw new Error('Limit price must align to the market minimum tick size.');
  }
  if (!isOrderSizeGranular(sizeRaw)) {
    throw new Error('Order size must align to the exchange size granularity.');
  }
  const exchangeSide = side === 'BID' ? Side.BUY : Side.SELL;
  const amounts = ctfExchangeOrderAmounts({
    side: exchangeSide,
    priceRaw,
    sizeRaw,
  });
  return {
    exchangeSide,
    priceRaw,
    sizeRaw,
    collateralRaw:
      exchangeSide === Side.BUY
        ? amounts.makerAmount
        : amounts.takerAmount,
    expiration,
  };
}

export type ExchangeApprovalRequirement =
  | {
      kind: 'COLLATERAL';
      amountRaw: bigint;
      ready: boolean;
    }
  | {
      kind: 'CTF';
      amountRaw: null;
      ready: boolean;
    };

export function makerApprovalRequirement(
  approvals: ExchangeApprovalStateResponse,
  side: OrderSide,
  collateralRaw: bigint,
): ExchangeApprovalRequirement {
  return side === 'BID'
    ? {
        kind: 'COLLATERAL',
        amountRaw: collateralRaw,
        ready: BigInt(approvals.collateralAllowanceRaw) >= collateralRaw,
      }
    : {
        kind: 'CTF',
        amountRaw: null,
        ready: approvals.ctfApprovedForAll,
      };
}

export function fillApprovalRequirement(
  approvals: ExchangeApprovalStateResponse,
  order: OffchainOrder,
  fillSizeRaw: bigint,
): ExchangeApprovalRequirement {
  if (order.side === 'ASK') {
    const collateralRaw = ctfExchangeCollateralAmountForFill(
      ctfExchangeOrderFromWire(order.signedOrder),
      fillSizeRaw,
    );
    return {
      kind: 'COLLATERAL',
      amountRaw: collateralRaw,
      ready: BigInt(approvals.collateralAllowanceRaw) >= collateralRaw,
    };
  }
  return {
    kind: 'CTF',
    amountRaw: null,
    ready: approvals.ctfApprovedForAll,
  };
}

interface LevelSource {
  side: OrderSide;
  priceRaw: string;
  remainingRaw: string;
}

function buildVenueLevels(
  orders: readonly LevelSource[],
  side: OrderSide,
): BookLevel[] {
  const sizes = new Map<string, { sizeRaw: bigint; orderCount: number }>();
  for (const order of orders) {
    if (order.side !== side) continue;
    const existing = sizes.get(order.priceRaw) ?? {
      sizeRaw: 0n,
      orderCount: 0,
    };
    existing.sizeRaw += BigInt(order.remainingRaw);
    existing.orderCount += 1;
    sizes.set(order.priceRaw, existing);
  }
  return [...sizes.entries()]
    .map(([priceRaw, value]) => ({
      priceRaw,
      sizeRaw: value.sizeRaw.toString(),
      orderCount: value.orderCount,
    }))
    .sort((left, right) => {
      const leftPrice = BigInt(left.priceRaw);
      const rightPrice = BigInt(right.priceRaw);
      if (leftPrice === rightPrice) return 0;
      if (side === 'BID') return leftPrice > rightPrice ? -1 : 1;
      return leftPrice < rightPrice ? -1 : 1;
    });
}

/** Keep venue ladders distinct even while the P2 response carries both raw sources. */
export function orderBookForVenue(
  book: OrderBook,
  venue: LiveBookVenue,
): OrderBook {
  const miniOrders = venue === 'MINICLOB' ? book.orders.filter((order) => order.open) : [];
  const hybridOrders =
    venue === 'HYBRID'
      ? book.offchainOrders.filter(
          (order) =>
            order.fillable &&
            (order.status === 'OPEN' || order.status === 'PARTIALLY_FILLED') &&
            BigInt(order.remainingRaw) > 0n,
        )
      : [];
  const levelSources: LevelSource[] = [...miniOrders, ...hybridOrders];
  const bids = buildVenueLevels(levelSources, 'BID');
  const asks = buildVenueLevels(levelSources, 'ASK');
  return {
    ...book,
    bids,
    asks,
    bestBidRaw: bids[0]?.priceRaw ?? null,
    bestAskRaw: asks[0]?.priceRaw ?? null,
    orders: miniOrders,
    offchainOrders: hybridOrders,
  };
}

export function hybridLevelCollateralRaw(
  orders: readonly OffchainOrder[],
  side: OrderSide,
  priceRaw: string,
): bigint {
  return orders
    .filter((order) => order.side === side && order.priceRaw === priceRaw)
    .reduce(
      (total, order) =>
        total +
        ctfExchangeCollateralAmountForFill(
          ctfExchangeOrderFromWire(order.signedOrder),
          BigInt(order.remainingRaw),
        ),
      0n,
    );
}
