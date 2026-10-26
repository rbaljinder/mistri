```ts
resources: {
  opportunity: {
    access: 'write',
    display: { amount: { format: 'money' }, stage: { tone: { closed_won: 'good', closed_lost: 'bad' } } },
    form: { show: ['name', 'account_id', ['amount', 'close_date']], defaults: { stage: 'prospecting' } },
    actions: { markWon: action('Mark won', { set: { stage: 'closed_won' }, when: 'stage = negotiation' }) },
    computed: { is_stale: computed.boolean('close_date < today and stage != closed_won') },
  },
  account: {},
},
```

Every table a view, dashboard or page reads needs a block, and `{}` is
enough: an App serves only its declared resources, and every declared
resource reads. Only `access: 'write'` writes, and the connection's
`"writable": true` still applies ([Resources and fields](/docs/access-model/)).
A resource's name is bare for the default source and `source.name` for
another. Every yes/no key takes `true` or `false`, and `false` means what
leaving it out means.

## Rollups

```ts
account: {
  rollups: {
    open_deals: count('opportunity', { query: 'stage != closed_won and stage != closed_lost' }),
    open_pipeline: sum('opportunity', 'amount', { query: 'stage != closed_won and stage != closed_lost' }),
  },
},
```

`count`, `sum`, `min` and `max` read the rows that point at the record, and
`latest` reads a column of the newest of them: an order's
`financial_status: latest('payment', 'status')` is its payment's own word,
read where the payment writes it, so no command keeps a copy on the order in
step (newest by key, or by `by`, a date). A
rollup reads like a column in `show`, sorts, tabs, conditions, a command's
`when`, cards and measures, and through a reference (`account_id.open_deals`). It reaches two
hops (`whose: 'task_id.project_id'`), `latest` included: a customer's
`last_service: latest('work_order', 'status', { whose: 'bike_id.customer_id' })` is the newest
of all their bikes' orders. It is computed in the same statement under
the grants and row policy of every table it walks, and is never written. Not
on API sources. Its `query` may follow the rows' references, so a product's
units sold leave out cancelled orders without a status copied onto each line:
`sum('order_line', 'quantity', { whose: 'variant_id.product_id', query: 'sales_order_id.status != cancelled' })`.

## Segments

```ts
work_order: {
  segments: {
    open: 'status is open',
    overdue: { query: 'open and due_on < today', label: 'Late' },
  },
},
```

A segment names a query once. Its name is a word of the query language
(`overdue and mine`), a tab names it (`tabs: ['open', { segment: 'overdue', sort: 'due_on' }]`),
a section takes it as its source (`metric('Late', 'work_order.overdue')`,
`related(..., { segment: 'open' })`), and a rollup counts it
(`count('work_order', { segment: 'open' })`). A tab's label and its address
(`?tab=overdue`) are the segment's. A segment may name another, never in a
loop, and a name a column, rollup or state already holds is refused. It only
ever narrows: a reader who may not read a column it names is served no tab,
section or word for it. The App API and MCP list it read-only as
`?segment=overdue`. `check --design` lists each segment with its cost, and
warns where one query is written in several places (`repeated-query`).

## Stock a line uses

```ts
work_order_part: {
  consumes: { column: 'part_id.on_hand', by: 'quantity', refuse: 'Only {part_id.on_hand} of {part_id.name} left' },
},
```

A line that uses stock moves the balance on every write, through every door: a
new line takes `by` (one, without it), a removed line gives it back, an edit
moves the difference, and a line moved to another part gives back to one and
takes from the other. A take past zero refuses the whole write as
`consumes_refused`, with `refuse` filled from the part as it stands and only
with what the reader may read; `floor: false` allows a backorder. Writing the
line is the whole grant: no role needs to write `on_hand`. A stored balance
that must refuse an oversell is `consumes`; a figure that is only read is a
rollup. `check` warns when a command also writes the balance
(`consumes-written`).

## Row-defined fields

```ts
product: { defined: { specs: { from: 'attribute', per: 'category_id' } } },
attribute: { access: 'write', delete: true },
```

