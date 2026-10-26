---
title: Roles and field access
description: Decide what each signed-in role reads, writes and runs, which columns it sees, and what a signed-out visitor reads, enforced by the server.
---

Decide what each signed-in role reads, writes and runs, which columns it sees,
and what a signed-out visitor reads, enforced by the server.

```ts title="examples/apps/lintel/app.ts"
technician: {
  label: 'Technician',
  // …
  write: ['maintenance_request', 'request_part', 'part_receipt'],
  create: ['request_part', 'part_receipt'],
  commands: ['completeRequest', ...repairs],
  fields: {
    resident: { read: ['id', 'name', 'email', 'phone', 'language'] },
```

See it in the sample (`examples/apps/lintel/app.ts:68`).

<!-- no picture: a grant changes which rows, columns and buttons a page offers, not how the page is drawn. -->

## What you'll see

- A technician reads the buildings, the repairs and the storeroom, a resident's name and how to reach them but nothing else of the resident, edits repairs and parts used, and runs only `completeRequest` and the repair messages; a leasing agent edits the rent roll instead.
- A column outside a role's `fields` missing from its lists, records, exports and search, as if the table had no such column.
- A button, a New form or a menu entry only for the roles that may use it; the server refuses the same request from anyone else.

## When to use it, and when not

- Use role grants when people differ in what they may read or change; every rule here is checked on the server, whatever the browser sends.
- Use a [row policy](/docs/row-access/) or a [tenant App](/docs/tenant-apps/) when people differ in which rows they see, not which tables or columns.
- Use `hidden` ([secrets](/docs/secrets/)) for a column no one may read, signed in or not; a role's `fields` only narrows what signed-in roles see.

## Who reads what by default

A resource the App declares reads; `access: 'write'` is the only other value,
and the only way a resource is written. A table the App does not declare is
not served at all. Writing also needs the connection's `"writable": true` in
`mistri.json`, which the adapter enforces whatever the App says.

| The App has | A signed-out visitor | A signed-in person |
| --- | --- | --- |
| No `auth` | Every declared resource, every column but `hidden` ones, and writes the `'write'` ones | (no sign-in) |
| `auth`, no `roles` | Nothing: the sign-in card | Every declared resource; writes the `'write'` ones |
| `auth` and `roles` | Only what `auth.public` names | What their roles grant together, and nothing else |

With roles, access is denied unless granted: a role that leaves out `read`
reads nothing, and a role the App does not declare grants nothing.

## Options

