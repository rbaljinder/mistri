# A build step and a front-end stack for app mode — assessment

Date: 2026-09-04. The question: app mode is becoming the product. Should it
get a compile step, and if so which stack — Vitest, React with TanStack, the
OXC toolchain (Oxlint, Oxfmt, Rolldown, Vite+)? This is the case for and
against, and a recommendation with an order.

## What is actually at stake

Two different "no build step" promises are tangled together, and only one
of them is load-bearing.

- **The user has no build step.** `npx tablewalk mydb.sqlite` runs; the
  desktop app runs; the container runs. This is the product's pitch and it
  must stay true.
- **The repository has no client build step.** `dist/client` is a verbatim
  copy of `src/client`; the file the browser runs is the file in git.

The second is a development convenience the repo already half-abandoned:
the server is TypeScript compiled by `tsc` at `npm run build`, so the
published tarball is already a build output. A client bundle produced at
the same moment changes nothing for a user. What it changes is the
repository's shape: three bespoke scripts (`check-client-imports`,
`check-client-types`, `check-client-geometry`) and the "mirrors" pattern
(shared helpers re-declared in the client and held equal by a test) exist
only because the client cannot import `src/shared/*.ts`. CLAUDE.md says so
itself: "If you ever add a client build step, these three go away."

So the honest framing is not "build step or not" but "what does the client
import, and who compiles it".

## The stack the repo has today, honestly

- **~30k lines of hand-written ES modules**, one `el()` helper, no
  framework, one mutable `state`, a navigation stack, seams for app mode.
  It is disciplined and it works; the reviews found no XSS, real
  accessibility, and a design system with tokens and motion doctrine.
- **The costs are showing.** Every state change rebuilds `#content` (the
  `refocus` helper exists to paper over it). There is no `AbortController`;
  staleness is handled four ways. Giant functions (`boot` 390 lines,
  `renderAppList` 376, `sectionRow` 358). New controls — the record picker,
  the New drawer, the sign-in screen — each hand-roll focus, keyboard and
  positioning that a component model would give once. Client unit tests
  need a DOM stub because modules touch `document` at import time.
- **App mode is where the surface is growing**: dashboards, pickers,
  drawers, actions, forms, sign-in, and next roles, share links, computed
  fields, batched dashboard fetches. This is the part that looks like an
  application, and it is the part hand-rolled DOM is worst at.

## Options

### 1. Keep buildless everywhere

Cost: zero migration. Benefit: the file in git is the file that runs;
`view-source` is the documentation. Against: every new app-mode surface
pays the framework tax by hand, third-party client libraries are
unusable (no bundler means no npm on the client), and the mirrors test
keeps growing. **Recommended only if app mode stops growing**, which is
the opposite of the direction.

### 2. Bundle the existing client at publish time, no framework

Add Vite (or Vite+ when it is out of beta) with the existing modules as
input. Nothing is rewritten. Gains immediately: the client imports
`src/shared/*.ts` directly and the mirrors pattern and its three scripts
are deleted; TypeScript in the client for real, not JSDoc; a dev server
with HMR; the ability to `import` an npm package in the client. The user
still gets a built `dist/`. Cost: one config file and ~a day of moving the
checks. **This is the step to take first, whatever else is decided.** It
carries no risk to the product and removes the largest source of drift.

### 3. React + TanStack for app mode, the workbench stays

Draw the line the product already draws: the workbench (explorer, SQL,
diagram, page builder) stays as it is; app mode — lists, pages,
dashboards, forms, sign-in — is rebuilt as a React tree mounted in
`#content` when an app is on. The two share the API, the query language,
the design tokens and the CSS.

- **TanStack Router**: typed routes replace `deeplink.js`'s hand parser
  for the app half; the `!new` tab-slot trick becomes a real route; search
  params carry windows and picks. Loaders replace the ad-hoc "fetch after
  paint, check staleness" pattern.
- **TanStack Query**: replaces `api()` calls scattered through render
  functions with cached, deduplicated, cancellable queries; the dashboard's
  fifteen requests per paint become fifteen cached queries that refetch
  only what a pick changes — which is the P4-3 backlog item, solved by
  adoption rather than by writing a batch endpoint.
- **TanStack Table**: the app-mode grid (sorting, pinning, virtual rows,
  column labels) is mostly what `table.js` and `virtual.js` do by hand.
