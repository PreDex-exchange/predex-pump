# predex-pump frontend

Phase C1 is a mock-first Next.js App Router frontend for the predex market incubator.

## Run

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Routes

- `/` — Feed
- `/market/1` — Incubating market
- `/market/3` — Graduated market
- `/market/6` — Resolved market
- `/market/7` — Closed-out market
- `/create` — Create scaffold
- `/portfolio` — Portfolio scaffold

## Data and chain boundaries

- UI hooks live in `lib/api/hooks.ts`.
- `lib/api/client.ts` is the one-file switch point from the current mock client to a future REST client.
- Mock objects in `lib/mock/data.ts` satisfy the shared DTOs and retain raw 6-decimal values as strings.
- Arc chain configuration and live addresses come from the shared source.
- `lib/chain/useQuote.ts` demonstrates the ABI-backed critical-read pattern, but defaults to deterministic mock quotes.
- Create, LMSR trade, book order, and redeem actions stop at preview modals. No on-chain writes are sent in Phase C1.

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm build
```
