# tablewalk

**[Follow the data.](https://tablewalk.dev)** — [tablewalk.dev](https://tablewalk.dev)

Most database tools are SQL clients that happen to render a grid. tablewalk
starts somewhere else: a foreign key is a place you can go. Open a row and it
shows you every row elsewhere that points at it — the orders on a customer, the
customer on an order — so you follow the data instead of writing joins to reach
it. The same machinery answers over **MCP**, so a coding agent sees what you
see ([jump to setup](#for-coding-agents-mcp)).

```bash
npx tablewalk --demo          # build a sample database and open it — an instant try
npx tablewalk mydata.sqlite   # or your own: SQLite or Postgres
npx tablewalk                 # or nothing, and the page asks for a connection
```

No config, no build step, no schema to define first — it reads the catalog on
connect. **Read-only** until you turn editing on, per connection. Runs from
`npx`, a [Docker image](#docker-and-a-desktop-app), or a desktop app. It needs
Node 24 or newer (`engines` in `package.json`); an older Node is refused at
start with one line that says so.

`npx tablewalk` with no target opens a page that asks for a connection: a form
that takes a URL or its parts, tests it before keeping it, and reads the
password from an environment variable or the keychain rather than the string.
The print-and-exit commands need a target, though — there is nothing for
`--export`, `--lint`, `--diff` or `--mcp` to read without one:

```bash
npx tablewalk mydata.sqlite --export md >> CLAUDE.md    # the schema, as a committed brief
npx tablewalk postgres://… --lint --fail-on high         # what the shape costs, for CI
npx tablewalk --config ./tablewalk.json --diff staging   # is staging the same shape?
```

## Apps are mistri's

An App — pages, commands, policies, jobs and workflows declared in TypeScript
over a database you already have — is the App framework's, a package and a
command of its own: [mistri](https://www.npmjs.com/package/@mistriwork/mistri)
(`npm create mistri`, `npx @mistriwork/mistri dev`). `tablewalk` is the database browser
alone: it refuses an App's start (`--app`, `check`, `dev`, a config that lists
`apps`) and names the `npx @mistriwork/mistri` command that runs it.

## The idea

Every database client shows you tables. The interesting structure is the
edges — and specifically the direction almost nothing surfaces well:

> I am looking at this customer. **What points at it?**

Foreign keys are stored once and readable in both directions, so the answer is
already sitting in `information_schema`. tablewalk computes it for the row you
are looking at, counts the referring rows in each table, and lets you click
through to them.

That turns a database from a list into something you can walk:

```
customer › Harbour Freight › invoice customer_id = 1 › 1001 › invoice_line …
```

Each step is a real filter you can see and edit, and walking back restores the
filter you walked away from — which is the detail most browsers lose.

## The query language

The bar at the top takes a small language. The table comes first, because that
is how people say it out loud; everything else is optional.

```
customer active = true sort credit_limit desc
invoice invoice_date = last 30 days
employee title contains manager show first_name, last_name
customer country_code in (AU, NZ) and email is not empty
invoice where total >= 500 order by total desc limit 20
```

| | |
|---|---|
| Operators | `= != < <= > >=`, `contains`, `startswith`, `endswith` (all three ignore case, on every engine), `in`, `not in` |
| Null checks | `is empty`, `is not empty` |
| Combining | `and`, `or`, parentheses |
| Dates | `today`, `yesterday`, `this week`, `last month`, `last 30 days`, `next 7 days`, `previous 30 days` (the window just before `last 30 days`, the same length) |
| Clauses | `filter` / `where`, `show` / `select`, `sort` / `order by`, `limit` |
| Projection | `show a, b, c` — or `select`, if that reads better to you |

Press **SQL** to see exactly what your query compiled to. The tool teaches the
database rather than hiding it.

### Counting things by something

`by` turns a query into a breakdown — the GROUP BY question, in the same
language and with the same guarantees. Measures first, then `by`, then what to
group by:

```
invoice count by status
invoice count, sum total as billed by month invoice_date sort billed desc limit 12
invoice where total > 100 count by customer_id.country_code.name as country
customer count distinct country_code as countries by active
```

| | |
|---|---|
| Measures | `count`, `count <column>` (skips its nulls), `count distinct <column>`, `sum`, `avg`, `min`, `max` |
| Group keys | any column, or a reference path — up to three of them |
| Periods | `by day \| month \| quarter \| year <date column>` |
| Sorting | `sort <name>` names a column of the *answer*, key or measure |

A period comes back as a label — `2026-08`, `2026-Q3` — spelled identically on
SQLite and Postgres, so it sorts correctly as text and means the same
thing wherever you point the tool. Agents get this as the `breakdown` tool,
which is the one to reach for before `sql`: every value is bound and every
path is checked against the catalog.

### Why not just let people type SQL?

Because this language compiles to a *structure*, never to SQL text:

```
customer name = "O'Brien"
        ↓
{ groups: [[{ column: 'name', op: '=', value: "O'Brien" }]] }
        ↓
SELECT * FROM "customer" WHERE "name" = ?     ["O'Brien"]
```

There is no path from what you type to what the database parses as syntax.
Every value arrives as a bound parameter. A tool that accepted raw SQL would
have to either trust the input or write a SQL parser to distrust it; this
sidesteps both by making the dangerous shape unrepresentable.

Two things fall out of that for free:

- **The compiler holds the schema.** `customer contry_code = AU` is an error
  with a suggestion, not a database exception — and not, worse, an empty
  result that looks like an empty table.
- **Dates resolve to real timestamps.** `last 30 days` becomes two bound
  values, identical in both dialects, visible in the explain panel.

## One row, and everything about it

Click a row and you get a record page: the fields, and — in a rail beside
them — every table that points at this row, counted, ranked by how much there
is to read. An empty relationship is shown as a zero rather than hidden,
because "nothing points here through this" is an answer, and a rail that
quietly dropped it could not be trusted to be the whole list.

Records are named like a person would name them. A table with a `name`-like
column uses it; a table whose name lives one-to-one away — `employee` carrying
`party_id`, with the name on `party.display_name` — walks the reference and
says `employee · Maeve Lindqvist` instead of `employee · 30`. The walk is the
tool's whole idea, so it applies to headings and breadcrumbs too, and it
deliberately stops at ownership: an invoice is never named after its customer,
because forty invoices share that name and a label that identifies nothing is
worse than a key.

**Pages** go one step further: a composed view of one record — its fields,
counts of what points at it, and lists of the rows themselves — laid out in
sections you arrange. Every table gets a suggested page for free; **Layout**
opens a builder where sections are added, hidden, filtered, resized and
dragged into order, fields dragged into groups, and a to-one reference pulled
in as its own block of fields. Values on a page render through the same module
the record view uses, so a page you build never reads worse than the record it
was built from.

Related lists sit in a tab strip rather than stacked down the page, and only
the tab you open is fetched — six things pointing at a record is otherwise six
queries and a scroll. A run of lists is one strip and anything between two
lists splits them, so dragging sections is how you decide what is a tab of
what; the builder's "Lists as tabs" is the way out of it.

Page view is sticky: from a page, a child row and a followed reference open as
pages too, using whichever page you built for that table. In write mode the
record's own fields become editors in place, through the same staging,
statement preview and undo as the record view. Pin a page with the star beside
its name and the home screen offers it — along with the records you were last
looking at, and every page there is.

**Check the shape** (⌘K, or the `···` menu) runs the same `lint` an agent and
a build get, for the person who can actually add the index: keyless tables,
foreign keys with nothing behind them, references with no delete rule,
timestamps with no zone — grouped by table, each cost said once, and every
heading opens the table it is about.

**Find a value** (⌘K, or the `···` menu) answers the question you have when a
string arrives from somewhere else and you cannot yet name the table it
belongs to: it sweeps the text columns of every table — and uuid columns when
the value is a whole uuid — grouped by table, with each match a row you can
open. Bounded, and honest about it: it says which tables it could not read and
where it stopped. It is the same `find` the MCP server offers, through the
same endpoint, so the two cannot disagree about what a match is.

Everything is a link. In the database browser the URL carries the whole
trail — connection, queries, rows, page — so a walk can be pasted into a ticket
and arrive intact. A page is named in the link rather than identified:
`/app/@customer-desk~1885`. The grammar is documented in the `?` help panel.
An App's links are its canonical addresses instead (above).

## For coding agents: MCP

The same machinery, offered to an agent:

```bash
npx tablewalk --mcp --config ./tablewalk.json   # speaks MCP on stdio
```

```json
{ "mcpServers": { "tablewalk": { "command": "npx", "args": ["tablewalk", "--mcp", "--config", "./tablewalk.json"] } } }
```

Or point it at a database instead of a config file: `"args": ["tablewalk",
"--mcp", "--db", "postgres://localhost/app"]`. **Twenty-three tools** —
seventeen read-only, and six writes offered only when a connection is
`"writable": true`. Every answer carries a deep link the human beside the
agent can open in the UI, and says what it cost in rows and milliseconds.

**Reading**

| tool | what it answers |
|---|---|
| `schema_summary` | orientation in a few hundred tokens — hubs, event tables, the deepest reference chain |
| `tables` / `table` | the list; then a table's columns, DDL, and foreign keys in **both** directions |
| `find` | where a name lives, across every table and column |
| `query` | the query language; its errors carry suggestions and the table's real columns, so a mistake is fixed in one retry |
| `breakdown` | counts and sums grouped by something — `invoice count by month invoice_date` |
| `record` | one row, its human name, and everything that points at it |
| `sql` | read-only, for whatever the language cannot say; never over tablewalk's own tables |
| `explain` | the planner's account of a statement without running it — feed a `query` answer's `sql` back |
| `profile` | what a column actually holds: null share, distinct count, range, the values that repeat |
| `lint` | what the shape will cost: keyless tables, unindexed references, naive timestamps |
| `change_impact` | what breaks if you change a table or column — asked *before* the migration is written |
| `diff` | whether two connections are still the same shape |
| `order` | what has to exist before what, and the reverse for teardown |
| `fixture` | a real row and the graph it belongs to, ready to replay into a test database |
| `refresh` | re-read the catalog after a migration |
| `connections` | list them; the call to start with |

**Writing** — offered only when a connection is marked `"writable": true`; a
read-only server does not list tools it would refuse.

| tool | what it does |
|---|---|
| `insert` | one row; answers with what the database stored, defaults filled and key assigned |
| `update` | one row, by its primary key |
| `delete` | reports its impact first — every table pointing at the row, counts, `ON DELETE` rules — and removes nothing until called again with `confirm: true` |
| `insert_graph` / `delete_graph` | several related rows in one all-or-nothing transaction |
| `revert` | preview the last write, then confirm with `confirm: true` and that preview's `next.id` as `expectedId`; raw `sql` writes have no general inverse |

Write answers carry `rowsInserted` / `rowsWritten` / `rowsDeleted`.

Undo reports `applied`, `not_applied`, or `unknown`. An unknown result may have
committed: inspect the stored records and do not retry it. Pending or uncertain
Undo blocks falling through to older writes. Keep the exact `expectedId` after
a lost response; never replace it with an older entry to retry. This journal is
bounded and in-memory, not a durable recovery receipt.

A fixture is a graph, so `insert_graph` takes one: several related rows in one
transaction, where either all of them land or none does. A row that cannot
know its parent's key names it by label —

```json
[{"table": "country",  "as": "au", "values": {"code": "AU", "name": "Australia"}},
 {"table": "customer", "as": "c1", "values": {"name": "Dry Creek", "country_code": {"ref": "au", "column": "code"}}},
 {"table": "invoice",                "values": {"customer_id": {"ref": "c1"}, "total": 99.5}}]
```

— and `{"ref": "c1"}` resolves to that row's key *as the database assigned it*.
The answer carries a `teardown` list, reversed, for `delete_graph`, which
removes it the same way: one transaction, all or nothing. `fixture`'s output
can be passed straight in as `tables`, which is the loop worth having — take a
real row out of development, put it into a test database, tear it down after.

Rows entering an agent's context leave the machine — point it at development
databases. Where you want that enforced rather than remembered, mark a
connection `"rows": false`: the catalog, row counts, null fractions, plans and
`lint` still answer, and everything that would return a value out of a row
refuses — at the adapter, so every endpoint and every tool at once. A server
whose connections are all shape-only does not list `query`, `sql` or `record`
at all.

Where only some columns must stay behind (a password hash, an API token), give
the connection `"hidden": { "account": ["password_hash"], "*": ["*_token"] }`
instead: the catalog and every answer leave those columns out, a query that
names one is refused, and raw SQL is refused on that connection. A database
role without `SELECT` on them is stronger still.

A call is bounded in time and in what it counts. Statements run under a
30-second cap, and `sql` takes `timeout_ms` to lower it for one statement:
Postgres sets it inside the statement's transaction, and SQLite, which cannot interrupt a statement
in-process, runs `sql` in a separate process that the cap stops — the reads
tablewalk compiles for SQLite are bounded by their limits instead. A client
that cancels a call (`notifications/cancelled`) stops the statement it is
running — the Postgres backend is cancelled, the SQLite
process ended — and the call answers as cancelled; a write that has already
started runs to its end, so its outcome is known. The totals `query` and
`breakdown` report, and the counts on `record`, stop at 10,000 and say so
(`cappedTotal`, `capped`). And `sql` and `explain` refuse statements that touch
the App runtime's own tables — the `__mistri_` tables and the `mistri`
schema, and the `__tablewalk_` and `tablewalk_auth` names they carried before
mistri — whether the statement names them, reaches them
through a view, or could only name a table when it runs.

The shelf your team already keeps is readable too. Named queries and page
definitions from your `tablewalk.json`, and pages saved from the browser, are
served as MCP **resources** — `tablewalk://{connection}/queries` and
`tablewalk://{connection}/pages` — beside the schema brief. Reading them does
not run them; they are the questions your team decided were worth asking, in
front of an agent that would otherwise re-derive them badly.

And you can watch all of it: the **Agent console** (⌘K → "Agent console")
drives the same tools by hand through the same code path, showing each
answer exactly as an agent receives it — stats, token cost, and the deep
links back into the UI.

## A config file, and a team's surfaces

Everything above works with no config at all. A `tablewalk.json` earns its keep
when you want several databases to hand, and when the interface a team agrees
on should live in version control rather than in one person's browser.

```json
{
  "connections": [
    { "name": "app (local)", "url": "postgres://localhost/app", "schemas": ["public"] },
    { "name": "production",  "url": "postgres://reader@prod/app", "rows": false },
    { "name": "analytics",   "url": "postgres://user:pass@warehouse/an" },
    { "name": "cache",       "url": "./var/cache.sqlite" },
    { "name": "desk",        "kind": "http", "url": "https://desk.example/v1/",
      "description": "desk.http.json", "auth": { "bearer": "${DESK_TOKEN}" } },
    { "name": "shared",      "kind": "cache", "url": "valkeys://cache.internal:6379",
      "auth": { "password": "${VALKEY_PASSWORD}" } }
  ]
}
```

`desk` is an API rather than a database, read through a description
`--from-openapi` drafts from its spec: `docs/http-sources.md`.
`shared` is an optional service, never a database: a Valkey cache every
instance shares (cached API answers, public-form rate limits). It can be down
without anything failing: [services](https://tablewalk.dev/docs/services/).
A search engine is not a service of tablewalk's: an App's text filters run on
the database, and search providers (Typesense among them) are packs that ship
after 1.0. An App's own connections — an email service, an OAuth server for
agents — are mistri's: its README has them.

A PostgreSQL entry can size its pools, `"pool": { "read": 16, "write": 8 }`
(each 1 to 64; an App defaults to twice the cores, 4 to 16, for both and the
database browser to 4 readers, or `--read-pool` and `--write-pool`). An App
writes through its writer pool, saves of one record in the order they
arrived and saves of different records side by side; the database browser
writes through one connection, one write at a time, which its Undo needs.
A write waits at most `--lock-timeout` (5 s) for a row another transaction
holds, and is then refused with a retry.
[Performance & PostgreSQL pools](https://tablewalk.dev/docs/performance/) has
the capacity arithmetic, and `--pooler transaction` for a deployment behind
PgBouncer or RDS Proxy.

A PostgreSQL entry can also name read replicas,
`"replicas": ["${REPLICA_URL}"]`. Lists, counts, dashboards, search, exports
and the Workbench grid read them in turn, a tenant App's under the same
membership and row scope; a record's own row, writes, commands, the catalog
and tablewalk's stores stay on the primary, and so does a browser's every read
for ten seconds after it writes (a short-lived cookie carries that, so it
holds across pods). A replica that cannot be reached is skipped for thirty
seconds and its reads go to the primary.

The same file can name SQL statements your team should have to hand:

```json
{
  "queries": [
    {
      "name": "Customers over their limit",
      "sql": "select c.name, sum(i.total) as invoiced from customer c join invoice i on i.customer_id = c.id group by c.id having sum(i.total) > c.credit_limit",
      "description": "Where invoiced value has passed the agreed credit limit",
      "connection": "app (local)"
    }
  ]
}
```

They appear above the SQL editor and in ⌘K. Leaving `connection` out offers the
statement on every database, which is right for one about a schema several of
them share and wrong for one about a table only production has. Statements you
save in the browser sit in the same list; the only difference is that a
committed one is not yours to delete.

It can also carry the built surfaces, so the interface a team agrees on lives
in version control rather than in one person's browser. Four sections, all
optional:

```json
{
  "views":   [{ "name": "Unpaid, biggest first", "connection": "app (local)",
                "text": "invoice show id, total, status, customer_id.name as customer where status != paid sort total desc limit 50" }],

  "pages":   [{ "label": "Customer desk", "base": "customer",
                "sections": [
                  { "kind": "fields", "title": "Account", "show": ["name", "email", "country_code.name"], "columns": 2 },
                  { "kind": "metric", "title": "Billed", "measure": "sum total", "from": "invoice", "whose": "customer_id", "width": "third" },
                  { "kind": "list",   "title": "Invoices", "from": "invoice", "whose": "customer_id", "limit": 10 }
                ] }],

  "layouts": [{ "table": "customer", "name": "Account desk",
                "sections": [
                  { "kind": "fields", "title": "Account", "show": ["name", "email", "credit_limit"] },
                  { "kind": "list",   "title": "Invoices", "from": "invoice", "whose": "customer_id", "limit": 5,
                    "sort": "invoice_date desc" }
                ] }]
}
```

A **view** is a saved filter in the query language. A **page** is a composed
record — fields, counts and related lists — reached at `/{connection}/@page~id`.
A **layout** is how the record view itself arranges one table, which used to be
buildable only by clicking.

Page and layout sections speak the same words: rows are named as `from` and
`whose` — the `invoice` rows *whose* `customer_id` is this customer — with
`show` for the fields or columns, `sort` written like the query bar, and (on
a page) `about` when the section is about a record the base points at rather
than the base itself. A layout's list section may instead say `via`, the
foreign key's constraint name — the real key, because a child can point at a
parent twice and the column alone would not say which; a `from`/`whose` pair
is resolved to it against the schema, and a pair that matches no relationship
keeps its section and carries an error saying so rather than quietly
disappearing.

Committed layouts fill in for tables nobody has laid out here, and never over
one somebody saved: a committed layout is the default a team starts from, and
the copy in your browser is what you chose afterwards. A malformed entry in any
of these stops the server and names the entry and the fix — a page that
silently did not appear is a bug report that starts "I definitely wrote it".

Looked for in `./tablewalk.json`, `./.tablewalk.json`, then
`$XDG_CONFIG_HOME/tablewalk/connections.json`. They appear in a picker in the
sidebar and are **opened lazily** — naming eight databases does not mean
dialling eight databases. Connection strings stay on the server: the browser
is sent an id, a name, a dialect and a redacted detail, never a password.

## HTTP diagnostics

Opt-in local request diagnostics are available with `TABLEWALK_DIAGNOSTICS=1`.
Generated request IDs correlate response headers with fixed-shape JSONL events
on stderr, without recording URLs, business payloads or SQL. No telemetry is
sent upstream. See HTTP diagnostics (`docs/observability.md`) for the event
contract, existing-log distinction and delivery limits, and
[Observe and operate](https://tablewalk.dev/docs/observe/) for an
App's readiness and support bundle.

## Credentials

A connection string is a credential, so tablewalk tries hard not to hold one.
The password can come from four places, tried in this order:

| | |
|---|---|
| **Environment** | `"url": "postgres://app:${PROD_PASSWORD}@db/app"` — nothing is stored anywhere |
| **OS keychain** | macOS, via the built-in `security` tool, addressed by connection name |
| **Credentials file** | `$XDG_CONFIG_HOME/tablewalk/credentials.json`, **refused unless mode 0600** |
| **Inline in the URL** | Works, and is reported in the UI, because it ends up in shell history |

An unset `${VAR}` is an error rather than an empty expansion — otherwise you
get an authentication failure that says nothing about the real cause.

tablewalk deliberately does **not** encrypt its own secrets. Rolling
encryption for a local tool means inventing key management, and a key stored
next to the ciphertext it protects is obfuscation with extra steps. Every
option above either delegates to something that already solves the problem or
is explicit about being plaintext-on-disk with the permission discipline `ssh`
and `psql` use.

Connections added through the UI keep their password out of the stored URL:
the secret goes to the keychain (or the 0600 file) and the URL that persists
has no password in it. A connection list can be shared or committed without
thinking about it.

## Read-only, and meant

- The SQLite handle is opened `readOnly`. Reaching past the query API entirely
  still fails.
- Postgres connections `SET default_transaction_read_only = on` and a 30s
  statement timeout.
- Writes exist only behind a per-connection `"writable": true` opt-in;
  adding a row is a form the schema writes, and deleting one leads with its
  impact. A write opens a *second* connection, so the one every read uses
  stays read-only for the life of the process however much gets edited.
- An update or a delete has to name the whole primary key, and the row is
  counted on the read-only handle before anything is written: a key matching
  anything other than exactly one row is refused rather than applied. The
  danger in a cell editor was never injection.
- Table names cannot be bound as parameters, so they are checked against the
  catalog before being quoted into a statement.
- Every read is bounded. There is no code path to an unlimited query: a
  caller that omits a limit gets 20, one that asks for too many gets 100,000,
  and one that sends nonsense gets 20 rather than `LIMIT NaN`.
- Request bodies are capped at 256 KB.
- The server binds `127.0.0.1` only. Listening on every interface would put
  your database one shared network away from someone else's browser; `--host`
  overrides it and says so at startup.
- Connection strings never reach the client, in any response.
- "Read-only" is enforced at the session and transaction level, not the
  role level. A superuser can still `COPY … TO PROGRAM` inside a Postgres
  `READ ONLY` transaction. Connect as a role that can only read and the database
  enforces what tablewalk promises. A connection that is not writable but
  opens over a role that could do more (a superuser, a write grant, `CREATE`)
  gets one line on stderr saying what that role can do.
- **The connection manager trusts the browser only on loopback.** Adding a
  connection from the page can reference `${ENV_VAR}`, look a password up in
  the keychain by name, open a SQLite file by path, and save the config —
  each of them what the config file itself may do, and each of them a way
  out when the browser is on another machine. So when the server is bound
  beyond loopback, or answers to an `--allowed-host` name, a URL from the
  browser is used exactly as written: no environment expansion, no keychain,
  no file paths, no saving, and no redirecting a connection the config named.
  Nothing is filled in from the server either — a missing password is empty,
  never `PGPASSWORD` — and the host must resolve to a public address: a
  loopback, private or link-local (cloud metadata) one is refused.
  Add those connections to `tablewalk.json` on the server instead.
- Editing a connection's URL makes it read-only. `writable` is a statement
  about one database, and it does not follow the entry to another.

There is a test asserting that `name = "'; DROP TABLE customer; --"` returns
zero rows *and leaves the table standing*.

## Databases

| Dialect | Status | Notes |
|---|---|---|
| SQLite | Built in | Uses Node's own `node:sqlite`. No native module to compile. Reads and writes. |
| Postgres | Supported | Needs `pg` (`npm install pg`). Reads `pg_catalog` for keys and row estimates. Reads and writes. Business commands with durable receipts after `migratePostgresCommandJournal`; an App's sign-in store in its own `tablewalk_auth` schema after `migratePostgresAuthStore` (an older one moves forward with `mistri migrate stores up`). Pools and the pooler mode: [performance](https://tablewalk.dev/docs/performance/#postgresql-pools); the command journal and the authentication store: `docs/postgresql.md`. |
| HTTP API | Built in | An API with an OpenAPI 3 spec: `--from-openapi` drafts a description of its lists and items, and a `"kind": "http"` connection reads through it. Filters, sort and paging only as the API documents them; no totals. Read-only. `docs/http-sources.md`. |

Adding another is one file implementing `Adapter` — `introspect`, `query`,
`count`, `close` — plus a case in `packages/engine/src/adapters/connect.ts`. The shared
`buildWhere` handles the dangerous part, so an adapter never builds a
predicate itself.

## Options

```
tablewalk                     no target: serve, and ask for one in the browser
tablewalk <target>            a SQLite file path, sqlite:<path>, or postgres:// URL
tablewalk migrate <command>   change the schema with versioned SQL files (below)
tablewalk seed [<db>]         believable rows in a writable database (below)
mistri --app <dir>            an App, served: the App framework's, npx @mistriwork/mistri
  -d, --db <target>           the same thing, explicitly (or set DATABASE_URL,
                              used when no config names connections)
  -p, --port <n>              default 4111
      --schema <name>         Postgres only; repeatable. Defaults to all user schemas.
      --read-pool <n>         PostgreSQL connections that may read at once, per
                              database (default 4, at most 64); a connection's
                              "pool": { "read": n } wins. Or set
                              TABLEWALK_READ_POOL
      --lock-timeout <s>      seconds a write waits for a row or table another
                              transaction holds before it is refused (default
                              5, 0.1 to 30). Or set TABLEWALK_LOCK_TIMEOUT
      --pooler <mode>         session (default: direct, or a pooler that keeps
                              a client on one server connection) or transaction
                              (PgBouncer in transaction mode, RDS Proxy): the
                              read-only guard and statement cap are then set
                              per transaction. Or set TABLEWALK_POOLER
      --drain-delay <s>       seconds /readyz answers 503 before the listener
                              closes on SIGTERM, so a balancer that probes
                              takes this instance out first (default 0, up to
                              120). Or set TABLEWALK_DRAIN_DELAY
      --shutdown-grace <s>    seconds a response still unfinished after the
                              drain may keep the process before it is cut
                              (default 10, 1 to 300); hold both inside the
                              platform's stop timeout. Or set
                              TABLEWALK_SHUTDOWN_GRACE
      --host <addr>           interface to bind (default 127.0.0.1)
      --allowed-host <name>   also answer for this Host header; repeatable
      --trust-proxy <address|CIDR>
                              a proxy whose X-Forwarded-For the public forms'
                              rate limit may believe (10.0.0.0/8, 172.17.0.1,
                              fd00::/8); repeatable or comma-separated, or set
                              TABLEWALK_TRUST_PROXY. Loopback is always trusted.
                              Also who may set --auth-proxy-header
      --trust-proxy-hops <n>  behind a managed front end with no address to name
                              (Cloud Run, a cloud load balancer): how many
                              proxies append to X-Forwarded-For; the client is
                              the address n places from the right. Or set
                              TABLEWALK_TRUST_PROXY_HOPS
      --trust-proxy-cloudflare
                              read CF-Connecting-IP as the client; only when the
                              server is reachable through Cloudflare alone; not
                              with --trust-proxy-hops. Or set
                              TABLEWALK_TRUST_PROXY_CLOUDFLARE=1
      --auth-proxy-header <name>
                              behind a proxy that signs people in: the header
                              it sets with the user (X-Forwarded-User). Requests
                              from beyond loopback must carry it and come from
                              a --trust-proxy address; every write is journaled
                              with it
      --config <path>         read connections from this file, and the
                              cache, search, webhook, email (smtps://,
                              smtp:// or log:) and OAuth services beside
                              them; the paths in it are relative to its folder
      --no-config             ignore any config file
      --base-path <path>      the path a reverse proxy serves this server
                              under, like /tools: every address, asset, API
                              call, cookie and link carries it. Or "basePath"
                              in the config, or set TABLEWALK_BASE_PATH
      --openapi <spec>        serve an API straight from its OpenAPI spec (a
                              file or URL): the description is drafted in
                              memory and the base URL is the spec's server
      --api-url <url>         with --openapi: the API's base URL, when the
                              spec's servers do not give a usable one
      --api-token-env <name>  with --openapi: send $name as a bearer token
      --demo                  build a throwaway sample database and open it
      --open                  open a browser once the server is up
      --mcp                   speak MCP on stdio instead of serving HTTP
                              (the database browser's tools; no App)
      --tools <name>          explore, migrate, seed, or full (the default)
      --output-schema         advertise each tool's output shape in tools/list
      --export <fmt>          print the schema as md, mermaid or json, then exit
                              (an App's brief, types, openapi and asyncapi are
                              mistri's)
      --lint [fmt]            report what the shape will cost, then exit
      --fail-on <sev>         with --lint, exit non-zero at this severity; for CI
      --diff <conn>           compare shapes with this connection, then exit
  -h, --help                  print the short help and stop; --help all, this
  -v, --version               print the version and stop

tablewalk migrate new <name> [--repeatable]
tablewalk migrate status | up | validate | baseline | repair
tablewalk migrate diff <name> | check | squash
                [<db> | --db <target> | --config <path>]
                [--connection <name>] [--schema <name>] [--migrations <dir>]
                [--history-table <name>] [--dry-run] [--tool flyway]
                [--schema-file <path>] [--dev-url <url>]
                              versioned SQL files in Flyway's format, forward
                              only: V3__add_payoff_quote.sql once, in its own
                              transaction (a failure is recorded as failed);
                              R__views.sql again when it changes. up
                              applies what is pending; status shows applied, pending, drift made
                              outside migrations and types older than the
                              database; validate fails on any of those;
                              baseline records an existing database as
                              version 0 and writes baseline.schema.json;
                              repair fixes the history. A lock keeps two
                              deploys apart. Exit 1 could not run, 2 files
                              and history disagree, 3 a migration failed.
                              diff writes the next V file from schema.sql
                              (beside the migrations): what they still lack,
                              for review; check exits 2 when the migrations
                              do not build schema.sql; squash folds the V
                              files into V1__baseline.sql. Atlas community,
                              pinned by sha256, fetched once into
                              .tablewalk/bin (TABLEWALK_ATLAS: your own)

tablewalk seed [<db> | --db <target> | --config <path>]
                [--connection <name>] [--rows <n>] [--seed <n>] [--append]
                              fill a writable database with rows to
                              look at, parents first: vocabularies, keys, NOT
                              NULL and unique hold; a status spread over its
                              states, with matching stamps; dates
                              over the last 90 days, some work due today or
                              overdue. Exit 1 could not run, 2 refused
      --rows <n>              with seed: rows per main table (default 40)
      --seed <n>              with seed: the same rows again, on the same day
      --append                with seed: add to tables that already hold rows
```

A path typed on the command line (`--config`, `--migrations`) is relative to the
current directory; a path written in a file (`tablewalk.json`) is relative to
that file's folder. A value from the environment (`"${DATABASE_URL}"`) is read
as given, from the current directory.

An option it does not recognize is an error, not a shrug: `tablewalk --prot
4111` says so rather than quietly serving the default port.

`--tools` offers one job's worth of tools instead of all twenty-three. Most
sessions are one job — an agent reading a schema does not need the graph
writers, one seeding a fixture does not need `explain` — and the listing is a
fixed cost paid on connect, before anything is asked. `connections` and
`refresh` are in every profile: the first is the call to start with, the second
is how an agent recovers from a schema that changed underneath it. A profile
only ever *removes*, so a read-only connection given `seed` still lists no
write tools.

    full 5,579 · explore 2,737 · migrate 2,210 · seed 2,909 tokens

`--output-schema` is off by default, and that default is a measurement. The
tool listing is what every agent pays for on connect, before it has asked
anything, and on a 66-table schema `outputSchema` was exactly half of it —
about 4,300 tokens, of which one byte-identical `stats` block repeated across
every tool is 1,200. It is optional in MCP and it is a contract rather than a
prompt: most agents never read it, and the answers carry the same fields
whether or not the shape was declared in advance. Turn it on for a client that
validates `structuredContent` against the declaration.

## What it will and will not answer

Browsing is read-only unless a connection is marked writable, and the server
enforces that — the padlock in the toolbar is the interface for a decision the
server makes, not the decision itself.

Every request is checked against the `Host` it arrived for, reads included.
That is the defense against DNS rebinding: a page on a name an attacker
controls, pointed at your loopback, is *same-origin* as far as the browser is
concerned, so it can read what it asks for. tablewalk answers only on
`localhost`, on the address it was bound to, and on any name given with
`--allowed-host` — everything else gets a 403, including the page itself, so
the attempt fails at the door rather than one fetch later.

Requests that change something are checked twice more: the `Origin`, when the
browser sends one, and the content type, because a form post is the one shape
a cross-origin page can make without asking permission.

Nothing here is authentication. Anyone who can reach the port and send the
right `Host` can read every connection this server holds, run read-only SQL
against them, and add network connections of their own — which also makes the
server a probe for hosts it can reach. Bind to loopback — the default — and
that is your own machine; bind wider and it is whoever else can reach you,
which is why a server bound wider stops trusting the browser with file paths,
environment references and the config file (above), and why anything past a
private network belongs behind a proxy that authenticates.

An App can sign people in itself, with email and password or an identity
provider; that is mistri's, and its README says how.

When the database browser is behind one — Cloudflare Access, oauth2-proxy, Tailscale's identity
headers — say so: `--auth-proxy-header X-Forwarded-User` (or the header your
proxy sets). Every request from beyond loopback must then carry it, so a
request that skipped the proxy is refused at the door, and every write in the
journal says who made it. That is the proxy's decision carried into this
process, not a login of tablewalk's own; per-user tabs, pins and history are
still the browser's. (`--trust-proxy` and its `-hops` and `-cloudflare`
siblings are unrelated: they say where a visitor's address is read for a
public form's rate limit, and sign nobody in.)

## Docker, and a desktop app

**Container** — `ghcr.io/rbaljinder/tablewalk`. It reads its connections from a
mounted `tablewalk.json` and holds no configuration of its own:

```bash
docker run --rm -p 127.0.0.1:4111:4111 -v "$PWD:/config:ro" ghcr.io/rbaljinder/tablewalk
```

`DEPLOY.md` covers the two things a container changes about the
security model — binding `0.0.0.0` inside while publishing only to the host's
loopback, and `--allowed-host` for reaching it by a name other than
`localhost`.

**An App in a container** is mistri's: its README covers building one.

**Desktop** — a native app (macOS, Windows, Linux) is built with every
release; its downloads open to the public with the source repository.
macOS is signed and notarised, so it opens normally; Windows is not signed
yet, so its first open needs an "open anyway" past SmartScreen; `npx tablewalk`
and the container need no such thing.

## Keyboard

The same table is in the app under `?` → **Keys the page listens for**, so it
cannot drift out of reach of the person who needs it.

| Key | |
|---|---|
| `h` | home — the schema, your work, the diagram |
| `/` | focus the query bar |
| `⌘/` | the query bar as a panel, with room to write in |
| `t` | focus the table filter |
| `⌘K` | command palette: tables, pages, actions, recent queries |
| `⌘B` | show or hide the table list |
| `Backspace` or `⌘[` | walk back one step |
| `?` | the query-language panel; in an App, the keys alone |
| `Space` | in a result grid: glance at that row's record |
| `j` / `k` | on a record opened from a list: the next / previous record in that list |
| `Esc` | leave the field, or close what is open |

Single keys work when the caret is not in a text field, and never through a
dialog: the page under a modal is not taking keys.

The `···` menu carries **Theme** — match the system, always light, always
dark — and the rows-per-page control lives with the pager.

In a result grid: arrows move a cell cursor, `Enter` opens that row's record,
`Space` glances at it without leaving the list, `⌘C` copies the cell,
`Home`/`End` jump to the first and last column. A record opened from a list —
its page, a glance or a dialog — says where it sits ("3 of 20") beside its
name, and `j`/`k` or the arrows there step through that list, past its page too.

## Development

```bash
npm install
npm test          # typecheck, lint, client checks, the unit suite, the component tests
npm run demo      # build a demo database and open it
npm run build     # emit dist/, runnable by plain node
```

The demo database is generated from source in `test/make-demo-db.ts` rather
than committed as a binary, so you can read what you are browsing. Its shape
deliberately covers the things that are easy to get wrong: a self-referencing
key, a composite key, a view, and a nullable reference.

For something with weight to it, seed bulk data:

```bash
npx tsx test/make-demo-db.ts .demo/big.db --scale 2000   # ~87,000 rows, <1s
```

Seeding is deterministic — the same scale and seed always produce the same
database, so a screenshot or a reported bug can be reproduced exactly. The
small fixture is left untouched by default because the test suite asserts
exact counts against it.

The client renders through React and imports the same TypeScript the server
runs on for the rules both sides need. Vite bundles it into `dist/` at publish
time, in the same `npm run build` that compiles the server, and serves it from
source under `npm run dev` — so the promise is still `npx tablewalk mydb.sqlite`
and nothing else, and the build is the maintainer's, never the user's.
Architecture, in one page (`docs/architecture.md`) says what runs where;
`CONTRIBUTING.md` says which constraints are load-bearing.

## License

MIT.
