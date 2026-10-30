---
title: An App from your database
description: Draft a typed App from a PostgreSQL or SQLite database you already have, check it, serve it and make it yours.
keywords: [scaffold, existing database, draft, quickstart, --scaffold-app, reverse engineer]
---

Draft a typed App from a PostgreSQL or SQLite database you already have, check it, serve it and make it yours.

```sh
export DATABASE_URL=postgres://reader@localhost/crm
npx @mistriwork/mistri --scaffold-app ./crm-app --name Sales
cd crm-app && npm install
npx @mistriwork/mistri check --app .
npx @mistriwork/mistri --app .
```

**You need** Node 24.22.1 or newer and a database with a few related tables. To
practice, use a copy, or a role that can only read.

## 1. Draft it

`--scaffold-app` reads the schema and writes an App project: `app.ts`,
`resources.ts`, `views.ts`, `dashboard.ts`, `pages/`, the schema's names as
types in `mistri-schema.d.ts`, a `package.json`, a `tsconfig.json` and an
oxfmt setup, so the project reads like the samples.

**You should now see** `Drafted "Sales" in ./crm-app`, with a count of views
and record pages.

For a SQLite file, name it instead: `npx @mistriwork/mistri ./crm.sqlite --scaffold-app
./crm-app --name Sales`. That also writes a `mistri.json` naming the file,
so nothing below needs `DATABASE_URL`.

## 2. Check it

`npm install`, then `npx @mistriwork/mistri check --app .` regenerates the schema types,
typechecks the App and validates it against the database.

**You should now see** `3 of 3 steps passed`. A warning, such as an index a
related list would use, is advice and does not fail the check.

## 3. Serve it

**You should now see** `Sales: http://localhost:4111/`. Open it:

- an Overview dashboard: a count per main table, how the work moves through its
  states, a trend by month and the newest rows (on an empty database, a
  checklist of first records instead);
- a list for each table, the busiest first, then the lookups in a folded group;
- a record page for each table others point at, its related rows in tabs, and
  references shown by name, never by id.

## 4. Make it yours

Open `views.ts`, remove a name from a list's `show`, and save: the page reloads
without that column ([reload and restart](/docs/reload-and-restart/)).

The draft only reads. To edit a table, give its resource `access: 'write'` in
`resources.ts` and its connection `"writable": true`; both are needed
([resources and fields](/docs/access-model/)). Keep later schema changes in
[migrations](/docs/change-your-schema/).

## If it fails

- `Cannot find module '@mistriwork/mistri/app'` → run `npm install` in the App's folder.
- `no database to check the App against` → `DATABASE_URL` is not set in this
  shell; export it, or pass the URL: `npx @mistriwork/mistri check --app . postgres://…`.
- A typecheck error after a migration → run `npx @mistriwork/mistri check --app .` again;
  it rewrites the schema types from the database.

## Related

- [Get started](/docs/getting-started/): a starter App, or one from a schema you write.
- [The DSL in one App](/docs/dsl-tour/): every piece of an App, read off one sample.
- [Build with a coding agent](/docs/build-with-an-agent/): hand the curating to an agent, with a loop and a rubric.
- [Choose a building block](/docs/choose/): what to turn the draft's lists and pages into.
