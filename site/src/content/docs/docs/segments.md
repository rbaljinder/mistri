---
title: Segments
description: Name a query once on a resource and use it by name in tabs, metrics, rollups, the query bar and the App API.
keywords: [segments, named query, tabs, saved query, repeated-query, overdue]
---

Name a query once on a resource and use it by name in tabs, metrics, rollups, the query bar and the App API.

```ts title="examples/apps/lintel/resources.ts"
segments: {
  occupied: 'status = occupied',
  on_notice: 'status = notice',
  vacant: 'status = vacant',
  turnover: 'status = turnover',
  available: 'status = vacant or status = turnover',
  advertised: 'listed = true',
},
```

See it in the sample (`examples/apps/lintel/resources.ts:40`).

## Names

A segment's name is a word in queries, so it cannot be one the language or the table already reads: not a column, rollup, computed column or state of the resource (`status`, `booked`), and not a query word (`today`, `me`, `and`, `or`, `not`). `mistri check` names every such segment at once. Write the readable words as the label, `{ query, label }`, and give the key a plain name of its own: `booked_rows: { query: 'status = booked', label: 'Booked' }` shows "Booked" in its tab.

The name is a word of the [query language](/docs/query/), written out inline before the conditions are read, so every use is the same statement.

| Where | How it names the segment |
|---|---|
| A list's tabs | `tabs: ['open', { segment: 'overdue', sort: 'due_on' }]` |
| A metric | `metric('Overdue', 'work_order.overdue')` |
| A related list | `related(..., { segment: 'open' })` |
| A rollup | `count('work_order', { segment: 'open' })` |
| The query bar and other queries | `overdue and mine` |
| The App API and MCP | read-only `?segment=overdue`, also how a view's tab is chosen |

A tab takes its label and its address (`?tab=overdue`) from the segment.

## When to use it, and when not

Use a segment when the same question is asked in two places, or deserves a name people say ("overdue"). A condition used once, in one tab, can stay a query in the [list](/docs/lists/).

## Options

- **The label.** A string segment is labeled by its name made readable (`open` is "Open"). `{ query, label }` sets it, as `label: 'Late'` above.
- **Built on another.** A segment may name another (`open and due_on < today`), never in a loop.
- **A tab's own keys.** `{ segment, sort }`; the label is the segment's, so a tab that names a segment and a `label` is refused.

## Common mistakes

- Giving a segment the name of a column, rollup, state or language word (`enabled`, `today`). It is a load error, since the language could not tell which is meant; the error names every such segment at once and a replacement in the label form (`today_only: { query: …, label: 'Today' }`).
- Expecting a segment to widen access. It only narrows, under the reader's row policy and field grants: a reader who may not read a column it names is served no tab, metric or word for it.
- `tabs: [{ label, query }]` → declare the segment and name it in the tab.
- `[repeated-query]`: `mistri check --design` warns where one query is written in several places, and `--fix` lifts each into a segment.

## Related

- [Lists](/docs/lists/): tabs, columns and filters.
- [Query language](/docs/query/): every operator and date phrase a segment can say.
- [Conventions](/docs/conventions/): what an App draws without being told.
