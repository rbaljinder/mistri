# Trigger effects under a row policy

Status: **approved 2026-11-01**, with the recommended option on every
decision (the last section says which). Built in rc.11 as Preview.

## Where this starts

Under a row policy (`auth.rows: 'policy'`) or a tenant's scope, every write a
person makes is bounded by the rows the policy gives them. A database trigger
runs inside that write and reaches whatever its body says, which the policy
never sees. Until rc.11 a table with any trigger could not be written under a
row policy at all. A field report met this on its ledger: a validation-only
`BEFORE UPDATE OF posted_minor … RAISE(ABORT, …)` refused an update of
`status` that could never fire it. To ship, the App dropped 25 integrity
triggers and moved their work into command handlers. Direct SQL lost those
safeguards.

rc.11 builds the part that needs no new authority (`scopeTriggers.ts`,
`sqliteTriggers.ts`, `postgresTriggers.ts`, `commandTriggerChecks.ts`):

- **Firing.** A trigger blocks only the writes that fire it: its event, and for
  `UPDATE OF` its columns. A definition the engine cannot read fires on every
  write.
- **Validation-only.** A trigger proven to read only `NEW`, `OLD` and literals,
  raise or do nothing, and write nothing blocks nothing. It is a `CHECK`
  constraint written as code. The grammar is narrow on purpose, and anything
  outside it fails closed. On PostgreSQL the function's version is read again
  before `COMMIT`, because `CREATE OR REPLACE FUNCTION` takes no lock the pinned
  table conflicts with.
- **`mistri check`** names each command whose writes reach a blocking trigger
  (`[command-trigger]`).

What is still refused is the field report's other 20-odd triggers: projections
(posting an entry updates its account's balance), audit (a change appends a
history row), and checks that read another table (an entry's account must be
open). This note is about those.

## What a trigger can do that a policy cannot see

1. **Write rows the person cannot.** `UPDATE account SET … WHERE id = NEW.account_id`
   writes whichever account the new row names. If `NEW.account_id` is another
   customer's account, the person has written outside the policy.
2. **Read rows the person cannot.** A trigger that raises when a hidden row
   exists, or has some value, says so through its error. That is an existence
   leak even when the trigger writes nothing.
3. **Chain.** A write the trigger makes fires the next table's triggers.
4. **Change after review.** `CREATE OR REPLACE FUNCTION` or
   `DROP TRIGGER … CREATE TRIGGER` changes what runs while the App's authority
   stays the same.
5. **Escape the transaction's rules.** PostgreSQL: `SECURITY DEFINER`,
   `search_path`, dynamic `EXECUTE`, deferred constraint triggers that run at
   `COMMIT`, and `dblink` or foreign tables. SQLite: `RAISE(ROLLBACK)`, which
   ends the transaction the platform holds.

A design is safe only if it covers all five.

## The DSL: what an App declares

### Option A: name the trigger, derive its effects (recommended)

The App names each trigger it relies on. The platform reads what the trigger
does from its definition through a narrow **keyed-effect grammar** (below). The
authority lock records the derived effects. The App never writes the effects by
hand.

```ts
resource('ledger_entry', {
  access: 'write',
  // The triggers this App accepts on this table. One not named here blocks
  // the writes that fire it, exactly as today.
  triggers: ['post_balance', 'entry_audit'],
});
```

`authority.lock` gains one line per accepted trigger:

```
trigger ledger_entry.post_balance on insert sha256:3f1c…
  writes account.posted_minor where account.id = NEW.account_id
trigger ledger_entry.entry_audit on insert, update, delete sha256:9a07…
  inserts entry_history where entry_history.entry_id = NEW.id
```

- Naming is the approval, and the lock line is the review. If a DBA adds a
  trigger, it blocks until it is named. If its SQL changes, the hash moves and
  the lock goes stale.
- There is one way to say it, and nothing hand-written can disagree with the
  SQL.

### Option B: declare the effects in the App

```ts
triggers: {
  post_balance: { on: ['insert'], writes: { account: { columns: ['posted_minor'], where: { id: 'NEW.account_id' } } } },
}
```

The platform then checks that the derived effects equal the declared ones.
This is more to write and adds a second statement of the same fact. It helps
only where derivation is impossible, and there the trigger is refused anyway.
**Not recommended.**

