# Door · browser gate fixture

An internal regression fixture, not a starter application. For user or LLM
authoring, start at [the public catalog](../../../../examples/apps/README.md).

It exists so [`e2e/public-door.spec.ts`](../../../../e2e/public-door.spec.ts)
owns the App it runs against: what a signed-out visitor meets at a public door,
over SQLite, with no call leaving the machine.

- `app.ts` — the App: a landing whose hero has a badge, three photo tiles and
  two icon rows; a public form that asks a human check, offers the `make` rows
  as its choices and draws its color field with the App's own input component;
  a signed-in list.
- `commands.ts` — the two public commands, the human check (Turnstile's local
  stand-in from `packs/challenge-turnstile`, started in the server's process)
  and the `--commands` entry. Server-only.
- `pages/lobby.page.tsx` — a public free-form page whose command goes through
  the page's own door with its ticket, and whose select of makes is drawn from
  the rows served with that command.
- `widgets/Swatch.tsx` — the input component: a row of swatches.
- `seed.mjs` — the makes, the photos, the tables the commands write, and the
  command journal.

The names are invented. Sized to its spec: do not grow it to demonstrate a
feature; author a fixture beside it, or a public sample under `examples/`.
