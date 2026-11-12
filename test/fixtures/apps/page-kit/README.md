# Page kit · browser gate fixture

An internal regression fixture, not a starter application. For user or LLM
authoring, start at [the public catalog](../../../../examples/apps/README.md).

It exists so [`e2e/page-kit.spec.ts`](../../../../e2e/page-kit.spec.ts) owns the App it
runs against: the page kit's layout vocabulary (a rail beside a column, rows with a
lead and a tone, a button with an address, a skeleton, a segmented choice, a file
field), over SQLite, with no sign-in.

- `pages/vocabulary.page.tsx` — one of each, on one page.
- `seed.mjs` — the things the page reads.

The names are invented. Sized to its spec: do not grow it to demonstrate a feature.
