import { ARC } from '@predex-pump/shared';
import type {
  AccountResponse,
  ActivityResponse,
  ConfigResponse,
  HealthResponse,
  ListMarketsResponse,
  MarketBookResponse,
  MarketDetailResponse,
  OrderBook,
  OrderBookResponse,
  PriceHistoryResponse,
} from '@predex-pump/shared';
import type {
  Fill as DbFill,
  Market as DbMarket,
  Order as DbOrder,
  Prisma,
  PrismaClient,
  Trade as DbTrade,
} from '@prisma/client';

import {
  ACTIVITY_TYPES,
  sumPnl,
  toAccountDto,
  toActivityDto,
  toFillDto,
  toMarketDto,
  toOrderDto,
  toPositionDto,
  toResolutionDto,
  toTradeDto,
} from './dto.js';
import {
  decodeActivityCursor,
  decodeMarketCursor,
  encodeActivityCursor,
  encodeMarketCursor,
} from './input.js';

export interface ListMarketsInput {
  phase?: string;
  creator?: string;
  limit: number;
  cursor?: string;
}

export async function listMarkets(
  prisma: PrismaClient,
  input: ListMarketsInput,
): Promise<ListMarketsResponse> {
  const cursor = input.cursor === undefined ? undefined : decodeMarketCursor(input.cursor);
  const where: Prisma.MarketWhereInput = {
    ...(input.phase === undefined ? {} : { phase: input.phase }),
    ...(input.creator === undefined ? {} : { creator: input.creator }),
    ...(cursor === undefined
      ? {}
      : {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        }),
  };
  const rows = await prisma.market.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: input.limit + 1,
  });
  const hasNextPage = rows.length > input.limit;
  const pageRows = rows.slice(0, input.limit);
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(toMarketDto),
    nextCursor:
      hasNextPage && last !== undefined
        ? encodeMarketCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  };
}

export async function getMarketDto(
  prisma: PrismaClient,
  marketId: string,
): Promise<ReturnType<typeof toMarketDto> | null> {
  const market = await prisma.market.findUnique({ where: { id: marketId } });
  return market === null ? null : toMarketDto(market);
}

export async function getMarketDetail(
  prisma: PrismaClient,
  marketId: string,
): Promise<MarketDetailResponse | null> {
  const market = await prisma.market.findUnique({
    where: { id: marketId },
    include: { resolution: true },
  });
  if (market === null) return null;
  const trades = await prisma.trade.findMany({
    where: { marketId },
    orderBy: [{ blockNumber: 'desc' }, { logIndex: 'desc' }],
    take: 50,
  });
  return {
    market: toMarketDto(market),
    recentTrades: trades.map(toTradeDto),
    resolution: market.resolution === null ? null : toResolutionDto(market.resolution),
  };
}

function compareRaw(left: string, right: string): number {
  const leftRaw = BigInt(left);
  const rightRaw = BigInt(right);
  return leftRaw < rightRaw ? -1 : leftRaw > rightRaw ? 1 : 0;
}

function buildLevels(orders: readonly DbOrder[], side: 'BID' | 'ASK') {
  const sizeByPrice = new Map<string, { sizeRaw: bigint; orderCount: number }>();
  for (const order of orders) {
    if (order.side !== side) continue;
    const current = sizeByPrice.get(order.priceRaw) ?? {
      sizeRaw: 0n,
      orderCount: 0,
    };
    current.sizeRaw += BigInt(order.remainingRaw);
    current.orderCount += 1;
    sizeByPrice.set(order.priceRaw, current);
  }
  return [...sizeByPrice.entries()]
    .map(([priceRaw, level]) => ({
      priceRaw,
      sizeRaw: level.sizeRaw.toString(),
      orderCount: level.orderCount,
    }))
    .sort((left, right) => {
      const ascending = compareRaw(left.priceRaw, right.priceRaw);
      return side === 'BID' ? -ascending : ascending;
    });
}

function buildOrderBook(
  marketId: string,
  outcome: 'YES' | 'NO',
  tokenId: string,
  rows: readonly DbOrder[],
): OrderBook {
  const orders = rows
    .filter((row) => row.tokenId === tokenId)
    .sort((left, right) => {
      if (left.side !== right.side) return left.side === 'BID' ? -1 : 1;
      const priceOrder = compareRaw(left.priceRaw, right.priceRaw);
      if (priceOrder !== 0) {
        return left.side === 'BID' ? -priceOrder : priceOrder;
      }
      return left.createdAt - right.createdAt || left.orderId.localeCompare(right.orderId);
    });
  return {
    marketId,
    outcome,
    tokenId,
    bids: buildLevels(orders, 'BID'),
    asks: buildLevels(orders, 'ASK'),
    orders: orders.map(toOrderDto),
  };
}

