---
title: Secrets and hidden columns
description: Keep a column, a credential or an environment variable out of every browser, and know which ways still hold without sign-in.
---

Keep a column, a credential or an environment variable out of every browser,
and know which ways still hold without sign-in.

```json
"hidden": { "staff": ["password_hash"], "*": ["*_token"] }
```

That entry, on a connection in `mistri.json`, cuts the columns from the browser, MCP and every App on it. The App can say the same of its own resource, and no reader of the dealers' desk then receives a car's `cost`, signed in or not (illustrative: no shipped example hides a column this way):

```ts
vehicle: { ...resources.vehicle, hidden: ['cost'] },
```

<!-- no picture: a hidden column is simply not there. -->

## What you'll see

- No `cost` in any list, record, export, search, history or App API answer; a filter or sort that names it is refused as naming a column that is not there.
- `show: ['cost']` failing the typecheck: the generated types list the column under `Hidden`, while a command's `Rows` still has it.

## When to use it, and when not

- Use `hidden` for a column no reader of the App may have; it holds with sign-in or without, and no role re-grants it.
- Use a role's `fields` ([roles](/docs/roles/#columns-fields)) when some signed-in roles may read the column and others may not.
- Use a database role without `SELECT` on the column when nothing that holds the connection may read it: the strongest answer.

## Options

| Way | Without sign-in | What it does |
| --- | --- | --- |
| A database role without `SELECT` on the column | Holds | The column never reaches the server |
| A view without it, its table out of reach (no `SELECT`, or `"schemas"` naming only the views') | Holds | A view alone hides nothing while its table is readable |
| A separate SQLite file | Holds | SQLite has no roles: every table in a file is readable |
| Leaving the table out of `resources` | Holds | The App does not serve it; the standalone browser still reads it |
| `hidden: [...]` on the resource | Holds | Cut from every answer; raw SQL refused; history redacts it. Never the key, `address` or a `search` field |
| `"hidden": { "staff": ["password_hash"], "*": ["*_token"] }` on the connection | Holds | The same cut for the browser, MCP and every App on it; raw SQL and deletes on such a table are refused |
| `fields: { read }` on the resource or a role | Needs `auth` and `roles` | A column ceiling for signed-in roles |
| `display: { x: { masked: true } }` | Hides nothing | Draws a placeholder; the value still reaches the browser |
| `show`, a page's fields, `nav` | Hides nothing | Only decides what is drawn |

`audit: { redact: ['ssn'] }` does not hide a column either: it keeps the
value out of the write trails (a keyed hash instead) and out of `history()`.

### Credentials and the App's environment

Connection URLs, service tokens and an identity provider's `clientSecret`
live in `mistri.json` as `${VARIABLE}` references read from the server's
environment; an unset one is an error, and none reaches an App or a browser.
`app.ts` runs in a worker with no environment, because whatever it builds
from a value is sent to every browser. `mistri.json` passes the names it
lists: `{ "apps": [{ "dir": "apps/ops", "env": ["REGION", { "name": "MAP_KEY", "secret": true }] }] }`.
A name that reads like a credential (`PASS`, `SECRET`, `TOKEN`, `KEY`,
`DATABASE_URL`, `PG…`) is refused unless written with `"secret": true`, and
each name is a line of `authority.lock`. Server-only modules (`--commands`,
`--jobs`, `--policy`) run with the server's environment and never reach the
browser.

## Common mistakes

- `[needs-auth]`: `fields` in an App without sign-in → use `hidden`, or the database's privileges.
- `[env-not-passed]`: the App reads a variable its config does not pass → list it in `apps[].env`, with `"secret": true` if it is one.
- A masked value is still in the page's data → mask only for the screen; use `hidden` or a role's `fields` to withhold it.

## Related

- [Roles and field access](/docs/roles/): who reads what, by default and by grant.
- [Resources and fields](/docs/access-model/): declared resources and `access`.
- [Reload and restart](/docs/reload-and-restart/): a change to `env` needs a restart.
