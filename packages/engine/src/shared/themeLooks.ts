/**
 * The built-in looks as authored specs: each look's palettes, faces, shape,
 * density and recipe picks, written by purpose as an App's own theme is.
 * themePresets.ts compiles them into the presets the server and the browser
 * both wear; the builder and the checks are elsewhere, so they stay out of a
 * first paint that needs only the looks.
 */
import type { ThemeBase, ThemeColorsOver, ThemeSpec } from '../../schema/theme.js';
import { LOOK_PALETTES, paletteColors } from './lookPalettes.js';

/** The system's own interface face on every machine; nothing is fetched and
    nothing is bundled. A look's identity is its type roles: size, weight and tracking. */
const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const HELVETICA = '"Helvetica Neue", Helvetica, Arial, ui-sans-serif, sans-serif';
/** Lumen's face: Inter, shipped with Lumen's sheet (lumenLook.css) and so
    fetched only by a page wearing it, never in the first paint; then Arial
    cut to Inter's measure while it arrives (docs/design.md, Faces). */
const INTER = `Inter, "Inter Fallback", ${SANS}`;
/** Workshop's faces: Barlow for the interface and data, its semi-condensed bold for titles and labels, shipped with
    Workshop's sheet (workshopLook.css) and fetched only by a page wearing it; each with Arial cut to its measure
    while it arrives. */
const BARLOW = `Barlow, "Barlow Fallback", "Helvetica Neue", Arial, sans-serif`;
const BARLOW_CONDENSED = `"Barlow Semi Condensed", "Barlow Semi Condensed Fallback", Barlow, "Arial Narrow", sans-serif`;
/** Ledger's figures and labels: IBM Plex Mono, shipped with Ledger's sheet (ledgerLook.css) and fetched only by a page
    wearing it; the platform's monospace stands in until it arrives. */
const PLEX_MONO = `'IBM Plex Mono', ui-monospace, Menlo, monospace`;

/** A look as written here: its own grounds, neutrals and meaning colors, and the palette (lookPalettes.ts) it wears
    until a reader or the App picks another. The hue's roles are the palette's, so a look never names them. */
