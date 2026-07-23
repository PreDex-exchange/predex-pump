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
    'https://rpc.testnet.arc.io',
    'https://rpc.drpc.testnet.arc.io',
  ],
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
  // The collateral is read/written as a 6-decimal ERC-20. 1_000_000 raw = 1 USDC.
  usdcErc20Decimals: 6,
} as const;

// Redeployed 2026-07-23 WITH the graduated-book complete-set handoff (supersedes the
// 2026-07-23 deploy-spike set which lacked MiniCLOB + graduateAndSeedBook).
export const ADDRESSES = {
  usdc: '0x3600000000000000000000000000000000000000',
  ctf: '0xd6fcfDb350beaDd944E4eC93a788388d82EF2beb',
  oracle: '0x8E93440689B3EB393AC359335bEc23F4D2F940E5',
  lmsr: '0x48ecAe9E1Dc321f9a57970e9919eE3eb42A89ead',
  registry: '0x8aeB31722A77C866f9F32463B4383d7d3047FEE5',
  miniClob: '0x8eC37d407FEFfB0b3917c50ffee8FE39A085c22f',
} as const;

// First block to index from (the registry/stack deployment block). From the broadcast
// receipt; the indexer replays from here forward.
export const DEPLOY_BLOCK = 53263311;

export type Address = `0x${string}`;
