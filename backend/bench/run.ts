import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { resolve } from 'node:path';

import { ADDRESSES, type ServerEvent } from '@predex-pump/shared';
import type { PrismaClient } from '@prisma/client';
import type { Address, Hex } from 'viem';
import { WebSocket } from 'ws';

import { buildServer } from '../src/api/server.js';
import { createNodeRedisPublicJsonReadCache } from '../src/cache/node-redis.js';
import { loadRuntimeConfig } from '../src/config.js';
import { ServerEventBus } from '../src/events/bus.js';
import { applyDecodedEvents } from '../src/indexer/runner.js';
import type { DecodedEvent } from '../src/indexer/types.js';
import { resolveBenchmarkProvenance } from './provenance.js';
import {
  address,
  benchDatabaseUrl,
  benchSchema,
  hash,
  makePrisma,
  positiveFlag,
  readFlag,
} from './support.js';

const BASE_TS = 1_750_000_000;
const BASE_BLOCK = 60_000_000;
const INGEST_MARKET_ID = '9000000000000000000';
const INGEST_ACCOUNT_OFFSET = 8_000_000;

interface Distribution {
  p50: number;
  p95: number;
  p99: number;
}

interface RestResult extends Distribution {
  name: string;
  path: string;
  requests: number;
  concurrency: number;
  throughputRps: number;
  averagePayloadBytes: number;
}

interface PlanNodeSummary {
  nodeType: string;
  relation?: string;
  index?: string;
  actualTotalMs?: number;
  actualRows?: number;
  loops?: number;
  rowsRemovedByFilter?: number;
  sortMethod?: string;
}

interface ExplainResult {
  name: string;
  executionMs: number | null;
  planningMs: number | null;
  nodes: PlanNodeSummary[];
  raw: unknown;
}

