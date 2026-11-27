# Jepsen-style data-integrity harness

Adversarial fault-injection and formal history verification for Mistri's stateful
data-integrity protocols over live PostgreSQL (primary + streaming replica),
transaction-mode PgBouncer, Valkey, multi-process Mistri HTTP clusters, and
multi-process SQLite WAL crash recovery.

## Quick start

```sh
# 1. Start disposable PostgreSQL 16 (primary + streaming replica), PgBouncer, and Valkey
docker compose -f test/jepsen/docker-compose.yml up -d --wait postgres-primary postgres-replica pgbouncer valkey

# 2. Run all 14 workloads with fault injection enabled
npm run test:jepsen -- \
  --pg postgres://mistri:mistri@127.0.0.1:15432/mistri_jepsen \
  --replica-pg postgres://mistri:mistri@127.0.0.1:15433/mistri_jepsen \
  --pgbouncer-pg postgres://mistri:mistri@127.0.0.1:16432/mistri_jepsen \
  --valkey valkey://127.0.0.1:16379/0 \
  --workload all \
  --duration 10 \
  --concurrency 6

# 3. Run SQLite WAL multi-process SIGKILL crash recovery standalone (no Docker needed)
npm run test:jepsen -- --workload sqlite-crash --duration 6 --concurrency 3

# 4. Tear down the disposable containers and volumes
docker compose -f test/jepsen/docker-compose.yml down -v
```

Each PostgreSQL workload creates a uniquely named database (`mistri_jepsen_*`)
on the target server and drops it on exit, so it never touches existing
databases.

## Workloads

