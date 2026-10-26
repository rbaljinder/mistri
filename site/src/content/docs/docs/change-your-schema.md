---
title: Change your schema
description: Change the database with versioned SQL files, and see what the change breaks in the App before it runs.
keywords: [migrations, migrate, schema change, alter table, flyway, drift, baseline, ddl]
---

Change the database with versioned SQL files, and see what the change breaks in the App before it runs.

```sh
npx @mistriwork/mistri migrate new add_payoff_quote --app .   # writes migrations/V2__add_payoff_quote.sql
npx @mistriwork/mistri check --app . --pending                # the App against the schema to come
npx @mistriwork/mistri migrate up --app .                     # apply, regenerate the types, check
```

<!-- no picture: the change happens in a terminal; its output is quoted below. -->

## What you'll see

- `check --pending` applies the pending files to a scratch copy (`--pending-on <url>`: to a scratch database you name, such as a branch, where the role cannot create databases) and names what a dropped or renamed column breaks (`[unknown-column] view "tasks": "due" is not a column on task`), before anything changes.
- `migrate up` applies each file in its own transaction, rewrites `mistri-schema.d.ts`, and runs `check` (exit 4 when the App no longer fits).
- `migrate status` lists applied, pending and drift, and whether the App's types are older than the database.

## When to use it, and when not

- Use `mistri migrate` when the App's team owns the schema: forward-only `V2__name.sql` files, plus `R__views.sql` files that rerun whenever they change.
- Keep your existing tool when one already runs migrations; run `mistri check --app .` after it, which rewrites the types and checks the App.
- Use `migrate stores` instead for mistri's own tables (sign-in, history, inbox, jobs, workflows, a tenant App's tenant and sandbox stores): they move only through it, and serving never migrates them.

## Options

| Command | What it does |
| --- | --- |
| `new <name>` | The next `V` file (`--repeatable`: an `R__` one). |
| `up` | Applies what is pending (`--dry-run` prints the SQL). |
| `status` | Applied, pending, drift and stale types. |
| `validate` | Exit 2 unless nothing is changed, missing, failed or pending and there is no drift. |
| `baseline` | Records an existing database as version 0; nothing in it changes. |
| `repair` | Removes failed entries, accepts changed files, marks missing ones deleted. |
| `stores status`, `stores up` | mistri's own stores, each step in its own transaction, safe to run twice (`--suite suite.json`). |

Files live in `migrations/` in the App, the connection's `"migrations"`, or `--migrations`. A run holds a lock (a PostgreSQL advisory lock, MySQL `GET_LOCK`, SQLite's write lock), so two deploys never migrate at once, and it owns only the schemas the App's sources use. On PostgreSQL, `--pending` copies the database with `CREATE DATABASE … TEMPLATE`, which needs `CREATEDB`; a `V3__index.sql.conf` saying `executeInTransaction=false` runs a file outside a transaction (`CREATE INDEX CONCURRENTLY`).

Names, checksums and the history layout are Flyway's. To take over from Flyway, name its table (`--history-table flyway_schema_history`); `--tool flyway` runs a command through an installed Flyway (on the `PATH`, or `MISTRI_FLYWAY`).

## Common mistakes

- `up` refuses a database that has tables and no history → run `migrate baseline` once; nothing in it is changed.
- `[pending-migration]` → a pending file failed on the scratch copy, or the files and their history disagree; fix the file, or `repair` after an edit you meant.
- `[schema-types-stale]` → someone changed the database outside migrations; `mistri check` rewrites the types, and `status` lists the drift until a migration settles it (`ADD COLUMN IF NOT EXISTS note`).
- A MySQL migration failed halfway → MySQL commits DDL as it runs; finish or undo it by hand, then `repair`.

## Related

- [Change the schema from schema.sql](/docs/schema-sql/): write the schema you want, and let a diff write the next file.
- [mistri check](/docs/check-codes/): every step and code `--pending` can print.
- [Build and deploy](/docs/build-and-deploy/): where `migrate up` sits in a deploy.
- [Sources](/docs/sources/): which schemas a run owns.
- [Reload and restart](/docs/reload-and-restart/): what a schema change needs from a running server.
