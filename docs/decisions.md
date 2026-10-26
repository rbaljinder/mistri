# Decisions

A decision is a typed question a model answers about one record's field, with a
probability: a category, a priority, who takes it, a yes or no. The answer is
offered to a person as a suggestion on the field, and lands by itself only
when the model was measured on records people already settled. This file is
the design record: what a decision may do, under whose authority, what is kept,
and why. The site's "Decisions" page is the author's half; this is the
maintainer's.

Everything lives in mistri, beside the assistant: the vocabulary
(`server/decide/decisionModule.ts`, exported from `@mistriwork/mistri/jobs` as
`defineDecision` and `defineDecisions`), the runtime (`server/decide/`), the
providers (`server/decide/providers/`: Jev, Anthropic and the scripted
double, each plain `fetch`, no SDK), the store (`adapters/decide/`), the
tenant switch (`server/tenant/tenantAdministration.ts`, `setTenantDecisions`),
the record and list UI (`client/components/DecisionChip.tsx`,
`decisionAdornment.tsx`, `decisionMarks.tsx`) and the eval
(`server/cli/decideCommand.ts`, `evaluateDecision` in `@mistriwork/mistri/testing`). Kit
holds two props-only slots and imports nothing of it.

## The one rule: a decision is a command someone could have run

A decision has no write path of its own. Its answer is the input field of an
ordinary command (`answer: { command, field }`), so its type is that field's
(choice, number, yes or no, reference, list of references), and landing it is
that command's business: its grants, its `when`, its machine, its
transaction, its history line. Concretely:

- **It never runs inside a handler.** A model call would hold a write
  transaction. A decision runs after a command commits (`on`, a job's
  trigger) or on a clock over the records `where` holds (`every`); each
  becomes a job of the module under the reserved `decide-` prefix, so it has
  the jobs host's lease, attempts, backoff and redrive for free.
- **It reads as its principal, through the answer command.** `runAs` names a
  principal the jobs module declares. Inputs and a reference's choices are
  read through the answer command's authorization as that principal: its
  grants, its `fields`, a row policy's rows for the service, a tenant's
  lease. `check` refuses an input outside the command's `read`, a `hidden` or
  `audit.redact` column, and anything that is not a record field: there is
  no prompt template and no free text.
- **It applies only what is pinned.** At or above `apply`, the command runs as
  `runAs`, and only when `decisions.lock` pins the provider's model version
  for that decision; another version, or a fallback provider, only suggests.
  The stale guard re-reads the field before the command: a value a person set
  since the trigger is never overwritten, and the answer is demoted to a
  suggestion beside it.
- **People accept as themselves.** Accept runs the same command from the
  browser, as the person, through the ordinary command route; Change opens its
  form prefilled. The decision row is then settled by reading the record as it
  now is (`accepted`, or `corrected` with the chosen value), never on the
  client's word.
- **Only someone who could accept it sees it.** A suggestion is offered to a
  person granted the answer command, and to no one else: a resident reading
  their own repair is not told which technician the model picked; the office,
  which assigns, is. The server enforces it (`http/decisionRoutes.ts`,
  `answerDecisions`): the payload names only the granted decisions' fields,
  the record and list routes answer only their rows, and "Why this?" or a
  settle about any other is refused as not found. Reading the record is not
  enough, since a suggestion is an offer to run a command.

## What is kept

