# Theming

Visual themes change presentation, not routes, data access, or authored layouts.
The runtime has five looks for Apps: Workshop, the default, then Lumen, Mono,
Sage and Ledger, and twelve palettes that are the same twelve in every look
([Palettes](#palettes)). Readers choose a look, a palette and
System/Light/Dark independently in More > Preferences. With no choice, an App
wears its preset, and Workshop in Safety orange where it names none. Any other look is the App's
own, written with `defineTheme` ([Bring Your Own Theme](#bring-your-own-theme);
the site's [Themes and branding](../site/src/content/docs/docs/themes.md) page
has three to start from: a neutral kit, a printed page and a colored bar). The database browser — `npx tablewalk <db>`, and an App's
Workbench — wears none of them: it keeps its own look (paper, green, the code
face), with System/Light/Dark, and its Preferences offer no Visual theme. A
reader's built-in pick is kept and dresses the next App they open; custom
choices belong to the App that offers them. A reader's pick overrides the App's, so the picker marks the App's own theme ("This App's theme") and, while a pick is worn instead, offers "Reset to the App's theme", which forgets the reader's theme and palette for that App. The site's
[Looks](../site/src/content/docs/docs/looks.md) page shows them side by side;
this file is the contract.

## Theme Families

| Preset | Character |
| --- | --- |
| Workshop | The default. The desk as a workbench, ported from a field report's theme: warm paper, ink-black type and one hue — Safety orange unless a palette says another — kept to the few marks a reader takes for the brand color: the primary verb's fill (the ink's words on it, edged in the ink, as a hazard tag prints them), links and the current tab's rule, a 3px marker beside the menu's ink block, the focus ring, a checked box and a chart's first series. Fills, rules and selection stay the ink, and nothing is tinted. Titles, section heads and labels in Barlow Semi Condensed's bold capitals, the rest in Barlow, shipped with the look; 2px ink rules part the sections; 2px corners; nothing floats; the menu's current entry an ink block with the hue's marker beside it, on a faint grain. |
| Lumen | Flat, calm and modern: a warm, faintly tinted shell around white working surfaces, elevation only on what floats (menus, dialogs, drawers), one confident accent for the primary action, the current room, selection, focus, the main chart series and the current step; a menu whose current room is a soft pill with quiet counts on its lists of work; metrics in a divided strip; record fields in a property rail; tables on hairlines with the record's name as the row's anchor and a head that sticks; statuses as a dot and their word (grey where neutral); a workflow as a track of segments; charts as a 1.5px line in one hue's steps; Inter, shipped with the look. Its blue is the **Cobalt** palette; every other palette changes only the accent's family. |
| Mono | Black and white: square corners, rules in the ink over grey hairlines, monospace figures and labels, the current tab inverted; colour only for status. |
| Ledger | A bookkeeper's desk, ported from a field report's theme: green-tinted paper on a faint graph-paper ground, every figure, id, date and label in a monospace (IBM Plex Mono) with titles and prose in Inter, a dark green cover for the menu and the bar with a gilt mark for the current entry, field groups and dashboard sections as square boxes ruled in the strong line, a table's heads closed with a double rule (`rules: 'double'`), and one deep ledger green for the accent. Light and dark. |
| Sage | A soft workspace: warm cream grounds with a dashboard's sections and stat cards on white panels (a soft shadow, the 8px radius and its 12px larger step) and tables open on the ground, near-black ink for text and calls to action, sage green for charts and good news, a warm tint for what is chosen, and meaning in soft tinted pills. |

Mono stands on the shared structure: rules instead of boxes (a table unboxed
under a 2px rule in the ink, board lanes under the same rule), a status said as
its word, and three steps of heading in the look's own face and weight; so does
a theme that extends no look. Sage keeps the headings, tabs and type scale but
puts a dashboard's sections and its stat cards on white panels (a table stays
open, rows on the ground under a hairline) and says a status as a tinted pill —
its exceptions are recorded in [design.md](design.md#the-refusal-list-after-impeccablestyle-kept-where-it-applies).
Lumen keeps the headings and type scale and stays flat: sections, metric strips,
tables and record fields stand open on the ground, divided by hairlines; only
what floats is lifted. Tabs are underlined, statuses are a dot and their word,
a workflow is a track of segments, a dashboard's steps are a strip, and board
lanes are headed by tinted strips (Lumen's exceptions, in
[design.md](design.md#the-refusal-list-after-impeccablestyle-kept-where-it-applies)).
Ledger is Lumen's flat structure drawn square and ruled: dashboard sections and
field groups are boxes in the strong line, a table's heads close with a double
rule, and the figures are set in a monospace (Ledger's exceptions, in design.md).

Each includes light and dark colors. Selecting one never rewrites the App's
manifest. An author picks the App's default with
`ui: { theme: { preset: 'sage' } }`, or builds on one in a custom definition
with `extends: 'sage'`; the same goes for `workshop`, `lumen`, `mono` and `ledger`. A
built-in look's palette is chosen the same way
(`ui: { theme: { preset: 'lumen', palette: 'teal' } }`). A reader can pick
another under Palette in Preferences while that look is on.

### Palettes

A palette is a colour identity apart from the look, from one registry
(`packages/engine/src/shared/lookPalettes.ts`): **Crimson** (`crimson`),
**Safety orange** (`safety`), **Amber** (`amber`), **Moss** (`moss`),
**Emerald** (`emerald`), **Teal** (`teal`), **Cobalt** (`cobalt`), **Violet**
(`violet`), **Plum** (`plum`), **Rose** (`rose`), **Slate** (`slate`) and
**Ink** (`ink`). Every built-in look offers all twelve, in that order, and
wears one by default: Workshop Safety orange, Lumen Cobalt, Mono and Sage Ink
(each look's own ink), Ledger Emerald (in the book's own deeper green). The look keeps its grounds, neutrals, type, shape and
recipes and decides which roles the hue reaches:

| Look | What a palette changes |
| --- | --- |
| Workshop | The primary verb's fill and its words, links and the current tab's rule, the menu's marker, the focus ring, a checked box and the first chart series. Selection, the menu's block and the rules stay the ink; no tint. |
| Lumen | The accent and its pale tint, links, the focus ring, the menu's mark and the first chart series. |
| Mono, Sage | The same as Lumen, on the look's own neutral tint for what is chosen. |
| Ledger | The accent and its pale tint, links, the focus ring, the rules (a table's double-ruled heads, a box's top rule) and the first chart series. The paper and the menu's green cover stay the book's own, with the gilt mark. |

A palette's first series takes the place of the look's series nearest its
hue, and the rest follow in the look's order wherever each neighbour stays
apart for a colour-blind reader. Every palette in every look, light and dark,
is measured by `test/contrast.test.ts`: text and links 4.5:1, the words on a
fill 4.5:1, the focus ring 3:1, adjacent series apart. A built-in look's own
colours are its default palette, so its picker lists the twelve and no
separate Default; `palette: 'default'` still names the look's own. An App's own
`accent`, `radius` and `font` win over the look, so a brand colour stays the
App's; the accent is the charts' first series as well. Mono is the one
exception to the radius: it is square, an authored radius included.

## Bring Your Own Theme

A theme is data: colours by what they are for, a shape, a type, a starting
density and one treatment per part from a closed menu. `defineTheme` returns
it; an App wears it as its look (`ui.theme`) or offers it beside the built-ins
(`ui.customThemes`):

```ts
// theme.ts
import { defineTheme } from '@mistriwork/mistri/app';

export const harbor = defineTheme({
  id: 'harbor',
  label: 'Harbor',
  extends: 'lumen', // start from a built-in look; say only what differs
  colors: {
    light: { accent: '#006976', ink: '#202c30', nav: { accent: '#006976' } },
    // A dark panel of its own asks the first chart series to read on it too: the accent, as in light.
    dark: { accent: '#85d6dc', surface: '#1a2529', ink: '#ecf4f4', chart: ['#85d6dc'] },
  },
  shape: { radius: { control: '3px', field: '3px' } },
  type: { font: { heading: 'Georgia, serif' } },
  recipes: { tabs: 'pill', status: 'dot' },
});
```

```ts
// app.ts
import { defineApp } from '@mistriwork/mistri/app';
import { harbor } from './theme.ts';

export default defineApp({
  name: 'Operations',
  // … resources, views and home …
  ui: { theme: harbor }, // or customThemes: [harbor] to offer it in the picker
});
```

Without `extends` a theme names `ground`, `surface`, `ink` and `accent` in both
modes and every other colour is derived from them (captions and lines mixed from
the ink into the surface, the accent's tint, meaning colours that read on white
and near-black, Lumen's chart series after the accent), on the plain structure:
every recipe at its first value. With `extends` it starts
from that look — its colours, palettes, faces, corners and recipes — and an
accent it changes takes along the roles that were that accent (its tint, the
ring, links, the menu's accent), and the first chart series and the metric
sparklines unless it names `colors.chart` itself, whatever hue the look drew them in.

`preset: 'lumen'` stays the spelling of "this built-in, as it is", with the
App's own `accent`, `radius` and `font` over it. There is no third way: a
theme of the App's own is a `defineTheme`.

The built-in looks are themselves written with this spec
(`packages/engine/src/shared/themeLooks.ts`) and compiled by the same function, so every
recipe on the menu is one a built-in wears — or one of the few, named below,
that only an App's own theme picks — and a look the menu could not say would
extend the menu rather than be special-cased.

Like other executable app modules, imported TypeScript or JavaScript is
trusted local code, not sandboxed third-party content. Keep modules inside the
watched app directory for the existing reload mechanism.

### The recipe menu

Each part takes one value; the first is the default, and the look that wears
each other value is named beside it. A value marked *own* no built-in wears:
it is there for an App's own theme (a bar in the navigation's colour, a
printed page's rules and capitals), fetched only when one picks it. The values
are attributes the shipped sheets answer (`data-look-<part>`); an App writes no
CSS.

| Part       | Values                                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| `nav`      | `tint`, `inverted` (Mono), `wash` (own), `underline` (own), `pill` (Lumen), `quiet` (Sage), `slot` (Workshop)           |
| `bar`      | `plain`, `ruled` (Workshop, Mono), `dark` (own), `airy` (Lumen), `soft` (Sage)                                          |
| `tabs`     | `pill`, `inverted` (Mono), `underline` (Lumen), `rule` (Workshop), `chosen` (Sage)                                      |
| `windows`  | `segmented` (Workshop), `lifted` (Lumen), `chosen` (Sage)                                                               |
| `stat`     | `plain`, `framed` (Mono), `topline` (own), `ruled` (Workshop), `icon` (own), `panel` (Sage), `divided` (Lumen)          |
| `section`  | `open` (Workshop, Lumen), `card` (own), `panel` (Sage)                                                                  |
| `fields`   | `open` (Workshop), `panel` (Sage), `card` (own), `rail` (Lumen)                                                         |
| `table`    | `open` (Workshop), `tinted` (own), `hairline` (Sage), `card` (own), `quiet` (Lumen)                                     |
| `status`   | `dot` (Workshop), `pill` (Sage), `pill-dot` (own), `quiet` (Lumen)                                                      |
| `board`    | `ruled` (Workshop), `soft` (Sage), `strip` (Lumen)                                                                      |
| `chart`    | `plain` (Workshop), `wash` (Sage), `gradient` (own), `line` (Lumen)                                                     |
| `buttons`  | `accent`, `raised` (Lumen), `keyed` (Workshop)                                                                          |
| `links`    | `plain`, `underline` (Mono)                                                                                             |
| `rules`    | `ink` (Workshop), `hairline` (Lumen, Sage), `double` (Ledger)                                                           |
| `avatar`   | `plain`, `large` (Sage), `round` (Lumen)                                                                                |
| `workflow` | `markers` (Workshop, Lumen), `pills` (own)                                                                              |
| `banner`   | `tint`, `gradient` (own), `plain` (Workshop, Lumen)                                                                     |
| `steps`    | `flat`, `tinted` (own), `strip` (Workshop, Lumen)                                                                       |
| `lanes`    | `tint`, `tag` (Workshop), `plain` (own)                                                                                 |
| `header`   | `plain`, `band` (Sage), `hero` (own)                                                                                    |

Each value is pictured on the CRM (the former Compass sample) in the site's recipe gallery
(`site/src/content/docs/docs/theme-recipes.md`, its pictures under
`site/src/assets/recipes/`, made by `node scripts/docs-shots.mjs recipes/`).
`mistri shot --recipes <part> [page]` makes the same contact sheet for an
App's own theme and page, and the bench `mistri dev` serves at `/_theme`
tries values on the App's own pages, light and dark side by side, with every
contrast check read as it changes and the `defineTheme` line to paste back.

`shape.elevation` is `hairline` (the default), `flat` (Mono), `soft` (Sage)
or `raised` (Lumen): a preset, each its look's own drawing of a card's lift
and a popup's. Or it says the steps, `{ card, float }`, over the base's
drawing: each is `none`, `hairline` (a hairline's shade), `low` (the
platform's popups), `mid` (Sage's) or `high` (Lumen's). `card` lifts the
cards a recipe draws (a section, a field group or a stat boxed by `section`,
`fields` or `stat`); `float` what floats (a menu, a popover, a drawer, a
dialog a step above). They are `data-look-card` and `data-look-float`, `look`
where the theme says none. Every lift is mixed from one colour, `shadow` in
each mode's `colors` (worn as `--shadow-ink`): omitted, the look's — its ink
by day and its ground by night. A shadow of the theme's own under `hairline`
draws the platform's popups in it, as the `low` step. A shadow lighter than
its ground is a glow, not a lift, and `check` says so (`theme-shadow`, C2).

`type.base` (`13px` to `16px`, omitted 13px) is the size an App's text is
drawn at, and every size grows with it: each `font-size` in the client's
sheets is written over `--type-k` (`calc(12px * var(--type-k))`, which
`test/check-client-type.mjs` holds them to), and a theme's base is worn as
`--type-k: calc(<base> / 13)`. Density is not type: it zooms the whole room.

`type.roles` says how each kind of text is drawn, by what it is for, and only
what differs from the look: `display` (a landing's headline), `title` (a
record's and a dashboard's name), `heading` (a list naming itself), `section`
(a section's title), `body`, `label` (a column's head, a stat's label, a
record's tabs), `data` (a table's cells, a record's values and its header's
figures; `reach: 'figures'` keeps the data face to figures, keys and dates, so
a name is read in the interface face), `figure` (a stat's figure) and
`nav` (the menu's entries, in the bar and down the side). A role takes a `face` (`ui`, `heading`, `data`, or
`code`, the theme's monospace: `fonts.code`, else the platform's), a `size` at the 13px base (only the roles
that have one: body, label, data and nav follow the base), `leading`,
`tracking`, `weight`, `case` (`upper` or `small-caps`, each tracked unless
the role says a tracking) and OpenType `features` (`tnum`, `lnum`, `zero`,
`ss01`…); `packages/engine/src/shared/themeType.ts` holds which role takes what, and the
ranges. The title's weight is every heading's (`--heading-weight`), and a
list's heading takes it unless its own says otherwise. A role is worn as
`--type-<role>-<property>` tokens and one `data-type-<role>` attribute naming
what it says, and a role that says nothing turns no rule on, so a theme
without roles draws as its look does. The looks are roles too: Lumen's
titles 28px at 600, tight, its list heading 24px and its sections 16px; Mono's
titles 30px at 700, its labels and bar entries in monospace capitals and its
figures in a bold monospace; Sage's titles at 600. A look's own nav role dresses the bar only; the side menu
wears the role where a theme sets it (`data-type-nav-side`), so a look's side menu is as it always was. `check` warns of a weight
past 700 in a face the theme does not ship at that weight (`theme-type`, C8).

The roles replaced `type.scale` (now `title.size`, 22px to 30px),
`type.headingWeight` (now `title.weight`) and three recipes: `labels`
(`mono-caps` is `label: { face: 'code', case: 'upper' }`), `headings` (`caps`
is `section: { case: 'upper', size: '12px' }`) and `figures` (`book` is
`figure: { face: 'heading', weight: 600, features: ['lnum'] }`). Each old
spelling is refused with its new one.

### Past the menu: bands, patterns, parts and icons

Four things a theme may say that no built-in look does (but Workshop's menu
grain, a pattern), each held to the contract as a recipe is, and each worn
only where it is said: a theme that says none of them sets no attribute and
fetches no sheet, so every theme written before them draws as it did (the
computed-style snapshot of every look holds this).

- **A band.** `recipes.table: 'banded'` lays every other row of a table on
  `band` (in each mode's `colors`; omitted, `raised`), and `check` measures
  each ink a row holds on it (`theme-contrast`, C1). It is a `brandLook.css`
  rule like the other recipes no look wears. It stripes a list's or grid's
  table (`.table-wrap`), not the calendar's weeks. A `status` or `tag` part
  given an opaque `ground` keeps it on the band, because part rules sit in the
  `theme` cascade layer above the `look` layer the band is drawn in; the cell
  shows as a pale column on every other row, and `check` warns of it
  (`theme-band`, C13). mistri does not mix or override the color you wrote:
  give the part a translucent ground, or leave its ground out for the look's.
- **A pattern.** `surface: { ground, nav }` draws one of six patterns behind
  the page and behind the menu, never behind a panel or a field: `paper`,
  `grain`, `grid`, `dots`, `lines` or `scanlines`, at `strength` 1 (omitted),
  2 or 3. A pattern is gradients in the theme's own line color (`line`, the
  menu's `nav.line`) at 40%, 70% or all of it (`paper`, two families of
  fibers crossing, at 20%, 45% or 70%), so it is a role, nothing moves
  and no picture is fetched; `check` measures the words over its darkest
  point, the line under them (`theme-contrast`, "on the page's grid
  pattern"). Worn as `data-surface-ground` and `data-surface-nav`
  (`surfacesLook.css`, in the `theme` layer).
- **A part's own style.** `parts` dresses a published part one by one:
  `ground`, `bar`, `bar.search`, `nav`, `nav.item`, `nav.current`,
  `nav.group`, `logo`, `page.title`, `tabs`, `tab.current`, `section`,
  `section.title`, `stat`, `stat.figure`, `fields`, `field.label`, `table`,
  `table.head`, `table.row`, `status`, `tag`, `button.primary`,
  `button.secondary`, `button.quiet`, `link`, `board.lane`, `board.card`,
  `workflow.step`, `banner`, `steps.step`, `avatar`, `menu`, `dialog` and
  `chart`. A part takes a `ground`, an `ink` and an `edge` as color roles by
  their path (`nav.ground`, `status.good`, `chart[2]`), never a hex, so
  `check` measures its ink on its ground in every mode and palette
  (`theme-part`, C13); a `radius` (`control`, `field`, `pill`, `panel`,
  `square`), a `lift` (the steps), a `face` (`ui`, `heading`, `data`), a
  `weight` (400 to 700) and a `case` (`upper`, `small-caps`, `none`). Nothing
  that moves a box: size, spacing, order and visibility are the App's, and a
  part style that says one is refused naming that. Each property is worn as
  `--part-<part>-<property>` on body, under the App's own accent, and one
  word in the root's `data-parts` (`stat:edge`) turns on its one rule in
  `partsLook.css`, generated from the selector map
  (`packages/mistri/src/server/app/themePartSelectors.ts`). The names are contract 1: a 1.x
  release may publish another part and withdraws none; which elements a part
  names is the platform's, so it follows its markup.
- **The icons' weight.** `type.icons` is `regular` (omitted), `light`,
  `bold` or `fill`, Phosphor's. Thin is refused (a 1px stroke fades at the
  16px an icon is drawn at), and so is duotone (a second tone no role says).
  Regular and bold are in every glyph the page has; light and fill are a
  chunk of their own (`packages/engine/src/shared/iconWeights.ts`) fetched once when a worn
  theme picks one, and waited for before the page is revealed. An icon given
  its own weight, a logo's bold, keeps it.

These stand in the `theme` cascade layer, over the look the theme extends
and under `structure` (docs/design.md, The cascade).

### A theme's own stylesheet, and a look as a package

`stylesheet: './theme.css'` is the last step past the menu: a file beside
the theme, at most 8 KB, read once as the App loads by an allowlist of its
own (`packages/mistri/src/server/app/themeStylesheet.ts`, no CSS library). A rule names
published parts, `[data-part="stat"]`, with `:hover`, `:focus-visible`,
`[aria-current]`, `[aria-selected="true"]` or `[aria-expanded="true"]`, under
an optional `[data-mode="dark"]`; a declaration dresses a box without moving
it: colors as roles, role gradients and pictures beside the sheet, edges of
at most 3px, the theme's corners, lifts and faces, letter case and spacing,
underlines and figure forms. Everything else is refused by its line and why
(`theme-css`, C13), at-rules and `!important` first. There is no glow: a
`box-shadow` is one of the look's own lifts, `text-shadow` and `filter` are
refused as a glow, and a lift's color is the theme's `shadow`,
which C2 refuses lighter than the ground (`theme-shadow`), so a neon or CRT
look draws its light with color and edges, not bloom. The sheet that is served
is written again from what matched, never passed through: each part becomes
the selectors the platform draws it with (the same map as `parts`), every
rule is prefixed by `:root[data-visual-theme="<id>"]`, the whole sits in
`@layer theme`, and its pictures are served content-named beside it from the
App's `_brand/` address. The page links it only while the theme is worn and
waits for it before the reveal. A build carries it in `brand/`.

A look is published as a package whose `defineTheme` says
`contract: 1` and `from: import.meta.url`. `from` makes the package the root
its faces and stylesheet are read from (not the App that installs it), held
by real path, so a symlink out of it is refused; `contract` is what a 1.x
mistri reads, and a theme written to another is refused naming the
release to install (`theme-contract`). An App wears it as one of its own,
`customThemes: [daybook]`, or starts from it: `extends` takes a theme that
extends a built-in, one level deep, inheriting its faces and stylesheet. A
tenant's theme has no directory, so it can say neither. The definition the
browser is sent carries no path; the package's root is held beside the
compiled theme in memory, and the definition bundle `mistri build` proves
resolves each module's `import.meta.url` to its source, relative to the
build. `test/fixtures/theme-package` is a published look, installed into two
Apps by `test/theme-package.test.ts`.

`density` (`compact`, `comfortable`, `spacious`) is where a reader starts;
their own Preferences choice wins.

`motion` is the pace things enter at, within the motion doctrine in
`docs/design.md`: `house` (the default, every built-in's) is the platform's
140ms press, 120ms hover, 160ms popover and 200ms panel; `brisk` is each a
quarter quicker (105, 90, 120, 150 and 900ms), for a tool that is used all day;
`still` enters nothing, as reduced motion draws a page. It is worn as
`data-look-motion` and changes the five duration tokens (`--t-press`,
`--t-hover`, `--t-popover`, `--t-panel`, `--t-changed`), so no pace can add an animation the
doctrine refuses. A reader who asks their system for reduced motion gets
`still` under every pace.

`rhythm` is how far apart things stand, on the space scale in
`docs/design.md` (Space and text): `house` (the default, every built-in's) is
the platform's spacing; `tight` draws the layout steps — 16, 24, 32 and 48px,
and the 40px section seam — a quarter closer (12, 18, 24, 36 and 30px), and
`airy` a quarter wider (20, 30, 40, 60 and 50px). It is worn as
`data-look-rhythm` and changes those five tokens only: the steps under 16px
are a control's own padding and a row's height is the density's, so a rhythm
moves the page's air and never a control's size or a target under 24px.

## Contract

### Theme, palette and mode

A theme owns structure, fonts and radii. A palette owns colors. System, Light
and Dark choose which mode of those colors to display. A definition's
`colors: { light, dark }` is the original **Default** palette. (The key was
`palette` before 1.0; it was renamed so that `palette` names only a
variation, as `ui.theme.palette` and `palettes` do.)

A built-in look's palettes are the shared twelve ([Palettes](#palettes)); a
theme that extends one and names no colours of its own keeps them.
Optionally add up to 20 `palettes`, each with a unique lowercase `id`, a
`label` of 1–60 characters, and both `light` and `dark` objects. These objects
accept partial color roles, including empty objects; omitted roles inherit
the theme's corresponding original mode, then its built-in base. They cannot
change fonts, radii or structure. The id `default` is reserved for the original
pair. For example, inside a theme definition:

```ts
palettes: [
  { id: 'mint', label: 'Mint', light: { accent: '#225544' }, dark: { accent: '#aaddcc' } },
  { id: 'lilac', label: 'Lilac', light: { accent: '#63439c' }, dark: { accent: '#cdb6f1' } },
],
defaultPalette: 'mint',
```

`defaultPalette` is optional; it must name one of these palettes or `default`.
An App can override it with `ui.theme: { preset: 'harbor', palette: 'lilac' }`.
An explicit `palette: 'default'` selects the original pair even when the theme
names a different default. Palette references require a preset and are checked
when loading the App. Readers choose a palette separately in Preferences;
palette choices are scoped to the App and theme, not shared between unrelated
themes. Missing stored palettes fall back to the current defaults.

Inheritance is built-in base → original theme colors → selected palette.
The legacy App tokens still override these colors. Contrast diagnostics check
the original pair and every named variant in both modes, including inherited
roles, not just the palette selected by default.

### Roles and validation

Definitions have a unique lowercase `id` and a `label`. `extends` names one
built-in look, not an arbitrary chain of theme modules. Up to 20 themes can be
registered by one App. Colours are lowercase six-digit hex. Unknown keys,
recipe values off the menu, CSS functions, URLs, duplicate ids and built-in
name collisions are refused with the path of the key (`colors.dark.status.critical`).

The navigation's colors dress the menu, whichever the shell draws and under
every bar recipe: a side menu, the phone's drawer and a top bar's menu stand on
`nav.ground`, their entries in `nav.ink`, their group headings, counts and icons
in `nav.muted`, the current entry in `nav.accent` (or a `nav.current` block).
The bar recipe picks the bar's shape — a rule beneath it, an airy search, a
soft panel — never whose colors the menu wears. Two things on the bar are the
page's, not the menu's: the search is a field on the surface in the page's ink
(the dark bar alone draws it on its own ground), and a soft bar beside a side
menu is a panel on the page in the page's colors. `check` reads each pair and
names the element it failed for ("the menu's group headings, counts and icons,
nav.muted/nav.ground …"), with a passing hex beside it; `e2e/menu-contrast.spec.ts`
measures the drawn menu at 4.5:1 under every bar recipe, both placements and
both modes.

A theme may say where the menu goes: `shell: { placement: 'top' }` (or
`'side'`). It is a suggestion the App's own `ui.shell.placement` overrides, and
an App that asks for a rail keeps the side; it holds only when the theme is the
App's (`ui.theme.preset`), not when a person picks it from Settings.

A mode's grounds are one family. When a theme moves `surface` away from its
base's hue, which is common in dark mode, set that mode's `ground`, `raised`,
lines, captions (`inkMuted`, `inkSubtle`) and `nav` colours with it.
Otherwise they are inherited from the base's own dark, and the bar and the
cards sit in one colour on a page of another. The Forecourt fixture's Marketplace theme
sets its navy dark family in full.

| Colour                                                                        | What it is for                                                 |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `ground`, `surface`, `raised`                                                 | the page, panels and fields, a row's hover                     |
| `line`, `lineStrong`, `lineControl`                                           | hairlines, emphasized rules, a control's edge                  |
| `ink`, `inkMuted`, `inkSubtle`                                                | text, secondary, tertiary                                      |
| `accent`, `onAccent`, `accentInk`, `accentSoft`, `link`, `focus`               | the accent as a fill, the words on it, the accent as text, its tint, links, the ring |
| `primary`, `onPrimary`                                                        | a form's primary action (Continue, Submit, Add) and the words on it |
| `field`                                                                       | a field's fill                                                 |
| `status.good`, `.warning`, `.critical`, `.info`                               | meaning                                                        |
| `nav.ground`, `.ink`, `.muted`, `.line`, `.accent`, `.current`, `.onCurrent`  | the bar and the menu, whichever the shell draws                |
| `rules.section`, `.head`                                                      | the rule over a section and under a table's heads              |
| `chart[0]` … `chart[7]`                                                       | the series, in order; `null` keeps a series                    |

A color has one name everywhere: in `defineTheme`, in `check`'s messages, in
`mistri theme show` and as the custom property a sheet or an App's component
reads — the path, hyphenated: `ink` is `var(--ink)`, `nav.ground` is
`var(--nav-ground)`, `status.critical` is `var(--status-critical)`, `chart[0]`
is `var(--chart-1)`. A compiled theme (`ThemePalette`) holds the same names
flattened (`navGround`, `statusCritical`, `chart1`).

`nav.current` is a filled block behind the current navigation item (with
`nav.onCurrent` on it). `rules.section` and `rules.head` colour and thicken
borders that already take their space, so nothing shifts. `lineControl` is the
edge of a form control and must reach 3:1 against `surface`, `ground` and
`raised`, where a table's head and a raised panel put it (WCAG 1.4.11). `focus` is the keyboard ring; left out, it is the `accent`.

The accent is a fill, and a brand accent is chosen as one: a bright orange
(`#ff8534`) wants near-black words on it and is 2.3:1 as text on white. So the
two inks it needs are their own colours. `onAccent` is the words on an accent
fill (a button, a selected tab) and `accentInk` is the accent drawn as text (a
quiet action, a current tab's word); `check` measures each where it is drawn, 4.5:1
`onAccent` on `accent` and `accentInk` on `surface`, `ground` and `raised`. Name
neither and the one that passes is taken: the `ground` for `onAccent`, else the `ink`, white or black; the
accent itself for `accentInk`, else the accent drawn toward the `ink` until it
reads. `link`, `focus`, `nav.accent` and the first chart series, where a theme
left them as its accent, follow `accentInk`. An App's own `ui.theme.accent` is
worn with inks chosen for it. A tenant's accent (`branding`) is still held to
read as text itself: a tenant picks one colour, and it is refused rather than
darkened.

A form's primary action is a fill of its own, `primary`, because the accent is
not always the color a form should press in: Lumen fills it in its ink, so a
long application says "next" by weight rather than by hue, while Mono and Sage
leave it as their accent. Name your accent (or your brand) as `primary` to have
every command form, New form and stepper press in it. Left out, a theme that
extends a look keeps the look's choice — following the theme's own `ink` or
`accent` where the look's was that color — and one that extends nothing fills
it in its accent. `onPrimary` is the words on it, taken as `onAccent` is when
omitted, and `check` measures it at 4.5:1 on `primary`.

A dark App says so with `scheme`. `scheme: 'dark'` is worn dark until the reader
picks a mode themselves (a reader's own pick, "match the system" included, wins
from then on); the theme keeps a light mode, held to a printed page's white paper
like any light palette. `scheme: 'dark-only'` has no light colors: `colors` names
`dark` alone (a `colors.light`, or a palette's `light`, is refused), the theme is
judged as dark and never as paper, and a reader cannot turn it light (Preferences shows the color mode as Dark, switched off, with a line saying why). Before, the
only way to a dark App was dark colors in the light slot, which the paper check
refused: a light palette whose accent vanishes on white paper. A dark-only theme
is printed by the same print layer as any dark mode (`@media print` in `style.css`,
which sets the page to ink on white); it has no light palette of its own to be
checked as paper. The server says the scheme in the first page (`mistri-scheme`, read by the
boot script in `index.html`), so a first visit is dark from its first paint
rather than light until the theme arrives; a reader's own stored mode still
wins where there is a light to choose. A tenant's or
host's saved theme takes `scheme` too, read by the same rule; its stored `light`
must be its `dark` (or absent) when it is dark-only.

One validator (`packages/mistri/src/shared/themeCheck.ts`) holds every theme an App authors,
at `mistri check`, at `mistri build`, and — for a tenant's branding — at
the save: text, links, the accent, the meaning colours and the menu at 4.5:1
on every ground they are drawn on — the page, a panel or card, the raised
ground of a table's head and a hovered row, a selected item's tint, a tone
chip, a tinted row and the pill menu's current entry on the menu's ground —
controls, the ring and the first four series at 3:1, in light and dark and
every palette; and each pair of adjacent chart series at least 8 apart in
OKLab (ΔE×100) for protanopia and deuteranopia (Machado 2009, full severity)
and 10 apart to normal vision. A colour is measured where it is drawn, not
only where it was picked: a control edge at 3:1 on the panel and the page that
reads 2.72:1 on a table's head is refused. A failure names the colour where
the theme writes it, the measure and the ground, and the nearest value of its
hue that passes (`check --fix` writes it): `Theme "Cadence" (light),
cadence.colors.light.lineControl: lineControl on raised (a control's edge on a
raised panel or a table's head) is 2.72:1; it needs 3:1 (lineControl is
#928c99). Try lineControl: '#8a8491' (3.02:1).` Colours a theme keeps from the
built-in it extends are not held against it.

Every failure is coded by the promise it breaks (the theme contract, C1 to C13,
`packages/mistri/src/server/build/themeContract.ts` and the site's `theme-contract.md`):
`theme-contrast` words (C1), `theme-edge` a control's edge (C2),
`theme-focus` the ring on the panel, the page and a raised row (C3; the
menu's ring is measured by `grade`), `theme-chart` the series (C7), `theme-print` a light palette's
accent ink and link on white paper where they are lighter than the panel (C12), and
`theme-budget` the faces past 150 KB (C11). Each `check --json` finding says
its `promise`. What only a drawn page shows, `mistri grade` measures:
`faint-edge`, `hidden-focus` (the Tab key's stops at 1280, a ring 2px at 3:1
or another change), `color-only`, `long-measure` (80 characters a line),
`unsafe-motion` (nothing moves under reduced motion, nothing past 200ms
otherwise), `print-contrast`, `heavy-theme` (the theme's own files past
200 KB on a cold visit) and `changed-app` (the controls the accessibility tree at 1280
reaches under the theme against the App's own look's, a control folded into a "More" menu still reached when grade opens the fold and
finds it there, by its own name or the one it filters, except where the theme moves
the menu). `grade --theme all [--palette all] [--as all]` grades every look,
palette and role as one table (`gradeMatrix.ts`), a palette at 390 in light
and dark on the color promises only.

Fonts expose `ui`, `data`, `heading`, and `code` stacks. These reference installed
or separately app-hosted fonts; definitions do not fetch assets or inject
`@font-face`. The one face mistri ships is Lumen's Inter, declared in
Lumen's own sheet, so a theme that extends Lumen and keeps its stack is set
in it too. The heading role covers page and section titles; a base style may
also use it for its wordmark. Density and structural layout are not font settings.

The four stacks are also tokens a component reads (`--sans`, `--mono`, `--heading-font`, `--code`; `tokens` from `@mistriwork/mistri/ui`). Which face a column's values wear is the App's to say per column, not the theme's: a display rule's `face` (`data`, `ui` or `code`) sets it, and unasked an App reads text in the reading face and keeps the data face for keys, references and codes, so a theme whose data face is monospace does not turn every name into code.

`shape.radius` is `{ control, field, pill, panel }`; one bare length is refused. `control` is a button's, an
input's and a select's corner, `0px` through `16px` or `'round'`; `field` a record's and a form's field,
`0px` through `12px`; `panel` a card's, a section's and a dialog's, `0px` through `20px` (omitted, one and a
half controls', at most 20px). Each look has one radius for controls and fields: Lumen and Sage 8px, Ledger 2px (its fields square), Mono
square, and a theme that extends none 4px. A custom theme inherits its base's radii, and an explicit custom
radius wins. A round control is a pill (`--control-radius`); every other box that follows the control's
corner — a menu, a card, a row — takes 8px, because a card is not a pill, and a popup never passes 12px.
`check` warns (`theme-radius`) when a `panel` is squarer than its `control`. `pill` is a status pill's, a
tag's, a chip's and a count's corner, `0px` through `12px` or `'round'`, and only an object says it:
omitted, they stay round under every look, so a ledger that wants square stamps says `radius: { pill: '2px' }`.

`shape.border` says the widths, each omitted for the look's own: `rule`, the rules over a section and under a
table's heads (`1px`–`3px`); `control`, a field's and a select's edge (`1px` or `2px`); `panel`, a card's and
a section's edge where the look draws one (`0px` draws none); `focus`, the focus ring (`2px` or `3px`, never
thinner than the house ring). A width is shape, said once for both modes: `colors.*.rules.weight` and
`.control` are refused with their new names.

Public types are exported from `@mistriwork/mistri/app`. The data-format schema is
`@mistriwork/mistri/schema/theme.schema.json`. CSS token names are implementation details;
custom modules use the typed role names instead of depending on selectors.

### An App's logo picture

`ui.logo` is a curated App icon, or the App's own picture: `{ src, dark?, mark? }`, PNG, JPEG, WebP, GIF or SVG
files in its directory. The load admits each as a tenant's upload is admitted (server/app/brandImage.ts: a raster
its first bytes say is one, at most 256 KB; an SVG written again from an allowlist) and serves it from the App's own
origin at `/{app}/_brand/<name>-<hash>.<ext>`, with `nosniff`, a policy that runs nothing, and a year's cache, its
name being its content's (server/http/brandRoutes.ts). A URL is refused: another site's file is not the App's to
serve. The bar draws `src` in the 96×24 box a tenant's logo has; `dark` where the bar is dark, which is dark mode and, under a theme
whose bar is dark by day (an inverted `nav.ground`, `bar: 'dark'`), light mode too; `mark` is the tab's icon. The
mark stays decorative: the App's name is the bar's accessible label. A record's branding and a tenant's logo are
drawn over it. `check` warns (`theme-dark`, the contract's C10) on a picture with no `dark`.

### Tenant branding

A tenant App (`auth.rows: 'tenant'`) may let each tenant brand it at runtime:

```ts
branding: { allow: ['logo', 'name', 'accent', 'density'], editors: ['admin'], themes: [meridian, 'mono'] },
```

`allow` is a closed list: `logo`, `name`, `accent`, `palette`, `radius`,
`density`, and `theme` (only with two or more `themes`; omitted, the one theme
is the App's own look with its accent). Grounds, ink and recipes are never a
tenant's: what a tenant changes is a brand, not a design. `editors` are tenant
roles; only their members save, never a support operator and never the
platform realm. A `brandingForm()` dashboard section is the editor: a form
beside a live preview of the bar, a record header, a stat card and an email
header, judged as the save will judge it.

The value is kept per tenant in reserved `__mistri_branding_*` tables (on PostgreSQL, `mistri.branding_*`)
(`provisionStores(<the database>, { app: { definition } })` from
`@mistriwork/mistri/maintenance` makes every store the App declares, this one when it
declares `branding`; `only: ['branding']` names it alone and is refused for an App
that does not declare it; a deployment that declares `branding` without them
refuses to start). A save is checked field by field — an accent is `#rrggbb`
or nothing, a radius `0px`–`8px`, a name one line without `<` or `>` — then the
whole theme the tenant would wear goes through the validator above, holding
against the tenant only the colours its accent changed. A refusal is a fixed
sentence per kind of failure, beside the field. A logo is sniffed by its bytes
(PNG, JPEG, WebP, GIF up to 256 KB; SVG up to 64 KB, parsed and written again
from an element and attribute allowlist: no script, handler, `href`, `style`
or foreign content), stored by its sha256 and served from the App's own origin
at `/api/branding/logo/<hash>` with `nosniff`, a sandboxing CSP and an
immutable cache. Nothing a tenant typed reaches CSS: the page receives a
compiled theme whose values passed the validator, written as custom
properties by the same code that writes the App's own.

A save drops the deployment's shared cache entry (Valkey where configured), so
every instance serves the new brand on its next page. The shell receives it
with the App's payload, before the page is revealed; a mapped host's public
pages (sign-in, the landing, a public form) carry it in their head. The logo
box is a fixed 96×24, so nothing moves when it arrives. The tab title and
favicon follow. The mail link page wears the tenant's name, logo and accent
(the logo the one image its policy admits); an App's own messages may say
`{brand.name}`, `{brand.logo}` and `{brand.accent}`, filled per tenant like
`{link}`. The platform realm keeps the App's own brand; a support operator
sees the tenant's, under a "viewing as the provider" marker.

## Precedence And Lifetime

One function ranks the themes a page could wear (`resolveTheme`,
`packages/engine/src/shared/themeResolve.ts`), read by the server where it projects an App
for a principal and guesses a first paint, by grade, and by tenant branding:

1. A page a signed-out visitor sees — the landing, sign-in, a public form or
   view — wears `ui.theme.for.public` where the App names one, whatever the
   reader once picked: a storefront is the same page for everyone, so it can
   be cached.
2. Otherwise an explicit reader-selected theme wins.
3. Otherwise the first `ui.theme.for.roles` entry, in the order it is
   written, whose role the account holds: a portal's look is the App's
   design (`for: { roles: { rider: 'cadence', mechanic: 'workshop' } }`).
4. Otherwise the tenant's saved theme (`branding`, its `preset`).
5. Otherwise the App's `ui.theme.preset`, when it names a theme the App
   offers; otherwise Lumen. The database browser, and an App's Workbench,
   wear none of the looks: their own tokens (style.css), whatever was picked.

Each id is taken only where the App offers it, so a theme removed since a
pick was saved falls to the next rank. A role's or the public's theme is
handed to the browser as the preset it wears; `ui.theme.palette` goes with it
when it names another theme, and the App's `accent`, `radius` and `font` stay
over it. In a tenant App the tenant's accent, name, logo, corner and density
lay over whichever theme an audience wears, and a save is refused when its
accent cannot be read on any of them (the refusal names that theme).
`check` refuses an audience naming a theme the App does not offer or a role
it does not declare (`theme-audience`); `grade` grades each role's row, and
the signed-out one, in the theme it wears unless `--theme` names one.

A custom definition inherits its base style and overrides supplied roles,
and explicit Mono/Sans data typography wins over the theme's data font.

`ui.theme` also takes tokens, `{ accent, radius, font }`, which dress
whichever look is in force and win over its own accent, radius and font (the
accent colours the first chart series too, and the soft tint derives from it),
except that Mono stays square. One accent is authored for the light ground and
mixed toward white on the dark one; `accent: { light, dark }` gives each ground
its own, worn as written. When
using `ui.theme.preset`, put additional visual changes in a registered
definition, not alongside the tokens. Explicit custom dark colors are not
lightened again.

Contrast diagnostics resolve inheritance, each named palette, and the App's
accent overrides in that order, using the same override expressions as the
renderer. App-wide overrides are checked against every selectable built-in and
registered look, not only the default. Checks include navigation accents and
text/links on page and hovered-row grounds; warnings remain warnings.
Numeric checks cover hex colors (including alpha), white/black/transparent and
the framework's accent mixes. Selected controls are checked on their composited
accent tint over panel/page grounds, navigation hover/expanded states on their
5%/7% navigation-ink overlays, a dark bar's search captions on their 8%
navigation-ink overlay (every other bar's search is a field in the page's own
ink, read by the page's pairs), and tinted rows on their 4% accent tint. Accent-filled pill tabs check
their page-colored text against the accent fill. Calculations retain
fractional sRGB channels. Other legacy CSS accent forms remain accepted but
receive an explicit unmeasured-color warning. Image URLs supplied as colors and
invalid simple radius literals receive useful diagnostics without new parser
refusals. The bounded radius check recognizes nonnegative lengths/percentages,
multi-value and elliptical forms, and CSS-wide keywords; it diagnoses negative
lengths, nonzero unitless numbers, and unknown bare keywords. Expressions such
as `var()`/`calc()` and unfamiliar syntax remain accepted with an explicit
unchecked-validity warning, not a claim that they are invalid CSS. The
registered-theme `0px`–`8px` limit is not imposed on legacy radii.
Arbitrary CSS expressions, unknown underlying grounds, and other structural
state-specific overrides still require rendered inspection; these diagnostics
are not a complete accessibility audit or a general CSS validator.

Preferences persist per browser origin. Built-in choices remain global; custom
choices are scoped by the stable App ID, not its display name or the theme's
label. Two Apps may offer the same custom theme ID without sharing a reader's
selection. A scoped custom choice wins in that App; choosing a built-in there
clears that App's custom choice and updates the global choice, without deleting
other Apps' custom choices. Selecting the App's default keeps no override.

A saved custom ID is resolved after App load. If that theme is absent, the UI
falls back to the App's preset, then Lumen, without deleting the saved choice;
it returns when the definition is available again. Legacy unscoped custom
choices cannot identify their original App: their stored value is retained but
does not apply to identified Apps until the reader selects that theme once
again. Built-in preferences need no migration. Blocked browser storage still
permits choices for the current tab. Palette preferences retain their existing
separate App-and-theme scope.

### Standalone Workbench

Workbench starts in **Workbench default**, the database browser's native look.
The reader can explicitly select a built-in look in Preferences or Theme lab;
both controls change the real Workbench appearance immediately. Choosing
Workbench default removes the selected look and its tokens, restoring the
native colors, typography and radii. Light, Dark and System are independent
color modes and remain available with every look, including the native default.

Workbench's look is remembered separately from App look choices in this browser
origin. It does not inherit an App's `ui.theme.preset`, custom theme registry,
record branding, accent, font or radius overrides. App branding policy does not
disable Workbench's picker. Different ports are different browser origins, so
an App on port 4880 cannot overwrite preferences on a Workbench on port 4881.

Without a selected look, the data face stays the Workbench code face unless
the reader explicitly chooses Sans. Changing or resetting a look removes tokens
owned by the previous definition, including fonts and field radii.

## Validation And Review

More > Authoring > Theme lab uses shared dropdowns, dialogs, charts, skeletons,
and runtime table/control styles with deterministic sample data. Inputs, error
states, disabled controls, a nested confirmation, and empty/loading views can be
inspected without sending business writes. Theme/color choices here are real
browser preferences, not a separate simulated renderer.

The validator's failures are `mistri check` problems and startup diagnostics
(they do not block a running server from loading). They are not a full accessibility certification:
CSS-inherited/mixed colors, focus outlines,
status colors on their own tints, and every surrounding surface still need rendered review.
`npm run test:tokens` holds the stylesheets to the theme. It serves every sample
App page under four canary themes (`scripts/token-canary.mjs`: one over each
built-in look and one with the recipes only an App's own theme picks), each
role a saturated color no stylesheet would choose, reads every color an element
draws — its words, its ground, each edge and outline, an icon's fill and
stroke — then moves every role to another canary color and reads them again. A
color that did not move is a literal — unless it is exactly one of the tokens
that stand still under every theme on purpose: the photo stage's
(`--lightbox-ground`, `--lightbox-ink`, `--lightbox-line`), since what is drawn
over a photograph is judged against the photo, and the scrims (`--scrim`,
`--scrim-light`), which darken whatever lies under them; one that moved, but not as one role or a
mix of two or three roles with the same weights before and after, is a role
mixed with a literal. Either fails the run, naming the property and the
elements. A component that needs a color it has no role for asks for a role;
it does not write one.

Browser tests cover dark/light behavior, token cleanup, keyboard focus restoration,
and containment at 1440, 1024, 390, and 320 pixels. Font downloads, theme package discovery,
arbitrary CSS plugins, and automatic contrast correction are outside this contract.

Date-only command fields, new-record forms, filters, value/range prompts and an
App record's inline date edits use the shared themed calendar. Typed values stay
in `YYYY-MM-DD` form without a timezone conversion; incomplete or invalid dates
remain editable but cannot be submitted. The calendar supports keyboard
navigation and opens inside its parent dialog, with Escape returning focus to
its trigger. A date and a wall-clock time — a value prompt over a timestamp
column, a tenant's local expiry — is the same calendar with the time kept in its
text (`YYYY-MM-DD HH:MM`, seconds optional): a wall time with no zone, as the
browser's control answered, and a value carrying an offset or `Z` is refused.
The calendar writes only the date part and keeps the time typed; it does not
define daylight-saving transitions. A stored timestamp edited in place on a
record keeps its text box, so an offset is never rewritten as a local time.
