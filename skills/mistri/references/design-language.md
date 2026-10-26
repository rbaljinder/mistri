# The design language, for App authors

Apps are tools people complete work in: quiet, square, dense, full width.
Hierarchy comes from type and spacing, not boxes. You write no CSS: you pick
a look and declare display rules (`mistri docs looks`, `mistri docs vocabularies`).
For what a whole App of a kind looks like on its first try, see
[recipes.md](recipes.md); this file is the rule for each part.

## The look: Lumen unless the work says otherwise

Write `ui.theme` even for the default, so the choice is visible in review.

| The App is | Look | Example |
| --- | --- | --- |
| Operations, sales, a desk, anything with a dashboard home | `preset: 'lumen'` (the default) | [lintel/app.ts:171](../../../examples/apps/lintel/app.ts#L171) |
| Dense back office: ledgers, admin tables, read in rows all day | `preset: 'mono'` | `mistri docs looks` |
| People, care, scheduling: soft cards, a calmer page | `preset: 'sage'` | `mistri docs looks` |
| A brand or a reading product with its own grounds and inks | a `defineTheme` in `theme.ts`, `extends` a built-in | `mistri docs themes` |
| A tenant App whose tenants want their own logo and accent | `branding` plus a `brandingForm()` section | `mistri docs themes` |

- **Adjust before you define**: `accent`, `radius`, `font` on a built-in look,
  beside `preset` in `ui.theme` (Lintel writes only the preset, line 159 above).
- **A theme of your own is small**: `extends: 'sage'` (or `'lumen'`, `'mono'`)
  and only what differs, registered in `customThemes` and named in
  `theme: { preset }`. It is done when `mistri check --app .` passes: the
  validator measures text and the accent at 4.5:1, controls and the first four
  `chart` colors at 3:1, light and dark, and adjacent chart colors apart for
  protanopia and deuteranopia, and names each failing key. A printed page is
  a `defineTheme` that extends nothing.
- **Tenant branding** (tenant Apps only):
  `branding: { allow: ['logo', 'name', 'accent'], editors: ['owner'] }` on the
  App and a settings dashboard with `brandingForm('Branding')`; the tenant can
  never change grounds, ink or recipes, and every save is validated as a theme.
- **A mark** (`ui.logo`) and an `icon` on every view, of what it lists —
  [lintel/app.ts:169](../../../examples/apps/lintel/app.ts#L169),
  [lintel/views.ts:25](../../../examples/apps/lintel/views.ts#L25).

## Make it look like the domain

A theme of its own is for an App whose work has a character the built-in looks
do not say: a workshop, a newsroom, a care home, a ledger. Name that character
in three words (`hard-wearing, labelled, loud`), find its row below, and start
from those recipes; then colors and a face, not the other way round. Every
value is pictured in `mistri docs theme-recipes`.

| Character | Extends | Recipes | Shape and type |
| --- | --- | --- | --- |
| Industrial: a workshop, a warehouse, a fleet | `mono` | `bar: 'dark'`, `nav: 'inverted'`, `tabs: 'inverted'`, `stat: 'framed'`, `status: 'pill'`, `lanes: 'tag'`, `table: 'tinted'` | `radius: { control: '2px', pill: '2px' }`, `elevation: 'flat'`, `rules.control: '2px'`, a condensed sans heading; `roles: { section: { case: 'upper', size: '12px' } }` (Mono's labels and figures come with it) |
| Editorial: a publication, research, a reading product | `lumen` | `bar: 'ruled'`, `nav: 'underline'`, `tabs: 'rule'`, `stat: 'ruled'`, `status: 'quiet'`, `links: 'underline'`, `rules: 'ink'` | `elevation: 'hairline'`, a serif heading; `roles: { section: { case: 'small-caps' }, label: { case: 'small-caps' }, figure: { face: 'heading', weight: 600, features: ['lnum'] } }` |
| Soft: care, scheduling, people | `sage` | `bar: 'soft'`, `nav: 'quiet'`, `tabs: 'chosen'`, `windows: 'chosen'`, `stat: 'panel'`, `section: 'panel'`, `fields: 'panel'`, `status: 'pill'`, `avatar: 'large'`, `board: 'soft'`, `chart: 'wash'` | `radius: '8px'`, `elevation: 'soft'` |
| Dense ledger: accounts, admin, anything read in rows all day | `mono` | `bar: 'ruled'`, `nav: 'tint'`, `tabs: 'underline'`, `stat: 'divided'`, `section: 'open'`, `table: 'quiet'`, `status: 'dot'`, `lanes: 'plain'`, `rules: 'hairline'` | `density: 'compact'`, `roles: { title: { size: '22px' } }` (Mono's labels and figures come with it) |

- **Measure the distance from the base**: `npx @mistriwork/mistri theme show <id> --app . --diff <base>`
  prints every value that differs and a `distance:` line counting recipe parts of
  all of them (a row's values its base already wears count for nothing). A theme
  whose distance counts no recipe part is the base in a new coat: either say the
  character's recipes, or keep the base and change only its accent.
- **Pass check in two runs**: `npx @mistriwork/mistri check --app .` names each failing
  color with the nearest one of its hue that passes; `check --fix` writes them,
  and the next run passes.
- **Look before you hand back**: `npx @mistriwork/mistri shot --app . --dark` and
  `npx @mistriwork/mistri shot --app . --phone`, every time, and read the pictures. A
  theme is drawn on every page in both modes and at both sizes; a desk in light
  is a quarter of it.

## The shell: a dashboard home, a menu grouped by the work

- **Home is a dashboard** named for the day (`label: 'Today'`), first in the menu —
  [lintel/navigation.ts:9](../../../examples/apps/lintel/navigation.ts#L9).
- **Groups named by the work** (`navGroup('inventory', 'Inventory', [...], { icon })`),
  at most seven top-level entries —
  [lintel/navigation.ts:15](../../../examples/apps/lintel/navigation.ts#L15).
- **A section used rarely** (settings, lookups, reference tables) starts
  folded: `navGroup('setup', 'Setup', [...], { folded: true })`.
- **Entries told apart by color** (projects, labels, queues): a dot in the
  icon's place, `{ to: 'launch', label: 'Q3 launch', color: 2 }` (1–8, the
  theme's chart colors).
- Side menu (`shell: { placement: 'side', rail: true, counts: true }`) for
  many lists worked all day; top menu for a few. Beside a side menu a record
  summary holds three figures, not four.

## Color is status, said through tones

- **A state wears a tone**: `{ tone: { ... } }` to `good`, `warn`, `bad`,
  `info`, `neutral`, with `'*': 'neutral'`. Tone only what carries meaning —
  [lintel/resources.ts:64](../../../examples/apps/lintel/resources.ts#L64).
- **A state people scan for** (locked, held): `icons`, never a dot and a mark
  together —
  [lintel/resources.ts:216](../../../examples/apps/lintel/resources.ts#L216).
- **A kind, not a state** (design, research, ops): `colors: { design: 1, research: 3 }`,
  so it keeps one chart color in every look; a board shows it as `category`.
- **A trend** is green or red only where `better` says which way is good —
  [lintel/dashboards.ts:19](../../../examples/apps/lintel/dashboards.ts#L19).

## Values drawn, not printed

Every status, figure, person and date gets a rule. One line per intent:

| Value | Rule | Example |
| --- | --- | --- |
| Money | none for a number named like money (`amount`, `price`, `…_total`); `{ format: 'money' }` where the name does not say it; `ui.currency` once; cents stored as whole numbers add `minor: true` | [lintel/resources.ts:12](../../../examples/apps/lintel/resources.ts#L12) |
| A figure with a unit | `{ unit: 'min' }`, money too (`unit: '/mo'`) | [lintel/resources.ts:59](../../../examples/apps/lintel/resources.ts#L59) |
| A share compared down a list | `{ format: 'percent', bar: true }` | `mistri docs vocabularies` |
| Progress toward a whole, on a record | `{ format: 'percent', ring: true }` | `mistri docs vocabularies` |
| A date said from today ("in 3 days") | none for a date named like a due date; `{ format: 'relative' }` for another | `mistri docs vocabularies` |
| A person or a company | `{ avatar: true, subtitle: 'email' }` | `mistri docs vocabularies` |
| The people on a thing | `{ format: 'avatars' }` | [lintel/resources.ts:225](../../../examples/apps/lintel/resources.ts#L225) |
| A thing's kind in a list | `{ icon: { mark: 'tag', toneOf: 'status' } }` | `mistri docs vocabularies` |
| A score out of N | `{ format: 'rating', outOf: 5 }` | `mistri docs vocabularies` |
| A color, a time, a month, a year | `format: 'color'`, `'time'`, `'month'`, `'year'` | `mistri docs vocabularies` |
| Settings or a payload | `{ format: 'json' }`: a tree on the record, an excerpt in a list | `mistri docs vocabularies` |
| An asset tag or link to scan | `{ format: 'qr' }` | `mistri docs vocabularies` |
| A stored code | a `tone` or a `values` map; a flag by `CHECK (x IN (0, 1))` | `mistri docs dates-and-types` |

A drawn format (`avatars`, `rating`, `color`, `time`, `month`, `year`,
`json`, `qr`) takes no `unit`, `bar`, `icons` or `values`; only a rating takes a `tone`.

## Inputs: the control is the value's own

- A number on a range (probability, NPS): `slider: { min: 0, max: 100, step: 5 }`.
- A rating is picked as stars, a color in the picker, a time, month or year in
  the browser's picker: the display rule is the input; nothing more to write.
- A JSON column (`format: 'json'`) is edited as checked JSON; the server
  refuses a write that is not JSON.
- A code read off a box (UPC, serial): `scan: true` on the text column.
- Proof of delivery or consent: `signature: true` on a reference to a `file`
  resource (a `file` resource, such as Lintel's photos at [lintel/resources.ts:36](../../../examples/apps/lintel/resources.ts#L36)).
- A vocabulary of a few kinds, in a New form: cards with their icons,
  `form: { fields: { category: { as: 'cards' } } }` —
  [lintel/resources.ts:206](../../../examples/apps/lintel/resources.ts#L206); `'buttons'`,
  `'radios'` and `'select'` are the others. A command's inputs say the same
  with `as` ([recipes.md](recipes.md#forms-a-record-form-in-rows-an-application-as-an-intake)).

## Forms: a clean outline, one way to say where you are

You write no form CSS; these are what the platform draws, so write the App to
fit them (`mistri docs command-forms`, `mistri docs forms`).

- **A field at rest is a clean outline** at 3:1 or more against its ground
  (`var(--field-edge)`, derived per look), never the soft well with no edge: a
  fill alone read as disabled. A theme may set `colors.<mode>.field`, and
  `check` measures the ink on it at 4.5:1.
- **"(optional)" stands beside an optional label**, and a needed one wears no
  star. A `help` says what to put there or what leaving it empty does, never
  "Optional" again.
- **One step indicator**: every stepped form, either style, page or dialog,
  says "Step n of m" beside one thin bar; there is no row of numbered tabs,
  and the primary says Continue or the step's `next`.
- **At a desk (1024px and up) a stepped page lists its steps** in a column
  beside it, each done step a link back with what it said. Short card labels
  stand in a grid there: up to 14 characters, three to a row; up to 24 with a
  line of up to 40, two. Keep card words that short.
- **The review is rows**: each label muted beside its answer, Change beside
  each step's name, an optional question left unanswered not listed, a
  sensitive answer as its last four.
- **Rows of fields**: up to three read together side by side, one height,
  stacking on a narrow form — `['part_id', 'quantity']` at
  [lintel/resources.ts:334](../../../examples/apps/lintel/resources.ts#L334);
  never four, never a field named twice.

## Dashboards: say one thing per section

Order: an optional banner, a row of three or four figures, the flow, charts in
pairs, then the lists of waiting work. Blocks by intent:

| Intent | Section | Example |
| --- | --- | --- |
| Introduce the board and its one next step | `note(text, { variant: 'banner', title, eyebrow, action })`, once, first | `mistri docs compose-dashboard` |
| A flow through ordered states (received, picked, shipped) | `breakdown(..., { shape: 'steps', notes })`, full width | [lintel/dashboards.ts:27](../../../examples/apps/lintel/dashboards.ts#L27) |
| A trend over time | `chart(..., 'month <date>', { curve: 'smooth' })` | [lintel/dashboards.ts:40](../../../examples/apps/lintel/dashboards.ts#L40) |
| Shares of a whole, at most six parts | `shape: 'donut', total: 'Leads'` | `mistri docs compose-dashboard` |
| How far rows get through a pipeline | `shape: 'funnel'` | `mistri docs compose-dashboard` |
| Two figures per group (count against value) | `shape: 'scatter', x: 'count'` | `mistri docs compose-dashboard` |
| When work happens (weekday by hour) | `shape: 'heatmap'` over `weekday <ts>, hour <ts>` | `mistri docs compose-dashboard` |
| Where a total sits, too many parts for a donut | `shape: 'treemap'` | `mistri docs compose-dashboard` |
| Rises and falls that make a net | `shape: 'waterfall'` | `mistri docs compose-dashboard` |
| The page's window as one date button | `windowControl: 'button'` with `windows` | [lintel/dashboards.ts:73](../../../examples/apps/lintel/dashboards.ts#L73) |

Charts follow the data-visualization rules, or they are left out:

- **One measure per axis**; never two scales on one chart. Compare across
  charts, not inside one.
- **Categories keep a fixed order**: the vocabulary's (`CHECK (stage IN (...))`)
  for stages and steps, the calendar's for time, biggest first otherwise; never
  the alphabet for a flow.
- **A legend wherever color means something**: a line over two keys
  (`'month created_on, source'`) or a donut draws one; at most four series,
  past that a breakdown or a treemap says it better.
- **No rainbow**: series take the theme's chart colors in order; pin a value's
  color with `colors` so it matches from chart to chart. Never color by position
  to decorate.
- **Pairs share a row**: two `width: 'half'` sections side by side, three
  metrics at `width: 'third'`; a half alone on a row is a gap.

Room decides the rest. Beside the side menu a dashboard's main column is about
820px at a desk, and an `aside` leaves it about 540: there a third-width metric
wraps, a donut's legend loses its words and half-width rows cut their titles.
So under a side menu, leave the dashboard's `aside` out and put the waiting
work in a half `rows` pair; keep `aside` for the top menu or for
metrics with no `width`. A `steps` flow draws every value of its
column in the vocabulary's order, and holds five at full width: past that,
`limit` cuts the tail (a cancellation listed last), or the flow is a bars
breakdown. Any section with `over: '<date>'` brings the dashboard's window
picker, whose first choice is "Default" (as authored): give `over` where most
sections follow the period, and say "now" figures in their `query` without it.

## Lists: the presentation is how the work divides

`mistri docs choose` picks the presentation; what each looks finished with:

- **A board**: `board: { by, primary, lines, category, footer }` — `category`
  a kind chip, `footer` up to four facts with icons, people last; each names a
  column of the record's own (a card draws a reference as its bare key) —
  [lintel/views.ts:134](../../../examples/apps/lintel/views.ts#L134).
- **A hierarchy** (parent companies, locations, categories) with a
  self-reference: `presentation: tree('parent_id', 'name', { lines: ['city'] })`.
- **Spans between two dates** (campaigns, projects, rotas):
  `presentation: gantt('starts_on', 'ends_on', 'name', { by: 'kind', progress })` —
  [lintel/views.ts:81](../../../examples/apps/lintel/views.ts#L81).
- Every list: tabs in working order with All last, a filter per way it is
  narrowed, an `empty` that says what belongs there.

## Records are named, never numbered

- **`recordLabel`** is words and references, never an amount or an id; a date
  only beside the parent it tells apart —
  [lintel/resources.ts:49](../../../examples/apps/lintel/resources.ts#L49).
- **No raw ids**: a reference by name through a label path (`owner_id.name`),
  captioned once in `labels`, keys out of `show` —
  [lintel/resources.ts:68](../../../examples/apps/lintel/resources.ts#L68).

## One primary action

- One filled button: the header's `primary: 'renew'` (an action id, never its
  label), else the first non-destructive verb; the next two quiet, the rest
  under More. The forward verb first; Delete never a button; a destructive
  verb last, with `confirm: true` —
  [lintel/resources.ts:176](../../../examples/apps/lintel/resources.ts#L176).
- **A verb says what it does to what**: `label: 'Cancel request'`, not "Cancel" —
  [lintel/resources.ts:14](../../../examples/apps/lintel/resources.ts#L14).
- A list's New is its one primary action.

## Copy: en-US, sentence case, the reader's words

- `locale`, `timezone` and `currency` in `ui` —
  [lintel/app.ts:187](../../../examples/apps/lintel/app.ts#L187).
- Sentence case, American spelling. A heading names what the section shows,
  never "Details", "Info" or "Data".
- A form's `description` says in one sentence what a new record is for; a
  field's `help` says what to put there —
  [lintel/views.ts:39](../../../examples/apps/lintel/views.ts#L39).
- An empty state says what belongs there and, at most, the one next step.
- Named orders (`sort: [{ label, sort }, …]`) say what they are, never "Default order".

## Never

- A card inside a card, or a box round a table.
- A tone on every column, or a tone map that is all `info`.
- A hex color outside a `defineTheme`, a font file or a stylesheet; a custom
  component draws with `@mistriwork/mistri/ui` and the look's tokens only.
- Motion for decoration, pulsing, anything that moves on hover.
- Fields grouped by type (Dates, Links); group by the noun in the form's `groups` —
  [tick/app.ts:38](../../../examples/apps/tick/app.ts#L38).
- A metric card alone on a row; more than two columns in an aside; a summary
  wider than a row (`check --design` measures it).
- Every new chart shape on one dashboard: pick the one the question asks for.
- The query language, a column name or a table name where a reader expects a sentence.
- A page that scrolls sideways, at a desk or at 320 wide.

## What not to write

The platform infers money by name or type, percentages, units, due dates, 0/1
flags, vocabulary tones, a machine's tones (`status is open`, its `groups`), a
record's label column, captions without `_at`/`_on`, a state's stamp
(`ready_at` beside `ready`) and a form's start from the schema DEFAULT. Write a
rule only where the App differs: `check --defaults` prints what each column is
drawn by, and `check --design --fix` deletes a rule that restates one.
