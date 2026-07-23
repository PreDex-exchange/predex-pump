# @predex-pump/shared

The **interface contract** between the backend (indexer + API) and the frontend. Defining it
first lets Lane B (backend) and Lane C (frontend) build in parallel against one source of truth.

## What's here
- `src/addresses.ts` — Arc chain config + the live incubator deployment addresses + indexer start block.
- `src/domain.ts` — domain DTOs (Market, Trade, Order, Fill, Position, Resolution, Account, ActivityEvent) + the **units convention**.
- `src/rest.ts` — REST paths (`routes`) + request/response types.
- `src/ws.ts` — WebSocket channels + server-push event envelopes.
- `abis/` — contract ABIs (extracted from `predex-contract/out`), for the indexer and the frontend's write path.

## Units convention (non-negotiable)
Every on-chain integer that can exceed 2^53 is a **decimal string** of the raw integer, suffixed `Raw`.
- USDC + CTF sizes: **6-decimal** raw. `"1000000"` = 1 USDC / 1 token.
- Prices (LMSR + book): 6-dec raw, `"1000000"` = 1 USDC per whole token; a market's YES + NO price always sums to `"1000000"`.
- `tokenId` / `conditionId` / `questionId`: uint256 / bytes32 as a string.
- Timestamps: unix **seconds** (number).

## Contract truth vs. display
- The backend is a **non-custodial read model** — it holds no keys and custodies no funds. Everything authoritative lives on Arc.
- The frontend reads this API for **display/history**, but reads the **chain directly** for tx-critical state (allowances, quotes, resolution status) before signing, because the indexer can lag. `/health` exposes that lag.

## Consuming it
Both tiers import from `@predex-pump/shared` (TS source; the backend runs it via `tsx`, the frontend via Next `transpilePackages`). The Prisma schema in `backend/prisma/schema.prisma` mirrors these DTOs 1:1.
