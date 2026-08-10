import { describe, expect, it, vi } from 'vitest';
import {
  concatHex,
  createWalletClient,
  custom,
  encodeAbiParameters,
  isAddressEqual,
  keccak256,
  recoverTypedDataAddress,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import {
  buildCtfExchangeOrder,
  CTF_EXCHANGE_DOMAIN,
  CTF_EXCHANGE_ORDER_TYPE_HASH,
  CTF_EXCHANGE_ORDER_TYPE_STRING,
  CTF_EXCHANGE_ORDER_TYPES,
  ctfExchangeOrderAmounts,
  ctfExchangeCollateralAmountForFill,
  ctfExchangeOrderFromWire,
  ctfExchangeMakerAmountForFill,
  ctfExchangeOrderTerms,
  ctfExchangeOrderToWire,
  ctfExchangeTakerAmountForFill,
  generateOrderSalt,
  getCtfExchangeOrderTypedData,
  hashCtfExchangeOrder,
  orderExpirationFromTimestamp,
  Side,
  SignatureType,
  signCtfExchangeOrder,
} from '../src/tx';

const CONTRACT_ORDER_TYPE =
  'Order(uint256 salt,address maker,address signer,address taker,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint256 nonce,uint256 feeRateBps,uint8 side,uint8 signatureType)';
const CONTRACT_ORDER_TYPE_HASH =
  '0xa852566c4e14d00869b6db0220888a9090a13eccdaea03713ff0a3d27bf9767c';
const DEPLOYED_DOMAIN_SEPARATOR =
  '0x794d47c61c37d2a6374205eeba03c2b2568704fb2dbc796ac017dbf611f7dbd0';
const ONCHAIN_SMOKE_ORDER_HASH =
  '0xdb5274adec5c1c9ace13c66825e61a3f266b6a7ea9d693d2025df3315c9972cf';

function buildSigningOrder(maker: `0x${string}`) {
  return buildCtfExchangeOrder({
    salt: 123n,
    maker,
    tokenId: 456n,
    side: Side.BUY,
    priceRaw: 625_000n,
    sizeRaw: 2_000_000n,
    expiration: 1_900_000_000n,
    nonce: 4n,
    feeRateBps: 20n,
  });
}

async function expectSignatureRecovers(
  order: ReturnType<typeof buildSigningOrder>,
) {
  const recovered = await recoverTypedDataAddress({
    ...getCtfExchangeOrderTypedData(order),
    signature: order.signature,
  });
  expect(isAddressEqual(recovered, order.signer)).toBe(true);
}

function onchainDerivedOrderHash(
  order: ReturnType<typeof buildSigningOrder>,
) {
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint8' },
        { type: 'uint8' },
      ],
      [
        CONTRACT_ORDER_TYPE_HASH,
        order.salt,
        order.maker,
        order.signer,
        order.taker,
        order.tokenId,
        order.makerAmount,
        order.takerAmount,
        order.expiration,
        order.nonce,
        order.feeRateBps,
        order.side,
        order.signatureType,
      ],
    ),
  );
  return keccak256(
    concatHex(['0x1901', DEPLOYED_DOMAIN_SEPARATOR, structHash]),
  );
}

describe('CTFExchange EIP-712 order schema', () => {
  it('matches Hashing.sol ORDER_TYPE_HASH byte-for-byte', () => {
    expect(CTF_EXCHANGE_ORDER_TYPE_STRING).toBe(CONTRACT_ORDER_TYPE);
    expect(CTF_EXCHANGE_ORDER_TYPE_HASH).toBe(CONTRACT_ORDER_TYPE_HASH);
    expect(
      CTF_EXCHANGE_ORDER_TYPES.Order.map(
        ({ name, type }) => `${type} ${name}`,
      ),
    ).toEqual([
      'uint256 salt',
      'address maker',
      'address signer',
      'address taker',
      'uint256 tokenId',
      'uint256 makerAmount',
      'uint256 takerAmount',
      'uint256 expiration',
      'uint256 nonce',
      'uint256 feeRateBps',
      'uint8 side',
      'uint8 signatureType',
    ]);
  });

  it('uses the deployed domain and excludes signature from the message', () => {
    const order = buildSigningOrder(
      '0x1111111111111111111111111111111111111111',
    );
    const typedData = getCtfExchangeOrderTypedData({
      ...order,
      signature: '0x1234',
    });

    expect(typedData.domain).toEqual({
      name: 'Predex CTFExchange',
      version: '1',
      chainId: 5_042_002,
      verifyingContract: '0x1d9637E0398f31d18c6792b7639ca47FC9B9c403',
    });
    expect(typedData.domain).toBe(CTF_EXCHANGE_DOMAIN);
    expect(typedData.message).not.toHaveProperty('signature');
  });
});

