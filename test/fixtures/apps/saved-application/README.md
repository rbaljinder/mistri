# Saved application · browser gate fixture

An internal regression fixture, not a starter application. For user or LLM
authoring, start at [the public catalog](../../../../examples/apps/README.md).

It exists so [`e2e/saved-form.spec.ts`](../../../../e2e/saved-form.spec.ts)
owns the App it runs against: a public form saved on every step
(each step runs a command) over SQLite, so the browser gate needs no service, with
the status check and the link, which a tenant App's saved form does not serve.
Ignition carries the tenant App's saved form, on PostgreSQL.

- `app.ts` — the App: the applications list and the four-step form, with its
  status check and the two ways an application is added to an account.
- `refs.ts` — each step's command, as the App graph sees it.
- `commands.ts` — the handlers and the `--commands` entry. Server-only.
- `seed.mjs` — the root table, the three tables beneath it, and the command
  journal, empty.
