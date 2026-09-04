import type { Prisma, PrismaClient, SignedOrder } from '@prisma/client';
import {
  Side,
  ctfExchangeMakerAmountForFill,
} from '@predex-pump/shared/tx';

import type { Fillability } from './order.js';
import { signedOrderFromRow } from './order.js';

export const ACTIVE_ORDER_STATUSES = ['OPEN', 'PARTIALLY_FILLED'] as const;

function positionKey(order: Pick<SignedOrder, 'maker' | 'marketId' | 'outcome'>) {
  return `${order.maker}:${order.marketId}:${order.outcome}`;
}

export async function expireSignedOrders(
  prisma: PrismaClient,
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
  prisma: PrismaClient,
  orders: readonly SignedOrder[],
  now: number,
): Promise<Map<string, Fillability>> {
  if (orders.length === 0) return new Map();
  const makers = [...new Set(orders.map((order) => order.maker))];
  const marketIds = [...new Set(orders.map((order) => order.marketId))];
  const sellOrders = orders.filter((order) => order.exchangeSide === Side.SELL);

  const [
    positions,
    ctfApprovals,
    collateralApprovals,
    collateralBalances,
    resolutions,
    migrations,
    indexerState,
  ] =
    await Promise.all([
      sellOrders.length === 0
        ? Promise.resolve([])
        : prisma.position.findMany({
            where: {
              OR: sellOrders.map((order) => ({
                account: order.maker,
                marketId: order.marketId,
                outcome: order.outcome,
              })),
            },
            select: {
              account: true,
              marketId: true,
              outcome: true,
              qtyRaw: true,
            },
          }),
      prisma.ctfExchangeApproval.findMany({ where: { owner: { in: makers } } }),
      prisma.collateralExchangeApproval.findMany({
        where: { owner: { in: makers } },
      }),
      prisma.collateralBalance.findMany({ where: { owner: { in: makers } } }),
      prisma.resolution.findMany({
        where: { marketId: { in: marketIds } },
        select: { marketId: true },
      }),
      prisma.bookMigration.findMany({
        where: { marketId: { in: marketIds }, status: 'MIGRATED' },
        select: {
          marketId: true,
          recoveryBlockNumber: true,
          yesBalanceRaw: true,
          noBalanceRaw: true,
        },
      }),
      prisma.indexerState.findUnique({
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
  const resolvedMarkets = new Set(resolutions.map((resolution) => resolution.marketId));
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
      if (order.expiration !== 0 && order.expiration <= now) {
        return [order.orderHash, { fillable: false, reason: 'EXPIRED' }];
      }
      if (resolvedMarkets.has(order.marketId)) {
        return [order.orderHash, { fillable: false, reason: 'MARKET_RESOLVED' }];
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
      const required = ctfExchangeMakerAmountForFill(
        signedOrderFromRow(order),
        BigInt(order.remainingRaw),
      );
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
  prisma: PrismaClient,
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
  prisma: PrismaClient,
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
