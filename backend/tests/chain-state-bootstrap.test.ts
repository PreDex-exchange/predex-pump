import { ADDRESSES, ARC } from '@predex-pump/shared';
import type { FastifyInstance } from 'fastify';
import type { Address, PublicClient } from 'viem';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildServer } from '../src/api/server.js';
import { getHealth } from '../src/api/queries.js';
import { loadRuntimeConfig, type RuntimeConfig } from '../src/config.js';
import { ServerEventBus } from '../src/events/bus.js';
import {
  bootstrapChainState,
  validateChainStateSnapshot,
  ViemChainStateReader,
  type ChainStateReader,
  type ChainStateSnapshot,
} from '../src/indexer/chain-state-bootstrap.js';
import { initializeReadModel } from '../src/indexer/handlers.js';
import { applyDecodedEvents, runIndexer } from '../src/indexer/runner.js';
import type { DecodedEvent } from '../src/indexer/types.js';
import {
  COMMITTEE_SIGNERS,
  chainStateSnapshot,
} from './chain-state-fixtures.js';
import { resetDatabase, testPrisma } from './database.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_HASH = `0x${'0'.repeat(64)}`;
const LIVE_DEFAULT_PARAMS = [
  0n,
  1_000_000n,
  5_000_000n,
  10_000_000n,
  1_000_000n,
  0n,
  100_000n,
  20_000_000n,
  5_000_000n,
  25_000_000n,
  1_000_000n,
  2_592_000n,
  300n,
  7_776_000n,
  0n,
  20n,
  0n,
] as const;

function testConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    ...loadRuntimeConfig(),
    deployBlock: 100,
    blockChunk: 1_000,
    // Tests drive a fake transport, not a rate-limited endpoint.
    requestSpacingMs: 0,
    chunkDelayMs: 0,
    webSocketRpcUrls: [],
    indexerStartPolicy: 'head',
    indexerMaxBackfillBlocks: 5,
    ...overrides,
  };
}

function mockChainClient(options: {
  defaultParams?: unknown;
  failSignerIndex?: number;
} = {}): {
  client: PublicClient;
  multicall: ReturnType<typeof vi.fn>;
  getLogs: ReturnType<typeof vi.fn>;
} {
  const params = chainStateSnapshot(110).registry.params;
  const multicall = vi.fn(
    async (input: {
      blockNumber: bigint;
      allowFailure: boolean;
      contracts: readonly {
        address: Address;
        functionName: string;
        args?: readonly unknown[];
      }[];
    }) =>
      input.contracts.map((contract) => {
        const index = Number(contract.args?.[0] ?? 0);
        if (
          contract.functionName === 'currentSigners' &&
          index === options.failSignerIndex
        ) {
          return { status: 'failure' as const, error: new Error('mock signer read failed') };
        }
        let result: unknown;
        switch (contract.functionName) {
          case 'defaultParams':
            result = options.defaultParams ?? {
              openingFeeRaw: BigInt(params.openingFeeRaw),
              seedFloorRaw: BigInt(params.seedFloorRaw),
              seedCapRaw: BigInt(params.seedCapRaw),
              fCapRaw: BigInt(params.fCapRaw),
              singleTopUpCapRaw: BigInt(params.singleTopUpCapRaw),
              graduationMoneyInThresholdRaw: BigInt(
                params.graduationMoneyInThresholdRaw,
              ),
              graduationTollRaw: BigInt(params.graduationTollRaw),
              inventoryTargetRaw: BigInt(params.inventoryTargetRaw),
              inventoryLowRaw: BigInt(params.inventoryLowRaw),
              inventoryHighRaw: BigInt(params.inventoryHighRaw),
              freeCollateralBufferRaw: BigInt(params.freeCollateralBufferRaw),
              tradingWindow: params.defaultTradingWindowSeconds,
              minTradingWindowSeconds: params.minTradingWindowSeconds,
              maxTradingWindowSeconds: params.maxTradingWindowSeconds,
              minimumTimeOpen: params.minimumTimeOpenSeconds,
              protocolFeeBps: params.protocolFeeBps,
              depthFeeBps: params.depthFeeBps,
            };
            break;
          case 'defaultMarketTypeVersion':
            result = 2;
            break;
          case 'currentSignerCount':
          case 'currentThreshold':
            result = 2n;
            break;
          case 'MAX_SIGNATURES':
            result = 10n;
            break;
          case 'collateral':
            result = ADDRESSES.usdc;
            break;
          case 'collateralDecimals':
            result = ARC.usdcErc20Decimals;
            break;
          case 'committeeOracleV2':
            result = ADDRESSES.oracle;
            break;
          case 'miniClob':
            result = ADDRESSES.miniClob;
            break;
          case 'lmsr':
            result = ADDRESSES.lmsr;
            break;
          case 'ctf':
            result = ADDRESSES.ctf;
            break;
          case 'marketTypes':
            result =
              index === 0
                ? [false, ZERO_ADDRESS, ZERO_HASH]
                : [
                    true,
                    ADDRESSES.lmsr,
                    `0x${String(index).repeat(64)}`,
                  ];
            break;
          case 'currentSigners':
            result = COMMITTEE_SIGNERS[index];
            break;
          default:
            throw new Error(`Unexpected mocked contract call ${contract.functionName}`);
        }
        return { status: 'success' as const, result };
      }),
  );
  const getLogs = vi.fn(async () => []);
  return {
    multicall,
    getLogs,
    client: {
      getBlockNumber: vi.fn(async () => 110n),
      getLogs,
      getBlock: vi.fn(),
      multicall,
    } as unknown as PublicClient,
  };
}

