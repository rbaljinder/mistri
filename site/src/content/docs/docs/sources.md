---
title: Sources
description: Bind an App to one database or several, by connection name, and name each table so its source is plain.
keywords: [sources, connection, several databases, multiple databases, schema, postgres schema, default source, physical]
---

Bind an App to one database or several, by connection name, and name each table so its source is plain.

```ts title="examples/apps/lintel/app.ts"
  sources: { lintel: { connection: 'lintel' } },
  resources,
```

See it in the sample (`examples/apps/lintel/app.ts:54`) (the resources are declared in `resources.ts`); [Sample Apps](/docs/examples/) says how to run Lintel.

<!-- no picture: a source is configuration; nothing on screen changes with it. -->

Several sources, one of them the default:

```ts
sources: {
  ops: { connection: 'fieldops', default: true },
  billing: { connection: 'billing' },
},
resources: { work_order: { access: 'write' }, 'billing.payment': {} },
```

## What you'll see

- The default source's tables named bare (`work_order`) and every other source's as `source.table` (`billing.payment`), in views, pages, paths and grants alike.
- Connection URLs and credentials only in mistri.json; `authority.lock` records each binding (`source billing connection "billing"`).

## When to use it, and when not

- Use one source for one database: a lone source is the default, and saying `default: true` on it is restated.
- Use a source per schema on one PostgreSQL connection when the tables live in several schemas: `ops: { connection: 'main', schema: 'ops' }` beside `catalog: { connection: 'main', schema: 'catalog' }`. They are one database, so keys join and writes to both are one transaction.
- Use sources on different connections only when the data truly lives apart: they share no joins or transactions, and a reference between them labels and links but never filters ([relationships](/docs/relationships/)).

## Options

| Key | What it does | Default | Status |
| --- | --- | --- | --- |
| `connection` | A connection named in mistri.json | required | Stable |
| `default` | Whose tables stay bare; at most one says `true` | the lone source | Stable |
| `schema` | The one PostgreSQL schema it sees; not on SQLite | the connection's | Stable |
| `resources` | `'all'` or a list: tables served without a `{}` block each | blocks only | Stable |
| `physical` (on a resource) | The engine table it binds, `'archive.opportunity'`; the only place an engine schema appears | inferred | Stable |

```json
{ "connections": [
    { "name": "fieldops", "url": "${FIELDOPS_URL}", "writable": true },
    { "name": "billing", "url": "postgres://reader@billing-db/billing" } ] }
```

A table name two PostgreSQL schemas share is inferred as `<schema>_<name>` for each copy. Adding, removing or rebinding a source changes the App's authority, so it needs a [restart](/docs/reload-and-restart/). Every key: [App reference](/docs/dsl-root/).

## Common mistakes

- `[unknown-connection]` → the App names a connection mistri.json does not have; add it or fix the name.
- `[restated]` on `default: true` beside no other source → delete it.
- Two sources on one connection without a `schema` each, or a schema the connection's `"schemas"` leaves out → give each its own schema and list it.

## Related

- [Configure connections and services](/docs/services/): mistri.json, URLs and `"writable"`.
- [Resources and fields](/docs/access-model/): what each source's tables may do.
- [Tenant Apps](/docs/tenant-apps/): one source, its rows per tenant.
- [Change your schema](/docs/change-your-schema/): migrations run per source's schemas.
