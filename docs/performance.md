# Performance notes

Measurements that a budget or a decision rests on. Each says how it was taken,
so it can be taken again.

## A database a network away

Every request that reads the database pays the round trip once per statement
it has to wait for, so what matters is the number of sequential waves, not
the number of statements. `scripts/delay-proxy.mjs` stands a local
PostgreSQL 16 a network away by holding each chunk 10 ms each way (a 20 ms
round trip, the next availability zone):

```sh
node scripts/delay-proxy.mjs --listen 55433 --to 127.0.0.1:5432 --ms 10
```

Point a connection at the proxy's port, serve the built App
(`node dist/server/index.js --config … --app …`) and ask for a record page
twice; the second is the warm one. The schema epoch store is provisioned
(`provisionStores(…, { only: ['schema-epoch'] })`), so a warm request reads no catalog.
The target is a warm record page under 300 ms.

Measured on a laptop with a load average near 17 (other work was running), so
the absolute figures are upper bounds; the wave counts are exact (PostgreSQL's
`log_min_duration_statement = 0`, one request).

Compass and Keystone are the CRM and Keystone regression fixtures
(`test/fixtures/apps/crm`, `test/fixtures/apps/keystone`) since 0.9.2; the
figures were taken when they were samples.

| Page | Statements | Sequential waves | Warm document, 20 ms RTT | Same, no proxy |
| --- | --- | --- | --- | --- |
| Compass, lead 127 | 12 | 2 | 73 ms quiet, median 180 ms loaded | 31 ms best, median 89 ms loaded |
| Keystone Lender, an application | 17 (was 31) | about 7 | 285 ms (was 385 to 420 ms) | not taken |

In a browser (navigation until the record's last section paints, median of 14
warm loads, loaded machine): Compass 380 ms through the proxy against 360 ms
direct, so the remote database adds about 40 ms (two waves) and the rest is
the client; Keystone Lender 1.0 to 1.6 s.

Compass meets the target on the server. Keystone Lender's application record
now does too, narrowly. The shell's navigation badges were some 16 `COUNT(*)`
statements that queued four at a time on the pool, because an App's
multi-source adapter and its row-scoped reader did not pass `countEach` on: the badges of one source are now one
statement (a `UNION ALL` of bounded counts under one set of scope CTEs, each
badge keeping its own row policy and filter), and a view count, which cannot
join that statement, runs beside it instead of ahead of it. Measured on the
same laptop (load average above 30, so these are upper bounds), 20 ms RTT,
median of five warm requests of one application: 31 statements (21 counts)
and 385 to 420 ms before; 17 statements (7 counts) and 281 to 297 ms after.

What remains is the record's own chain of about six dependent statements (the
row, its row-scope check, the sections) and the two badges that count through
a rollup (a view count each, `decision_alert` and `payment`), which wait one
wave behind the first paint's reads. The next cost to remove is the chain.

Without the epoch store a Keystone request also reads the catalog and the
store's meta row (two more waves, 31 statements); that is the reason to
provision it for a database that is not on the same host.

## What a save costs

A save is a fixed number of round trips, not one per statement: flight 1 is the
`BEGIN` with the record's lock and row behind it, then one flight per awaited
dependent read or write, then one that carries the `COMMIT` with history,
notices and the receipt. Preparing a command is `BEGIN` and `COMMIT`, and a
one-click command skips it. At 25 ms from the database, a warm Qualify lead in
Ignition executes in 6 round trips (0.38 s); before the writer pipelined it took
28 (1.58 s). `test/write-flights.test.ts` holds one write of each sample App to
its budget against a 10 ms relay, and fails a write that falls back to one
flight per statement.

## What the client costs a browser

Moved here from the site's Performance page, which now covers sizing and
measuring only. The client ships built in the package; nobody builds anything.

| First page | Script, brotli |
| --- | --- |
| Sign-in screen or public form | 163 KB |
| An App page | 314 KB |
| The Workbench | 318 KB |

- **Only what the page draws.** The SQL editor, dashboards and charts, boards
  and calendars, the New form and the account dialogs load the first time they
  are used, and the server preloads each page's part. `npm run build` fails
  when the first paint passes its budget (`scripts/bundle-budget.mjs`).