interface ObservedScale {
  markets: number;
  accounts: number;
  trades: number;
  positions: number;
  orders: number;
  fills: number;
  pricePoints: number;
  activityEvents: number;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

function distribution(samples: readonly number[]): Distribution {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}

async function requestOnce(
  baseUrl: string,
  path: string,
): Promise<{ elapsedMs: number; bytes: number }> {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${path}`);
  const body = await response.arrayBuffer();
  const elapsedMs = performance.now() - startedAt;
  if (response.status !== 200) {
    throw new Error(
      `${path} returned ${response.status}: ${Buffer.from(body).toString('utf8')}`,
    );
  }
  return { elapsedMs, bytes: body.byteLength };
}

async function benchmarkRest(
  baseUrl: string,
  name: string,
  path: string,
  requestCount: number,
  concurrency: number,
  warmupRequests: number,
): Promise<RestResult> {
  for (let index = 0; index < warmupRequests; index += 1) {
    await requestOnce(baseUrl, path);
  }

  const samples = new Array<number>(requestCount);
  let bytes = 0;
  let next = 0;
  const startedAt = performance.now();
  await Promise.all(
    Array.from({ length: Math.min(concurrency, requestCount) }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= requestCount) return;
        const result = await requestOnce(baseUrl, path);
        samples[index] = result.elapsedMs;
        bytes += result.bytes;
      }
    }),
  );
  const durationSeconds = (performance.now() - startedAt) / 1_000;
  const stats = distribution(samples);
  const result = {
    name,
    path,
    requests: requestCount,
    concurrency,
    throughputRps: requestCount / durationSeconds,
    averagePayloadBytes: bytes / requestCount,
    ...stats,
  };
  console.info(
    `[bench:rest] ${name} p50=${stats.p50.toFixed(2)}ms ` +
      `p95=${stats.p95.toFixed(2)}ms p99=${stats.p99.toFixed(2)}ms ` +
      `rps=${result.throughputRps.toFixed(1)}`,
  );
  return result;
}

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function planRoot(raw: unknown): Record<string, unknown> | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const first = raw[0];
  return typeof first === 'object' && first !== null
    ? (first as Record<string, unknown>)
    : null;
}

function summarizePlanNode(node: unknown, summaries: PlanNodeSummary[]): void {
  if (typeof node !== 'object' || node === null) return;
  const value = node as Record<string, unknown>;
  const nodeType = value['Node Type'];
  if (typeof nodeType === 'string') {
    summaries.push({
      nodeType,
      ...(typeof value['Relation Name'] === 'string'
        ? { relation: value['Relation Name'] }
        : {}),
      ...(typeof value['Index Name'] === 'string'
        ? { index: value['Index Name'] }
        : {}),
      ...(typeof value['Actual Total Time'] === 'number'
        ? { actualTotalMs: value['Actual Total Time'] }
        : {}),
      ...(typeof value['Actual Rows'] === 'number'
        ? { actualRows: value['Actual Rows'] }
        : {}),
      ...(typeof value['Actual Loops'] === 'number'
        ? { loops: value['Actual Loops'] }
        : {}),
      ...(typeof value['Rows Removed by Filter'] === 'number'
        ? { rowsRemovedByFilter: value['Rows Removed by Filter'] }
        : {}),
      ...(typeof value['Sort Method'] === 'string'
        ? { sortMethod: value['Sort Method'] }
        : {}),
    });
  }
  const children = value.Plans;
  if (Array.isArray(children)) {
    for (const child of children) summarizePlanNode(child, summaries);
  }
}

async function explain(
  prisma: PrismaClient,
  name: string,
  sql: string,
): Promise<ExplainResult> {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
  );
  const raw = rows[0]?.['QUERY PLAN'];
  const outer = planRoot(raw);
  const nodes: PlanNodeSummary[] = [];
  summarizePlanNode(outer?.Plan, nodes);
  const result = {
    name,
    executionMs:
      typeof outer?.['Execution Time'] === 'number' ? outer['Execution Time'] : null,
    planningMs:
      typeof outer?.['Planning Time'] === 'number' ? outer['Planning Time'] : null,
    nodes,
    raw,
  };
  const scans = nodes
    .filter((node) => node.nodeType.includes('Scan'))
    .map((node) => `${node.nodeType}${node.index === undefined ? '' : `:${node.index}`}`)
    .join(',');
  console.info(
    `[bench:plan] ${name} execution=${result.executionMs?.toFixed(2) ?? '?'}ms ` +
      `scans=${scans}`,
  );
  return result;
}

async function hasAccountRollups(
  prisma: PrismaClient,
  schema: string,
): Promise<boolean> {
  const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = ${schema}
      AND table_name = 'Account'
      AND column_name IN ('realizedPnlRaw', 'unrealizedPnlRaw')
  `;
  return columns.length === 2;
}

async function collectPlans(
  prisma: PrismaClient,
  schema: string,
  observed: ObservedScale,
): Promise<ExplainResult[]> {
  const activityMidBlock =
    BASE_BLOCK + Math.floor((observed.activityEvents ?? 0) / 20);
  const accountQuery = (await hasAccountRollups(prisma, schema))
    ? `
      SELECT p.*
      FROM "Position" p
      WHERE p."account" = '${address(0)}'
      ORDER BY p."updatedAt" DESC, p."marketId" DESC, p."outcome" ASC
    `
    : `
      SELECT p.*, m.*, r.*
      FROM "Position" p
      INNER JOIN "Market" m ON m."id" = p."marketId"
      LEFT JOIN "Resolution" r ON r."marketId" = m."id"
      WHERE p."account" = '${address(0)}'
      ORDER BY p."updatedAt" DESC, p."marketId" DESC, p."outcome" ASC
    `;
  const supportedTypes = ACTIVITY_SQL_TYPES;
  const queries = [
    {
      name: 'markets.list',
      sql: `SELECT * FROM "Market" ORDER BY "createdAt" DESC, "id" DESC LIMIT 51`,
    },
    {
      name: 'markets.phase',
      sql: `SELECT * FROM "Market" WHERE "phase" = 'Graduated' ORDER BY "createdAt" DESC, "id" DESC LIMIT 51`,
    },
    {
      name: 'markets.deep-keyset',
      sql: `SELECT * FROM "Market" WHERE ("createdAt", "id") < (${
        BASE_TS + 60_000
      }, '1001') ORDER BY "createdAt" DESC, "id" DESC LIMIT 51`,
    },
    {
      name: 'market.recent-trades',
      sql: `SELECT * FROM "Trade" WHERE "marketId" = '1' ORDER BY "blockNumber" DESC, "logIndex" DESC LIMIT 50`,
    },
    {
      name: 'market.book',
      sql: `SELECT * FROM "Order" WHERE "marketId" = '1' AND "open" = true`,
    },
    {
      name: 'market.prices',
      sql: `SELECT * FROM "PricePoint" WHERE "marketId" = '1' AND "ts" >= ${BASE_TS} ORDER BY "ts" ASC, "blockNumber" ASC, "logIndex" ASC LIMIT 2000`,
    },
    {
      name: 'account.positions',
      sql: accountQuery,
    },
    {
      name: 'account.recent-trades',
      sql: `SELECT * FROM "Trade" WHERE "account" = '${address(
        0,
      )}' ORDER BY "blockNumber" DESC, "logIndex" DESC LIMIT 50`,
    },
    {
      name: 'activity.list',
      sql: `SELECT * FROM "ActivityEvent" WHERE "type" IN (${supportedTypes}) ORDER BY "blockNumber" DESC, "logIndex" DESC LIMIT 51`,
    },
    {
      name: 'activity.market-deep-keyset',
      sql: `SELECT * FROM "ActivityEvent" WHERE "type" IN (${supportedTypes}) AND "marketId" = '1' AND ("blockNumber", "logIndex") < (${activityMidBlock}, 5) ORDER BY "blockNumber" DESC, "logIndex" DESC LIMIT 51`,
    },
  ];
  const results: ExplainResult[] = [];
  for (const query of queries) {
    results.push(await explain(prisma, query.name, query.sql));
  }
  return results;
}

const ACTIVITY_SQL_TYPES = [
  "'MarketCreated'",
  "'Trade'",
  "'MarketGraduated'",
  "'BookSeeded'",
  "'OrderPlaced'",
  "'OrderFilled'",
  "'OrderCancelled'",
  "'ResolutionObserved'",
  "'Closeout'",
  "'Redeem'",
].join(',');

function ingestEvent(index: number, offset: number): DecodedEvent {
  return {
    source: 'LMSR',
    address: ADDRESSES.lmsr as Address,
    eventName: 'TradeState',
    args: {
      marketId: BigInt(INGEST_MARKET_ID),
      qYesRawAfter: BigInt((index + offset + 1) * 10_000),
      qNoRawAfter: 0n,
      FCommittedRawAfter: 10_000_000n,
      bCurrentWadAfter: 1_442_695_040_888_963_406n,
      inventoryYesRawAfter: 5_000_000n,
      inventoryNoRawAfter: 5_000_000n,
      splitAmountRaw: 0n,
      mergeAmountRaw: 0n,
      graduationMoneyInRawAfter: BigInt((index + offset + 1) * 100_000),
    },
    txHash: hash(90_000_000 + offset + index) as Hex,
    logIndex: 0,
    blockNumber: BASE_BLOCK + 200_000 + offset + index,
    ts: BASE_TS + 200_000 + offset + index,
  };
}

async function cleanupIngestFixture(
  prisma: PrismaClient,
  originalLastBlock: number,
  originalHeadBlock: number,
): Promise<void> {
  await prisma.activityEvent.deleteMany({ where: { marketId: INGEST_MARKET_ID } });
  await prisma.pricePoint.deleteMany({ where: { marketId: INGEST_MARKET_ID } });
  await prisma.position.deleteMany({ where: { marketId: INGEST_MARKET_ID } });
  await prisma.market.deleteMany({ where: { id: INGEST_MARKET_ID } });
  await prisma.account.deleteMany({
    where: {
      address: {
        in: Array.from({ length: 1_000 }, (_, index) =>
          address(INGEST_ACCOUNT_OFFSET + index),
        ),
      },
    },
  });
  await prisma.indexerState.update({
    where: { id: 1 },
    data: { lastBlock: originalLastBlock, headBlock: originalHeadBlock },
  });
}

async function benchmarkIngest(
  prisma: PrismaClient,
  eventCount: number,
  positionCount: number,
): Promise<Record<string, number>> {
  const state = await prisma.indexerState.findUniqueOrThrow({ where: { id: 1 } });
  await cleanupIngestFixture(prisma, state.lastBlock, state.headBlock);
  await prisma.market.create({
    data: {
      id: INGEST_MARKET_ID,
      creator: address(INGEST_ACCOUNT_OFFSET),
      question: 'Synthetic ingest benchmark market',
      ancillaryData: '0x',
      ancillaryDataHash: hash(91_000_000),
      metadataHash: hash(91_000_001),
      phase: 'Opened',
      conditionId: hash(91_000_002),
      questionId: hash(91_000_003),
      marketTypeVersion: 2,
      yesTokenId: '9100000000000000001',
      noTokenId: '9100000000000000002',
      bCurrentWad: '1442695040888963406',
      createdAt: BASE_TS,
    },
  });
  await prisma.account.createMany({
    data: Array.from({ length: positionCount }, (_, index) => ({
      address: address(INGEST_ACCOUNT_OFFSET + index),
      firstSeenAt: BASE_TS,
    })),
  });
  await prisma.position.createMany({
    data: Array.from({ length: positionCount }, (_, index) => ({
      account: address(INGEST_ACCOUNT_OFFSET + index),
      marketId: INGEST_MARKET_ID,
      outcome: index % 2 === 0 ? 'YES' : 'NO',
      qtyRaw: '1000000',
      costBasisRaw: '500000',
      unrealizedPnlRaw: '0',
      updatedAt: BASE_TS,
    })),
  });

  try {
    const warmup = [ingestEvent(0, 0), ingestEvent(1, 0)];
    await applyDecodedEvents(
      prisma,
      warmup,
      warmup.at(-1)?.blockNumber ?? state.lastBlock,
      warmup.at(-1)?.blockNumber ?? state.headBlock,
    );
    const events = Array.from({ length: eventCount }, (_, index) =>
      ingestEvent(index, 10),
    );
    const startedAt = performance.now();
    const applied = await applyDecodedEvents(
      prisma,
      events,
      events.at(-1)?.blockNumber ?? state.lastBlock,
      events.at(-1)?.blockNumber ?? state.headBlock,
    );
    const durationMs = performance.now() - startedAt;
    const result = {
      events: eventCount,
      positionsPerPriceTick: positionCount,
      applied,
      durationMs,
      eventsPerSecond: applied / (durationMs / 1_000),
    };
    console.info(
      `[bench:indexer] events=${applied} positions/tick=${positionCount} ` +
        `rate=${result.eventsPerSecond.toFixed(1)} events/s`,
    );
    return result;
  } finally {
    await cleanupIngestFixture(
      prisma,
      state.lastBlock,
      state.headBlock,
    );
  }
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolveOpen, reject) => {
    socket.once('open', resolveOpen);
    socket.once('error', reject);
  });
}

