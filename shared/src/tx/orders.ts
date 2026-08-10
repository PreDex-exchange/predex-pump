import {
  bytesToBigInt,
  hashTypedData,
  isAddressEqual,
  keccak256,
  recoverTypedDataAddress,
  stringToHex,
  zeroAddress,
  type Address,
  type Hex,
  type LocalAccount,
  type WalletClient,
} from 'viem';

import { ADDRESSES, ARC } from '../addresses';

export const Side = {
  BUY: 0,
  SELL: 1,
} as const;

export type Side = (typeof Side)[keyof typeof Side];

export const SignatureType = {
  EOA: 0,
  POLY_PROXY: 1,
  POLY_GNOSIS_SAFE: 2,
  POLY_1271: 3,
} as const;

export type SignatureType =
  (typeof SignatureType)[keyof typeof SignatureType];

export const CTF_EXCHANGE_ORDER_TYPE_STRING =
  'Order(uint256 salt,address maker,address signer,address taker,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint256 nonce,uint256 feeRateBps,uint8 side,uint8 signatureType)';

export const CTF_EXCHANGE_ORDER_TYPE_HASH = keccak256(
  stringToHex(CTF_EXCHANGE_ORDER_TYPE_STRING),
);

export const CTF_EXCHANGE_ORDER_TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'taker', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' },
    { name: 'expiration', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'feeRateBps', type: 'uint256' },
    { name: 'side', type: 'uint8' },
    { name: 'signatureType', type: 'uint8' },
  ],
} as const;

export const CTF_EXCHANGE_DOMAIN = {
  name: 'Predex CTFExchange',
  version: '1',
  chainId: ARC.chainId,
  verifyingContract: ADDRESSES.ctfExchange,
} as const;

export const CTF_EXCHANGE_PRICE_SCALE = 1_000_000n;

const UINT256_MAX = (1n << 256n) - 1n;

export interface CtfExchangeOrder {
  salt: bigint;
  maker: Address;
  signer: Address;
  taker: Address;
  tokenId: bigint;
  makerAmount: bigint;
  takerAmount: bigint;
  expiration: bigint;
  nonce: bigint;
  feeRateBps: bigint;
  side: Side;
  signatureType: SignatureType;
  signature: Hex;
}

export type CtfExchangeOrderMessage = Omit<CtfExchangeOrder, 'signature'>;

export interface BuildCtfExchangeOrderInput {
  maker: Address;
  tokenId: bigint;
  side: Side;
  priceRaw: bigint;
  sizeRaw: bigint;
  salt?: bigint;
  signer?: Address;
  taker?: Address;
  expiration?: bigint;
  nonce?: bigint;
  feeRateBps?: bigint;
  signatureType?: SignatureType;
}

export interface CtfExchangeOrderAmountsInput {
  side: Side;
  priceRaw: bigint;
  sizeRaw: bigint;
}

export interface OrderSaltRandomSource {
  getRandomValues(bytes: Uint8Array): Uint8Array;
}

export type CtfExchangeOrderSigner = LocalAccount | WalletClient;

function assertUint256(name: string, value: bigint) {
  if (value < 0n || value > UINT256_MAX) {
    throw new Error(`${name} must fit in an unsigned 256-bit integer.`);
  }
}

function assertSide(side: number): asserts side is Side {
  if (side !== Side.BUY && side !== Side.SELL) {
    throw new Error('Order side must be Side.BUY or Side.SELL.');
  }
}

function assertSignatureType(
  signatureType: number,
): asserts signatureType is SignatureType {
  if (
    signatureType !== SignatureType.EOA &&
    signatureType !== SignatureType.POLY_PROXY &&
    signatureType !== SignatureType.POLY_GNOSIS_SAFE &&
    signatureType !== SignatureType.POLY_1271
  ) {
    throw new Error('Unsupported CTFExchange signature type.');
  }
}

function divideRoundUp(numerator: bigint, denominator: bigint) {
  return (numerator + denominator - 1n) / denominator;
}

/** Normalize a signed exchange ratio into position-token size and 6-decimal price. */
export function ctfExchangeOrderTerms(order: CtfExchangeOrder) {
  assertSide(order.side);
  assertUint256('makerAmount', order.makerAmount);
  assertUint256('takerAmount', order.takerAmount);
  if (order.makerAmount === 0n || order.takerAmount === 0n) {
    throw new Error('Order maker and taker amounts must be greater than zero.');
  }

  if (order.side === Side.BUY) {
    return {
      sizeRaw: order.takerAmount,
      priceRaw:
        (order.makerAmount * CTF_EXCHANGE_PRICE_SCALE) / order.takerAmount,
    };
  }
  return {
    sizeRaw: order.makerAmount,
    priceRaw: divideRoundUp(
      order.takerAmount * CTF_EXCHANGE_PRICE_SCALE,
      order.makerAmount,
    ),
  };
}

/** Maker-side asset needed by CTFExchange for a position-token fill amount. */
export function ctfExchangeMakerAmountForFill(
  order: CtfExchangeOrder,
  fillSizeRaw: bigint,
) {
  assertUint256('fillSizeRaw', fillSizeRaw);
  const { sizeRaw } = ctfExchangeOrderTerms(order);
  if (fillSizeRaw > sizeRaw) {
    throw new Error('Fill size exceeds the signed order size.');
  }
  return order.side === Side.SELL
    ? fillSizeRaw
    : (fillSizeRaw * order.makerAmount) / order.takerAmount;
}

