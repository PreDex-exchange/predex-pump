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
  and closeout writes go through the connected wallet (MetaMask, or the
  optional Privy email wallet below) and wait for receipts.
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

## Optional Privy email wallet

MetaMask stays the primary wallet. Setting a public Privy App ID adds a
secondary **Continue with email** button that signs in with an email code and
uses the user's Privy embedded Ethereum wallet on Arc Testnet.

```dotenv
NEXT_PUBLIC_PRIVY_APP_ID=<public App ID from the Privy dashboard>
# Optional app client ID for per-environment settings
NEXT_PUBLIC_PRIVY_CLIENT_ID=
```

- Without `NEXT_PUBLIC_PRIVY_APP_ID` no Privy connector is registered, the SDK
  chunk is never loaded, and the MetaMask path is unchanged. The frontend never
  needs the Privy app secret.
- Privy dashboard settings: enable the **Email** login method, enable Ethereum
  embedded wallets, and add every frontend origin to the allowed domains. Use
  `https://` origins without trailing paths; plain HTTP is accepted only for
  localhost with an explicit port (for example `http://localhost:3000`). See
  [Privy allowed domains](https://docs.privy.io/recipes/dashboard/allowed-domains).
  Arc Testnet is supplied by the app as a custom chain from
  `lib/chain/arc.ts`; this integration is test-network only.
- Embedded wallets need a secure browser context (WebCrypto). A plain HTTP LAN
  origin such as `http://192.168.1.23:3000` cannot create or use the email
  wallet. See
  [Privy embedded wallet troubleshooting](https://docs.privy.io/basics/troubleshooting/troubleshooting-embedded-wallets).
- The SDK loads only after the email button is clicked, or when this browser
  previously connected the email wallet. Page load never opens a login or
  sign-in prompt, and an existing MetaMask session is never replaced.
- The embedded wallet's EIP-1193 provider is attached to a dedicated wagmi
  connector (`privyEmbedded`), so SIWE, EIP-712 order signatures, contract
  writes, receipt recovery, balances, and Gateway deposits use the existing
  code paths. Privy shows its own confirmation for signatures and transactions.
- Disconnecting the email wallet signs out of Privy and clears the backend
  session. Disconnecting MetaMask does not touch any Privy session. The app
  stores only a boolean choice marker in `localStorage`; Privy manages its own
  session storage.

### Manual real-SDK validation (not covered by automated tests)

Automated tests use a mocked Privy SDK and a fake EIP-1193 provider. Before
claiming live support, verify with the real App ID:

1. Fresh email: complete the email code login and confirm an embedded wallet
   address appears in the header.
2. Fund that address with Arc Testnet USDC (Arc gas is paid in USDC).
3. Run an existing Gateway deposit or bonding-curve trade and confirm the Arc
   receipt in the explorer.
4. Use a saved account feature to sign SIWE, and place a Hybrid order to sign
   the EIP-712 order.
5. Reload: the email wallet reconnects without a login or signature prompt.
   Disconnect, reload again: nothing reconnects and the backend session is gone.
6. MetaMask regression: connect, sign, trade, and disconnect MetaMask with the
   App ID set, including after an email-wallet session.
7. Repeat login, a transaction, and disconnect in a mobile browser loaded over
   an HTTPS origin that is listed in the Privy allowed domains.

Validation record (2026-09-13): the user reported that the manual wallet checks
discussed for this branch were tested on the pc63 preview, source ID
`267ff7dda752-597006748479`. This is user-reported manual evidence, not an
independently captured record: no transaction receipt hashes or mobile device
and browser details were supplied. Automated tests still mock the Privy SDK and
do not prove real vendor behavior. The preview was API-only, so it does not
imply a host cutover or fresh indexed trading data. Repeat the checklist above
after changes to the Privy SDK, App ID, allowed domains, chain config, or wallet
connectors.

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm build
```