type HouseLook = Omit<Extract<ThemeSpec, { extends?: undefined; colors: { light: unknown } }>, 'colors' | 'id' | 'palettes'> & {
  id: ThemeBase;
  colors: { light: ThemeColorsOver; dark: ThemeColorsOver };
  defaultPalette: string;
};

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
function withPalettes(look: HouseLook): ThemeSpec {
  const series = (mode: 'light' | 'dark') => (look.colors[mode].chart ?? []).filter((color): color is string => typeof color === 'string');
  const worn = (id: string, mode: 'light' | 'dark') =>
    overColors(
      look.colors[mode],
      paletteColors(
        look.id,
        LOOK_PALETTES.find((palette) => palette.id === id)!,
        mode,
        series(mode),
      ),
    );
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

/** The built-in looks: Workshop, the default an App wears, then Lumen, Mono, Sage and Ledger.
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
    softer titles at 600; Workshop's condensed capitals at 700.

    Each wears every palette in lookPalettes.ts; its own colors are its
    default palette's (Workshop's Safety orange, Lumen's Cobalt, Mono's and
    Sage's Ink, which is each one's own ink, Ledger's Emerald, drawn in the
    book's own deep green). */
const HOUSE: readonly HouseLook[] = [
  {
    // The desk as a workbench, ported from a field report's theme: warm paper,
    // ink-black type and fills, and one restrained hue — Safety orange unless
    // a palette says another. The hue reaches only the marks a reader takes
    // for the brand color: the primary verb (the ink's words on it, as a
    // hazard tag prints them), links and the current tab's rule, a 3px marker
    // beside the menu's ink block (like a tool's slot on a pegboard), the
    // focus ring, a checked box and the first chart series. Fills, rules and
    // selection stay the ink, and nothing is tinted. Titles, section heads
    // and labels are Barlow's semi-condensed bold in capitals, the rest
    // Barlow; heavy 2px ink rules part the sections and stand under a
    // table's heads, corners are near-square and nothing floats; the menu
    // sits on a faint grain (workshopLook.css; docs/design.md, Workshop).
    id: 'workshop',
    label: 'Workshop',
    defaultPalette: 'safety',
    colors: {
      light: {
        ground: '#f2ede3',
        surface: '#faf8f3',
        raised: '#ece6da',
        ink: '#1b1813',
        inkMuted: '#4f483d',
        inkSubtle: '#5f574b',
        line: '#ddd5c6',
        lineStrong: '#8b8274',
        lineControl: '#7d7466',
        accentInk: '#1b1813',
        accentSoft: '#e7dfd0',
        primary: '#1b1813',
        link: '#1b1813',
        shadow: '#3a3020',
        status: { good: '#106b38', warning: '#934a06', critical: '#c52a2a', info: '#2f5578' },
        nav: {
          ground: '#ebe5d9',
          ink: '#1b1813',
          muted: '#4f483d',
          line: '#d8cfbe',
          accent: '#1b1813',
        },
        rules: { section: '#1b1813', head: '#1b1813' },
        chart: ['#2b2620', '#9a6cf7', '#0e9a6c', '#d97706', '#e0428a', '#0e8fb0', '#a3510b', '#94a3b8'],
      },
      dark: {
        ground: '#15130f',
        surface: '#1d1a15',
        raised: '#26221c',
        ink: '#efe9de',
        inkMuted: '#c2b9aa',
        inkSubtle: '#a59c8d',
        line: '#2f2a22',
        lineStrong: '#6d6555',
        lineControl: '#7a7262',
        accentInk: '#efe9de',
        accentSoft: '#2c261e',
        primary: '#efe9de',
        link: '#efe9de',
        status: { good: '#4ade80', warning: '#fbbf24', critical: '#f87171', info: '#91a8ff' },
        nav: {
          ground: '#110f0c',
          ink: '#efe9de',
          muted: '#b3aa9b',
          line: '#26221c',
          accent: '#efe9de',
        },
        rules: { section: '#8a8170', head: '#8a8170' },
        chart: ['#d9d0c0', '#9a78ec', '#12a678', '#c88317', '#e0559b', '#1597b9', '#d26b3b', '#6b7694'],
      },
    },
    shape: {
      radius: { control: '2px', field: '2px', pill: '2px', panel: '2px' },
      elevation: 'flat',
      border: { panel: '1px', rule: '2px' },
    },
    type: {
      font: { ui: BARLOW, data: BARLOW, heading: BARLOW_CONDENSED },
      base: '14px',
      roles: {
        title: { face: 'heading', size: '30px', weight: 700, case: 'upper', tracking: '0.01em', leading: 1.1 },
        heading: { face: 'heading', size: '22px', weight: 700, case: 'upper', tracking: '0.01em' },
        section: { face: 'heading', size: '15px', weight: 700, case: 'upper', tracking: '0.04em' },
        label: { face: 'heading', weight: 700, case: 'upper', tracking: '0.06em' },
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
      nav: 'slot',
      bar: 'ruled',
      tabs: 'rule',
      windows: 'segmented',
      stat: 'ruled',
      section: 'open',
      fields: 'open',
      table: 'open',
      status: 'dot',
      board: 'ruled',
      chart: 'plain',
      buttons: 'keyed',
      links: 'plain',
      rules: 'ink',
      avatar: 'plain',
      workflow: 'markers',
      banner: 'plain',
      steps: 'strip',
      lanes: 'tag',
      header: 'plain',
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
    shape: { radius: { control: '8px', field: '8px' }, elevation: 'raised', border: { rule: '1px' } },
    /* The page's name anchors it: 28px, tight; a list's name a step under, and a section's heading 16px, so the
       page reads title, section, row at a glance. On a flat page the type is the hierarchy the boxes used to be. */
    type: {
      font: { ui: INTER, data: INTER, heading: INTER },
      roles: {
        title: { size: '28px', weight: 600, tracking: '-0.02em' },
        heading: { size: '24px', tracking: '-0.018em' },
        section: { size: '16px', weight: 600, tracking: '-0.01em' },
      },
    },
    density: 'compact',
    recipes: {
      nav: 'pill',
      bar: 'airy',
      tabs: 'underline',
      windows: 'lifted',
      stat: 'divided',
      section: 'open',
      fields: 'rail',
      table: 'quiet',
      status: 'quiet',
      board: 'strip',
      chart: 'line',
      buttons: 'raised',
      rules: 'hairline',
      avatar: 'round',
      workflow: 'markers',
      banner: 'plain',
      steps: 'strip',
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
    shape: { radius: { control: '0px', field: '0px' }, elevation: 'flat' },
    /* Figures and the labels that make the look in the platform's monospace, the labels and the bar's entries in
       capitals: not data, which a reader who wants monospace picks in Preferences. */
    type: {
      font: { ui: HELVETICA, data: HELVETICA, heading: HELVETICA },
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
    recipes: { nav: 'inverted', bar: 'ruled', tabs: 'inverted', stat: 'framed', links: 'underline' },
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
    shape: { radius: { control: '8px', field: '8px' }, elevation: 'soft' },
    type: { font: { ui: SANS, data: SANS, heading: SANS }, roles: { title: { weight: 600 } } },
    // Compact, as Mono and Lumen: see Mono's density.
    density: 'compact',
    recipes: {
      nav: 'quiet',
      bar: 'soft',
      tabs: 'chosen',
      windows: 'chosen',
      stat: 'panel',
      section: 'panel',
      fields: 'panel',
      table: 'hairline',
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
      border: { panel: '1px', rule: '1px' },
    },
    type: {
      font: { ui: INTER, data: PLEX_MONO, heading: INTER },
      roles: {
        title: { size: '26px', weight: 600, tracking: '-0.01em' },
        heading: { size: '20px', weight: 600, tracking: '-0.018em' },
        section: { face: 'data', size: '12px', weight: 500, case: 'upper', tracking: '0.08em' },
        label: { face: 'data', weight: 500, case: 'upper', tracking: '0.04em' },
        data: { features: ['tnum', 'zero'] },
        figure: { face: 'data', size: '30px', weight: 500, tracking: '-0.02em', features: ['tnum', 'zero'] },
        nav: { face: 'ui', weight: 400 },
      },
    },
    surface: { ground: { kind: 'grid' } },
    density: 'compact',
    recipes: {
      nav: 'wash',
      bar: 'dark',
      tabs: 'rule',
      windows: 'segmented',
      stat: 'divided',
      section: 'panel',
      fields: 'panel',
      table: 'hairline',
      status: 'quiet',
      board: 'ruled',
      chart: 'plain',
      buttons: 'accent',
      links: 'plain',
      rules: 'double',
      avatar: 'plain',
      workflow: 'markers',
      banner: 'plain',
      steps: 'strip',
      lanes: 'plain',
      header: 'plain',
    },
  },
];

export const LOOKS: readonly ThemeSpec[] = HOUSE.map(withPalettes);
