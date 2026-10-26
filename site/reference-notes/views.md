```ts
views: {
  triage: listView('Triage', 'issue', {
    query: 'status = backlog or status = ready',
    show: ['name', 'status', 'priority', 'assignee_id.name'],
    presentation: queue('name', { lines: ['status', 'priority'] }),
    filters: ['priority', 'assignee_id'],
  }),
  pipeline: listView('Pipeline', 'opportunity', { board: { by: 'stage', primary: 'name' } }),
},
```

The key is the view's address: lowercase letters, digits and hyphens. Every
dashboard and signed-in form must be reachable from `nav`, `home` or an embed,
or it is refused as an orphan. A list's `query` holds conditions only; its
order is `sort`, and a tab takes a `sort` of its own. Query strings are typed
where the App's schema is registered ([the limit](/docs/app-dsl/#typed-query-strings)).
`filters` and `totals` may name a rollup or computed column as they name a
column: `filters: ['state', 'spent']` offers a customer's lifetime spend as a
Min and a Max.

| `kind` | Helper | What it is |
| --- | --- | --- |
| `list` | `listView(label, table, opts)` or `listView(table, opts)` | The rows of one resource. [Lists](/docs/lists/) |
| `dashboard` | `dashboard(label, sections, opts)` | Sections about whole tables. [Dashboards](/docs/dashboards/) |
| `landing` | `landing(hero, sections, opts)` | The signed-out front page. [Public pages](/docs/landing-pages/) |
| `form` | `commandForm(label, command, steps, opts)` | One form over one command. [Command forms](/docs/command-forms/) |
| `room` | `room(label, component, { reads, params })` | A whole view drawn by a [custom component](/docs/custom-components/). |

## How a list's rows draw

A view says at most one of `presentation`, `board` and `split`; with none, the
rows are a grid.

| Spelling | Draws |
| --- | --- |
| `checklist(primary, checked, { lines? })` | A card per row with a checkbox. |
| `queue(primary, { lines?, facts?, badge?, openLabel? })` | A keyboard-first selection list; bulk actions apply to the selection. |
| `board: { by, lanes?, order?, swimlanes?, limits?, primary, lines?, sum?, folded? }` | Lanes by one column; cards move by drag, Alt+arrows or ⋯. `limits` are shown, never enforced. A lane's head adds up `sum` (else the card's money) — "Discovery · 3 · $92.8K" — and `folded: ['won', 'lost']` draws closed stages as strips a reader opens. A reference as `primary`, a line or a footer fact says the record it names: `primary: 'sales_order_id'`. |
| `split: { detail?, limit? }` | The list beside the picked record, addressed `/inbox/2`. |
| `calendar(date, primary, { end?, lines?, badge? })` | A month grid; with `end`, a bar across the days. |
| `cards(primary, { value?, badge?, icon?, description?, lines?, facts?, image?, media? })` | A grid of cards; a page's related list takes the same. |
| `customList(component, { show })` | Rows drawn by a custom component. |

## Dashboard sections

| Helper | Says |
| --- | --- |
| `metric(title, table, { measure?, query?, compare?, target?, to? })` | One figure; `compare: 'previous period'` adds a change. |
| `chart(title, table, by, { shape?, measure? })` | `line` (default), `bar`, `donut`, `stacked`. |
| `breakdown(title, table, by, { measure?, limit? })` | Groups as bars, a vocabulary's in its order. |
| `matrix(title, table, 'stage, month close_date', opts)` | Two keys as rows and columns. |
| `rows(title, table, { show, sort?, limit? })` | Matching rows. |
| `board(title, table, by, { lanes?, primary?, lines? })` | Lanes, full width. |
| `note(text, opts)`, `firstRun(title, steps)`, `activity(title, resources)` | Guidance, a welcome until the tables have rows, recent changes. |
| `embed(view, { tab?, limit?, interactive? })` | A list view inside the dashboard. |

Every table section also takes `query`, `over` (the date column the window
narrows), `windows`, `icon`, `title` and `width` (`full`, `two-thirds`,
`half`, `third`; with a dashboard's `areas`, an `area` instead). A measure is `count`, `sum amount`, `avg`, `min`, `max`,
`median` (PostgreSQL) or arithmetic over them (`sum won / sum amount as rate`).