A JSON column whose keys are rows people keep: each row of `from` has `key`,
`label` and `type` (`text`, `textarea`, `number`, `money`, `date`,
`datetime`, `bool`, `choice`, `choices`), and may have `options` (one per
line), `required`, `help` and `position`. With `per`, a record gets the rows
whose `per` equals its own and those whose `per` is empty. The fields are
drawn on record pages and forms as the record's own, judged at the server
in the write's transaction (a refusal names `specs.capacity`), read in the
tenant's scope, asked by a list as `specs.capacity`, and offered one facet
each where a view's `filters` names the column. PostgreSQL and SQLite.

## Computed columns

```ts
task: {
  computed: {
    is_overdue: computed.boolean('due_on < today and not completed'),
    days_open: computed.number('today - opened_on'),
    renews_on: computed.date('ends_on + term months'),
  },
},
```

An expression in the query language's words: columns and paths, rollups,
numbers, quoted text, `today`, `now`, `me`, comparisons, `and`, `or`, `not`,
`is empty`, `+ - * /` (a division by zero has no value), date spans, and five
functions: `coalesce(a, b, …)` (the first with a value), `round(x)` or
`round(x, 2)` (a half away from zero), `abs(x)`, and `min(a, b, …)` and
`max(a, b, …)` of numbers or dates, which have no value where one of theirs has
none (`computed.number('max(owed - paid, 0)')`). It is
written into the statement, so it shows, sorts, filters and tones like a
column, and a rollup sums it (`sum('task', 'overrun')`) or a dashboard
window reads a computed date (`over: 'renews_on'`) when it reads only its
row's own columns; it is never written, and `fields.write`, `form.show` and an action's
`set` refuse it. A role is served it only where every column it reads is
readable to that role. A fixed action's `set` takes the same kind of
expression for a stamp (`computed.date('today + 14 days')`); anything heavier
is a [command](/docs/commands/) or a database view.

## Unions

```ts
import { union } from '@mistriwork/mistri/app';

unions: [
  union('my_requests', [
    { from: 'incident', as: { title: 'short_description', opened: 'opened_at' } },
    { from: 'requested_item', as: { title: 'name', opened: 'created_at' } },
  ]),
],
```

One read-only list over tables that share a shape. A list view and `useRows`
name it as they name a table, in one order and one page; each row also says
`from` and `key`, and opens its own record. Each branch is read under the
reader's own grants and row policy, so a branch they cannot read is none of
their rows. A union lists; it has no record page, breakdown or summary.

## Record names and conditions

```ts
purchase_order: { recordLabel: 'PO-{id}' },
po_line: { recordLabel: '{product_id.name} × {qty}' },
```

`recordLabel` is a column, a label path or a template in braces, computed in
SQL so lists, pickers and breadcrumbs sort and search the same name.

Every condition (a list's `query`, a tab, a section's `query`, a `when`, a
validation's `must`) is [the query language](/docs/query/). `me` is the
signed-in person: their email beside a text column, or their row beside a
reference once `auth.me` says where people live. `me.<table>.<column>` is
their memberships: `team_id in (me.team_member.team_id)` is the rows of the
teams they are in, read on each request through their own rows (the one
column of `team_member` that points at people says whose; at most 1,000).
Where nobody is signed in to be it (the database browser, MCP, the App API, a
rollup), `me` is refused rather than read as the word; quote it (`"me"`) to
mean the text. A path walks references
(`product_id.unit_cost > 50`). Another column is compared by naming it on the
right: a path always, a bare word beside a number, date or flag
(`shipped_on > promised_on`); beside text a bare word is a value.

## Validation

```ts
validation: [
  { must: 'close_date >= created_on', message: 'A deal cannot close before it was created.' },
  { must: 'probability = 100', when: 'stage = closed_won', message: 'A won deal is at 100% probability.' },
],
```

A rule is a condition the record must meet on every write, optionally under
`when`, which compares the record's own columns. At most 128 rules per
resource.
