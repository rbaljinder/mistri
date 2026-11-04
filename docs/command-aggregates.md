# Command aggregates and cursors

A design note, not a guide. It answers a field report (a banking sandbox,
finding F10): a command's typed `db` can read rows but cannot sum or group
them, and cannot walk a large table, so a reconciliation job loops over bounded
pages in App code. It proposes the smallest addition that closes that, says
how row policies and footprints bind it, and lists the decisions it needed.

**Decided 2026-11-01.** Every recommendation below was approved as written:
the query chain (1), decimal-string sums and averages (2), exact SQLite
decimal sums in the shared compiler (3), the table's own columns only (4),
`avg` from the exact sum and count (5), `snapshot: true` as an opt-in (6),
cursor positions as plain data (7), the bounds as listed (8), checkpoints
through workflows (9), and streaming documents parked (10). The commands page
(`site/src/content/docs/docs/commands.md`) is the guide to what was built;
where the build departed from this note, the note says so beside the part.

## The gap, verified

The report is right about the shape and slightly understates what exists.

| Claim | What the code says |
| --- | --- |
| A command's `ReadTable` has `get`, `find`, `where`, `count`; a query has `orderBy`, `limit`, `first` | Exactly that: `packages/mistri/src/server/commands/commandDb.ts:86-101`. No sum, group, offset or cursor |
| Reads are bounded | More than 1,000 rows without `.limit()` is refused, not cut (`commandDb.ts:190`, `:413-414`). `.limit(n)` itself reaches 100,000 rows per read (`clampLimit`, `engine/src/shared/reads.ts:23`, `:169-173`), so a handler can pull a large slice and add it up in JavaScript, which is what the report's App does |
| The raw `tx` is no way out | `ctx.tx` (`businessCommands.ts:161`) has `query`, `count` and the writes, with `offset` on `query` (`engine/src/adapters/adapter.ts:126-137`, `:611-626`). Still no aggregate |
| Dashboards aggregate under policy | `ScopedReads.runBreakdown` (`adapter.ts:765-776`) compiles the breakdown through the reader's row scope (`adapters/scoped/scopedReads.ts:165-169`, `ScopedRelations` in `shared/breakdown.ts:360`), behind the reader's grants (`engine/src/server/columnGrants.ts:572-590`, `server/app/appAccess.ts:408-412`) |
| Commands lack the equivalent | The command transaction exposes only `query` and `count` from those scoped reads (`adapters/scoped/scopedTransaction.ts:322-323`); `WriteTransaction` has no aggregate member |
| Jobs have no database handle | By design (`server/jobs/jobs.ts:18-23`): an App job runs a command as a service principal (`examples/apps/lintel/jobs.ts`), so a job's reads are a command's reads |

Two things the report did not name, both relevant to money:

- **SQLite sums decimals as floats.** A `numeric(12,2)` column is stored as an
  integer or a REAL, and `SUM` over it is a REAL. Rows of 0.10, 0.20, 0.07 and
  100,000,000,000,000.00 sum to `100000000000000.38`; the exact answer is
  `.37` (checked on SQLite 3.51 under `node:sqlite`). The declared scale is
  reapplied only to a column, not to an expression (`adapters/sqliteDecimals.ts`),
  so the dashboards' sums share this today. On PostgreSQL `numeric` is exact
  and `SUM` of an integer column is `bigint` or `numeric`, both read as text
  by `pg`.
- **PostgreSQL commands run at READ COMMITTED** (`adapters/postgres.ts:1458-1465`):
  each statement sees what had committed when it ran. One aggregate statement
  is consistent with itself; a sum followed by a page in the same command may
  not be. SQLite commands run under `BEGIN IMMEDIATE` on the one writer
  (`adapters/sqlite.ts:1402`), so every read in a command sees one state.

MySQL is not a question here: Apps refuse it (`MYSQL_REFUSAL`,
`engine/src/adapters/connect.ts:31`).

## What reuses, and what does not

- **The breakdown compiler** (`shared/breakdown.ts`) already does count, sum,
  avg, min, max, up to three keys, date buckets, a bounded group count, and
  compiles under a `RowScope`. A command aggregate is a `BreakdownDef` over one
  table, run on the command's transaction. No second compiler.
