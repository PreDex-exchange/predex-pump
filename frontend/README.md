# predex-pump frontend

The frontend is a live Arc Next.js App Router app for the predex market
incubator. Indexed display data comes from the backend; signing-critical state
and every write stay on-chain.

## Run

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).
Run the backend separately on port 3001 before opening the app.

## Routes

- `/` — Feed
- `/market/:id` — Indexed market lifecycle, prices, positions, activity, and graduated book
- `/create` — Validated live Registry create flow
- `/portfolio` — Indexed CTF positions, estimated PnL, and Arc activity

## Data and chain boundaries

- `lib/api/rest-client.ts` implements every shared REST route. The existing
  display hooks in `lib/api/hooks.ts` use it for markets, market detail,
  accounts/positions/PnL, order books, activity, config, price history, and
  health.
- `lib/api/websocket.ts` multiplexes shared channel subscriptions and
  reconnects automatically. Global market/activity subscriptions stay mounted
  across routes; market, book, and account hooks subscribe only while their
  views are mounted.
- Confirmed writes are reflected by backend WebSocket events after indexing.
  The create flow seeds a short-lived optimistic detail so navigation does not
  wait on the indexer.
- Arc chain configuration, deployment addresses, and `DEPLOY_BLOCK` come from the shared source.
- LMSR quotes, USDC/CTF balances and approvals, graduation status,
  MiniCLOB order/minimum-fill state, payout state, and committee membership are
  re-read from Arc before signing.
- All create, trade, graduate, MiniCLOB, resolution, observation, redemption,
  and closeout writes go through MetaMask and wait for receipts.
- All collateral and CTF sizes use six-decimal raw integers. No flow sends native `value`.

## Backend URLs and LAN phones

The defaults require no frontend environment file:

```dotenv
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws
```

Copy `.env.example` to `.env.local` to override them. For a phone on the same
LAN, use the Mac's LAN address for both values, for example:

```dotenv
NEXT_PUBLIC_API_URL=http://192.168.1.23:3001
NEXT_PUBLIC_WS_URL=ws://192.168.1.23:3001/ws
```

The backend must listen on `0.0.0.0`, and the frontend dev server must also be
reachable on the LAN (for example, `pnpm dev --hostname 0.0.0.0`).

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm build
```
