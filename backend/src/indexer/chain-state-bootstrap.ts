import { ADDRESSES, ARC, type ChainStateIssue } from '@predex-pump/shared';
import oracleAbiJson from '@predex-pump/shared/abis/CommitteeOracleAdapterV2.json' with {
  type: 'json',
};
import registryAbiJson from '@predex-pump/shared/abis/IncubatorRegistry.json' with {
  type: 'json',
};
import type {
  CommitteeMember,
  Prisma,
  PrismaClient,
  RegisteredMarketType,
  RegistryConfig,
} from '@prisma/client';
import {
  isAddress,
  type Abi,
  type Address,
  type ContractFunctionParameters,
  type PublicClient,
} from 'viem';

import { lockIndexerCursor } from './cursor-lock.js';

const registryAbi = registryAbiJson as Abi;
const oracleAbi = oracleAbiJson as Abi;
const MAX_DB_INT = 2_147_483_647n;
const MAX_EVENT_LOG_INDEX = 2_147_483_647;
const MAX_ENUMERATED_MARKET_TYPE_VERSION = 4_096;
const MULTICALL_BATCH_SIZE = 240;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_HASH = `0x${'0'.repeat(64)}`;

const PARAMETER_NAMES = [
  'openingFeeRaw',
  'seedFloorRaw',
  'seedCapRaw',
  'fCapRaw',
  'singleTopUpCapRaw',
  'graduationMoneyInThresholdRaw',
  'graduationTollRaw',
  'inventoryTargetRaw',
  'inventoryLowRaw',
  'inventoryHighRaw',
  'freeCollateralBufferRaw',
  'tradingWindow',
  'minTradingWindowSeconds',
  'maxTradingWindowSeconds',
  'minimumTimeOpen',
  'protocolFeeBps',
  'depthFeeBps',
] as const;

const RAW_PARAMETER_NAMES = PARAMETER_NAMES.slice(0, 11);

export interface RegistryParameterSnapshot {
  openingFeeRaw: string;
  seedFloorRaw: string;
  seedCapRaw: string;
  fCapRaw: string;
  singleTopUpCapRaw: string;
  graduationMoneyInThresholdRaw: string;
  graduationTollRaw: string;
  inventoryTargetRaw: string;
  inventoryLowRaw: string;
  inventoryHighRaw: string;
  freeCollateralBufferRaw: string;
  defaultTradingWindowSeconds: number;
  minTradingWindowSeconds: number;
  maxTradingWindowSeconds: number;
  minimumTimeOpenSeconds: number;
  protocolFeeBps: number;
  depthFeeBps: number;
}

export interface MarketTypeSnapshot {
  version: number;
  lmsrAddress: string;
  configHash: string;
}

export interface ChainStateSnapshot {
  blockNumber: number;
  registry: {
    collateralAddress: string;
    collateralDecimals: number;
    ctfAddress: string;
    oracleAddress: string;
    lmsrAddress: string;
    miniClobAddress: string;
    defaultMarketTypeVersion: number;
    params: RegistryParameterSnapshot;
  };
  committee: {
    ctfAddress: string;
    threshold: number;
    signers: string[];
  };
  marketTypes: MarketTypeSnapshot[];
  rpcRequestCount: number;
}

export interface ChainStateReader {
  readChainState(blockNumber: number): Promise<ChainStateSnapshot>;
}

export interface ChainStateBootstrapResult {
  status: 'complete' | 'failed';
  snapshotBlock: number;
  rpcRequestCount: number;
  changedRows: number;
  protectedNewerRows: number;
  error: string | null;
}

export interface PersistedChainStateInspection {
  ready: boolean;
  issues: ChainStateIssue[];
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_000);
}

function integerValue(value: unknown, label: string): bigint {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw new Error(`${label} was malformed: expected a non-negative integer`);
}

function dbInteger(value: unknown, label: string): number {
  const integer = integerValue(value, label);
  if (integer > MAX_DB_INT) {
    throw new Error(`${label} exceeds the supported Postgres Int range`);
  }
  return Number(integer);
}

function addressValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isAddress(value) || value.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(`${label} was malformed: expected a non-zero EVM address`);
  }
  return value.toLowerCase();
}

function hashValue(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/u.test(value) ||
    value.toLowerCase() === ZERO_HASH
  ) {
    throw new Error(`${label} was malformed: expected a non-zero bytes32 value`);
  }
  return value.toLowerCase();
}

