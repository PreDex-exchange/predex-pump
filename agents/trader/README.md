# Predex trader agent

Headless market-making/trading loop for graduated Predex MiniCLOB markets. It reads the indexed
book and explainable truth signal, takes clearly mispriced resting YES orders, and maintains exact
configured YES BID/ASK quotes around fair value.

## Safety model

- Dry-run is the default. `pnpm start -- --once` does not construct a wallet or broadcast.
- Broadcast requires `pnpm start -- --send` or `PREDEX_DRY_RUN=false`. Only that branch reads
  `PREDEX_PRIVATE_KEY` from the process environment.
- Inventory per outcome, notional per action, open orders, and cumulative session notional are hard
  caps. An action is logged and refused when its exact configured size would cross one; it is never
  silently resized.
- Cumulative session spend is conservative: it counts paid truth reads plus the USDC notional of
  every successful place or fill, including token-side actions, and does not assume returned escrow
  can be re-spent.
- REST is decision data only. Immediately before every real place/fill, the executor re-reads the
  Arc registry lifecycle and token binding, CTF preparation and payout denominator, live order and
  `minimumFillRaw` where applicable, wallet balance, and approval. A non-graduated, paused,
  resolved, changed, closed, undersized, or insufficiently funded action is refused.
- Approvals are exact for the intended USDC amount; no unlimited ERC-20 approval is requested.
- Backend, signal, RPC, and action failures are logged per cycle/market and the loop continues.

## Market discovery modes

- `backend` (default) preserves the original backend-ordered opportunity loop.
- `graph-required` queries the hosted Predex subgraph and uses its ordered market IDs as
  the allow-list for every new fill or placement. The backend still enumerates every market
  and book for complete order/risk accounting, and Arc preflight remains authoritative.
- A Graph timeout, stale block (older than 90 seconds), indexing error, malformed response,
  or empty universe permits owned-order retirement but creates no new exposure. There is no
  fallback to backend discovery in this mode.

The Graph request timeout is fixed at ten seconds and the response is bounded to at most 20
markets. The endpoint URL is intentionally omitted from logs.

## Truth payment modes

- `auto` (default) calls `truth.buy` without a signer. It reads an unpaid dev endpoint, but if the
  endpoint requires payment it logs the unavailable buyer and skips that market.
- `free` calls the Stage 1 REST signal directly. Use it only with a backend whose seller mode is
  disabled.
- `paid` reads `PREDEX_TRUTH_PRIVATE_KEY` at runtime, signs a Circle Gateway EIP-3009 authorization,
  and refuses any price above `PREDEX_TRUTH_MAX_PAYMENT_RAW` before signing. This can spend Gateway
  USDC even while trading itself is dry-run, so it requires this separate explicit opt-in.
- `agentkit` uses that explicit truth key as the agent identity. It first signs the World AgentKit
  CAIP-122 challenge; an AgentBook-registered, human-backed agent receives the server trial.
  Unverified or exhausted agents fall through to the same bounded Circle payment. When
  `PREDEX_TRADER_ADDRESS` is set, it must match this signer. An unverified wallet is reported as
  unverified, never assumed to be a bot.
- `skip` performs no signal-dependent action. The market loop remains alive.

## Dry-run demo

```sh
PREDEX_API_URL=http://localhost:3001 \
PREDEX_MARKET_DISCOVERY=graph-required \
PREDEX_GRAPH_QUERY_URL=https://api.studio.thegraph.com/query/1758846/predex/0.0.1 \
PREDEX_GRAPH_MARKET_LIMIT=20 \
pnpm start -- --once
```

The Studio endpoint is limited to 3,000 daily queries. Use `--once` for evidence runs or a
poll interval of at least 30 seconds; the published Network endpoint replaces it later.

The package does not load dotenv files. Export variables in the runtime shell or inject them with a
secret manager. Never put a real private key in this repository.

## Operator-funded Circle proof

This cannot run in CI: it needs an EOA with Arc Testnet USDC and a funded Gateway balance. Run the
following only from an operator shell with the key supplied at runtime.

1. Start the paid seller (the seller address is public; no seller key is used):

```sh
cd /Users/ggattacker/Documents/predex/predex-pump-trader/backend
export PREDEX_TRUTH_SELLER_MODE=circle
export PREDEX_TRUTH_SELLER_ADDRESS="$OPERATOR_SELLER_ADDRESS"
export PREDEX_TRUTH_PRICE_RAW=100
export PREDEX_GATEWAY_FACILITATOR_URL=https://gateway-api-testnet.circle.com
pnpm start
```

2. In another shell, confirm the challenge contains Arc Testnet (`eip155:5042002`) and HTTP 402:

```sh
curl -i http://localhost:3001/truth/1
```

3. Deposit once and confirm the buyer's Gateway balance. `deposit("1")` is the one onchain step;
   individual reads remain gas-free and are batch-settled:

```sh
cd /Users/ggattacker/Documents/predex/predex-pump-trader/agent-sdk
export PREDEX_TRUTH_PRIVATE_KEY="$OPERATOR_RUNTIME_PRIVATE_KEY"
node --input-type=module <<'NODE'
import { GatewayClient, GATEWAY_DOMAINS } from '@circle-fin/x402-batching/client';

const privateKey = process.env.PREDEX_TRUTH_PRIVATE_KEY;
if (!privateKey) throw new Error('PREDEX_TRUTH_PRIVATE_KEY is required in this runtime shell');
const client = new GatewayClient({ chain: 'arcTestnet', privateKey });
console.log({ buyer: client.address, domain: GATEWAY_DOMAINS.arcTestnet });
const before = await client.getBalances();
console.log({ gatewayAvailableRawBefore: before.gateway.available.toString() });
if (before.gateway.available < 1_000_000n) {
  const deposit = await client.deposit('1');
  console.log({ depositTxHash: deposit.depositTxHash });
}
const after = await client.getBalances();
console.log({ gatewayAvailableRawAfter: after.gateway.available.toString() });
NODE
```

4. Run one trader scan. Trading stays dry-run, while `paid` explicitly authorizes the real
   sub-cent signal charges. The log shows `event=signal-payment`, then the fair-value decision and
   every planned/refused trade action:

```sh
cd /Users/ggattacker/Documents/predex/predex-pump-trader/agents/trader
export PREDEX_API_URL=http://localhost:3001
export PREDEX_DRY_RUN=true
export PREDEX_TRUTH_MODE=paid
export PREDEX_TRUTH_MAX_PAYMENT_RAW=100
export PREDEX_MAX_SESSION_SPEND_RAW=2000000
pnpm start -- --once
```

5. Re-run the balance snippet from step 3 (without depositing) or call `client.searchTransfers()`
   to verify the Gateway transfer/batch status. Do not put either runtime key variable in a file in
   this repository.