/**
 * Encode a six-decimal price and position-token size into the ratio consumed by
 * CTFExchange. The contract settles SELL as
 * `floor(fill * takerAmount / makerAmount)` and BUY as
 * `floor(fill * makerAmount / takerAmount)`, where fill is always position-token
 * raw units. SELL therefore stores (size, collateral) while BUY stores
 * (collateral, size). At construction, SELL collateral rounds up so the encoded
 * full-size ratio does not lower the maker's ask; BUY collateral rounds down so
 * it does not raise the maker's bid. Individual partial fills still inherit the
 * contract's final floor to whole collateral raw units.
 */
export function ctfExchangeOrderAmounts({
  side,
  priceRaw,
  sizeRaw,
}: CtfExchangeOrderAmountsInput) {
  assertSide(side);
  assertUint256('priceRaw', priceRaw);
  assertUint256('sizeRaw', sizeRaw);
  if (priceRaw === 0n) throw new Error('Order price must be greater than zero.');
  if (sizeRaw === 0n) throw new Error('Order size must be greater than zero.');

  const notionalNumerator = priceRaw * sizeRaw;
  const collateralAmount =
    side === Side.SELL
      ? divideRoundUp(notionalNumerator, CTF_EXCHANGE_PRICE_SCALE)
      : notionalNumerator / CTF_EXCHANGE_PRICE_SCALE;

  if (collateralAmount === 0n) {
    throw new Error(
      'BUY order notional is below one raw collateral unit and cannot be represented without exceeding its limit price.',
    );
  }
  assertUint256('collateral amount', collateralAmount);

  return side === Side.SELL
    ? { makerAmount: sizeRaw, takerAmount: collateralAmount }
    : { makerAmount: collateralAmount, takerAmount: sizeRaw };
}

export function orderExpirationFromTimestamp(
  blockTimestamp: bigint,
  lifetimeSeconds: bigint,
) {
  assertUint256('blockTimestamp', blockTimestamp);
  assertUint256('lifetimeSeconds', lifetimeSeconds);
  if (lifetimeSeconds === 0n) {
    throw new Error('Order lifetime must be greater than zero.');
  }
  const expiration = blockTimestamp + lifetimeSeconds;
  assertUint256('expiration', expiration);
  return expiration;
}

export function generateOrderSalt(randomSource?: OrderSaltRandomSource) {
  const source =
    randomSource ??
    (globalThis as unknown as { crypto?: OrderSaltRandomSource }).crypto;
  if (!source) {
    throw new Error('A Web Crypto getRandomValues implementation is required.');
  }
  const bytes = new Uint8Array(32);
  source.getRandomValues(bytes);
  return bytesToBigInt(bytes);
}

export function buildCtfExchangeOrder({
  maker,
  tokenId,
  side,
  priceRaw,
  sizeRaw,
  salt = generateOrderSalt(),
  signer = maker,
  taker = zeroAddress,
  expiration = 0n,
  nonce = 0n,
  feeRateBps = 0n,
  signatureType = SignatureType.EOA,
}: BuildCtfExchangeOrderInput): CtfExchangeOrder {
  assertUint256('salt', salt);
  assertUint256('tokenId', tokenId);
  assertUint256('expiration', expiration);
  assertUint256('nonce', nonce);
  assertUint256('feeRateBps', feeRateBps);
  assertSignatureType(signatureType);
  const amounts = ctfExchangeOrderAmounts({ side, priceRaw, sizeRaw });

  return {
    salt,
    maker,
    signer,
    taker,
    tokenId,
    ...amounts,
    expiration,
    nonce,
    feeRateBps,
    side,
    signatureType,
    signature: '0x',
  };
}

export function getCtfExchangeOrderTypedData(order: CtfExchangeOrder) {
  const { signature: _signature, ...message } = order;
  return {
    domain: CTF_EXCHANGE_DOMAIN,
    types: CTF_EXCHANGE_ORDER_TYPES,
    primaryType: 'Order',
    message,
  } as const;
}

/** Return the full EIP-712 digest exposed by CTFExchange.getOrderHash. */
export function hashCtfExchangeOrder(order: CtfExchangeOrder) {
  return hashTypedData(getCtfExchangeOrderTypedData(order));
}

function boundWalletAddress(signer: CtfExchangeOrderSigner) {
  if (!('account' in signer) || !signer.account) return undefined;
  return typeof signer.account === 'string'
    ? signer.account
    : signer.account.address;
}

/** Sign an order through either a viem LocalAccount or a browser WalletClient. */
export async function signCtfExchangeOrder(
  signer: CtfExchangeOrderSigner,
  order: CtfExchangeOrder,
): Promise<CtfExchangeOrder> {
  const expectedSigner = isAddressEqual(order.signer, zeroAddress)
    ? order.maker
    : order.signer;
  const localAddress = 'address' in signer ? signer.address : undefined;
  const walletAddress = boundWalletAddress(signer);
  const selectedAddress = localAddress ?? walletAddress;
  if (selectedAddress && !isAddressEqual(selectedAddress, expectedSigner)) {
    throw new Error(
      `Signing account ${selectedAddress} does not match order signer ${expectedSigner}.`,
    );
  }

  const typedData = getCtfExchangeOrderTypedData(order);
  const signTypedData = signer.signTypedData as unknown as (
    parameters: typeof typedData & { account: Address },
  ) => Promise<Hex>;
  const signature = await signTypedData({
    ...typedData,
    account: expectedSigner,
  });

  if (
    order.signatureType === SignatureType.EOA ||
    order.signatureType === SignatureType.POLY_PROXY
  ) {
    const recovered = await recoverTypedDataAddress({
      ...typedData,
      signature,
    });
    if (!isAddressEqual(recovered, expectedSigner)) {
      throw new Error(
        `Order signature recovered ${recovered}, expected ${expectedSigner}.`,
      );
    }
  }

  return { ...order, signature };
}
