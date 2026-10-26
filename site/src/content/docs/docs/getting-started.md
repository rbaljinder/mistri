---
title: Get started
description: Make a starter App with one command, serve it while you change it, check it the way CI will, and build it for production.
keywords: [start, new, starter, first app, tutorial, quickstart, schema.sql, scaffold, mistri new, mistri dev]
---

Make a starter App with one command, serve it while you change it, check it
the way CI will, and build it for production.

```sh
npm create mistri billing
cd billing
npm install
npx @mistriwork/mistri dev
```

**You need** Node 24 or newer. The starter brings its own SQLite database, so
nothing else has to be running. Two other ways in, further down: [from a
schema of your own](#from-a-schema-of-your-own) on PostgreSQL, and [from a
database you have](/docs/quickstart-app/).

## 1. Make the App

```sh
npm create mistri billing
cd billing
npm install
```

**You should now see** the files it wrote: `app.ts` (the whole App),
`db/schema.sql` and `db/migrations/V1__task.sql` (its schema, and how a
database gets there), `billing.db` (that database, with a few rows),
`mistri.json` (the connection the App binds), `package.json`,
`tsconfig.json`, `.oxfmtrc.json`, `.gitignore` and a `README.md` that walks
you through them. `npm install` brings in mistri, TypeScript and Node's
types.

## 2. Serve it while you work

```sh
npx @mistriwork/mistri dev
```

**You should now see** the App's address. Open it: the starter's list, with
rows in it. Leave the server running; a save reloads the App.

## 3. Make one change

Open `app.ts` and change the App's `name`:

```ts
export default defineApp({
  id: 'billing',
  name: 'Billing desk',
  // …
```

**You should now see**, after the save, the new name in the browser's
header, with no restart.

## 4. Check it

In a second terminal, run what CI would:

```sh
npx @mistriwork/mistri check --app . --config mistri.json
```

**You should now see** `typecheck passed` and `validation passed`, and an exit
code of 0. A misspelled column or key is named with its file, its line and the
fix ([check codes](/docs/check-codes/)).

## 5. Build it for production

```sh
npx @mistriwork/mistri build --app . --config mistri.json
```

**You should now see** `built …` and the command that serves the build. A
build is optional: the source runs as it is, and a build adds the checks and a
pinned bundle. [Build and deploy](/docs/build-and-deploy/) takes it into a
container.

## From a schema of your own

Write the tables you want, the App over them and one connection, on an empty
PostgreSQL database. These are the four files the [home page](/) shows.

```sh
npm init -y && npm pkg set type=module && npm install @mistriwork/mistri typescript
```

```sh
createdb billing
```

```sql title="schema.sql"
create table customer (
  id serial primary key,
  name text not null,
  email text
);

create table invoice (
  id serial primary key,
  customer_id integer not null references customer (id),
  total numeric(10, 2) not null,
  paid boolean not null default false
);
```

```json title="mistri.json"
{
  "connections": [{
    "name": "billing",
    "url": "postgres://localhost/billing",
    "writable": true
  }]
}
```

```ts title="app.ts"
import { defineApp, listView } from '@mistriwork/mistri/app';

export default defineApp({
  id: 'billing',
  name: 'Billing',
  connection: 'billing',
  resources: {
    customer: { access: 'write' },
    invoice: { access: 'write' },
  },
  views: {
    invoices: listView('Invoices', 'invoice', {
      show: ['customer_id', 'total', 'paid'],
    }),
    customers: listView('Customers', 'customer', {
      show: ['name', 'email'],
    }),
  },
  nav: ['invoices', 'customers'],
  home: 'invoices',
});
```

Write the first migration, read it, and apply it:

```sh
npx @mistriwork/mistri migrate diff init --app .
```

```sh
npx @mistriwork/mistri migrate up --app .
```

**You should now see** `wrote migrations/V1__init.sql`, then `applied
V1__init.sql` and the App checked against the tables it made: `typecheck
passed` and `validation passed  Billing: ok`. Then serve it:

```sh
npx @mistriwork/mistri dev
```

**You should now see** `Billing: http://localhost:4111/`. Invoices is empty,
with **New invoice**; the form asks for a Customer and a Total, both required,
and sets Paid with a switch. A customer's page lists its invoices.

Two things to know:

- Writing is opt-in for each connection. Without `"writable": true` the App
  only reads, whatever `access` says.
- Write a reference in full, `references customer (id)`. The next
  `migrate diff`, after you change `schema.sql`, fetches the diff tool once
  into `.mistri/bin` ([schema.sql](/docs/schema-sql/)). Add `.mistri/` to
  `.gitignore`; `mistri dev` keeps its throwaway session secret there too.

Now name the unpaid invoices once, on the resource, and give the list a tab
for each:

```ts title="app.ts, in part" ins={3-4,9}
    invoice: {
      access: 'write',
      segments: { unpaid: 'paid = false', settled: 'paid = true' },
    },
  // …
  views: {
    invoices: listView('Invoices', 'invoice', {
      show: ['customer_id', 'total', 'paid'],
      tabs: ['unpaid', 'settled'],
    }),
```

**You should now see**, after the save, **Unpaid** and **Settled** tabs with
their counts. Misspell a column (`'piad = false'`) and `npx @mistriwork/mistri check --app .`
names it with its file, its line and the fix.

## From a database you have

`npx @mistriwork/mistri --scaffold-app ./crm-app` drafts a typed App from the schema of a
database you already have: a list per table, record pages, an overview
dashboard. [An App from your database](/docs/quickstart-app/) walks it.

## If it fails

- `… declares the tables "customer" and "invoice", which billing does not have`
  → the migration is not applied yet: run `npx @mistriwork/mistri migrate up --app .`.
- `createdb: error: connection to server … failed` → PostgreSQL is not
  running, or not on its default port; start it, or put the host, port and
  user in the `url`.
- `Cannot find module '@mistriwork/mistri/app'` → run `npm install` in the App's folder.
- `mistri dev` refuses to start → `NODE_ENV=production` is set in the shell;
  `dev` is for this machine only. Serve with `npx @mistriwork/mistri --app .` instead.

## Related

- [Build with a coding agent](/docs/build-with-an-agent/): hand the next steps to an agent, with a brief and a gate.
- [Tick in fifteen minutes](/docs/tick-tutorial/): a tab, a presentation, an action and a look, added to a running App.
- [The DSL in one App](/docs/dsl-tour/): every piece of an App, read off one sample.
- [Choose a building block](/docs/choose/): which view, section or command a need calls for.
