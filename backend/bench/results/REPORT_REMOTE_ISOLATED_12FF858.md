# Backend performance rerun: remote, idle, process-isolated

Date: 2026-07-31

## Result

The clean run completed at the original scale and workload. The API/event-bus process and the
HTTP/WebSocket load-generator process ran on disjoint physical CPU sets. Nine of twelve REST
scenarios now meet the p95 target, compared with four of twelve in the old report. Indexer ingest
still meets its target, and WebSocket publish p95 now meets its target.

The remaining real REST misses are:

- `market.book`: 145.09 ms p95
- `market.prices`: 167.35 ms p95
- `account.detail`: 198.85 ms p95

No application code was changed. Raw clean results are in
`backend/bench/results/isolated-remote-12ff858.json`. The old comparison source is
`backend/bench/results/after.json` and the old narrative is
`backend/bench/results/REPORT.md`.

## Comparison basis

| | OLD | CLEAN |
| --- | --- | --- |
| Commit | `4f7c67562436c6486c0b12e8a92c8ea2815dcb37` | `12ff858f01917084434d878d924e653252e34137` |
| Host | Intel i5-1038NG7 Mac, 8 logical / 4 physical CPUs | CloudLab Xeon E5-2630 v3, 32 logical / 16 physical CPUs |
| Runtime | Node v25.6.1, macOS 25.5.0 | Node v24.18.1, Ubuntu 22.04 |
| Process topology | Server and generator in one Node process | Server and generator in separate Node processes |
| REST load | 20 warmups, 400 measured, concurrency 24 | Identical |
| WS load | 500 clients, 5 target subscribers, 2,000 publishes | Identical |
| Ingest load | 10 events, 100 positions re-marked per event | Identical |
| Data scale | Default synthetic scale in `perf_bench` | Identical |

OLD-to-CLEAN is the requested treatment comparison, not a pure one-variable A/B: host, Node
version, and commit also differ. The current commit adds health/liveness, dedup, and indexer
resilience work since `4f7c675`; the main optimized read-query shapes remain in place. A separate
same-host/current-commit contended control, described below, was used to distinguish process
topology from the broader environment change.

## Isolation and harness limitation

The repository's existing `bench/run.ts` cannot run out of process. It imports `buildServer`,
starts Fastify on an ephemeral port, creates its load clients, and publishes WS events through the
same in-memory event bus in one process. An unmodified run would therefore still contain the
measurement flaw.

For this run only, a temporary measurement adapter preserved the existing scenarios, defaults,
queries, ingest fixture, and result structure while changing orchestration:

- API server and `ServerEventBus`: CPUs `0-7,16-23` (socket 0, NUMA node 0, all SMT siblings).
- REST/WS generator: CPUs `8-15,24-31` (socket 1, NUMA node 1, all SMT siblings).
- These sets share no logical CPU, physical core, socket, or NUMA node.
- REST requests used real loopback TCP between the two processes.
- The 500 WS clients lived in the generator process. A loopback control socket told the server
  process to perform the same 2,000 synchronous `eventBus.publish` calls and return its measured
  publish distribution. Thus client message handlers could not starve the server event loop.
- The adapter was temporarily placed behind the existing `pnpm bench:run` command, then the
  original `bench/run.ts` was restored byte-for-byte
  (SHA-256 `ec3a05df16da68064b3399f7d6013d22de88f75b7c8ae0dda1b8f6efdc1939fd`).

The temporary adapter was not retained as application code.

## Host and load attribution

| Item | Value |
| --- | --- |
| Remote host | `node0.span14-311910.sec2pcllmbench-pg0.wisc.cloudlab.us` |
| OS/kernel | Ubuntu 22.04; Linux 5.15.0-177-generic x86_64 |
| CPU | Intel Xeon E5-2630 v3 @ 2.40 GHz |
| Topology | 2 sockets × 8 physical cores × 2 threads = 32 logical CPUs; 2 NUMA nodes |
| RAM | 134,882,701,312 bytes (125.6 GiB); 123+ GiB available before the run |
| Node / pnpm | v24.18.1 / 10.29.2 |
| Branch / commit | `dev` / `12ff858f01917084434d878d924e653252e34137` |
| Database | PostgreSQL 17 container, local loopback, isolated `perf_bench` schema |
| Vector store | Qdrant container healthy but unused by measured requests |

