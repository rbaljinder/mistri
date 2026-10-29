/**
 * The palettes every built-in look offers: one registry, so Cobalt is the same
 * blue in Workshop, Lumen, Mono, Sage and Ledger, and a reader who picks it keeps it
 * when they pick another look. A palette is a color identity only — its hue at
 * the depths a look draws it, light and dark, and the chart series that starts
 * from it. Everything else stays the look's: its grounds and neutrals
 * (Workshop's paper, Lumen's stone, Mono's grays, Sage's cream, Ledger's green-tinted paper and cover), its type,
 * shape and recipes, and which roles it lets the hue reach (`paletteColors`).
 * Workshop keeps one restrained accent under any palette: the hue reaches the
 * few marks a reader takes for the brand color — the primary verb, links and
 * the current tab, the menu's marker, the ring, a checked box, the first
 * series — and never a tint; its fills and rules stay the ink.
 *
 * test/contrast.test.ts measures every palette in every look, light and dark:
 * the hue as text and as a fill's words at 4.5:1, the ring at 3:1, adjacent
 * chart series apart for color-blind readers.
 */
import type { ThemeBase, ThemeColorsOver } from '../../schema/theme.js';
import { chartPairFailure, linear, oklab } from './chartSeparation.js';

/** One mode of a palette: the hue at each depth a look draws it. */
interface PaletteMode {
  /** The hue as text and as a fill under the page's words: a link, a current tab's word, a button (Lumen, Mono, Sage). */
  accent: string;
  /** A link a step brighter than the accent, by night; omitted, the accent. */
  link?: string;
  /** The hue's pale (by night, deep) tint under a selected item: Lumen's. */
  soft: string;
  /** The focus ring: a mid-tone of the hue, 3:1 on every look's grounds. */
  focus: string;
  /** The hue as a signal fill — Workshop's primary verb, as a hazard tag prints it — and the words on it. */
  signal: string;
  onSignal: string;
  /** The first chart series. */
  chart: string;
  /** Ledger's rules by night, where the ring's mid-tone is not the rung it draws them at; omitted, the ring. */
  rule?: string;
}

interface LookPalette {
  id: string;
  label: string;
  light: PaletteMode;
  dark: PaletteMode;
  /** Where one look draws the hue at another depth: the ink is each look's own ink, Workshop's orange its own, and a
      link a step deeper where Workshop's paper and its menu's hover would otherwise hold it under 4.5:1. */
  looks?: Partial<Record<ThemeBase, { light?: Partial<PaletteMode>; dark?: Partial<PaletteMode> }>>;
}

/* Around the wheel, then the two neutrals, so twelve hues read apart at a glance in the picker. Lumen's five
   (Violet, Teal, Emerald, Rose, Amber) keep their ids and their Lumen colors; Amber moved toward gold so that it and
   Safety orange are two hues, not one. Cobalt is Lumen's own blue. */
