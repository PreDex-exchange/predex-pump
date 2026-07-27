# Backend performance pass

## Scope and method

- Branch: `feat/backend-indexer`
- Baseline implementation: `ee13065` (benchmark tooling only; backend behavior from `eadf52b`)
- Optimized implementation: `4f7c675`
- Database: local PostgreSQL 17 in Docker, isolated `perf_bench` schema
- Runtime: Node v25.6.1, macOS 25.5.0, Intel i5-1038NG7, 8 logical CPUs
- REST workload: 20 warmups then 400 measured requests per scenario at concurrency 24
- Indexer workload: 10 committed synthetic `TradeState` events, each re-marking 100 positions
- WebSocket workload: 500 real socket clients, 5 subscribed to the published channel, 2,000
  publishes / 10,000 delivered messages
- Explicit targets: every REST scenario p95 < 100 ms; indexer >= 20 events/s; WebSocket
  publish p95 < 250 us

The load generator and Fastify server run in the same Node process. This makes the comparison
repeatable and deliberately exposes event-loop/serialization pressure, but absolute tail latency
is machine-specific. The reported AFTER values are the final complete run from `4f7c675`; no
smaller payloads or reduced concurrency were substituted for missed targets.

## Scale data

The deterministic default seed contains only synthetic rows:

| Entity | Rows |
| --- | ---: |
| Markets (evenly spread over all four phases) | 2,000 |
| Accounts | 20,000 |
| Trades | 200,000 |
| Positions | 100,000 |
| Orders | 50,000 |
| Fills | 25,000 |
| Price points | 200,000 |
| Activity events | 1,000,000 |

The hot market has 10,000 trades, 10,000 price points, 500 orders, and 50,000 activity events.
The dense account has 1,002 positions. This skew ensures the detail, book, history, portfolio,
cursor, and re-mark paths are exercised rather than measuring only uniform low-cardinality
lookups. `pnpm bench:seed` recreates only a schema named `perf_bench` or `perf_bench_*`;
`pnpm bench:teardown` removes it.

## REST before / after

Latency columns are `p50 / p95 / p99` in milliseconds. Throughput is completed requests/second.

| Scenario | BEFORE latency | BEFORE req/s | AFTER latency | AFTER req/s | p95 reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| `markets.list` | 195.11 / 333.32 / 338.75 | 116.6 | 136.56 / 350.09 / 523.06 | 145.7 | -5.0% |
| `markets.phase` | 185.92 / 268.45 / 346.56 | 131.9 | 122.10 / 166.15 / 189.31 | 184.0 | 38.1% |
| `markets.deep-keyset` | 154.18 / 253.06 / 268.94 | 144.8 | 91.74 / 164.77 / 169.36 | 229.7 | 34.9% |
| `market.detail` | 164.73 / 245.09 / 289.20 | 139.9 | 102.08 / 180.70 / 200.33 | 222.7 | 26.3% |
| `market.book` | 330.59 / 480.41 / 496.14 | 70.3 | 285.35 / 425.95 / 427.25 | 77.7 | 11.3% |
| `market.prices` | 691.77 / 892.61 / 896.48 | 34.7 | 327.97 / 404.43 / 441.06 | 72.4 | 54.7% |
| `orderbook.token` | 130.61 / 205.14 / 245.78 | 175.3 | 107.73 / 144.93 / 212.01 | 215.6 | 29.4% |
| `account.detail` | 2,437.12 / 3,424.41 / 3,436.65 | 9.7 | 330.19 / 465.81 / 481.20 | 72.6 | 86.4% |
| `activity.list` | 7,158.01 / 10,772.34 / 12,336.05 | 3.1 | 63.10 / 93.53 / 96.41 | 371.6 | 99.1% |
| `activity.market-deep-keyset` | 1,086.78 / 1,359.82 / 1,479.73 | 22.3 | 41.51 / 66.29 / 76.31 | 548.0 | 95.1% |
| `config` | 49.43 / 100.60 / 104.49 | 420.6 | 11.39 / 17.26 / 18.05 | 1,952.9 | 82.8% |
| `health` | 40.50 / 79.55 / 85.70 | 561.3 | 33.05 / 60.42 / 66.84 | 643.6 | 24.0% |

`markets.list` improved at p50 and throughput but its p95 regressed by 5.0% in the final run.
Its SQL plan is only 0.13 ms after optimization, so this tail is not a database scan; it is
event-loop/serialization contention for the fixed ~50 KB response on this four-core host.

## Indexer and WebSocket before / after

