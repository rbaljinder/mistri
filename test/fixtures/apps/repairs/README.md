# Repairs · browser gate fixture

An internal regression fixture, not a starter application. For user or LLM
authoring, start at [the public catalog](../../../../examples/apps/README.md).

It exists so [`e2e/held-files.spec.ts`](../../../../e2e/held-files.spec.ts)
owns the App it runs against: a public command form that takes photos
(`field.files`), close-ups that are each a photo and its note (`field.files`
in a repeating `field.group`) and a signature (`field.signature`), each held as it is sent
and stored by the command as a row of its file resource, over SQLite.

- `app.ts` — the App: the repairs list and the one-page public form.
- `commands.ts` — the command and the `--commands` entry. Server-only.
- `seed.mjs` — the three tables the command writes, and the command journal, empty.

The names are invented. Sized to its spec: do not grow it to demonstrate a
feature; author a fixture beside it, or a public sample under `examples/`.
