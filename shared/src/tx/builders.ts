import { encodeFunctionData, type Abi, type Address } from 'viem';

import { ADDRESSES } from '../addresses';
import {
  committeeOracleAbi,
  collateralErc20Abi,
  conditionalTokensAbi,
  incubatorLmsrAbi,
  incubatorRegistryAbi,
  miniClobAbi,
} from './abis';
import { ZERO_COLLECTION_ID } from './helpers';
import type {
  BuyTxInput,
  CommitteeResolveTxInput,
  CreateMarketTxInput,
  CtfApprovalForAllTxInput,
  Erc20ApprovalTxInput,
  MarketIdTxInput,
  MiniClobCancelTxInput,
  MiniClobCutoverTxInput,
  MiniClobFillTxInput,
  MiniClobPlaceTxInput,
  RedeemTxInput,
  SellTxInput,
  TxRequest,
} from './types';

function buildTx(
  to: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
): TxRequest {
  return {
    to,
    data: encodeFunctionData({
      abi,
      functionName,
      args,
    }),
    value: 0n,
  };
}

export function buildErc20ApprovalTx({
  spender,
  amountRaw,
}: Erc20ApprovalTxInput) {
  return buildTx(ADDRESSES.usdc, collateralErc20Abi, 'approve', [
    spender,
    amountRaw,
  ]);
}

export function buildCtfApprovalForAllTx({
  operator,
  approved = true,
}: CtfApprovalForAllTxInput) {
  return buildTx(ADDRESSES.ctf, conditionalTokensAbi, 'setApprovalForAll', [
    operator,
    approved,
  ]);
}

export function buildCreateMarketTx({
  ancillaryData,
  seedRaw,
  openingFeeRaw,
  tradingWindowSeconds,
  metadataHash,
}: CreateMarketTxInput) {
  return buildTx(ADDRESSES.registry, incubatorRegistryAbi, 'createMarket', [
    ancillaryData,
    seedRaw,
    openingFeeRaw,
    tradingWindowSeconds,
    metadataHash,
  ]);
}

export function buildBuyTx({
  marketId,
  outcome,
  amountRaw,
  maxCostRaw,
  deadline,
}: BuyTxInput) {
  return buildTx(
    ADDRESSES.lmsr,
    incubatorLmsrAbi,
    outcome === 'YES' ? 'buyYes' : 'buyNo',
    [marketId, amountRaw, maxCostRaw, deadline],
  );
}

export function buildSellTx({
  marketId,
  outcome,
  amountRaw,
  minProceedsRaw,
  deadline,
}: SellTxInput) {
  return buildTx(
    ADDRESSES.lmsr,
    incubatorLmsrAbi,
    outcome === 'YES' ? 'sellYes' : 'sellNo',
    [marketId, amountRaw, minProceedsRaw, deadline],
  );
}

export function buildGraduateIfQualifiedTx({ marketId }: MarketIdTxInput) {
  return buildTx(
    ADDRESSES.registry,
    incubatorRegistryAbi,
    'graduateIfQualified',
    [marketId],
  );
}

// The UI calls this action "graduate"; the deployed write remains
// IncubatorRegistry.graduateIfQualified(uint256).
export const buildGraduateTx = buildGraduateIfQualifiedTx;

export function buildMiniClobPlaceTx({
  conditionId,
  tokenId,
  side,
  priceRaw,
  sizeRaw,
}: MiniClobPlaceTxInput) {
  return buildTx(ADDRESSES.miniClob, miniClobAbi, 'place', [
    conditionId,
    tokenId,
    side === 'BID' ? 0 : 1,
    priceRaw,
    sizeRaw,
  ]);
}

export function buildMiniClobFillTx({
  orderId,
  fillSizeRaw,
}: MiniClobFillTxInput) {
  return buildTx(ADDRESSES.miniClob, miniClobAbi, 'fill', [
    orderId,
    fillSizeRaw,
  ]);
}

export function buildMiniClobCancelTx({ orderId }: MiniClobCancelTxInput) {
  return buildTx(ADDRESSES.miniClob, miniClobAbi, 'cancel', [orderId]);
}

/** Irreversibly retire one graduated condition from the on-chain book. */
export function buildMiniClobCutoverTx({
  conditionId,
}: MiniClobCutoverTxInput) {
  return buildTx(ADDRESSES.miniClob, miniClobAbi, 'cutover', [conditionId]);
}

export function buildCommitteeResolveTx({
  questionId,
  payouts,
  signatures,
}: CommitteeResolveTxInput) {
  return buildTx(ADDRESSES.oracle, committeeOracleAbi, 'resolve', [
    questionId,
    [...payouts],
    [...signatures],
  ]);
}

export function buildObserveResolutionTx({ marketId }: MarketIdTxInput) {
  return buildTx(ADDRESSES.lmsr, incubatorLmsrAbi, 'observeResolution', [
    marketId,
  ]);
}

export function buildRedeemTx({ conditionId, indexSet }: RedeemTxInput) {
  return buildTx(ADDRESSES.ctf, conditionalTokensAbi, 'redeemPositions', [
    ADDRESSES.usdc,
    ZERO_COLLECTION_ID,
    conditionId,
    [indexSet],
  ]);
}

export function buildCloseoutTx({ marketId }: MarketIdTxInput) {
  return buildTx(ADDRESSES.lmsr, incubatorLmsrAbi, 'closeout', [marketId]);
}

export function buildClaimFundingResidualTx({ marketId }: MarketIdTxInput) {
  return buildTx(ADDRESSES.lmsr, incubatorLmsrAbi, 'claimFundingResidual', [
    marketId,
  ]);
}

export function buildSweepProtocolAfterCloseoutTx({
  marketId,
}: MarketIdTxInput) {
  return buildTx(
    ADDRESSES.lmsr,
    incubatorLmsrAbi,
    'sweepProtocolAfterCloseout',
    [marketId],
  );
}
