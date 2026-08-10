import conditionalTokensAbiJson from '@predex-pump/shared/abis/ConditionalTokens.json' with {
  type: 'json',
};
import { ADDRESSES } from '@predex-pump/shared';
import {
  Side,
  collateralErc20Abi,
  ctfExchangeAbi,
  ctfExchangeMakerAmountForFill,
} from '@predex-pump/shared/tx';
import type { SignedOrder } from '@prisma/client';
import {
  zeroHash,
  type Abi,
  type ContractFunctionParameters,
  type Hex,
  type PublicClient,
} from 'viem';

import { createArcPublicClient } from './chain-reader.js';
import type { ReservedMatch } from './matcher.js';
import { signedOrderFromRow } from './order.js';

const conditionalTokensAbi = conditionalTokensAbiJson as Abi;
const CALLS_PER_ORDER = 7;

export type PreflightFailureCode =
  | 'MARKET_RESOLVED'
  | 'WRONG_NONCE'
  | 'EXPIRED'
  | 'TOKEN_NOT_REGISTERED'
  | 'ORDER_CANCELLED'
  | 'STALE_FILL_STATE'
  | 'INSUFFICIENT_BALANCE'
  | 'MISSING_APPROVAL';

export type SettlementPreflightResult =
  | { ok: true; blockNumber: number }
  | { ok: false; code: PreflightFailureCode; message: string; blockNumber: number };

export interface SettlementPreflight {
  check(match: ReservedMatch): Promise<SettlementPreflightResult>;
}

interface FreshOrderState {
  nonce: bigint;
  complement: bigint;
  conditionId: Hex;
  payoutDenominator: bigint;
  cancelled: boolean;
  filledRaw: bigint;
  balanceRaw: bigint;
  approval: bigint | boolean;
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

function orderCalls(order: SignedOrder): ContractFunctionParameters[] {
  const signed = signedOrderFromRow(order);
  const assetCalls: ContractFunctionParameters[] =
    signed.side === Side.BUY
      ? [
          {
            address: ADDRESSES.usdc,
            abi: collateralErc20Abi as Abi,
            functionName: 'balanceOf',
            args: [signed.maker],
          },
          {
            address: ADDRESSES.usdc,
            abi: collateralErc20Abi as Abi,
            functionName: 'allowance',
            args: [signed.maker, ADDRESSES.ctfExchange],
          },
        ]
      : [
          {
            address: ADDRESSES.ctf,
            abi: conditionalTokensAbi,
            functionName: 'balanceOf',
            args: [signed.maker, signed.tokenId],
          },
          {
            address: ADDRESSES.ctf,
            abi: conditionalTokensAbi,
            functionName: 'isApprovedForAll',
            args: [signed.maker, ADDRESSES.ctfExchange],
          },
        ];
  return [
    {
      address: ADDRESSES.ctfExchange,
      abi: ctfExchangeAbi as Abi,
      functionName: 'makerNonce',
      args: [signed.maker],
    },
    {
      address: ADDRESSES.ctfExchange,
      abi: ctfExchangeAbi as Abi,
      functionName: 'registry',
      args: [signed.tokenId],
    },
    {
      address: ADDRESSES.ctf,
      abi: conditionalTokensAbi,
      functionName: 'payoutDenominator',
      args: [order.conditionId as Hex],
    },
    {
      address: ADDRESSES.ctfExchange,
      abi: ctfExchangeAbi as Abi,
      functionName: 'cancelledOrders',
      args: [order.orderHash as Hex],
    },
    {
      address: ADDRESSES.ctfExchange,
      abi: ctfExchangeAbi as Abi,
      functionName: 'filledAmount',
      args: [order.orderHash as Hex],
    },
    ...assetCalls,
  ];
}

function parseFreshOrderState(
  values: readonly unknown[],
  offset: number,
): FreshOrderState {
  const nonce = values[offset];
  const registry = values[offset + 1];
  const payoutDenominator = values[offset + 2];
  const cancelled = values[offset + 3];
  const filledRaw = values[offset + 4];
  const balanceRaw = values[offset + 5];
  const approval = values[offset + 6];
  if (
    typeof nonce !== 'bigint' ||
    typeof payoutDenominator !== 'bigint' ||
    typeof cancelled !== 'boolean' ||
    typeof filledRaw !== 'bigint' ||
    typeof balanceRaw !== 'bigint' ||
    (typeof approval !== 'bigint' && typeof approval !== 'boolean')
  ) {
    throw new Error('Arc returned an unexpected settlement preflight value');
  }
  const [complement, conditionId] = registryTuple(registry);
  return {
    nonce,
    complement,
    conditionId,
    payoutDenominator,
    cancelled,
    filledRaw,
    balanceRaw,
    approval,
  };
}

function blocked(
  code: PreflightFailureCode,
  message: string,
  blockNumber: number,
): SettlementPreflightResult {
  return { ok: false, code, message, blockNumber };
}

export class ViemSettlementPreflight implements SettlementPreflight {
  constructor(private readonly client: PublicClient = createArcPublicClient()) {}

