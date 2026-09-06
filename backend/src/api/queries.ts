import { ARC } from '@predex-pump/shared';
import type {
  AccountResponse,
  ActivityResponse,
  ConfigResponse,
  DedupIndexHealth,
  ExchangeApprovalStateResponse,
  HealthResponse,
  IndexerHistoryGap,
  ListMarketsResponse,
  Market,
  MarketBookResponse,
  MarketDetailResponse,
  OrderBook,
  OrderBookWindow,
  OrderBookResponse,
  PriceHistoryResponse,
  ReadCacheHealth,
  TruthSignalResponse,
} from '@predex-pump/shared';
import {
  Prisma,
  type Fill as DbFill,
  type Market as DbMarket,
  type PrismaClient,
  type SignedOrder as DbSignedOrder,
} from '@prisma/client';

import { DEFAULT_INDEXER_STALL_MS } from '../config.js';
import { unavailableDedupIndexHealth } from '../dedup/health.js';
import {
  inspectChainStateRows,
  inspectPersistedChainState,
} from '../indexer/chain-state-bootstrap.js';
import {
  ACTIVE_ORDER_STATUSES,
  fillabilityForOrders,
  findActiveSignedOrderBookRows,
  findFillableSignedOrders,
  type PreloadedFillabilityMarketState,
  type SignedOrderBookRow,
} from '../orderbook/fillability.js';
import { toOffchainOrderDto } from '../orderbook/order.js';

import {
  ACTIVITY_TYPES,
  type ActivityDtoRow,
  type MarketDtoRow,
  type OrderDtoRow,
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
  decodePositionCursor,
  encodeActivityCursor,
  encodeMarketCursor,
  encodePositionCursor,
} from './input.js';
import { deriveTruthSignal } from './truth.js';

const MARKET_SELECT = {
  id: true,
  creator: true,
  question: true,
  phase: true,
  conditionId: true,
  questionId: true,
  yesTokenId: true,
  noTokenId: true,
  seedRaw: true,
  yesPriceRaw: true,
  noPriceRaw: true,
  graduationActivityRaw: true,
  bookAddress: true,
  frozenYesPriceRaw: true,
  handoffSizeRaw: true,
  tradeCount: true,
  volumeRaw: true,
  seedFloorRaw: true,
  seedCapRaw: true,
  fCapRaw: true,
  graduationThresholdRaw: true,
  graduationTollRaw: true,
  inventoryTargetRaw: true,
  protocolFeeBps: true,
  depthFeeBps: true,
  tradingWindowSeconds: true,
  minimumTimeOpenSeconds: true,
  minimumTickSizeRaw: true,
  createdAt: true,
  tradingEndsAt: true,
  graduatedAt: true,
  resolvedAt: true,
} as const satisfies Prisma.MarketSelect;

const TRADE_SELECT = {
  id: true,
  marketId: true,
  venue: true,
  account: true,
  outcome: true,
  side: true,
  sizeRaw: true,
  priceRaw: true,
  costRaw: true,
  feeRaw: true,
  txHash: true,
  logIndex: true,
  ts: true,
} as const satisfies Prisma.TradeSelect;

