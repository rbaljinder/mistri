/**
 * A theme's `brand`: one colour, and every role a reader takes for the App's own in each mode. The accent, links,
 * the ring, the menu's mark and the first chart series are the colour itself (by night, lit until it reads on a dark
 * panel). Where the look it extends wears a tint (Lumen, Sage, Bloom), the neutrals turn to its hue too — the raised
 * ground, the menu's ground, hairlines and the muted inks — each keeping how light it is, so a pair that read before
 * still reads; `mistri check` measures them as it measures any theme's. Two Apps on one look then differ in more
 * than their button. A look whose neutrals are its identity (Workshop's paper, Mono's and Graphite's greys, Ledger's
 * book, Atelier's page) keeps them, and takes the signal colour alone. What a colour means (`status`) is never
 * turned. A colour the theme names itself wins over the one worked out here (themeBuild.ts).
 */
import { linear, oklab } from '@mistriwork/engine/shared/chartSeparation.js';
import type { ThemeDefinition, ThemePalette } from '@mistriwork/engine/schema/theme.js';

/** The looks whose neutrals take the brand's hue. */
const TINTED = new Set(['lumen', 'sage', 'bloom']);

/** The neutrals that turn. The working surface and the ink stay the look's: a white page under black words is what
    the tint is seen against. */
const NEUTRALS = [
  'ground',
  'raised',
  'line',
  'lineStrong',
  'lineControl',
  'inkMuted',
  'inkSubtle',
  'navGround',
  'navLine',
  'navMuted',
  'rulesSection',
  'rulesHead',
] as const satisfies readonly (keyof ThemePalette)[];

/** OKLab back to a hex colour, clipped to what a screen draws (as lookPalettes.ts does for a palette's turn). */
function hexOf([L, a, b]: readonly [number, number, number]): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const channel = (value: number) => {
    const lit = Math.min(1, Math.max(0, value));
    const coded = lit <= 0.0031308 ? lit * 12.92 : 1.055 * lit ** (1 / 2.4) - 0.055;
    return Math.round(coded * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)}${channel(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)}${channel(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)}`;
}

const lab = (hex: string) => oklab(linear(hex)) as [number, number, number];

/** How much colour a neutral holds at its lightness: a wash on what is nearly white or nearly black, a little more
    on a line or a muted word, where a hue is seen in less area. */
function wash(L: number): number {
  return L > 0.9 ? 0.011 : L > 0.55 ? 0.016 : L > 0.3 ? 0.02 : 0.013;
}

/** A neutral in the brand's hue, as light as it was. A brand with next to no colour of its own turns nothing grey
    into a guess at a hue: the tint is taken out in proportion. */
function turned(hex: string, hue: number, hold: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const [L, a, b] = lab(hex);
  /* Pure white and pure black hold no colour on a screen: they are left as written. */
  if (L > 0.995 || L < 0.02) return hex;
  const chroma = Math.max(Math.hypot(a, b), wash(L)) * hold;
  return hexOf([L, chroma * Math.cos(hue), chroma * Math.sin(hue)]);
}

/** The brand at a depth: as light as asked, with no more colour than reads calmly there. */
function atDepth(brand: string, depth: number, most: number): string {
  const [, a, b] = lab(brand);
  const chroma = Math.min(Math.hypot(a, b), most);
  const hue = Math.atan2(b, a);
  return hexOf([depth, chroma * Math.cos(hue), chroma * Math.sin(hue)]);
}

/** One mode's roles from a brand colour, over the look `base` (a theme that extends nothing has none to turn). */
export function brandRoles(brand: string, mode: 'light' | 'dark', base: ThemeDefinition | undefined): Partial<ThemePalette> {
  const [L, a, b] = lab(brand);
  /* By day the colour is the author's, as written; by night it is lit to where a dark panel shows it, and a link a
     step brighter, as the built-in palettes draw theirs. */
  const accent = mode === 'light' ? brand.toLowerCase() : atDepth(brand, Math.max(L, 0.78), 0.14);
  const link = mode === 'light' ? accent : atDepth(brand, Math.max(L, 0.84), 0.12);
  const roles: Partial<ThemePalette> = { accent, link, focus: accent, navAccent: link, chart1: accent };
  const look = base?.base ?? base?.id;
  if (!base || !look || !TINTED.has(look)) return roles;
  const hue = Math.atan2(b, a);
  const hold = Math.min(1, Math.hypot(a, b) / 0.08);
  const worn = base[mode];
  for (const role of NEUTRALS) {
    const was = worn[role];
    if (typeof was === 'string') roles[role] = turned(was, hue, hold);
  }
  return roles;
}
