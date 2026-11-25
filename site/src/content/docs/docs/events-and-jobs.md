---
title: Events, jobs and workflows
description: Run work after a command commits, at a set time, on a signed callback, or across days of waiting, without a message broker.
---

Run work after a command commits, at a set time, on a signed callback, or
across days of waiting, without a message broker.

```ts title="examples/apps/lintel/commands/ledger.ts"
export const postRent = defineCommand({
  source: lintel,
  target: 'charge',
  targets: 'none',
  read: ['lease'],
  // …
  output: shape({
    message: text({ max: 300 }),
    period: text({ pattern: /^\d{4}-\d{2}$/ }),
    dueOn: text({ pattern: /^\d{4}-\d{2}-\d{2}$/ }),
    posted: int({ min: 0, max: 100_000 }),
  }),
  events: { posted: rentPosted },
  // …
});
```

See it in the sample (`examples/apps/lintel/commands/ledger.ts:25`).
`rentPosted` is declared in `events.ts` with `defineEvent('rent.posted', shape({ period, dueOn, posted }))`. It carries the output's fields of the same names, recorded in the command's own transaction.

An event that only sometimes happens is a projection that may say nothing: `events: { posted: defineEventProjection(rentPosted, (out) => (out.posted ? { period: out.period, dueOn: out.dueOn, posted: out.posted } : null)) }`. A run where it returns `null` records the command's other events without it, and one where every event is skipped records an empty batch.

<!-- no picture: events, jobs and workflows run on the server; Console's Operations room shows them. -->

## What you'll see

- Exactly one event batch per committed command, and nothing for one that rolled back or was replayed from its receipt.
- A job that runs another command later, or at times, as a service principal whose every attempt is authorized again.
- In Console's Operations room, the App's jobs, deliveries and workflows, with redrive, cancel and retry.

## When to use it, and when not

- Use an event and a job when one committed fact should run another command later: a deadline, a follow-up, a reminder.
- Use a workflow when a process waits days for a callback, a person or a deadline, across several steps that must each happen once.
- Use a command's [`effects`](/docs/commands/#starting-values-other-sources-webhooks) instead to tell an outside system after commit, and the [App API's event feed](/docs/app-api/) for a program that reads events itself.

## Options

| Piece | What it does | From | Status |
| --- | --- | --- | --- |
| `defineEvent(name, shape)` | A fact a command records; the shape's keys are its fields | `@mistriwork/mistri/commands` | Stable |
| `defineJob({ on, runAs, command, schedule })` | Runs a command because of an event | `@mistriwork/mistri/jobs` | Stable |
| `defineJob({ every, timezone, runAs, command })` | Runs a command at times (cron) | `@mistriwork/mistri/jobs` | Stable |
| `defineInbound({ verify, runAs, command, key, input })` | A signed endpoint that runs a command | `@mistriwork/mistri/jobs` | Stable |
| `defineWorkflow({ start, listens, runAs, run })` | A durable process of named steps | `@mistriwork/mistri/workflows` | Stable |

Jobs, inbound endpoints and workflows live in one server-only module, loaded
with `--jobs` beside `--commands`, and never imported by the App. Delivery is
at least once, from queues kept in your database and run by the server
process (there is no broker); each command a job runs keeps one receipt.
Retries, ordering and what survives a restart: [operational guarantees](/docs/operational-guarantees/).

### A job on an event

```ts
decisionDue: defineJob({
  on: { event: applicationSubmitted, command: 'submitToLender' },
  runAs: 'decision-clock',
  command: 'flagLateDecision',
  schedule: event => ({
    runAt: Date.parse(`${event.dueAt.replace(' ', 'T')}Z`) + 60_000,
    key: { id: event.applicationId },
    input: { due_at: event.dueAt },
  }),
}),
```

`schedule` turns the event into the command's target, input and due time, and
must be pure. `runAs` names a principal the module declares
(`principals: { 'decision-clock': { roles: ['automation'] } }`); a role with
generic writes is refused. A job only runs a command.

### A job at times

