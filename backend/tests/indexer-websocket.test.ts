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
import {
  COLLATERAL_TRANSFER_EVENT,
  CONTRACT_BY_ADDRESS,
} from '../src/indexer/abis.js';
import { runIndexer } from '../src/indexer/runner.js';
import { testChainStateReader } from './chain-state-fixtures.js';
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

  emitHead(
    blockNumber: number,
    timestamp = 1_700_000_000 + blockNumber,
  ): void {
    const subscription = this.subscriptions.find(
      ({ parameters }) => parameters[0] === 'newHeads',
    );
    if (subscription === undefined) throw new Error('newHeads is not subscribed');
    subscription.handlers.onData({
      result: {
        number: `0x${blockNumber.toString(16)}`,
        timestamp: `0x${timestamp.toString(16)}`,
      },
    });
  }

  emitLog(
    log: ReturnType<typeof registeredMarketTypeLog>,
    removed = log.removed,
  ): void {
    const subscription = this.subscriptions.find(
      ({ parameters }) => parameters[0] === 'logs',
    );
    if (subscription === undefined) throw new Error('logs are not subscribed');
    subscription.handlers.onData({
      result: {
        ...log,
        blockNumber: `0x${log.blockNumber.toString(16)}`,
        logIndex: `0x${log.logIndex.toString(16)}`,
        removed,
        transactionIndex: `0x${log.transactionIndex.toString(16)}`,
      },
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
    webSocketReconnectBaseMs: 10,
    webSocketReconnectMaxMs: 20,
    ...overrides,
  };
}

interface FakeGetLogsParameters {
  address?: unknown;
  fromBlock?: bigint;
  toBlock?: bigint;
  event?: { name?: string };
  events?: readonly unknown[];
  args?: Record<string, unknown>;
}

function asClient(methods: {
  getBlockNumber: () => Promise<bigint>;
  getLogs: (parameters: FakeGetLogsParameters) => Promise<unknown[]>;
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

function collateralTransferLog(input: {
  blockNumber: number;
  from: Address;
  to: Address;
  value: bigint;
}) {
  const abi = CONTRACT_BY_ADDRESS.get(ADDRESSES.usdc.toLowerCase())?.abi;
  if (abi === undefined) throw new Error('Collateral ABI unavailable');
  return {
    address: ADDRESSES.usdc,
    blockHash: `0x${'d'.repeat(64)}` as Hex,
    blockNumber: BigInt(input.blockNumber),
    data: encodeAbiParameters(
      [{ name: 'value', type: 'uint256' }],
      [input.value],
    ),
    logIndex: 1,
    removed: false,
    topics: encodeEventTopics({
      abi,
      eventName: 'Transfer',
      args: { from: input.from, to: input.to },
    }),
    transactionHash: `0x${'e'.repeat(64)}` as Hex,
    transactionIndex: 0,
  };
}

async function seedTrackedMaker(
  owner: Address,
  snapshotBlock = 99,
): Promise<void> {
  const conditionId = `0x${'1'.repeat(64)}`;
  await testPrisma.market.create({
    data: {
      id: '1',
      creator: owner,
      question: 'Static subscription test market',
      ancillaryData: '0x',
      ancillaryDataHash: `0x${'2'.repeat(64)}`,
      metadataHash: `0x${'3'.repeat(64)}`,
      conditionId,
      questionId: `0x${'4'.repeat(64)}`,
      marketTypeVersion: 1,
      createdAt: 1_700_000_000,
    },
  });
  await testPrisma.signedOrder.create({
    data: {
      orderHash: `0x${'5'.repeat(64)}`,
      saltRaw: '1',
      maker: owner.toLowerCase(),
      signer: owner.toLowerCase(),
      taker: '0x0000000000000000000000000000000000000000',
      tokenId: '1',
      makerAmountRaw: '1000',
      takerAmountRaw: '500',
      expiration: 1_900_000_000,
      nonceRaw: '0',
      feeRateBpsRaw: '0',
      exchangeSide: 0,
      signatureType: 0,
      signature: '0x',
      marketId: '1',
      conditionId,
      outcome: 'YES',
      side: 'BID',
      priceRaw: '500000',
      sizeRaw: '1000',
      remainingRaw: '1000',
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_000,
    },
  });
  await testPrisma.collateralBalance.create({
    data: {
      owner: owner.toLowerCase(),
      balanceRaw: '1000',
      blockNumber: snapshotBlock,
      logIndex: 0,
      updatedAt: 1_700_000_000,
    },
  });
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
      chainStateReader: testChainStateReader,
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

  it('decodes and persists a pushed log without any steady-state HTTP call', async () => {
    const transport = new FakeSubscriptionTransport();
    const getBlockNumber = vi.fn(async () => 99n);
    const getLogs = vi.fn(async () => []);
    const getBlock = vi.fn(async () => ({ timestamp: 1_700_000_100n }));
    const client = asClient({
      getBlockNumber,
      getLogs,
      getBlock,
    });
    start(testConfig(), client, () => transport);

    await waitUntil(
      async () =>
        (await testPrisma.indexerSubscriptionState.findUnique({
          where: { id: 1 },
        }))?.status === 'connected',
      'the subscription to become trusted',
    );
    getBlockNumber.mockClear();
    getLogs.mockClear();
    getBlock.mockClear();

    transport.emitLog(registeredMarketTypeLog(100));
    transport.emitHead(100, 1_700_000_100);

    await waitUntil(
      async () =>
        (await testPrisma.registeredMarketType.findUnique({
          where: { version: 7 },
        })) !== null,
      'the pushed event to be decoded and persisted',
    );
    expect(
      await testPrisma.activityEvent.findUnique({
        where: { id: `${`0x${'c'.repeat(64)}`}:0` },
      }),
    ).toMatchObject({
      eventName: 'MarketTypeVersionRegistered',
      blockNumber: 100,
      ts: 1_700_000_100,
    });
    expect(
      await testPrisma.indexerState.findUniqueOrThrow({ where: { id: 1 } }),
    ).toMatchObject({ lastBlock: 100, headBlock: 100 });
    expect(getBlockNumber).not.toHaveBeenCalled();
    expect(getLogs).not.toHaveBeenCalled();
    expect(getBlock).not.toHaveBeenCalled();
  });

  it('advances a quiet authoritative cursor from newHeads with zero HTTP calls', async () => {
    const transport = new FakeSubscriptionTransport();
    const getBlockNumber = vi.fn(async () => 99n);
    const getLogs = vi.fn(async () => []);
    const getBlock = vi.fn(async () => ({ timestamp: 1_700_000_100n }));
    const client = asClient({
      getBlockNumber,
      getLogs,
      getBlock,
    });
    start(testConfig(), client, () => transport);

    await waitUntil(
      async () =>
        (await testPrisma.indexerSubscriptionState.findUnique({
          where: { id: 1 },
        }))?.status === 'connected',
      'the subscription to become trusted',
    );
    getBlockNumber.mockClear();
    getLogs.mockClear();
    getBlock.mockClear();
    for (let block = 100; block <= 109; block += 1) transport.emitHead(block);

    await waitUntil(
      async () =>
        (await testPrisma.indexerState.findUnique({ where: { id: 1 } }))
          ?.lastBlock === 109,
      'the quiet pushed-head cursor',
    );
    expect(getBlockNumber).not.toHaveBeenCalled();
    expect(getLogs).not.toHaveBeenCalled();
    expect(getBlock).not.toHaveBeenCalled();
  });

  it('suppresses an added log that is removed before its head is committed', async () => {
    const transport = new FakeSubscriptionTransport();
    const getLogs = vi.fn(async ({ address }: FakeGetLogsParameters) =>
      Array.isArray(address) ? [registeredMarketTypeLog(100)] : [],
    );
    const client = asClient({
      getBlockNumber: async () => 99n,
      getLogs,
      getBlock: async () => ({ timestamp: 1_700_000_100n }),
    });
    start(
      testConfig({
        fallbackPollMs: 1_000,
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
    getLogs.mockClear();

    const log = registeredMarketTypeLog(100);
    transport.emitLog(log);
    transport.emitLog(log, true);
    transport.emitHead(100, 1_700_000_100);

    await waitUntil(
      () => transport.close.mock.calls.length === 1,
      'the removed-log session to be revoked',
    );
    expect(
      await testPrisma.activityEvent.count({
        where: { txHash: log.transactionHash },
      }),
    ).toBe(0);
    expect(
      await testPrisma.registeredMarketType.findUnique({
        where: { version: 7 },
      }),
    ).toBeNull();
    expect(
      await testPrisma.indexerState.findUniqueOrThrow({ where: { id: 1 } }),
    ).toMatchObject({ lastBlock: 99 });
    expect(getLogs).not.toHaveBeenCalled();
  });

  it('installs only the four static log subscriptions', async () => {
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
      reconnectBaseMs: 10,
      reconnectMaxMs: 20,
      createTransport: () => transport,
      onConnecting: async () => undefined,
      onConnected: async ({ logSubscriptionCount }) => {
        expect(logSubscriptionCount).toBe(4);
        markConnected();
      },
      onDisconnected: async () => undefined,
      onInvalidated: () => undefined,
      onHead: () => undefined,
      onLog: () => undefined,
      onHeartbeat: async () => undefined,
    });

    try {
      await connected;
      const logSubscriptions = transport.subscriptions.filter(
        ({ parameters }) => parameters[0] === 'logs',
      );
      expect(logSubscriptions).toHaveLength(4);
      expect(
        logSubscriptions.map(({ parameters }) =>
          parameters[0] === 'logs' ? parameters[1].address : undefined,
        ),
      ).toEqual([
        expect.any(Array),
        ADDRESSES.ctf,
        ADDRESSES.ctf,
        ADDRESSES.usdc,
      ]);
      const transferSelector = encodeEventTopics({
        abi: [COLLATERAL_TRANSFER_EVENT],
        eventName: 'Transfer',
      })[0];
      expect(JSON.stringify(logSubscriptions)).not.toContain(transferSelector);
    } finally {
      controller.abort();
      await supervisor;
    }
  });

  it('keeps one healthy session while a new maker transfer is indexed by the safety sweep', async () => {
    const owner =
      '0x1111111111111111111111111111111111111111' as Address;
    const recipient =
      '0x2222222222222222222222222222222222222222' as Address;
    const transport = new FakeSubscriptionTransport();
    const createTransport = vi.fn(() => transport);
    const sweptOwnerFilters: unknown[] = [];
    let head = 99n;
    let headCalls = 0;
    const client = asClient({
      getBlockNumber: async () => {
        headCalls += 1;
        return head;
      },
      getLogs: async ({ event, args, fromBlock }) => {
        if (event?.name !== 'Transfer' || args?.from === undefined) return [];
        sweptOwnerFilters.push(args.from);
        return fromBlock === 100n
          ? [
              collateralTransferLog({
                blockNumber: 100,
                from: owner,
                to: recipient,
                value: 250n,
              }),
            ]
          : [];
      },
      getBlock: async () => ({ timestamp: 1_700_000_100n }),
    });
    start(
      testConfig({ pollMs: 25, webSocketStallMs: 1_000 }),
      client,
      createTransport,
    );

    await waitUntil(
      async () =>
        (await testPrisma.indexerSubscriptionState.findUnique({
          where: { id: 1 },
        }))?.status === 'connected',
      'the static subscription to become trusted',
    );
    const subscriptionBeforeOwnerChange =
      await testPrisma.indexerSubscriptionState.findUniqueOrThrow({
        where: { id: 1 },
      });

    await seedTrackedMaker(owner);
    head = 100n;

    await waitUntil(
      async () =>
        (await testPrisma.collateralBalance.findUnique({
          where: { owner: owner.toLowerCase() },
        }))?.balanceRaw === '750',
      'the safety sweep to apply the maker transfer',
    );

    const subscriptionAfterSweep =
      await testPrisma.indexerSubscriptionState.findUniqueOrThrow({
        where: { id: 1 },
      });
    expect(sweptOwnerFilters).toContainEqual([owner.toLowerCase()]);
    expect(headCalls).toBeGreaterThanOrEqual(3);
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(transport.subscriptions).toHaveLength(5);
    expect(transport.close).not.toHaveBeenCalled();
    for (const subscription of transport.subscriptions) {
      expect(subscription.unsubscribe).not.toHaveBeenCalled();
    }
    expect(subscriptionAfterSweep).toMatchObject({ status: 'connected' });
    expect(subscriptionAfterSweep.updatedAt).toEqual(
      subscriptionBeforeOwnerChange.updatedAt,
    );
    expect(await getHealth(testPrisma, 1_000)).toMatchObject({
      ok: true,
      indexerStatus: 'healthy',
      indexedBlock: 100,
    });
  });

  it('keeps advancing from pushes while a safety getLogs request is blocked', async () => {
    let head = 99n;
    let markSafetyStarted!: () => void;
    let releaseSafety!: () => void;
    const safetyStarted = new Promise<void>((resolve) => {
      markSafetyStarted = resolve;
    });
    const safetyRelease = new Promise<void>((resolve) => {
      releaseSafety = resolve;
    });
    const transport = new FakeSubscriptionTransport();
    const client = asClient({
      getBlockNumber: async () => head,
      getLogs: async ({ address }) => {
        if (Array.isArray(address)) {
          markSafetyStarted();
          await safetyRelease;
        }
        return [];
      },
    });
    start(
      testConfig({ pollMs: 25, webSocketStallMs: 1_000 }),
      client,
      () => transport,
    );

    try {
      await waitUntil(
        async () =>
          (await testPrisma.indexerSubscriptionState.findUnique({
            where: { id: 1 },
          }))?.status === 'connected',
        'the subscription to become trusted',
      );
      head = 100n;
      await safetyStarted;

      transport.emitLog(registeredMarketTypeLog(101));
      transport.emitHead(101, 1_700_000_101);
      await waitUntil(
        async () =>
          (await testPrisma.registeredMarketType.findUnique({
            where: { version: 7 },
          })) !== null,
        'the push path while safety HTTP is blocked',
      );
      expect(
        await testPrisma.indexerState.findUniqueOrThrow({ where: { id: 1 } }),
      ).toMatchObject({ lastBlock: 101, headBlock: 101 });
    } finally {
      releaseSafety();
    }
  });

  it('backfills the disconnected gap before trusting a replacement subscription', async () => {
    const owner =
      '0x1111111111111111111111111111111111111111' as Address;
    const recipient =
      '0x2222222222222222222222222222222222222222' as Address;
    let head = 99n;
    const coreRanges: Array<[bigint | undefined, bigint | undefined]> = [];
    const collateralRanges: Array<[
      bigint | undefined,
      bigint | undefined,
    ]> = [];
    let holdReconnectGap = false;
    let markReconnectGapStarted!: () => void;
    let releaseReconnectGap!: () => void;
    const reconnectGapStarted = new Promise<void>((resolve) => {
      markReconnectGapStarted = resolve;
    });
    const reconnectGapRelease = new Promise<void>((resolve) => {
      releaseReconnectGap = resolve;
    });
    const transports: FakeSubscriptionTransport[] = [];
    const client = asClient({
      getBlockNumber: async () => head,
      getLogs: async ({ address, event, args, fromBlock, toBlock }) => {
        if (Array.isArray(address)) {
          coreRanges.push([fromBlock, toBlock]);
          if (holdReconnectGap && fromBlock === 100n) {
            markReconnectGapStarted();
            await reconnectGapRelease;
          }
          return fromBlock === 100n ? [registeredMarketTypeLog()] : [];
        }
        if (event?.name === 'Transfer' && args?.from !== undefined) {
          collateralRanges.push([fromBlock, toBlock]);
          return fromBlock === 100n
            ? [
                collateralTransferLog({
                  blockNumber: 100,
                  from: owner,
                  to: recipient,
                  value: 250n,
                }),
              ]
            : [];
        }
        return [];
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
    await seedTrackedMaker(owner);
    head = 101n;
    holdReconnectGap = true;
    transports[0]?.fail();

    await reconnectGapStarted;
    expect(transports).toHaveLength(2);
    transports[1]?.emitLog(registeredMarketTypeLog(101));
    transports[1]?.emitHead(101, 1_700_000_101);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      await testPrisma.indexerState.findUniqueOrThrow({ where: { id: 1 } }),
    ).toMatchObject({ lastBlock: 99 });
    expect(
      await testPrisma.indexerSubscriptionState.findUniqueOrThrow({
        where: { id: 1 },
      }),
    ).toMatchObject({ status: 'backfilling' });
    releaseReconnectGap();

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
    expect(collateralRanges).toEqual([[100n, 101n]]);
    expect(
      await testPrisma.collateralBalance.findUniqueOrThrow({
        where: { owner: owner.toLowerCase() },
      }),
    ).toMatchObject({ balanceRaw: '750', blockNumber: 100 });
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
    transport.emitHead(100, 1_700_000_100);
    await waitUntil(
      async () =>
        (await testPrisma.indexerState.findUnique({ where: { id: 1 } }))
          ?.lastBlock === 100,
      'the last live subscription watermark',
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
      indexedBlock: 100,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      await testPrisma.indexerState.findUniqueOrThrow({ where: { id: 1 } }),
    ).toMatchObject({ lastBlock: 100 });
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('newHeads subscription was silent'),
    );
  });

  it.each(['disabled', 'connection unavailable', 'eth_subscribe rejected'])(
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
      const createTransport = vi.fn(() => {
        if (failureMode === 'connection unavailable') {
          throw new Error('connect ECONNREFUSED');
        }
        return new FakeSubscriptionTransport(
          new Error('eth_subscribe is not supported'),
        );
      });
      start(
        testConfig({
          ...(failureMode === 'disabled' ? { webSocketRpcUrls: [] } : {}),
          fallbackPollMs: 20,
          webSocketReconnectBaseMs: 10,
          webSocketReconnectMaxMs: 20,
        }),
        client,
        createTransport,
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
      if (failureMode === 'disabled') {
        expect(createTransport).not.toHaveBeenCalled();
      }
    },
  );

  it('applies the same event exactly once when both push and safety sweep deliver it', async () => {
    let head = 99n;
    let headCalls = 0;
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
        return [registeredMarketTypeLog()];
      },
      getBlock: async () => ({ timestamp: 1_700_000_000n }),
    });
    start(
      testConfig({ pollMs: 150, webSocketCoalesceMs: 5 }),
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
    transport.emitLog(registeredMarketTypeLog(100));
    transport.emitHead(100, 1_700_000_000);

    await waitUntil(
      async () =>
        (await testPrisma.activityEvent.count({
          where: { txHash: `0x${'c'.repeat(64)}` },
        })) === 1,
      'the pushed event',
    );
    await waitUntil(
      () => coreRanges.length === 1 && headCalls >= 3,
      'the overlapping safety sweep',
    );
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
