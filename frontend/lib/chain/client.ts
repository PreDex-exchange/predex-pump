import type {
  Account,
  ActivityEvent,
  Address,
  Hash,
  Market,
  MarketParams,
  MarketPhase,
  Order,
  OrderBook,
  Position,
  PricePoint,
  RegistryConfig,
  Resolution,
  Trade,
} from '@predex-pump/shared/domain';
import type {
  AccountResponse,
  ActivityResponse,
  ListMarketsResponse,
  MarketBookResponse,
  MarketDetailResponse,
  PriceHistoryResponse,
} from '@predex-pump/shared/rest';
import {
  createPublicClient,
  decodeEventLog,
  fallback,
  getAddress,
  hexToString,
  http,
  isAddress,
  type Abi,
  type Hex,
  type TransactionReceipt,
} from 'viem';

import type { ApiClient } from '@/lib/api/types';
import { ADDRESSES, ARC, DEPLOY_BLOCK } from '@/lib/shared/addresses';

import { arcTestnet } from './arc';
import {
  committeeOracleAbi,
  collateralErc20Abi,
  conditionalTokensAbi,
  incubatorLmsrAbi,
  incubatorRegistryAbi,
  miniClobAbi,
} from './contracts';

const LOG_BLOCK_RANGE = 10_000n;
const CACHE_MS = 12_000;
const PRICE_SCALE = 1_000_000n;
const WAD_TO_RAW = 1_000_000_000_000n;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

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

interface MarketParamsStruct {
  openingFeeRaw: bigint;
  seedFloorRaw: bigint;
  seedCapRaw: bigint;
  fCapRaw: bigint;
  singleTopUpCapRaw: bigint;
  graduationMoneyInThresholdRaw: bigint;
  graduationTollRaw: bigint;
  inventoryTargetRaw: bigint;
  inventoryLowRaw: bigint;
  inventoryHighRaw: bigint;
  freeCollateralBufferRaw: bigint;
  tradingWindow: number;
  minTradingWindowSeconds: number;
  maxTradingWindowSeconds: number;
  minimumTimeOpen: number;
  protocolFeeBps: number;
  depthFeeBps: number;
}

interface OrderEventMeta {
  orderId: bigint;
  conditionId: Hex;
  tokenId: bigint;
  maker: Address;
  side: 0 | 1;
  priceRaw: bigint;
  sizeRaw: bigint;
  createdAt: number;
  updatedAt: number;
  isSeed: boolean;
}

interface ChainSnapshot {
  markets: Market[];
  trades: Trade[];
  activities: ActivityEvent[];
  resolutions: Map<string, Resolution>;
  priceHistory: Map<string, PricePoint[]>;
  orderEvents: Map<string, OrderEventMeta>;
}

interface TimedPromise<T> {
  createdAt: number;
  promise: Promise<T>;
}

