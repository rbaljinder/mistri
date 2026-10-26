---
title: Observe and operate
description: See what a running App did, send its traces to your collector, and give operators readiness, a support bundle and redrive.
---

See what a running App did, send its traces to your collector, and give operators readiness, a support bundle and redrive.

```sh
npx @mistriwork/mistri --app ./my-app --dev                      # while building: the dev observer
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318 \
OTEL_SERVICE_NAME=loans npx @mistriwork/mistri --app ./my-app   # in production: OpenTelemetry
```

<!-- no picture: the observer is a loopback-only dev page; a screenshot would show one machine's traffic. -->

## What you'll see

- With `--dev`, `http://localhost:4111/_mistri/observe/` shows every request as a waterfall: its SQL with parameters, commands with their input and refusal cause, logs, N+1 and slow statements, and the page's web vitals.
- With the `OTEL_*` variables set, a trace per request, a span per statement, command, job, delivery and outbound call, and a log line per refusal.
- Neither sends a row value, a body, SQL parameters, an email or a token off the machine; the observer masks credentials and hidden columns.

## When to use it

- Use the dev observer while you build; a refusal on the page links to it.
- Use OpenTelemetry in production, to a Collector, Datadog or Dynatrace; with no variables set nothing is loaded.
- Use the operator routes and maintenance entries to check readiness or redrive failed work without access to the data.

## OpenTelemetry

Only the standard variables, over OTLP/HTTP (gRPC is not spoken, so point at the HTTP port, usually 4318):

| Destination | Set |
| --- | --- |
| OpenTelemetry Collector | `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318` |
| Datadog | The Agent's OTLP intake (`otlp_config.receiver.protocols.http`): `OTEL_EXPORTER_OTLP_ENDPOINT=http://datadog-agent:4318` |
| Dynatrace | `OTEL_EXPORTER_OTLP_ENDPOINT=https://{env-id}.live.dynatrace.com/api/v2/otlp` and `OTEL_EXPORTER_OTLP_HEADERS="Authorization=Api-Token%20${DT_API_TOKEN}"` |

`OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, the per-signal endpoints, samplers, `OTEL_EXPORTER_OTLP_COMPRESSION=gzip` and `OTEL_SDK_DISABLED=true` are read too. W3C `traceparent` is read on requests and MCP calls and sent on webhooks and HTTP sources.

Metrics: `http.server.request.duration`, `db.client.operation.duration`, `mistri.command.executions` and `.duration`, `mistri.job.attempts`, `mistri.outbound.calls`.

## Health and readiness

| Route | Answers | For |
| --- | --- | --- |
| `GET /healthz` | 200 while the process runs | Liveness |
| `GET /readyz` | 503 while starting, while a row policy restarts, while a tenant App's writer is closed after an uncertain write, and from shutdown on | Readiness, an orchestrator's rollout |
| `GET /api/app` (`/api/whoami` with sign-in) | The App | A load balancer's health check |

Nothing probes a database: `ready` is not a capacity claim.

A tenant App's writes share one writer. When a write's outcome cannot be confirmed (a COMMIT sent and never acknowledged), the writer closes, refuses writes and reopens by itself, backing off from one second to a minute, logging a line each way that says whether the uncertain command committed. While it is closed `/readyz` answers 503. A command retried with its idempotency key is answered from its receipt, never run twice. Under `--base-path` the probes move with every other route: `/desk/healthz`.

## Operator reads

`operations` is a grant of its own; no data or command grant implies it:

```ts
operator: { read: true, operations: ['readiness', 'bundle', 'workflows'] },
```

| Grant | Opens |
| --- | --- |
| `'readiness'` | `GET /api/operations/readiness`: a `ready` flag and named checks (`sources`, `pools`, `jobs`, `effects`, …), each a state and a code, never an error message |
| `'bundle'` | `GET /api/operations/support`: readiness, HTTP metrics, and the capacity section below. No names, paths, SQL, values or identities |
| `'workflows'` | The [workflows](/docs/events-and-jobs/#a-workflow) room |
| `'jobs'`, `'deliveries'`, `'stores'`, `'analytics'` | That App in the Console's [Operations and Analytics rooms](/docs/suites/#operations-and-analytics-rooms), in a suite |

These need an App that signs people in. `MISTRI_DIAGNOSTICS=1` adds an `X-Request-ID` per response and one JSONL `http.request` event per request on stderr.

### The capacity section

Cumulative counters, so compare two bundles: the event loop's busy and idle time, and for each PostgreSQL pool its size, `inUse`, `waiting`, `queued` and `timedOut`. [Reading the pool meters](/docs/performance/#reading-the-pool-meters) says which pattern means add pods, raise a pool, or look at the database.

## Failed jobs and deliveries

Failed jobs and webhook deliveries wait for an operator. Outside a suite's Console, run these from `@mistriwork/mistri/maintenance`:

| Jobs | Event deliveries |
| --- | --- |
| `inspectJobs`, `inspectJobAttempts` | `inspectEventDeliveries` |
| `redriveJobs` | `redriveEventDeliveries` |
| `pruneJobs` | `pruneEventDeliveries` |

A redrive puts the work back in line and records the operator. A worker that halts stays halted until the process restarts.

## Common mistakes

- The observer address answers 404 → the server started without `--dev`; `npx @mistriwork/mistri observe` prints the address when it is on.
- Nothing reaches the collector → the endpoint is the gRPC port (4317); use the HTTP one (4318).
- An operator gets `not_authorized` (403) → grant `operations` on their role; no data or command grant includes it.
- A balancer takes pods out while a row policy restarts after a save → point its health check at `/api/app`; `/readyz` is for the orchestrator.

## Related

- [Performance and pools](/docs/performance/): what the meters mean and how to size.
- [Build and deploy](/docs/build-and-deploy/#behind-a-load-balancer): health checks behind a balancer.
- [Workflows](/docs/events-and-jobs/#a-workflow): the instances the `'workflows'` grant opens.
- [Several Apps in one server](/docs/suites/): the Console's Operations room.
