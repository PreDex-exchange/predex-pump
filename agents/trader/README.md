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
- Cumulative session spend is conservative: it counts the USDC notional of every successful place
  or fill, including token-side actions, and does not assume returned escrow can be re-spent.
- REST is decision data only. Immediately before every real place/fill, the executor re-reads the
  Arc registry lifecycle and token binding, CTF preparation and payout denominator, live order and
  `minimumFillRaw` where applicable, wallet balance, and approval. A non-graduated, paused,
  resolved, changed, closed, undersized, or insufficiently funded action is refused.
- Approvals are exact for the intended USDC amount; no unlimited ERC-20 approval is requested.
- Backend, signal, RPC, and action failures are logged per cycle/market and the loop continues.

## Dry-run demo

```sh
PREDEX_API_URL=http://localhost:3001 pnpm start -- --once
```

The package does not load dotenv files. Export variables in the runtime shell or inject them with a
secret manager. Never put a real private key in this repository.
