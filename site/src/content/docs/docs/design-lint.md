---
title: Design checks
description: What `mistri check --design` and `mistri grade` find in a record page, a form and the shell, with the fix for each.
---

What `mistri check --design` and `mistri grade` find in a record page, a form and the shell, with the fix for each.

`check --design` reads an App's pages, forms and shell for compositions that
come out basic, each finding a warning: the smell, then the fix. Warnings are
advisory by default. For automation, add
`--fail-on-design-warning`: it includes design checks and returns exit code 4
when any design warning is found. JSON output retains warning severity and
marks the design step as failed (`ok: false`). Other validation errors keep
their existing exit-code precedence.

```sh
npx @mistriwork/mistri check --app . --config mistri.json --design
npx @mistriwork/mistri check --app . --config mistri.json --fail-on-design-warning --json
npx @mistriwork/mistri shot --app . --config mistri.json --both   # then look at the PNGs
```

`mistri shot` prints the path of each picture: every view and page, or the
routes you name (`leads/12`). `--as <role>` signs in (on a tenant App, with
`--tenant <id>` for a role within a tenant: shot writes a temporary membership
to the App's tenant store and revokes it when it ends), `--as <email>` signs in
as an account you already made, with its password in `MISTRI_AS_PASSWORD`
(its store is copied, never written), `--theme all` tries
every look, `--full` captures the whole page, `--width 1024` sets the window's
width (320 to 2560) in place of the desk's or the phone's, and `--scale 2` (1 to 3)
makes the picture sharper without changing the layout.

| Code | Smell | Fix |
| --- | --- | --- |
| `aside-columns` | A related list beside an aside has more columns than its width holds (4 short ones at a desk, in either menu's shell), or in an `article`'s reading column (about 640px, 4 short ones); the rest are left out. A `showcase`'s lists stand under its photos at full width | `show:` the ones that fit, or `shell: { placement: 'top' }` |
| `aside-summary` | A summary beside an aside wraps: 4 figures share a row in the top menu's shell, 3 beside the side menu | fewer figures, or `shell: { placement: 'top' }` |
| `aside-table` | A list in the aside has more than 2 columns | 2 columns, or `presentation: cards(...)` |
| `aside-metrics` | 3 or more metric cards beside an aside wrap | a `fields([...])` of rollups |
| `lone-metric` | A strip of metrics wraps its last onto a row alone: three share a row, two beside a dashboard's aside in the side menu's shell (at `width: 'third'` too) | a multiple of the row, or `width: 'half'`; beside the side menu, no aside |
| `board-reference` | A list board's `category` names a reference, which a card tags with its stored key (its `lines` and `footer` say the name) | a category of the record's own; the reference among the card's lines |
| `rail-columns` | A list beside its filter rail (`filterBar: 'rail'`) has more columns than a desk holds there (about 627px beside the side menu, 855 under the top menu, less a row menu); the rest are left out | `show:` the ones that fit, first, or drop `filterBar: 'rail'` |
| `dashboard-columns` | A dashboard's `rows` at half, a third or two thirds of the page (or in an area of that width) shows more columns than fit there; the rest are left out | `show:` the ones that fit, or `width: 'full'` (an area of more columns) |
| `area-too-narrow` | A `rows`, embedded list or `matrix` stands alone in a one-column area of `areas` three or four columns wide, where a list is names, not a table | give the area two columns of the template, or put a breakdown or a metric there |
| `stacked-lists` | Two or more related lists stand one under another, on a page that is not a document (paper has no tabs) | `{ listTabs: true }` (or `false` to keep the stack); one row is `current(...)` |
| `bare-title` | A page with no header opens with a block of fields or a table | `header({ status: 'stage', facts: [...] })`, then `fields([...])` |
| `fields-by-type` | Fields grouped as Details, Links, Dates, Address | a summary, a properties rail in the aside, a `table` sheet |
| `default-presentation` | A `fields` call says the presentation it would have drawn anyway: `properties` in the aside, `summary` in the main column | leave `presentation` out |
| `vague-heading` | A section, or a New form's group or step, titled Details, Info, Data, Other | its content's name: the record's noun, Contact, Terms |
| `thin-card` | A `card` shows its record's name only | `card('Owner', 'owner_id', ['city', 'phone'])` |
| `unitless-fact` | A bare number in a facts line or a header | `{ unit: 'mi' }`, or `{ column, after: '…' }` |
| `shown-twice` | A headline's figure repeated as its subfigure | drop one |
| `destructive-first` | The first action (the filled button) cancels or deactivates | the forward verb first, `confirm: true`, or `header({ destructive: [...] })` |
| `no-forward-verb` | A record's only actions end it (cancel, deactivate, end) | add the verb its work moves on by, or a related `create` |
| `thin-workflow` | A workflow of 2 steps, or most values outside it | 3–6 ordered steps; tones for side exits |
| `undressed-vocabulary` | A status without tones reads as body text | `{ tone: { open: 'info', '*': 'neutral' } }` |
| `raw-label` | A `recordLabel` template names a time, money, or a date with no parent beside it | words and references; a day may tell siblings apart beside its parent: `'{lease_id} · rent due {due_on}'` |
| `required-unfilled` | A New form or a related `create` leaves a required column empty, or a status unchosen | `show` it, or `defaults: { status: 'new' }` |
| `calendar-address` | Records are addressed under a calendar or board | `view: 'the-grid'` on the resource |
| `default-shell` | No look, no logo, a flat menu or table icons | `ui.theme`, `ui.logo`, `navGroup`, `icon:` |
| `repeated-query` | The same query written in two places or more over one resource | `segments: { open: 'status is open' }`, then `'open'` in each place; `--fix` lifts one whose name reads off its condition |

## Measured in a browser: mistri grade

`check --design` reads the definition; `mistri grade` measures the drawn
page. It serves the App as `shot` does, opens every view and a record of each
page at 1280, 390 and 320 wide in light and at 390 in dark, and prints one line
per finding with its fix, at the file and line that declares the page where it
can find one, else at `page@width`. The run ends with a score out of 100; an
error fails it with exit code 2. `--json` prints one document instead. An App
with sign-in is graded signed in as the role that reads the most (a person's,
never a service role), and the run says which; `--as <role>` grades another, and `--as <email>` an account you
already made, its password in `MISTRI_AS_PASSWORD`. A role signs in as an account of it in the
App's local store (one with a person row first, then the earliest made), inside a copy where its password is reset, so the pages show that person's own rows; where
there is none, a fresh account signs in, owns no rows, and the run says so.

`--theme <id>` grades the App in another look and gates that look: any error
fails it whatever the score. A finding the theme causes is placed at the theme
— a color that is one of its tokens by its path (`cadence.colors.light.lineControl`),
and a layout finding the App's own look does not have on the same page and
window by its type scale or density. `--theme all` grades every look the App
can wear as one table, `--palette all` each palette and `--as all` each role
([the theme contract](/docs/theme-contract/)); every finding of a code the
contract holds says its promise (`C1` to `C13`).

```sh
npx @mistriwork/mistri grade . --config mistri.json
npx @mistriwork/mistri grade . --config mistri.json --as manager --json
npx @mistriwork/mistri grade . --config mistri.json --theme cadence
npx @mistriwork/mistri grade . --config mistri.json --theme all --palette all --as all
```

| Code | Finding | Fix |
| --- | --- | --- |
| `page-error` | The page threw, or a section could not be drawn (error) | read the console; `mistri check --app` names most causes |
| `failed-request` | A request the page made failed or answered 400 or more (error) | the server's log says why; a 404 is a route, file or record the App does not have |
| `sideways-scroll` | The page scrolls sideways (error) | fewer columns (`show:`), a row that wraps, or a full-width section |
| `clipped-number` | A figure is cut off: an ellipsis on a number, a metric wider than its card (error) | give its column room (fewer columns beside it) or its section `width: 'full'` |
| `overlap` | Two controls are drawn over each other (error); the page scrolling under a bar pinned to the window, as a phone record's verbs are, is not one while the page can scroll it clear | let the row wrap, or move one into the ⋯ menu |
| `low-contrast` | Text under 4.5:1 (3:1 when large) on its ground (error) | the look's tokens, not a color of your own |
| `faint-edge` | A field's, a select's or a picker's edge under 3:1 on what it sits on (error) | the look's control edge, never a hairline of your own |
| `hidden-focus` | At 1280, a stop the Tab key reaches shows no ring of 2px at 3:1 and no other change (error) | the look's `--focus` ring, never `outline: none` alone |
| `print-contrast` | A record printed has words, a link or the accent under 4.5:1 on white paper (error) | a light-mode accent and link that read on white |
| `changed-app` | Under `--theme`, a control or part of the accessibility tree at 1280 is gone or added against the App's own look's; a control folded into a "More" menu still counts when grade opens the fold and finds it there, a shortcut hint and chart ticks do not (error) | report the part: a theme changes how the App looks, never which controls a reader can reach |
| `layout-shift` | The page moves more than 0.1 (CLS) after its first paint (error) | give the late part its height before it arrives |
| `clipped-text` | Words cut mid-word with no ellipsis: a chip, a label (warning) | let them wrap, or say less |
| `small-target` | On a phone, a control under 44px either way (warning) | padding, not a smaller box; report the platform's own controls rather than restyle them |
| `empty-section` | A section drawn with nothing but its heading (warning) | `empty: 'No visits yet.'`, or hide it when empty |
| `mixed-format` | One column or section says its figures two ways: cents and none, grouped and not, compact and full; a section's quantity beside its price is two measures, not one (warning) | one `format` for the column, not text built by hand |
| `round-ticks` | A chart's axis counts in steps that are not 1, 2, 2.5 or 5 of a power of ten (warning) | let the chart choose its scale; say the figure's `format` |
| `header-wrap` | A record's name takes more than two lines on a phone 390 wide (warning) | a shorter `recordLabel`, the rest as header facts |
| `color-only` | A toned mark, a dot or a swatch, with no word, name or label beside it (warning) | a status as its dot and word, or an `aria-label` on a mark that stands alone |
| `long-measure` | At 1280, prose runs past 80 characters a line (warning) | a narrower column, not smaller type |
| `unsafe-motion` | At 1280, a part moves under reduced motion, or takes past 200ms otherwise; a spinner loops only while it waits (warning) | the platform's motion; report a part that moves |
| `heavy-theme` | The theme's own faces and logo pass 200 KB on a cold visit (warning) | fewer weights, a variable face, a smaller or SVG logo |

## What it does not check

- **How wide a value is.** A column's width is judged by what it holds (a
  day, a moment, a number, a word, a chip), not by its values, at a desk
  1280 wide in the App's shell. Whether a long name fits is for
  `mistri shot` and your eyes.
- **Multi-line text boxes.** A New form draws prose-named text (`description`,
  `notes`, `body`) as several lines already; `form.fields.<col>.multiline` says
  otherwise.
- **A tab strip of one.** Validation refuses one, so it is never a warning.

A good record page opens with a `header()` and a summary. Its related lists
are tabs of at most 4 columns. The aside holds a `card` for the parent, the
`current()` child, a `properties` rail and `history()`. See [pages](/docs/pages/) and
[looks](/docs/looks/).

## Related

- [mistri check](/docs/check-codes/): every other check code and the exit codes.
- [The theme contract](/docs/theme-contract/): the promises the grade's theme codes measure.
- [Composing a record page](/docs/compose-record-page/): the rules these warnings come from.
- [Build with a coding agent](/docs/build-with-an-agent/): grade before handing back.