function tupleRecord(
  value: unknown,
  names: readonly string[],
  label: string,
): Record<string, unknown> {
  if (Array.isArray(value)) {
    if (value.length < names.length) {
      throw new Error(`${label} was malformed: tuple was truncated`);
    }
    return Object.fromEntries(names.map((name, index) => [name, value[index]]));
  }
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, unknown>;
  }
  throw new Error(`${label} was malformed: expected a tuple`);
}

function parseRegistryParameters(value: unknown): RegistryParameterSnapshot {
  const tuple = tupleRecord(value, PARAMETER_NAMES, 'registry defaultParams');
  const raw = Object.fromEntries(
    RAW_PARAMETER_NAMES.map((name) => [
      name,
      integerValue(tuple[name], `defaultParams.${name}`).toString(),
    ]),
  ) as Record<(typeof RAW_PARAMETER_NAMES)[number], string>;
  return {
    openingFeeRaw: raw.openingFeeRaw,
    seedFloorRaw: raw.seedFloorRaw,
    seedCapRaw: raw.seedCapRaw,
    fCapRaw: raw.fCapRaw,
    singleTopUpCapRaw: raw.singleTopUpCapRaw,
    graduationMoneyInThresholdRaw: raw.graduationMoneyInThresholdRaw,
    graduationTollRaw: raw.graduationTollRaw,
    inventoryTargetRaw: raw.inventoryTargetRaw,
    inventoryLowRaw: raw.inventoryLowRaw,
    inventoryHighRaw: raw.inventoryHighRaw,
    freeCollateralBufferRaw: raw.freeCollateralBufferRaw,
    defaultTradingWindowSeconds: dbInteger(
      tuple.tradingWindow,
      'defaultParams.tradingWindow',
    ),
    minTradingWindowSeconds: dbInteger(
      tuple.minTradingWindowSeconds,
      'defaultParams.minTradingWindowSeconds',
    ),
    maxTradingWindowSeconds: dbInteger(
      tuple.maxTradingWindowSeconds,
      'defaultParams.maxTradingWindowSeconds',
    ),
    minimumTimeOpenSeconds: dbInteger(
      tuple.minimumTimeOpen,
      'defaultParams.minimumTimeOpen',
    ),
    protocolFeeBps: dbInteger(
      tuple.protocolFeeBps,
      'defaultParams.protocolFeeBps',
    ),
    depthFeeBps: dbInteger(tuple.depthFeeBps, 'defaultParams.depthFeeBps'),
  };
}

function unwrapResult(
  results: readonly unknown[],
  index: number,
  label: string,
): unknown {
  const entry = results[index];
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`${label} was missing from the Multicall3 response`);
  }
  const result = entry as { status?: unknown; result?: unknown; error?: unknown };
  if (result.status !== 'success') {
    const reason = result.error === undefined ? 'unknown call failure' : errorMessage(result.error);
    throw new Error(`${label} failed in Multicall3: ${reason}`);
  }
  if (!Object.hasOwn(result, 'result')) {
    throw new Error(`${label} returned no result from Multicall3`);
  }
  return result.result;
}

function contractCall(
  address: Address,
  abi: Abi,
  functionName: string,
  args?: readonly unknown[],
): ContractFunctionParameters {
  return {
    address,
    abi,
    functionName,
    ...(args === undefined ? {} : { args }),
  } as ContractFunctionParameters;
}

function parseMarketType(value: unknown, version: number): MarketTypeSnapshot | null {
  const tuple = tupleRecord(
    value,
    ['registered', 'lmsr', 'configHash'],
    `registry marketTypes(${version})`,
  );
  if (typeof tuple.registered !== 'boolean') {
    throw new Error(`registry marketTypes(${version}) returned a malformed registration flag`);
  }
  if (!tuple.registered) return null;
  return {
    version,
    lmsrAddress: addressValue(tuple.lmsr, `marketTypes(${version}).lmsr`),
    configHash: hashValue(tuple.configHash, `marketTypes(${version}).configHash`),
  };
}

function assertEqualAddress(actual: string, expected: string, label: string): void {
  if (actual !== expected.toLowerCase()) {
    throw new Error(`${label}=${actual} does not match configured ${expected.toLowerCase()}`);
  }
}

