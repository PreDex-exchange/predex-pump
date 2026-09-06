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

// Redeployed 2026-09-06 with an authoritative global trading deadline.
export const ADDRESSES = {
  usdc: '0x3600000000000000000000000000000000000000',
  ctf: '0x8D80a47711752fc5665d0bDB6cf4745025Bf4B87',
  oracle: '0xfE6D5ad250f97381b4Ec66C81D9B6c215E205424',
  lmsr: '0xe0D94eE42B038e7db4E9CD7257467395fDC4a9F2',
  registry: '0xc9A65eBBdECfd2BDcD4a921B2a05061BFc1FE50c',
  miniClob: '0xCC7a8268f9F95d82f98e396C42b0562db758c7F5',
  ctfExchange: '0xF39198eBd60C8fd02b192ceE599478488e424b79',
  ctfExchangeOperator: '0xfE4cc0643199d15a0e284E61088d4c9495D506aF',
} as const;

// First block to index from (the registry/stack deployment block). From the broadcast
// receipt; the indexer replays from here forward.
export const DEPLOY_BLOCK = 60710296;

export type Address = `0x${string}`;
