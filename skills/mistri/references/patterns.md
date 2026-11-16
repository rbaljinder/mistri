# Patterns: each room, made well

One pattern per kind of room: when it is the right room, what makes it read as finished, and the lines of Lintel
that say it. Take the pattern, map its tables onto the brief's, then check the page against
[rubric.md](rubric.md). The keys are in `npx @mistriwork/mistri docs choose` and the `compose-*` guides; this file
is the choice and the worked lines, not the reference.

## From the brief to the rooms

The brief ([brief-template.md](brief-template.md)) answers four things; each picks a pattern.

| The brief says | The room it asks for |
| --- | --- |
| What a person must know when the day starts | the home: three or four figures in one `figures` row, then the work that waits |
| The three tasks done most | a list of work each, opened on what is open, with the verb on the row or the card |
| What counts as urgent | a tone on that value, a tab or a segment for it, and its rows on the home |
| Who else uses it (a customer, a visitor) | a public listing or form, and a home of their own |

A record that moves through states is work: it gets a machine, a list with tabs, and a place on the home. A record
that only is (a building, a product) gets a plain list and an overview page.

## A list of work

When: the table holds things people act on. Opens on what is open, never on everything ever made.

- Tabs in working order, counted, All last — [lintel/views.ts:61](../../../examples/apps/lintel/views.ts#L61) (`tabs`),
  each a named `segment` of the resource so the same words filter the home and the menu's count.
- A summary strip of up to four figures above the tabs, in a dashboard's words —
  [lintel/views.ts:55](../../../examples/apps/lintel/views.ts#L55) (`summary`). Use it where the list is a
  ledger people total in their heads (rent, stock, pipeline); leave it out of a plain directory.
- The first column names the row; four to seven columns that answer "which one, what state, how much, when".
- A tone on every status and a unit on every number, said once on the resource —
  [lintel/resources.ts:63](../../../examples/apps/lintel/resources.ts#L63) (`tone`).
- An `empty` that says what belongs there and how to add the first one.

## A record page

When: every main table. The anatomy is head, figures, tabs, aside.

- The head: the state beside the name, three or four facts with units, the forward verb filled and the ending
  verbs last — [lintel/pages/lease.ts:12](../../../examples/apps/lintel/pages/lease.ts#L12) (`header`).
- Two to four leading figures, each with a line under it saying what it counts —
  [lintel/pages/lease.ts:20](../../../examples/apps/lintel/pages/lease.ts#L20) (`notes`).
- Related lists as tabs, which count themselves —
  [lintel/pages/lease.ts:37](../../../examples/apps/lintel/pages/lease.ts#L37) (`listTabs`).
- The aside: a card for each parent, by name, with two or three facts —
  [lintel/pages/lease.ts:33](../../../examples/apps/lintel/pages/lease.ts#L33) (`card`); then a property rail and
  `history()`.

## A home page

When: always; it is first in the menu and it is what a person sees after signing in.

- One row of three or four figures, each with its window or its "right now", a meter where the figure is a share —
  [lintel/dashboards.ts:12](../../../examples/apps/lintel/dashboards.ts#L12) (`metric`).
- Then the work: one or two short lists of what waits, the urgent first, each a `rows` that leads with the
  record's name — [lintel/dashboards.ts:68](../../../examples/apps/lintel/dashboards.ts#L68) (`rows`). A home of
  figures alone sends people looking for their work; `check --design` says `home-without-work`.
- Charts last, in time order, only where a trend changes what someone does.
- More than eight figures is `crowded-dashboard`: move them to the list they total, as its `summary`.

## A board

When: the work has three to seven open states and people move it by hand.

- Lanes are the machine's states; a card is the name, one quiet line of facts, and its next step as a button —
  [lintel/views.ts:141](../../../examples/apps/lintel/views.ts#L141) (`board`). The button is the first verb the
  machine offers from the card's state, so every open state needs one —
  [lintel/resources.ts:135](../../../examples/apps/lintel/resources.ts#L135) (`machine`); a state nothing leaves
  is `stuck-state`.
- `category` is a column of the record's own (a trade, a priority), never a reference.
- Keep the same records as a plain list beside it, for search, export and the long tail.

## A calendar

When: the record happens on a day and people ask "what is on Thursday".

- The day column, the name, a line and a badge —
  [lintel/views.ts:100](../../../examples/apps/lintel/views.ts#L100) (`calendar`). Its records stay addressed
  under their list (`view:` on the resource), not under the calendar.

## A public listing and a form

When: someone without an account looks or asks.

- A listing is a list view the signed-out home shows —
  [lintel/views.ts:24](../../../examples/apps/lintel/views.ts#L24) (`listings`): cards with a photo, the name and
  two labelled facts.
- A form asks only what the first reply needs, in groups of at most seven, with a sentence saying what happens
  next; its human check and limits are settled in [choices.md](choices.md).
- What a card opens is read the way the card is, large. A list open to every reader (no `roles`) whose
  `cards(...)` names a `value` and an `image` of the record's own rows gives the record it opens, when you write
  no page for it, a showcase: its pictures first, the card's `value` beside them as the figure with presence, the
  card's `facts` under the name, the rest under both. Write a `page(…, { layout: 'showcase' })` when the figure
  needs its note or a call to action (Lintel's home:
  [lintel/pages/unit.ts](../../../examples/apps/lintel/pages/unit.ts)); a list only the office reads keeps the
  office's record.

## A portal for the App's own public

When: customers, patients or residents sign in to see their own things.

- Their role says `portal: true` — [lintel/app.ts:110](../../../examples/apps/lintel/app.ts#L110). The shell then
  offers them no office tools: no search across every table, no look picker, no view switch, column chooser or
  record pager. It grants nothing; the role's `read`, `commands` and the row policy still decide what they reach.
- Their lists are titled for them: `primary: '<a shown column>'` on a list view names each row by that column where
  the list is read as records (a phone). A patient's visits titled by the therapist read "Maya Okafor", not the
  record's name with their own name in it on every row. A dashboard's `rows` and a record page's related list take
  the same `primary`; a `rows` section then leads each row with it.
- Their own record is a menu destination: `settings: 'My details'` on the resource opens the one row their row
  policy leaves them from the account menu, not a list of one.
- A moment says its time by default ("in 2 days, 9:30 AM", "Tue, Nov 17, 9:30 AM"); `format: 'time'` says the time
  alone on a list that is all today. An address column says `format: 'address'`: its lines kept, a map a press away.

## Settings

Preferences, the profile and the look are the platform's page (`/settings`): an App adds nothing. A setting of the
business itself (late fee, opening hours) is a record of one row with a form, in the menu's last group.

## The look

Pick one look from [design-language.md](design-language.md) by the work, and give it the App's color: a palette or an accent in `ui.theme`, or `brand: '#…'` in a theme of its own, which also turns the shell's neutrals. A look left in its own color is every App on that look; `check --design` says `unbranded`.
Add a mark, and stop. No stylesheet of the App's own unless the person asks for one.

## Rows to judge it on

Every pattern above is judged on rows. `npx @mistriwork/mistri seed --app . --config ../mistri.json` writes them
through the App: about forty a main table (`--rows <n>`), a machine's status spread over its states with most work
open, dates across the last ninety days with some due today and some overdue, names from a word list; `--seed <n>`
repeats a run. Look at what it made before grading:

- every tab, every lane and every tone has at least one row, and one lane or tab is empty on purpose, to see its
  empty state;
- the home's lists have between three and eight rows each, and one figure is not zero;
- money has cents somewhere, a name is long enough to be cut, a date is today.

Where the seed cannot make a row the brief needs (a real address, a person a row policy matches by email), a seed
script beside the database, never in the App's folder ([handback.md](handback.md)). `mistri grade` says
`unseeded-list` when most lists are empty: seed first, then grade.

### When the seed is a script

`mistri seed` writes dates behind today only, and it does not know which row is whose. Write a script when the brief
needs rows still to come (a booking next week, an appointment tomorrow), states that agree across tables (a line
that is out, its item out, its booking out), or a row for each person who signs in. Keep it beside the database
(`db/seed.mjs`), run once on an empty migrated database, and have it:

- refuse a database that already holds rows, so a second run never doubles the data;
- draw from a small fixed generator (a seeded linear congruential one is enough), so two runs make the same rows;
- lay every date out from today in the App's zone (`day(-30)` to `day(+30)`), with some rows due today, some
  overdue and some ahead, so "upcoming", "due today" and "overdue" each hold three to eight;
- write one row for each sign-in the App has, with that account's email, in the table `auth.me` names: a person
  whose row is missing sees an empty App;
- move rows through the App's own states only, and write the columns each state implies (a completed visit has its
  end time, a cancelled one its reason);
- end by printing how many rows each table got.

Then `mistri check`, and look at the pages before grading.
