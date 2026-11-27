---
title: Data-integrity verification
description: How mistri verifies transactions, idempotency, tenant isolation, caches, workflows and crash recovery under Jepsen-style fault injection and formal Elle checking, plus the soak and saturation results.
---

How mistri verifies transactions, idempotency, tenant isolation, caches,
workflows and crash recovery under Jepsen-style fault injection and formal
Elle checking, plus the soak and saturation results.

```sh
# Start PostgreSQL 16 (primary + lagged replica), transaction-mode PgBouncer and Valkey 8
docker compose -f test/jepsen/docker-compose.yml up -d --wait postgres-primary postgres-replica pgbouncer valkey

# Run all 14 workloads with fault injection (and optional official elle-cli JAR)
ELLE_CLI_JAR=/path/to/elle-cli-0.1.11-standalone.jar npm run test:jepsen -- \
  --pg postgres://mistri:mistri@127.0.0.1:15432/mistri_jepsen \
  --replica-pg postgres://mistri:mistri@127.0.0.1:15433/mistri_jepsen \
  --pgbouncer-pg postgres://mistri:mistri@127.0.0.1:16432/mistri_jepsen \
  --valkey valkey://127.0.0.1:16379/0 \
  --workload all --duration 10 --concurrency 6
```

<!-- no picture: command-line verification harness, fault matrix and soak/saturation tables. -->

Every workload creates an isolated disposable database (`mistri_jepsen_*`),
drives real mistri adapters, pools, HTTP servers or child processes behind
programmable TCP fault proxies (`FaultProxy`), records Jepsen-compatible
`.edn` and `.jsonl` operation histories, and fails non-zero on any invariant
violation.

## Fault model

The nemesis injects faults continuously while concurrent clients contend on
shared hot records:

- **Post-`COMMIT` TCP reply cuts** — `FaultProxy` inspects PostgreSQL v3 wire
  frames, lets `COMMIT` reach PostgreSQL, and destroys the client socket
  before the acknowledgement returns, forcing `TransactionOutcomeUnknown` and
  idempotent receipt recovery.
- **Connection resets, partitions and latency spikes** — active socket RSTs,
  blackholed reconnects, FIFO-preserving latency/jitter, and
  `pg_terminate_backend` kills against writer and `LISTEN` sessions.
- **Real OS process faults** — `SIGSTOP`/`SIGCONT` process freezes and
  `SIGKILL` crashes with automatic pod/worker respawns on multi-process HTTP
  clusters and SQLite WAL workers.
- **Topology & state faults** — streaming replica lag (`150 ms`), dynamic
  failover to a read-only standby (`25006 read_only_sql_transaction`),
  transaction-mode PgBouncer connection recycling (`MAX_PREPARED_STATEMENTS=0`),
  online `ALTER TABLE` DDL churn, backward clock regressions on event leases,
  and concurrent parent membership revocations.

## Workloads