describe('CTFExchange order construction', () => {
  it('maps exact BUY and SELL notionals to the contract-side ratio', () => {
    expect(
      ctfExchangeOrderAmounts({
        side: Side.BUY,
        priceRaw: 600_000n,
        sizeRaw: 2_500_000n,
      }),
    ).toEqual({ makerAmount: 1_500_000n, takerAmount: 2_500_000n });
    expect(
      ctfExchangeOrderAmounts({
        side: Side.SELL,
        priceRaw: 600_000n,
        sizeRaw: 2_500_000n,
      }),
    ).toEqual({ makerAmount: 2_500_000n, takerAmount: 1_500_000n });
  });

  it('rounds BUY down and SELL up at a six-decimal collateral edge', () => {
    // 570001 * 2500001 / 1e6 = 1425003.070001 raw collateral.
    expect(
      ctfExchangeOrderAmounts({
        side: Side.BUY,
        priceRaw: 570_001n,
        sizeRaw: 2_500_001n,
      }),
    ).toEqual({ makerAmount: 1_425_003n, takerAmount: 2_500_001n });
    expect(
      ctfExchangeOrderAmounts({
        side: Side.SELL,
        priceRaw: 570_001n,
        sizeRaw: 2_500_001n,
      }),
    ).toEqual({ makerAmount: 2_500_001n, takerAmount: 1_425_004n });
  });

  it('normalizes stored ratios and partial-fill maker obligations', () => {
    const buy = buildCtfExchangeOrder({
      salt: 1n,
      maker: '0x1111111111111111111111111111111111111111',
      tokenId: 1n,
      side: Side.BUY,
      priceRaw: 600_000n,
      sizeRaw: 2_500_000n,
    });
    const sell = buildCtfExchangeOrder({
      salt: 2n,
      maker: '0x1111111111111111111111111111111111111111',
      tokenId: 1n,
      side: Side.SELL,
      priceRaw: 600_000n,
      sizeRaw: 2_500_000n,
    });
    expect(ctfExchangeOrderTerms(buy)).toEqual({
      priceRaw: 600_000n,
      sizeRaw: 2_500_000n,
    });
    expect(ctfExchangeOrderTerms(sell)).toEqual({
      priceRaw: 600_000n,
      sizeRaw: 2_500_000n,
    });
    expect(ctfExchangeMakerAmountForFill(buy, 500_000n)).toBe(300_000n);
    expect(ctfExchangeMakerAmountForFill(sell, 500_000n)).toBe(500_000n);
    expect(ctfExchangeTakerAmountForFill(buy, 500_000n)).toBe(500_000n);
    expect(ctfExchangeTakerAmountForFill(sell, 500_000n)).toBe(300_000n);
    expect(ctfExchangeCollateralAmountForFill(buy, 500_000n)).toBe(300_000n);
    expect(ctfExchangeCollateralAmountForFill(sell, 500_000n)).toBe(300_000n);
  });

  it('rejects a BUY notional that only rounding up could represent', () => {
    expect(() =>
      ctfExchangeOrderAmounts({
        side: Side.BUY,
        priceRaw: 1n,
        sizeRaw: 1n,
      }),
    ).toThrow(/cannot be represented without exceeding its limit price/u);
  });

  it('generates a full-width salt and a block-relative expiration', () => {
    const salt = generateOrderSalt({
      getRandomValues(bytes) {
        bytes.fill(0xff);
        return bytes;
      },
    });

    expect(salt).toBe((1n << 256n) - 1n);
    expect(orderExpirationFromTimestamp(1_800_000_000n, 3_600n)).toBe(
      1_800_003_600n,
    );
  });

  it('builds the representative order whose digest the RPC smoke verifies', () => {
    const order = buildCtfExchangeOrder({
      salt: 42_424_242_424_242n,
      maker: '0x1111111111111111111111111111111111111111',
      tokenId: 12_345_678_901_234_567_890n,
      side: Side.BUY,
      priceRaw: 570_001n,
      sizeRaw: 2_500_001n,
      expiration: 1_900_000_000n,
      nonce: 7n,
      feeRateBps: 25n,
      signatureType: SignatureType.EOA,
    });

    expect(hashCtfExchangeOrder(order)).toBe(ONCHAIN_SMOKE_ORDER_HASH);
    expect(
      hashCtfExchangeOrder({ ...order, signature: '0xdeadbeef' }),
    ).toBe(ONCHAIN_SMOKE_ORDER_HASH);
    expect(ctfExchangeOrderFromWire(ctfExchangeOrderToWire(order))).toEqual(
      order,
    );
  });
});

describe('CTFExchange order signing', () => {
  it('signs with a node LocalAccount and recovers the generated signer', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const unsigned = buildSigningOrder(account.address);
    const contractDerivedDigest = onchainDerivedOrderHash(unsigned);

    const signed = await signCtfExchangeOrder(account, unsigned);

    expect(signed.signature).not.toBe('0x');
    expect(hashCtfExchangeOrder(signed)).toBe(contractDerivedDigest);
    await expectSignatureRecovers(signed);
  });

  it('signs through a browser-style JSON-RPC WalletClient', async () => {
    const throwawayAccount = privateKeyToAccount(generatePrivateKey());
    const unsigned = buildSigningOrder(throwawayAccount.address);
    const typedData = getCtfExchangeOrderTypedData(unsigned);
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method !== 'eth_signTypedData_v4') {
        throw new Error(`Unexpected wallet method: ${method}`);
      }
      return throwawayAccount.signTypedData(typedData);
    });
    const walletClient = createWalletClient({
      account: throwawayAccount.address,
      transport: custom({ request }),
    });

    const signed = await signCtfExchangeOrder(walletClient, unsigned);

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      method: 'eth_signTypedData_v4',
    });
    await expectSignatureRecovers(signed);
  });
});