### Option C: no App change; accept anything that parses

This is the smallest change. A trigger added to the database by someone
outside the App widens what a person's write reaches, with no review. **Refused.**

## The keyed-effect grammar

This extends rc.11's validation grammar. Each statement in the body must be one
of these:

- A validation statement, as today: `IF … THEN RAISE …`, or SQLite
  `SELECT RAISE(ABORT, '…') WHERE …`.
- **A keyed write:** `UPDATE t SET c = <expr> [, …] WHERE <key> = NEW.x [AND …]`,
  `INSERT INTO t (cols) VALUES (<expr>, …)`, or
  `DELETE FROM t WHERE <key> = OLD.x`. The `WHERE` must be equalities that cover
  a primary or unique key of `t`, against `NEW` or `OLD` columns. Values are
  expressions over `NEW`, `OLD`, the target row's own columns (`c = c + NEW.amount`)
  and literals, with the same function and operator allowlist as validation.
- **A keyed read:** `IF (SELECT c FROM t WHERE <key> = NEW.x) <cond> THEN RAISE …`.
  It uses the same key rule, reads one row, and has no aggregates.

The following are still refused:

- A predicate that is not a key (`WHERE status = 'open'`).
- Aggregates over other rows, such as the sum of an account's entries.
- `EXECUTE`, `PERFORM`, and assignment to `NEW`.
- Unqualified table names on PostgreSQL. These resolve through `search_path`
  when the function runs, so they must be schema-qualified, or the function
  must pin `search_path` with a `SET` that the lock records.
- `SECURITY DEFINER`, statement-level triggers, transition tables, and
  constraint or deferred triggers.
- `RAISE(ROLLBACK | FAIL | IGNORE)`.
- A write to a reserved `mistri` table, or to a table the App does not declare
  as a resource.

From the grammar, the platform knows exactly which rows the trigger touches,
as a function of the row being written.

**Chains.** A keyed write fires the effect table's own triggers. Those must be
validation-only or accepted keyed-effect triggers, to a depth of 4. A cycle
(`a → b → a`) is refused when the catalog is read.

## Runtime enforcement

### Option 1: prove before writing (recommended)

Before the statement that fires an accepted trigger, the scoped transaction
works out the keys the trigger will touch. It takes them from the request's
values, plus the old row it already reads and locks for the update guard. It
then checks each key against the policy:

- **Written keys** must be in the person's *write* scope for that table. This is
  the check a parent key already gets (`scopedTransaction.ts`), and it uses the
  same row lock: `FOR UPDATE` on PostgreSQL, while SQLite's `BEGIN IMMEDIATE`
  already holds the database. That way the account's owner cannot change between
  the check and the trigger's write.
- **Read keys** must be in the person's *read* scope. A key outside it is refused
  with the same answer as writing a hidden row (`temporarily_unavailable`, never
  "it exists").
- **Inserted rows** (audit) must satisfy the write scope of the table they land
  in, judged on the row the trigger will insert. Its values are expressions over
  `NEW` and `OLD`, so they are computed before the write.

Cost:

- **SQLite.** Parsing is cached per schema epoch, as today. Each effect adds one
  indexed read in process, a few microseconds.
- **PostgreSQL.** Parsing is cached under the catalog digest. The key checks
  join the guard read the write already makes, so each table touched adds no
  round trip and one row lock per effect key. The before-`COMMIT` function
  re-read that rc.11 makes for validation triggers covers keyed-effect
  functions too: one query, only when such a trigger fired.

### Option 2: verify after writing, before COMMIT

Instead of predicting the effects, the platform would observe them:

- **SQLite** could attach a session (`DatabaseSync.createSession()`) to the
  writer and read the changeset before `COMMIT`. That gives every row changed in
  every table, which is exact and cheap.
- **PostgreSQL** has no equivalent inside a transaction. There are three ways
  to get one, and none works:
  - `xmin = pg_current_xact_id()` finds inserted and updated rows only by
    scanning each table, and cannot see deletes.
  - A mistri-owned statement trigger with transition tables on every effect
    table is DDL on the App's tables.
  - Logical decoding happens after the commit.

So PostgreSQL, the main target, cannot rely on this option. **Recommended only
as SQLite defense in depth**, after Option 1, if the session cost measures
small.

### Rollback

