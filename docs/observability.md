# HTTP Diagnostics

Local, opt-in HTTP diagnostics include per-request records and bounded in-process
latency/outcome aggregates. They are not product analytics, distributed tracing,
an audit log or a write receipt.

## Enable

```sh
MISTRI_DIAGNOSTICS=1 npx @mistriwork/mistri --app ./myapp
```

From this repository, use the same environment variable with `npm run start`.
Only the exact value `1` enables diagnostics. Unset, `0` and other values leave
them disabled, with no added request-ID response header. MCP is not instrumented.
These JSONL records are local; the OpenTelemetry export below is separate.

When enabled, each HTTP response gets a generated `X-Request-ID`. Find it in the
browser Network panel and match it with a JSONL event on server stderr. Incoming
request-ID headers are not trusted or reused. Existing human-readable CLI logs
still share stderr; it is not a JSON-only stream.

## Event Contract

Each `http.request` event contains only:

- `timestamp`: the completion/abort time in UTC.
- `requestId`: a server-generated UUID, not a user or record identity.
- `method`: a recognized HTTP method or `OTHER`.
- `route`: a fixed category such as `api.query`, `api.update` or `web`.
- `status`: the emitted HTTP status, or null when no headers were sent.
- `durationMs`: elapsed request time measured with a monotonic clock.
- `outcome`: `completed` or `aborted`, emitted at most once per response.
- `droppedTotal`: the cumulative number of diagnostic records dropped by this sink.

Route categories never contain concrete URL paths, query strings, connection
names, app names or table names. Workbench URLs can contain database predicates,
so recording a raw path is not safe. Events also omit request/response bodies,
headers, credentials, SQL, parameters, business values, exception messages and
stack traces. This allowlist applies to these new events, not to all pre-existing
console output. Review ordinary console logs separately before sharing them.

HTTP status is not a business-operation result. Some endpoints return HTTP 200
with validation errors in the body; this slice intentionally does not inspect
that body. Likewise, a completed response does not prove an operation committed,
and an aborted response does not prove it failed. Use the existing write outcome
and recovery behavior rather than inferring success from diagnostics.

## Aggregate Contract

The same exact opt-in also maintains cumulative HTTP metrics for that diagnostics
instance. The existing explicit `flush()` opportunity, including CLI shutdown,
emits an additional JSONL record with `event: "http.metrics"` and `version: 1`.
Consumers must select records by `event`; the `http.request` shape and generated
correlation headers are unchanged. There is no periodic emission, new endpoint,
flag, collector or background job. Trusted in-process callers can also read
`RequestDiagnostics.snapshot()`; it returns deeply frozen, detached values and
does not export or reset anything.

Each summary contains:

- `started`, `completed`, `aborted`, `inFlight`: observed request lifetimes.
  Finish/close settles a response once. In-flight requests have no terminal
  status or latency sample yet; flush does not wait for them.
- `durationBoundsMs`: `[1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000,
  10000, 30000]`. Each series has 14 **disjoint** `durationBuckets`: the first
  includes zero through 1ms, the next covers greater than 1 through 5ms, and so
  on; the final slot covers greater than 30000ms. All bounds and counters are
  JSON numbers; there is no infinity-valued boundary. Buckets use the monotonic
  elapsed time before per-request display rounding. They include both completed
  and aborted lifetimes. Invalid durations increment `invalidDurationTotal`
  instead of inventing a sample.
- `series`: only observed combinations, in a fixed order. Each contains `method`,
  `route`, `statusClass`, `count`, `completed`, `aborted`, `durationBuckets` and
  `invalidDurationTotal`. Dimensions are the seven recognized methods plus
  `OTHER`; the twelve existing `api.*` route groups plus `api.auth`, `api.other`,
  `web`, `unknown`; and `1xx` through `5xx` plus `unknown`. There are at most
  **768 series**, each with 14 bucket counters. Missing or invalid emitted status
  is `unknown`; an abort after headers retains that HTTP class.
- `health`: `droppedTotal` for lost request records/setup failures, `failed` for a
  disabled output stream, `queuedRecords`, `writingRecord`, `writingSummary`,
  `summaryPending`, and
  `summaryDroppedTotal` for discarded pending or failed aggregate writes.
  Summary loss does not inflate request-record drops. Health reflects the moment
  of capture, before the summary itself is handed to the stream; a stream cannot
  report a later failure through its failed output.
- `capacity`, once the host attaches it (the HTTP server does): the database
  pools and the event loop as they were when the summary was taken, in the
  shape of the support bundle's [capacity section](#capacity).

