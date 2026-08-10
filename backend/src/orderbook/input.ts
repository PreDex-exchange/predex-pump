import type {
  IngestOrderRequest,
  OrderIngestRejectionCode,
  SignedCtfExchangeOrder,
} from '@predex-pump/shared';
import { isAddress, isHex, size } from 'viem';

const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/u;
const UINT256_MAX = (1n << 256n) - 1n;
const ORDER_FIELDS = new Set([
  'saltRaw',
  'maker',
  'signer',
  'taker',
  'tokenId',
  'makerAmountRaw',
  'takerAmountRaw',
  'expiration',
  'nonceRaw',
  'feeRateBpsRaw',
  'side',
  'signatureType',
  'signature',
]);

export class OrderIngestError extends Error {
  constructor(
    readonly code: OrderIngestRejectionCode,
    message: string,
    readonly statusCode = 422,
  ) {
    super(message);
  }
}

function objectValue(name: string, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OrderIngestError('MALFORMED_ORDER', `${name} must be an object`, 400);
  }
  return value as Record<string, unknown>;
}

function rawUint(name: string, value: unknown): string {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) {
    throw new OrderIngestError(
      'MALFORMED_ORDER',
      `${name} must be a canonical unsigned decimal string`,
      400,
    );
  }
  if (BigInt(value) > UINT256_MAX) {
    throw new OrderIngestError('MALFORMED_ORDER', `${name} exceeds uint256`, 400);
  }
  return value;
}

function address(name: string, value: unknown): `0x${string}` {
  if (typeof value !== 'string' || !isAddress(value, { strict: true })) {
    throw new OrderIngestError(
      'MALFORMED_ORDER',
      `${name} must be a 20-byte address`,
      400,
    );
  }
  return value.toLowerCase() as `0x${string}`;
}

function safeTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new OrderIngestError(
      'MALFORMED_ORDER',
      'expiration must be a non-negative safe integer timestamp',
      400,
    );
  }
  return value as number;
}

function exchangeSide(value: unknown): 0 | 1 {
  if (value !== 0 && value !== 1) {
    throw new OrderIngestError('MALFORMED_ORDER', 'side must be 0 (BUY) or 1 (SELL)', 400);
  }
  return value;
}

function signatureType(value: unknown): 0 | 1 | 2 | 3 {
  if (value !== 0 && value !== 1 && value !== 2 && value !== 3) {
    throw new OrderIngestError('MALFORMED_ORDER', 'signatureType is unsupported', 400);
  }
  return value;
}

function signature(value: unknown): `0x${string}` {
  if (
    typeof value !== 'string' ||
    !isHex(value, { strict: true }) ||
    size(value) !== 65
  ) {
    throw new OrderIngestError(
      'BAD_SIGNATURE',
      'EOA order signature must be 65 bytes of hex',
    );
  }
  return value as `0x${string}`;
}

export function parseIngestOrderRequest(body: unknown): IngestOrderRequest {
  const request = objectValue('request body', body);
  const requestUnknown = Object.keys(request).find(
    (key) => key !== 'orderHash' && key !== 'order',
  );
  if (requestUnknown !== undefined) {
    throw new OrderIngestError(
      'MALFORMED_ORDER',
      `Unknown request field ${requestUnknown}`,
      400,
    );
  }
  if (
    typeof request.orderHash !== 'string' ||
    !isHex(request.orderHash, { strict: true }) ||
    size(request.orderHash) !== 32
  ) {
    throw new OrderIngestError(
      'MALFORMED_ORDER',
      'orderHash must be a 32-byte hex digest',
      400,
    );
  }

  const order = objectValue('order', request.order);
  const unknown = Object.keys(order).find((key) => !ORDER_FIELDS.has(key));
  if (unknown !== undefined) {
    throw new OrderIngestError(
      'MALFORMED_ORDER',
      `Unknown order field ${unknown}`,
      400,
    );
  }
  const parsed: SignedCtfExchangeOrder = {
    saltRaw: rawUint('saltRaw', order.saltRaw),
    maker: address('maker', order.maker),
    signer: address('signer', order.signer),
    taker: address('taker', order.taker),
    tokenId: rawUint('tokenId', order.tokenId),
    makerAmountRaw: rawUint('makerAmountRaw', order.makerAmountRaw),
    takerAmountRaw: rawUint('takerAmountRaw', order.takerAmountRaw),
    expiration: safeTimestamp(order.expiration),
    nonceRaw: rawUint('nonceRaw', order.nonceRaw),
    feeRateBpsRaw: rawUint('feeRateBpsRaw', order.feeRateBpsRaw),
    side: exchangeSide(order.side),
    signatureType: signatureType(order.signatureType),
    signature: signature(order.signature),
  };
  return {
    orderHash: request.orderHash.toLowerCase() as `0x${string}`,
    order: parsed,
  };
}