Every effect runs in the command's own transaction. That covers the trigger's
writes and what the platform already writes there today: the command journal's
receipt, the command's events and its notifications. Whether record history is
written there for every path is to be confirmed when this is built. A refusal before the write
or at `COMMIT` rolls all of them back together. Two things are new:

- **Live sync and record history.** These do not see trigger-made changes,
  because they hear about writes from the platform and not from the database.
  The derived keys tell the platform which rows changed, so it can announce
  them. Without that, an open account page does not refresh when an entry is
  posted.
- **Double-applies.** If a command writes `account.posted_minor` and an
  accepted trigger on the same event does too, the change is applied twice.
  `mistri check` reports this as a problem (`[trigger-double-write]`).

## What stays refused

These stay refused even after this design is built:

- Any trigger that is not named in `triggers`.
- Any trigger outside the grammar: dynamic SQL, non-key predicates, aggregates,
  calls to user functions, `SECURITY DEFINER`, statement-level triggers,
  deferred triggers, and cycles.
- A key outside the person's scope. A trigger never gives authority. A
  transfer that settles both sides needs a principal whose scope covers both,
  such as the policy's service. An ordinary customer can never reach the other
  side through a trigger.
- Raw SQL and MCP writes under a policy. Those are refused today, and this
  design leaves them refused.

## Adversarial tests (both engines)

1. A trigger keyed to `NEW.account_id`, with the request naming another
   customer's account, is refused before the write. No row changes.
2. Same as test 1, keyed to `OLD`, through an update that moves the row.
3. A body that writes by a constant (`WHERE id = 2`) or a non-key predicate is
   refused when the catalog is read.
4. A trigger that is accepted and then replaced (`CREATE OR REPLACE FUNCTION`)
   mid-transaction is refused at `COMMIT`. The projection, receipt, event and
   live change are all absent.
5. A trigger that is accepted and then changed between runs leaves the lock
   stale. The server refuses to start, and `check` names it.
6. In a chain, the effect table's trigger writes a third table that is not
   declared: refused. A cycle: refused.
7. A keyed read of a hidden parent is refused with the hidden-row answer, never
   an answer that tells the rows apart.
8. A concurrent change of the account's owner between the check and the
   trigger's write is serialized by the row lock. A test interleaves two
   connections.
9. An unqualified table name with a hostile `search_path` schema is refused on
   PostgreSQL.
10. A trigger declared on a table the App does not list as a resource is refused.
11. Rollback after each posting stage: entry inserted, account projected,
    history appended, refusal. Each stage leaves nothing behind.

## Migration path for an App that removed its triggers

The steps follow the field report's retirement checklist, mapped onto what
ships when.

**Possible now (rc.11):**

1. Upgrade on a branch and run the field report's probe. An update of `status`
   succeeds, and a negative balance is refused by the trigger.
2. In a new forward migration, restore every validation-only trigger:
   - negative balances;
   - immutable postings and statements (`BEFORE UPDATE … RAISE`, which fires
     on every update and always raises);
   - hold reuse, where the check is on the row's own columns.

   Do not rewrite the migration that removed them. Run `mistri check`. A
   restored trigger it names is not validation-only. Leave that one in the
   handler for now.

**After this design is built:**

3. Restore the projection and audit triggers, name them in `triggers`, and
   review the `authority.lock` diff.
4. In the same rollout, remove the handlers' duplicate account, activity,
   budget, goal and hold mutations. `[trigger-double-write]` names any left
   behind.
5. Keep command-level eligibility, idempotency and friendly refusals. The
   triggers supplement them.
6. Run the full suite with the triggers enabled. Add direct-SQL tests for each
   restored invariant and the adversarial tests above on the App's own tables.

**Still the App's after either:**

7. Checks that aggregate, such as an unbalanced statement on sealing. Keep these
   in the sealing command, or in a deferred check that the command runs.

## Decisions (approved 2026-11-01)

Each was approved with its recommended option:

1. **DSL shape: Option A.** The App names each accepted trigger in
   `resources.<table>.triggers`; the platform derives its effects through the
   keyed-effect grammar and records them in `authority.lock`. Nothing about the
   effects is written by hand.
2. **Enforcement: Option 1, on both engines,** with SQLite's session check
   (Option 2) kept as defense in depth: a change outside the proven set rolls
   the transaction back and refuses it.
