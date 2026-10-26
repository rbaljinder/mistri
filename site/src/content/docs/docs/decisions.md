---
title: Decisions
description: Let a model answer one field of a record, offered to people as a suggestion and applied by itself only once its model is measured.
---

Let a model answer one field of a record, offered to people as a suggestion and applied by itself only once its model is measured.

```ts title="examples/apps/lintel/jobs.ts"
routeRepair: defineDecision({
  question: 'Which technician should take this repair?',
  target: 'maintenance_request',
  inputs: ['title', 'description', 'category', 'unit_id.property_id.name'],
  answer: { command: 'assignTechnician', field: 'assigned_to' },
  every: '*/15 * * * *',
  timezone: 'America/Denver',
  where: 'status = new and assigned_to is empty',
  suggest: 0.6,
  runAs: 'repair-triage',
  provider: ['jev', 'anthropic'],
}),
```

See it in the sample (`examples/apps/lintel/jobs.ts:49`).
A decision is declared in the jobs module, beside its jobs, and handed to `defineJobs` as `decisions: defineDecisions({ … })`.
The answer's type is the answer command's input field: here a reference to a technician, so the model picks one of the technicians that field's `query` offers.

<!-- no picture: a suggestion is a chip on one field; the e2e suite holds its states and the library story draws them. -->

## What you'll see

- An empty field shows the suggestion in muted ink where the empty mark was, how sure it is in words (*likely*, *very likely*), and **Accept**; a field a person filled keeps their value, the suggestion trailing it. A list marks the empty cell; on a phone, the card's empty fact. Only people granted the answer command see any of it: a resident is not shown the technician suggested for their own repair; the office, which assigns, is.
- **Accept** runs the answer command as you, under your own grants. The ⋯ menu has **Change…** (its form, the suggestion filled in), **Dismiss**, and **Why this?**: the question, the inputs with the values you may read, the model and its version, the percent.
- A value applied by itself looks like any other; its history line names the decision and how sure it was.

## When to use it, and when not

- Use it for a field people fill by judgment from the record's other fields: a category, a priority, who takes it, a yes or no.
- Use a [command](/docs/commands/) with a rule instead when the answer follows from the fields every time; a rule is never wrong and costs nothing.
- Use the [assistant](/docs/assistant/) instead when a person asks the question, in their own words, about whatever they are looking at.

## Options

| Key | Does | Default | Status |
| --- | --- | --- | --- |
| `question` | What is asked, sent as written and shown in "Why this?" | required | Stable |
| `target` | The resource the decision is about: the answer command's target | required | Stable |
| `inputs` | The record's columns, rollups, computed columns and label paths it is asked from; never a `hidden` or redacted column | required | Stable |
| `answer` | `{ command, field }`: the command that lands it and its input field | required | Stable |
| `on` | `{ event, command, key }`: ask after that command commits, about the record `key` names | — | Stable |
| `every`, `timezone`, `where`, `limit`, `realm` | Or ask on a clock, about the records `where` holds, at most `limit` a slot | `limit` 500 | Stable |
| `suggest` | The probability at or above which a person is offered it | 0.6 | Stable |
| `apply` | The probability at or above which the command runs by itself, once its model is pinned | never | Stable |
| `runAs` | The principal it reads and runs as, declared in the jobs module | required | Stable |
| `provider` | `'jev'`, `'anthropic'`, or a list: the first asked, the next only while it fails, and a fallback only suggests | required | Stable |
| `model`, `deadline`, `fresh` | The provider's model; how long it may take (`'3 seconds'`); how long a failing call is retried (`'10 minutes'`) | the provider's, 3 s, 10 min | Stable |

The server reads `JEV_API_KEY` or `ANTHROPIC_API_KEY` from its environment; without one it asks no one and nothing is shown.
Provision the decision store once with `mistri migrate stores up --app <dir> --jobs <file>`.
Only the inputs' names and a digest of what was sent are kept, never their values.

A decision applies only with a model you measured on records people already settled:

```sh
mistri decide eval routeRepair --app examples/apps/lintel --jobs examples/apps/lintel/jobs.ts \
  --policy examples/apps/lintel/policy.ts --truth "status is done" --dry
```

`--dry` prints what one record would send. Without it the command prints the count and a cost estimate, and asks only with `--yes`. `--pin` writes the provider's model version into `decisions.lock` beside `app.ts`, only when the share it would apply was wrong at most 2% of the time. A different model version only suggests until you measure it again.
In a tenant App a customer's decisions run only after the platform owner turns them on for that customer, per provider, in **Account → Manage tenants**; each customer's members see only their own customer's suggestions.

## Common mistakes

- No suggestions ever → set a provider key for the server and provision the store; in a tenant App, turn decisions on for that customer. Shown to one person and not another → only a role granted the answer command sees it.
- `check` refuses an input → read it through the answer command: add its table to the command's `read`.
- A decision that never applies → it has no pin; run `mistri decide eval --pin`, or leave `apply` out and let people accept.
- A New-form insert asks nothing → `on` follows a command; open records through a command, or ask on a clock.

## Related

- [Events, jobs and workflows](/docs/events-and-jobs/): the triggers and principals a decision runs on.
- [Commands](/docs/commands/): the command an answer lands through.
- [Add an assistant](/docs/assistant/): questions a person asks.
