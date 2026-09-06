import type { Prisma, SignedOrder } from '@prisma/client';
import { Side } from '@predex-pump/shared/tx';

import type { Fillability } from './order.js';

export const ACTIVE_ORDER_STATUSES = ['OPEN', 'PARTIALLY_FILLED'] as const;

export interface SignedOrderFillabilityRow {
  orderHash: string;
  maker: string;
  marketId: string;
  outcome: string;
  exchangeSide: number;
  status: string;
  withdrawnAt: number | null;
  expiration: number;
  remainingRaw: string;
  origin: string;
  makerAmountRaw: string;
  takerAmountRaw: string;
}

export const SIGNED_ORDER_BOOK_SELECT = {
  orderHash: true,
  maker: true,
  tokenId: true,
  marketId: true,
  outcome: true,
  side: true,
  priceRaw: true,
  exchangeSide: true,
  status: true,
  withdrawnAt: true,
  expiration: true,
  remainingRaw: true,
  origin: true,
  makerAmountRaw: true,
  takerAmountRaw: true,
  createdAt: true,
} as const satisfies Prisma.SignedOrderSelect;

export type SignedOrderBookRow = Prisma.SignedOrderGetPayload<{
  select: typeof SIGNED_ORDER_BOOK_SELECT;
}>;

function positionKey(
  order: Pick<SignedOrderFillabilityRow, 'maker' | 'marketId' | 'outcome'>,
) {
  return `${order.maker}:${order.marketId}:${order.outcome}`;
}

function assertExchangeSide(value: number): asserts value is Side {
  if (value !== Side.BUY && value !== Side.SELL) {
    throw new Error('Order side must be Side.BUY or Side.SELL.');
  }
}

function makerAmountForRemaining(order: SignedOrderFillabilityRow): bigint {
  assertExchangeSide(order.exchangeSide);
  const makerAmount = BigInt(order.makerAmountRaw);
  const takerAmount = BigInt(order.takerAmountRaw);
  const remaining = BigInt(order.remainingRaw);
  if (makerAmount <= 0n || takerAmount <= 0n) {
    throw new Error('Order maker and taker amounts must be greater than zero.');
  }
  const size = order.exchangeSide === Side.SELL ? makerAmount : takerAmount;
  if (remaining > size) {
    throw new Error('Fill size exceeds the signed order size.');
  }
  return order.exchangeSide === Side.SELL
    ? remaining
    : (remaining * makerAmount) / takerAmount;
}

export async function expireSignedOrders(
  prisma: Prisma.TransactionClient,
  now: number,
): Promise<number> {
  const expired = await prisma.signedOrder.updateMany({
    where: {
      status: { in: [...ACTIVE_ORDER_STATUSES] },
      expiration: { gt: 0, lte: now },
    },
    data: { status: 'EXPIRED', updatedAt: now },
  });
  return expired.count;
}