export function validateChainStateSnapshot(snapshot: ChainStateSnapshot): void {
  if (!Number.isSafeInteger(snapshot.blockNumber) || snapshot.blockNumber <= 0) {
    throw new Error('Chain-state snapshot block must be a positive safe integer');
  }
  const { params } = snapshot.registry;
  for (const [name, value] of Object.entries(params)) {
    if (name.endsWith('Raw') && !/^\d+$/u.test(String(value))) {
      throw new Error(`Registry parameter ${name} is not a non-negative decimal string`);
    }
  }
  const integerParameters = [
    params.defaultTradingWindowSeconds,
    params.minTradingWindowSeconds,
    params.maxTradingWindowSeconds,
    params.minimumTimeOpenSeconds,
    params.protocolFeeBps,
    params.depthFeeBps,
  ];
  if (integerParameters.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('Registry defaultParams contains a malformed integer parameter');
  }
  const requiredPositiveRaw = [
    params.seedFloorRaw,
    params.seedCapRaw,
    params.fCapRaw,
    params.singleTopUpCapRaw,
    params.graduationMoneyInThresholdRaw,
    params.graduationTollRaw,
    params.inventoryTargetRaw,
  ];
  if (requiredPositiveRaw.some((value) => BigInt(value) <= 0n)) {
    throw new Error('Registry defaultParams contains a zero required economic parameter');
  }
  if (BigInt(params.seedCapRaw) < BigInt(params.seedFloorRaw)) {
    throw new Error('Registry seedCapRaw is below seedFloorRaw');
  }
  if (
    params.minTradingWindowSeconds <= 0 ||
    params.maxTradingWindowSeconds < params.minTradingWindowSeconds ||
    params.defaultTradingWindowSeconds < params.minTradingWindowSeconds ||
    params.defaultTradingWindowSeconds > params.maxTradingWindowSeconds
  ) {
    throw new Error('Registry trading-window bounds are invalid');
  }
  if (
    params.protocolFeeBps <= 0 ||
    params.protocolFeeBps > 10_000 ||
    params.depthFeeBps < 0 ||
    params.depthFeeBps > 10_000 ||
    params.protocolFeeBps + params.depthFeeBps > 10_000
  ) {
    throw new Error('Registry fee basis points are invalid');
  }
  if (
    !Number.isSafeInteger(snapshot.registry.defaultMarketTypeVersion) ||
    snapshot.registry.defaultMarketTypeVersion <= 0
  ) {
    throw new Error('Registry default market-type version must be positive');
  }
  if (!Number.isSafeInteger(snapshot.rpcRequestCount) || snapshot.rpcRequestCount < 0) {
    throw new Error('Chain-state RPC request count is malformed');
  }
  for (const marketType of snapshot.marketTypes) {
    if (!Number.isSafeInteger(marketType.version) || marketType.version < 0) {
      throw new Error('Registered market-type snapshot contains an invalid version');
    }
    const lmsrAddress = addressValue(
      marketType.lmsrAddress,
      `marketTypes(${marketType.version}).lmsr`,
    );
    const configHash = hashValue(
      marketType.configHash,
      `marketTypes(${marketType.version}).configHash`,
    );
    if (
      lmsrAddress !== marketType.lmsrAddress ||
      configHash !== marketType.configHash
    ) {
      throw new Error('Registered market-type snapshot was not normalized');
    }
  }
  const currentType = snapshot.marketTypes.find(
    (marketType) => marketType.version === snapshot.registry.defaultMarketTypeVersion,
  );
  if (currentType === undefined) {
    throw new Error('Registry default market type is not registered');
  }
  if (snapshot.committee.signers.length === 0) {
    throw new Error('Committee signer snapshot is empty');
  }
  if (
    !Number.isSafeInteger(snapshot.committee.threshold) ||
    snapshot.committee.threshold <= 0 ||
    snapshot.committee.threshold > snapshot.committee.signers.length
  ) {
    throw new Error('Committee threshold is not satisfiable by the current signer set');
  }
  if (new Set(snapshot.committee.signers).size !== snapshot.committee.signers.length) {
    throw new Error('Committee signer snapshot contains duplicates');
  }
  for (const signer of snapshot.committee.signers) {
    if (addressValue(signer, 'committee signer') !== signer) {
      throw new Error('Committee signer snapshot was not normalized');
    }
  }
  if (new Set(snapshot.marketTypes.map(({ version }) => version)).size !== snapshot.marketTypes.length) {
    throw new Error('Registered market-type snapshot contains duplicate versions');
  }

  assertEqualAddress(snapshot.registry.collateralAddress, ADDRESSES.usdc, 'registry collateral');
  assertEqualAddress(snapshot.registry.ctfAddress, ADDRESSES.ctf, 'registry CTF');
  assertEqualAddress(snapshot.registry.oracleAddress, ADDRESSES.oracle, 'registry oracle');
  assertEqualAddress(snapshot.registry.lmsrAddress, ADDRESSES.lmsr, 'registry LMSR');
  assertEqualAddress(snapshot.registry.miniClobAddress, ADDRESSES.miniClob, 'registry MiniCLOB');
  assertEqualAddress(snapshot.committee.ctfAddress, ADDRESSES.ctf, 'oracle CTF');
  if (snapshot.registry.collateralDecimals !== ARC.usdcErc20Decimals) {
    throw new Error(
      `registry collateralDecimals=${snapshot.registry.collateralDecimals} does not match configured ${ARC.usdcErc20Decimals}`,
    );
  }
}