| Workload | BEFORE | AFTER | Result |
| --- | ---: | ---: | --- |
| Indexer ingest rate | 0.80 events/s | 22.55 events/s | 28.0x; target hit |
| Indexer duration (10 events) | 12,436.86 ms | 443.45 ms | 96.4% lower |
| WS publish p50 | 130.43 us | 154.11 us | regressed |
| WS publish p95 | 406.07 us | 378.26 us | 6.8% lower; target missed |
| WS publish p99 | 773.51 us | 641.99 us | 17.0% lower |
| WS publishes/s | 5,777.4 | 5,315.3 | regressed 8.0% |
| WS end-to-end duration | 400.80 ms | 467.68 ms | regressed |
| Non-target deliveries | 0 | 0 | correctness preserved |

The WebSocket wall-clock result is mixed and the 250 us p95 target was not reached. The dispatch
work is nevertheless bounded correctly: before, every publish invoked all 500 socket listeners
and 495 returned after checking their local set; after, the channel map invokes exactly the 5
matching listeners and serializes the update once. Local socket backpressure dominates this
microbenchmark after that change.

## Bottlenecks and corresponding changes

| Bottleneck evidence | Optimization | Representative SQL execution |
| --- | --- | ---: |
| Global activity used a parallel sequential scan over 1,000,000 rows plus top-N sort | `(blockNumber DESC, logIndex DESC)` index and narrow projection | 599.60 ms -> 0.11 ms |
| Market-filtered activity read/sorted 50,000 rows through the `(marketId, ts)` index | `(marketId, blockNumber DESC, logIndex DESC)` and tuple keyset seek | 72.97 ms -> 0.16 ms |
| Recent market trades sorted 10,000 rows because the index ended in `ts` | `(marketId, blockNumber DESC, logIndex DESC)` | 17.44 ms -> 0.12 ms |
| Recent account trades sorted 20,000 rows | `(account, blockNumber DESC, logIndex DESC)` | 27.45 ms -> 0.17 ms |
| Account positions joined/scanned Market and Resolution, then recalculated and summed every PnL value | Persisted Position marks plus maintained Account realized/unrealized totals; narrow position select | 14.96 ms -> 0.87 ms |
| Every price tick sequentially re-read and updated every market position (N+1) | One set-based SQL position update plus grouped Account rollup deltas; `(marketId, outcome, account)` index | 0.80 -> 22.55 events/s |
| Price history fetched unused inventory/hash fields and needed an incremental ordering step | Narrow three-column select and `(marketId, ts, blockNumber, logIndex)` index | 4.77 ms -> 1.59 ms |
| Market cursors used an OR predicate that scanned from the start of the index | Composite filter/sort indexes and tuple comparisons; no `OFFSET` anywhere | 2.16 ms -> 0.25 ms |
| `/config` queried two tables for every request | 5-second in-process TTL cache with concurrent miss coalescing | p95 100.60 ms -> 17.26 ms |
| Each WebSocket connection registered a global bus listener; projection queried DTOs even without subscribers | Per-channel listener sets, subscription-aware projection queries, one serialization per event | 500 -> 5 listener callbacks/publish |
| Prisma pool sizing was implicit | Explicit `connection_limit=32`, `pool_timeout=10`, both environment-configurable | bounded concurrency |

Market `tradeCount`, `volumeRaw`, and live price fields were already maintained by the indexer.
The read queries continue to use those fields; no request-time market aggregation was introduced.

## Targets

REST p95 below 100 ms was hit by:

- `activity.list` (93.53 ms)
- `activity.market-deep-keyset` (66.29 ms)
- `config` (17.26 ms)
- `health` (60.42 ms)

It was missed by both market-list variants, deep market pagination, market detail, book, price
history, token order book, and dense account detail. The remaining largest responses are fixed by
the shared contract: dense account is ~254 KB / 1,002 positions, market book is ~162 KB / 375 open
orders, and price history is ~126 KB / 2,000 points. Their post-optimization SQL plans are
0.3-1.6 ms, so further large gains require response caching, contract-level pagination/downsampling,
or more server CPU; this pass did not change response shapes.

The indexer target (>= 20 events/s) was hit at 22.55 events/s. The WebSocket target (< 250 us p95)
was missed at 378.26 us.

## Correctness and reproducibility

- Existing REST contract, derive, and ingest-to-WebSocket tests pass; the added rollup and
  channel-selectivity assertions also pass (17 tests total).
- `pnpm build` completes cleanly.
- The migration was separately applied with `prisma migrate deploy` to a disposable
  `perf_bench_migration` schema and `prisma migrate status` reported up to date.
- Dense-account rollups were checked against `SUM(Position.realizedPnlRaw)` and
  `SUM(Position.unrealizedPnlRaw)`; both matched.
- Response DTOs and shared contracts were not changed.
- The indexer idempotency guard and transaction boundary are unchanged; rollup changes occur in
  the same transaction as their source event.

Raw artifacts: `scale.json`, `baseline.json`, and `after.json` in this directory.
