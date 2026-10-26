# Acceptance: the per-page rubric

A page is done when its pictures pass, not when its code looks right. Answer
every check below yes or no for the page type; a no is fixed before the next page.

1. `npx @mistriwork/mistri shot --app . <route> --text` answers the checks about words,
   columns, counts and actions without a picture.
2. For layout, `npx @mistriwork/mistri shot --app . <route> --both` (`--as <role>` signed
   in, `--full` the whole page); open both PNGs beside the worked example's
   screenshot, whose path `mistri docs compose-record-page` (and the other
   `compose-*` topics) prints. On a phone, shoot 320 wide too:
   `npx @mistriwork/mistri shot --app . <route> --phone --width 320`.
3. `npx @mistriwork/mistri check --app . --design --brief` prints nothing the page could
   fix (`mistri docs design`).

The checks are `mistri docs build-with-an-agent`'s; a test keeps them identical.

**Record page** — worked example Lintel's repair,
[lintel/pages/maintenance_request.ts:12](../../../examples/apps/lintel/pages/maintenance_request.ts#L12) (`page('maintenance_request', …)`)
- The name is words (not "Visit #12" or a bare code), with the state beside it.
- Three or four facts under the name, with units; none repeats the name.
- The figures share one row; no card wraps alone.
- Child lists are tabs; no column is cut and the status is visible.
- The aside holds the parent's card, the current child and a property rail,
  nothing wider than two columns.
- On a phone, the main work comes before the aside.
- The filled button is the forward verb; destructive verbs come last.

**Form** — worked example Tick's New task,
[tick/app.ts:36](../../../examples/apps/tick/app.ts#L36) (the task's `form`)
- A sentence under the heading says what a new record is for.
- Fields sit in groups named by nouns, none longer than seven.
- Every required field starts filled or is plainly the reader's to fill;
  created-on dates start today.
- Choices read as words, references as names.
- Long text has a box of several lines; a dependent picker offers only the
  chosen parent's records.
- Add and Cancel sit together at the end.

**Overview page** — worked example Lintel's home,
[lintel/pages/unit.ts:12](../../../examples/apps/lintel/pages/unit.ts#L12) (`page('unit', …)`)
- The name appears once, with its avatar or mark.
- A row of three to five figures, each with its unit or word.
- A chart of activity in time order, no taller than it needs.
- Lists of what it made, every column readable; an empty one is left out.
- No aside half empty beside a long main column.

**List** — worked example Lintel's repairs,
[lintel/views.ts:143](../../../examples/apps/lintel/views.ts#L143) (`repairs`)
- The first column names the row; no raw id, and a reference reads by name.
- Four to seven columns fit at 1280 wide without cutting the status.
- Tabs are counted, in working order, All last.
- Money has its currency, states are a tone and a word, due dates say how far.
- The filters are the ways it is narrowed (a rail for three or more).
- On a phone the rows read without a sideways scroll.

**Dashboard** — worked example Lintel's Today,
[lintel/dashboards.ts:8](../../../examples/apps/lintel/dashboards.ts#L8) (`dashboard('Today', …)`)
- The first row is three or four figures of one width.
- Every figure says its window; a compared one says against what.
- Charts run in time order with readable axes.
- A chart has one measure per axis, at most four colors, a legend where
  color means something, and its categories in their fixed order.
- A breakdown's words are words, and its total matches the figure it divides.
- The page ends where its content ends.

**Navigation and shell** — worked example Lintel's side menu,
[lintel/navigation.ts:15](../../../examples/apps/lintel/navigation.ts#L15) (`navGroup`)
- A look chosen for the work and written in `ui.theme`, and a mark beside the
  App's name.
- At most seven top-level entries; groups named by the work; a section used
  rarely starts folded.
- Every entry has an icon of what it lists; counts beside the lists.
- Home is the page a person starts the day on.
- The folded rail and the phone menu still reach every entry.

**Before calling it done** — the whole App, once every page passes
- The look was chosen on purpose (Lumen, Mono, Sage or a theme of the App's
  own), and a theme of its own passes `mistri check`.
- Home is a dashboard a person starts the day on.
- Status, money, people and dates are drawn (a tone, a currency, an avatar, a
  relative date); no raw code, id or timestamp is printed anywhere.
- The menu is grouped by the work, with rarely used sections folded.
- No page scrolls sideways on a phone, at 390 and at 320 wide.
- Every chart passes the color check: the look's own colors in order, a
  custom theme's validated for color-vision deficiency, no color by position alone.
- Nothing jumps after the first paint: reload a page and watch its first second.
- Every list and section that can be empty says what belongs there.
- `mistri check --app .` exits 0 (typecheck and validation), and
  `check --design` has nothing left to fix.
- `mistri grade` reports no error: it measures what this list can be
  measured on, every page at a desk, on a phone and in the dark.
