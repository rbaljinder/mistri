# Command drawer · browser gate fixture

An internal regression fixture, not a starter application. For user or LLM
authoring, start at [the public catalog](../../../../examples/apps/README.md).

It exists so [`e2e/command-drawer.spec.ts`](../../../../e2e/command-drawer.spec.ts)
owns the App it runs against: one patient list, one record page, and two
commands on the record, one with two inputs (a centered dialog) and one with
twelve (a side drawer), and a third, `bookVisit`, whose dialog holds an accept box, a date and
time and choice cards.

- `app.ts` — the App.
- `commands.ts` — the handlers and the `--commands` entry. Server-only.
- `seed.mjs` — SQLite, so the gate needs no service.

Do not grow it to demonstrate a feature.
