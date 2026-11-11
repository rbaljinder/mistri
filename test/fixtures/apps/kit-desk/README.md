# Kit desk · browser gate fixture

An internal regression fixture, not a starter application. For user or LLM
authoring, start at [the public catalog](../../../../examples/apps/README.md).

It exists for [`e2e/ui-kit.spec.ts`](../../../../e2e/ui-kit.spec.ts): an App
that brings its own control kit (`uiKit`, Preview). `ui/kit.tsx` draws the
Button, ButtonLink, Modal, the menu's four parts, Typeahead and DateField in
plain HTML, each marked `data-kit`, and leaves every other slot to the
platform. The spec walks a record page, a New save with a typeahead and a
date, and a row menu's confirmed action through those controls.

- `app.ts` — the App: one list, one record page, one confirmed action.
- `ui/kit.tsx` — the kit; `ui/kit.css` its stylesheet, read from the tokens.
- `ui/kit.test.tsx` — the kit against `@mistriwork/ui/conformance`.
- `seed.mjs` — SQLite (`DatabaseSync`): two owners, two tasks, writes the connection JSON.

Sized to that one spec. Do not grow it to demonstrate a feature.

Focused authoring check from the repository root:

```sh
npx tsc -p test/fixtures/apps/kit-desk/tsconfig.json
```