Request counts and buckets include observed completions whose individual records
were dropped. There is no sampling. No IDs, URLs, bodies, arbitrary labels or
exception messages enter aggregates. For HTTP error proportions, divide the
chosen `4xx`/`5xx` counts by the corresponding terminal request counts; aborts and
unknown statuses remain separately visible. Summaries are cumulative: compare
successive snapshots from the same instance for interval counts; do not sum them.
They reset on process/instance restart, have no durable history or instance ID,
and give coarse latency ranges rather than exact percentiles or request rates.
An HTTP 200 with a business validation error remains `2xx`.

## Delivery and Limits

The sink retains at most 64 request records, including any request write in
flight, plus one aggregate write and one coalesced summary-request bit. It hands
only one record to the stream at a time. Request output is scheduled after
response completion; a requested summary is captured after queued request
records drain. Slow output drops excess request records. The accumulator keeps
fixed dimensions and bucket counts, without retaining individual latency samples
or a separate collection of active requests. A stream error disables further
output; counters and in-process health snapshots remain available.

An explicit flush requests a summary of changed metrics/drop counts; the first
flush can emit an empty summary. Overlapping flush calls share one promise and
the first caller's deadline (250ms by default, clamped to 0–1000ms; non-finite
arguments use 250ms). Unchanged repeated flushes add no summaries. A timeout
returns false but does not cancel the one pending/in-flight delivery; later
flushes can resume waiting without duplicating it. A request arriving after a
summary was captured needs another explicit flush for inclusion in a newer
summary. Concurrent flushes can request that newer cumulative summary, with at
most one pending request for it. Continuous request traffic can prevent the
queue from draining within the flush deadline.

Business requests do not await records, summaries or flush. This is not a
zero-overhead or fully non-blocking I/O guarantee: a synchronous stderr
destination can still stall the event loop while a record is written. CLI
shutdown gives queued records a
bounded flush opportunity, not a delivery guarantee or durable storage. The
summary adds bounded serialization/output work to that opportunity. A successful
flush means the stream callbacks settled, not that storage is durable or all
requests ended. An abrupt exit or in-flight request can still lose diagnostics.
Operators own stderr access, retention and any external collection. Treat
correlation IDs as diagnostic data
and do not use them as metric labels.

## Protected Operator Reads

An authenticated App exposes two operator routes, `GET /api/operations/readiness`
and `GET /api/operations/support`, to verified sessions whose server roles carry
`auth.roles.<role>.operations` — `'readiness'` for the first, `'bundle'` for the
second, and `'workflows'` for the durable workflows room (`/api/operations/workflows`, below). The routes are implemented in
`packages/mistri/src/server/operations/operationsHttp.ts` over the transport-independent contract in
`operations.ts`, `operationsAdapter.ts` and `operationsHeadless.ts`: the host's
existing auth gate verifies the session, the grant is minted per request with a
five-second life, the collector runs only after the grant, and the headless
reader sanitizes the result before it is written with `Cache-Control: no-store`.

