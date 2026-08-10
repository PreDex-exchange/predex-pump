import { ADDRESSES, ARC } from '@predex-pump/shared';
import type { PrismaClient } from '@prisma/client';
import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  fallback,
  HttpRequestError,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

import type { RuntimeConfig } from '../config.js';
import { parseMarketPhase } from '../dedup/indexer.js';
import type { MarketDedupIndexer } from '../dedup/types.js';
import {
  COLLATERAL_APPROVAL_EVENT,
  COLLATERAL_TRANSFER_EVENT,
  CONTRACT_BY_ADDRESS,
  CORE_TRACKED_ADDRESSES,
  CTF_APPROVAL_EVENT,
  CTF_EVENT_ABI,
} from './abis.js';
import { bigintArg, toDbInt } from './derive.js';
import {
  handleDecodedEvent,
  initializeReadModel,
  preloadMarketIdentities,
} from './handlers.js';
import { inspectRpcError, retryDelayMs } from './retry.js';
import {
  createViemSubscriptionTransport,
  runSubscriptionSupervisor,
  subscriptionEndpointLabel,
  type IndexerSubscriptionTransportFactory,
} from './subscriptions.js';
import type { DecodedEvent, EventArgs } from './types.js';

const arc = defineChain({
  id: ARC.chainId,
  name: ARC.name,
  nativeCurrency: ARC.nativeCurrency,
  rpcUrls: {
    default: {
      http: [...ARC.rpcUrls],
      webSocket: [...ARC.webSocketRpcUrls],
    },
  },
});

export interface IndexerOptions {
  once: boolean;
  replayFrom?: number;
  onEvents?: (events: readonly DecodedEvent[]) => Promise<void>;
  marketDedupIndexer?: MarketDedupIndexer;
  client?: PublicClient;
  signal?: AbortSignal;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => Date;
  subscriptionTransportFactory?: IndexerSubscriptionTransportFactory;
}

export interface RangeResult {
  fromBlock: number;
  toBlock: number;
  decodedLogs: number;
  newlyAppliedLogs: number;
}

function createArcClient(rpcUrls: readonly string[]): PublicClient {
  return createPublicClient({
    chain: arc,
    transport: fallback(
      rpcUrls.map((url) =>
        http(url, {
          onFetchResponse: (response) => {
            if (
              response.status === 429 ||
              (!response.ok && response.headers.has('retry-after'))
            ) {
              throw new HttpRequestError({
                details: response.statusText,
                headers: response.headers,
                status: response.status,
                url: response.url || url,
              });
            }
          },
          retryCount: 0,
          timeout: 30_000,
        }),
      ),
      {
        rank: false,
        retryCount: 0,
        // A rate-limited public endpoint explicitly asked us to slow down. Do
        // not immediately shift the same request to another shared endpoint.
        shouldThrow: (error) => inspectRpcError(error)?.kind === 'rate-limit',
      },
    ),
  });
}

