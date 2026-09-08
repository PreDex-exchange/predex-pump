# Continuity — ETHOnline 2026

Continuity is entered in ETHOnline's Continuity track. The Arc prediction-market contracts,
backend/indexer, web interface, agent SDK, and original trader existed before the sponsor features
described here. This file makes the event work independently reviewable.

## Review boundary

- Public repository: <https://github.com/PreDex-exchange/predex-pump>
- World AgentKit feature baseline: `267ff7dda752` (`dev` before this feature branch)
- The Graph subgraph: `12712f4791b3`
- The Graph-backed trader decision path: `267ff7dda752`
- World AgentKit feature commit: recorded here after the feature is merged

## The Graph — load-bearing agent discovery

The custom Arc Testnet subgraph is deployed in Subgraph Studio at
<https://thegraph.com/studio/subgraph/predex>. Its live query endpoint selects and orders the
trader's opportunity universe. The backend still supplies complete books, balances, and order
maintenance state, and Arc remains authoritative immediately before a write. An unavailable,
stale, malformed, or unhealthy Graph response permits owned-order retirement but no new exposure.

With a seller-disabled local backend, reproduce one read-only decision cycle from `agents/trader`:

```sh
PREDEX_API_URL=http://localhost:3001 \
PREDEX_MARKET_DISCOVERY=graph-required \
PREDEX_GRAPH_QUERY_URL=https://api.studio.thegraph.com/query/1758846/predex/0.0.1 \
PREDEX_TRUTH_MODE=auto \
pnpm start -- --once
```

Subgraph Studio is intentionally sufficient for this track's live-provider requirement; network
publication is not part of the runtime dependency.

## World AgentKit — human-backed agent access

World AgentKit is not another browser login. It lets the paid truth API distinguish an agent that
is registered in AgentBook by a unique human from an unverified wallet or script. Absence of an
AgentBook registration means "unverified," not "bot."

The working policy is:

1. `/truth/:marketId` returns the existing Arc/Circle x402 challenge plus an AgentKit extension.
2. The trader signs that challenge with its explicitly configured truth-agent wallet.
3. The backend validates the AgentKit message and signature and resolves the wallet through the
   canonical World Chain AgentBook.
4. All wallets belonging to one anonymous human share three total free truth reads.
5. The fourth read, an unverified wallet, a replay, or any World dependency failure follows the
   unchanged Circle Gateway payment path.

Postgres atomically owns the hashed human quota and granted nonce records. Redis remains an
ephemeral read/broadcast accelerator and cannot grant access.

Register the same public address used by the agent through the official World flow; this command
does not need the private key:

```sh
npx @worldcoin/agentkit-cli@0.2.0 register 0xAGENT_ADDRESS
npx @worldcoin/agentkit-cli@0.2.0 status 0xAGENT_ADDRESS
```

Then run from `agents/trader`. `agentkit` is an explicit spending mode: after the human-backed
trial is exhausted, it may authorize Circle payments up to the configured cap.

```sh
PREDEX_API_URL=http://127.0.0.1:3001 \
PREDEX_MARKET_DISCOVERY=graph-required \
PREDEX_GRAPH_QUERY_URL=https://api.studio.thegraph.com/query/1758846/predex/0.0.1 \
PREDEX_TRUTH_MODE=agentkit \
PREDEX_TRUTH_MAX_PAYMENT_RAW=100 \
PREDEX_TRADER_ADDRESS=0xAGENT_ADDRESS \
PREDEX_TRUTH_PRIVATE_KEY=0xRUNTIME_ONLY \
pnpm start -- --once
```

Never commit a key. The final submission evidence will include the AgentBook status, three-free /
fourth-paid trace, exact source ID, and a two-to-four-minute demo video.

The disposable test agent's Circle Gateway fallback was funded with 1 testnet USDC in transaction
[`0x26bc…b73ce`](https://testnet.arcscan.app/tx/0x26bc5c9f15bf867d4a45a6220607ee46375f88fc409d48837c280a8bb47b73ce).

## Explicit non-goals

- The Graph does not replace the production backend, Redis market feed, either order book, or Arc
  transaction preflight.
- World login, Privy login, and MetaMask connection are separate user-authentication paths; none is
  treated as AgentBook proof.
- No generic chatbox, custom AgentBook relayer, World Chain payment migration, or self-hosted Graph
  node is added for sponsor optics.