- **TanStack Form** for the New form, actions and validation, which is
  the surface that is growing fastest.
- **React** itself, with the React Compiler, is the boring choice and the
  right one: Better Auth, TanStack, and every widget library the app
  layer might want ship React bindings first. Your own stack preference
  (Hono, TanStack, Cloudflare) points here too.

Cost: real. A parallel implementation of app mode while the workbench
stays vanilla; the design system must be ported to components without
drifting; the e2e suite is the safety net (and it is good: 145 tests,
the CRM spec covers the app surface). Benefit: every app-mode item left on
the backlog gets cheaper, and the next ten features are components rather
than functions.

### 4. Rewrite everything in React

Not recommended. The workbench is done, tested, and not where the growth
is. A rewrite spends months to arrive where the tool already is.

## The toolchain: OXC, Vite+, Vitest

- **Oxlint**: adopt now, regardless of the framework decision. The repo
  has no linter; three bespoke scripts do a linter's job. Oxlint runs in
  milliseconds, needs no config to be useful, and its type-aware rules
  (via the OXC TypeScript runner) cover what `check-client-types.mjs`
  greps for. Zero risk.
- **Oxfmt**: adopt if you want a formatter at all. The codebase has a
  consistent hand style; a formatter would reformat 57k lines in one
  commit and lose blame. Defer, or adopt only for new app-mode code.
- **Rolldown / Vite+**: Vite 8 is Rolldown underneath already, with OXC
  doing the transforms, so the plain `vite` package is the tool for option
  2 today. Vite+ (the same plus Oxlint, Vitest and a task runner in one
  binary) is still pre-1.0; nothing here needs it yet.
- **Vitest**: the unit suite is `node:test`, 1,164 tests, fast, no
  framework. Vitest buys browser-mode component tests and a watch UI.
  Adopt it **when React components exist to test**; migrating the existing
  suite to it first is churn for nothing. Playwright stays for e2e.

## What a build step does *not* solve

- The SQLite driver being synchronous on the main thread (P4-1).
- Connection pooling (P4-2), keyset pagination, the 3,000-line server
  files. These are server-side and are the next real scale work.
- Design discipline. A component model makes consistency cheaper, not
  automatic; `docs/design.md` still has to be the law.

## Recommendation, in order

1. **Now: Vite (or Vite+) as a publish-time bundle for the existing
   client, plus Oxlint.** Delete the mirrors test and the three check
   scripts; import `src/shared` directly; TypeScript in the client. One
   focused PR, no product change. This is the prerequisite for anything
   below and it pays for itself on its own.
2. **Next arc: React + TanStack for app mode only**, mounted when an app
   is on, starting with the surfaces that are still being built rather
   than the ones that are finished: the sign-in screen, the New form and
   record picker, actions, then dashboards (where Query's caching is the
   batching the backlog wanted), then lists. The workbench stays vanilla
   until there is a reason to touch it. Vitest arrives with the first
   component.
3. **Not yet: formatting the whole repo, rewriting the workbench, or
   Vite+ before it is stable.**

The line to hold throughout: `npx tablewalk` never asks a user to build
anything. Everything above happens at `npm run build`, which already
exists.

## Step 1, done (2026-09-04)

`vite.config.ts` bundles the client at `npm run build`; under tsx the
server serves `src/client` through Vite's middleware
(`packages/engine/src/server/devclient.ts`), so `npm run dev` and every test suite run
from source with nothing built. The client imports `src/shared` directly.
`test/mirrors.test.ts` and its eleven copies are gone — what remains of it
is `test/agreement.test.ts`, the client readings that are not copies.
`check-client-imports.mjs` is replaced by Oxlint's `no-undef`, which also
found a duplicated `aria-label` on the first run. The type and geometry
checks stay: one is about JSDoc, the other about a rule Oxlint cannot
express, and neither was about the build.

## Step 2, started (2026-09-04)