async function initializeAt(blockNumber: number): Promise<void> {
  await testPrisma.$transaction(async (tx) => {
    await initializeReadModel(tx, 100);
    await tx.indexerState.update({
      where: { id: 1 },
      data: { lastBlock: blockNumber, headBlock: blockNumber },
    });
  });
}

async function materializedSnapshot() {
  return {
    config: await testPrisma.registryConfig.findUniqueOrThrow({ where: { id: 1 } }),
    members: await testPrisma.committeeMember.findMany({ orderBy: { address: 'asc' } }),
    marketTypes: await testPrisma.registeredMarketType.findMany({
      orderBy: { version: 'asc' },
    }),
  };
}

function readerFor(snapshot: ChainStateSnapshot): ChainStateReader {
  return { readChainState: async () => snapshot };
}

function defaultParamsEvent(input: {
  blockNumber: number;
  logIndex: number;
  seedFloorRaw: bigint;
  txDigit: string;
}): DecodedEvent {
  const params = chainStateSnapshot(input.blockNumber).registry.params;
  return {
    source: 'REGISTRY',
    address: ADDRESSES.registry,
    eventName: 'DefaultParamsUpdated',
    args: {
      params: {
        openingFeeRaw: BigInt(params.openingFeeRaw),
        seedFloorRaw: input.seedFloorRaw,
        seedCapRaw: 6_000_000n,
        fCapRaw: BigInt(params.fCapRaw),
        singleTopUpCapRaw: BigInt(params.singleTopUpCapRaw),
        graduationMoneyInThresholdRaw: BigInt(
          params.graduationMoneyInThresholdRaw,
        ),
        graduationTollRaw: BigInt(params.graduationTollRaw),
        inventoryTargetRaw: BigInt(params.inventoryTargetRaw),
        inventoryLowRaw: BigInt(params.inventoryLowRaw),
        inventoryHighRaw: BigInt(params.inventoryHighRaw),
        freeCollateralBufferRaw: BigInt(params.freeCollateralBufferRaw),
        tradingWindow: BigInt(params.defaultTradingWindowSeconds),
        minTradingWindowSeconds: BigInt(params.minTradingWindowSeconds),
        maxTradingWindowSeconds: BigInt(params.maxTradingWindowSeconds),
        minimumTimeOpen: BigInt(params.minimumTimeOpenSeconds),
        protocolFeeBps: BigInt(params.protocolFeeBps),
        depthFeeBps: BigInt(params.depthFeeBps),
      },
      marketTypeVersion: 2n,
    },
    txHash: `0x${input.txDigit.repeat(64)}` as `0x${string}`,
    logIndex: input.logIndex,
    blockNumber: input.blockNumber,
    ts: 1_700_000_000 + input.blockNumber,
  };
}

