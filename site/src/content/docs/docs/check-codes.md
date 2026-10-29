---
title: mistri check
description: Run every check on an App in one command, read the exit code and the JSON an agent reads, and look up any code's fix.
---

Run every check on an App in one command, read the exit code and the JSON an
agent reads, and look up any code's fix.

```sh
npx @mistriwork/mistri check --app . --config mistri.json
#   schema types  passed  mistri-schema.d.ts matches the database
#   typecheck     passed  tsconfig.json
#   validation    failed  1 problem
```

Every step runs, each says its verdict on one line, and the exit code names
the first that failed. Warnings never fail a step. An App that uses a
[Preview feature](/docs/status/) gets one line naming them
(`preview: This App uses Preview features (flags, experiments). …`), which
fails nothing.

## Steps and exit codes

| Exit | Step | What it does |
| --- | --- | --- |
| 0 | — | Every step passed or was skipped as said |
| 1 | could not check | No App directory, no database, a config listing another App, or a flag that is a mode of its own |
| 2 | schema types | Rewrites `mistri-schema.d.ts` when the database drifted; fails when the database cannot be opened |
| 3 | typecheck | The App's `tsconfig.json`; each error as file:line with tsc's own code (`TS2322`) and a hint |
| 4 | validation | Loads the App against the database: every problem, with its file, and `authority.lock` |
| 5 | components | Custom components read for what may never ship |
| 6 | pending | With `--pending`: the pending migrations failed on a scratch copy ([change your schema](/docs/change-your-schema/)) |

`--routes` adds every address the App answers to, and `--design` adds the
[design checks](/docs/design-lint/).

## For an agent: `--json`

`--json` runs the same steps and prints one document, with the same exit code:

```json
{ "version": 1, "app": { "id": "tick", "name": "Tick" }, "ok": false, "exit": 4,
  "steps": [{ "step": "validation", "status": "failed", "detail": "Tick: 1 problem" }],
  "problems": [{ "code": "unknown-column", "severity": "error", "step": "validation",
    "file": "app.ts", "line": 51, "path": "views.tasks.tabs",
    "message": "view \"tasks\": \"due\" is not a column on task. Did you mean \"due_on\"?",
    "docs": "https://mistriwork.dev/docs/check-codes/#unknown-column" }] }
```

Each problem has `code`, `severity` (`error` fails its step; `warning` and
`info` never do), `step`, `message` and `docs`, and where known `file`,
`line`, `column`, `path` (where in the App definition) and `fix`. The codes
and fields are the contract; a message may change. The document is described
by `@mistriwork/mistri/schema/check.schema.json`, and `mistri observe --mcp` has a
`check` tool that answers it with no server running. Each `docs` link lands
on the code's row below.

## For an agent's context: `--brief` and `explain`

`--brief` prints one line per problem and nothing else, with the same exit
code: `code file:line message — fix: …`. A finding the check gave no fix for
borrows the one below; `ok` is a clean App. Information is not a problem, so
the one `info` finding it says is `preview-feature`, as a last line
(`preview-feature (info) app.ts This App uses Preview features (…). …`).

```sh
npx @mistriwork/mistri check --app . --config mistri.json --brief
# unknown-column app.ts:51 view "tasks": "due" is not a column on task. Did you mean "due_on"? — fix: use a column the table has (…)
npx @mistriwork/mistri explain unknown-column
```

`mistri explain <code>` prints the code's row from this page (where it comes
from, what it means, the fix) on one screen. A code it does not know lists the
nearest ones. `mistri schema --brief` is the schema in the same spirit, one
line per table: `task(id* int, title text, status text {open|done}, owner_id int? → person)`.

## Common messages

| Message | Fix |
| --- | --- |
| `Cannot find module '@mistriwork/mistri/app'` | `npm install` in the App's project, or keep it in a checkout: [start](/docs/getting-started/). |
| `has "fields" and no "access"` | `fields` needs `access` and `auth` with roles: [resources and fields](/docs/access-model/). |
| `"fields", a column ceiling for signed-in roles; it needs "auth"` | Without sign-in, keep the column out in the database: [secrets](/docs/secrets/). |
| `has no reference called "site_code"` | It is a column, not a foreign key: [relationships](/docs/relationships/). |
| `"created_at" is TEXT, so the time window cannot narrow by it` | Declare a date type: [dates and types](/docs/dates-and-types/). |
| `compare "previous period" needs exactly one "last N …" phrase` | One window phrase in `query`, or a compare in full: [dashboards](/docs/dashboards/). |
| `compare "previous period" has no dates to compare` | Give the metric `over` (a date column), or a compare in full: [dashboards](/docs/dashboards/). |
| `"fortnight created_at" is not something to group by` | `day`, `week`, `month`, `quarter` or `year`: [dashboards](/docs/dashboards/). |
| `nav entry 2 names the view "…", which this App does not declare` | Declare the view, or fix the id: [navigation](/docs/nav-and-shell/). |
| `the effective authority differs from the lock` | Review, then `mistri check --app <dir> --write-authority`. |
| `read process.env.X, which mistri.json does not pass to it` | List it in `apps[].env`: [secrets](/docs/secrets/). |

Most messages end with the `mistri docs <topic>` that explains them.

## Per-role codes

These belong to the validation step. Problems fail it; warnings explain what a role will not see.

