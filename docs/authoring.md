# Authoring a mistri App

The whole loop, on one page. An App is a directory of config that
curates the UI over a database you already have — diffable, reviewable,
written by hand or by an agent. TypeScript is the recommended authoring path.
The types (`@mistriwork/mistri/app`), JSON Schema (`packages/mistri/schema/app.schema.json`) and startup
validation define the current contract.

Start with the [two-project catalog](../examples/apps/README.md): Tick in five
minutes, then Lintel, a property-operations App with a staff desk, a resident
portal and a public side, for modular authoring at a realistic size.
Every App has a README. Tick's DSL and inline types fit in one `app.ts`;
seeding lives separately under `examples/databases/`.

## Zero to App, sixty seconds

For an agent-oriented brief, executable checkout recipe and completion checklist,
see [Build an App with a coding agent](../site/src/content/docs/docs/build-with-an-agent.md).
The commands below run from a source checkout.

```sh
npm run start -- --config connections.json --scaffold-app ./myapp
npx tsx packages/mistri/src/server/index.ts check --app ./myapp --config connections.json
npm run start -- --config connections.json --app ./myapp
```

The scaffold drafts a working App project from your live schema, in the
TypeScript the samples are written in: `app.ts` with `defineApp`;
`resources.ts` with each record's noun and `display` rules guessed from
column names, types and CHECK vocabularies (`{ format: 'money' }`, `{ tone: { … } }`);
`views.ts` with a `listView` per table — plural labels, icons, reference
columns read by name, keys, versions and long text left out, filters and
status tabs; `dashboard.ts` with an Overview that counts each main table
and breaks the busiest down; a record page per main table under `pages/`,
fields grouped and related lists for what points at it; plus
`mistri-schema.d.ts`, `tsconfig.json` and, outside a mistri
checkout, a `package.json`. Tabs lead with All. A table that only belongs
to another (an order's lines, stock per warehouse) is a related list on its
parent's page, not a menu entry, and a record no column names is called by
its noun and key. From a SQLite file it writes a `mistri.json` naming the
file by a path from the App, so its scripts name no machine's directories;
`--name` names the App. It passes `mistri check` as written. It is a
start to curate, not an answer — rename, regroup, cut.

## Three formats, one truth

| file | what it is |
| --- | --- |
| `app.ts` | the primary authoring path: typed helpers and imported modules, native type stripping, no app build step |
| `app.json` | data-only configuration, no build step or module evaluation |
| `app.mjs` | JavaScript with editor types from one JSDoc line — `/** @type {import('@mistriwork/mistri/app').AppConfig} */` — nothing to resolve at runtime |

A directory holds exactly one of these (the loader refuses more, all
names spoken). Whatever the format, the server sees only data: an
`app.mjs`/`app.ts` is evaluated in a throwaway worker and its default
export crosses back by structured clone — a function smuggled into the
manifest is refused with the reason. TS page modules are imported into the
manifest's `pages`, keyed by id; standalone `pages/<key>.json` files are also
discovered.
Typechecking is a separate author-time check, not a required compilation step.

**An `app.mjs` or `app.ts` is code, and it runs as the server.** The
worker is isolation for a fresh module cache, not a sandbox: a manifest
module has all of Node — the filesystem, the network, child processes —
and hot reload evaluates whatever lands in the directory on every save.
Treat the App directory like the server's own source: commit it, review
it, and keep it writable only by the account that runs mistri (a
world-writable directory is refused at load). The one thing the module is
*not* given is the server's environment, so a manifest cannot read the
variables that hold database passwords. mistri.json passes the names an
App's entry lists (`"apps": [{ "dir": "apps/ops", "env": ["REGION"] }]`),
recorded in authority.lock; a name that reads like a credential needs
`{ "name": …, "secret": true }`, and reading an unlisted one throws rather
than returning undefined (`mistri docs secrets`). `--app-entry <file>`
names a manifest other than the directory's own `app.ts`, and the directory
stays the App's root for components, `pages/`, `features/` and the lock.

## Resources, views, home and nav

An App says what it knows about each table once, in its resource block, and
keys everything a visitor can open in `views`. `home` says where a visitor
starts, and `nav`, which is optional, arranges references to views:

```ts
import { navGroup } from '@mistriwork/mistri/app';
import type { App } from './mistri-schema.d.ts';

export const navigation = [
  navGroup('directory', 'Directory', [
    'contacts',
    navGroup('organization', 'Organization', ['sales-team']),
  ]),
] satisfies NonNullable<App['nav']>;
```

A nav entry is a view id, `{ to, label }` for a menu-only word, a checked
`{ label, to }` destination, or a group.
`navGroup(id, label, children, { icon, placement, inline })` returns
`{ id, label, children }` with those options; plain objects are equally
supported. `placement: 'footer'` holds a top-level group at the foot of the
sidebar; `inline: true` draws a top-level group's items straight in the top
bar as links (a portal's few rooms), and keeps it a section in the folded
menu. Group ids are stable, unique across the App and
independent of labels; groups need children and nest up to eight deep. Nav
never defines a view: `defineApp` checks every id against the App's own
`views` in the editor, and the parser refuses an id the App does not declare.
An App without `nav` draws no menu and opens on its `home`.

Desktop menus use nested submenus, compact menus drill into one level at a time
with Back, and side navigation retains the hierarchy. Command-palette search
includes ancestor labels. This fragment is a sketch; Lintel's
`navigation.ts` arranges the views its `views.ts` declares. The
[App DSL reference](../site/src/content/docs/docs/app-dsl.md) gives every key.

### Checked destinations and App menus

Use `{ label: 'Lender queue', to: { app: 'lender', kind: 'view', view: 'review' } }`
in `nav` to link to another App's declared view. Targets may name `home`, a
`view`, or a `record` with its declared resource and complete primary key.
Navigation has no source row, so its targets must use literal values rather
than `{ from: ... }` bindings. These links do not declare local views.

An App opts into an App picker or grouped navbar through `ui.appSwitcher`:

```ts
ui: {
  appSwitcher: {
    placement: 'navbar',
    label: 'Workspaces',
    groups: [
      { label: 'Finance', links: [
        { label: 'Lender queue', to: { app: 'lender', kind: 'view', view: 'review' } },
        { label: 'Dealer workspace', to: { app: 'dealer', kind: 'home' } },
      ] },
    ],
  },
}
```

Use `apps: ['lender', 'dealer']` instead of `groups` for a compact picker,
or explicitly opt into `apps: 'authorized'` to list the account's available
Apps. `placement: 'account'` puts the entries in the account menu. Omitting
`appSwitcher` creates no App picker. Labels and grouped destinations come
only from this configuration; unavailable links and empty groups are hidden.

Suites validate targets before listening and recheck target access when
resolving links. Standalone Apps can resolve ordinary same-App targets;
foreign targets and targets requiring a tenant lookup remain unavailable.
Links use normal document navigation, including opening a new tab. Switching
does not change the account's saved default App; set that separately in
Preferences or the suite chooser.

## Bind the database in the DSL

Use `connection` to bind the App to a server-configured connection by name or ID:

```ts title="app.ts"
import { defineApp, listView } from '@mistriwork/mistri/app';

export default defineApp({
  id: 'lintel',
  name: 'Lintel',
  connection: 'lintel',
  resources: { unit: {} },
  views: { units: listView('Rent roll', 'unit') },
  home: 'units',
});
```

Here `lintel` must match the connection's configured name or ID; it is not
a connection URL. Configure the adapter, database address and credentials on the
server. Keep secret values out of the exported app definition. Omitting
`connection` retains the existing unscoped behavior; it does not combine databases.

An App does not offer the connection manager, database picker or connection
switching through the command palette, and has no Workbench. Connection setup
belongs to the standalone database explorer and server configuration, not an App's
end-user experience. App-configured servers also deny `/api/connections` and its
management subpaths. Startup uses `/api/runtime` with only bound source IDs,
names and capabilities, not database administration metadata. Requests to unbound
sources are refused. These restrictions do not replace row/field authorization.
For multiple databases, use named `sources`, at most one of them `default: true`, as in
[Ignition](../test/fixtures/apps/ignition/app.ts). Each operation stays on one connection;
a single `connection` binding does not combine databases. Several sources may
share one PostgreSQL connection, each scoped to a `schema`: they execute as one
database (joins across their real keys, one transaction), and each sees only its
own schema's tables. Attribution keeps the connection and the physical table,
which is schema-qualified, so a journal entry names exactly one resource.

## Logical resource names

App routes and queries use logical resource names. A unique database table name
is inferred automatically: PostgreSQL `public.opportunity` becomes `opportunity`.
The server maps structured queries and writes to the original physical table;
it does not alter row values or depend on PostgreSQL's search path.

Give a resource block `physical` for a custom name, or for tables with the
same name in different schemas:

```ts title="app.ts"
import { defineApp, listView } from '@mistriwork/mistri/app';

export default defineApp({
  id: 'lintel',
  name: 'Lintel',
  connection: 'lintel',
  resources: {
    opportunity: { physical: 'public.opportunity' },
    archived_opportunity: { physical: 'archive.opportunity' },
  },
  views: {
    opportunities: listView('Opportunities', 'opportunity'),
    archive: listView('Archive', 'archived_opportunity'),
  },
  home: 'opportunities',
  nav: ['opportunities', 'archive'],
});
```

Use these logical names throughout views, pages, actions and grants. Each
physical table has one logical name; remaining unique tables are inferred
bare, and a name two schemas share is inferred as `<schema>_<name>` for every
copy (`sales_partner`, `settings_partner`) until one is bound explicitly. Every table a view
shows is a declared resource; a block is not by itself an authorization
policy. Physical bindings are not included in the App payload. The standalone DB browser and database
schema export retain physical identifiers. App type exports use logical names
when an App is supplied, as shown below.

App read/write responses retain data, typed presentation metadata, pagination,
timings and mutation outcomes, but omit generated SQL, bound parameters, explain
text and compiled join plans. An App has no Workbench: raw SQL, saved SQL, DDL,
the layout and page builders and agent diagnostic tools belong to the standalone
DB browser, and an App serves only its declared resources, signed in or not. Database failures
use stable public error codes and safe messages on App servers. Standalone
database tools retain the original diagnostic errors. An unconfirmed write
instructs the user to reload and check, not blindly retry.

## The editor knows your schema

```sh
npx @mistriwork/mistri --config connections.json --app ./myapp --export types > myapp/mistri-schema.d.ts
```

```ts
import type { App } from './mistri-schema.d.ts';
export default defineApp({ … } satisfies App);
```

A mistyped table or display key now squiggles before the server ever
refuses it — with TypeScript's own `Did you mean 'work_order'?`
carrying the fix. (`--scaffold-app` writes this file for you, and
`mistri check` rewrites it when the database has changed.)
The same file names the server's configured connections (`Connections`), so a
mistyped `connection` or `sources.*.connection` squiggles too, and `defineApp`
refuses a `ui.theme.preset` that is neither built in nor one of the App's
`ui.customThemes`.
The export follows the App's bound connection and its resources' logical names. With no
app supplied or configured, `--export types` remains a physical database export,
including qualified names on PostgreSQL. Multiple loaded apps are refused rather
than choosing one: use a one-app config, or a connection-only config with `--app`.
The scaffolder infers unique logical names; when tables share a bare name, author
explicit `physical` bindings first and export types from that app.
Label paths are names too: the file's `References` says where each
reference lands, so a `show`, a card's lines, a label or a related list's
`whose` is checked hop by hop — `owner_id.nmae` squiggles with `Did you mean
'owner_id.name'?` — exactly for two hops, with a longer path's tail left to
the catalog. A sort's first key is checked the same way (`sort: 'orderd_on
desc'` squiggles). Other grammar strings — queries, measures, `when` — stay
strings: the grammar is the server's to judge, at startup, with the fix named,
and `mistri check` places each finding on the file and line its words were
typed on. `mistri check` warns about a literal a column can never hold (`status
= resolvd` beside a CHECK vocabulary, `on_hand = none` beside a number).

## The loop

1. **Edit** — full typing in any editor; the DSL helpers (`metric`,
   `chart`, `matrix`, `rows`, `breakdown`, `note`, `board`, `dashboard`,
   `embed`, `listView`, `checklist`, `queue`, `calendar`, `cards`,
   `navGroup`, `page`, `summary`, `related`, `card`, `headline`, `stream`,
   `action`, `machine`, `money`, `number`, `percent`, `relative`,
   `items`, `tones`) are pure
   data constructors whose value is per-kind checking: each carries its
   kind in its type, and a view, a list presentation, a section, a page or
   an action is written with its helper only — a hand-written object in
   their place is a type error. An App is a real module graph —
   screens in their own files, the manifest a table of contents — and
   hot reload sees edits to imported files too.
2. **Save** — the server hot-reloads the App directory. A broken save
   keeps the last good load serving, with the reason on a banner. A save
   that changes what the App grants or who may sign in to it closes the
   App's requests (503) until the server restarts, serving neither the old
   authority nor the new.
3. **Look** — every remaining problem wears a quiet `issues N` pill in
   the shell; click for the list, each line naming its file and its fix.
4. **Check** — `mistri check --app ./myapp <db>` regenerates the
   schema types, typechecks and runs the same list, one verdict per step,
   and exits non-zero naming the first step that failed. In CI, follow it
   with a diff of the working tree to catch types that drifted from the
   database; `mistri check --app ./myapp` is its validation step
   alone. A running server does not rewrite the types: a write into the
   watched App directory would reload the App, and the file may be kept by
   hand on purpose — `mistri check` is where it happens.

## Bridges from the running UI

- A filter tab's **Copy app entry** copies the list you refined — its
  table, shown columns and filter as a tab — as JSON, the start of a list
  view in `views`.
- The breakdown view's **Copy as app section** emits the line you
  composed in the query bar as a ready dashboard section — the kind
  read off the shape (two keys cross a matrix, a bucketed key draws a
  chart), the conditions surviving exactly as typed.
- `mistri observe --mcp` gives agents the same loop: its `check` tool,
  and the shipped reference as resources. `--scaffold-app` drafts the
  first directory.

## What the config can say

The quick index. The [App DSL reference](../site/src/content/docs/docs/app-dsl.md)
gives every key.

- **Resources**: one block per table the App uses, keyed by logical name —
  `physical`, `access` (`'read'` or `'write'`), `delete`, `favorite`, `file`,
  `tags`, `search`, `machine`, `fields`, `display`, `validation`, `text`,
  `labels`, `recordLabel` (a path, or a template like `'PO-{id}'` computed in
  the statement), `form`, `actions` and `page` (and `owner` in a tenant App). `actions` puts the
  App's own verbs on a record — `action('Mark working', { set: { status:
  'working' }, when: 'status = new' })` — each an update through the same gate
  and journal as an edit, or a business `command`; `form` curates the New form
  (`show` the columns to ask for, `defaults` the values filled in first).
  In App mode, updates submit directly and deletion still requires confirmation;
  SQL previews belong to Workbench. Action `confirm` does not add an App-mode
  update modal. `when` controls visibility, not authorization or an atomic
  workflow precondition. Keep actual write permission in the server-side scope.
  Business commands use the separate reference contract below.
- **Text rules**: `text: { code: { pattern: '^[A-Z]{3}$', message: 'Three
  capital letters.' }, name: { min: 2, max: 80 } }` on a resource — characters
  (code points, `min` after trimming) and a pattern the whole value matches.
  The New form and an edit say the rule under the field as it is typed (the
  author's `message`, or a generic sentence), and the server holds the stored
  row to it on every write, whichever door the write came through
  (`appValidation.ts`, beside `validation`). On PostgreSQL the catalog says
  the same without it: a `varchar(n)` is `max`, and a CHECK in one of two
  simple shapes — `char_length(col) >= n` and `col ~ '...'` — is `min` or
  `pattern`; anything more in a CHECK is no rule, since a partial reading would
  be presented as the whole. What the App writes wins, key by key.
- **Tags**: `tags: { through, to, tone? }` puts a record's labels on its page,
  and then reads like a column: `tags` in a list's `show` (chips, the first
  three and "+N"), `tags` in `filters` (each tag a choice, any of them), and
  `tags has bug` / `tags has (bug, docs)` in the query language, an EXISTS over
  the link rows. They are never a column of the table: the catalog carries them
  (`TableMeta.tags`) for a reader who reads both the link and the tag table, so
  grants and row access narrow them as they narrow a related list. The New form
  offers a tags field where the reader may add link rows, and the server writes
  the record and its link rows in one transaction (not yet in a tenant App).
- **Conditions**: a view's `query`, a tab, a dashboard section's `query`, a
  page's and a fixed action's `when`, and a command's own `when`, are the query language. They may say `me`,
  the signed-in person, resolved on the server from the verified session: the
  account's email beside a text column (`filed_by = me`), and — with `auth.me:
  { from: 'employee', column: 'email' }` — their row beside a reference to it
  (`owner_id = me`); a command's `when` reads that row where the command reads
  the people table (`read: ['employee']`), and is the actor in a selection's
  prepare, availability and the run alike. `auth.me.create: { name: 'full_name' }` has the server
  make a new account's row on its first signed-in request — after sign-up, an
  accepted invitation or a first single sign-on — once, found again by the
  email column, which `mistri check` requires unique; every other column
  the row needs must have a default. Not yet in a tenant App. A list, a tab and a dashboard section may walk a reference
  path (`product_id.unit_cost > 50`) and compare with another column
  (`on_hand < product_id.reorder_level`, `shipped_on > promised_on`); a bare
  word beside text stays its value. A command's `when` and a fixed action's
  `when` compare two of the record's values too (`qty < reorder_at`,
  `paid < owed` where `owed` is a rollup), judged in the write's transaction
  once the row is read. A form's `when` and a validation's
  `when` compare the record's own columns with values.
- **Views**: keyed, of kind `list`, `dashboard`, `form` or `landing`. A list
  view is the rows of one resource: `show`, `tabs`, quick `filters`, a standing
  `query` (so "Urgent orders" is its own view), and
  `open: 'page' | 'drawer' | 'modal'` for how rows present, and `order`, a
  numeric column holding each row's place: the list reads in it, and an editor
  drags a row into place (a finger holds it first), presses Alt+↑/↓ or picks a
  place from the row's grip — the board's own is `presentation.order`, and a
  sort in the standing `query` is refused beside it. Its `presentation`
  chooses `checklist`, `calendar` (a month by one date column), `cards` (a
  grid of cards), `split` (a bounded list beside the selected record; `row: { primary, lines, properties, badge,
  avatar }` says how each row reads, and the view's `shortcuts: { m: 'markReady' }` binds single keys
  to the picked record's actions, shown beside each verb and quiet while an input has focus),
  `queue` (a keyboard-first selection; the resource's
  fixed actions marked `bulk: true` apply to exactly the selected records, one
  ordinary write each, results per record, never one transaction over the
  selection) or `board` (lanes by one local column; a card moves only through
  a resource action whose `set` is exactly that column — or, where the column
  references another table, by an ordinary update of the reference, its lanes
  that table's rows after one for none; `swimlanes` adds a row per value of
  another column, `limits` a lane's work-in-progress number, shown and never
  enforced, `sum` a numeric column added up in each lane's head (absent, the
  first money column the card shows; money is said short, $240K, whole in its
  title), `folded` the lanes drawn as a narrow strip until opened — a closed
  stage, won or lost; a card's primary and line are edited in place with F2). A command is offered
  in bulk only when its reference declares `targets: 'many'`. See the site
  guide "Queues, boards and bulk actions".
- **Dashboards**: `metric` (with `compare` deltas — the phrase
  `"previous period"` derives the shifted window, `better: "up" | "down"`
  says which way is good news so the delta wears it, and is only a warning
  without a `compare` — and `spark` trends),
  `chart` (line/donut), `breakdown`, `matrix`, `rows`, `board`, `note`, and
  `embed(view)` to draw a list view; a dashboard-level
  `table` is every section's default, and is refused when no section
  inherits it; a board always takes the whole width, so it takes no `width`;
  `over` +
  `windows` for the reader's time window (which rides the URL),
  `filters` for pick-filters, `refresh` for the wall-board clock.
- **Display**: `money`/`percent`/`number`/`relative`/`items`/`duration`/`email`/`phone`/`url` formats
  (`relative` says a date from today — "in 3 days", "64 days ago" — with the
  date in the tooltip; `items` lays a text of one item per line out as a
  list; `duration` says a number of seconds as its two largest units, "2h 15m",
  a preview; `email`, `phone` and `url` link a value of that shape, and an App
  links a column named like one without a rule; `richText` is formatted text —
  see below), a `unit` after a number or money figure ("85,780 mi", "$237/mo"),
  tones by value — a dot and the word in every look —
  or numeric threshold (`">= 5": "bad"`, severe first) with `"*"` for
  every other value (`neutral` is the tone that says nothing in
  particular, plain text in a look, so a vocabulary is all tones or none), applied everywhere a
  value shows — including through dotted label paths.
- **Pages**: keyed by id. Fields, related metrics/lists/breakdowns (a metric
  says the dashboard's `measure` — "count", "sum amount" — a section narrows with
  `query`, and `when` shows a section only while the record
  matches — "Converted to" on a converted lead), and `timeline`
  (dated child streams merged newest-first; a stream's `author` says who wrote
  each row, and `create` puts a composer above the newest row, bound to the
  record like a related list's create). A timeline that is a conversation says
  `newest: 'last'` (oldest first, scrolled to the end, in a box whose height is its own so
  nothing moves as rows arrive), `composer: { reply, note }` (a pinned Reply / Internal note
  toggle that runs those two commands on this record, shown only for a command the role grants),
  `tone: { <column>: { <value>: tone } }` (a row's tone from its own column, a tinted
  ground, never a side stripe) and `compact: { <column>: [values] }` (one quiet line for system
  rows). `header({ actions: [...] })` names the verbs the record's head draws, the rest of the
  record's actions waiting in More; it is the third list beside the header's `primary` and
  `destructive`. `fields(..., { editable: true })` on a summary or properties group edits a
  property in place through the resource's action that sets it (a picker of that action's
  reachable values); the server's rule is unchanged, and a reader who cannot write sees it read-only.
  A page `note` is `variant: 'quiet'` (a line of text) or `'callout'` (the default box). Sections stand as written, each
  at its own `width`; `listTabs: true` draws each run of adjacent lists
  (none with a `width`) as one tab strip, whose open tab
  rides the URL by name and whose unopened tabs are never fetched.
  A related list's `empty` is guidance, `'hide'` (left out while it has no rows) or `'collapse'` (one line for the
  empty lists side by side, each with its Add); `page(…, { empty })` is the default for lists that say nothing. A list
  that offers an Add collapses rather than hides, a tab keeps at least one list, and inside a `listTabs` strip an empty
  list is a tab. `empty: false` is now `empty: 'hide'`.
  A related list's `group: { by, show?, sort?, limit?, empty?, sum? }` reads the rows under a header for each record they share through
  `by` (one level; a plain column groups by its value): the groups are one breakdown of the same rows, each group's rows
  one read of the keys that come back, and `show` is read off the rows (`by.column`), so a header costs no read. `limit`
  is then the rows to a group (default 5, up to 50 on "Show all") and `group.limit` the groups to a page (default 5, up
  to 10). Tables only: refused beside a presentation, `same` or a `current()` card, and `by` may not end at the
  page's own record. It composes with `empty` (no groups is no rows), `totals` (a subtotal under each group, the
  whole list's under all of them) and `rowActions` (the ⋯ on each group's rows). The rows with no value are one group,
  headed "No <the column>" or `group.empty`, and always drawn last whatever the sort (the breakdown orders them last, so
  every page of groups agrees). `group.sum` (one or two numeric columns, rollups or computed numbers) is summed over each
  whole group and said in its header after the count; unlike `totals` it works beside a `query`.
  A record page's `chart` of bars or a donut draws its categories in the order they have of their own: a date, a number
  that is a step, a column with allowed values (in that order), or the rows' own label (a bar for each sprint, in the
  order the sprints were made); any other category goes largest first. `sort: 'value' | 'category' | 'starts_on [desc]'`
  says it outright, the last ordering the categories by that column of the rows.
  Fields show reference labels by default in App mode; a mistri.json page's
  `names: false` keeps raw ids and survives layout save/export. Workbench keeps
  raw ids regardless of that option. Composite references and targets without a
  usable label retain their keys rather than failing the field query.
  Related page lists also display reference labels in App mode, fetched as
  hidden joined columns; their raw keys and visible projection remain intact.
  Tables without a list view get schema-ordered list defaults with
  named non-key references and complete row keys. Explicit `show` clauses still
  win. Dotted fields use their resolved source metadata in grids and summaries.
  Explicit field `columns` describe the desktop arrangement; at phone widths
  fields stack into one column so values and editors remain readable.
- **Home and nav**: `home` is required — a view id, or rules that end with
  one for everyone. `nav` is optional and only arranges view references.
- **Menu icons and the rail**: a list, dashboard or signed-in form view, and
  a nav group (`navGroup(id, label, children, { icon })`), may name an
  `icon`: one of Phosphor's icons by its own name, from the curated App set
  (`house`, `tray`, `kanban`, `calendar`, `users`, `package`, `receipt`,
  `gear` and more; `packages/engine/src/shared/appIcons.ts` has them all). An unknown name
  is refused with the nearest ones. Icons are drawn before the entry's words
  in the side and top menus; an App that names none looks as before.
  `ui.shell.rail: true`, with the side placement, makes folding the menu
  (its « button or ⌘B) leave a narrow rail of those icons instead of hiding
  it — an entry without one shows its initial, and every entry keeps its
  name for screen readers and says it on hover.
- **UI**: `ui.shell.placement: 'side' | 'top'` and the other shell settings,
  including `ui.shell.sidebar` for compact or comfortable side-menu spacing
  and a static workspace footer (`{ title, description? }`),
  `ui.logo` for a decorative curated App icon beside the App name, or the App's
  own picture (`{ src, dark?, mark? }`, files in its directory served from
  its own origin; server/app/appBrand.ts) (an App has
  no Workbench: the standalone browser is the tool for uncurated tables),
  the theme whitelist (`accent` — one colour or `{ light, dark }` — `radius`, `font`, optional
  `preset`), registered `customThemes` through
  [the typed theme contract](theming.md), `export: false`; `locale` for how
  numbers and money are written, `currency` as the default for money
  rules that name none, and `timezone` for whose "today" the date
  phrases mean (a server in a UTC container serving Sydney otherwise
  says "today" about yesterday).
  Side-menu apps use compact top navigation at 900px and below, without changing
  the desktop sidebar preference or remounting the current record editor.
- **Sign-in**: `auth` makes the App sign people in, through
  [Better Auth](https://better-auth.com) — `providers` (`email`, `github`,
  `google`), `signUp: "invite"` (default; an admin creates accounts) or
  `"open"`, and `roles`, each granting reads, writes, commands, operations
  and columns within the resources' ceilings. Sessions live in a store of
  mistri's own — a SQLite file, or a `postgres://` URL in `auth.store` —
  never the App's database. Secrets come from
  the environment: `BETTER_AUTH_SECRET` (required), `GITHUB_CLIENT_ID` /
  `_SECRET` and the like per provider, `MISTRI_AUTH_ADMIN_EMAIL` /
  `_PASSWORD` for the first admin, `MISTRI_PUBLIC_URL` for the address
  cookies and OAuth callbacks are minted for. A forgotten password is reset
  by a one-time link (an hour, once, ending the account's other sessions),
  emailed through the config's email service (`"kind": "email"`), or, with
  `MISTRI_AUTH_RESET=log`, written to the server's log for an operator to
  pass on — never into an HTTP answer; set that only where the log is
  private. With neither, sign-in's "Forgot password?" says an administrator
  resets passwords. `better-auth` is an optional
  dependency — `npm install better-auth` — paid for only by apps that ask.
  Authenticated Apps require a stable nonzero listening port. If that port is
  occupied, startup refuses instead of trying another port; choose a free
  `--port <n>` so session origins and OAuth callbacks remain consistent.
  Every request to the server then needs a session; app listeners deny
  connection management even to admins; and every journaled write says who
  made it. `auth.rows` scopes rows: `'policy'` for a row policy, `'tenant'`
  for a tenant App.
- **Scope**: `connection` binds an App to one database, or `sources` to
  several; several apps can ride one server through their source-scoped URLs,
  without a connection manager. A resource's `access` is the App's ceiling:
  once any resource declares one, the undeclared ones are not written, and the
  server enforces it for every route and tool, so New and Delete appear only
  where a write would land. The connection's own `"writable": true` opt-in
  still applies, checked in every route and tool that writes.

## Rich text and attachments

A column becomes formatted text with a display rule, and a command input with a
field helper:

```ts
issue: { display: { description: { format: 'richText', images: 'attachment', mentions: { from: 'member', by: 'id', labelColumn: 'name' } } } }
reply: field.richText({ max: 20_000, mentions: { from: 'agent', by: 'handle' } })
```

- **Stored as sanitized HTML.** The server cleans every write — a generic
  insert or update (`authorizeTransaction`), a command's input
  (`readCommandInput`), a tenant's write on its lease — with `sanitize-html`
  over one allowlist (`packages/engine/src/shared/richText.ts`): `p`, `br`, `strong`, `em`,
  `s`, `u`, `a[href]` (`http`, `https`, `mailto`; `rel="noopener noreferrer"`
  added), `h2`–`h4`, lists and checklists, `blockquote`, `code`, `pre`, simple
  tables, a mention's `span`, and `img` only at one of the App's own attachment
  addresses (`/api/file?table=…&key=…&inline=1`, in one of its file
  resources). No `style`, no `class` but a code block's language, no
  handlers. `sanitize-html` (htmlparser2, no DOM) was chosen over DOMPurify,
  which needs jsdom on the server, and over hand parsing; `marked` reads
  Markdown. Both load the first time a rich text value is written.
- **Input.** HTML, or Markdown — a string that does not start with a tag is
  Markdown — or `{ format: 'markdown' | 'html', text }`. The API's schema says
  so, so an agent may write `**done**` and `- [ ] call back`.
- **The plain twin is derived, never stored.** `richTextPlain` (one line per
  block, a dash or a box before an item) and `richTextExcerpt` (one line, 160
  characters) are computed where text is wanted — a list cell, a card, the
  timeline's compact row. Searching a rich text column searches its HTML,
  which holds every word.
- **Drawn without trusting it.** The client parses the value into an inert
  document (`DOMParser`) and walks it into React elements through the same
  allowlist (`components/RichText.tsx`), so a value written behind the App's
  back by SQL or another program is held to the list too; nothing is set as
  inner HTML. A link opens in a new tab with no opener.
- **The editor** (`components/RichTextEditor.tsx`, Tiptap) is a chunk of its
  own, fetched the first time a rich text field is edited; no first page
  carries it. A form, a record's field, a New form and a timeline composer
  whose command input is rich text draw it. Pictures are kept as rows of the
  `images` file resource that point at the record, so a New form (no record
  yet) takes none; a public command form takes neither pictures nor mentions.
- **Mentions.** `mentions: { from, by, label? }` is whom an @ offers: the
  people resource, the column stored as the handle, the column shown. With
  `groups: { from, by, label?, through? }` an @ names a team as well; `through`
  is the resource of link rows that puts a person in a team (absent, the
  people resource's own reference to the team). A mention is stored as a
  `span` carrying its handle, so the column's own HTML says whom it names. A
  resource's `notify: [{ mentions: { in: 'description' } }]` tells them: over a
  rich text column the handle is the display rule's `by` (a `by` given on the
  rule must agree), over a plain text column it is `@handle` words matched by
  `by`. A team mentioned is told as its members. On an update only whom the
  write newly mentions is told, so editing a typo does not tell everyone
  again; a mention tells only someone who may read the record, and at most
  twenty a write (`packages/mistri/src/shared/appNotify.ts`).
- **Attachments on a tenant App.** A tenant App's file resource reads and
  uploads on the tenant's lease (`/api/file/read`, `/api/file/upload`): the
  row is written as any of the tenant's writes, so its grants, row scope and
  tenant column hold, and a file of another tenant reads as not found. The
  bytes travel as base64 in JSON and are drawn from a blob address; an upload
  is at most 10 MB (the resource's `maxBytes` when smaller), and a picture is
  typed by its own bytes only when it is asked for in place — anything else is
  a download. Cards and avatar photos from files are not drawn on a lease.

## Existing-record save policy

An App may opt existing writable record fields into blur-triggered saving:

```ts
ui: { editing: { save: 'blur' } },
```

Omit `ui.editing`, or use `{ save: 'explicit' }`, to keep Save/Enter submission.
The setting belongs to the App, not a view or a New form, and applies
to full keyed record pages, including cold custom-page links. Workbench remains
explicit. The current detail modal is a read-only preview; **Details** opens the
full editor. New/Add, checklist toggles, Delete and business actions retain their
own explicit interactions.

Only a fresh user change followed by leaving the complete field interaction
surface can autosave. Moving through a portalled picker is not leaving the field;
search text is not a selected reference. Each save validates the whole staged
snapshot and submits it with its expected originals as one update. Separate blur
gestures are separate transactions: keep explicit Save or a business command
when several edits must be reviewed and committed together.

Save and Discard remain available. Escape/Discard and navigation before dispatch
cancel deferred saving, not an already sent write. Pending autosaves block
voluntary navigation until an outcome arrives. Retained drafts and rejected
saves require explicit review/Save; uncertainty locks the record and is never an
automatic retry. Local validation errors can be corrected and saved on a fresh
blur. Autosave does not add durable CRUD receipts or server lifecycle hooks.

## The examples

The [sample catalog](../examples/apps/README.md) describes two projects: Tick
and Lintel, which has a row-policy resident portal, a public side and its own
test suite. Each App has a README; database setup lives under
[`examples/databases/`](../examples/databases/README.md). The Apps that were
samples until 0.9.2 (the CRM, Thread, Keystone, Forecourt, Payday, Depot,
Commons, Atelier and Loaner Desk) and Ignition remain under
`test/fixtures/apps/` for regression coverage; they do not ship.

## Practical authoring habits

- Start with the smallest useful sample. Read its README, manifest, imports and
  schema types before changing it; keep Tick's DSL in one file and split larger
  apps by resources, views, navigation and pages.
- Use `satisfies App` with inline or generated schema types. Consult the current
  `@mistriwork/mistri/app` helper signatures; query strings still need catalog validation.
- Seed only unused disposable targets and make seed scripts refuse overwrite.
  Never reseed a running preview. Keep database assets separate from App modules,
  and mutable databases/private configuration outside watched App directories.
- Keep the manifest serializable and credentials in server configuration.
  JSON runtime config, data-only JSON Apps and JavaScript Apps remain supported;
  the public examples teach TypeScript authoring.
- Enforce permissions on the server. `show`, query tabs, workflow strips and
  action `when` conditions only curate the UI. Fixed `set` actions use generic
  update permissions; business invariants need command-time actor/state checks.
  No sample's labels or queue filters implement tenant membership or isolation.

- Say only what differs from the conventions. The platform infers money,
  percentages, units, due dates, flags, vocabulary tones, a machine's tones, a
  record's label column, captions without `_at`/`_on`, state stamps and form
  starts from the schema DEFAULT (`packages/engine/src/shared/displayDefaults.ts`). `check`
  warns `restated` on a rule that repeats one, `check --defaults` prints them,
  and `check --design --fix` deletes the restated rules from the source.
- A handler writes `now`, `today` and `me` as an action's `set` does, by the
  column's kind (`packages/mistri/src/shared/appStamps.ts`); a form default may come from a
  chosen record (`{ from: 'service_id.price' }`), refilled by the server when a
  create leaves it out. The column may be a computed one of that record
  (`service_id.list`, `list = price * 2`), and a validation may name the
  record's own computed columns or a referenced record's (`total > 0`,
  `service_id.list >= labor_charge`): each is worked out of the stored row as
  a list works it out. One that reads a rollup, another record or `me` is
  refused with why, since the stored row does not hold it.

## The rules that keep it honest

The app layer composes the core and never grows into it. The manifest
stays machine-editable data. Errors name the fix at startup. And
`docs/design.md` governs how anything looks or moves.

## Record Blocks

Start concise; expand only the options you need. Typed helpers construct ordinary
data, not runtime callbacks or a second configuration language:

```ts
import { page, summary, related } from '@mistriwork/mistri/app';

page('opportunity', [
  fields(['name', 'stage', 'amount', 'owner_id']),
  related('Tasks', 'task', 'opportunity_id', {
    show: ['subject', 'status', 'due_on', 'owner_id.name'],
    create: { label: 'Add task', show: ['subject', 'owner_id', 'due_on', 'created_on'] }
  })
]);
```

These fragments use a sales schema (opportunities and their tasks). Use `create: 'Add task'` for the
schema-derived form, or `{ label, show }` to
choose its fields. `columns`, `width`, `when`, reference names and the
existing section options remain available. JSON supports the same short forms;
both formats normalize to one validated page contract.

### Table sizing

Lists default to `sizing: 'fit'`: long text shares the available table width,
leaving readable room for concise values. Fit is container-relative, including
half-width dashboard `rows`. It does not hide columns; when readable minimum
widths exceed the container, the table still scrolls horizontally.

Choose `sizing: 'scroll'` to retain content-based column widths instead:

```ts
rows('Products', 'product', {
  show: ['sku', 'name', 'family', 'list_price'],
  sizing: 'scroll',
})
```

The same option is available on list views, and on a mistri.json page's lists. This changes presentation only, not the query projection.
Full clipped text remains available on hover and by opening record details.

### Record side panel

Give a section `region: 'aside'` to place it in an optional record context panel:

```ts
import { page, summary, related, fields } from '@mistriwork/mistri/app';

page('opportunity', [
  fields(['name', 'stage', 'amount']),
  related('Tasks', 'task', 'opportunity_id', {
    show: ['subject', 'status', 'due_on', 'owner_id.name']
  }),
  fields(['account_id', 'owner_id'], { title: 'Account and owner', columns: 1, region: 'aside' }),
]);
```

The region does not introduce a nested page, separate data source or new
permission boundary. Section objects take `region: 'main' | 'aside'`
directly, including JSON definitions. Without
an aside section, existing page layout is unchanged. All existing section kinds
are supported; choose short fields and focused related lists for a narrow panel.

On wide viewports the context occupies a 280-320px right-hand column. At 1100px
and below it follows the main content in normal document flow, with no separate
vertical scrolling container. Existing section queries, conditional visibility,
editing, permissions and lazy related-list tabs are reused. The Layout editor's
section placement control can move a section between regions. Appearance follows
the selected look (Lumen unless the App or the reader picks another).

This composition does not itself provide tagging, account assignment commands
or a print workspace. Those need their own feature contracts. Files have one:
a resource declares `file: { content, name, type?, size? }`, and a related list
over it draws as attachments (see Pages and forms).

Fields can opt into compact summary presentation. Over a resource with a
`machine`, the summary also draws the record's road — each state's first
verb, from the first state — as a stepper, with earlier steps passed and the
current one marked; the words are the column's `display.values`. The stepper
is derived from the graph and never authored, and the machine, not the
stepper, is what the server enforces.

A related list can offer contextual creation:

```ts
related('Tasks', 'task', 'opportunity_id', {
  show: ['subject', 'status', 'due_on', 'owner_id.name'],
  create: { label: 'Add task', show: ['subject', 'owner_id', 'due_on', 'created_on'] },
});
```

`whose` must be one foreign key to the complete parent primary key, including
composite keys. Its child columns are filled from that key and hidden from the
form. No parent is inferred from arbitrary query conditions. The first version
refuses filtered lists, multi-hop paths and forms hiding required fields
without database defaults. Creation is App-only and honors server write scope.
Success remains on the parent, refreshes related sections and preserves pending
parent edits. The binding is UI context, not row-level authorization.

These options are available in JSON/typed page definitions and preserved by the
shared page exporter. Dedicated visual-editor controls are a follow-up. See
Lintel's [`pages/`](../examples/apps/lintel/pages/) for connected examples.

A related list can match rows on the record's own values instead of a reference:

```ts
related('Similar vehicles', 'vehicle', { same: ['body_type'], near: { price: 0.25 } }, {
  query: 'status != sold', limit: 4,
});
```

Every `same` column (one to four) must be a column of both `from` and the page's
base, and equal the record's value. Each `near` number column (one or two) must fall within ± its
fraction of the record's value, a fraction above 0 and at most 1. Rows come
back closest first on the first `near` column, then in `sort` order, then by
key. Over the page's own table the record itself is left out. `whose` and `create` are
refused beside `same` (its rows are not the record's children, so there is nothing to add them
under), while `empty` is kept: a match that finds nothing, or a record with no value to match
on, says so in the author's words. A document's lines take the same match; with `same` alone it lists siblings
(`related('Other deals on this account', 'opportunity', { same: ['account_id'] })`). The server reads the record's
values from its own row, never from the request. The list runs as an ordinary
read under the reader's grants, row policy, public ceiling and tenant scope. An
empty `same` value or a non-numeric `near` value shows nothing. See
[Lintel's home page](../examples/apps/lintel/pages/unit.ts), whose "More homes here" list matches on the building.

## Field-level access

Authenticated resource grants can be narrowed to local columns. These are
server-enforced permissions, not `show` lists or hidden form fields:

```ts
resources: {
  lead: { access: 'write', fields: { read: ['id', 'name', 'status'], write: ['name', 'status'] } },
},
auth: {
  roles: {
    sales: {
      read: true,
      write: true,
      fields: { lead: { read: ['id', 'name', 'status'], write: ['name'] } },
    },
    manager: { read: true, write: true },
  },
},
```

A role without a field rule for a resource inherits the resource's column
ceiling; a resource without `fields` keeps whole-row access. An explicit field rule
requires `read` and defaults `write` to no columns. Writes must be readable and
within the parent ceiling. All primary-key columns must remain readable. Roles
union their permitted columns; unknown roles deny. Generated `TypedAppConfig`
checks column names against their owning logical resource, including named
sources. Every declared role is catalog-validated, even when nobody holds it.

Hidden columns are excluded from schema, default projections and relationships;
explicit hidden projections, predicates, sorts and aggregates are refused. App
pages with inaccessible definitions are omitted whole; unavailable fixed actions
are omitted without dropping their list. Unsafe form curation/defaults are
omitted whole and the permitted schema-derived form is used. Readable nonwritable
fields render without editors. Inserts may supply a permitted subset and receive
only readable returned values. Deletes require full-row read/write permissions.
An App has no Undo. Under row policy, permitted insertion returns projected
results; deletion additionally requires an explicit server-only deleted-record
policy and complete row access, as described below.

Limits: field policy is not row or tenant isolation. Restricted table profiling
is refused. Opaque database view/trigger dependencies remain deployment-owned.
A role's field rule may narrow reads on a table a command reads: it narrows
that role's generic reads (lists, records, the API, history), never the
handler's `db`, whose output is the command's declared shape. A role granted
the command must still read its target's `version` column, where it has one, and every column its
`when` judges, or binding refuses. A resource-level (root) field rule on a
command footprint, any role rule in a tenant App, and a role rule on a table a
command looks up are still refused. **Stop the server before
deploying such a privacy-policy change, then start a compatible configuration.**
A hot reload that would change the App's grants does not activate the proposed
restriction and does not keep serving the old one: the App's requests answer 503
until the server restarts, and the operator log names the difference. Current request permissions
are checked afresh, but previously fetched browser data is not remotely erased;
there is no policy polling. Refresh metadata to adopt changed field affordances.

## Read-only row policies

Authenticated named-source Apps can require a server-defined policy using
`auth.rows: 'policy'` and `--policy <file>` with one explicit `--app`.
The separate server-only module exports `defineAppRowPolicy({ appId, resolveRows })`
from `@mistriwork/mistri/policy` for an App without commands. The resolver receives verified
account/App identity and roles, and a read-only `db` over every declared resource
through the App's own pooled, traced connections (`policy/policyDb.ts`), for a
policy that must look the person up; browser filters cannot replace its row
predicates or grant resources.
Missing/invalid enrollment fails closed. `mistri check` validates without running
the resolver or migrating databases.

Lists/details, related reads, counts, reference lookup, views, aggregates and
browser export reads are scoped.
Without generic role write grants, generic editing remains disabled. With matching
resource ceilings and role grants, `POST /api/update` supports generic Save,
inline edits and fixed `set` actions on existing rows, and `POST /api/insert`
supports creation. `POST /api/delete` requires the separate policy below. An App
has no Undo: `POST /api/revert` answers 404.
No extra CLI flag is needed. Startup validates the scoped transaction
capability (SQLite or PostgreSQL) for every granted source across all roles,
including inactive roles; read-only or unsupported sources refuse without an
ordinary writer fallback. Without `--commands`, omit command grants/actions;
write ceilings and generic role write grants are allowed.

A generic writable table with a primary key that is not a view can advertise
`insertable: true` and offer New. Without `authorizeDeletedRecord`, DELETE remains
HTTP 403 with public `deletable: false`. With the hook, Delete eligibility also
requires generic whole-row read/write grants and no incoming foreign keys.
Raw SQL, diagnostic/compilation routes, MCP and CLI export/lint/diff modes remain
refused under row policy.

### Scoped updates and insertion

The update applies the conditional change inside one source-local scoped writer
transaction, which takes the row `FOR UPDATE` before it checks it. Caller
`expected` values make the write a compare-and-set: a row someone changed since
is refused with 409, never written over. Two saves of one record from this
process run in the order they arrived; saves of different records run side by
side on the writer pool (docs/postgresql.md).

Creation requires an explicit `values` object; send `{ "table": "ticket", "values": {} }`
to request database defaults. Missing, null or array values refuse. The same
source-local scoped writer checks the actual stored row after defaults
and coercion, including every foreign-key parent's scope. Neither ordinary reads
nor ordinary writes provide a fallback; scoped MySQL writes are unsupported.

Field-limited creation returns only readable fields. An insertion returns `key`,
`row` and `applied`. Permitted creation does not enable ordinary DELETE.

A file upload (`POST /api/file/upload`, a `file` resource's Add) is a creation
like any other: the file's bytes, name, type and size become the row's values,
and the same scoped writer judges the stored row and its parents. Whoever the
policy lets insert into the file table may upload; anyone else is refused by the
server, and the catalog's `insertable` is what draws the Add. Removing a file is
a deletion, held to the hook below. The reply names the row and never carries
the bytes back.

### Scoped deletion

Add an optional `authorizeDeletedRecord(principal, { table, key, row }): boolean`
to the separate server-only policy. It must return a strict synchronous boolean;
promises, truthy non-booleans and thrown errors refuse. This is explicit
authorization to delete the row. It does not bypass current row scope, source
access or resource/field grants. For a `ticket.assigned_user_id` that stores the verified auth account ID:

```ts
import { defineAppRowPolicy } from '@mistriwork/mistri/policy';

export default defineAppRowPolicy({
  appId: 'service-review',
  resolveRows: principal => ({
    ticket: { groups: [[{ column: 'assigned_user_id', op: '=', value: principal.id }]] },
  }),
  authorizeDeletedRecord: (principal, { table, key, row }) =>
    table === 'ticket' && row.id === key.id && row.assigned_user_id === principal.id,
});
```

Map business staff IDs explicitly when they differ from auth account IDs. Check
ownership; a bare `true` is not a production ownership policy. This hook alone grants no generic writes. Deletion requires
complete whole-row read/write access to a keyed non-view table on an explicitly
writable SQLite or PostgreSQL source with no incoming foreign keys. Graphs,
cascades and scoped MySQL writers remain unsupported.

Send `POST /api/delete` with `{ table: 'ticket', key: { id: 1 }, confirm: false }`.
Omitting `confirm` also previews; any supplied value must be boolean. An authorized
preview returns `{ impact: [], deleted: false }` and does not reserve the row.
Confirmation (`confirm: true`) checks the actual scoped row, captures every stored
scalar column and deletes on the same writer. The hook must return `true` before
and after removal. Success returns `{ impact: [], deleted: true, affected: 1 }`.

### Outcomes

A successful UPDATE returns `affected` and `applied`. Recognized
update/insert/delete refusals report `outcome: 'rejected'` (a line's `consumes`
refusing, `consumes_refused`, also answers HTTP 422); a write that waited
out another transaction's lock reports `row_locked` with 503 and `Retry-After`;
unconfirmed failures report `unknown`. Inspect the response body: uncertainty
can arrive with HTTP 200. There are no durable generic-write receipts or safe
automatic retries. Refresh and reconcile the record after uncertainty; the
record's history, not an Undo, is the account of what changed.

### Scoped commands

`--policy` supports `--commands <file>` for the same explicit authenticated
named-source App. Resources with `access: 'write'` may allow command footprints while
roles grant named commands. Generic write grants overlapping command-owned
resources refuse across all roles, including inactive roles; unrelated resources
may grant generic CRUD alongside commands, with the separate deleted-record
policy required for delete. A command grant alone never enables generic
New, Save or Delete. The command source must be explicitly
writable and support scoped command execution (SQLite or PostgreSQL) with an
existing migrated journal. Startup and `mistri check` do not migrate it; unsupported
capabilities or policy failures never fall back to legacy unscoped execution.

For commands, the policy declaration must also supply `resultReferences`, a map
with exactly the names of the registered commands a signed-in role can run
(public commands never run scoped and are left out) and one trusted
synchronous extractor per command. Each extractor declares all non-target row dependencies of the
entire result, including nested content and historical associations, using at
most 64 source-local references within the command's read footprint. Each key
must contain the complete primary key and no extra fields. Extractors receive
frozen detached data; async or malformed results refuse. Returning `[]` attests
only target-authorized content or constants. The runtime never infers arbitrary
JSON provenance. Opaque aggregates, commands deleting their target and field
rules overlapping command reads remain unsupported.

Prepare checks current visibility of the exact target and reads its authored
revision without reserving the record. Execute/status use the verified scoped
context and require current authorization for the target and every result
dependency before disclosing fresh or historical receipts. Hidden receipts and
status absence remain `unknown`. A fresh failure can report `not_applied` only
after authorized receipt absence and, if a transaction began, confirmed rollback.
Replay/status revalidate detached stored output without changing its canonical
content, rerunning handlers or rewriting receipts.

App, policy, command and private identity-map changes require restart. A watched
App-directory edit makes data requests unavailable until then; policy files
outside that directory are not watched. Keep business/auth stores outside the
authoring directory. Shutdown retires contexts and drains accepted reads, updates, insertions, deletions
and commands before releasing sources, including after disconnects. Embedded
hosts must await `policy.retire()` before replacing or closing sources. Tenant
context and membership remain separate work. Foreign-key constraint names
remain existing public path identifiers; resource aliases do
not anonymize them.

See the [complete Markdown example](../site/src/content/docs/docs/row-access.md).

## Business command actions

A command is declared once, in the server-only module beside the App
(`commands.ts`, or the file `--commands` names), and the App refers to it by
name:

```ts
// commands.ts — server-only
export default defineCommands({
  assignReviewer: defineCommand({
    source: lending, target: 'loan_application',
    input: {
      reviewer: field.reference('reviewer', { by: 'id', labelColumn: 'name',
        query: 'active = true and role = reviewer' }),
      reason: field.textarea({ max: 500, help: 'Explain this assignment.' }),
    },
    read: ['reviewer'], write: ['assignment_history'],
    async handle({ db, record }, input) { /* … */ },
  }),
});

// resources.ts — the App
export const resources = {
  loan_application: {
    access: 'write',
    actions: {
      assignReviewer: action('Assign reviewer', {
        command: 'assignReviewer',
        when: 'status = submitted and reviewer_id is empty',
      }),
    },
  },
};
```

The App never imports the module. Loading the App loads it, resolves each
name to the command's target, cardinality and input, and serves those to the
browser; a name the module does not register is refused with the nearest
one. `mistri check` (and `--export types`) writes
`mistri-commands.d.ts` beside the App, which fills `Register` in
`@mistriwork/mistri/app`: an unknown name, a record's command on another resource, a
bulk action over a single-record command and a form step naming a field the
command does not take fail the typecheck. The runtime also checks targets,
primary keys, reference columns and queries.

The input is fields keyed by name, in the order the form asks them, each
written with `field.*` (or as the plain object it stands for): `text`,
`textarea`, `email`, `phone`, `url`, `number`, `money`, `date`, `bool`,
`choice`, `reference` and `group`. A field is required unless it says
`optional: true`, and its label is read from its key unless it gives one.
Text takes `min`/`max` characters (at most 16384), a `format`, a `pattern`
with its `message`, and a `case`. A number takes finite `min`/`max`,
`integer` and a `step` it is rounded to (`money` is one from 0 in cents); a
number or a date may be `below` or `above` a sibling. A date is `YYYY-MM-DD`
with optional `min`/`max`. A choice lists its values, labelled once by
`each`, drawn as radios for four or fewer and a listbox for more; the value
submitted must equal an option's exactly. A reference names a logical
`resource`, its single primary-key `value` column, a `labelColumn`, and an
optional query. A group holds `fields`, nests at most two deep, and with
`repeat: { min, max }` becomes rows people add and remove; a form's steps may
name groups.

The form and the server read a value by the same parser, and a refusal names
the field by path (`vehicles[1].stock`). A command adds only
`validate(input, context)` for the rule a declaration cannot state, and
`initial({ record, db })` to prefill a record action's form, read with the
revision under the same authorization as execution. The metadata still
grants nothing: reference selection does not grant resource access, and the
handler's transactional checks remain authoritative.

A role granted a command must read the command's whole `read` footprint, or
the command is refused for it. Where a command must consult a table its
callers may not read — a rate card, a credit limit, another team's queue —
it says so: `read: ['rate_card'], elevate: { read: ['rate_card'] }`. The
spelling is a qualifier on `read`, not a second footprint: the handler's typed
`db` is built from `read` as always, and `elevate` only says whose authority
those reads are under. It names neither the target (whoever runs a command is
shown its target) nor a written table (whoever runs it must be able to write
what it writes), and a public command has no role to read above. The handler
reads the elevated table whole, within the tenant's scope in a tenant App;
what it reads reaches the caller only through the declared `output`. A form's
`initial` prefill reads only the caller's part, since its values are shown.
An App whose rows are a policy's (`auth.rows: 'policy'`) refuses an elevation
at load: a policy's row rules are the whole of what a reader may see. An App
API operation stays the role's own read: a role is eligible only where it
reads the elevated tables too, so an elevation never opens the API, and the
receipts a retry or a status request reveals are the declared output, as for
any command. `mistri check --design` lists every elevation and the granted
roles that would not read the table otherwise, so each is a reviewed decision.

A command has no version in its source. `authority.lock` records each
command's contract digest and version (`contract assignReviewer v1 …`); a
contract change is breaking only once something durable depends on it — an
API or MCP exposure, a job, kept receipts — and `mistri check --bump
<command>` then moves it to its next version, which execution, retries,
receipts and the API's routes carry. The record's revision is a different
thing: the target's non-null integer `version` column where it has one, else a
digest of the row, including binary contents, checked inside the transaction
(`stale_record`). Unknown outcomes retain the original request and retry key.
A fixed action is `close: action('Close', { set: { status: 'closed' } })`.
An action cannot combine a command with `set`. A command that asks nothing runs
on one click unless the action, or the machine verb that names it, says
`confirm: true`; one with inputs asks them in its form, which is the explicit
submission step, and is refused `confirm`. `when` controls visibility only. A resource's
`machine` makes command verbs its buttons and their precondition.

The retained Ignition fixture's assignment command reads `loan_application`, `reviewer`, `review_team`,
`assignment_history`, `dealer` and `vehicle`, and writes only the application and
history. Dealer and vehicle reads authorize unchanged foreign-key parents in the
loan postimage during scoped writes. Fresh synthetic browser checks prove a
desk-scoped reviewer picker and assignment; this is not a production preview, and
the fixture's selector stays desk-unscoped, with the handler checking
desk membership.

The [commands guide](../site/src/content/docs/docs/commands.md) covers server loading,
authentication, receipts and the SQLite execution boundary.