export const LOOK_PALETTES: readonly LookPalette[] = [
  {
    id: 'crimson',
    label: 'Crimson',
    light: { accent: '#b42318', soft: '#fdecea', focus: '#d9534a', signal: '#cf2a1e', onSignal: '#faf8f3', chart: '#d63a32' },
    dark: {
      accent: '#ff8f85',
      link: '#ffaca5',
      soft: '#3d1715',
      focus: '#e06158',
      signal: '#ff6b5e',
      onSignal: '#15130f',
      chart: '#e5534b',
    },
  },
  {
    id: 'safety',
    label: 'Safety orange',
    light: { accent: '#b33d0b', soft: '#fdeee4', focus: '#d4612a', signal: '#f26a1b', onSignal: '#1b1813', chart: '#e8691f' },
    dark: {
      accent: '#ff9d66',
      link: '#ffb88f',
      soft: '#3b2112',
      focus: '#d8743a',
      signal: '#ff7a2e',
      onSignal: '#15130f',
      chart: '#f07a32',
    },
    /* Workshop's ring is its own deeper orange (a field report's theme, where the look began). */
    looks: { workshop: { light: { accent: '#c9530b', link: '#aa3600' }, dark: { accent: '#e8742c' } } },
  },
  {
    id: 'amber',
    label: 'Amber',
    light: { accent: '#875a00', soft: '#fbf2dc', focus: '#b57a33', signal: '#f2a516', onSignal: '#1b1813', chart: '#d97706' },
    dark: {
      accent: '#f4b24a',
      link: '#fbcf86',
      soft: '#3a2a10',
      focus: '#b07d2d',
      signal: '#ffb52e',
      onSignal: '#15130f',
      chart: '#c88317',
    },
    looks: { workshop: { light: { link: '#825600' } } },
  },
  {
    id: 'moss',
    label: 'Moss',
    light: { accent: '#436e10', soft: '#eef4e2', focus: '#638f2a', signal: '#86b828', onSignal: '#1b1813', chart: '#6b9e1f' },
    dark: {
      accent: '#a6d468',
      link: '#bfe28f',
      soft: '#232f15',
      focus: '#7aa743',
      signal: '#a3d65c',
      onSignal: '#15130f',
      chart: '#8cbf45',
    },
    looks: { workshop: { light: { link: '#3f6a08' } } },
  },
  {
    id: 'emerald',
    label: 'Emerald',
    light: { accent: '#08734f', soft: '#e4f6ed', focus: '#36966f', signal: '#12a26f', onSignal: '#1b1813', chart: '#0e9a6c' },
    dark: {
      accent: '#4ad6a0',
      link: '#7ee6bd',
      soft: '#0f3529',
      focus: '#279771',
      signal: '#34d399',
      onSignal: '#15130f',
      chart: '#12a678',
    },
    /* Ledger's own green is Emerald as the book draws it: a deeper, greyer hue than the shared one, so its marks read
       on its tinted paper and the cover's green sits beside them. */
    looks: {
      workshop: { light: { link: '#006d4a' } },
      ledger: {
        light: { accent: '#0f4d36', link: '#0f5a3f', soft: '#e0ece4', focus: '#3f8a6c', chart: '#0f6b4a' },
        dark: { accent: '#7cc4a0', link: '#8fd1ae', soft: '#183026', focus: '#5fa585', chart: '#5fbf92', rule: '#6fb592' },
      },
    },
  },
  {
    id: 'teal',
    label: 'Teal',
    light: { accent: '#0b6f86', soft: '#e3f5f8', focus: '#3c90a4', signal: '#17a9c4', onSignal: '#1b1813', chart: '#0e8fb0' },
    dark: {
      accent: '#4cc6db',
      link: '#79d6e6',
      soft: '#0f3540',
      focus: '#2a8a9c',
      signal: '#3ccbe0',
      onSignal: '#15130f',
      chart: '#0c8ab0',
    },
    looks: { workshop: { light: { link: '#00687e' } } },
  },
  {
    id: 'cobalt',
    label: 'Cobalt',
    light: { accent: '#2d4fd6', soft: '#eef1fd', focus: '#6880e0', signal: '#2f5ce8', onSignal: '#faf8f3', chart: '#2557e0' },
    dark: {
      accent: '#8aa1ff',
      link: '#91a8ff',
      soft: '#1d2547',
      focus: '#5a73d6',
      signal: '#7f9cff',
      onSignal: '#15130f',
      chart: '#4369f0',
    },
  },
  {
    id: 'violet',
    label: 'Violet',
    light: { accent: '#6534d8', soft: '#f1ecff', focus: '#8a6ee6', signal: '#7445e8', onSignal: '#faf8f3', chart: '#9a6cf7' },
    dark: {
      accent: '#ad91ff',
      link: '#bea8ff',
      soft: '#2a2154',
      focus: '#7c63cf',
      signal: '#a98cff',
      onSignal: '#15130f',
      chart: '#9a78ec',
    },
  },
  {
    id: 'plum',
    label: 'Plum',
    light: { accent: '#8a1f8f', soft: '#f8eaf8', focus: '#b65bbb', signal: '#a3289f', onSignal: '#faf8f3', chart: '#b847c0' },
    dark: {
      accent: '#e28cea',
      link: '#edaef2',
      soft: '#3a1840',
      focus: '#b366bb',
      signal: '#e083ea',
      onSignal: '#15130f',
      chart: '#d062d8',
    },
  },
  {
    id: 'rose',
    label: 'Rose',
    light: { accent: '#b4185a', soft: '#fdebf2', focus: '#d0608f', signal: '#c92265', onSignal: '#faf8f3', chart: '#e0428a' },
    dark: {
      accent: '#f57ab9',
      link: '#f9a6cf',
      soft: '#3e1631',
      focus: '#bd5a8f',
      signal: '#ff70aa',
      onSignal: '#15130f',
      chart: '#e0559b',
    },
  },
  {
    id: 'slate',
    label: 'Slate',
    light: { accent: '#3f5670', soft: '#ebeff4', focus: '#6e8399', signal: '#4c6584', onSignal: '#faf8f3', chart: '#5f7690' },
    dark: {
      accent: '#a8bbd2',
      link: '#c2d0e1',
      soft: '#1f2733',
      focus: '#6f86a3',
      signal: '#9fb4cf',
      onSignal: '#15130f',
      chart: '#8a9fba',
    },
  },
  {
    /* No hue: the look's own ink is the accent. Mono's and Sage's original colors are this palette as they draw it. */
    id: 'ink',
    label: 'Ink',
    light: { accent: '#1c1a17', soft: '#eeedeb', focus: '#726c64', signal: '#1c1a17', onSignal: '#ffffff', chart: '#2b2620' },
    dark: { accent: '#eeece8', soft: '#2a2826', focus: '#9f9a92', signal: '#eeece8', onSignal: '#121110', chart: '#d9d0c0' },
    looks: {
      workshop: {
        light: { accent: '#5f574b', signal: '#1b1813', onSignal: '#faf8f3' },
        dark: { accent: '#a59c8d', signal: '#efe9de', onSignal: '#15130f' },
      },
      mono: {
        light: { accent: '#000000', focus: '#000000', chart: '#000000' },
        dark: { accent: '#ffffff', focus: '#ffffff', chart: '#ffffff' },
      },
      sage: {
        light: { accent: '#1f2320', link: '#256b43', focus: '#256b43', chart: '#3a8560' },
        dark: { accent: '#f1f0ea', link: '#8fd9ad', focus: '#8fd9ad', chart: '#7fd1a0' },
      },
    },
  },
];