| Code | Kind | What it means | Fix |
| --- | --- | --- | --- |
| `role-cannot-read` | <span id="role-cannot-read"></span>problem | A `recordLabel` names a column (or a table) some roles cannot read: their records read "(row)" | Add the column to those roles' `fields.<table>.read`, or name the record by columns every role reads |
| `role-cannot-read` | warning | A list or a page names a column, or a rollup over one, that some roles cannot read: the list is drawn as a plain grid or not at all for them, and the page leaves that section out (or falls back to the default page). A related list's `create` a role cannot use, and a headline's `was` it cannot read, are left off without a warning: the section stays. Sometimes the point (a moderators' room) | Add the column to their `fields.<table>.read`, or leave it out of the list or page |
| `command-unreadable` | <span id="command-unreadable"></span>warning | A role is granted a command whose footprint reads a table the role does not read: its actions and form are never offered to that role | Add the table to the role's `read`, or take the command from the role |
| `new-cannot-form` | <span id="new-cannot-form"></span>warning | A role writes a table that has a New form, a quick add or a related create, but its writable columns leave out one a new row needs: New is not offered to it | Add the column to the role's `fields.<table>.write`, or make the rows with a command |
| `write-unreadable-parent` | <span id="write-unreadable-parent"></span>warning | A role writes a column that references a table it does not read: a write that sets it is refused, while the rest of the row edits | Let the role read the table, or leave the column out of the role's `fields.<table>.write` |
| `write-generated` | <span id="write-generated"></span>warning | A role's or a resource's `fields.write` names a column the database computes (a generated column): nothing writes it, and a write that sets it is refused; it is read like any other column, with or without a row policy | Leave the column out of `fields.write` |
| `restated` | <span id="restated"></span>warning | A value the App writes that the platform says without it: a `labels` caption the screens already say (also a command field's `label` that is its key made words), `format: 'number'` beside a `unit`, the App's own `currency`, a `recordLabel` that is the label column, `signUp: 'invite'`, `default: true` on the only source, `targets: 'none'` beside `public: true`, a handler that returns `out.parse(…)` | Delete it; the message names which |
| `role-label` | <span id="role-label"></span>warning | A role has no `label`, so the screens that name it to people (accounts, a suite's grants, a tenant's members and invitations) say its id made words | `roles.<id>.label: 'Loan officer'` |
| `admin-grants-nothing` | <span id="admin-grants-nothing"></span>warning | `auth.roles` names no `admin`, the role the first account (`MISTRI_AUTH_ADMIN_EMAIL`) and every administrator holds: they sign in to an App that shows them nothing | Declare `roles.admin` with what an administrator reads and writes, for example `{ read: true, write: true }` |
| `outside-ceiling` | <span id="outside-ceiling"></span>problem | A role, or a command, names a resource whose own `access` does not allow it. A command's `target` is always written | Declare `resources.<name>`, or for a write `access: 'write'`: the refusal names which |
| `role-extends` | <span id="role-extends"></span>problem | A role's `extends` names a role the App does not declare, loops back to itself, or names a role of another realm or kind of principal | Name a declared role of the same realm that does not extend this one |
| `command-and-edit` | <span id="command-and-edit"></span>problem | A role edits in place a table a command writes and says neither which columns it edits nor has the table a machine; or a role edits the `version` column a command keeps its revision in | The role's `fields: { <table>: { write: [...] } }`, or a `machine` on the resource, or take the table out of the role's `write`; for the revision, leave `version` out of the role's write |
| `machine-unreachable` | <span id="machine-unreachable"></span>problem | A machine's state no verb leads to from its first state | Add a verb that leads there, or drop the state |
| `machine-timer-edge` | <span id="machine-timer-edge"></span>problem | A timer has no command edge from the state it waits in | Declare that command under the same state’s `on`, with its destination |
| `machine-dead-end` | <span id="machine-dead-end"></span>problem | A machine's state that no verb leaves and that is not `final` | Give it a verb, or `final: true` |
| `machine-verb-unrunnable` | <span id="machine-verb-unrunnable"></span>problem | A machine's verb no role may run: a command no role is granted, or a fixed verb on a table no role writes or runs by name | Grant the command, or the verb by its label (`roles.<role>.actions`) |
| `machine-command-outside` | <span id="machine-command-outside"></span>warning | A command judges a machine's column in its `when`, writes it in its handler, and is not one of the machine's verbs or timers: its write is refused unless it follows an edge | Name it as a verb of the states it runs from |
| `command-unoffered` | <span id="command-unoffered"></span>warning | A command names a record (`targets` is not `'none'`) and no action, form, import or `api.commands` entry offers it, and no job, workflow or endpoint runs it: preparing it is refused with 403 `forbidden`, whatever a role is granted | Offer it with an action on its target (`action('…', { command: '…' })`), expose it in `api.commands`, or take it out of the registry |
| `tenant-delete-unauthorized` | <span id="tenant-delete-unauthorized"></span>warning | A tenant App's role writes a tenant-owned table and the tenant policy has no `authorizeDeletedRecord`: Save and New work and Delete answers 403 `forbidden` | Add `authorizeDeletedRecord` to `defineAppTenantPolicy`, or take `write` from the role |
| `claim-grants-nothing` | <span id="claim-grants-nothing"></span>problem | A role's `claims` gives it from an identity provider's claims, and it grants nothing: the claims would sign people in to nothing | Give the role reads, writes or commands, or drop `from` |
| `claim-without-provider` | <span id="claim-without-provider"></span>problem | A role has `claims`, and `auth.providers` names no `oidc('…')` or `saml('…')` provider to read claims from | Add the identity provider, or drop `from` |
| `claim-provider-unknown` | <span id="claim-provider-unknown"></span>problem | A role's `claims.provider` names a provider `auth.providers` does not | Name one of the App's `oidc('…')` or `saml('…')` providers |
| `claim-any-provider` | <span id="claim-any-provider"></span>warning | A role's `claims` names no `provider`, and the App has more than one identity provider: a claim of the same name from any of them gives the role | Say whose claims they are: `claims: { provider: oidc('workforce'), … }` |
| `claim-in-tenant-app` | <span id="claim-in-tenant-app"></span>problem | A tenant App's role has `claims`: its roles are members' memberships in the tenant store | Grant the membership instead |
| `identity-provider-unknown` | <span id="identity-provider-unknown"></span>problem | `auth.providers` names `oidc('<name>')` or `saml('<name>')`, and the config file has no entry by that name | Add it: [identity providers](/docs/identity-providers/) |
| `identity-provider-kind` | <span id="identity-provider-kind"></span>problem | `oidc('<name>')` names a `saml` entry, or `saml('<name>')` an `oidc` one | Say the entry's own kind |
| `identity-provider-tenant` | <span id="identity-provider-tenant"></span>problem | `oidc('<name>')` or `saml('<name>')` names an entry the config gives to a tenant | Name an App-wide provider; a tenant's own signs in through `oidc.tenants()` or `saml.tenants()` |
| `open-sign-up-unproven` | <span id="open-sign-up-unproven"></span>problem | `auth.signUp` is `'open'` with the `email` provider, and the config file names no email service: nothing sends the link that proves an address, so anyone may make an account under anyone's email | Add an [email service](/docs/email/) (`"log:"` in development), or make `signUp` `'invite'` |
| `embed-issuer-no-auth` | <span id="embed-issuer-no-auth"></span>problem | A host in the config file (`"kind": "embed"`) signs people into an App that signs no one in | Give the App `auth`, or take it off the host's `apps`: [sign in from your app](/docs/embed-sign-in/) |
| `embed-issuer-role-unknown` | <span id="embed-issuer-role-unknown"></span>problem | A host's `roles` maps an App role the App does not declare | Declare it in `auth.roles`, or map one it does |
| `scim-no-auth` | <span id="scim-no-auth"></span>problem | A SCIM directory (`"kind": "scim"`) names in its `apps` an App that signs no one in | Give the App `auth`, or take it off the directory's `apps`: [SCIM provisioning](/docs/scim/) |
| `scim-provider-unused` | <span id="scim-provider-unused"></span>problem | A directory provisions an App that does not sign people in through the directory's `provider` | Add the provider to `auth.providers`, or take the App off the directory's `apps` |
| `scim-role-unknown` | <span id="scim-role-unknown"></span>problem | A directory's `roles` maps a role the App does not declare (for a tenant's directory, a tenant role) | Declare it in `auth.roles`, or map one it does |
| `scim-role-service` | <span id="scim-role-service"></span>problem | A directory maps a role only a service holds | Map a person's role |
| `scim-role-claims` | <span id="scim-role-claims"></span>problem | A directory maps a role the provider's `claims` give | A role is the directory's or the claims', never both: drop one |
| `scim-tenant-roles` | <span id="scim-tenant-roles"></span>problem | A tenant's directory maps no `roles` | Map a tenant role from the directory's groups: a member holds one |
| `public-form-reference` | <span id="public-form-reference"></span>problem | A public form's command answers no `reference`, so every submission would be refused after it ran | `output: shape({ reference: text({ pattern: publicReferencePattern('…') }), message: literal('…') })` |
| `public-form-picker` | <span id="public-form-picker"></span>problem | A public form's `reference` input picks from a resource `auth.public` does not open, or by a key or label column its `fields` leave out, so a visitor could not read its choices | Open the resource (and those columns) in `auth.public`, or ask a `choice` the handler resolves |
| `money-minor` | <span id="money-minor"></span>problem | A `format: 'money'` rule says `minor: true` over a column that is not an integer, or names a `currency: { column }` that is not another text column of the resource | Keep minor units in an integer column (or drop `minor` for a decimal one); name the column each row keeps its ISO 4217 code in |
| `boolean-keys` | <span id="boolean-keys"></span>warning | A yes/no column's (or computed boolean's) `values`, `tone` or `icons` is keyed by something other than `true`, `false` or `*`: SQLite stores 1 and 0, and only those two keys are read for them | Key the rule by `true` and `false` |
| `value-label` | <span id="value-label"></span>problem | A value component's `label(value)` throws, returns something other than text, returns more than 80 characters, or is `async`, for a value of its column's vocabulary; or its module does not load to be read | Return the word as a short string, synchronously |
| `value-label-open` | <span id="value-label-open"></span>warning | A value component exports `label`, but its column has no vocabulary (free text), so it cannot be called over its values and is not used | Declare `values` for the known words, or constrain the column with an enum or CHECK list |
| `value-words-missing` | <span id="value-words-missing"></span>warning | A value component draws a column that has a vocabulary, with no `label` export and no `values`, so breakdowns, chips and the CSV show the stored values | Export `label(value)` from the component, or declare `values` |
| `drill-none` | <span id="drill-none"></span>warning | A breakdown, chart or matrix groups by a column, or a funnel counts rows, of a table that has no list view, so its groups or stages are not links (an App never opens the database browser) | Add a list view over the table, or say `to: false` |
| `drill-ambiguous` | <span id="drill-ambiguous"></span>warning | A breakdown, chart or matrix groups by a column, or a funnel counts rows, of a table that has several list views and says none in `to`, so its groups or stages are not links | Say which list with `to: 'view-id'`, or `to: false` |
| `empty-run` | <span id="empty-run"></span>warning | A record page has three or more related lists in a row, none saying what it does while empty (no `empty` on the page or the lists, no `listTabs`), so a record with no history draws that many empty tables | Say `empty: 'collapse'` on the page to fold them into one line, or `empty: 'hide'` where a list is not worth a place |
| `raw-id` | <span id="raw-id"></span>warning | A view's label, a page's label or a section's title is written as an identifier (`billing.order_line`, `EVENT_ENUM`) and is drawn to the reader as it stands | Say it in words, or leave the label out: the platform says a table's name as words, without its schema |
| `live-unused` | <span id="live-unused"></span>warning | A resource says `live: false` on an App that does not say `live: true` at its top: the App follows no changes, so leaving a table out of live sync changes nothing | Drop the resource's `live: false`, or say `live: true` on the App if its open pages should follow other people's changes |
| `form-lines` | <span id="form-lines"></span>problem | A form's `lines`, or a related list that edits its rows in place, names a resource the App does not write, a `whose` that is not one reference to the record, or a column a form does not write | Declare the child with `access: 'write'`, name its reference to the record, and show only columns a form writes (never `whose` or `order`) |
| `form-live` | <span id="form-live"></span>problem | A form's `live` names something that is not a computed column or rollup of the resource, a rollup of rows its `lines` do not ask (or one narrowed by a query), or a computed column that reads through a reference | Live values read the draft and its lines only: add the rows to `lines`, their columns to `show`, or roll up a computed column of the line |
| `document` | <span id="document"></span>problem | A page's `document` draws a section paper cannot (an aside, a tab, a timeline, a list with a presentation or editing), names a `number` that is not a field of its record, takes a key a record page already answers to as a tab, or is named as the page a record opens through | Keep a document to fields, related lists and notes placed by `width`; give it a key no tab uses: [printable documents](/docs/documents/) |

