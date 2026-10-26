---
title: Money, lines and live totals
description: Keep amounts in cents with each order's currency, edit its lines as a grid saved with it, and show its totals as the form is filled in.
keywords: [money, cents, minor units, currency, order lines, line items, child rows, grid, live totals, computed, subtotal]
---

Keep amounts in cents with each order's currency, edit its lines as a grid saved with it, and show its totals as the form is filled in.

Three keys make an order: an amount kept in minor units, the lines asked as a grid and saved with the record in one transaction, and the totals said as the form is filled in.

```ts title="app.ts"
import { computed, defineApp, listView, sum } from '@mistriwork/mistri/app';

export default defineApp({
  name: 'Orders',
  connection: 'orders',
  resources: {
    order_line: { access: 'write', delete: true, display: { unit_price: { format: 'money', minor: true } },
      computed: { line_total: computed.number('quantity * unit_price') } },
    sales_order: {
      access: 'write',
      rollups: { subtotal: sum('order_line', 'line_total') },
      computed: { total: computed.number('subtotal + shipping') },
      display: {
        shipping: { format: 'money', minor: true, currency: { column: 'currency' } },
        total: { format: 'money', minor: true, currency: { column: 'currency' } },
      },
      form: {
        show: ['customer_id', 'currency', 'shipping'],
        lines: [{ label: 'Lines', from: 'order_line', whose: 'order_id', show: ['product_id', 'quantity', 'unit_price'], order: 'position', min: 1 }],
        live: ['subtotal', 'total'],
      },
    },
  },
  views: { orders: listView('Orders', 'sales_order') },
  home: 'orders',
  nav: ['orders'],
});
```
<!-- no sample: no shipped App asks for lines in a form -->

## Money in minor units

`minor: true` on a money rule says the integer column holds cents (paise, yen, fils): `1999` is said $19.99, ¥1,999 or 1.999 KWD, in the currency's own decimals. A person types `19.99` and `1999` is stored; `19.999` is refused, not rounded. `currency` is a fixed code, `{ column }` (each row's own code), or left out for the App's `ui.currency`. Sums, rollups, dashboard figures and a CSV export say the major figure; a CSV import reads it back, in the decimals of the row's own currency column when it is mapped. Where rows differ in currency, a metric, a record's figures and a board's lanes sum each currency apart (`$1,200 · €300`); a chart or breakdown is told to group `by` the currency column, or keep to one with `query: 'currency = USD'`. JSON and the API keep the stored integer. A decimal money column stays as it was: leave `minor` off.

## Lines

`form.lines` asks child rows under the New form's fields: a grid of `show` inputs, with Add line, Remove and, with `order`, up and down. The server inserts the record and every line in one transaction, `whose` filled with the new record's key and `order` with each row's place; each line is judged as its own insert would be (grants, validation), and a refusal marks the line's field and saves nothing. On the record page, `related('Lines', 'order_line', 'order_id', { show: [...], order: 'position', editable: true })` is the same grid over the saved lines, with Save: rows added, changed and removed together. Up to four collections, 64 rows each.

## Live values

`form.live` names the resource's computed columns and rollups the form says as it changes, worked out in the browser by the server's own expression rules. A rollup sums the lines the form holds; a computed column reads the draft and those rollups. It is a preview: the saved record's figures are the server's, read from the rows it stored.

## Common mistakes

- `[money-minor]` → `minor` over a `numeric` column; keep cents in an integer, or drop `minor`.
- `[form-lines]` → the child is not `access: 'write'`, or `whose` is not its reference to the record; `show` never names `whose` or `order`.
- `[form-live]` → a live rollup over rows the form does not ask, or narrowed by `query`; roll up a computed column of the line instead.
- A line refused with 403 → the reader may not add rows of the child (or, editing in place, remove them); grant the child as you would for adding it alone. In a tenant App and under a row policy each line is written as that reader's own insert, update or delete, stamped and judged the same way.

## Related

- [Forms](/docs/forms/): the form that asks for lines.
- [Record pages](/docs/pages/): the editable related grid.
- [Display rules](/docs/vocabularies/): money and its currency.
- [Resources reference](/docs/dsl-resources/): rollups and computed columns.
