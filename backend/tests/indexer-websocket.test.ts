import { ADDRESSES } from '@predex-pump/shared';
import {
  encodeAbiParameters,
  encodeEventTopics,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { getHealth } from '../src/api/queries.js';
import { loadRuntimeConfig, type RuntimeConfig } from '../src/config.js';
import { CONTRACT_BY_ADDRESS } from '../src/indexer/abis.js';
import { runIndexer } from '../src/indexer/runner.js';
import {
  runSubscriptionSupervisor,
  type IndexerSubscriptionHandle,
  type IndexerSubscriptionParameters,
  type IndexerSubscriptionTransport,
} from '../src/indexer/subscriptions.js';
import { resetDatabase, testPrisma } from './database.js';

interface SubscriptionRecord {
  parameters: IndexerSubscriptionParameters;
  handlers: {
    onData: (data: unknown) => void;
    onError: (error: unknown) => void;
  };
  unsubscribe: ReturnType<typeof vi.fn>;
}

class FakeSubscriptionTransport implements IndexerSubscriptionTransport {
  readonly subscriptions: SubscriptionRecord[] = [];
  readonly close = vi.fn(async () => undefined);

  constructor(private readonly rejection?: Error) {}

  async subscribe(
    parameters: IndexerSubscriptionParameters,
    handlers: SubscriptionRecord['handlers'],
  ): Promise<IndexerSubscriptionHandle> {
    if (this.rejection !== undefined) {
      handlers.onError(this.rejection);
      throw this.rejection;
    }
    const unsubscribe = vi.fn();
    this.subscriptions.push({ parameters, handlers, unsubscribe });
    return { unsubscribe };
  }

  emitHead(blockNumber: number): void {
    const subscription = this.subscriptions.find(
      ({ parameters }) => parameters[0] === 'newHeads',
    );
    if (subscription === undefined) throw new Error('newHeads is not subscribed');
    subscription.handlers.onData({
      result: { number: `0x${blockNumber.toString(16)}` },
    });
  }

  emitLog(blockNumber: number): void {
    const subscription = this.subscriptions.find(
      ({ parameters }) => parameters[0] === 'logs',
    );
    if (subscription === undefined) throw new Error('logs are not subscribed');
    subscription.handlers.onData({
      result: { blockNumber: `0x${blockNumber.toString(16)}` },
    });
  }

  fail(error = new Error('socket closed')): void {
    for (const subscription of this.subscriptions) {
      subscription.handlers.onError(error);
    }
  }
}

function testConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    ...loadRuntimeConfig(),
    deployBlock: 100,
    blockChunk: 100,
    pollMs: 60_000,
    fallbackPollMs: 50,
    chunkDelayMs: 0,
    indexerStallMs: 1_000,
    webSocketRpcUrls: ['wss://fake.arc.test'],
    webSocketCoalesceMs: 10,
    webSocketStallMs: 500,
    webSocketHeartbeatMs: 50,
    webSocketOwnerRefreshMs: 1_000,
    webSocketReconnectBaseMs: 10,
    webSocketReconnectMaxMs: 20,
    ...overrides,
  };
}

function asClient(methods: {
  getBlockNumber: () => Promise<bigint>;
  getLogs: (parameters: {
    address?: unknown;
    fromBlock?: bigint;
    toBlock?: bigint;
  }) => Promise<unknown[]>;
  getBlock?: () => Promise<{ timestamp: bigint }>;
}): PublicClient {
  return {
    getBlockNumber: methods.getBlockNumber,
    getLogs: methods.getLogs,
    getBlock: methods.getBlock ?? vi.fn(),
  } as unknown as PublicClient;
}