function closeSocket(socket: WebSocket): Promise<void> {
  return new Promise((resolveClose) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolveClose();
      return;
    }
    socket.once('close', () => resolveClose());
    socket.close();
  });
}

async function benchmarkWebsocket(
  websocketUrl: string,
  eventBus: ServerEventBus,
  clientCount: number,
  targetSubscribers: number,
  eventCount: number,
): Promise<Record<string, number>> {
  const sockets: WebSocket[] = [];
  let targetDeliveries = 0;
  let nonTargetDeliveries = 0;
  let resolveDelivered: (() => void) | undefined;
  const delivered = new Promise<void>((resolvePromise) => {
    resolveDelivered = resolvePromise;
  });
  const expectedTargetDeliveries = targetSubscribers * eventCount;

  try {
    for (let offset = 0; offset < clientCount; offset += 50) {
      const batch = Array.from(
        { length: Math.min(50, clientCount - offset) },
        (_, relative) => {
          const index = offset + relative;
          const socket = new WebSocket(websocketUrl);
          sockets.push(socket);
          return waitForOpen(socket).then(
            () =>
              new Promise<void>((resolveAck, reject) => {
                const timer = setTimeout(
                  () => reject(new Error(`WebSocket ${index} ack timed out`)),
                  10_000,
                );
                socket.on('message', (raw) => {
                  const message = JSON.parse(raw.toString()) as {
                    type: string;
                  };
                  if (message.type === 'ack') {
                    clearTimeout(timer);
                    resolveAck();
                    return;
                  }
                  if (message.type === 'update') {
                    if (index < targetSubscribers) {
                      targetDeliveries += 1;
                      if (targetDeliveries === expectedTargetDeliveries) {
                        resolveDelivered?.();
                      }
                    } else {
                      nonTargetDeliveries += 1;
                    }
                  }
                });
                socket.once('error', reject);
                socket.send(
                  JSON.stringify({
                    type: 'subscribe',
                    channels: [
                      index < targetSubscribers
                        ? 'market:bench-target'
                        : `market:bench-${index}`,
                    ],
                  }),
                );
              }),
          );
        },
      );
      await Promise.all(batch);
    }

    const event: ServerEvent = {
      channel: 'market:bench-target',
      event: 'price.tick',
      data: {
        marketId: 'bench-target',
        yesPriceRaw: '500000',
        noPriceRaw: '500000',
        ts: BASE_TS,
      },
    };
    const samples: number[] = [];
    const endToEndStartedAt = performance.now();
    for (let index = 0; index < eventCount; index += 1) {
      const startedAt = performance.now();
      eventBus.publish(event, BASE_TS + index);
      samples.push(performance.now() - startedAt);
    }
    const publishDurationMs = samples.reduce((sum, value) => sum + value, 0);
    let deliveryTimer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      deliveryTimer = setTimeout(
        () =>
          reject(
            new Error(
              `WebSocket delivery timed out at ${targetDeliveries}/${expectedTargetDeliveries}`,
            ),
          ),
        30_000,
      );
    });
    try {
      await Promise.race([delivered, timeout]);
    } finally {
      if (deliveryTimer !== undefined) clearTimeout(deliveryTimer);
    }
    const endToEndDurationMs = performance.now() - endToEndStartedAt;
    if (nonTargetDeliveries !== 0) {
      throw new Error(`Non-target clients received ${nonTargetDeliveries} updates`);
    }
    const stats = distribution(samples.map((value) => value * 1_000));
    const result = {
      clients: clientCount,
      targetSubscribers,
      events: eventCount,
      deliveredMessages: targetDeliveries,
      nonTargetDeliveries,
      publishP50Us: stats.p50,
      publishP95Us: stats.p95,
      publishP99Us: stats.p99,
      publishDurationMs,
      publishesPerSecond: eventCount / (publishDurationMs / 1_000),
      endToEndDurationMs,
    };
    console.info(
      `[bench:ws] clients=${clientCount} target=${targetSubscribers} ` +
        `p95=${stats.p95.toFixed(2)}us rate=${result.publishesPerSecond.toFixed(
          1,
        )} broadcasts/s`,
    );
    return result;
  } finally {
    await Promise.all(sockets.map(closeSocket));
  }
}