export async function getMarketBook(
  prisma: PrismaClient,
  marketId: string,
): Promise<MarketBookResponse | null> {
  const market = await prisma.market.findUnique({ where: { id: marketId } });
  if (market === null) return null;
  const orders = await prisma.order.findMany({
    where: { marketId, open: true },
  });
  return {
    marketId,
    yes: buildOrderBook(marketId, 'YES', market.yesTokenId ?? '', orders),
    no: buildOrderBook(marketId, 'NO', market.noTokenId ?? '', orders),
  };
}

export async function getOrderBook(
  prisma: PrismaClient,
  tokenId: string,
): Promise<OrderBookResponse | null> {
  const market = await prisma.market.findFirst({
    where: { OR: [{ yesTokenId: tokenId }, { noTokenId: tokenId }] },
  });
  if (market === null) return null;
  const outcome = market.yesTokenId === tokenId ? 'YES' : 'NO';
  const orders = await prisma.order.findMany({
    where: { tokenId, open: true },
  });
  return buildOrderBook(market.id, outcome, tokenId, orders);
}

export async function getPriceHistory(
  prisma: PrismaClient,
  marketId: string,
  fromTs: number | undefined,
  limit: number,
): Promise<PriceHistoryResponse | null> {
  const market = await prisma.market.findUnique({
    where: { id: marketId },
    select: { id: true },
  });
  if (market === null) return null;
  const points = await prisma.pricePoint.findMany({
    where: {
      marketId,
      ...(fromTs === undefined ? {} : { ts: { gte: fromTs } }),
    },
    orderBy: [{ ts: 'asc' }, { blockNumber: 'asc' }, { logIndex: 'asc' }],
    take: limit,
  });
  return {
    marketId,
    points: points.map((point) => ({
      ts: point.ts,
      yesPriceRaw: point.yesPriceRaw,
      noPriceRaw: point.noPriceRaw,
    })),
  };
}

export async function getAccount(
  prisma: PrismaClient,
  accountAddress: string,
): Promise<AccountResponse> {
  const [account, positionRows, tradeRows] = await Promise.all([
    prisma.account.findUnique({ where: { address: accountAddress } }),
    prisma.position.findMany({
      where: { account: accountAddress },
      include: { market: { include: { resolution: true } } },
      orderBy: [{ updatedAt: 'desc' }, { marketId: 'desc' }, { outcome: 'asc' }],
    }),
    prisma.trade.findMany({
      where: { account: accountAddress },
      orderBy: [{ blockNumber: 'desc' }, { logIndex: 'desc' }],
      take: 50,
    }),
  ]);
  const positions = positionRows.map(toPositionDto);
  return {
    account:
      account === null
        ? {
            address: accountAddress as `0x${string}`,
            firstSeenAt: 0,
            marketsCreated: 0,
            tradeCount: 0,
          }
        : toAccountDto(account),
    positions,
    recentTrades: tradeRows.map(toTradeDto),
    pnl: sumPnl(positions),
  };
}

export interface ListActivityInput {
  marketId?: string;
  account?: string;
  limit: number;
  cursor?: string;
}

export async function listActivity(
  prisma: PrismaClient,
  input: ListActivityInput,
): Promise<ActivityResponse> {
  const cursor =
    input.cursor === undefined ? undefined : decodeActivityCursor(input.cursor);
  const where: Prisma.ActivityEventWhereInput = {
    type: { in: [...ACTIVITY_TYPES] },
    ...(input.marketId === undefined ? {} : { marketId: input.marketId }),
    ...(input.account === undefined ? {} : { account: input.account }),
    ...(cursor === undefined
      ? {}
      : {
          OR: [
            { blockNumber: { lt: cursor.blockNumber } },
            {
              blockNumber: cursor.blockNumber,
              logIndex: { lt: cursor.logIndex },
            },
          ],
        }),
  };
  const rows = await prisma.activityEvent.findMany({
    where,
    orderBy: [{ blockNumber: 'desc' }, { logIndex: 'desc' }],
    take: input.limit + 1,
  });
  const hasNextPage = rows.length > input.limit;
  const pageRows = rows.slice(0, input.limit);
  const items = pageRows.flatMap((row) => {
    const dto = toActivityDto(row);
    return dto === null ? [] : [dto];
  });
  const last = pageRows.at(-1);
  return {
    items,
    nextCursor:
      hasNextPage && last !== undefined
        ? encodeActivityCursor({
            blockNumber: last.blockNumber,
            logIndex: last.logIndex,
          })
        : null,
  };
}

