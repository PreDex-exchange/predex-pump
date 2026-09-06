# predex-pump backend

Non-custodial Arc read model: a TypeScript/viem indexer reads the deployed incubator's logs and
writes a replay-safe Postgres projection through Prisma. A Fastify serving layer exposes the
shared REST contract and a subscription WebSocket from the same process. That serving process
contains no wallet, private-key, or transaction-signing code. A separate optional operator
process signs Hybrid settlement and graduated-book migration transactions without taking custody
of user funds.

## Run locally

Requirements: Node 20+, pnpm, and Docker.

```sh
pnpm install
cp .env.example .env
docker compose up -d postgres qdrant redis
pnpm db:migrate
pnpm start
```

`pnpm start` runs the indexer, REST API, and WebSocket together:

- REST: `http://localhost:3001`
- WebSocket: `ws://localhost:3001/ws`
- Override the listener with `API_HOST` / `API_PORT`.
- CORS is open for local frontend development.

`pnpm dev` runs the same entrypoint under the `tsx` file watcher. Useful one-shot and inspection
commands:

```sh
pnpm indexer:once
pnpm summary
pnpm build
pnpm test
```

## Graduated-book operator

Apply database migrations before starting the operator, then inject `OPERATOR_PRIVATE_KEY` from a
runtime secret store. The key must belong to the configured CTFExchange operator address.

`OPERATOR_REGISTER_TOKENS=false` is the safe default. On Arc Testnet, set it to `true` only after
confirming that address still has CTFExchange `ADMIN_ROLE`. Registration activates direct
CTFExchange fills, so the operator first confirms the irreversible MiniCLOB cutover, snapshots and
signs the recovered inventory, obtains any required CTF approval, and only then registers the exact
YES/NO pair. Partial or mismatched registrations fail closed. Unknown cutover or registration
broadcasts are quarantined and observed again; neither is blindly resubmitted.

This state machine is not an in-place upgrade for existing `BookMigration` rows. Deploy it with
the new immutable Registry/MiniCLOB/LMSR addresses, set the matching deploy block, and rebuild the
disposable testnet projection from a clean database. Do not reuse rows from the earlier
seed-by-seed cancellation flow.

```sh
pnpm db:migrate
OPERATOR_REGISTER_TOKENS=true pnpm operator
```

This hot-admin arrangement is testnet-only. Before a real-value deployment, registration must move
to Registry-bound or narrowly scoped registrar authority, and the settlement signer must lose its
admin roles.

`DATABASE_URL` selects Postgres. `ARC_RPC_URL` selects the preferred Arc endpoint and defaults to
`ARC.rpcUrls[0]`; the other RPC URL from `shared` is an automatic read-only failover. The indexer
starts at shared `DEPLOY_BLOCK` (`60710296`), resumes at `IndexerState.lastBlock + 1`, and follows
the head. `SIGINT`/`SIGTERM` stop it after the current transactional range.

The Prisma pool is explicitly bounded by `DATABASE_POOL_SIZE` (default 32) with
`DATABASE_POOL_TIMEOUT_SECONDS` (default 10). Existing `connection_limit` / `pool_timeout` URL
parameters take precedence.

`REDIS_URL` selects the disposable read cache and invalidation bus. Local Compose binds Redis to
`127.0.0.1:6379`; its `/data` directory is a bounded, hardened tmpfs rather than a persistent
volume, persistence is disabled, and memory is capped at 128 MB with `volatile-lru` eviction.
Postgres and Arc remain authoritative, so restarting or flushing Redis must not lose durable
application state. Keep non-local Redis endpoints on a private network rather than publishing
port 6379.

`pnpm test` uses `TEST_DATABASE_URL`, defaulting to the isolated `contract_test` schema in the
local Compose Postgres. It applies the Prisma schema before running the REST contract and
ingest-to-WebSocket tests; it does not truncate the development schema.

## Performance benchmark

The benchmark always requires a schema named `perf_bench` or prefixed `perf_bench_`; it refuses
development/production schemas. The default deterministic synthetic scale is 2,000 markets,
20,000 accounts, 200,000 trades, 100,000 positions, 50,000 orders, 25,000 fills, 200,000 price
points, and 1,000,000 activity events.

```sh
pnpm bench:seed
pnpm bench:run --label=after --output=bench/results/after.json
pnpm bench:teardown
```

`bench:seed` drops and recreates only the selected benchmark schema. Every count can be overridden
with flags such as `--markets=200` or `--activity-events=100000`; `BENCH_DATABASE_URL` selects a
different safely named benchmark schema. Market 1 is a deliberately active migrated Hybrid hot
book; the runner refuses to time an ended or empty book. `bench:run` starts Fastify, Redis, and the
event bus in a dedicated child process, drives REST and WebSocket clients from the parent process,
emits JSON `EXPLAIN (ANALYZE, BUFFERS)` plans, and runs a transactional synthetic TradeState ingest
fixture. Its explicit targets are REST p95 below 100 ms, at least 20 indexed price ticks/sec when
each tick re-marks 100 positions, and WebSocket publish p95 below 250 µs with 500 clients. The
REST target applies to bounded interactive reads: 20 complete book orders per side, 500 price
points, and 100 account positions. Matching unbounded/2,000-point `.bulk` scenarios remain in the
result as informational capacity measurements and do not decide the interactive gate.

## Serving contract

Every route is declared in `shared/src/rest.ts`:

| Method | Path | Response |
| --- | --- | --- |
| GET | `/markets` | Keyset-paginated markets (`phase`, `creator`, `limit`, `cursor`) |
| GET | `/markets/:id` | Market, recent trades, resolution |
| GET | `/markets/:id/book` | YES and NO books (`orderLimitPerSide` optionally bounds complete order DTOs, not aggregate levels) |
| GET | `/markets/:id/prices` | Indexed price curve (`fromTs`, `limit`) |
| GET | `/truth/:marketId` | Explainable indexed fair value; x402-protected when seller mode is `circle` |
| GET | `/orderbook/:tokenId` | One token's aggregated ladder and optionally bounded complete orders (`orderLimitPerSide`) |
| GET | `/accounts/:addr` | Account, positions (`marketId`, `positionsLimit`, `positionsCursor`), recent trades, aggregate PnL |
| GET | `/activity` | Keyset-paginated activity (`marketId`, `account`, `limit`, `cursor`) |
| GET | `/config` | Registry params, addresses, trading-window bounds, committee |
| GET | `/health` | Indexed block, Arc head, and lag |

The truth seller is gated separately so local Stage 1 development remains available. With
`PREDEX_TRUTH_SELLER_MODE=disabled` (default), `/truth/:marketId` is unpaid. With `circle`, set the
public `PREDEX_TRUTH_SELLER_ADDRESS`; unpaid requests receive 402 plus `PAYMENT-REQUIRED`, and paid
requests are submitted through Circle Gateway's batched `settle` API. The backend keeps no payment
ledger and never needs a wallet key. `PREDEX_TRUTH_PRICE_RAW` defaults to 100 ($0.0001) and must
remain strictly below one cent.

WebSocket clients send:

```json
{"type":"subscribe","channels":["markets","market:1","book:1","account:0x...","activity"]}
```

`unsubscribe` uses the same envelope. The server acknowledges the current channel set, then sends
the `ServerMessage` envelope from `shared/src/ws.ts` for `market.created`, `market.updated`,
`market.graduated`, `price.tick`, `trade`, order placement/fill/cancellation, `book.seeded`,
`position.updated`, `resolution`, and activity events. Indexer notifications are published only
after their database transaction commits.

For an explicit idempotency audit, replay an already indexed range without rewinding the durable
cursor:

```sh
pnpm indexer --once --replay-from=60710296
```

## Correctness model

- All logs from the registry, LMSR, MiniCLOB, CTF, and oracle addresses are decoded with the
  checked-in ABIs and persisted to `ActivityEvent`.
- `(txHash, logIndex)` is the ledger key for `ActivityEvent`, `Trade`, `Fill`, and `PricePoint`.
  Natural keys are used for `Market`, `Order`, `Position`, `Resolution`, and config entities.
- A range's derived writes and cursor advance share one serializable database transaction.
  Replaying a log that already has an `ActivityEvent` is a no-op.
- A pre-discovery pass records market/token bindings before chronological deltas are applied. This
  handles CTF transfers emitted by an inner contract call before the registry emits its outer
  binding events in the same transaction.
- The cursor never moves backwards, refuses to start ahead of the chain head, and is guarded
  against a different chain/deployment being mixed into the same database.
- The process only performs RPC reads and database writes. It has no wallet or private-key code.

## Event projection

| Source event | Projection |
| --- | --- |
| Registry `MarketCreated` | `Market`, creator `Account`, decoded UTF-8 question |
| Registry `MarketParameterSnapshot` | Immutable market economics/trading-window snapshot |
| Registry `MarketTokenBinding` / `MarketGraduationBinding` | Collateral and YES/NO token binding |
| LMSR `TradeExecuted` | Exact `Trade` economics, market/account rollups, estimated basis/PnL |
| LMSR `TradeState` | Market inventory/funding, LMSR marginal prices, `PricePoint` |
| Registry `MarketGraduated` | Graduated phase/timestamp/activity |
| Registry `MarketGraduationBookSeeded` / MiniCLOB `GraduationSeeded` | Book address, frozen price, handoff size, seed order linkage |
| MiniCLOB `OrderPlaced` | Natural-keyed `Order`, including escrow and seed status |
| MiniCLOB `OrderFilled` | `Fill`, order state, book-venue `Trade`, rollups |
| MiniCLOB `OrderCancelled` | Closed order and final remaining size |
| Oracle `QuestionResolved` / CTF `ConditionResolution` | Resolution outcome, payouts, denominator |
| LMSR / Registry resolution-observed events | Observed timestamp and `ResolvedObserved` phase |
| LMSR `MarketCloseout` / Registry `MarketClosedOut` | `Closeout` economics and `ClosedOut` phase |
| CTF `TransferSingle` / `TransferBatch` | Authoritative natural-keyed position quantities |
| CTF `PayoutRedemption` | Redemption activity (burn transfers remain quantity authority) |
| Oracle membership/threshold events | Active `CommitteeMember` set and threshold |
| Registry default/version events | `RegistryConfig` and `RegisteredMarketType` |
| Every decoded ABI event | Raw, JSON-safe `ActivityEvent` timeline row |

Cost basis and realized/unrealized PnL are explicitly marked `costBasisEstimated=true`; CTF
transfers remain the authority for quantity.

## Layout

```text
backend/
├── prisma/
│   ├── migrations/
│   └── schema.prisma
├── src/
│   ├── indexer/
│   │   ├── abis.ts
│   │   ├── derive.ts
│   │   ├── handlers.ts
│   │   ├── runner.ts
│   │   └── types.ts
│   ├── api/
│   │   ├── dto.ts
│   │   ├── input.ts
│   │   ├── queries.ts
│   │   ├── routes.ts
│   │   ├── server.ts
│   │   └── websocket.ts
│   ├── events/
│   │   ├── bus.ts
│   │   └── projector.ts
│   ├── config.ts
│   ├── db.ts
│   ├── indexer.ts
│   ├── start.ts
│   └── summary.ts
├── tests/
├── docker-compose.yml
└── package.json
```