describe('chain-state bootstrap', () => {
  beforeEach(async () => {
    await resetDatabase();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it('bootstraps the exact live registry tuple and serves its usable config values', async () => {
    const { client, getLogs, multicall } = mockChainClient({
      defaultParams: LIVE_DEFAULT_PARAMS,
    });
    const observedAt = new Date('2026-08-12T08:00:00.000Z');
    let registryParamsSeenBeforeHeadEvents: string | undefined;
    getLogs.mockImplementation(async (input: { address?: unknown }) => {
      if (Array.isArray(input.address)) {
        registryParamsSeenBeforeHeadEvents = (
          await testPrisma.registryConfig.findUniqueOrThrow({ where: { id: 1 } })
        ).seedFloorRaw;
      }
      return [];
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await runIndexer(testPrisma, testConfig(), {
      once: true,
      client,
      now: () => observedAt,
    });

    expect(multicall).toHaveBeenCalledTimes(2);
    expect(registryParamsSeenBeforeHeadEvents).toBe('1000000');
    expect(multicall.mock.calls).toEqual([
      [expect.objectContaining({ allowFailure: true, blockNumber: 109n })],
      [expect.objectContaining({ allowFailure: true, blockNumber: 109n })],
    ]);
    expect(await testPrisma.registryConfig.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({
      openingFeeRaw: '0',
      seedFloorRaw: '1000000',
      seedCapRaw: '5000000',
      fCapRaw: '10000000',
      singleTopUpCapRaw: '1000000',
      graduationMoneyInThresholdRaw: '0',
      graduationTollRaw: '100000',
      inventoryTargetRaw: '20000000',
      inventoryLowRaw: '5000000',
      inventoryHighRaw: '25000000',
      freeCollateralBufferRaw: '1000000',
      defaultTradingWindowSeconds: 2_592_000,
      minTradingWindowSeconds: 300,
      maxTradingWindowSeconds: 7_776_000,
      minimumTimeOpenSeconds: 0,
      protocolFeeBps: 20,
      depthFeeBps: 0,
      marketTypeVersion: 2,
      committeeThreshold: 2,
      updatedBlock: 109,
      updatedLogIndex: 2_147_483_647,
    });
    expect(
      await testPrisma.committeeMember.findMany({
        where: { active: true },
        orderBy: { address: 'asc' },
      }),
    ).toEqual([
      expect.objectContaining({ address: COMMITTEE_SIGNERS[0], updatedBlock: 109 }),
      expect.objectContaining({ address: COMMITTEE_SIGNERS[1], updatedBlock: 109 }),
    ]);
    expect(
      await testPrisma.registeredMarketType.findMany({
        orderBy: { version: 'asc' },
      }),
    ).toEqual([
      expect.objectContaining({ version: 1, blockNumber: 109 }),
      expect.objectContaining({ version: 2, blockNumber: 109 }),
    ]);

    const app: FastifyInstance = await buildServer({
      prisma: testPrisma,
      eventBus: new ServerEventBus(),
      logger: false,
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/config' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        marketTypeVersion: 2,
        seedFloorRaw: '1000000',
        seedCapRaw: '5000000',
        graduationTollRaw: '100000',
        protocolFeeBps: 20,
        minTradingWindowSeconds: 300,
        maxTradingWindowSeconds: 7_776_000,
        committee: { signers: [...COMMITTEE_SIGNERS], threshold: 2 },
      });
    } finally {
      await app.close();
    }
  });

  it('does not apply the first post-gap block until its prerequisite snapshot succeeds', async () => {
    const { client, getLogs } = mockChainClient({ failSignerIndex: 1 });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runIndexer(testPrisma, testConfig(), { once: true, client });

    expect(getLogs).not.toHaveBeenCalled();
    expect(await testPrisma.registryConfig.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({
      seedFloorRaw: '0',
      updatedBlock: 99,
    });
    expect(await getHealth(testPrisma)).toMatchObject({
      ok: false,
      chainState: {
        ready: false,
        status: 'failed',
        attemptedBlock: 109,
        error: expect.stringContaining('currentSigners(1) failed'),
      },
    });
  });

  it('bootstraps an externally advanced cursor before a small resume catch-up', async () => {
    await initializeAt(108);
    const { client, getLogs } = mockChainClient();
    let registryParamsSeenBeforeCatchUp: string | undefined;
    getLogs.mockImplementation(async (input: { address?: unknown }) => {
      if (Array.isArray(input.address)) {
        registryParamsSeenBeforeCatchUp = (
          await testPrisma.registryConfig.findUniqueOrThrow({ where: { id: 1 } })
        ).seedFloorRaw;
      }
      return [];
    });
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await runIndexer(
      testPrisma,
      testConfig({ indexerStartPolicy: 'auto' }),
      { once: true, client },
    );

    expect(registryParamsSeenBeforeCatchUp).toBe('1000000');
    expect(await testPrisma.indexerGap.count()).toBe(0);
    expect(await testPrisma.indexerState.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({
      lastBlock: 110,
      chainStateBootstrapStatus: 'COMPLETE',
      chainStateBootstrapBlock: 108,
      chainStateBootstrapRpcRequestCount: 2,
    });
  });

  it('accepts zero for every non-required MarketParams field', async () => {
    await initializeAt(110);
    const snapshot = chainStateSnapshot(110);
    snapshot.registry.params = {
      openingFeeRaw: '0',
      seedFloorRaw: '1000000',
      seedCapRaw: '5000000',
      fCapRaw: '0',
      singleTopUpCapRaw: '0',
      graduationMoneyInThresholdRaw: '0',
      graduationTollRaw: '0',
      inventoryTargetRaw: '0',
      inventoryLowRaw: '0',
      inventoryHighRaw: '0',
      freeCollateralBufferRaw: '0',
      defaultTradingWindowSeconds: 0,
      minTradingWindowSeconds: 300,
      maxTradingWindowSeconds: 7_776_000,
      minimumTimeOpenSeconds: 0,
      protocolFeeBps: 0,
      depthFeeBps: 0,
    };

    const result = await bootstrapChainState(testPrisma, readerFor(snapshot), {
      snapshotBlock: 110,
    });

    expect(result).toMatchObject({
      status: 'complete',
      changedRows: expect.any(Number),
    });
    const app = await buildServer({
      prisma: testPrisma,
      eventBus: new ServerEventBus(),
      logger: false,
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/config' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        graduationTollRaw: '0',
        protocolFeeBps: 0,
      });
    } finally {
      await app.close();
    }
  });

  it.each([
    [
      'seedFloorRaw',
      (snapshot: ChainStateSnapshot) => {
        snapshot.registry.params.seedFloorRaw = '0';
      },
    ],
    [
      'seedCapRaw',
      (snapshot: ChainStateSnapshot) => {
        snapshot.registry.params.seedCapRaw = '0';
      },
    ],
    [
      'minTradingWindowSeconds',
      (snapshot: ChainStateSnapshot) => {
        snapshot.registry.params.minTradingWindowSeconds = 0;
      },
    ],
    [
      'maxTradingWindowSeconds',
      (snapshot: ChainStateSnapshot) => {
        snapshot.registry.params.maxTradingWindowSeconds = 0;
      },
    ],
  ] as const)(
    'rejects required parameter %s=0 by name and value',
    (name, zeroParameter) => {
      const snapshot = chainStateSnapshot(110);
      zeroParameter(snapshot);

      expect(() => validateChainStateSnapshot(snapshot)).toThrow(
        `Registry required parameter ${name}=0 must be greater than zero`,
      );
    },
  );

  it('reports completed RPC attempts and the offending value in logs and health', async () => {
    const invalidParams = [...LIVE_DEFAULT_PARAMS];
    invalidParams[1] = 0n;
    const { client } = mockChainClient({ defaultParams: invalidParams });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runIndexer(testPrisma, testConfig(), { once: true, client });

    expect(errorLog).toHaveBeenCalledWith(
      expect.stringMatching(
        /status=failed .*rpcRequests=2 .*seedFloorRaw=0 must be greater than zero/u,
      ),
    );
    expect(await getHealth(testPrisma)).toMatchObject({
      ok: false,
      chainState: {
        status: 'failed',
        rpcRequestCount: 2,
        error: expect.stringContaining('seedFloorRaw=0 must be greater than zero'),
      },
    });
  });

  it('refuses a zero downgrade and leaves every materialized snapshot untouched', async () => {
    await initializeAt(110);
    const good = chainStateSnapshot(110);
    good.registry.params.openingFeeRaw = '500000';
    const first = await bootstrapChainState(testPrisma, readerFor(good), {
      snapshotBlock: 110,
      now: () => new Date('2026-08-12T08:00:00.000Z'),
    });
    expect(first.status).toBe('complete');
    const before = await materializedSnapshot();

    const zeroed = chainStateSnapshot(110);
    zeroed.registry.params.openingFeeRaw = '0';
    const result = await bootstrapChainState(testPrisma, readerFor(zeroed), {
      snapshotBlock: 110,
      now: () => new Date('2026-08-12T08:01:00.000Z'),
    });

    expect(result).toMatchObject({
      status: 'failed',
      rpcRequestCount: 2,
      changedRows: 0,
      error: expect.stringContaining('replace positive openingFeeRaw with zero'),
    });
    expect(await materializedSnapshot()).toEqual(before);
    expect(before.config.openingFeeRaw).toBe('500000');
  });

  it('persists none of a partial Multicall3 response and reports the failure in health', async () => {
    await initializeAt(110);
    expect(
      await bootstrapChainState(testPrisma, readerFor(chainStateSnapshot(110)), {
        snapshotBlock: 110,
      }),
    ).toMatchObject({ status: 'complete' });
    const before = await materializedSnapshot();
    const { client, multicall } = mockChainClient({
      defaultParams: LIVE_DEFAULT_PARAMS,
      failSignerIndex: 1,
    });

    const result = await bootstrapChainState(
      testPrisma,
      new ViemChainStateReader(client),
      { snapshotBlock: 110 },
    );

    expect(multicall).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: 'failed',
      rpcRequestCount: 2,
      changedRows: 0,
      error: expect.stringContaining('currentSigners(1) failed'),
    });
    expect(await materializedSnapshot()).toEqual(before);
    expect(await getHealth(testPrisma)).toMatchObject({
      ok: false,
      chainState: {
        ready: false,
        status: 'failed',
        attemptedBlock: 110,
        snapshotBlock: 110,
        rpcRequestCount: 2,
        error: expect.stringContaining('currentSigners(1) failed'),
        issues: [],
      },
    });
  });

  it('is idempotent at the same cursor-aligned snapshot block', async () => {
    await initializeAt(110);
    const snapshot = chainStateSnapshot(110);
    const first = await bootstrapChainState(testPrisma, readerFor(snapshot), {
      snapshotBlock: 110,
      now: () => new Date('2026-08-12T08:00:00.000Z'),
    });
    expect(first.status).toBe('complete');
    const before = {
      rows: await materializedSnapshot(),
      state: await testPrisma.indexerState.findUniqueOrThrow({ where: { id: 1 } }),
    };

    const second = await bootstrapChainState(testPrisma, readerFor(snapshot), {
      snapshotBlock: 110,
      now: () => new Date('2026-08-12T09:00:00.000Z'),
    });

    expect(second).toMatchObject({ status: 'complete', changedRows: 0 });
    expect({
      rows: await materializedSnapshot(),
      state: await testPrisma.indexerState.findUniqueOrThrow({ where: { id: 1 } }),
    }).toEqual(before);
  });

  it('lets newer events win and rejects an older snapshot or replay', async () => {
    await initializeAt(110);
    await bootstrapChainState(testPrisma, readerFor(chainStateSnapshot(110)), {
      snapshotBlock: 110,
    });

    await applyDecodedEvents(
      testPrisma,
      [
        defaultParamsEvent({
          blockNumber: 111,
          logIndex: 3,
          seedFloorRaw: 2_000_000n,
          txDigit: 'a',
        }),
      ],
      111,
      111,
    );
    expect(await testPrisma.registryConfig.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({
      seedFloorRaw: '2000000',
      updatedBlock: 111,
      updatedLogIndex: 3,
    });

    await applyDecodedEvents(
      testPrisma,
      [
        defaultParamsEvent({
          blockNumber: 109,
          logIndex: 1,
          seedFloorRaw: 1_500_000n,
          txDigit: 'b',
        }),
      ],
      109,
      111,
    );
    const staleBootstrap = await bootstrapChainState(
      testPrisma,
      readerFor(chainStateSnapshot(110)),
      { snapshotBlock: 110 },
    );

    expect(staleBootstrap).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('cursor moved'),
    });
    expect(await testPrisma.registryConfig.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({
      seedFloorRaw: '2000000',
      updatedBlock: 111,
      updatedLogIndex: 3,
    });
  });
});