export async function fillabilityForOrders(
  prisma: Prisma.TransactionClient,
  orders: readonly SignedOrderFillabilityRow[],
  now: number,
): Promise<Map<string, Fillability>> {
  if (orders.length === 0) return new Map();
  for (const order of orders) assertExchangeSide(order.exchangeSide);
  const marketIds = [...new Set(orders.map((order) => order.marketId))];
  const sellOrders = orders.filter((order) => order.exchangeSide === Side.SELL);
  const buyOrders = orders.filter((order) => order.exchangeSide === Side.BUY);
  const sellMakers = [...new Set(sellOrders.map((order) => order.maker))];
  const buyMakers = [...new Set(buyOrders.map((order) => order.maker))];
  const positionTargets = [
    ...new Map(
      sellOrders.map((order) => [
        positionKey(order),
        {
          account: order.maker,
          marketId: order.marketId,
          outcome: order.outcome,
        },
      ] as const),
    ).values(),
  ];
  const migrationMarketIds = [
    ...new Set(
      sellOrders
        .filter((order) => order.origin === 'BOOK_MIGRATION')
        .map((order) => order.marketId),
    ),
  ];

  const [
    positions,
    ctfApprovals,
    collateralApprovals,
    collateralBalances,
    markets,
    migrations,
    indexerState,
  ] =
    await Promise.all([
      positionTargets.length === 0
        ? Promise.resolve([])
        : prisma.position.findMany({
            where: { OR: positionTargets },
            select: {
              account: true,
              marketId: true,
              outcome: true,
              qtyRaw: true,
            },
          }),
      sellMakers.length === 0
        ? Promise.resolve([])
        : prisma.ctfExchangeApproval.findMany({
            where: { owner: { in: sellMakers } },
          }),
      buyMakers.length === 0
        ? Promise.resolve([])
        : prisma.collateralExchangeApproval.findMany({
            where: { owner: { in: buyMakers } },
          }),
      buyMakers.length === 0
        ? Promise.resolve([])
        : prisma.collateralBalance.findMany({
            where: { owner: { in: buyMakers } },
          }),
      prisma.market.findMany({
        where: { id: { in: marketIds } },
        select: {
          id: true,
          tradingEndsAt: true,
          resolution: { select: { marketId: true } },
        },
      }),
      migrationMarketIds.length === 0
        ? Promise.resolve([])
        : prisma.bookMigration.findMany({
            where: {
              marketId: { in: migrationMarketIds },
              status: 'MIGRATED',
            },
            select: {
              marketId: true,
              recoveryBlockNumber: true,
              yesBalanceRaw: true,
              noBalanceRaw: true,
            },
          }),
      migrationMarketIds.length === 0
        ? Promise.resolve(null)
        : prisma.indexerState.findUnique({
            where: { id: 1 },
            select: { lastBlock: true },
          }),
    ]);

  const positionByKey = new Map(
    positions.map((position) => [
      `${position.account}:${position.marketId}:${position.outcome}`,
      BigInt(position.qtyRaw),
    ]),
  );
  const ctfApprovalByOwner = new Map(
    ctfApprovals.map((approval) => [approval.owner, approval.approved]),
  );
  const collateralApprovalByOwner = new Map(
    collateralApprovals.map((approval) => [
      approval.owner,
      BigInt(approval.allowanceRaw),
    ]),
  );
  const collateralBalanceByOwner = new Map(
    collateralBalances.map((balance) => [balance.owner, BigInt(balance.balanceRaw)]),
  );
  const marketById = new Map(markets.map((market) => [market.id, market]));
  const migrationByMarket = new Map(
    migrations.map((migration) => [migration.marketId, migration]),
  );

  return new Map(
    orders.map((order): [string, Fillability] => {
      if (!ACTIVE_ORDER_STATUSES.includes(order.status as (typeof ACTIVE_ORDER_STATUSES)[number])) {
        return [order.orderHash, { fillable: false, reason: 'NOT_OPEN' }];
      }
      if (order.withdrawnAt !== null) {
        return [order.orderHash, { fillable: false, reason: 'WITHDRAWN' }];
      }
      const market = marketById.get(order.marketId);
      if (market === undefined) {
        return [
          order.orderHash,
          { fillable: false, reason: 'INDEXED_STATE_UNAVAILABLE' },
        ];
      }
      if (market.resolution !== null) {
        return [order.orderHash, { fillable: false, reason: 'MARKET_RESOLVED' }];
      }
      if (now >= market.tradingEndsAt) {
        return [order.orderHash, { fillable: false, reason: 'TRADING_ENDED' }];
      }
      if (order.expiration !== 0 && order.expiration <= now) {
        return [order.orderHash, { fillable: false, reason: 'EXPIRED' }];
      }
      if (BigInt(order.remainingRaw) <= 0n) {
        return [order.orderHash, { fillable: false, reason: 'NOT_OPEN' }];
      }

      if (order.exchangeSide === Side.SELL) {
        const migration =
          order.origin === 'BOOK_MIGRATION'
            ? migrationByMarket.get(order.marketId)
            : undefined;
        // The cutover receipt proves these tokens are already back at the maker.
        // Until the indexer reaches that block, use the pinned migration snapshot
        // so publishing does not create an artificial extra no-book interval.
        const recoverySnapshot =
          migration?.recoveryBlockNumber !== null &&
          migration?.recoveryBlockNumber !== undefined &&
          (indexerState?.lastBlock ?? -1) < migration.recoveryBlockNumber
            ? migration
            : undefined;
        const snapshottedBalance =
          order.outcome === 'YES'
            ? recoverySnapshot?.yesBalanceRaw
            : recoverySnapshot?.noBalanceRaw;
        const balance =
          snapshottedBalance === null || snapshottedBalance === undefined
            ? positionByKey.get(positionKey(order))
            : BigInt(snapshottedBalance);
        if (balance === undefined) {
          return [
            order.orderHash,
            { fillable: false, reason: 'INDEXED_STATE_UNAVAILABLE' },
          ];
        }
        if (balance < BigInt(order.remainingRaw)) {
          return [
            order.orderHash,
            { fillable: false, reason: 'INSUFFICIENT_BALANCE' },
          ];
        }
        if (ctfApprovalByOwner.get(order.maker) !== true) {
          return [
            order.orderHash,
            { fillable: false, reason: 'MISSING_APPROVAL' },
          ];
        }
        return [order.orderHash, { fillable: true, reason: null }];
      }

      const balance = collateralBalanceByOwner.get(order.maker);
      const allowance = collateralApprovalByOwner.get(order.maker);
      if (balance === undefined || allowance === undefined) {
        return [
          order.orderHash,
          { fillable: false, reason: 'INDEXED_STATE_UNAVAILABLE' },
        ];
      }
      const required = makerAmountForRemaining(order);
      if (balance < required) {
        return [
          order.orderHash,
          { fillable: false, reason: 'INSUFFICIENT_BALANCE' },
        ];
      }
      if (allowance < required) {
        return [
          order.orderHash,
          { fillable: false, reason: 'MISSING_APPROVAL' },
        ];
      }
      return [order.orderHash, { fillable: true, reason: null }];
    }),
  );
}

