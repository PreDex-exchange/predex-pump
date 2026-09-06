import conditionalTokensAbiJson from '@predex-pump/shared/abis/ConditionalTokens.json' with {
  type: 'json',
};
import registryAbiJson from '@predex-pump/shared/abis/IncubatorRegistry.json' with {
  type: 'json',
};
import { ADDRESSES, ARC } from '@predex-pump/shared';
import {
  Side,
  collateralErc20Abi,
  ctfExchangeAbi,
  miniClobAbi,
  type CtfExchangeOrder,
} from '@predex-pump/shared/tx';
import {
  createPublicClient,
  fallback,
  http,
  keccak256,
  stringToHex,
  type Abi,
  type ContractFunctionParameters,
  type Hex,
  type PublicClient,
} from 'viem';

import { ARC_CHAIN } from '../chain.js';

const conditionalTokensAbi = conditionalTokensAbiJson as Abi;
const registryAbi = registryAbiJson as Abi;
const CTF_EXCHANGE_ADMIN_ROLE = keccak256(stringToHex('ADMIN_ROLE'));

export { ARC_CHAIN };

export interface FreshOrderChainState {
  blockNumber: number;
  blockTimestamp: bigint;
  makerNonce: bigint;
  complementTokenId: bigint;
  registeredConditionId: Hex;
  registeredTradingEndsAt: bigint;
  payoutDenominator: bigint;
  makerAssetBalance: bigint;
  approvalKind: 'COLLATERAL_ALLOWANCE' | 'CTF_APPROVAL_FOR_ALL';
  collateralAllowance: bigint | null;
  ctfApprovedForAll: boolean | null;
}

export interface OrderChainReader {
  readOrderState(
    order: CtfExchangeOrder,
    conditionId: Hex,
  ): Promise<FreshOrderChainState>;
}

export interface MiniClobSeedOrderState {
  orderId: bigint;
  maker: Hex;
  conditionId: Hex;
  tokenId: bigint;
  side: number;
  priceRaw: bigint;
  sizeRaw: bigint;
  filledRaw: bigint;
  open: boolean;
}

export interface BookMigrationChainState {
  blockNumber: number;
  blockTimestamp: bigint;
  conditionStale: boolean;
  graduationSeedOrderIds: {
    yesOrderId: bigint;
    noOrderId: bigint;
  };
  makerNonce: bigint;
  ctfApprovedForAll: boolean;
  registrationAuthorized: boolean;
  exchangeCtfAddress: Hex;
  exchangeCollateralAddress: Hex;
  conditionPrepared: boolean;
  payoutDenominator: bigint;
  yesBalanceRaw: bigint;
  noBalanceRaw: bigint;
  yesRegistration: {
    complementTokenId: bigint;
    conditionId: Hex;
    tradingEndsAt: bigint;
  };
  noRegistration: {
    complementTokenId: bigint;
    conditionId: Hex;
    tradingEndsAt: bigint;
  };
  registryTradingEndsAt: bigint;
  registryLifecycle: {
    creator: Hex;
    marketTypeVersion: number;
    state: number;
    paused: boolean;
  };
  registryBinding: {
    collateralAddress: Hex;
    ctfAddress: Hex;
    oracleAddress: Hex;
    questionId: Hex;
    conditionId: Hex;
    yesTokenId: bigint;
    noTokenId: bigint;
  };
  /** Null only for the Registry's explicit zero-handoff 0/0 graduation. */
  yesOrder: MiniClobSeedOrderState | null;
  noOrder: MiniClobSeedOrderState | null;
}

export interface BookMigrationChainReader {
  readBookMigrationState(input: {
    marketId: bigint;
    maker: Hex;
    conditionId: Hex;
    yesTokenId: bigint;
    noTokenId: bigint;
    yesSeedOrderId: bigint;
    noSeedOrderId: bigint;
  }): Promise<BookMigrationChainState>;
}

export function createArcPublicClient(
  rpcUrls: readonly string[] = ARC.rpcUrls,
): PublicClient {
  return createPublicClient({
    chain: ARC_CHAIN,
    transport: fallback(rpcUrls.map((url) => http(url, { retryCount: 0 }))),
  });
}

function safeBlockNumber(blockNumber: bigint): number {
  const value = Number(blockNumber);
  if (!Number.isSafeInteger(value)) {
    throw new Error('Latest block number exceeds the database integer range');
  }
  return value;
}

function registryTuple(value: unknown): readonly [bigint, Hex, bigint] {
  if (
    Array.isArray(value) &&
    typeof value[0] === 'bigint' &&
    typeof value[1] === 'string' &&
    typeof value[2] === 'bigint'
  ) {
    return [value[0], value[1] as Hex, value[2]];
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (
      typeof record.complement === 'bigint' &&
      typeof record.conditionId === 'string' &&
      typeof record.tradingEndsAt === 'bigint'
    ) {
      return [
        record.complement,
        record.conditionId as Hex,
        record.tradingEndsAt,
      ];
    }
  }
  throw new Error('CTFExchange registry returned an unexpected value');
}