- **Keyset paging** (`shared/keysetPage.ts`) already turns "after this row, in
  this order" into a filter (`keysetAfter`, `:90`), refuses orders that are not
  total or not faithful (`keysetOrder`, `:46-57`), and is "an additional AND on
  columns the reader already sorts by", so every scope and grant checks it. A
  cursor is that filter plus the primary key.
- **Not reused: reference paths.** Under a row policy a command's scope sets
  every table outside its read footprint to `false`
  (`commands/scopedBusinessCommandAccess.ts:155-167`). A breakdown keyed by
  `customer_id.region` would join to an empty relation and answer a null group:
  a wrong answer, not a refusal. So command aggregates take the table's own
  columns only (decision 4).

## The proposal

### Aggregates

On the existing query chain, so `where`, the template form and `limit` mean
what they mean now:

```ts
import { sum, count, max } from '@mistriwork/mistri/commands';

// One number. Always a decimal string: exact on both engines.
const held = await db.hold.where({ account_id, status: 'active' }).sum('amount_minor'); // '1834500'

// Grouped: one row per key, keys first, then the measures by the names given.
const balances = await db.entry
  .where`status = posted and posted_on <= ${input.through}`
  .groupBy('account_id')
  .aggregate({ posted: sum('amount_minor'), entries: count(), last: max('posted_on') })
  .limit(1000);
// readonly { account_id: number; posted: string; entries: number; last: string | null }[]
```

- Measures: `count()`, `count(column)` (non-null), `sum`, `min`, `max`, `avg`.
  `groupBy` takes up to three columns, or a date bucket
  (`groupBy(month('posted_on'))`), the breakdown's `MAX_KEYS` and `DATE_UNITS`.
- Without `groupBy`, `aggregate` answers one object, never an array.
- Results: `count` a number; `sum` and `avg` a canonical decimal string (`'0'`
  for `sum` over no rows, `null` for `avg`); `min` and `max` the column's own
  type or `null`. Never `Number()` on a sum (decision 2).
