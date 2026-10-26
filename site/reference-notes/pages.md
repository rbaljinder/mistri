```ts
import { fields, page, related } from '@mistriwork/mistri/app';

pages: {
  opportunity: page('opportunity', [
    fields(['name', 'stage', 'amount'], { presentation: 'summary' }),
    related('Tasks', 'task', 'opportunity_id', { show: ['subject', 'status', 'due_on'] }),
  ]),
},
```

A page takes its resource and its sections, and optionally `path`, `listTabs`,
`aside: false` (no default aside of the remaining fields), `layout` and `realm`.
`layout` is the page's archetype, how its regions are arranged:
`'conversation'` (one timeline, last in the main column, the record beside it),
`'showcase'` (a gallery first with a panel of 1 to 3 aside sections beside it,
then the rest at full width) or `'article'` (one column at a reading measure,
no aside), or `'record'`, the record's own main column and aside. Left out,
the page is drawn in the one its sections make: a gallery first is a showcase,
a timeline ending the main column with no list there a conversation, the
record's long text with its facts alone an article, anything else the record's
own (`mistri check --defaults` says which and why).
A page's `layout` names a shape from that fixed set, where a dashboard's
`areas` draws its own grid ([dashboard areas](/docs/dsl-views/#viewskinddashboardareas)). It is called by its resource's `noun`, so `page('issue', [...])`
carries no label of its own. A page may also be a file under `pages/`.
See [Record pages](/docs/pages/).

| Helper | Says |
| --- | --- |
| `header({ status?, facts?, primary?, destructive? })` | The record's title row; its buttons are the resource's actions, `primary` filled and `destructive` last. |
| `fields(show, { presentation? })` | `summary`, `facts`, `table` or `properties`; a summary over a machine draws its stepper. |
| `card(title, 'dealer_id', show)`, `headline(figure, { was?, subfigure?, note?, links? })` | The record a reference names, and a figure with its facts: sections of their own. |
| `related(title, from, whose, opts)` | Rows pointing at the record: `show`, `query`, `sort`, `limit`, `create` (with its `prefill`), `empty`, `totals` (columns, or the rows' rollups: `['total_amount', 'refunded']`), `rowActions: true` (each row's own verbs in a ⋯, so an order's payment is voided from the order); `actions: ['addBuyer']` (the record's own verbs drawn in the list's head instead of the record's); `create: false` (no Add: where the reader may add a row, a list offers the child's New form bound to the record); `group: { by, show?, sort?, limit?, empty?, sum? }` (a header for each record the rows share, one level deep, with `limit` then the rows to a group; the rows with no value are the last group, "No <column>" or `empty`; `sum` is a column summed in each header; `rowActions` draws on each group); `presentation: 'gallery'` or `cards(…)` with the list view's keys. |
| `current(title, from, whose, { query, sort, show })` | The one current related row as a card: the active lease, the latest visit. |
| `similar(title, from, { same, near? })` | Rows like this one; `near: { price: 0.25 }` is ±25%. |
| `metric`, `chart`, `breakdown` with `{ whose }` | The dashboard helpers, narrowed to this record's rows. A bar chart or donut draws a category with an order of its own in it (a date, a step, allowed values, the rows' own label oldest first); `sort: 'value' \| 'category' \| 'starts_on desc'` overrides. |
| `timeline(title, [stream(from, whose, at, show)])` | Dated rows from up to four tables, merged. |
| `history()` | The record's own changes. |
| `note(text, opts)`, `embed(view, { whose })`, `custom(title, component, opts)` | Guidance, a list narrowed to this record (a view with a board or calendar presentation is drawn as one), a custom component. |

A fields section once took more forms. They are refused, and the refusal prints this table:

| Was | Is now |
| --- | --- |
| `fields(…, { presentation: 'card' })` | `card(title, 'dealer_id', ['rating', 'city'])` |
| `fields(…, { presentation: 'headline' })` | `headline('price', { was, subfigure, note, links })` |
| `fields(…, { presentation: 'accordion' })` | gone: a group of fields is always open |
| `fields(…, { collapsed })` | gone with the accordion |
| `fields(…, { actions })` | `headline(figure, { links })` |
| `fields(…, { subfigure, was, note })` | `headline(figure, { subfigure, was, note })` |

Every section takes `title`, `region` (`'aside'` for the side panel), `tab`,
`width`, `hidden` and `when` (`'status = converted'`).
