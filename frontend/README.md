# predex-pump frontend

Phase C3 is a live Arc Next.js App Router frontend for the predex market incubator.

## Run

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Routes

- `/` — Feed
- `/market/:id` — Live market lifecycle, prices, positions, activity, and graduated book
- `/create` — Validated live Registry create flow
- `/portfolio` — Direct CTF holdings and live Arc activity (redemption remains deferred)

## Data and chain boundaries

- UI hook interfaces remain in `lib/api/hooks.ts`; `lib/chain/client.ts` now implements them with
  chunked event scans and direct contract/multicall reads.
- Arc chain configuration, deployment addresses, and `DEPLOY_BLOCK` come from the shared source.
- Wallet writes are live for Registry create, LMSR buy/sell, and Registry graduation. Every flow
  refreshes transaction-critical state, obtains ERC-20/ERC-1155 approval when needed, and waits for
  receipts.
- All collateral and CTF sizes use six-decimal raw integers. No flow sends native `value`.
- MiniCLOB place/fill/cancel and committee resolve/redeem/closeout remain preview-only.
- Set `NEXT_PUBLIC_USE_MOCK_DATA=true` only for local visual development; live Arc is the default.

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm build
```
