# Command desk · browser gate fixture

An internal regression fixture, not a starter application. For user or LLM
authoring, start at [the public catalog](../../../../examples/apps/README.md).

It exists so three framework specs —
[`e2e/command-actions.spec.ts`](../../../../e2e/command-actions.spec.ts),
[`e2e/policy-command-actions.spec.ts`](../../../../e2e/policy-command-actions.spec.ts)
and [`e2e/related-tabs.spec.ts`](../../../../e2e/related-tabs.spec.ts) — own the
App they run against. They test generic behaviour (a command from a record's
action bar, the same command under a row policy, a run of related lists drawn
as tabs) and used to borrow Ignition's seed because one was handy. When the
0.5.0 reshape made Ignition a PostgreSQL-only tenant sample, that seed went and
`npx playwright test` could not load the directory at all. A sample being
reshaped must not be able to do that.

- `app.ts` — the App: one list, one record page, one action.
- `refs.ts` — `assignReviewer`'s browser-safe presentation, shared by both.
- `commands.ts` — its handler and the `--commands` entry. Server-only.
- `seed.mjs` — SQLite (`DatabaseSync`), so the gate needs no service; it also
  migrates the command journal and writes the connection JSON.
- `e2e/support/commandDeskServer.ts` starts a disposable server over all of it,
  and is the only thing that should.

Sized to those three specs and nothing more. The specs name rows by id —
application 1 is the one assigned, application 3 the one whose tabs are read —
and reviewer 3 (Robin Bell) by name, so read them before changing a row. To
demonstrate a feature, author a fixture beside this one or a public sample
under `examples/`; do not grow this one.

Focused authoring check from the repository root:

```sh
npx tsc -p test/fixtures/apps/command-desk/tsconfig.json
```
