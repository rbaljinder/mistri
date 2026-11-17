/**
 * The built-in looks as authored specs: each look's palettes, faces, shape,
 * density and recipe picks, written by purpose as an App's own theme is.
 * themePresets.ts compiles them into the presets the server and the browser
 * both wear; the builder and the checks are elsewhere, so they stay out of a
 * first paint that needs only the looks.
 */
import type { ThemeBase, ThemeColorsOver, ThemeSpec } from '../../schema/theme.js';
import { LOOK_PALETTES, infoApart, paletteAccent, paletteColors, rehued } from './lookPalettes.js';
import { familyRecipes, recipeParts } from './themeRecipeFamilies.js';

/** The system's own interface face on every machine; nothing is fetched and
    nothing is bundled. A look's identity is its type roles: size, weight and tracking. */
const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const HELVETICA = '"Helvetica Neue", Helvetica, Arial, ui-sans-serif, sans-serif';
/** Lumen's face: Inter, shipped as a sheet of its own (interFace.css) and so
    fetched only by a page set in it, never in the first paint; then Arial
    cut to Inter's measure while it arrives (docs/design.md, Faces). */
export const INTER = `Inter, "Inter Fallback", ${SANS}`;
/** Lumen's heading face: Manrope, for titles, section heads, the App's name and a strip's figures; shipped as a sheet
    of its own (manropeFace.css), fetched only by a page whose headings lead with it, with Arial Bold cut to its measure
    while it arrives. One line to change the look's heading face: `heading:` in Lumen's `font` below. */
const MANROPE = `Manrope, "Manrope Fallback", ${INTER}`;
/** Workshop's faces: Barlow for the interface and data, its semi-condensed bold for titles and labels, shipped with
    a sheet of their own (barlowFace.css) and fetched only by a page set in them; each with Arial cut to its measure
    while it arrives. */
export const BARLOW = `Barlow, "Barlow Fallback", "Helvetica Neue", Arial, sans-serif`;
const BARLOW_CONDENSED = `"Barlow Semi Condensed", "Barlow Semi Condensed Fallback", Barlow, "Arial Narrow", sans-serif`;
/** Ledger's figures and labels: IBM Plex Mono, shipped with Ledger's sheet (ledgerLook.css) and fetched only by a page
    wearing it; the platform's monospace stands in until it arrives. */
const PLEX_MONO = `'IBM Plex Mono', ui-monospace, Menlo, monospace`;
/** A data column's figures in every built-in look (`fonts.figures`, drawn as `--figures`, themeFamilies.css): Plex Mono, with
    the fallback cut to its measure while it arrives. A theme that names a data face and no figures face draws its figures
    in that face, so each built-in that names a data face says this one, and its figures stay as they were. Bloom is
    the exception, on purpose: it leaves this out, and its figures are its sans (its spec says why). */
const FIGURES = `'IBM Plex Mono', 'IBM Plex Mono Fallback', ui-monospace, Menlo, monospace`;
/** Atelier's titles and figures: whichever book serif the machine has. Nothing is shipped for it: a printed page's
    face is the reader's own, and a title in Georgia is still that page. */
const BOOK_SERIF = `"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif`;
/** Graphite's labels: the machine's monospace, as an instrument's engraving is whatever the maker cut. */
const SYSTEM_MONO = `ui-monospace, "SF Mono", Menlo, Consolas, monospace`;

/** A look as written here: its own grounds, neutrals and meaning colors, and the palette (lookPalettes.ts) it wears
    until a reader or the App picks another. The hue's roles are the palette's, so a look never names them. */
type HouseLook = Omit<Extract<ThemeSpec, { extends?: undefined; colors: { light: unknown } }>, 'colors' | 'id' | 'palettes'> & {
  id: ThemeBase;
  colors: { light: ThemeColorsOver; dark: ThemeColorsOver };
  defaultPalette: string;
  /** The look's page is a tint of its hue, so its neutrals turn with the palette worn (lookPalettes.ts `rehued`).
      The word is the palette the colours below are written in, which need not be the one the look wears by default:
      Bloom's are violet's, and it is worn grey until someone picks a hue. */
  tinted?: string;
};

/** A look written over a flagship, as an App's theme is over the look it `extends`: it names the flagship (`over`)
    and says only what differs. Its colours are the exception and are its own, whole: a look's colours go through the
    palettes (withPalettes), never over another look's. */
type VariantLook = Pick<HouseLook, 'id' | 'label' | 'colors' | 'defaultPalette'> &
  Partial<Omit<HouseLook, 'id' | 'label' | 'colors' | 'defaultPalette'>> & { over: ThemeBase };

/** The variant as a look of its own: where it says nothing the flagship's shape, type, pace and recipes stand, merged
    as themeBuild.ts merges a theme over its base (a corner, a face and a role's properties one by one; a family the
    variant says over the flagship's parts, a part it says over its own family). `extends` could not say Mono or Sage
    this way: a theme cannot say a base's type role or rule width back to the platform's, so each would wear its
    flagship's title, heading and section sizes. Ledger says every role it differs in, and so can. */
function variantOf(base: HouseLook, { over: _over, ...own }: VariantLook): HouseLook {
  const roles: Record<string, object> = { ...base.type?.roles };
  for (const [role, said] of Object.entries(own.type?.roles ?? {})) roles[role] = { ...roles[role], ...said };
  const face = (font: NonNullable<HouseLook['type']>['font']) =>
    typeof font === 'string' ? { ui: font, data: font, heading: font } : font;
  const shape = { ...base.shape, ...own.shape };
  for (const key of ['radius', 'border', 'height'] as const)
    if (base.shape?.[key] || own.shape?.[key]) Object.assign(shape, { [key]: { ...base.shape?.[key], ...own.shape?.[key] } });
  return {
    ...base,
    ...own,
    shape,
    type: { ...base.type, ...own.type, font: { ...face(base.type?.font), ...face(own.type?.font) }, roles },
    ...(base.surface || own.surface ? { surface: { ...base.surface, ...own.surface } } : {}),
    recipes: { ...familyRecipes(base.recipes), ...recipeParts(base.recipes), ...familyRecipes(own.recipes), ...recipeParts(own.recipes) },
  } as HouseLook;
}

