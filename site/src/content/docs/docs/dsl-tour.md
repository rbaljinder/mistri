---
title: The DSL in one App
description: Read Lintel from top to bottom — a resource, a list, a record page, a role, a command and a look — each piece of the DSL once.
---

Read Lintel from top to bottom — a resource, a list, a record page, a role, a command and a look — each piece of the DSL once.

```ts title="examples/apps/lintel/app.ts"
export default defineApp({
  id: 'lintel',
  name: 'Lintel',
  // Open pages follow what others change: a repair moved by a technician shows on the office's board as it happens.
  live: true,
  sources: { lintel: { connection: 'lintel' } },
  resources,
  // …
```

See it in the sample (`examples/apps/lintel/app.ts:49`).

## The App file

Lintel (`examples/apps/lintel`) runs a property company's three Denver
buildings: staff let homes, keep the ledger and fix things, and residents sign
in to the same App and see only their own household. It is `app.ts`, the
modules it imports, and `commands/`, the server code behind its buttons. Every
snippet below is cut from those files ([run it](#run-it)). Tick
(`examples/apps/tick/app.ts`) is the same shape in one file.

- `id` is the App's name in addresses and in its account store.
- `live: true` asks for live sync: open pages follow what other people
  change. Without it an App's pages refresh on focus and after their own saves.
- `sources` binds the App to a server connection by name. The App never holds
  a URL or a password; the server's config does.
- `resources` is imported from `resources.ts`, and `views` from `views.ts`:
  the manifest splits when one file would be too long to read.
- The file ends `satisfies App`. `App` is generated from the database by
  `mistri check`, so a misspelled table or column is an editor error.

## 1. A resource: the table, said once

```ts title="examples/apps/lintel/resources.ts"
  lease: {
    segments: {
      current: 'status = active or status = notice',
      ending_soon: 'status = active and end_on = next 60 days',
      // …
    },
    access: 'write',
    recordLabel: '{unit_id.property_id.name} #{unit_id.number}',
    // …
    machine: machine('status', {
      draft: { on: { signLease: 'active' } },
      active: { on: { giveNotice: 'notice' } },
      notice: { on: { endLease: 'ended' } },
      ended: { final: true },
    }),
    // …
  },
```

See it in the sample (`examples/apps/lintel/resources.ts:106`)

Everything the App says about a table lives in its resource, and every list,
page and form reads it from there:

- `segments` name a condition once, in the query language; the list below puts two of them in tabs.
- `access: 'write'` is the most any role may be granted on leases.
- `recordLabel` names a record by its words ("Alder Court #101"), not its id.
- `machine` is the lease's road. Each verb on it becomes a button where the
  lease's state lists it, and the server refuses any other change of status.
  Here every verb is a command (step 5); a fixed move says `{ to, label }`.
- A stored value reads as words without a rule: `ending_soon` is "Ending soon". A `display` rule is for the word that differs.

[Resources and fields](/docs/access-model/) · [Display rules](/docs/vocabularies/) · [Actions](/docs/actions/)

## 2. A list: what a visitor opens

```ts title="examples/apps/lintel/views.ts"
  leases: listView('Leases', 'lease', {
    icon: 'file-text',
    roles: [...OFFICE, 'accountant'],
    show: ['unit_id', 'resident_id', 'status', 'start_on', 'end_on', 'rent', 'balance'],
    // …
    tabs: [
      { segment: 'current', sort: 'end_on' },
      { segment: 'ending_soon', sort: 'end_on' },
      // …
    ],
  }),
```

See it in the sample (`examples/apps/lintel/views.ts:62`)

The key, `leases`, is the address: `/leases`. `show` picks the columns, with
a reference drawn as the record's words, and each tab names a segment, a
condition in the [query language](/docs/query/) the resource declares once.
`roles` keeps the list out of other roles' menus. With no `presentation` the
rows are a grid. `home` and `nav` say which list opens first and what the
menu holds.
[Lists](/docs/lists/)

## 3. A record page

```ts title="examples/apps/lintel/pages/lease.ts"
export default page(
  'lease',
  [
    header({
      status: 'status',
      // …
    }),
    // …
    related('Charges', 'charge', 'lease_id', {
      show: ['description', 'due_on', 'amount', 'status'],
      sort: 'due_on desc',
      limit: 12,
    }),
```

See it in the sample (`examples/apps/lintel/pages/lease.ts:7`)

A page is a list of sections, and a file in `pages/` whose default export is
a page is that page, keyed by its name. `header` draws the name, the status
beside it and the record's verbs; `related` lists the charges that point at
this lease through `charge.lease_id`.
[Record pages](/docs/pages/)

## 4. Who may do what

```ts title="examples/apps/lintel/app.ts"
const leasing = {
  label: 'Leasing',
  read: true,
  // …
  commands: ['signLease', 'giveNotice', 'endLease', ...repairs],
  // …
} as const;
// …
  auth: {
    rows: 'policy',
    providers: ['email'],
    // …
    roles: {
      leasing,
      manager,
      // …
```

See it in the sample (`examples/apps/lintel/app.ts:17`)

People sign in by email. Leasing reads every table and runs the lease
commands, and its `write` list (left out here) names only the tables edited
in place, so a lease changes only by its commands. `manager` extends
`leasing`, and a resident is a role whose rows the `policy` decides, so each
sees their own household and nothing else. The server enforces every grant;
hiding a button is not security.
[Roles and field access](/docs/roles/) · [Row access](/docs/row-access/)

## 5. A command: a decision made on the server

```ts title="examples/apps/lintel/commands/leasing.ts"
export const giveNotice = defineCommand({
  source: lintel,
  target: 'lease',
  write: ['unit'],
  input: { end_on: field.date({ label: 'Moving out on', help: 'The last day of the lease. Thirty days from today at the earliest.' }) },
  output: said,
  // …
  async handle({ db, record, now }, input) {
    // …
    if (input.end_on < addDays(today, 30)) refuse('A lease ends at least thirty days after notice is given.', { field: 'end_on' });
    // …
    await db.lease.update(record, { status: 'notice', end_on: input.end_on });
    const home = await db.unit.get(record.unit_id);
    await db.unit.update(home, { status: 'notice', available_on: addDays(input.end_on, 14) });
```

See it in the sample (`examples/apps/lintel/commands/leasing.ts:28`)

Giving notice changes two tables at once and checks a date against the
lease, so it is a command rather than a plain `set` action like Tick's:

- `input` declares the form: a date, with its help. The browser and the
  server read it with the same rules.
- The machine's `active` state lists `giveNotice`, and the button is drawn
  only where it does; the command is checked again inside the transaction.
- `handle` gets a `db` typed from the schema. The lease and the home change
  together, or neither does; `refuse('…')` says no and keeps nothing.
- `mistri check` writes `mistri-commands.d.ts` from the commands, so
  `giveNotice` in `app.ts` is checked like a column name.

[Commands](/docs/commands/)

## 6. A look

Lintel wears the default look, Lumen. To try another, change its `ui` and save:

```ts
  ui: { theme: { preset: 'sage' } },
```

[Looks](/docs/looks/) shows all three.

## Run it

From a source checkout (`npm install` first), Lintel's own README has the
whole recipe; in short, seed a database and serve it with the App's jobs and
row policy:

```sh
DIR=$(mktemp -d /tmp/lintel.XXXXXX)
export LINTEL_MAIL_SECRET=$(openssl rand -base64 24) PAYMENT_CALLBACK_SECRET=$(openssl rand -hex 16)
export BETTER_AUTH_SECRET=$(openssl rand -base64 32)
export MISTRI_AUTH_ADMIN_EMAIL=admin@example.test MISTRI_AUTH_ADMIN_PASSWORD=choose-a-long-password
node --import tsx examples/databases/lintel/seed.mjs "$DIR/lintel.db"
npx tsx packages/mistri/src/server/index.ts --config "$DIR/lintel.db.json" --app examples/apps/lintel \
  --jobs examples/apps/lintel/jobs.ts --policy examples/apps/lintel/policy.ts --port 4610
```

**You should now see** the public front page at `http://localhost:4610/`.
Sign in with the email and password above, open **Leases** and a lease in
its active state: **Give notice** asks for a date at least thirty days away
and refuses an earlier one. The
Lintel README (`examples/apps/lintel/README.md`)
says what each file teaches and how its tests run.

## Related

- [Sample Apps](/docs/examples/): Tick, Lintel and Ladle, what each shows and how to run it.
- [Choose a building block](/docs/choose/): which view, section or command a need calls for, with sample lines.
- [Build with a coding agent](/docs/build-with-an-agent/): build your own with an agent, a brief and a gate.
- [DSL reference](/docs/app-dsl/): every key, generated from the schema.