function integerValue(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  throw new Error(`MiniCLOB returned an unexpected ${field}`);
}

function outputFields(
  value: unknown,
  names: readonly string[],
  label: string,
): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return names.map((name) => record[name]);
  }
  throw new Error(`${label} returned an unexpected value`);
}

function registryLifecycleTuple(value: unknown): BookMigrationChainState['registryLifecycle'] {
  const fields = outputFields(
    value,
    ['creator', 'marketTypeVersion', 'state', 'paused'],
    'IncubatorRegistry marketLifecycle',
  );
  const creator = fields[0];
  const paused = fields[3];
  if (typeof creator !== 'string' || typeof paused !== 'boolean') {
    throw new Error('IncubatorRegistry returned an unexpected market lifecycle');
  }
  return {
    creator: creator as Hex,
    marketTypeVersion: Number(integerValue(fields[1], 'marketTypeVersion')),
    state: Number(integerValue(fields[2], 'market lifecycle state')),
    paused,
  };
}

function registryBindingTuple(value: unknown): BookMigrationChainState['registryBinding'] {
  const fields = outputFields(
    value,
    [
      'collateral_',
      'ctf_',
      'oracle_',
      'questionId',
      'conditionId',
      'yesTokenId',
      'noTokenId',
    ],
    'IncubatorRegistry tokenBinding',
  );
  if (fields.slice(0, 5).some((field) => typeof field !== 'string')) {
    throw new Error('IncubatorRegistry returned an unexpected token binding');
  }
  return {
    collateralAddress: fields[0] as Hex,
    ctfAddress: fields[1] as Hex,
    oracleAddress: fields[2] as Hex,
    questionId: fields[3] as Hex,
    conditionId: fields[4] as Hex,
    yesTokenId: integerValue(fields[5], 'YES token id'),
    noTokenId: integerValue(fields[6], 'NO token id'),
  };
}

function miniClobOrderTuple(
  orderId: bigint,
  value: unknown,
): MiniClobSeedOrderState {
  let fields: readonly unknown[];
  if (Array.isArray(value)) {
    fields = value;
  } else if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    fields = [
      record.maker,
      record.conditionId,
      record.tokenId,
      record.side,
      record.priceRawPerToken,
      record.sizeRaw,
      record.filledRaw,
      record.open,
    ];
  } else {
    throw new Error('MiniCLOB returned an unexpected seed order');
  }
  const maker = fields[0];
  const conditionId = fields[1];
  const open = fields[7];
  if (
    typeof maker !== 'string' ||
    typeof conditionId !== 'string' ||
    typeof open !== 'boolean'
  ) {
    throw new Error('MiniCLOB returned an unexpected seed order');
  }
  return {
    orderId,
    maker: maker as Hex,
    conditionId: conditionId as Hex,
    tokenId: integerValue(fields[2], 'tokenId'),
    side: Number(integerValue(fields[3], 'side')),
    priceRaw: integerValue(fields[4], 'price'),
    sizeRaw: integerValue(fields[5], 'size'),
    filledRaw: integerValue(fields[6], 'filled amount'),
    open,
  };
}

function graduationSeedOrderIdsTuple(value: unknown): {
  yesOrderId: bigint;
  noOrderId: bigint;
} {
  const fields = outputFields(
    value,
    ['yesOrderId', 'noOrderId'],
    'MiniCLOB graduationSeedOrderIds',
  );
  return {
    yesOrderId: integerValue(fields[0], 'YES graduation seed order id'),
    noOrderId: integerValue(fields[1], 'NO graduation seed order id'),
  };
}

