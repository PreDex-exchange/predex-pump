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
  testnet: true,
});

export const arcAddresses = ADDRESSES;