/** How far apart two series are to the reader who tells them apart least (OKLab ΔE ×100), and whether every reader
    does (chartSeparation.ts). */
function apart(a: string, b: string): boolean {
  return !chartPairFailure(a, b);
}
function nearness(a: string, b: string): number {
  const x = oklab(linear(a)),
    y = oklab(linear(b));
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/**
 * A look's series led by a palette's hue. The lead takes the first place and the look's series follow in their own
 * order, less the lead where it is one of them, else less the one nearest it, so a chart never shows two of a hue.
 * Where a neighbor would sit too close to the one before it for a color-blind reader, the next that reads apart takes
 * its place: the first order, in the look's own, in which every neighbor does. Where none does without the nearest,
 * the next nearest is left out instead; a look whose series cannot be set apart at all keeps its own order.
 */
function ledSeries(series: readonly string[], lead: string): string[] {
  const own = series.findIndex((color) => color.toLowerCase() === lead.toLowerCase());
  const leaving =
    own >= 0 ? [own] : series.map((_, index) => index).sort((a, b) => nearness(series[a]!, lead) - nearness(series[b]!, lead));
  for (const left of leaving) {
    const rest = series.filter((_, index) => index !== left);
    const order: string[] = [];
    const used = new Set<number>();
    const place = (before: string): boolean => {
      if (order.length === rest.length) return true;
      for (let index = 0; index < rest.length; index++) {
        if (used.has(index) || !apart(before, rest[index]!)) continue;
        used.add(index);
        order.push(rest[index]!);
        if (place(rest[index]!)) return true;
        order.pop();
        used.delete(index);
      }
      return false;
    };
    if (place(lead)) return [lead, ...order];
  }
  return [lead, ...series.filter((_, index) => index !== leaving[0])];
}

/**
 * One palette as a look draws it, in one mode: the roles the look lets the hue reach, as spec colors.
 *
 * - Workshop: the hue is the primary verb's fill and its words, links and the current tab's rule, the marker beside
 *   the menu's ink block, the ring, a checked box and the first chart series; fills, rules and selection stay the
 *   ink, on paper, with no tint.
 * - Lumen: the accent and its pale tint, links, the ring, the menu's mark and the first chart series.
 * - Mono and Sage: the same, on their own neutral tint for what is chosen (Mono's gray, Sage's warm cream).
 * - Ledger: Lumen's reach and the primary verb's fill, and the hue's ink and the rules (a table's double-ruled heads, a box's top rule) in it;
 *   the paper and the cover stay the book's own green, with the gilt mark for the current entry.
 */
export function paletteColors(look: ThemeBase, palette: LookPalette, mode: 'light' | 'dark', series: readonly string[]): ThemeColorsOver {
  const tone: PaletteMode = { ...palette[mode], ...palette.looks?.[look]?.[mode] };
  const link = tone.link ?? tone.accent;
  switch (look) {
    case 'workshop':
      /* The few marks a reader takes for the brand color, and no tint: the primary verb's fill and its words, links
         and the current tab's rule, the menu's marker beside its ink block, the ring, a checked box and the first
         chart series. Fills, rules, selection and the menu's block stay the ink, on paper. */
      return {
        accent: tone.signal,
        onAccent: tone.onSignal,
        primary: tone.signal,
        onPrimary: tone.onSignal,
        link,
        focus: tone.accent,
        nav: { accent: link },
        chart: ledSeries(series, tone.chart),
      };
    case 'lumen':
      return {
        accent: tone.accent,
        accentSoft: tone.soft,
        link,
        focus: tone.focus,
        nav: { accent: link },
        chart: ledSeries(series, tone.chart),
      };
    case 'mono':
      return { accent: tone.accent, link, focus: tone.focus, nav: { accent: link }, chart: ledSeries(series, tone.chart) };
    case 'sage':
      return {
        accent: tone.accent,
        link,
        focus: tone.focus,
        /* Sage's menu marks the current entry in its ink by day, as its buttons are; by night in the brighter link. */
        nav: { accent: mode === 'light' ? tone.accent : link },
        chart: ledSeries(series, tone.chart),
      };
    case 'ledger': {
      /* The rules stand in the hue by day, and by night in its mid-tone, a rung under the link so a 3px double rule
         is a line and not a glare on the dark paper. */
      const rule = mode === 'light' ? tone.accent : (tone.rule ?? tone.focus);
      /* The book has one green for its cover's marks, its primary button and its links: a form's primary verb fills
         in the hue like a record's, never in the ink. */
      return {
        accent: tone.accent,
        primary: tone.accent,
        accentSoft: tone.soft,
        accentInk: mode === 'light' ? tone.accent : link,
        link,
        focus: tone.focus,
        rules: { section: rule, head: rule },
        chart: ledSeries(series, tone.chart),
      };
    }
  }
}