React 19 and TanStack Query are in; `packages/kit/src/client/components/mount.tsx` is the
crossing (one QueryClient for the page, a root per host element, vanilla
callers unchanged). The sign-in screen and the account control are the
first components, with a Vitest suite in happy-dom. The New form followed:
`NewRecord.tsx` on TanStack Form, with `Dropdown.tsx` and
`RecordPicker.tsx` (the picker's search on Query, previous results kept
while the next fetch is in flight) — same classes and roles, so the
stylesheet and the browser suite see one control; `insert.js` is now the
crossing plus the navigation the form's outcome drives. The workbench
keeps `dropdown.js`. Then record actions (`Actions.tsx`: a `when` is a
Query, a write a mutation) and the dashboard (`Dashboard.tsx` with
`dashboardModel.ts` for the pure parts): every section's fetch is a
Query, so the ops-board refresh is a refetch that changes numbers in
place — the offscreen-stage swap is gone — and a pick re-asks only the
sections it lands on. The charts and the grid inside it are still the
vanilla client's, drawn into hosts. Then the app list (`AppList.tsx` with
`appListModel.ts`): the heading, the chips, the tabs with counts on Query
and the reader's saved tabs through a read-then-write mutation, around the
vanilla filter boxes and the vanilla grid. `applist.js` is the crossing.
Then the shell, without a router: the walk in the URL is one of the tool's
own ideas (the path *is* the trail, each segment classified by schema and
grammar), and a route tree cannot express it without a new URL scheme
that would break every shared link. So the walk became something a
component can watch (`subscribeWalk` in core.js, `useWalk` in
`components/walk.ts`) and the trail (`Crumbs.tsx`) and the top bar
(`TopNav.tsx`) read it. A visual suite (`e2e/visual.spec.ts`, eight rooms
pixel for pixel) guards every move. The landing followed
(`AppLanding.tsx`: the app's screen with its cards and "Where you were",
and the home card for an app without a dashboard). What remains vanilla in
app mode is what the workbench shares: the grid, the filter boxes, the
charts, the record view, the "Your work" card.

## Step 3: one rendering model (started 2026-09-04)

