---
title: Custom components
description: Draw what no built-in block draws with a React component of your own, fed by checked reads and changing data only through commands.
keywords:
  [
    custom component,
    React,
    widget,
    plugin,
    extension,
    '@mistriwork/mistri/ui',
    '@mistriwork/mistri/page',
    SDK,
    visualization,
    definePage,
    free-form page,
    loader,
  ]
---

Draw what no built-in block draws with a React component of your own, fed by checked reads and changing data only through commands.

```sh
npm i -D rolldown @types/react
```

An App declares a component by an id and a module path inside its directory, and a section places it:

```ts
export const binMap = component('bin-map', { module: './widgets/BinMap.tsx' });

export const warehouseBins = custom('Floor', binMap, {
  rows: {
    bins: { from: 'bin', whose: 'warehouse_id', show: ['id', 'code', 'zone', 'capacity', 'units', 'active'], sort: 'code', limit: 500 },
  },
  figures: {
    bins: { from: 'bin', whose: 'warehouse_id', measure: 'count' },
    units: { from: 'bin', whose: 'warehouse_id', measure: 'sum units' },
  },
});
```

<!-- no sample: no sample App needs a component of its own; Ladle's free-form page is below. -->

The module, `widgets/BinMap.tsx`, draws with `@mistriwork/mistri/ui`.

