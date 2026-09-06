export const BENCHMARK_SERVER_READY_TIMEOUT_MS = 30_000;
export const BENCHMARK_SERVER_COMMAND_TIMEOUT_MS = 30_000;
export const BENCHMARK_SERVER_STOP_TIMEOUT_MS = 10_000;

export interface PublishDistribution {
  publishP50Us: number;
  publishP95Us: number;
  publishP99Us: number;
  publishDurationMs: number;
  publishesPerSecond: number;
}

export type BenchmarkServerRequest =
  | {
      type: 'publish';
      requestId: string;
      eventCount: number;
      baseTimestamp: number;
    }
  | { type: 'shutdown' };

export type BenchmarkServerMessage =
  | {
      type: 'ready';
      pid: number;
      baseUrl: string;
      websocketUrl: string;
      redisConfigured: boolean;
    }
  | { type: 'publish-result'; requestId: string; result: PublishDistribution }
  | { type: 'fatal'; message: string }
  | { type: 'stopped' };

function object(value: unknown, label = 'IPC message'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Benchmark ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Benchmark IPC message has invalid ${field}`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Benchmark IPC message has invalid ${field}`);
  }
  return value;
}

function distribution(value: unknown): PublishDistribution {
  const result = object(value, 'publish result');
  const fields = [
    'publishP50Us',
    'publishP95Us',
    'publishP99Us',
    'publishDurationMs',
    'publishesPerSecond',
  ] as const;
  for (const field of fields) {
    const candidate = result[field];
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
      throw new Error(`Benchmark IPC message has invalid ${field}`);
    }
  }
  return Object.fromEntries(
    fields.map((field) => [field, result[field]]),
  ) as unknown as PublishDistribution;
}

export function parseBenchmarkServerMessage(value: unknown): BenchmarkServerMessage {
  const message = object(value);
  if (message.type === 'ready') {
    if (typeof message.redisConfigured !== 'boolean') {
      throw new Error('Benchmark IPC message has invalid redisConfigured');
    }
    return {
      type: 'ready',
      pid: positiveInteger(message.pid, 'pid'),
      baseUrl: text(message.baseUrl, 'baseUrl'),
      websocketUrl: text(message.websocketUrl, 'websocketUrl'),
      redisConfigured: message.redisConfigured,
    };
  }
  if (message.type === 'publish-result') {
    return {
      type: 'publish-result',
      requestId: text(message.requestId, 'requestId'),
      result: distribution(message.result),
    };
  }
  if (message.type === 'fatal') {
    return { type: 'fatal', message: text(message.message, 'fatal message') };
  }
  if (message.type === 'stopped') return { type: 'stopped' };
  throw new Error('Benchmark IPC message has unknown type');
}

export function parseBenchmarkServerRequest(value: unknown): BenchmarkServerRequest {
  const message = object(value);
  if (message.type === 'shutdown') return { type: 'shutdown' };
  if (message.type !== 'publish') {
    throw new Error('Benchmark IPC request has unknown type');
  }
  return {
    type: 'publish',
    requestId: text(message.requestId, 'requestId'),
    eventCount: positiveInteger(message.eventCount, 'eventCount'),
    baseTimestamp: positiveInteger(message.baseTimestamp, 'baseTimestamp'),
  };
}

export interface HotHybridEvidence {
  marketId: '1';
  liveVenue: 'HYBRID';
  tradingOpen: true;
  marketBookOffchainOrders: number;
  tokenBookOffchainOrders: number;
  marketBookLevels: number;
  tokenBookLevels: number;
}

function list(book: Record<string, unknown>, field: string): unknown[] {
  const value = book[field];
  if (!Array.isArray(value)) throw new Error(`Benchmark book omitted ${field}`);
  return value;
}

function assertFillable(orders: readonly unknown[]): void {
  if (orders.some((order) => object(order, 'order').fillable !== true)) {
    throw new Error('Benchmark Hybrid book contains an unfillable order');
  }
}

export function assertHotHybridResponses(
  marketBookValue: unknown,
  tokenBookValue: unknown,
): HotHybridEvidence {
  const market = object(marketBookValue, 'market book');
  const token = object(tokenBookValue, 'token book');
  if (
    market.marketId !== '1' ||
    market.liveVenue !== 'HYBRID' ||
    market.orderBookAvailable !== true ||
    market.tradingOpen !== true
  ) {
    throw new Error('Benchmark market 1 must be an active, available HYBRID book');
  }
  if (
    token.marketId !== '1' ||
    token.tokenId !== '1000000000' ||
    token.outcome !== 'YES'
  ) {
    throw new Error('Benchmark token book does not belong to market 1 YES');
  }
  const yes = object(market.yes, 'YES book');
  const no = object(market.no, 'NO book');
  const marketOrders = [...list(yes, 'offchainOrders'), ...list(no, 'offchainOrders')];
  const marketLevels = [
    ...list(yes, 'bids'),
    ...list(yes, 'asks'),
    ...list(no, 'bids'),
    ...list(no, 'asks'),
  ];
  const tokenOrders = list(token, 'offchainOrders');
  const tokenLevels = [...list(token, 'bids'), ...list(token, 'asks')];
  assertFillable(marketOrders);
  assertFillable(tokenOrders);
  if (
    marketOrders.length === 0 ||
    marketLevels.length === 0 ||
    tokenOrders.length === 0 ||
    tokenLevels.length === 0
  ) {
    throw new Error('Benchmark Hybrid books must contain fillable orders and levels');
  }
  return {
    marketId: '1',
    liveVenue: 'HYBRID',
    tradingOpen: true,
    marketBookOffchainOrders: marketOrders.length,
    tokenBookOffchainOrders: tokenOrders.length,
    marketBookLevels: marketLevels.length,
    tokenBookLevels: tokenLevels.length,
  };
}