export class ViemChainStateReader implements ChainStateReader {
  constructor(private readonly client: PublicClient) {}

  async readChainState(blockNumber: number): Promise<ChainStateSnapshot> {
    if (!Number.isSafeInteger(blockNumber) || blockNumber <= 0) {
      throw new Error('Chain-state read block must be a positive safe integer');
    }
    let rpcRequestCount = 0;
    const firstCalls: ContractFunctionParameters[] = [
      contractCall(ADDRESSES.registry, registryAbi, 'defaultParams'),
      contractCall(ADDRESSES.registry, registryAbi, 'defaultMarketTypeVersion'),
      contractCall(ADDRESSES.oracle, oracleAbi, 'currentSignerCount'),
      contractCall(ADDRESSES.oracle, oracleAbi, 'currentThreshold'),
      contractCall(ADDRESSES.oracle, oracleAbi, 'MAX_SIGNATURES'),
      contractCall(ADDRESSES.registry, registryAbi, 'collateral'),
      contractCall(ADDRESSES.registry, registryAbi, 'collateralDecimals'),
      contractCall(ADDRESSES.registry, registryAbi, 'ctf'),
      contractCall(ADDRESSES.registry, registryAbi, 'committeeOracleV2'),
      contractCall(ADDRESSES.registry, registryAbi, 'lmsr'),
      contractCall(ADDRESSES.registry, registryAbi, 'miniClob'),
      contractCall(ADDRESSES.oracle, oracleAbi, 'ctf'),
    ];
    const firstResults = (await this.client.multicall({
      allowFailure: true,
      blockNumber: BigInt(blockNumber),
      contracts: firstCalls,
    })) as readonly unknown[];
    rpcRequestCount += 1;

    const params = parseRegistryParameters(
      unwrapResult(firstResults, 0, 'registry defaultParams'),
    );
    const defaultMarketTypeVersion = dbInteger(
      unwrapResult(firstResults, 1, 'registry defaultMarketTypeVersion'),
      'registry defaultMarketTypeVersion',
    );
    const signerCount = dbInteger(
      unwrapResult(firstResults, 2, 'oracle currentSignerCount'),
      'oracle currentSignerCount',
    );
    const threshold = dbInteger(
      unwrapResult(firstResults, 3, 'oracle currentThreshold'),
      'oracle currentThreshold',
    );
    const maxSignatures = dbInteger(
      unwrapResult(firstResults, 4, 'oracle MAX_SIGNATURES'),
      'oracle MAX_SIGNATURES',
    );
    if (defaultMarketTypeVersion <= 0) {
      throw new Error('Registry default market-type version must be positive');
    }
    if (defaultMarketTypeVersion > MAX_ENUMERATED_MARKET_TYPE_VERSION) {
      throw new Error(
        `Registry default market-type version ${defaultMarketTypeVersion} exceeds the bounded bootstrap range`,
      );
    }
    if (signerCount <= 0 || signerCount > maxSignatures || maxSignatures <= 0) {
      throw new Error('Oracle signer count is outside the contract MAX_SIGNATURES bound');
    }

    const dynamicCalls: ContractFunctionParameters[] = [];
    // marketTypes is a mapping without a separate count getter. Versions in
    // this deployment are monotonic, and the default version is the current
    // upper bound, so scan the bounded inclusive range and retain registered
    // entries rather than depending on MarketTypeVersionRegistered history.
    for (let version = 0; version <= defaultMarketTypeVersion; version += 1) {
      dynamicCalls.push(
        contractCall(ADDRESSES.registry, registryAbi, 'marketTypes', [version]),
      );
    }
    for (let index = 0; index < signerCount; index += 1) {
      dynamicCalls.push(
        contractCall(ADDRESSES.oracle, oracleAbi, 'currentSigners', [BigInt(index)]),
      );
    }

    const dynamicResults: unknown[] = [];
    for (let offset = 0; offset < dynamicCalls.length; offset += MULTICALL_BATCH_SIZE) {
      const results = (await this.client.multicall({
        allowFailure: true,
        blockNumber: BigInt(blockNumber),
        contracts: dynamicCalls.slice(offset, offset + MULTICALL_BATCH_SIZE),
      })) as readonly unknown[];
      rpcRequestCount += 1;
      dynamicResults.push(...results);
    }

    const marketTypes: MarketTypeSnapshot[] = [];
    for (let version = 0; version <= defaultMarketTypeVersion; version += 1) {
      const marketType = parseMarketType(
        unwrapResult(dynamicResults, version, `registry marketTypes(${version})`),
        version,
      );
      if (marketType !== null) marketTypes.push(marketType);
    }
    const signerOffset = defaultMarketTypeVersion + 1;
    const signers = Array.from({ length: signerCount }, (_, index) =>
      addressValue(
        unwrapResult(
          dynamicResults,
          signerOffset + index,
          `oracle currentSigners(${index})`,
        ),
        `oracle currentSigners(${index})`,
      ),
    ).sort();

    const snapshot: ChainStateSnapshot = {
      blockNumber,
      registry: {
        collateralAddress: addressValue(
          unwrapResult(firstResults, 5, 'registry collateral'),
          'registry collateral',
        ),
        collateralDecimals: dbInteger(
          unwrapResult(firstResults, 6, 'registry collateralDecimals'),
          'registry collateralDecimals',
        ),
        ctfAddress: addressValue(
          unwrapResult(firstResults, 7, 'registry CTF'),
          'registry CTF',
        ),
        oracleAddress: addressValue(
          unwrapResult(firstResults, 8, 'registry oracle'),
          'registry oracle',
        ),
        lmsrAddress: addressValue(
          unwrapResult(firstResults, 9, 'registry LMSR'),
          'registry LMSR',
        ),
        miniClobAddress: addressValue(
          unwrapResult(firstResults, 10, 'registry MiniCLOB'),
          'registry MiniCLOB',
        ),
        defaultMarketTypeVersion,
        params,
      },
      committee: {
        ctfAddress: addressValue(
          unwrapResult(firstResults, 11, 'oracle CTF'),
          'oracle CTF',
        ),
        threshold,
        signers,
      },
      marketTypes,
      rpcRequestCount,
    };
    validateChainStateSnapshot(snapshot);
    return snapshot;
  }
}