| Grant | What it does | Default | Status |
| --- | --- | --- | --- |
| `read` | `true` for every declared resource, or a list | nothing | Stable |
| `write` | `true` for every `'write'` resource, or a list, within what the role reads | nothing | Stable |
| `create` | Of what it writes, where it makes new rows: `false` edits only, or a list | all it writes | Stable |
| `export` | Tables it may export as a file, beyond those it writes (which it always may): `export: ['charge']`. A signed-out visitor never may | what it writes | Stable |
| `commands` | The [commands](/docs/commands/) it may run; grants no Save, New or Delete | none | Stable |
| `actions` | Fixed [actions](/docs/actions/#who-may-click-it) by id on a resource it does not write | none | Stable |
| `fields` | Narrows the columns it reads and writes, per resource | every column | Stable |
| `label` | The role's name for people: accounts, a suite's grants, a tenant's members | its id as words | Stable |
| `extends` | Another role whose grants it holds too | none | Stable |
| `operations` | Operator reads: `'readiness'`, `'bundle'`, `'jobs'`, `'deliveries'`, `'workflows'`, `'stores'`, `'analytics'` | none | Stable |

A person may export a table (the whole list as a CSV or JSON file) when any of
their roles writes it or lists it in `export`, as the accountant does
(`export: ['charge', 'payment']`). The server refuses the file, not just the
menu, and a file that reaches another table through a reference
(`incident show id, service_id.name`), a rollup or a computed column needs the
grant for that table too. A list of a table the person may not export reads at
most 2,000 rows at a time. `ui.export: false` refuses every file, over any
grant, and in an App without role grants it is the one switch.

A role cannot widen a resource's ceiling. All keys:
[the generated reference](/docs/dsl-auth/). Every grant is a line of
`authority.lock`, so a change in what anyone may do is a reviewed diff.

### One role on top of another: `extends`

A role that does everything another does, and more, says so once:

```ts
mechanic: { read: true, write: ['work_order', 'work_order_part'], commands: ['startRepair'] },
manager: { extends: 'mechanic', write: ['customer'], commands: ['approveQuote'] },
```

Every grant passes down as the union of both; `label`, `claims` and `service`
stay the role's own. A loop or a role of another realm is refused, and
`authority.lock` lists all the manager holds, beneath `role manager extends mechanic`.

A view's or page's `roles` open to a role that extends one they name:
`roles: ['mechanic']` is opened by a manager too, through any depth, and
`roles: ['manager']` is never opened by the mechanic it extends. Only `roles`
on views and pages work this way. The `principal.roles` a
[row policy](/docs/row-access/) reads, a `home` rule's roles and a theme's
`for.roles` match a role by its own name: list `manager` beside `mechanic`
there.

### Columns: `fields`

A resource's own `fields: { read, write }` is the column ceiling for every
signed-in role; a role's `fields` narrows it further, and may say only `write`
to narrow what it edits. Lintel's leasing role edits a viewing's status, day,
home, phone and message but never its `version`:

```ts title="examples/apps/lintel/app.ts"
fields: {
  unit: { write: ['market_rent', 'listed', 'available_on', 'headline', 'description'] },
  // A viewing moves along its verbs; a command's revision column (`version`) is never edited in place.
  viewing: { write: ['status', 'preferred_on', 'unit_id', 'phone', 'message'] },
},
```

See it in the sample (`examples/apps/lintel/app.ts:26`).

Grants and commands meet in four rules, and `check` names every conflict in one
run: a role's `create` needs `write`; `fields` only narrows what a role already
reads or writes, so a column it names must be one the role reads; any role that
writes a table a command writes must narrow it with
`fields: { table: { write: [...] } }` (or the table needs a machine), the
`[command-and-edit]` refusal; and a command target's `version` column is never
in a `fields` write list, because only commands move a revision.

A column a role does not read is left out of metadata and every answer, and a
query, filter or sort that names it is refused. Primary keys stay readable, and
a written column must be readable. `fields` needs `auth` and `roles`; without
sign-in, use `hidden`. A command's handler still reads its footprint whole.

### Views and pages: `roles`

A list, dashboard, room, signed-in form or page that names `roles` opens only
for those roles: anyone else finds it missing from their menu, ⌘K and search,
and its address opens nothing, while table grants still apply.

```ts
queues: listView('Queues', 'ticket', { roles: ['agent', 'lead'], tabs }),
```

### Signed-out visitors

`auth.public` lets a visitor who has not signed in read the
resources it names, read-only, as Lintel opens its listings:

```ts title="examples/apps/lintel/app.ts"
public: {
  read: ['property', 'property_photo', 'unit'],
  fields: {
    property: { read: ['id', 'name', 'address', 'city', 'state', 'zip', 'kind', 'year_built', 'description'] },
    // …
```

See it in the sample (`examples/apps/lintel/app.ts:136`).

Each resource is named; `read: true` is refused, so nothing is public by
accident. A public resource's record opens for a visitor at its own address
(`/jobs/1`), on its page or the one the App builds for it, which names nothing
outside `auth.public`. A visitor writes nothing except through a
[public form](/docs/command-forms/#public-forms). It needs `auth.roles`, and a
tenant App refuses it: a visitor has no tenant.

Anything else a visitor asks for (a list, a record, a dashboard section over a
table `auth.public` does not name) is answered `401` with the sign-in card, the
same answer for a private table and for a name that is no table.

## Common mistakes

- `[outside-ceiling]`: a role writes a resource without `access: 'write'` → add `access: 'write'` to the resource; a role grants only within it.
- `[role-cannot-read]`: a list, page or record name uses a column some roles cannot read → add the column to their `fields.<table>.read`, or show another.
- `[needs-auth]`: `fields` in an App without sign-in → use `hidden`, or add `auth` with `roles`.
- `[write-unreadable-parent]`: a role writes a reference to a table it does not read → grant it that table, or leave the column out of its writes.

## Related

- [Sign-in](/docs/sign-in/): providers, accounts and the first administrator.
- [Row access](/docs/row-access/): which rows each person sees.
- [Secrets and hidden columns](/docs/secrets/): what holds without sign-in, and what hides nothing.
- [Resources and fields](/docs/access-model/): declared resources, `access` and `delete`.
