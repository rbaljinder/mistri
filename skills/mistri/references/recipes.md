# First-shot recipes, by kind of App

What makes an App of each kind look finished on its first try, as a pattern.
Only two sample Apps ship, Tick (one list) and Lintel (property operations: a
desk, a resident portal and a public side); each recipe cites Lintel's lines
where it does the same thing and otherwise describes the pattern in words,
because `mistri docs choose` and the `compose-*` guides carry the rest. Take the
recipe nearest the brief, map its tables onto the person's, then build page by
page. Every recipe shares a spine:

- **Data**: SQLite text dates declared, `types: { due_on: 'date' }`, before
  any trend, calendar or `relative` ([choices.md](choices.md)).
- **Look**: `ui.theme` written out (Workshop unless [design-language.md](design-language.md)
  says otherwise), `ui.logo`, `locale`, `timezone`, `currency` —
  [lintel/app.ts:169](../../../examples/apps/lintel/app.ts#L169).
- **Home**: a dashboard, first in the menu, as the day's starting page: three
  or four figures of one width, the flow or trend, charts in pairs, the waiting
  work as a pair of half `rows`; a `firstRun` for an empty database. Under a
  side menu, an `aside` only beside metrics with no `width` ([design-language.md](design-language.md)).
  A different home for each role: `home` takes a view per role, a `signedOut: true` one first — [lintel/app.ts:161](../../../examples/apps/lintel/app.ts#L161).
- **A board's cards**: the record's own columns only.
- **Every value drawn**: a tone on each status, `money` on each amount, an
  `avatar` on each person, `relative` on each due date, a unit on each count.
- **Menu**: groups named by the work (`navGroup`), the rarely used one `folded: true` —
  [lintel/navigation.ts:16](../../../examples/apps/lintel/navigation.ts#L16).
- **Every main table**: a list with counted tabs (All last) and an `empty`; a
  record page in the anatomy (head, summary, tabs, aside); a New form in
  noun-named groups.

Check the shape against the rubric's worked example, not against this text.

## Property operations, or any business of homes, bills and repairs: Lintel

Lintel is the whole of this recipe. Look: Lumen, side menu with `rail: true`.

- **Home** "Today", by role: occupancy and rent as half-width `metric`s, rent
  compared to the previous period —
  [lintel/dashboards.ts:14](../../../examples/apps/lintel/dashboards.ts#L14);
  the repairs' road as a `shape: 'steps'` breakdown with `notes` —
  [lintel/dashboards.ts:27](../../../examples/apps/lintel/dashboards.ts#L27);
  rent by month as a stacked `chart`, leases ending soon as `rows`, the day's
  viewings as an `embed`. A resident's `portal` is their balance, their
  open repairs and two embedded lists —
  [lintel/dashboards.ts:78](../../../examples/apps/lintel/dashboards.ts#L78).
- **Lists** with counted `tabs` from `segments` and `rowActions` —
  [lintel/views.ts:104](../../../examples/apps/lintel/views.ts#L104);
  `totals` under a column —
  [lintel/views.ts:67](../../../examples/apps/lintel/views.ts#L67); the storeroom with `editable` columns —
  [lintel/views.ts:181](../../../examples/apps/lintel/views.ts#L181).
- **Record**: the state beside the name, facts under it, the conversation as a
  `timeline` with a composer, parts used as a `related` list —
  [lintel/pages/maintenance_request.ts:20](../../../examples/apps/lintel/pages/maintenance_request.ts#L20).
- **Values**: money from whole cents with `minor: true`
  ([lintel/resources.ts:12](../../../examples/apps/lintel/resources.ts#L12)), a `tone` on each status
  ([lintel/resources.ts:64](../../../examples/apps/lintel/resources.ts#L64)), a road as a `machine` whose verbs are the
  buttons (see the service desk below).

## CRM: leads, accounts, deals

Lintel has no pipeline of its own; its leases and repairs show the parts.
Look: Lumen with the brand's `accent`, top menu.

- **Home** "Sales dashboard": a banner `note` with one action; three `metric`
  cards at `width: 'third'` with `compare: 'previous period'` and `spark`;
  bookings by month, new leads by source (`curve: 'smooth'`), pipeline by stage
  beside a donut with `total`, a funnel beside a rep scatter, "Closing soon"
  rows; `windowControl: 'button'` and owner and stage filters.
- **Lists**: `leads` tabbed by status with `rowActions`, as the ledger is
  ([lintel/views.ts:104](../../../examples/apps/lintel/views.ts#L104)); deals with `totals`; the pipeline as a `board`
  whose lanes are the stage ([lintel/views.ts:129](../../../examples/apps/lintel/views.ts#L129)), with a `footer`;
  accounts as a `tree` by parent; campaigns as a `gantt`
  ([lintel/views.ts:81](../../../examples/apps/lintel/views.ts#L81)).
- **Record**: the deal, stage beside the name, money and close date as facts,
  rollups as the summary, quote and activity as tabs, account card and
  properties in the aside, as a `page('opportunity', …)`
  ([lintel/pages/unit.ts:12](../../../examples/apps/lintel/pages/unit.ts#L12) shows a record page of this anatomy).
- **Values**: `stage` toned and its codes said as words (`values`), people as
  avatars, the deal team as `avatars`, probability on a `slider`.

## Service desk or ticketing: requests worked through states

Look: Lumen, side menu with `rail: true` ([lintel/app.ts:175](../../../examples/apps/lintel/app.ts#L175)).

- **Home** "Workspace": opened and closed metrics compared to the previous
  period, a "Needs attention" `rows` of urgent open work; add a `shape: 'steps'`
  breakdown of the status flow ([lintel/dashboards.ts:27](../../../examples/apps/lintel/dashboards.ts#L27)) and a `heatmap` of
  when requests arrive (`weekday created_at, hour created_at`).
- **Lists**: an `inbox` as a `split` (list beside the request, keys for the
  verbs); `triage` as a `queue`
  ([lintel/views.ts:148](../../../examples/apps/lintel/views.ts#L148)); a `board` in the machine's states with
  work-in-progress `limits`
  ([lintel/views.ts:129](../../../examples/apps/lintel/views.ts#L129)).
- **Record**: the forward verbs in the header, the conversation as a `timeline`
  with its own Add —
  [lintel/pages/maintenance_request.ts:20](../../../examples/apps/lintel/pages/maintenance_request.ts#L20);
  priority and assignment editable in the aside.
- **Values**: `status` in a `machine`, toned by meaning (only what is urgent is
  red), its verbs the page's buttons ([lintel/resources.ts:240](../../../examples/apps/lintel/resources.ts#L240)); replies as `richText` with `mentions`; an
  SLA date `relative`; queues or teams in the menu told apart by `color` dots.

## Inventory or warehouse: stock that moves

Look: Lumen, side menu, `shell: { placement: 'side', counts: true }`
([lintel/app.ts:173](../../../examples/apps/lintel/app.ts#L173)).

- **Home** "Operations": `firstRun` for an empty depot; metrics with an `icon`
  and a `to` list ([lintel/dashboards.ts:23](../../../examples/apps/lintel/dashboards.ts#L23)); the floor's flow as `steps` with
  `notes`; two embedded queues at half; moves by day, a `heatmap`, a `treemap`
  of stock value beside a `waterfall` of net units; an `aside` with `activity`
  and the low-stock list.
- **Lists**: the floor's work as a `queue`; orders and products at `density: 'compact'` with
  `editable` triage columns ([lintel/views.ts:181](../../../examples/apps/lintel/views.ts#L181)); a catalog as `cards`.
- **Record**: the product's `facts` line, photos, stock summary, the ledger and
  purchasing as tabs, properties and `history` in the aside
  ([lintel/pages/maintenance_request.ts:35](../../../examples/apps/lintel/pages/maintenance_request.ts#L35) ends on `history`).
- **Values and inputs**: the product name with `icon: { mark, tone }`, money and
  units everywhere, the UPC with `scan: true`, delivery proof as a `signature`;
  stock changes only by a take or a receipt that moves the shelf and refuses
  past zero ([lintel/resources.ts:296](../../../examples/apps/lintel/resources.ts#L296) is the `consumes` side).

## Community or forum: reading first

Look: a `defineTheme` of its own (a printed page), because people read here
more than they operate; top menu, `width: 'wide'`.

- **Home** by role: signed-out readers a landing, members the latest threads,
  moderators a health `dashboard`, the `home` list choosing by `roles`
  ([lintel/app.ts:164](../../../examples/apps/lintel/app.ts#L164)). The dashboard is metrics with sparks, posts by
  month, busiest boards beside a donut, the queues at half, an `aside` of
  `activity` and guidance notes.
- **Lists** as `cards`: threads with their board and author; members by name
  and standing.
- **Record**: a member as an overview page (avatar, figures, activity chart,
  what they wrote), `page('member', …)`.
- **Values**: locked, held and removed as `icons`
  ([lintel/resources.ts:216](../../../examples/apps/lintel/resources.ts#L216)); people with photo avatars; posting and
  moderation only through commands, readers who may only read.

## Marketplace or catalog: browsing first

Lintel's public side is this recipe. Look: Lumen or its own theme on Lumen
(`customThemes`), top menu, `width: 'wide'`.

- **Access**: the catalog is `public`, read signed out, and sign-up gives the
  smallest role — [lintel/app.ts:136](../../../examples/apps/lintel/app.ts#L136).
- **Front page**: a `landing` whose `hero` is a photograph with the heading
  over it, then rows of photo cards as `embed`s —
  [lintel/landing.ts:7](../../../examples/apps/lintel/landing.ts#L7).
- **Lists** as `cards`: the photo dominant, the price as the value, a few
  quiet facts — as `cards`, a `value`, `facts` and an `image`:
  [lintel/views.ts:14](../../../examples/apps/lintel/views.ts#L14).
- **Refinements**: a `filterBar: 'rail'` of counted facets, so the address is
  the question — [lintel/views.ts:28](../../../examples/apps/lintel/views.ts#L28).
- **Record**: the `gallery` first, then the price as a sticky `headline` in the
  aside with its figure per area and the ways to ask —
  [lintel/pages/unit.ts:16](../../../examples/apps/lintel/pages/unit.ts#L16).
- **Asking**: a public `commandForm` that the item's page prefills —
  [lintel/views.ts:37](../../../examples/apps/lintel/views.ts#L37).
- **The desk**: a `board` of the inquiry's stages whose drag is the verb; an
  inquiry as a `timeline` with a composer.
- **Stock**: `editable` in the grid — [lintel/views.ts:51](../../../examples/apps/lintel/views.ts#L51).
- **Values**: real photographs (a thumbnail on the card), `money` everywhere,
  a `slug` in each item's address.

## Internal admin tool: people, requests, settings

Look: Sage, or a small `extends: 'sage'` theme for people work, named in
`theme: { preset }`; Mono for a dense ledger or config tool.

- **Home** "Today", a to-do `dashboard`: embedded queues of what waits on the
  reader, an aside of who starts soon and what is coming up
  (the resident's `portal`, [lintel/dashboards.ts:78](../../../examples/apps/lintel/dashboards.ts#L78), embeds two lists).
- **Lists**: each approval a `queue` with a `badge`, its facts and an
  `openLabel` verb; lookups and settings in a folded
  group.
- **Record**: the person as an overview; a request as the record anatomy with
  its approve and reject verbs.
- **Values and inputs**: settings columns as `json`, brand colors as `color`,
  opening hours as `time`, a renewal as `month`, a score as `rating`,
  completion as a percent `ring`; `signature: true` for an acknowledgment.

## Forms: a record form in rows, an application as an intake

A record's New form asks its columns in noun-named groups; fields read
together share a row of up to three, `['part_id', 'quantity']` as Lintel's
delivery does — [lintel/resources.ts:334](../../../examples/apps/lintel/resources.ts#L334).
`show`, a group's `fields` and a step take the same rows (`mistri docs forms`):

```ts
form: {
  groups: [
    { label: 'Contact', fields: [['email', 'phone'], 'company'] },
    { label: 'Deal', fields: [['amount', 'close_on'], 'stage'] },
  ],
},
```

A long application, public or signed in, is a `commandForm` with
`style: 'intake'` — [lintel/views.ts:229](../../../examples/apps/lintel/views.ts#L229);
a public one starts from `npx @mistriwork/mistri new --template intake`
(`mistri docs command-forms`):

```ts
apply: commandForm('Apply', 'submitApplication', [
  step('You', [['first_name', 'last_name'], 'email'], { title: 'Who is applying?' }),
  step('Income', ['income', 'monthly'], { title: 'What do you earn?', lead: 'Before tax.' }),
  step('Extras', ['extras'], { title: 'Anything else?', skip: 'Skip', next: 'Review' }),
], { style: 'intake', public: true, note: { icon: 'lock', text: 'We never share your details.' } }),
```

- **A step speaks for itself**: `title` is its question, `lead` one line
  under it, `next` the primary's word, `skip` its word while the step is
  empty; `note` is one line of reassurance under the first title. The last
  step is the review, every answer under its step's name with a Change
  (`review: false` leaves it out).
- **A yes or no** is two buttons, `field.bool({ as: 'buttons' })` —
  [lintel/commands/maintenance.ts:40](../../../examples/apps/lintel/commands/maintenance.ts#L40).
- **One answer from a few** is icon cards, `field.choice(KINDS, { as: 'cards' })` —
  [lintel/commands/maintenance.ts:38](../../../examples/apps/lintel/commands/maintenance.ts#L38);
  several are `field.choices(EXTRAS, { as: 'cards', min: 1, exclusive: ['none'] })`.
- **An amount** is `field.money({ min: 1 })` —
  [lintel/commands/ledger.ts:185](../../../examples/apps/lintel/commands/ledger.ts#L185);
  on a range it is a slider in the currency,
  `field.money({ min: 150, max: 1000, step: 10, as: 'slider' })`, and a plain
  number's slider is `as: 'slider'` too.
- **A shaped text** takes a `mask` and the `message` said when it is not filled:
  `field.text({ mask: '00000', message: 'Enter the 5 digits of your ZIP.' })`.
  An identity number is also `sensitive: { keep: 'last4' }`: drawn masked,
  never prefilled, kept only as its last four.
- **A question asked only after another** takes `when` —
  [lintel/commands/maintenance.ts:43](../../../examples/apps/lintel/commands/maintenance.ts#L43).
  It is three-valued: an unanswered field is null, so `entry_ok = false`
  waits for a No; a bare word is read as its field's own kind, so
  `battery != no` against a choice compares the word `no`.

## Anything else

Name the nearest recipe and say what differs. A facilities, clinic or
field-service desk is the service desk with a schedule (`calendar` or `gantt`);
a booking or rental App is the CRM with a `calendar`; a finance back office is
the admin tool in Mono.
