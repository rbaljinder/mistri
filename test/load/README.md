# Local Thread load checks

Run `node test/load/run.mjs --smoke` (or `npm run test:load:smoke`). The standalone
harness uses the installed Node 24+, tsx and Playwright Chromium. It imports
neither the e2e configuration nor the shared fixture builder. It never installs
dependencies, builds, deploys, opens an existing preview, or accepts a target.
Use `node test/load/run.mjs --help` for the complete strict CLI and bounds.

```sh
node --test test/load/*.test.mjs
TABLEWALK_LOAD_INTEGRATION=1 node --test test/load/lifecycle.test.mjs
node test/load/run.mjs --smoke
node test/load/run.mjs --smoke --production
node test/load/run.mjs --production --arrival-rps 10 --users 4 --duration 15
node test/load/run.mjs --users 4 --browser-users 1 --duration 15 --rows 500
```

If Chromium is missing, install it separately with `npx playwright install chromium`.
The harness reports the missing browser and stops its server; it does not install it.
The opt-in lifecycle tests use one-second measured windows, verify real gate
failure and signal cleanup, and remain skipped during ordinary unit checks.

Each run checks for 1 GiB available temporary space before creating its directory
and before either load phase. It calls the exported Thread seed in a fresh OS-temp
directory, retains the 24 original issues, and extends to `--rows` total issues
(at most 10,000). Thus the smoke profile's 100 issues include 24 original issues
and 76 synthetic issues. Issue 1 contains a random ownership marker. A fresh CLI
child uses only this database, the Thread sample app, isolated XDG stores, and an
OS-selected loopback port. Its startup log, live child, app response header,
ownership marker, and exact issue count must match before any load starts.
Inherited database/auth/Node/proxy environment options do not enter the child.

The HTTP workers are independent closed loops with one keepalive socket per
user. Each alternates list, exact count, varying issue detail, and backlog list
requests using real POST `/api/run` and `/api/count` calls. HTTP status, application
errors, exact totals, row counts, identity and row contents are checked. Redirects
are refused and response bodies are capped at 2 MiB. Think time follows each
request; users are concurrency settings, never a promised request rate.

Explicit `--arrival-rps 1..100` replaces the HTTP closed loops with a fixed
arrival schedule; `--users` becomes the maximum concurrent HTTP requests.
Each arrival has a deadline independent of previous responses. Full concurrency
drops the arrival rather than queueing it; generator stalls drop expired slots
rather than sending catch-up bursts. Both kinds of drops fail warmup/measurement
even when the error-rate gate is permissive. Reports show offered, admitted,
dropped, cancelled, peak in-flight and maximum scheduler lag. HTTP think time
does not apply in this mode; browser think time still does. HTTP scheduling ends
at the declared window and then drains, without adding arrivals during the final
browser journey. Successful-request latency excludes scheduling delay, which is
reported separately; completion throughput still includes drain.

Each browser user owns an isolated Chromium context. A journey loads the issue
list, waits for visible known content and animation-frame paints, opens issue 1
through its row in the authored record modal, verifies detail fields and the
ownership marker, closes the modal to return to the preserved queue, chooses
Backlog, checks a known backlog row, and returns
to Active. It drains finite resource requests before finishing. HTTP workers
continue through the final in-flight journey, keeping background load active.
No screenshots, video or traces are recorded. Every browser request is restricted
to the owned origin; this routing disables the browser HTTP cache. Service workers
are blocked. Browser request counts cover document/script/style/XHR/fetch traffic;
HMR WebSockets are excluded. Navigation cancellations (`net::ERR_ABORTED`) are
counted separately; other request failures, HTTP errors and page errors fail the run.

Warmup has separate collectors and must be error-free before measurement starts.
Both phases include in-flight drain in their actual elapsed time. The measured
phase admits new journeys for `--duration` seconds; a started journey can extend
the phase by at most its whole-journey timeout, plus request/think-time drain.
Successful-attempt p50/p95/p99 use exact nearest-rank percentiles; failed attempts
are counted separately. Completed operations per second use actual phase elapsed
time, including drain. JSON includes aggregate, endpoint and operation latency,
per-user attempt counts, network counts, settings, OS/CPU/memory, Node, Chromium,
git HEAD/dirty state, and child logs. Markdown includes aggregate and endpoint
tables. Small smoke samples make percentiles coarse.

Defaults gate measured HTTP p95 at 1,000ms, UI journey p95 at 5,000ms and failed
attempt fraction at zero. `--max-error-rate` is a fraction in 0..1, checked
separately for HTTP and browser attempts. Browser infrastructure errors, retired
browser users, absent users or zero successful samples always fail, even with a
permissive error-rate gate. SIGINT/SIGTERM stop owned browser/server resources
and return 130/143; failures return 1. No unrelated process is signaled.

`report.json` and `report.md` are retained beside the small fixture and isolated
stores in the printed `tablewalk-load-*` OS-temp directory. Error examples are
capped at 20 per collector and 1,500 characters each; child log tail is capped at
65,536 characters. Serialized reports have hard limits of 1 MiB JSON and 64 KiB
Markdown. Request latency samples are summarized rather than serialized. Temporary
files are retained for diagnosis and may be removed by the OS; delete the exact
printed run directory when you no longer need that fixture/report. The harness
does not accumulate screenshots or maintain a repository artifact directory.

By default results are labeled `source-dev-vite`. Explicit `--production` launches
the existing `packages/mistri/dist/server/index.js` (under
`--conditions=mistri-built`) with the built client, without tsx or Vite.
It fails clearly when required built artifacts are absent; build separately first.
It never builds, installs, picks an external target or changes ownership checks.
The Thread authored app and seeded fixture are still source-checkout inputs;
this mode tests the built framework, not a separately built App bundle. Existing
artifacts may be stale relative to git HEAD: refresh them deliberately before
comparisons. Reports label this mode `production-dist` and include exact launch
arguments. An optional real lifecycle proof can be run separately with
`TABLEWALK_LOAD_INTEGRATION=1 TABLEWALK_LOAD_PRODUCTION_INTEGRATION=1 node --test test/load/lifecycle.test.mjs`.

Both server modes remain local experiments, not production capacity acceptance.
Fixed-arrival mode establishes offered-load accounting, not a PostgreSQL capacity
result: this fixture is SQLite, and no production service-level target is inferred.
Vite transforms in source mode, browser routing/cache behavior, the shared generator
machine, and concurrent work affect timings. Journey elapsed time is synthetic,
not INP or a real-user Web Vital (`test/built-client-vitals.mjs` measures those,
per page and interaction). A successful safety smoke proves the mechanism;
it is not a capacity baseline. Collect comparisons only on otherwise quiet machines
with equivalent revisions, workloads and environments. This scenario covers reads
and UI navigation, not authentication, writes, tenant isolation or distributed load.
