---
title: Tags
description: 'Give a record labels through a link table: chips on its page, a list column, a filter, a query condition and a New-form field.'
keywords: [tags, labels, chips, link table, many to many, has, filter, facet]
---

Give a record labels through a link table: chips on its page, a list column, a filter, a query condition and a New-form field.

```ts
  issue: {
    access: 'write',
    tags: { through: 'issue_label', to: 'label', toneOf: 'tone' },
  },
```

```ts
  issues: listView('issue', {
    show: ['name', 'status', 'priority', 'tags', 'assignee_id.name'],
    filters: ['name', 'status', 'priority', 'tags', 'assignee_id'],
  }),
```

<!-- no sample: no shipped App uses tags -->

No shipped example uses tags, so these fragments are illustrative. `through` is the link table, with one reference to the record and one to the tag; `to` is the table of tags, named by its label column; `toneOf` names its column that colors each chip.

## What you'll see

- The record page shows the tags as chips under its title, added and removed there.
- `tags` in a list's `show` draws the first three chips and "+N" for the rest.
- `tags` in `filters` lists every tag to tick; a record with any ticked tag stays, and the address says `?tags=bug,docs`.
- The query language asks `tags has bug` or `tags has (bug, docs)`, any of them; `tags = bug` is refused.
- The New form offers a tags field when the reader may add link rows; the record and its link rows are written in one transaction.

## When to use it, and when not

- Use `tags` for a free set of labels many records share (issue labels, topics).
- Use a vocabulary column for one state from a fixed list, and a [related list](/docs/relationships/) when the link row has columns of its own.

## Common mistakes

- `tags need issue_label to reference issue by exactly one column` → the link table needs one reference to each side, and a key of its own.
- No tags appear for a role → the role must read the link table and the tag table; tags are read under the reader's grants and row access.
- No tags field on a New form → the role must write the link table. A tenant App takes tags on the record page, not yet on the New form.

## Related

- [Lists](/docs/lists/): columns, filters and tabs.
- [Query language](/docs/query/): every condition `has` sits beside.
- [Resources reference](/docs/dsl-resources/): every key, generated from the schema.
