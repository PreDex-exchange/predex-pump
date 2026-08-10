import type {
  Prisma,
  SignedOrder as DbSignedOrder,
} from '@prisma/client';
import type {
  OffchainOrder,
  OrderUnfillableReason,
  SignedCtfExchangeOrder,
} from '@predex-pump/shared';
import {
  ctfExchangeOrderTerms,
  ctfExchangeOrderFromWire,
  type CtfExchangeOrder,
} from '@predex-pump/shared/tx';

export interface Fillability {
  fillable: boolean;
  reason: OrderUnfillableReason | null;
}

export function signedOrderCreateData(input: {
  orderHash: string;
  order: CtfExchangeOrder;
  marketId: string;
  conditionId: string;
  outcome: 'YES' | 'NO';
  status?: string;
  origin?: string;
  now: number;
}): Prisma.SignedOrderUncheckedCreateInput {
  const terms = ctfExchangeOrderTerms(input.order);
  return {
    orderHash: input.orderHash.toLowerCase(),
    saltRaw: input.order.salt.toString(),
    maker: input.order.maker.toLowerCase(),
    signer: input.order.signer.toLowerCase(),
    taker: input.order.taker.toLowerCase(),
    tokenId: input.order.tokenId.toString(),
    makerAmountRaw: input.order.makerAmount.toString(),
    takerAmountRaw: input.order.takerAmount.toString(),
    expiration: Number(input.order.expiration),
    nonceRaw: input.order.nonce.toString(),
    feeRateBpsRaw: input.order.feeRateBps.toString(),
    exchangeSide: input.order.side,
    signatureType: input.order.signatureType,
    signature: input.order.signature,
    marketId: input.marketId,
    conditionId: input.conditionId.toLowerCase(),
    outcome: input.outcome,
    side: input.order.side === 0 ? 'BID' : 'ASK',
    priceRaw: terms.priceRaw.toString(),
    sizeRaw: terms.sizeRaw.toString(),
    remainingRaw: terms.sizeRaw.toString(),
    status: input.status ?? 'OPEN',
    origin: input.origin ?? 'USER',
    createdAt: input.now,
    updatedAt: input.now,
  };
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
