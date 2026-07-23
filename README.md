# predex-pump

Standalone demo app for the predex on-chain prediction-market **incubator** on **Arc testnet**.
The smart contracts (incubator + MiniCLOB order book) live in the separate **`predex-contract`** repo.
This repo is the **application**: a non-custodial backend (indexer + API + WebSocket) and a Next.js frontend.
Demo-only for the Encode x Arc "Programmable Money" hackathon; integrates with predex-sync/exchange later.

## Architecture (3 tiers)
```
Arc contracts (SETTLEMENT source of truth)  ⇄  backend (indexer + Postgres + REST/ws, non-custodial)  ⇄  frontend
   incubator + MiniCLOB                          serves markets, account history, positions, PnL, order book, live
                                                 frontend reads backend for DISPLAY; reads chain directly for tx-critical
                                                 state (allowances/quotes/resolution); writes txs via wallet
```

## Structure (monorepo — backend and frontend build in parallel)
- **`backend/`** — TS indexer (viem watches Arc) → Prisma/Postgres → REST + WebSocket. Holds NO keys, custodies NO funds.
- **`frontend/`** — Next.js + wagmi/viem, injected wallet (+ Circle Wallets/Paymaster seam). Reads backend; writes chain.
- **`shared/`** — the API contract (types) + contract addresses/ABIs. The interface both sides build against (defined after the contracts are final).

## Arc testnet (chainId 5042002, RPC `https://rpc.testnet.arc.io`)
- USDC (6-dec collateral + native gas): `0x3600000000000000000000000000000000000000`
- Incubator + MiniCLOB addresses: TBD — re-deployed with the `graduateAndSeedBook` handoff (see plan). Live in `shared/addresses`.
- Note: USDC flows can only be tested against real Arc (a blocklist precompile makes local simulation impossible).

## Plan
Eng-reviewed 3-tier plan: `~/.gstack/projects/predex-pump/ggattacker-predex-quant-fade-runner-eng-plan-20260723.md`