| Workload        | Mistri subsystem                                                                                       | What it proves under fault injection                                                                                                                                                                                                                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bank`          | Commands (`snapshot: true`), command journal, receipt recovery (`lookupBusinessCommandStatus`), outbox | Two independent Mistri pools (`node-a`, `node-b`) behind separate `FaultProxy` links execute concurrent transfers and cross-node retries while the nemesis cuts TCP sockets **after PostgreSQL receives `COMMIT` and before the reply reaches Mistri**, resets connections, adds latency, and terminates backends. Verifies conservation, non-negativity, idempotency, and 1:1 receipt/event correspondence. |
| `append`        | `snapshot: true` commands (`REPEATABLE READ` + `WriteAhead`)                                           | Concurrent multi-operation Elle `list-append` transactions (`[:r k]`, `[:append k v]`) across two Mistri pools under connection faults. Verifies zero `G0`, `G1a`, `G1b`, `G1c`, lost updates (`P4`), duplicate appends, or `G-single` anomalies via the built-in DSG checker and optional official `elle-cli` (`--model list-append`).                                                                      |
| `workflow`      | Durable workflow engine (`advance`) & PostgreSQL workflow store (`openPostgresWorkflowStore`)          | Two competing workflow hosts (`host-a`, `host-b`) race to advance the same multi-step workflows under mid-`COMMIT` cuts, TCP resets, latency spikes, and mid-step aborts. Verifies epoch fencing (`overtaken`), convergence to `completed`, and exactly-once step side effects per idempotency key.                                                                                                          |
| `outbox`        | Event delivery store (`openPostgresEventDeliveryStore`) & publisher (`createEventPublisher`)           | Two competing publishers (`pub-a`, `pub-b`) deliver committed command events under post-`COMMIT` cuts, lost transport acknowledgements, slow handlers exceeding `leaseMs`, rolled-back refusals, and backward clock regressions. Verifies zero lost events, zero phantom events, and stable `idempotencyKey`.                                                                                                |
| `replica`       | Read-replica routing & Read-Your-Writes (`replicas.ts`: `lagTolerantReads`, `readsAs`, `noteWrite`)    | Concurrent monotonic writers and lag-tolerant readers against primary + streaming replica (`REPLICA_APPLY_DELAY=150ms`) under latency spikes, replica partitions, and resets. Verifies strict RYW monotonicity (`observed >= written`), active replica checkouts, and transparent primary fallback.                                                                                                          |
| `tenant`        | Row-scoped multi-tenant transactions (`scopeTransaction`, `RowScope`, `WriteAhead`)                    | Three tenants (`alpha`, `beta`, `gamma`) contend over a tight 2-connection PostgreSQL write pool behind `FaultProxy` with post-`COMMIT` cuts, TCP resets, and latency spikes. Verifies zero cross-tenant reads/writes, zero lost acknowledged writes, and zero false-negative rollbacks.                                                                                                                     |
| `pgbouncer`     | Transaction-mode connection pooling (`pooler: 'transaction'`, `postgresPooler.ts`, `WriteAhead`)       | Drives multi-tenant scoped transactions through real `edoburu/pgbouncer` (`POOL_MODE=transaction`, `MAX_PREPARED_STATEMENTS=0`) behind `FaultProxy`. Verifies zero prepared-statement / session-state bleed across recycled server connections and zero cross-tenant leaks.                                                                                                                                  |
| `ddl`           | Online DDL & catalog-epoch invalidation (`epochCache.ts`, `scopeTransaction`)                          | Executes online `ALTER TABLE` (add column, add `CHECK` constraint, rename/drop auxiliary column) while two Mistri hosts perform concurrent tenant-scoped writes. Verifies catalog invalidation, zero constraint bypasses, zero cross-tenant writes, and zero lost commits.                                                                                                                                   |
| `cache`         | Shared Valkey cache (`ValkeyCacheStore`, `RespClient`, `scopedCache`)                                  | Multi-tenant cache-aside reads/writes and rate-limit `incr` across two `ValkeyCacheStore` instances routed through `FaultProxy` to live Valkey 8 under partitions, TCP resets, and latency spikes. Verifies zero cross-tenant reply bleed across reconnects, fail-open `get`, fail-closed `incr` (`CacheUnavailable`), and post-heal freshness.                                                              |
| `proposals`     | AI command proposals (`createProposal`, `runProposalRoute`) & live sync (`listenForCommandEvents`)     | Races concurrent `approve` vs `approve` and `approve` vs `dismiss` across two Mistri hosts under post-`COMMIT` cuts while killing the `LISTEN` backend with `pg_terminate_backend`. Verifies at-most-once execution, zero execution of dismissed proposals, reliable reconnect wakeups, and zero notifications from rolled-back transactions.                                                                |
| `failover`      | PostgreSQL read-only (`25006`) failover refusal & automatic recovery                                   | Dynamically retargets `FaultProxy` upstream from writable primary → read-only streaming standby (`25006 read_only_sql_transaction`) → writable primary while Mistri executes bank commands. Verifies zero writes applied on the read-only standby, clean refusal, automatic post-failover write recovery, and exact balance conservation.                                                                    |
| `support-lease` | Audited tenant support leases (`createTenantAuthenticatedHttpServer`, `revokePlatformMembership`)      | Races concurrent `/api/tenant/support/open` and `/exit` requests over Better Auth native sessions and PostgreSQL behind `FaultProxy` while invoking `revokePlatformMembership`. Verifies at most one active lease per account, zero active leases or resumable contexts post-revocation, and an intact cryptographic audit hash-chain (`verifyPostgresSupportAudit`).                                        |
| `http-cluster`  | End-to-end multi-process Mistri HTTP cluster (`createApp`, `/api/commands/{prepare,execute,status}`)   | Spawns two real OS child processes running full Mistri HTTP servers behind separate PostgreSQL `FaultProxy` links while injecting real OS `SIGSTOP`/`SIGCONT` process freezes, `SIGKILL` crashes + pod respawns, and post-`COMMIT` cuts. Verifies idempotent cross-pod retry recovery, balance conservation, and 1:1 ledger/receipt/event consistency.                                                       |
| `sqlite-crash`  | Multi-process SQLite WAL transactions (`SqliteAdapter`) & persistent Undo journal (`journalStore.ts`)  | Spawns real OS child worker processes executing concurrent `SqliteAdapter.transaction` transfers and persistent `recordedUpdate` Undo entries on a shared WAL database while repeatedly injecting real OS `SIGKILL`. Verifies `PRAGMA integrity_check === 'ok'`, balance conservation, and Undo journal schema/JSON integrity across WAL recovery.                                                           |

## Running official `elle-cli` on recorded histories

Every workload writes Jepsen-compatible `.edn` and `.jsonl` history files to
`--out <dir>` (or the printed OS temp directory `mistri-jepsen-*`).

You can verify `append-history.edn` automatically during a run by pointing the
harness at official [`elle-cli`](https://github.com/ligurio/elle-cli) (v0.1.11+):

```sh
# Using an elle-cli binary:
npm run test:jepsen -- --workload append --elle-cli /path/to/elle-cli --pg ...

# Or using the standalone JAR (Java 11+):
ELLE_CLI_JAR=/path/to/elle-cli-0.1.11-standalone.jar npm run test:jepsen -- --workload append --pg ...
```

## Nightly CI & fast PR checks

- **Fast PR gate** (`test/jepsen-harness.test.ts`, runs in `npm run test:node`, no Docker or PostgreSQL needed): proves EDN serialization, planted-anomaly detection across every checker, TCP `COMMIT`-cut interception, `postgresTransactionHandle` mid-`COMMIT` disconnect classification, and `RespClient` per-connection reply-queue isolation.
- **Nightly / manual chaos workflow** (`.github/workflows/jepsen.yml`): sets up Java 21 + cached official `elle-cli` v0.1.11 JAR, starts PostgreSQL 16 primary + streaming replica + PgBouncer + Valkey via Docker Compose, and runs all 14 workloads, uploading `report.md`, `report.json`, and `.edn`/`.jsonl` histories as workflow artifacts.
