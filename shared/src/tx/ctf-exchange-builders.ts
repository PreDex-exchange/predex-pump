import { encodeFunctionData, type Abi } from 'viem';

import { ADDRESSES } from '../addresses';
import { ctfExchangeAbi } from './abis';
import { buildCtfApprovalForAllTx, buildErc20ApprovalTx } from './builders';
import type {
  CtfExchangeCancelOrdersTxInput,
  CtfExchangeCancelOrderTxInput,
  CtfExchangeCollateralApprovalTxInput,
  CtfExchangeFillOrdersTxInput,
  CtfExchangeFillOrderTxInput,
  CtfExchangeMatchOrdersTxInput,
  TxRequest,
} from './types';

function buildCtfExchangeTx(
  functionName: string,
  args: readonly unknown[],
): TxRequest {
  return {
    to: ADDRESSES.ctfExchange,
    data: encodeFunctionData({
      abi: ctfExchangeAbi as Abi,
      functionName,
      args,
    }),
    value: 0n,
  };
}

export function buildCtfExchangeApprovalForAllTx() {
  return buildCtfApprovalForAllTx({
    operator: ADDRESSES.ctfExchange,
    approved: true,
  });
}

export function buildCtfExchangeCollateralApprovalTx({
  amountRaw,
}: CtfExchangeCollateralApprovalTxInput) {
  return buildErc20ApprovalTx({
    spender: ADDRESSES.ctfExchange,
    amountRaw,
  });
}

export function buildCtfExchangeFillOrderTx({
  order,
  fillAmount,
}: CtfExchangeFillOrderTxInput) {
  return buildCtfExchangeTx('fillOrder', [order, fillAmount]);
}

export function buildCtfExchangeFillOrdersTx({
  orders,
  fillAmounts,
}: CtfExchangeFillOrdersTxInput) {
  return buildCtfExchangeTx('fillOrders', [
    [...orders],
    [...fillAmounts],
  ]);
}

export function buildCtfExchangeMatchOrdersTx({
  takerOrder,
  makerOrders,
  takerFillAmount,
  makerFillAmounts,
}: CtfExchangeMatchOrdersTxInput) {
  return buildCtfExchangeTx('matchOrders', [
    takerOrder,
    [...makerOrders],
    takerFillAmount,
    [...makerFillAmounts],
  ]);
}

export function buildCtfExchangeCancelOrderTx({
  order,
}: CtfExchangeCancelOrderTxInput) {
  return buildCtfExchangeTx('cancelOrder', [order]);
}

export function buildCtfExchangeCancelOrdersTx({
  orders,
}: CtfExchangeCancelOrdersTxInput) {
  return buildCtfExchangeTx('cancelOrders', [[...orders]]);
}

export function buildCtfExchangeCancelAllTx() {
  return buildCtfExchangeTx('cancelAll', []);
}
