# Choose · browser gate fixture

An internal regression fixture, not a starter application. For user or LLM
authoring, start at [the public catalog](../../../../examples/apps/README.md).

It exists so [`e2e/app-choose.spec.ts`](../../../../e2e/app-choose.spec.ts) owns the App it runs
against: two sites, a visit list narrowed to the picked site (`chosen.site`), and the
preferences store that keeps a person's pick.

- `app.ts` — the App.
- `seed.mjs` — SQLite, so the gate needs no service.

Do not grow it to demonstrate a feature.