Readiness checks are `listener`, `sources` (the App's entry connection is
registered), `policy` (only under `--policy`; not ready while the policy is
unavailable), `diagnostics` (only with `MISTRI_DIAGNOSTICS=1`; degraded
once the sink has dropped a record or failed) and `pools` (once a connection
has opened a database pool; degraded with `pool_saturated` while a checkout is
queued, or one timed out within the last minute). The support bundle adds the
fixed-dimension metrics snapshot when diagnostics are on, and always the
[capacity section](#capacity). Failures are the three codes `invalid_request`
(400), `not_authorized` (403) and `unavailable` (503) with no further detail.
The standalone browser has no route. Nothing probes a database, and `ready` is
not a capacity or availability claim.

### Workflow instances

With `'workflows'` and a `--jobs` module that declares workflows, the host also
answers `GET /api/operations/workflows[?state=&workflow=&after=&limit=]` (a
page of at most fifty instances), `GET /api/operations/workflows/steps?id=`
(the steps, and each operator Cancel and Retry with who and when),
and the POSTs `/api/operations/workflows/cancel` and `/retry` with `{ id }`. They
are gated like the two reads above, by the grant alone, and implemented in
`packages/mistri/src/server/operations/workflowOperationsHttp.ts` over `createWorkflowOperator`
(`packages/mistri/src/server/workflows/workflowOperator.ts`), the in-process twin of the
`inspectWorkflows`, `cancelWorkflow` and `retryWorkflow` maintenance entries.
A reply carries the store's inspection shape only (no event payload, step
result or error text) with times as ISO strings. An instance that stopped on
`workflow_error`, an error its own code threw, also carries `problemError`: the
error's `name` and, when it has one, its `code`, each a short token checked
when it is written and again when it is read, and never the message, which may
quote a payload or a credential. Refusals are a bare code:
`not_authorized` (403), `unavailable` (404 without workflows, 503),
`invalid_request` (400, and 405 for a wrong method), `not_found` (404) and
`not_retryable` (409, for one completed or cancelled). Retry re-enqueues the
instance's wake-up job, so the runner picks it up at once. A failed or
diverged instance runs again from its last good step; a running or waiting one
(Console's Wake) is woken where it is, with nothing forgotten. That is the
repair for a crash between a retry's commit and its enqueue, which left an
instance running with no wake-up: the store moves the instance's epoch, so a
wake-up still pending and the new one may both run, and only the newer takes a
step or finishes. Both are of this App's instances only: on a
PostgreSQL database several Apps share, each App's workflow store is its own
namespace, and another App's id answers `not_found`.

### Capacity

`capacity` answers the question behind "it is slow" — is this process the
limit, its database pool, or the database — from counters the process keeps
anyway. It is read when the bundle is asked for, never per business request,
and like the metrics it is cumulative since start: compare two bundles for an
interval.

- `eventLoop`: `activeMs` and `idleMs`, the event loop's cumulative busy and
  idle time (`performance.eventLoopUtilization()`), whole milliseconds. Busy
  divided by elapsed between two bundles is the loop's utilization.
- `durationBoundsMs`: the pools' bucket bounds, the same thirteen as the HTTP
  metrics; each bucket array has fourteen disjoint counts, the last for
  anything past 30 seconds.
- `pools`: one entry per open pool role, at most 64. `position` is the
  connection's place among the configured ones — the order of mistri.json,
  then the command line — never its name, URL or database. `dialect`
  (`postgres` today), `role` (`read` or `write`), `pooler` (`session` or
  `transaction`), `size` (the most connections the role may hold), `open` (the
  physical connections the driver holds, or null), `inUse` and `waiting` now,
  `saturated`, and cumulative `checkouts`, `queued` (checkouts that found every
  connection in use), `timedOut` (gave up at the 10-second acquisition
  timeout), `failed`, `waitBuckets` (asking to holding, including checkouts
  that failed) and `holdBuckets` (holding to giving back).

A connection not yet opened has no pool to report; SQLite and HTTP
connections keep none. Reading the three answers:

| Pools | Event loop | The limit |
| --- | --- | --- |
| `waiting` above zero, `queued` rising, holds short | not busy | The pool: raise `pool.read` if the database has connections to spare |
| queueing behind long holds | not busy | The database: more connections would queue there instead |
| calm: `waiting` zero, `queued` flat | busy most of the time | This process: add pods |

[Performance and pools](../site/src/content/docs/docs/performance.md#capacity-planning)
has the connection arithmetic the first answer has to fit within.

Coverage: `test/operations-http.test.ts` (real HTTP host, session stub at the
auth boundary, grant precedence, no-store, leak checks, methods, stale account,
standalone refusal, grant expiry), `test/app-operations-grants.test.ts`
(parser, schema, typed DSL, role unions) and `test/capacity.test.ts` (positions
never names, sanitization and bounds, the `pools` check, the HTTP read and the
diagnostics summary).

## OpenTelemetry and the dev observer

Spans, metrics and logs over OTLP/HTTP, switched on by the standard OTEL_*
variables (`src/adapters/telemetry/`), and the `--dev` observer
(`src/server/observe/`) are described for operators and authors in the site's
[Observe and operate](../site/src/content/docs/docs/observe.md). The design, in short:

- One span model (`adapters/telemetry/trace.ts`) with two parts. `attributes`
  travel and are set only from values the code names — route templates,
  statement kind and table, command ids, refusal codes, counts. `detail` never
  travels: it is built only when the local observer listens, and holds the SQL
  with parameters, bodies, command input and output and the refusal's recorded
  cause (`shared/refusal.ts`, the same reasons `http/refusalReport.ts` prints).
- With no sink, `inSpan` calls its function and returns; the exporter, its
  encoders and the driver wrappers are dynamic imports behind the variables.
- Statements are timed at the drivers (node:sqlite, pg) by wrapping
  their `query`, as vendor agents do; the wrappers chain, and the server is
  not bundled, so dd-trace and OneAgent keep hooking the same modules.
- The encoders are hand-written (`otlpEncode.ts`), protobuf and JSON, for the
  same reason the MCP loop is: a dozen stable messages, smaller than the SDK.
- `test/telemetry-otlp.test.ts` seeds secrets into a command round trip and
  scans what a local OTLP receiver got; `test/observe.test.ts` and
  `test/observe-cli.test.ts` cover the observer's masking, loopback rule and
  absence from a start without `--dev`.

Focused regression coverage lives in `test/diagnostics.test.ts` and
`test/request-metrics.test.ts`: fixed cardinality and bucket boundaries, immutable
redacted snapshots, lifecycle outcomes, dropped-record accounting, repeated and
timed-out flushes, failed exporters with real database writes, disabled behavior
and actual CLI shutdown wiring. Coordinate the main verification slot before
running these tests or the type/build gates in a shared worktree.
