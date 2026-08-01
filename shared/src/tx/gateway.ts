import { encodeFunctionData, type Address } from 'viem';

import { ADDRESSES } from '../addresses';
import { buildErc20ApprovalTx } from './builders';
import type { TxRequest } from './types';

/** Arc Testnet values verified against @circle-fin/x402-batching 3.2.0. */
export const CIRCLE_GATEWAY_WALLET_ADDRESS =
  '0x0077777d7EBA4688BDeF3E311b846F25870A19B9' as Address;
export const CIRCLE_GATEWAY_DOMAIN = 26;
export const CIRCLE_GATEWAY_DEPOSIT_GAS_LIMIT = 120_000n;

/** Exact GATEWAY_WALLET_ABI deposit entry bundled in the installed Circle SDK. */
export const circleGatewayDepositAbi = [
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

export function buildCircleGatewayApprovalTx(amountRaw: bigint): TxRequest {
  return buildErc20ApprovalTx({
    spender: CIRCLE_GATEWAY_WALLET_ADDRESS,
    amountRaw,
  });
}

export function buildCircleGatewayDepositTx(amountRaw: bigint): TxRequest {
  return {
    to: CIRCLE_GATEWAY_WALLET_ADDRESS,
    data: encodeFunctionData({
      abi: circleGatewayDepositAbi,
      functionName: 'deposit',
      args: [ADDRESSES.usdc, amountRaw],
    }),
    value: 0n,
  };
}
