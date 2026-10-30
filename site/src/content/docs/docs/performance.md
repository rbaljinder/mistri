---
title: Performance and pools
description: Size PostgreSQL pools for a deployment, read the meters when it is slow, and run behind PgBouncer or RDS Proxy.
---

Size PostgreSQL pools for a deployment, read the meters when it is slow, and run behind PgBouncer or RDS Proxy. To keep requests cheap in the first place, see [Performance by default](/docs/performance-by-default/).

```json title="mistri.json"
{ "connections": [{ "name": "app", "url": "${DATABASE_URL}", "writable": true, "pool": { "read": 16, "write": 4 } }] }
```

<!-- no picture: numbers and configuration; the support bundle's capacity section is the thing to look at. -->

## What you'll see

- At most `read + write + 1` connections per process to each PostgreSQL database for the App's requests, five more for its jobs and other server stores, opened when first needed; idle ones close after 30 seconds.
- People arriving at a tenant App at once (`/api/tenant/enter`, `/api/tenant/bootstrap`) are let in half as many at a time as there are readers, in order; one that has waited 20 seconds is answered 503, `Retry-After: 1`, code `tenant_temporarily_unavailable`.
- A write that waits more than five seconds for a lock is refused with nothing applied: 503, `Retry-After: 1`, code `row_locked`.
- A request that finds every reader or writer busy queues for at most two seconds, and at most sixty-four per connection may queue. Past either it is refused at once: 503, `Retry-After: 1`, code `server_busy`, with nothing run (a write says `not_applied`). The page asks a busy read again a few times and shows a write's refusal.
- Readiness reports `pool_saturated` while a checkout queues; the support bundle's [capacity section](/docs/observe/#the-capacity-section) says why.

## When to use it

