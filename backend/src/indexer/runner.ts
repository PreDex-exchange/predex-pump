import { ADDRESSES, ARC } from '@predex-pump/shared';
import type { PrismaClient } from '@prisma/client';
import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  fallback,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

import type { RuntimeConfig } from '../config.js';
import { parseMarketPhase } from '../dedup/indexer.js';
import type { MarketDedupIndexer } from '../dedup/types.js';
import { CONTRACT_BY_ADDRESS, TRACKED_ADDRESSES } from './abis.js';
import { bigintArg, toDbInt } from './derive.js';
import {
  handleDecodedEvent,
  initializeReadModel,
  preloadMarketIdentities,
} from './handlers.js';
import type { DecodedEvent, EventArgs } from './types.js';

const arc = defineChain({
  id: ARC.chainId,
  name: ARC.name,
  nativeCurrency: ARC.nativeCurrency,
  rpcUrls: {
    default: { http: [...ARC.rpcUrls] },
  },
});

export interface IndexerOptions {
  once: boolean;
  replayFrom?: number;
  onEvents?: (events: readonly DecodedEvent[]) => Promise<void>;
  marketDedupIndexer?: MarketDedupIndexer;
}

export interface RangeResult {
  fromBlock: number;
  toBlock: number;
  decodedLogs: number;
  newlyAppliedLogs: number;
}

function createArcClient(rpcUrl: string): PublicClient {
  const rpcUrls = [...new Set([rpcUrl, ...ARC.rpcUrls])];
  return createPublicClient({
    chain: arc,
    transport: fallback(
      rpcUrls.map((url) =>
        http(url, {
          retryCount: 2,
          retryDelay: 500,
          timeout: 30_000,
        }),
      ),
      { rank: false },
    ),
  });
}

async function decodedEventsForRange(
  client: PublicClient,
  fromBlock: number,
  toBlock: number,
): Promise<DecodedEvent[]> {
  const logs = await client.getLogs({
    address: TRACKED_ADDRESSES,
    fromBlock: BigInt(fromBlock),
    toBlock: BigInt(toBlock),
  });

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

async function ingestRange(
  prisma: PrismaClient,
  client: PublicClient,
  fromBlock: number,
  toBlock: number,
  headBlock: number,
  onEvents?: (events: readonly DecodedEvent[]) => Promise<void>,
  marketDedupIndexer?: MarketDedupIndexer,
): Promise<RangeResult> {
  const events = await decodedEventsForRange(client, fromBlock, toBlock);
  const newlyAppliedLogs = await applyDecodedEvents(
    prisma,
    events,
    toBlock,
    headBlock,
    onEvents,
    marketDedupIndexer,
  );

  return {
    fromBlock,
    toBlock,
    decodedLogs: events.length,
    newlyAppliedLogs,
  };
}

function waitForPoll(milliseconds: number, stopped: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (stopped()) {
      resolve();
      return;
    }
    setTimeout(resolve, milliseconds);
  });
}

export async function runIndexer(
  prisma: PrismaClient,
  config: RuntimeConfig,
  options: IndexerOptions,
): Promise<void> {
  const client = createArcClient(config.rpcUrl);
  await prisma.$transaction(
    (tx) => initializeReadModel(tx, config.deployBlock),
    { timeout: 30_000 },
  );

  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    let head = toDbInt(await client.getBlockNumber(), 'headBlock');
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

    while (!stopping) {
      head = toDbInt(await client.getBlockNumber(), 'headBlock');
      await prisma.indexerState.update({
        where: { id: 1 },
        data: { headBlock: head },
      });

      while (nextBlock <= head && !stopping) {
        const toBlock = Math.min(head, nextBlock + config.blockChunk - 1);
        const result = await ingestRange(
          prisma,
          client,
          nextBlock,
          toBlock,
          head,
          options.onEvents,
          options.marketDedupIndexer,
        );
        console.info(
          `[indexer] ${result.fromBlock}-${result.toBlock} ` +
            `decoded=${result.decodedLogs} applied=${result.newlyAppliedLogs}`,
        );
        nextBlock = toBlock + 1;
      }

      if (replaying) {
        state = await prisma.indexerState.findUniqueOrThrow({ where: { id: 1 } });
        nextBlock = Math.max(config.deployBlock, state.lastBlock + 1);
        replaying = false;
      }

      if (options.once) break;
      await waitForPoll(config.pollMs, () => stopping);
    }

    state = await prisma.indexerState.findUniqueOrThrow({ where: { id: 1 } });
    console.info(
      `[indexer] stopped cursor=${state.lastBlock} head=${state.headBlock} ` +
        `lag=${Math.max(0, state.headBlock - state.lastBlock)}`,
    );
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
