import assert from 'node:assert/strict';

import {
  createPublicClient,
  encodeAbiParameters,
  hashMessage,
  hashTypedData,
  http,
  keccak256,
} from 'viem';

const chainId = 5_042_002;
const oracle =
  process.env.ARC_ORACLE_ADDRESS ??
  '0xd246A354FD469023bfbA2DC5eCf4868Db034fC57';
const rpcUrl =
  process.env.ARC_RPC_URL ?? 'https://rpc.drpc.testnet.arc.network';
const questionId =
  process.env.ARC_SMOKE_QUESTION_ID ??
  '0xedf8a456092446db109cc0c8e48c1354253c938bb586e7b2924e6091584369ce';
const payouts = [1n, 0n];
const oracleAbi = [
  {
    type: 'function',
    name: 'domainSeparator',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'questionNonce',
    stateMutability: 'view',
    inputs: [{ name: 'questionId', type: 'bytes32' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'resolutionDigest',
    stateMutability: 'view',
    inputs: [
      { name: 'questionId', type: 'bytes32' },
      { name: 'payouts', type: 'uint256[]' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
];

const client = createPublicClient({ transport: http(rpcUrl) });
const [onchainDomain, nonce, onchainDigest] = await Promise.all([
  client.readContract({
    address: oracle,
    abi: oracleAbi,
    functionName: 'domainSeparator',
  }),
  client.readContract({
    address: oracle,
    abi: oracleAbi,
    functionName: 'questionNonce',
    args: [questionId],
  }),
  client.readContract({
    address: oracle,
    abi: oracleAbi,
    functionName: 'resolutionDigest',
    args: [questionId, payouts],
  }),
]);

const clientDomain = keccak256(
  encodeAbiParameters(
    [{ type: 'string' }, { type: 'uint256' }, { type: 'address' }],
    ['PredexCommitteeOracleV2', BigInt(chainId), oracle],
  ),
);
const innerDigest = keccak256(
  encodeAbiParameters(
    [
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'uint256[]' },
      { type: 'uint256' },
    ],
    [clientDomain, questionId, payouts, nonce],
  ),
);
const eip191Digest = hashMessage({ raw: innerDigest });

// This is the conventional EIP-712 schema requested by the C4 brief. It is
// deliberately computed alongside the deployed scheme so a contract/client
// mismatch cannot be mistaken for a successful smoke.
const eip712Domain = {
  name: 'PredexCommitteeOracleV2',
  version: '1',
  chainId,
  verifyingContract: oracle,
};
const eip712Types = {
  Resolution: [
    { name: 'questionId', type: 'bytes32' },
    { name: 'payouts', type: 'uint256[]' },
    { name: 'nonce', type: 'uint256' },
  ],
};
const eip712Digest = hashTypedData({
  domain: eip712Domain,
  types: eip712Types,
  primaryType: 'Resolution',
  message: { questionId, payouts, nonce },
});

assert.equal(clientDomain, onchainDomain, 'custom domain separator mismatch');
assert.equal(
  eip191Digest,
  onchainDigest,
  'deployed EIP-191 resolution digest mismatch',
);
assert.notEqual(
  eip712Digest,
  onchainDigest,
  'oracle unexpectedly changed to the conventional EIP-712 schema',
);

process.stdout.write(
  `${JSON.stringify(
    {
      sample: {
        questionId,
        payouts: payouts.map(String),
        nonce: String(nonce),
      },
      deployedScheme: {
        label: 'PredexCommitteeOracleV2',
        domainSeparator: clientDomain,
        clientDigest: eip191Digest,
        onchainDigest,
        matches: true,
      },
      requestedEip712Comparison: {
        domain: eip712Domain,
        types: eip712Types,
        digest: eip712Digest,
        onchainDigest,
        matches: eip712Digest === onchainDigest,
      },
    },
    null,
    2,
  )}\n`,
);