- Raise `pool.read` when the meters say the pool is the limit and the database has connections to spare.
- Add pods when the event loop is busy and the pools are calm.
- Put a [transaction-mode pooler](#behind-a-transaction-mode-pooler) in front when pods × pools passes the database's `max_connections`.

## PostgreSQL pools

| Setting                             | Readers                                                                                        | Writers                                                                                            | Background writer |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------- |
| Connections                         | The database browser: 4; an App: as many as its writers; `pool.read` or `--read-pool`, 1 to 64 | An App: twice the cores, 4 to 16; `pool.write` or `--write-pool`, 1 to 64. The database browser: 1 | 1                 |
| Queue wait (then 503 `server_busy`) | 2 s; 64 queued per connection                                                                  | 2 s; 64 queued per connection                                                                      | —                 |
| Acquisition timeout                 | 10 s                                                                                           | 10 s                                                                                               | 10 s              |
| Statement timeout                   | 30 s                                                                                           | 30 s                                                                                               | 30 s              |
| Lock timeout                        | —                                                                                              | 5 s; `--lock-timeout` (0.1 to 30)                                                                  | 5 s               |
| Read-only                           | Yes                                                                                            | Database default                                                                                   | Database default  |

Writes exist only on a `"writable": true` connection. An App's writer pool commits two saves of one record in arrival order and saves of different records side by side; a save over a row someone changed since is refused. A job's command writes through the background writer. The database browser keeps one writer.

`--read-pool`, `--write-pool` and `--lock-timeout` (or `MISTRI_READ_POOL`, `MISTRI_WRITE_POOL`, `MISTRI_LOCK_TIMEOUT`) are the defaults for every pool whose connection names none. SQLite and HTTP sources take no `pool`.

### The sign-in store

A `postgres://` sign-in store (`auth.store`) is read once for a signed-in person every few seconds, not on every request: what it answered about a session is kept in the process for `MISTRI_AUTH_SESSION_CACHE` seconds (default 5, 0 to 60), and a page's burst of calls shares one read. A sign-out, a ban or a role change made through this process is seen by its next request. One made elsewhere — another instance, `mistri` maintenance, SQL — is honored by this process for at most that long; set `0` to read the store on every check. `MISTRI_AUTH_POOL` sets its connections per process (default 4).

### Capacity planning

Across a deployment:

    pods × databases × (read + write + 1)

plus 1 for live sync's LISTEN, 5 for the server's stores when the App declares jobs, mail, integrations, effects, decisions, API events or an assistant (they share one pool, apart from the people's), 1 for the jobs LISTEN, up to 4 for a `postgres://` sign-in store (`MISTRI_AUTH_POOL`, 1 to 64), and short-lived ones for startup checks and query cancels. A tenant App's readers, writers, administration and support share the one `read + write + 1` pool too, sized by the connection's `pool`. The sign-in store's pool counts on top of the rest when it is on the same database: a role allowed eighteen connections fits a tenant App at `"pool": { "read": 4, "write": 4 }` with jobs only if `MISTRI_AUTH_POOL=2` (16 + 2); the default 4 makes it 20. `mistri check --deploy` prints each term. A pool the database refuses another connection goes on with the ones it holds, and the log says `connection limit reached`. Ten pods at `"read": 16` is 210 connections, past a stock `max_connections` of 100. Fewer writers per pod (`--write-pool 2`) is the first lever; a pooler is the second.

A writer makes about `1000 / transaction_ms` saves a second (at 20 ms and a three-trip save, about sixty for the default four); a reader serves about `1000 / hold_ms` reads. Past a few thousand a second the event loop is the limit: add pods.

### Reading the pool meters

| What the meters show                               | What to do                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| `waiting` above zero, holds short, event loop idle | The pool is the limit: raise `pool.read`                                       |
| Checkouts queued behind long holds                 | The database is slow: look at the statements in the [observer](/docs/observe/) |
| Pools calm, event loop busy                        | The process is the limit: add pods                                             |
| `timedOut` rising                                  | Checkouts gave up after 10 seconds                                             |

### One request's time

`MISTRI_SERVER_TIMING=1` answers every request with a `Server-Timing` header, and logs it as one JSON line: `total`, `cpu`, `auth` (resolving the session), and per database (`db-app`, `db-auth`) the round trips sent and the time spent awaiting them, and per pool the wait for a connection. At startup it logs ten `SELECT 1` round trips to each database, measured from where the server runs. It names no statement, row or key; it is off by default, except under `mistri dev`, where it is on for the dev log's cost line and leaves out `proc`. **It exposes process internals (heap, garbage collection, pools) to any requester, so it is for load testing only: keep it off in production.** To measure a deployment that is reachable, set `MISTRI_SERVER_TIMING_TOKEN`: the process entry (`proc`) is then added only to a request that sends the token as an `x-mistri-timing` header, and the per-request entries stay as they were. `mistri check --deploy` warns when timing is on without a token.

## Read replicas

```json title="mistri.json"
{
  "connections": [
    { "name": "app", "url": "${DATABASE_URL}", "writable": true, "replicas": ["${REPLICA_1_URL}", "postgres://app@replica-2/app"] }
  ]
}
```

A connection's `replicas` are copies of its database, PostgreSQL (SQLite is refused), resolved like `url`. Each gets a reader pool the size of the primary's, opened on first use.

| Read                                                                                                 | Where                                              |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| A list's rows and counts, the Workbench grid, a dashboard's charts and breakdowns, search, an export | A replica, in turn                                 |
| A record's own row, a record page and its related lists                                              | The primary                                        |
| Writes, commands, imports, raw SQL, the catalog, history, the inbox, sign-in, MCP tools              | The primary                                        |
| Anything from a browser in the 10 seconds after it wrote                                             | The primary                                        |
| A tenant App's lists, counts and breakdowns                                                          | A replica, under the same membership and row scope |

Row policies are compiled into each statement, so a replica answers the same rows the primary would. Replica sessions are read-only. A replica that refuses or drops a connection is skipped for 30 seconds and its read runs again on the primary; a bad filter is not run twice. A write sets a `mistri_fresh` cookie for 10 seconds (HttpOnly, SameSite=Lax, on the App's base path), and a request that carries it reads the primary, whichever pod answers. A caller with a bearer token has no cookies, so its writes are remembered by token in the process that took them. In a tenant App a member the replica has not seen yet is answered by the primary, and a revoked one is refused on the replica once the revocation has replicated; writes and commands always check the primary. The support bundle's capacity section lists each replica's pool as `replica`, and a trace marks each read `mistri.read.pool`.

Capacity: add `pods × databases × replicas × read` connections, spread across the replicas.

## Behind a transaction-mode pooler

PgBouncer in `pool_mode = transaction` and RDS Proxy hand a server connection to a different client each transaction, so start with:

```sh
npx @mistriwork/mistri --pooler transaction --config mistri.json --app ./my-app
```

Nothing is then set on a session: each statement runs in its own `BEGIN READ ONLY` (`BEGIN` on the writer) with `SET LOCAL statement_timeout`, and user SQL is fenced by a savepoint. A single read costs three round trips instead of one, but a save does not multiply: the writer pipelines inside its transaction, so a save is the `BEGIN` with its opening reads, one round trip for each dependent read or write it awaits, and a last one that carries the `COMMIT`, history and receipt. The authentication store (`auth.store`) works the same way, its search path set in each transaction, except that its client sends a statement with its `BEGIN` and `COMMIT` in one round trip. Run `migrate up` and `migrate stores up` on a URL without the pooler: they hold a session lock. Expect jobs to poll rather than wake on `LISTEN` unless the connection also names the database without the pooler:

```json
{ "name": "main", "url": "${POOLED_URL}", "listen": "${DIRECT_URL}" }
```

A jobs host holds its `LISTEN` on `listen` (one connection per host); work written through the pooler still wakes it.

On a managed pooler such as PlanetScale Postgres, use the pooler port (6432) for the App and the direct port (5432) for `migrate` and `pg_dump`. A small `max_connections` is fine: the App's pools cost pooler clients, not server connections.

## Load testing

From a source checkout, a local harness drives a fresh test App with concurrent HTTP users and real Chromium journeys:

```sh
npm run test:load -- --users 8 --browser-users 2 --duration 30 --rows 1000
```

It seeds its own database and loopback server, so it cannot be pointed at a live App, and exits nonzero when a p95 gate fails. It is a regression guard, not a capacity certificate.

## Common mistakes

- `sorry, too many clients already` after a scale-out → multiply it out: pods × (read + write + 2), plus 6 with jobs (`mistri check --deploy` prints the sum); lower `--write-pool` or add a pooler.
- Session settings leak, or prepared statements collide, behind PgBouncer → start with `--pooler transaction`.
- Saves answer 503 `row_locked` during a migration → the migration holds the table; run migrations before the rollout, not during traffic.
- `pool` on a SQLite connection refuses the start → SQLite has no pool; drop it.

## Related

- [Observe and operate](/docs/observe/): readiness and the capacity section.
- [Connections and services](/docs/services/#connections): where `pool` is written.
- [Build and deploy](/docs/build-and-deploy/#behind-a-load-balancer): what each instance holds.
- `docs/postgresql.md`: the journal, row policies and stores on PostgreSQL.