export async function getConfig(prisma: PrismaClient): Promise<ConfigResponse | null> {
  const [config, members] = await Promise.all([
    prisma.registryConfig.findUnique({ where: { id: 1 } }),
    prisma.committeeMember.findMany({
      where: { active: true },
      orderBy: { address: 'asc' },
    }),
  ]);
  if (config === null) return null;
  return {
    chainId: config.chainId,
    addresses: {
      usdc: config.usdcAddress as `0x${string}`,
      ctf: config.ctfAddress as `0x${string}`,
      oracle: config.oracleAddress as `0x${string}`,
      lmsr: config.currentLmsrAddress as `0x${string}`,
      registry: config.registryAddress as `0x${string}`,
      miniClob: config.miniClobAddress as `0x${string}`,
    },
    marketTypeVersion: config.marketTypeVersion,
    seedFloorRaw: config.seedFloorRaw,
    seedCapRaw: config.seedCapRaw,
    graduationTollRaw: config.graduationTollRaw,
    protocolFeeBps: config.protocolFeeBps,
    minTradingWindowSeconds: config.minTradingWindowSeconds,
    maxTradingWindowSeconds: config.maxTradingWindowSeconds,
    committee: {
      oracle: config.oracleAddress as `0x${string}`,
      signers: members.map((member) => member.address as `0x${string}`),
      threshold: config.committeeThreshold,
    },
  };
}

export async function getHealth(prisma: PrismaClient): Promise<HealthResponse> {
  const state = await prisma.indexerState.findUnique({ where: { id: 1 } });
  if (state === null) {
    return {
      ok: false,
      chainId: ARC.chainId,
      indexedBlock: 0,
      headBlock: 0,
      lagBlocks: 0,
    };
  }
  return {
    ok: state.lastBlock <= state.headBlock,
    chainId: state.chainId,
    indexedBlock: state.lastBlock,
    headBlock: state.headBlock,
    lagBlocks: Math.max(0, state.headBlock - state.lastBlock),
  };
}

export async function getTradeDto(
  prisma: PrismaClient,
  id: string,
): Promise<ReturnType<typeof toTradeDto> | null> {
  const trade: DbTrade | null = await prisma.trade.findUnique({ where: { id } });
  return trade === null ? null : toTradeDto(trade);
}

export async function getOrderDto(
  prisma: PrismaClient,
  orderId: string,
): Promise<ReturnType<typeof toOrderDto> | null> {
  const order: DbOrder | null = await prisma.order.findUnique({ where: { orderId } });
  return order === null ? null : toOrderDto(order);
}

export async function getFillDto(
  prisma: PrismaClient,
  id: string,
): Promise<ReturnType<typeof toFillDto> | null> {
  const fill: DbFill | null = await prisma.fill.findUnique({ where: { id } });
  return fill === null ? null : toFillDto(fill);
}

export async function getPositionDto(
  prisma: PrismaClient,
  account: string,
  marketId: string,
  outcome: string,
): Promise<ReturnType<typeof toPositionDto> | null> {
  const position = await prisma.position.findUnique({
    where: { account_marketId_outcome: { account, marketId, outcome } },
    include: { market: { include: { resolution: true } } },
  });
  return position === null ? null : toPositionDto(position);
}

export async function getResolutionForMarket(
  prisma: PrismaClient,
  marketId: string,
): Promise<ReturnType<typeof toResolutionDto> | null> {
  const resolution = await prisma.resolution.findUnique({ where: { marketId } });
  return resolution === null ? null : toResolutionDto(resolution);
}

export async function getActivityById(
  prisma: PrismaClient,
  id: string,
): Promise<ReturnType<typeof toActivityDto>> {
  const activity = await prisma.activityEvent.findUnique({ where: { id } });
  return activity === null ? null : toActivityDto(activity);
}

export async function getSeedOrders(
  prisma: PrismaClient,
  marketId: string,
): Promise<ReturnType<typeof toOrderDto>[]> {
  const orders = await prisma.order.findMany({
    where: { marketId, isSeed: true },
    orderBy: { orderId: 'asc' },
  });
  return orders.map(toOrderDto);
}

export async function findMarketForToken(
  prisma: PrismaClient,
  tokenId: string,
): Promise<{ market: DbMarket; outcome: 'YES' | 'NO' } | null> {
  const market = await prisma.market.findFirst({
    where: { OR: [{ yesTokenId: tokenId }, { noTokenId: tokenId }] },
  });
  if (market === null) return null;
  return {
    market,
    outcome: market.yesTokenId === tokenId ? 'YES' : 'NO',
  };
}