async function decodedEventsForRange(
  client: PublicClient,
  fromBlock: number,
  toBlock: number,
  collateralOwners: readonly Address[],
): Promise<DecodedEvent[]> {
  const range = {
    fromBlock: BigInt(fromBlock),
    toBlock: BigInt(toBlock),
  } as const;
  // Keep the calls sequential so a shared endpoint's rate-limit response stops
  // the range immediately instead of creating a burst of doomed requests.
  const coreLogs = await client.getLogs({
    address: CORE_TRACKED_ADDRESSES,
    ...range,
  });
  const ctfLogs = await client.getLogs({
    address: ADDRESSES.ctf,
    events: CTF_EVENT_ABI,
    ...range,
  });
  const ctfApprovalLogs = await client.getLogs({
    address: ADDRESSES.ctf,
    event: CTF_APPROVAL_EVENT,
    args: { operator: ADDRESSES.ctfExchange },
    ...range,
  });
  const collateralApprovalLogs = await client.getLogs({
    address: ADDRESSES.usdc,
    event: COLLATERAL_APPROVAL_EVENT,
    args: { spender: ADDRESSES.ctfExchange },
    ...range,
  });
  const collateralIncomingLogs =
    collateralOwners.length === 0
      ? []
      : await client.getLogs({
          address: ADDRESSES.usdc,
          event: COLLATERAL_TRANSFER_EVENT,
          args: { to: collateralOwners },
          ...range,
        });
  const collateralOutgoingLogs =
    collateralOwners.length === 0
      ? []
      : await client.getLogs({
          address: ADDRESSES.usdc,
          event: COLLATERAL_TRANSFER_EVENT,
          args: { from: collateralOwners },
          ...range,
        });
  const logs = [
    ...new Map(
      [
        ...coreLogs,
        ...ctfLogs,
        ...ctfApprovalLogs,
        ...collateralApprovalLogs,
        ...collateralIncomingLogs,
        ...collateralOutgoingLogs,
      ].map((log) => [
        `${log.address}:${String(log.transactionHash)}:${String(log.logIndex)}`,
        log,
      ]),
    ).values(),
  ];

  logs.sort((left, right) => {
    const blockDelta = Number((left.blockNumber ?? 0n) - (right.blockNumber ?? 0n));
    return blockDelta !== 0 ? blockDelta : (left.logIndex ?? 0) - (right.logIndex ?? 0);
  });

  const blockNumbers = [
    ...new Set(
      logs.map((log) => {
        if (log.blockNumber === null) {
          throw new Error('Confirmed getLogs response omitted blockNumber');
        }
        return log.blockNumber.toString();
      }),
    ),
  ];
  const blocks = await Promise.all(
    blockNumbers.map(async (blockNumber) => {
      const block = await client.getBlock({ blockNumber: BigInt(blockNumber) });
      return [blockNumber, toDbInt(block.timestamp, 'block.timestamp')] as const;
    }),
  );
  const timestampByBlock = new Map(blocks);

  return logs.map((log) => {
    if (
      log.blockNumber === null ||
      log.transactionHash === null ||
      log.logIndex === null ||
      log.topics[0] === undefined
    ) {
      throw new Error('Confirmed getLogs response omitted canonical log coordinates');
    }
    const contract = CONTRACT_BY_ADDRESS.get(log.address.toLowerCase());
    if (contract === undefined) {
      throw new Error(`Received a log from untracked address ${log.address}`);
    }

    const decoded = decodeEventLog({
      abi: contract.abi,
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
      strict: true,
    });
    if (typeof decoded.eventName !== 'string') {
      throw new Error(`Decoded log ${log.transactionHash}:${log.logIndex} without an event name`);
    }
    const timestamp = timestampByBlock.get(log.blockNumber.toString());
    if (timestamp === undefined) {
      throw new Error(`Missing timestamp for block ${log.blockNumber}`);
    }

    return {
      source: contract.source,
      address: log.address as Address,
      eventName: decoded.eventName,
      args: (decoded.args ?? {}) as EventArgs,
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      blockNumber: toDbInt(log.blockNumber, 'blockNumber'),
      ts: timestamp,
    };
  });
}

export async function applyDecodedEvents(
  prisma: PrismaClient,
  events: readonly DecodedEvent[],
  toBlock: number,
  headBlock: number,
  onEvents?: (events: readonly DecodedEvent[]) => Promise<void>,
  marketDedupIndexer?: MarketDedupIndexer,
  successfulPollAt = new Date(),
): Promise<number> {
  const newlyAppliedEvents = await prisma.$transaction(
    async (tx) => {
      await preloadMarketIdentities(tx, events);
      const applied: DecodedEvent[] = [];
      for (const event of events) {
        if (await handleDecodedEvent(tx, event)) {
          applied.push(event);
        }
      }

      const state = await tx.indexerState.findUniqueOrThrow({ where: { id: 1 } });
      await tx.indexerState.update({
        where: { id: 1 },
        data: {
          // Explicit replay never moves the durable resume cursor backwards.
          lastBlock: Math.max(state.lastBlock, toBlock),
          headBlock,
          lastSuccessfulPollAt: successfulPollAt,
          consecutiveRpcFailures: 0,
        },
      });
      return applied;
    },
    {
      maxWait: 30_000,
      timeout: 120_000,
      isolationLevel: 'Serializable',
    },
  );

  if (newlyAppliedEvents.length > 0 && onEvents !== undefined) {
    // The WebSocket projection observes only committed database state.
    await onEvents(newlyAppliedEvents);
  }
  if (newlyAppliedEvents.length > 0 && marketDedupIndexer !== undefined) {
    for (const event of newlyAppliedEvents) {
      if (event.source !== 'REGISTRY' || event.eventName !== 'MarketCreated') continue;
      let marketId = 'unknown';
      try {
        marketId = bigintArg(event.args, 'marketId').toString();
        const market = await prisma.market.findUniqueOrThrow({
          where: { id: marketId },
          select: { id: true, question: true, phase: true },
        });
        await marketDedupIndexer.indexMarket({
          marketId: market.id,
          question: market.question,
          phase: parseMarketPhase(market.phase),
        });
      } catch (error) {
        // This projection runs after commit and can never invalidate core indexing.
        console.warn(`[dedup-index] market=${marketId} best-effort sync failed`, error);
      }
    }
  }
  return newlyAppliedEvents.length;
}