3. **Release: before 1.0, as Preview.**
4. **Live sync and history: yes to both.** Live sync announces the rows a
   trigger changed, and record history covers them, attributed to the trigger
   and to the command that fired it.
5. **`[command-trigger]` stays as it is:** a warning when a trigger blocks
   only some writes, a problem when it blocks every write of the table.
6. **Chain depth: 4.** A deeper chain is refused.

The questions as they were put:

1. **DSL shape.** Recommended: Option A, where naming the trigger in
   `resources.<table>.triggers` is the approval and the effects are derived and
   locked. Option B is the alternative.
2. **Enforcement.** Recommended: Option 1, prove before writing, on both
   engines. Should the SQLite session check (Option 2) be added as defense in
   depth? It would be measured first.
3. **Release.** The key is new DSL. Ship it before 1.0 as Preview, or after
   1.0? After 1.0 nothing moves, so if it is to be Stable at 1.0, it must ship
   in an rc.
4. **Live sync and history for trigger effects.** Recommended: announce the
   derived keys. Is record history for trigger-made changes wanted, or is the
   database's own audit trigger enough?
5. **`[command-trigger]` severity (rc.11).** Today it is a problem when the
   triggers block every insert, update and delete of the table, and a warning
   when only some writes are blocked. The check cannot know which writes a
   handler makes. Should a partial block also fail `check`?
6. **Chain depth.** Recommended: 4. Is any chain deeper than 2 expected?

## As built (rc.11)

Where the build departs from the design above, and why.

- **Effects never write the trigger's own table.** An effect on the table it
  fires on would change rows the write is still proving; it is refused. A
  delete effect is refused on any table a foreign key references, as the
  person's own delete is: a cascade's rows are not keyed, and a `NO ACTION`
  or `RESTRICT` reference would refuse the delete exactly when some row,
  hidden or not, still points at it, which would tell the person that it
  exists.
- **Keyed reads are read where the grammar can see them.** On SQLite, a
  `SELECT` inside the body; on PostgreSQL, an `IF` condition. A read anywhere
  else leaves the trigger outside the grammar.
- **On SQLite the key is the primary key**, since that is what the session
  (Option 2) can match a change by: an `INTEGER PRIMARY KEY`, or a primary key
  whose index compares under each column's own collation. A `UNIQUE` column is
  not one; an effect keyed by it is refused when it is read (`is not by the
  primary key of it`). On PostgreSQL the key is a primary key or a valid,
  immediate, non-partial unique btree index whose columns compare under their
  own collation and their type's default operator class.
- **A key's two sides compare as the proof compares.** Each column of the key
  and the column of `NEW` or `OLD` it equals must have the same type and the
  same collation, or the row the statement finds is not the row the proof
  read: `'abc' = 'ABC'` under `NOCASE`, `char(3)` padded against `text`, a
  `name` truncated to 63 bytes, `int8` widened to `float8`. On SQLite the type
  is the column's affinity (a column with none holds `3` and `'3'` as two
  keys); on PostgreSQL it is the base type through domains, with its modifier,
  and the parsed key must show no cast or conversion of either side. A key
  under a nondeterministic collation is refused, since equal is not one value
  there.
- **PostgreSQL refuses `SET search_path` on the function.** Pinning it would be
  the safer form, but a function's settings are not read by the grammar yet,
  so a pinned one is refused rather than trusted; effects need a
  schema-qualified table (adversarial 9).
- **An effect row must exist and be in the person's rows.** An `UPDATE` that
  would match no row is refused like a hidden row, so a missing row and a
  hidden one answer alike (adversarial 1).
- **Every row an update, a delete or a keyed read reaches is named by a key
  known before the statement.** A key that only the write assigns (a serial
  or rowid id, a value an earlier effect computes from one, or an explicit
  NULL in a rowid alias or identity column) is refused when it is proven. A
  first build proved such a key straight after the statement, but by then
  the effect's own triggers had run on a row nobody had judged. Only an
  insert may wait: its row is judged against the policy straight after the
  statement, and only when no trigger on that table reads or writes another
  row by a key.
- **A row is reached once.** Two effects of one statement that reach the
  same row are refused when either write fires a trigger that reads or
  writes another row: the second would be proven against an image the first
  has already changed. The triggering row counts as reached.
