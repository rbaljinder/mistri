---
title: Documents
description: Put a record on paper, an invoice, a packing slip or a payslip, printed by the browser and saved as a PDF from its print dialog.
keywords: [document, documents, invoice, packing slip, payslip, quote, print, pdf, paper, letter, a4, letterhead]
---

Put a record on paper, an invoice, a packing slip or a payslip, printed by the browser and saved as a PDF from its print dialog.

```ts
invoice: document(
  'sales_order',
  [
    fields(['customer_id', 'customer_id.email'], { title: 'Billed to', presentation: 'facts', width: 'third' }),
    fields(['ship_name', 'ship_address', 'ship_city', 'ship_state', 'ship_zip'], { title: 'Ship to', presentation: 'facts', width: 'third' }),
    fields(['placed_at', 'shipping_method', 'financial_status', 'note'], { presentation: 'properties', width: 'third' }),
    related('Items', 'order_line', 'sales_order_id', { show: ['sku', 'description', 'quantity', 'unit_price_amount', 'line_amount'], sort: 'line_no' }),
    note('Thank you for shopping with us.', { variant: 'quiet', width: 'half' }),
    fields(['subtotal_amount', 'discount_amount', 'shipping_amount', 'tax_amount', 'total_amount'], { presentation: 'table', width: 'half' }),
  ],
  { label: 'Invoice', number: 'id', description: 'Alder Goods Co.\n214 Alder Street, Portland, OR 97204' },
),
```
<!-- no sample: no shipped App declares a document -->

A document is a page in `pages`, keyed like any other. It is offered as a verb in its record's **More** menu, and it lives at the record's address followed by its key: `/shop/orders/1696/invoice`. It never appears in the menu, and a record never opens on it.

## What it takes

| Key | What it says |
| --- | --- |
| `label` | The document's name. It is the verb on the record and the sheet's heading. |
| `number` | The field whose value is the document's number. A reference path works (`pay_run_id.reference`). If it is left out, the record's name is used. |
| `size` | `'a4'` or `'letter'`. If it is left out, the size follows the App's locale: Letter in North America and the Philippines, A4 elsewhere. |
| `description` | The sender's lines under the letterhead's name, such as an address or a registration number. Line breaks are kept. |

The letterhead is the App's own mark and name. A tenant's uploaded logo replaces the mark.

## Sections on paper

A document draws three kinds of section: `fields`, related lists and notes. They are placed side by side with `width` and the offsets, on the same twelve columns a page uses.

- **Fields** take the shape their `presentation` names:
  - a summary (the default) is label over value;
  - `properties` sets the caption beside the value;
  - `facts` is an address, one value per line, with a city, its state and its code joined on one line;
  - `table` is the totals: a zero is left out, and the last row, the sum owed, sits under a rule;
  - `headline` shows one figure large, such as the amount due or the net pay.
  - in a summary or `properties`, long text (an order's note, a review's summary) sits under its caption across the
    section's width, as a paragraph.
- **A related list** is every line of the record, up to 500, found by `whose` or, as on a page, by a match (`{ same: ['sales_order_id'] }`, the lines that share the record's order). It is drawn as a table whose header repeats on each sheet, with figures right-aligned in tabular numerals and money to the cent. Its `totals` are said once, under the last line.
- **A note** holds the terms, a thank-you or how to pay. `variant: 'quiet'` sets it as small print.

Paper refuses whatever operates a screen: the aside, tabs, actions, row actions, editing, a gallery or cards. `mistri check` names each one under the [`document`](/docs/check-codes/) code.

## Who sees it

A document is read the way the record's own page is read. It uses the same grants, the same field grants, the same row scope and, in a tenant App, the same tenant. A reader who cannot read the record gets nothing. In a tenant App, a member asking for another tenant's record is told it is not found, exactly as on the record's page. Nothing is rendered on the server: **Print / Save as PDF** opens the browser's print dialog.

## Related

- [Record pages](/docs/pages/): the sections a document reuses.
- [Roles](/docs/roles/): the grants a document is read under.
- [Check codes](/docs/check-codes/): the `document` code that names what paper refuses.
