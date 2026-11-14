# @mistriwork/ui-next (experiment)

A side experiment: what the next `@mistriwork/ui` could be, drawn over
[UI SDK](https://ui-sdk.dev), Vercel Labs' library of interface behaviors
(`@ui-sdk/core`, `@ui-sdk/react`; a public beta), in place of Base UI. It began
as an aesthetic question (are a list and a record better looking this way than
the ones mistri draws today?) and became a larger one: can it stand level with
`@mistriwork/ui` part for part, and behave better?

## Where it stands

- **Level with `@mistriwork/ui`.** Every part that package exports has one
  here, read against its counterpart for what it can do and not only what it
  is called ([the table](#parity-with-mistriworkui)). Two are left out on
  purpose and one is spelled differently (the library's words are one set
  for the page, not a prop on each control).
- **Past it in behavior.** A list keeps its place, a row opens beside a list
  that still answers, the keyboard goes through the rows, columns are chosen,
  ordered and sized by the reader, a card is carried by a pointer, a finger
  or the keyboard, a form puts the reader on what went wrong, a sheet asks
  before it loses what was typed ([How it behaves](#how-it-behaves)).
- **Built to compose.** What the reader moves, edits and walks is seven UI
  SDK primitives of ui-next's own (`Sortable`, `Transfer`, `Widths`, `Scrub`,
  `Editable`, `Spans`, `Days`), and the board, the column chooser, the
  charts, the Gantt, the calendars and a day picker are each one or two of
  them with a look
  ([The behaviors](#the-behaviors-srcbehaviors)).
- **Run in a real App.** Four of Lintel's screens run on it with Lintel's
  rows and commands, at mistri's three densities, in its light and dark,
  with one real write through a form of its own
  ([In a real App](#in-a-real-app-lintel)).
- **Wears mistri's themes.** The five looks, the twelve palettes, an App's
  `defineTheme` and a reader's pick dress it through the attributes and
  tokens mistri already puts on a page, in the gallery and inside Lintel
  ([Themes](#themes)).
- **Held by** 176 tests (mistri's conformance suite against the kit, the
  behaviors by keyboard, the library, the list), axe-core with nothing to
  report over the gallery and the pages in Lintel, and scripted browser runs
  of every interaction, at a desk and a phone.
- **Not answered.** No person has used it with a keyboard, a screen reader or
  a hand on a phone; the record form mistri builds from a resource, the grid
  at scale, charts and the rest of the kit are not here; and UI SDK is a beta
  that says its API may change
  ([What it does not show](#what-it-does-not-show)).

The library (`src/`) depends on nothing of mistri's, and nothing of mistri's
depends on any of this. It is not a workspace and is never published: it lives
under `experiments/`, with its own lockfile, so no released package, root
lockfile or release gate mentions a beta. Moving it to `packages/ui-next` is
the step that would make it one of the packages a release publishes, and
belongs with the decision to adopt it.

Two folders do know mistri, on purpose. `kit/` is ui-next as a
[control kit](../../site/src/content/docs/docs/control-kits.md), the seam
`@mistriwork/ui` already has for another drawing of its controls; it reads the
slot types and the conformance suite from `packages/ui/src` in this checkout.
`in-app/` holds what was written to try it inside one of the repository's Apps:
four of Lintel's screens as pages of its own.

```sh
cd experiments/ui-next
npm install
npm run dev        # http://localhost:6020
npm run typecheck
npm test           # mistri's conformance suite against the kit, and the library's own tests
npm run build
```

## The library (`src/`)

`import { ListView, DataTable, RecordHeader, … } from '@mistriwork/ui-next'`,
and `@mistriwork/ui-next/style.css` beside `@ui-sdk/core/web.css`.

- **List.** `ListView` is a whole list room: its name and count, tabs with
  live counts, a search box, filter chips (an offer on a dashed edge until
  used, then a fact in the accent), a sortable `DataTable`, row menus that
  wait for the pointer, a selection that raises a bar of what it can do, a
  pager, and an empty state that offers the way out. How it behaves is under
  [How it behaves](#how-it-behaves).
- **Record.** `Breadcrumbs`, `RecordHeader` (kind, name, status, actions),
  `Facts`, `Stages` (a workflow as a horizontal timeline), `Stats` (figures in
  one ruled strip, a share of a whole drawn as a bar under its figure),
  `RecordSection`, `RecordLayout` with `Properties` panels
  beside it, and `Activity`.
- **Board.** `Board` is a list as lanes. A card that may stand anywhere moves
  through its menu; a card whose moves are a workflow's says its own verbs. A
  card is also carried, by a pointer, a finger or the keyboard: the lanes
  that would take it light up and name what letting go there does, and the
  rest stand back. It is the Transfer behavior with a look.
- **Behaviors.** `Sortable`, `Transfer` and `Widths`, UI SDK primitives of
  ui-next's own that other components are composed on: see
  [The behaviors](#the-behaviors-srcbehaviors).
- **Worklist.** `Worklist` is things to do, a row and a press each: what it
  is, where, and the figure it is about.
- **Forms.** One labelled field each, label over value with its hint or its
  problem under it: `TextField` (with a unit before or after), `TextAreaField`,
  `NumberField`, `MoneyField`, `SelectField` (one or several), `ComboField`,
  `DateField`, `SensitiveField`, `FileField`, `SwitchField`, `CheckField`,
  `ChoiceField` (cards), `SliderField`; and their layout, `FormGrid`,
  `FormSection` and `ActionBar`.
- **Overlays.** `Modal` and `SidePanel` (one sheet: a head, a body that
  scrolls, a foot that does not), `Confirm`, `DropMenu`, `Tip`.
- **Small parts.** `Button` (primary, default, quiet, danger; three sizes; it
  waits with a turning ring while the press it started is still running),
  `ButtonLink`, `Status` (a dot and its word), `Badge`, `Avatar`, `Tabs`,
  `Pager`, `Toaster` (a toast may carry the way back, Undo), `Skeleton`,
  `Mark`, `ValidMark`, `ProgressBar`, `HelpTip`.
- **More fields.** `MaskedField` with `masks` (phone, date, month, time, ssn,
  zip, card, digits, money, or a shape of one's own: `shaped('##-####')`),
  `YesNoField`, `CheckCardsField`, `ConsentField`, `PickList`, `Checklist`.
  Every field takes `required` (a mark, and the word for a screen reader)
  and `tip` (more about it, behind a question mark that opens on a press).
- **A form's furniture.** `StepHeader`, `ReviewList`, `Columns`.
- **A landing page's blocks.** `IconRows`, `PhotoTiles`.
- **Things that hold things.** `Carousel`, `Split` (panes the reader sizes),
  `ScrollArea`, `Popover`, and `ColumnChooser`.
- **Its own words, in one place.** Everything the library says on its own
  account (a button's name, what a screen reader is told, what an empty
  list says) is in `words.ts`, about a hundred entries, and `setWords`
  replaces any of them. A word that takes a name or a count is a function
  of it, since where a name goes in a sentence is a language's own
  business.
- **The theme.** `theme/tokens.css` says mistri's vocabulary once in
  `light-dark()` and hands it to UI SDK through the `--ui-*` names its
  stylesheet reads; `parts.css` dresses UI SDK's parts, `list.css` and
  `record.css` the components here. Every rule keys on a `data-slot` and its
  state attributes, in declared layers: `ui-sdk`, `m-tokens`, `m-parts`,
  `m-components`.

Behavior is UI SDK's throughout: tabs, menus and their checkbox items,
checkboxes, inputs, pagination, timelines, popovers, dialogs, the command
palette, the shortcuts, the text match, the pointer drag. Nothing here writes
a `role` by hand except the selection bar's `toolbar`.

### How it behaves

A better look is half of it. These are the things a reader does a hundred
times a day in a list, and what each one costs them here:

- **A chart is read three ways, and none of them is its colour.** Passing
  over a chart reads the place under the pointer: one readout with every
  series in it, the number strong and the name beside a key, so the pointer
  never has to land on a two-pixel line. The plot is one stop for the
  keyboard: arrows move along it, Home and End go to its ends, and each
  place is said (`Jul: Collected $68,150; Owed $2,350`); Enter opens what a
  press opens. And the same numbers are a table a press away. A series is
  taken out and put back from the legend, the last one stays, and taking
  one out does not repaint the rest: a colour belongs to a series, not to
  its place among those shown. Eight colours can be told apart and a ninth
  cannot, so past eight the rest are one grey sum. While a period is read
  again the last drawing stays, dimmed, and nothing jumps.
- **A month is one stop for the keyboard, and a thing is moved without a
  mouse.** `Calendar` is a grid: the day last visited is its one Tab stop,
  arrows go by day and by week, Home and End to the week's edges, Page Up
  and Down by month. Enter goes into a day, onto what it holds, and Escape
  comes back out; on a day that holds nothing Enter adds to it. A thing is
  carried to another day (the same `Transfer` the board is on, so the day
  under it lights, the days that will not take it go flat, and letting go
  anywhere else puts it back), or taken a day or a week on with Alt and an
  arrow, the keyboard going with it. A day shows its first three and a
  count that opens the rest. Where it is narrow the month is an agenda:
  the days that hold something, in order.
- **Reading down a list is one key a row.** `ListDetail` is a list and the
  one picked from it, side by side: Up and Down pick as they go and the
  detail keeps up, Enter goes into the detail and Escape comes back to the
  row. Where there is room for one, a pick turns the list to the detail
  with the way back above it, and the keyboard is put on the detail as it
  arrives and on the row again on the way back.
- **A queue has an end in sight.** `Queue` is a list worked one at a time:
  the one in hand in full, what can be done to it as buttons that each
  have a key, a count and a bar for how much is behind the reader. A verb
  does it and brings the next with the keyboard on its name; one that
  fails leaves the one in hand where it is and says why; a skipped one
  comes round again at the end.
- **A card is one stop.** `Cards` stretches the title's link over the whole
  card, so a card opens from anywhere on it and is one Tab stop; a
  picture's box has its size before the picture arrives. `Tree` is UI
  SDK's tree with a far end for a count, and remembers what was open.
- **Nothing typed in a note is lost.** `RecordTimeline` is what happened on
  a record and what was said about it, oldest first under its day, with the
  box to add to it at the end, where the newest is. A note is shown the
  moment it is sent, marked as on its way; one that does not arrive stays,
  says why, and is sent again or taken back into the box. What was typed
  and not sent is kept for the visit, so a reader called away to another
  record finds half a note where they left it. Ctrl or Cmd with Enter
  sends.
- **A note is plain text with a little shape.** `NoteField` and the
  `Composer` are a textarea with marks over it (and Ctrl or Cmd with B, I
  and K): a second press takes a mark off, a list goes on by itself on
  Enter and ends on an empty item, and what it will read as is a press
  away. `Prose` draws it as elements and never as markup, so nothing a
  note says can become a tag, and a link is followed only to http, https
  or mailto. It is not mistri's rich text, which edits in place; it is
  what a search can read and a column can hold.
- **A view is a name and Enter.** `SavedViews` keeps a list as the reader
  left it (tab, search, filters, order, columns) under a name. Its button
  says which view the list is in and, in a word, when the list has moved
  on from it, with the two things a reader then wants: update the view, or
  go back to it. A page is where a reader is in a view and not part of it.
- **A filter says what choosing it would show.** `FilterRail` is a list's
  filters down its side, every group open with a count beside each choice;
  a choice that would leave nothing steps back and is still there. A long
  group shows its first few and whatever is chosen, and is searched.
- **The palette offers what was wanted a minute ago.** `CommandPalette`
  (UI SDK's command, on Ctrl or Cmd with K) lists the last few commands
  run first while nothing is typed, and ranks everything once something
  is. `PictureGallery` opens a tile large, arrows from one picture to the
  next, and gives the keyboard back to the tile on the way out.
- **Nothing moves that the reader did not move.** Measured, not looked
  at ([Layout shift](#layout-shift)): every room loads and is used with a
  layout-shift score of 0, and the things a browser's score leaves out
  because they follow a press were measured too. A cell or a value opened
  for editing is laid over what it showed, so its row, its column and
  what is under it stay put, and what is wrong with it is a note over the
  page and not a line in it. A table lays out its own columns from the
  widest each one's words have been, so a sort, a page or a tab leaves
  every column where it is.
- **The bar and the menu are one line.** The brand, the fold, where the
  reader is, the search and the reader's own controls share a centre and
  a height, on whole pixels; the bar's two ends stand on the page's own
  gutters at any width; the bar says where the reader is (`Leasing /
  Rent roll`) and, once the page has gone under it, that it is over
  something. The menu's head and foot stay while its rooms scroll, a
  folded room with something waiting wears a dot, and `layout="top"` puts
  the menu along the bar with a group a menu under its name.
- **The page that was asked for has the keyboard.** `AppShell` is the menu,
  the bar and the page. Choosing a room from the menu puts the keyboard on
  the page that arrives, so the next Tab is in what was asked for and not
  back at the top of the menu; a room that changes while the reader is in
  the page leaves the keyboard where it is. The first stop on every page
  is a link past the menu. The menu folds to its icons (its button, or
  `[`) and stays folded across visits, each icon still named; where the
  window is narrow it is a drawer that closes on a choice. `InboxBell`
  says how many notices are new in words as well as in a dot. `SignIn`
  says what is missing, keeps what was typed when it is refused, and says
  when Caps Lock is on.
- **A value is changed where it is read, and a refused save keeps what was
  typed.** A record's value (`EditableText`, or a `Properties` item with
  `edit`) and a table's cell (a column with `edit`) open a box in their
  place on a press, Enter, F2 or simply typing. Enter keeps, Escape puts
  the value back, leaving the box keeps too. What is kept shows at once,
  marked as on its way; if the save is refused the value says why and
  holds on to what was typed, and the next press takes up from there. A
  text that fails its check never leaves the box. In a table Tab keeps and
  goes on to the next cell that can be changed, F2 from a row starts on
  its first, and a press on such a cell is the cell's and does not open
  the row.
- **Ten thousand rows cost what thirty do.** A table given a `height`
  scrolls in its own box under a head that stays, and draws only the rows
  in view (UI SDK's virtualizer): the gallery's Charges room holds 10,000
  rows in about 300 elements, 22 rows drawn at a time. The keyboard does
  not know the difference: Up, Down, Page Up and Down and Ctrl with Home
  and End reach rows that are not drawn, the row with the keyboard stays
  drawn when it is scrolled out of view, select-all and a Shift run are
  over every row, and the browser's find in page finds a row by its name
  whether it is drawn or not. A column's `total` is over every row and
  stands at the foot; `pinFirst` keeps the row's name at the leading edge
  while the rest goes sideways. Searching the 10,000 took about 140 ms and
  sorting them about 200, measured in the unbuilt gallery.
- **A week is read by the hour.** `WeekCalendar` is a column a day and a
  block a thing, from when it starts to when it ends, on the same behavior
  as the Gantt: a block is carried to another time or another day and
  pulled from its foot to last longer, snapped to a quarter of an hour;
  things at the same time stand side by side. From the keyboard Alt with
  Up or Down moves one a quarter of an hour, Alt with Shift moves its end,
  and Alt with Left or Right takes it to the day beside, the keyboard
  going with it.
- **A task is moved along its row and never off it.** `Gantt` is tasks as
  bars against a calendar: a bar is carried to move both its days or
  pulled from an end to move one, and stays in its own row wherever the
  pointer goes. The bars are one stop for the keyboard: the arrows walk
  them, Alt with an arrow moves one a day, Alt with Shift moves its last
  day, each said as it lands. Every task's days are also written beside
  its name, which stays while the calendar scrolls, so nothing is read off
  a bar's length alone.
- **A row with a problem is never dropped in silence.** `ImportDialog`
  asks the three things a reader has to decide and no more: which file,
  which of its columns is which field (matched by name where the names
  agree, so most sheets need no matching), and whether to go on once they
  have seen what would be taken. Rows that fail are counted, shown with
  their reasons by the line they have in the reader's own file, left out
  of what is taken, and handed back as a sheet of their own to put right.
  Leaving half way asks first. `toCsv` writes a cell a spreadsheet would
  run as a formula so that it is not.
- **A figure says which way it moved, and whether that is good.** A tile's
  movement is an arrow and a word as well as a colour, and the colour is
  whether it is good and not which way it went: fewer open repairs is
  green.
- **Coming back finds the list as it was left.** A list that keeps its tab,
  search, filters, order and page only in memory forgets them when the reader
  opens a row and comes back, which is what a reader of a list does most. So
  `ListView` takes where the reader stood (`initialState`) and tells every
  change (`onStateChange`), and `listStateToWords` / `listStateFromWords` say
  it as the words an address carries, in mistri's own spelling
  (`?tab=behind&building=Birchwood+Lofts&sort=-rent`). An untouched list has
  a bare address. Back, a reload and a pasted link all land where the reader
  was.
- **A row opens beside the list, and the list stays live.** `SidePanel` with
  `beside` dims nothing and traps nothing where the window has room: the
  rows still answer, so pressing another row changes what the panel shows,
  and the list steps aside by the panel's width so its last columns, its
  pager and its selection bar stay in reach. Comparing ten rows is ten
  presses and no closing. On a phone the panel is the whole screen, so there
  it is the ordinary one, with its dim.
- **The keyboard goes through the rows.** `/` puts the keyboard in the search
  box. `J` and `K` (or Up and Down from a row) walk the rows and off the end
  of a page onto the next; Enter opens the row; `X` selects it. With a panel
  open, `J` and `K` step the panel through the rows as they stand, and Escape
  closes it from wherever the keyboard is. The keys are said once, under the
  list, to a reader who has them (a pointer that hovers, a window with room),
  and they stand down while a dialog, a menu or a text box has the keyboard.
- **A run of rows is one press and a Shift-press.** As in every list a
  reader has used.
- **The search shows what it matched.** A cell wraps its text in `Mark`, and
  the part the search found is tinted in the row, so a reader sees why a row
  is still there.
- **A page waits in its own shape.** `loading` on `ListView`, `Stats`,
  `Board` and `Worklist` draws the head, the lanes and the labels at once
  with quiet bars where the figures and rows will be, so nothing jumps when
  they arrive. The light across a bar stops for a reader who asked for less
  motion.
- **A card is carried, and the board says where it may go.** The card left
  behind fades to a place-holder, the copy lifts and tilts, the lanes that
  would take it take an edge in the accent and name what letting go there
  does ("Book a visit"), and the others stand back. A mouse or a pen carries
  a card from anywhere on it. A finger scrolls the board, so it carries a
  card by its grip, which is also what the keyboard picks one up by: Space,
  then Left and Right between lanes, Space to let go, Escape to put it back,
  each step read out. For a card with verbs, carrying is a second way to say
  a verb and never a way around one. A press that does not move still opens
  the card. And nothing lands where nothing is lit: carried over a lane that
  would not take it, or off the board, the card is shown back where it came
  from and letting go leaves it there.
- **The table shows the columns the reader wants, in their order.** A
  Columns control in the list's bar: tick a column to show it, carry it by
  its grip or its row to move it, with a pointer or the keyboard, and the
  table follows as it is done, with no Apply. What was chosen is part of the
  list's place (`?cols=code,status,rent`), so it survives Back and travels in
  a link, and Reset puts the table back as it was given.
- **A column is as wide as the reader makes it.** The bar at a column's far
  edge is dragged, with the column following and Escape putting it back; from
  the keyboard it is Alt with Left and Right on the column's header, so a
  table gains no Tab stops for it. A double-click on the bar, or Alt with
  Backspace, gives the column back the width its words ask for.
- **A masked field leaves the caret where the reader is typing.** Editing
  the middle of a phone or a card number does not throw the caret to the
  end; a Backspace that lands on a bracket or a space takes the digit before
  it, not punctuation the field would only draw again; and a value that is
  whole says so with a tick. The form is sent the digits.
- **A form says what went wrong, where, and puts the reader there.**
  `useForm` holds a set of named fields: the answers are checked before
  they are sent, whatever takes them may still refuse, and both are shown
  the same way. Each problem stands on its field, one line over the form
  says how many there are with each a press from its field
  (`FormProblems`), the keyboard is put on the first, and a field's problem
  goes the moment that field is changed. While the answers are being taken
  the form is busy, its button turns its ring, and a second Enter sends
  nothing twice. It knows nothing of where the answers go.
- **A form can be drawn from a description of it.** `SchemaForm` takes what
  a page asks (each question a `kind`, its rule, whether it is asked given
  the answers so far) and is the rest. A question that depends on an answer
  comes and goes as that answer changes, and one that is not asked is not
  checked and is not sent. Questions may be in steps: a step is checked
  when the reader leaves it forward, Back never loses an answer, and
  arriving on a step puts the keyboard on its name so the step is read out.
  With `review`, the last thing before sending is every answer said back
  the way it was typed (a phone in its brackets, money as money), each with
  the way back to change it. What the taker refuses takes the form to the
  step of the first field refused and puts the keyboard there.
- **A sheet asks before it loses what was typed, in its own foot.** `Modal`
  and `SidePanel` take `unsaved`. Escape, a press outside and the cross
  then do not close it: the sheet's foot becomes the question (Discard
  what you entered?), Keep editing has the keyboard, and what was typed
  stays in view behind it. Not a second dialog over the first.
- **A field says how it is going.** A text field with a limit counts what is
  typed and tells a screen reader only as the limit comes near; `clearable`
  puts a cross at its end that empties it and gives the keyboard back;
  `valid` marks a value that was found; a text area grows with what is
  typed; `reserve` keeps a line for a problem so the form does not jump.
- **A date has bounds, and a foot.** `min`, `max` and `unavailable` (weekends,
  booked days) are refused typed as well as picked, and the calendar's foot
  holds Today and Clear. Today stands back when today may not be chosen.
- **A file that is turned away is named, with the reason.** `maxSize`,
  `maxFiles` and `accept` are held, each file refused is said under the
  field (too large, the wrong kind, one too many), the zone says while a
  file is held over it whether it would be taken, and a picture shows as
  one in the list of what was chosen.
- **A lookup says where it stands.** `LookupField` searches as the reader
  types: it waits for a pause, drops a search that was overtaken, keeps
  what it found in view while the next is on its way, says Searching, how
  many it found or that it could not look, and offers what was typed as a
  new one where the caller can make one.
- **A secret can be taken without being shown.** `SensitiveField` with
  `copyable` puts the value on the clipboard, and says Copied only once the
  clipboard has it.
- **A choice with a limit says so before it is reached.** `CheckCardsField`
  with `max` counts down as cards are ticked, and at the limit the unticked
  cards stand back, rather than refusing a press after the fact.
- **What was done is said, with the way back.** A step taken on the board is
  taken at once and its toast carries Undo: no "are you sure" before a thing
  Undo puts right.
- **A press that is still running shows it.** A button whose handler returns
  a promise holds its width and turns a ring until it settles, and ignores a
  second press.

## The behaviors (`src/behaviors/`)

What the reader moves is built the way UI SDK builds its own parts, so that a
component is composed on a behavior and not on pointer events. Each is a
primitive made with `definePrimitive` from the behaviors `@ui-sdk/core` ships
(`createReorder`, `createTransfer`, `createRovingFocus`, `createChange`),
given React parts with `createParts`:

| Primitive  | Parts                                                        | What a composer gets                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sortable` | `Sortable`, `SortableItem`, `SortableHandle`                 | An order as a value with a change that can be cancelled or controlled; a drag; Space, the arrows, Home and End, Escape; the pick-up, each move and the drop read out; `data-sorting`, `data-grabbed`, `data-dragging`. Vertical, horizontal or a grid. Items that are themselves picked up (a listbox of options), or items with controls of their own picked up by a handle (a list).                                                                         |
| `editable` | `Editable`, `EditableValue`, `EditableInput`                 | Values edited where they stand, over the inline edit `@ui-sdk/core` ships: one at a time, started by Enter, F2, typing or a press, kept by Enter, Tab or leaving, put back by Escape; `onCommit` may refuse a text and keep the box; Tab goes on to the next value in the page's order. Under `EditableText` and the table's cells.                                                                                                                            |
| `spans`    | `Spans`, `SpansTrack`, `SpansSpan`                           | Stretches along tracks, over the spans `@ui-sdk/core` ships: a value with a change, a stretch carried along its track or lengthened from an edge marked `data-span-edge`, snapped to a step, with a least length. The keyboard is this primitive's own so a walking key never moves anything: one stop, arrows walk, Alt with an arrow moves, Alt with Shift lengthens. `stay` holds a stretch to its track. Under `Gantt` (across) and `WeekCalendar` (down). |
| `days` | `Days`, `DaysDay` | A month of days as a grid a keyboard walks: the day the keyboard is on and the month in view are values with changes, one stop in the Tab order, arrows by day and week, Home and End, Page Up and Down across months with the keyboard following, a first and last day, days that cannot be had, Enter or a press to pick. A day can be another part's element, so a calendar's day is one element that is also a place things are carried to | `Calendar` (the month, with `Transfer`), `DayPicker` (a day chosen from a month laid open, each day able to say something of itself) |
| `scrub`    | `Scrub`, `ScrubTrack`                                        | One position out of several along a line, read by passing over it: a value with a change (so two charts can read the same month), by pointer, finger or arrows, Home, End, Escape, and a pick by press or Enter. The track is a slider whose value text is what is at each place. `band` or `point` scale, either orientation, right to left. Under `Chart`; fit for a timeline or a heat strip.                                                               |
| `transfer` | `Transfer`, `TransferList`, `TransferItem`, `TransferHandle` | Lists as one value; a carry between them by pointer, finger (the handle) or keys; `accepts(key, list)`; and while something is carried, which lists take it, refuse it and which it is over, as `data-takes`, `data-refuses`, `data-over` and as state a list's renderer reads.                                                                                                                                                                                |
| `widths`   | `Widths`, `WidthsColumn`, `WidthsHandle`                     | Column widths as a value that holds only what the reader changed; a bar at a column's edge dragged with a draft that Escape puts back; Alt with the arrows from the column's own header, so the bars add no Tab stops; a double-click or Alt with Backspace to give a width back; each change read out. `data-sized`, `data-sizing`.                                                                                                                           |

```tsx
<Sortable by="handle" value={order} onValueChange={setOrder} aria-label="Columns">
  {(id) => (
    <SortableItem value={id}>
      <SortableHandle aria-label={`Move ${names[id]}`} />
      <Checkbox … /> {names[id]}
    </SortableItem>
  )}
</Sortable>
```

Composed on them so far:

- `Board` is `Transfer` with lanes, cards and what a move means (a verb, or a
  lane). It lost about a hundred lines of pointer code when it moved onto
  the behavior and gained the keyboard, the finger and the screen reader.
- `ColumnChooser` is `Sortable` with a tick in each item.
- `DataTable` is a table whose head cells are `WidthsColumn`s: every list
  has columns the reader can size, and a column made narrower than its
  words cuts them with an ellipsis.
- `PickList` is `Transfer` with two lists: some of many, in an order, each
  item crossing by being carried or by the arrow at its end, with a limit
  the chosen side holds to.
- `Checklist` is `Sortable` with a tick: things to do, in the order they
  will be done.

The last two are about a hundred lines between them and have no pointer
handler, key handler or announcement of their own, which is the point of
building the behaviors first.

Three things the behaviors add to what UI SDK ships, each found by using it:

- **Nothing lands where nothing is lit.** `createTransfer` leaves a carried
  item in the last list that would take it, wherever the pointer goes next,
  so letting go over a list that refuses it, or over nothing, still moves
  it. `transfer` tracks a pointer that has gone astray, shows the item back
  where it came from, and refuses the drop.
- **A press on a link inside an item still opens it.** Following a press
  takes the pointer for the item, so the click that ends a press which
  never moved arrives at the item, not at the link that was pressed. The
  item hands it on.
- **A drag answers for a zoomed page.** mistri zooms its root, and under a
  zoom the pointer's pixels and the stylesheet's are not the same pixels.
  The carried copy is taken back out of the zoom and what it holds zoomed
  again; a dragged row has only the pointer's part of its offset put right;
  a column's edge divides the pointer's travel. The table under
  [What it does not show](#what-it-does-not-show) has the numbers.
- **A change's reason is one of UI SDK's own words.** UI SDK holds a change's
  event to a vocabulary of reasons in development (`drag` with a pointer,
  `move-key` with a key) and warns at a word it does not list. A width
  given back is said as its `clear-press`, not a word of our own.
- **The carried copy is dressed.** UI SDK draws the copy on the page's top
  layer. Where a host scopes a page's styles to the page (mistri does), the
  copy arrives bare, so each part's look is written onto it as it leaves
  (`dress.ts`). A pseudo-element cannot be written that way.

They are held by `kit/behaviors.test.tsx`, `kit/library.test.tsx` and
`kit/list.test.tsx`, `kit/charts.test.tsx`, `kit/calendar.test.tsx`, `kit/presentations.test.tsx`, `kit/notes.test.tsx`, `kit/workbench.test.tsx`, `kit/shell.test.tsx`, `kit/editable.test.tsx`, `kit/scale.test.tsx`, `kit/gantt.test.tsx`, `kit/importing.test.tsx` and `kit/week.test.tsx` (the keyboard, in happy-dom: 164 tests with the kit's
conformance run) and were run with a pointer, and a scripted finger, in a
real browser, in the gallery and in Lintel.

## The kit (`kit/`): ui-next as a drop-in

`@mistriwork/ui` lets an App replace its controls slot by slot
(`defineUiKit`, `packages/ui/src/UiKit.tsx`): thirty slots, each typed by the
props the platform already draws it with, and a conformance suite
(`uiKitConformance`) that holds a kit to what mistri's screens rely on, by role
and by name. `kit/index.tsx` fills all thirty over UI SDK:

```ts
// an App's ui/kit.tsx
export { default } from '@mistriwork/ui-next/kit';
```

|                    |                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------- |
| Slots filled       | 30 of 30, typed against `UiKitSlots` (`npm run typecheck`)                                   |
| `uiKitConformance` | 24 of 24 (`npm test`, happy-dom); the same suite passes 24 of 24 with no kit, as the control |
| In Chromium        | every control on the drop-in page opened, chosen from and closed, with no page error         |

The kit's stylesheet brings the library's two theme sheets
(`theme/bridge.css`, `theme/looks.css`), so an App's theme reaches the
kit's controls and any page drawn with the library ([Themes](#themes)).
`kit/bridge.css` is the older, opt-in switch for a page that wears no theme
and still wants the App's tokens (`data-m-look="app"`); the drop-in page
has a switch for it.

What it took, that the suite or a browser found:

- **A listbox's button is a button.** UI SDK's select trigger calls itself a
  combobox; mistri's contract (and its own Dropdown, over Base UI) says button.
  The role is said on the element handed to `render`, the one place a part's
  role gives way.
- **A popup inside a dialog.** The suite wants it drawn inside the dialog that
  opened it. UI SDK draws in place in the top layer, and takes a `container`
  where it has to move one; the kit names the enclosing dialog.
- **Nothing matches.** UI SDK's autocomplete popup calls itself a listbox when
  it holds no list; mistri wants a status and no empty listbox. The kit draws
  the message itself.
- **A row chosen by key.** mistri's Typeahead keeps the text the caller's and
  hears one `onPick`; UI SDK fills the box with the row's label. The kit
  cancels the fill and picks the row in hand.
- **Focus back from a modal that is gone.** mistri's Modal is unmounted the
  moment `onClose` is heard, before UI SDK hands the focus back. happy-dom did
  not show this; Chromium did. The kit remembers what had the focus.
- **The caret, kept.** mistri's masks are a pair of functions that know
  nothing of the caret, and its own `MaskedField` leaves the caret at the
  end whenever a value is rewritten: on the drop-in page, a digit typed
  into the middle of `678-678-6781` under mistri's own control leaves the
  caret at 12 of 12, and under the kit at 7. The kit's box counts the
  digits before the caret and puts it back after as many, for any mask
  whose kept value is digits. The suite still passes 24 of 24.
- **Change details.** UI SDK names seven hands (mouse, touch, pen, keyboard,
  virtual, programmatic, agent); mistri's callers read three. `kit/told.ts`
  says each change in mistri's words.

## In a real App: Lintel

`scripts/try-in-app.mjs` copies one of the repository's Apps into `.app/`
(not committed), installs the kit in the copy as an App installs any kit
(`uiKit: './ui/kit.tsx'`) and, for Lintel, adds two pages drawn whole by
ui-next (`in-app/lintel/pages`). The App it copies is not touched.

```sh
# from the repository root, on its own install (Node 24)
node experiments/ui-next/scripts/try-in-app.mjs            # writes experiments/ui-next/.app/lintel
# then seed and serve the copy as examples/apps/lintel/README.md serves the original,
# with --app experiments/ui-next/.app/lintel (and its jobs.ts and policy.ts)
```

It loads. mistri compiled the kit and its stylesheets, served them, and the
copy ran signed in with no page error on the rent roll, a lease and the New
repair form.

**A kit reaches few of a page's controls.** Counted in the running App, the
controls the kit drew against the ones mistri drew itself:

| Page       | Drawn by the kit                                | Drawn by mistri                   |
| ---------- | ----------------------------------------------- | --------------------------------- |
| Rent roll  | 5 menus, 1 listbox                              | 281 buttons, 54 inputs            |
| A lease    | 3 menus, 2 buttons                              | 59 buttons                        |
| New repair | 2 typeaheads, 2 date fields, 2 buttons, 4 menus | 45 buttons, 13 inputs, 1 textarea |

mistri's own pages (the grid, the record, a form's text boxes, choices and
switches, the navigation) draw their markup themselves, in `@mistriwork/kit`
and the App framework, and reach a slot only for a menu, a typeahead, a date
field, a dialog and a few buttons. So the control-kit seam cannot carry a new
look to an App. It was made to let an App match a design system's controls,
and it does that.

**Whole pages are an App's to draw, and that is where ui-next's look arrives.**
Four free-form pages (`definePage`, `pages/<path>.page.tsx`) run in the copy on
Lintel's own rows, under the reader's grants, with no page error. None is the
App's own screen in other clothes; each starts from what its reader came for:

- `/today-next` is not a dashboard of charts. An office opening the App asks
  what needs it, so the page is that list in the order it would be worked:
  the urgent repairs, the leases behind with what each owes, the homes empty
  and unlisted. Each row is one press from where it is dealt with, and a
  column beside it says what is coming (visits, leases ending, homes falling
  free).
- `/repairs-next` is a board where a card does not go wherever it is put. A
  repair has a next step that depends on where it stands, so each card says
  it on a button (Triage, Book a visit, Start work, Complete, Close), with
  what else may be done in its menu. The steps are Lintel's own machine verbs
  and commands. Carrying a card to a lane is the same step said another way:
  carried from "Waiting for a visit" to "On site", the lane says "Book a
  visit" and letting go opens Lintel's Schedule visit form.

- `/lease` asks for a charge with a form of its own. Add a charge opens a
  panel beside the lease with ui-next's fields; the answers are checked
  there, then sent through the command's `run`, which the server judges
  again; applied, the charge is on the lease and the panel says what the
  server said (`$62.50 charged: Gate fob replaced.`). This is a real write,
  made on the scratch database, and the only one in the experiment made
  through a form that is not mistri's.
- `/rent-roll` is the rent roll rethought, not mistri's list in other clothes.
  Four figures stand over the rows (how full the buildings are, what is
  empty, what the month is worth, who is behind). A home opens in a panel
  beside the list, so the list keeps its place; the panel steps to the next
  home in the order the list stands in, and the home it shows is in the
  address (`?home=25`). Tabs carry live counts, including two the App's own
  list has no tab for (behind on rent, free within 30 days).
- `/lease?lease=27` puts the money first: what is due, how much of what was
  charged has come in, and the open charges with the one thing to do about
  each on its row. Give notice, Add charge and Record payment are Lintel's
  own commands through mistri's own pipeline (`page.useCommand(…).open`);
  their forms open in the kit's dialog. Charges and payments are also one
  line of time beside the record.

What those pages give up, that mistri's own list and record have: saved
views, the query bar, a list's tab, search and filters in the address, totals,
cells edited in place, and paging on the server (the pages read every home at
once, which 54 homes allow and ten thousand would not). They are also not
typed against the App's generated types here: the App's own `tsconfig` reads
its modules as NodeNext and the library is written for a bundler.

An earlier pass drew only the rent roll's rows, through `customList`, with
the head and tabs still mistri's. It worked and is the smaller step: a custom
list has no totals and no cells edited in place, and its `show` is held to
what a signed-out visitor of the view may read, so the office's columns were
a second read.

**What had to change for mistri to compile it:**

- A kit's modules live inside the App's directory or are installed packages,
  so the script copies `kit/` and the sheets into the copy. As a package,
  ui-next would be installed and nothing would be copied.
- `defineUiKit` comes from the page (`@mistriwork/mistri/page`), React is the
  page's, and nothing else of mistri's may be imported, so the kit says its
  own money mask and initials.
- mistri joins a kit's stylesheets in the order its modules import them,
  inside the `components` layer. A CSS `@import` does not survive that, so
  `kit/styles.ts` imports each sheet by itself.
- UI SDK's stylesheet dresses five bare elements (`a`, `hr`, `code`, `kbd`,
  a link's focus). Page-wide in an App, that underlined mistri's own links.
  The script's copy of the sheet leaves those rules out.
- mistri's looks dress bare elements, by design: every `button` and `input`
  its corner, every `th` and `td` its padding, rule and face. UI SDK's parts
  are those elements, and a kit's or a page's sheet stands in `components`,
  under the look. Checkboxes came out round, filter chips square, and the
  table's head on a grey band. `kit/guest.css` says the corners and the
  table's cells again as `!important`, the one way an earlier layer keeps
  its word. That file is the cost of the seam as it stands, written out.
- mistri stamps `data-density` on the root for a density of its own, and
  ui-next's switch used the same name, so its scale changed with the App's.
  ui-next's attributes now carry its own prefix (`data-m-density`, …).
- **Every bundle carries its own UI SDK, unless something shares it.** mistri
  compiles the kit and each page to a file of its own, so the page held
  three copies of UI SDK, and moving from one page to the other the second
  copy's toast region refused the first's toaster and the page did not draw.
  The script now splits the one module the pages draw with
  (`in-app/lintel/ui.ts`): the real one goes with the kit, which loads first
  and holds it, and each page gets a stand-in of the same names that reads
  the kit's. Measured unminified in the served copy:

  |                                                                | Each bundling its own | Sharing the kit's                   |
  | -------------------------------------------------------------- | --------------------- | ----------------------------------- |
  | The kit                                                        | 696 kB                | 811 kB, holding what four pages use |
  | A page                                                         | 401 to 463 kB         | 11 to 17 kB                         |
  | The kit and two pages                                          | 1,559 kB              | 837 kB                              |
  | The kit and four pages                                         | not built             | 866 kB                              |
  | The same, with the behaviors and the rest of the library since | not built             | 945 kB                              |

  That is a patch made by a script. The real form of it is UI SDK and ui-next
  as modules the page provides, as React is (`HOST_MODULES`).

- **A fixed action is refused by the server.** The board's Triage, Start,
  Resume and Close are `page.useAction(…).run(record)`. Every one is answered
  400: `"status_since" is stamped by its machine as the state moves; no write
  sets it.` The client sends the stamp as the word `now`, as the server's own
  comment says it should; the same write sent by hand to an unmodified
  Lintel is refused the same way, with the stamp and without it. So the
  buttons are right by the API and do nothing here, and mistri's own notice
  says why. The commands (Book a visit, Assign a technician, Complete,
  Cancel) open their forms. This wants a look in mistri, not in ui-next.

What is still unproven or open:

1. **A seam for a list and a record.** A free-form page is the App's own
   code beside mistri's views, so it stands apart from what a view gives
   (saved views, the query bar, the address of a list's state, the server's
   paging). A list and a record as replaceable parts, with mistri keeping
   the question, the grants and the address and handing the part its rows,
   would let these pages be the App's list and record rather than a second
   copy beside them.
2. **Classes the callers pass.** mistri hands its controls class names its
   own stylesheets dress (`dd-list`, `field-control`, `insert-input`,
   `confirm`). The kit puts them where they were asked for. Which to keep
   (the ones that place a control) and which to drop is a decision, slot by
   slot.
3. **UI SDK's own layer.** At run time UI SDK adds a little CSS in a
   top-level `ui-sdk` layer, named after every layer of mistri's, so it
   stands over `structure`. Only its few rules for hidden and inert parts.
4. **Behavior the suite does not ask for.** Check cards are a Tab stop each,
   where mistri's share one and move by the arrows. The date field does not
   bound a date and its time together or say its format to a screen reader.
   A Dropdown's `readOnly` and letter-to-jump on the closed button, a
   Typeahead's `anchorRef` and `fit`, a Modal's `plain` and a Drawer's swipe
   are passed through and unproven. Overlays do not carry the scope of the
   component that opened them (`ComponentStyleScope`).
5. **The density zoom**, as below: UI SDK places its own popups.
6. **What is not a slot.** `Icon`, `Field`, the form parts, `Carousel`,
   `Resizable`, `ScrollArea` and the hero blocks stay mistri's own, so Base
   UI stays installed until they are slots or are ported. The database
   browser never takes a kit.
7. **The gates.** `mistri check`, the App's own tests, the visual matrix,
   the first-paint budgets and the Web Vitals run have not seen the copy.
   It was driven in one App, signed in as its admin, in light mode: the
   four pages, the panel, the filters, the links between pages and five
   commands' forms at a desk, and each page at a phone's width for a
   sideways scroll. The behaviors above were each run there by a script: the
   keys, the search's marks, the list's place in the address surviving a
   visit to a lease and Back, the panel beside a list that still answers,
   and a card carried to a lane opening its command's form. No command was
   submitted; the one write that was tried, a fixed action, was refused as
   above. The keys were pressed by a script, not by a person who lives on a
   keyboard, and no screen-reader pass was made.

Two things the App taught about behavior, beyond the look:

- **A page's styles stop at the page.** mistri scopes a page's sheet to the
  page's own element (`@scope`). UI SDK draws a carried copy on the page's
  top layer, outside it, so the copy arrived bare: the card's name a blue
  link, its parts in a heap. `Board` now writes each part's look onto the
  copy before it leaves. A pseudo-element (the dots between a card's facts)
  cannot be written that way and is missing from the copy.
- **A table head is theirs to place.** mistri sticks a grid's head to the top
  and raises it over the rows. `kit/guest.css` had answered that with
  `position: static`, which left a column's width bar with nothing to stand
  in, and the raised head cells covered the half of each neighbour's bar
  that stands outside its own cell. The head is now placed (`relative`) and
  not raised, and a sized cell keeps the width the reader gave it against
  the look's own `max-width`.
- **A page's own form cannot be refused by field for what the command
  checks itself.** `run(record, input, { quiet: true })` with an amount
  over the command's limit does not come back `refused` with `fields`:
  mistri opens its own form over the page's, with the answers in it, and
  the page's `run` waits behind it (the same through `prepare` and a
  review). And a page is told an input's `choices` but not its limits. So
  Lintel's page says the limit again and checks it first. A refusal by
  field for a page's own form would need `run` to return one, and
  `PageCommand` to say what each input allows.
- **A page has eight params.** The list's place is a home, four words and a
  word for each filter; with three filters that is eight, and the columns
  chosen made nine, which the App refuses at load (`page-params`). Lintel's
  page leaves the page number out of the address. A list with more filters
  would have to fold them into one word.
- **mistri's own keys did not collide.** `/`, `J`, `K` and `X` did what the
  list means by them on the App's page, and the shell's own ⌘K kept working.
  That is one page's finding, not a survey of the shell's shortcuts.

## If this replaced @mistriwork/kit

The kit is everything mistri draws in a browser that is not a bare control:
the grid, the record, the forms, the dashboards, the boards, the calendar,
the navigation, and the walk that moves between them. What stands here
against that, said plainly:

- **Here:** a list with a summary, tabs, search, chips, sort, selection, a
  panel beside it, its place kept in the address, and columns the reader
  chooses, orders and sizes; a record's head, stages, figures, sections and
  side column; a board whose cards are carried by pointer, finger or keys;
  a worklist; every form field `@mistriwork/ui` has and several it does not,
  with a form that checks, sends and shows a refusal; sheets that ask before
  they lose what was typed; a command palette; the thirty controls behind
  mistri's own props; and three behaviors to build the next thing on. Four
  of Lintel's screens run on them with its data and its commands, at its
  three densities and in its light and dark.
- **Not here:** a grid that holds ten thousand rows (virtual rows, paging and
  sorting on the server, pinned columns, totals, groups, cells edited in
  place); saved views and the query bar; the record form as mistri builds it
  from a resource (here a form is drawn from a description, with `when`,
  steps and a review, but not from a table, and with no lines or
  autosave); charts by a query and a dashboard's own windows (here the
  chart, the figures and the blocks, handed their numbers); ranges across days on the calendar; the App switcher, the palette's real search; timelines with
  attachments and conversations; public pages, sign-in, the landing; the
  five looks and twelve palettes (here one look, four accents, light and
  dark, with what it drags answering for the density zoom); print; right to
  left; the message catalog (here one set of words a caller replaces). And the gates that hold
  all of it: the ARIA pattern checks on every widget, the visual matrix, the
  first-paint budgets, Web Vitals, the browser suite.
- **The order that would work:** a seam first, so a list and a record can be
  replaced one at a time behind a flag while the kit stays whole; then the
  grid, since every App is mostly lists; then the record form; then the
  rest by how often it is seen. Each one arrives when it passes the gate the
  kit's own version passes, not before.
- **What decides it:** UI SDK is a beta two days old at the time of writing,
  and its API says it may change. The look and the experience here do not
  depend on it: the tokens, the sheets and the pages' shapes would stand
  over Base UI as well. So the design can be adopted on its own, and the
  question of what is underneath answered when UI SDK is stable.

## The gallery (`gallery/`)

Lintel's menu around seven real rooms, so the pages are read where an App
would show them and against the same content as the site's guide shots
(`site/src/assets/guide/list.webp`, `record-page.webp`):

- `#today`: what needs the office now, and what is coming.
- `#rent-roll`: the list, 54 homes, with its figures and the panel beside it.
  Try `/`, `J`, `K`, Enter and `X`, a Shift-press on a second checkbox, and
  leaving for a lease and coming Back.
- `#lease`: the record, Alder Court #101.
- `#repairs`: the board, each card with its next step. Carry a card with a
  mouse or by its grip with the keyboard, and take a step back from its
  toast.
- `#components`: every part, with the two behaviors bare (a sortable list, a
  grid, a list with handles, a transfer with a rule) and the parts that
  bring the library level with `@mistriwork/ui`.
- `#settings`: a page of form sections with a sticky action bar.
- `#kit`: the drop-in page. One screen written against `@mistriwork/ui`,
  drawn twice: bare (today's controls, over Base UI) and under the kit.
- `#components`: every UI SDK part used, as specimens.

New home on the rent roll opens the side panel form; Add charge on the lease
opens the modal, and End lease in its menu the confirmation.

The sliders button in the top bar changes mode, accent, corners and density;
each is a UI SDK preference stamping an attribute on the root.

## Parity with @mistriwork/ui

What `packages/ui/src/index.ts` exports, and where each stands in the library
(`src/`), which has its own props. The kit above is the other answer: the same
thirty controls with mistri's props.

| @mistriwork/ui                                       | ui-next                                             | Over                                        |
| ---------------------------------------------------- | --------------------------------------------------- | ------------------------------------------- |
| `Button`, `ButtonLink`                               | `Button`, `ButtonLink`                              | Button, with `render` for the link          |
| `Field`                                              | inside every field (`FieldFrame`)                   | Field                                       |
| `Modal`                                              | `Modal`, `Confirm`                                  | Dialog, Alert Dialog                        |
| `Drawer`                                             | `SidePanel` (and `beside`)                          | Drawer                                      |
| `DropMenu`, `DropItem`, `DropGroup`, `DropSeparator` | `DropMenu` (items as data)                          | Menu                                        |
| `Popover`                                            | `Popover`                                           | Popover                                     |
| `Tooltip`                                            | `Tip` / `Tooltip`                                   | Tooltip                                     |
| `Typeahead`                                          | `ComboField`                                        | Combobox                                    |
| `Dropdown`, `MultiDropdown`, `Select`, `MultiSelect` | `SelectField` (one or several)                      | Select                                      |
| `DateField`                                          | `DateField`                                         | Date Picker                                 |
| `TextField`, `TextArea`                              | `TextField`, `TextAreaField`                        | Input, Textarea                             |
| `MoneyField`                                         | `MoneyField`                                        | Number Input, `format`                      |
| `MaskedField`, `masks`                               | `MaskedField`, `masks`, `shaped`                    | Input; the caret kept, a whole value marked |
| `ValidMark`                                          | `ValidMark`                                         | plain markup                                |
| `SensitiveField`                                     | `SensitiveField`                                    | Password Input                              |
| `FileField`                                          | `FileField`                                         | File Input                                  |
| `Checkbox`, `Consent`                                | `CheckField`, `ConsentField`                        | Checkbox                                    |
| `YesNo`, `ChoiceCards`                               | `YesNoField`, `ChoiceField`                         | Radio                                       |
| `CheckCards`                                         | `CheckCardsField` (with `max`)                      | Checkbox                                    |
| `Slider`                                             | `SliderField`                                       | Slider                                      |
| `Switch`                                             | `SwitchField`                                       | Switch                                      |
| `Tabs`                                               | `Tabs` (items as data)                              | Tabs                                        |
| `Avatar`, `initialsOf`                               | `Avatar`, `initialsOf`                              | Avatar                                      |
| `Pagination`                                         | `Pager`                                             | Pagination                                  |
| `Carousel`                                           | `Carousel`                                          | Carousel                                    |
| `Resizable`                                          | `Split` (and `remember`)                            | Resizable                                   |
| `ScrollArea`                                         | `ScrollArea`                                        | Scroll Area                                 |
| `Badge`, `IconRows`, `PhotoTiles`                    | `Badge`, `IconRows`, `PhotoTiles`                   | plain markup                                |
| `HelpTip`                                            | `HelpTip` (opens on a press, so under a finger too) | Popover                                     |
| `ProgressBar`                                        | `ProgressBar`                                       | Progress                                    |
| `StepHeader`, `Columns`, `ReviewList`, `ActionBar`   | the same names                                      | plain markup                                |
| `Icon`, `registerIcons`                              | not here: the pages use Phosphor's components       | see below                                   |
| `ChangeDetails` on every callback                    | UI SDK's own `details`                              | built in                                    |
| ruler, `zoomAnchor`, `popupContainer`                | none                                                | see the density zoom, below                 |

Every name is in the gallery's Components room. Two are not ported on
purpose. `Icon` is mistri's own registry of path data sent with an App's
payload, which is the platform's and not a look's; and the ruler exists for
the density zoom, which UI SDK's popups turned out not to need (see below).

Level by name is not level by what each can do, so each was read against
its counterpart's props and behavior. What that added here, where mistri has
it: a sheet that asks before it loses what was typed and one that cannot be
dismissed at all, a panel from either edge, a date's bounds with Today and
Clear, a field's required mark, tip, hidden label and reserved line, a
select's action rows ("New building…") and its options' detail, icon and
disabled state, a menu's disabled items, headings and hints, a button that
is busy or as wide as its box, a card that means none of the others, an
icon on a choice, a popover a caller opens, a step's name that takes the
keyboard when the step changes, a scrolling region that is a Tab stop only
while it scrolls, tiles that hold their place while pictures load, and
every word replaceable.

And what is here that `@mistriwork/ui` does not have: a count for a field
with a limit, a cross that clears one, a text area that grows, a file's
size and number limits with the reason one was refused and a picture of a
picture, drag and drop for files, a lookup with its loading, error and
count said, a copy for a secret, a limit on check cards said before it is
reached, a mask that keeps the caret, and the behaviors.

A date with a time is `DateTimeField` here (and a time alone `TimeField`),
and `timeZone` says whose day today is. What `@mistriwork/ui` has that is
still not here: per-control `words` props (here they are one set for the
page), and its `ChangeDetails` shape (here the details are UI SDK's own).

Not in `@mistriwork/ui` today, and here: `ListView`, `DataTable`,
`ColumnChooser`, `Board`, `Worklist`, the record's parts, `Activity`,
`FormSection`, `Skeleton`, `Mark`, the command palette, and the `Sortable` and
`Transfer` behaviors.

## Against the rest of mistri's client

`@mistriwork/ui` is the primitives. What an App is drawn with is mostly
`@mistriwork/kit`'s components (138 files) and the App framework's own (96).
This is where ui-next stands against those, by what a reader would call the
thing. "Here" means a component a page hands rows to; none of it reads an
App's definition, which is the part that makes them mistri's.

| What mistri draws                | In mistri                                                                                  | Here                                                                                                                                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A list as a table                | `Grid`, `GridCellEditor`, `TableView`, `ThMenu`, `SortMenu`, `ListFilterBar`, `RowActions` | `ListView`, `DataTable`, `ColumnChooser`, `Widths`, cells edited in place (as text), rows drawn only in view, a pinned name, totals: the rows are all in the browser (no sorting or paging on a server), no groups, no range of cells            |
| A record                         | `Record`, `Page*`, `Value`, `Editable`                                                     | `RecordHeader`, `RecordLayout`, `Properties`, `Facts`, `Stages`, `Stats`, `Activity`, `EditableText`: a value edited in place as text, not by a control chosen for its kind                                                                      |
| A form                           | `NewRecord`, `MultiStepForm`, `CommandForm`, `FormSurface`                                 | `useForm`, `SchemaForm`, the fields: from a description, not from a resource                                                                                                                                                                     |
| A board                          | `BoardList`, `TriageBoard`                                                                 | `Board` over `Transfer`                                                                                                                                                                                                                          |
| Charts and a dashboard           | `Chart`, `ChartShapes`, `Dashboard`, `PageMetrics`, `Breakdown`, `Funnel`                  | `Chart` (columns, stacked, line, area), `Metrics`, `Sparkline`, `BarList`, `SegmentBar`, `Funnel`, `DashGrid`: no scatter, heatmap, waterfall or treemap                                                                                         |
| A worklist, a queue              | `InboxList`, `QueueList`                                                                   | `Worklist`; `Queue`, one at a time with a key a verb (mistri's queue is a listbox with bulk actions, which here is the list's own selection)                                                                                                     |
| Calendar, Gantt                  | `CalendarList`, `CalendarTimeGrid`, `GanttList`                                            | `Calendar`: a month and its agenda; `WeekCalendar`: a week by the hour; `Gantt`: a row a task, carried and lengthened. No ranges across days on the month, no single day view, no drawing a new thing by dragging, no dependencies between tasks |
| Cards, gallery, tree, split      | `CardsList`, `Gallery`, `TreeList`, `SplitListDetail`                                      | `Cards`, `Tree` (UI SDK's), `ListDetail`: handed their rows; no pictures from a file resource, no tree read from a parent column                                                                                                                 |
| Timeline, notes, conversations   | `PageTimeline`, `Composer`, `TimelineComposer`, `Notes`, `ConversationList`                | `RecordTimeline`, `Composer`, `Activity`: notes, events, reactions; no attachments, no mentions, no conversation list                                                                                                                            |
| Rich text                        | `RichText`, `RichTextEditor`, `RichTextField`                                              | `NoteField`, `Prose`: marked plain text and its preview, not editing in place                                                                                                                                                                    |
| Saved views, filter rail         | `SavedViews`, `FilterRail`, `FilterBoxes`                                                  | `SavedViews` (kept in the browser, or by the caller), `FilterRail` with counts; no query bar                                                                                                                                                     |
| Command palette                  | `Palette`                                                                                  | `CommandPalette`: the commands it is handed, with recents; not a search of the App's records                                                                                                                                                     |
| The shell                        | `Sidebar`, `TopNav`, `MobileNavDrawer`, `Crumbs`, `Prefs`, `InboxBell`                     | `AppShell` (menu down the side that folds or along the top, phone drawer, skip link, where the reader is), `InboxBell`, `AccountMenu`, `Breadcrumbs`: no App switcher, no overflow of a top menu too long for the bar                            |
| Files and pictures               | `AttachmentList`, `FilePreview`, `Lightbox`                                                | `FileField`, `PhotoTiles`, `PictureGallery`, `Attachments`: a record's files, one read where it stands (a picture, a PDF, a text file), arrows from one to the next; no office formats, no upload progress                                       |
| Import, export                   | `ImportDialog`, `ImportButton`, `Export`                                                   | `ImportDialog`, `ExportMenu`, `parseCsv`, `toCsv`: CSV in the browser, the rows handed to the caller; no import held and run on a server, no other formats                                                                                       |
| Sign-in, account, tenant screens | `SignIn`, `Account*`, `Tenant*`                                                            | `SignIn`: address, password and other ways in; no account or tenant administration                                                                                                                                                               |
| Themes                           | `defineTheme`, five looks, twelve palettes, recipes, type roles, `visualTheme`             | the same, worn: `theme/bridge.css`, `theme/looks.css`, `wearTheme`; a theme's `parts`, motion and rhythm are not read                                                                                                                            |
| The Workshop's own               | `LayoutBuilder`, `FieldArranger`, `ThemeLab`, `Diagram`, `JsonView`                        | not here, and not meant to be                                                                                                                                                                                                                    |

## What changed from today's look, on purpose

- One colour. A filled primary is the ink; the accent only says current,
  selected, focused or followable.
- The content pane is a sheet of the surface on a quieter ground, and the menu
  sits on the ground.
- Smaller, tighter type (13px Inter, tabular figures), 40px rows, hairlines.
- A record's related things are label and value on one line each, and its
  figures share one ruled strip.

## What it found

- **Tokens carry most of the look.** Mapping about twenty tokens dressed every
  UI SDK part, light and dark, with no rule per component.
- **The model matches the doc.** Parts carry `data-slot` and state attributes
  and the stylesheet stands in one layer, the cascade `docs/design.md` already
  holds the kit to.
- **Things to fix by hand.** A date picker's trigger drops under its input
  inside a `Field`; `InputGroup` and `InputClear` arrive undressed; a checkbox
  in a `Field` needs `flex-direction: row`; popups have no entry motion; a
  part's `data-slot` cannot be replaced, so a variant of one is keyed on
  another attribute (`data-kind` here).
- **Weight.** The gallery builds to roughly 1,036 kB of script unsplit, for
  some eighty parts, the three behaviors, the icons and a font. An App's first-paint budget
  (`scripts/bundle-budget.mjs`) would need this measured per surface.

## Layout shift

Run against the built gallery (`vite preview`), every room, at a desk and
a phone, cold: the layout-shift entries a browser reports at load, and
again through what a reader does in the room (tabs, a search, a sort, a
cell opened and closed, a period changed, a chart read and turned to a
table, a queue worked, a month and a week turned, ten thousand rows
scrolled). The score is 0 in all of them. It was not at first, and what it
found:

| What moved           | Score                                 | Why                                                                                                                             | Now                                                                                                                                                        |
| -------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The 10,000-row table | 0.08 at load, 0.48 scrolled by script | The rows that hold the place of what is not drawn grow and shrink as the window turns, and counted as content moving            | They are hidden from view and from the count; nothing a reader sees moved                                                                                  |
| A heading on a phone | 0.007                                 | It fitted its line by a pixel in Inter and not in the face that stood in before Inter arrived, so it went from two lines to one | The stand-in face is measured to Inter's width, per weight; and the gallery waits up to 400 ms for the face before its first draw, which is a host's to do |

A browser's score leaves out what follows a press. Those were measured as
positions before and after (`moves`, 30 checks), and three were real:

| What moved                                                       | By how much                              | Now                                                               |
| ---------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------- |
| A cell opened for editing widened its column                     | 123 to 232 px, and every column after it | The box is laid over the cell                                     |
| A record's value opened for editing changed its section's height | 15 px, and everything under it           | The box is laid over the value; a problem is a note over the page |
| A sort, a page or a tab nudged every column                      | up to 13 px                              | The table lays out its own columns (above)                        |

Not measured: a slow network (the face arriving after the 400 ms), the
pages inside Lintel, and anything under mistri's density zoom.

## On the pixel

Every room was measured for boxes whose top or height is not a whole
number of pixels, since an edge on a half pixel is drawn as two grey rows
and not one sharp one, and puts everything under it on a half pixel too.
There were 403 boxes whose own height was fractional. They had three
causes, and none is left:

| Cause                          | Where                                                                                         | Now                                                                                                                                                                                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A line height that is a ratio  | 13px text at 1.5 is 19.5px; 11px is 16.5; a 24px figure at 1.2 is 28.8. Nearly all of the 403 | A type scale in the tokens (`--m-size-*`, `--m-lead-*`): eleven sizes, each with a line height that is a whole number of pixels. All 112 font sizes in the components' sheets are on it, and UI SDK's own parts are set at the same leading |
| Collapsed table borders        | A shared border is half one cell's and half the next's, so rows were 40.5px                   | Each cell's border is its own                                                                                                                                                                                                               |
| Lines of one and a half pixels | A stage's track, a timeline's connector                                                       | Two pixels, centred on whole pixels                                                                                                                                                                                                         |

What is still off the pixel, by measure: the left edge and width of things
as wide as their words, which is what text is; a status's dot and word in
a table cell (no edge to blur); and elements that are not drawn.

The same pass counted control heights across the rooms: a button is 32px
or 26px (`sm`), an input and a select 32px, the bar's controls 32px, a
filter's pill 28px beside a 32px search box on purpose. One was wrong and
is fixed: the views button was 26px beside 32px buttons.

The scale is also what a theme needed: nothing in a component's sheet
names a font size now.

## Space

A look that draws a section as a box left it touching the next one: in
ui-next's own drawing a rule and its padding divide two sections, and a box
has neither. That was one report, and the cause was wider than it: the
sheets held 25 different spacings, seven of them on no grid (5, 7, 9, 15,
18, 22 and 28px), so nothing said how far apart two things stand.

- **One scale.** Every gap, margin and padding in the components' sheets
  is a token now (`--m-space-1` to `-8`, the half steps, `--m-seam`): 507
  values in about 390 declarations, 56 of them moved from an odd value to
  the step that suits what they space. The steps are mistri's (2, 4, 8, 12, 16, 24, 32, 48,
  the halves 3, 6, 10, 14, a 40px seam) with one it has not, 20.
- **A box brings its room.** `--m-gap-box` is what stands between two
  boxes and `--m-pad-box` what a box has inside. A recipe that makes a
  thing a box (`section`, `fields`, `stat`) sets both and takes away the
  rule that divided it before, in the same place.
- **Rhythm.** A theme's `rhythm` (`tight`, `airy`) moves the steps from
  16px up and the seam a quarter closer or wider, as it does in mistri,
  and never a control's own padding.
- **A band runs the room.** A header drawn as a band is painted to the
  room's sides whatever the page's own measure is, with its words on the
  page's margins.

A script measures it in fourteen rooms under all six looks, at a desk and a
phone: boxes with less than 6px between them, a box flush inside a box,
words nearer than 6px to their box's side, a word broken across lines, text
under 11px, wrapped text set tighter than 1.25, and a box whose contents
stand nearer one edge than the other. It found the report (eight pairs of
touching boxes, in Sage and Ledger), the same in two more places (a form's
sections), an address broken in the middle of a name (it breaks after the
`@` now: `breakable`), and initials at 10px. What it still reports is four
things that are meant: tiles and lanes in a row are as tall as the tallest,
so a short one has room under it; a band's side is the page's gutter; a
form's sticky bar is as wide as the form.

Read at twice the size in each look, the same pass found what a measure
does not: one block's heading set in a look's section face and the chart's
beside it not (a chart's title is a section's heading now), a look's
square corners on its fields and not on the panels around them, and chips
drawn as pills in a look that has none.

It was run again on the next thing built, a day picker, and found what the
first look missed: in a narrow box the notes under the days (`3 free`) ran
into each other. A day has a least width now, and the measure a check for
words that fill their cell.

The measure sees what it was told to look for. Nobody has yet read every
room in every look at full size, and that is the pass that finds the rest.

## Themes

ui-next has no theme language of its own. It wears mistri's: the five
looks, the twelve palettes, an App's `defineTheme`, a tenant's branding and
a reader's pick all reach it through the two things mistri already puts on
a page, and nothing an App writes changes.

| mistri says                                                                                               | ui-next reads it in                                                                                                 |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Tokens named by what they are for (`--ground`, `--accent`, `--chart-3`, `--nav-ground`, `--heading-font`) | `theme/bridge.css`: each of ui-next's tokens is mistri's where a theme says it, and ui-next's own where it does not |
| One attribute a recipe (`data-look-tabs="pill"`), from a closed menu                                      | `theme/looks.css`: an answer on ui-next's own parts for each value                                                  |
| Type roles (`data-type-label="face upper"` and `--type-label-*`)                                          | `theme/looks.css`: the parts each role is (title, heading, section, label, data, figure, nav)                       |
| How far things lift (`data-look-elevation`)                                                               | `theme/looks.css`                                                                                                   |
| Four corners: a control's, a field's, a pill's, a panel's | each on the parts that are one: Ledger's fields and panels are square and its buttons soft, Workshop's chips are not pills |
| The face values are set in, and how far it reaches (`data`) | a table's cells and a record's values; with `reach: 'figures'`, a table's figures only |
| How far apart things stand (`data-look-rhythm`) | the space scale's steps from 16px up ([Space](#space)) |

Both sheets turn on at `data-custom-theme`, which mistri puts on the root
with the rest. So inside an App there is nothing to call. Where mistri is
not on the page, `wearTheme(theme, element?)` puts a worked-out theme on
the root or on any element, and takes the last one off; it does not work a
theme out. The gallery works them out with the engine's own code
(`gallery/theme.ts` imports `themePreset`, `effectiveThemeDefinition`,
`recipeAttributes` and the token tables from `packages/engine`), so what it
shows is what an App would hand over. Its Themes room has the look, the
palette and every recipe as a choice, and the same specimen in six themes
side by side.

**Recipes.** Of the menu's 25 parts, these are answered on ui-next's parts:
the menu (7 values), the bar (5), tabs (5), stat (6 of 7), section (3),
fields (4), table (6), status (4), board (3), lanes (3), chart (4),
buttons (3), links (2), rules (3), avatar (3), workflow (2), header (2 of
3), filters (3), a form's action bar (2). Where ui-next's own drawing
already is a value (its tabs are underlined, its status a dot and a word)
the value has no rule. **Not answered yet**, so wearing them changes
nothing: `windows`, `banner`, `steps`, `required`, `checkbox`, `formStep`,
`stat: icon`, `header: hero`. `kit/theme.test.tsx` holds both lists to the
engine's menu: a value mistri adds fails there until it is answered or
listed.

**A theme inside a theme.** An attribute is read from whatever wears it,
and a part answers the nearest: every rule is a scope from the attribute to
the next theme inside it (`@scope … to`), and a theme worn by a part of the
page starts from nothing, with every token mistri can say put back. So a
preview, or a tenant's brand in one panel, is its own and not the page's
with changes. A popup is drawn at the end of the body and wears the page's
theme, not the panel's.

**What was checked.**

- The five looks, light and dark, over seven rooms of the gallery (today,
  rent roll with its panel, form and menus open, lease, board, dashboard,
  settings, themes): axe-core reports nothing, contrast included.
- Layout shift under Workshop, Ledger and Sage in the fourteen rooms the
  measure covers, desk
  and phone: 0, once the gallery waited for the look's faces (Barlow, IBM
  Plex Mono) as it does for Inter. mistri preloads a look's files for an
  App; a host that does not will see the swap.
- With no theme worn the rooms are as they were: layout shift 0, and the
  bridge adds nothing a rule reads.
- **In Lintel**, the copy of the App served by mistri: its own
  `defineTheme` (`lintel`, over Lumen) and a reader's pick of Sage, Mono and
  Ledger each reached the four ui-next pages through mistri's root alone,
  tokens and recipes, with no page error.

**What is not there, or not right.**

- **mistri's own sheets still reach a page's bare elements.** In today's
  App a look's rule for `th` sits in a later layer than a kit's, so a
  ui-next table head there is set by mistri's rule and not by ui-next's
  answer to the label role. It goes when the kit's sheets are the App's.
- **A theme's `parts`** (a part's own ground, ink, edge, radius, lift,
  face) and an App's own stylesheet for a theme are not read.
- **Motion and density** as a theme says them are not answered; density
  is still the reader's, by ui-next's own attribute. Rhythm is
  ([Space](#space)).
- **Weights** are five tokens by what they are for (`--m-weight-regular`
  to `-heavy`), as sizes and spacings are tokens
  ([On the pixel](#on-the-pixel), [Space](#space)). No theme moves them
  yet: mistri says a weight a role, which is answered, and has no word for
  the scale. A role's size is given a line height on whole pixels by
  `round()`.
- **The pixel pass was not repeated per look**: fractional heights were
  measured for ui-next's own look only.
- **Browser floor.** `@scope` needs Chrome 118, Safari 17.4 or Firefox
  146; `light-dark()` was already the floor for colour.
- Outside a theme, a series' colours are ui-next's own eight, checked on
  white and near-black. Under a theme they are the theme's, which mistri
  checks when it reads the theme.

## What it does not show

axe-core reports one rule on the tree and nothing else anywhere: an open
branch's row is named by its own label, and axe reads the rows nested under
it as text the name leaves out (`label-content-name-mismatch`). The nesting
is UI SDK's and is the tree pattern's; the name is the row's, which is
right. It is left reported and not silenced.

- **The density zoom, measured.** mistri zooms its root for density (1.12 at
  its default, 1.24 at its widest) and places its own popups on a
  zoom-aware ruler because of it. The question since the first day was
  whether UI SDK's placement survives that. Measured in Lintel at all three
  densities:

  |                                          | zoom 1                   | 1.12                     | 1.24                     |
  | ---------------------------------------- | ------------------------ | ------------------------ | ------------------------ |
  | A menu under its trigger                 | 4px below, flush         | 4px, flush               | 5px, flush               |
  | A popover under its trigger              | 4px below, flush         | 4px, flush               | 5px, flush               |
  | A select's popup (gallery, zoomed)       | 4px, its trigger's width | the same                 | the same                 |
  | A slider's thumb, a split's bar          | follow the pointer       | follow                   | follow                   |
  | A card carried on the board, before      | under the pointer        | 112px off, 13% too large | 247px off, 25% too large |
  | A row dragged in a sortable list, before | under the pointer        | 9% ahead                 | 18% ahead                |

  So UI SDK's popups, sliders and panes are right under a zoom, and the
  ruler is not needed for them. Two things are not: the copy
  `createTransfer` and `createReorder` carry is placed and moved in the
  screen's pixels inside a page whose pixels are larger, and the offset
  `createReorder` writes for a dragged item mixes the two (the pointer's
  part in the screen's pixels, the part for the place it has taken in the
  stylesheet's). Both are answered in `src/behaviors` (`dress.ts`,
  `sortable.ts`), and a column's edge divides the pointer's travel by the
  zoom: after it, a carried card stays within 4px of where it was picked up
  and is the size it was, a dragged row and a column's edge move as far as
  the pointer, at every density. A page that is not zoomed is untouched.
  What was not measured: a drawer swiped by a finger, and the kit's
  date picker's calendar.

- **Acceptance.** Each page and overlay was opened in a browser, light and
  dark, desk and phone, with no page error and no sideways scroll. axe-core
  was run over every room of the gallery in both modes, with the panel, the
  New form, a row's menu, the column chooser, the command palette and a
  card carried by keys each open: it reports nothing. It first found three
  things, since put right: a badge's small words under 4.5:1 on their wash,
  a room with no first heading, and lanes that faded their text when they
  stood back from a carried card (they go flat now, and stay readable). The
  same run over the four pages inside Lintel, in mistri's own light and
  dark, reports nothing either, and the pages follow mistri's theme (its
  `color-scheme` is what `light-dark()` reads). A scripted Tab through
  every room of the gallery, 370 stops, found none that does not show where
  the keyboard is. axe and a script prove less than they sound: no screen
  reader was listened to, and no person who lives on a keyboard has used
  it. The colour pairs were
  computed from the token values (text at 4.5:1 or better, a field's edge and
  the accent at 3:1 or better, every accent, both modes). A default button's
  edge is the softer hairline, below 3:1: it is found by its words.
- **The real list.** No virtual rows, inline edit, grouping or saved views,
  and the data is in memory. The widths a reader gives columns are kept
  while the list is on screen and not past it: they are not in the address
  (a page has eight params) and not saved.
- **A finger on the board, by a script.** At a phone's width with touch
  events sent to the page: a finger pulled across a card's body scrolled
  the board 115px and carried nothing, and a finger on a card's grip
  carried it to the next lane, the board scrolling under it as it neared
  the edge, and let it go there. The grip is drawn 14px wide and answers
  over 44px under a finger. That is a script's finger, not a hand on a
  phone. An order within a lane is the behavior's to give and the board
  does not use it, since its cards stand in the order they are given.
- **A person at the keyboard.** The list's keys were run by a script. Whether
  `J` and `K` sit well beside a screen reader's own keys, and beside every
  shortcut a real App already has, is not answered here.
- **The record form, in part.** `useForm` checks, sends and shows a refusal
  for fields a page writes out by hand (Lintel's Add a charge), and
  `SchemaForm` draws a form from a description, with `when`, steps and a
  review. What mistri builds from a resource goes further and is not here:
  the fields chosen from a table's columns, lines of a record, autosave and
  resuming a draft, files in a step, and a form that is a view of its own
  with an address.
- **The looks.** One look with four switches, not Workshop, Lumen, Sage, Mono
  and Ledger, and none of the palettes.
- **A stable API.** Both packages are pinned to an exact beta
  (`0.1.0-beta.2`); the beta says its APIs may still change.
