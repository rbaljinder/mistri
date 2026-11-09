---
title: Operational guarantees
description: For command receipts, events, jobs, workflows, webhooks and integrations, what is retried and how often, what is deduplicated, what is ordered, what survives a restart, and what your code must do.
---

For command receipts, events, jobs, workflows, webhooks and integrations, what
is retried and how often, what is deduplicated, what is ordered, what survives
a restart, and what your code must do.

```ts
// A job that must run once per event, however many times the server retries it.
decisionDue: defineJob({
  on: { event: applicationSubmitted, command: 'submitToLender' },
  runAs: 'decision-clock',
  command: 'flagLateDecision',      // idempotent by the receipt the job's key gives it
  schedule: (event) => ({ runAt: Date.parse(event.dueAt) + 60_000, key: { id: event.applicationId }, input: {} }),
}),
```

Everything here is **at least once** on the wire and **at most once in your
tables** wherever the command it reaches keeps a receipt: the delivery is
retried until it is acknowledged, and a repeat is answered from the receipt
instead of running again. Jobs, workflows, inbound endpoints, the App API and
MCP always keep one. A browser action keeps one only with `track` or an
`Idempotency-Key` header ([where a receipt is kept](/docs/commands/#when-the-outcome-is-uncertain));
an untracked action sent twice after an uncertain answer can run twice, so
give it a key, or declare `track`, before a client retries it. mistri has no broker; each queue is a table in your database
(or the App's job store), so a restart loses nothing that was committed.

## At a glance

| Mechanism                                             | Retries                                          | Deduplicated by                                                   | Order                                              | After a restart                                                                    |
| ----------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| A command (`/api/commands/execute`, the App API, MCP) | None: the caller retries                         | The idempotency key and the actor, where a receipt is kept        | None between requests                              | A receipt answers a retry, for as long as `retention.commands` keeps it            |
| An event                                              | None: a fact is a row written with the receipt   | The receipt: one batch per committed command                      | Declaration order within one command               | Discovered from the committed receipts                                             |
| A job on an event                                     | 8 attempts, 1 s doubling to 60 s                 | The job, its version and the event id, which is the command's key | None between jobs; a job's own slots never overlap | The lease expires, the attempt is recorded as unknown and the job is claimed again |
| A job at times (`every`)                              | As a job                                         | The slot                                                          | One slot of a job at a time                        | The latest missed slot runs once; a first start runs none                          |
| An inbound endpoint                                   | None: the sender retries                         | `key`, which becomes the receipt's key                            | None                                               | The delivery store remembers it                                                    |
| A command's webhook effect                            | 8 attempts, 1 s doubling to 5 min                | `Idempotency-Key`, the same on every attempt                      | Declaration order within one command               | Retry state and attempt counts are kept                                            |
| A workflow                                            | A step's own `retry`; `run` 3 attempts, `call` 5 | Each step's stored result; `run` by command receipt               | Steps run in order                                 | Finished steps return what they stored; an unfinished one resumes                  |
| An integration call                                   | 3 tries, 250 ms then 500 ms                      | The idempotency key the provider dedupes by, and the journal      | Inside the command's lookup                        | The command's receipt answers a replay                                             |
| An integration channel message                        | 8 tries, a minute apart                          | The message row                                                   | Held through quiet hours                           | Held and failed rows are kept                                                      |
| Notification email                                    | 8 tries, 1 minute doubling to 1 hour             | The queued message                                                | None                                               | Queued in the write's own transaction                                              |

## Command receipts

A command ends applied, refused or unknown, and a request sent again under the
same key and input is answered from the first run's receipt. The full contract,
including how long receipts are kept, is
[when the outcome is uncertain](/docs/commands/#when-the-outcome-is-uncertain).

What you must do: send a key that is stable across retries of one intent
(`crypto.randomUUID()` made once and kept), keep the request while the answer is
`unknown`, and ask `POST /api/commands/status` before sending again. Never retry
under a new key.

## Events

A command that declares `events` records them in the same transaction as its
receipt: exactly one batch per committed command, nothing for a rollback, and
nothing again for a replay. Delivery to a job or a webhook starts from the
committed receipts, so an event exists if and only if the command committed.

- **Order.** Facts of one command are delivered in the order the command declared them, and a later one waits until the earlier one is accepted. Between commands there is no order promise: a receipt waiting out a backoff does not hold up another receipt or another destination.
- **After a restart.** Discovery reads the committed receipts again and never regenerates one. A delivery that was leased when the process died is released as unknown when its lease expires and tried again.
- **Retention.** The finished tries are forgotten after `retention.attempts` (30 days); the receipt of a command that recorded events is kept while its events are.

What you must do: record facts, not instructions, and make the consumer safe to
see a fact twice.

## Jobs, timers and inbound endpoints

**A job on an event** runs a command as a service principal.

- **Retries.** A failed attempt is tried again after a backoff of 1 second, doubling to 60 seconds, up to 8 attempts. A job module's `store` can set `maxAttempts` (1 to 32), `leaseMs` and `backoffMs`. After the last, the job waits as failed for an operator; **Console's Operations room** or `redriveJobs` from `@mistriwork/mistri/maintenance` gives it a fresh budget and records who did it.
- **Idempotency.** The command's key is a hash of the job, its version and the event id, the same on every attempt and every re-delivery. An attempt after the first looks the receipt up before it runs the command, so an attempt whose outcome was lost lands on the receipt that exists.
- **Authority.** No grant is kept: every attempt is authorized again, and a principal whose grant was removed fails `not_authorized` without running the handler.
- **Concurrency.** An App's jobs run one at a time by default (`maxInFlight` is held at the source's one writer), so a job's command queues with HTTP's rather than beside them.
- **After a restart.** A job that was running holds a lease of 30 seconds. When the lease expires with no outcome, the attempt is recorded as unknown and the next attempt takes the job over with the same key. Queued and retrying jobs are rows, and are still there.

**A job at times** (`every`) and the timers (`after`, `at`) run each slot once
however many processes serve the App; the job store's lease decides. After a
stop only the latest missed slot runs, and a first start never runs a missed
one. A slot that falls due while the last run still holds its lease waits for
it. `mistri jobs run <name>` is a manual run in the same store and never
overlaps the schedule's.

**An inbound endpoint** is served before sign-in and verified on the raw bytes.
`key` becomes the receipt's key, so the sender's retry replays one write and is
answered `204`; the same key with another body is `409`. mistri does not retry
an inbound delivery: the sender does. A delivery is remembered in the
integrations store.

What you must do:

- Make `schedule` pure, and give it a `key` that names the thing, not the attempt.
- Grant the principal exactly the command; a role with generic writes is refused.
- Treat the command as the unit of idempotence, not the job: put the work in the command, so the receipt covers it.
- Provision the stores (`mistri migrate up --app <dir> --jobs <file>`) before you start; serving never creates them.

## Webhooks from commands (effects)

`effects: { notify: post('hook', …) }` is written with the receipt and sent
after commit: never for a refusal, never again for a replay.

- **Retries.** A request is given 12 seconds. A non-2xx answer is asked again after 1 second, doubling to 5 minutes, up to 8 attempts, then waits for an operator. A 5xx is asked again with the same key; a 4xx is asked again until its attempts are spent, then fails, readiness says so, and a redrive sends it again.
- **Idempotency.** The `Idempotency-Key` is the same on every attempt. The receiver must deduplicate by it: delivery is at least once.
- **Order.** Declaration order within a command; none between commands.
- **After a restart.** The delivery rows keep their attempt counts and backoff.

## Workflows

A workflow's steps store their results when they first complete.

- **`w.run`** runs an App command as `runAs` exactly once: the step's result and the command's receipt both say so, and a process killed after the command committed resumes without running it again.
- **`w.call`** posts to a webhook connection with an `Idempotency-Key`, at least once.
- **Retries.** A step retries its `5xx`, `408`, `429` and timeouts with exponential backoff: `run` 3 attempts from 5 seconds up to 5 minutes, `call` 5 attempts from 10 seconds up to 10 minutes, or the step's own `retry` (up to 32 attempts). A refusal or a `4xx` throws `StepRefused`, which the workflow may catch.
- **After a restart.** Finished steps return what they stored; an unfinished one resumes. `diverged` stops an instance whose code changed a recorded step under the same `version`. Console's Wake wakes an instance whose wake-up was lost to a crash.

What you must do: put `Date.now()`, a random value or a database read in a step,
call steps one at a time, and raise `version` when you change a step's kind or
target.

## Integrations

- **Calls** from a command's lookup are journaled under an idempotency key the provider dedupes by, tried up to 3 times (250 ms, then 500 ms apart, 12 seconds each), and answered from the journal when the command is replayed. `refuse(reason)` is a definite no and is not retried; any other throw is.
- **Webhooks** are an inbound endpoint: a delivery more than five minutes from now is refused, and the same event id and time is taken once. An event the App does not map is `202`.
- **Channel messages** are held through quiet hours, suppressed without consent or after an opt-out, and logged either way. A held message the provider will not take is tried again a minute on, 8 times in all, then recorded failed.
- **After a restart.** Secrets, held messages and their attempt counts are rows in the integrations store.

What you must do: pass the `idempotencyKey` core gives an action through to the
provider's API, read `at` from what the signature covers, and map each webhook
event to a command that is safe to see twice.

## What differs in a tenant App

- A tenant job's, mail command's or flow step's command may declare `events` and look up: the fact is recorded in that tenant's store as `service:<principal>`. A platform job's command may not (the server refuses it at start: platform jobs run outside any tenant).
- A hand-written `defineInbound` is refused; an integration's webhooks are served at `/api/inbound/<name>/<tenant>`, verified with that tenant's secret.
- A job at times says its `realm`: once per active tenant, or once for the platform.
- The App API has no event feed; deliver events through webhooks.

[What a tenant keeps](/docs/tenant-apps/#what-a-tenant-keeps) has the table.

## Before production

- Run `mistri check --app <dir> --jobs <file>`: it names a store the database still lacks (`store-pending`), a job whose command was bumped (`store-destination-changed`) and an inbound secret variable that is not set (a warning).
- Watch `/readyz` for `jobs` and `effects`: an exhausted delivery makes the check say so.
- Decide who redrives. A failed delivery waits for an operator with the `jobs`, `deliveries` or `workflows` operations ([observe and operate](/docs/observe/)).
- Size the windows: `retention` keeps attempts 30 days and receipts 730 days unless you say otherwise.

_Proved by:_ `test/job-runner.test.ts` (a handler error retries as the next attempt; a timeout is unknown and a later runner takes over; a revoked grant fails without the handler), `test/event-delivery-store.test.ts` and `test/event-delivery-outage.test.ts` (restart keeps attempts, declaration order, the attempt ceiling, recovery in receipt order), `test/job-every.test.ts` and `test/jobs-run.test.ts` (each slot once across servers, no missed slot on a first start), `test/inbound-webhooks.test.ts` (a replay answers the first delivery's receipt; the same id with another body is 409), `test/command-effects.test.ts` (sent after commit, never twice for a replay, never for a refusal; a 5xx or 4xx asked again, then a redrive), `test/workflow-engine.test.ts` (a process killed after a command committed resumes without running it twice; a failing provider is asked again after its back-off), `test/integrations.test.ts` (a held message is tried eight times, a minute apart; a command's integration call is tried three times, then refuses), `test/jobs-cli.test.ts` (a job is attempted eight times, backing off from 1 second to a 60-second ceiling), `test/tenant-job-events-lookups.test.ts` (a tenant job records events and looks up as its service; a platform job's command that does either is refused at load), `test/business-command-execution.test.ts` (a key retried after its receipt was pruned is a new request).