- **Nothing moves.** A page is shown once its room has answered, and a release
  is held to Web Vitals tighter than Google's "good": layout shift 0.01,
  largest paint 1.2 s, interactions 100 ms on a slowed CPU
  (`npm run test:built:vitals`).
- **A return visit downloads nothing.** Assets are content-named and served
  `immutable`; `index.html` answers 304. Each has a `.br` and `.gz` beside it,
  and source maps ship beside the minified code.

## What typechecking an App costs

In a project that installs the package, with TypeScript 7 (the native
compiler, the minimum), on an Apple M2:

| App | Tables | Cold `tsc` |
| --- | --- | --- |
| Compass | 12 | 0.2 s |
| Ignition regression fixture | 20 | 0.3 s |
| Generated, with tenancy | 150 | 0.8 s |

The budget is 5 s cold at 150 tables (`scripts/type-budget.mjs`, run by
`npm run build`), held mostly by counting the types the checker makes, which
do not depend on the machine. Record pages cost the most, since each section is
checked against every table.

## What the server asks of the database

What Compass asks is counted per request, on SQLite and PostgreSQL, so an
unintended statement fails a test.

- **Few statements.** The catalog is read once per connection: Compass's first
  view after start is 1 statement, a list page 2.
- **Bounded counts.** A filtered list counts to 10,000 and says `10,000+`;
  turning a page does not recount. A list's tab badges are one `/api/counts`
  request and, where each tab's conditions are on the table's own columns, one
  statement; so are the menu's counts. A dashboard's breakdowns are one
  `/api/breakdowns` request.
- **A record page is one request.** `/api/pages/compose` answers every read its
  open sections will ask, each under the reader's own grants. A press on a row
  starts it before the click is over; a closed tab reads nothing.
- **A tenant App's first page is one request past its lease.** `/api/boot`
  answers the runtime, the App, its pages and schema and the first room's
  reads on one context, so a list or a record settles in four rounds
  (who-am-I, the member's tenants, the lease, the boot) where it took six or
  seven (`e2e/tenant-boot-budget.spec.ts`).
- **No catalog on a warm write.** A command's transaction checks one epoch
  (SQLite's schema version; on PostgreSQL the epoch store).
- **Pages by key.** Next, Previous and Last read the rows after or before the
  ones on screen; a typed page number is read by offset, refused past 10,000.
- **Long SQLite reads off the thread.** A count, filter or sort over 250,000
  rows or more (or a SQL view) runs in a child process, stopped at 30 seconds.
- **Jobs wake on commit.** An idle `--jobs` host polls from every second to
  every 30; on PostgreSQL a commit wakes it at once by `LISTEN`/`NOTIFY` (not
  behind a transaction-mode pooler).
- **Index advice.** `mistri check` and `mistri build` warn where a related
  list's reference, a tenant column or a large list's sort leads no index, and
  on PostgreSQL where a `contains` filter has no `pg_trgm` index.
- **Replies.** JSON of 1 KB or more is compressed; the schema, App, pages and
  runtime answer 304 when unchanged, keyed to the signed-in person (row-policy
  and tenant replies are never stored); a signed-in reader's images are
  `private, no-cache` with `Vary: Cookie`; exports stream in batches.
- **Inlined row scopes** on PostgreSQL 12+ (`NOT MATERIALIZED`).

## The load harness's flags

`npm run test:load -- --help` lists them; the gates are:

| Flag | Default | Range |
| --- | --- | --- |
| `--users` | 4 | 1–32 HTTP users (closed loop) |
| `--arrival-rps` | off | 1–100 fixed arrivals a second; `--users` becomes the in-flight cap |
| `--browser-users` | 1 | 1–4 |
| `--duration` | 15 s | 1–300 measured seconds |
| `--rows` | 500 | 24–10,000 issues |
| `--http-p95-ms` | 1000 | successful-request p95 gate |
| `--ui-p95-ms` | 5000 | successful-journey p95 gate |
| `--max-error-rate` | 0 | 0–1 |
| `--production` | off | the built `dist/` server and client instead of source mode |