/** Spec colors over spec colors: a group (`nav`, `status`, `rules`) role by role, a series whole. */
function overColors(base: ThemeColorsOver, top: ThemeColorsOver): ThemeColorsOver {
  return {
    ...base,
    ...top,
    ...(base.nav || top.nav ? { nav: { ...base.nav, ...top.nav } } : {}),
    ...(base.status || top.status ? { status: { ...base.status, ...top.status } } : {}),
    ...(base.rules || top.rules ? { rules: { ...base.rules, ...top.rules } } : {}),
  };
}

/** A look with every palette: its own colors are its default palette's, and each palette is the same hue as it is in
    every other look (scripts/theme-presets.mjs keeps only what a palette changes). */
function withPalettes({ tinted, ...look }: HouseLook): ThemeSpec {
  const series = (mode: 'light' | 'dark') => (look.colors[mode].chart ?? []).filter((color): color is string => typeof color === 'string');
  const named = (id: string) => LOOK_PALETTES.find((palette) => palette.id === id)!;
  /* A tinted look's colours are written in one palette's hue; under any other they turn to that one's. */
  const own = (id: string, mode: 'light' | 'dark') =>
    tinted && id !== tinted
      ? rehued(look.colors[mode], paletteAccent(look.id, named(id), mode), paletteAccent(look.id, named(tinted), mode))
      : look.colors[mode];
  /* What is merely so (`status.info`) is a hue of its own under every palette: a look's blue under Cobalt or Slate, or
     a look that wore the palette's own hue for it, was the accent said twice (infoApart). */
  const worn = (id: string, mode: 'light' | 'dark') =>
    infoApart(overColors(own(id, mode), paletteColors(look.id, named(id), mode, series(mode))), mode);
  return {
    ...look,
    colors: { light: worn(look.defaultPalette, 'light'), dark: worn(look.defaultPalette, 'dark') },
    palettes: LOOK_PALETTES.map((palette) => ({
      id: palette.id,
      label: palette.label,
      light: worn(palette.id, 'light'),
      dark: worn(palette.id, 'dark'),
    })),
  } as ThemeSpec;
}

/** The built-in looks: Workshop, the default an App wears, then Lumen, Mono, Sage, Ledger, Atelier, Graphite and Bloom.
    Each is written as an App would write its own (`defineTheme`,
    packages/engine/schema/theme.d.ts): colours by purpose, a shape, a type and a pick from the
    recipe menu (themeBuild.ts), and built by the same `buildTheme` an App's
    theme goes through once `compileTheme` has checked it. A look the menu
    could not say would extend the menu, never be special-cased. An App's
    theme `extends` one of them, or none (docs/theming.md shows a few that
    extend none). Every look draws its content on a white or near-white
    ground (Sage's white panels on cream are the warm page) and keeps its
    colour for the bar, the accent and the current item; captions take an ink
    darker than the hairlines and still quieter than the text. `lineControl`
    is a form control's edge, at 3:1 on surface, ground and raised (WCAG
    1.4.11): the look's lineStrong where that already clears it, else one step
    toward the ink.

    The title weight (`type.roles.title.weight`) is never past 700: a heavier
    ask resolved a book face to its Black cut, a masthead where a title was
    meant, and broke the record's head. Mono titles at 700; Lumen's and Sage's
    softer titles at 600; Workshop's condensed bold at 700.

    Each wears every palette in lookPalettes.ts; its own colors are its
    default palette's (Workshop's Safety orange, Lumen's Cobalt, Mono's and
    Sage's Ink, which is each one's own ink, Ledger's Emerald, drawn in the
    book's own deep green, Atelier's Safety orange at its rust depth,
    Graphite's Teal), but Bloom, which is written in Violet and worn in Slate (`tinted`, below). */
