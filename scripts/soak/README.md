# Soak harness

Measures memory, GC, CPU, latency and where the time goes for one tablewalk server under load.
Not shipped (outside package.json `files`).

    PGBIN=<dir with initdb, pg_ctl, createdb, psql> scripts/soak/run.sh <out-dir>

`run.sh` starts a disposable PostgreSQL 16 (with `pg_stat_statements`), seeds Compass, serves it
writable with `sampler.mjs` loaded, runs the load, then the reports. Everything is torn down on exit.
Tablewalk runs from source under tsx, as the repository's tests do.

## The k6 run (default)

`k6/mixed.js` runs these scenarios at the same time. Every request is tagged `scenario` and `ep`
(`scenario.endpoint`), so results split both ways.

| scenario | what it does | share of peak users |
| --- | --- | --- |
| `api` | create, read, list, search, list-opportunity, update, count, delete through `/api/*`; 40 ms think | 43% |
| `pages` | HTML for `/leads`, `/leads/<id>`, `/sales-dashboard` plus the first-paint stylesheets and scripts; cold, and warm with ETags; 1-3 s think | 34% |
| `commands` | Compass's actions on a lead (Start working, Mark qualified) as the record page sends them, then delete | 23% |
| `browser` | 2 Chromium users (k6 browser module) loading pages; web vitals | 2 users, on top |

Not run: `sessions`, business commands and `publicapi`. Compass declares no `auth`, no commands module
and no `api`, so there is no sign-in, no `/api/commands/execute` and no public App API to drive; they need
an App that has them (Forecourt, Commons) and a seeded user. The 10% they would take went to `api` and `pages`.
Compass's actions are not commands: the browser sends `POST /api/update` with the action's `set`.

A page's first-paint data is inlined in the HTML (`firstPaint.ts`), so a page load is the document plus static
files. Under tsx the client is served by Vite's dev middleware, which sends about 500 module requests per page;
`pages` leaves them out (they measure the dev bundler) and the `browser` scenario carries them.

Stages (`SOAK_STAGES`, seconds:users, ramped linearly): `60:150,180:150,60:0` by default.
During the hold, `monitor.mjs` takes a 30 s CPU profile at the start and another at the end, and runs the
sampling allocation profile across the whole hold. Output in `<out>`:

- `summary.json` (from `report-k6.mjs`): per scenario and endpoint stats (avg, min, med, p90, p95, p99, p99.9, max;
  whole run and hold), throughput and errors in 10 s buckets, web vitals, the sampler series, the memory/GC verdict,
  Postgres activity and statement counts, the writer-pool meters, and the profile top lists.
- `k6-dashboard.html` (k6's web dashboard export), `k6-summary.json`, `points.json.gz` (every point).
- `cpu-hold-start|hold-end.cpuprofile` and `alloc-hold.heapprofile` (open in Chrome DevTools or speedscope), each with
  `.folded`, `.flame.html` (self-contained flame graph) and `.top25.json`; `flame-index.json` names them.
  Frames carry the TypeScript `file:line`, mapped through tsx's source maps.
- `server.ndjson` (sampler, every 5 s), `db.ndjson`, `pgact.ndjson` (pg_stat_activity each second),
  `pgstat-*.json` (pg_stat_statements at the hold's start and end), `events.ndjson`.

The profilers hold memory of their own, so a profiled run is not a leak test: use `SOAK_PROFILE_OFF=1` for that.

## Env

`SOAK_STAGES`, `SOAK_THINK_MS` (40), `SOAK_BROWSERS` (2, 0 turns them off), `SCENARIOS` (comma list),
`SOAK_WRITE_POOL` (server `--write-pool`), `SOAK_PROVISION_EPOCH=1` (provision the Postgres schema epoch, off by
default so runs compare), `SOAK_DIAGNOSTICS=1` (per-request JSONL and the pool wait/hold meters; a little slower),
`SOAK_PG_LOG_STATEMENTS=1` (log_statement=all, for a short probe), `SOAK_PROFILE_OFF=1`, `SOAK_CPU_WINDOW` (30),
`SOAK_INSPECT=1` (`--inspect=9229`, attach Chrome DevTools live), `SOAK_LOCK` (a lock file other jobs wait on,
taken atomically and only removed if it is this run's), `SOAK_MIN_FREE_GB` (4), `SOAK_MIN_FREE_PCT` (10),
`SOAK_MIN_START_GB` (8), `SOAK_INTERVAL_MS` (5000), `K6_BROWSER_EXECUTABLE_PATH` (default: Playwright's Chromium).
Free disk uses `df -Pk`, so it is the same on macOS and Linux.

## The Node driver (API only)

`SOAK_DRIVER=node` runs `load.mjs` instead of k6: N users loop create, read, list, search, update, count, delete,
and `report.mjs` writes `summary.json` (`SOAK_STAGES`, or `SOAK_WARMUP_S`, `SOAK_DURATION_S`, `SOAK_VUS`,
`SOAK_SNAPSHOTS`). The earlier 500-user runs used it. `report.mjs <dir>` also gives the heap-floor slope,
the heap snapshot diff and the leak verdict, which `report-k6.mjs` reuses.

## One hour on a remote Linux box

Install PostgreSQL 16 (server and contrib, for `pg_stat_statements`), Node 24, k6 (grafana.com/docs/k6/latest/set-up/install-k6/)
and, if you want the browser users, `npx playwright install --with-deps chromium`. Run as a non-root user (initdb refuses root).

    npm ci
    SOAK_STAGES=300:150,3600:150,120:0 SOAK_PROFILE_OFF=1 SOAK_BROWSERS=2 \
      PGBIN=/usr/lib/postgresql/16/bin scripts/soak/run.sh ~/soak-1h

The hold is the hour, after a 5 minute ramp. `monitor.mjs` takes heap snapshots just before and after the hold
(the diff names retainers); for more, append lines such as `snapshot 30min` to `<out>/control` while it runs.
With `SOAK_PROFILE_OFF=1` the heap-floor slope is a leak test: over 1 MB/10 min is a failure. For a profile on the same
box run a separate 5 minute pass without it. Expect `points.json.gz` near 0.5 GB for the hour; the run aborts if free
disk falls under the floor. Use `nohup` or tmux, then copy `<out>` back and open `summary.json`.
