import { ARC } from '@predex-pump/shared';
import { defineChain } from 'viem';

export const ARC_CHAIN = defineChain({
  id: ARC.chainId,
  name: ARC.name,
  nativeCurrency: ARC.nativeCurrency,
  rpcUrls: {
    default: {
      http: [...ARC.rpcUrls],
      webSocket: [...ARC.webSocketRpcUrls],
    },
  },
  contracts: ARC.contracts,
  testnet: true,
});
