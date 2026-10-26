---
title: Change the schema from schema.sql
description: Keep the schema you want in one schema.sql, and let a pinned diff tool write the next migration from it for review.
keywords: [schema.sql, desired state, schema diff, atlas, generate migration, drift check, squash, baseline, declarative schema]
---

Keep the schema you want in one schema.sql, and let a pinned diff tool write the next migration from it for review.

```sh
# edit db/schema.sql: add the column, the table, the index
npx @mistriwork/mistri migrate diff add_priority --config mistri.json   # writes db/migrations/V2__add_priority.sql
npx @mistriwork/mistri migrate check --config mistri.json               # exit 2 when they disagree
```

<!-- no picture: the change happens in a terminal; its output is quoted below. -->

## What you'll see

- `diff` prints what the migrations still lack to build `db/schema.sql` (`ALTER TABLE "task" ADD COLUMN "priority" integer NULL;`) and writes it as the next `V` file, with a header saying to review it.
- `check` builds the migrations on a scratch database and compares: `db/schema.sql matches the migrations`, or the missing SQL and exit 2. Put it in `npm test`; it takes a second or two.
- `mistri new --api` starts a project this way: `db/schema.sql`, `db/migrations/V1__task.sql`, and `npm run schema:diff`, `schema:check` and `migrate`.

## When to use it, and when not

- Use it when you would rather say what the schema is than how to get there: one file to read, review and grep, and migrations you still read before they run.
- Write the `V` file by hand instead ([Change your schema](/docs/change-your-schema/)) for a data step, a backfill or anything a diff cannot know; both kinds of file sit in the same chain.
- Nothing comes from the App's DSL: the database is the source of truth, and `mistri check` writes the App's types from it.

## Options

| Command or flag | What it does |
| --- | --- |
| `diff <name>` | Writes the next `V<n>__<name>.sql`; says so when it drops something. |
| `check` | Exit 2 unless the migrations, applied in order by mistri's runner, build `schema.sql`. |
| `squash` | Folds the `V` files into one `V1__baseline.sql` holding `schema.sql`, then checks it. Before go-live only. |
| `--schema-file <path>` | The schema you want (default `schema.sql` beside the migrations directory). |
| `--dev-url <url>` | PostgreSQL: the server for the two scratch databases (default the connection's; needs `CREATEDB`). |

The comparison is [Atlas](https://atlasgo.io)'s community build (Apache 2.0), pinned at v1.3.0. The first migration needs none of it: with no versioned migration yet, `diff` writes `schema.sql` itself as `V1`. The first `diff` that compares, or `check`, fetches it into `.mistri/bin` (about 40 MB, checked by sha256; add the folder to `.gitignore`) and runs it with its update check off; serving never fetches it, and `MISTRI_ATLAS` names an Atlas you installed. mistri's own `__mistri_*` tables are left out. PostgreSQL (one schema per run) and SQLite. On SQLite a `serial primary key` is read as `integer primary key`, so one `schema.sql` serves both; another `serial` column is refused, since SQLite would not number it.

## Common mistakes

- A renamed column comes out as `DROP COLUMN` and `ADD COLUMN` → neither tool detects renames: rewrite it as `ALTER TABLE task RENAME COLUMN old TO new;`, then `check`.
- A `NOT NULL` column filled from other rows → add it nullable, `UPDATE` it, then `SET NOT NULL`, in the generated file.
- A check constraint keeps reading as different → write it plainly (`points BETWEEN -50 AND 100`), not as Atlas prints it back.
- `could not create a scratch database` → the role lacks `CREATEDB`: name a server where it has it with `--dev-url`.

## Related

- [Change your schema](/docs/change-your-schema/): applying the files, status, drift and the history.
- [Build an API](/docs/build-an-api/): the project `mistri new --api` writes.
- [Build and deploy](/docs/build-and-deploy/): where `migrate up` sits in a deploy.