const ORDER_SELECT = {
  orderId: true,
  marketId: true,
  conditionId: true,
  tokenId: true,
  outcome: true,
  maker: true,
  side: true,
  priceRaw: true,
  sizeRaw: true,
  filledRaw: true,
  remainingRaw: true,
  open: true,
  isSeed: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.OrderSelect;

const ORDER_BOOK_SELECT = {
  orderId: true,
  tokenId: true,
  side: true,
  priceRaw: true,
  remainingRaw: true,
  createdAt: true,
} as const satisfies Prisma.OrderSelect;

type OrderBookRow = Prisma.OrderGetPayload<{
  select: typeof ORDER_BOOK_SELECT;
}>;

const POSITION_SELECT = {
  account: true,
  marketId: true,
  outcome: true,
  qtyRaw: true,
  costBasisRaw: true,
  realizedPnlRaw: true,
  unrealizedPnlRaw: true,
  updatedAt: true,
} as const satisfies Prisma.PositionSelect;

const ACTIVITY_SELECT = {
  id: true,
  type: true,
  marketId: true,
  account: true,
  outcome: true,
  side: true,
  amountRaw: true,
  priceRaw: true,
  txHash: true,
  blockNumber: true,
  logIndex: true,
  ts: true,
} as const satisfies Prisma.ActivityEventSelect;

function selectedColumns(select: Readonly<Record<string, true>>): Prisma.Sql {
  return Prisma.raw(
    Object.keys(select)
      .map((column) => `"${column}"`)
      .join(', '),
  );
}

const MARKET_COLUMNS_SQL = selectedColumns(MARKET_SELECT);
const ACTIVITY_COLUMNS_SQL = selectedColumns(ACTIVITY_SELECT);

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
  const rows: MarketDtoRow[] =
    cursor === undefined
      ? await prisma.market.findMany({
          where,
          select: MARKET_SELECT,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
        })
      : await prisma.$queryRaw<MarketDtoRow[]>(Prisma.sql`
          SELECT ${MARKET_COLUMNS_SQL}
          FROM "Market"
          WHERE
            ${
              input.phase === undefined
                ? Prisma.sql`TRUE`
                : Prisma.sql`"phase" = ${input.phase}`
            }
            AND ${
              input.creator === undefined
                ? Prisma.sql`TRUE`
                : Prisma.sql`"creator" = ${input.creator}`
            }
            AND ("createdAt", "id") < (${cursor.createdAt}, ${cursor.id})
          ORDER BY "createdAt" DESC, "id" DESC
          LIMIT ${input.limit + 1}
        `);
  const hasNextPage = rows.length > input.limit;
  const pageRows = rows.slice(0, input.limit);
  const resolutions = await prisma.resolution.findMany({
    where: { marketId: { in: pageRows.map((row) => row.id) } },
  });
  const resolutionByMarket = new Map(
    resolutions.map((resolution) => [resolution.marketId, resolution]),
  );
  const last = pageRows.at(-1);
  return {
    items: pageRows.map((market) =>
      toMarketDto({
        ...market,
        resolution: resolutionByMarket.get(market.id) ?? null,
      }),
    ),
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
  const market = await prisma.market.findUnique({
    where: { id: marketId },
    select: { ...MARKET_SELECT, resolution: true },
  });
  return market === null ? null : toMarketDto(market);
}

/** Resolve indexed markets while preserving the caller's recency/order semantics. */
export async function getMarketsByIds(
  prisma: PrismaClient,
  marketIds: readonly string[],
): Promise<Market[]> {
  if (marketIds.length === 0) return [];
  const rows = await prisma.market.findMany({
    where: { id: { in: [...new Set(marketIds)] } },
    select: { ...MARKET_SELECT, resolution: true },
  });
  const byId = new Map(rows.map((row) => [row.id, toMarketDto(row)]));
  return marketIds.flatMap((id) => {
    const market = byId.get(id);
    return market === undefined ? [] : [market];
  });
}

export async function getMarketDetail(
  prisma: PrismaClient,
  marketId: string,
): Promise<MarketDetailResponse | null> {
  const [market, trades, settlementEvents] = await Promise.all([
    prisma.market.findUnique({
      where: { id: marketId },
      select: { ...MARKET_SELECT, resolution: true },
    }),
    prisma.trade.findMany({
      where: { marketId },
      select: TRADE_SELECT,
      orderBy: [{ blockNumber: 'desc' }, { logIndex: 'desc' }],
      take: 50,
    }),
    prisma.activityEvent.findMany({
      where: {
        marketId,
        source: 'LMSR',
        eventName: 'ProtocolFeeSwept',
      },
      select: { data: true },
    }),
  ]);
  if (market === null) return null;
  let protocolSweepCompleted = false;
  let protocolSweptRaw = 0n;
  for (const event of settlementEvents) {
    if (
      typeof event.data !== 'object' ||
      event.data === null ||
      Array.isArray(event.data)
    ) {
      continue;
    }
    const amountRaw = event.data.amountRaw;
    if (typeof amountRaw === 'string' && /^\d+$/u.test(amountRaw)) {
      protocolSweptRaw += BigInt(amountRaw);
    }
    protocolSweepCompleted =
      protocolSweepCompleted || event.data.closeoutComplete === true;
  }
  return {
    market: toMarketDto(market),
    recentTrades: trades.map(toTradeDto),
    resolution: market.resolution === null ? null : toResolutionDto(market.resolution),
    settlementEvents: {
      protocolSweepCompleted,
      protocolSweptRaw: protocolSweptRaw.toString(),
    },
  };
}

function compareRaw(left: string, right: string): number {
  const leftRaw = BigInt(left);
  const rightRaw = BigInt(right);
  return leftRaw < rightRaw ? -1 : leftRaw > rightRaw ? 1 : 0;
}

interface LevelOrder {
  tokenId: string;
  side: string;
  priceRaw: string;
  remainingRaw: string;
}

interface PriceTimeOrder extends LevelOrder {
  createdAt: number;
}

function comparePriceTime<T extends PriceTimeOrder>(
  left: T,
  right: T,
  identity: (row: T) => string,
  identityKind: 'DECIMAL' | 'LEXICAL',
): number {
  if (left.side !== right.side) return left.side === 'BID' ? -1 : 1;
  const priceOrder = compareRaw(left.priceRaw, right.priceRaw);
  if (priceOrder !== 0) {
    return left.side === 'BID' ? -priceOrder : priceOrder;
  }
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  return identityKind === 'DECIMAL'
    ? compareRaw(identity(left), identity(right))
    : identity(left).localeCompare(identity(right));
}

interface BoundedBookRows<T> {
  visible: T[];
  truncatedTokenIds: Set<string>;
}

function sortedPriceTimeGroups<T extends PriceTimeOrder>(
  rows: readonly T[],
  identity: (row: T) => string,
  identityKind: 'DECIMAL' | 'LEXICAL',
): T[][] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = `${row.tokenId}:${row.side}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) =>
    group.sort((left, right) =>
      comparePriceTime(left, right, identity, identityKind),
    ),
  );
}

function boundedBestRows<T extends PriceTimeOrder>(
  rows: readonly T[],
  limitPerSide: number,
  identity: (row: T) => string,
  identityKind: 'DECIMAL' | 'LEXICAL',
): BoundedBookRows<T> {
  const visible: T[] = [];
  const truncatedTokenIds = new Set<string>();
  for (const group of sortedPriceTimeGroups(rows, identity, identityKind)) {
    visible.push(...group.slice(0, limitPerSide));
    const tokenId = group[0]?.tokenId;
    if (tokenId !== undefined && group.length > limitPerSide) {
      truncatedTokenIds.add(tokenId);
    }
  }
  return { visible, truncatedTokenIds };
}

async function boundedFillableSignedRows(
  prisma: Prisma.TransactionClient,
  rows: readonly SignedOrderBookRow[],
  orderLimitPerSide: number,
  now: number,
  preloadedMarketStates: readonly PreloadedFillabilityMarketState[],
): Promise<BoundedBookRows<SignedOrderBookRow>> {
  const groups = sortedPriceTimeGroups(
    rows,
    (row) => row.orderHash,
    'LEXICAL',
  ).map((group) => ({ group, next: 0, fillable: [] as SignedOrderBookRow[] }));
  const batchSize = orderLimitPerSide + 1;

  while (true) {
    const batches = groups.flatMap((state) => {
      if (
        state.fillable.length >= batchSize ||
        state.next >= state.group.length
      ) {
        return [];
      }
      const candidates = state.group.slice(state.next, state.next + batchSize);
      state.next += candidates.length;
      return [{ state, candidates }];
    });
    if (batches.length === 0) break;
    const fillability = await fillabilityForOrders(
      prisma,
      batches.flatMap(({ candidates }) => candidates),
      now,
      preloadedMarketStates,
    );
    for (const { state, candidates } of batches) {
      for (const candidate of candidates) {
        if (
          state.fillable.length < batchSize &&
          fillability.get(candidate.orderHash)?.fillable === true
        ) {
          state.fillable.push(candidate);
        }
      }
    }
  }

  const visible: SignedOrderBookRow[] = [];
  const truncatedTokenIds = new Set<string>();
  for (const state of groups) {
    visible.push(...state.fillable.slice(0, orderLimitPerSide));
    const tokenId = state.group[0]?.tokenId;
    if (tokenId !== undefined && state.fillable.length > orderLimitPerSide) {
      truncatedTokenIds.add(tokenId);
    }
  }
  return { visible, truncatedTokenIds };
}

function buildLevels(orders: readonly LevelOrder[], side: 'BID' | 'ASK') {
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
  minimumTickSizeRaw: string,
  outcome: 'YES' | 'NO',
  tokenId: string,
  levelOrders: readonly LevelOrder[],
  levelSignedOrders: readonly LevelOrder[],
  wireOrders: readonly OrderDtoRow[],
  wireSignedOrders: readonly DbSignedOrder[],
  orderLimitPerSide?: number,
  truncatedOrderTokenIds: ReadonlySet<string> = new Set(),
  truncatedSignedTokenIds: ReadonlySet<string> = new Set(),
): OrderBook {
  const activeOrders = levelOrders.filter((row) => row.tokenId === tokenId);
  const orders = wireOrders
    .filter((row) => row.tokenId === tokenId)
    .sort((left, right) =>
      comparePriceTime(left, right, (row) => row.orderId, 'DECIMAL'),
    );
  const activeSignedOrders = levelSignedOrders.filter(
    (row) => row.tokenId === tokenId,
  );
  const offchainOrders = wireSignedOrders
    .filter((row) => row.tokenId === tokenId)
    .sort((left, right) =>
      comparePriceTime(left, right, (row) => row.orderHash, 'LEXICAL'),
    );
  const bids = buildLevels([...activeOrders, ...activeSignedOrders], 'BID');
  const asks = buildLevels([...activeOrders, ...activeSignedOrders], 'ASK');
  const orderWindow: OrderBookWindow | undefined =
    orderLimitPerSide === undefined
      ? undefined
      : {
          limitPerSide: orderLimitPerSide,
          orders: {
            returned: orders.length,
            truncated: truncatedOrderTokenIds.has(tokenId),
          },
          offchainOrders: {
            returned: offchainOrders.length,
            truncated: truncatedSignedTokenIds.has(tokenId),
          },
        };
  return {
    marketId,
    minimumTickSizeRaw,
    outcome,
    tokenId,
    bids,
    asks,
    bestBidRaw: bids[0]?.priceRaw ?? null,
    bestAskRaw: asks[0]?.priceRaw ?? null,
    orders: orders.map(toOrderDto),
    offchainOrders: offchainOrders.map((order) =>
      toOffchainOrderDto(order, { fillable: true, reason: null }),
    ),
    ...(orderWindow === undefined ? {} : { orderWindow }),
  };
}

async function hydrateBoundedMiniOrders(
  prisma: Prisma.TransactionClient,
  rows: readonly OrderBookRow[],
): Promise<OrderDtoRow[]> {
  const orderIds = rows.map((row) => row.orderId);
  if (orderIds.length === 0) return [];
  return prisma.order.findMany({
    where: { orderId: { in: orderIds }, open: true },
    select: ORDER_SELECT,
  });
}

async function hydrateBoundedSignedOrders(
  prisma: Prisma.TransactionClient,
  rows: readonly SignedOrderBookRow[],
): Promise<DbSignedOrder[]> {
  const orderHashes = rows.map((row) => row.orderHash);
  if (orderHashes.length === 0) return [];
  return prisma.signedOrder.findMany({
    where: {
      orderHash: { in: orderHashes },
      status: { in: [...ACTIVE_ORDER_STATUSES] },
      withdrawnAt: null,
    },
  });
}

async function getMarketBookSnapshot(
  prisma: Prisma.TransactionClient,
  marketId: string,
  now = Math.floor(Date.now() / 1_000),
  orderLimitPerSide?: number,
): Promise<MarketBookResponse | null> {
  const market = await prisma.market.findUnique({
    where: { id: marketId },
    select: {
      id: true,
      yesTokenId: true,
      noTokenId: true,
      phase: true,
      bookAddress: true,
      graduatedAt: true,
      resolvedAt: true,
      tradingEndsAt: true,
      minimumTickSizeRaw: true,
      bookMigration: { select: { status: true, lastFailureCode: true } },
    },
  });
  if (market === null) return null;
  const tradingOpen =
    (market.phase === 'Opened' || market.phase === 'Graduated') &&
    market.resolvedAt === null &&
    now < market.tradingEndsAt;

  const hasLiveGraduatedBook =
    market.phase === 'Graduated' &&
    market.resolvedAt === null &&
    market.bookAddress !== null &&
    market.graduatedAt !== null;
  if (!hasLiveGraduatedBook) {
    const liveVenue =
      market.phase === 'Opened' && tradingOpen ? 'LMSR' : 'NONE';
    return {
      marketId,
      tradingOpen,
      minimumTickSizeRaw: market.minimumTickSizeRaw,
      minimumTickSizeAppliesTo: 'NEW_ORDERS',
      orderBookAvailable: false,
      liveVenue,
      yes: buildOrderBook(
        marketId,
        market.minimumTickSizeRaw,
        'YES',
        market.yesTokenId ?? '',
        [],
        [],
        [],
        [],
        orderLimitPerSide,
      ),
      no: buildOrderBook(
        marketId,
        market.minimumTickSizeRaw,
        'NO',
        market.noTokenId ?? '',
        [],
        [],
        [],
        [],
        orderLimitPerSide,
      ),
    };
  }

  if (
    market.bookMigration !== null &&
    market.bookMigration.status !== 'MIGRATED'
  ) {
    return {
      marketId,
      tradingOpen,
      minimumTickSizeRaw: market.minimumTickSizeRaw,
      minimumTickSizeAppliesTo: 'NEW_ORDERS',
      orderBookAvailable: false,
      liveVenue: 'NONE',
      venueTransition:
        market.bookMigration.status === 'FAILED'
          ? {
              state: 'FAILED',
              failureCode: market.bookMigration.lastFailureCode,
            }
          : { state: 'PREPARING' },
      yes: buildOrderBook(
        marketId,
        market.minimumTickSizeRaw,
        'YES',
        market.yesTokenId ?? '',
        [],
        [],
        [],
        [],
        orderLimitPerSide,
      ),
      no: buildOrderBook(
        marketId,
        market.minimumTickSizeRaw,
        'NO',
        market.noTokenId ?? '',
        [],
        [],
        [],
        [],
        orderLimitPerSide,
      ),
    };
  }

  const liveVenue =
    market.bookMigration?.status === 'MIGRATED' ? 'HYBRID' : 'MINICLOB';
  const responseOrderLimitPerSide =
    liveVenue === 'MINICLOB' && !tradingOpen
      ? undefined
      : orderLimitPerSide;
  const fillabilityMarketStates = [
    {
      id: market.id,
      tradingEndsAt: market.tradingEndsAt,
      resolvedAt: market.resolvedAt,
    },
  ];
  let miniLevelRows: readonly LevelOrder[] = [];
  let miniWireRows: OrderDtoRow[] = [];
  let truncatedMiniTokenIds: ReadonlySet<string> = new Set();
  let signedLevelRows: readonly LevelOrder[] = [];
  let signedWireRows: DbSignedOrder[] = [];
  let truncatedSignedTokenIds: ReadonlySet<string> = new Set();
  if (liveVenue === 'HYBRID' && tradingOpen) {
    if (orderLimitPerSide === undefined) {
      const rows = await findFillableSignedOrders(prisma, { marketId }, now);
      signedLevelRows = rows;
      signedWireRows = rows;
    } else {
      const candidates = await findActiveSignedOrderBookRows(
        prisma,
        { marketId },
      );
      const window = await boundedFillableSignedRows(
        prisma,
        candidates,
        orderLimitPerSide,
        now,
        fillabilityMarketStates,
      );
      signedLevelRows = window.visible;
      truncatedSignedTokenIds = window.truncatedTokenIds;
      signedWireRows = await hydrateBoundedSignedOrders(
        prisma,
        window.visible,
      );
    }
  } else if (liveVenue === 'MINICLOB') {
    if (orderLimitPerSide === undefined || !tradingOpen) {
      const rows = await prisma.order.findMany({
        where: { marketId, open: true },
        select: ORDER_SELECT,
      });
      miniLevelRows = tradingOpen ? rows : [];
      miniWireRows = rows;
    } else {
      const rows = await prisma.order.findMany({
        where: { marketId, open: true },
        select: ORDER_BOOK_SELECT,
      });
      const window = boundedBestRows(
        rows,
        orderLimitPerSide,
        (row) => row.orderId,
        'DECIMAL',
      );
      miniLevelRows = window.visible;
      truncatedMiniTokenIds = window.truncatedTokenIds;
      miniWireRows = await hydrateBoundedMiniOrders(
        prisma,
        window.visible,
      );
    }
  }
  return {
    marketId,
    tradingOpen,
    minimumTickSizeRaw: market.minimumTickSizeRaw,
    minimumTickSizeAppliesTo: 'NEW_ORDERS',
    orderBookAvailable: true,
    liveVenue,
    yes: buildOrderBook(
      marketId,
      market.minimumTickSizeRaw,
      'YES',
      market.yesTokenId ?? '',
      miniLevelRows,
      signedLevelRows,
      miniWireRows,
      signedWireRows,
      responseOrderLimitPerSide,
      truncatedMiniTokenIds,
      truncatedSignedTokenIds,
    ),
    no: buildOrderBook(
      marketId,
      market.minimumTickSizeRaw,
      'NO',
      market.noTokenId ?? '',
      miniLevelRows,
      signedLevelRows,
      miniWireRows,
      signedWireRows,
      responseOrderLimitPerSide,
      truncatedMiniTokenIds,
      truncatedSignedTokenIds,
    ),
  };
}

export async function getMarketBook(
  prisma: PrismaClient,
  marketId: string,
  now = Math.floor(Date.now() / 1_000),
  orderLimitPerSide?: number,
): Promise<MarketBookResponse | null> {
  if (orderLimitPerSide === undefined) {
    return getMarketBookSnapshot(prisma, marketId, now);
  }
  // The visible levels and bounded full DTOs must describe one database view.
  return prisma.$transaction(
    (transaction) =>
      getMarketBookSnapshot(
        transaction,
        marketId,
        now,
        orderLimitPerSide,
      ),
    { isolationLevel: 'RepeatableRead' },
  );
}

async function getOrderBookSnapshot(
  prisma: Prisma.TransactionClient,
  tokenId: string,
  now = Math.floor(Date.now() / 1_000),
  orderLimitPerSide?: number,
): Promise<OrderBookResponse | null> {
  const market = await prisma.market.findFirst({
    where: { OR: [{ yesTokenId: tokenId }, { noTokenId: tokenId }] },
    select: {
      id: true,
      yesTokenId: true,
      noTokenId: true,
      minimumTickSizeRaw: true,
      phase: true,
      tradingEndsAt: true,
      resolvedAt: true,
      bookMigration: { select: { status: true } },
    },
  });
  if (market === null) return null;
  const outcome = market.yesTokenId === tokenId ? 'YES' : 'NO';
  const tradingOpen =
    (market.phase === 'Opened' || market.phase === 'Graduated') &&
    market.resolvedAt === null &&
    now < market.tradingEndsAt;
  const hybrid = market.bookMigration?.status === 'MIGRATED';
  const transitioning = market.bookMigration !== null && !hybrid;
  const fillabilityMarketStates = [
    {
      id: market.id,
      tradingEndsAt: market.tradingEndsAt,
      resolvedAt: market.resolvedAt,
    },
  ];
  let miniLevelRows: readonly LevelOrder[] = [];
  let miniWireRows: OrderDtoRow[] = [];
  let truncatedMiniTokenIds: ReadonlySet<string> = new Set();
  let signedLevelRows: readonly LevelOrder[] = [];
  let signedWireRows: DbSignedOrder[] = [];
  let truncatedSignedTokenIds: ReadonlySet<string> = new Set();
  if (tradingOpen && !hybrid && !transitioning) {
    if (orderLimitPerSide === undefined) {
      const rows = await prisma.order.findMany({
        where: { tokenId, open: true },
        select: ORDER_SELECT,
      });
      miniLevelRows = rows;
      miniWireRows = rows;
    } else {
      const rows = await prisma.order.findMany({
        where: { tokenId, open: true },
        select: ORDER_BOOK_SELECT,
      });
      const window = boundedBestRows(
        rows,
        orderLimitPerSide,
        (row) => row.orderId,
        'DECIMAL',
      );
      miniLevelRows = window.visible;
      truncatedMiniTokenIds = window.truncatedTokenIds;
      miniWireRows = await hydrateBoundedMiniOrders(
        prisma,
        window.visible,
      );
    }
  } else if (hybrid && tradingOpen) {
    if (orderLimitPerSide === undefined) {
      const rows = await findFillableSignedOrders(prisma, { tokenId }, now);
      signedLevelRows = rows;
      signedWireRows = rows;
    } else {
      const candidates = await findActiveSignedOrderBookRows(
        prisma,
        { tokenId },
      );
      const window = await boundedFillableSignedRows(
        prisma,
        candidates,
        orderLimitPerSide,
        now,
        fillabilityMarketStates,
      );
      signedLevelRows = window.visible;
      truncatedSignedTokenIds = window.truncatedTokenIds;
      signedWireRows = await hydrateBoundedSignedOrders(
        prisma,
        window.visible,
      );
    }
  }
  return buildOrderBook(
    market.id,
    market.minimumTickSizeRaw,
    outcome,
    tokenId,
    miniLevelRows,
    signedLevelRows,
    miniWireRows,
    signedWireRows,
    orderLimitPerSide,
    truncatedMiniTokenIds,
    truncatedSignedTokenIds,
  );
}

export async function getOrderBook(
  prisma: PrismaClient,
  tokenId: string,
  now = Math.floor(Date.now() / 1_000),
  orderLimitPerSide?: number,
): Promise<OrderBookResponse | null> {
  if (orderLimitPerSide === undefined) {
    return getOrderBookSnapshot(prisma, tokenId, now);
  }
  // The visible levels and bounded full DTOs must describe one database view.
  return prisma.$transaction(
    (transaction) =>
      getOrderBookSnapshot(
        transaction,
        tokenId,
        now,
        orderLimitPerSide,
      ),
    { isolationLevel: 'RepeatableRead' },
  );
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
    select: { ts: true, yesPriceRaw: true, noPriceRaw: true },
    orderBy:
      fromTs === undefined
        ? [{ ts: 'desc' }, { blockNumber: 'desc' }, { logIndex: 'desc' }]
        : [{ ts: 'asc' }, { blockNumber: 'asc' }, { logIndex: 'asc' }],
    take: limit,
  });
  if (fromTs === undefined) points.reverse();
  return {
    marketId,
    points: points.map((point) => ({
      ts: point.ts,
      yesPriceRaw: point.yesPriceRaw,
      noPriceRaw: point.noPriceRaw,
    })),
  };
}

export async function getTruthSignal(
  prisma: PrismaClient,
  marketId: string,
): Promise<TruthSignalResponse | null> {
  const market = await getMarketDto(prisma, marketId);
  if (market === null) return null;
  const [book, recentPriceRows] = await Promise.all([
    getMarketBook(prisma, marketId),
    prisma.pricePoint.findMany({
      where: { marketId },
      select: { ts: true, yesPriceRaw: true, noPriceRaw: true },
      orderBy: [{ ts: 'desc' }, { blockNumber: 'desc' }, { logIndex: 'desc' }],
      take: 8,
    }),
  ]);
  if (book === null) return null;
  return deriveTruthSignal({
    market,
    book,
    recentPrices: recentPriceRows.reverse(),
  });
}

export interface GetAccountInput {
  marketId?: string;
  positionsLimit?: number;
  positionsCursor?: string;
}

export async function getAccount(
  prisma: PrismaClient,
  accountAddress: string,
  input: GetAccountInput = {},
): Promise<AccountResponse> {
  const positionCursor =
    input.positionsCursor === undefined
      ? undefined
      : decodePositionCursor(input.positionsCursor);
  const positionsLimit =
    input.positionsLimit ?? (positionCursor === undefined ? undefined : 100);
  const [account, positionRows, tradeRows] = await Promise.all([
    prisma.account.findUnique({
      where: { address: accountAddress },
      select: {
        address: true,
        firstSeenAt: true,
        marketsCreated: true,
        tradeCount: true,
        realizedPnlRaw: true,
        unrealizedPnlRaw: true,
      },
    }),
    prisma.position.findMany({
      where: {
        account: accountAddress,
        ...(input.marketId === undefined ? {} : { marketId: input.marketId }),
        ...(positionCursor === undefined
          ? {}
          : {
              OR: [
                { updatedAt: { lt: positionCursor.updatedAt } },
                {
                  updatedAt: positionCursor.updatedAt,
                  marketId: { lt: positionCursor.marketId },
                },
                {
                  updatedAt: positionCursor.updatedAt,
                  marketId: positionCursor.marketId,
                  outcome: { gt: positionCursor.outcome },
                },
              ],
            }),
      },
      select: POSITION_SELECT,
      orderBy: [{ updatedAt: 'desc' }, { marketId: 'desc' }, { outcome: 'asc' }],
      ...(positionsLimit === undefined ? {} : { take: positionsLimit + 1 }),
    }),
    prisma.trade.findMany({
      where: { account: accountAddress },
      select: TRADE_SELECT,
      orderBy: [{ blockNumber: 'desc' }, { logIndex: 'desc' }],
      take: 50,
    }),
  ]);
  const hasNextPositionsPage =
    positionsLimit !== undefined && positionRows.length > positionsLimit;
  const positionsPage =
    positionsLimit === undefined
      ? positionRows
      : positionRows.slice(0, positionsLimit);
  const positions = positionsPage.map(toPositionDto);
  const lastPosition = positionsPage.at(-1);
  const positionsNextCursor =
    positionsLimit === undefined
      ? undefined
      : hasNextPositionsPage && lastPosition !== undefined
        ? encodePositionCursor({
            updatedAt: lastPosition.updatedAt,
            marketId: lastPosition.marketId,
            outcome: lastPosition.outcome as 'YES' | 'NO',
          })
        : null;
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
    pnl:
      account === null
        ? { realizedRaw: '0', unrealizedRaw: '0' }
        : {
            realizedRaw: account.realizedPnlRaw,
            unrealizedRaw: account.unrealizedPnlRaw,
          },
    ...(positionsNextCursor === undefined ? {} : { positionsNextCursor }),
  };
}

export async function getExchangeApprovalState(
  prisma: PrismaClient,
  owner: string,
): Promise<ExchangeApprovalStateResponse> {
  const [ctfApproval, collateralApproval] = await Promise.all([
    prisma.ctfExchangeApproval.findUnique({ where: { owner } }),
    prisma.collateralExchangeApproval.findUnique({ where: { owner } }),
  ]);
  return {
    owner: owner as `0x${string}`,
    ctfApprovedForAll: ctfApproval?.approved ?? false,
    collateralAllowanceRaw: collateralApproval?.allowanceRaw ?? '0',
    ctfUpdatedAt: ctfApproval?.updatedAt ?? null,
    collateralUpdatedAt: collateralApproval?.updatedAt ?? null,
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
  const rows: ActivityDtoRow[] =
    cursor === undefined
      ? await prisma.activityEvent.findMany({
          where,
          select: ACTIVITY_SELECT,
          orderBy: [{ blockNumber: 'desc' }, { logIndex: 'desc' }],
          take: input.limit + 1,
        })
      : await prisma.$queryRaw<ActivityDtoRow[]>(Prisma.sql`
          SELECT ${ACTIVITY_COLUMNS_SQL}
          FROM "ActivityEvent"
          WHERE
            "type" IN (${Prisma.join([...ACTIVITY_TYPES])})
            AND ${
              input.marketId === undefined
                ? Prisma.sql`TRUE`
                : Prisma.sql`"marketId" = ${input.marketId}`
            }
            AND ${
              input.account === undefined
                ? Prisma.sql`TRUE`
                : Prisma.sql`"account" = ${input.account}`
            }
            AND ("blockNumber", "logIndex") <
              (${cursor.blockNumber}, ${cursor.logIndex})
          ORDER BY "blockNumber" DESC, "logIndex" DESC
          LIMIT ${input.limit + 1}
        `);
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
  const [config, members, marketTypes] = await Promise.all([
    prisma.registryConfig.findUnique({ where: { id: 1 } }),
    prisma.committeeMember.findMany({
      where: { active: true },
      select: { address: true, active: true },
      orderBy: { address: 'asc' },
    }),
    prisma.registeredMarketType.findMany({
      select: { version: true, lmsrAddress: true, configHash: true },
    }),
  ]);
  if (!inspectChainStateRows(config, members, marketTypes).ready || config === null) {
    return null;
  }
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

export function createCachedConfigReader(
  prisma: PrismaClient,
  ttlMs = 5_000,
): () => Promise<ConfigResponse | null> {
  let cached: { value: ConfigResponse; expiresAt: number } | null = null;
  let pending: Promise<ConfigResponse | null> | null = null;

  return async () => {
    const now = Date.now();
    if (cached !== null && cached.expiresAt > now) return cached.value;
    if (pending !== null) return pending;

    pending = getConfig(prisma)
      .then((value) => {
        if (value !== null) {
          cached = { value, expiresAt: Date.now() + ttlMs };
        }
        return value;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}

const DISABLED_READ_CACHE_HEALTH: ReadCacheHealth = {
  status: 'disabled',
  hits: 0,
  misses: 0,
  errors: 0,
  invalidations: 0,
};

export async function getHealth(
  prisma: PrismaClient,
  stallAfterMs = DEFAULT_INDEXER_STALL_MS,
  now = new Date(),
  dedupIndex: DedupIndexHealth = unavailableDedupIndexHealth(
    'fallback',
    'Dedup index health reader is not configured',
  ),
  readCache: ReadCacheHealth = DISABLED_READ_CACHE_HEALTH,
): Promise<HealthResponse> {
  const [state, subscription, gaps, persistedChainState] = await Promise.all([
    prisma.indexerState.findUnique({ where: { id: 1 } }),
    prisma.indexerSubscriptionState.findUnique({ where: { id: 1 } }),
    prisma.indexerGap.findMany({
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
    }),
    inspectPersistedChainState(prisma),
  ]);
  const historyGaps: IndexerHistoryGap[] = gaps.map((gap) => ({
    skippedFromBlock: gap.skippedFromBlock,
    skippedToBlock: gap.skippedToBlock,
    skippedBlockCount: gap.skippedBlockCount,
    cursorBefore: gap.cursorBefore,
    cursorAfter: gap.cursorAfter,
    headBlock: gap.headBlock,
    startPolicy: gap.startPolicy as IndexerHistoryGap['startPolicy'],
    reason: gap.reason as IndexerHistoryGap['reason'],
    maxBackfillBlocks: gap.maxBackfillBlocks,
    recordedAt: gap.recordedAt.toISOString(),
    balanceReconciliationStatus:
      gap.balanceReconciliationStatus.toLowerCase() as IndexerHistoryGap['balanceReconciliationStatus'],
    balanceReconciliationBlock: gap.balanceReconciliationBlock,
    balanceReconciliationAttemptedAt:
      gap.balanceReconciliationAttemptedAt?.toISOString() ?? null,
    balanceReconciledAt: gap.balanceReconciledAt?.toISOString() ?? null,
    balanceReconciliationError: gap.balanceReconciliationError,
  }));
  const unreconciledBalanceGapCount = historyGaps.filter(
    (gap) => gap.balanceReconciliationStatus !== 'complete',
  ).length;
  const balancesReconciled = unreconciledBalanceGapCount === 0;
  const bootstrapStatus =
    state?.chainStateBootstrapStatus.toLowerCase() === 'complete'
      ? 'complete'
      : state?.chainStateBootstrapStatus.toLowerCase() === 'failed'
        ? 'failed'
        : 'pending';
  const chainState = {
    ready: persistedChainState.ready && bootstrapStatus === 'complete',
    status: bootstrapStatus,
    attemptedBlock: state?.chainStateBootstrapAttemptedBlock ?? null,
    snapshotBlock: state?.chainStateBootstrapBlock ?? null,
    rpcRequestCount: state?.chainStateBootstrapRpcRequestCount ?? 0,
    attemptedAt: state?.chainStateBootstrapAttemptedAt?.toISOString() ?? null,
    completedAt: state?.chainStateBootstrappedAt?.toISOString() ?? null,
    error: state?.chainStateBootstrapError ?? null,
    issues: persistedChainState.issues,
  } as const;
  if (state === null) {
    return {
      ok: false,
      chainId: ARC.chainId,
      indexedBlock: 0,
      headBlock: 0,
      lagBlocks: 0,
      indexerStatus: 'stalled',
      lastSuccessfulPollAt: null,
      secondsSinceLastSuccessfulPoll: null,
      balancesReconciled,
      unreconciledBalanceGapCount,
      chainState,
      dedupIndex,
      readCache,
      historyGaps,
    };
  }
  const lastSuccessfulLivenessAt =
    subscription?.status === 'connected'
      ? (subscription.lastMessageAt ?? state.lastSuccessfulPollAt)
      : state.lastSuccessfulPollAt;
  const millisecondsSinceLastSuccessfulPoll =
    lastSuccessfulLivenessAt === null
      ? null
      : Math.max(0, now.getTime() - lastSuccessfulLivenessAt.getTime());
  const secondsSinceLastSuccessfulPoll =
    millisecondsSinceLastSuccessfulPoll === null
      ? null
      : Math.floor(millisecondsSinceLastSuccessfulPoll / 1_000);
  const stalled =
    millisecondsSinceLastSuccessfulPoll === null ||
    millisecondsSinceLastSuccessfulPoll > stallAfterMs;
  const indexerStatus = stalled
    ? 'stalled'
    : historyGaps.length > 0 ||
        !chainState.ready ||
        state.consecutiveRpcFailures > 0 ||
        subscription?.status !== 'connected'
      ? 'degraded'
      : 'healthy';
  const headBlock = Math.max(
    state.headBlock,
    subscription?.headBlock ?? state.headBlock,
  );
  return {
    ok:
      !stalled &&
      state.lastBlock <= headBlock &&
      balancesReconciled &&
      chainState.ready,
    chainId: state.chainId,
    indexedBlock: state.lastBlock,
    headBlock,
    lagBlocks: Math.max(0, headBlock - state.lastBlock),
    indexerStatus,
    lastSuccessfulPollAt: lastSuccessfulLivenessAt?.toISOString() ?? null,
    secondsSinceLastSuccessfulPoll,
    balancesReconciled,
    unreconciledBalanceGapCount,
    chainState,
    dedupIndex,
    readCache,
    historyGaps,
  };
}

export async function getTradeDto(
  prisma: PrismaClient,
  id: string,
): Promise<ReturnType<typeof toTradeDto> | null> {
  const trade = await prisma.trade.findUnique({
    where: { id },
    select: TRADE_SELECT,
  });
  return trade === null ? null : toTradeDto(trade);
}

export async function getOrderDto(
  prisma: PrismaClient,
  orderId: string,
): Promise<ReturnType<typeof toOrderDto> | null> {
  const order = await prisma.order.findUnique({
    where: { orderId },
    select: ORDER_SELECT,
  });
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
    select: POSITION_SELECT,
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
    select: ORDER_SELECT,
    orderBy: { orderId: 'asc' },
  });
  return orders.map(toOrderDto);
}

export async function findMarketForToken(
  prisma: PrismaClient,
  tokenId: string,
): Promise<{
  market: Pick<DbMarket, 'id' | 'yesTokenId' | 'noTokenId'>;
  outcome: 'YES' | 'NO';
} | null> {
  const market = await prisma.market.findFirst({
    where: { OR: [{ yesTokenId: tokenId }, { noTokenId: tokenId }] },
    select: { id: true, yesTokenId: true, noTokenId: true },
  });
  if (market === null) return null;
  return {
    market,
    outcome: market.yesTokenId === tokenId ? 'YES' : 'NO',
  };
}