The user chose to consolidate: React and TanStack across the whole
client, in tiers — shared primitives, then the workbench rooms, then the
shell itself — with the URL and the walk kept as they are. The grid went
first: `Grid.tsx` on TanStack Table (the column and row model) and
TanStack Virtual (the window arithmetic, rendered as a real table with two
spacer rows so sticky headers and Find-in-page keep working), with the
keyboard cursor (`useGridKeyboard.ts`) and the pinned columns
(`usePins.ts`) as hooks, the expanded rows on Query (`Nested.tsx`), and
the head, pager and tabs in `TableView.tsx`. The header filter menu stays
a transient vanilla surface (`thmenu.js`). The fetch and its stale guard
stay in `table.js` until the shell collapses. Pixel-identical to the
baselines; every grid spec passes unchanged. Then the record view
(`Record.tsx`): the row and the reverse-reference counts as two Queries,
the fields grouped by the layout, the rail of relationships and the child
tables under the chosen one, paged; the leaves (a value in its dress, a
reference chip, an editable field, the pending bar) still the vanilla
client's, drawn into place, because the page view shares them and moves
next. `record.js` keeps the walk's business — label, tab, crumb, address.
Then the page (`Page.tsx`, `pageModel.ts`): every section a Query landing
in its place, the `when` gate a Query, metrics as one strip, lists as a tab
strip fetched when opened, a broken section named in place, the head with
its picker on the listbox component. `page.js` keeps the definition
lookup, the root probe, the plan, the crumb, the address, the visit, and
the chooser for a page with no record yet. Then the leaves: `Value.tsx`
and `valueModel.ts` (the plain readings and the app's dress as pure
decisions the components render), `Editable.tsx` (the editor and the
pending bar over the staging store in `write.js`, which now ticks),
`DeleteButton.tsx`, `Skeleton.tsx`. The grid, the record and the page draw
components all the way down; `value.js`, `write.js`, `delete.js` and
`skeleton.js` are stores and wrappers for the surfaces still by hand. Then
the filter boxes (`FilterBoxes.tsx`: the boxes, the reference typeahead
and the workbench bar; the parent holds what was set by hand, so only a
touched box speaks), used by the app list and by the workbench's table
view through `filterbar.js`, which keeps the rules. Then the last shared
primitives: the charts (`Chart.tsx` — the line with its crosshair as state,
the donut, the spark; `chart.js` keeps only the gap filler, a rule about
time with no DOM in it), the hover peek (`Peek.tsx`: one layer on the body
listening on the document, the settle timer, the row a Query so the
cache is Query's and a re-introspection clears it by key), the peek drawer
(`PeekPanel.tsx`: the fresh row with reference names joined in, the three
ways out), and the breakdown view (`Breakdown.tsx`: head, sortable grid on
the keyboard hook, export in two scopes with `useDisclosure`, pager;
`breakdown.js` keeps the fetch, the stale guard and the globals a reply
may touch). `grid.js` is gone — its only caller was the breakdown. Then
the first workbench chrome: the export control (`Export.tsx`, the menu and
the column chooser; `export.js` keeps the serialisers and the column
memory, pure), the schema summary (`Summary.tsx`, drawn into the
`section.shape` the landing addresses as a direct child; `summary.js` is
the crossing and the "is there anything to say" decision), and the
first-run welcome screen (`Welcome.tsx`; `welcome.js` keeps the body
class, the title and the connection list). Then the saved-filter bar
(`SavedViews.tsx`, drawn into the tablist `views.js` owns; the store and
the naming stay there) and the SQL pane (`SqlPane.tsx`: the editor with the
vanilla completer attached to an uncontrolled textarea, the saved chips,
the result as the Grid component, the write confirm; `sql.js` keeps the
drafts per connection, the one host on the body and the menu and key
bindings). Then the two overlays: the command palette (`Palette.tsx`; the
ranking is `paletteModel.ts`, shared with the record picker, and the list
of everything nameable stays in `palette.js` with the Cmd+K binding and
the sidebar toggle) and the help panel (`HelpPanel.tsx`; `help.js` keeps
the example generator, the sections' text, the sample fetch and the focus
it hands back). Then the small overlays in one pass: the tour card
(`Tour.tsx`; the stops and the memory of having seen it stay in
`tour.js`), the query-history panel (`History.tsx`, drawn into the panel
`history.js` owns beside its store and ↑/↓ stepping), the diagram's export
menu (`SchemaExport.tsx`; the writers stay in `schemaexport.js`), the
agent console (`AgentConsole.tsx`, tools as a Query, the transcript as
state), and the prompt dialogs (`Prompt.tsx`; `prompt.js` keeps the
promise-shaped `promptFor`/`promptForRange` every room calls). Then the
column header's menu (`ThMenu.tsx`: what a column of each kind is
offered is a pure rule, `offersFor`; `thmenu.js` keeps the sampling round
trip and the header sort). Then connections: the top-bar picker
(`ConnectionPicker.tsx`, on the shared `Dropdown`, which grew `actions`
for re-introspection), the Connections screen (`ConnectionManager.tsx`,
the list as state refreshed from the server after every change) and the
Add/Edit form (`ConnectionDialog.tsx`: the pasted URL and the parts as two
views of one `parts` value, a typed password never echoed); `connections.js`
keeps the switch and the re-introspection, `connmanager.js` the hosts and
the server calls behind add, edit, remove and save. And preferences
(`Prefs.tsx`). Then the record layout editor (`LayoutBuilder.tsx` over a
mutable draft `template.js` still holds for the record view to read;
`FieldArranger.tsx` is the controlled arranger). Then the page builder
(`PageBuilder.tsx`: sections with their pickers in place, section drag and
field drag on the same rows, the relation menus grouped by distance;
`pagebuilder.js` keeps storage, the config emitter and the entry points,
and `arrange.js` is gone with its last caller). Then the diagram
(`Diagram.tsx` over `diagramModel.ts`, the geometry as numbers tested
without drawing: the neighbourhood's three columns, the dependency-depth
layout, the hubs a dense schema opens on; pan and zoom stay imperative
because a render per pixel is the wrong tool; `Picker.tsx` is the table
typeahead; `diagram.js` is two crossings and `picker.js` is gone). Then
the composer, the last room (`Composer.tsx` reads a store through
`useComposer` and drives its actions; `composer.js` keeps the draft, the
preview fetch with its token, storage, the URL sync and the path-aware
completion rules, and every mutation ends in one `tell()`; `dropdown.js`
goes with its last caller; the themed confirm is `prompt.js`'s
`confirmFor` over `ConfirmDialog`). Then the shell's chrome:
the sidebar (`Sidebar.tsx` over `sidebarModel.ts` — the app's nav or every
table as one computed list, the keyboard's cursor a store beside the tick
of the walk it was set at, so the skim's `.active` and the room's
`aria-current` are derived rather than toggled; `moveSidebar` flushes the
render so the row it lands on can be focused in the same keystroke), the
landings (`Landing.tsx`: the workbench's summary-beside-work-above-diagram
and the app's home card, `WorkPanel.tsx` for the work already done;
`SchemaSummary` renders its own card and `summary.js` is gone) and the
app-issues badge (`AppIssues.tsx`). `app.js` fell from 1312 lines to 869:
boot, the dispatch, the key bindings and the menu registrations. Then the dispatch
itself: the content pane is one tree (`Content.tsx`), mounted once on
`#content` and driven by the walk — nothing on the stack is a landing,
otherwise the trail and the room the top entry names, each kind branched
explicitly. Two ticks drive it: every `render()` is a paint (`core.js`
counts them and flushes synchronously, because the address gate and every
caller that reads the page straight after depend on a paint having
finished) and the room is keyed by the paint so its state and fetches
start over the way a repaint always did; a crumb correction ticks the
walk alone, and the room is left be. The rooms fetch through Query:
`TableRoom.tsx` (the run keyed by connection, line, page and an optional
refresh version, kept for no longer than the room is up — a table view is
re-asked every time it is drawn, so a write that repaints sees itself;
with `chrome` it owns the tabs, the boxes, the query bar's text and the
globals a shared result touches), `BreakdownRoom.tsx`, `PageRoom.tsx`
(four asks in a row — definition, sibling pages, the root probe, the plan —
each a Query enabled by the one before; the rootless chooser is a node
the page draws into its body rather than a function that draws into a
host) and `Rooms.tsx` (the app list with its redirect and its New button
as a component, the dashboard with its slot in the address, the record,
and the row that resolves which page it opens as). The app list and the
dashboard's list sections embed `TableRoom` instead of asking the vanilla
crossing to draw into a host; `table.js`, `record.js`, `breakdown.js`,
`skeleton.js` and `Built.tsx` are gone, `page.js`, `applist.js` and
`dashboard.js` keep only their registries and models, and `insert.js`'s
New buttons are `NewRecordButton.tsx`. `app.js` is boot: the schema, the
stores, the key bindings and the menu registrations. What remains by hand
is `core.js`'s toast, error banner and SQL pane, `menu.js`, `url.js`,
`deeplink.js` and `complete.js` for the query bar — behaviour on the
static header, not rendering.

