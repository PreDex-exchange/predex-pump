// Arc testnet chain + the live incubator deployment.
// SOURCE OF TRUTH for both backend (indexer/RPC) and frontend (wallet/reads).
//
// ⚠️ Units: Arc USDC is BOTH the native gas token AND the 6-decimal ERC-20 collateral at
// `usdc` below. The native-18-decimal balance and the ERC-20-6-decimal balance are the SAME
// balance viewed at two precisions. All value movement in this app uses the 6-dec ERC-20
// interface (never native `msg.value`, never `address(this).balance`). USDC enforces a
// blocklist precompile, so USDC flows CANNOT be simulated locally — only against real Arc.

export const ARC = {
  chainId: 5042002,
  name: 'Arc Testnet',
  rpcUrls: [
    'https://rpc.testnet.arc.network',
    'https://rpc.testnet.arc.io',
    'https://rpc.drpc.testnet.arc.network',
  ],
  webSocketRpcUrls: [
    'wss://rpc.testnet.arc.network',
    'wss://rpc.testnet.arc.io',
    'wss://rpc.drpc.testnet.arc.network',
  ],
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
  contracts: {
    multicall3: {
      address: '0xcA11bde05977b3631167028862bE2a173976CA11',
    },
  },
  // The collateral is read/written as a 6-decimal ERC-20. 1_000_000 raw = 1 USDC.
  usdcErc20Decimals: 6,
} as const;

// Redeployed 2026-09-04 with coordinated MiniCLOB -> Hybrid cutover.
export const ADDRESSES = {
  usdc: '0x3600000000000000000000000000000000000000',
  ctf: '0x53222F4e8Dc81B02421B33F84A79f12de3bc240D',
  oracle: '0xf6a765fB79e31e62733EcAEbbED7d96d56386877',
  lmsr: '0x16Ec1d8962014e5F488C319C0d7388aDCa032321',
  registry: '0x5eb4f6320Cb52E3C8BdB146f1E5DD8B148af7f62',
  miniClob: '0xDf3DDD60f0dC36e9459473C7c9391251bB301d2f',
  ctfExchange: '0xd0f12fa586911163fB29bE06Ab15DD076Cc5650D',
  ctfExchangeOperator: '0xfE4cc0643199d15a0e284E61088d4c9495D506aF',
} as const;

// First block to index from (the registry/stack deployment block). From the broadcast
// receipt; the indexer replays from here forward.
export const DEPLOY_BLOCK = 60387670;

export type Address = `0x${string}`;
