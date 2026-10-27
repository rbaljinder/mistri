# The tablewalk design system

The official record of how this product looks, moves, and refuses to
look. It was practice before it was law: everything here is extracted
from decisions already in the stylesheets, plus doctrine adopted from
two outside sources — Emil Kowalski's animation teaching
(emilkowal.ski — purposeful motion, and what *not* to animate) and
impeccable.style's anti-pattern catalogue (the "AI slop" tells). Where
this file and the stylesheets disagree, fix one of them in the same
commit; a design doc that drifts is worse than none.

## The rules at a glance

The body of this file is the law; these are the rules most often needed, each
a pointer into it.

1. **Operate, don't persuade.** Quiet, square, dense, full width. Hierarchy
   comes from type and the 40px section seam, not from boxes (Voice; the
   refusal list).
2. **Rules, not boxes.** A section is announced by one rule; a table is its
   rows under a 2px rule in the ink; no card in a card (Standing layout
   rules). Lumen's hairline in place of the 2px rule is its own recorded
   exception (Lumen's exceptions).
3. **Tokens only.** Every colour, radius, face, duration, space and text
   size is a custom property; a literal outside the tokens (`tokens.css`) and the looks'
   presets is a bug (Tokens; Space and text). Three looks dress Apps; the database browser wears none. Lumen is the
   default.
4. **The cascade is layered.** A later layer wins by order, never by
   specificity; layout no look may move lives in `structure.css` (The cascade).
5. **One action is primary.** A record's first verb and a list's New are
   filled; the rest are quiet; Delete is never a button. Every primary a look
   draws — page, list and record headers, dialogs, forms, drawers, a
   landing's search — fills in one color, the theme's primary-action color
   (`--primary`), which may be the ink rather than the accent (Standing
   layout rules).
6. **Meaning is a dot and its word.** Tones are earned through the display
   map; a neutral value is a grey dot and its word where the look says
   status with a dot, plain text where it says it with a pill (the refusal
   list; Sage's and Lumen's exceptions). The dot and its word belong to a
   vocabulary, never to a figure: a toned amount or count is set in its tone's
   ink alone (no tint, no dot), and a neutral one is no tone at all, so a
   column of figures keeps the edge its label stands on.
7. **Motion is information or absent.** Enter with ease-out, leave at once,
   hover is 120ms of colour, a navigation swaps finished screens, reduced
   motion silences all of it (Motion).
8. **AA everywhere, the house ring on every focus.** Text 4.5:1, a field's edge
   3:1 (a command form's field is a clean outline at rest, and the ring
   replaces it), targets 24px (44px where asked), focus never dropped (Access).
9. **Public pages are a storefront.** A signed-out reader gets no kind label,
   no Back, no folds, no editing panels (Standing layout rules).
10. **Nothing scrolls sideways but its own box**, and a label never breaks
    inside its control (Standing layout rules).

## Voice

Quiet, square, spaced. Legibility problems are fixed with colour and
spacing before weight. The endorsed model is the classic record form:
dense, full-width, label-over-value, everything scannable. This is an
**operate**-mode product (a tool people complete tasks in), never a
persuade-mode one: nothing on a working screen exists to win attention.

## The cascade

Every stylesheet stands in a declared layer, named once at the top of
`style.css`: `base` (the tool's own rules, the component sheets
`features.css` imports, and ahead of both @mistriwork/ui's tokens and its
primitives' own rules, `packages/ui/src/tokens.css` and `primitives.css`), `components` (a sheet a component brings with it),
`kit` (the dress under every look, and custom themes' token machinery), `look`
(each look), `theme` (what an App's own theme says past the recipe menu: its
parts' styles in `partsLook.css`, its patterns in `surfacesLook.css` and its
own stylesheet as the server reads and scopes it, each fetched only when a worn
theme says one), `structure` (`structure.css`: layout no look may move, such as
the list head in the crumb bar, a thumb's 44px menu rows and a dashboard layout's grid) and `print`. (A page
drawn with @mistriwork/ui alone takes the same tokens and primitives from its `style.css`, in a `mistri-ui` layer of
their own; the kit takes them into `base` instead, where a layer under base would let an element rule beat a
primitive's class.) A
theme's rules stand over its look's so a part it dresses is dressed whatever
the look said, and under `structure` so nothing it says moves a box.
What every look shares, and Mono's rules, are in `themeFamilies.css`;
Lumen's and Sage's own rules stand in `look` from a sheet of their own
(`lumenLook.css`, `sageLook.css`), as do the few recipes only an App's own
theme picks (`brandLook.css`: a dark bar, a washed or underlined menu, a
ruled stat, a tinted table, small capitals and book figures), fetched when
worn and waited for before the page is revealed, so a look's own rules add
nothing to the first stylesheet
(the move was proven by the same computed-style snapshot: no difference in
any look, light or dark, at a desk or on a phone); a chart's rules
travel the same way with the chunk that draws it (`components/Chart.css`).
A later layer wins whatever its specificity, so no rule wins by out-specifying
(`:root body …`) or out-loading another. A look rule that would reach a
component it should not dress is scoped, not outranked. The layer change was
proven to leave every computed style unchanged across the sample Apps' pages
and all stories in every look (a before/after snapshot of every element's
computed style), apart from three fixes it made on purpose: the calendar's own cell padding and
rules, a look's bold current sidebar room, and the pager's page box at the
field radius.

An App's own component (a custom section, a value renderer, an input, a
list's rows or a whole room) is held to the same rules as the tool's. Its stylesheet is served inside `components` and
under `@scope` of the component's own element, so a look still dresses it,
`structure` still wins over it and nothing it writes leaks out. It draws with
the public kit (`@mistriwork/mistri/ui`: `Card`, `Stack`, `Button`, `Value`, `Tone`,
`Meter`, `Empty`, `Icon`, `Segmented`, `Stat`, `Columns`, `Table` (the look's table, so its head and hairlines are the platform's), whose own sheet `components/sdk/kit.css` is in the
same layer) and with tokens only. `mistri check` warns on what these rules
refuse — a literal colour or radius (a pill's `999px` and a circle's `50%`
excepted), motion past 200ms or outside a
reduced-motion guard, a shadow, a class outside `c-<id>-`, a popup placed by
`getBoundingClientRect` — the way the theme diagnostics warn.

## Tokens (packages/ui/src/tokens.css — the only source)

Every colour, radius, face, duration, space and text size is a custom property on
`:root`, overridden per theme (dark), per app (the theme whitelist),
and never bypassed. A hex value outside tokens.css and the looks'
definitions (`packages/engine/src/shared/themePresets.ts`, whose palettes carry each look)
is a bug.

**Two dresses, one rule each.** The database browser — `npx tablewalk
<db>`, and an App's Workbench — wears these tokens and nothing else: warm
paper, the green accent, the code face in its chrome and its data, flat
dense rows. The three looks (Lumen, the default an App wears when neither it nor
its reader names one, then Mono and Sage, which an App opts into; an App
may also define its own with `defineTheme`; `visualThemes.css`,
`themeFamilies.css`) dress Apps only: every one of
their rules keys on `data-visual-theme`, which the browser never carries,
and its Preferences offer no Visual theme. A reader's built-in pick is kept for
the next App they open; custom choices belong to the stable App ID that offers
them, so matching theme names in unrelated Apps do not share preferences.
Every look draws its content on a white or
near-white ground (Sage's white panels on cream are the warm
page) and keeps its colour
for the top bar, the accent and the current item; its captions take an
ink darker than its hairlines and still quieter than its text.

- **Ground and ink**: `--ground`, `--surface`, `--raised`, `--line`,
  `--line-strong`, `--line-control` (a form control's edge), `--ink`,
  `--ink-muted`, `--ink-subtle`.
- **Meaning**: `--accent` (a fill; `--on-accent` is the words on it and
  `--accent-ink` the accent as text and links, each the page's colour and the
  accent itself until a theme names them or the accent would fail without —
  then the one that reads is derived) (+ `--accent-soft`, derived when an App gives
  one colour, and the first chart series, so a brand's charts are the brand's
  colour), `--link`, `--status-warning`, `--status-critical`, `--status-info` (identifiers /
  info), `--status-good` (success — deliberately *not* the accent, so an
  indigo-themed app still says "paid" in green).
- **The navigation**: `--nav-ground`, `--nav-ink`, `--nav-muted`,
  `--nav-line`, `--nav-accent`, `--nav-current`, `--nav-on-current` — the
  bar and the side menu, whichever the shell draws, under every bar recipe:
  inside the menu the page's inks are the nav's, so a rule drawn in `--ink`
  or `--ink-muted` there draws in `--nav-ink` or `--nav-muted`. The search
  field and a soft bar beside a side menu are the page's; and the rules,
  `--rules-section`, `--rules-head`, `--rules-weight`; and the series,
  `--chart-1` to `--chart-8`.
- **One name per color.** A color token is its `defineTheme` path,
  hyphenated (`ink` is `--ink`, `nav.ground` is `--nav-ground`,
  `status.critical` is `--status-critical`), and the compiled theme, `check`'s
  messages and `theme show` say the same name. There is no second vocabulary
  to translate through.
- **Every color drawn is a token.** `npm run test:tokens` serves the sample
  Apps under canary themes and fails on a color an element draws that is not
  a role, or a mix of roles, before and after the roles move
  (docs/theming.md, Validation). A part with no role for what it needs asks
  for one.
- **The photo stage**: `--lightbox-ground`, `--lightbox-ink`,
  `--lightbox-line` — the lightbox's deep ground and its ink, the same in
  both themes, because a photograph is judged against dark.
- **Faces**: `--mono` (the data face; an App may re-point it, the
  reader's typography preference still wins), `--sans` (prose),
  `--code` (never themed). In an App the interface is sans: `--mono`
  points at `--sans` unless the App or its preset names a face, and what
  is read character by character — code, the query language, and in
  Mono a grid's short values (ids, dates, codes) — keeps `--code`. A column may ask for a face (`display: { vin: { face: 'code' } }`); unasked, an App sets only keys, references and codes in the data face.
  A look's sans is the system's own, and its identity comes from scale,
  weight and tracking — except Lumen's: Lumen is set in Inter, which ships
  with Lumen's sheet (`lumenLook.css`, the variable face's Latin subset, 48
  KB) and is preloaded beside it, so only a page wearing Lumen fetches it and
  no first-paint bundle carries it. Named and not shipped, Inter drew only
  where it was installed, and a Lumen screen was set in a different face on
  every machine. Until it arrives Lumen draws Arial cut to Inter's measure
  (`size-adjust` and the ascent, descent and line-gap overrides), so the swap
  neither rewraps a line nor moves a baseline. No other face is fetched or
  bundled.
- **Type**: three steps of heading — `--type-list-title` (20px, a list
  naming itself), `--type-record-title` (26px, a record or a dashboard;
  Mono takes 30px) and `--type-display` (32 to 44px with the
  window, the landing's headline) — each in the look's `--heading-font`
  at its `--heading-weight` (the title role's weight), which each look sets in themeLooks.ts and
  none takes past 700 (a heavier ask resolved Iowan Old Style to its Black
  cut). Tracking by size, the only letter-spacing a look sets:
  `--track-display` (−0.022em, 24px and up), `--track-title` (−0.012em,
  17 to 23px) and `--track-caps` (+0.05em, capitals and small caps at a
  label's size).
  Every size is written over the theme's base, `calc(<n>px * var(--type-k))`
  (`--type-k` is `type.base` / 13px, 1 unless a theme says a base), so one
  setting grows the whole scale; `test/check-client-type.mjs` refuses a bare
  pixel size. A theme's type roles (`type.roles`, docs/theming.md) are worn
  as `--type-<role>-<property>` and a `data-type-<role>` attribute, and say
  only what differs from the look.
  Navigation uses the shared `--type-ui` (13px) and `--icon-ui` (18px) roles.
  A comfortable sidebar increases row spacing and hit areas, not type size;
  navigation must not compete with content headings.
  App headers use a 50px minimum with 4px vertical padding; account controls
  keep their hit area without adding a second band of padding. List panels,
  titles and filter rows share the same 14px horizontal inset.
- **Shape**: `--radius` — one radius, themable — and its one larger step,
  `--radius-lg` (1.5×, for a panel, the palette and a stat card), derived
  so an App's or a look's radius moves both and Mono stays square — an App's
  authored radius included, which Mono does not take (a theme built on Mono
  that names its own radius keeps it). One rule on one screen: Compass's 8px
  once rounded its window switch and pickers beside Mono's square cards. No
  per-corner creativity and no other literal corner in the looks; pills
  are `999px` (a tab, a count, a label's chip) and that is the entire
  exception.

  Shape is the look's, by role. Every surface names its role's token and
  never a corner or a lift of its own — `.th-menu` once said 8px and a soft
  20px shadow, so in Mono the column menu and the settings menu came out
  round and floating beside square fields:

  | Token | What wears it | Database browser | Every look |
  | --- | --- | --- | --- |
  | `--radius` | a control: an input, a button, a chip that is not a pill, a day in the calendar | 6px | the look's control radius (Mono 0, Sage and Lumen 8; an App theme's own, 0 to 8), or the App's |
  | `--radius-item` | a row inside a popup (a menu item, an option), a small button in a bar | 5px | `min(--radius, 5px)` |
  | `--radius-pop` | a menu, a listbox, a typeahead's list, a popover, a hover card, the date picker | 8px | `--radius` |
  | `--radius-panel` | a box on the page: a card, a code or result panel | 8px | `--radius-lg`; a board's card keeps `--radius` unless the theme names its panel corner (`shape.radius.panel`, worn as `--panel-radius`) |
  | `--radius-dialog` | a dialog, the palette, the page editor | 10px | `--radius-lg` |
  | `--shadow-pop` | a popup and a toast | its own per popup (below) | the look's (Mono none) |
  | `--shadow-panel` | a hover card, a drawer | 0 10px 34px | the look's (Mono none) |
  | `--shadow-modal` | a dialog, the palette | its own per dialog | the look's (Mono none) |
  | `--shadow-control` | a field's, a quiet button's and the pressed window's hairline lift | — | 0 1px 2px at 4% (Mono none) |
  | `--shadow-card` | a card a recipe boxes (a section, a field group, a stat) | — | the look's (Lumen's and Sage's), or a theme's `card` step |
  | `--shadow-ink` | the ink every lift above is mixed from | — | the look's (its ink by day, its ground by night), or a theme's `shadow` |
  | `--focus-width`, `--focus-offset` | the house ring (Access) | 2px, 2px | the same |
  | `--focus` | the house ring's ink, and the border a focused field shares with it | the look's `focus`: a softer, mid-tone tint of its accent, at least 3:1 on `surface`, `background` and `subtle` in light and dark | the accent, where a palette sets no `focus` |

  A small mark (a bar, a swatch, a tag) is `min(3px, var(--radius))`: at most
  its own size, never rounder than the look. The role tokens stand on `body`,
  beside `--radius-lg`, because that is where appnav writes an App's or a
  look's `--radius`; the looks point them at it in `visualThemes.css`, and
  Mono's lifts are `none` in `themeFamilies.css` — square and hairline, a
  popup stands on its edge in the ink. A theme's `shape.elevation: { card, float }`
  steps over its look's drawing: `none`, `hairline`, then `low` (these
  popups' fall), `mid` (Sage's) and `high` (Lumen's), each mixed from
  `--shadow-ink`, so a theme picks a lift and a colour and never draws a
  shadow of its own geometry. The database
  browser keeps every value it had (proven by the computed-style snapshot:
  no difference on any Workbench page, popups open, light and dark, desk and
  phone); where its lift was a literal of a popup's own, a rule under
  `:where(:root:not([data-visual-theme]))` right after the popup's keeps it
  at the same specificity. `test/check-client-shape.mjs` refuses any other
  literal corner (0, `999px` and `50%` aside) or lift (a blurless stroke in a
  token's colour, such as a drop marker, aside) in the client's stylesheets.
- **Motion**: `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`,
  `--ease-in-out`, and `--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)` for a
  drawer or sheet that slides from an edge (Motion doctrine 14); `--t-hover: 120ms`, `--t-press: 140ms`,
  `--t-popover: 160ms`, `--t-panel: 200ms`, and `--t-changed: 1200ms`, the
  one fade of a row another person changed (rule 11). There is no slower token
  on purpose: chrome never earns more than 200ms, and a fade that says
  something happened elsewhere is not chrome. A theme's `motion` picks a
  pace over these five and nothing else: `house` (these), `brisk` (each a
  quarter quicker) or `still` (0ms, and a navigation's enter skipped, as
  reduced motion draws it), so a pace can quicken or silence the house's
  motion and never add to it. A transition written in the house's own
  durations reads the token, so a pace reaches it.
- **Space and text.** Two scales, on `:root` beside the colours:

  | Token | px | | Token | px |
  | --- | --- | --- | --- | --- |
  | `--space-1` | 2 | | `--text-xs` | 11 |
  | `--space-2` | 4 | | `--text-sm` | 12 |
  | `--space-3` | 8 | | `--text-base` | 13 |
  | `--space-4` | 12 | | `--text-md` | 14 |
  | `--space-5` | 16 | | `--text-lg` | 16 |
  | `--space-6` | 24 | | `--text-xl` | 20 |
  | `--space-7` | 32 | | | |
  | `--space-8` | 48 | | | |

  Between the control steps sit four halves, `--space-1h` (3px), `--space-2h` (6px), `--space-3h`
  (10px) and `--space-4h` (14px): a button's, a field's and a chip's own
  padding, which no rhythm moves; the smallest is also a caption's
  gap over its value. Every padding, margin and gap is a step, a
  half, or a semantic token over the scale: `--room-inset` (14px, a room's one
  content edge), `--section-seam` (40px, between a record's sections and a dashboard's rows), `--field-gap`
  (20px, between a form's fields and a record's field columns) and `--row-h`
  (an App list's row, drawn 32px at compact, 40px at comfortable, 44px at
  spacious and under a finger, whatever the density's zoom). Every text size
  is a step over `--type-k`, or a heading's role (`--type-list-title` and
  the rest). A theme's `rhythm` moves the layout steps (`--space-5` up) and
  the seam a quarter closer (`tight`) or wider (`airy`), never a control's
  own padding. `test/check-client-space.mjs` refuses a new literal; what was
  off the scale when it arrived is counted in `test/client-space.allow.json`
  and only shrinks, and a value off it on purpose says why beside it
  (`/* off-scale: … */`).

Apps may theme exactly what `defineTheme` says, and nothing else: colours by
purpose for light and dark (ground, surface, ink, accent, the meaning
colours, the chart series, the bar, the shadow's ink), a corner and an
elevation (a preset, or a step of the platform's lifts for cards and for
what floats), a face and a
title scale, a starting density, and one treatment per part from a closed
recipe menu (`packages/mistri/src/shared/themeSpec.ts`). Every recipe is one a built-in look
already wears — the built-ins are written in `defineTheme` themselves — so an
App theme can only ask for what this system already draws; a look the menu
cannot say extends the menu, it is never special-cased. Apps write no CSS. Lumen, Mono and
Sage all start an App compact; comfortable zooms the page by 1.12 and spacious
by 1.24, which a 1280px desk cannot hold a wide list in (Lintel's rent roll
scrolled 213px sideways in Mono at comfortable). A person's own saved density
choice wins over any look's start. A
built-in by name with the App's `accent` (one colour, or `{ light, dark }`),
`radius` and `font` remains the short spelling for "this look, my colour".
One validator (`packages/mistri/src/shared/themeCheck.ts`) holds every theme at `tablewalk
check`, at `build` and at a tenant's save: text at 4.5:1 and controls at 3:1
on their effective grounds in light and dark and every palette, and adjacent
chart series at least 8 apart (OKLab ΔE×100) for protanopia and
deuteranopia and 10 to normal vision. A failure names the colour by its name
in the theme and the reason. A themed app that cannot be read is the
product's failure.

A tenant may change less than an App: its name, a logo, an accent, one of
the App's palettes or themes, a corner and a density, each only where the App
allows it (`branding.allow`). Grounds, ink and recipes are never a tenant's.

Theme, palette and color mode are separate choices. A theme owns structure,
typography and radii; its optional named palettes override colors only, each
with light and dark values. The existing light/dark pair is its Default
palette. Preferences offers Palette only when that theme has alternatives,
and remembers the choice per App and theme. Color mode remains Light, Dark or
System. Workbench never inherits an App palette. Palette variants must pass
the same effective-color checks as the original pair.

## Motion doctrine (after Emil Kowalski)

1. **Motion is information or it is absent.** An animation must say
   something a still frame cannot: where a popover came from, that a
   press landed, that content replaced content. Decoration — pulsing
   dots, attention-seeking loops, hover theatrics — is refused.
2. **Frequency buys subtlety.** The more often a gesture runs, the less
   it may move: keyboard navigation animates *nothing*; hover feedback
   gets 120ms of colour only; a popover, opened occasionally, may enter
   with 160ms of fade-and-settle; a panel, rarer still, 200ms. A drag is
   the one frequent gesture that moves things, because there the movement
   *is* the information: where the item will land is a gap opening
   between its neighbors (they slide by transform, `--t-press` and
   `--ease-out`), and a drop settles the copy into that gap in no more
   than 150ms. A rule drawn over unmoving rows said "here" less well, and
   a copy that vanished on release left the eye to find the item again.
   Under reduced motion the gap is there at once and the copy goes.
3. **Enter with ease-out; leave instantly.** Arriving UI decelerates
   into place (`--ease-out`); departing UI just goes — an exit
   animation makes the interface feel slower exactly when someone has
   decided to move on.
4. **Animate transform and opacity, nothing that reflows.** The one
   sanctioned exception is the tour ring, which animates position to
   *carry the eye* between stops — that is the information.
5. **Origin-aware.** A popover grows from its trigger
   (`transform-origin` at the anchor edge), because spatial continuity
   is the message.
6. **`prefers-reduced-motion: reduce` silences all of it.** Enter
   effects are declared inside `no-preference` blocks (the
   `@starting-style` pattern the peek card uses), so reduction is the
   default, not a patch.
7. **Never gate input on motion.** Nothing waits for an animation; a
   click during an enter lands on the finished state.
8. **Data does not dance.** Grids, charts and numbers paint complete.
   A live refresh swaps a finished screen for a finished screen —
   the reader sees values change, never a loading performance.
9. **A navigation swaps finished screens.** Opening a record, following
   a reference, Back and Forward: the screen being left stays, as a still
   copy where it stood, while the room that replaces it is laid out
   beneath and asks for what it needs; when nothing it asked is still
   out, the copy goes and the room is there complete
   (`packages/kit/src/client/navigationHold.ts`). No empty pane, no skeleton under the
   hold, no section pushing the next one down. Past 300ms the copy is dimmed,
   still, so the wait is said without motion; past 1.5s the room is shown
   as it stands — a record page that is still arriving then keeps its
   place, out of sight, and is shown whole once complete
   (`PageRoom.tsx`, `Revealed`; after the startup veil's second too). A
   record whose row has not answered by then draws its page's anatomy in
   placeholders — the head's name and facts, the main column's and the
   aside's sections in their own shapes, from the page's definition
   (`PageSkeleton`) — inside the height it holds, and is replaced whole, so
   nothing under it moves; an empty pane read as a page that had failed. Any
   press, key or wheel ends the hold at once (rule 7).
   A step to a new place starts at its top; Back returns to where the
   reader was on that screen; a refinement keeps its scroll. A step to a
   new place taken with the pointer may enter with 160ms of opacity (from
   0.6, never from nothing) and 4px of settle, once complete; keys, Back
   and refinements animate nothing (rule 2), and reduced motion silences
   it (rule 6). There is no exit. `e2e/navigation-hold.spec.ts` reads
   every frame of list → record → related record → Back → Back at a desk
   and on a phone, and holds it to no unfinished frame and no layout shift.
10. **Five durations and one curve.** Every transition takes its time from
   `--t-hover`, `--t-press`, `--t-popover`, `--t-panel` or `--t-changed` and its curve from
   `--ease-out` (`--ease-drawer` for a drawer); none says `ease` or a number of milliseconds of its own,
   and each is declared where reduced motion silences it. The two loops
   are waits, not decoration: a placeholder's sweep and the Workbench's
   reading-a-schema dot.
11. **A change from elsewhere is said once, quietly.** A row another person
   changed (a grid's row, a card, a queue's row, a board's card) is tinted
   with `--changed-hue`, a warm amber that is no look's accent (Mono's is black
   and Sage's grey, which tinted like a selected row), `--changed-mix` of it over
   the surface (more on a dark ground), held a moment and faded over `--t-changed` (1.2 s); a record says who
   changed it in one line; nothing moves, nothing toasts, and a list the
   reader is working in holds still behind an "N updates · Show" pill. The
   pill (`position: fixed`) and the notice over a draft (hung from the
   record's head, `position: absolute`) are out of flow: they never push
   content. While a draft is open the notice speaks for the record, and the
   "Updated" line under its head is not drawn. Reduced motion: no tint.

12. **A press lands.** A button or row answers pointer-down with `:active`
   `transform: scale(0.97)` over 100–160ms (`--t-press`) and lets go the same
   way; a keyboard activation does not animate (rule 2). Nothing presses below
   0.95, and nothing ever scales from 0: an element that appears starts from
   0.95 and opacity, never from nothing.
13. **Tooltips: the first waits, the rest are instant.** The first tooltip
   after a pause is delayed so a pointer crossing the screen does not set them
   off; while one has just been seen, the next opens at once and with no
   animation, so moving along a toolbar reads as one continuous label.
14. **Reversible state transitions; one-way entrances keyframe.** A thing that
   can be undone mid-flight (a hover tint, a toggle, a disclosure, a drawer) is
   a `transition`, which reverses from where it is; a `@keyframes` is for what
   only runs forward. A drawer or sheet slides on `--ease-drawer`, on transform
   alone. Dialogs are exempt from origin-aware motion (rule 5): they are
   modal, centred and belong to no trigger, so they fade and settle in place.
15. **Performance bans.** No `transition: all` (name the properties); no
   animated `box-shadow` (fade a pseudo-element's opacity instead); blur at
   most 20px, in a backdrop or a shadow; `will-change` only where a trace
   showed a dropped frame, and removed when the motion ends.
   `test/check-client-motion.mjs` holds the checkable half: `transition: all`,
   `ease-in`, `scale(0)`, a literal duration over 300ms and a `:hover` rule
   outside `@media (hover: hover)` fail `npm test` (a reason beside an
   exception: `/* motion-ok: … */`; the `:hover` rules older than the check
   are counted per file and only shrink).
16. **Staggered entrances are refused.** Rows, cards and tiles that arrive
   one after another, each a beat behind the last, are a performance of
   loading; data does not dance (rule 8). Everything in a screen arrives
   together.

## Mobile

A phone is a first-class room, not a squeezed desk (`e2e` runs every spec at
a desk and at 390px).

- **Safe areas.** Anything fixed to an edge (a bottom bar, a sheet, a toast)
  pads by `env(safe-area-inset-*)` on that edge, and the page declares
  `viewport-fit=cover` so the insets exist.
- **Hover is gated.** Every `:hover` rule sits inside
  `@media (hover: hover) and (pointer: fine)`; a touch screen keeps a hover
  after a tap, and a tint that sticks reads as a selection. Nothing depends
  on hover to be reachable: what hover reveals is also reachable by focus and
  by a long press or a visible control on a coarse pointer.
- **16px inputs on coarse pointers.** A text field is at least 16px under
  `@media (pointer: coarse)`, because iOS zooms the page into anything
  smaller and does not zoom back (not yet verified on WebKit).
- **`touch-action`.** A control that is only pressed says
  `touch-action: manipulation` (no double-tap zoom delay) and a transparent
  tap highlight, and its press is our own `:active` (scale 0.97 unless motion
  is reduced, rule 12; a link dims); a surface that pans or draws takes
  `pan-x`/`pan-y`/`none` on purpose.
- **The keyboard resizes the page.** Every served page says
  `viewport-fit=cover` and `interactive-widget=resizes-content`: the layout
  runs under the notch and shrinks to the visible area when the keyboard opens.
- **The browser wears the theme.** The head carries `color-scheme` and a
  `theme-color` per mode from the worn theme, so the address bar and
  overscroll wear its ground. It follows the reader's system setting, not the
  in-App toggle.
- **A person's setting outranks a theme.** `prefers-contrast: more` darkens
  the muted inks, the hairlines and the focus ring;
  `prefers-reduced-transparency: reduce` makes scrims opaque. Both are in
  `packages/ui/src/preferences.css` and use `!important` on purpose: theme
  tokens are inline on the root.
- Targets are 44px on a coarse pointer (rule 8); sideways scroll is a
  defect (rule 10).

## Truncation

Text is cut only by this policy. **Identifying text wraps**: a record's name,
a title, a label that says which thing this is. **Secondary metadata
end-truncates** with an ellipsis and carries the whole value in a `title`.
**File names, paths and ids truncate in the middle**, so the extension and
the distinguishing tail survive. **Numbers, amounts and dates are never
truncated**: the column or the figure gets the room it needs, or the layout
changes. **In a form nothing typed or chosen is cut short**: a label, a
choice, an answer and a review value are the reader's own words, so they wrap
(`overflow-wrap: anywhere`), and the smoke's `reflow-320` variant (320px, 2x)
holds every App page to no sideways scroll.

## The refusal list (after impeccable.style, kept where it applies)

The list binds the built-in looks and what the platform draws. An App's own
theme is bounded instead by its token menu and the theme contract, C1 to C13
(site `theme-contract.md`, `packages/mistri/src/server/build/themeContract.ts`): it may be
round, warm or loud where this list refuses it, so long as every promise holds,
and `check` and `grade` hold them.

Tells that read as template output, refused on sight: beige "AI"
palettes and italic serif display type; cards nested in cards (one
box, hairlines inside); everything-equal spacing (hierarchy comes from
the 40px section seam vs the 20px field gap, not from more boxes);
status chip soup (tones are earned through the display map, and an
all-info tone map says nothing — the platform infers none; in
a look a tone that carries meaning is a dot and its word, with no
container, and the rest of a vocabulary a grey dot and its word, so a
column of statuses scans as one); over-rounding
(one `--radius` and its one larger step); ghost cards; hard offset
shadows; pulsing anything; image-on-hover motion; vague headlines (a
section is titled by what it shows). Side-tab borders are refused: a
current item is a tint and the accent's ink, an underline or a fill,
never a bar down its side (Lumen's board-card stripe says a card's
meaning, not that it is current: Lumen's exceptions; so does the 2px edge
in its tone on a conversation's tinted message, an internal note).

**Sage's exceptions.** Sage recreates, as it is, a reference the
maintainer chose, and takes three departures from this list for itself
alone: a warm cream ground under white panels (where the list refuses
beige palettes), a soft layered shadow on its panels and stat cards,
mixed from its own ink (never a hard offset shadow), and meaning
said as a soft tinted pill (where the other looks say a dot and its
word) — only meaning: a neutral value stays plain text. Its radius is the authored ceiling, 8px, with the one larger step,
12px. Its navigation is a white panel too: the side menu, and a top bar that holds the menu, are drawn
in the panel's warm white on the cream page. A record's editing group is one white panel with a quiet border and no
shadow, when the group has its row to itself: sections sharing a row are
dressed alike. Summaries, headlines, facts and the supporting property rail stay on
the cream ground, with fine rules separating related information. A table
is not one of the exceptions: a list, a related tab and a dashboard's list
are rows on their ground under a hairline, never a white box of their own
(boxed, a record page was a stack of cards). Sage record tabs use ordinary sentence
case with the active group marked by the accent underline. Nothing here is
open to another look or to an App's tokens.

**Lumen's exceptions.** Lumen is flat, calm and modern, with its
character in details: a faintly warm shell around white working surfaces,
one confident accent, and elevation only on what floats. It takes these
departures for itself and for an App theme that picks the same recipes
(`stat: 'divided'`, `section: 'open'`, `fields: 'rail'`, `status:
'quiet'`, `chart: 'line'`, `board: 'strip'`, `steps: 'strip'` and the rest
of Lumen's picks in `themeLooks.ts`); each is one value on the menu, so the
departure travels as a whole or not at all. *Hairlines, not the 2px rule*:
a list, a section and a field group stand open on the ground, divided by
the look's 1px hairline rather than the ink's 2px rule; a dashboard's
figures share one strip divided by hairlines. Nothing on the page is
lifted: a menu, a popover, a drawer and a dialog — what floats — carry
the look's soft layered shadow (`--shadow-pop`, `--shadow-panel`, never a
hard offset), and by night the shadow all but goes and the hairline
carries the edge. *A dot for every status*: meaning is the tone's dot and
its word, and the rest of a vocabulary a grey dot and its word, so a
column of statuses scans as one; no status is boxed. *A chart's bare
line*: a series is a 1.5px line with nothing under it, over an unbroken
grid a shade lighter than a hairline, and points show only under the
pointer. *The board card's stripe*: a board's lane is headed by a strip
in its state's tint (grey for a value that says nothing), and each card
carries a 4px bar at its left in its own toned value's colour, else its
lane's — a rounded bar inset from the card's edge, never the edge itself,
and a mark of what the card is, never of what is current. *Radius 8/12*: the authored ceiling and
its one larger step, as Sage's. Everything else holds: one primary action
filled in the ink, Lumen's primary-action color, on every surface that draws one
(Standing layout rules), the accent (a confident blue) kept for tabs underlined in it, the
current room a soft pill of its tint, Inter shipped with
the look's own sheet (Faces), no motion beyond the house's. Lumen's palettes — **Violet**,
**Teal**, **Emerald**, **Rose** and **Amber** — change only the accent's
family (the tab underline, the link and current room,
the soft tint, the focus ring and the lead chart hue), each checked for
contrast and chart separation light and dark like the default. Nothing
here is open to another look or to an App's tokens. The references'
other markup is now the App's to ask for, each a block of its own that
every look draws plainly, and Lumen dresses only through its recipes.
*The banner* (`banner: 'gradient'`): a note an App marks `variant:
'banner'` stands on a soft wash from the accent toward the second
series, no rule round it, its eyebrow a small tinted tag, and its one
action filled in the ink rather than the accent — on a tinted ground an
accent button reads as one more tint. *Step cards* (`steps: 'tinted'`):
a breakdown's steps each stand on a 5% tint of their tone (the accent's
where none is said) with a deeper edge and a tinted rounded mark. The
avatar stacks, a donut's total, a board card's category and footer facts,
the lead icon square and the nav dot are drawn alike in every look
(tokens only), so they are not exceptions. One thing is the same
everywhere and on purpose: a QR code is near-black on white with its
quiet zone, in every look and by night, because an inverted code is
one many scanners refuse. A signature pad is the same: dark ink on white paper in
every look, so the picture it keeps reads on whatever page shows it.

## Standing layout rules

- **One column discipline**: every room runs full width with the list
  view's gutters; navigation never jumps the content edge.
- **Full rooms, capped measures**: field grids stop at 100rem,
  breakdown bars and donut legends at 46rem, prose at 70rem — the room
  keeps its width, the content keeps its shape.
  Dashboard guidance paragraphs use a tighter 70ch measure so short explanatory
  notes remain easy to read on wide screens.
- **Gutters are symmetric** (the grid stops 14px short of both edges),
  and the top-bar shell adds 22px of pane air where the sidebar used
  to soften the left.
- **A room has one content edge**, `--room-inset` inside the pane's gutter:
  the crumbs' words, a list's controls and rows, a board's first lane, a
  calendar and a record start on it (the app smoke run measures it). On a
  phone every App's pane keeps the same 4px gutter, whichever menu it wears,
  so the gutter and the inset never stack.
- **Nothing moves once it is drawn.** A first page is revealed finished,
  as a navigation is (Motion, rule 9): boot keeps the startup veil up until
  the room is quiet — nothing asked still out, no read running, nothing
  being drawn — a second at most (`startupHold.ts`), and a tenant's chosen
  workspace is revealed the same way. What still arrives late holds its
  place: a count keeps two digits' room, Export its button's width beside
  New, a metric its figure's height (a bar at the figure's size, never "…"), a
  chart its plot's room, a breakdown a row per group it expects, a record's
  facts their line and its verbs their row. A place says empty, refused and
  broken in one block (`Notes.tsx`): a mark, one sentence, at most one action
  under it; a list's tab with nothing under it says so by its noun and the
  tab's word, and only a search or filter past the tab is "No matches" with
  Clear. An App's list keeps its room through a sort or a page
  turn, as the Workbench's table does. Motion never hides a shift.
  `test/built-client-vitals.mjs` measures CLS, LCP and INP on the build and
  holds each to a budget tighter than Google's "good".
- The page never scrolls sideways, and neither does a card, a section, a
  related list or a dashboard's table. A table is fitted in this order, each
  step taken only where the one before still runs past its room
  (`gridSizing.ts`): everything whole on one line; an App's heads wrapped at
  their words; the row's name wrapped to two lines, kept whole, before any
  other words are; then those wrapped too; the columns that still do not fit
  folded, muted and a size down, under the row's name (or the widest text
  column where the name is a short key) as a detail line (an App's list) or left out (an embedded grid); only then the secondary text cut. A
  dashboard's matrix folds each row into labelled cells, and a strip of
  windows or a board's groups wraps. A row whose job is to scroll — a
  board's lanes, a phone's workflow steps, a heat map past its cells' floor —
  says so with `data-scrolls`; the smoke run
  (`scripts/visual-matrix.mjs --smoke`) fails on any other box that scrolls.
- **A strip of tabs fits its row; it never scrolls.** A record's tabs and a
  list's tabs (with its saved views) stay one row of whole, nonshrinking
  labels with an inset focus ring, and the tabs past the row's end go under
  a More at its end, as a record's verbs do (`useTabFold.ts`). The chosen tab
  is always drawn in the row, in its order, the ones before it giving way; a
  tab reached by the keyboard is drawn before it is focused. The fold is
  decided before the first paint and again before the paint after any size
  changes, so no tab is seen in one place and then another. A strip that
  scrolled hid that there was more: A tenant App's ran 648px in a 627px room at a
  desk, and past a phone's edge.
- **The App's own panes draw no scroll bar.** The content pane, the filter
  rail, the list's control strip, every dialog, the navigation rail and a
  record's feeds and side panel hide theirs; popups and listboxes keep theirs. CSS cannot ask
  for "only while scrolling" — whether a bar fades or stands there is the
  operating system's setting, and a mouse attached to a Mac makes it
  permanent — so the choice is a bar that is always drawn or none, and a
  track standing between two panes at all times reads as a divider that means
  nothing. The window's own bar stays the platform's, so a page that scrolls
  as a whole still says so. The cost, stated plainly: on a desk where bars are
  permanent, these panes no longer advertise that there is more below.
- **A table wider than its room fades at the edge that has more.** A list is
  sized to its room first (`gridSizing.ts` measures the heads as they are
  drawn, and the menu caret reserves nothing). An App's head may wrap to two
  lines, at its words and never inside one, before its column widens: where
  the heads set whole would run past the room their floor is the label's
  two-line width, the head and its row grow by a line, and a table whose
  heads fit whole keeps them on one. Where the columns still
  cannot fit, the wrap draws a 24px mask-fade over the side with columns past
  it (`data-more`, `useStickyHead.ts`). With no scroll bar this is mandatory,
  not a flourish: a column must never be cut off without saying so. It is a
  mask, so it moves nothing and takes no room.
- **A table starts on its section's heading.** Inside a page or dashboard
  section the wrap reaches 14px past the content edge, so the first cell's
  text sits on the heading's line and the hover band bleeds past it. The
  edge cells keep their 14px, which a frozen column needs.
- Apps may opt into a centered `shell.width` (`wide` or `narrow`) and symmetric
  `shell.gutter` spacing. Omitted settings preserve the full-room default.
  Optional `shell.headerWidth: 'content'` aligns the brand and header controls
  with that width and gutter on desktop and phones. The header's background
  and border stay full width; omitted/`full` preserves existing header spacing.
  Menu, search, breadcrumbs and visible page headings may be suppressed by
  the App shell; headings retain their accessible name. A list may hide its
  filter form independently of its view tabs and active-query chips.
- A dashboard's `aside` holds supporting sections in an independent column.
  Main work does not wait for a taller context panel before continuing. Both
  columns use the ordinary section components, with the same access rules;
  on narrow screens the supporting content follows the main work.
- A list may draw its filters as a rail beside the rows (`filterBar: 'rail'`):
  a column of at most 15rem behind one hairline, facets divided by hairlines,
  never boxed; counts in the faint ink with tabular figures, blank until known.
  On a phone the rail is a sheet over the list that applies on one button.
  Beside the rows the chips that say the selection head the results, with the
  Sort and one Clear all; the rail carries no second one.
- Otherwise a list's filters are controls, not a form: one search box on the
  name column — the only field in the row, so the only 3:1 edge — then a quiet
  "+ Status" per filter the view declares, on a dashed hairline, opening the
  rail's picker for that column in a popover (a checklist, Min/Max, date
  presets; a reference is a typeahead). What is applied is said as chips in
  the same row, each in its filter's place: a chip opens its picker again, its
  × or Backspace removes it, and two or more earn one Clear all. A picker edits
  a draft and applies on one button that says what it will show; a flag's "+"
  is one gesture. On a phone the pickers are the rail's sheet behind one
  Filters button with the active count. Search, tabs and applied chips stay in
  one nonshrinking, horizontally scrollable controls row at every width;
  selecting a longer value never pushes the results down a second row. On a
  desk the "+" filters not yet asked for give way from the end, before the row
  would run past the window, into one "+ Filter" that opens every picker in the
  sheet; a chip never gives way.
- An App says a condition in words wherever it shows one — a chip, a facet's
  note, the column menu's Clear filter, the empty list, a saved view's first
  name: the column's label, the display rule's word for a value, the
  catalog's connectives ("Status is not Done", "Rent from $1,000", "Owner is
  Dana Ward or Sam Reyes"). Never the query language, a physical column name
  or an operator symbol; a masked value is the mask, and a column the reader
  is not served is "Another condition". The address and the Workbench keep
  the language (`components/conditionWords.ts`).
- An App list's column menu has at most five entries and no query language:
  the two sorts worded by what the column holds (A → Z, Low → high, Oldest
  first; a flag, and a vocabulary its database orders as declared (an enum
  type), names its ends — No → Yes, New → Lost; a vocabulary over text says
  A → Z, which is the order it gets; a reference sorts by the name it is
  drawn by), an entry that repeats
  the current order dropped; one "Filter…" that opens the rail's facet for the
  column in a popover, or, beside a rail that shows the column, moves the
  focus to that facet; "Clear filter" while the column is narrowed; "Pin
  column" last, set apart, in the dimmer ink. Every facet, in the rail and in
  a popover, keeps its rarer conditions (starts with, a pattern, empty, not
  empty) behind one quiet "More conditions". The Workbench keeps its power
  menu: every condition, sampled values, the language beside each entry.
- The sidebar menu filter is opt-in in Apps (`shell.menuSearch: true`),
  independent of global search; Workbench keeps its table filter.
- Menu icons are marks, not decoration: one Phosphor outline per entry
  (15px in compact navigation, the 18px UI icon role in comfortable navigation),
  in the dim ink until the entry is current, drawn only where an App declares
  one — never a color per entry, never an icon an App did not ask for. A
  popup menu is all icons or none: where one line has a mark, a line without
  keeps an empty slot of the mark's width, so every label starts on one line
  (the More menu's tick column is the same rule). The
  icon rail (default when an App side menu folds; `shell.rail: false` opts out)
  is 56px wide: marks alone,
  an initial in a hairline square for an entry without one, group headings as
  hairlines. In Apps the fold button lives in the sidebar footer, centered in
  the folded rail; Workbench keeps its sidebar control. The words stay each entry's
  accessible name and appear on hover.
- Every sidebar group folds through its heading button, the top level's too. A
  footer group's heading stays at the foot, under its rows, so it opens upward
  and the heading a reader pressed does not move. Groups start open and remember a reader's choice per App and
  connection using their authored IDs. The active destination's ancestors,
  matching menu-filter results and the icon rail always reveal their entries.
  Folding updates the keyboard's row model as well as the rendered list; it
  never leaves invisible destinations in the arrow order. Groups open and close
  immediately, without height animation.
- Apps with sidebar navigation use a modal left drawer on phones. The menu
  trigger shares the main header row; the drawer carries navigation and workspace
  identity, dismisses on selection, Escape or backdrop click, and returns focus
  to its trigger. Desktop sidebar collapse preferences remain independent.
- A record's layout answers to the room it is drawn in, not the window: a
  peek, a side panel or a split detail is a container, and its record stacks
  as a narrow screen would.
- An App list names itself in the crumb bar: title, match count and star after
  the trail, New and Export at its end, with tabs and filters on the one row
  below. A band of heading over a table is space a reader scrolls past on every
  visit. An embedded list, which has no bar of its own, keeps its heading row.
  The bar is one height in every room, a control's, so going from a list to
  its record does not move the page under the bar. On a phone its tools are
  marks (Import is its upload arrow, still named Import), so the title, New
  and ⋯ keep the one line rather than pushing the tools under it.
- App record pages show the selected layout name without a layout switcher or
  Copy layout action. Layout authoring stays in Workbench; business tabs, fields
  and commands keep their existing behavior.
- A queue’s optional facts keep compact captions visible beside their values:
  a pay date, an employee count and an end date should not require guessing.
  They wrap within the row, omit empty values and use ordinary column display
  rules; they add no boxes or independent color meanings. A queue row is
  compact: the title and its badge share one line, the lines and facts run on
  one wrapping line under it — a fact wraps whole, never its caption from its
  value — and the action waits at the row's end, dropping under the row (left-aligned)
  on a phone and wherever the queue itself is narrower than 22rem. A queue fits half a dashboard.
- A calendar's range is one bar across the days it spans, in the first day's
  cell, reaching over the rest above them and continued on the next week's
  row; it is square where it runs on and rounded where it starts or ends. Each
  week lays its records in lanes, and every card of a calendar is one of two
  heights, so a bar keeps its lane across days whose cards say less. A status
  on a card is a dot and its word; a date under the title carries its caption,
  because a bare date on a calendar reads as the record's own day.
- A calendar's backdrop is a tint of the day cells a span covers — its tone
  at 9% over the surface, never a bar of its own — so it adds no height and
  the cards stay in front of it. Its label sits in the date's line, beside the
  day number, where it starts and on a week's first day; it is a link only
  where its record can open, and plain words elsewhere.
- A conversation's other side (`side`) is a message set against the far
  edge on the second surface, at most four fifths of the width, square like
  every message, its avatar on its own edge. No tails and no bubble colours:
  the side and the surface say who spoke. An author's run says the name once;
  the time stays on every row. On a phone every row takes the width.
- In a dashboard's aside a list is names, not a table: the name whole and
  wrapping, a quiet line under it, a value at the row's end, rows parted by
  hairlines, the row the record's link. A grid there cut its names short.
- A metric that opens a list says so with an arrow after its label; the whole
  card is the link, and its hover is the look's, colour only.
- A related list that has nothing may be left out (`empty: 'hide'`) or said in
  one line (`'collapse'`), or the page may say which for every list that says
  nothing (`page(…, { empty })`): no heading and no rule where a manager's
  reports would be. Empty lists side by side are one quiet sentence, "No
  charges, payments or notes yet", each name followed by its Add. A list that
  offers an Add or `actions` is collapsed, never hidden: a door is not taken
  away. A tab always keeps at least one list, and inside a `listTabs` strip an
  empty list is a tab, neither hidden nor collapsed.
- A related list read as groups (`group`) is a header for each record its rows
  share, over that group's own table: the record's name as the link (accent ink),
  its facts after it in the muted ink, the count at the far end in the mono
  figure. Groups are parted by space, not a rule, so the table is what the eye
  follows; "Show all" is a quiet button that keeps focus, and a page of groups
  turned holds the box's height until the next page is in. On a phone the
  header's link is a 44px target and its facts wrap under the name.
- A run of figures parts them with a hairline in the gap between two on one
  line, never on a figure's own edge: the one that wraps starts its line flush,
  with no rule and no indent before it.
- A related list offers its Add where the reader may add a row, as a list
  offers New: the child's own form, bound to the record (`create: false`
  offers none). The record's verbs that act on the list (`actions`) stand in
  its head, quiet, and leave the record's. A row's ⋯ has its own column at the
  row's end, so it never sits over the last chip.
- Modal task details use the shared focus-owning dialog, filling the viewport
  on phones and retaining a bounded panel on desktop. Resizing never remounts
  the content or drops focus ownership.
- **Two primitives draw every form** (`packages/ui/src/Button.tsx`,
  `packages/ui/src/Field.tsx`): sign-in, a command form, a prompt, a confirmation,
  the account profile. A Button has an intent — primary (the one filled
  action; it fills in the theme's primary-action color,
  `colors.primary`, which Lumen sets to the ink so the button says "next" by
  weight, not hue, and Mono and Sage leave as their accent; the same on
  a header, a list, a dialog, a drawer and a landing's search), secondary
  (outlined), quiet (a word in the link ink) and danger —
  and a size: 28px compact, 34px, 40px large; busy is `aria-disabled` with
  its own words, never disabled. A Field is its label over the control (13px
  in the text ink; in a form that runs a command or makes a record, 14px at
  the regular weight, the answer's own size, so the question reads as
  plainly as the answer, its help 12px in the muted ink; in a form the answers that may be left empty say
  "(optional)" beside it, and elsewhere a required one wears a star that is
  not part of the name), a hint and then its problem under it, wired into the
  control's description and `aria-invalid`. Every control in a form is one
  field, 36px tall with 14px words (30px compact), so a text box, a date and
  a Select stand level; a picker is one field too — its box holds the chips
  and the words, and the words draw no second edge. Each look dresses the
  classes the primitives render, never a form's own.
- **A command form is quiet until touched.** In every form that runs a
  command or makes a record — a command dialog, a form page in the shell or
  on its own, a public form, a resource's New form, the stepper and the
  intake style — a field at rest is a clean outline and no fill: the
  lightest edge that still reads at 3:1 (WCAG 1.4.11), `--field-edge`.
  Where the look's control edge is already quiet (Lumen, Sage) it is that
  edge, the one a record's inline edit draws; where it is near the ink
  (Mono, a theme with a near-black `lineControl`) it is mixed toward the
  surface to about 3.5:1 (`fieldEdge`, `themeColor.ts`). A soft well with no
  edge was tried first and read as disabled: a fill a twentieth of the ink
  is what a greyed-out box looks like, and it stood under 3:1 on its own
  ground. Hover takes the edge one step toward the ink; the field the reader
  is in wears the house ring with the border cleared under it so it never
  draws two lines; the field that is wrong takes the danger edge over a
  faint wash of it, and its sentence; a disabled field a dashed faint edge
  and dim words, so it is never mistaken for one at rest. A theme that names
  its own `field` keeps its fill and its control edge. The one action to
  press is the only fill. Each surface keeps its own
  density: a dialog's fields stay 36px, the intake's are 44px and larger
  type. Digits in a field are tabular. A sensitive field's Show stands over
  the box's inline end, in room the box keeps for it, still its own Tab stop.
  Back is a quiet word. A record's inline edit, a grid cell, a filter, the
  query bar and the Workbench keep the 3:1 edge (Access).
- An App's New form is dressed as a command form: each label over its
  control (6px apart), a help sentence under it, 20px between fields, and a
  section as a hairline, a 14px heading and an optional dim line set close
  under it — more room above a section's rule than under its heading, so a
  heading belongs to the fields it names. The last field keeps that 20px from
  the drawer's foot. It says no generic
  lede ("leave a field empty…"); the author's `description` or nothing. A
  short form (up to 8 fields, no steps) is a drawer beside the list; a
  longer or stepped one is a page of its own in the content pane, one 40rem
  measure under the App's name, as a command form is. The input comes from
  the column: radios for up to four words that must be answered, a listbox
  past that or where empty is an answer, a switch for a flag answered either
  way (never a yes/no listbox), money with its currency inside the box (a command form's amount too, the sign in the muted ink at the box's size),
  several lines for long or prose-named text. A picker narrowed by an
  earlier field is disabled until that field is filled and its help says so.
  Fields the author puts in one row (`show`, a group's or a step's fields:
  `[['email', 'phone'], 'company']`, at most three) stand side by side, the
  intake's row rule: every box one height and level with its neighbor's, the
  row aligned at its top so a help line or an error stays under its own box
  and moves nothing beside it. The row is measured on the form, not the
  window: under 30rem — a phone's drawer, never a desk's — it is one column.
  A related create is always the drawer: it keeps its record in sight. On a
  phone a drawer takes the whole width — a sliver of the list beside it was
  not context, only a target too thin to press — and its actions stand at
  its foot while its fields scroll.
- A form's actions stand 24px under its last field, the primary last at the
  right; at 760px and under they take the form's width, 44px tall, the
  primary on top. A guided form's footer follows its step's fields, with no
  floor between them, and Back is not drawn on the first step; on a phone
  the steps ahead and behind are their numbers and the current one keeps its
  name. A dialog that fills a phone keeps its actions at its foot, the same
  44px and full width, standing while its question scrolls.
- A form says each problem once. A problem with a field on screen is said
  beside that field and only there; the form's own line, in the danger ink
  at 13px, is for what no field on screen holds (a field on another step,
  named by its label; a refusal about the whole), and stands above the
  actions — 18px under the fields, 24px over the buttons — where the eye is
  before it presses. Every sentence is the reader's: the platform's fixed
  refusals, written for an integrator, are said in a visitor's words, and a
  handler's own reason is said as written. A checkbox is drawn with its label
  beside it, the label checking it; a box that must be checked (`accept:
  true`) says "Check this box to continue." before anything is sent.
- An anonymous public form is write-only, and its screens say so rather
  than hide it. With steps, its last step is **Review**: each
  step's answers as a quiet list, drawn from the page's memory and never
  fetched back. It is one type size (14px): the label in the dim ink, its
  value in the ink, side by side above a phone (the label's column 38% of
  the width, at most 208px; rows 6px apart) and stacked on one (2px between
  label and value, 12px between answers). A section is its step's name in
  the semibold with **Change** beside it as a quiet underlined link in the
  accent's ink, so the focus goes heading, Change, the next section; 24px
  above and below each, a hairline between. A question left unanswered and
  not required is not on the review at all: a dash there read as a gap to
  fill. A value is said as its field displays it (a date in words, money in
  the App's currency, a choice by its label). A form saved
  on every step says before its first step, in one bordered line of dim
  text, that details are not shown back and the tab should stay open. After
  a reload, a step the page no longer holds reads "Saved — not shown for
  your privacy" in the dim ink, with no alarm colour, since nothing is
  wrong. The done screen is the reference and the author's words, never an
  answer. Leaving mid-application goes through the platform's own exit guard
  and the browser's generic prompt, never a custom dialog of the form's.
  A status check is a page of its own, the receipt and its details as plain
  fields: a refusal is the form's one sentence and marks no field, since
  saying which detail was wrong is the leak; what it answers is the state as
  a quiet list, never an input. A form whose applications may join an
  account offers it under the reference, primary "Create an account to track
  this" beside a secondary "Sign in to add it", and a quiet "This is a shared
  device"; the account screen asks one question with Yes and No, never
  answered by a sign-in alone. A public form served as the App's home, to
  someone signed out of an App that signs people in, carries a quiet
  **Sign in** at the top bar's end (`.account-sign-in`, as a public App's
  is): staff reach their door without typing its address.
- Sign-in is a card at a desk and the screen on a phone (760px and under):
  no box, the fields the window's width less its gutter. The staff door of an
  App with public pages leads back to them ("← Payday"). A problem with one
  field is said beside it; a refusal that must not say which field (a wrong
  email or password) is the form's one sentence.
- The public landing (`LandingSurface`) is the one signed-out screen that is a
  page rather than a form or a tool, and it still does not persuade by
  decoration: one 68rem column (growing on a desk past 1440px to 80rem at
  1920, so a wide window is not half ground), prose held to 65ch, hierarchy from a 48px
  section seam and the type scale (a headline at the display step, in the
  look's heading face, and 22px section titles), hairlines instead of
  cards, no imagery of its own, hover as 120ms of colour only. Calls to
  action are links dressed as the accent button, at least 44px tall, and go
  full width on phones. In an App the public reads, the landing may show a
  list's cards (the records' own photos) and one search panel, the page's
  one box, and its hero may carry one photo from the App's own files:
  beside the words, or behind them under the photo stage's scrim, in a box
  sized before the photo arrives and by the words, so a longer headline
  grows the photo rather than leaving it. Over the photo the primary call is
  the stage's own — its light ink as the fill, its dark ground as the words —
  in every look, since the accent is chosen for the page, not the scrim. The facts under the headline wrap
  with no dot opening a line. In place of the one photo the hero may carry
  two to four tiles from the same files, the photo's 4:3 box cut into a
  mosaic (sized before any arrives); over the headline, a badge — a few
  words in a chip of the accent's quiet tint, at the look's corner, never a
  button; and in place of the facts, up to four icon rows — an icon in the
  accent and a line in the muted ink. A hero with icon rows and no photo
  sets them where the photo would stand at a desk (1024px and wider): a
  column opposite the words behind a hairline, at 14px with 16px between
  rows, so they read as reasons rather than fine print trailing the button.
  On a phone they follow the actions, as they always did. No parallax, no
  carousel.
- **A public reader's pages are the storefront, not the tool.** A signed-out
  visitor in an App that opens resources to the public (`auth.public`; the
  root carries `body.public-visitor`) reads a record without the operator's
  furniture: no kind label over the name, no Back beside the trail, a trail
  that ends at the list (the heading names the record), no folds, no record
  history (`history()` is the operator's, and its read is behind sign-in), and
  in Sage no editing-group panels, since there is nothing to edit. Its lists show no
  match-count chip, no star and no page-size choice, and a Sort whose default
  is one of its choices names it ("Newest listings", never "Default order").
  Staff, signed in, keep all of it. The shell is the storefront's too: a
  signed-out visitor gets the top bar (brand, the public entries as links,
  Sign in), never the staff sidebar with its menu emptied. Shell selection
  only; the look is the App's own.
- **A place that has nothing to show says so one way.** An empty list, a
  refused room and a failed read share one block (`Empty`, `Refused`,
  `Problem` in Notes.tsx): a mark, one 14px line in the muted ink, an optional
  second line, at most one action. A refusal names the right noun (list,
  record, page). A date is written as the reader's locale writes it and kept
  as ISO. In an App every stored day and moment, in a grid and on a record,
  is said from today within two weeks ("2 days ago", "yesterday, 2:05 PM")
  and as the date past them (`sayNearDay`), the full day and time on hover;
  the Workbench shows the data as written. A due date that
  has passed on a row still open (its machine's state not final, or a
  `completed`-like flag that is no) is in the warning ink. Required is
  said once — by the star on a record, and in a form by the optional word on
  the others — and the word stays in the control's name, hidden.
- A reference in a record's fields is a link in the link ink, not a pill. The
  pill is the Workbench's, where a bare key needs its table said beside it.
  Where the link ink is the text's (Mono), a reference — in a record's
  fields, a grid's reference column, a card's "View dealer" — is underlined,
  1px and 2px under the letters, since the colour cannot say it.
- A `card()` section is the record a reference names, as one box beside
  the offer card: its caption the section's title, its title the named
  record (a link), its facts two across, "View dealer" ruled off at the foot.
  Two boxes in the aside stand 20px apart, not the 40px section seam. On a
  phone the card, the headline and the current card follow the summary, ahead
  of the related lists they explain; the rail and the history stay last.
- On a phone, an App that shows no search keeps its menu beside the brand,
  as the list mark (named "Menu"); the brand's name is not what gives way.
- Related-list tabs share the height of their visited panels, with a small
  loading-height floor. Switching to fewer or no records must not collapse
  the page and pull its scroll position. Unopened lists remain lazy; inactive
  panels contribute layout only, not focus or accessibility-tree content.
- A record's name and its toolbar share one row: exactly one action is
  filled — the verb the record most needs next, the header's `primary` where
  it names one shown now, else the first the record offers that takes
  nothing away — the next two are quiet, the rest go under More, and on a
  phone the toolbar keeps one button and More on a row of its own. The head
  is two columns, so a long name wraps inside its own and the toolbar keeps
  its row at every desktop width. Delete is
  never a button: when a resource allows it, it is the last item in More,
  in the danger colour and ruled off from the record's own verbs.
- A record header (`header()`) is the head, not a section under it: the
  status is its tone's own dress (a dot and its word) beside the name, the
  facts one line under the name in the name's column, quieter than the name
  and at the facts line's weight, a reference in them a link as in the
  fields; on a phone the facts stay under the name and the toolbar takes the
  row after. A fact's own word follows its value ("3 beds"), or leads it
  where the value is a date or a name that needs its caption said first
  ("Born Apr 24, 2017", "Ends in 3 months"). A destructive verb is never
  the filled one: it goes last, and where it stands as a button it is
  quiet; a record whose only verbs are destructive has no filled button,
  since the one it would fill would end it. A person whose
  name's avatar is their photo wears it in the head as in every list.
- A head is dressed by one recipe, `header`, a record's and a list's alike, and
  the recipe paints the boxes the page placed: it never moves a region into
  or out of the head, adds to what it holds or changes its reading order.
  `plain` is the head on the page's ground under the trail's hairline. `band`
  is one strip of the raised ground from the pane's edge to its edge, from
  the top of the trail (with the record's verbs, which stand there on a
  desk) through the eyebrow, name, status and facts, or a list's title, tabs
  and filters, closed by a hairline, as an object page leads with its
  object; the contents keep their edge, and a band under the facts keeps
  20px of its own before the body's margin. It is drawn as a border image
  whose outset reaches the pane's edges, which is ink overflow: it adds no
  scroll, clips nothing (a phone's verbs fixed at the foot of the screen
  are the head's) and needs nothing measured, so it stands from the first
  paint. `hero` is the band with the record's avatar large beside the head's
  words, 64px, and over the eyebrow on a phone (56px); its room is kept
  wherever the resource gives its records an avatar, before the name it is
  drawn from arrives, and a record without one, and a list, draw the band.
  Lumen and Mono wear `plain`, Sage `band`; the head's geometry is the
  head's, apart from the page body under it, so a page's own arrangement
  reuses it.
- A current card (`current()`) is the one related row that matters now, drawn
  as the reference card is — its caption the section's title, the row's name
  its title and link (said without the page record's name, as a child list
  says it: "Telehealth" on the patient's page, not "Noah Fischer ·
  telehealth"), the columns its `show` names the facts, "View lease" at its foot —
  and with no such row it says so inside the same box, never an empty table.
- Stars are opt-in (`favorite: true` on a resource or a view): a star on
  everything is chrome nobody asked for. Favorites list first in the menu.
- Table building blocks come from display rules and list options, never from
  one-off styling, so every theme dresses the same markup:
  - an avatar is an initials disc whose ink is one of eight slots fixed by
    the name — the first seven chart series and, for the eighth, the mean of
    the second and third, since the palette's eighth is its neutral grey and a
    grey disc read as a disabled person. One person keeps one colour on every
    screen, and the colours follow the theme and dark mode. The disc is tinted
    on a ground 7% into the text ink, so it stands off its card (1.25:1 at the
    least) in every look;
  - a second line is another column of the same record, said quietly under
    the value, never a second value competing with it;
  - a meter is a number against its max; a tone colours the bar instead of
    turning the value into a pill;
  - a grid's selection is the queue's (the same keys, limit and per-record
    writes), drawn only for a reader offered a bulk action. Select all is the
    checkbox in the header row, level with the rows' boxes, with no label and
    no count: checked when every loaded row is chosen, mixed when some are,
    and named for assistive tech by what it takes ("Select all issues"). A
    presentation with no header row to hold it says "Select all", still
    without the count;
  - totals are over everything the list's conditions match, not the page,
    and sit in one ruled footer row;
  - a row's own menu is hidden, not dimmed, until its row is hovered or it
    has focus (always there on touch), and asks nothing until it is opened —
    twenty rows are not twenty ⋯ nor sixty reads;
  - a fit grid gives its spare width first to the columns still cut short,
    the shortest first, each to its words (a title up to 360px), and only then
    evenly to every column; a relative date and a number's chip are as wide as
    their words, not their longest possible form. The row's name
    keeps 240px (its avatar's disc counted) before any other text column keeps
    more than 120px, so when a table is tight the secondary columns are cut
    first; a tone chip is never cut. A grid drawn inside another room (a
    dashboard's list, a record's related list beside its aside) leaves out,
    from the end, the columns past its width rather than scrolling to them or
    cutting them at its edge — its first column, its name and its status
    always stay — and on a phone says its rows as summaries;
  - an App's list that fits one page draws no pager. Past one it says its
    range ("21–40 of 312") with Previous and Next; First, Last and the page
    box are the Workbench's. Cards, a queue and a checklist page as the grid
    does;
  - `density: 'compact'` tightens a ledger's rows — 5px above and below a
    cell's 12px words, under the row height (`--row-h`) every other list
    stands at — in every look (structure.css); the reader's zoom still
    applies on top.
- A JSON document is laid out by its shape, never printed as braces
  (`JsonView.tsx`, decisions in `jsonModel.ts`): quiet labels beside values —
  the record form at a document's scale — like records as a table, words as
  chips, and nested levels indented by a hairline rather than boxed. Two
  levels open, deeper ones fold behind a count, long arrays are paged. In a
  grid it is one quiet `--code` line that opens the document in the confirm
  dialog's box; Raw text is `--code`; `true` is the Yes pill. Read-only: a
  document is not a line of text, so no field editor is offered one.
- Cards, galleries and accordions are presentations, not styling. A card is
  one box with hairlines inside. When an image is configured, its picture
  stays at a fixed 4:3 so nothing moves as photos load; without an image,
  the card starts with its text and reserves no photo space. An authored
  avatar uses a fixed circular portrait beside the name, with the same initials
  and palette as other person values when no image is available. The portrait
  is decorative: the name remains the accessible record target. The whole card
  is one target wearing the house focus ring;
  the columns follow the room, one to four. Sage dashboards keep their supporting
  aside lists unboxed; guidance notes retain a panel, so primary tasks and
  secondary context have distinct visual weight. A gallery's lead photo opens the
  lightbox, whose box enters with the popover's fade and whose steps swap a
  finished photo for a finished photo. An accordion opens and closes at once;
  its chevron is the one thing that turns. A headline in the side panel is
  the offer card: one box, the figure first, the facts in two columns, the
  call to action across its foot; it stays in view as the details scroll,
  and in one column it follows the photos.
- A label never breaks over lines inside its control: tabs, window pills and
  the phone's current crumb stay on one line, and the row scrolls or the crumb
  ends in an ellipsis instead. A list turns its rows into record summaries
  only at phone widths (760px and under); a tablet keeps the grid. Ordinary
  App related lists use the same summaries, preserving the record's name and
  hidden navigation keys. A summary is two lines: the name, then its facts on
  one wrapping line, each caption beside its value, and a column the list's
  question holds to one value (a tab's `status = new`) is left out of every
  summary, which sits on its section's own edge with no inset of its own.
  Records/Table keeps comparison available on a phone, as one control in the
  look's tab dress, at the end of the list's tab row rather than on a row of
  its own; the tabs scroll beside it under a fade in the strip's own ground,
  which says there is more without a scrollbar;
  its selected state remains visible in every look. The title is the keyboard
  target and carries one focus ring; nested controls keep their own targets.
- A list's tabs take one grammar per look: an inverted block (Mono), an underline in the
  accent (Lumen) or a tint of the accent (Sage, whose accent is its ink); an App's own theme may pick a pill
  filled in the accent at the look's radius or a rule.
- Mono says "current" one way everywhere: the bar's current group or item,
  the sidebar's current room (the phone's menu too) and the selected tab are
  all inverted blocks, and every one of them is set as a label, in capitals
  in the monospace. A sidebar's group headings are one style, a nested
  group's fold included, and a nested room is indented inside its row, so
  every current fill starts on the list's one edge.
- The top bar's items are blocks of their own height, centred in the bar, and
  the current one is marked once: the look's fill, or an underline. A
  menu longer than its pane fades out at its foot while there is more below.
- The browser tab names the room, then the App ("Purchase orders ·
  Inventory"), with no vendor suffix; signing in is "Sign in · Inventory".
  An App that names no logo is its initial in a square of the navigation's
  accent, never tablewalk's own mark, and the tab's icon is the App's mark.
  The workspace mark in a sidebar's foot says its name's words' initials in
  the sidebar's own ink.
- The header's controls say what they are: in an App the search is a box — a
  magnifier, "Search…" and ⌘K — and the reader's settings (Preferences, the
  dark mode, the Workbench) are behind a gear named "Settings". Signed in,
  they are the account menu's, between the account's own items and Sign out,
  and the gear is not drawn: one menu at the bar's end, not two side by side.
  Where the App keeps its reader an inbox (`notify`), a bell stands just
  before the account: an icon button like the gear, its unread count a pill
  in the accent beside the mark ("99+" past 99), said in its name too
  ("Notifications, 3 unread"); nothing moves when the count changes. Its menu
  is the latest notices — unread ones a dot in the accent and words in the
  text's ink, read ones the dim ink — and "See all notifications".
  Where the App lists ways to make something (`ui.shell.new`), one
  ghost button, "+ New" — the words a list's own New says — stands before the
  assistant and the bell, and opens a menu of nouns, each with its mark in the
  dim ink: what to make, never where to go, which is the side menu's. A long
  menu reads by its groups (`{ label, children }`): each a small dim heading in
  capitals over its nouns, a hairline between runs — no box round a group, and
  the arrows walk the nouns straight through. A reader
  with nothing they may make has no button, never an empty menu; a tenant's
  bell is the inbox of the tenant the person is working in.
  The Workbench keeps its bare key and its "···" of tools ("More"). An App's
  settings records (`settings: 'Company profile'`) are that menu's Settings
  items, and an administrator's **Manage accounts** is one dialog from it: the
  accounts as rows under the 2px rule, each name the row's one target, which
  stack to two lines on a phone, where the dialog fills the screen. Its
  History is the same rows — when, the change, by whom — with no target in
  them: a record is read, not opened.
- A phone's App bar is one row in every App, whichever shell it has on a
  desk: the menu's mark, the brand, then search as its magnifier, the
  settings, the bell where there is an inbox, and the account. The list's own search is the one box on a
  phone's screen, and a list's New says "New" beside a long title. The bar's
  New is its plus and the account its avatar, marks like search's, and the
  brand gives way to its mark when its name has no room. A tenant App's
  context control leaves the bar on a phone: it is the account menu's first
  item ("Dealer: Demo North Motors"; its profile record's name, never its id),
  set off by a rule, and opens the context dialog; at 320-430px the bar could
  not hold it beside search, New, the bell and the account without cutting the
  last at the edge. What the bar offers beside the control at a desk (entering
  a tenant for support, its support visits) is the context dialog's on a phone.
- A list's New is its one primary action and is filled, in the primary-action color, as a record's first action is; Export beside it stays quiet.
- A stat card says money compact from a thousand up ("$27.3K", "$414.1K"), as
  its axis and its change do, and whole below it; the exact figure is the
  card's title and what a screen reader hears. Each card measures alone, so a
  rule over its neighbours ("compact where one of them must be") could only be
  kept after all had answered, by a figure changing form under the reader; a
  strip said "$414.1K" beside "$27,300" instead. A table or a breakdown says
  figures whole to a hundred thousand: there they are read against each other.
- A dashboard's `areas` places sections in the named areas of a grid of equal columns (`structure.css`; a look dresses the sections in an area and never moves an area). Areas in one template row stand as tall as the tallest, the sections in an area stack, and the last of them takes the height that is left, so a boxed look's panels end on one line. The DOM is in the order the template reads, which is the one a narrow screen stacks in: below 13rem a column, asked of the grid's own room, not the window's. Metrics and pairs are made per area (nothing pairs in one). An area whose every section leaves out (`empty: 'hide'`) hands its cells to its left neighbour, and that is settled once for each pick the reader makes, when every tile has answered, never on a refresh.
- A stat card is as tall as what it says: the trend's 32px slot is kept only
  when a trend is drawn, and the cards of a strip stand from one top edge
  rather than stretching to the tallest. A trend spans its card and is drawn
  only from four points. A change names what it is measured against ("↓
  $785.1K vs prior 90 days"). A metric over a clock (`over`) is compared with
  the equal period before the window unasked, and its trend is the window's
  own — days over a month, weeks over a quarter, months over a year, the
  empty periods of a count or a sum drawn at zero — read in the paint's one
  batch beside its figure. Both slots stand from the first paint: the
  change's line and the trend's height are held while they are read, so
  neither arrives by pushing the card taller; a window under four periods
  ("today") asks no trend and holds none. Once the reader has picked a window, a
  card it does not move says "Fixed window" (under All time nothing is
  narrowed, and the note was noise on a card never about time). On a phone the figures sit two to a row, a compact 24px figure that never breaks, an odd run's first taking the row as its lead, the rest in pairs (a lone last one read as an afterthought); one per row made eight figures a column three screens tall. At a desk, `stat: 'icon'` cards stand in equal columns, four to a row, and fold into pairs by the same rule where four do not fit: wrapped as they came, four stood three over one at 1280-1440px. A card's mark sits at its right, level with the label, in every look: standing over the label it set that card's figure 25-50px below its neighbour's, and on a phone each label keeps two lines so a wrapped one moves no figure. A record's figures under its name sit two to a row on a phone too. A row's own head in a table's body (a matrix's
  "Closed won") is a value: it takes the row's hairline and the body's face,
  never the header's rule or a look's label dress.
- A card's summary is one line, ending in an ellipsis where it runs out, so
  the facts under it stand level across a row of cards.
- A line of facts — a headline's, a card's summary — never opens a line with
  its dot: the dot rides in the gap before its fact and is clipped where a
  fact starts a line. A breakdown's bar is a quantity, a solid fill in the
  first chart series, never a pale fill with an accent cap at its end; it is
  a share of the largest group, so the biggest reaches the end of the track.
  Groups read in their column's vocabulary order (a pipeline's stages), else
  biggest first — never the alphabet. Stat cards and their trends take no
  colour by position: one edge colour for every card (the first series)
  and every trend in the first series, as the refusal list asks — save where
  the metric says which way is good news (`better`) and its change is known:
  then the trend is drawn in its change's tone, the green or red its delta is
  said in, because that colour is meaning, not position (Lumen, alone,
  colours its stat cards by their place: Lumen's exceptions).
- Bars (`shape: 'bar'`) are one series: a bar per group, the quiet ones a
  tint of the first series and one current bar in the
  series itself — the last, the period in hand, until the
  pointer names another. Its value is said in a pill over it and a dashed
  guide runs from it across the levels, always drawn, since it is
  information rather than a hover effect; nothing moves. Periods keep the
  calendar's order with their empty buckets at zero, categories go as a
  breakdown's do, the levels stand on the left as a line's, and every bar is a
  row of a hidden table.
- A dashboard section may carry a mark (`icon`), one of the curated App
  icons, in its heading row: leading the title, in the title's quieter ink.
  Like a menu
  mark it is drawn only where the author asked for one.
- A section may pick its own period (`windows`): a quiet picker at the end of
  its heading row, apart from the dashboard's window,
  which it does not follow; a figure's card with one keeps the picker in its
  label row and its label is the way in, since a button cannot hold another
  control. An embedded list that opted in (`interactive`) is its room's list
  under the section's heading: its search, filters and selection, no heading,
  saved views or rail of its own.
- An activity feed is rows under hairlines: its resource's mark in a hairline
  square beside each change (as the icon rail draws a mark), what the change
  was over its record — a link in the text's ink, underlined — and its first
  field from what to what, who under it and the time at the row's end. Its
  periods are a segmented row, the chosen one filled in the accent (the ink in
  Mono); its search is the section's one field.
- A value may wear a mark (`icons`): one of the App icons before its word, where
  a tone's dot would stand, in the tone's colour — never both a dot and a mark
  — and in the caption's ink where it has no tone. The word stays, so the value
  is still said. A person's avatar may be their photo, cropped to the disc,
  with the initials where there is none or it will not load.
- A dashboard's heading may greet its reader (`heading: 'Hello, {me.name}'`),
  the name said by the server from the verified session; where there is no
  name the label stands instead, never a greeting to nobody.
- A line chart's words are set at their own size at every width (its viewBox
  is the width it is drawn at), its levels on the left in a gutter the line
  cannot cross, its months as many as fit, and every point is a row of a
  table assistive technology reads. A donut's legend is held to 24rem.
- An App's table anchors each row on the record's name — its first column
  in the ink at 500, the rest in the second ink — and its head, in the
  faint ink at 12px/500, sticks under the trail where the table fits its
  width, taking a soft ground once stuck. A table wider than its pane
  keeps its sideways scroll and its head scrolls with it. Placeholder rows
  are the real rows' height, and a tab's badge keeps its count while the
  next one is on the way.
- A workflow strip is a track of thin segments, one per step, the label
  under each: a step walked is a quiet tint of the accent, the current one
  the accent with its label in the ink at 600, a step the record's actions
  can reach now an outlined segment, a step ahead the rule's grey. The track
  carries the order, so there is no joining rule and no box around it; on a
  phone it is one row that scrolls sideways. A step's label is never cut: it
  takes up to two lines under its segment, in every theme.
- In an App an email address, a phone number and a web address are links
  (`format: 'email' | 'phone' | 'url'`, or a column named like one), in the
  link ink as a named reference is; a web page opens beside the App. Never
  inside another target (a card, a row that opens), and never in the
  Workbench, which shows the data exactly.
- On a phone a property rail keeps each caption beside its value: a 7.5rem
  caption column and the value after it, one row per fact, the last with no
  rule under it. A wide field (prose, an address) puts its caption over it.
  Stacked, every fact took two lines and a record's eight facts a screen. A record's
  aside, stacked under it, is more sections: its first takes the section
  rule, not a hairline of its own. Stacked, the aside follows the main work;
  only a headline (the figure and its actions) comes up, after the first main
  section, so the key facts and the verbs stay near the top while the cards,
  properties and notes wait under the lists they explain.
- A section's note ("Nothing to count yet.") starts on the section's edge, in
  the reader's words: an App never shows a table's name where its reader
  expects a sentence. There is one empty block and one problem block
  (`Notes.tsx`), both at body size: an empty place says what belongs there
  and, at most, the one thing to do next — never a heading louder than its
  section, and a board with no cards says so once, not in every lane; a
  place that could not be shown says why with a warn mark and Try again,
  offline said as offline, and the same failure is said in full once per
  screen. A list's "View all" is not offered over nothing. A reference that
  is not set is said as such ("No account is set, so there are no invoices
  to show"), with no header row over nothing, and a footer that sums more
  rows than it shows says so ("Total · all 12 invoices").
- Rules are not doubled: a section draws one rule above its heading, so
  nothing above it (a summary band, a head) draws one below itself. In a
  look the rule is 2px in the ink, and sections that share a row share one
  rule, carried across the gap between them — and the first row, like the
  first section, draws none; everything else is a hairline. A record's tabs
  are tabs: they wear the look's tab dress, as a list's do.
  A dialog's head says the kind of record; the name is the page's heading
  under it.
- Rules, not boxes, on the screens people work in: a table is its rows under
  a 2px rule in the ink, with no panel round it; a board's lanes stand under
  the same rule, and a board of rows keeps it on its lane heads, its cells
  places rather than boxes. When the lanes run past the window the board's
  far edge fades until the last is in view.
- A board is one board wherever it is drawn: a dashboard's and a list's lanes
  say a toned value as its dot and word, with the lane's count as a chip, and
  a card its title over its quieter, dressed lines. A lane starts at 15rem
  and shares a wide room up to 320px; in a narrower one the lanes give way
  together down to 12rem, a card's words wrapping and the lane's sum taking
  a line under its name, so four lanes and their folded strips fit beside a
  side menu at 1280. Only more lanes than fit at 12rem scroll, with a fade at the edge, and an
  empty final state of the column's machine (Closed, Cancelled) is a folded strip, not a full lane, decided before the first paint from what the reader's browser saw last time (counts that land after the cards never fold a lane on the page already drawn, which moved every lane to its right). Its head counts the lane over the whole
  list, never the page drawn, and its limit is met by that count; its cards
  are read a page at a time, with "Show 20 more" at its foot. Records with no
  value have a lane of their own, and what the lanes leave out is said under
  the board, naming the cap where it was the cap. On a phone the lanes snap
  one at a time under a picker that names the lane in view ("Ready 2 of 5").
- A split list marks the record beside it as a current item is marked: a tint
  and the accent's ink. Before a record is picked the pane says so in a
  sentence at the body's size where the record will start.
- A calendar's days of the months either side take the page's ground; a
  checklist the reader cannot change draws its checks in the text's ink, not
  the browser's disabled grey; a queue reads 14px names over 13px lines
  wherever it is drawn.
- The Workbench's instruments (a query's milliseconds, a column head's "key")
  stay in the Workbench.
- A drag is never the only way. Whatever a pointer can drag — a card to a
  lane or a place, a record to a day, a row to its place in a list kept in
  hand order — Alt and an arrow key does too, and the item's own menu
  offers it by name. A mouse or a pen lifts what it presses once it has
  moved a few pixels; a finger holds it still for a moment first, so a
  swipe still scrolls, and a held finger is told by the item pressing to
  0.97 over `--t-press` (motion rule 12; none under reduced motion). The item's copy follows the pointer
  and the item stays where it was, faded. Where the items keep an order
  (a board's lanes with an `order`, a list in hand order, a ranked
  group), the place it will take opens as a gap the copy's height; where
  they keep none, nothing slides and no place is drawn, since there is no
  place to choose, and only the lane or group to enter is marked, by
  color. A lane or group the item may not enter is shut while it is
  carried, and an item let go over one says why it stayed. Escape puts
  it back. A move is drawn the moment it is let go and saved behind it,
  the item quiet until the write is answered; a refusal puts it back
  with the server's sentence, and a move that asks first (a confirmation,
  a reason, a command's form) holds the item faded in its new place
  until it is answered. After a move the focus stays on the moved item
  and a polite live region says where it went. On a phone a lane strip
  stops snapping while an item is carried and steps a lane at a time
  near its edge.
- A record's lines (`form.lines`) read as a ledger
  until they are touched: each box is a table's cell, its edge in
  `--line-control` shown where its row is under the pointer (always, on a
  touch screen) and the house ring where it has the focus — said in the
  `structure` layer, since every look dresses a form's inputs as fields.
  Columns are as wide as their kind: what the line is takes the rest,
  numbers and money narrow, right-aligned, tabular; money reads in its
  currency at rest and as typed under the focus; an amount worked out of
  the line is read-only beside them. A reference with a `subtitle` or an
  `avatar` on its naming column shows them in the cell and its list. The
  handle and a `⋯` menu replace arrow buttons; the summary sits under the
  amounts, parts in the dim ink and the total last over a hairline.
  Narrower than 34rem the lines stack as cards.
- On paper a record or a list is its content (`@media print`, style.css):
  nothing that operates the screen — the bars, the menu, a record's toolbar,
  the pending dock, a list's controls and pager, a field's edit mark — ink
  on white in every look and mode, the page let out of the fixed-height
  shell, and no row, field or section split across a sheet. The breadcrumb
  and record trails are screen navigation and stay off; a list keeps its
  title. A record prints the tab it is on. `test/repo/print.test.ts` holds it.
- A document (`document()`, components/Document.tsx) is paper on screen
  too: the sheet at its paper's width, ink on white in every look and mode
  (the system's Canvas and CanvasText, mixed for its quieter inks), its
  margins as padding. Its hierarchy is the platform's, never the author's:
  a letterhead (the App's mark and name, the sender's lines) across from
  the document's name and number under one hairline; captions in small
  capitals; lines as rows under a 2px rule in the ink with hairlines
  between, figures right-aligned in tabular numerals and money to the
  cent; the totals with the sum owed last and heaviest, under a rule in
  the ink. No shadow, no band, no box but the headline's quiet ground. A
  date said relatively on screen is the day on paper. A look's table dress
  is said away again in the look layer, and the room around the sheet in
  the print layer, so no look moves paper.

### The intake style of a form with steps

`style: 'intake'` is for a long application, not a wizard. It draws no form
heading and no eyebrow (its page's brand row keeps the App's mark and name,
the name giving way first where room runs out): the step's own title is the h1 (h2 in a dialog), set
tight at a display size (28px on a phone, 32px at a desk, leading 1.05) so a
two-line question reads as one, under a thin bar that says "Step n of m: label" with "Step n of m"
beside it in tabular figures. The step's help and a section's words under
the title are one size (`--text-lg`) and one color (`--ink-muted`), in the
regular weight, with no rule under the section; a checkbox's words are an
answer in the regular weight, and only a question's label stays medium. A
review section is headed by its step's whole title, which wraps in its own
column with Change beside its first line. The actions sit in a bar at the foot of a page
(`.intake-actions`, safe-area aware, no rule over it, 44px targets on a coarse
pointer): on a phone it is the screen's foot and the primary fills the width
beside Back; at a desk the primary is weighted right at its words' width. In a
dialog they stay in the flow. Back is a quiet word, absent on the first step;
the primary says the step's `next` word, `skip` while the step is empty, and
the form's completing word on the last, filled in the theme's primary-action
color. A row of up to three fields stands side by side and stacks under the
container's narrow width. A choice drawn as cards — one answer or several —
is a full-width card a choice: an icon on the left, its words, and a square
at its end that fills in the primary-action color when chosen. At rest a card
wears the field's outline and no fill (`--choice-edge`, `--choice-well`); a
chosen card takes its edge in the primary-action color, and the card in hand
the house ring.
Several cards are one group to the keyboard as one answer's radios are: one
Tab stop, the arrows between them, Space to turn one on or off, each saying
`aria-checked`. The form's description is said once, on the first step under
its title, never over the bar on every step. The review is every step's
answers as a summary under its name, a group's answers a short list each by
its label ("Urgent: Yes"), a date said in words, with a quiet Change that opens that
step's fields in place (a step holding a problem opens itself), and holds the
submit until valid; a sensitive value is masked to its last four in tabular
figures with a Change that asks for it again.

Every stepped form says where the reader is one way, the stepper style's and
the intake's, on a page or in a dialog: the thin bar (4px, the primary-action
color on a 9% ink track) with "Step n of m" beside it in tabular figures, the
bar's own name ("Step n of m: label") said to assistive technology and the
count hidden from it. The stepper's row of numbered tabs is gone: it said the
same thing a second way, and ran off a phone at three names. The stepper
keeps the step's name as its h2 under the bar, its primary says Continue (the
step's `next` word when it has one), Back is the same quiet word, its review
the same summaries, and on a phone page its actions pinned to the foot the
same way.

At a desk (1024px and wider, where the page's container has 56rem), a
stepped form drawn as a page — a public form, a signed-in command page, a
stepped New page — sets its steps beside it: the form keeps its 40rem
column and a 300px column to its right lists every step behind a hairline,
sticky as the step scrolls. A step done is a way back to it, its mark filled
in the primary-action color with a check, its name in the ink and under it
what it said in a line or two of small dim text (a yes-or-no says its label
when yes, nothing when no; a sensitive answer its last four). The step in
hand has a ring and the semibold and says `aria-current="step"`; a step ahead
is its name, quiet, and no Tab stop. On the review the list is the names
alone, since the review says every answer. A dialog and a phone draw no
list. The list is in the first frame at any width and shown by the
container, so nothing moves when it appears; its layout is in
`structure.css`, where no look can move it. Cards whose words are short
stand side by side in that column: a label of up to 14 characters alone,
three to a row; a label up to 24 and a line up to 40, two (four of either two
by two); a phone and a dialog keep one card a row. Focus after a step moves with
`preventScroll`, then the page scrolls only when the heading is out of view,
so the page never moves sideways. Enter in a typed answer presses the
primary. The intake's own size, type and page are its on-demand file
(`MultiStepForm.css`), never in the first paint; the outline, ring, optional
word, Show and primary are every quiet form's (`formDress.css`). Its labels, choices, answers and review values wrap, by the
truncation policy.

## Access

Every look, in light and dark, at a desk and on a phone, is held to WCAG
2.2 AA. The rules below are where it was
found not to hold.

- **Focus is the house ring.** Every focusable wears 2px of `--focus`, 2px off
  the edge: the look's own softer tint of its accent where the accent is a
  colour, and in the two looks whose accent is the ink, a ring that is not
  grey. Mono's ring is the ink itself (black by day, white by night); Sage's
  is its link green, since a near-black accent drew a heavy outline and a
  grey one vanished against the ink. 3:1 or better on the grounds a
  ring crosses in both modes (`focus` in the palette; `themeWarnings` checks
  it, and an App that authors only an accent gets the ring in that accent). A
  field in a look shows focus with the ring, never with a border colour
  alone: a look draws its fields' borders itself, and in Mono the border
  already is the accent. The ring stands flush on the field's edge, which
  takes the ring's ink, so the two are one band in every look — a pixel of
  ground between them drew a second box round the first. A Select's button
  and a picker are fields and wear the same ring. In a list the keyboard's place wears the ring
  inset — on the option, where options take focus (a menu, a Select), and
  on the lit option, where the box keeps it (the palette, a picker, the
  query's completions) — never a tint alone, which was 1.04:1 on white.
  A ring drawn inside a filled current item takes that item's ink. The
  ring's corners are the control's own, so a square look's ring is square.
  In an App, anything the keyboard reaches that names no ring of its own
  still wears the house ring, never the browser's blue, and a popup that
  holds its menu's focus draws none round itself: the lit item says where
  the keyboard is.
- **Text reads at 4.5:1 on what it sits on**, hover and tints included.
  Placeholders are `--ink-subtle`, not the browser's grey. A loading bar
  stands a tenth into the text ink, at the look's corner (square in Mono):
  on `--raised` it was 1.1:1, a page that looked empty rather than loading. A word on the
  accent takes the ground's ink (`--ground`), never a fixed white: by night the
  accent is light. A status word takes a fifth of the text ink, which held
  it past 4.5:1 on the tint it once sat on; in a look it sits on the row's
  own ground, and a label's chip keeps a lighter tint. An avatar's initials
  take the text ink at 55%, so its slot is a hue, not a contrast. A column
  head is never clipped: a look's heads fit the width the grid sizes them
  for. A control's mark
  (a pencil, a ×) is dimmed by the faint ink, never by opacity. A calendar
  week is not a list row: the looks' row-hover tint stays off it, where it
  took an outside day's faint date to 4.42:1.
- Date-only command fields, filter ranges, value prompts and an App record's
  inline date edits share a themed calendar popover and editable ISO
  (`YYYY-MM-DD`) text. Arrow keys move by day/week, Home/End by week edge,
  Page Up/Down by month; Escape closes the calendar before its enclosing
  dialog. Moving focus inside the composite never commits a filter or an
  autosaving field; leaving it commits valid drafts before a following
  submit. Date-only values never pass through an instant conversion. A date
  and a wall-clock time (a prompt over a timestamp, a tenant's local expiry)
  is the same calendar with the time kept in its text (`YYYY-MM-DD HH:MM`):
  the calendar writes only the date part, and a value with an offset or `Z`
  is refused, because an instant is not a wall time. A stored timestamp
  edited in place on a record keeps its text box.
- **A calendar list's month is one Tab stop**, not a stop per record: the
  grid pattern, its day last visited holding the stop and wearing the ring
  inset. Arrows move by day and week, Home/End to the week's edges, Page
  Up/Down by month (the month turns with the focus); Enter goes into a day —
  its first record, or its "+N more" when all are folded — where Up/Down
  step and Escape comes back to the day. Alt and an arrow still move a
  record. A phone's agenda is a list, and its records stay plain Tab stops.
- **Native controls follow the mode.** The root declares `color-scheme`
  with the theme, so a checkbox, a radio, a date's calendar and the window's
  scroll bar are drawn dark on a dark ground rather than as white squares.
- **A field's edge reads at 3:1** on the field and on what it sits on (WCAG
  1.4.11). Every form control — a text box, a textarea, a Select's button, a
  picker, the query bar, a list's search box and the rail's boxes — outside a
  command form (whose lighter outline the next rule measures) draws its edge
  in `--line-control`, which each look, light and dark, and the database
  browser set beside their hairlines; a Select's hover takes the edge toward
  the ink, never back to a hairline. Only fields wear it: section, card, table
  and divider rules stay `--line`, so the looks stay quiet. Checkboxes and
  radios are the browser's own, whose frame already clears it. Startup warns
  when a custom theme's `lineControl` is under 3:1 on its `surface` or
  `ground`, as it does for text, and for the meaning colors on either.
- **A filled field may drop its edge.** A theme that sets `colors.<mode>.field`
  and `shape.border.control: '0px'` draws the control as a well, no line. That
  is allowed only when the fill stands off both the ground and the surface by
  1.08:1 in light and in dark, which `check` measures (`EDGELESS_FIELD_DELTA`).
  1.08 is the faintest well that still reads on a warm paper ground (Lintel's
  Hearth sits at 1.085 on the ground and 1.17 on white); WCAG 1.4.11 asks for
  3:1 of a control's boundary only where nothing else shows it, and the label
  over the field and a 2px focus edge do. The ink on the fill still clears
  4.5:1. Without the fill delta, `0px` is refused. A command form's fields
  (Standing layout rules) are a clean outline at rest by default, no fill:
  `--field-edge`, the look's `--line-control` where that already stands
  between 3:1 and 4.5:1 on the surface and the ground, else that edge mixed
  toward the surface until it is the lightest at 3.5:1 or more — derived for
  every look, palette and mode and for a `defineTheme` theme alike, never
  authored, and held by `test/field-edge.test.ts`. The edgeless 5% well it
  replaced cleared 1.08:1 and still read as a disabled box. A theme's own
  `field` keeps its fill and the edge its `shape.border.control` says. In
  either the focus ring is the one edge: the field's border is cleared under
  it, because a 1px border inside a 2px ring of one ink drew two lines with a
  seam between them. An empty Select asks in the placeholder's ink ("Choose
  source"), never a dash, and its caret is the chrome's caret-down at 16px in
  the muted ink, drawn as the date's calendar is.
- **Controls stand level.** A field, a select and a button take their height
  from `--control-h` (`shape.height.control`, 32px to 56px, whole pixels). On a
  touch screen (`pointer: coarse`) none is shorter than 44px, whatever the
  theme says, and the density zoom is divided out so the floor is real pixels.
- **The optional word.** A long form — every command form and New form —
  marks the answers that may be left empty with "(optional)" beside the
  label, and never the required ones with a star: in an application nearly
  every answer is needed, so a star on each was noise. Elsewhere a theme may
  say `recipes.required: 'optional-word'` for the same. Pick one rule per
  form; a mix of both is noise. `aria-required` is said either way.
- **A drawn checkbox.** `recipes.checkbox: 'drawn'` replaces the browser's box
  with one in the field fill and edge, the corner capped at 6px, and a check in
  `--on-accent`. It keeps focus, disabled and forced-colors states.

- **A chart's first four series read at 3:1** on the card they sit on, in
  every look, light and dark; past four, a chart is a legend's job. Mono's
  greys alternate dark and mid so neighbouring slices differ as well, and
  startup warns when a custom theme's `chart[0]`–`chart[3]` fall short. A
  look's first four are four hues, never two greens (Sage's donut read five
  sources as three), and its dark series are the same hues in the same order,
  so a series keeps its color across modes. Up to three lines are named where
  they end, in the muted ink beside a dot of their color, and the key above
  them goes; past three, or where the names would take more than a quarter of
  the width, the key says them. A legend that carries totals (stacked bars,
  columns, a donut) stays.
- **The contrast check measures the grounds a page draws**, not only the
  palette's own pairs (`themeWarnings`, packages/engine/src/shared/theme.ts): muted and
  faint text on the row and hover ground (`--raised`), a tone chip's ink
  (78% of the meaning colour in the text) on its 12% tint, the danger colour
  on its own banner, the focus ring at 3:1 on the page and the row
  ground, and the ink on a matrix's heaviest cell. That tint stops at the
  palette's heat top (`heatTop`): at most 62% of the accent, and no stronger
  than the ink reads on at 4.5:1, so Mono's black or a dark mode's pale
  accent ends its scale early instead of fading its figures. Every
  built-in look and sample App theme passes it.
- **A live region is on the page before its words.** A status that enters
  the accessibility tree already holding its message is not heard: the
  toast speaks through `#toast-live`, emptied and refilled so a repeat is
  said again. An error speaks through `#toast-alert`, assertively, and does
  not time out: it stays, with its ×, until it is dismissed or replaced. Moves (a card, a row, a day) and saves are said there or in
  the board's and list's own polite regions.
- **Dialogs own focus and give it back.** A modal holds Tab and hands focus
  back on close (`Modal.tsx`); the palette is a named modal whose one Tab
  stop is its box. The New form's drawer keeps the list in sight but, like
  a pointer on its scrim, lets nothing past it: it holds Tab, and when it
  goes focus returns to the button that opened it. The glance (`open:
  'drawer'`) covers the list's right side too, so it is a modal: it takes the
  focus when it opens — on its title, where J, K and Tab start, and which
  wears no ring of its own since the glance's box says where the focus is —
  Tab and Shift+Tab stay in it, and Escape gives the focus back to the row
  it was opened from.
- **The focus is never dropped on the page.** A button that is busy says
  so (`aria-disabled`, its handler refusing a second press) instead of going
  disabled, which drops the focus it holds. A moved item is focused where it
  is drawn, again if it is drawn anew after the move is told.
- **A form says what it needs, not only how it looks.** A required field
  carries `aria-required` beside its star (or its neighbors' optional word),
  a field holding a problem carries
  `aria-invalid` beside the problem it describes, and a step that will not
  go on sends the focus to the field to fix.
  Command-field feedback stays below its input in the same column; showing a
  problem must not narrow or move the control. Invalid controls use the danger
  border alongside the written explanation, while retaining the focus ring.
- **One `<main>`, and a way to it.** The pane a room is drawn in is the
  page's `<main>`; the sidebar is navigation beside it, not inside it. The
  first Tab stop is "Skip to content", which lands on that pane. The menu is
  one Tab stop — its filter, or, where an App hides the filter, the current
  row — and the arrows move from there.
- **Targets are 24px square at least** where they sit among others (a
  card's ⋯), and 44px where this file asks (the landing's calls to action).
  On a coarse pointer a row's own small controls — the grip, a checklist's
  box, a card's ⋯, a chip's × — take a 44px hit area without growing what
  they draw (structure.css), and so do the chrome's: the trail's steps, a
  Select's button, a list's Export, + filter and Filters, a record's title, a lane's
  +, a dashboard's windows, a folding section's heading and a gantt's bars. A field cannot take one, so on a phone it is drawn at a target's
  height: a list's search row at a Button's 40px, the sign-in card's fields
  at its submit's 44px, and on a touch screen an App form's fields (a New
  form's, a record's in edit) at the 44px of the form's own actions. Two controls never share a box: a card's ⋯ stands
  in its own column beside the button that opens the card, the
  password's Show beside its field, and a gallery's previous and next beside
  the button that opens the photo, which stops at their columns. A board is a group of lanes, and a
  lane's cards are its list; a record's fields are a `<dl>`.
- **The browser gate reads every room with axe** (`e2e/accessibility.spec.ts`):
  the smoke rooms and the sample Apps' pages, in the App's own look and
  every built-in one, light and dark, failing on a serious or critical
  finding. A finding it lets stand is in its allowlist with the reason.
- **Headings step in order.** A room has one h1 — the record's name, the
  dashboard's, the list's, the table's; on the Workbench's landing, which
  draws no title, a named one that is not drawn. Its sections are h2 and
  what a section holds is h3. A heading's size is its class's, never its
  tag's, so a level can change and the page not.

## What every look shares

Every look carries the same structure (`themeFamilies.css`,
`visualThemes.css`, `themePresets.ts`): a section's 2px rule, one per row;
a table unboxed under its rule; board lanes under a rule; a status said as
its word; a list titled at the list title's step in the look's heading
face; captions and column heads in a darker ink that stays AA and quieter
than the text, crisper hairlines, and each look's tightened corners (Mono
square). A look sets a border's colour and width, never whether it is
there: a room that draws no rule still draws none, and a lane keeps its
border's width, so the drop mark (its edge in the accent) moves nothing.

## Composition

The tokens and layout rules make each part look right; what makes a page look
designed is how the parts are chosen and arranged. A design audit of three
Apps built by agents from the docs alone found dashboards and lists came out
well, because their grammar makes the layout decisions itself (metrics share
a strip, charts size themselves), while record pages, forms and pages that
compose related tables came out as database dumps, because nothing said what
they are made of. The site's composition guides (`mistri docs
compose-record-page`, `compose-form`, `compose-overview`, `compose-list`,
`compose-dashboard`, `compose-shell`) say it as "when X, use Y", each rule
pointing at one sample page that already does it; the reasons live here.

- **One skeleton per archetype.** The good record pages in the samples share
  one: a head of name, state and facts; a summary of figures; children as
  tabs; an aside of the parent's card, the current child, the property rail
  and the history. A page built any other way made the reader assemble the
  record. `packages/engine/src/shared/pageAnatomy.ts` is the rule, so the default page and
  the scaffold's are the same page. Three kinds of record read badly in it,
  and each is a word the author chooses, `page(…, { layout })`
  (`packages/engine/src/shared/pageLayouts.ts`): a `conversation` (a repair, a ticket) keeps
  its one timeline last in the main column at a reading measure, so the
  composer ends the thread and lists above it cannot push it down; a
  `showcase` (a home, a vehicle) puts its photos beside a panel of one to
  three sections and the rest under both at full width, because in the record
  skeleton a phone drew the asking rent and its call to action after every
  list; an `article` (a task, a policy) is one column at `--page-measure`,
  70ch of the body face, because a full-width column of words has no measure.
  A page that names none is given the one its sections already make
  (`chooseLayout`): each archetype is chosen by the section it is named for,
  the photos first, the thread last, the record's own long text with no more
  facts than a rail holds and nothing else, and only where the layout's own
  rule takes the page as written, so the platform never draws what an author
  could not have written. The choice is made when the App is read, from its
  declarations and never from a row, because a page that changed shape
  between records, or once its rows arrived, would be a layout shift every
  time. A written word still matters: it holds the page to the shape and
  refuses a section that breaks it, where a chosen one falls back; `'record'`
  keeps the skeleton on a page that would be chosen as another.
  A layout moves regions and sets the DOM order; it never sets a colour, a
  rule or a type size, which stay the looks' recipes, and no CSS `order` is
  used, so what is read is what is seen. The measure is a structure token no
  look moves. A page's `layout` names a shape from that fixed set, where a
  dashboard's `areas` draws its own grid.
- **The aside is a budget.** It is a third of the record, 256px to 320px
  (16rem to 20rem): two columns of text, a card or a rail. A ratio rather than
  a fixed column, because the menu takes its share of the pane first: fixed at
  320px it left the main column 487px beside the side menu at 1280, three
  figures a pixel short of a row and a related list a column short. As a
  third it keeps 320px in the top menu's shell, where the main column is
  715px and holds four figures and four columns, and gives the side menu's
  main column 538px — three figures and four short columns — growing back to
  320px by about 1450px. The floor holds a rail's 5.5rem caption beside
  an editable value and its pencil. Beside it metric cards wrap, which is why
  the head's figures are a summary, not cards. The scaffold still draws the
  top menu, folded to a bar's seven entries, even for an App with many
  tables: the anatomy's summary is up to four figures, which need 660px, so
  beside the side menu they wrap until about 1480px, and one page for the
  default and the scaffold is worth more than the menu. An author who chooses
  the side menu (Depot) keeps a summary to three. `check --design` judges a
  page at the width its shell leaves, a column by what it holds (a moment
  176px, a day 112, a number 88, words 120).
- **Groups are nouns.** A form or a page grouped by type (Dates, Links,
  Address) is a catalog read aloud; grouped by what the reader is doing
  (Person, Lead, Contact) it is a form.
- **A record is named in words.** "Visit #12" and a bare "B103" say where a
  row is stored, not what it is; the parent's name and a word that tells
  siblings apart ("Maple Court B103", "Ada Park · follow-up") say it. On
  the parent's own page its children's names say only the word ("follow-up"),
  and the column that points back at the parent is left out: both hold one
  value there, the record the page is already about.
- **A rail is caption beside value.** A property rail of one field keeps its
  caption; a lone date under the rail's title reads as a stray value.
- **The shell is chosen.** The look, the mark and a grouped menu carry more
  of an App's character than any section, and the default look with a flat
  menu of table icons reads as unstyled; the scaffold chooses all three so
  that no App starts there.
- **A worked example beats a description.** An agent matches a picture
  better than it follows prose, so each guide shows its sample page, and the
  agent's acceptance is its own screenshot graded against a short rubric
  (the agent guide), not a claim that the page "follows the rules".

## Enforcement

`test/prose.test.ts` keeps counts honest; `check-client-geometry.mjs`
keeps measurement zoom-aware; `check-client-motion.mjs` keeps motion inside the doctrine; `check-client-shape.mjs` keeps every corner
and lift on the look's tokens; `check-client-copy.mjs` keeps every word the
platform says in the catalog; the e2e crash tripwire keeps every walk
honest, and fails as well on a section its error boundary caught
(`[data-section-error]`) and on any Content-Security-Policy violation;
`test/repo/reduced-motion.test.ts` keeps motion rule 6 true of
every stylesheet the client ships; `test/repo/type-weight.test.ts` keeps
every stylesheet at or under weight 700;
`e2e/theme-families.spec.ts` measures AA, the type scale, quiet status
words and unclipped column heads in every look, and holds Sage's exceptions to exactly what they are. When a new rule here is cheap to make executable, make it
executable — a manual ritual is a rule that fails silently on the day
it matters.

What cannot be made executable is made visible: `scripts/visual-matrix.mjs`
holds each page in every look, and `scripts/surface-atlas.mjs` holds every
*kind* of surface beside the others (`.visual/atlas.html`), so a dialog's
field, a New form's and a public form's are read in one row. Drift between
kinds (a label's size, an optional word, a button's order or color, an empty
sentence) is fixed toward the rule here, or the rule is amended.

## Interface language

Framework words belong to the typed message catalog: the words every room
shares in `packages/kit/src/client/messages.ts`, and each module's own in a table beside it
under `src/client/copy/<room>/`, keyed by what it means, with `{name}` holes
the key's text types and `{ one, other }` forms chosen by count. A module's
table travels with the module, so copy loaded on demand stays on demand;
the build shortens its keys, so a key is always written as a string where
it is said.
`test/check-client-copy.mjs` fails on a text literal in JSX or a sentence in a
client module outside the catalog. English is the fallback; Spanish covers
navigation, Preferences, the list words and the filter words so far. Preferences selects a language
per App in the browser; subscribing controls update without remounting forms or
changing drafts. Formatting remains governed by `ui.locale`, currency and timezone.
Never translate identifiers, queries, permissions or stored values. An App's
own words are its `messages/<locale>.ts` catalogs (ICU MessageFormat), named
where a caption goes with `msg(key, args?)`; the server says every caption in
the reader's language (their row's tag, their tenant's, the browser's on a
public page, the App's) before the payload leaves it, so the browser draws
plain strings and never holds another language's. Addresses stay in the App's
own words: a tab's slug and a section's window key are the source's in every
language. The rest of the framework's Spanish remains follow-up work.