export async function findSignedOrdersWithFillability(
  prisma: Prisma.TransactionClient,
  where: Prisma.SignedOrderWhereInput,
  now: number,
): Promise<
  Array<{ order: SignedOrder; fillability: Fillability }>
> {
  await expireSignedOrders(prisma, now);
  const orders = await prisma.signedOrder.findMany({
    where,
    orderBy: [{ createdAt: 'asc' }, { orderHash: 'asc' }],
  });
  const fillability = await fillabilityForOrders(prisma, orders, now);
  return orders.map((order) => ({
    order,
    fillability: fillability.get(order.orderHash) ?? {
      fillable: false,
      reason: 'INDEXED_STATE_UNAVAILABLE',
    },
  }));
}

export async function findFillableSignedOrders(
  prisma: Prisma.TransactionClient,
  where: Prisma.SignedOrderWhereInput,
  now: number,
): Promise<SignedOrder[]> {
  const candidates = await findSignedOrdersWithFillability(
    prisma,
    {
      ...where,
      status: { in: [...ACTIVE_ORDER_STATUSES] },
      withdrawnAt: null,
    },
    now,
  );
  return candidates
    .filter(({ fillability }) => fillability.fillable)
    .map(({ order }) => order);
}

export async function findFillableSignedOrderBookRows(
  prisma: Prisma.TransactionClient,
  where: Prisma.SignedOrderWhereInput,
  now: number,
): Promise<SignedOrderBookRow[]> {
  // This path runs inside a repeatable-read public-book snapshot. Expiration is
  // evaluated below without mutating durable order status inside that snapshot.
  const orders = await prisma.signedOrder.findMany({
    where: {
      ...where,
      status: { in: [...ACTIVE_ORDER_STATUSES] },
      withdrawnAt: null,
    },
    select: SIGNED_ORDER_BOOK_SELECT,
  });
  const fillability = await fillabilityForOrders(prisma, orders, now);
  return orders.filter(
    (order) => fillability.get(order.orderHash)?.fillable === true,
  );
}
