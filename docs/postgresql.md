# PostgreSQL Connections

The adapter uses the existing optional `pg` dependency and its `Pool` API.
SQLite users do not need the PostgreSQL driver.

Each configured PostgreSQL database opens up to three pools lazily, on first use:

| Setting                       | Readers                                                                                                  | Writers                                                                                                        | Background writer |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------- |
| Maximum connections           | The database browser 4, an App as many as its writers, by default; `pool.read` or `--read-pool`, 1 to 64 | An App: twice the cores, 4 to 16, by default; `pool.write` or `--write-pool`, 1 to 64. The database browser: 1 | 1                 |
| Queue wait                    | 2 seconds, 64 queued per connection                                                                      | 2 seconds, 64 queued per connection                                                                            | —                 |
| Connect/acquisition timeout   | 10 seconds                                                                                               | 10 seconds                                                                                                     | 10 seconds        |
| Idle expiry                   | 30 seconds                                                                                               | 30 seconds                                                                                                     | 30 seconds        |
| Statement timeout             | 30 seconds                                                                                               | 30 seconds                                                                                                     | 30 seconds        |
| Lock timeout                  | —                                                                                                        | 5 seconds; `--lock-timeout`                                                                                    | 5 seconds         |
| Default transaction read-only | On                                                                                                       | Database default                                                                                               | Database default  |

