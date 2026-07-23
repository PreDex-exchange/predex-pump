import { defineChain } from 'viem';

import { ADDRESSES, ARC } from '@/lib/shared/addresses';

export const arcTestnet = defineChain({
  id: ARC.chainId,
  name: ARC.name,
  nativeCurrency: ARC.nativeCurrency,
  rpcUrls: {
    default: {
      http: [...ARC.rpcUrls],
    },
  },
  contracts: {
    // Canonical Multicall3 deployment, verified on Arc testnet. Keeping this in the
    // frontend chain definition lets viem batch the per-market getter reads.
    multicall3: {
      address: '0xcA11bde05977b3631167028862bE2a173976CA11',
    },
  },
  testnet: true,
});

export const arcAddresses = ADDRESSES;
