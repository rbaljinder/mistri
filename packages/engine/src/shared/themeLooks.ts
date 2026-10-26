/**
 * The built-in looks as authored specs: each look's palettes, faces, shape,
 * density and recipe picks, written by purpose as an App's own theme is.
 * themePresets.ts compiles them into the presets the server and the browser
 * both wear; the builder and the checks are elsewhere, so they stay out of a
 * first paint that needs only the looks.
 */
import type { ThemeSpec } from '../../schema/theme.js';

/** The system's own interface face on every machine; nothing is fetched and
    nothing is bundled. A look's identity is its type roles: size, weight and tracking. */
const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const HELVETICA = '"Helvetica Neue", Helvetica, Arial, ui-sans-serif, sans-serif';
/** Lumen's face: Inter, shipped with Lumen's sheet (lumenLook.css) and so
    fetched only by a page wearing it, never in the first paint; then Arial
    cut to Inter's measure while it arrives (docs/design.md, Faces). */
const INTER = `Inter, "Inter Fallback", ${SANS}`;

/** The built-in looks: Lumen, the default an App wears, then Mono and Sage.
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
    softer titles at 600. */
export const LOOKS: readonly ThemeSpec[] = [
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
    // checks pass, light and dark. Inter, shipped with the look. Violet,
    // Teal, Emerald, Rose and Amber change the accent family only — grounds,
    // ink and structure stay Default's.
    id: 'lumen',
    label: 'Lumen',
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
        accent: '#2d4fd6',
        accentSoft: '#eef1fd',
        primary: '#1c1a17',
        onPrimary: '#ffffff',
        link: '#2d4fd6',
        focus: '#6880e0',
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
          accent: '#2d4fd6',
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
        accent: '#8aa1ff',
        accentSoft: '#1d2547',
        primary: '#eeece8',
        onPrimary: '#121110',
        link: '#91a8ff',
        focus: '#5a73d6',
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
          accent: '#91a8ff',
        },
        rules: {
          section: '#2d2b27',
          head: '#2d2b27',
        },
        chart: ['#3559e6', '#9a78ec', '#12a678', '#c88317', '#e0559b', '#1597b9', '#d26b3b', '#6b7694'],
      },
    },
    palettes: [
      {
        id: 'violet',
        label: 'Violet',
        light: {
          accent: '#6534d8',
          accentSoft: '#f1ecff',
          link: '#6534d8',
          focus: '#8a6ee6',
          nav: {
            accent: '#6534d8',
          },
          chart: ['#9a6cf7', '#2557e0'],
        },
        dark: {
          accent: '#ad91ff',
          accentSoft: '#2a2154',
          link: '#bea8ff',
          focus: '#7c63cf',
          nav: {
            accent: '#bea8ff',
          },
          chart: ['#9a78ec', '#3559e6'],
        },
      },
      {
        id: 'teal',
        label: 'Teal',
        light: {
          accent: '#0b6f86',
          accentSoft: '#e3f5f8',
          link: '#0b6f86',
          focus: '#3c90a4',
          nav: {
            accent: '#0b6f86',
          },
          chart: ['#0e8fb0', null, null, null, null, '#2557e0'],
        },
        dark: {
          accent: '#4cc6db',
          accentSoft: '#0f3540',
          link: '#79d6e6',
          focus: '#2a8a9c',
          nav: {
            accent: '#79d6e6',
          },
          chart: ['#0c8ab0', null, null, null, null, '#3559e6'],
        },
      },
      {
        id: 'emerald',
        label: 'Emerald',
        light: {
          accent: '#08734f',
          accentSoft: '#e4f6ed',
          link: '#08734f',
          focus: '#36966f',
          nav: {
            accent: '#08734f',
          },
          chart: ['#0e9a6c', null, '#2557e0'],
        },
        dark: {
          accent: '#4ad6a0',
          accentSoft: '#0f3529',
          link: '#7ee6bd',
          focus: '#279771',
          nav: {
            accent: '#7ee6bd',
          },
          chart: ['#12a678', null, '#3559e6'],
        },
      },
      {
        id: 'rose',
        label: 'Rose',
        light: {
          accent: '#b4185a',
          accentSoft: '#fdebf2',
          link: '#b4185a',
          focus: '#d0608f',
          nav: {
            accent: '#b4185a',
          },
          chart: ['#e0428a', null, null, null, '#2557e0'],
        },
        dark: {
          accent: '#f57ab9',
          accentSoft: '#3e1631',
          link: '#f9a6cf',
          focus: '#bd5a8f',
          nav: {
            accent: '#f9a6cf',
          },
          chart: ['#e0559b', null, null, null, '#3559e6'],
        },
      },
      {
        id: 'amber',
        label: 'Amber',
        light: {
          accent: '#9c4c06',
          accentSoft: '#fdf1df',
          link: '#9c4c06',
          focus: '#b57a33',
          nav: {
            accent: '#9c4c06',
          },
          chart: ['#d97706', null, null, '#2557e0'],
        },
        dark: {
          accent: '#f4b24a',
          accentSoft: '#3a2a10',
          link: '#fbcf86',
          focus: '#b07d2d',
          nav: {
            accent: '#fbcf86',
          },
          chart: ['#c88317', null, null, '#3559e6'],
        },
      },
    ],
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
        accent: '#000000',
        accentSoft: '#ebebeb',
        link: '#000000',
        focus: '#000000',
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
          accent: '#000000',
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
        accent: '#ffffff',
        accentSoft: '#262626',
        link: '#ffffff',
        focus: '#ffffff',
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
          accent: '#ffffff',
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
        accent: '#1f2320',
        accentSoft: '#ebe8df',
        link: '#256b43',
        focus: '#256b43',
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
          accent: '#1f2320',
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
        accent: '#f1f0ea',
        accentSoft: '#2a2d27',
        link: '#8fd9ad',
        focus: '#8fd9ad',
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
          accent: '#8fd9ad',
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
];
