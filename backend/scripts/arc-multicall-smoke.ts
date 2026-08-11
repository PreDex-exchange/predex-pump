import assert from 'node:assert/strict';

import { ADDRESSES, ARC } from '@predex-pump/shared';
import { ctfExchangeAbi } from '@predex-pump/shared/tx';
import { createPublicClient, http, zeroAddress } from 'viem';

import { ARC_CHAIN } from '../src/chain.js';

const rpcUrl = process.env.ARC_RPC_URL?.trim() || ARC.rpcUrls[0];
const multicall3Address = ARC_CHAIN.contracts?.multicall3?.address;

assert.equal(
  multicall3Address,
  ARC.contracts.multicall3.address,
  'configured Arc chain is missing the shared Multicall3 deployment',
);

const client = createPublicClient({
  chain: ARC_CHAIN,
  transport: http(rpcUrl, { retryCount: 0, timeout: 15_000 }),
});
const [zeroAddressMakerNonce] = await client.multicall({
  allowFailure: false,
  contracts: [
    {
      address: ADDRESSES.ctfExchange,
      abi: ctfExchangeAbi,
      functionName: 'makerNonce',
      args: [zeroAddress],
    },
  ],
});

assert.equal(
  typeof zeroAddressMakerNonce,
  'bigint',
  'Arc Multicall3 returned an unexpected maker nonce value',
);

process.stdout.write(
  `${JSON.stringify(
    {
      rpcUrl,
      chainId: ARC_CHAIN.id,
      multicall3Address,
      call: {
        target: ADDRESSES.ctfExchange,
        functionName: 'makerNonce',
        maker: zeroAddress,
        result: zeroAddressMakerNonce.toString(),
      },
      success: true,
    },
    null,
    2,
  )}\n`,
);