## Codes

| Code | Step | What it means | Fix |
| --- | --- | --- | --- |
| `could-not-check` | <span id="could-not-check"></span>check | No App directory, no database, a flag that is a mode of its own | Give `--app <dir>` the App's directory and the database as `<db>`, `--db <target>` or `--config <path>`, and run a flag that is a mode of its own in a `mistri check` of its own |
| `pending-migration` | <span id="pending-migration"></span>pending | A pending migration failed on the scratch copy, or the migrations and their history disagree | [Change your schema](/docs/change-your-schema/) |
| `deploy-sqlite-source` | <span id="deploy-sqlite-source"></span>deploy | `check --deploy`: a connection the App uses is a SQLite file, lost with a replaced container and not shared by replicas | Use a `postgres://` URL, e.g. `"${DATABASE_URL}"` |
| `deploy-connection-limit` | <span id="deploy-connection-limit"></span>deploy | `check --deploy --connection-limit <n>`: one process's pools (read, write, background writer, LISTEN, read replicas, the sign-in store) times `--replicas` exceed the connections the database allows this role | Lower `--read-pool` / `--write-pool` or a connection's `pool`, `MISTRI_AUTH_POOL`, run fewer replicas, or add a pooler (`--pooler transaction`) |
| `deploy-default-auth-store` | <span id="deploy-default-auth-store"></span>deploy | `check --deploy`: the App signs people in and `auth.store` is not set, so accounts and sessions are a SQLite file in the config directory | Set `auth.store` to a `postgres://` URL, kept apart from the business database |
| `deploy-sqlite-auth-store` | <span id="deploy-sqlite-auth-store"></span>deploy | `check --deploy`: `auth.store` names a SQLite file | Set `auth.store` to a `postgres://` URL |
| `deploy-missing-secret` | <span id="deploy-missing-secret"></span>deploy | `check --deploy`: `BETTER_AUTH_SECRET` is unset or under 32 characters, and a start refuses without it | `openssl rand -base64 32`, kept in the platform's secret store |
| `deploy-unset-reference` | <span id="deploy-unset-reference"></span>deploy | `check --deploy`: a connection or `auth.store` references a `${NAME}` the environment lacks, and a start would refuse | Export it when you run check; the deployment's secret store holds the real value |
| `deploy-public-url` | <span id="deploy-public-url"></span>deploy | `check --deploy` warning: `MISTRI_PUBLIC_URL` is not set, so cookies and emailed links name the loopback address | Set it to the public `https` address |
| `deploy-per-process-limits` | <span id="deploy-per-process-limits"></span>deploy | `check --deploy --replicas <n>` warning: more than one replica and no `cache` service, so each keeps its own rate limits and sign-in lockout | Add a `cache` service (Valkey), or run one replica |
| `deploy-form-key` | <span id="deploy-form-key"></span>deploy | `check --deploy`: the App opens a public page's door and `MISTRI_FORM_KEY` is not set, so each instance signs that door's tickets with a key of its own; an error with `--replicas` above one, a warning otherwise | `openssl rand -base64 32`, exposed as `MISTRI_FORM_KEY` to every instance |
| `unknown-connection` | <span id="unknown-connection"></span>schema types | The App names a connection the config does not have | Add it to `mistri.json`, or fix the name |
| `database-unreachable` | <span id="database-unreachable"></span>schema types | The database could not be opened | Start it, or fix its address |
| `schema-types-stale` | <span id="schema-types-stale"></span>schema types | `mistri-schema.d.ts` is older than the database (`migrate status`) | `mistri check` rewrites it |
| `schema-types` | <span id="schema-types"></span>schema types | The schema types could not be written, for the reason said | Let `mistri check` write `mistri-schema.d.ts` beside `app.ts` (the directory writable, the file not open elsewhere) and the database answer, then check again |
| `typecheck` | <span id="typecheck"></span>typecheck | tsc failed without an error it placed | Run tsc |
| `unknown-key` | <span id="unknown-key"></span>validation | A key this place does not take | The message lists the keys it takes |
| `unknown-column` | <span id="unknown-column"></span>validation | A column a table does not have, in a query, a list, an action, a computed column | The message suggests the nearest |
| `not-a-reference` | <span id="not-a-reference"></span>validation | A column where a foreign key goes | [Relationships](/docs/relationships/) |
| `unknown-view` | <span id="unknown-view"></span>validation | A view id nav, home or an embed names that the App does not declare | Declare the view, or fix the id |
| `unknown-action` | <span id="unknown-action"></span>validation | An action id a header, a queue or a role names that the resource does not declare | Use one of the ids it lists |
| `unknown-resource` | <span id="unknown-resource"></span>validation | A resource, a table or a connection that is not there | Fix the name |
| `computed-column` | <span id="computed-column"></span>validation | A computed column that does not parse or type, or one written, asked for or granted as if stored | [Computed columns](/docs/dsl-resources/#computed-columns) |
| `query-grammar` | <span id="query-grammar"></span>validation | A query, a `when` or a measure that does not parse; the message says at which character | [The query language](/docs/query/) |
| `not-a-date` | <span id="not-a-date"></span>validation | A time window or a timeline over a column that is not a date | [Dates and types](/docs/dates-and-types/) |
| `needs-auth` | <span id="needs-auth"></span>validation | A column ceiling for signed-in roles in an App without sign-in | [Secrets](/docs/secrets/) |
| `authority-lock` | <span id="authority-lock"></span>validation | The effective authority differs from `authority.lock`; the one finding carries each changed fact, `+` granted now and `-` only in the lock | Review, then `--write-authority` |
| `env-not-passed` | <span id="env-not-passed"></span>validation | The App reads an environment variable its config does not pass | `apps[].env` |
| `analytics-unknown-step` | <span id="analytics-unknown-step"></span>validation | A funnel step names a view, action, form (or form step) or event the App does not declare | Use one of the ids the App declares, or declare the custom event |
| `preview-feature` | <span id="preview-feature"></span>validation | Information, not a problem: the App uses a Preview feature (flags, audiences, experiments, behavior analytics, Gantt), which may change in any 1.x release | Nothing to fix; [Status](/docs/status/) lists what is Preview |
| `analytics-not-collected` | <span id="analytics-not-collected"></span>validation | A funnel step counts a kind (views, actions or forms) that `analytics.collect` does not list | Add the kind to `collect` |
| `experiment-eligibility-audiences-only` | <span id="experiment-eligibility-audiences-only"></span>validation | An experiment's `eligibility` lists `roles` or `tenants` itself | Declare an audience with those roles or tenants and name it in `eligibility.audiences` |
| `analytics-name-clash` | <span id="analytics-name-clash"></span>validation | A custom event, funnel or feature declares a name another already holds, or a custom event shares a business event's name | Rename one; custom and business events share one namespace |
| `api-write-unsupported` | <span id="api-write-unsupported"></span>validation | A generic write the App cannot serve: rows not every role's, several sources, a resource no role writes, or a delete the App does not allow | Write through a command the App exposes; or, for one source where every role reads all rows, give the resource `access: 'write'` and `delete: true` where the API deletes |
| `api-write-field` | <span id="api-write-field"></span>validation | A generic write's field that is not a column, or a create that leaves out a required column | Add or fix the field |
| `api-write-no-role` | <span id="api-write-no-role"></span>validation | No API role creates, edits or deletes the resource | Grant a role, or drop the write |
| `api-write-name-taken` | <span id="api-write-name-taken"></span>validation | The commands module registers the name a generic write runs as | Rename the command |
| `api-multi-source` | <span id="api-multi-source"></span>validation | An exposed field, filter or sort that reaches a resource on another connection, or an exposed command whose lookup does: one App API request reads one connection | Expose the other resource as its own, or drop the path |
| `api-source-unsupported` | <span id="api-source-unsupported"></span>validation | An exposed resource on a source the App API does not serve: an HTTP API, or an engine it does not read | Expose resources of SQLite or PostgreSQL sources |
| `api-event-unsupported` | <span id="api-event-unsupported"></span>validation | `api.events` in a tenant App | Use webhooks |
| `api-event-unknown` | <span id="api-event-unknown"></span>validation | `api.events` names an event no command emits | The message lists the declared events |
| `policy-events-feed` | <span id="policy-events-feed"></span>validation | `api.events` in a row-policy App: the feed serves every event, and its rows are scoped per reader | Deliver events through an effect's webhook |
| `policy-service-unnamed` | <span id="policy-service-unnamed"></span>validation | A jobs principal the row policy's `services` does not name: the server does not start | Add it to `services` |
| `policy-service-unused` | <span id="policy-service-unused"></span>warning | `services` names a principal no job, timer, workflow, inbound endpoint or integration runs as | Drop it, or run something as it |
| `policy-service-rows` | <span id="policy-service-rows"></span>warning | The policy gives a service no rows of a table its commands read or write, on the check's database | Give `service:<name>` those rows in `resolveRows` |
| `notify-send-transport` | <span id="notify-send-transport"></span>validation | A rule's `send: { channel: 'email' }` on a server with no email service | Add a service of `"kind": "email"` to the config file |
| `notify-send-links-secret` | <span id="notify-send-links-secret"></span>validation | The email service sets no `links.secret`, which signs each message's unsubscribe link | Set `"links": { "secret" }` |
| `notify-send-timezone` | <span id="notify-send-timezone"></span>validation | An email `send` gives `timezone`: mail has no quiet hours | Remove it |
| `notify-send-source` | <span id="notify-send-source"></span>validation | The rules that email a record's address span several connections, or a connection is neither SQLite nor PostgreSQL | Keep the rules' resources on one SQLite or PostgreSQL connection |
| `notify-send-unproven` | <span id="notify-send-unproven"></span>warning | A public command writes a resource that emails its address, and no form proves the address (`link.email.verified`): a visitor's write is not mailed | Prove the address on the form, or accept that visitors' writes are not mailed |
| `notify-send-consent` | <span id="notify-send-consent"></span>warning | An email `send` names no `consent` column, so only addresses that opted in are mailed | Name the column that records consent |
| `page-layout` | <span id="page-layout"></span>validation | A page's `layout` is not `conversation`, `showcase` or `article`; or it is on a `mistri.json` page, a `document()` or a `definePage` | Use one of the three on a `page(…)`; a document has paper's one layout and a free-form page lays itself out ([compose a record page](/docs/compose-record-page/)) |
| `layout-conversation` | <span id="layout-conversation"></span>validation | A `conversation` page has no timeline or two, a section after its timeline in the main column, a related list, embed, chart, breakdown or metric in the main column, or a tab there | A conversation is its one timeline, last in main: put `related('Parts used', …)` in `region: 'aside'` |
| `layout-showcase` | <span id="layout-showcase"></span>validation | A `showcase` page's first main section is not a gallery, it has no aside section or more than three, an aside section names a `tab`, or it says `aside: false` | A showcase opens with its photos: `related('Photos', …, { presentation: 'gallery' })` first, its price `headline` in the aside |
| `layout-article` | <span id="layout-article"></span>validation | An `article` page has a section in the aside, says `aside: false`, or gives a section `width: 'third'` or `'two-thirds'` | An article has no aside: move `card('Home', …)` into the column, or leave out `layout` |
| `page-file` | <span id="page-file"></span>validation | A `pages/*.page.tsx` file that does not compile, has no `definePage` default, gives it a key it does not take, or no `label` | Make the file compile and `export default definePage({ label, … })` with only the keys it takes ([free-form pages](/docs/custom-components/#free-form-pages)) |
| `page-path` | <span id="page-path"></span>validation | A page's `path` is not its file's name, is reserved, or is a view's already | Name the file for the path, or change the path |
| `page-nav` | <span id="page-nav"></span>validation | A page asks for a nav group the App's nav does not have, or nav names a page | `nav: { group }` with one of the nav's groups; a page places itself |
| `page-reads` | <span id="page-reads"></span>validation | A page declares no `reads` | Name the resources it reads |
| `page-params` | <span id="page-params"></span>validation | A page's `params` are not up to eight lowercase words, or name `period` | `params: ['list']` |
| `auth-challenge` | <span id="auth-challenge"></span>validation | `auth.challenge` names a check the commands module's `challenges` does not define | `export const challenges = defineChallenges({ verifyHuman: … })` beside the commands |
| `page-commands` | <span id="page-commands"></span>validation | A page runs a command the commands module does not register, or the App has no roles | Register the command, or drop it |
| `page-public` | <span id="page-public"></span>validation | A `public` page names roles, or reads what `auth.public` does not open | Open the resource in `auth.public`, or make the page signed-in |
| `page-coverage` | <span id="page-coverage"></span>validation | A role the page names is not granted all it reads and runs, or no role is | Grant the role, or narrow the page |
| `page-loader` | <span id="page-loader"></span>validation | A page names a loader the commands module does not export, or the loader reads what the page does not | `export const loaders = defineLoaders({ … })`; keep its `reads` within the page's |
| `message-missing` | <span id="message-missing"></span>validation | A `msg('…')` names a key the source catalog (`messages/<the App's language>.ts`) does not have, or the App names messages and has no `messages/` catalogs | Add the key to the source catalog, or fix its name |
| `message-syntax` | <span id="message-syntax"></span>validation | A catalog's text is not ICU MessageFormat, or a `messages/` file is not `export default defineMessages('<its locale>', { … })` | Write each text as ICU MessageFormat, every `{` with its `}`, and the file as `export default defineMessages('<its locale>', { … })` |
| `message-placeholder` | <span id="message-placeholder"></span>validation | A translation reads an argument its source text does not | Say only the source's arguments |
| `message-arg` | <span id="message-arg"></span>validation | A message's argument reads no column, a column of the wrong kind (a plural of text), or sits where nothing supplies it: only a record's name, a notify title, a transition (`{to}`) and a landing's slots take arguments | Bind it to a column (`msg('lead.due', { days: 'due_in' })`), or say the caption without arguments |
| `message-untranslated` | <span id="message-untranslated"></span>validation | Warning: a translation leaves some of the source's keys to the source's words | Translate them in `messages/<locale>.ts` |
| `message-unused` | <span id="message-unused"></span>validation | Warning: a key no `msg()` names, or a translation's key the source catalog does not have | Name it, or remove it |
| `route-clash` | <span id="route-clash"></span>routes, validation | An address another App or another room holds | Give one of them a `path` |
| `app-on-mysql` | <span id="app-on-mysql"></span>validation | The App's connection (or one of its sources) is a MySQL or MariaDB database; MySQL and MariaDB are not supported, so the check says it and the server refuses to start | Point the App at a PostgreSQL or SQLite connection: [status](/docs/status/) |
| `mount` | <span id="mount"></span>routes | The mount flags or config do not say where the App is served | [Build and deploy](/docs/build-and-deploy/) |
| `deprecated` | <span id="deprecated"></span>validation | Warning: a key that still works and goes at the next major version; the message names its replacement | What the message says to write instead (compatibility (`docs/compatibility.md`)) |
| `theme-contrast` | <span id="theme-contrast"></span>validation | An App theme's text color fails a contrast check, in a mode or a palette ([C1](/docs/theme-contract/#c1)); the message names the color, what it was measured on, and the nearest color of its hue that passes | Write the color the message says, or `mistri check --fix` |
| `theme-edge` | <span id="theme-edge"></span>validation | An App theme's control edge (`lineControl`) reads under 3:1 on a field, the page or a raised panel, in a mode or a palette ([C2](/docs/theme-contract/#c2)) | Write the darker edge the message says, or `mistri check --fix` |
| `theme-focus` | <span id="theme-focus"></span>validation | An App theme's focus ring (`focus`, or the accent where it is the ring) reads under 3:1 on a ground a focusable sits on: the panel, the page or a raised row ([C3](/docs/theme-contract/#c3)) | Write the ring color the message says, or `mistri check --fix` |
| `theme-print` | <span id="theme-print"></span>validation | An App theme's light `accent` or `link` reads under 4.5:1 on white paper, which a printed page is whatever its ground ([C12](/docs/theme-contract/#c12)) | Write the color the message says, or `mistri check --fix` |
| `theme-budget` | <span id="theme-budget"></span>fonts | A theme's faces are past 150 KB together as served, and each is fetched as the page is first drawn ([C11](/docs/theme-contract/#c11)) | Ship fewer weights, or one variable file cut to Latin |
| `theme-audience` | <span id="theme-audience"></span>validation | `ui.theme.for` names a theme that is neither a built-in look nor one of `ui.customThemes`, a role `auth.roles` does not declare, or no audience at all | Name an offered theme for `public` and each role, or register the theme in `ui.customThemes` |
| `theme-shadow` | <span id="theme-shadow"></span>validation | Warning: a theme's `shadow` is lighter than its `ground` in a mode, so a card or a menu glows rather than lifts and loses the edge the lift was for ([C2](/docs/theme-contract/#c2)) | A `shadow` darker than the ground, or leave it out for the look's |
| `theme-type` | <span id="theme-type"></span>validation | Warning: a type role's `weight` is past 700 in a face the theme does not ship at that weight, so the browser draws a smeared 700 or a Black cut ([C8](/docs/theme-contract/#c8)) | Ship the face at that weight in `type.faces`, or keep the weight at 700 or under |
| `theme-part` | <span id="theme-part"></span>validation | A part style (`parts`) names a part that is not published, a hex or a property past its menu, or a warning that its ink fails on its ground in a mode ([C13](/docs/theme-contract/#c13)) | A published part, a color by its role's path, an ink that reads on the ground |
| `theme-band` | <span id="theme-band"></span>validation | Warning: a banded table's theme gives `parts.status` or `parts.tag` an opaque `ground`, so that cell keeps its own color on the band and shows as a pale column on every other row ([C13](/docs/theme-contract/#c13)) | A translucent ground for the part, or leave its ground out for the look's |
| `theme-css` | <span id="theme-css"></span>validation | A theme's `stylesheet` is not a `.css` file beside it, weighs over 8 KB, or has a rule the allowlist refuses: a selector that is not a published part, an at-rule, `!important`, a size, a place or a hidden part, each by its line ([C13](/docs/theme-contract/#c13)) | Dress `[data-part]` rules in role colors, edges, corners, lifts and faces; say size and place in the App |
| `theme-contract` | <span id="theme-contract"></span>validation | A published look says a contract this mistri does not read, a `from` that is not its `import.meta.url` or has no `contract`, extends a theme that extends a theme, or names a file outside its package ([C13](/docs/theme-contract/#c13)) | Install the look's release for contract 1, say `contract: 1` beside `from`, and keep its files in its package |
| `theme-radius` | <span id="theme-radius"></span>validation | Warning: a theme's `shape.radius.panel` is squarer than its `control`, so a card's corner cuts under the buttons it holds | A `panel` at least the control's corner, or leave it out for one and a half controls' |
| `theme-dark` | <span id="theme-dark"></span>validation | Warning: `ui.logo` is a picture with no `dark`, so the light picture is drawn on the dark bar ([C10](/docs/theme-contract/#c10)) | Say `ui.logo.dark`, or name the same file there when it reads on both |
| `app-logo` | <span id="app-logo"></span>validation | `ui.logo`'s `src`, `dark` or `mark` is a URL, not a PNG, JPEG, WebP, GIF or SVG file, missing, outside the App's directory, or a picture past 256 KB (an SVG past 64 KB) | A file in the App's directory, or an App icon's name |
| `theme-chart` | <span id="theme-chart"></span>validation | Two neighboring chart series of an App theme are too alike for a color-blind reader ([C7](/docs/theme-contract/#c7)); the message gives an order of the same series that passes | Write the order the message says, or `mistri check --fix` |
| `theme-font` | <span id="theme-font"></span>validation | A theme's `type.faces` file is missing, outside the App, not WOFF2 or WOFF, or over 1 MB; or, as a warning, a face over 80 KB, a face no stack names, or a stack that leads with a family the theme neither ships nor falls back from | Ship each face as a WOFF2 file inside the App, subset to under 80 KB, name it in a stack, and lead each stack with a family the theme ships ([Themes](/docs/themes/#fonts)) |
| `invalid-app` | <span id="invalid-app"></span>validation | Any refusal of the load no other code names: a declaration the parser does not accept, or a refusal the App's start makes over its database or its `--policy` and `--commands` modules (`App error:` or `Policy startup error:`, with each `because:` under it). The App's other problems are listed beside it | Correct the declaration at the key the message quotes to the shape it lists (`mistri docs <topic>` shows it in full); for a start's refusal, read the last `because:` line, which names the table, column or module |
| `component-markup` | <span id="component-markup"></span>components | A component writes HTML from text | Draw React children |
| `component-code-from-text` | <span id="component-code-from-text"></span>components | `eval`, `new Function`, a string timer or a `javascript:` address | A function |
| `component-environment` | <span id="component-environment"></span>components | A component reads the server's environment | Pass what it needs as props |
| `component-color` | <span id="component-color"></span>components | Warning: a literal color | A token, `var(--accent)` |
| `component-token` | <span id="component-token"></span>components | Warning: a `var(--…)` no look defines | The token named, `var(--status-critical)` for `--negative`; the list is `tokens` from `@mistriwork/mistri/ui` |
| `component-radius` | <span id="component-radius"></span>components | Warning: a literal radius | `var(--radius)` |
| `component-motion` | <span id="component-motion"></span>components | Warning: motion over 200 ms, or outside a reduced-motion query | [Design](/docs/design-lint/) |
| `component-shadow` | <span id="component-shadow"></span>components | Warning: a shadow | `var(--line)` |
| `component-class` | <span id="component-class"></span>components | Warning: a class outside the component's `c-<id>` name-space | Name it `c-<id>-…` |
| `component-ruler` | <span id="component-ruler"></span>components | Warning: placed by the window's ruler | The kit's popups |
| `page-undeclared` | <span id="page-undeclared"></span>components | A page's module reads or runs what its `definePage` does not declare (a warning when it names one with an expression) | Add it to `reads` or `commands`, or name it in quotes |
| `integration-unknown` | <span id="integration-unknown"></span>validation | a command calls, or `integrations.webhooks` maps, an integration the jobs module's `integrations.use` does not list | List it, or fix the name ([Integrations](/docs/integrations/)) |
| `integration-action-unknown` | <span id="integration-action-unknown"></span>validation | a command calls an action its integration does not declare | Use one of the actions the message lists |
| `integration-event-unknown` | <span id="integration-event-unknown"></span>validation | `integrations.webhooks` maps an event its integration does not declare, or one that sends no webhooks | Use one of the events the message lists |
| `integration-channel-unknown` | <span id="integration-channel-unknown"></span>validation | a command's `send(...)`, or a `notify` rule's `send`, names a channel no listed integration provides | List the integration that provides it, or fix the name |
| `integration-event-input` | <span id="integration-event-input"></span>validation | an event's payload does not fill the input of the command it runs | Match the command's input to the payload, field for field |
| `integration-service-role` | <span id="integration-service-role"></span>validation | the principal an event runs as holds a role that is not `service: true`, or is not granted the command | Give the principal service roles that grant the command |
| `oauth-no-auth` | <span id="oauth-no-auth"></span>validation | The config file's OAuth authorization server issues tokens for an App that signs no one in, and a token is a person's | Give the App `auth`, or take it off the server's `apps` ([OAuth for agents](/docs/app-api/#oauth-for-agents)) |
| `oauth-no-api` | <span id="oauth-no-api"></span>validation | The OAuth authorization server issues tokens for an App with no `api` | Declare one, or take the App off the server's `apps` |
| `oauth-not-network` | <span id="oauth-not-network"></span>validation | The OAuth authorization server issues tokens for an App whose `api` does not say `network: true`, and an agent reaches the API over the network | Say `network: true`, or take the App off the server's `apps` |
| `oauth-role-unknown` | <span id="oauth-role-unknown"></span>validation | The OAuth authorization server lets a token carry a role the App's `api` does not grant | Name one of the api's `roles` |
| `consumes-path` | <span id="consumes-path"></span>validation | A `consumes` (or `restocks`) `column` starts with a column that is not a reference of the line | Name one of its references, then a number column of the record it names: `part_id.on_hand` |
| `consumes-balance` | <span id="consumes-balance"></span>validation | A `consumes` balance is not a number column of the record the reference names | Name the number the record keeps, like `on_hand` |
| `consumes-by` | <span id="consumes-by"></span>validation | A `consumes` `by` is not a number column of the line | Name the line's amount, like `quantity`, or leave `by` out for one per line |
| `consumes-decimal` | <span id="consumes-decimal"></span>validation | A whole-number balance is moved by an amount that may be a fraction | Give both columns the same numeric type |
| `consumes-written` | <span id="consumes-written"></span>validation (warning) | A command's handler writes a line and the balance its `consumes` or `restocks` already moves for it: the line would count twice. One that writes only the balance is not named | Leave the balance to the rule, or drop the rule where the command keeps the balance itself |

## Related

- [Design checks](/docs/design-lint/): what `check --design` and `mistri grade` report.
- [Command line](/docs/cli/): every flag `mistri check` takes.
- [Build with a coding agent](/docs/build-with-an-agent/): the loop an agent runs against these codes.
- [Reload and restart](/docs/reload-and-restart/): what `--write-authority` accepts before a restart.
