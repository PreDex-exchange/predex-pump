import assert from 'node:assert/strict';

import {
  createPublicClient,
  encodeAbiParameters,
  hashTypedData,
  http,
  keccak256,
  stringToHex,
} from 'viem';

import ctfExchangeAbi from '../../shared/abis/CTFExchange.json' with {
  type: 'json',
};

const chainId = 5_042_002;
const exchange = '0x1d9637E0398f31d18c6792b7639ca47FC9B9c403';
const rpcUrl = process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.io';
const expectedDeployedDomain =
  '0x794d47c61c37d2a6374205eeba03c2b2568704fb2dbc796ac017dbf611f7dbd0';

const domain = {
  name: 'Predex CTFExchange',
  version: '1',
  chainId,
  verifyingContract: exchange,
};
const types = {
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
};
const order = {
  salt: 42_424_242_424_242n,
  maker: '0x1111111111111111111111111111111111111111',
  signer: '0x1111111111111111111111111111111111111111',
  taker: '0x0000000000000000000000000000000000000000',
  tokenId: 12_345_678_901_234_567_890n,
  makerAmount: 1_425_003n,
  takerAmount: 2_500_001n,
  expiration: 1_900_000_000n,
  nonce: 7n,
  feeRateBps: 25n,
  side: 0,
  signatureType: 0,
  signature: '0x',
};

const domainTypeHash = keccak256(
  stringToHex(
    'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
  ),
);
const localDomain = keccak256(
  encodeAbiParameters(
    [
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'uint256' },
      { type: 'address' },
    ],
    [
      domainTypeHash,
      keccak256(stringToHex(domain.name)),
      keccak256(stringToHex(domain.version)),
      BigInt(domain.chainId),
      domain.verifyingContract,
    ],
  ),
);

const message = Object.fromEntries(
  Object.entries(order).filter(([key]) => key !== 'signature'),
);
const localOrderHash = hashTypedData({
  domain,
  types,
  primaryType: 'Order',
  message,
});

const client = createPublicClient({ transport: http(rpcUrl) });
const onchainDomain = await client.readContract({
  address: exchange,
  abi: ctfExchangeAbi,
  functionName: 'DOMAIN_SEPARATOR',
});
const onchainOrderHash = await client.readContract({
  address: exchange,
  abi: ctfExchangeAbi,
  functionName: 'getOrderHash',
  args: [order],
});

assert.equal(
  localDomain,
  expectedDeployedDomain,
  'local CTFExchange domain separator differs from the verified deployment value',
);
assert.equal(
  onchainDomain,
  expectedDeployedDomain,
  'RPC returned an unexpected CTFExchange domain separator',
);
assert.equal(
  localDomain,
  onchainDomain,
  'local CTFExchange domain separator does not match DOMAIN_SEPARATOR()',
);
assert.equal(
  localOrderHash,
  onchainOrderHash,
  'local EIP-712 order hash does not match getOrderHash(order)',
);

process.stdout.write(
  `${JSON.stringify(
    {
      rpcUrl,
      exchange,
      domainSeparator: {
        local: localDomain,
        onchain: onchainDomain,
        matches: true,
      },
      representativeOrder: Object.fromEntries(
        Object.entries(order).map(([key, value]) => [
          key,
          typeof value === 'bigint' ? value.toString() : value,
        ]),
      ),
      orderHash: {
        local: localOrderHash,
        onchain: onchainOrderHash,
        matches: true,
      },
    },
    null,
    2,
  )}\n`,
);
