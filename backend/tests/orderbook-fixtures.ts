import type {
  IngestOrderRequest,
  SignedCtfExchangeOrder,
} from '@predex-pump/shared';
import {
  Side,
  buildCtfExchangeOrder,
  hashCtfExchangeOrder,
  signCtfExchangeOrder,
  type CtfExchangeOrder,
} from '@predex-pump/shared/tx';
import { zeroAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import type {
  FreshOrderChainState,
  OrderChainReader,
} from '../src/orderbook/chain-reader.js';
import { MARKET_ONE_CONDITION } from './fixtures.js';

export const BOOK_NOW = 1_800_000_000;

export function throwawayAccount() {
  return privateKeyToAccount(generatePrivateKey());
}

export function orderWire(order: CtfExchangeOrder): SignedCtfExchangeOrder {
  return {
    saltRaw: order.salt.toString(),
    maker: order.maker,
    signer: order.signer,
    taker: order.taker,
    tokenId: order.tokenId.toString(),
    makerAmountRaw: order.makerAmount.toString(),
    takerAmountRaw: order.takerAmount.toString(),
    expiration: Number(order.expiration),
    nonceRaw: order.nonce.toString(),
    feeRateBpsRaw: order.feeRateBps.toString(),
    side: order.side,
    signatureType: order.signatureType,
    signature: order.signature,
  };
}

export async function signedOrderRequest(input: {
  account?: ReturnType<typeof throwawayAccount>;
  maker?: `0x${string}`;
  signerAccount?: ReturnType<typeof throwawayAccount>;
  tokenId?: bigint;
  side?: 0 | 1;
  priceRaw?: bigint;
  sizeRaw?: bigint;
  expiration?: bigint;
  nonce?: bigint;
  salt?: bigint;
} = {}): Promise<{
  request: IngestOrderRequest;
  order: CtfExchangeOrder;
  account: ReturnType<typeof throwawayAccount>;
}> {
  const account = input.account ?? throwawayAccount();
  const signerAccount = input.signerAccount ?? account;
  const order = buildCtfExchangeOrder({
    maker: input.maker ?? account.address,
    signer: signerAccount.address,
    taker: zeroAddress,
    tokenId: input.tokenId ?? 101n,
    side: input.side ?? Side.SELL,
    priceRaw: input.priceRaw ?? 650_000n,
    sizeRaw: input.sizeRaw ?? 1_000_000n,
    expiration: input.expiration ?? BigInt(BOOK_NOW + 3_600),
    nonce: input.nonce ?? 7n,
    salt: input.salt ?? BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 1_000_000)),
  });
  const signed = await signCtfExchangeOrder(signerAccount, order);
  return {
    request: {
      orderHash: hashCtfExchangeOrder(signed),
      order: orderWire(signed),
    },
    order: signed,
    account,
  };
}

export function validChainState(
  overrides: Partial<FreshOrderChainState> = {},
): FreshOrderChainState {
  return {
    blockNumber: 123,
    blockTimestamp: BigInt(BOOK_NOW),
    makerNonce: 7n,
    complementTokenId: 102n,
    registeredConditionId: MARKET_ONE_CONDITION as Hex,
    payoutDenominator: 0n,
    makerAssetBalance: 10_000_000n,
    approvalKind: 'CTF_APPROVAL_FOR_ALL',
    collateralAllowance: null,
    ctfApprovedForAll: true,
    ...overrides,
  };
}

export class FakeOrderChainReader implements OrderChainReader {
  state = validChainState();
  calls = 0;

  async readOrderState(): Promise<FreshOrderChainState> {
    this.calls += 1;
    return this.state;
  }
}
