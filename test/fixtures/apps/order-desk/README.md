# Order desk · browser gate fixture

An internal regression fixture, not a starter application. For user or LLM
authoring, start at [the public catalog](../../../../examples/apps/README.md).

It exists for [`e2e/order-lines.spec.ts`](../../../../e2e/order-lines.spec.ts):
an amount kept in minor units with each order's own currency, an order's lines
asked as a grid on the New form and saved with the record in one transaction,
and the totals said live as the form is filled in.

- `app.ts` — the App: one list, one New form with lines, one record page.
- `seed.mjs` — SQLite (`DatabaseSync`): two orders, writes the connection JSON.

Sized to that one spec. It names order 1 (dollars, two lines) and order 2
(yen, one line) by id. Do not grow it to demonstrate a feature.

Focused authoring check from the repository root:

```sh
npx tsc -p test/fixtures/apps/order-desk/tsconfig.json
```