| Workload        | Subsystem under test                                                                 | Invariants verified                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bank`          | `snapshot: true` commands, command journal, receipt recovery, transactional outbox   | Strict balance conservation on every read and final state, non-negativity, zero double-applies, zero lost acks, 1:1 ledger ↔ receipt ↔ event rows |
| `append`        | `REPEATABLE READ` + `WriteAhead` pipelined transactions                              | Built-in Elle `list-append` DSG checker (`G0`, `G1a`, `G1b`, `G1c`, `P4`, `G-single`) plus official `elle-cli` (`--model list-append`)            |
| `workflow`      | Durable workflow engine (`advance`) & PostgreSQL workflow store                      | Epoch fencing (`overtaken`), zero divergence across competing hosts, convergence to `completed`, exactly-once step side effects                   |
| `outbox`        | Event delivery store & competing publishers under lease expiry and clock regression  | Zero lost committed events, zero phantom deliveries, stable `idempotencyKey` across retries and hosts                                             |
| `replica`       | Read-replica routing & Read-Your-Writes (`lagTolerantReads`, `readsAs`, `noteWrite`) | Monotonic RYW (`observed >= written`) after fresh writes, active replica checkouts when healthy, transparent primary fallback during partitions   |
| `tenant`        | Row-scoped multi-tenant transactions (`scopeTransaction`, `RowScope`, `WriteAhead`)  | Zero cross-tenant reads or writes under a 2-connection pool and post-`COMMIT` cuts, zero lost acks, zero false `not_applied`                      |
| `pgbouncer`     | Transaction-mode connection pooling (`pooler: 'transaction'`, live PgBouncer)        | Zero prepared-statement or session-state bleed across recycled server connections, zero cross-tenant leaks                                        |
| `ddl`           | Online `ALTER TABLE` / `CHECK` constraint churn & catalog `EpochCache` invalidation  | Zero constraint bypasses, zero cross-tenant writes, zero lost acknowledged writes across two hosts                                                |
| `cache`         | Shared Valkey cache (`ValkeyCacheStore`, `RespClient`, `scopedCache`)                | Zero cross-tenant reply bleed across reconnects, fail-open `get`, fail-closed `incr` (`CacheUnavailable`), post-heal freshness                    |
| `proposals`     | AI command proposals (`approve` vs `approve` / `dismiss`) & `LISTEN`/`NOTIFY`        | At-most-once execution, zero execution after dismissal, reconnect wakeups after backend kills, zero notifies from rolled-back transactions        |
| `failover`      | Dynamic primary → read-only standby (`25006`) → primary routing                      | Zero writes applied on read-only standby, clean refusal, exact conservation, automatic post-failover write recovery                               |
| `support-lease` | Audited tenant support leases (`revokePlatformMembership`, Better Auth)              | At most 1 active lease per operator, zero active/resumable leases post-revocation, intact cryptographic audit hash-chain                          |
| `http-cluster`  | Two real Mistri HTTP server child processes (`createApp`, `/api/commands/*`)         | Balance conservation, idempotent cross-pod retry recovery and 1:1 ledger/receipt/outbox match under `SIGSTOP`/`SIGKILL` and PG cuts               |
| `sqlite-crash`  | Multi-process `SqliteAdapter` WAL transactions & persistent Undo journal             | `PRAGMA integrity_check === 'ok'`, balance conservation, valid Undo journal schema and JSON entries across repeated `SIGKILL` crashes             |

## Two-hour soak results

Executed on a 2-vCPU, 7.8 GB Linux VM against Dockerized PostgreSQL 16
(primary + 150 ms-lagged streaming replica), `edoburu/pgbouncer` (transaction
mode), Valkey 8, and official `elle-cli` v0.1.11:

| Stage                                                                    | Duration | Workload runs | Mistri integrity verdict | Resource & leak telemetry                                                                                             |
| ------------------------------------------------------------------------ | -------- | ------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| **Stage 1 — Long-lived single-process leak soak** (`--expose-gc`, `c=8`) | 30 min   | 134           | **134 / 134 PASS**       | Heap flat `77.2–109.0 MB`, RSS `280–336 MB`, FDs `22–31`, PG connections `6`, leftover DBs `0`, `0` listener warnings |
| **Stage 2 — 2-lane parallel high-load chaos** (`c=12–32`, 17 rounds)     | 90 min   | 234           | **233 / 233 PASS**\*     | **27 / 27** official `elle-cli` v0.1.11 proofs PASS; **0 hangs**; Postgres `55.9 MiB`, Replica `49.4 MiB`, PgBouncer `1.9 MiB`, Valkey `3.4 MiB`; `310,315` Valkey commands |

_\*One Round 1 `replica` failure at `c=24` was traced to a shared JS counter in the workload script when `writerCount > 4`; after allocating one slot per writer in `test/jepsen/workloads/replicaRyw.ts`, all 228 remaining Stage 2 runs (including 16 straight `replica` runs at `c=24`) passed._

## Thirty-minute end-to-end HTTP saturation results

Two real Mistri HTTP server child processes (`createApp`) connected to
PostgreSQL through `FaultProxy`, driven by closed-loop HTTP clients (zero
worker sleep, 16 teller accounts, 70% `POST /api/query` reads and 30%
transactional `POST /api/commands/prepare` + `/execute` transfers across 200
accounts) while injecting `SIGSTOP`/`SIGKILL` pod restarts and post-`COMMIT`
TCP cuts:

| Tier                         | Concurrency | Duration | HTTP requests | Throughput (goodput) | Latency (p50 / p95 / p99) | Committed transfers | Faults injected                                     |
| ---------------------------- | ----------- | -------- | ------------- | -------------------- | ------------------------- | ------------------- | --------------------------------------------------- |
| **Tier 1 — Baseline**        | 32          | 5 min    | 83,641        | 279 req/s (16.7k/m)  | 12 ms / 630 ms / 795 ms   | 14,965              | None (`0` errors)                                   |
| **Tier 2 — High load+chaos** | 64          | 8 min    | 122,456       | 254 req/s (15.3k/m)  | 14 ms / 1.41 s / 1.67 s   | 17,855              | 87 (22 `SIGKILL`, 22 `SIGSTOP`, 43 PG resets/cuts)  |
| **Tier 3 — Saturation knee** | 128         | 10 min   | 162,683       | 271 req/s (16.2k/m)  | 16 ms / 2.47 s / 3.01 s   | 17,590              | 107 (27 `SIGKILL`, 27 `SIGSTOP`, 53 PG resets/cuts) |
| **Tier 4 — Overload burst**  | 256         | 7 min    | 129,404       | 307 req/s (274/s)\*  | 25 ms / 3.62 s / 3.94 s   | 6,737               | 74 (18 `SIGKILL`, 19 `SIGSTOP`, 37 PG resets/cuts)  |

_\*At `c=256` on 2 vCPUs, 115,634 HTTP 2xx/409 responses (274.3 good req/s: 69,439 reads, 29,578 prepares, 6,737 committed transfers and 9,880 clean `409` refusals) completed with `0` HTTP `500` responses while excess overload shed cleanly across 13,690 client 4 s timeouts/resets._

**End-to-end integrity verdict across all 498,184 HTTP requests, 67 `SIGKILL` pod crashes, 68 `SIGSTOP` freezes, 136 post-`COMMIT` TCP cuts and 325 TCP resets:**

- **Balance conservation:** `2,000,000 / 2,000,000` exact (`minBalance = 9,099`, zero negative balances).
- **1:1:1 durability correspondence:** `57,432` ledger rows = `57,432` command receipts = `57,432` outbox events.
- **Zero lost acknowledgements:** `0` lost out of `57,147` HTTP `200` applied responses (`285` additional commits whose pod died or socket cut mid-`COMMIT` were classified as indeterminate rather than `not_applied`).
- **Zero false negatives:** `0` false `not_applied` answers across `41,333` refused transfers.
- **Zero server `500`s and 95.8% lower pool churn:** `0` HTTP `500` responses across all four tiers (transient mid-query database disconnects map to HTTP `503`), and `875` total PostgreSQL TCP connections opened across the 30-minute run (down from `20,929` before clean-rollback connection reuse).

## Issues found and fixed by the suite

Running the harness and saturation benchmark live caught correctness, status-mapping and hot-path bottlenecks that unit tests had missed, all fixed with deterministic regression tests in `test/jepsen-harness.test.ts`:

1. **Mid-`COMMIT` disconnect misclassified as `not_applied` (`postgresTransactionHandle.ts`)** —
   when a TCP drop rejected both pipelined `beforeCommit()` journal writes and
   `COMMIT`, `behind()` threw `RolledBackAtCommit` without PostgreSQL answering
   `command === 'ROLLBACK'`, surfacing as an Elle `G1a` anomaly. Fixed so only an
   explicit server `ROLLBACK` (or local rollback before `COMMIT` leaves) throws
   `RolledBackAtCommit`; disconnects now stay `TransactionOutcomeUnknown`.
2. **Stale-socket RESP reply-queue desync (`resp.ts`)** — `RespClient` shared a
   single `waiting` queue and receive buffer across reconnects and did not
   re-verify socket identity after `await this.connected()`. Under abrupt
   disconnects and reconnects, a phantom waiter could shift replies across
   callers/tenants. Fixed by binding `{ socket, chunks, buffered, waiting, dead }`
   per connection.
3. **Rollback connection teardown storm (`postgresPool.ts`, `postgres.ts`)** —
   conflict/refusal rollbacks (`409`) previously passed `release(true)` and
   destroyed healthy idle TCP sockets, triggering SCRAM-SHA-256 reconnect storms
   under contention (`20,929` connections in 30 min). Clean pre-`COMMIT`
   rollbacks now return healthy sockets to the pool (`875` connections, −95.8%)
   while still destroying any uncertain, cancelled or failed-rollback socket.
4. **Transient read disconnects mapped to `503` and hot-path contention** —
   mid-query `connectionFailure` errors now return HTTP `503` instead of `500`
   (`server.ts`), revision-only `/api/commands/prepare` routes onto the primary
   reader pool (`businessCommandHttp.ts`), and snapshot commands reuse cached
   before-images while skipping redundant audit re-serialization, per-request
   `AsyncLocalStorage` hops and `liveReads` error-stack allocations (+29% to
   +64% throughput across `c=32..128`, +157% goodput and 4.4× committed
   transfers at `c=256`).

## CI gates and scope boundaries

- **Fast PR gate** (`test/jepsen-harness.test.ts`, runs in `npm run test:node`,
  no Docker needed): verifies EDN serialization, planted-anomaly detection
  across every checker, `FaultProxy` wire interception, and the two regression
  tests above.
- **Nightly / manual chaos workflow** (`.github/workflows/jepsen.yml`): starts
  PostgreSQL 16 primary + replica, PgBouncer, and Valkey, caches official
  `elle-cli` v0.1.11, runs all 14 workloads, and uploads `report.md`,
  `report.json`, and `.edn`/`.jsonl` histories as artifacts.
- **Known boundaries not covered by this suite:** bearer-token RYW tracking is
  process-local (browser cookie RYW is cluster-wide); filesystem `ENOSPC` /
  `dm-flakey` storage faults and true multi-primary PostgreSQL timeline
  divergence (split-brain promotion) are outside this harness's scope.

## Related

- [Operational guarantees](/docs/operational-guarantees/)
- [Performance and pools](/docs/performance/)
- [Performance by default](/docs/performance-by-default/)
- [Commands](/docs/commands/)
- [Tenant Apps](/docs/tenant-apps/)