function positiveDecimal(value: string): boolean {
  return /^\d+$/u.test(value) && BigInt(value) > 0n;
}

export function inspectChainStateRows(
  config: RegistryConfig | null,
  members: readonly Pick<CommitteeMember, 'active' | 'address'>[],
  marketTypes: readonly Pick<
    RegisteredMarketType,
    'version' | 'lmsrAddress' | 'configHash'
  >[],
): PersistedChainStateInspection {
  const issues: ChainStateIssue[] = [];
  const paramsValid =
    config !== null &&
    config.chainId === ARC.chainId &&
    config.registryAddress === ADDRESSES.registry.toLowerCase() &&
    positiveDecimal(config.seedFloorRaw) &&
    positiveDecimal(config.seedCapRaw) &&
    BigInt(config.seedCapRaw) >= BigInt(config.seedFloorRaw) &&
    positiveDecimal(config.graduationTollRaw) &&
    config.protocolFeeBps > 0 &&
    config.protocolFeeBps <= 10_000 &&
    config.minTradingWindowSeconds > 0 &&
    config.maxTradingWindowSeconds >= config.minTradingWindowSeconds &&
    config.marketTypeVersion > 0;
  if (!paramsValid) issues.push('registry-parameters-invalid');

  const activeMembers = members.filter(({ active }) => active);
  if (
    config === null ||
    config.committeeThreshold <= 0 ||
    activeMembers.length < config.committeeThreshold ||
    activeMembers.some(({ address }) => !isAddress(address))
  ) {
    issues.push('committee-snapshot-invalid');
  }

  const currentType =
    config === null
      ? undefined
      : marketTypes.find(({ version }) => version === config.marketTypeVersion);
  if (
    config === null ||
    marketTypes.length === 0 ||
    currentType === undefined ||
    currentType.lmsrAddress !== config.currentLmsrAddress ||
    !/^0x[0-9a-f]{64}$/u.test(currentType.configHash) ||
    currentType.configHash === ZERO_HASH
  ) {
    issues.push('market-types-snapshot-invalid');
  }
  return { ready: issues.length === 0, issues };
}

