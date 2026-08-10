import type { SignedOrder as DbSignedOrder } from '@prisma/client';
import type {
  OffchainOrder,
  OrderUnfillableReason,
  SignedCtfExchangeOrder,
} from '@predex-pump/shared';
import {
  ctfExchangeOrderFromWire,
  type CtfExchangeOrder,
} from '@predex-pump/shared/tx';

export interface Fillability {
  fillable: boolean;
  reason: OrderUnfillableReason | null;
}

export function signedOrderFromWire(
  order: SignedCtfExchangeOrder,
): CtfExchangeOrder {
  return ctfExchangeOrderFromWire(order);
}

export function signedOrderFromRow(order: DbSignedOrder): CtfExchangeOrder {
  return {
    salt: BigInt(order.saltRaw),
    maker: order.maker as `0x${string}`,
    signer: order.signer as `0x${string}`,
    taker: order.taker as `0x${string}`,
    tokenId: BigInt(order.tokenId),
    makerAmount: BigInt(order.makerAmountRaw),
    takerAmount: BigInt(order.takerAmountRaw),
    expiration: BigInt(order.expiration),
    nonce: BigInt(order.nonceRaw),
    feeRateBps: BigInt(order.feeRateBpsRaw),
    side: order.exchangeSide as CtfExchangeOrder['side'],
    signatureType:
      order.signatureType as CtfExchangeOrder['signatureType'],
    signature: order.signature as `0x${string}`,
  };
}

export function signedOrderWireFromRow(
  order: DbSignedOrder,
): SignedCtfExchangeOrder {
  return {
    saltRaw: order.saltRaw,
    maker: order.maker as `0x${string}`,
    signer: order.signer as `0x${string}`,
    taker: order.taker as `0x${string}`,
    tokenId: order.tokenId,
    makerAmountRaw: order.makerAmountRaw,
    takerAmountRaw: order.takerAmountRaw,
    expiration: order.expiration,
    nonceRaw: order.nonceRaw,
    feeRateBpsRaw: order.feeRateBpsRaw,
    side: order.exchangeSide as SignedCtfExchangeOrder['side'],
    signatureType:
      order.signatureType as SignedCtfExchangeOrder['signatureType'],
    signature: order.signature as `0x${string}`,
  };
}

export function toOffchainOrderDto(
  order: DbSignedOrder,
  fillability: Fillability,
): OffchainOrder {
  return {
    orderHash: order.orderHash as `0x${string}`,
    marketId: order.marketId,
    conditionId: order.conditionId as `0x${string}`,
    tokenId: order.tokenId,
    outcome: order.outcome as OffchainOrder['outcome'],
    maker: order.maker as `0x${string}`,
    side: order.side as OffchainOrder['side'],
    priceRaw: order.priceRaw,
    sizeRaw: order.sizeRaw,
    filledRaw: order.filledRaw,
    remainingRaw: order.remainingRaw,
    status: order.status as OffchainOrder['status'],
    fillable: fillability.fillable,
    unfillableReason: fillability.reason,
    signedOrder: signedOrderWireFromRow(order),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}