async function applyRange(
  prisma: PrismaClient,
  events: readonly DecodedEvent[],
  fromBlock: number,
  toBlock: number,
  headBlock: number,
  onEvents?: (events: readonly DecodedEvent[]) => Promise<void>,
  marketDedupIndexer?: MarketDedupIndexer,
  successfulPollAt = new Date(),
): Promise<RangeResult> {
  const newlyAppliedLogs = await applyDecodedEvents(
    prisma,
    events,
    toBlock,
    headBlock,
    onEvents,
    marketDedupIndexer,
    successfulPollAt,
  );

  return {
    fromBlock,
    toBlock,
    decodedLogs: events.length,
    newlyAppliedLogs,
  };
}

function waitForPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
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

interface RpcRetryResult<T> {
  value: T;
  failures: number;
}

async function requestRpcWithRetry<T>(
  prisma: PrismaClient,
  operation: string,
  request: () => Promise<T>,
  signal: AbortSignal,
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>,
  random: () => number,
): Promise<RpcRetryResult<T> | undefined> {
  let failures = 0;
  while (!signal.aborted) {
    try {
      return { value: await request(), failures };
    } catch (error) {
      if (signal.aborted) return undefined;
      const details = inspectRpcError(error);
      if (details === null) throw error;

      failures += 1;
      // A failure from this database write escapes the current catch block; it
      // is fatal rather than being misclassified as another RPC retry.
      await prisma.indexerState.update({
        where: { id: 1 },
        data: { consecutiveRpcFailures: { increment: 1 } },
      });
      const delay = retryDelayMs(failures, details, random);
      const retryAfter =
        details.retryAfterMs === undefined
          ? ''
          : ` retryAfterMs=${details.retryAfterMs}`;
      console.warn(
        `[indexer] RPC ${operation} failed attempt=${failures} ` +
          `kind=${details.kind} retryInMs=${delay}${retryAfter} ` +
          `error="${details.summary}"`,
      );
      await wait(delay, signal);
    }
  }
  return undefined;
}

function logRpcRecovery(operation: string, failures: number): void {
  if (failures > 0) {
    console.info(
      `[indexer] RPC ${operation} recovered after ${failures} ` +
        `${failures === 1 ? 'retry' : 'retries'}`,
    );
  }
}

async function pollHead(
  prisma: PrismaClient,
  client: PublicClient,
  signal: AbortSignal,
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>,
  random: () => number,
  now: () => Date,
): Promise<number | undefined> {
  const result = await requestRpcWithRetry(
    prisma,
    'getBlockNumber',
    () => client.getBlockNumber(),
    signal,
    wait,
    random,
  );
  if (result === undefined) return undefined;
  const head = toDbInt(result.value, 'headBlock');
  await prisma.indexerState.update({
    where: { id: 1 },
    data: {
      headBlock: head,
      lastSuccessfulPollAt: now(),
      consecutiveRpcFailures: 0,
    },
  });
  logRpcRecovery('getBlockNumber', result.failures);
  return head;
}

type SubscriptionStatus =
  | 'connecting'
  | 'backfilling'
  | 'connected'
  | 'polling';

async function setSubscriptionStatus(
  prisma: PrismaClient,
  status: SubscriptionStatus,
): Promise<void> {
  const clearPreviousHeartbeat = status === 'connecting';
  await prisma.indexerSubscriptionState.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      status,
      ...(clearPreviousHeartbeat ? { lastMessageAt: null } : {}),
    },
    update: {
      status,
      ...(clearPreviousHeartbeat ? { lastMessageAt: null } : {}),
    },
  });
}

