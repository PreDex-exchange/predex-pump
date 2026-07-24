# predex-pump backend indexer

Non-custodial Arc read model: a TypeScript/viem indexer reads the deployed incubator's logs and
writes a replay-safe Postgres projection through Prisma. This phase intentionally has no REST or
WebSocket server.

## Run locally

Requirements: Node 20+, pnpm, and Docker.

```sh
pnpm install
cp .env.example .env
pnpm db:up
pnpm db:migrate
pnpm indexer
```

Useful one-shot and inspection commands:

```sh
pnpm indexer:once
pnpm summary
pnpm build
pnpm test
```

`DATABASE_URL` selects Postgres. `ARC_RPC_URL` selects the preferred Arc endpoint and defaults to
`ARC.rpcUrls[0]`; the other RPC URL from `shared` is an automatic read-only failover. The indexer
starts at shared `DEPLOY_BLOCK` (`53405070`), resumes at `IndexerState.lastBlock + 1`, and follows
the head. `SIGINT`/`SIGTERM` stop it after the current transactional range.

For an explicit idempotency audit, replay an already indexed range without rewinding the durable
cursor:

```sh
pnpm indexer --once --replay-from=53405070
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
│   ├── config.ts
│   ├── db.ts
│   ├── indexer.ts
│   └── summary.ts
├── tests/
├── docker-compose.yml
└── package.json
```
