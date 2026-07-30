import type { Address, Hex } from 'viem';

export type MarketOutcome = 'YES' | 'NO';
export type ResolutionChoice = MarketOutcome | 'INVALID';
export type MiniClobSide = 'BID' | 'ASK';

export interface TxRequest {
  to: Address;
  data: Hex;
  value: bigint;
}

export interface Erc20ApprovalTxInput {
  spender: Address;
  amountRaw: bigint;
}

export interface CtfApprovalForAllTxInput {
  operator: Address;
  approved?: boolean;
}

export interface CreateMarketTxInput {
  ancillaryData: Hex;
  seedRaw: bigint;
  openingFeeRaw: bigint;
  tradingWindowSeconds: bigint;
  metadataHash: Hex;
}

export interface TradeTxInput {
  marketId: bigint;
  outcome: MarketOutcome;
  amountRaw: bigint;
  deadline: bigint;
}

export interface BuyTxInput extends TradeTxInput {
  maxCostRaw: bigint;
}

export interface SellTxInput extends TradeTxInput {
  minProceedsRaw: bigint;
}

export interface MarketIdTxInput {
  marketId: bigint;
}

export interface MiniClobPlaceTxInput {
  conditionId: Hex;
  tokenId: bigint;
  side: MiniClobSide;
  priceRaw: bigint;
  sizeRaw: bigint;
}

export interface MiniClobFillTxInput {
  orderId: bigint;
  fillSizeRaw: bigint;
}

export interface MiniClobCancelTxInput {
  orderId: bigint;
}

export interface CommitteeResolveTxInput {
  questionId: Hex;
  payouts: readonly [bigint, bigint];
  signatures: readonly Hex[];
}

export interface RedeemTxInput {
  conditionId: Hex;
  indexSet: bigint;
}