- **An inserted row's place in the policy is judged in memory** against the
  rule's conditions, which supports `=`, `in` and null tests. A rule beyond
  those, or a column the policy depends on that the trigger computes, is
  refused.
- **The command's policy widens.** When a command writes a resource that names
  triggers, the scope carries the person's row rule for every resource of
  that source (scopedBusinessCommandAccess.ts), so an effect on a table the
  command does not write is still judged, and stays within those rows. The
  handler's own reads and writes are still limited by its footprint.
- **A parent is judged before the write as its foreign key judges it, and a
  missing one answers as a hidden one.** Every reference an insert or update
  sets, the person's own or an effect's, is checked against the person's
  rows before the statement runs, with the value the column will store (an
  empty string for a nullable reference is NULL, "7.0" for an integer one
  is 7). On PostgreSQL the value is read as the referencing column's type,
  named by its schema and with its modifier as digits
  (`pg_catalog."numeric"(10,2)`): `format_type` named `text`, which the
  search_path resolves when the statement runs, and a domain `public.text`
  over `name` made mid-transaction, with `pg_catalog` after `public`, read a
  64-character key as its first 63 and found a visible key where the foreign
  key found a hidden one. It is compared by the constraint's own operator (`conpfeqop`, with the casts
  `ri_triggers.c` makes): by `=` and the value as given, a `char(3)` 'ab '
  found the text key 'ab ' where the foreign key finds 'ab'. The value is
  coerced as the write coerces it, by the column's type with its domains
  unwrapped, so a domain over `integer` takes "" as NULL and "7.0" as 7.
  Neither side is cast to a pseudo-type (an enum's `anyenum`). A value the
  check takes from the stored row (the other column of a composite reference
  an update sets in part, every reference checked again after the statement,
  a column of `NEW` or `OLD` an effect copies) is read as `col::text` in the
  statement that reads the row and bound as that text (`storedText.ts`),
  never as the driver's reading of it: that reading once dropped an array's
  lower bounds and rounded a `jsonb` number past 2^53, and the check found
  the visible parent the reading named while the update committed onto the
  hidden one the stored value names. Such types are no longer keys (below),
  and the text is still what is bound. SQLite's foreign
  key applies the parent's affinity to the stored value, the check to the
  value written. They part only where the child column's affinity changes
  the value in a way the parent's does not undo: a number column against a
  `TEXT` key ("7.0" stored as 7 reads "7"), and anything but a `BLOB` column
  against a typeless key, which converts nothing. Such a reference is refused
  to a scoped write that sets it; a typeless or `BLOB` reference, two columns
  of one affinity, and a `TEXT` reference to a numeric key are checked. A row
  that references itself by the key it is written with has no parent to
  read. A first build left a missing parent to the database's own foreign
  key, whose error differed from the refusal a hidden parent gets; what the
  check still cannot judge before the write (a reference the write names
  only in part) is left to that foreign key, and its refusal is said as the
  check's. An effect whose reference only the write computes (a default, an
  expression) is refused when it is proven.
- **A key is of a type that reads back exactly.** Six reviews found the
  same defect in a new place each time: a check bound a key's value as
  something other than what the database compares. The driver read a `jsonb`
  key as JavaScript (past 2^53 rounded, `"123"` as `123`), SQLite said a
  `numeric(10,2)` key with its scale (`19.987` as `19.99`), and a `float8` or
  `timestamptz` key's text followed the session's `extra_float_digits`,
  `DateStyle` or `TimeZone`. Fixing each value left the class open, so under
  a row policy a column that is a row's identity (a primary key, either side
  of a foreign key, either side of an effect's key) must be of a type on an
  allow-list, and any other is refused from the catalog, before a value is
  read, with the table, the column and its type (`keyTypes.ts`). On
  PostgreSQL, a domain read as the type it is over: `text`, `varchar`,
  `char`, `citext`, `name`, `smallint`, `integer`, `bigint`, `numeric`,
  `uuid`, `date`, `boolean` and enums. On SQLite, `INTEGER` or `TEXT`
  affinity; a typeless column may still reference such a key, which its
  foreign key compares as the check does. A scoped transaction on PostgreSQL
  pins `DateStyle` to `ISO`, `IntervalStyle` and `extra_float_digits` for
  itself (`SET LOCAL`, in the message that says `BEGIN`, so no round trip is
  added): those change only how a value is said. `TimeZone` is not pinned,
  since it changes what a written timestamp means. A scoped read on SQLite
  keeps a key's value as stored, never as a decimal column's display. A
  `boolean` key is accepted as a reference; a write that names its own row
  by one is refused when its value is read, as before. Every table an
  effect reaches, by any key, takes the same primary-key gate as the
  write's own row: a seventh review keyed an effect by a unique `text`
  column of a table whose primary key was `jsonb`, and the change told to
  history and live sync named a hidden row by the driver's reading of
  that key. The trigger is refused from the catalog (`whose primary key
  cannot name its rows`). On SQLite, a key declared as another engine's type
  (`UUID`, `STRING`, `DATETIME`, `BOOLEAN`, `GUID`) has `NUMERIC` affinity,
  and its refusal says to declare it `TEXT` or `INTEGER`.