## Step 4: a headless layer (started 2026-09-05)

The directory is `src/client/components/` now — named for what is in it.
With every surface a component, the hand-rolled keyboard contracts were
the last thing worth replacing: a listbox and a menu each owe the keyboard
a dozen behaviours (arrows, Home/End, typeahead, Escape back to the
trigger, outside click, the roles and `aria-expanded` that go with them),
and two copies of that contract is how one of them drifts. [Base UI]
(https://base-ui.com) (`@base-ui/react`) is unstyled and composes through
`render`/`className`, so it can wear the tool's own classes and the
stylesheet and the browser suite see the control they always saw. First
two: the header's ··· menu (`OverflowMenu.tsx` over `Menu`; the registry
of commands stays in `menu.js`) and the themed listbox (`Dropdown.tsx`
over `Select`, actions as items whose value is never taken). Two things
learned: a portalled popup lands behind a native `<dialog>`'s top layer,
so the list stays in place with fixed positioning; and the trigger keeps
its `button` role — Base UI's `combobox` is the other reading of the same
pattern, and every test here knows this one. The mutation spec that
proved our stale `aria-expanded` would be caught now points at the row
expander, the one this client still sets by hand. Then the dialogs: nine
of them, each opening a native `<dialog>`, listening for its close and
trapping focus by hand, now one `Modal.tsx` over `Dialog` — the scrim,
focus held and handed back, Escape and the scrim to dismiss, one
`onClose` however it closed — with the `dialog.confirm` / `.prefs` /
`.cols` rules re-keyed to the classes and a `.modal` rule saying what the
element used to say for free. Then every remaining hand-rolled menu: the
`<details>` menus (the three export menus, the page builder's pickers)
through one `DropMenu.tsx`, the column header's menu (`ThMenu.tsx`,
anchored on the header that opened it) and the top bar's group menus and
folded menu (`TopNav.tsx`, kept in the strip and kept mounted while
closed, so `#topnav [data-dash]` is always there to be asked). Items
announce as `menuitem` now, which the specs follow. Positioning under the
density zoom is the one thing to know: Floating UI measures in screen
pixels and places in layout pixels, so every positioner takes a virtual
anchor from the zoom-aware ruler and a collision boundary in the same
pixels (`anchor.ts`); a popup inside a dialog is portalled into that
dialog, so it shares its stacking context. Then the last four
vanilla overlays — the ⌘/ query modal, Find a value, Check the shape and
the write-mode confirmation — as components over Modal (`Ask.tsx`,
`FindValue.tsx`, `ShapeCheck.tsx`, `WriteConfirm.tsx`), the last two
fetching through Query. Then the typeaheads: the record picker, the
diagram's table picker and the reference filter box each walked their own
list; `Typeahead.tsx` over `Autocomplete` owns the combobox roles, the
arrows, Enter on the lit row and leaving on Tab or a click outside, while
the caller ranks and fetches the items and draws each row in its own
classes. Left as they are, on purpose: the palette (an always-open ranked
list inside a modal, not a popup under a box — Autocomplete's shape does
not fit and the keyboard it has is the one it wants), the composer's
inline completions (a textarea's caret, not a list), the tab strips
(navigation that rides the URL, not widget state), the non-modal panels
(the New drawer, help, the page builder, peek, the tour — each already a
`role="dialog"` with its own placement and its own Escape), and the peek
card (one document listener over thousands of chips, where a per-trigger
`PreviewCard` would be thousands of registrations). Base UI is the layer
for a menu, a listbox, a dialog and a typeahead; those five are not any of
them.

## Two rendering worlds, step 1: a host per row (2026-09-10)

The release plan's item 5 was written as though the explorer grid were
still vanilla. It has not been since step 3: `Grid.tsx` is the grid, on
TanStack Table, and `table.js` is gone. What was really missing was a way
*into* a row from outside the grid. A row's contents belonged to the
grid's own row model, so the only way to add anything to it was one more
prop threaded through `TableRoom`, `Rows` and `TableView` into `Grid`.
That is why the queue's selection is a list of its own rather than
something drawn on the grid.

The way in is `RowHost.tsx`. Each row the grid can identify publishes one
element, its leading cell. That is the column the expander already
occupied, so it is drawn only when the grid has an expander or when a
presentation around the grid has asked for hosts, and not a pixel moves.
The hosts go into a store keyed by the row's primary key as a string,
spelled exactly as `bulkKey` spells it. That way a selection made on the
grid and a selection made in a queue are the same set, and an id past
2^53 is never run through `Number()`. `RowHosts` gives a presentation a
scope. `useRowHosts` reads the current `Map` in a layout effect, not
through `useSyncExternalStore`, which subscribes after paint: a
decoration arrives in the same frame as its row, because grids paint
complete. `RowDecoration` portals its children into one row's host. The
grid keys its React rows by the same string, so a refetch that reorders,
adds or drops rows moves the survivors rather than redrawing them, and a
portal into a surviving row stays mounted. A row that cannot name itself
(no key, a projection that dropped a key column, a duplicate) is kept by
position and has no host. The rows a grid opens in place get a null
scope, so a nested grid never publishes into its parent's store.

The first consumer is the expander. It is declared beside the table and
portalled into each row's leading cell, and `Nested.tsx` now draws only
the button. The button, its place and its classes are unchanged, and the
visual baselines did not move. One behaviour changed on purpose: a result
without the key no longer offers an expander. The detail is fetched by the
row's key, so the triangle used to open an empty detail for rows that had
nothing to ask with. In the React tree, a portal's click does not bubble
through the row, so a control in a host is not a click that opens the
record.

This identity holds within one grid's lifetime. Sort and page are paints, and the
room is keyed by the paint (`Content.tsx`), so everything in the room
starts over, decorations included. They come back on the right rows
because they are found by key, but their local state does not survive.
Identity is kept through what happens without a paint: the in-place
refetch that follows a write (the invalidation the bulk actions send),
expanding a row, and scrolling a windowed grid.

What the next two steps now need:

- **Step 2** ("the grid becomes a renderer over a React-owned result")
  is about who owns the result, not about the grid. The pager still
  moves `state.page` and calls `render()`. The header's sort and filter
  still rewrite the walk's query through `thmenu.js`. Each of those
  paints and remounts the room. For decorations, and selection with them,
  to keep their state across sort and page, `TableRoom`'s Query has to
  outlive those walk changes: re-keyed rather than remounted, with the
  previous page kept while the next arrives. The pager and the header
  can then own their controls' state and be driven by that result.
- **Step 3** has no vanilla paint path left to weigh. The real question
  is the windowing threshold: `VIRTUAL_THRESHOLD` is 300 and page sizes
  stop at 250, so only an explicit `limit` or the SQL pane ever windows.
  Hosts exist only for the rows in view, so the load harness should
  measure an explicit large limit with a decoration on every row. The
  queue's selection moving onto the grid as a `RowHosts` decoration is
  the consumer the plan had in mind. That work belongs to the queue and
  the bulk actions, and the keys already agree.

## Two rendering worlds, step 2: the room owns its result (2026-09-10)

The room owns the result now, not the paint. `TableRoom`'s Query is keyed
by the question: the connection, the table, the line, the page's limit and
offset, the exact-count flag and a caller's refresh version. A page, a page
size, and a sort or filter from a column header are *refinements*. They
still go through the walk exactly as before: the header writes the line
with `go(…, 'replace')` and the pager moves `state.page` and paints. So the
address bar, the history, the trail and every deep link are written as they
were. The page number is still not in the link, and restoring an entry
still lands on its first page. The difference is that they paint inside
`refine()` (core.js). That adds a third tick beside the paint and the walk:
`roomVersion` moves on every paint except a refinement whose top entry is
still the same table room, meaning the same connection, depth, table and
tab. `Content.tsx` keys the explorer's room by that tick instead of by the
paint. The room stays mounted, the key moves, and the grid re-renders in
place.

While the next answer is fetched, the previous one stays on screen
(`placeholderData`, and only for the same table on the same connection).
The result carries `aria-busy`, which is the pending signal the rest of the
client already uses. Nothing dims, because data does not dance. The head's
range and the keyboard's row numbers describe the rows actually on screen:
each answer remembers the page it was asked for. The pager, meanwhile, says
straight away where the reader asked to go. Its page box is controlled now,
since it is no longer reset by a remount. A new page brings the head back
into view once it lands, because the old remount emptied the room and the
pane fell to the top on its own. A sort keeps the reader's place.

What survives a sort or a page change is now everything that lives in the
room:
- the grid's element
- the header and pager controls, with the focus on the one pressed
- the keyboard cursor
- every row decoration's state, for rows still in the result, since rows
  are keyed by their key and the hosts move with them

The expander is the first beneficiary. `Grid` prunes its open rows to the
ones still in the result instead of clearing them on every new answer.
`resetNested` refreshes the details of rows still open, in place, and drops
only the ones no longer asked for. The filter boxes are keyed by the line,
so a header filter starts them over the way the old repaint did.

Keeping the header's focus exposed a keyboard bug that predates this step.
`useGridKeyboard` took Enter from anywhere inside the table, and after a
row had been clicked, Enter on a header's sort button or on an expander
opened that row instead of pressing the button. A remount used to drop the
focus before a second Enter could land. Now a control inside the grid
answers its own Enter, and the cursor opens a row only from a cell.

What still remounts, and why:
- **Any plain paint.** A write that repaints has to re-ask and see its own
  effect, and `gcTime: 0` is still the rule. The same goes for the query
  bar, the filter boxes' Filter, a saved view, a removed chip, the
  exact-count button, the tab strip, and pinning a column. The grid reads
  pins once per column set, and the paint is what re-reads them.
- **Every step of the walk.** Another table, a record, a page, a crumb,
  Back and Forward, a connection switch.
- **App mode.** There every table is an app list, still keyed by the paint.
  `AppListRoom` owns its chips, its tabs and the queue around the grid.
  Moving it onto the room tick is the app list's own step, with the
  selection that would ride on it.

Embedded `TableRoom`s also keep their previous answer across a re-key: a
dashboard section's refresh clock and a page's chooser. So the refresh now
swaps a finished grid for a finished grid instead of passing through the
skeleton.

What step 3 needs, with the load harness:
- **The windowing threshold.** `VIRTUAL_THRESHOLD` is 300 and page sizes
  stop at 250, so only an explicit `limit` (or the SQL pane) windows.
  Measure an explicit large limit with a `RowHosts` decoration on every
  row.
- **The cost of an in-place sort.** It re-renders every row, because rows
  are not memoized and keep their elements. Measure the frame in which the
  placeholder gives way before memoizing anything.
- **The window across a refinement.** The windowed grid now keeps its
  scroller and its measured row height when sorting, where it used to
  start over. Check that a sort deep in a windowed result lands where the
  reader expects.
- **The queue's selection as a grid decoration.** It can now keep its set
  across sort and page, since the keys already agree.
