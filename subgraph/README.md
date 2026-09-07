# Predex Arc Testnet subgraph

This subgraph is the live onchain discovery and execution-history source for the
Continuity trader agent. It indexes four fixed Arc Testnet contracts from block
`60710296`:

- IncubatorRegistry for market identity and lifecycle
- IncubatorLMSR for bootstrap trades
- MiniCLOB for historical onchain book fills
- CTFExchange for settled Hybrid fills

It deliberately does not model the live MiniCLOB or Hybrid orderbook. Signed Hybrid
orders are offchain, and both books remain authoritative only through the Predex
REST/WebSocket backend. The agent must hydrate Graph-selected market IDs through that
backend and use fresh Arc reads before signing.

## Build

Run on the CloudLab verification host:

```sh
pnpm install --frozen-lockfile
pnpm run codegen
pnpm test
pnpm run build
```

The pinned Matchstick `0.6.0` binary expects AssemblyScript `0.19.23` at the
package root and the host `libpq5` runtime. Graph CLI still compiles production
mappings against the `0.27.31` compiler pinned transitively by graph-ts.

## Deploy to Studio

The Studio slug is `predex`, the manifest network is `arc-testnet`, and the first
version label is `0.0.1`. Use `scripts/cloudlab/deploy-subgraph.sh` from the repository
root so the deploy key is streamed from the local credential file and never copied
into source or left in the remote home directory.

Deployment to Studio is a staging action. Publishing to the decentralized Graph
Network is a separate, later release gate.

### Current Studio deployment

- Slug/version: `predex/0.0.1`
- Deployment ID: `QmVqHgw6TpXJQZ248cT5zeAPRLR5mku5KfgqXLzdHnE9rq`
- Query URL: `https://api.studio.thegraph.com/query/1758846/predex/0.0.1`
- Source verification ID: `f48df0bdc310-edc2bd4ea6d0`

The Upgrade Indexer reported this deployment as synced and healthy on
2026-09-07. This version is staged in Studio and has not been published.

## Query

`queries/agent-market-universe.graphql` is the bounded query the trader integration
will consume. Every response includes `_meta.block` and `hasIndexingErrors`; the agent
must fail closed for new exposure when the data is stale or unhealthy.
