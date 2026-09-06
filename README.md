# predex-pump

Standalone demo app for the predex on-chain prediction-market **incubator** on **Arc testnet**.
The smart contracts (incubator + MiniCLOB order book) live in the separate **`predex-contract`** repo.
This repo is the **application**: a non-custodial backend (indexer + API + WebSocket),
a Next.js web app, and a Flutter mobile shell.
Demo-only for the Encode x Arc "Programmable Money" hackathon; integrates with predex-sync/exchange later.

## Architecture (3 tiers)
```
Arc contracts (SETTLEMENT source of truth)  ⇄  backend (indexer + Postgres + REST/ws, non-custodial)
   incubator + MiniCLOB + Hybrid exchange         ⇅
                                             Next.js web app ⇄ Flutter mobile shell
                                             display comes from the backend; tx-critical reads and
                                             writes stay in the audited web wallet flow
```

## Structure
- **`backend/`** — TS indexer (viem watches Arc) → Prisma/Postgres → REST + WebSocket. Holds NO keys, custodies NO funds.
- **`frontend/`** — Next.js + wagmi/viem. Reads backend and uses MetaMask for transaction-critical chain access.
- **`mobile/`** — Secure Flutter WebView shell around the responsive frontend. It
  contains no wallet keys, ABI encoder, or JavaScript bridge.
- **`shared/`** — the API contract (types) + contract addresses/ABIs. The interface both sides build against (defined after the contracts are final).

## Arc testnet (chainId 5042002, RPC `https://rpc.testnet.arc.io`)
- USDC (6-dec collateral + native gas): `0x3600000000000000000000000000000000000000`
- Incubator, MiniCLOB, and Hybrid exchange addresses are pinned in `shared/src/addresses.ts`.
- Note: USDC flows can only be tested against real Arc (a blocklist precompile makes local simulation impossible).

## Plan
Eng-reviewed 3-tier plan: `~/.gstack/projects/predex-pump/ggattacker-predex-quant-fade-runner-eng-plan-20260723.md`

## CloudLab mobile build

```sh
./scripts/cloudlab/bootstrap-mobile.sh --accept-android-licenses
./scripts/cloudlab/sync.sh
./scripts/cloudlab/verify-mobile.sh
```

The automated gate creates a debug APK only. Release signing and the physical-phone
MetaMask roundtrip are separate release gates; no keystore is stored in this repository
or in verification evidence.

### Headless Android acceptance

CloudLab can run the Android shell and the official MetaMask app with KVM acceleration:

```sh
./scripts/cloudlab/bootstrap-mobile-emulator.sh --accept-android-licenses
./scripts/cloudlab/sync.sh
./scripts/cloudlab/verify.sh
./scripts/cloudlab/verify-mobile.sh
./scripts/cloudlab/runtime.sh install
./scripts/cloudlab/runtime.sh provision-operator
./scripts/cloudlab/runtime.sh up
./scripts/cloudlab/mobile-emulator.sh start
```

The emulator maps its loopback ports to CloudLab ports 3001 and 3002 with `adb reverse`,
so the standard debug APK uses `http://localhost:3002`, matching the persistent runtime's
CORS, SIWE, REST, and WebSocket hostname. Do not start the QA stack alongside this runtime.
`MOBILE_APP_URL` remains an explicit override for an isolated legacy QA stack that uses
`http://127.0.0.1:3002`; it is not the persistent-runtime acceptance path. The flow is:
connect MetaMask, add/switch to Arc Testnet, return through Android recents, explicitly
sign in, and confirm the account screen loads. Create a disposable wallet in MetaMask;
never send an existing recovery phrase or private key through ADB.

```sh
./scripts/cloudlab/mobile-emulator.sh status
./scripts/cloudlab/mobile-emulator.sh stop
```
