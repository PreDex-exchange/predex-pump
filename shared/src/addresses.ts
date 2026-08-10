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
    'https://rpc.drpc.testnet.arc.network',
  ],
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
  // The collateral is read/written as a 6-decimal ERC-20. 1_000_000 raw = 1 USDC.
  usdcErc20Decimals: 6,
} as const;

// Redeployed 2026-07-23 WITH the graduated-book complete-set handoff (supersedes the
// 2026-07-23 deploy-spike set which lacked MiniCLOB + graduateAndSeedBook).
export const ADDRESSES = {
  usdc: '0x3600000000000000000000000000000000000000',
  ctf: '0x4021798fEcE71F31564251c2D1A9A7467ada7ae7',
  oracle: '0xd246A354FD469023bfbA2DC5eCf4868Db034fC57',
  lmsr: '0x33a45f0d31cE4E9bD877c4BBf632df7c5DCeD566',
  registry: '0x15EE004A3CfD9508EA0b47323762C1780A610Ed3',
  miniClob: '0xA4f4e20bB706B38C7BbFeB923b63c2d427C9f7a3',
  ctfExchange: '0x1d9637E0398f31d18c6792b7639ca47FC9B9c403',
} as const;

// First block to index from (the registry/stack deployment block). From the broadcast
// receipt; the indexer replays from here forward.
export const DEPLOY_BLOCK = 53405070;

export type Address = `0x${string}`;