interface MulticallRead {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

interface MulticallResult {
  status: 'success' | 'failure';
  result?: unknown;
  error?: Error;
}

const addressLogCache = new Map<string, TimedPromise<RawChainLog[]>>();
const blockTimestampCache = new Map<bigint, Promise<number>>();
const confirmedLogsByAddress = new Map<string, Map<string, RawChainLog>>();
let snapshotCache: TimedPromise<ChainSnapshot> | null = null;

function cacheIsFresh(entry: TimedPromise<unknown> | null | undefined) {
  return Boolean(entry && Date.now() - entry.createdAt < CACHE_MS);
}

export function clearChainReadCache() {
  addressLogCache.clear();
  snapshotCache = null;
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
 * catches up so the creator can open the market immediately.
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
    for (let fromBlock = firstBlock; fromBlock <= head; fromBlock += LOG_BLOCK_RANGE) {
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

async function multicallReads(reads: MulticallRead[]) {
  const output: MulticallResult[] = [];
  const chunkSize = 120;

  for (let index = 0; index < reads.length; index += chunkSize) {
    const contracts = reads.slice(index, index + chunkSize);
    const results = await arcPublicClient.multicall({
      allowFailure: true,
      contracts: contracts as never,
    });
    output.push(...(results as unknown as MulticallResult[]));
  }

  return output;
}

function requireResult<T>(result: MulticallResult | undefined, label: string): T {
  if (!result || result.status !== 'success') {
    throw new Error(
      result?.error?.message
        ? `${label}: ${result.error.message}`
        : `${label} could not be read from Arc.`,
    );
  }
  return result.result as T;
}

function optionalResult<T>(result: MulticallResult | undefined, fallbackValue: T): T {
  return result?.status === 'success' ? (result.result as T) : fallbackValue;
}

function bigintArg(args: Record<string, unknown>, name: string) {
  const value = args[name];
  return typeof value === 'bigint' ? value : 0n;
}

function numberArg(args: Record<string, unknown>, name: string) {
  const value = args[name];
  return typeof value === 'number'
    ? value
    : typeof value === 'bigint'
      ? Number(value)
      : 0;
}

function hexArg(args: Record<string, unknown>, name: string) {
  const value = args[name];
  return typeof value === 'string' && value.startsWith('0x')
    ? (value as Hex)
    : ('0x' as Hex);
}

function addressArg(args: Record<string, unknown>, name: string) {
  const value = args[name];
  return normalizeAddress(typeof value === 'string' ? value : ZERO_ADDRESS);
}

function normalizeAddress(value: string): Address {
  if (!isAddress(value)) return ZERO_ADDRESS;
  return getAddress(value).toLowerCase() as Address;
}

function eventId(event: ChainEvent) {
  return `${event.transactionHash}:${event.logIndex}`;
}

function decodeQuestion(ancillaryData: Hex) {
  try {
    const decoded = hexToString(ancillaryData).replace(/\0+$/u, '').trim();
    return decoded || ancillaryData;
  } catch {
    return ancillaryData;
  }
}

function phaseFromState(state: number): MarketPhase {
  if (state === 3) return 'Graduated';
  if (state === 4) return 'ResolvedObserved';
  if (state === 5) return 'ClosedOut';
  // Bootstrap (1) and PausedBootstrap (2) are both the incubating UI phase.
  return 'Opened';
}

function rawPricesFromWad(prices: readonly unknown[]) {
  const yesWad = typeof prices[0] === 'bigint' ? prices[0] : 0n;
  let yesRaw = (yesWad + WAD_TO_RAW / 2n) / WAD_TO_RAW;
  if (yesRaw < 0n) yesRaw = 0n;
  if (yesRaw > PRICE_SCALE) yesRaw = PRICE_SCALE;
  return {
    yesPriceRaw: yesRaw.toString(),
    noPriceRaw: (PRICE_SCALE - yesRaw).toString(),
  };
}

function resolutionPrices(
  denominator: bigint,
  yesNumerator: bigint,
  noNumerator: bigint,
) {
  if (denominator === 0n) return null;
  const yesRaw = (yesNumerator * PRICE_SCALE) / denominator;
  const noRaw = (noNumerator * PRICE_SCALE) / denominator;
  return {
    yesPriceRaw: yesRaw.toString(),
    noPriceRaw: noRaw.toString(),
  };
}

function pricePointFromTradeState(event: ChainEvent): PricePoint | null {
  const qYesRaw = bigintArg(event.args, 'qYesRawAfter');
  const qNoRaw = bigintArg(event.args, 'qNoRawAfter');
  const bCurrentWad = bigintArg(event.args, 'bCurrentWadAfter');
  if (bCurrentWad === 0n) return null;

  // q is six-decimal raw while b is WAD. The bounded Number conversion is only
  // applied after reducing to the dimensionless exponent.
  const deltaRaw = qNoRaw - qYesRaw;
  const exponent = Math.max(
    -60,
    Math.min(60, (Number(deltaRaw) * 1e12) / Number(bCurrentWad)),
  );
  const yesRaw = BigInt(Math.round((1 / (1 + Math.exp(exponent))) * 1_000_000));

  return {
    ts: 0,
    yesPriceRaw: yesRaw.toString(),
    noPriceRaw: (PRICE_SCALE - yesRaw).toString(),
  };
}

function getBlockTimestamp(blockNumber: bigint) {
  const cached = blockTimestampCache.get(blockNumber);
  if (cached) return cached;
  const promise = arcPublicClient
    .getBlock({ blockNumber })
    .then((block) => Number(block.timestamp));
  blockTimestampCache.set(blockNumber, promise);
  return promise;
}

async function timestampMap(events: ChainEvent[]) {
  const uniqueBlocks = [...new Set(events.map((event) => event.blockNumber))];
  const timestamps = await Promise.all(
    uniqueBlocks.map(async (blockNumber) => [
      blockNumber,
      await getBlockTimestamp(blockNumber),
    ] as const),
  );
  return new Map(timestamps);
}

function tradePriceRaw(costRaw: bigint, sizeRaw: bigint) {
  if (sizeRaw === 0n) return '0';
  return ((costRaw * PRICE_SCALE) / sizeRaw).toString();
}

function marketParamsFromStruct(params: MarketParamsStruct): MarketParams {
  return {
    seedFloorRaw: params.seedFloorRaw.toString(),
    seedCapRaw: params.seedCapRaw.toString(),
    fCapRaw: params.fCapRaw.toString(),
    graduationMoneyInThresholdRaw:
      params.graduationMoneyInThresholdRaw.toString(),
    graduationTollRaw: params.graduationTollRaw.toString(),
    inventoryTargetRaw: params.inventoryTargetRaw.toString(),
    protocolFeeBps: params.protocolFeeBps,
    depthFeeBps: params.depthFeeBps,
    tradingWindowSeconds: params.tradingWindow,
    minimumTimeOpenSeconds: params.minimumTimeOpen,
  };
}

function marketIdForCondition(
  conditionToMarket: Map<string, string>,
  conditionId: Hex,
) {
  return conditionToMarket.get(conditionId.toLowerCase()) ?? null;
}

async function buildSnapshot(): Promise<ChainSnapshot> {
  const [registryRaw, lmsrRaw, miniClobRaw] = await Promise.all([
    getAddressLogs(ADDRESSES.registry),
    getAddressLogs(ADDRESSES.lmsr),
    getAddressLogs(ADDRESSES.miniClob),
  ]);
  const registryEvents = decodeLogs(registryRaw, incubatorRegistryAbi);
  const lmsrEvents = decodeLogs(lmsrRaw, incubatorLmsrAbi);
  const miniClobEvents = decodeLogs(miniClobRaw, miniClobAbi);

  const createdEvents = registryEvents.filter(
    (event) => event.eventName === 'MarketCreated',
  );
  const conditionToMarket = new Map<string, string>();
  const tokenIdsByMarket = new Map<
    string,
    { yesTokenId: bigint; noTokenId: bigint }
  >();
  for (const event of createdEvents) {
    conditionToMarket.set(
      hexArg(event.args, 'conditionId').toLowerCase(),
      bigintArg(event.args, 'marketId').toString(),
    );
  }
  for (const event of registryEvents) {
    if (event.eventName !== 'MarketTokenBinding') continue;
    tokenIdsByMarket.set(bigintArg(event.args, 'marketId').toString(), {
      yesTokenId: bigintArg(event.args, 'yesTokenId'),
      noTokenId: bigintArg(event.args, 'noTokenId'),
    });
  }

  const allTimestampedEvents = [
    ...registryEvents,
    ...lmsrEvents,
    ...miniClobEvents,
  ];
  const timestamps = await timestampMap(allTimestampedEvents);

  const parameterSnapshots = new Map<string, ChainEvent>();
  const bookSnapshots = new Map<string, ChainEvent>();
  const seedOrderIds = new Set<string>();
  for (const event of registryEvents) {
    const marketId = bigintArg(event.args, 'marketId').toString();
    if (event.eventName === 'MarketParameterSnapshot') {
      parameterSnapshots.set(marketId, event);
    }
    if (event.eventName === 'MarketGraduationBookSeeded') {
      bookSnapshots.set(marketId, event);
      seedOrderIds.add(bigintArg(event.args, 'yesOrderId').toString());
      seedOrderIds.add(bigintArg(event.args, 'noOrderId').toString());
    }
  }

  const orderEvents = new Map<string, OrderEventMeta>();
  for (const event of miniClobEvents) {
    if (event.eventName !== 'OrderPlaced') continue;
    const orderId = bigintArg(event.args, 'orderId');
    const id = orderId.toString();
    const timestamp = timestamps.get(event.blockNumber) ?? 0;
    orderEvents.set(id, {
      orderId,
      conditionId: hexArg(event.args, 'conditionId'),
      tokenId: bigintArg(event.args, 'tokenId'),
      maker: addressArg(event.args, 'maker'),
      side: numberArg(event.args, 'side') === 1 ? 1 : 0,
      priceRaw: bigintArg(event.args, 'priceRawPerToken'),
      sizeRaw: bigintArg(event.args, 'sizeRaw'),
      createdAt: timestamp,
      updatedAt: timestamp,
      isSeed: seedOrderIds.has(id),
    });
  }
  for (const event of miniClobEvents) {
    if (event.eventName !== 'OrderFilled' && event.eventName !== 'OrderCancelled') {
      continue;
    }
    const meta = orderEvents.get(bigintArg(event.args, 'orderId').toString());
    if (meta) meta.updatedAt = timestamps.get(event.blockNumber) ?? meta.updatedAt;
  }

  const trades: Trade[] = [];
  for (const event of lmsrEvents) {
    if (event.eventName !== 'TradeExecuted') continue;
    const sizeRaw = bigintArg(event.args, 'amountRaw');
    const sideNumber = numberArg(event.args, 'side');
    const costRaw =
      sideNumber === 0
        ? bigintArg(event.args, 'totalCostRaw')
        : bigintArg(event.args, 'netProceedsRaw');
    trades.push({
      id: eventId(event),
      marketId: bigintArg(event.args, 'marketId').toString(),
      venue: 'LMSR',
      account: addressArg(event.args, 'trader'),
      outcome: numberArg(event.args, 'outcome') === 0 ? 'YES' : 'NO',
      side: sideNumber === 0 ? 'BID' : 'ASK',
      sizeRaw: sizeRaw.toString(),
      priceRaw: tradePriceRaw(costRaw, sizeRaw),
      costRaw: costRaw.toString(),
      feeRaw: (
        bigintArg(event.args, 'protocolFeeRaw') +
        bigintArg(event.args, 'depthContributionRaw')
      ).toString(),
      txHash: event.transactionHash,
      logIndex: event.logIndex,
      ts: timestamps.get(event.blockNumber) ?? 0,
    });
  }
  for (const event of miniClobEvents) {
    if (event.eventName !== 'OrderFilled') continue;
    const meta = orderEvents.get(bigintArg(event.args, 'orderId').toString());
    if (!meta) continue;
    const marketId = marketIdForCondition(conditionToMarket, meta.conditionId);
    if (!marketId) continue;
    const fillSizeRaw = bigintArg(event.args, 'fillSizeRaw');
    const paymentRaw = bigintArg(event.args, 'paymentRaw');
    const tokenIds = tokenIdsByMarket.get(marketId);
    trades.push({
      id: eventId(event),
      marketId,
      venue: 'BOOK',
      account: addressArg(event.args, 'taker'),
      outcome: tokenIds && meta.tokenId === tokenIds.yesTokenId ? 'YES' : 'NO',
      side: meta.side === 1 ? 'BID' : 'ASK',
      sizeRaw: fillSizeRaw.toString(),
      priceRaw: tradePriceRaw(paymentRaw, fillSizeRaw),
      costRaw: paymentRaw.toString(),
      feeRaw: '0',
      txHash: event.transactionHash,
      logIndex: event.logIndex,
      ts: timestamps.get(event.blockNumber) ?? 0,
    });
  }

  const marketReads: MulticallRead[] = [];
  for (const event of createdEvents) {
    const marketId = bigintArg(event.args, 'marketId');
    const conditionId = hexArg(event.args, 'conditionId');
    marketReads.push(
      {
        address: ADDRESSES.registry,
        abi: incubatorRegistryAbi,
        functionName: 'marketLifecycle',
        args: [marketId],
      },
      {
        address: ADDRESSES.registry,
        abi: incubatorRegistryAbi,
        functionName: 'tokenBinding',
        args: [marketId],
      },
      {
        address: ADDRESSES.registry,
        abi: incubatorRegistryAbi,
        functionName: 'marketParams',
        args: [marketId],
      },
      {
        address: ADDRESSES.registry,
        abi: incubatorRegistryAbi,
        functionName: 'marketTradingEndsAt',
        args: [marketId],
      },
      {
        address: ADDRESSES.registry,
        abi: incubatorRegistryAbi,
        functionName: 'graduationStatus',
        args: [marketId],
      },
      {
        address: ADDRESSES.lmsr,
        abi: incubatorLmsrAbi,
        functionName: 'currentPrices',
        args: [marketId],
      },
      {
        address: ADDRESSES.ctf,
        abi: conditionalTokensAbi,
        functionName: 'payoutDenominator',
        args: [conditionId],
      },
      {
        address: ADDRESSES.ctf,
        abi: conditionalTokensAbi,
        functionName: 'payoutNumerators',
        args: [conditionId, 0n],
      },
      {
        address: ADDRESSES.ctf,
        abi: conditionalTokensAbi,
        functionName: 'payoutNumerators',
        args: [conditionId, 1n],
      },
    );
  }
  const marketResults = await multicallReads(marketReads);

  const markets: Market[] = [];
  const resolutions = new Map<string, Resolution>();
  const bindingByMarket = new Map<string, readonly unknown[]>();
  const readsPerMarket = 9;
  for (const [marketIndex, event] of createdEvents.entries()) {
    const offset = marketIndex * readsPerMarket;
    const marketId = bigintArg(event.args, 'marketId').toString();
    const lifecycle = requireResult<readonly unknown[]>(
      marketResults[offset],
      `Market ${marketId} lifecycle`,
    );
    const binding = requireResult<readonly unknown[]>(
      marketResults[offset + 1],
      `Market ${marketId} token binding`,
    );
    bindingByMarket.set(marketId, binding);
    const params = requireResult<MarketParamsStruct>(
      marketResults[offset + 2],
      `Market ${marketId} parameters`,
    );
    const tradingEndsAt = requireResult<bigint>(
      marketResults[offset + 3],
      `Market ${marketId} trading window`,
    );
    const graduation = requireResult<readonly unknown[]>(
      marketResults[offset + 4],
      `Market ${marketId} graduation status`,
    );
    const currentPrices = requireResult<readonly unknown[]>(
      marketResults[offset + 5],
      `Market ${marketId} prices`,
    );
    const payoutDenominator = optionalResult<bigint>(
      marketResults[offset + 6],
      0n,
    );
    const payoutYes = optionalResult<bigint>(marketResults[offset + 7], 0n);
    const payoutNo = optionalResult<bigint>(marketResults[offset + 8], 0n);
    const phase = phaseFromState(Number(lifecycle[2] ?? 0));
    const livePrices = rawPricesFromWad(currentPrices);
    const settledPrices = resolutionPrices(
      payoutDenominator,
      payoutYes,
      payoutNo,
    );
    const prices = settledPrices ?? livePrices;
    const snapshot = parameterSnapshots.get(marketId);
    const book = bookSnapshots.get(marketId);
    const conditionId = String(binding[4]) as Hex;
    const createdAt = Number(lifecycle[4] ?? bigintArg(event.args, 'openedAt'));
    const graduatedAtRaw = Number(lifecycle[6] ?? 0);
    const resolvedAtRaw = Number(lifecycle[7] ?? 0);
    const closedOutAtRaw = Number(lifecycle[8] ?? 0);
    const marketTrades = trades.filter((trade) => trade.marketId === marketId);

    if (payoutDenominator > 0n) {
      const outcome =
        payoutYes === payoutNo
          ? 'INVALID'
          : payoutYes > payoutNo
            ? 'YES'
            : 'NO';
      resolutions.set(marketId, {
        marketId,
        conditionId,
        outcome,
        payoutYes: Number(payoutYes),
        payoutNo: Number(payoutNo),
        denominator: Number(payoutDenominator),
        resolvedAt: resolvedAtRaw,
        observedAt: resolvedAtRaw || null,
      });
    }

    markets.push({
      id: marketId,
      creator: normalizeAddress(String(lifecycle[0] ?? addressArg(event.args, 'creator'))),
      question: decodeQuestion(hexArg(event.args, 'ancillaryData')),
      phase,
      conditionId,
      questionId: String(binding[3]),
      yesTokenId: String(binding[5]),
      noTokenId: String(binding[6]),
      seedRaw: snapshot
        ? bigintArg(snapshot.args, 'seedRaw').toString()
        : '0',
      ...prices,
      graduationActivityRaw:
        typeof graduation[1] === 'bigint' ? graduation[1].toString() : '0',
      bookAddress: book
        ? addressArg(book.args, 'miniClob')
        : null,
      frozenYesPriceRaw: book
        ? bigintArg(book.args, 'frozenYesPriceRaw').toString()
        : null,
      handoffSizeRaw: book
        ? bigintArg(book.args, 'sizeRaw').toString()
        : null,
      tradeCount: marketTrades.length,
      volumeRaw: marketTrades
        .reduce((total, trade) => total + BigInt(trade.costRaw), 0n)
        .toString(),
      params: marketParamsFromStruct(params),
      createdAt,
      tradingEndsAt: Number(tradingEndsAt),
      graduatedAt: graduatedAtRaw || null,
      resolvedAt:
        phase === 'ClosedOut'
          ? closedOutAtRaw || resolvedAtRaw || null
          : resolvedAtRaw || null,
    });
  }

  const priceHistory = new Map<string, PricePoint[]>();
  for (const event of lmsrEvents) {
    if (event.eventName !== 'TradeState') continue;
    const point = pricePointFromTradeState(event);
    if (!point) continue;
    const marketId = bigintArg(event.args, 'marketId').toString();
    point.ts = timestamps.get(event.blockNumber) ?? 0;
    const points = priceHistory.get(marketId) ?? [];
    points.push(point);
    priceHistory.set(marketId, points);
  }

  const activities: ActivityEvent[] = [];
  for (const event of registryEvents) {
    const marketId = bigintArg(event.args, 'marketId').toString();
    if (event.eventName === 'MarketCreated') {
      activities.push({
        id: eventId(event),
        type: 'MarketCreated',
        marketId,
        account: addressArg(event.args, 'creator'),
        txHash: event.transactionHash,
        ts: numberArg(event.args, 'openedAt'),
      });
    } else if (event.eventName === 'MarketGraduated') {
      activities.push({
        id: eventId(event),
        type: 'MarketGraduated',
        marketId,
        account: addressArg(event.args, 'creator'),
        amountRaw: bigintArg(event.args, 'activityMoneyInRaw').toString(),
        txHash: event.transactionHash,
        ts: numberArg(event.args, 'graduatedAt'),
      });
    } else if (event.eventName === 'MarketGraduationBookSeeded') {
      activities.push({
        id: eventId(event),
        type: 'BookSeeded',
        marketId,
        account: null,
        amountRaw: bigintArg(event.args, 'sizeRaw').toString(),
        priceRaw: bigintArg(event.args, 'frozenYesPriceRaw').toString(),
        txHash: event.transactionHash,
        ts: timestamps.get(event.blockNumber) ?? 0,
      });
    } else if (event.eventName === 'MarketResolutionObserved') {
      activities.push({
        id: eventId(event),
        type: 'ResolutionObserved',
        marketId,
        account: null,
        txHash: event.transactionHash,
        ts: numberArg(event.args, 'observedAt'),
      });
    } else if (event.eventName === 'MarketClosedOut') {
      activities.push({
        id: eventId(event),
        type: 'Closeout',
        marketId,
        account: null,
        txHash: event.transactionHash,
        ts: numberArg(event.args, 'closedOutAt'),
      });
    }
  }
  for (const trade of trades.filter((candidate) => candidate.venue === 'LMSR')) {
    activities.push({
      id: trade.id,
      type: 'Trade',
      marketId: trade.marketId,
      account: trade.account,
      outcome: trade.outcome,
      side: trade.side,
      amountRaw: trade.sizeRaw,
      priceRaw: trade.priceRaw,
      txHash: trade.txHash,
      ts: trade.ts,
    });
  }
  for (const event of miniClobEvents) {
    const meta = orderEvents.get(bigintArg(event.args, 'orderId').toString());
    if (!meta) continue;
    const marketId = marketIdForCondition(conditionToMarket, meta.conditionId);
    if (!marketId) continue;
    const binding = bindingByMarket.get(marketId);
    const outcome =
      binding && meta.tokenId === BigInt(String(binding[5])) ? 'YES' : 'NO';
    if (event.eventName === 'OrderPlaced') {
      activities.push({
        id: eventId(event),
        type: 'OrderPlaced',
        marketId,
        account: meta.maker,
        outcome,
        side: meta.side === 0 ? 'BID' : 'ASK',
        amountRaw: meta.sizeRaw.toString(),
        priceRaw: meta.priceRaw.toString(),
        txHash: event.transactionHash,
        ts: timestamps.get(event.blockNumber) ?? 0,
      });
    } else if (event.eventName === 'OrderFilled') {
      activities.push({
        id: eventId(event),
        type: 'OrderFilled',
        marketId,
        account: addressArg(event.args, 'taker'),
        outcome,
        side: meta.side === 1 ? 'BID' : 'ASK',
        amountRaw: bigintArg(event.args, 'fillSizeRaw').toString(),
        priceRaw: meta.priceRaw.toString(),
        txHash: event.transactionHash,
        ts: timestamps.get(event.blockNumber) ?? 0,
      });
    } else if (event.eventName === 'OrderCancelled') {
      activities.push({
        id: eventId(event),
        type: 'OrderCancelled',
        marketId,
        account: addressArg(event.args, 'maker'),
        outcome,
        side: meta.side === 0 ? 'BID' : 'ASK',
        amountRaw: bigintArg(event.args, 'remainingSizeRaw').toString(),
        priceRaw: meta.priceRaw.toString(),
        txHash: event.transactionHash,
        ts: timestamps.get(event.blockNumber) ?? 0,
      });
    }
  }

  markets.sort((left, right) => right.createdAt - left.createdAt);
  trades.sort((left, right) => right.ts - left.ts || right.logIndex - left.logIndex);
  activities.sort((left, right) => right.ts - left.ts);

  return {
    markets,
    trades,
    activities,
    resolutions,
    priceHistory,
    orderEvents,
  };
}

async function getSnapshot() {
  if (cacheIsFresh(snapshotCache)) return snapshotCache!.promise;
  const promise = buildSnapshot();
  snapshotCache = { createdAt: Date.now(), promise };
  return promise;
}

function cursorOffset(cursor?: string) {
  if (!cursor?.startsWith('chain:')) return 0;
  const parsed = Number(cursor.slice('chain:'.length));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function page<T>(items: T[], limitInput: number | undefined, cursor?: string) {
  const limit = Math.max(1, Math.min(limitInput ?? 50, 200));
  const offset = cursorOffset(cursor);
  const selected = items.slice(offset, offset + limit);
  return {
    items: selected,
    nextCursor:
      offset + selected.length < items.length
        ? `chain:${offset + selected.length}`
        : null,
  };
}

function emptyBook(market: Market, outcome: 'YES' | 'NO'): OrderBook {
  return {
    marketId: market.id,
    outcome,
    tokenId: outcome === 'YES' ? market.yesTokenId : market.noTokenId,
    bids: [],
    asks: [],
    orders: [],
  };
}

function aggregateBook(book: OrderBook) {
  const aggregate = (side: 'BID' | 'ASK') => {
    const levels = new Map<string, { size: bigint; orderCount: number }>();
    for (const order of book.orders) {
      if (order.side !== side || !order.open || BigInt(order.remainingRaw) === 0n) {
        continue;
      }
      const existing = levels.get(order.priceRaw) ?? { size: 0n, orderCount: 0 };
      existing.size += BigInt(order.remainingRaw);
      existing.orderCount += 1;
      levels.set(order.priceRaw, existing);
    }
    return [...levels.entries()]
      .map(([priceRaw, value]) => ({
        priceRaw,
        sizeRaw: value.size.toString(),
        orderCount: value.orderCount,
      }))
      .sort((left, right) => {
        const leftPrice = BigInt(left.priceRaw);
        const rightPrice = BigInt(right.priceRaw);
        if (leftPrice === rightPrice) return 0;
        if (side === 'BID') return leftPrice > rightPrice ? -1 : 1;
        return leftPrice < rightPrice ? -1 : 1;
      });
  };
  book.bids = aggregate('BID');
  book.asks = aggregate('ASK');
}

async function readOrderBook(
  market: Market,
  snapshot: ChainSnapshot,
): Promise<MarketBookResponse> {
  const response = {
    marketId: market.id,
    yes: emptyBook(market, 'YES'),
    no: emptyBook(market, 'NO'),
  };
  if (market.phase !== 'Graduated') return response;

  const metas = [...snapshot.orderEvents.values()].filter(
    (meta) => meta.conditionId.toLowerCase() === market.conditionId.toLowerCase(),
  );
  if (metas.length === 0) return response;

  const results = await multicallReads(
    metas.map((meta) => ({
      address: ADDRESSES.miniClob,
      abi: miniClobAbi,
      functionName: 'getOrder',
      args: [meta.orderId],
    })),
  );

  for (const [index, meta] of metas.entries()) {
    const value = optionalResult<Record<string, unknown> | null>(
      results[index],
      null,
    );
    if (!value) continue;
    const sizeRaw = typeof value.sizeRaw === 'bigint' ? value.sizeRaw : meta.sizeRaw;
    const filledRaw = typeof value.filledRaw === 'bigint' ? value.filledRaw : 0n;
    const tokenId = typeof value.tokenId === 'bigint' ? value.tokenId : meta.tokenId;
    const side = Number(value.side ?? meta.side) === 1 ? 'ASK' : 'BID';
    const order: Order = {
      orderId: meta.orderId.toString(),
      marketId: market.id,
      conditionId: String(value.conditionId ?? meta.conditionId),
      tokenId: tokenId.toString(),
      outcome: tokenId.toString() === market.yesTokenId ? 'YES' : 'NO',
      maker: normalizeAddress(String(value.maker ?? meta.maker)),
      side,
      priceRaw: String(value.priceRawPerToken ?? meta.priceRaw),
      sizeRaw: sizeRaw.toString(),
      filledRaw: filledRaw.toString(),
      remainingRaw: (sizeRaw > filledRaw ? sizeRaw - filledRaw : 0n).toString(),
      open: Boolean(value.open),
      isSeed: meta.isSeed,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
    };
    (order.outcome === 'YES' ? response.yes : response.no).orders.push(order);
  }

  response.yes.orders = response.yes.orders.filter((order) => order.open);
  response.no.orders = response.no.orders.filter((order) => order.open);
  aggregateBook(response.yes);
  aggregateBook(response.no);
  return response;
}

async function readConfig(): Promise<RegistryConfig> {
  const results = await multicallReads([
    {
      address: ADDRESSES.registry,
      abi: incubatorRegistryAbi,
      functionName: 'defaultParams',
    },
    {
      address: ADDRESSES.registry,
      abi: incubatorRegistryAbi,
      functionName: 'defaultMarketTypeVersion',
    },
    {
      address: ADDRESSES.registry,
      abi: incubatorRegistryAbi,
      functionName: 'collateral',
    },
    {
      address: ADDRESSES.registry,
      abi: incubatorRegistryAbi,
      functionName: 'ctf',
    },
    {
      address: ADDRESSES.registry,
      abi: incubatorRegistryAbi,
      functionName: 'committeeOracleV2',
    },
    {
      address: ADDRESSES.registry,
      abi: incubatorRegistryAbi,
      functionName: 'lmsr',
    },
    {
      address: ADDRESSES.registry,
      abi: incubatorRegistryAbi,
      functionName: 'miniClob',
    },
    {
      address: ADDRESSES.oracle,
      abi: committeeOracleAbi,
      functionName: 'currentThreshold',
    },
    {
      address: ADDRESSES.oracle,
      abi: committeeOracleAbi,
      functionName: 'currentSignerCount',
    },
    {
      address: ADDRESSES.registry,
      abi: incubatorRegistryAbi,
      functionName: 'collateralDecimals',
    },
    {
      address: ADDRESSES.usdc,
      abi: collateralErc20Abi,
      functionName: 'decimals',
    },
  ]);

  const params = requireResult<MarketParamsStruct>(
    results[0],
    'Registry default parameters',
  );
  const marketTypeVersion = requireResult<number>(
    results[1],
    'Registry default market type',
  );
  const linkedAddresses = [
    ADDRESSES.usdc,
    ADDRESSES.ctf,
    ADDRESSES.oracle,
    ADDRESSES.lmsr,
    ADDRESSES.miniClob,
  ];
  for (const [index, expected] of linkedAddresses.entries()) {
    const actual = requireResult<string>(
      results[index + 2],
      `Registry linked address ${index + 1}`,
    );
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(
        `Arc deployment mismatch: registry returned ${actual}, expected ${expected}.`,
      );
    }
  }

  const threshold = Number(
    requireResult<bigint>(results[7], 'Committee threshold'),
  );
  const signerCount = Number(
    requireResult<bigint>(results[8], 'Committee signer count'),
  );
  const registryDecimals = requireResult<number>(
    results[9],
    'Registry collateral decimals',
  );
  const tokenDecimals = requireResult<number>(
    results[10],
    'Arc USDC ERC-20 decimals',
  );
  if (
    registryDecimals !== ARC.usdcErc20Decimals ||
    tokenDecimals !== ARC.usdcErc20Decimals
  ) {
    throw new Error(
      `Arc collateral decimal mismatch: registry=${registryDecimals}, token=${tokenDecimals}, expected=${ARC.usdcErc20Decimals}.`,
    );
  }
  const signerResults = await multicallReads(
    Array.from({ length: signerCount }, (_, index) => ({
      address: ADDRESSES.oracle,
      abi: committeeOracleAbi,
      functionName: 'currentSigners',
      args: [BigInt(index)],
    })),
  );
  const signers = signerResults.map((result, index) =>
    normalizeAddress(
      requireResult<string>(result, `Committee signer ${index + 1}`),
    ),
  );

  return {
    chainId: ARC.chainId,
    addresses: {
      usdc: normalizeAddress(ADDRESSES.usdc),
      ctf: normalizeAddress(ADDRESSES.ctf),
      oracle: normalizeAddress(ADDRESSES.oracle),
      lmsr: normalizeAddress(ADDRESSES.lmsr),
      registry: normalizeAddress(ADDRESSES.registry),
      miniClob: normalizeAddress(ADDRESSES.miniClob),
    },
    marketTypeVersion,
    seedFloorRaw: params.seedFloorRaw.toString(),
    seedCapRaw: params.seedCapRaw.toString(),
    graduationTollRaw: params.graduationTollRaw.toString(),
    protocolFeeBps: params.protocolFeeBps,
    minTradingWindowSeconds: params.minTradingWindowSeconds,
    maxTradingWindowSeconds: params.maxTradingWindowSeconds,
    committee: {
      oracle: normalizeAddress(ADDRESSES.oracle),
      signers,
      threshold,
    },
  };
}

export const chainApiClient: ApiClient = {
  async listMarkets(query = {}): Promise<ListMarketsResponse> {
    const snapshot = await getSnapshot();
    let markets = snapshot.markets;
    if (query.phase) {
      markets = markets.filter((market) => market.phase === query.phase);
    }
    if (query.creator) {
      const creator = query.creator.toLowerCase();
      markets = markets.filter(
        (market) => market.creator.toLowerCase() === creator,
      );
    }
    return page(markets, query.limit, query.cursor);
  },

  async getMarket(id: string): Promise<MarketDetailResponse | null> {
    const snapshot = await getSnapshot();
    const market = snapshot.markets.find((candidate) => candidate.id === id);
    if (!market) return null;
    return {
      market,
      recentTrades: snapshot.trades
        .filter((trade) => trade.marketId === id)
        .slice(0, 20),
      resolution: snapshot.resolutions.get(id) ?? null,
    };
  },

  async getAccount(address: string): Promise<AccountResponse> {
    if (!isAddress(address)) throw new Error('Enter a valid Arc account address.');
    const normalized = normalizeAddress(address);
    const snapshot = await getSnapshot();
    const reads = snapshot.markets.flatMap((market) => [
      {
        address: ADDRESSES.ctf,
        abi: conditionalTokensAbi,
        functionName: 'balanceOf',
        args: [normalized, BigInt(market.yesTokenId)],
      },
      {
        address: ADDRESSES.ctf,
        abi: conditionalTokensAbi,
        functionName: 'balanceOf',
        args: [normalized, BigInt(market.noTokenId)],
      },
    ]);
    const balances = await multicallReads(reads);
    const latestBlock = await arcPublicClient.getBlock();
    const updatedAt = Number(latestBlock.timestamp);
    const positions: Position[] = [];
    for (const [marketIndex, market] of snapshot.markets.entries()) {
      for (const outcomeIndex of [0, 1] as const) {
        const balance = optionalResult<bigint>(
          balances[marketIndex * 2 + outcomeIndex],
          0n,
        );
        if (balance === 0n) continue;
        positions.push({
          account: normalized,
          marketId: market.id,
          outcome: outcomeIndex === 0 ? 'YES' : 'NO',
          qtyRaw: balance.toString(),
          // Holdings are authoritative ERC-1155 reads. Basis/PnL do not exist in
          // contract storage; zero is a DTO sentinel and the UI labels them unknown.
          costBasisRaw: '0',
          costBasisEstimated: true,
          realizedPnlRaw: '0',
          unrealizedPnlRaw: '0',
          updatedAt,
        });
      }
    }

    const accountTrades = snapshot.trades.filter(
      (trade) => trade.account.toLowerCase() === normalized,
    );
    const recentTrades = accountTrades.slice(0, 50);
    const firstSeenCandidates = [
      ...accountTrades.map((trade) => trade.ts),
      ...snapshot.markets
        .filter((market) => market.creator.toLowerCase() === normalized)
        .map((market) => market.createdAt),
    ].filter((timestamp) => timestamp > 0);
    const account: Account = {
      address: normalized,
      firstSeenAt:
        firstSeenCandidates.length > 0 ? Math.min(...firstSeenCandidates) : 0,
      marketsCreated: snapshot.markets.filter(
        (market) => market.creator.toLowerCase() === normalized,
      ).length,
      tradeCount: accountTrades.length,
    };

    return {
      account,
      positions,
      recentTrades,
      pnl: {
        realizedRaw: '0',
        unrealizedRaw: '0',
      },
    };
  },

  async getOrderBook(marketId: string): Promise<MarketBookResponse> {
    const snapshot = await getSnapshot();
    const market = snapshot.markets.find((candidate) => candidate.id === marketId);
    if (!market) throw new Error(`Market ${marketId} was not found on Arc.`);
    return readOrderBook(market, snapshot);
  },

  async getActivity(query = {}): Promise<ActivityResponse> {
    const snapshot = await getSnapshot();
    let events = snapshot.activities;
    if (query.marketId) {
      events = events.filter((event) => event.marketId === query.marketId);
    }
    if (query.account) {
      const account = query.account.toLowerCase();
      events = events.filter(
        (event) => event.account?.toLowerCase() === account,
      );
    }
    return page(events, query.limit, query.cursor);
  },

  async getConfig(): Promise<RegistryConfig> {
    return readConfig();
  },

  async getPriceHistory(
    marketId,
    query = {},
  ): Promise<PriceHistoryResponse> {
    const snapshot = await getSnapshot();
    let points = snapshot.priceHistory.get(marketId) ?? [];
    if (query.fromTs !== undefined) {
      points = points.filter((point) => point.ts >= query.fromTs!);
    }
    const limit = Math.max(1, Math.min(query.limit ?? 500, 2_000));
    return {
      marketId,
      points: points.slice(-limit),
    };
  },
};
