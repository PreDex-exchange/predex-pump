import { Prisma, type PrismaClient, type SignedOrder } from '@prisma/client';
import { encodePacked, keccak256 } from 'viem';

import { findFillableSignedOrders } from './fillability.js';

const IN_FLIGHT_MATCH_STATUSES = [
  'PENDING',
  'SUBMITTING',
  'SUBMITTED',
  // A transport error can happen after broadcast but before a tx hash returns.
  // Keep both orders quarantined until an operator reconciles this state.
  'SUBMISSION_UNKNOWN',
] as const;

export interface CrossingMatchCandidate {
  takerOrder: SignedOrder;
  makerOrder: SignedOrder;
  fillSizeRaw: string;
  matchPriceRaw: string;
  matchKey: `0x${string}`;
}

function compareRaw(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function orderPriority(left: SignedOrder, right: SignedOrder): number {
  return left.createdAt - right.createdAt || left.orderHash.localeCompare(right.orderHash);
}

function deterministicMatchKey(
  takerOrder: SignedOrder,
  makerOrder: SignedOrder,
  fillSizeRaw: bigint,
): `0x${string}` {
  return keccak256(
    encodePacked(
      ['bytes32', 'bytes32', 'uint256', 'uint256', 'uint256'],
      [
        takerOrder.orderHash as `0x${string}`,
        makerOrder.orderHash as `0x${string}`,
        BigInt(takerOrder.filledRaw),
        BigInt(makerOrder.filledRaw),
        fillSizeRaw,
      ],
    ),
  );
}

/** Pure price-time crossing. It never mutates remaining quantities. */
export function findCrossingCandidates(
  orders: readonly SignedOrder[],
): CrossingMatchCandidate[] {
  const tokenIds = [...new Set(orders.map((order) => order.tokenId))].sort();
  const candidates: CrossingMatchCandidate[] = [];
  for (const tokenId of tokenIds) {
    const bids = orders
      .filter(
        (order) =>
          order.tokenId === tokenId &&
          order.side === 'BID' &&
          BigInt(order.remainingRaw) > 0n,
      )
      .sort((left, right) => {
        const price = compareRaw(right.priceRaw, left.priceRaw);
        return price !== 0 ? price : orderPriority(left, right);
      });
    const asks = orders
      .filter(
        (order) =>
          order.tokenId === tokenId &&
          order.side === 'ASK' &&
          BigInt(order.remainingRaw) > 0n,
      )
      .sort((left, right) => {
        const price = compareRaw(left.priceRaw, right.priceRaw);
        return price !== 0 ? price : orderPriority(left, right);
      });

    for (const bid of bids) {
      for (const ask of asks) {
        if (BigInt(bid.priceRaw) < BigInt(ask.priceRaw)) break;
        const fillSize =
          BigInt(bid.remainingRaw) < BigInt(ask.remainingRaw)
            ? BigInt(bid.remainingRaw)
            : BigInt(ask.remainingRaw);
        const takerOrder = orderPriority(bid, ask) > 0 ? bid : ask;
        const makerOrder = takerOrder.orderHash === bid.orderHash ? ask : bid;
        candidates.push({
          takerOrder,
          makerOrder,
          fillSizeRaw: fillSize.toString(),
          matchPriceRaw: makerOrder.priceRaw,
          matchKey: deterministicMatchKey(takerOrder, makerOrder, fillSize),
        });
      }
    }
  }
  return candidates;
}

export interface ReservedMatch extends CrossingMatchCandidate {
  id: string;
}

export async function reserveNextCrossingMatch(
  prisma: PrismaClient,
  now: number,
): Promise<ReservedMatch | null> {
  const [orders, inFlight] = await Promise.all([
    findFillableSignedOrders(prisma, {}, now),
    prisma.settlementMatch.findMany({
      where: { status: { in: [...IN_FLIGHT_MATCH_STATUSES] } },
      select: { takerOrderHash: true, makerOrderHash: true },
    }),
  ]);
  const busyOrders = new Set(
    inFlight.flatMap((match) => [match.takerOrderHash, match.makerOrderHash]),
  );
  const candidates = findCrossingCandidates(
    orders.filter((order) => !busyOrders.has(order.orderHash)),
  );
  if (candidates.length === 0) return null;
  const existing = new Set(
    (
      await prisma.settlementMatch.findMany({
        where: { matchKey: { in: candidates.map((candidate) => candidate.matchKey) } },
        select: { matchKey: true },
      })
    ).map((match) => match.matchKey),
  );
  const candidate = candidates.find((item) => !existing.has(item.matchKey));
  if (candidate === undefined) return null;

  try {
    const match = await prisma.settlementMatch.create({
      data: {
        id: candidate.matchKey,
        matchKey: candidate.matchKey,
        takerOrderHash: candidate.takerOrder.orderHash,
        makerOrderHash: candidate.makerOrder.orderHash,
        tokenId: candidate.takerOrder.tokenId,
        fillSizeRaw: candidate.fillSizeRaw,
        takerFilledBeforeRaw: candidate.takerOrder.filledRaw,
        makerFilledBeforeRaw: candidate.makerOrder.filledRaw,
        status: 'PENDING',
        createdAt: now,
        updatedAt: now,
      },
    });
    return { ...candidate, id: match.id };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return null;
    }
    throw error;
  }
}