![A warehouse page: the Floor section, the bin map, drawing each aisle's bays and levels shaded by how full each bin is.](../../../assets/screens/custom-component.webp)

## What you'll see

- The section stands among the page's built-in ones, with its title, in every look and in dark mode, because it draws with the looks' tokens.
- Its one read (`bins`) arrives as typed `rows`, and its two figures (`bins`, `units`) as exact `figures`, all compiled at load and run under the reader's grants, field projection and row policy; loading and errors are the platform's to draw.
- Edited from source, the module recompiles on save; `mistri build` bundles it, pinned to its version.

## When to use it, and when not

- Use a component only when no section, presentation, chart or display rule draws it, and the need is one App's: a bin map, a payroll timeline, a forum's post stream.
- Use [Choose a building block](/docs/choose/) first: a bug is fixed in the platform, and a need two Apps share is a platform gap to report, not a component.
- Use a [command](/docs/commands/) for anything the component changes: it never writes on its own.

## Options

| Kind              | Declared                                                           | Placed                                                                                          | Props type     |
| ----------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | -------------- |
| Section (default) | `component(id, { module, props })`                                 | `custom(title, comp, { record, rows, props })` on a page or dashboard                           | `SectionProps` |
| Value             | `kind: 'value'`                                                    | `resources.<r>.display.<column>`                                                                | `ValueProps`   |
| Input             | `kind: 'input'`                                                    | `resources.<r>.inputs`, an action's or a command form's `inputs` (`'trade.vin'` inside a group) | `InputProps`   |
| List              | `kind: 'list'`                                                     | `presentation: customList(comp, { show })`                                                      | `ListProps`    |
| Page              | `definePage({ path, label, reads, … })` in `pages/<path>.page.tsx` | Its own address and nav place; see [free-form pages](#free-form-pages)                          | `PageProps`    |

`props` are JSON-safe: `prop.number({ default, min, max })`, `prop.text`, `prop.bool`, `prop.choice([...])`. `rows` holds up to eight named reads, `{ from, show, query?, sort?, limit? }`, tied to the record by `whose` on a page (or `same: ['body_type']` for the rows that share the record's values, the record left out) or to the window by `over` on a dashboard. Every key: [pages reference](/docs/dsl-pages/#pagessectionskindcustom).

## Write the module

```tsx
import { EmptyState, useFormat, useNavigate, type SectionProps } from '@mistriwork/mistri/ui';
import type { Rows } from '../mistri-schema.d.ts';
import type { warehouseBins } from '../pages/warehouse.ts';

export default function BinMap({ rows }: SectionProps<typeof warehouseBins, Rows, 'warehouse'>) {
  // rows.bins[0].code is a string, rows.bins[0].units a number
}
```

Custom components and pages import from six mistri client entry points — `@mistriwork/mistri/ui` (the kit, reads, commands and App hooks), `@mistriwork/mistri/page` (free-form pages: everything in `/ui` plus page blocks and param controls), `@mistriwork/mistri/primitives` (operational controls, pickers, menus and structured editors), `@mistriwork/mistri/charts` (responsive SVG charts), `@mistriwork/mistri/views` (composite product views) and `@mistriwork/mistri/behaviors` (headless drag, calendar, resize and inline-edit behaviors). `@mistriwork/mistri/ui` holds:

- **The kit**: `Card`, `Stack`, `Row`, `Cluster`, `Beside`, `Heading`, `Button`, `Badge`, `Value`, `StatusDot`, `Meter`, `StatCard`, `Sparkline`, `MiniBars`, `BreakdownList`, `Tile`, `Columns`, `Table`, `ItemList`, `ItemRow`, `DescriptionList`, `Dropdown`, `SegmentedControl`, `SplitView`, `EmptyState`, `Loaded`, `Skeleton`, `Icon`, `Text` (`<Text muted size="sm">`: a line of secondary ink; `hierarchy` `default`, `secondary`, `muted` or `subtle`, and `tone` a `Tone`), `VisuallyHidden` (words only a screen reader hears, clipped rather than hidden: `<VisuallyHidden>, opens in a new tab</VisuallyHidden>`). `AiBadge` is the badge the platform draws on whatever a model made or proposed, with the App's `ai.label` ("AI" unless said): draw it beside a value your component shows as a model's, `<AiBadge quiet />` for the small one in a row. `StatCard` takes a `delta` (`{ value: 12, good: 'up', against: 'vs last month' }` is "+12 vs last month" in the good ink, and "-3" with `good: 'down'` too), a `trend` array (drawn as a sparkline for the eye and hidden from a screen reader, which hears the figure and the change), `formatValue`, and an `href` that makes the whole figure a link. A `Meter` is a share of a whole (`value` against `max`, 100 unless said): `ariaLabel` names it where its `label` is not a string (`ariaLabel="Seats taken"`), `formatValue` (with an optional `format` preset, `'number'` or `'percent'`) formats the figure, `valueLabel` is the value as a screen reader says it (`valueLabel="12 of 40 seats"`), and `fluid` stretches the bar across its row or column. `Sparkline` (`data`, `formatValue`) and `MiniBars` (`data`, `labels`, `highlight`, `formatValue`) draw in the look's chart ink and tell a screen reader their values. A `Tile` is a card that is one control (`onClick` or `href`, `selected`, `disabled`), with the card's corner and lift rather than a button's. `BreakdownList` draws groups as labeled bars against the largest, or against `total` with `showPercent`, in the order given (`items`: `{ key, label, value, note? }`, formatted by `formatValue` or `format`, the `note` a quiet second figure such as "4 deals"); each row is a meter a screen reader hears whole, and on a phone the label stands above its bar. A `Card`'s title is an h3; a card that is a section of a page under the platform's h1 says `level={2}` so the outline does not skip a level. `Table` draws each cell as a `Value`, dressed as the App dresses that column; sorting stays yours (`sort`, `onSort`), and `onRowClick` makes the first cell a link. `Button` with an `href` is a link in the button's dress: it opens a new tab, copies as an address, and an address of this App is followed in place. `ButtonLink` from `@mistriwork/mistri/primitives` is that same link-styled button; there is no other name for it. The platform's fields (`TextField`, `Select`, `Checkbox`, `Switch`, `Slider`, `YesNo`, `ChoiceCards`, `FileField`) are exported from the same entry. A free-form page's row of verbs at the screen's foot is `<Row foot>`: on a phone a notice stands above it instead of covering it. `<Cluster min="14rem">` lays its children in equal columns at least that wide, as many across as fit and one on a phone, and never scrolls sideways: `<Cluster>{teams.map((team) => <Card key={team.id} title={team.name}>…</Card>)}</Cluster>`.
- **Reads**: `useRows`, `useRecord`, `useBreakdown`, `useFile`, all under the reader's grants, row policy and tenant.
  `useFile(resource)` gives a function from a row's key to the picture's address: `<img src={file({ id }, { thumbnail: true })} />`. In a tenant App the file is read on the reader's session first, so the address is `undefined` until it arrives and the component draws again then; draw a placeholder meanwhile.
  Each read answers `isPending` until its first answer and `isFetching` while any answer is on its way. A refresh that fails keeps the last good rows and says so: `isStale` is true and `refreshError` holds the failure. `useRows` reads `limit` rows (20 unless said), and its `page` says `{ limit, hasMore }`; `more()` reads the next page onto the end. `page.total` is there only when the server counted one, never guessed from the rows. Each read is consistent on its own: two reads on one page are two answers, possibly a moment apart, never one snapshot.
- **Commands**: `useCommand(cmd)` with `available`, `reason`, `run` and `open`; an applied run resolves with the command's `output`. `useAction(id)` is the same handle for a fixed action (a machine's verb, `action(label, { set })`). `useGranted(cmd)` is only whether the reader may run it, the same answer as `useCommand(cmd).granted`.
- **Inputs**: `run(record, input)` takes only the command's declared inputs, by name, each as a person would type it: a `field.money({ minor: true })` input is its major amount (`255` or `'255.00'` for $255.00, never the cents the handler receives), for `run`, `open` and `prepare` alike, and an input left out takes its literal `default`. A refusal names the inputs it is about in `fields` (`{ amount: 'Enter an amount of zero or more.' }`): say each beside its control. `useField(cmd, name)` binds one input to a control of your own: its label, `text` as typed, `value` as it is sent, `error` once judged, and `inputProps` for the shell's fields; a `money` input reads what is typed with `parseMoney(text, { currency, locale })`, which answers `{ minor, major }` exactly (a figure past 2^53 stays text) or `{ problem }`. `useOptions(cmd, name)` is a reference input's choices for a picker you draw (`Typeahead` from `@mistriwork/mistri/primitives` keeps the keyboard): searched and paged as the platform's own picker reads them, the latest text winning, and `resolved` names a pick by its key, `available: false` where the reader has lost access to it.
- **Optional reads**: a read the reader may not be granted, such as a part of a page that another source serves, says `optional: true` (`useRecord(resource, key, show, { optional: true })`) and answers `refused: boolean`, typed only then. A 401 or 403 gives `refused: true` and `isError: false`, with no toast and no error boundary, so the page draws its own note; a 500 stays an error.
- **Choices of a resource**: `useOptions(resource, { where })` is the same picker for a resource the page declares in `reads`, labeled by its title column (`useOptions('region')`), under the reader's row policy. A resource the page does not read is refused as any other read is.
- **Addresses**: `useHref()` gives `home()` (the App's front door, wherever it is mounted), `signIn()`, `view(key, params?)`, `record(view, key, { tab? })` and `page(path, params?)`, the App's canonical addresses typed against its views and pages (`<a href={href.signIn()}>Sign in</a>`), so a page never writes a path by hand.
- **Saying something**: `useNotice()` returns `notice({ text, tone })`, the platform's own notice (`tone` is a `Tone`: `'neutral'`, `'info'`, `'good'`, `'warning'`, `'critical'` or `'accent'`), the one a refused verb is said in, for a page that refuses something of its own.
- **Opening a page**: `useNavigate().openPage(name, params?)` moves to one of the App's custom pages in place, with no reload, through the shell's router and the page's canonical address (`openPage('schedule', { day: '2026-11-09' })`), and `pageHref(name, params?)` gives that address for an `<a href>` whose plain click you hand to `openPage`. A page the App has no address for throws.
- **Quiet runs**: `run(record, input, { quiet: true })` returns a refusal as ever but shows no notice in the shell, for a page that says it in place: `const outcome = await book.run(slot, input, { quiet: true }); if (outcome.status === 'refused') setProblem(outcome.message);`.
- **Pointer position**: `layoutPoint(event, element)` answers `{ x, y }`, where the pointer is inside the element in the layout pixels the page styles in, however the reader's density zoom is set: `const { y } = layoutPoint(event, column.current)`. Use it instead of `getBoundingClientRect`, which `check` warns about as `component-ruler`.
- **Widgets**: a list to choose from, a menu, tabs or a dialog is a primitive's, not a `role=` written by hand: the role promises keys, focus and states the primitive keeps. `check` warns about a hand-written `role="listbox"`, `option`, `menu`, `menuitem`, `tab`, `tablist`, `dialog` or `combobox` attribute as `component-role`, naming the primitive to draw instead (`@mistriwork/mistri/primitives` provides `DropdownMenu` and `Combobox` alongside `Select`, `Listbox`, `Tabs` and `Modal`).
- **The rest**: `useNavigate`, `useComposer` (fills the page's conversation box, never sends), `useAssistant` (`open({ about: { table, id }, text })` opens the App's assistant about the record the person is on, its words in the box, never sent; `offered` says whether this reader has one: [Add an assistant](/docs/assistant/#from-a-page)), `useViewer` (`signedIn`, `account`, and `roles`, the roles the reader holds here), `useAccountProfile` (`profile`, `isPending`, `error`, `save`, `changeEmail` over `/api/auth/profile` for the signed-in reader's name and email), `useFormat`, `useMessage`, `useLook`, `useToken`, `useFlags`.

`<Loaded query={rows}>{(data) => …}</Loaded>` draws a read's three other states as the platform does: a skeleton while it loads (`loading={<Skeleton lines={3} />}` draws a placeholder shaped like the drawing instead of the bar, so nothing under it moves when it lands; `Skeleton` takes `height`, `width` and `lines`), `empty` (`{ title, body?, action? }`, or "Nothing here yet."; `empty={null}` draws nothing) for no rows, and the error with Try again. `useFormat().money(value, { currency, minor, whole, compact })` says a figure as a `money` column does, exactly, from a decimal string too; `dateTime(value, { timezone: 'America/Chicago' })` says it in that zone and `{ style: 'short' }` in the fewest characters ("3/5/26, 2:30 PM"), and `timezone` is the App's own (`ui.timezone`), for reckoning "today" as the App's day.

### Run a command

```tsx
const close = useCommand('closeTicket');
const can = close.available(ticket); // undefined while the server is asked
{
  can !== false && (
    <Button loading={can === undefined} onClick={() => close.run(ticket, { outcome: 'fixed' })}>
      Close
    </Button>
  );
}
```

- Gate a button on `available(record)`, not `granted`: `granted` is the role, `available` adds the command's `when` for this record. While it is undefined, keep the button and set `loading`, never `disabled`: a disabled button drops the reader's focus.
- `run` resolves with `{ status }`: `applied`, `refused` (in the server's words), `closed` when its form was closed unsent, or `unknown` when the answer was lost. On `unknown`, call `check()` before sending again: it asks under the same key, so the run applies at most once.
- An applied run's `output` is typed by the command's declared `output` once `mistri check` has written `mistri-commands.d.ts`, so `done.output.assigned` needs no cast. A command that declares no `output` gives `undefined`, and a public command run from a public page gives `{ reference, receipt }`.
- One key covers each run. For a command that names no record, or a public page's, a run that must survive a reload takes `{ attempt }`: a `crypto.randomUUID()` made once per intent and kept (in the address, say). The same attempt sent again is the same run.
- Inputs a command's `when` hides are neither required nor sent, as in its form.

### Review before a run

A page that shows what a run will do, and asks the person to confirm it, pins the run to the revision they read:

```tsx
const assign = page.useCommand('assign');
const review = await assign.prepare(ticket, { owner_id: 4 }); // { token, values, fresh }, or a refusal
// …the person reads review.values and confirms…
const done = await assign.run(ticket, review.values, { review });
if (done.status === 'refused' && done.code === 'stale') showTheReviewAgain();
```

- `prepare(record, input)` reads the command's starting values at the record's revision now, with `input` laid over them.
- A run with `{ review }` is sent for that revision only, once. If the record has moved since, it is refused with `code: 'stale'` and never run over a revision nobody saw. A run without a review still prepares again on its own, as before.
- `assign.reviewFresh` turns false as soon as live sync hears a change to the record, so the page can show the review again before anyone presses Run. A review is spent by its run.
- A form, a public page's command and a fixed action name no record revision, so their `prepare` answers with a refusal.

### Run an action

A resource's fixed actions (a machine's verbs, `action(label, { set })`) are not commands, so `useCommand` does not run them. `useAction` is the record page's own button, with the handle a command has:

```tsx
const start = page.useAction('startVisit'); // the page declares `actions: ['startVisit']`
{
  start.granted && (
    <Button disabled={start.reason(request) === 'unavailable'} onClick={() => start.run(request)}>
      {start.label}
    </Button>
  );
}
```

- `run(record)` writes the action's `set` to that record, found by its key. An action that says `confirm` asks first, in the platform's dialog; one that asks a reason takes it as `run(record, { reason })`. It takes no other input.
- `granted` is the record page's rule: the reader writes the resource, or a role of theirs runs this action (`roles.<role>.actions`). `available(record)` is the action's `when` for this record, and a run on a record in another state is refused in words, never skipped. The server judges the write again as it judges any update.
- A page declares its actions beside its reads, as it declares its commands. A command's id there is refused (`[page-action]`: name it in `commands`), as is an id that is no fixed action of a resource the page reads, and a `public` page declares none: a signed-out visitor holds no role to run one. They are the role's grants, not the page's authority, so adding one does not change `authority.lock`.

An id past 2^53 arrives as a string: draw it with `Value`, never through `Number()`.

### Figures

`figures` holds up to eight named aggregates: `{ from, measure, by?, whose?, query?, limit? }` on a page, `{ table, measure, by?, query?, over?, limit? }` on a dashboard. `measure` is `count`, `count distinct` and a column (`count distinct patient_id`: how many different people the rows name), or `sum`, `avg`, `min` or `max` over a column. They run on the server like a dashboard's metrics, under the reader's grants, with no SQL of the component's own. Counting `rows` instead counts at most the read's `limit`.

Without `by`, a figure is one value: a number, a string (a sum or id past 2^53) or `null` when no row matched. With `by` it is a list of `{ key, value, label? }`, biggest first, up to `limit` groups (100 by default, at most 500).

`useBreakdown(resource, { by, measure?, where?, query?, limit?, fill? })` asks the same from the module, for a figure that follows a control. On a page it may ask only for the page's `reads`. Each row is typed: its groups under the keys the server names them by (`status`, `day(created_at)`), the first measure as `value` and the rows it stands for as `count`, both numbers. `where` narrows the rows as a page's read does. A share is in points, so `format.percent(56)` says "56%". Prefer declared `figures` when the question is known; figures are checked at load, `useBreakdown` only when it runs.

A breakdown by a period (`by: 'day created_at'`) answers only the periods that hold rows. `fill` stands the others at zero, each marked `filled: true`, in the App's time zone: `'window'` over the whole window the query names (`created_at = last 30 days`, up to today), `'observed'` between the first and last period answered, `false` not at all. Without it, a count or a sum is filled over the query's window where it names one and between the periods answered where it does not. `fillBuckets(rows, { unit, from, to, timeZone, key })`, from `@mistriwork/mistri/page`, does the same for rows of your own.

### Rows, a rail and the dark ground

`ItemList` is a list of rows with no head row, where `Table` always draws one. Each `ItemRow` has a `title`, and may have a `leading` slot (an icon, an avatar, a time, a `Value`), a `tone` (a dot in the leading column, or, beside `leading`, the slot in that tone's ink), one quiet `description` under the title and `actions` at the row's end. With `href` or `onClick` the title is the row's one link or button, the whole row answers a pointer as a table's rows do, and a click inside `actions` never opens it. On a phone the action stays on the row and the description wraps. The leading slot is one column the rows share, as wide as its widest, so times and marks line up down the list. `empty` (`{ title, body?, action? }` or a node) is drawn when there are no rows; inside a `Card` it is flush with the card, not a box in a box.

A long list in runs (overdue, today, later) takes `groups`: `{ title, count?, items }` each, `key` optional. Each run's head holds the top of the room while its own rows pass beneath it, and the next run's head takes its place; the leading column is still one width down every run, and a run with no rows draws no head. A screen reader hears a list of lists, each named by its head.

```tsx
<ItemList
  ariaLabel="Work"
  groups={[
    { title: 'Overdue', count: overdue.length, items: overdue.map((task) => <ItemRow key={task.id} title={task.title} description={task.due} />) },
    { title: 'Today', count: today.length, items: today.map((task) => <ItemRow key={task.id} title={task.title} leading={task.time} />) },
  ]}
/>
```

```tsx
<ItemList ariaLabel="Open work" empty={{ title: 'Nothing open' }}>
  {tasks.map((task) => (
    <ItemRow key={task.id} title={task.title} description={task.due} onClick={() => open(task)} actions={<Button variant="ghost">Done</Button>} />
  ))}
</ItemList>
```

A `Card` takes a `count` (a quiet number beside the title) and an `action` (right-aligned in the title row): `<Card title="Open work" count={tasks.length} action={<Button variant="ghost">Add</Button>}>`. With neither, the title is the heading alone. `description` is one quiet line under the title (what the part holds), and `tone` (`good`, `warning`, `critical`, `info`, `accent`, `neutral`) says the title in that status ink.

`Beside` is a main column beside a rail. The rail is `railWidth` wide (`'20rem'` by default, never past half the box) on the `side` you name (`'end'` by default). Where its own box is under 40rem wide (or under `stackBelow`, a CSS length such as `'56rem'`) it stacks, the main first, and it never scrolls sideways: `<Beside rail={<Card title="Facts">…</Card>}>…</Beside>`.

`<Card ground="nav">`, or any element with `data-ground="nav"`, puts what is inside on the look's navigation ground: the kit's inks, hairlines and surfaces take the nav's own, so a `StatCard`, `Value`, `Meter`, `Table`, `ItemList`, `SegmentedControl` or `EmptyState` there reads in every look, light and dark, with no recipe of its own.

### SegmentedControl, Tabs or Select

| Control | Use it to | Size of the set |
| --- | --- | --- |
| `SegmentedControl` | Pick a value or filter within one view; the content below it is the same view, narrowed | 2 to 5 options |
| `Tabs` | Switch between sibling panels of content, such as a record's related lists or sections | A handful of panels, each its own content |
| `Select` | Choose from a big or open-ended set | Many options, or a list that grows |

A record page with sibling panels uses `Tabs` (or `listTabs`), never `SegmentedControl`. A page's `<Choose count>` is the exception to SegmentedControl's five: it draws up to eight counted options as the list's own tab row at a desk, the listbox past that, and the phone's own picker.

### An identity cell

A column that names a row with a second line under it (a record id with a long external id beneath) says so on the column; it does not need a hand-rolled cell:

```tsx
<Table
  ariaLabel="Orders"
  rows={rows}
  onRowClick={(row) => open(row.id)}
  columns={[{ key: 'id', label: 'Order', secondary: 'externalId', copy: true }, { key: 'status', label: 'Status' }]}
/>
```

- `secondary` is a row field's key or a function of the row (`(row) => row.externalId`): a quieter line in the body's weight that wraps, never scrolls.
- `emphasis` (`'strong'` or `'normal'`) is whether the primary line is emphasized; the first column is `'strong'` unless said. The weight is the primary line's alone, so the secondary line is never bold.
- With `onRowClick` both lines sit inside the one link, the cell's only navigation target; there are no nested links or buttons.
- `copy: true` puts a copy button beside the link, a sibling of it and never inside it.
- `avatar` puts a person's disc before the primary line: a row field's key holding the picture's address (the cell's own value is the name the initials come from), or a function of the row (`(row) => ({ name: row.owner, src: row.photo })`). The disc is decorative; the name is what a reader hears.

### A person and a record's facts

`<Person name="Ada Stone" secondary="Acme, buyer" src={photo} href="/compass/contacts/7" size="md">` is a person as a line of the page: their disc (the initials until there is a picture), their name and one quieter line. With `href` the name is the link. `size` is `sm`, `md` or `lg`; on a phone the disc is the small one and the second line wraps.

`<DescriptionList resource="lead" row={lead} fields={['status', 'owner', { label: 'Age', value: age }]} columns={2}>` lists a record's facts as terms and values. A column named by string takes its label from the App and draws its value as `Value` does; a `{ label, value }` pair is one the page worked out. It is the record page's own field grid, so a look dresses both alike, but a long value wraps instead of clipping. `columns` (1, 2 or 3) fixes the count at a desk; a phone has one.

### Which part for which job

Reach for a part before writing markup; each is token-only, so every look and theme dresses it.

| The job | The part |
| --- | --- |
| Filter rows by a word, with how many each holds | `<page.Choose param="status" count all="All" />` |
| Rows with a person and a second line | `Table` column `{ key: 'name', label: 'Lead', avatar: (r) => ({ name: r.name }), secondary: 'company' }` |
| A status, as the look says it (dot, pill, pill and dot, or quiet) | `Value`, or a `Table` column `{ resource: 'lead', column: 'status' }`; the recipe is the theme's |
| A figure over the reader's window, against the one before | `<Metric title="Won" measure="sum amount" over="close_date" window="window" previous spark />` |
| Groups as labeled bars, in the column's order | `<Breakdown title="Pipeline" by="stage" measure="sum amount" also="count" shape="bars" />` |
| Bars from numbers a page worked out | `<BreakdownList ariaLabel="By owner" format="money" items={[{ key, label, value, note }]} />` |
| Someone as a face and a name | `<Person name="Ada Stone" secondary="Acme" href={href} />` |
| A record's facts as terms and values | `<DescriptionList resource="lead" row={lead} fields={['status', { label: 'Age', value: age }]} />` |
| What happened with a record, across tables | `<Timeline from="lead" record={lead} />`, drawing the streams the record's page declares (`stream(…, { about })` reads another record's rows, such as the contact a lead became) |
| A verb offered only where it applies | `<ActionButton action="markLost" row={lead} unavailable="hide" />`; the default draws it held |
| Periods with no rows as zero | `<Chart by="week closed_at" fill="window" />`, or `fillBuckets` over rows of your own |
| A link to the front door | `useHref().home()` |

A page that draws its own head (`head: false`) keeps the space a head would stand in, so its first part is not against the top of the pane. An App that moved a page keeps the old address answering with `ui: { redirects: { '/old/:id': '/new/:id' } }`; `mistri check --routes` refuses a redirect to nowhere, a chain, or one that would hide a live route.

### Types, values and styles

- A status `Value` or `StatusDot` is drawn by the look's status recipe: `dot`, `pill`, `pill-dot` or `quiet`. An App that wants soft badges everywhere says so once, `defineTheme({ recipes: { status: 'pill' } })`, never per page. `StatusDot` takes the display rule's tone names.
- `mistri check` writes `mistri-components.d.ts`: a props type per component, named from its id (`sales-summary` is `SalesSummaryProps`), from its declared props, reads, figures and record fields.
- A value component may export `label(value)`, the word each value of the column's vocabulary is said as, in breakdowns, legends, filter chips and the CSV export. It is synchronous and returns at most 80 characters; declared `values` win.
- Style with the tokens (`var(--surface)`, `var(--ink)`, `var(--accent)`, `var(--space-1)` to `var(--space-8)`, `var(--text-xs)` to `var(--text-xl)`…) and classes named `c-<component-id>-…`. `tokens` and the `Token` type list them all; `check` warns about a `var(--…)` that is none of them and names the nearest. An imported stylesheet is scoped to the component, including one a module reached through `import()` imports.
- A stylesheet several components draw, such as a widget two pages share, may also name its classes after itself: `widgets/TicketList.css` (or `widgets/ticket-list/styles.css`) owns `c-ticket-list-…`, where no other stylesheet in the App has that name.
- A shared package that ships a stylesheet of its own, kept inside the App's directory (a workspace package), names its class name-space in its `package.json`: `"mistri": { "cssPrefix": "acme" }` (or a list). `check` then reads `.acme` and `.acme-…` in that package's stylesheets as the package's own and does not warn `[component-class]`. The App's own `package.json` is not read for this; an installed package under `node_modules` is never linted.
- On a document's sheet a value component inherits paper: the sheet says `--ink`, `--ink-muted`, `--ink-subtle`, the grounds, the lines and the status inks again for white, in every look and in dark mode, on screen and in print. Draw with those tokens, not a color of your own, and the value reads on the sheet as it does on the screen.
- `react`, `react-dom` and `@mistriwork/mistri/ui` are shared with the page, never bundled.
- Test with `@mistriwork/mistri/ui/testing` in Vitest: `renderSection(BinMap, warehouseBins, { data: fixtures<Rows>({ bin: [...] }) })` draws it over typed fixtures and records navigations and commands; `renderValue`, `renderList`, `renderPage` and `renderInput` draw the other kinds. `refused: { bin: 403 }` draws a read the reader may not make, and `await view.refresh({ data: { bin: [...] }, refused: { bin: 403 } })` changes the server under a page already drawn and asks every read again, as a live update does. A command's `outcome` (`{ status: 'unknown', message, check }`) draws an answer that never came. `forms: { enroll: { steps, draft } }` draws a form view a page opens with a draft to resume. `renderPage(page, { catalog })` takes the tables' columns (`{ tables: [{ name, columns: [{ name, type, primaryKey }] }] }`) so a reference, a picker and a card title read the declared title column as the platform does, not a guess. `view.region('Open')` (or `within(view.region('Open'))` from Testing Library) scopes a query to one titled section; it throws unless exactly one matches. `board.card('Fix pump')`, `board.move('Fix pump', 'Done')`, `calendar.event('Dock 4')` and `calendar.day('2026-11-08')` (each taking the region as a last argument to narrow it) find and drive a `<Board>` or `<Calendar>` by what a person sees. `Popover` and `Tooltip` are placed on the shell's zoom-aware ruler and drawn inside the dialog they open from, so focus comes back to the trigger and the dialog's trap holds them.

## Free-form pages

A page drawn whole by your code is one file, `pages/<path>.page.tsx`, from `@mistriwork/mistri/page`. Pages are compiled with rolldown, so `npm i -D rolldown @types/react` comes first: the first `check` after adding a page fails without it. Ladle's door list:

```tsx title="examples/apps/ladle/pages/check-in.page.tsx"
const page = definePage({
  label: 'Check-in',
  description: 'Tonight’s guests at the door: check each party in as it arrives.',
  icon: 'check-circle',
  nav: { position: 0 },
  reads: ['class_session', 'booking'],
  commands: ['checkIn'],
  params: { class: 'id' },
  component: CheckIn,
});
```

See it in the sample (`examples/apps/ladle/pages/check-in.page.tsx:24`).

- The path is the file's name, and the address: `/check-in?class=2`. `home` may name a page by its path. A page may sit in a folder, which joins its name with a dash: `pages/ops/dispatch.page.tsx` is the page `ops-dispatch` at `/ops-dispatch`, and a second file that comes to the same key (`pages/ops-dispatch.page.tsx`) is refused (`[page-file]`).
- A page's path is its address alone: a view with the same key is refused (`[page-path]`), and the page never replaces it. Rename the file, or remove the view and let the page take its place.
- `nav: { group }` is the nav group the page stands in. In a nav split into workspaces, a list stands in each: `nav: { group: ['sales', 'support'] }`. A group the nav lacks, or one named twice, is refused (`[page-nav]`).
- A page stands where it asks (`nav: { group, position }`), or where the App's own `nav` names it by its path, like a view: `nav: ['tickets', 'check-in', navGroup('desk', 'Desk', ['queue', 'tally'])]` puts the pages `check-in` second in the menu and `tally` last in the Desk group, each at its declared place among its siblings (`mistri check` writes its path into `mistri-commands.d.ts` so the types know it, and an id that is no view and no page is refused by name). Say it in one place: a page the nav names takes no `nav: { group, position }` or `nav: false` of its own (`[page-nav]`). `nav: false` keeps it out of the menu, and a `public: true` page that says nothing of `nav` stays off the signed-in menu too (it is the signed-out door's); say `nav: {}` or `nav: { group }` to put it in both. A `nav: false` page is still served at its address; another page reaches it with `pageHref('<key>')` or `openPage('<key>')`, and `mistri check` warns ([`page-unlinked`](/docs/check-codes/#page-unlinked)) when no source links to it.
- `nav.position` is an index among the App's own entries in the group (its `nav` and its features' fragments), never among other pages, so the menu does not change with what the page files are called: `position: 0` leads the group, a position past the end goes last, and a page with no position goes after the entries, in path order. Two pages asking the same place stand in path order. A page that stands at the top level counts a group as one entry.
- A command a page lists in `commands` is offered by that declaration alone: it needs no `action('…', { command })` on its table, and the role still needs the grant (an ungranted role is refused at prepare and at run). The page's command stays off the record's bar, its More menu and every row menu until an action offers it there.
- A page that must stay current needs `live: true` on the App (live sync is off unless the App asks; `dev` says so), or its own timer that calls `refresh()` for its loader and each read's `refetch()` (`page.useRows(…).refetch()`) for the rows it draws.
- `icon` is one of the built-in names, and a misspelled one is a type error in the page's file.
- `page.useRows`, `useRecord`, `useBreakdown` and `useFile` read only its `reads`; `page.useCommand` runs only its `commands` and `page.useAction` only its `actions`. Anything else is a type error, a `[page-undeclared]` problem in `check`, and refused by the server. A `show`, `query` or `sort` path across a reference (`customer_id.name`) reads the table it lands on, so that table is in `reads` too: the types allow the path, and `check` refuses it when the path is written in place, `as const`, or in a `const` at the top of the module.
- `params` names the address's parameters and their kind: `'id'`, `'text'`, `'date'`, `'date-range'` (`2026-11-01..2026-11-08`, either end open) or a list of its values (`view: ['list', 'board']`); a plain list (`params: ['class']`) is text. `const [value, setValue] = page.useParam('class')` keeps state in the address and hands back `[value, setValue]`, the value already of its kind: an id is a number, past 2^53 its digits (a param named for a resource the page reads, with a text key, as a tenant's tables have, holds URL-safe text instead: `params: { vehicle: 'id' }` with `reads: ['vehicle']`); a day not on the calendar, or a value not in the list, is no value.
- A read's rows (`useRows`, and a `RecordList`'s) are typed from its `show` and the schema, plus the resource's key column or columns, which both always carry: a key column (`row.id` where the key is `id`) is there, and typed, without `show` naming it. Any other column `show` leaves out is a type error. Name the key in `show` only to draw it. A `RecordList` that takes its resource from an enclosing `Scope` still carries the key, but its type cannot name the resource, so the key is not typed there: give the `RecordList` its own `from` to type it. `where` is its condition as an object keyed by the columns (`{ status: ['booked', 'waiting'], party_size: { gt: 1 }, paid_on: null }`), the same condition the query language says; the server refuses a column or operator it does not know. `query` still takes the language's text or a segment's name.
- `<Scope from where>` says a condition once: every block inside reads under it, and a Scope inside another narrows it. `<RecordList from where show sort limit empty>{(row) => …}</RecordList>` draws a row each, says its loading, empty, failed and refused states, and "Showing the first 20." when its `limit` cut the rows short.
- `forms` names the form views the page opens (a view whose `command` makes it a form). `page.useForm('apply')` reads the form's draft as the form itself resumes it (`dirty`, `saved`, `step`, `expiresAt`), so the page can say "Continue your application"; `open(input, { at })` opens it filled with its command's inputs (typed by name) and, for a draft, at a step it has reached; `goTo(step)` and `startOver()` drive the form itself, and `outcome` says how it last closed. The server still judges every submit.
- `<CommandButton command row />` and `<ActionButton action row />` (a command that names no row, `targets: 'none'`, takes none: `<CommandButton command />`) are hidden where the reader is not granted them, held where the row's state does not allow them, busy while they run, named with the row's title ("Check in Morgan Lee"), and say the outcome aloud; `done` words it. `values` on a `CommandButton` are the command's input, as `run(row, values)` takes them.
- `@mistriwork/mistri/page` holds everything `@mistriwork/mistri/ui` does, plus the shell's own `Modal`, `Drawer`, `Popover`, `Tooltip`, `TextField`, `TextArea` (a box of several lines in the same frame), `DateField`, `DateNav` (previous, Today, next and the date field for a day or a week at a time: `step="week"`, `skip` for days not to land on, and `T` goes to today unless a box is being typed in), `Select`, `FileField` (the browser's file picker, handing the page the chosen `File` or null; with `multiple`, a `File[]` in and out), `Choices`, `Switch`, `Slider`, `Pagination` and `Avatar`. Composite views (`@mistriwork/mistri/views`), SVG charts (`@mistriwork/mistri/charts`), operational controls (`@mistriwork/mistri/primitives`) and headless behaviors (`@mistriwork/mistri/behaviors`), all Preview at 1.0, are shared once across the shell with no duplicate CSS or view code per page.
- `optionalReads: ['visit_note']` names what the page reads only where its reader may: one component on a page two roles open, showing more to the role that may see it (a visit's note to a dentist, not the front desk). An optional read is no part of who is offered the page, and is read with `optional: true` alone (`page.useRows('visit_note', { optional: true })`, a type error without it): for a reader whose role is not granted the table it says `refused: true` and nothing is asked of the server, which refuses that read itself before anything is read (403), with the same answer whether the table holds rows or none. Each is a resource the App declares that some role the page is offered to is granted (`[page-coverage]` otherwise), never one of `reads`, and not on a public page. A loader still reads what every reader of the page reads: it cannot name an optional read.
- A role is offered the page when it is granted every read (`roles` narrows it; `public: true` opens it within `auth.public`). `useCommand(…).granted` is false for a command the role lacks; draw its button where `available(record)` is not false. To ask whether the reader may run a command the page does not run, as an entry shown only to a role that may use it, call `useGranted(cmd)`: it writes nothing, so the command need not be in `commands`. A service role is offered a page only where the page names it.
- A `public: true` page may name `public: true` commands, and a signed-out visitor runs them through the page's own door. That door asks for the page's ticket, takes a request from the page's own origin only (never from a host that embeds it), and holds the run to the public form's rules. `run(record, input, { challenge })` passes a human check's token where `auth.challenge` names one. The applied answer's `output` is `{ reference, receipt }`, never the input, and its `message` the command's own words or else a thank-you naming the reference: show it, and `output.reference` beside it where the visitor needs it and the command's words leave it out, or go on with `useNavigate()` to a page of your own. A lost answer is `unknown`, and `check({ challenge })` asks again under the same submission. On a tenant App the run lands where its visitor's address places it, through [public intake](/docs/tenant-apps/#public-intake), which says what such a page may run.
- `authority.lock` records which pages are public, the public commands each runs, and which load; what a signed-in page reads and runs is the roles' grants, which the lock already records. `<CommandForm command="…" />` is a command's own dialog behind a button.
- `head` says the form of the page's head. `head: 'compact'` is the title alone on one line with its star, at a list's size, with no `description` under it: a working page whose controls start at once. `head: false` is a page that draws its own head: the platform's title stays for a screen reader only, so the room keeps one `h1` and the page's first element is the first thing in the pane (no band, no rule, no gap above it), and the label still names the browser tab, the crumb and the palette entry. Draw your own title as an `h2` or the kit's `<Heading>`, never a second `h1`; say the intro yourself. Absent, the page has the full head: title, star and description.
- `layout: 'bare'` takes the sidebar and the top bar away: the component owns the whole window, edge to edge (no gutter, no band), for a kiosk, a wallboard or a landing page. The title still names the tab, the crumb and the palette and stays for a screen reader as the page's one `h1`; the skip link and focus are the shell's. A bare page draws no head, so it takes no `head` (`[page-layout]`). With `public: true` it is a public landing page, held to `auth.public` as any public page is. With no sidebar there is no way out but the page's own links, so a bare page that is not a kiosk gives the reader one.

A `loader` runs on the server for the reader and hands the component its `data`. It is exported from the commands module with `defineLoaders` and `defineLoader` (`@mistriwork/mistri/commands`); a page that names one it does not export, or one that reads past the page, fails `check` (`[page-loader]`):

```ts
export const loaders = defineLoaders({
  pickWalk: defineLoader({
    source,
    reads: ['pick_list', 'sales_order', 'warehouse'],
    async load({ db }) {
      const waiting = await db.pick_list.segment('to_pick_lists').orderBy('released_at').limit(40);
// …
      return { lists: lists.sort((a, b) => (a.shipBy ?? '\uffff').localeCompare(b.shipBy ?? '\uffff')) };
```

`reads: []` declares a loader that reads no table, such as one that hands the page its program's settings. Its `db` is read-only, holds only the tables it declares (each one the page reads too) and reads through the reader's grants, row policy and tenant. It has `params`, `viewer`, `now`, `today`, `timezone` and `signal`. As in a command, `now()` is the instant and `today()` is the date in the reader's zone (the tenant's time zone setting, then the App's `ui.timezone`, then UTC), which `timezone` names; ends after its `timeout` (`'5 seconds'` by default, at most ten) and returns at most 256 KiB of JSON. `mistri check` types `data` from what `load` returns. The page also receives `refresh()` beside `data`: it runs the loader again and draws the new result. A command the page runs, a public one included, does that itself when it commits, and so reads the page's rows again, where the command wrote a table they answer from (below), so `refresh()` is for a change the page did not make (a timer, a scan that arrived, a save somewhere else): `function Tally({ data, refresh }: PageProps<'tally'>): ReactNode`, where `'tally'` is the page's own path (`pages/tally.page.tsx`), not its loader's name; `mistri check` writes the pairing into `mistri-commands.d.ts`, and a path that has no loader does not compile. Give the component its own return type (`function PickWalk(): ReactNode`); without it TypeScript reports "'page' implicitly has type 'any'".

A page may name several loaders: `loaders: ['pickFigures']` beside, or instead of, `loader`. `data` stays the one `loader`'s result (null when only `loaders` is named); `page.useLoader('pickFigures')` reads another by name, typed from what it returns, as a read's `{ data, isPending, isError, refetch }`. `page.useLoader('asap', { enabled: office !== undefined })` asks nothing until `enabled` holds, for a page that settles a parameter after its first reads: the loader runs once, with the place the page settled on. Each has its own cache entry, loading state and refetch, so a slow one never holds the others back, and each is read again when a command the page runs commits. The server finds the name in the page's own list for the reader it projects the App for and never trusts the name alone: a loader the page does not name is refused as if it did not exist, and a `useLoader` of one it does not name is a type error and a `[page-undeclared]` problem in `check`. A tenant App's pages use them the same way, and there a page's loads arrive with the page: entering at a page's address reads its `loader` in the same request, and a named loader the page asked as it last opened in this browser, so the page draws from one wait. A loader held back with `enabled: false` as its page opens is not read ahead, and an App that declares `choose` reads none ahead.

A loader runs again when the page's address parameters move. One that says the parameters it reads, `params: ['office', 'day']`, runs again only when one of those moves, and not when another does (a picked row, a view toggle kept in the address); its `params` then holds those alone, in its types too, so a parameter it did not say is not there to read. Each is one the page keeps (`[page-loader]` otherwise). `params: []` is a loader no parameter runs again; a loader that says none runs when any moves, as before:

```ts
schedule: defineLoader({
  reads: ['visit'],
  params: ['office', 'day'],
  load: async ({ db, params }) => ({ visits: await db.visit.where({ office_id: Number(params.office), day: params.day }) }),
}),
```

After a command a page runs commits, the page reads again only what the command could have changed. The server says which tables the run wrote, and each read says which tables it answers from: a list, a count, a breakdown, a `useRows` or a `useRecord` its own table and what it reaches (the tables its references point at, its rollups' children, its computed columns' paths), a loader the tables it declares and what they reach. A read over none of the written tables is left as it is, and a command that wrote nothing reads none of them again. Whatever cannot be told is read again as before: a loader with `reads: []`, a read on a server run with `--no-live` or of a tenant App that does not say `live: true` (their reads do not say their tables), a command whose answer is a replay, every read of an App that accepts a database trigger (`triggers` on a resource: it writes rows the command's own statements did not), and every other kind of read (a command's availability, a record's history, the inbox). Two things are outside what the server can tell, and the page asks for them itself once the command settles, with `refresh()` or a read's `refetch()`: a loader whose result depends on something other than its tables (another service a command calls), and a table written by a database trigger the App does not name, where the read over it does not also reach the table the command wrote (a parent its child's trigger totals does, by the reference between them).

A loader reads as its reader, with one declared exception. `elevate: { read: ['note'] }` names tables of its `reads` the loader reads under the App's own authority, in the shape and with the meaning of [a command's `elevate`](/docs/commands/): a role the page is offered to need not be granted them, the page does not name them in its own `reads`, and what `load` reads there reaches the reader only as what it returns, so return the few values the page needs and not the rows.

```ts
nextVisit: defineLoader({
  reads: ['visit', 'note'],
  elevate: { read: ['note'] },
  // The desk reads no note: the page is handed the follow-up asks, and nothing else of them.
  load: async ({ db }) => ({ asks: (await db.note.where('follow_up != ""')).map((row) => row.follow_up) }),
}),
```

It is the App's read and nothing wider. In a tenant App it is made in the reader's own tenant and under their row scope, with only the role's grant of the table left out; a condition on another table's rows (`any`, `no`, `in`) stays on one side, elevated or not, and `.with` is not read of an elevated table. `mistri check --design` lists each elevating loader with its pages and the roles it reads above, beside the commands that elevate. It is refused where a command's is (`[loader-elevate]`): under `auth.rows: 'policy'`, where every read is the caller's rows; on a public page and on a surface; on a page a platform role is offered; and over a resource that audits its reads, which a command's read records and a loader's would not. Without `elevate`, a loader that reads a table its page does not is refused by `check`, and one its reader cannot read is refused when it runs.

A loader's `db` also reads a resource's segment by name, `db.pick_list.segment('to_pick_lists')`, under the same grants, field projection and row policy, and it chains `where`, `orderBy` and `limit` as any read does. The rule that says which lists are waiting is then written once, in the resource, and the list's tab, a figure and the loader all read it. A segment that uses a rollup, a computed column, a path or `me` cannot be read in a handler, and the call says so by the segment's name.

A loader reads the App's computed columns and rollups beside a row's own with `.with(…)`: list each as `'table.name'` among `reads`, and ask for it by name. They come back as fields of each row, worked out by the same SQL the table's lists use, in the same one read, so the page does not read rows again to total them up. A name the loader did not list is refused (`mistri check` names an unknown one), and one this reader's field grant hides is refused as a list does not show it. `.with` goes with a read of rows, not a sum, a group or a page; a command's `db` has none.

```ts
reads: ['invoice', 'invoice.balance', 'invoice.open_alerts'],
async load({ db }) {
  return { rows: await db.invoice.where({ status: 'open' }).with('balance', 'open_alerts').limit(20) };
},
```

### Blocks

The platform's sections are components of `@mistriwork/mistri/page`, each taking its DSL helper's words as props and `from` for its table, one the page reads (or a `Scope`'s), and `where` beside `query`. Each loads when a page first draws it.

```tsx
<PageGrid>
  <Metric title="Open" from="ticket" where={{ status: 'open' }} width="third" />
  <Chart title="Opened" from="ticket" by="month opened_on" width="two-thirds" />
  <Panel title="This record" width="half">
    <RecordCard from="ticket" record={{ id: 7 }} />
  </Panel>
  <Tabs param="tab" tabs={[{ key: 'open', label: 'Open', content: <Rows title="Open" from="ticket" where={{ status: 'open' }} /> }]} />
</PageGrid>
```

- `<Rows title from where query show sort limit />`: a dashboard's `rows()`.
- `<Metric title from where query measure compare better format unit target over window previous spark />`: `metric()`. `over` names the date column and `window` the page param that holds the reader's pick (`params: { window: ['last-30-days', 'this-quarter'] }`), so the figure follows it as a dashboard's does; `previous` adds the change against the window before, `spark` the trend over it. A `window` that is not one of the page's params is refused by name.
- `<Chart title from by where query measure shape format unit fill … />`: `chart()`. A line or bars by a period stand its empty periods at zero (`fill`, as `useBreakdown` reads it).
- `<Breakdown title from by where query measure limit format unit shape also />`: `breakdown()`. `format="duration"` says a measure of seconds as "10h 2m", as on a dashboard. `shape="bars"` draws one labeled bar per group in the column's declared order, and `also` a second measure beside each (`also="count"` is "4 deals").
- `<RecordCard from record show />`: the record as its page shows it, its name and verbs over its fields.
- `<Timeline from record />`: the record page's timeline.
- `<Tree from parent primary />` and `<Gantt from start end primary />`: a list's `tree()` and `gantt()`.
- `<Board from by … />`, `<Calendar from date … />`, `<Gallery from image … />` and `<RecordSplit from row … />`: a list's `board()`, `calendar()`, `cards()` with an `image`, and `split()`; see [Lists as blocks](#lists-as-blocks).
- `<Assistant />`: the App's assistant, where it declares one.
- `<PageGrid>`, `<Panel title width>` and `<Tabs tabs param>`: the layout, with `width` `full`, `half`, `third` or `two-thirds`.
- `<PageHeader title description actions back />`: the head for a page that sets `head: false` and draws its own, in the platform's head markup so it reads like every other page's in every theme. `actions` is the page's verbs at the head's far end (typically `<CommandForm>` buttons), `back` is `{ label, href }`, an address of this App followed in place. It draws an `h2`: the page's one `h1` is the platform's.

A word a block does not take, or a resource the page does not read, stands as a problem note in the block's place.

A `Chart`, `Metric`, `Breakdown` or `Rows` inside a kit `Card` drops its own frame and sits on the card's padding; where the card names no title, the block's title becomes the card's head. A `Table` in a card lines up with the same padding.

### Lists as blocks

A list's presentation is a block too, drawn by the same room the list views use, so it looks the same in every look, at a desk and on a phone. Each takes the presentation's own words, `from` for one of the page's reads, and `where`, `query`, `sort`, `limit` and `label` for its question, so a page can bind them to its params.

```tsx
<Board from="ticket" by="status" primary="title" where={{ owner_id: owner }} move={['advance']} />
<Calendar from="class_session" date="starts_at" primary="title" lines={['room_id']} />
<Gallery from="vehicle" image="photo_url" primary="title" value="price" />
<RecordSplit from="ticket" row={{ primary: 'title', lines: ['unit_id'] }} detail={['title', 'status']} param="ticket" />
```

- `<Board>` moves a card only with a command or fixed action the page declares (`commands`, `actions`); `move` narrows which. A drop runs it through the command pipeline with the same rules, refusals and card placement as a list's board, and a board the page declares no move for is read. `move` names something the page does not declare, and the block stands as a problem note.
- `<Calendar>` and `<Gallery>` are read; a card or a day opens its record.
- `<Gallery>`'s `image` is a column holding an image address, or a related file resource's first file, as a list's cards take it: `image={{ from: 'product_photo', whose: 'product_id', sort: 'position' }}`.
- `<RecordSplit>` lists the rows in a queue beside the picked record's own page. `param` keeps the pick in a page param (one key column), so Back and a link keep it; without it the block holds the pick itself.

Lintel's delivery board adds the month the deliveries fell in with a `<Calendar>` over the read the page already holds:

```tsx title="examples/apps/lintel/pages/delivery-board.page.tsx"
<Calendar from="part_receipt" date="received_on" primary="part_id.name" lines={['vendor']} label="Deliveries by day" />
```

See it in the sample (`examples/apps/lintel/pages/delivery-board.page.tsx:231`).

[Page recipes](/docs/page-recipes/) has six small things built from the kit alone: a facts list, ordered progress, selected-item cards, before and after values, reveal and copy, and a printable document.

### Read the deployment

`useDeployment()` is the presentation this server gives the App: `{ name, mark, theme, locale, basePath }`, read only, never a credential or a connection setting (set per deployment under `presentation`; see [One App, several programs](/docs/build-and-deploy/#one-app-several-programs)). A page uses it to say whose program it is without a name of its own:

```tsx
function Welcome() {
  const deployment = useDeployment();
  return (
    <Stack>
      <Heading>Welcome to {deployment.name}</Heading>
      {deployment.theme && <p>Set in {deployment.theme}.</p>}
    </Stack>
  );
}
```

### Read the brand

`useBranding()` is the brand the reader sees now: `{ name, logo, accent }`. In a tenant App that lets each customer brand it, they are the current tenant's own name, logo address and accent; elsewhere they are the App's name, logo mark and accent. `logo` and `accent` are `null` where there is none.

```tsx
function Masthead() {
  const brand = useBranding();
  return (
    <Row>
      {brand.logo && <img src={brand.logo} alt="" height={24} />}
      <Heading>{brand.name}</Heading>
    </Row>
  );
}
```

### The tenant's team

`useTeam()` is the current tenant's team: `{ members, invitations, roles, canManage, read, isPending, error, invite, changeRole, remove, reissue, cancel }`. A member is `{ id, account, name, initials, email, role, you }`, an invitation `{ id, email, role, expiresAt }`; `roles` are the roles the reader may place people in. Each action returns a promise and the team is read again when it settles, so a list drawn from `members` stays current. Outside a tenant App it is an empty team with `canManage: false`.

`read` says which list `members` is, because there are two:

- `'administration'`: the reader manages the team. The list is the one the shell's own account dialogs use, so the reader's grant is exactly what those routes enforce: administration (`/api/tenant/administration/…`: `memberships` lists a tenant's members by the operation they may be changed with, `execute` replaces or revokes a membership) and invitations (`/api/tenant/invitations/…`: `targets`, `list`, and `execute` to issue, reissue or revoke), each under the signed-in account's own session context. Member and invitation rows carry the account's name and address, said from the sign-in store.
- `'names'`: the reader is a member who does not manage it. They are told each member's `name`, `initials`, `id` and `account`, and which one is `you`, over the tenant's own lease (`POST /api/team`): enough to offer "assign this to a person". `email` and `role` are empty, and nothing of an invitation, a status or an end date is read. A member the sign-in store keeps no name for has an empty `name`, never an address. At most 500 members are listed.
- `'none'`: neither answered.

`account` is the account's id, the one `useViewer().account` and a command's `actor.id` say, so it is what a pick is stored by; two members of one name are told apart by it. A command input that takes a person is [`field.member()`](/docs/commands/#inputs): its form draws this list, and the server holds the pick to the tenant's active members. `canManage` is true when the reader holds any administration or invitation grant on this tenant; the server still judges every request. `invite` and `reissue` resolve with the one-time `token` the invitee is handed, where the server returned one.

Members read each other's names unless the App says otherwise: `auth: { tenancy: { team: false } }` closes the `'names'` read for a tenant whose members must not see who else is a member, and `useTeam()` then lists the team only for a reader who manages it. It is on by default because a member already reads who changed a record in its history. It is served where the App administers its tenants' members (its tenant policy has `administration` or `invitations`), not in the platform realm, not on a support visit, and not to a bearer token of a host page.

```tsx
function Team() {
  const team = useTeam();
  const [email, setEmail] = useState('');
  return (
    <Stack>
      {team.members.map((member) => (
        <Row key={member.id}>
          <Text>{member.name || member.email}</Text>
          {team.canManage && !member.you && <Button onClick={() => team.remove(member.id)}>Remove</Button>}
        </Row>
      ))}
      {team.canManage && (
        <Row>
          <TextField label="Email" value={email} onValueChange={setEmail} />
          <Button onClick={() => team.invite(email, team.roles[0])}>Invite</Button>
        </Row>
      )}
    </Stack>
  );
}
```

A command form's field picks a person from the same list through an [input component](#options) (`kind: 'input'`, placed with the form's `inputs: { assignee: memberPicker }`): it draws the members and hands back the picked one's `account`, which the command takes as a text input. The handler decides what the id means (a row of the App's own people, `auth.me`); the framework does not check that a text value names a member.

```tsx
export default function MemberPicker({ value, onValueChange, disabled }: InputProps): ReactNode {
  const team = useTeam();
  return (
    <Select
      value={typeof value === 'string' ? value : null}
      onValueChange={(account) => onValueChange(account)}
      disabled={disabled}
      options={team.members.map((member) => ({ value: member.account, label: member.name || member.account }))}
    />
  );
}
```

### Who read a record

`useReadAudit(filters)` is the organization's read audit (`audit: { reads: true }` on a resource): `{ reads, next, more, isPending, error }`, newest first. A line is `{ id, at, actor, person, roles, membership, resource, route, command, kind, record, count }`; `filters` are `actor`, `resource`, `record`, `since`, `until` and `before` (a line's id). `more()` reads the page below onto the end of `reads`, and `next` is absent once the last line is read. It reads the route the Settings Reads room reads, so its gate is that room's: the tenant's admins, the tenant from the session. Anyone else gets the route's refusal as `error` and no lines, so check `error` before drawing an empty list as "nobody". Outside a tenant App it is empty.

```tsx
function SeenBy({ patient }: { patient: { id: number } }) {
  const audit = useReadAudit({ resource: 'patient', record: String(patient.id) });
  if (audit.error) return null;
  return (
    <Stack>
      {audit.reads.map((read) => (
        <Text key={read.id}>{read.person ?? read.actor} · {read.route} · {read.at}</Text>
      ))}
      {audit.next !== undefined && <Button onClick={audit.more}>Older</Button>}
    </Stack>
  );
}
```

### Controls bound to a param

`<Choose>`, `<Search>` and `<DateRange>` are controls whose state is a param of the page, so the address is the state: a change replaces the entry (Back leaves the page, not the last choice), a pasted link opens with it set, and the control keeps nothing of its own. They are built from the kit's segmented row, listbox, text box and calendar, so every look dresses them, and the space they take is held while their options load.

```tsx
const page = definePage({
  label: 'Orders', reads: ['order', 'region'], component: Orders,
  params: { region: 'id', status: ['open', 'shipped'], q: 'text', placed: 'date-range' },
});

<Choose param="region" from="region" sort="name" label="name" all="All regions" />  // options are rows of a read
<Choose param="status" />                                                          // options are the param's words
<Search param="q" placeholder="Find an order" />                                    // typed, then written after 300 ms
<DateRange param="placed" />                                                       // placed=2026-11-01..2026-11-08
```

- `<Choose param from where query sort limit value label name all empty count>`: with `from`, the options are that read's rows, `value` (default `id`) is what the param holds and `label` is a column path or a function of the row, as Ladle's check-in page says its classes with their start times. Without `from`, the options are the param's own words. Up to five short options are a row of segments (arrows move the choice); more, or longer words, are the house listbox. `all="Any"` adds a first choice that clears the param. `count` says how many rows each choice holds and draws the list's own tab row (up to eight choices at a desk, each said as "Working, 12"; the house listbox past that, and the phone's own picker, with the counts in the options' words): `count` alone counts the param's column on the page's read, under the Scope's other conditions, and `count={{ of: 'tickets', by: 'status', where }}` counts another resource.
- `<Search param placeholder delay>` writes what is typed after a pause, or at once on leaving the box, and puts the box as the address says when Back or a link changes it.
- `<DateRange param>` is two date fields in one `'date-range'` param; a day reaches the address once it is a whole date on the calendar, or cleared.
- `page.Choose`, `page.Search` and `page.DateRange` are the same components held to the page by the types: `param` must be a param it declared (of the kind the control keeps), `from` a read, and `value`, `label` and `sort` columns of that read. A wrong word is a type error where it is written.

### A page as a record's tab

A page whose file stands in a record's folder, `pages/<list view>/[id]/<tab>.page.tsx`, is a tab of that record's page, beside its related lists and named sections. Compass's account pipeline is `pages/accounts/[id]/pipeline.page.tsx`, at `/compass/accounts/13/pipeline`:

```tsx
const page = definePage({
  label: 'Pipeline',
  reads: ['account', 'opportunity'],
  component: Pipeline,
});

function Pipeline(): ReactNode {
  const account = page.useRecordKey('account'); // { id: 13 }, typed { readonly id: number }
  return (
    <Scope from="opportunity" where={{ account_id: account.id }}>
      …
    </Scope>
  );
}
```

- The folder names a list view the App declares (its table is the record's), and `[id]` is the record's key, whatever its columns are called. The file's name is the tab's word in the address: lowercase and dashed, and not `new` or `edit`. A page file under any other bracketed folder is refused (`[page-file]`); a folder with no brackets only groups pages, its name joined to the page's with a dash.
- `page.useRecordKey('account')` is the key of the record the tab is drawn on, typed by the table's primary key: `{ readonly id: number }`, every column of a composite key, an id past 2^53 as its digits. It is the key, not the row: `page.useRecord('account', page.useRecordKey('account'))` reads the row when the page wants its fields. Naming another resource, or calling it on a page that is not a tab, throws.
- `reads` includes the record's own resource. The tab is drawn for a role granted every read, as a page is offered; a role that may read the account but not its opportunities sees the account without the tab.
- A tab's word is one word, one tab: a word its record's page already has (a related list's title, a section's `tab`, `history`) is refused (`[page-tab]`), as is a file whose key `<view>-<tab>` is also a page's path. A tab is drawn on its table's record page from every list view, so the file's list view names only the resource it reads.
- The record's address is the tab's place, so a tab takes no `params`, `loader`, `public`, `favorite`, `head`, `layout` or `nav`. Its crumb is its record's.
- A plain `<a href>` a page writes (`useHref().page('…')`) wears the look's link color; a class of the page's own, or a kit component, overrides it. The page's own `z-index`es stay inside the page, and a `Drawer`, `Modal` or `Popover` carries the page's stylesheet with it, so its classes apply inside the layer.
- The tab joins the record's first strip of tabs (its named sections', else its related lists'), and is drawn the first time it is opened. A record whose page says nothing of `listTabs` and has such a tab draws its related lists as that strip, so the tab stands among them rather than alone under a stack (`listTabs: false` keeps them stacked). A record with no list or section to make a strip gets a one-tab strip, so the tab's place is stable when a second arrives. The palette lists a tab only as a record is open ("Pipeline — Acme Corp"), never as a top-level entry. `renderPage(page, { record: { id: 13 } })` from `@mistriwork/mistri/ui/testing` draws it on a record in a test.

### Several steps

`<Steps>` asks one command's inputs over several steps, drawn like a public form's steps: a progress bar, one question group at a time, Back and Continue. The command runs once, from the last step, whose button carries the command's label. Continue runs nothing. It checks only that step's inputs, in the browser and then on the server, with the same reader, `when`s and rules the run uses, so a problem shows on the step that asks for it.

```tsx title="examples/apps/lintel/pages/add-charge.page.tsx"
const page = definePage({
  label: 'Add a charge',
  reads: ['lease'],
  commands: ['addCharge'],
  component: AddCharge,
  params: { lease: 'id', step: ['what', 'amount'] },
});

<page.Steps
  command="addCharge"
  param="step"
  record={{ id: lease }}
  steps={[
    { id: 'what', label: 'What', title: 'What is the charge for?', inputs: ['kind', 'description'] },
    { id: 'amount', label: 'Amount', title: 'How much, and when is it due?', inputs: ['amount', 'due_on'] },
  ]}
/>;
```

- Each step names the command's inputs it asks (`inputs`), its short `label` for "Step 2 of 2: Amount", and optionally a `title`, a `lead` sentence and a `next` button word. `page.Steps` types `command` against the page's `commands`, each input against that command's inputs, and `param` against the page's params that hold words.
- The open step is the param, written in place (replace, not push), so a reload or a shared link opens the same step. What was typed stays in the page's memory between steps, never in the address or the browser's storage. A reload starts empty, so a link past a step that is not answered yet opens that step instead.
- Moving between steps announces "Step 2 of 2: Amount" and focuses the new step's heading. A refusal that names an input opens the step that asks it, announces the problem and focuses the input.
- `record` is the record the command runs on. `done` replaces the words shown after a run, and `onDone` hears it. A reader the command is not granted to sees nothing.
- `mistri check` refuses a `<Steps command>` the page does not declare (`page-undeclared`).

## Draw it like the platform

- Type by role, not by weight: `var(--type-display)`, `var(--type-list-title)` and `var(--type-record-title)` for the page's headings, `var(--heading-weight)`, and the `--text-xs` to `--text-xl` steps. Each look sets them, so the component follows it.
- Check it in grayscale in two distinct looks. Hierarchy should hold without hue.
- An App's own composition variants follow `useLook()` (`look`, `preset`, `mode`, `density`), not a prop of your own.
- A button waiting on the server is `loading`, never `disabled`.
- What the reader moves, walks or edits in place (a list to order, cards carried between lanes, a month of days) is built on [the behaviors](/docs/behaviors/), which answer the keyboard, a finger and a screen reader.

## Security

A component is deployment code, trusted like `app.ts`, running in the reader's browser under the reader's session. The server stays the boundary: every read and command is authorized per request. The page's Content-Security-Policy allows only its own origin; `ui.csp.connect` and `ui.csp.images` open exactly the origins named, recorded in `authority.lock`. Importing `@mistriwork/mistri/commands`, server code, Node modules or files outside the App is refused at compile. Signed out, a component's reads are held to `auth.public`. The only commands it runs are the `public: true` commands of a public page. A page's loader cannot write, and is run only for a page the reader may open.

## Common mistakes

- "declares custom components, which are compiled with rolldown" at start → `npm i -D rolldown @types/react` in the App's project.
- `[component-markup]` or `[component-code-from-text]` fails `check` (exit 5) → draw React children; never `innerHTML`, `eval` or a string timer.
- `[component-color]`, `[component-radius]` or `[component-class]` warnings → use a token (`var(--accent)`, `var(--radius)`) and name classes `c-<id>-…`, so every look dresses it.
- A write from `fetch` is refused, or `useCommand` says a record's command is not granted though the role holds it → run the App's command with `useCommand`, which checks the grant, the record's revision and the command's `when`, and reach it through one of the resource's `actions`; one only the component runs takes `header: false`, which keeps it out of the record's bar, its More menu and every row menu.

## Related

- [Choose a building block](/docs/choose/): the built-ins to rule out first.
- [The general path](/docs/general-path/): Ladle's free-form page beside a host's own server and React app.
- [Component showcase](/components/): the kit and example components in every look.
- [Commands](/docs/commands/): what `useCommand` runs, and how it refuses.
- [Looks](/docs/looks/): the tokens a component draws with.
