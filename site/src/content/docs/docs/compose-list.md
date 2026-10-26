---
title: Composing a list
description: Rules of the form "when X, use Y" for which columns, tabs, filters and row tools a list view needs, each with a worked example.
---

Rules of the form "when X, use Y" for which columns, tabs, filters and row tools a list view needs, each with a worked example.

A list reads as a tool when its columns are the ones a person scans for and
its tabs are the ways the work divides. Lintel's repairs and rent roll are
the worked examples.

![Lintel's rent roll: counted tabs from All to Advertised, Building, Beds and Status filters to add, and rows of home, building, beds, size, asking rent, rent per square foot, status as a toned word, resident and the day it is free.](../../../assets/guide/list.webp)

- **Always**, `show` 4–7 columns: the name first, then the state, the parent
  by name (`unit_id`, drawn as the home's label), a figure and a date; never a raw id —
  `examples/apps/lintel/views.ts:65`.
- **When the rows are people or companies**, an `avatar` and a muted
  `subtitle` on the first column.
- **When the work divides by state or date**, `tabs` in the order it is
  worked, All last — `examples/apps/lintel/views.ts:151`.
- **When it is worked by narrowing on three or more facets**,
  `filterBar: 'rail'` — `examples/apps/lintel/views.ts:28`; fewer,
  the bar's chips of `filters` — `examples/apps/lintel/views.ts:52`.
- **When triage happens in the list**, make those columns `editable` —
  `examples/apps/lintel/views.ts:51`.
- **When each row is worked by talking**, a `split` with a `row`: the queue
  beside the one picked, its conversation page drawn whole —
  `examples/apps/lintel/views.ts:150`.
- **When a record's verbs are the work**, `rowActions: true` —
  `examples/apps/lintel/views.ts:104`.
- **When a figure adds up**, `totals` under the rows —
  `examples/apps/lintel/views.ts:53`; when a count or sum of children
  says more, a rollup such as `balance` shown like a column —
  `examples/apps/lintel/views.ts:86`.
- **When it can be empty**, an `empty` that says what belongs there and
  where it comes from — `examples/apps/lintel/views.ts:35`.
- **When the rows are things to look at**, a cards `presentation` —
  `examples/apps/lintel/views.ts:27`.

The keys are in [Lists](/docs/lists/).

## Related

- [Lists](/docs/lists/): every key behind the rules above.
- [Segments](/docs/segments/): name a tab's condition once.
- [Display rules](/docs/vocabularies/): how each cell is drawn.