- **A reference with a generated column is checked after every update.** It
  moves with the columns its expression reads, which no update names: an
  update of `x` re-pointed `k GENERATED ALWAYS AS (x + 1) REFERENCES p` at
  a hidden parent, by a person's write or an effect's. Its value is not
  known before the statement, so it is checked after it, from the stored
  row; a missing parent (refused by the foreign key) and a hidden one answer
  alike. A key or a referenced column that is generated, and that the
  update moved, is refused as a key the update names is.
- **No table in a partition or inheritance hierarchy is written under a
  row policy, for now.** A partitioned table, a partition at any level, an
  inheritance parent and an inheritance child are each refused as a scoped
  write's target and as an effect's table, read or written, when the
  catalog is read (`is part of a partition or inheritance hierarchy, which
  writes under a row policy do not support yet`). An eighth review found
  that a foreign key declared on a partition alone, one pointing at a
  partition, and an inheritance child's own keys were all missed by a
  write through the table above them: a cascade reached hidden rows and a
  reference to a hidden row went unchecked. Following each would mean
  reading every member's keys for each write; the surface is narrowed for
  1.0 instead. A reference from an ordinary table to a partitioned one still
  works: PostgreSQL copies the key onto each partition of the referenced
  table, the catalog leaves those copies out (`conparentid`), and the check
  counts the parent through the partitioned table the policy names.
- **A target that joins a hierarchy while the write runs is refused at
  COMMIT.** The scope's pin takes ROW EXCLUSIVE on each table, which holds a
  target against becoming a partition or a child (ATTACH PARTITION and
  `ALTER TABLE … INHERIT` take ACCESS EXCLUSIVE on the table attached) but
  not against becoming a parent: `ALTER TABLE c INHERIT t` and `CREATE TABLE
  c () INHERITS (t)` take SHARE UPDATE EXCLUSIVE on `t`. No lock closes
  that without blocking writes. In PostgreSQL's conflict table SHARE UPDATE
  EXCLUSIVE conflicts with SHARE UPDATE EXCLUSIVE, SHARE, SHARE ROW
  EXCLUSIVE, EXCLUSIVE and ACCESS EXCLUSIVE; the last four conflict with
  ROW EXCLUSIVE, the mode of every ordinary INSERT, UPDATE and DELETE, and
  the first conflicts with itself, so every scoped write of a table would
  wait on the one before it (and on VACUUM and ANALYZE). So the tables the
  transaction wrote (and, where a target's trigger ran, every table its
  effects can reach) are read again for a hierarchy just before COMMIT, by a
  statement sent with the COMMIT that fails where it finds one, answering
  the COMMIT as a ROLLBACK: no round trip is added. Under READ COMMITTED it
  sees every inheritance committed before the transaction's last write was
  planned, and a write planned before an inheritance committed did not
  expand into the child. Before it, a child attached mid-write brought a row
  whose own key pointed at a hidden row, and an update through the parent
  committed it (`test/postgres-scoped-references.test.ts`).