Load averages from `uptime`:

| Sample | Local host time | 1 min | 5 min | 15 min |
| --- | --- | ---: | ---: | ---: |
| Immediately before | 2026-07-31 11:12:39 -05:00 | 0.32 | 0.34 | 0.39 |
| During 1 | 11:12:40 | 0.32 | 0.34 | 0.39 |
| During 2 | 11:12:45 | 0.45 | 0.37 | 0.40 |
| During 3 | 11:12:50 | 0.50 | 0.38 | 0.40 |
| During 4 | 11:12:55 | 0.86 | 0.45 | 0.43 |
| Immediately after | 11:13:00 | 0.79 | 0.45 | 0.43 |

No other user workload was running. The only material services were the benchmark's healthy
PostgreSQL and idle Qdrant containers, plus Docker/containerd, SSH, and ordinary OS services.
Process samples confirmed the server and generator retained their assigned affinities during the
run.

## Reproducibility and dependency setup

- Checkout was fetched and fast-forwarded to current `origin/dev` at `12ff858`.
- The pre-update generated `backend/pnpm-lock.yaml` diff was preserved in git stash message
  `codex-pre-benchmark-existing-lock` and was not applied to the benchmark checkout.
- `shared` and `backend` were installed with pnpm using the frozen current lockfiles.
- The active `backend/node_modules/@predex-pump/shared` is a symbolic link
  (`../../../shared`) resolving to `/users/span14/predex-pump/shared`.
- No installed package resolves the old copied package. An unreferenced stale pnpm virtual-store
  directory from the previous `file:` install remains under `node_modules/.pnpm`; it has no
  inbound symlink and no current manifest or lockfile reference. It was not used or removed.
- PostgreSQL and Qdrant were healthy. All three migrations were applied, and
  `prisma migrate status` reported the public schema up to date.
- `pnpm bench:seed` recreated only `perf_bench`; `pnpm bench:teardown` dropped it after the
  report was recorded.
- `OPENAI_API_KEY` was absent from `.env` and explicitly unset for seed, server, generator,
  controls, and teardown. Dedup is not one of the benchmark scenarios, so its deterministic
  no-key fallback did not enter any measured request.

The run was independent of live chain RPC. The measurement server imported the existing
`buildServer` and event bus directly; it did not start `src/start.ts`, `runIndexer`, or an Arc
client. REST read the synthetic database, WS used synthetic in-memory events, and ingest called
`applyDecodedEvents` with synthetic decoded events. No public Arc endpoint was contacted.

Observed scale was unchanged: 2,000 markets, 20,000 accounts, 200,000 trades, 100,000 positions,
50,000 orders, 25,000 fills, 200,000 price points, and 1,000,000 activity events.

## REST: OLD versus CLEAN

Latency deltas are `(CLEAN - OLD) / OLD`; negative is faster. Throughput deltas are positive
when CLEAN completed more requests per second.