export async function inspectPersistedChainState(
  prisma: PrismaClient,
): Promise<PersistedChainStateInspection> {
  const [config, members, marketTypes] = await Promise.all([
    prisma.registryConfig.findUnique({ where: { id: 1 } }),
    prisma.committeeMember.findMany({
      select: { address: true, active: true },
    }),
    prisma.registeredMarketType.findMany({
      select: { version: true, lmsrAddress: true, configHash: true },
    }),
  ]);
  return inspectChainStateRows(config, members, marketTypes);
}

function compareCoordinate(
  left: { blockNumber: number; logIndex: number },
  right: { blockNumber: number; logIndex: number },
): number {
  if (left.blockNumber !== right.blockNumber) return left.blockNumber - right.blockNumber;
  return left.logIndex - right.logIndex;
}

function rowsMatch(
  existing: object,
  desired: Readonly<Record<string, unknown>>,
): boolean {
  const row = existing as Record<string, unknown>;
  return Object.entries(desired).every(([key, value]) => row[key] === value);
}

function assertNoZeroRegression(
  existing: RegistryConfig,
  params: RegistryParameterSnapshot,
  marketTypeVersion: number,
  committeeThreshold: number,
): void {
  const pairs: Array<[string, bigint, bigint]> = [
    ...(
      [
        'openingFeeRaw',
        'seedFloorRaw',
        'seedCapRaw',
        'fCapRaw',
        'singleTopUpCapRaw',
        'graduationMoneyInThresholdRaw',
        'graduationTollRaw',
        'inventoryTargetRaw',
        'inventoryLowRaw',
        'inventoryHighRaw',
        'freeCollateralBufferRaw',
      ] as const
    ).map(
      (name): [string, bigint, bigint] => [
        name,
        BigInt(existing[name]),
        BigInt(params[name]),
      ],
    ),
    [
      'defaultTradingWindowSeconds',
      BigInt(existing.defaultTradingWindowSeconds),
      BigInt(params.defaultTradingWindowSeconds),
    ],
    [
      'minTradingWindowSeconds',
      BigInt(existing.minTradingWindowSeconds),
      BigInt(params.minTradingWindowSeconds),
    ],
    [
      'maxTradingWindowSeconds',
      BigInt(existing.maxTradingWindowSeconds),
      BigInt(params.maxTradingWindowSeconds),
    ],
    [
      'minimumTimeOpenSeconds',
      BigInt(existing.minimumTimeOpenSeconds),
      BigInt(params.minimumTimeOpenSeconds),
    ],
    ['protocolFeeBps', BigInt(existing.protocolFeeBps), BigInt(params.protocolFeeBps)],
    ['depthFeeBps', BigInt(existing.depthFeeBps), BigInt(params.depthFeeBps)],
    ['marketTypeVersion', BigInt(existing.marketTypeVersion), BigInt(marketTypeVersion)],
    ['committeeThreshold', BigInt(existing.committeeThreshold), BigInt(committeeThreshold)],
  ];
  const regression = pairs.find(([, previous, next]) => previous > 0n && next === 0n);
  if (regression !== undefined) {
    throw new Error(
      `Chain-state bootstrap refused to replace positive ${regression[0]} with zero`,
    );
  }
}

