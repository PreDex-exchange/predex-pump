import conditionalTokensAbiJson from '@predex-pump/shared/abis/ConditionalTokens.json' with {
  type: 'json',
};
import { ADDRESSES, ARC } from '@predex-pump/shared';
import {
  Side,
  collateralErc20Abi,
  ctfExchangeAbi,
  type CtfExchangeOrder,
} from '@predex-pump/shared/tx';
import {
  createPublicClient,
  defineChain,
  fallback,
  http,
  type Abi,
  type ContractFunctionParameters,
  type Hex,
  type PublicClient,
} from 'viem';

const conditionalTokensAbi = conditionalTokensAbiJson as Abi;

export const ARC_CHAIN = defineChain({
  id: ARC.chainId,
  name: ARC.name,
  nativeCurrency: ARC.nativeCurrency,
  rpcUrls: { default: { http: [...ARC.rpcUrls] } },
});

export interface FreshOrderChainState {
  blockNumber: number;
  blockTimestamp: bigint;
  makerNonce: bigint;
  complementTokenId: bigint;
  registeredConditionId: Hex;
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

function registryTuple(value: unknown): readonly [bigint, Hex] {
  if (
    Array.isArray(value) &&
    typeof value[0] === 'bigint' &&
    typeof value[1] === 'string'
  ) {
    return [value[0], value[1] as Hex];
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (
      typeof record.complement === 'bigint' &&
      typeof record.conditionId === 'string'
    ) {
      return [record.complement, record.conditionId as Hex];
    }
  }
  throw new Error('CTFExchange registry returned an unexpected value');
}

export class ViemOrderChainReader implements OrderChainReader {
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
    const [complementTokenId, registeredConditionId] = registryTuple(results[1]);

    return {
      blockNumber: safeBlockNumber(block.number),
      blockTimestamp: block.timestamp,
      makerNonce,
      complementTokenId,
      registeredConditionId,
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
}