const WRITTEN: readonly (HouseLook | VariantLook)[] = [
  {
    // The desk as a workbench, ported from a field report's theme, and
    // refreshed in rc.18 so the work sits on white: the warm paper and its
    // grain frame it (the top bar, the menu and one band behind a page's
    // head: a list's title, tabs and filters, a record's trail, name and
    // facts), as a sheet is clipped to a board, and rows, fields and cards
    // stay white. Ink-black type and one restrained hue — Safety orange
    // unless a palette says another. The hue reaches only the marks a reader
    // takes for the brand color: the primary verb, filled, with the ink's
    // words on it as a hazard tag prints them (the look's one idea), links
    // and the current tab's rule, a 3px marker beside the menu's current
    // entry (like a tool's slot on a pegboard), the focus ring, a checked
    // box and the first chart series. The current entry is a soft tint of
    // the menu's ink, by day and by night: the brightest thing on a screen
    // is the orange verb, never the menu. Barlow's semi-condensed bold sets
    // the titles, in sentence case, a stat's figures and the App's name, the
    // one word in capitals (the brand's stamp); sections, tabs, column heads
    // and labels are Barlow in sentence case, the labels in the muted ink.
    // Hairlines part the sections and close a table's heads, corners are
    // near-square and nothing floats (workshopLook.css; docs/design.md,
    // Workshop).
    id: 'workshop',
    label: 'Workshop',
    defaultPalette: 'safety',
    colors: {
      light: {
        // White to work on; the paper (#f2ede3) is the frame's: the menu, the bar and the band behind a page's head,
        // which is the raised ground (recipes.header 'band'), so a hovered row is the paper too.
        ground: '#fbfaf7',
        surface: '#ffffff',
        raised: '#f2ede3',
        ink: '#1b1813',
        inkMuted: '#4f483d',
        inkSubtle: '#5f574b',
        line: '#e6e1d8',
        lineStrong: '#8b8274',
        lineControl: '#7d7466',
        accentInk: '#1b1813',
        accentSoft: '#e7dfd0',
        primary: '#1b1813',
        link: '#1b1813',
        shadow: '#3a3020',
        status: { good: '#106b38', warning: '#934a06', critical: '#c52a2a', info: '#2f5578' },
        nav: {
          ground: '#f2ede3',
          ink: '#1b1813',
          muted: '#4f483d',
          line: '#d8cfbe',
          accent: '#1b1813',
          // The current entry: the ink at 7% over the paper, in the ink, its orange slot kept (workshopLook.css).
          current: '#e3ded4',
          onCurrent: '#1b1813',
        },
        // Hairlines, not 2px of ink: a section and a table's heads stand on the rule a row does.
        rules: { section: '#e6e1d8', head: '#e6e1d8' },
        chart: ['#2b2620', '#9a6cf7', '#0e9a6c', '#d97706', '#e0428a', '#0e8fb0', '#a3510b', '#94a3b8'],
      },
      dark: {
        ground: '#121110',
        surface: '#1a1917',
        raised: '#24221f',
        ink: '#efe9de',
        inkMuted: '#c2b9aa',
        inkSubtle: '#a59c8d',
        line: '#2c2a26',
        lineStrong: '#6d6555',
        lineControl: '#7a7262',
        accentInk: '#efe9de',
        accentSoft: '#2a2723',
        primary: '#efe9de',
        link: '#efe9de',
        status: { good: '#4ade80', warning: '#fbbf24', critical: '#f87171', info: '#91a8ff' },
        nav: {
          ground: '#0f0e0d',
          ink: '#efe9de',
          muted: '#b3aa9b',
          line: '#24221f',
          accent: '#efe9de',
          // The ink at 10% over the menu's ground, not the inverted cream block, which was the brightest thing on a
          // screen at night.
          current: '#252422',
          onCurrent: '#efe9de',
        },
        rules: { section: '#2c2a26', head: '#2c2a26' },
        chart: ['#d9d0c0', '#9a78ec', '#12a678', '#c88317', '#e0559b', '#1597b9', '#d26b3b', '#6b7694'],
      },
    },
    shape: {
      radius: { control: '2px', field: '2px', pill: '2px', panel: '2px' },
      elevation: 'flat',
      border: { panel: '1px', rule: '1px' },
    },
    type: {
      font: { ui: BARLOW, data: BARLOW, heading: BARLOW_CONDENSED, figures: FIGURES },
      base: '14px',
      roles: {
        // A page still names itself in the workshop's voice, the condensed bold, in sentence case.
        title: { face: 'heading', size: '28px', weight: 700, case: 'none', tracking: '0em', leading: 1.15 },
        heading: { face: 'heading', size: '23px', weight: 700, case: 'none', tracking: '0em' },
        section: { face: 'ui', size: '15px', weight: 600, case: 'none', tracking: '0em' },
        // A step under the base, in the semibold the look already ships: Barlow comes at 400 and 600 only, so a 500
        // drew at 400, as loud as the values under it. The muted ink (parts below) keeps the 600 quieter than a value.
        label: { face: 'ui', size: '12px', weight: 600, case: 'none', tracking: '0em' },
        data: { features: ['tnum'] },
        figure: { face: 'heading', size: '38px', weight: 700, features: ['tnum'] },
        nav: { weight: 500 },
      },
    },
    surface: { nav: { kind: 'grain' } },
    // Compact, as the other looks: see Mono's density.
    density: 'compact',
    rhythm: 'house',
    recipes: {
      // Everything open on the white sheet: one divided strip of figures, not a 2px ink rule over each.
      blocks: 'open',
      // The current one is a block of the ink: the window filled, the menu's entry with its slot beside it, and a
      // record's tabs apart, on a rule in the hue.
      current: 'inverted',
      nav: 'slot',
      tabs: 'rule',
      bar: 'ruled',
      buttons: 'keyed',
      // A filter not yet asked for is a key on a solid edge, as the search beside it is, not a dashed place.
      filters: 'solid',
      rules: 'hairline',
      banner: 'plain',
      lanes: 'tag',
      // The paper under a page's head: the frame reaches the title, tabs and filters, and the rows start on white.
      header: 'band',
    },
  },
  {
    // Flat, calm and modern, with character in its details: a warm, faintly
    // tinted shell around white working surfaces, elevation only on what
    // floats, one confident accent for the primary action, the current room,
    // selection, focus, the main chart series and the current step; metrics
    // in a divided strip, fields in a property rail, tables on hairlines
    // anchored on the record's name, statuses as a dot and their word, a
    // workflow as a track of segments, charts as a line in one hue's steps
    // (lumenLook.css; docs/design.md, Lumen, for its exceptions). The chart
    // palette keeps blue, violet, green, amber and pink at steps the dataviz
    // checks pass, light and dark. Inter, shipped with the look. Its own
    // blue is Cobalt; every other palette changes the accent family only —
    // grounds, ink and structure stay Lumen's.
    id: 'lumen',
    label: 'Lumen',
    defaultPalette: 'cobalt',
    colors: {
      light: {
        ground: '#ffffff',
        surface: '#ffffff',
        raised: '#f5f4f2',
        ink: '#1c1a17',
        inkMuted: '#5c5852',
        inkSubtle: '#726c64',
        line: '#ebe8e4',
        lineStrong: '#8f8a83',
        lineControl: '#8f8a83',
        primary: '#1c1a17',
        onPrimary: '#ffffff',
        status: {
          good: '#127a40',
          warning: '#a65308',
          critical: '#c52a2a',
          info: '#2d4fd6',
        },
        nav: {
          ground: '#fbfaf9',
          ink: '#1c1a17',
          muted: '#5c5852',
          line: '#ebe8e4',
        },
        rules: {
          section: '#ebe8e4',
          head: '#ebe8e4',
        },
        chart: ['#2557e0', '#9a6cf7', '#0e9a6c', '#d97706', '#e0428a', '#0e8fb0', '#a3510b', '#94a3b8'],
      },
      dark: {
        ground: '#121110',
        surface: '#161514',
        raised: '#201f1d',
        ink: '#eeece8',
        inkMuted: '#b8b3ab',
        inkSubtle: '#9f9a92',
        line: '#2d2b27',
        lineStrong: '#726d65',
        lineControl: '#726d65',
        primary: '#eeece8',
        onPrimary: '#121110',
        status: {
          good: '#4ade80',
          warning: '#fbbf24',
          critical: '#f87171',
          info: '#91a8ff',
        },
        nav: {
          ground: '#141312',
          ink: '#eeece8',
          muted: '#aaa59d',
          line: '#262422',
        },
        rules: {
          section: '#2d2b27',
          head: '#2d2b27',
        },
        chart: ['#3559e6', '#9a78ec', '#12a678', '#c88317', '#e0559b', '#1597b9', '#d26b3b', '#6b7694'],
      },
    },
    /* `pill` is said in every look: an App's stylesheet may read var(--pill-radius) (check accepts it), and a look that left it
       unsaid gave that rule no value and square corners. Round is what the sheets draw a tag as already. */
    shape: { radius: { control: '8px', field: '8px', pill: 'round' }, elevation: 'raised', border: { rule: '1px' } },
    /* The page's name anchors it: 28px, tight; a list's name a step under, and a section's heading 16px, so the
       page reads title, section, row at a glance. On a flat page the type is the hierarchy the boxes used to be. */
    type: {
      font: { ui: INTER, data: INTER, heading: MANROPE, figures: FIGURES },
      roles: {
        /* Manrope draws lighter than Inter at a given weight: a title at 600 read as a line of text, so the heading
           roles stand a step heavier than they did in Inter, to the presence they had. */
        title: { size: '28px', weight: 700, tracking: '-0.02em' },
        heading: { size: '24px', weight: 700, tracking: '-0.018em' },
        section: { size: '16px', weight: 600, tracking: '-0.01em' },
      },
    },
    density: 'compact',
    recipes: {
      // Open on the white surface, with two of its own: a record's fields in a property rail, a table of quiet rows.
      blocks: 'open',
      fields: 'rail',
      table: 'quiet',
      // Pills in the menu and a raised key on the windows' tray; a record's tabs apart, underlined on a hairline.
      current: 'pill',
      tabs: 'underline',
      bar: 'airy',
      status: 'quiet',
      board: 'strip',
      chart: 'line',
      buttons: 'raised',
      filters: 'quiet',
      rules: 'hairline',
      avatar: 'round',
      banner: 'plain',
    },
  },
  {
    // Black and white, and structure: square corners, rules in the ink over
    // grey hairlines, stat figures and labels in a monospace
    // (themeFamilies.css), the current tab inverted, colour left to status.
    // Data stays in the sans, as in every look.
    id: 'mono',
    label: 'Mono',
    defaultPalette: 'ink',
    colors: {
      light: {
        ground: '#ffffff',
        surface: '#ffffff',
        raised: '#f2f2f2',
        ink: '#000000',
        inkMuted: '#333333',
        inkSubtle: '#555555',
        line: '#d4d4d4',
        lineStrong: '#000000',
        lineControl: '#000000',
        accentSoft: '#ebebeb',
        status: {
          good: '#0a6b3a',
          warning: '#7a5200',
          critical: '#b3261e',
          info: '#0a4fc2',
        },
        nav: {
          ground: '#ffffff',
          ink: '#000000',
          muted: '#333333',
          line: '#000000',
        },
        chart: ['#000000', '#6b6b6b', '#333333', '#8e8e8e', '#505050', '#a8a8a8', '#1c1c1c', '#c8c8c8'],
      },
      dark: {
        ground: '#000000',
        surface: '#0a0a0a',
        raised: '#161616',
        ink: '#ffffff',
        inkMuted: '#d0d0d0',
        inkSubtle: '#a8a8a8',
        line: '#3a3a3a',
        lineStrong: '#ffffff',
        lineControl: '#ffffff',
        accentSoft: '#262626',
        status: {
          good: '#6fdc9c',
          warning: '#f2c94c',
          critical: '#ff8a80',
          info: '#8fb8ff',
        },
        nav: {
          ground: '#000000',
          ink: '#ffffff',
          muted: '#bdbdbd',
          line: '#ffffff',
        },
        chart: ['#ffffff', '#8a8a8a', '#cccccc', '#6a6a6a', '#a8a8a8', '#4a4a4a', '#e6e6e6', '#333333'],
      },
    },
    shape: { radius: { control: '0px', field: '0px', pill: 'round' }, elevation: 'flat' },
    /* Figures and the labels that make the look in the platform's monospace, the labels and the bar's entries in
       capitals: not data, which a reader who wants monospace picks in Preferences. */
    type: {
      font: { ui: HELVETICA, data: HELVETICA, heading: HELVETICA, figures: FIGURES },
      roles: {
        title: { size: '30px', weight: 700 },
        label: { face: 'code', case: 'upper' },
        nav: { face: 'code', case: 'upper' },
        figure: { face: 'code', weight: 700 },
      },
    },
    /* Compact, as Lumen: these looks' comfortable cut zooms by 1.12, and a wide list (Lintel's rent roll at a 1280px
       desk) then overflowed sideways. A reader's own density still wins. */
    density: 'compact',
    /* Open, and the current one inverted wherever it is; a figure framed in the ink, and a breakdown's steps as the
       hairline cards the plain structure draws. */
    recipes: { blocks: 'open', current: 'inverted', stat: 'framed', steps: 'flat', bar: 'ruled', links: 'underline' },
  },
  {
    // A soft workspace, recreated as it is from a reference the maintainer
    // chose: warm cream grounds with the content on white panels (a soft
    // shadow, a larger radius), near-black ink for text and calls to action,
    // sage green for the charts and good news, a warm tint for what is chosen
    // and meaning in soft tinted pills (sageLook.css; docs/design.md,
    // Sage, for its exceptions). The one look whose content ground is warm.
    id: 'sage',
    label: 'Sage',
    defaultPalette: 'ink',
    colors: {
      light: {
        ground: '#f4f2ec',
        surface: '#fdfcf9',
        raised: '#efece5',
        ink: '#1f2320',
        inkMuted: '#484d48',
        inkSubtle: '#5d625c',
        line: '#e6e2d8',
        lineStrong: '#837e72',
        lineControl: '#837e72',
        accentSoft: '#ebe8df',
        status: {
          good: '#23784a',
          warning: '#8f5800',
          critical: '#b83a2c',
          info: '#2f5fa3',
        },
        /* The menu is a panel on the cream page, as a section is: white beside the
           page, and a bar that holds the menu (placement top) white above it. */
        nav: {
          ground: '#fdfcf9',
          ink: '#1f2320',
          muted: '#565b55',
          line: '#e6e2d8',
        },
        // Ordered so neighbors differ for a red-green reader too (themeCheck.ts), and with one green among the
        // first four: a second green and a teal there made a five-way breakdown read as three. The dark series
        // are the same hues in the same order, so a series keeps its color across modes.
        chart: ['#3a8560', '#7b61c4', '#c4573f', '#b25c8c', '#a8781f', '#2f8f89', '#3f76c2', '#8a8578'],
      },
      dark: {
        ground: '#141613',
        surface: '#1b1e1a',
        raised: '#242822',
        ink: '#f1f0ea',
        inkMuted: '#cdcbc2',
        inkSubtle: '#aaa89f',
        line: '#323630',
        lineStrong: '#7d8277',
        lineControl: '#7d8277',
        accentSoft: '#2a2d27',
        status: {
          good: '#72d59c',
          warning: '#efc26a',
          critical: '#f28d7f',
          info: '#92b8f2',
        },
        nav: {
          ground: '#1b1e1a',
          ink: '#f1f0ea',
          muted: '#aaa89f',
          line: '#2a2e28',
        },
        chart: ['#7fd1a0', '#c4b1f2', '#f2a08a', '#f08cc4', '#ecc36e', '#6fd1c8', '#92b8f2', '#8c887f'],
      },
    },
    shape: { radius: { control: '8px', field: '8px', pill: 'round' }, elevation: 'soft' },
    type: { font: { ui: SANS, data: SANS, heading: SANS, figures: FIGURES }, roles: { title: { weight: 600 } } },
    // Compact, as Mono and Lumen: see Mono's density.
    density: 'compact',
    // Airy between its panels: a page read by the person it is about wants room round each thing, where a desk's
    // look packs them. The rows keep the compact density.
    rhythm: 'airy',
    recipes: {
      // White panels on the cream page, whatever is in them.
      blocks: 'panel',
      // What is chosen sits on the warm tint; the menu's entry is quieter still, shaded in its ink.
      current: 'tint',
      nav: 'quiet',
      bar: 'soft',
      status: 'pill',
      board: 'soft',
      chart: 'wash',
      rules: 'hairline',
      avatar: 'large',
      // The head stands on one band of the surface, as its cards do on the warm ground.
      header: 'band',
    },
  },
  {
    // A bookkeeper's desk, ported from a field report's theme (it extended
    // Lumen; here it stands alone): every figure, id, date and label in a
    // monospace (IBM Plex Mono) so numbers line up down a page, with prose and
    // titles left in Inter. Green-tinted paper under a faint graph-paper
    // ground, field groups and dashboard sections as square ruled boxes in the
    // strong line, a table's column heads closed with a double rule as a
    // ledger closes a total (ledgerLook.css), and one deep ledger green for
    // the book's cover (the menu), the primary verb and links, with a gilt
    // mark for the current entry. By night the cover goes near-black green and
    // the same green is lifted to a mint that reads on it. A palette moves the
    // hue the reader's marks are drawn in (accent, links, the ring, the rules,
    // the first series) and leaves the paper and the cover the book's own.
    // Written over Lumen, as the report's theme was: Lumen's Inter for prose and titles, its hairline rule and its
    // compact cut stand, and the book says its own corners, its monospace, its paper and where its blocks differ.
    over: 'lumen',
    id: 'ledger',
    label: 'Ledger',
    defaultPalette: 'emerald',
    colors: {
      light: {
        ground: '#eef2ec',
        surface: '#fcfdfb',
        raised: '#eaf0ea',
        ink: '#0f1a14',
        inkMuted: '#44524a',
        inkSubtle: '#52605a',
        line: '#d3ddd5',
        lineStrong: '#7f8f85',
        lineControl: '#748479',
        onAccent: '#ffffff',
        accentInk: '#0f4d36',
        primary: '#0f4d36',
        status: { good: '#127a40', warning: '#a65308', critical: '#c52a2a', info: '#2d4fd6' },
        nav: {
          ground: '#103d2c',
          ink: '#e6efe9',
          muted: '#a9c2b4',
          line: '#1d4d3b',
          accent: '#e4cf8f',
          current: '#1c5640',
          onCurrent: '#ffffff',
        },
        rules: { section: '#0f4d36', head: '#0f4d36' },
        chart: ['#0f6b4a', '#9a6cf7', '#0e9a6c', '#d97706', '#e0428a', '#0e8fb0', '#a3510b', '#94a3b8'],
      },
      dark: {
        ground: '#0b1310',
        surface: '#111c17',
        raised: '#18251f',
        ink: '#e3ece6',
        inkMuted: '#afc0b6',
        inkSubtle: '#93a59a',
        line: '#1c2a23',
        lineStrong: '#587064',
        lineControl: '#66806f',
        onAccent: '#0b1310',
        accentInk: '#8fd1ae',
        primary: '#7cc4a0',
        status: { good: '#4ade80', warning: '#fbbf24', critical: '#f87171', info: '#91a8ff' },
        nav: {
          ground: '#08100c',
          ink: '#dfe9e3',
          muted: '#9fb3a7',
          line: '#18261f',
          accent: '#e0cd94',
          current: '#163a2b',
          onCurrent: '#ffffff',
        },
        rules: { section: '#6fb592', head: '#6fb592' },
        chart: ['#5fbf92', '#9a78ec', '#12a678', '#c88317', '#e0559b', '#1597b9', '#d26b3b', '#6b7694'],
      },
    },
    shape: {
      radius: { control: '2px', field: '0px', pill: '2px', panel: '0px' },
      elevation: 'flat',
      border: { panel: '1px' },
    },
    type: {
      font: { data: PLEX_MONO },
      roles: {
        title: { size: '26px', tracking: '-0.01em' },
        heading: { size: '20px', weight: 600 },
        section: { face: 'data', size: '12px', weight: 500, case: 'upper', tracking: '0.08em' },
        label: { face: 'data', weight: 500, case: 'upper', tracking: '0.04em' },
        data: { features: ['tnum', 'zero'] },
        figure: { face: 'data', size: '30px', weight: 500, tracking: '-0.02em', features: ['tnum', 'zero'] },
        nav: { face: 'ui', weight: 400 },
      },
    },
    surface: { ground: { kind: 'grid' } },
    // Tight between its boxes: a bookkeeper's page holds more rows of figures to the screen than a reader's does.
    rhythm: 'tight',
    recipes: {
      // Ruled boxes on the paper; the figures apart, one divided strip, and a breakdown's steps one strip too.
      blocks: 'panel',
      stat: 'divided',
      // A ledger's rows are banded, every other one on the raised ground, so an amount is followed across a wide page.
      table: 'banded',
      steps: 'strip',
      // The current one inverted, as a filled window is; the cover's entry on a wash of the gilt, tabs on a rule.
      current: 'inverted',
      nav: 'wash',
      tabs: 'rule',
      bar: 'dark',
      board: 'ruled',
      chart: 'plain',
      buttons: 'accent',
      rules: 'double',
      avatar: 'plain',
      lanes: 'plain',
      filters: 'solid',
    },
  },
  {
    // A printed page. Warm paper, the machine's book serif for a page's name, its headings and a figure, a section
    // named in small tracked capitals over a rule in the ink, a column's heads in the same capitals, and white
    // space where another look would draw a box: nothing is a card, nothing floats, a table is its rows. The one
    // hue is a printer's second colour, rust unless a palette says another, and it reaches links (underlined, as on
    // paper), the current tab's rule, the ring, the first series and the wash under what is chosen; the paper is
    // the look's under every palette, and the one primary button is the ink wherever it stands. For what is read
    // more than it is worked: a client's portal, a report, a catalogue. No face is shipped: the serif is whichever
    // book face the machine has, and the page and its tables are set in its interface face. Its air is its large
    // title, its open sections and the airy rhythm: a page's blocks stand a quarter further apart, as a printed
    // page's do.
    id: 'atelier',
    label: 'Atelier',
    defaultPalette: 'safety',
    colors: {
      light: {
        ground: '#f6f3ee',
        surface: '#fffdf8',
        raised: '#f0ece4',
        ink: '#1d1a16',
        inkMuted: '#57514a',
        inkSubtle: '#6a6359',
        line: '#e4dfd4',
        lineStrong: '#aba391',
        lineControl: '#8a8372',
        primary: '#1d1a16',
        onPrimary: '#fffdf8',
        status: { good: '#2c6a46', warning: '#855600', critical: '#b3261e', info: '#2b5fa8' },
        /* The menu is the page's own margin: the paper, with no edge of its own colour. Its current entry is
           shaded, not coloured: the one hue is the links' and a figure's in trouble. */
        nav: { ground: '#f6f3ee', ink: '#1d1a16', muted: '#57514a', line: '#e4dfd4', current: '#e9e4da', onCurrent: '#1d1a16' },
        chart: ['#b4472a', '#2b5fa8', '#2c6a46', '#8a6d1f', '#7b4a8c', '#2f7f86', '#a3510b', '#8a8578'],
      },
      dark: {
        ground: '#141210',
        surface: '#1b1815',
        raised: '#25211d',
        ink: '#f1ece4',
        inkMuted: '#b8b0a4',
        inkSubtle: '#9a9286',
        line: '#2e2a25',
        lineStrong: '#5a544b',
        lineControl: '#7f786d',
        primary: '#f1ece4',
        onPrimary: '#141210',
        status: { good: '#6fc08f', warning: '#e0b055', critical: '#f08a80', info: '#86b4f0' },
        nav: { ground: '#141210', ink: '#f1ece4', muted: '#b8b0a4', line: '#2e2a25', current: '#25211d', onCurrent: '#f1ece4' },
        chart: ['#e2896b', '#86b4f0', '#6fc08f', '#d8b65c', '#c79ad6', '#6fc7cf', '#d99a5b', '#8c887f'],
      },
    },
    shape: { radius: { control: '4px', field: '4px', pill: '4px', panel: '6px' }, elevation: 'flat' },
    type: {
      /* No figures face: a date, a phone number and an amount in a table are set in the text's own face, their
         digits lining and a column wide (themeFamilies.css), as a printed table's are. The serif is the title's
         and the large figure's. */
      font: { ui: SANS, data: SANS, heading: BOOK_SERIF },
      roles: {
        title: { face: 'heading', size: '30px', weight: 400, tracking: '-0.01em' },
        // A list's name is a chapter's: the serif, a step under the page's own title.
        heading: { face: 'heading', size: '26px', weight: 400, tracking: '-0.01em' },
        // A section's name is a small tracked line over a rule, as a chapter's running head is.
        section: { face: 'ui', size: '12px', weight: 600, case: 'upper', tracking: '0.09em' },
        // A column's head and a figure's label are written as a sentence is, quiet: the section's line is the one
        // set in capitals, and a page of capital heads over capital labels read as a form, not a printed page.
        figure: { face: 'heading', size: '34px', weight: 400, tracking: '-0.01em', features: ['lnum'] },
      },
    },
    // Compact, as the other looks: see Mono's density. The rhythm is the page's air, not the rows'.
    density: 'compact',
    rhythm: 'airy',
    recipes: {
      // A printed page: blocks open under rules, a record's side groups captioned between hairlines. A figure is
      // open with no rule of its own (four ink rules over four figures were the heaviest thing on a list), and a
      // table is open on the paper, its head row over the one rule in the ink.
      blocks: 'ruled',
      stat: 'plain',
      table: 'open',
      // What is chosen sits on a tint; the menu's entry shaded in its ink, a record's tabs on a rule.
      current: 'tint',
      nav: 'quiet',
      tabs: 'rule',
      status: 'quiet',
      chart: 'line',
      // A row is opened by its name, underlined as an index's entry is; what it refers to reads as text.
      links: 'name',
      banner: 'plain',
      lanes: 'plain',
      // No band behind a page's head: a title large on the paper, as a dashboard's greeting already is.
      filters: 'quiet',
      required: 'optional-word',
      formStep: 'ruled',
    },
  },
  {
    // An instrument. Cool greys under a white page, a near-black menu beside it by day and by night, labels and
    // section names in tracked monospace capitals, tabs in a sunken track with the chosen one lifted out of it,
    // rows that tint under the pointer and statuses as dotted pills. One signal colour, cyan unless a palette says
    // another: on the page at the depth that reads as text, on the dark menu at its bright night depth. Tight and
    // compact, for people who are in it all day: operations, finance, support. The monospace is the machine's own,
    // and it is for labels and readings (a dashboard's figures, a record's leading ones): a table's dates, amounts
    // and counts are the sans with digits a column wide, so a row is read in one face. Its greys are its own under
    // every palette, and its one primary is the ink.
    id: 'graphite',
    label: 'Graphite',
    defaultPalette: 'teal',
    colors: {
      light: {
        ground: '#f1f3f5',
        surface: '#ffffff',
        raised: '#eceef1',
        ink: '#0f1216',
        inkMuted: '#474e58',
        inkSubtle: '#5c646f',
        line: '#e1e4e8',
        lineStrong: '#9aa1ab',
        lineControl: '#78808c',
        primary: '#0f1216',
        onPrimary: '#ffffff',
        status: { good: '#16714a', warning: '#8a5700', critical: '#bb2a2a', info: '#2459b8' },
        nav: { ground: '#0f1216', ink: '#e6e9ee', muted: '#a3abb7', line: '#232830', current: '#1c222b', onCurrent: '#ffffff' },
        /* Hairlines throughout, as Lumen: the cards carry the structure, not a rule in the ink. */
        rules: { section: '#e1e4e8', head: '#e1e4e8' },
        chart: ['#0e8fb0', '#9a6cf7', '#0e9a6c', '#d97706', '#e0428a', '#2557e0', '#a3510b', '#94a3b8'],
      },
      dark: {
        ground: '#0b0d10',
        surface: '#111418',
        raised: '#191d23',
        ink: '#eef1f5',
        inkMuted: '#aab2be',
        inkSubtle: '#8c95a2',
        line: '#232830',
        lineStrong: '#4a525e',
        lineControl: '#727b88',
        primary: '#eef1f5',
        onPrimary: '#0b0d10',
        status: { good: '#5fcf98', warning: '#e2b04e', critical: '#ff8a80', info: '#8ab4ff' },
        nav: { ground: '#07090b', ink: '#e6e9ee', muted: '#a3abb7', line: '#1c2128', current: '#171c23', onCurrent: '#ffffff' },
        rules: { section: '#232830', head: '#232830' },
        chart: ['#1597b9', '#9a78ec', '#12a678', '#c88317', '#e0559b', '#3559e6', '#d26b3b', '#6b7694'],
      },
    },
    shape: { radius: { control: '6px', field: '6px', pill: '4px', panel: '8px' }, elevation: 'hairline', border: { rule: '1px' } },
    type: {
      font: { ui: SANS, data: SANS, heading: SANS, code: SYSTEM_MONO },
      roles: {
        title: { weight: 600, tracking: '-0.015em' },
        section: { face: 'code', size: '12px', weight: 600, case: 'upper', tracking: '0.06em' },
        // Tracked a little, not much: a column's head is a label too, and at 0.06em seven of them took the room a
        // phone number needs to stay on one line.
        label: { face: 'code', size: '11px', weight: 500, case: 'upper', tracking: '0.06em' },
        data: { features: ['tnum'] },
        figure: { face: 'code', weight: 500, tracking: '-0.02em', features: ['tnum', 'zero'] },
      },
    },
    density: 'compact',
    rhythm: 'tight',
    recipes: {
      // Everything a hairline card: a figure like the sections under it (framed in the ink it outweighed them), a
      // list with its rows tinting under the pointer. A breakdown's steps apart, one strip of figures.
      blocks: 'card',
      steps: 'strip',
      // A record's tabs are keys lifted out of a track; the menu's entry a slot, the window a filled segment.
      current: 'lifted',
      nav: 'slot',
      windows: 'segmented',
      // The bar is the menu's ground, near-black by day: its search and its keys are drawn on it, not as the page's.
      bar: 'dark',
      status: 'pill-dot',
      board: 'strip',
      chart: 'gradient',
      rules: 'hairline',
      workflow: 'pills',
      banner: 'plain',
      lanes: 'tag',
      filters: 'solid',
      formStep: 'ruled',
    },
  },
  {
    // Soft and round. A ground in the palette's faintest tint with everything on it a white tile: the menu a card
    // standing off the window's edge, a dashboard's figures as tiles with a large figure, a list one tile with its
    // rows ruled apart, sections as panels under a soft shadow. Buttons and tabs are pills and the primary one is
    // the hue itself: a slate grey until a palette says another. Friendly, for a product people meet now and then:
    // bookings, a members' area, onboarding.
    id: 'bloom',
    label: 'Bloom',
    /* Worn grey until a hue is picked: the shape is the look, and a lavender page under an App whose brand is
       another colour read as the look's choice, not the App's. The colours below are written in Violet, which is
       one pick away: the lavender page, the lilac hairlines and the plum ink are violet's, and under Emerald they
       are emerald's. */
    defaultPalette: 'slate',
    tinted: 'violet',
    colors: {
      light: {
        ground: '#f4f1fb',
        surface: '#ffffff',
        /* A field is a white tile too, on the tinted page as on a panel. */
        field: '#ffffff',
        raised: '#f1edf9',
        ink: '#1c1730',
        inkMuted: '#544c6e',
        inkSubtle: '#665e82',
        line: '#e6e0f2',
        lineStrong: '#b3a8cc',
        /* A field's edge at the least a control's may be (3:1 on the tint and on a raised tile): beside pills and
           soft tiles a darker line made every field the heaviest thing on its form. */
        lineControl: '#8a7fa8',
        status: { good: '#1c7550', warning: '#875600', critical: '#c0263b', info: '#2f62c9' },
        /* The menu is a white card on the tinted page. */
        nav: { ground: '#ffffff', ink: '#1c1730', muted: '#544c6e', line: '#e6e0f2' },
        /* Hairlines throughout: a tile's edge is its shape, and a rule in the ink across one would cut it. */
        rules: { section: '#e6e0f2', head: '#e6e0f2' },
        chart: ['#9a6cf7', '#0e9a6c', '#d97706', '#e0428a', '#0e8fb0', '#2557e0', '#a3510b', '#94a3b8'],
      },
      dark: {
        ground: '#110e1c',
        surface: '#191527',
        field: '#191527',
        raised: '#221d33',
        ink: '#f0ecfb',
        inkMuted: '#b9b0d2',
        inkSubtle: '#9a91b6',
        line: '#2c2640',
        lineStrong: '#584d7a',
        lineControl: '#8176a3',
        status: { good: '#6fd0a0', warning: '#e6b458', critical: '#ff8f9d', info: '#8fb5ff' },
        nav: { ground: '#191527', ink: '#f0ecfb', muted: '#b9b0d2', line: '#2c2640' },
        rules: { section: '#2c2640', head: '#2c2640' },
        chart: ['#9a78ec', '#12a678', '#c88317', '#e0559b', '#1597b9', '#3559e6', '#d26b3b', '#6b7694'],
      },
    },
    shape: { radius: { control: 'round', field: '12px', pill: 'round', panel: '20px' }, elevation: 'soft', border: { rule: '1px' } },
    type: {
      /* No figures face of its own: a date, a phone number and an amount are set in the look's sans, their digits
         a column wide (themeFamilies.css). A monospace column is an instrument's, and nothing here is one. */
      font: { ui: SANS, data: SANS, heading: SANS },
      roles: {
        // A page names itself large: the greeting on a dashboard is the one generous line on it.
        title: { size: '30px', weight: 700, tracking: '-0.02em' },
        section: { size: '16px', weight: 600, tracking: '-0.01em' },
        figure: { size: '32px', weight: 700, tracking: '-0.03em' },
      },
    },
    // Compact, as the other looks: see Mono's density. Airy between its tiles: soft boxes with generous corners
    // crowd one another at the house's gaps, and the page is one people meet now and then, not work in all day.
    density: 'compact',
    rhythm: 'airy',
    recipes: {
      // Everything a soft tile: figures, a list (one tile, its rows ruled apart), a breakdown's steps.
      blocks: 'tile',
      // Pills, and a raised key on the windows' tray; the menu itself a card standing off the window's edge.
      current: 'pill',
      nav: 'float',
      bar: 'soft',
      status: 'pill',
      board: 'soft',
      chart: 'wash',
      rules: 'hairline',
      avatar: 'round',
      workflow: 'segments',
      banner: 'gradient',
      filters: 'solid',
      // A form's actions stand on a raised bar, as every other block here is lifted off the tint.
      actionBar: 'raised',
    },
  },
];

/** Each look whole: a variant over the flagship it names, which is written before it. */
const HOUSE: readonly HouseLook[] = WRITTEN.map((look) =>
  'over' in look ? variantOf(WRITTEN.find((flagship) => flagship.id === look.over) as HouseLook, look) : look,
);

export const LOOKS: readonly ThemeSpec[] = HOUSE.map(withPalettes);
