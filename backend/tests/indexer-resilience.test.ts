import { ADDRESSES } from '@predex-pump/shared';
import { Side } from '@predex-pump/shared/tx';
import type { FastifyInstance } from 'fastify';
import {
  encodeAbiParameters,
  encodeEventTopics,
  RpcRequestError,
  TimeoutError,
  type Hex,
  type PublicClient,
} from 'viem';
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { buildServer } from '../src/api/server.js';
import { loadRuntimeConfig, type RuntimeConfig } from '../src/config.js';
import { ServerEventBus } from '../src/events/bus.js';
import { CONTRACT_BY_ADDRESS } from '../src/indexer/abis.js';
import { runIndexer } from '../src/indexer/runner.js';
import { signedOrderCreateData } from '../src/orderbook/order.js';
import { testChainStateReader } from './chain-state-fixtures.js';
import { resetDatabase, testPrisma } from './database.js';
import { MARKET_ONE_CONDITION, seedContractData } from './fixtures.js';
import { BOOK_NOW, signedOrderRequest } from './orderbook-fixtures.js';

const RPC_URL = 'https://rpc.example.test';

function testConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    ...loadRuntimeConfig(),
    deployBlock: 100,
    blockChunk: 1,
    // Tests drive a fake transport, not a rate-limited endpoint.
    requestSpacingMs: 0,
    pollMs: 25,
    fallbackPollMs: 25,
    webSocketRpcUrls: [],
    chunkDelayMs: 0,
    indexerStallMs: 1_000,
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
  multicall?: (parameters: unknown) => Promise<unknown>;
}): PublicClient {
  return {
    getBlockNumber: methods.getBlockNumber,
    getLogs: methods.getLogs,
    getBlock: methods.getBlock ?? vi.fn(),
    ...(methods.multicall === undefined ? {} : { multicall: methods.multicall }),
  } as unknown as PublicClient;
}

function rateLimitError(): RpcRequestError {
  return new RpcRequestError({
    body: { id: 1, jsonrpc: '2.0', method: 'eth_getLogs', params: [] },
    error: {
      code: -32_005,
      message: 'You reached Public endpoint rate limit, please upgrade to paid plan',
    },
    url: RPC_URL,
  });
}