- On SQLite a `decimal(p,s)` column sums as
  `SUM(CAST(ROUND(col * 10^s) AS INTEGER))` read as a BigInt and said with `s`
  places, exact while each stored value times 10^s is below 2^53. The same
  change goes into the shared compiler, so dashboards get exact sums too
  (decision 3). Where the limit lies: a REAL times 10^s must stay below 2^53,
  an integer times 10^s and the total below 2^63. Past either the sum refuses
  loudly (`ExactnessRefusal`, a `RequestFault`: `invalid_result`, marked as the
  author's fault, naming the column) and never answers a rounded or wrapped
  number; SQLite's own `integer overflow` on a total is the same refusal. The
  same refusal reaches a dashboard that sums the column.
- A float column (REAL, double precision, SQLite's `NUMERIC` with no places)
  has no exact digits, so its `sum` and `avg` are JS numbers; strings are for
  exact decimals and integers. PostgreSQL's unconstrained `numeric` is exact,
  and its mean is PostgreSQL's own text (`0.00075000000000000000`), not
  rounded to two places. A column's places on PostgreSQL come from the catalog
  (`ColumnMeta.scale`, from `numeric_scale`), beside the type string the
  browser shows.
- `avg` is computed in the server from the exact sum and count, rounded half to
  even, not by the engine's `AVG` (which disagrees across engines).
- Typing: column names are `keyof Row`, as `orderBy` is today. A `sum` over a
  text column is a runtime refusal marked as the author's fault
  (`authorFault`, `engine/src/shared/refusal.ts`), naming the column, because `Rows` types
  a PostgreSQL numeric and a text column alike as `string`
  (`server/typegen.ts:52-58`).

**As built.** Three departures. A date bucket is `period.month('posted_on')`
(also `hour`, `day`, `week`, `quarter`, `year`, `weekday`), one export rather
than seven generic names beside `sum`; the group's key keeps the column's name.
A sum over no rows is zero with the column's places (`'0.00'`), not `'0'`, so
a sum's places never depend on whether rows matched. Ordering groups by an
`avg` orders by the engine's own mean, asked for that alone; the value answered
is still the exact one. An author's mistake (a reference path, a text column
summed, a bound passed) is `invalid_result` marked as the author's fault; a
forged page boundary from a caller is `invalid_input`.

### Cursors

```ts
// One page, resumable: the position is data the caller keeps.
const { rows, next } = await db.entry.where({ account_id }).page({ after: input.after, size: 500 });

// Every row, inside one command, bounded.
for await (const entry of db.entry.where({ account_id }).iterate({ size: 500 })) { … }
```

- Order: the primary key ascending unless `orderBy` says otherwise; the key is
  appended to any order so it is total, and an order `keysetOrder` refuses (a
  JSON, money or float column, no primary key) is refused here, not degraded
  to an offset.
- `next` is a plain boundary, `{ posted_on: '2026-10-01', id: 812 }`, or
  `undefined` at the end. It is a position, not a capability: the next page is
  read under whoever asks for it, under that request's scope. A boundary that
  names other columns than the order is refused.
- `iterate` checks the command's `signal` between pages and reads at most
  100,000 rows in one command; past that it refuses and says to page across
  commands (below). The last page is cut to what the bound leaves, so no row
  past it is ever yielded.
- A group key is any readable column of the table, whatever its spelling
  (`_tag`, `región`): the statement aliases it and the answer keys it by the
  column's name. No key or measure may answer as `__proto__`, `constructor` or
  `prototype`, which on an object reach its prototype, not a field. A raw
  request does not say which text columns are dates: the App's catalog does.

**As built.** A nullable column in a page's order is refused, beside the
orders `keysetOrder` refuses: the two engines place nulls at opposite ends, and
a boundary on a null cannot say which side the next page starts.

### Snapshots

| Engine | Inside one command | Across commands |
| --- | --- | --- |
| SQLite | One state: `BEGIN IMMEDIATE`, one writer, nobody else writes until commit. The cost is that a long walk holds every other writer | None: each batch commits |
| PostgreSQL, default | Each statement its own snapshot (READ COMMITTED). A row inserted behind the cursor is not seen, one ahead is; a row whose order key changes can be seen twice or never; a primary-key order avoids the last | None |
| PostgreSQL, `snapshot: true` | Every statement one snapshot (`REPEATABLE READ`; `READ ONLY` too for a command that writes nothing, as `postgresReadSnapshot.ts:43` already opens). A writing command whose update meets a concurrent one fails with 40001, said as `conflict` and retried by a job or workflow as any conflict is | None |

No database snapshot survives a commit, so a walk across many commands is made
consistent by the App's data, and the note says so rather than pretending: the
first step records a high-water mark (`max(id)` of an append-only ledger, or a
cutoff instant), and every batch adds `id <= through`. For an append-only
ledger that is exact; a mutable row is read as it stands when its batch runs.

**As built.** `snapshot: true` opens `BEGIN ISOLATION LEVEL REPEATABLE READ`
(`adapters/snapshotRead.ts`, read once where the write transaction opens, as
the write-ahead hint is) and 40001 is said as `stale_record`, the refusal jobs
and workflows already retry; there is no `conflict` code. It does not add
`READ ONLY`: a command always has a target and, unless it keeps nothing, writes
its receipt, so the engine cannot know at `BEGIN` that it will write nothing.

### Checkpoints

Workflows already are durable checkpoints: a step's output is recorded and an
advance after a restart walks the recorded steps and continues at the first
missing one (`server/workflows/workflowEngine.ts:1-24`, `w.run` returns the
command's output, `workflowModule.ts:127`). A resumable reconciliation is then:

```ts
async run(w, start) {
  const { through } = await w.run('mark', 'ledgerMark', { input: { as_of: start.as_of } });
  let after: Boundary | undefined;
  for (let batch = 0; ; batch++) {
    const out = await w.run(['batch', batch], 'reconcileBatch', { input: { through, after } });
    if (!(after = out.next)) break;
  }
}
```

Each batch is one command: one transaction, one receipt, its writes atomic. A
cancel stops between steps; finished batches stay committed, so a batch must be
safe to have happened alone. No new store (decision 9).

### Bounds and cancellation

- Groups: more than 1,000 without `.limit(n)` is refused, as rows are.
- Pages: `size` 1 to 1,000. `iterate`: 100,000 rows per command.
- Every statement runs under the adapter's statement ceiling
  (`STATEMENT_TIMEOUT_MS`, `adapters/statementControl.ts:20`) and the command's
  `signal`. PostgreSQL cancels the backend; SQLite runs a statement on the
  server's thread and stops only between statements, so one aggregate over a
  huge SQLite table blocks the process as a dashboard metric over it does
  today. The build must confirm the ceiling reaches the command writer, not
  only the read pool.
- A refusal is never a truncation: no call returns part of an answer silently.

**As built.** Confirmed: the PostgreSQL writer's session sets
`statement_timeout` to the same 30-second ceiling and `lock_timeout` to five
seconds (`postgresPool.ts`, asserted in `test/postgres-pool.test.ts`), and
`SET LOCAL` per transaction behind a pooler, so a command's aggregates stop as
a dashboard's do. SQLite's writer has no ceiling; the commands page says so.

### How policy and footprints bind

Nothing new is trusted. Each call becomes a request on the command's own
transaction, so it passes exactly what `query` and `count` pass now:

- **Footprint:** the table must be one of the command's `read` (the handle
  exists only for those; the raw `tx` maps its table name through
  `binding.table` and refuses others, `commands/businessCommandAccess.ts:172-195`).
- **Row policy:** under a policy the aggregate compiles under the command's
  scope (the actor's, or the service principal's for a job), the same
  `ScopedRelations` a dashboard metric uses; in a tenant App also under the
  tenant bound. A group whose only rows are hidden does not exist.
- **Elevation:** a table in `elevate.read` is read under the command's
  authority, as `where` reads it there now; aggregates add no new elevation,
  and `mistri check --design` already lists each one.
- **Columns:** a handler reads its footprint whole, withheld columns included
  (the commands page says so); aggregates follow, and only the declared output
  reaches the caller.
- **No raw SQL.** The measure function is one of the breakdown's words
  (`MEASURE_FUNCTIONS`), the columns are checked against the catalog, values are
  bound parameters.

### What `mistri check` validates

A handler's code is opaque to check, so its column names and measure words are
held by the App's typecheck (which check runs) and by runtime refusals that
name the fix. Check adds one declaration rule: `snapshot: true` is refused on
an HTTP source (no transactions) and said to be a no-op on SQLite. Footprints
need nothing new: an aggregate reads only tables `read` already declares.

**As built.** `[command-snapshot]` in `mistri check` (`app/appSnapshotChecks.ts`):
a problem on an HTTP source, a warning on SQLite, judged by the engine of the
command's target.

## Tests that would prove it

- **Agreement.** For random rows and random row policies, on SQLite and on
  PostgreSQL (the serial lane), every `sum`, `count`, `min`, `max`, grouped or
  not, equals the same measure computed with BigInt over the rows `where`
  returns under the same scope.
- **Policy bypass, each expected to fail closed:** a group key that exists only
  in hidden rows; `min`/`max` over a hidden row's value; another tenant's rows;
  a table off the read footprint through the handle, through the raw `tx`, and
  through a template `where`; a reference path in `groupBy` or a `where`
  (refused); a forged `after` boundary taken from a hidden row (pages only
  visible rows after it); a cursor issued to one actor replayed by another
  (read under the second actor's scope); a service principal reading only what
  its policy names; a value spelled `x" or 1 = 1` in a template (quoted).
- **Exactness:** zero, negatives, a sum past 2^53 on both engines, the SQLite
  decimal case above to the cent, `avg` rounding half to even, an empty table.
- **Concurrency:** on PostgreSQL, a second connection inserting during a
  `snapshot: true` walk is not seen and is seen without it; a concurrent update
  under `snapshot: true` answers `conflict` and leaves nothing written.
- **Cancellation:** aborting mid-`iterate` answers `cancelled` and writes
  nothing.
- **Resume:** a workflow killed after batch k resumes at k+1, runs no batch
  twice (receipts), and its totals equal a single-pass answer.
- One `test/combinations.test.ts` case: aggregate x row policy x tenant App.
- One sample App uses it for real (a ledger check in Lintel or Ignition), with
  its own e2e assertion.

**As built.** `test/command-aggregates.test.ts` holds agreement, the policy
bypass cases, exactness, bounds, cancellation, `elevate` and the workflow
resume over fixed rows chosen so each hidden row would change an answer, not
random ones; `test/tenant-command-aggregates.test.ts` the tenant bound;
`test/command-snapshot.test.ts` the snapshot (its PostgreSQL concurrency cases
run where `TABLEWALK_TEST_PG` is set); `test/combinations.test.ts` the
aggregate × row policy × tenant App case, with a mutation in
`scripts/combination-proof.mjs`. No sample App uses it yet.

## Decisions (approved 2026-11-01)

1. **API shape.** On the query chain (`where().groupBy().aggregate()`, plus
   `.sum(col)`) or a separate `db.t.aggregate(def)` object. *Recommend the
   chain*: `where`, templates and `limit` already mean one thing.
2. **Number representation.** `sum` and `avg` always a decimal string, `count`
   a number, `min`/`max` the column's type. *Recommend yes*: on PostgreSQL an
   integer sum already arrives as text, so typing it `number` would be a lie on
   one engine.
3. **Exact SQLite decimal sums, in the shared compiler.** *Recommend yes*, in
   the same change, so a dashboard's total and a command's agree to the cent.
   It changes what some existing dashboards show by a cent at large totals.
4. **Local columns only** in keys, measures and wheres. *Recommend yes* for the
   first release; reference paths need a footprint check per hop and can come
   later on evidence.
5. **`avg`.** Ship it, computed from the exact sum and count, half to even, at
   the column's scale plus two places (integers: two). *Recommend ship*; the
   alternative is leaving it out and letting authors divide.
6. **`snapshot: true` on PostgreSQL** as an opt-in command declaration.
   *Recommend yes*, not a default: REPEATABLE READ turns concurrent updates
   into retries, which ordinary commands do not need.
7. **Cursor positions as plain data**, not signed tokens. *Recommend plain*:
   the position grants nothing, every page re-reads under its own scope, and a
   workflow input must be JSON anyway.
8. **Bounds:** 1,000 groups without `limit`, pages of at most 1,000, 100,000
   rows per `iterate`. *Recommend these*; they match the existing read limits.
9. **Checkpoints through workflows**, not a new batch-job primitive.
   *Recommend workflows* plus the resume test; revisit only if replaying a few
   thousand recorded steps per advance proves slow.
10. **Streaming documents and exports** (the report's last ask). *Recommend
    parking it* in its own note: lists already export under an export grant,
    and a document's row cap is a rendering question, not a command one.

## Later

- Streaming documents and exports (decision 10): parked, to be taken up in a
  note of its own if a report asks for more than a list export gives.

## Build estimate

About **22 agent-hours**, or **12** for aggregates and cursors alone with
decisions 6 and 9 deferred.

| Part | Agent-hours | Files |
| --- | --- | --- |
| Aggregate on the transaction, every facade | 6 | `engine/src/adapters/adapter.ts`, `adapters/scoped/scopedTransaction.ts`, `adapters/scoped/scopedCommandOperations.ts`, `adapters/sqlite.ts`, `adapters/postgres.ts`, `engine/src/server/columnGrants.ts`, `mistri/src/server/commands/businessCommandAccess.ts`, `commands/scopedBusinessCommandAccess.ts`, `server/tenant/tenantCommandTransaction.ts`, `server/tenant/tenantManagedTransaction.ts` |
| Exact sums and the handle's API and types | 4 | `engine/src/shared/breakdown.ts`, `adapters/sqliteDecimals.ts`, `mistri/src/server/commands/commandDb.ts`, the `@mistriwork/mistri/commands` entry |
| `page` and `iterate` | 3 | `commandDb.ts`, `engine/src/shared/keysetPage.ts` (reused), `commands/businessCommandExecution.ts` (signal) |
| `snapshot: true` | 3 | `commands/businessCommands.ts`, `adapters/postgres.ts`, `adapters/postgresTransactionHandle.ts`, the check rule |
| Workflow recipe and resume test | 2 | a test, the workflows page |
| Tests (SQLite, PostgreSQL serial lane, adversarial, combinations) | 3 | `test/command-aggregates*.test.ts` (`command-aggregates-engines.test.ts` is the PostgreSQL lane), `test/combinations.test.ts` |
| Docs and a sample App | 1 | `site/src/content/docs/docs/commands.md`, `CHANGELOG.md`, Lintel or Ignition |

Policy reads (`policy/policyDb.ts`), page loaders (`commands/pageLoaderRun.ts`)
and command availability share the handle, and `aggregate` reaches each through
the same scoped reader, under its rows and granted columns, as built. A tenant
App's readers carry it too (`server/tenant/tenantReadSource.ts` and the support,
platform and public runtimes), pinned to the member's tenant and answering what
`count` answers in each realm; `test/tenant-read-aggregates.test.ts` is the
proof.