  async check(match: ReservedMatch): Promise<SettlementPreflightResult> {
    const orders = [match.takerOrder, match.makerOrder] as const;
    const block = await this.client.getBlock({ blockTag: 'latest' });
    if (block.number === null) throw new Error('Latest Arc block omitted its number');
    const blockNumber = Number(block.number);
    if (!Number.isSafeInteger(blockNumber)) {
      throw new Error('Latest Arc block exceeds the database integer range');
    }
    const values = await this.client.multicall({
      allowFailure: false,
      blockNumber: block.number,
      contracts: orders.flatMap(orderCalls),
    });

    for (let index = 0; index < orders.length; index += 1) {
      const order = orders[index];
      if (order === undefined) continue;
      const state = parseFreshOrderState(values, index * CALLS_PER_ORDER);
      if (state.payoutDenominator !== 0n) {
        return blocked(
          'MARKET_RESOLVED',
          `Market ${order.marketId} resolved before settlement`,
          blockNumber,
        );
      }
      if (state.nonce !== BigInt(order.nonceRaw)) {
        return blocked(
          'WRONG_NONCE',
          `Maker nonce changed before settlement for order ${order.orderHash}`,
          blockNumber,
        );
      }
      if (order.expiration !== 0 && BigInt(order.expiration) <= block.timestamp) {
        return blocked(
          'EXPIRED',
          `Order ${order.orderHash} expired before settlement`,
          blockNumber,
        );
      }
      if (
        state.complement === 0n ||
        state.conditionId.toLowerCase() === zeroHash ||
        state.conditionId.toLowerCase() !== order.conditionId.toLowerCase()
      ) {
        return blocked(
          'TOKEN_NOT_REGISTERED',
          `Order ${order.orderHash} token registration is unavailable`,
          blockNumber,
        );
      }
      if (state.cancelled) {
        return blocked(
          'ORDER_CANCELLED',
          `Order ${order.orderHash} was cancelled on-chain`,
          blockNumber,
        );
      }
      if (state.filledRaw !== BigInt(order.filledRaw)) {
        return blocked(
          'STALE_FILL_STATE',
          `Indexed fill state is stale for order ${order.orderHash}`,
          blockNumber,
        );
      }

      const signed = signedOrderFromRow(order);
      const required = ctfExchangeMakerAmountForFill(
        signed,
        BigInt(match.fillSizeRaw),
      );
      if (state.balanceRaw < required) {
        return blocked(
          'INSUFFICIENT_BALANCE',
          `Maker balance changed before settlement for order ${order.orderHash}`,
          blockNumber,
        );
      }
      const approved =
        signed.side === Side.BUY
          ? typeof state.approval === 'bigint' && state.approval >= required
          : state.approval === true;
      if (!approved) {
        return blocked(
          'MISSING_APPROVAL',
          `Maker approval changed before settlement for order ${order.orderHash}`,
          blockNumber,
        );
      }
    }
    return { ok: true, blockNumber };
  }
}
