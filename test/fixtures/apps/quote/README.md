# Quote · browser gate fixture

An internal regression fixture, not a starter application. For user or LLM
authoring, start at [the public catalog](../../../../examples/apps/README.md).

It exists so [`e2e/form-desk.spec.ts`](../../../../e2e/form-desk.spec.ts) owns
the App it runs against: a landing whose hero has points, and a stepped public
form drawn as a page — an address row with a listbox beside a masked box, one
choice in short icon cards and one in long ones, an amount on a slider, a masked
phone, the review and the done screen — over SQLite, so the browser gate needs
no service.

- `app.ts` — the App: the landing, the five-step public form and a staff list.
- `commands.ts` — the one command and the `--commands` entry. Server-only.
- `seed.mjs` — the one table the command writes, and the command journal, empty.

The names are invented. Sized to its spec: do not grow it to demonstrate a
feature; author a fixture beside it, or a public sample under `examples/`.