| Endpoint | p50 ms, old → clean (Δ) | p95 ms, old → clean (Δ) | p99 ms, old → clean (Δ) | req/s, old → clean (Δ) |
| --- | ---: | ---: | ---: | ---: |
| `markets.list` | 136.56 → 34.38 (-74.8%) | 350.09 → 82.07 (-76.6%) | 523.06 → 174.01 (-66.7%) | 145.7 → 563.8 (+286.9%) |
| `markets.phase` | 122.10 → 36.69 (-70.0%) | 166.15 → 53.85 (-67.6%) | 189.31 → 67.19 (-64.5%) | 184.0 → 611.4 (+232.3%) |
| `markets.deep-keyset` | 91.74 → 22.63 (-75.3%) | 164.77 → 42.49 (-74.2%) | 169.36 → 48.28 (-71.5%) | 229.7 → 926.0 (+303.0%) |
| `market.detail` | 102.08 → 26.38 (-74.2%) | 180.70 → 48.18 (-73.3%) | 200.33 → 57.26 (-71.4%) | 222.7 → 807.6 (+262.6%) |
| `market.book` | 285.35 → 97.33 (-65.9%) | 425.95 → 145.09 (-65.9%) | 427.25 → 191.68 (-55.1%) | 77.7 → 225.5 (+190.4%) |
| `market.prices` | 327.97 → 109.80 (-66.5%) | 404.43 → 167.35 (-58.6%) | 441.06 → 181.22 (-58.9%) | 72.4 → 205.0 (+183.2%) |
| `orderbook.token` | 107.73 → 43.64 (-59.5%) | 144.93 → 62.08 (-57.2%) | 212.01 → 72.13 (-66.0%) | 215.6 → 516.4 (+139.5%) |
| `account.detail` | 330.19 → 123.11 (-62.7%) | 465.81 → 198.85 (-57.3%) | 481.20 → 226.67 (-52.9%) | 72.6 → 183.7 (+153.2%) |
| `activity.list` | 63.10 → 16.12 (-74.4%) | 93.53 → 26.64 (-71.5%) | 96.41 → 29.89 (-69.0%) | 371.6 → 1320.5 (+255.4%) |
| `activity.market-deep-keyset` | 41.51 → 13.45 (-67.6%) | 66.29 → 23.96 (-63.9%) | 76.31 → 27.11 (-64.5%) | 548.0 → 1566.8 (+185.9%) |
| `config` | 11.39 → 7.26 (-36.3%) | 17.26 → 14.78 (-14.4%) | 18.05 → 15.11 (-16.3%) | 1952.9 → 2930.7 (+50.1%) |
| `health` | 33.05 → 9.30 (-71.9%) | 60.42 → 23.64 (-60.9%) | 66.84 → 25.01 (-62.6%) | 643.6 → 2067.5 (+221.2%) |

The median REST p95 reduction across all twelve scenarios is 64.9%.

## Indexer and WebSocket

| Metric | OLD | CLEAN | Delta |
| --- | ---: | ---: | ---: |
| Indexer ingest | 22.55 events/s | 36.48 events/s | +61.8% |
| Indexer duration, 10 events | 443.45 ms | 274.14 ms | -38.2% |
| WS publish p50 | 154.11 µs | 87.03 µs | -43.5% |
| WS publish p95 | 378.26 µs | 129.12 µs | -65.9% |
| WS publish p99 | 641.99 µs | 172.39 µs | -73.1% |
| WS publish rate | 5,315.3 publishes/s | 11,339.1 publishes/s | +113.3% |
| WS end-to-end | 467.68 ms | 183.05 ms | -60.9% |

All 10 ingest events were applied. WS delivered all 10,000 expected messages and delivered zero
messages to non-target clients.

- Indexer target, at least 20 events/s: met before and met cleanly.
- WS target, publish p95 below 250 µs: previously missed; now met.

## REST target disposition

The p95 target is below 100 ms.

Previously missed but now met:

| Endpoint | OLD p95 | CLEAN p95 |
| --- | ---: | ---: |
| `markets.list` | 350.09 ms | 82.07 ms |
| `markets.phase` | 166.15 ms | 53.85 ms |
| `markets.deep-keyset` | 164.77 ms | 42.49 ms |
| `market.detail` | 180.70 ms | 48.18 ms |
| `orderbook.token` | 144.93 ms | 62.08 ms |

Still missed:

| Endpoint | OLD p95 | CLEAN p95 | Payload |
| --- | ---: | ---: | ---: |
| `market.book` | 425.95 ms | 145.09 ms | 162,441 bytes |
| `market.prices` | 404.43 ms | 167.35 ms | 126,027 bytes |
| `account.detail` | 465.81 ms | 198.85 ms | 253,898 bytes |

## Evidence for the remaining time

A separate, process-isolated diagnostic repeated 20 warmups plus 400 requests at concurrency 24
for only the three misses. A temporary Fastify hook put handler and JSON-serialization durations
in a `Server-Timing` header. The client computed a paired residual as end-to-end minus those two
server phases. The diagnostic is supporting attribution, not a replacement for the clean numbers
above; hook overhead and run-to-run variation make its total p95 somewhat different.

