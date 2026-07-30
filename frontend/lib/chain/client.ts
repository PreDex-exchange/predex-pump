import {
  createPublicClient,
  decodeEventLog,
  fallback,
  http,
  type Abi,
  type Hash,
  type Hex,
  type TransactionReceipt,
} from 'viem';

import { ADDRESSES, ARC, DEPLOY_BLOCK } from '@/lib/shared/addresses';

import { arcTestnet } from './arc';
import { incubatorLmsrAbi } from './contracts';

const LOG_BLOCK_RANGE = 10_000n;
const CACHE_MS = 12_000;

export const arcPublicClient = createPublicClient({
  chain: arcTestnet,
  transport: fallback(ARC.rpcUrls.map((url) => http(url))),
});

interface RawChainLog {
  address: `0x${string}`;
  blockNumber: bigint | null;
  transactionHash: Hex | null;
  logIndex: number | null;
  data: Hex;
  topics: readonly Hex[];
}

interface ChainEvent {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  transactionHash: Hash;
  logIndex: number;
}

interface TimedPromise<T> {
  createdAt: number;
  promise: Promise<T>;
}

const addressLogCache = new Map<string, TimedPromise<RawChainLog[]>>();
const confirmedLogsByAddress = new Map<string, Map<string, RawChainLog>>();

function cacheIsFresh(entry: TimedPromise<unknown> | undefined) {
  return Boolean(entry && Date.now() - entry.createdAt < CACHE_MS);
}

export function clearChainReadCache() {
  addressLogCache.clear();
}

function chainLogKey(log: RawChainLog) {
  if (log.transactionHash === null || log.logIndex === null) return null;
  return `${log.transactionHash.toLowerCase()}:${log.logIndex}`;
}

function sortChainLogs(logs: RawChainLog[]) {
  return logs.sort((left, right) => {
    const blockDelta = Number(
      (left.blockNumber ?? 0n) - (right.blockNumber ?? 0n),
    );
    if (blockDelta !== 0) return blockDelta;
    return (left.logIndex ?? 0) - (right.logIndex ?? 0);
  });
}

function mergeConfirmedLogs(
  address: `0x${string}`,
  indexedLogs: RawChainLog[],
) {
  const addressKey = address.toLowerCase();
  const confirmedLogs = confirmedLogsByAddress.get(addressKey);
  if (!confirmedLogs?.size) return sortChainLogs(indexedLogs);

  const merged = new Map<string, RawChainLog>();
  const unkeyed: RawChainLog[] = [];
  for (const log of indexedLogs) {
    const key = chainLogKey(log);
    if (key) merged.set(key, log);
    else unkeyed.push(log);
  }
  for (const [key, log] of confirmedLogs) {
    if (merged.has(key)) confirmedLogs.delete(key);
    else merged.set(key, log);
  }
  if (confirmedLogs.size === 0) confirmedLogsByAddress.delete(addressKey);

  return sortChainLogs([...unkeyed, ...merged.values()]);
}

/**
 * A confirmed receipt can be available briefly before eth_getLogs indexes the
 * same block. Keep its relevant logs in the discovery stream until the RPC scan
 * catches up so transaction-critical settlement reads see the receipt promptly.
 */
export function rememberConfirmedChainLogs(receipt: TransactionReceipt) {
  const scannedAddresses = new Set(
    [ADDRESSES.registry, ADDRESSES.lmsr, ADDRESSES.miniClob].map((address) =>
      address.toLowerCase(),
    ),
  );
  let added = false;

  for (const log of receipt.logs) {
    const addressKey = log.address.toLowerCase();
    if (!scannedAddresses.has(addressKey)) continue;
    const rawLog: RawChainLog = {
      address: log.address,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
      data: log.data,
      topics: log.topics,
    };
    const key = chainLogKey(rawLog);
    if (!key) continue;

    const logs = confirmedLogsByAddress.get(addressKey) ?? new Map();
    logs.set(key, rawLog);
    confirmedLogsByAddress.set(addressKey, logs);
    added = true;
  }

  if (added) clearChainReadCache();
}

async function getAddressLogs(address: `0x${string}`) {
  const key = address.toLowerCase();
  const cached = addressLogCache.get(key);
  if (cacheIsFresh(cached)) return cached!.promise;

  const promise = (async () => {
    const head = await arcPublicClient.getBlockNumber();
    const firstBlock = BigInt(DEPLOY_BLOCK);
    if (head < firstBlock) return mergeConfirmedLogs(address, []);

    const ranges: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
    for (
      let fromBlock = firstBlock;
      fromBlock <= head;
      fromBlock += LOG_BLOCK_RANGE
    ) {
      const candidateEnd = fromBlock + LOG_BLOCK_RANGE - 1n;
      ranges.push({
        fromBlock,
        toBlock: candidateEnd < head ? candidateEnd : head,
      });
    }

    const chunks = await Promise.all(
      ranges.map(({ fromBlock, toBlock }) =>
        arcPublicClient.getLogs({
          address,
          fromBlock,
          toBlock,
        }),
      ),
    );

    return mergeConfirmedLogs(address, chunks.flat() as RawChainLog[]);
  })();

  addressLogCache.set(key, { createdAt: Date.now(), promise });
  return promise;
}

function decodeLogs(logs: RawChainLog[], abi: Abi): ChainEvent[] {
  const decoded: ChainEvent[] = [];

  for (const log of logs) {
    if (
      log.blockNumber === null ||
      log.transactionHash === null ||
      log.logIndex === null
    ) {
      continue;
    }

    try {
      const event = decodeEventLog({
        abi,
        data: log.data,
        topics: log.topics as [signature: Hex, ...args: Hex[]],
        strict: false,
      });
      if (!event.eventName) continue;
      decoded.push({
        eventName: event.eventName,
        args: (event.args ?? {}) as Record<string, unknown>,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
      });
    } catch {
      // An address-level scan can contain proxy/admin events outside the selected ABI.
    }
  }

  return decoded;
}

function bigintArg(args: Record<string, unknown>, name: string) {
  const value = args[name];
  return typeof value === 'bigint' ? value : 0n;
}

export interface SettlementEventState {
  fundingResidualClaimedRaw: bigint;
  protocolSweepCompleted: boolean;
  protocolSweptRaw: bigint;
}

/**
 * terminalAccounting exposes protocol PnL swept, but the LMSR intentionally
 * keeps its protocol-fee swept counter private. The emitted closeout events are
 * therefore the authoritative public read for whether the one-shot protocol
 * sweep has completed.
 */
export async function readSettlementEventState(
  marketId: bigint,
  options: { fresh?: boolean } = {},
): Promise<SettlementEventState> {
  if (options.fresh) {
    addressLogCache.delete(ADDRESSES.lmsr.toLowerCase());
  }
  const events = decodeLogs(
    await getAddressLogs(ADDRESSES.lmsr),
    incubatorLmsrAbi,
  ).filter((event) => bigintArg(event.args, 'marketId') === marketId);

  let fundingResidualClaimedRaw = 0n;
  let protocolSweepCompleted = false;
  let protocolSweptRaw = 0n;
  for (const event of events) {
    if (event.eventName === 'FundingResidualClaimed') {
      fundingResidualClaimedRaw += bigintArg(event.args, 'amountRaw');
    } else if (event.eventName === 'ProtocolFeeSwept') {
      protocolSweptRaw += bigintArg(event.args, 'amountRaw');
      protocolSweepCompleted =
        protocolSweepCompleted || Boolean(event.args.closeoutComplete);
    }
  }

  return {
    fundingResidualClaimedRaw,
    protocolSweepCompleted,
    protocolSweptRaw,
  };
}