function registeredMarketTypeLog() {
  const abi = CONTRACT_BY_ADDRESS.get(ADDRESSES.registry.toLowerCase())?.abi;
  if (abi === undefined) throw new Error('Registry ABI unavailable');
  return {
    address: ADDRESSES.registry,
    blockHash: `0x${'a'.repeat(64)}` as Hex,
    blockNumber: 100n,
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

function exchangeOrderFilledLog(input: {
  orderHash: Hex;
  maker: `0x${string}`;
  taker: `0x${string}`;
  blockNumber: bigint;
}) {
  const abi = CONTRACT_BY_ADDRESS.get(ADDRESSES.ctfExchange.toLowerCase())?.abi;
  if (abi === undefined) throw new Error('CTFExchange ABI unavailable');
  return {
    address: ADDRESSES.ctfExchange,
    blockHash: `0x${'d'.repeat(64)}` as Hex,
    blockNumber: input.blockNumber,
    data: encodeAbiParameters(
      [
        { name: 'tokenId', type: 'uint256' },
        { name: 'makerAmountFilled', type: 'uint256' },
        { name: 'takerAmountFilled', type: 'uint256' },
      ],
      [101n, 1_000n, 498n],
    ),
    logIndex: 3,
    removed: false,
    topics: encodeEventTopics({
      abi,
      eventName: 'OrderFilled',
      args: {
        orderHash: input.orderHash,
        maker: input.maker,
        taker: input.taker,
      },
    }),
    transactionHash: `0x${'e'.repeat(64)}` as Hex,
    transactionIndex: 0,
  };
}

describe('indexer RPC resilience', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it('retries a rate-limited backfill range from the same cursor without gaps', async () => {
    const ranges: Array<[bigint | undefined, bigint | undefined]> = [];
    const delays: number[] = [];
    let getLogsCalls = 0;
    const client = asClient({
      getBlockNumber: async () => 103n,
      getLogs: async ({ address, fromBlock, toBlock }) => {
        if (!Array.isArray(address)) return [];
        ranges.push([fromBlock, toBlock]);
        getLogsCalls += 1;
        if (getLogsCalls <= 2) throw rateLimitError();
        return fromBlock === 100n ? [registeredMarketTypeLog()] : [];
      },
      getBlock: async () => ({ timestamp: 1_700_000_000n }),
    });
    const onEvents = vi.fn(async () => undefined);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    try {
      await runIndexer(testPrisma, testConfig({ blockChunk: 2, chunkDelayMs: 7 }), {
        once: true,
        client,
        onEvents,
        chainStateReader: testChainStateReader,
        random: () => 0,
        wait: async (milliseconds) => {
          delays.push(milliseconds);
        },
      });
    } finally {
      warning.mockRestore();
      info.mockRestore();
    }

    expect(ranges).toEqual([
      [100n, 101n],
      [100n, 101n],
      [100n, 101n],
      [102n, 103n],
    ]);
    expect(delays).toEqual([5_000, 10_000, 7]);
    expect(onEvents).toHaveBeenCalledTimes(1);
    expect(
      await testPrisma.registeredMarketType.findUnique({ where: { version: 7 } }),
    ).toMatchObject({ blockNumber: 100 });
    expect(
      await testPrisma.activityEvent.count({
        where: { txHash: `0x${'c'.repeat(64)}` },
      }),
    ).toBe(1);
    expect(
      await testPrisma.indexerState.findUniqueOrThrow({ where: { id: 1 } }),
    ).toMatchObject({
      lastBlock: 103,
      headBlock: 103,
      consecutiveRpcFailures: 0,
      lastSuccessfulPollAt: expect.any(Date),
    });
  });

  it('leaves the fill, allowance row, and cursor untouched when its allowance read fails', async () => {
    await seedContractData();
    await testPrisma.indexerState.update({
      where: { id: 1 },
      data: { deployBlock: 100, lastBlock: 99, headBlock: 99 },
    });
    const makerOrder = await signedOrderRequest({
      side: Side.SELL,
      priceRaw: 498_000n,
      sizeRaw: 1_000n,
      salt: 301n,
    });
    await testPrisma.signedOrder.create({
      data: signedOrderCreateData({
        orderHash: makerOrder.request.orderHash,
        order: makerOrder.order,
        marketId: '1',
        conditionId: MARKET_ONE_CONDITION,
        outcome: 'YES',
        now: BOOK_NOW,
      }),
    });
    const taker = '0x2222222222222222222222222222222222222222';
    await testPrisma.collateralExchangeApproval.create({
      data: {
        owner: taker,
        allowanceRaw: '498',
        blockNumber: 99,
        logIndex: 1,
        updatedAt: BOOK_NOW,
      },
    });
    const fillLog = exchangeOrderFilledLog({
      orderHash: makerOrder.request.orderHash,
      maker: makerOrder.account.address,
      taker,
      blockNumber: 100n,
    });
    const controller = new AbortController();
    const multicall = vi.fn(async () => {
      throw new TimeoutError({ body: {}, url: RPC_URL });
    });
    const client = asClient({
      getBlockNumber: async () => 100n,
      getLogs: async ({ address }) => (Array.isArray(address) ? [fillLog] : []),
      getBlock: async () => ({ timestamp: BigInt(BOOK_NOW + 100) }),
      multicall,
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    try {
      await runIndexer(testPrisma, testConfig(), {
        once: true,
        client,
        chainStateReader: testChainStateReader,
        signal: controller.signal,
        random: () => 0,
        wait: async () => {
          controller.abort();
        },
      });
    } finally {
      warning.mockRestore();
      info.mockRestore();
    }

    expect(multicall).toHaveBeenCalledOnce();
    expect(multicall).toHaveBeenCalledWith(
      expect.objectContaining({ blockNumber: 100n }),
    );
    await expect(
      testPrisma.activityEvent.count({
        where: { txHash: fillLog.transactionHash },
      }),
    ).resolves.toBe(0);
    await expect(
      testPrisma.collateralExchangeApproval.findUniqueOrThrow({
        where: { owner: taker },
      }),
    ).resolves.toMatchObject({ allowanceRaw: '498', blockNumber: 99 });
    await expect(
      testPrisma.indexerState.findUniqueOrThrow({ where: { id: 1 } }),
    ).resolves.toMatchObject({
      lastBlock: 99,
      headBlock: 100,
      consecutiveRpcFailures: 1,
    });
  });

  it.each([
    ['rate limit', () => rateLimitError()],
    [
      'timeout',
      () => new TimeoutError({ body: {}, url: RPC_URL }),
    ],
    [
      'ENOTFOUND',
      () =>
        Object.assign(new Error('getaddrinfo ENOTFOUND rpc.example.test'), {
          code: 'ENOTFOUND',
        }),
    ],
    [
      'connection reset',
      () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    ],
  ])(
    'keeps REST live, becomes stalled, and resumes polling after %s',
    async (_label, createError) => {
      const config = testConfig();
      const controller = new AbortController();
      const ranges: Array<[bigint | undefined, bigint | undefined]> = [];
      let headCalls = 0;
      let releaseRetry!: () => void;
      let markRetryReached!: () => void;
      const retryReached = new Promise<void>((resolve) => {
        markRetryReached = resolve;
      });
      const retryRelease = new Promise<void>((resolve) => {
        releaseRetry = resolve;
      });
      const client = asClient({
        getBlockNumber: async () => {
          headCalls += 1;
          if (headCalls === 1) return 100n;
          if (headCalls === 2) throw createError();
          return 101n;
        },
        getLogs: async ({ address, fromBlock, toBlock }) => {
          if (!Array.isArray(address)) return [];
          ranges.push([fromBlock, toBlock]);
          if (fromBlock === 101n) controller.abort();
          return [];
        },
      });
      const app: FastifyInstance = await buildServer({
        prisma: testPrisma,
        eventBus: new ServerEventBus(),
        indexerStallMs: config.indexerStallMs,
        logger: false,
      });
      const warning = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const exit = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => {
          throw new Error('process.exit must not be called for a transient RPC error');
        }) as typeof process.exit);

      const run = runIndexer(testPrisma, config, {
        once: false,
        client,
        chainStateReader: testChainStateReader,
        random: () => 0,
        signal: controller.signal,
        wait: async (milliseconds) => {
          if (milliseconds === config.fallbackPollMs) return;
          markRetryReached();
          await retryRelease;
        },
      });

      try {
        await retryReached;
        expect(
          (await app.inject({ method: 'GET', url: '/health' })).json(),
        ).toMatchObject({ ok: true, indexerStatus: 'degraded' });

        await testPrisma.indexerState.update({
          where: { id: 1 },
          data: { lastSuccessfulPollAt: new Date(Date.now() - 2_000) },
        });
        expect(
          (await app.inject({ method: 'GET', url: '/health' })).json(),
        ).toMatchObject({ ok: false, indexerStatus: 'stalled' });

        releaseRetry();
        await run;

        expect(
          (await app.inject({ method: 'GET', url: '/health' })).json(),
        ).toMatchObject({
          ok: true,
          indexerStatus: 'degraded',
          indexedBlock: 101,
          headBlock: 101,
        });
        expect(ranges).toEqual([
          [100n, 100n],
          [101n, 101n],
        ]);
        expect(exit).not.toHaveBeenCalled();
        expect(warning).toHaveBeenCalledWith(
          expect.stringContaining('[indexer] RPC getBlockNumber failed'),
        );
        expect(info).toHaveBeenCalledWith(
          expect.stringContaining('[indexer] RPC getBlockNumber recovered'),
        );
      } finally {
        releaseRetry();
        controller.abort();
        await run.catch(() => undefined);
        await app.close();
        exit.mockRestore();
        warning.mockRestore();
        info.mockRestore();
      }
    },
  );
});