`nightlyClose: defineJob({ every: '0 6 * * 1-5', timezone: 'America/New_York', runAs: 'clock', command: 'closeStaleQuotes' })`
runs on that wall clock (UTC by default), so six stays six through daylight
saving. `every` is five cron fields, or `@hourly`, `@daily`, `@weekly`,
`@monthly`. The command names no record. Each slot runs once however many
processes serve the App; after a stop, only the latest missed slot runs, and a
first start never runs a missed one. A slot that falls due while the last run
still holds its lease waits for it. In a tenant App a job says
`realm: 'tenant'` (once per active tenant) or `realm: 'platform'` (once, no
tenant's rows). A tenant job may run a command that declares `events` or looks
something up: the event is recorded in that tenant's store as
`service:<principal>`, and the lookup reads global rows, that tenant's own and
the record the command targets. A job that runs a platform command may not, since that
command runs outside any tenant; the server refuses that pair at start.

`timezone: 'tenant'` runs a tenant job on each tenant's own wall clock, the zone
its profile names through `ui.timezone` (the App's default where it names none):
`morningDigest: defineJob({ every: '0 6 * * *', timezone: 'tenant', realm: 'tenant', runAs: 'clock', command: 'sendDigest' })`
is six in the morning at every tenant.

`every: { column, default }` runs a tenant job at the schedule each tenant keeps
for itself, cron text in a column of its profile (`'tenant.<column>'`, listed in
`auth.tenancy.shared`) or of a table it owns its rows of (`'<resource>.<column>'`,
its first row by key):
`weeklyReport: defineJob({ every: { column: 'tenant.report_cron', default: '0 7 * * 1' }, timezone: 'tenant', realm: 'tenant', runAs: 'clock', command: 'sendReport' })`.
A tenant that keeps none runs at `default`; one whose value is not a schedule
runs there too, and the server says so once rather than stalling any tenant. A
tenant that moves its schedule during the day may run once more, or once less,
that day.

`mistri jobs run nightlyClose --app . --jobs jobs.ts` runs it now, once, as the
job's principal, journaled as a slot's run is. It waits while the schedule's
run holds its lease ([command line](/docs/cli/#running-a-job-now)).

### Timers

A machine state's `after` ([actions](/docs/actions/)) and a resource's `at`
are jobs of the module: each minute the host finds the records whose time has
come and runs the command on each, as the first principal granted it. `at`
runs its command once the date or timestamp column's instant has passed and
the record matches `when`, once for each instant the column holds: writing a
new instant arms it again. In a tenant App each run is in its row's tenant. For
a calendar-aware SLA clock, the command that starts or resumes the clock
stores the instants, and `at` fires at them.

```ts
ticket: {
  machine: machine('status', { open: { on: { hold: 'waiting', resolve: 'resolved', breach: 'breached' } }, … }),
  at: { warn_at: { command: 'warnSla', when: "status = 'open'" }, due_at: { command: 'breach', when: "status = 'open'" } },
},

// The command that resumes the clock counts open hours on the desk's own calendar:
await db.ticket.update(record, { status: 'open', due_at: addBusinessMinutes(now(), minutesLeft, deskHours) });
```

A timer may come due `before` or `after` its instant, and a column with
several timers takes a list. Each comes due once per instant, so a moved
appointment is reminded again:

```ts
appointment: {
  at: {
    starts_at: [
      { command: 'sendReminder', before: '24 hours', when: "status = 'booked'" },
      { command: 'sendReminder', before: '2 hours', when: "status = 'booked'" },
    ],
    ended_at: { command: 'askForReview', after: '2 days', when: "status = 'completed'" },
  },
},
```

A timer may name the command that records a failure:
`at: { queued_at: { command: 'postLine', when: "state = 'waiting'", failed: 'failLine' } }`.
When `postLine` is refused for good on a record (any refusal a retry would
repeat, or its attempts spent), `failLine` runs on the same record as a
principal granted it, with the refusal as its two text inputs: `code`
(`ineligible_state`, `invalid_input`, …) and `message`, the sentence a person
would have read, the handler's own where it said one. The job is then done:
the refusal is the record's to keep, and nothing is left failed for an
operator. A record that left its `when` or took a new instant meanwhile gets
neither command. Startup and `mistri check` refuse a `failed` command that does
not declare both inputs (`at-failed`).

### Work larger than one command

One command is one transaction with a
[ceiling on its changes](/docs/commands/#how-many-rows-a-command-may-change).
Work past that (a payer's advice of thousands of lines, a batch over every
open account) is a row per item and a timer that runs one command on each:

```ts
// The resource: one row per item, due as soon as it is queued.
advice_line: {
  at: { queued_at: { command: 'postLine', when: "state = 'waiting'", failed: 'failLine' } },
},

// The command that starts the work queues the rows, in its own transaction.
await db.advice_line.insertMany(lines.map((line) => ({ advice_id: record.id, claim: line.claim, amount: line.amount, queued_at: { auto: 'now' } })));

// One item: its own transaction, receipt and audit, as the jobs module's principal.
postLine: defineCommand({ target: 'advice_line', write: ['ledger'], input: {},
  async handle({ db, record }) {
    await db.ledger.insert({ claim: record.claim, amount: record.amount });
    await db.advice_line.update(record, { state: 'done' });
  } }),

// What a refusal leaves on its row.
failLine: defineCommand({ target: 'advice_line', input: { code: field.text(), message: field.text() },
  async handle({ db, record }, input) {
    await db.advice_line.update(record, { state: 'failed', refusal: input.message });
  } }),
```

- **Each item once.** A row is run once for the instant it holds, whatever is
  retried or swept again, and a unique key on the rows (`UNIQUE (advice_id,
  claim)`) refuses the same item queued twice. The item's command marks its row
  in the transaction that does the work, so the two cannot disagree.
- **Progress.** The rows are the progress: a list of them with a tab per state,
  a related list on the record that queued them, and counts on a dashboard, all
  read as any rows are, under the reader's row access.
- **Failures and retries.** A failed row keeps its refusal. A command a person
  runs on it (`retryLine`) puts it back to `waiting` with a new `queued_at`,
  which arms the timer once more.
- **Who runs it.** The first principal of the jobs module granted the command,
  as every timer; keep who queued the row in a column the command stamps
  (`{ auto: 'me' }`). In a tenant App each run is in its row's tenant.
- **When.** The first rows start within a minute; from then the host reads the
  next page (a hundred rows, or twenty a tenant) as soon as the last is worked
  through, without waiting for the minute.
- **In a test.** `host.runJob('at-advice_line-queued_at')` sweeps the timer now
  and runs every due row: `{ state, code, ran }`.

### A signed callback: inbound

```ts title="examples/apps/lintel/jobs.ts"
paymentSettled: defineInbound({
  verify: hmac({
    secret: 'PAYMENT_CALLBACK_SECRET',
    signature: { header: 'x-processor-signature', encoding: 'hex' },
    timestamp: { header: 'x-processor-timestamp', window: '5 minutes' },
    signed: '{timestamp}.{body}',
  }),
  runAs: 'payment-processor',
  command: 'settleCharge',
  key: (body) => settlement(body).id,
```

See it in the sample (`examples/apps/lintel/jobs.ts:65`).
It is served at `POST /api/inbound/paymentSettled`, before sign-in: the
signature is the credential, verified on the raw bytes before the body is
parsed. `secret` is the name of an environment variable, never the value.
`key` is the sender's id for the delivery and becomes the receipt's key, so a
retry replays one write and answers its receipt. The answer is a status alone:
`204` applied or replayed, `400` a body it cannot read, `401` a bad signature
or time, `409` a reused key with a different body or a refusal, `413` past
256 KB. A text input the command declares with no `max` takes the delivery's
whole text, up to that limit; a declared `max` stops at 65,536 characters (a
larger one is refused when the App loads), so bound a field that must stay
small. `runAs` holds `service: true` roles alone. Deliveries are remembered in
the integrations store (`provisionStores` with the App and its `jobs`). A
tenant App refuses a hand-written one; an [integration's
webhooks](/docs/integrations/#what-core-does) are this same endpoint and are
served per tenant ([what a tenant keeps](/docs/tenant-apps/#what-a-tenant-keeps)).

An endpoint that names a file resource with `files: 'scan'` takes up to 20
files beside its input: the body's `files` is a list of `{ name, type, content }`,
`content` in base64. Each is checked as an upload to that resource is, and the
command's handler receives them as `ctx.files` to store with
`db.scan.insertFile(file, values)`; `key`, `input` and `target` never see them.
Only such an endpoint's body may weigh more than 256 KB: up to the resource's
`maxBytes` in base64, plus 256 KB. A file past that cap is `413`; a part that
is not base64 is `400`. Startup and `mistri check` refuse `files` naming a
resource with no `file`, or one its command does not write.

An [integration's webhook](/docs/integrations/#what-core-does) takes files in
the same way without naming a resource: a signed `multipart/form-data` callback
puts each file part in the mapped command's `field.files` of that name, and the
field's own `accept`, `min`, `max` and the file resource's cap bound it.

### A workflow

```ts title="examples/apps/lintel/late-fees.ts"
export const lateFees = defineWorkflow({
  start: { event: rentPosted, key: (event) => event.period },
  runAs: 'rent-poster',
  async run(w, start) {
    await w.until('grace', graceEnds(start.dueOn));
    await w.run('assess', 'assessLateFees', { input: { period: start.period } });
  },
});
```

See it in the sample (`examples/apps/lintel/late-fees.ts:13`). A step that calls a webhook and waits for its answer reads:

```ts
const check = await w.call<{ id: string }>(
  'request-check',
  'credit-provider',
  { method: 'POST', path: '/checks', body: { applicationId } },
  { retry: { attempts: 4, backoff: '30 seconds', max: '10 minutes' } },
);
const result = await w.waitFor('credit-result', creditReported, { match: (event) => event.checkId === check.id, timeout: '2 days' });
if (!result) return w.run('no-score', 'referToUnderwriter', { target: applicationId });
```

A workflow is an async function of named steps. Each step's result is stored
when it first completes; after a wake-up or restart, finished steps return what
they stored. Register it: `defineJobs({}, { principals, workflows: defineWorkflows({ lateFees }) })`.

| Step | Does |
| --- | --- |
| `w.run(name, command, { target, input })` | Runs an App command as `runAs`, exactly once |
| `w.call(name, connection, request)` | Calls a webhook connection with an `Idempotency-Key`, at least once |
| `w.waitFor(name, event, { match, timeout })` | The first matching event since the instance began, or `null` at the timeout |
| `w.sleep(name, '2 days')`, `w.until(name, date)`, `w.now(name)` | Durable timers, and the time as a step |

Only step results may feed the code between steps: put `Date.now()`, a random
value or a database read in a step, and call steps one at a time. A refusal or
a `4xx` throws `StepRefused`, which the workflow may catch; a `5xx`, 408, 429
or a timeout is retried. A `w.call` whose path leaves its connection's address,
or whose `headers` would replace one the request owns (host, credential,
cookies, content type or length), fails the instance before anything is sent;
a header naming the connection's own `auth.header` is refused as `StepRefused`
with the code `owned_header`. `version` (1 unless you say) is pinned per
instance, and a run that asks for a recorded step with a different kind or
target stops as `diverged`. `authority.lock` lists every step, and
`createWorkflowDriver` from `@mistriwork/mistri/testing` runs the real engine with a clock
that moves only when you say.

### Flows from rows

```ts
flows: {
  from: 'po_flow',
  steps: 'po_flow_step',
  events: { 'po.decided': 'order' },
  kinds: {
    approval: { command: 'requestApproval', input: ['approver'], waitFor: 'po.decided' },
    send: { command: 'sendPurchaseOrder' },
  },
},
```

That binding sits on a `purchase_order` resource, and a jobs module runs it:

```ts
workflows: defineWorkflows({ purchaseFlows: flowRunner('purchase_order', { runAs: 'automation', listens: [poDecided] }) }),
```

A flow can be rows that people edit while the App runs. Each row runs as a
workflow on the resource's records. The columns have fixed names:

| Table | Columns |
| --- | --- |
| `from` (a flow) | `id`, `name`, `start` (`created`, `updated` or `manual`); optional: `condition` (query language), `changes` (the column an update must change), `active` |
| `steps` (a step) | `flow_id`, `position`, `kind`; then the columns its kind reads: `title`, `duration`, `field`, `value`, `condition`, `goto`, `event`, `audience`, `message`, `mode`, `remind`, and a kind's `input` |

| Kind | Does |
| --- | --- |
| `set` | Writes `value` to `field`, one of the binding's `set` columns |
| `wait`, `until` | Waits for `duration`, or until the date in `field` (plus `duration`) |
| `branch` | Goes on when `condition` holds; otherwise jumps to `goto`, or ends the run |
| `waitFor` | Waits for `event` (one of `events`) about this record, at most `duration` |
| `notify` | Tells `audience` the `message` (at most 500 characters), through the notify rule with `on: { flow: audience }` |
| An App kind | Runs its `command` on the record as `runAs`, with the step's `input` columns, then waits for its `waitFor` |

Steps that share a `position` start together, and the run goes on once each
is done. A step of an App kind that waits may also say:

| Column | Does |
| --- | --- |
| `mode` | `any` (one event) or `all`: one event per each the command asked, which it answers as `{ asked: 3 }` |
| `condition` | Ends the wait early once it holds, such as one rejection |
| `duration` | Gives up after it and goes on |
| `remind` | Runs the kind's `remind` command (`remind: 'remindApprover'`) this often, like `1 day`, while it waits |

A record's creation or update starts each active flow whose `start` and
`condition` match, once per change. A flow's own writes start nothing. The
event that ends a wait names the record by the field given in `events`. Steps
are checked when written: a bad one is refused (`422`); a row that broke later
fails its run at `load` with a sentence that names it. A run keeps the rows it
started with, so editing a flow changes only later runs. `flows()` on the
record's page shows its runs and lets a workflows operator start a `manual`
flow. `diagram()` on a flow's page draws its steps (each position a column,
shared positions stacked, a branch's other way to its `goto` or the end); on a
record's page it draws that record's run over the steps: what is done, the step
it waits at, what is ahead. A step the reader cannot read is not drawn. On a
tenant App the record and both tables are tenant-owned, and each run is its
record's tenant's, under that tenant's service principal.

A `notify` step's audience is a name the resource's `notify` rules give, so the
rule, not the row, says who is told and on which channel:

```ts
notify: [{ on: { flow: 'requester' }, to: 'requester_id', title: '{number}: {message}', email: true }],
```

The notice is written in the step's own transaction, so a replayed run tells
nobody twice.

Records that existed before their flows start nothing on their own. Start them
once, beside the running server:

```sh
mistri flows start ticket --app ./tickets --jobs ./tickets/jobs.ts --where 'status = open'
```

Each chosen record is handed to the runner as though just created, so each
`created` flow whose condition holds starts on it (`--flow` names one). A
tenant App runs one `--tenant` at a time. Running it again starts nothing new.

### Provision and operate

`mistri migrate up --app <dir> --jobs <file>` (or `migrate stores up` with the same flags, for the stores alone;
or name the module once, `"app": { "jobs": "jobs.ts" }` in the App's `mistri.json`) creates the job store,
the deliveries the jobs listen on, and the journal and event store the commands
need (from a script, `provisionStores({ sqlite: path }, { app: { id, commands }, jobs })`
from `@mistriwork/mistri/maintenance`; a tenant App passes `app: { tenant: binding, commands }`).
`mistri migrate stores status|up` moves a store to its current layout; serving
never does. A role with `operations: ['jobs', 'deliveries', 'workflows']` reads
and acts on them in Console, and every redrive, cancel and retry is kept with
the operator who made it ([observe and operate](/docs/observe/)). Retry runs a
failed or diverged instance again from its last good step; on a running or
waiting one (Console's Wake) it wakes the instance where it is, for a wake-up
lost to a crash. In a row-policy App each principal runs as a service the
policy's `services` names, in the rows it gives that service.

When a command a job listens to is bumped (`mistri check --bump`), the job's delivery destination in the
store was made for the old version, and a start refuses it. `mistri check` says so as `store-destination-changed`
(exit 8) and `migrate status` shows it, naming the destination and the versions it was made for and has now.
`mistri migrate up --app …` with the server stopped replaces it, once nothing in it is undelivered: while some
deliveries are, it says how many and refuses until they have drained or been redriven. The other way out is to
raise the job's or workflow's own `version`, which makes a new destination beside the old one. Running two
producer versions into one job is not supported, because the handler would need both input shapes. An effect's
destination is new for every bump, and `up` retires the drained ones it leaves behind.

A tenant App's jobs module also declares its email: `mail: { receive, send, links }`
([tenant mail](/docs/tenant-mail/)).

## Common mistakes

- `[job-every-column]`: a job's `every.column` is not a text column the tenant keeps, or the job is not `realm: 'tenant'` → name `'tenant.<column>'` from `auth.tenancy.shared`, or `'<resource>.<column>'` of a tenant-owned table, and say `realm: 'tenant'`.
- A job's `runAs` principal is not granted its command → grant the command to one of the principal's roles; startup and `mistri check` refuse the pair.
- An inbound secret variable is not set → set it in the server's environment; startup refuses, and `mistri check` warns.
- A workflow stops as `diverged` → a step's kind or target changed at the same `version`; raise `version` and branch on `w.version`.

## Related

- [Operational guarantees](/docs/operational-guarantees/): retries, idempotency, ordering and restarts for each of these.
- [Commands](/docs/commands/): what every job, callback and workflow step runs.
- [Fake external services](/docs/service-virtualization/): a provider to call and a callback to receive, in tests.
- [Observe and operate](/docs/observe/): readiness, jobs and deliveries in production.
- [Connections and services](/docs/services/): the webhook connections `post` and `w.call` reach.