- **A reference to an inheritance parent is refused.** Its foreign key
  checks the parent's own rows (`ONLY`), while the parent check reads the
  parent with its children, so a child's row visible to the person passed
  for a hidden parent row under the same key, and the insert committed
  pointing at it (a field report). A parent check whose table is an ordinary
  table with inheritance children (`ScopeCatalog.inheritanceParents`, read
  in the catalog's existing facts statement) refuses the write instead; a
  NULL reference checks nothing and still commits. Reading the parent with
  `ONLY` was not chosen: for a partitioned table it would read no rows. A
  partitioned table is not refused, since its key and its check both read
  every partition. A referenced table that becomes an inheritance parent
  while the write runs is caught by the same statement the COMMIT carries,
  over the tables the written ones reference; there a table that became a
  parent refuses the write whether or not a reference to it was checked.
- **Known limits.** A schema author's own code (a DEFAULT, a CHECK, an
  IMMUTABLE function) that calls `set_config` could undo the transaction's
  pinned settings; a principal cannot cause that. On SQLite an integer key
  past 2^53 is refused, since the driver cannot read it back exactly: it
  fails closed.
- **On SQLite, a delete cannot say `OR ABORT`.** A scoped insert or update
  says `OR ABORT`, which overrides the conflict clause of every statement a
  trigger it fires runs; SQLite has no `DELETE OR ABORT`, so under a scoped
  delete a trigger's insert into a table declared `PRIMARY KEY ON CONFLICT
  REPLACE` would replace a hidden row. An insert or update effect on a table
  whose schema declares any conflict clause but `ABORT` is refused. The
  session check also matches each change by its operation as well as its
  key, since SQLite reports a replaced row as an update.
- **On SQLite the session also watches the command's own rows.** A change
  to a row the transaction wrote itself stays direct however many triggers
  write that row after it (`sqlite3session_indirect`), and the session check
  passed every direct change. It now keeps what the changeset says of each
  row a statement of the transaction wrote, and refuses, after each later
  statement and before `COMMIT`, a change to it the proof did not reach
  since. A row is known by its key as stored, read back after the
  statement (before it, for a delete): the changeset names the row so, and a
  `NOCASE` key the command named as "ABC" is the row "abc", and a `BLOB` key
  is its bytes as `x'…'` hex, as the changeset says them. A trigger's
  write to that row inside the very statement that writes it folds into the
  statement's own change and is not told apart. A command that deletes a
  `NOCASE` row and inserts it again under another case is refused: the
  changeset folds the two into one update named by the deleted row's case,
  which the session does not match to the row inserted. That fails closed and
  is left so.
- **On PostgreSQL a key's `=` is its column's own.** An `=` resolves through
  the search_path, so one created ahead of `pg_catalog` could match any row.
  Each equality of a key must be strategy 3 of the default btree operator
  class of its column's type, and the catalog queries that judge keys and
  effects name their own operators (`OPERATOR(pg_catalog.=)`). So does every
  other catalog read the scope makes, the facts that find triggers, the
  foreign and primary keys the description reads and the catalog digest
  among them: a polymorphic built-in loses to an exact-typed function of
  the same name anywhere on the search_path, and `public.cardinality(text[])`
  answering 0 read every table as having no triggers. So does an App's
  scoped read: each comparison on a column of a built-in type, the policy's
  and the reader's own filter alike (`=`, `<>`, the ranges, an IN list as
  `= ANY` of the list read as the column's type, and a pattern as `~~*` of
  `like_escape`), names pg_catalog's operator, and a policy of `false` is
  `WHERE FALSE`. pg_catalog has no `varchar = varchar`, so a schema author's
  exact one in public answered every varchar comparison, and a `1 = 0` with
  pg_catalog after public on the path admitted every row
  (`test/postgres-scoped-read-operators.test.ts`). A column of a type the
  database defines (an enum, citext, an extension's) keeps its own operator,
  which is what that column means, and still resolves through the
  search_path; so do the key joins between scoped relations, which pair two
  rows the reader may already read, and the trigger's statements. The
  database's owner sets the search_path.
- **`mistri check` reads what the write reads.** Besides the keys, it reads
  whether a table is in a partition or inheritance hierarchy, its row-level
  security, rules and the writer's privileges, and on SQLite each table's
  conflict clauses, so it refuses the effects the write refuses. A refusal names a
  collation with its schema (`"public"."sv"`), since two schemas can hold
  one name.
- **The lock is required, and pins through the App.** A write pins the
  digest the lock approved; a named trigger the lock has no line for, or an
  App that names triggers and keeps no lock, pins one no definition has, so
  the write is refused. `mistri check` reports it as `[trigger-lock]`, and
  the server checks the lock at start, in the policy's acquire. A first build
  let an App without a lock pin nothing and read the definition again, which
  a changed definition could pass unreviewed.
- **History and live sync for an insert whose key the database assigned.**
  Nothing reads the key back, so it has no history row, and live sync
  announces its table as `many`.
- **`[trigger-double-write]` is a warning, not a problem.** A command's
  footprint names tables, not columns, so the check cannot tell a handler that
  writes `account.posted_minor` from one that writes `account.status`. A
  problem would refuse the second; the warning names the trigger's columns.
- **Tenant Apps keep Part 1.** `resources.<t>.triggers` is read under a row
  policy only; a tenant App's named trigger is still refused.
- **PostgreSQL judges every expression in an effect, as it judges a
  condition.** The grammar reads only the shape of a keyed statement: which
  table, which key columns, which columns it sets. Each expression in it
  goes to the same temporary view the conditions go to, and is judged by
  the same rules: node kinds, immutable functions and operators that are
  the database's own or C, and a domain's input for a literal. A keyed read
  goes in as itself. An update's key goes in as `(SELECT true FROM ONLY
  <table> WHERE <key>)`, and each of its values as `(SELECT (<value>) FROM
  ONLY <table>)`, so a bare name in it resolves to that table's column, as
  it does in the statement. An insert's values go in bare, where a bare name
  finds nothing, as in `VALUES`. The view holds exactly one scalar subquery
  for each of these, and no other. One rule is added for writes: a value
  other than a bare literal must have its column's type, or reach it by a
  binary cast or one whose function is proven pure. Both sides are taken
  through their domains, because an assignment cast runs the cast's
  function. A literal is read by the column's own type, and a domain's
  checks there are the table's own code. CURRENT_DATE, CURRENT_TIMESTAMP
  and LOCALTIMESTAMP go in as a NULL of their type. They are keywords, which
  no search_path shadows, and their stored form is a node the condition
  rules refuse. A qualified function name is outside the grammar, as it is
  in a condition.
- **The grammar is stricter than PostgreSQL's lexer only where effects
  need it.** On top of the tokenizer the conditions use (PostgreSQL's
  whitespace, nothing past ASCII or `$` outside a literal), a definition
  with effects must also pass `plainDefinition` (scopeTriggers.ts): it
  refuses a vertical tab and an `IN` without a parenthesized list.
  Effects widen what a write reaches, so they are held to the strictest
  reading on both engines.
- **The code a write to an effect's table runs is judged as the person's
  own write would be.** A CHECK constraint, a default, a generated column,
  an expression index, a partition key or a domain that calls a function
  of the database's is read first (readPostgresTableCode). It counts among
  that table's triggers, so an effect whose write would run it is refused:
  `its write to "public.te_account" runs the CHECK constraint "te_seen", it
  calls te_peek(integer)`. A table in a partition or inheritance hierarchy
  is still refused as an effect's table.
- **Loaded where used.** The effect judge, the proof and the SQLite session
  witness load on a scoped write, or where an App names triggers. They do
  not load when the process starts, so `--mcp` loads no more modules than
  before.

Tests: SQLite in `test/trigger-effects.test.ts` (1, 2, 6, 7, 10, 11, and
keys known only after the write, a row reached twice, keys whose two sides
compare differently, conflict clauses under a delete, delete effects on a
referenced table, hidden and missing parents, a trigger's write to a row the
command wrote itself),
PostgreSQL in `test/postgres-trigger-effects.test.ts` (1, 2, 4, 7, 8, 9, 11, an effect's table that runs code of the database's, and the same key cases plus casts, index collations and an `=` from the search_path),
the person's own hidden and missing parents in
`test/row-scope-transaction.test.ts` and
`test/postgres-scoped-transactions.test.ts`, a parent compared as its
foreign key compares in `test/scoped-references.test.ts` and
`test/postgres-scoped-references.test.ts`, the catalog reads and the
parent check's cast against a function or type of the same name on the
search_path in
`test/postgres-scope-search-path.test.ts`, check's facts in
`test/command-trigger-check.test.ts`,
the grammar in `test/trigger-effects-grammar.test.ts` (3, 6, 9), the lock in
`test/trigger-lock.test.ts` (5, both engines), and history and live sync in
`test/trigger-effects-sync.test.ts`.