export class ViemOrderChainReader
  implements OrderChainReader, BookMigrationChainReader
{
  constructor(private readonly client: PublicClient = createArcPublicClient()) {}

  async readOrderState(
    order: CtfExchangeOrder,
    conditionId: Hex,
  ): Promise<FreshOrderChainState> {
    const block = await this.client.getBlock({ blockTag: 'latest' });
    if (block.number === null) throw new Error('Latest Arc block omitted its number');

    const assetContracts: ContractFunctionParameters[] =
      order.side === Side.BUY
        ? [
            {
              address: ADDRESSES.usdc,
              abi: collateralErc20Abi as Abi,
              functionName: 'balanceOf',
              args: [order.maker],
            },
            {
              address: ADDRESSES.usdc,
              abi: collateralErc20Abi as Abi,
              functionName: 'allowance',
              args: [order.maker, ADDRESSES.ctfExchange],
            },
          ]
        : [
            {
              address: ADDRESSES.ctf,
              abi: conditionalTokensAbi,
              functionName: 'balanceOf',
              args: [order.maker, order.tokenId],
            },
            {
              address: ADDRESSES.ctf,
              abi: conditionalTokensAbi,
              functionName: 'isApprovedForAll',
              args: [order.maker, ADDRESSES.ctfExchange],
            },
          ];

    const contracts: ContractFunctionParameters[] = [
      {
        address: ADDRESSES.ctfExchange,
        abi: ctfExchangeAbi as Abi,
        functionName: 'makerNonce',
        args: [order.maker],
      },
      {
        address: ADDRESSES.ctfExchange,
        abi: ctfExchangeAbi as Abi,
        functionName: 'registry',
        args: [order.tokenId],
      },
      {
        address: ADDRESSES.ctf,
        abi: conditionalTokensAbi,
        functionName: 'payoutDenominator',
        args: [conditionId],
      },
      ...assetContracts,
    ];
    const results = await this.client.multicall({
      allowFailure: false,
      blockNumber: block.number,
      contracts,
    });
    const makerNonce = results[0];
    const payoutDenominator = results[2];
    const makerAssetBalance = results[3];
    const approval = results[4];
    if (
      typeof makerNonce !== 'bigint' ||
      typeof payoutDenominator !== 'bigint' ||
      typeof makerAssetBalance !== 'bigint'
    ) {
      throw new Error('Arc returned an unexpected order validation value');
    }
    const [
      complementTokenId,
      registeredConditionId,
      registeredTradingEndsAt,
    ] = registryTuple(results[1]);

    return {
      blockNumber: safeBlockNumber(block.number),
      blockTimestamp: block.timestamp,
      makerNonce,
      complementTokenId,
      registeredConditionId,
      registeredTradingEndsAt,
      payoutDenominator,
      makerAssetBalance,
      approvalKind:
        order.side === Side.BUY
          ? 'COLLATERAL_ALLOWANCE'
          : 'CTF_APPROVAL_FOR_ALL',
      collateralAllowance:
        order.side === Side.BUY && typeof approval === 'bigint'
          ? approval
          : null,
      ctfApprovedForAll:
        order.side === Side.SELL && typeof approval === 'boolean'
          ? approval
          : null,
    };
  }

  async readBookMigrationState(input: {
    marketId: bigint;
    maker: Hex;
    conditionId: Hex;
    yesTokenId: bigint;
    noTokenId: bigint;
    yesSeedOrderId: bigint;
    noSeedOrderId: bigint;
  }): Promise<BookMigrationChainState> {
    const chainId = await this.client.getChainId();
    if (chainId !== ARC.chainId) {
      throw new Error(
        `Operator RPC chain=${chainId} does not match Arc chain=${ARC.chainId}`,
      );
    }
    const block = await this.client.getBlock({ blockTag: 'latest' });
    if (block.number === null) throw new Error('Latest Arc block omitted its number');
    const zeroHandoff =
      input.yesSeedOrderId === 0n && input.noSeedOrderId === 0n;
    if (
      !zeroHandoff &&
      (input.yesSeedOrderId === 0n || input.noSeedOrderId === 0n)
    ) {
      throw new Error('MiniCLOB graduation seed ids must be both zero or both non-zero');
    }
    const seedContracts: ContractFunctionParameters[] = zeroHandoff
      ? []
      : [
          {
            address: ADDRESSES.miniClob,
            abi: miniClobAbi as Abi,
            functionName: 'getOrder',
            args: [input.yesSeedOrderId],
          },
          {
            address: ADDRESSES.miniClob,
            abi: miniClobAbi as Abi,
            functionName: 'getOrder',
            args: [input.noSeedOrderId],
          },
        ];
    const results = await this.client.multicall({
      allowFailure: false,
      blockNumber: block.number,
      contracts: [
        ...seedContracts,
        {
          address: ADDRESSES.ctfExchange,
          abi: ctfExchangeAbi as Abi,
          functionName: 'makerNonce',
          args: [input.maker],
        },
        {
          address: ADDRESSES.ctf,
          abi: conditionalTokensAbi,
          functionName: 'isApprovedForAll',
          args: [input.maker, ADDRESSES.ctfExchange],
        },
        {
          address: ADDRESSES.ctf,
          abi: conditionalTokensAbi,
          functionName: 'balanceOf',
          args: [input.maker, input.yesTokenId],
        },
        {
          address: ADDRESSES.ctf,
          abi: conditionalTokensAbi,
          functionName: 'balanceOf',
          args: [input.maker, input.noTokenId],
        },
        {
          address: ADDRESSES.ctfExchange,
          abi: ctfExchangeAbi as Abi,
          functionName: 'registry',
          args: [input.yesTokenId],
        },
        {
          address: ADDRESSES.ctfExchange,
          abi: ctfExchangeAbi as Abi,
          functionName: 'registry',
          args: [input.noTokenId],
        },
        {
          address: ADDRESSES.ctf,
          abi: conditionalTokensAbi,
          functionName: 'payoutDenominator',
          args: [input.conditionId],
        },
        {
          address: ADDRESSES.registry,
          abi: registryAbi,
          functionName: 'marketLifecycle',
          args: [input.marketId],
        },
        {
          address: ADDRESSES.registry,
          abi: registryAbi,
          functionName: 'tokenBinding',
          args: [input.marketId],
        },
        {
          address: ADDRESSES.ctf,
          abi: conditionalTokensAbi,
          functionName: 'isConditionPrepared',
          args: [input.conditionId],
        },
        {
          address: ADDRESSES.ctfExchange,
          abi: ctfExchangeAbi as Abi,
          functionName: 'ctf',
        },
        {
          address: ADDRESSES.ctfExchange,
          abi: ctfExchangeAbi as Abi,
          functionName: 'collateral',
        },
        {
          address: ADDRESSES.ctfExchange,
          abi: ctfExchangeAbi as Abi,
          functionName: 'hasRole',
          args: [CTF_EXCHANGE_ADMIN_ROLE, input.maker],
        },
        {
          address: ADDRESSES.miniClob,
          abi: miniClobAbi as Abi,
          functionName: 'conditionStale',
          args: [input.conditionId],
        },
        {
          address: ADDRESSES.miniClob,
          abi: miniClobAbi as Abi,
          functionName: 'graduationSeedOrderIds',
          args: [input.conditionId],
        },
        {
          address: ADDRESSES.registry,
          abi: registryAbi,
          functionName: 'marketTradingEndsAt',
          args: [input.marketId],
        },
      ],
    });
    const offset = zeroHandoff ? 0 : 2;
    const makerNonce = results[offset];
    const approved = results[offset + 1];
    const yesBalanceRaw = results[offset + 2];
    const noBalanceRaw = results[offset + 3];
    const payoutDenominator = results[offset + 6];
    const registryLifecycle = registryLifecycleTuple(results[offset + 7]);
    const registryBinding = registryBindingTuple(results[offset + 8]);
    const conditionPrepared = results[offset + 9];
    const exchangeCtfAddress = results[offset + 10];
    const exchangeCollateralAddress = results[offset + 11];
    const registrationAuthorized = results[offset + 12];
    const conditionStale = results[offset + 13];
    const graduationSeedOrderIds = graduationSeedOrderIdsTuple(
      results[offset + 14],
    );
    const registryTradingEndsAt = results[offset + 15];
    if (
      typeof makerNonce !== 'bigint' ||
      typeof approved !== 'boolean' ||
      typeof yesBalanceRaw !== 'bigint' ||
      typeof noBalanceRaw !== 'bigint' ||
      typeof payoutDenominator !== 'bigint' ||
      typeof conditionPrepared !== 'boolean' ||
      typeof exchangeCtfAddress !== 'string' ||
      typeof exchangeCollateralAddress !== 'string' ||
      typeof registrationAuthorized !== 'boolean' ||
      typeof conditionStale !== 'boolean' ||
      typeof registryTradingEndsAt !== 'bigint'
    ) {
      throw new Error('Arc returned unexpected migration validation state');
    }
    const [yesComplementTokenId, yesConditionId, yesTradingEndsAt] = registryTuple(
      results[offset + 4],
    );
    const [noComplementTokenId, noConditionId, noTradingEndsAt] = registryTuple(
      results[offset + 5],
    );
    return {
      blockNumber: safeBlockNumber(block.number),
      blockTimestamp: block.timestamp,
      conditionStale,
      graduationSeedOrderIds,
      makerNonce,
      ctfApprovedForAll: approved,
      registrationAuthorized,
      exchangeCtfAddress: exchangeCtfAddress as Hex,
      exchangeCollateralAddress: exchangeCollateralAddress as Hex,
      conditionPrepared,
      payoutDenominator,
      yesBalanceRaw,
      noBalanceRaw,
      yesRegistration: {
        complementTokenId: yesComplementTokenId,
        conditionId: yesConditionId,
        tradingEndsAt: yesTradingEndsAt,
      },
      noRegistration: {
        complementTokenId: noComplementTokenId,
        conditionId: noConditionId,
        tradingEndsAt: noTradingEndsAt,
      },
      registryTradingEndsAt,
      registryLifecycle,
      registryBinding,
      yesOrder: zeroHandoff
        ? null
        : miniClobOrderTuple(input.yesSeedOrderId, results[0]),
      noOrder: zeroHandoff
        ? null
        : miniClobOrderTuple(input.noSeedOrderId, results[1]),
    };
  }
}