async function recordSubscriptionHeartbeat(
  prisma: PrismaClient,
  headBlock: number,
  at: Date,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const state = await tx.indexerSubscriptionState.findUniqueOrThrow({
      where: { id: 1 },
    });
    await tx.indexerSubscriptionState.update({
      where: { id: 1 },
      data: {
        headBlock: Math.max(state.headBlock, headBlock),
        lastMessageAt: at,
      },
    });
  });
}

async function loadCollateralOwners(prisma: PrismaClient): Promise<Address[]> {
  return (
    await prisma.signedOrder.findMany({
      where: {
        exchangeSide: 0,
        status: { in: ['OPEN', 'PARTIALLY_FILLED'] },
        withdrawnAt: null,
      },
      select: { maker: true },
      distinct: ['maker'],
    })
  ).map((order) => order.maker as Address);
}

class IndexerWakeSignal {
  private pending = false;
  private wake: (() => void) | undefined;

  notify(): void {
    this.pending = true;
    this.wake?.();
  }

  async wait(
    milliseconds: number,
    signal: AbortSignal,
    wait: (milliseconds: number, signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    if (this.pending || signal.aborted) {
      this.pending = false;
      return;
    }

    const timerController = new AbortController();
    const abortTimer = () => timerController.abort();
    signal.addEventListener('abort', abortTimer, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: unknown): void => {
          if (settled) return;
          settled = true;
          this.wake = undefined;
          timerController.abort();
          if (error === undefined) resolve();
          else reject(error);
        };
        this.wake = () => finish();
        void wait(milliseconds, timerController.signal).then(
          () => finish(),
          (error) => finish(error),
        );
      });
    } finally {
      this.pending = false;
      signal.removeEventListener('abort', abortTimer);
    }
  }
}