| Endpoint | SQL plan / execution | Handler p95 | JSON serialization p95 | Socket/queue/client residual p95 |
| --- | ---: | ---: | ---: | ---: |
| `market.book` | 1.687 / 0.322 ms | 96.51 ms | 1.30 ms | 99.10 ms |
| `market.prices` | 1.280 / 1.445 ms | 117.68 ms | 1.38 ms | 74.63 ms |
| `account.detail` positions | 1.320 / 1.354 ms | 122.38 ms | 2.14 ms | 97.02 ms |

The phase p95 values are distributions and are not additive. The residual includes request
admission, loopback/kernel socket work, client body receipt, and client scheduling; it is not a
claim that the physical wire alone took that time.

PostgreSQL execution is not the bottleneck: representative plans execute in 0.32-1.45 ms and use
the intended indexes. JSON stringify itself is also only 1.30-2.14 ms p95. The real time is in the
handler/ORM/materialization/DTO work plus socket and event-loop queuing for large responses:

- book reads market plus 375 open orders and builds/sorts YES/NO books and levels;
- prices reads and maps 2,000 points;
- account runs three Prisma reads and maps 1,002 positions plus recent trades.

That is evidence of genuine current behavior under full concurrency. No fix was attempted.

## How much of OLD was artifact?

Broadly, six of the nine previously missed targets were environment/measurement artifacts:
five of eight REST misses now pass, and the old WS miss now passes. Three REST misses persist and
are real. Across REST, OLD-to-CLEAN p95 fell by a median 64.9%, but that full reduction must not be
attributed solely to process isolation because the host, Node version, and commit changed.

For a narrower topology check, the unchanged repository harness was run once on this same host
and current commit in its original same-process mode, clearly labeled as a contended diagnostic
and stored only in `/tmp`:

| Previously missed REST endpoint | Same-host contended p95 | CLEAN p95 | Same-host contended req/s | CLEAN req/s |
| --- | ---: | ---: | ---: | ---: |
| `markets.list` | 124.45 ms | 82.07 ms | 391.3 | 563.8 |
| `markets.phase` | 51.43 ms | 53.85 ms | 543.5 | 611.4 |
| `markets.deep-keyset` | 56.46 ms | 42.49 ms | 699.2 | 926.0 |
| `market.detail` | 56.45 ms | 48.18 ms | 634.7 | 807.6 |
| `market.book` | 151.98 ms | 145.09 ms | 188.8 | 225.5 |
| `market.prices` | 156.03 ms | 167.35 ms | 187.4 | 205.0 |
| `orderbook.token` | 69.79 ms | 62.08 ms | 452.6 | 516.4 |
| `account.detail` | 187.50 ms | 198.85 ms | 154.5 | 183.7 |

Isolation is decisive for the `markets.list` target on the controlled host
(124.45 → 82.07 ms). Four other newly passing REST scenarios already pass on this host in the
contended control, so their old failures were primarily host/runtime/current-code effects, not
same-process contention alone. The three persistent misses fail in both remote modes.

CLEAN throughput is higher for all eight rows. Where contended p95 looks slightly lower, the
shared event loop self-throttles request production; that coordinated omission is another reason
not to treat it as a clean result. The same-host contended WS p95 was 50.48 µs versus CLEAN
129.12 µs: both meet target, and the lower contended number reflects changed scheduling semantics
(client callbacks defer during the synchronous publish loop), not a superior trustworthy
measurement. The old 378.26 µs WS miss is therefore not real on the current idle host.

## Uncertainties

- As in the old report, CLEAN is one complete final run rather than a multi-run confidence
  interval. The 10-event ingest sample is particularly sensitive to run-to-run cache variation.
- OLD and CLEAN use different commits and runtimes; the same-host diagnostic isolates topology
  only for current `12ff858`.
- Per-phase timing came from a separate instrumented run; use it for attribution, not as a second
  canonical latency result.
- PostgreSQL was not CPU-pinned, although the host remained near-idle and the server/generator
  CPU sets were verified throughout.
- The stale, unreferenced pnpm virtual-store copy noted above was present, but the active module
  graph resolved only the repository-source symlink.
