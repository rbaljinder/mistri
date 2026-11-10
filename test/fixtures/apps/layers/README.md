# Layers · browser gate fixture

An internal regression fixture, not a starter application. For user or LLM
authoring, start at [the public catalog](../../../../examples/apps/README.md).

It exists so [`e2e/page-layers.spec.ts`](../../../../e2e/page-layers.spec.ts) owns the
App it runs against: what a free-form page draws around itself, over SQLite, with no
sign-in.

- `pages/kit.page.tsx` — one of each house control, with `?show=modal|drawer|popover`
  opening a layer, over a page child at `z-index: 9`.
- `pages/wall.page.tsx` — a bare page whose root fills the window.
- `pages/hero.page.tsx` — a page with `head: false` that draws its own first child.
- `seed.mjs` — the three things the pages read.

The names are invented. Sized to its spec: do not grow it to demonstrate a feature.