async function observedScale(prisma: PrismaClient): Promise<ObservedScale> {
  const [
    markets,
    accounts,
    trades,
    positions,
    orders,
    fills,
    pricePoints,
    activityEvents,
  ] = await Promise.all([
    prisma.market.count(),
    prisma.account.count(),
    prisma.trade.count(),
    prisma.position.count(),
    prisma.order.count(),
    prisma.fill.count(),
    prisma.pricePoint.count(),
    prisma.activityEvent.count(),
  ]);
  return {
    markets,
    accounts,
    trades,
    positions,
    orders,
    fills,
    pricePoints,
    activityEvents,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const provenance = resolveBenchmarkProvenance();
  const databaseUrl = benchDatabaseUrl(argv);
  const label = readFlag(argv, 'label') ?? 'benchmark';
  const requestCount = positiveFlag(argv, 'requests', 400);
  const concurrency = positiveFlag(argv, 'concurrency', 24);
  const warmupRequests = positiveFlag(argv, 'warmup', 20);
  const wsClients = positiveFlag(argv, 'ws-clients', 500);
  const wsSubscribers = positiveFlag(argv, 'ws-subscribers', 5);
  const wsEvents = positiveFlag(argv, 'ws-events', 2_000);
  const ingestEvents = positiveFlag(argv, 'ingest-events', 10);
  const ingestPositions = positiveFlag(argv, 'ingest-positions', 100);
  if (wsSubscribers > wsClients) {
    throw new Error('--ws-subscribers cannot exceed --ws-clients');
  }

  const runtimeConfig = loadRuntimeConfig();
  const prisma = makePrisma(databaseUrl);
  const eventBus = new ServerEventBus();
  const publicReadCache = createNodeRedisPublicJsonReadCache({
    url: runtimeConfig.redisUrl,
    keyPrefix: runtimeConfig.redisKeyPrefix,
  });
  const app = await buildServer({
    prisma,
    eventBus,
    logger: false,
    publicReadCache,
    marketListCacheTtlSeconds: runtimeConfig.marketsCacheTtlSeconds,
  });
  try {
    const observed = await observedScale(prisma);
    if (observed.markets === 0 || observed.activityEvents === 0) {
      throw new Error('Benchmark schema is empty; run pnpm bench:seed first');
    }
    const addressUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const marketCursor = encodeCursor({
      kind: 'markets',
      createdAt: BASE_TS + Math.floor(observed.markets / 2) * 60,
      id: String(Math.floor(observed.markets / 2) + 1),
    });
    const activityCursor = encodeCursor({
      kind: 'activity',
      blockNumber: BASE_BLOCK + Math.floor(observed.activityEvents / 20),
      logIndex: 5,
    });
    const scenarios = [
      { name: 'markets.list', path: '/markets?limit=50' },
      {
        name: 'markets.phase',
        path: '/markets?phase=Graduated&limit=50',
      },
      {
        name: 'markets.deep-keyset',
        path: `/markets?limit=50&cursor=${encodeURIComponent(marketCursor)}`,
      },
      { name: 'market.detail', path: '/markets/1' },
      { name: 'market.book', path: '/markets/1/book' },
      {
        name: 'market.prices',
        path: `/markets/1/prices?fromTs=${BASE_TS}&limit=2000`,
      },
      { name: 'orderbook.token', path: '/orderbook/1000000000' },
      { name: 'account.detail', path: `/accounts/${address(0)}` },
      { name: 'activity.list', path: '/activity?limit=50' },
      {
        name: 'activity.market-deep-keyset',
        path: `/activity?marketId=1&limit=50&cursor=${encodeURIComponent(
          activityCursor,
        )}`,
      },
      { name: 'config', path: '/config' },
      { name: 'health', path: '/health' },
    ];
    const rest: RestResult[] = [];
    for (const scenario of scenarios) {
      rest.push(
        await benchmarkRest(
          addressUrl,
          scenario.name,
          scenario.path,
          requestCount,
          concurrency,
          warmupRequests,
        ),
      );
    }

    const plans = await collectPlans(prisma, benchSchema(databaseUrl), observed);
    const indexer = await benchmarkIngest(
      prisma,
      ingestEvents,
      ingestPositions,
    );
    const websocket = await benchmarkWebsocket(
      `${addressUrl.replace(/^http/, 'ws')}/ws`,
      eventBus,
      wsClients,
      wsSubscribers,
      wsEvents,
    );

    const result = {
      label,
      generatedAt: new Date().toISOString(),
      branch: provenance.branch,
      commit: provenance.commit,
      sourceId: provenance.sourceId,
      sourceProvenance: provenance.kind,
      schema: benchSchema(databaseUrl),
      syntheticOnly: true,
      environment: {
        node: process.version,
        platform: `${platform()} ${release()}`,
        cpu: cpus()[0]?.model ?? 'unknown',
        logicalCpus: cpus().length,
      },
      workload: {
        restRequestsPerScenario: requestCount,
        restConcurrency: concurrency,
        restWarmupRequests: warmupRequests,
        wsClients,
        wsSubscribers,
        wsEvents,
        ingestEvents,
        ingestPositions,
      },
      targets: {
        restP95Ms: 100,
        indexerEventsPerSecond: 20,
        wsPublishP95Us: 250,
      },
      observedScale: observed,
      rest,
      plans,
      indexer,
      websocket,
    };
    const output =
      readFlag(argv, 'output') ?? resolve('bench/results', `${label}.json`);
    await mkdir(resolve(output, '..'), { recursive: true });
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
    console.info(`[bench] wrote ${output}`);
  } finally {
    await app.close();
    await publicReadCache.close();
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('[bench] failed', error);
  process.exitCode = 1;
});