async function recordBootstrapFailure(
  prisma: PrismaClient,
  snapshotBlock: number,
  attemptedAt: Date,
  error: string,
): Promise<void> {
  await prisma.indexerState.updateMany({
    where: {
      id: 1,
      OR: [
        { chainStateBootstrapAttemptedBlock: null },
        { chainStateBootstrapAttemptedBlock: { lte: snapshotBlock } },
      ],
    },
    data: {
      chainStateBootstrapStatus: 'FAILED',
      chainStateBootstrapAttemptedBlock: snapshotBlock,
      chainStateBootstrapAttemptedAt: attemptedAt,
      chainStateBootstrapError: error,
    },
  });
}

async function persistChainStateSnapshot(
  prisma: PrismaClient,
  snapshot: ChainStateSnapshot,
  attemptedAt: Date,
): Promise<{ changedRows: number; protectedNewerRows: number }> {
  return prisma.$transaction(
    async (tx) => {
      const cursor = await lockIndexerCursor(tx);
      if (cursor.lastBlock !== snapshot.blockNumber) {
        throw new Error(
          `Indexer cursor moved from bootstrap block ${snapshot.blockNumber} to ${cursor.lastBlock}`,
        );
      }
      let changedRows = 0;
      let protectedNewerRows = 0;
      // Direct getters expose current membership/type values, not their
      // historical event timestamps. For rows discovered only by bootstrap,
      // record when this authoritative snapshot was observed.
      const observedAt = Math.floor(attemptedAt.getTime() / 1_000);
      const currentType = snapshot.marketTypes.find(
        ({ version }) => version === snapshot.registry.defaultMarketTypeVersion,
      );
      if (currentType === undefined) {
        throw new Error('Validated snapshot lost its default market type');
      }

      const existingConfig = await tx.registryConfig.findUniqueOrThrow({
        where: { id: 1 },
      });
      const bootstrapCoordinate = {
        blockNumber: snapshot.blockNumber,
        logIndex: MAX_EVENT_LOG_INDEX,
      };
      const configCoordinate = {
        blockNumber: existingConfig.updatedBlock,
        logIndex: existingConfig.updatedLogIndex,
      };
      if (compareCoordinate(configCoordinate, bootstrapCoordinate) > 0) {
        protectedNewerRows += 1;
      } else {
        assertNoZeroRegression(
          existingConfig,
          snapshot.registry.params,
          snapshot.registry.defaultMarketTypeVersion,
          snapshot.committee.threshold,
        );
        const desiredConfig = {
          usdcAddress: snapshot.registry.collateralAddress,
          ctfAddress: snapshot.registry.ctfAddress,
          oracleAddress: snapshot.registry.oracleAddress,
          lmsrAddress: snapshot.registry.lmsrAddress,
          registryAddress: ADDRESSES.registry.toLowerCase(),
          miniClobAddress: snapshot.registry.miniClobAddress,
          marketTypeVersion: snapshot.registry.defaultMarketTypeVersion,
          currentLmsrAddress: currentType.lmsrAddress,
          ...snapshot.registry.params,
          committeeThreshold: snapshot.committee.threshold,
          updatedBlock: snapshot.blockNumber,
          updatedLogIndex: MAX_EVENT_LOG_INDEX,
        } satisfies Prisma.RegistryConfigUpdateInput;
        if (!rowsMatch(existingConfig, desiredConfig)) {
          await tx.registryConfig.update({
            where: { id: 1 },
            data: desiredConfig,
          });
          changedRows += 1;
        }
      }

      const existingTypes = await tx.registeredMarketType.findMany();
      const typeByVersion = new Map(existingTypes.map((row) => [row.version, row]));
      for (const marketType of snapshot.marketTypes) {
        const existing = typeByVersion.get(marketType.version);
        const desired = {
          lmsrAddress: marketType.lmsrAddress,
          configHash: marketType.configHash,
          blockNumber: snapshot.blockNumber,
          logIndex: MAX_EVENT_LOG_INDEX,
        };
        if (existing === undefined) {
          await tx.registeredMarketType.create({
            data: {
              version: marketType.version,
              ...desired,
              registeredAt: observedAt,
            },
          });
          changedRows += 1;
          continue;
        }
        if (
          compareCoordinate(
            { blockNumber: existing.blockNumber, logIndex: existing.logIndex },
            bootstrapCoordinate,
          ) > 0
        ) {
          protectedNewerRows += 1;
          continue;
        }
        if (!rowsMatch(existing, desired)) {
          await tx.registeredMarketType.update({
            where: { version: marketType.version },
            data: desired,
          });
          changedRows += 1;
        }
      }

      const existingMembers = await tx.committeeMember.findMany();
      const memberByAddress = new Map(existingMembers.map((row) => [row.address, row]));
      const activeSigners = new Set(snapshot.committee.signers);
      for (const address of snapshot.committee.signers) {
        const existing = memberByAddress.get(address);
        const desired = {
          active: true,
          removedAt: null,
          updatedBlock: snapshot.blockNumber,
          updatedLogIndex: MAX_EVENT_LOG_INDEX,
        };
        if (existing === undefined) {
          await tx.committeeMember.create({
            data: { address, addedAt: observedAt, ...desired },
          });
          changedRows += 1;
          continue;
        }
        if (
          compareCoordinate(
            {
              blockNumber: existing.updatedBlock,
              logIndex: existing.updatedLogIndex,
            },
            bootstrapCoordinate,
          ) > 0
        ) {
          protectedNewerRows += 1;
          continue;
        }
        if (!rowsMatch(existing, desired)) {
          await tx.committeeMember.update({ where: { address }, data: desired });
          changedRows += 1;
        }
      }
      for (const existing of existingMembers) {
        if (activeSigners.has(existing.address)) continue;
        if (
          compareCoordinate(
            {
              blockNumber: existing.updatedBlock,
              logIndex: existing.updatedLogIndex,
            },
            bootstrapCoordinate,
          ) > 0
        ) {
          protectedNewerRows += 1;
          continue;
        }
        const desired = {
          active: false,
          removedAt: existing.removedAt ?? observedAt,
          updatedBlock: snapshot.blockNumber,
          updatedLogIndex: MAX_EVENT_LOG_INDEX,
        };
        if (!rowsMatch(existing, desired)) {
          await tx.committeeMember.update({
            where: { address: existing.address },
            data: desired,
          });
          changedRows += 1;
        }
      }

      const indexerState = await tx.indexerState.findUniqueOrThrow({ where: { id: 1 } });
      const statusMatches =
        indexerState.chainStateBootstrapStatus === 'COMPLETE' &&
        indexerState.chainStateBootstrapAttemptedBlock === snapshot.blockNumber &&
        indexerState.chainStateBootstrapBlock === snapshot.blockNumber &&
        indexerState.chainStateBootstrapError === null;
      if (!statusMatches) {
        await tx.indexerState.update({
          where: { id: 1 },
          data: {
            chainStateBootstrapStatus: 'COMPLETE',
            chainStateBootstrapAttemptedBlock: snapshot.blockNumber,
            chainStateBootstrapBlock: snapshot.blockNumber,
            chainStateBootstrapAttemptedAt: attemptedAt,
            chainStateBootstrappedAt: attemptedAt,
            chainStateBootstrapError: null,
          },
        });
        changedRows += 1;
      }
      return { changedRows, protectedNewerRows };
    },
    {
      maxWait: 30_000,
      timeout: 120_000,
      isolationLevel: 'Serializable',
    },
  );
}

