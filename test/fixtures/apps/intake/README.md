# Intake · browser gate fixture

An internal regression fixture, not a starter application. For user or LLM
authoring, start at [the public catalog](../../../../examples/apps/README.md).

It exists so [`e2e/intake-form.spec.ts`](../../../../e2e/intake-form.spec.ts)
owns the App it runs against: a public command form drawn in the intake style
(a progress bar, one question at a time, a sticky bar of actions, an editable
review) over SQLite, so the browser gate needs no service. A second, signed-in
form is declared in the stepper style for the specs that compare the two.

- `app.ts` — the App: the applications list, the five-step public intake (with
  a description, several choices in icon cards, and a yes or no as two buttons
  that a question on each answer waits on) and a signed-in stepper form.
- `commands.ts` — the two commands and the `--commands` entry. Server-only.
- `seed.mjs` — the one table the commands write, and the command journal, empty.

The names are invented. Sized to its specs: do not grow it to demonstrate a
feature; author a fixture beside it, or a public sample under `examples/`.