export async function runIndexer(
  prisma: PrismaClient,
  config: RuntimeConfig,
  options: IndexerOptions,
): Promise<void> {
  const client = options.client ?? createArcClient(config.rpcUrls);
  const wait = options.wait ?? waitForPoll;
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => new Date());
  const createSubscriptionTransport =
    options.subscriptionTransportFactory ?? createViemSubscriptionTransport;
  await prisma.$transaction(
    (tx) => initializeReadModel(tx, config.deployBlock),
    { timeout: 30_000 },
  );

  const stopController = new AbortController();
  const stop = (): void => {
    stopController.abort();
  };
  if (options.signal?.aborted) stop();
  options.signal?.addEventListener('abort', stop, { once: true });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  let subscriptionRun: Promise<void> | undefined;
  try {
    await setSubscriptionStatus(prisma, 'polling');
    let head = await pollHead(
      prisma,
      client,
      stopController.signal,
      wait,
      random,
      now,
    );
    if (head === undefined) return;
    let state = await prisma.indexerState.findUniqueOrThrow({ where: { id: 1 } });
    if (state.lastBlock > head) {
      throw new Error(
        `Cursor guard: database lastBlock=${state.lastBlock} is ahead of Arc head=${head}`,
      );
    }

    if (
      options.replayFrom !== undefined &&
      (options.replayFrom < config.deployBlock || options.replayFrom > head)
    ) {
      throw new Error(
        `--replay-from must be between DEPLOY_BLOCK=${config.deployBlock} and head=${head}`,
      );
    }

    let nextBlock = options.replayFrom ?? Math.max(config.deployBlock, state.lastBlock + 1);
    let replaying = options.replayFrom !== undefined;
    console.info(
      `[indexer] chain=${ARC.chainId} registry=${ADDRESSES.registry.toLowerCase()} ` +
        `cursor=${state.lastBlock} head=${head} start=${nextBlock}` +
        (replaying ? ' replay=true' : ''),
    );

    const catchUpTo = async (targetHead: number): Promise<boolean> => {
      while (nextBlock <= targetHead && !stopController.signal.aborted) {
        const toBlock = Math.min(
          targetHead,
          nextBlock + config.blockChunk - 1,
        );
        const collateralOwners = await loadCollateralOwners(prisma);
        const decoded = await requestRpcWithRetry(
          prisma,
          `getLogs blocks=${nextBlock}-${toBlock}`,
          () => decodedEventsForRange(client, nextBlock, toBlock, collateralOwners),
          stopController.signal,
          wait,
          random,
        );
        if (decoded === undefined) return false;
        const result = await applyRange(
          prisma,
          decoded.value,
          nextBlock,
          toBlock,
          targetHead,
          options.onEvents,
          options.marketDedupIndexer,
          now(),
        );
        logRpcRecovery(`getLogs blocks=${nextBlock}-${toBlock}`, decoded.failures);
        console.info(
          `[indexer] ${result.fromBlock}-${result.toBlock} ` +
            `decoded=${result.decodedLogs} applied=${result.newlyAppliedLogs}`,
        );
        nextBlock = toBlock + 1;
        if (
          nextBlock <= targetHead &&
          !stopController.signal.aborted &&
          config.chunkDelayMs > 0
        ) {
          await wait(config.chunkDelayMs, stopController.signal);
        }
      }
      return !stopController.signal.aborted;
    };

    if (!(await catchUpTo(head))) return;

    if (replaying && !stopController.signal.aborted) {
      state = await prisma.indexerState.findUniqueOrThrow({ where: { id: 1 } });
      nextBlock = Math.max(config.deployBlock, state.lastBlock + 1);
      replaying = false;
    }

    if (!options.once) {
      const wake = new IndexerWakeSignal();
      let activeGeneration: number | undefined;
      let trustedGeneration: number | undefined;
      let latestHeadWatermark = head;
      let pendingActivityBlock: number | undefined;

      if (config.webSocketRpcUrls.length === 0) {
        console.warn(
          `[indexer] websocket=disabled mode=polling ` +
            `fallbackPollMs=${config.fallbackPollMs}`,
        );
      } else {
        subscriptionRun = runSubscriptionSupervisor({
          urls: config.webSocketRpcUrls,
          signal: stopController.signal,
          wait,
          now,
          stallMs: config.webSocketStallMs,
          heartbeatMs: config.webSocketHeartbeatMs,
          ownerRefreshMs: config.webSocketOwnerRefreshMs,
          reconnectBaseMs: config.webSocketReconnectBaseMs,
          reconnectMaxMs: config.webSocketReconnectMaxMs,
          loadCollateralOwners: () => loadCollateralOwners(prisma),
          createTransport: createSubscriptionTransport,
          async onConnecting(url) {
            await setSubscriptionStatus(prisma, 'connecting');
            console.info(
              `[indexer] websocket=connecting ` +
                `endpoint=${subscriptionEndpointLabel(url)}`,
            );
            wake.notify();
          },
          async onConnected(details) {
            await setSubscriptionStatus(prisma, 'backfilling');
            activeGeneration = details.generation;
            console.info(
              `[indexer] websocket=subscribed ` +
                `endpoint=${subscriptionEndpointLabel(details.url)} ` +
                `logFilters=${details.logSubscriptionCount} mode=backfill`,
            );
            wake.notify();
          },
          async onDisconnected(details) {
            if (
              details.generation === undefined ||
              activeGeneration === details.generation
            ) {
              activeGeneration = undefined;
            }
            await setSubscriptionStatus(prisma, 'polling');
            const message =
              `[indexer] websocket=down mode=polling ` +
              `fallbackPollMs=${config.fallbackPollMs} ` +
              `retryInMs=${details.retryInMs} ` +
              `error="${details.error.message}"`;
            if (details.retryInMs === 0) console.info(message);
            else console.warn(message);
            wake.notify();
          },
          onHead(blockNumber) {
            latestHeadWatermark = Math.max(
              latestHeadWatermark,
              blockNumber,
            );
          },
          onActivity(blockNumber, generation) {
            if (activeGeneration !== generation) return;
            pendingActivityBlock = Math.max(
              pendingActivityBlock ?? 0,
              blockNumber,
            );
            wake.notify();
          },
          async onHeartbeat({ blockNumber, generation, receivedAt }) {
            if (
              activeGeneration !== generation ||
              trustedGeneration !== generation
            ) {
              return;
            }
            await recordSubscriptionHeartbeat(
              prisma,
              blockNumber,
              receivedAt,
            );
          },
          onOwnerFilterRefresh(ownerCount) {
            console.info(
              `[indexer] websocket=refreshing collateralOwners=${ownerCount}`,
            );
          },
        }).catch(async (error: unknown) => {
          activeGeneration = undefined;
          await setSubscriptionStatus(prisma, 'polling').catch(() => undefined);
          console.warn(
            `[indexer] websocket=failed mode=polling ` +
              `fallbackPollMs=${config.fallbackPollMs} error="${String(error)}"`,
          );
          wake.notify();
        });
      }

      let currentPollInterval = config.fallbackPollMs;
      let nextPollAt = now().getTime() + currentPollInterval;

      while (!stopController.signal.aborted) {
        const isTrusted =
          activeGeneration !== undefined &&
          trustedGeneration === activeGeneration;
        const desiredPollInterval = isTrusted
          ? config.pollMs
          : config.fallbackPollMs;
        if (desiredPollInterval !== currentPollInterval) {
          const candidate = now().getTime() + desiredPollInterval;
          nextPollAt =
            desiredPollInterval < currentPollInterval
              ? Math.min(nextPollAt, candidate)
              : candidate;
          currentPollInterval = desiredPollInterval;
        }

        if (
          activeGeneration !== undefined &&
          trustedGeneration !== activeGeneration
        ) {
          const generation = activeGeneration;
          const reconnectHead = await pollHead(
            prisma,
            client,
            stopController.signal,
            wait,
            random,
            now,
          );
          if (reconnectHead === undefined) break;
          head = Math.max(head, reconnectHead);
          latestHeadWatermark = Math.max(latestHeadWatermark, reconnectHead);
          if (!(await catchUpTo(reconnectHead))) break;
          if (
            pendingActivityBlock !== undefined &&
            pendingActivityBlock <= reconnectHead
          ) {
            pendingActivityBlock = undefined;
          }

          if (activeGeneration === generation) {
            trustedGeneration = generation;
            await setSubscriptionStatus(prisma, 'connected');
            if (activeGeneration !== generation) {
              trustedGeneration = undefined;
              await setSubscriptionStatus(
                prisma,
                activeGeneration === undefined ? 'polling' : 'backfilling',
              );
            } else {
              console.info(
                `[indexer] websocket=connected mode=subscription ` +
                  `safetyPollMs=${config.pollMs}`,
              );
              currentPollInterval = config.pollMs;
              nextPollAt = now().getTime() + config.pollMs;
            }
          }
          continue;
        }

        if (pendingActivityBlock !== undefined && isTrusted) {
          await wait(config.webSocketCoalesceMs, stopController.signal);
          if (stopController.signal.aborted) break;
          const targetHead = Math.max(
            pendingActivityBlock,
            latestHeadWatermark,
          );
          head = Math.max(head, targetHead);
          if (!(await catchUpTo(targetHead))) break;
          if (
            pendingActivityBlock !== undefined &&
            pendingActivityBlock <= targetHead
          ) {
            pendingActivityBlock = undefined;
          }
          continue;
        }

        const currentTime = now().getTime();
        if (currentTime >= nextPollAt) {
          const polledHead = await pollHead(
            prisma,
            client,
            stopController.signal,
            wait,
            random,
            now,
          );
          if (polledHead === undefined) break;
          head = Math.max(head, polledHead);
          latestHeadWatermark = Math.max(latestHeadWatermark, polledHead);
          if (!(await catchUpTo(polledHead))) break;
          if (
            pendingActivityBlock !== undefined &&
            pendingActivityBlock <= polledHead
          ) {
            pendingActivityBlock = undefined;
          }
          const trustedAfterPoll =
            activeGeneration !== undefined &&
            trustedGeneration === activeGeneration;
          currentPollInterval = trustedAfterPoll
            ? config.pollMs
            : config.fallbackPollMs;
          nextPollAt = now().getTime() + currentPollInterval;
          continue;
        }

        await wake.wait(
          Math.max(1, nextPollAt - currentTime),
          stopController.signal,
          wait,
        );
      }
    }

    state = await prisma.indexerState.findUniqueOrThrow({ where: { id: 1 } });
    console.info(
      `[indexer] stopped cursor=${state.lastBlock} head=${state.headBlock} ` +
        `lag=${Math.max(0, state.headBlock - state.lastBlock)}`,
    );
  } finally {
    stopController.abort();
    await subscriptionRun;
    await setSubscriptionStatus(prisma, 'polling').catch(() => undefined);
    options.signal?.removeEventListener('abort', stop);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