function registeredMarketTypeLog(blockNumber = 100) {
  const abi = CONTRACT_BY_ADDRESS.get(ADDRESSES.registry.toLowerCase())?.abi;
  if (abi === undefined) throw new Error('Registry ABI unavailable');
  return {
    address: ADDRESSES.registry,
    blockHash: `0x${'a'.repeat(64)}` as Hex,
    blockNumber: BigInt(blockNumber),
    data: encodeAbiParameters(
      [{ name: 'configHash', type: 'bytes32' }],
      [`0x${'b'.repeat(64)}`],
    ),
    logIndex: 0,
    removed: false,
    topics: encodeEventTopics({
      abi,
      eventName: 'MarketTypeVersionRegistered',
      args: { version: 7, lmsr: ADDRESSES.lmsr },
    }),
    transactionHash: `0x${'c'.repeat(64)}` as Hex,
    transactionIndex: 0,
  };
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function waitForTimer(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

interface ActiveRun {
  controller: AbortController;
  run: Promise<void>;
}

describe('WebSocket-driven indexer', () => {
  const activeRuns: ActiveRun[] = [];
  let info: ReturnType<typeof vi.spyOn>;
  let warning: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetDatabase();
    info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    const runs = activeRuns.splice(0);
    for (const active of runs) active.controller.abort();
    await Promise.all(runs.map(({ run }) => run.catch(() => undefined)));
    info.mockRestore();
    warning.mockRestore();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  function start(
    config: RuntimeConfig,
    client: PublicClient,
    subscriptionTransportFactory: (url: string) => IndexerSubscriptionTransport,
    onEvents?: (events: readonly unknown[]) => Promise<void>,
  ): ActiveRun {
    const controller = new AbortController();
    const run = runIndexer(testPrisma, config, {
      once: false,
      client,
      signal: controller.signal,
      subscriptionTransportFactory,
      ...(onEvents === undefined
        ? {}
        : {
            onEvents: async (events) => onEvents(events),
          }),
    });
    const active = { controller, run };
    activeRuns.push(active);
    return active;
  }

  it('runs once for one pushed log and coalesces a burst into one catch-up', async () => {
    const coreRanges: Array<[bigint | undefined, bigint | undefined]> = [];
    const transport = new FakeSubscriptionTransport();
    const client = asClient({
      getBlockNumber: async () => 99n,
      getLogs: async ({ address, fromBlock, toBlock }) => {
        if (Array.isArray(address)) coreRanges.push([fromBlock, toBlock]);
        return [];
      },
    });
    start(testConfig(), client, () => transport);

    await waitUntil(
      async () =>
        (await testPrisma.indexerSubscriptionState.findUnique({
          where: { id: 1 },
        }))?.status === 'connected',
      'the subscription to become trusted',
    );
    transport.emitLog(100);

    await waitUntil(
      async () =>
        (await testPrisma.indexerState.findUnique({ where: { id: 1 } }))
          ?.lastBlock === 100,
      'the single pushed-log catch-up',
    );
    expect(coreRanges).toEqual([[100n, 100n]]);

    coreRanges.length = 0;
    transport.emitHead(103);
    transport.emitLog(101);
    transport.emitLog(102);
    transport.emitLog(103);
    await waitUntil(
      async () =>
        (await testPrisma.indexerState.findUnique({ where: { id: 1 } }))
          ?.lastBlock === 103,
      'the coalesced pushed-log burst',
    );
    expect(coreRanges).toEqual([[101n, 103n]]);
  });

  it('uses high-frequency newHeads only as a watermark, never as a getLogs trigger', async () => {
    const coreRanges: Array<[bigint | undefined, bigint | undefined]> = [];
    let headCalls = 0;
    const transport = new FakeSubscriptionTransport();
    const client = asClient({
      getBlockNumber: async () => {
        headCalls += 1;
        return 99n;
      },
      getLogs: async ({ address, fromBlock, toBlock }) => {
        if (Array.isArray(address)) coreRanges.push([fromBlock, toBlock]);
        return [];
      },
    });
    start(testConfig(), client, () => transport);

    await waitUntil(
      async () =>
        (await testPrisma.indexerSubscriptionState.findUnique({
          where: { id: 1 },
        }))?.status === 'connected',
      'the subscription to become trusted',
    );
    for (let block = 100; block <= 109; block += 1) transport.emitHead(block);

    await waitUntil(
      async () =>
        (await testPrisma.indexerSubscriptionState.findUnique({
          where: { id: 1 },
        }))?.headBlock === 109,
      'the throttled newHeads watermark',
    );
    expect(coreRanges).toEqual([]);
    expect(headCalls).toBe(2);
  });

  it('subscribes to exact dynamic collateral-owner transfer topics', async () => {
    const owner =
      '0x1111111111111111111111111111111111111111' as Address;
    const ownerTopic = `0x${owner.slice(2).padStart(64, '0')}`;
    const controller = new AbortController();
    const transport = new FakeSubscriptionTransport();
    let markConnected!: () => void;
    const connected = new Promise<void>((resolve) => {
      markConnected = resolve;
    });
    const supervisor = runSubscriptionSupervisor({
      urls: ['wss://fake.arc.test'],
      signal: controller.signal,
      wait: waitForTimer,
      now: () => new Date(),
      stallMs: 1_000,
      heartbeatMs: 100,
      ownerRefreshMs: 1_000,
      reconnectBaseMs: 10,
      reconnectMaxMs: 20,
      loadCollateralOwners: async () => [owner],
      createTransport: () => transport,
      onConnecting: async () => undefined,
      onConnected: async () => markConnected(),
      onDisconnected: async () => undefined,
      onHead: () => undefined,
      onActivity: () => undefined,
      onHeartbeat: async () => undefined,
      onOwnerFilterRefresh: () => undefined,
    });

    try {
      await connected;
      const logSubscriptions = transport.subscriptions.filter(
        ({ parameters }) => parameters[0] === 'logs',
      );
      expect(logSubscriptions).toHaveLength(6);
      const incoming = logSubscriptions.at(-2)?.parameters;
      const outgoing = logSubscriptions.at(-1)?.parameters;
      if (incoming?.[0] !== 'logs' || outgoing?.[0] !== 'logs') {
        throw new Error('Dynamic collateral subscriptions were not installed');
      }
      expect(incoming[1].address).toBe(ADDRESSES.usdc);
      expect(incoming[1].topics?.[1]).toBeNull();
      expect(incoming[1].topics?.[2]).toEqual([ownerTopic]);
      expect(outgoing[1].address).toBe(ADDRESSES.usdc);
      expect(outgoing[1].topics?.[1]).toEqual([ownerTopic]);
      expect(outgoing[1].topics?.[2]).toBeNull();
    } finally {
      controller.abort();
      await supervisor;
    }
  });

  it('backfills the disconnected gap before trusting a replacement subscription', async () => {
    let head = 99n;
    const coreRanges: Array<[bigint | undefined, bigint | undefined]> = [];
    const transports: FakeSubscriptionTransport[] = [];
    const client = asClient({
      getBlockNumber: async () => head,
      getLogs: async ({ address, fromBlock, toBlock }) => {
        if (!Array.isArray(address)) return [];
        coreRanges.push([fromBlock, toBlock]);
        return fromBlock === 100n ? [registeredMarketTypeLog()] : [];
      },
      getBlock: async () => ({ timestamp: 1_700_000_000n }),
    });
    start(testConfig({ fallbackPollMs: 1_000 }), client, () => {
      const transport = new FakeSubscriptionTransport();
      transports.push(transport);
      return transport;
    });

    await waitUntil(
      async () =>
        (await testPrisma.indexerSubscriptionState.findUnique({
          where: { id: 1 },
        }))?.status === 'connected',
      'the first subscription',
    );
    head = 101n;
    transports[0]?.fail();

    await waitUntil(
      async () =>
        (await testPrisma.registeredMarketType.findUnique({
          where: { version: 7 },
        })) !== null,
      'the reconnect gap-fill event',
    );
    expect(transports.length).toBeGreaterThanOrEqual(2);
    expect(transports[0]?.close).toHaveBeenCalledTimes(1);
    expect(coreRanges).toEqual([[100n, 101n]]);
    expect(
      await testPrisma.indexerState.findUniqueOrThrow({ where: { id: 1 } }),
    ).toMatchObject({
      lastBlock: 101,
    });
    expect(
      await testPrisma.indexerSubscriptionState.findUniqueOrThrow({
        where: { id: 1 },
      }),
    ).toMatchObject({ status: 'connected' });
  });

  it('detects a silent newHeads subscription and stops reporting healthy', async () => {
    const transport = new FakeSubscriptionTransport();
    const client = asClient({
      getBlockNumber: async () => 99n,
      getLogs: async () => [],
    });
    start(
      testConfig({
        fallbackPollMs: 1_000,
        webSocketStallMs: 40,
        webSocketHeartbeatMs: 10,
        webSocketReconnectBaseMs: 1_000,
        webSocketReconnectMaxMs: 1_000,
      }),
      client,
      () => transport,
    );

    await waitUntil(
      async () =>
        (await testPrisma.indexerSubscriptionState.findUnique({
          where: { id: 1 },
        }))?.status === 'connected',
      'the subscription to become trusted',
    );
    await waitUntil(
      async () =>
        transport.close.mock.calls.length === 1 &&
        (await testPrisma.indexerSubscriptionState.findUnique({
          where: { id: 1 },
        }))?.status === 'polling',
      'silent-stall fallback',
    );

    expect(await getHealth(testPrisma, 1_000)).toMatchObject({
      ok: true,
      indexerStatus: 'degraded',
    });
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('newHeads subscription was silent'),
    );
  });

  it.each(['connection unavailable', 'eth_subscribe rejected'])(
    'falls back to polling when WebSocket is %s',
    async (failureMode) => {
      let headCalls = 0;
      const client = asClient({
        getBlockNumber: async () => {
          headCalls += 1;
          return headCalls === 1 ? 99n : 100n;
        },
        getLogs: async ({ address, fromBlock }) =>
          Array.isArray(address) && fromBlock === 100n
            ? [registeredMarketTypeLog()]
            : [],
        getBlock: async () => ({ timestamp: 1_700_000_000n }),
      });
      start(
        testConfig({
          fallbackPollMs: 20,
          webSocketReconnectBaseMs: 10,
          webSocketReconnectMaxMs: 20,
        }),
        client,
        () => {
          if (failureMode === 'connection unavailable') {
            throw new Error('connect ECONNREFUSED');
          }
          return new FakeSubscriptionTransport(
            new Error('eth_subscribe is not supported'),
          );
        },
      );

      await waitUntil(
        async () =>
          (await testPrisma.registeredMarketType.findUnique({
            where: { version: 7 },
          })) !== null,
        'HTTP fallback indexing',
      );
      expect(await getHealth(testPrisma, 1_000)).toMatchObject({
        ok: true,
        indexerStatus: 'degraded',
        indexedBlock: 100,
      });
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('mode=polling'),
      );
    },
  );

  it('applies an event once when a pushed wake-up overlaps the safety poll', async () => {
    let head = 99n;
    let headCalls = 0;
    let releaseRange!: () => void;
    let markRangeStarted!: () => void;
    const rangeStarted = new Promise<void>((resolve) => {
      markRangeStarted = resolve;
    });
    const rangeRelease = new Promise<void>((resolve) => {
      releaseRange = resolve;
    });
    const coreRanges: Array<[bigint | undefined, bigint | undefined]> = [];
    const transport = new FakeSubscriptionTransport();
    const onEvents = vi.fn(async () => undefined);
    const client = asClient({
      getBlockNumber: async () => {
        headCalls += 1;
        return head;
      },
      getLogs: async ({ address, fromBlock, toBlock }) => {
        if (!Array.isArray(address)) return [];
        coreRanges.push([fromBlock, toBlock]);
        markRangeStarted();
        await rangeRelease;
        return [registeredMarketTypeLog()];
      },
      getBlock: async () => ({ timestamp: 1_700_000_000n }),
    });
    start(
      testConfig({ pollMs: 25, webSocketCoalesceMs: 5 }),
      client,
      () => transport,
      onEvents,
    );

    await waitUntil(
      async () =>
        (await testPrisma.indexerSubscriptionState.findUnique({
          where: { id: 1 },
        }))?.status === 'connected',
      'the subscription to become trusted',
    );
    head = 100n;
    transport.emitLog(100);
    await rangeStarted;
    await new Promise((resolve) => setTimeout(resolve, 35));
    releaseRange();

    await waitUntil(() => headCalls >= 3, 'the overlapping safety poll');
    expect(coreRanges).toEqual([[100n, 100n]]);
    expect(onEvents).toHaveBeenCalledTimes(1);
    expect(
      await testPrisma.activityEvent.count({
        where: { txHash: `0x${'c'.repeat(64)}` },
      }),
    ).toBe(1);
  });

  it('unsubscribes, closes the transport, and exits on abort', async () => {
    const transport = new FakeSubscriptionTransport();
    const client = asClient({
      getBlockNumber: async () => 99n,
      getLogs: async () => [],
    });
    const active = start(testConfig(), client, () => transport);

    await waitUntil(
      async () =>
        (await testPrisma.indexerSubscriptionState.findUnique({
          where: { id: 1 },
        }))?.status === 'connected',
      'the subscription to become trusted',
    );
    active.controller.abort();
    await active.run;

    expect(transport.subscriptions).toHaveLength(5);
    for (const subscription of transport.subscriptions) {
      expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
    }
    expect(transport.close).toHaveBeenCalledTimes(1);
  });
});