export async function bootstrapChainState(
  prisma: PrismaClient,
  reader: ChainStateReader,
  options: { snapshotBlock: number; now?: () => Date },
): Promise<ChainStateBootstrapResult> {
  const attemptedAt = (options.now ?? (() => new Date()))();
  let rpcRequestCount = 0;
  try {
    const snapshot = await reader.readChainState(options.snapshotBlock);
    rpcRequestCount = snapshot.rpcRequestCount;
    if (snapshot.blockNumber !== options.snapshotBlock) {
      throw new Error(
        `Chain-state reader returned block ${snapshot.blockNumber}; expected ${options.snapshotBlock}`,
      );
    }
    validateChainStateSnapshot(snapshot);
    const persisted = await persistChainStateSnapshot(prisma, snapshot, attemptedAt);
    return {
      status: 'complete',
      snapshotBlock: options.snapshotBlock,
      rpcRequestCount,
      ...persisted,
      error: null,
    };
  } catch (error) {
    const message = errorMessage(error);
    await recordBootstrapFailure(prisma, options.snapshotBlock, attemptedAt, message);
    return {
      status: 'failed',
      snapshotBlock: options.snapshotBlock,
      rpcRequestCount,
      changedRows: 0,
      protectedNewerRows: 0,
      error: message,
    };
  }
}
