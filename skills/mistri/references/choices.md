# The hard-to-undo choices

Pages are cheap to change; these move addresses, the account store,
`authority.lock`, a migration or who reads what. Decide them with the person
before building pages and say each in the App's README. A change to sources,
grants or sign-in needs a restart (`mistri docs reload-and-restart`).

## Identity and data

- **A stable `id`** before anyone signs in: it names the account store and,
  beside other Apps, every address —
  [lintel/app.ts:50](../../../examples/apps/lintel/app.ts#L50).
- **A foreign key in the database, not a declared reference.** Reference
  links, label paths, related lists, rollups and `whose` all follow foreign
  keys: add a missing one by migration. Declare `references` only when the
  schema cannot change or the target is in another database, where it cannot
  filter, sort or roll up (`mistri docs relationships`). The generated
  `References` type lists every hop —
  [lintel/mistri-schema.d.ts:53](../../../examples/apps/lintel/mistri-schema.d.ts#L53).
- **Name every source**, the first too: other sources' tables are
  `source.table` in every view, path and grant, and sources on different
  connections share no joins or transactions; one PostgreSQL database with
  several schemas is a source per `{ connection, schema }` (`mistri docs sources`) —
  [lintel/app.ts:54](../../../examples/apps/lintel/app.ts#L54).
- **Declare resources one by one** when they carry access, display or forms
  (`{}` for a table read only as a label); `resources: 'all'` suits a
  read-mostly source. Every declared table is served whole to whoever reads it —
  [lintel/app.ts:55](../../../examples/apps/lintel/app.ts#L55).
- **Dates stored as text** (SQLite `TEXT`) are declared on the resource,
  `types: { due_on: 'date', created_at: 'datetime' }`: without it a date is a
  string, so `month due_on`, `relative` and the calendar have nothing to read
  and the scaffold drafts no trend (`mistri docs dates-and-types`).
- **A status vocabulary in the schema** (`CHECK (status IN (...))`, an enum):
  filters, lanes and pickers read it (`mistri docs vocabularies`).

## Access: the least mode that is true

| Mode | Choose when | Worked example |
| --- | --- | --- |
| No `auth` | one person on loopback, or behind a proxy that signs people in; every declared column reaches every browser | `mistri docs access-model` |
| `auth` without `roles` | everyone signed in may read and write the same things | `mistri docs roles` |
| `auth.roles` | people differ by what they may read, write or decide; each role grants within the resources' `access` ceilings | [lintel/app.ts:61](../../../examples/apps/lintel/app.ts#L61) |
| `rows: 'policy'` | a reader sees only their own rows; a server-only `defineAppRowPolicy` says which | [lintel/policy.ts:91](../../../examples/apps/lintel/policy.ts#L91) |
| `rows: 'tenant'` | one App serves several organizations, each seeing only its own | `mistri docs tenant-apps` |

Never fake tenancy with a `tenant_id` filter in views: a filter decides what
is shown, not what is served.

- **Open sign-up gets the smallest role**: with `signUp: 'open'`,
  `defaultRole` is what a stranger gets, so name the role with the fewest
  grants (`mistri docs roles`).
- **Who "me" is**: `auth.me` matches an account to its row —
  [lintel/app.ts:59](../../../examples/apps/lintel/app.ts#L59).
- **A column a role must not read**: a `fields` ceiling —
  [lintel/app.ts:86](../../../examples/apps/lintel/app.ts#L86).
- **Decisions only through commands**: `access: 'write'` on the resource as
  the commands' ceiling, no role granted `write`, each role its `commands` —
  [lintel/app.ts:24](../../../examples/apps/lintel/app.ts#L24) (a lease moves only by its commands).
  A table people also edit: `write` with a `fields` rule, or a `machine`.
- **Edits but never creates**: `create: false` beside `write` (or
  `create: ['note']`). **Runs one fixed action without editing**: an
  `actions` grant in place of `write`.
- **A reference numbered per parent**: `nextNumber('lead', { per: dealer.id, start: 1001 })`
  in the command, never `max() + 1`, which a row policy cannot see past.
- **A row policy that looks a person up** reads through the resolver's `db`
  (`resolveRows(principal, { db })`), never a pool of its own.
- **A command that only adds a note, a comment or an attachment** to a record
  others keep editing says `appendOnly: true` beside its `write`, so it is not
  refused as `stale_record` for an edit it never touched; one that writes the
  target's own fields leaves it out (`mistri docs commands`).
- **Leave `track` out**; `track: 'audit'` only where every change must be kept
  (`mistri docs commands`).
- **Open pages that follow other people's changes**: `live: true` at the App's
  top — [lintel/app.ts:53](../../../examples/apps/lintel/app.ts#L53); off
  unless asked. A resource whose writes nobody watches stays out with
  `live: false`.
- **A field a model may fill**: a `defineDecision` in the jobs module, answered
  through the command that sets the field, only suggesting until
  `mistri decide eval --pin` measures it on settled records —
  [lintel/jobs.ts:49](../../../examples/apps/lintel/jobs.ts#L49)
  (`mistri docs decisions`). A rule a command can state is never one.

## Public pages and forms

- **Signed-out reads are named per resource**: `auth.public.read`, needs
  `auth.roles`; `read: true` is refused —
  [lintel/app.ts:136](../../../examples/apps/lintel/app.ts#L136).
- **A public form is write-only**: `public: true` on the `commandForm`
  ([lintel/views.ts:38](../../../examples/apps/lintel/views.ts#L38)) and its command, whose `output`
  is a reference and a fixed sentence
  ([lintel/commands/viewing.ts:29](../../../examples/apps/lintel/commands/viewing.ts#L29)).
- **The reference is random** (`publicReference(...)`), and an unverified
  submission holds nothing scarce: write a request staff act on, never a
  reservation —
  [lintel/commands/viewing.ts:31](../../../examples/apps/lintel/commands/viewing.ts#L31).
- **Prefill only what the public grant opens**: `prefillable` inputs —
  [lintel/views.ts:42](../../../examples/apps/lintel/views.ts#L42).
- **A human check before it goes live**: `auth: { challenge: 'verifyHuman' }`
  naming a `challenges` export of the commands module
  (`defineChallenges` from `@mistriwork/mistri/commands`); the Turnstile pack
  (`@mistriwork/challenge-turnstile`, from `packs/challenge-turnstile`) is one
  provider, `turnstileStub()` its stand-in in tests. It guards every public
  submit, saved step and public page's command; a missing token is 403
  `challenge_failed`, and its secret is the deployment's (`mistri docs integrations`).
- **A choice from a table on a public form** (`field.choice({ from })`) needs
  the table opened under `auth.public`, by columns the public reads. Its rows
  ride in the form's payload, a cached GET kept until a row changes; the
  submit reads the chosen key by primary key inside the transaction, so a row
  deleted since is refused (`mistri docs command-forms`).
- **A tenant App's form lands in one tenant**: on a tenant's mapped host by
  the intake address that tenant holds; on the shared host by
  `/form/<key>?via=<address>`; an address on a mapped host is `400`. A
  submission that places nobody goes to the platform's triage (`mistri docs tenant-apps`).
- **The limits are fixed**: five submissions a minute and thirty an hour per
  client, an App-wide ceiling after the check, a body of at most 64 KB (`413`)
  that must arrive within 10 s (`408`). Behind a proxy name it with
  `--trust-proxy`, on the tenant host too, or every visitor shares one budget;
  several instances share one `MISTRI_FORM_KEY` and a cache.
- **Pictures a signed-out visitor reads are public**: a file resource
  `auth.public` opens, with no row policy, is delivered for any cache to keep
  and its resized copies are shared through the bucket. Keep a private picture
  out of `auth.public` or behind a row policy (`mistri docs file-storage`).

## Environment

- `app.ts` reads no environment unless mistri.json lists the name under
  the App's `env` (`"secret": true` for a credential); whatever it builds is
  sent to every browser (`mistri docs secrets`).
- Commit `authority.lock` (`mistri check --app . --write-authority`)
  so a change to what the App grants is a reviewed diff.

## A process that waits (workflows)

- A process that waits days on a call, a callback, a person or a deadline is
  a workflow (`defineWorkflows` from `@mistriwork/mistri/workflows`, in the `--jobs`
  module), started by an event a command records; a single command or a
  scheduled job is not one —
  [lintel/late-fees.ts:6](../../../examples/apps/lintel/late-fees.ts#L6).
- Everything durable is a named step (`w.run`, `w.call`, `w.sleep`, `w.until`,
  `w.waitFor`, `w.now`); nothing else feeds the code between steps: no
  `Date.now`, no random, no database read, no `Promise.all`. A changed or
  removed step raises `version`. Not in tenant Apps (`mistri docs events-and-jobs`).

## The general path

- **Where the App ends.** Take the general path when part of the product is
not an App's to draw: a public or branded site, a flow the person's own React
already owns, a route that is not a command (a JSON feed, a webhook another
service calls). The App keeps the lists, records, commands and access; the
person's code keeps the rest, and the two meet through public entry points
alone: `createHandler` (`@mistriwork/mistri/handler`) mounted in their server
beside their own routes, `<App>` (`@mistriwork/mistri/react`) inside their own
design, and free-form pages for the screens in between. Decide it before a
view is bent into a page it is not. Ladle shows all three:
[ladle/host/server.ts](../../../examples/apps/ladle/host/server.ts),
[ladle/host/main.tsx](../../../examples/apps/ladle/host/main.tsx),
[ladle/pages/check-in.page.tsx](../../../examples/apps/ladle/pages/check-in.page.tsx);
`mistri docs general-path`.