The last three rows are set once per physical connection, or per transaction
behind a [transaction-mode pooler](../site/src/content/docs/docs/performance.md#behind-a-transaction-mode-pooler).
Initialization is awaited for every new physical connection. Every structured
read leases a client for exactly its statement, as `pool.query` would, so its
wait for a connection is measured ([the pool meters](../site/src/content/docs/docs/performance.md#reading-the-pool-meters));
a raw SQL read or explain request holds one client for its complete read-only
transaction. Structured write transactions also hold a single client, and
concurrent calls inside a transaction are serialized on that transaction's
client. The order writes run in is the next section's.

A checkout that finds every connection leased queues, but not for long: past
two seconds, or past sixty-four waiting per connection, it is refused with `PoolBusy`
(`packages/engine/src/adapters/poolMetrics.ts`) rather than held for the ten-second driver
timeout and failed as a 500. The HTTP layer answers it 503 with `Retry-After: 1`
and the code `server_busy`. Nothing was leased, so nothing ran: a write says
`outcome: "not_applied"`, and is not recorded as an uncertain write in the
history, because no transaction began (one that began and then lost its rollback
is still `unknown`). The page asks a busy read again, a few times, with that
delay, and never retries a write by itself. Refusals count in the pool's
`timedOut` meter and keep it `saturated`, so readiness reports `pool_saturated`.
The driver cannot withdraw a request it queued, so a connection that arrives
after the refusal is returned to the pool unused. The bounds are fixed, not
flags. The background writer waits as before.

All leases release in `finally`. Failed operations discard their client. Clients
used for user-authored SQL are discarded even after success, because rollback
alone does not clear every form of session state, such as advisory locks. There
is no automatic replay of failed or unconfirmed writes. Shutdown rejects new
acquisitions and drains existing work before ending the pools.

Sizing the reader pool, planning connections across pods, reading the pool
meters and running behind PgBouncer or RDS Proxy (`--pooler transaction`) are
on the site:
[Performance & PostgreSQL pools](../site/src/content/docs/docs/performance.md).
This page keeps what the adapter guarantees and why.

## Listening behind a pooler

A transaction-mode pooler cannot hold `LISTEN`, so a jobs host behind one polls
(`--pooler transaction`). A connection's `"listen"` is a PostgreSQL URL that
reaches the same database without the pooler; the host listens there
(`wakeListenUrl`, `packages/mistri/src/adapters/events/postgresCommandEventWake.ts`) and the
writers still `NOTIFY` through the pooled URL. It is refused for any other
engine rather than ignored. A tenant App's job hosts read it too: startup resolves it into the enrollment's source.

## Read replicas

A connection's `"replicas"` (PostgreSQL and MySQL; refused for SQLite and
HTTP sources) gives each replica a connection manager of its own, sized,
capped and read-only exactly as the primary's readers are; its writers are
never opened. Only the reader handle's single statements are routed
(`packages/engine/src/adapters/replicas.ts`): everything that leases a whole client — a
snapshot, a raw SQL read, a store's read, every write — stays on the
primary, and so does every read nobody classified. A tenant App's request
reader is the exception that proves the rule (`openPostgresTenantReadSource`):
its whole snapshot moves, prologue, catalog and store attestation, relation
description and membership revalidation included, so the replica is held to
the same contract the primary is. Its replica readers attest on first use;
the description must equal the primary's. A replica that cannot answer — a
catalog that does not attest, a member it has not replayed yet, an uncertain
rollback (which replaces that replica's pool, as the primary's does, not the source) — hands the read
to the primary, which stays the authority: a revoked membership is honoured
on a replica after its lag, and every write and command revalidates on the
primary. The enrollment's discovery reader (sign-in, notices) never moves. The HTTP
layer classifies (`packages/engine/src/server/http/readRouting.ts`): list pages and counts,
breakdowns and exports may use a replica; a one-row read, a composed record
page, writes and commands may not. The catalog is pinned to the primary,
because the reads after it compile against it.

Read-your-write travels with the browser. A writer lease taken inside a
request marks that request fresh and sets `mistri_fresh=<write time>` (`tablewalk_fresh` in the browser)
(Max-Age 10, HttpOnly, SameSite=Lax, Path the App's base path;
`readFreshness` in readRouting.ts); a request that brings back a marker under
ten seconds old reads the primary. No pod has to remember anything, and two
anonymous visitors never share a window. A bearer-token caller (the App API,
MCP over HTTP) has no cookie jar, so its writes are remembered in the process
under a digest of its token: per pod, which is only a replica's lag. Ten
seconds is long past a healthy replica's lag, and short enough that one busy
writer does not move the read load back. A
replica that refuses or drops a connection (SQLSTATE classes 08 and 28,
57P01–03, 53300, 3D000, a socket error) is skipped for thirty seconds and the
read runs again on the primary; one that only cannot answer this read — a
full pool, a recovery conflict, a relation a migration has not reached — hands
it over without being skipped. Any other failure is the read's own and is not
repeated.

## Writers: one for the database browser, a pool for an App

The order writes run in is decided once per process (`packages/engine/src/adapters/writeLanes.ts`).

**The database browser keeps one writer, one write at a time.** Every write —
`update`, `insert`, `remove`, raw SQL, `transaction` — waits for the one
before it, on its one writer connection. That is its contract with the person
at the keyboard: two edits of one cell sent in order commit in that order, a
raw SQL write lands after the edit queued before it, and its Undo reverts "the
last write", which is one thing only while writes commit one at a time
(`packages/engine/src/server/journal.ts`). A `"pool": { "write": n }` does not change it.

**An App has no Undo and writes through a pool.** A process serving an App
opens up to `pool.write` writers per database (twice the cores, 4 to 16, by default; `--write-pool`)
and orders its writes by record instead of all at once:

- A write that names one record — an `update` or `remove` by its key, an App
  save of a record — waits only for earlier writes of that record (its table
  and primary key, the values as text), and waits in its lane _without_ a
  connection. Two saves of one record commit in the order they arrived; saves
  of different records run side by side, each on a writer of its own.
- A write whose rows are known only inside it — a command, a row-policy or
  tenant transaction, a plain `transaction()`, an insert — takes no lane and
  runs at once. The database orders it, as it always ordered writes from two
  pods (below).
- A raw SQL write and shutdown wait for every write before them and hold back
  every write after them, in either order.

No two writes wait on each other in the process: a write's waits are taken
when it is queued, only on writes queued before it. Rows locked inside
transactions are the database's to order, and its deadlock detector and the
lock timeout bound them.

Dropping the one-at-a-time queue is safe for an App because nothing an App
writes relied on it; each path already held across pods, which are other
connections to the same database:

- **Commands.** Declared targets and receipt scopes take their process lanes
  together, so bulk requests with overlapping targets keep arrival order.
  The target is read in the transaction and every typed
  `db.update` is a compare-and-set on the values it read, with the version
  field bumped (`packages/mistri/src/server/commands/commandDb.ts`): a command that read a
  row another transaction has since changed writes nothing and refuses
  `stale_record`. Duplicate deliveries of one request are serialized by the
  receipt: a transaction-level advisory lock per receipt scope
  (`packages/mistri/src/adapters/commands/postgresCommandJournal.ts`), or, on the fresh path,
  the receipt's own unique insert at commit. A handler's raw `tx.update`
  without `expected` is as blind as it was across pods; a handler that reads
  and then writes takes `tx.lockRecord` first.
- **Row policies and tenants.** Every target is taken `FOR UPDATE` and every
  parent `FOR SHARE` before it is checked, the scoped tables are pinned
  `ROW EXCLUSIVE`, and the check reads a fresh statement snapshot after the
  lock (below). Tenant sources fence membership and versions in the same
  transaction.
- **An App's saves.** A form, an inline edit, a board or calendar move and a
  checklist tick send the values they were showing as `expected`, and the
  `UPDATE` compares and sets on them: a save on a row someone changed since
  answers 409 and writes nothing, rather than the lost update a second writer
  would otherwise let through. The save runs in a transaction that locks its
  row first, so the App's transitions and validation judge the row it
  replaces, and a refusal after the write rolls it back
  (`packages/engine/src/server/recordWriteOperations.ts`, `unrecorded`). API clients editing a
  previously read row must send `expected` with the original values of exactly
  the fields being changed. Omitting it requests an unconditional assignment;
  serialization alone cannot detect that a caller is editing an old image.
- **Plain transactions.** `transaction()` runs at `READ COMMITTED` and takes a
  row lock only where the caller asks with `lockRecord`. That was already
  what a transaction in another pod saw; an App's transactions now see it
  from their own process too, so a read-then-write takes `lockRecord`.
- **Background work.** Job commands, event delivery and the email outbox use the background writer
  (`asBackgroundWork`), one connection of its own, so a job waiting on a lock
  never holds the writer a person's save is waiting for.

**A lock wait gives up.** Every writer connection runs with `lock_timeout`
(5 seconds, `--lock-timeout`, never past the statement cap): a row or table
held by another transaction — another pod, `psql`, a migration's
`ACCESS EXCLUSIVE` — fails the waiting statement with 55P03 instead of holding
its connection, and every save behind it, for the 30-second statement cap. The
transaction rolls back, and the caller hears it as what it is: a save answers
503 with `Retry-After: 1`, code `row_locked`, outcome `not_applied`, and a
command refuses `row_locked` the same way. A migration sets its own
`lock_timeout` and retries its file (`packages/engine/src/server/migrate/runner.ts`).

**Sizing.** A process opens at most `read + write + 1` connections per
database, the one for background work only when needed: nine by default.
Ten pods at the defaults is ninety, under a stock `max_connections` of 100
with nothing else connected; the site's capacity table does the rest of the
sum. A writer serves about `1000 / transaction_ms` saves a second. A save is a
fixed number of round trips, because the writer pipelines: the `BEGIN` with the
row's lock and the row behind it, one flight per awaited write or dependent
read, and a last flight that carries the `COMMIT` with history, notices and the
receipt. A plain save is three, so at 20 ms from the database one writer makes
about sixteen a second and four make about sixty, where the one queue made
about six. This holds through PgBouncer in transaction mode, which is why a
small `max_connections` is enough.
`scripts/write-throughput.mjs` measures it.

**A tenant App holds several of those per process.** `read + write + 1` is one
connection manager's. A tenant App on one PostgreSQL source has a request
reader and a membership reader (`read` each), the tenant writer (`write`, a
reader for record history, the background writer), the administration and
support writers (`write` each), and with them configured the jobs host (`write`
and a background writer), the email outbox and the integrations store (`write`
each), the assistant (one) and two `LISTEN` connections, besides
`MISTRI_AUTH_POOL` for a `postgres://` sign-in store: at most
`3 × read + 6 × write + 5 + auth`. Pools open as they are used and writers
close after 30 idle seconds, so far fewer are held: measured at 6/5/3 with
four people, 16 idle and 22 at the peak, the growth almost all in the two
readers and the auth store. When the database refuses another connection
(53300, "too many connections for role"), the pool goes on with the
connections it holds and a checkout waits for one of them; holding none, it is
answered busy (503).
The log says `connection limit reached: the app write pool holds N of M`, once
in 30 seconds. Size the pools so the peak stays under the role's limit, or put
a pooler in front.

Point the App at a pooler's port (PlanetScale's is 6432, with `--pooler
transaction`) and keep migrations and `pg_dump` on the direct port 5432; see
[Deploy targets](deploy-targets.md#planetscale-postgres). Existing transaction
preflight checks use the read pool and cannot see rows created earlier inside
that same uncommitted transaction.

Verification includes fake-driver tests for initialization, lease cleanup,
transaction isolation, concurrent operations and shutdown races, plus read-only
PlanetScale concurrency checks; `test/postgres-pool-budget.test.ts` (sizes,
queueing, timeouts and the meters, on a fake that enforces `max`),
`test/postgres-pooler.test.ts` (the transaction-mode statements, resets and
cancellation) and `test/connection-pool-config.test.ts` (the setting, the
flags and their refusals), `test/write-lanes.test.ts` (the two orders, the
lanes, the barrier) and `test/postgres-writers-live.test.ts` (writes side by
side, one record's in order, a stale save refused, a lock timeout over HTTP,
the background writer, two processes incrementing one row, and the browser's
one writer with its Undo). `test/postgres-pool-live.test.ts`, live-gated by
`TABLEWALK_TEST_PG`, runs a small pool under concurrent reads, and reuses one
server connection for a write, a leaky session and then a read, as a
transaction-mode pooler would. Live mutation/failure tests require an explicitly
configured disposable PostgreSQL fixture; preview user data is not a test fixture.

## Business commands

A PostgreSQL source runs business commands with the SQLite guarantees: the
handler's effects, the receipt, the bounded write-intent audit and, for an
owner-bound journal, the event batch commit in one transaction or not at all.

- **Tables.** The same two journal tables as SQLite, with the same names
  (`command_meta`, and `command_receipt`: one row per
  command holding its receipt, its audit and its event batch's manifest,
  dated by a `timestamptz` `completed_at` for retention), in the `mistri`
  schema, which holds every runtime table on PostgreSQL (SQLite and MySQL keep
  the `__mistri_` prefix beside the records). The App catalog, the browser and
  MCP hide the schema, and raw SQL refuses it. Identity
  columns are `COLLATE "C"` so the uniqueness constraint is byte-exact
  regardless of the database's default collation. The event store's
  tables (`mistri.event_*`) are provisioned separately, as on SQLite.
- **Migration.** `migratePostgresCommandJournal(url)` from `@mistriwork/mistri/maintenance`
  creates the version-1 layout once, under a server-wide advisory lock so two
  operators cannot race the existence check, and is idempotent afterwards.
  Version 3 keeps one audit row per target for multi-target commands. Any
  other layout under the prefix — an older version or a hand-made one — is
  refused unchanged. An adapter attests the layout when it first opens the journal and never migrates.
- **Attestation.** Compares a description of every relation under the prefix,
  in any schema — columns with types, collations and defaults, every
  constraint and index definition, and the absence of triggers, rules, row
  security and policies — with the one the migration produces. PostgreSQL does
  not keep CREATE text the way SQLite does, so the description is the
  fingerprint. A relation of the same name in another schema is a collision.
- **Transaction and locking.** `commandTransaction` runs `BEGIN` at the
  server's default `READ COMMITTED` on the leased writer client and attests the
  journal before the callback. The journal takes
  `pg_advisory_xact_lock` on a digest of the receipt scope (application,
  store, source, tenant, actor, command, version, idempotency key) in `find`
  and again in `commit`, held to the end of the transaction. Two independent
  connections delivering the same request therefore queue: the second's
  lookup runs after the first commits and replays its receipt, or refuses with
  `idempotency_conflict` when the fingerprint differs. Unrelated commands do
  not wait on each other; `SERIALIZABLE` with retries was refused for that
  reason. The unique constraint remains the backstop for a commit without a
  prior lookup. A duplicate that waits longer than the 30-second statement
  timeout fails `not_applied` and may be retried with the same key.
- **What a request keeps (`track`).** The receipt-first path above is what a
  request with no door keeps (a public form, an import, a tenant App, a command
  that records events), and what a row-policy command keeps whenever it keeps
  receipts. Otherwise the door and the declared `track` decide
  (`packages/mistri/src/server/commands/commandTrack.ts`): a browser's action keeps nothing, and
  its transaction is `BEGIN` with the epoch (below), the target as `when` admits
  it in one read, the handler's SQL and `COMMIT`. A request that keeps receipts
  first asks, in one read and taking no lock, whether its receipt is there — a
  taken one is replayed by the receipt-first lookup, so the handler never runs
  for a retry — and at commit writes the receipt and every audit row in one
  statement, `INSERT … ON CONFLICT DO NOTHING` inside a CTE. A delivery racing
  its original waits on the unique index, writes nothing, rolls back and is
  answered by the original's receipt. `audit` keeps each write's before image;
  `receipts` keeps the audit rows' targets with no changes.
- **The schema epoch.** Attesting the journal was two catalog statements per
  command, the row scope's catalog three more, and each write a relation probe
  and a column read: seven or eight catalog statements a command.
  `provisionStores({ postgres: url }, { only: ['schema-epoch'] })` (`@mistriwork/mistri/maintenance`, a role that may
  create event triggers) adds `mistri.schema_epoch` (bumped by `mistri.schema_epoch_bump()`) and a
  `ddl_command_end` event trigger named `__mistri_schema_epoch` (event triggers
  are database-wide) that appends a row for every DDL but a session's own temporary
  objects. Appending, not bumping one counter, so two DDL transactions never
  wait on each other; the trigger keeps the newest 64 rows, pruning with `SKIP
  LOCKED`. The epoch is a digest of those rows with their `xmin`, the event
  trigger's and its function's row versions (disabled, dropped or replaced:
  no epoch at all), role membership and attributes (shared objects fire no
  event trigger) and `current_user`, read in the message that begins the
  transaction beside the LOCK the scope pinned last time. Everything a write
  transaction asks the catalog is kept under the epoch it read
  (`adapters/epochCache.ts`); a different epoch is a miss, never an answer. A
  message that fails — a pinned table gone, a privilege revoked — rolls back
  and begins again the long way. Without the store, the digest below is read
  instead. Outside the contract, as for the digest: a superuser who sets
  `event_triggers = off` in a session and changes the schema there.
- **MySQL.** Not cached, and no epoch. MySQL has no event triggers, DDL
  commits implicitly, and `information_schema` offers no cheap version: a
  checksum over it costs what the reads it would save cost. MySQL runs no
  commands, and its writes are the Workbench's single edits, which read the
  columns they write, as before.
- **Outcomes.** A failure after `COMMIT` was sent, or a rollback that was not
  acknowledged, is `unknown`; the client is discarded and the next request
  leases a sound one. Everything else is `not_applied`. Status with the same
  request key finds a receipt a lost acknowledgement did commit.
- **Tenant Apps.** A tenant App's commands commit on this journal inside the
  tenant writer's fenced transaction, with the tenant, membership and version
  provenance the host pins in the receipt and audit
  ([below](#tenant-apps)). A tenant App's command events commit the
  same way, beside the receipt inside that fenced transaction, into a
  preprovisioned event store (`provisionStores` with the tenant binding, from
  `@mistriwork/mistri/maintenance`) that `--policy` startup attests and never creates.
  A tenant command's `effects` are delivered per tenant from destinations
  `provisionStores` creates from the App's commands and the tenant binding.

Verification: `test/postgres-command-journal.test.ts` and
`test/business-command-http-postgres.test.ts`, live-gated by
`TABLEWALK_TEST_PG` like the adapter suite.

## Row policies and scoped commands

A PostgreSQL source enrolled with `--policy` runs scoped reads, generic scoped
updates, creation, deletion, exact-image Undo and scoped business commands with
the SQLite guarantees. Startup validates the capability the same way; there is
no CLI flag and no ordinary-writer fallback. Row-scoped reads compile to the
same CTE-per-resource SQL on both engines.

- **Isolation and locking.** `scopeTransaction` and `scopeCommandTransaction`
  run plain `BEGIN` at the server's default `READ COMMITTED` on the leased
  writer client. SQLite gets "the row the scope checked is the row the write
  changed" from `BEGIN IMMEDIATE`, which excludes every other writer; here
  the same guarantee is made per row. Before a target is scope-checked its
  row is taken `SELECT … FOR UPDATE` by primary key, and before a parent's
  visibility is checked its row is taken `FOR SHARE`. A lock waits for an
  in-flight writer of that row, and the guard read that follows takes a fresh
  statement snapshot, so it sees the version that writer committed; nobody
  can commit another until this transaction ends. A row a concurrent writer
  moved out of scope is refused whether it moved before the check or while
  the check waited, and a writer that arrives second waits for the scoped
  commit. `SERIALIZABLE` would prove the same by aborting one side with
  40001, which every handler would have to retry and which the SQLite path
  never produces; the explicit locks make the refusal an ordinary one. A
  scoped read inside the callback (`tx.query`, `tx.count`) does not lock; a
  write's own preflight is what holds the row.
- **Catalog attestation.** The catalog is read on the writer inside the
  transaction — the adapter's own introspection, so the evidence has the
  shape the permissions were bound to — and compared by the server against
  the deployed catalog: table ids, columns with types, nullability, defaults
  and identity, primary keys and every foreign key with its delete rule. Any
  difference on a mapped table refuses before the callback runs. Because
  PostgreSQL has no writer fence, the tables the scope names are first pinned
  with `LOCK TABLE … IN ROW EXCLUSIVE MODE` — the lock an UPDATE takes anyway,
  compatible with every ordinary reader and writer and in conflict with
  ALTER TABLE, CREATE TRIGGER, ADD FOREIGN KEY on either side, CREATE INDEX
  and ENABLE ROW LEVEL SECURITY — and the catalog is read after the pin, so
  DDL that committed earlier is what the attestation sees and DDL after it
  waits for the transaction to end.
- **Writable tables.** A scoped write targets only an ordinary table
  (`relkind` r or p) with a primary key, no user triggers, no rules, no row
  security and no policies, that the writer role may `UPDATE` and that the
  scope named. Views, foreign tables and materialised views stay read-only.
  The same conservative boundaries as SQLite apply: deletes refuse a table
  with any incoming foreign key, updates refuse key and referenced columns,
  and every outgoing foreign key of a stored row must resolve to exactly one
  visible parent.
- **Privileges.** The writer role needs `UPDATE` on every table the policy
  writes, which is also what `FOR UPDATE` and the pin require. A parent table
  the role cannot update is checked without a row lock: its foreign key's own
  `KEY SHARE` still stops deletion, but a concurrent change to the parent's
  scope column is then not fenced. Grant `UPDATE` on parents too where that
  matters.
- **Outcomes and failure.** A caught refusal poisons the transaction: every
  later operation refuses and nothing commits. A failure after `COMMIT` was
  sent, or a rollback that was not acknowledged, is `unknown` and the client
  is discarded; everything else did not commit. Scoped commands attest the
  journal before the catalog is read and compose with the journal's per-scope
  advisory lock exactly as unscoped commands do.

Verification: `test/postgres-scoped-transactions.test.ts` (adapter contract,
concurrency, attestation drift, outcomes and scoped commands) and
`test/postgres-row-policy-http.test.ts` (the enrolled HTTP routes with Undo),
live-gated by `TABLEWALK_TEST_PG`.

## Tenant Apps

A tenant App starts on a PostgreSQL source through the same `auth.rows: 'tenant'` +
`--policy` path as on SQLite; [Tenant Apps](tenant-apps.md#tenant-apps-on-postgresql)
covers authoring, provisioning and what is refused. Its reads, generic writes,
record history, business commands and administration run on the tenant store
and journals below, through private sources the deployment owns — a reader, a
writer and a separate discovery reader, each with its own pool — and an
administration writer.

- **Migration.** `migratePostgresTenantStore(url, binding)` and then
  `migratePostgresTenantAdministrationJournal(url, binding)`, from
  `@mistriwork/mistri/commands`, with the binding a tenant policy declares
  (`{ appId, source: { id, connection }, storeId }`). Each is explicit, runs
  under the server-wide maintenance advisory lock the command journal and auth
  store share, creates its layout once and returns `{ version: 1, migrated }`,
  and is idempotent on the exact layout bound to the same App, source and store.
  Anything else (another version, a hand-made table, an added column or index,
  another binding, a journal without its store) is refused unchanged.
- **Tables.** `mistri.tenant_meta`, `mistri.tenant_tenant` and
  `mistri.tenant_membership`, whose partial unique index allows one live
  grant per tenant and account, and `mistri.admin_meta`, `_receipt` and
  `_audit`, all in the `mistri` schema like the command journal. The App
  catalog hides the schema and scoped commands refuse it. A reporting role
  granted `USAGE` on `public` and `SELECT` on its tables does not make the
  store refuse. The standalone browser's schema
  listing, `/api/sql` and MCP `sql` do not filter it; that reach is the
  connection role's.
- **Exact identity.** Every identity column is `COLLATE "C"`, so equality, the
  live-grant index and discovery order are byte-exact whatever the database's
  default collation is, which is what `COLLATE BINARY` says on SQLite. Ill-formed
  UTF-16 (a lone surrogate) is refused rather than stored as U+FFFD.
- **Attestation.** As the command journal: a catalog description (columns with
  types, collations and defaults, every constraint and index, no triggers, rules,
  row security or policies) compared with the pinned one. Then sole ownership, as
  the auth store requires it: every reserved table owned by the connecting role
  or a role it inherits (a superuser counts only itself), and no privilege held
  by any other role, `PUBLIC` included, since a role that could write the
  membership table could grant itself a tenant. `ALTER DEFAULT PRIVILEGES`
  grants that reach the `mistri` schema (database-wide, or `IN SCHEMA mistri`)
  therefore refuse the migration; ones `IN SCHEMA public` do not.
- **Fence and lock order.** SQLite's `BEGIN IMMEDIATE` orders a membership read
  on the writer against every revocation. Here the ordering is per tenant, with
  row locks held to COMMIT: the business path takes the tenant row, then the
  membership row, `FOR SHARE`; every administrative change takes the tenant row
  `FOR UPDATE`, then the membership row. Whichever locks the tenant row first
  commits first. A revocation, role change or suspension waits for an in-flight
  business commit; a business transaction waits for an in-flight change, then
  reads it (READ COMMITTED takes a fresh snapshot per statement) and refuses
  before its callback runs. A write request reads no membership snapshot of its
  own around this: the fence proves the membership from BEGIN to COMMIT, and a
  revocation committed after the write's COMMIT does not change its answer. The store tables are pinned before the catalog is
  read, `ROW SHARE` on the business path and `ROW EXCLUSIVE` for administration,
  so DDL waits for the transaction. The fence runs on the adapter's writer inside
  its scoped transaction, through a private owner-only hook as on SQLite: after
  the scope's tables are pinned and before the callback, and again before COMMIT.
- **Revisions and states.** The SQLite contract, in shared code: store-created
  decimal-string revisions compared exactly, a stale or create-over-existing
  change refusing the whole transaction, closed tenants and revoked grants
  terminal, and an active grant never reverting to invited.
- **Administration journal.** Receipt and audit rows commit with the metadata
  change in one transaction. Duplicate attempts are serialised by a
  transaction-level advisory lock on the receipt scope, as in the command
  journal, with the unique constraint as backstop; a receipt without its audit
  refuses the journal.
- **Reads.** Each read is one `REPEATABLE READ, READ ONLY` transaction on one
  leased reader. It first locks the mapped tables and the store
  `ACCESS SHARE` — PostgreSQL takes the snapshot at the first query after
  them, and an `ALTER` waits — then compares the whole catalog with the
  deployed one, a pinned `pg_catalog` description of the mapped tables
  (column types and collations, constraints, indexes, triggers, rules, row
  security) with the one captured at startup, and the store's layout, and
  rereads the evidence's membership, unlocked, in that same snapshot before
  any row is released. SQLite pins the stored CREATE text for the same
  reason: catalog authority does not see a collation, and a re-collated
  column must not quietly widen a filter.
- **The attestation is repeated when the catalog moved.** The first statement
  after the locks is one digest of the `(oid, xmin)` of every catalog row
  those comparisons read — namespaces, relations, columns, defaults,
  constraints, indexes, triggers, rules, policies, the types, functions and
  operators in the visible schemas, role membership. The store's meta row is
  data and is read when a source opens, not here. DDL rewrites or removes
  those rows, so it moves the digest. When
  the digest equals the one a full attestation last passed under, that
  attestation stands for this snapshot: one statement instead of eight. When
  it differs, the full comparison runs again and refuses what it always did.
  VACUUM and ANALYZE update `pg_class` in place, and a comment lives
  elsewhere, so neither moves it. The membership is reread in every snapshot
  regardless.
- **A snapshot costs two round trips before its SQL.** The digest has no
  parameters, so `BEGIN`, the locks and the digest travel as one message;
  the membership read is the second. The answer goes back to the caller once
  the snapshot's reads are done, and the read-only `COMMIT` finishes on the
  lease afterwards: it changes nothing the snapshot showed. Behind a
  transaction-mode pooler the per-transaction cap is set straight after the
  `BEGIN` in that same message, so it is in force before the locks can wait.
- **A tenant or platform read is three snapshots at most** once the login's
  admission is kept (below); a request that admits afresh reads the membership
  in one more. Each operation — rows and the count, in parallel — revalidates
  the membership in its own snapshot before its SQL, and the release fence
  observes it once more after the last read and before any byte leaves; a
  metadata read is the fence alone. A platform read no longer observes it a
  third time after the context owner's last session proof: the release fence
  had just run that lease's own guard and then read the membership after the
  last read, as a tenant read's does, and a membership revoked while the read
  runs is refused there or by the next read's own snapshot. A platform-only source's read revalidates the
  platform membership in the App's database first, then reads in its own
  snapshot, attested from a digest of its own catalog the same way. The
  session is resolved from its cookie once per request, and its row is
  observed in the auth store at every step.
- **Admission is kept between one login's requests; its fences are not.**
  Admission verifies the session and reads the membership in a snapshot of
  its own to mint the evidence the fences compare against. The first request
  of a context — its open, switch or renewal, which always admit afresh —
  keeps that evidence, and the login's next requests start from it instead of
  reading it again (`tenantAdmissionCache.ts`). It is safe because admission
  is not what refuses a revoked member: every read revalidates the membership
  in the snapshot its rows come from, a request that may write revalidates it
  in a snapshot before its callback, and a writer holds the tenant and
  membership rows `FOR SHARE` to COMMIT. What is kept, and how:
  - evidence only — never grants, row scopes or refusals, which are computed
    from the evidence on every request; a membership granted after a refusal
    is admitted at once;
  - keyed by App, deployment, store, database, source, account, the native
    session instance and the tenant or `@platform`; a request with no session
    instance, such as an App API token's, neither reads nor fills it, and each
    deployment has its own, so a restart starts empty;
  - served only between the evidence's `verifiedAt` and its `validUntil`, at
    most `maxLifetimeMs` after it was minted, and only after the session has
    been verified again;
  - dropped on sign-out, and whenever the evidence meets any refusal, a
    writer's fence included;
  - evidence the first revalidation refuses is admitted afresh once, and only
    where nothing can have been written: a read (which writes nothing), or a
    request's pre-callback revalidation, before any transaction begins. A
    refusal after a writer's first statement reaches the caller as it always
    did; a command's idempotency key is never spent on a silent second try.
- **Stores are attested when an adapter opens them.** The tenant store, the
  administration journal, the support audit, the invitation store, the command
  journal and the event store are attested in full — the catalog description,
  the meta row's binding, sole ownership and no foreign grant — the first time
  an adapter uses each, inside that transaction, and not again
  (`attestOnce`, `postgresTransactionHandle.ts`). They take no `LOCK TABLE`
  pins, and a fence reads rows only. A statement that fails for a table,
  column or privilege that is not there, or a reference that broke (`42P01`,
  `42703`, `42501`, `23503`), forgets every store that adapter attested, and
  the next use attests in full again; a new adapter (a restart, a writer
  reopened after an uncertain outcome) always does. The trade: a `GRANT`, a
  trigger, an index or a rebound meta row made on runtime tables while a server
  runs is seen at its next start, or at the first statement it breaks, not at
  the next COMMIT. The database role is the boundary, as `reservedSql.ts`
  says: a role that may alter runtime tables could already change what any
  check reads. A `FOREIGN KEY` on another table that references a store table
  is not in the attestation; it needs `REFERENCES` on the store table, which
  only the store's owner holds.
- **The tenant predicate** is plain `=` with no `COLLATE`: ownership columns
  are attested `text` or `varchar` under a deterministic collation, where
  equality is byte-exact, so the column's own indexes stay usable. SQLite
  writes `COLLATE BINARY` instead.
- **Writes and commands.** Inside the adapter's verified scoped transaction
  on the writer. The scope's writable tables are pinned `ROW EXCLUSIVE` and
  the catalog read — described again only when the same digest, read just
  before the description, has moved since the writer last described it; the source pins any other mapped table `ACCESS SHARE`,
  attests the catalog, the description, the store and tenant-local unique
  keys from `pg_index`, and takes the fence before the callback runs. The
  fence runs again after the callback's operations drain, before COMMIT, and
  each operation checks the lifetime — clock, lease, close — when it executes.
  That second pass reads nothing: the rows it locked are still locked, so a
  kind whose fence is only those row locks (member, platform, intake, service,
  platform-tenant) checks the lifetime alone; a support write reads again.
  SQLite re-verifies membership around every operation because its check is a
  snapshot read; the held row locks make that reread redundant here.
- **Where the fence is taken:**

  | Operation                                                 | Pins                                                                      | Fence                                                                                                                |
  | --------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
  | Read, count, view, breakdown, membership check, discovery | mapped tables `ACCESS SHARE`, one read-only snapshot                      | unlocked reread of tenant and membership in that snapshot                                                            |
  | Generic write, record history and Undo                    | writable scope tables `ROW EXCLUSIVE`, other mapped tables `ACCESS SHARE` | tenant row, then membership row, `FOR SHARE` before the callback, held to COMMIT                                     |
  | Business command                                          | as a write                                                                | the same, with receipt and audit on the same writer                                                                  |
  | Administration                                            | none on the stores                                                        | tenant row, then membership row, `FOR UPDATE`, read before the change so the audit's before-image is what is changed |

- **Outcomes.** As the adapter's: a failure after COMMIT was sent, or an
  unacknowledged ROLLBACK, is `unknown` and closes the writer rather than
  reusing it, until it reopens attested; a failed read snapshot rollback is a
  connection the server ended, so that read is refused (503) and the reader's
  pool is replaced, never the source: one lost connection must not refuse
  every later request of the process.

Verification: `test/postgres-tenant-store.test.ts` (one case creates and drops
a NOLOGIN role, so the role needs CREATEROLE); the tenant read-source,
write-source, command-source and record-history suites, which run on SQLite
and, live-gated, on PostgreSQL; and `test/postgres-tenant-http.test.ts`, a
hostile two-tenant HTTP proof through startup, native auth and administration.
The tenant suites work in databases of their own beside `TABLEWALK_TEST_PG`,
created once, so the role needs CREATEDB.

## Authentication store

An App that signs people in keeps its Better Auth store in a SQLite file of
mistri's own by default. Set `auth.store` in the manifest to a
`postgres://` URL and the same store lives in PostgreSQL instead — the same
field, the same Better Auth, its own PostgreSQL adapter (a `pg` pool) under
it. Nothing else in the manifest changes.

- **Setup.** `auth: { store: "postgres://auth:${AUTH_DB_PASSWORD}@db/authdb" }`.
  The manifest is committed, so name the password — or the whole URL, as
  `"${MISTRI_AUTH_STORE}"` — by `${NAME}` reference; an unset variable
  refuses at startup rather than expanding to nothing. Only the braced form
  is expanded in a store URL: a bare `$` there is literal, so a password
  containing `$abc` is used as written (a business connection's URL also
  accepts `$NAME`). A file path is never expanded. The database is one
  dedicated to sessions: a role that owns it, `BETTER_AUTH_SECRET` in the
  environment as before, and the `pg` package installed.
- **Tables.** Better Auth's four (`user`, `session`, `account`,
  `verification`, with the admin plugin's columns), the account-administration
  trail (`accountAudit`, append-only by two `DO INSTEAD NOTHING` rules, which
  bind every role where a trigger would need a function the schema may not
  hold) and a `meta` row, in the `mistri` schema as `mistri.auth_user`,
  `auth_session`, `auth_account`, `auth_verification`, `auth_account_audit`
  (every Better Auth plugin table is `auth_`-prefixed too) and `auth_meta`,
  never `public`. Each
  transaction runs `SET LOCAL search_path = pg_catalog, mistri, pg_temp` —
  `pg_catalog` named first so nothing in the schema can shadow a built-in,
  `public` not at all, and never a session `search_path`, so PgBouncer's
  transaction mode is safe — so those names resolve there and nowhere else.
- **Ownership.** The runtime resolves names inside the schema, so the
  schema has to be the connecting role's alone (provisioning runs `CREATE
  SCHEMA IF NOT EXISTS mistri` then `REVOKE ALL ON SCHEMA mistri FROM PUBLIC`;
  a flag or experiment control role running as its own role needs `GRANT USAGE,
  CREATE ON SCHEMA mistri TO <role>`). The migration and every
  startup attestation require the schema and every table in it to be owned
  by the connecting role, or by a role whose privileges it inherits (so a
  deployment can migrate as one member of an owning group role and run as
  another); a superuser, an implicit member of every role, counts only
  itself. No other role, `PUBLIC` included, may hold `CREATE` on the schema
  or any privilege on its tables or columns, and the schema may hold nothing
  but the store's tables: no functions, procedures, aggregates, operators,
  types, domains, collations, conversions, operator classes, text-search or
  statistics objects, or extensions. A schema another role created, or
  planted something in, is refused by the migration rather than adopted, and
  by startup after the fact; the refusal says what is wrong and changes
  nothing.
- **Migration.** `migratePostgresAuthStore(url)` from `@mistriwork/mistri/maintenance`
  creates the schema (owned by the role that runs it) and its layout once,
  under the same server-wide advisory lock as the journal migration, and is
  idempotent afterwards; it returns `{ version: 2, migrated }`. Run it from
  the deployment's maintenance script before starting the server, exactly
  as the command journal is migrated. A version 1 store — exactly the
  previous layout, with or without the API token extension — is brought up
  by adding the trail and nothing else. Any other content under the schema
  name — a hand-made table, an added column or index — is refused
  unchanged. Startup attests the layout and never migrates: an
  unmigrated database refuses with the maintenance step named, and creates
  nothing. The pinned layout is what the installed Better Auth's own
  migration planner would create, and the test proves the planner has
  nothing to add over it; a Better Auth upgrade that changes its schema is
  a new store version here, not a runtime `ALTER`.
- **Attestation.** A description of every relation in the schema — columns
  with types, collations and defaults, every constraint and index
  definition, no triggers, row security or policies, and no rules but the
  trail's two — compared with
  the one the migration produces, read under a transaction-local
  `search_path` pinned to the schema so a foreign key into `public."user"`
  describes differently from one into the store's own table on every
  connection alike; then the ownership rule above.
- **Separation.** The store may not be a business database. Three checks
  say so, each with the file rule's error (`Authentication storage must
  remain separate from the captured business database and its SQLite
  sidecars.`) unless noted, and a SQLite connection is never a collision:
  - _Before anything is opened,_ each URL is read the way the driver reads
    it — pg-connection-string, so `?host=` and `?port=` override the
    authority, with pg's defaults and `PGHOST`, `PGPORT`, `PGDATABASE` and
    `PGUSER` filling what the URL leaves out — and a store reaching the same
    host, port and database as any configured connection is refused. Hosts
    compare by what they reach: every name for this machine (`localhost`,
    `*.localhost`, `127.0.0.0/8`, `::1` and its mapped forms, `0.0.0.0`, a
    Unix socket directory, the machine's own hostname and interface
    addresses) is one host, and case, trailing dots and IPv4/IPv6 spellings
    are canonicalised. The password and role are not compared, and `${VAR}`
    references on a connection are expanded first.
  - _Once the store is open,_ every configured PostgreSQL connection is
    dialled as the registry dials it and asked for its server's identity —
    `system_identifier` from `pg_control_system()`, executable by `PUBLIC`
    on a stock server — and its `current_database()`. The same server and
    the same database refuse, whatever the URLs said: a port forward, a
    proxy, a DNS alias, another role. A role that cannot read the identity
    leaves it unknown, and unknown is treated as the same server, so a
    matching database name refuses. (A streaming replica shares its
    primary's identity, which is right: it serves the same data.)
  - _In depth,_ a connection whose role has `USAGE` on a `mistri`
    schema on the store's server, in any database, is refused
    (`… connection "name" can use a "mistri" schema on the
    authentication store's PostgreSQL server …`). The standalone browser's
    SQL box and the MCP `sql` and `explain` tools run the operator's
    statements without a schema filter, so it is the role's reach that is
    refused; SQL text is never parsed for schema names.
  - A PostgreSQL connection that cannot be reached at startup is a refusal
    too (`Could not confirm that connection "name" is separate from the
    authentication store …`), since nothing would check it later. An App
    server offers no connection management, so the configured connections
    are all of them.

  In the other direction, a business PostgreSQL adapter pointed at the
  store's database never lists `mistri` — not by default and not
  when `--schema mistri` names it — and refuses a generic insert,
  update or delete into it (`Reserved resources are runtime-only.`).
  Tenant deployments (`--policy` with a tenant App) may use it too, beside a
  SQLite or a PostgreSQL business source. Their strong session proof reads
  the file store synchronously, inside the commit; this store cannot be read
  that way, so it is read asynchronously at the owner's last await before
  COMMIT — on every tenant request, again after a write's or command's
  callback, and at each administration step — and a revocation that lands
  between that read and COMMIT is refused on the next request. Invitations on
  a PostgreSQL business source work with either native auth-store engine; on a
  SQLite source they need the file store, whose final invitation verifier is
  synchronous, and startup refuses the pair.

- **Sessions and restart.** A session is a row, not process state: a server
  restart, or a second instance on the same store, sees every session the
  first issued, and a sign-out on one is a sign-out on all. The startup log
  names the store by a fixed label, `postgresql auth store (schema
  mistri)` — no host, user or database, since any of them may be an
  expanded `${NAME}`. `MISTRI_AUTH_ADMIN_EMAIL` / `_PASSWORD` bootstrap
  the admin account once; a later start finds it.
- **Pool.** Four connections at most, 10-second acquisition, 30-second idle
  expiry and statement timeout, ended when the App's auth closes; at
  startup, one short-lived connection per configured PostgreSQL connection
  for the separation check. Count it with the business pools when planning
  capacity.

Verification: `test/postgres-auth-store.test.ts`, live-gated by
`TABLEWALK_TEST_PG` like the adapter suite (it creates a sibling database
and four roles, so its role needs CREATEDB and CREATEROLE); the store
selector, `${NAME}` expansion and the URL comparison alone, without a
server, are `test/auth-store.test.ts`.

References: [node-postgres Pool API](https://node-postgres.com/apis/pool) and
[transaction client ownership](https://node-postgres.com/features/transactions).