The store is `__mistri_decision_*` in the App's database (on PostgreSQL, `mistri.decision_*`), provisioned like the
assistant's (`mistri migrate stores up`, `provisionStores(…, { only:
['decisions'] })`), attested at start and never created by serving. Every
statement names `(app, tenant)`.

| Table | Holds |
| --- | --- |
| `__mistri_decision_meta` (`mistri.decision_meta`) | the layout version |
| `__mistri_decision_record` (`mistri.decision_record`) | one row per asking: decision, contract version, record key, trigger, provider, model and version, the SHA-256 of what was sent and the input names, the answer and probability, the outcome and who settled it, latency, cost |
| `__mistri_decision_usage` (`mistri.decision_usage`) | calls and cost per tenant and day, for caps and the bill |
| `__mistri_switch_tenant` (`mistri.switch_tenant`) | a tenant App's switch per customer and provider (feature `decide:<provider>`), with its consent reference; the tenant switch store the assistant shares |

**Values are never stored.** "Why this?" shows the input names and the
current values the reader may read, so nothing a reader could not see leaks
through a decision. Outcomes are `applied`, `suggested`, `accepted`,
`corrected`, `ignored`, `below` and `none` (timeout, error, invalid, cap,
refused). A suggestion untouched for fourteen days is `ignored`; a person
editing an applied value marks it `corrected`, which is what auto-apply's
accuracy is judged by. Rows go after `decisions.retentionDays` (365); usage
rows stay; closing a tenant deletes its rows in the same transaction.

## Consent and failure

- **Off until turned on.** An ordinary App's switch is the operator's
  environment: no `JEV_API_KEY` or `ANTHROPIC_API_KEY`, no calls. A tenant
  App's customer is off until the platform owner turns decisions on for it,
  per provider, with a consent reference, through `setTenantDecisions`; a
  tenant's delegate may turn it off, never on; support sessions and the
  platform realm never get it. Read before every call; off records nothing. A customer's members are
  answered from their own tenant's rows alone, through the tenant server's
  lease (`tenant/tenantHttp.ts`): another tenant's suggestion is not found,
  as its record is. A tenant's decision reads its record inside its answer
  command's fenced transaction, scoped to that tenant, and writes nothing
  there (`decideReads.ts`); the service binding opens no other.
- **Never blocks a write, never waits on a model past its deadline.**
  `deadline` (3 s) ends a call as `none (timeout)`; 429s and 5xx retry until
  `fresh` (10 min); five failures open a per-process circuit for a minute, and
  the next provider is asked, which only suggests. Caps refuse before the
  call (`none (cap)`). An answer outside the field's type, a key not offered,
  or a probability outside [0, 1] is `none (invalid)`.
- **Contracts are locked.** `decisions.lock` beside `authority.lock` records
  each decision's contract digest (question, inputs, answer type, providers)
  and the pins `mistri decide eval --pin` earned. A changed contract
  needs `--bump`; a pin lapses with it.

## Measuring before applying

`mistri decide eval <decision>` asks the provider about records whose
answer people settled (`--truth`), with their inputs put back as they were
before the answer where record history keeps them, and reports accuracy,
Brier, calibration error, a reliability table and what the thresholds would
have done. It prints the count and an estimate first and spends only with
`--yes` under `--max-cost`; `--dry` prints what one record would send, for a
consent review. It writes nothing and never applies. `--pin` writes the pin
only when the share it would apply was wrong at most `--max-error` (2%).
A row-policy App names its policy (`--policy`) and is read as its service
reads it; a tenant App is refused, since its records are its customers': it
is evaluated on a consented export served as an ordinary App.
`evaluateDecision` in `@mistriwork/mistri/testing` gives an App's own tests the same
report against a scripted model.

## The UI holds still

A suggestion is drawn by mistri through two kit slots read from the shell:
`useFieldAdornment` at a record's field (every record page: routed, dialog,
split) and `useCellMarks` in a list's empty cell. On a phone a list draws
summary cards, not cells, and the same slot marks a card's empty fact: the
fact keeps its empty mark's box, and the glyph is drawn over it, hidden mark
and all, so nothing reflows. The record's suggestions
are asked beside its read; until they answer a field keeps its empty mark,
and a header holds its facts' line only while a column being asked is an
empty fact there, so an arriving chip moves nothing (`e2e/decide.spec.ts`
measures zero layout shift at 1280 and 390, for the list mark, and for the
phone card's). The
chip's code loads the first time a record has one. Confidence is said in
words (almost certain ≥ 0.95, very likely ≥ 0.85, likely ≥ 0.70, possible);
the percent is only in "Why this?".

## Limits, on purpose

- A New-form insert is not a command and has no save hook, so `on` cannot
  follow it; ask on a clock instead.
- A workflow step that waits on an answer, bulk accept, and a fitted
  calibration map per provider come after 1.0; until then an unpinned or
  fallback answer only suggests.
- A card's mark is on an empty fact the card shows; a decided column the
  card leaves out is met on the record's chip.
