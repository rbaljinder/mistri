/**
 * What a theme may say beyond the recipe menu, checked: its patterns (`surface`), its parts' styles (`parts`) and
 * its icons' weight (`type.icons`), for the spec (themeSpec.ts) and for a compiled theme read back (theme.ts
 * parseThemes) alike. A module apart from themeParts.ts, which the first paint wears and these messages are no
 * weight of.
 */
import type { ThemeIconWeight, ThemePart, ThemePartStyle, ThemePattern, ThemeSurface } from '../../schema/theme.js';
import { PALETTE_TOKENS, rolePath } from './themeTokens.js';
import { PART_CASES, PART_FACES, PART_LIFTS, PART_PROPERTIES, PART_RADII, PART_WEIGHTS, THEME_PARTS } from './themeParts.js';

/** The patterns, drawn by surfacesLook.css; each at a strength of 1 (omitted), 2 or 3. */
export const PATTERN_KINDS = ['paper', 'grain', 'grid', 'dots', 'lines', 'scanlines'] as const;
/** How much of the line color each strength draws a pattern in (surfacesLook.css says the same three). */
const PATTERN_STRENGTH = { 1: 0.4, 2: 0.7, 3: 1 } as const;
/* Paper is two families of fibers crossing, twice the ink of one family of lines at a strength: at 40% its low end
   read as a mesh over the page, not a sheet of paper. Its own steps are half again lighter. */
const PAPER_STRENGTH = { 1: 0.2, 2: 0.45, 3: 0.7 } as const;
/** How much of the line color a pattern of this kind and strength is drawn in. */
export const patternStrength = (pattern: ThemePattern): number =>
  (pattern.kind === 'paper' ? PAPER_STRENGTH : PATTERN_STRENGTH)[pattern.strength ?? 1];
/** Phosphor's weights a theme may pick for the icons: thin fades at 16px, duotone says a second tone no role names. */
export const ICON_WEIGHTS: readonly ThemeIconWeight[] = ['regular', 'light', 'bold', 'fill'];

/** The color roles a part may name, by their paths: every color but the widths and the shadow's ink. */
const PART_COLOR_PATHS: readonly string[] = Object.keys(PALETTE_TOKENS)
  .filter((role) => role !== 'shadow' && role !== 'rulesWeight' && role !== 'rulesControl')
  .map(rolePath);
/** A role's path back to the role it names: `nav.onCurrent` is `navOnCurrent`, `chart[2]` is `chart3`. */
export function pathRole(path: string): string {
  const series = /^chart\[(\d)\]$/.exec(path);
  if (series) return `chart${Number(series[1]) + 1}`;
  return path.replace(/\.(\w)/, (_, letter: string) => letter.toUpperCase());
}

function record(raw: unknown, where: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where} must be an object.`);
  return raw as Record<string, unknown>;
}

/** `surface`: a pattern behind the page, one behind the menu, each of the six at a strength; omitted strength is 1. */
export function surfaceOf(raw: unknown, where: string): ThemeSurface {
  const surface = record(raw, where);
  const out: ThemeSurface = {};
  for (const [place, value] of Object.entries(surface)) {
    if (place !== 'ground' && place !== 'nav') throw new Error(`${where} has no "${place}". It takes: ground, nav.`);
    const pattern = record(value, `${where}.${place}`);
    for (const key of Object.keys(pattern))
      if (key !== 'kind' && key !== 'strength')
        throw new Error(
          `${where}.${place} has no "${key}". It takes: kind, strength. A pattern is one of the platform's, drawn in the theme's line color.`,
        );
    if (!(PATTERN_KINDS as readonly unknown[]).includes(pattern.kind))
      throw new Error(`${where}.${place}.kind must be one of ${PATTERN_KINDS.join(', ')}.`);
    if (pattern.strength !== undefined && pattern.strength !== 1 && pattern.strength !== 2 && pattern.strength !== 3)
      throw new Error(`${where}.${place}.strength must be 1, 2 or 3.`);
    out[place] = { kind: pattern.kind as ThemePattern['kind'], strength: (pattern.strength ?? 1) as 1 | 2 | 3 };
  }
  return out;
}

/** `parts`: each a published part, saying only what its menus hold. */
export function partsOf(raw: unknown, where: string): Partial<Record<ThemePart, ThemePartStyle>> {
  const parts = record(raw, where);
  const out: Partial<Record<ThemePart, ThemePartStyle>> = {};
  for (const [part, value] of Object.entries(parts)) {
    if (!(THEME_PARTS as readonly string[]).includes(part))
      throw new Error(`${where} has no "${part}". The parts are: ${THEME_PARTS.join(', ')}.`);
    const at = `${where}.${part}`;
    const style = record(value, at);
    for (const [property, said] of Object.entries(style)) {
      if (!(PART_PROPERTIES as readonly string[]).includes(property))
        throw new Error(
          `${at} has no "${property}". It takes: ${PART_PROPERTIES.join(', ')}. A part's size, spacing, order and visibility are the App's, never its theme's.`,
        );
      const menu = (why: string, values: readonly unknown[]) => {
        if (!values.includes(said)) throw new Error(`${at}.${property} must be one of ${values.join(', ')}${why}.`);
      };
      if (property === 'ground' || property === 'ink' || property === 'edge') {
        if (said === 'nav.currentInk') throw new Error(`${at}.${property} names nav.currentInk, which is now nav.onCurrent.`);
        if (typeof said !== 'string' || !PART_COLOR_PATHS.includes(said))
          throw new Error(`${at}.${property} must be a color role by its path, like nav.ground or chart[2], never a hex.`);
      } else if (property === 'radius') menu(": a corner the theme's shape already says, or square", PART_RADII);
      else if (property === 'lift') menu('', PART_LIFTS);
      else if (property === 'face') menu(": a face the theme's type already says", PART_FACES);
      else if (property === 'weight') menu('', PART_WEIGHTS);
      else menu('', PART_CASES);
    }
    out[part as ThemePart] = { ...style } as ThemePartStyle;
  }
  return out;
}

/** `type.icons`: one of Phosphor's weights the icons are drawn in. */
export function iconsOf(raw: unknown, where: string): ThemeIconWeight {
  if (!(ICON_WEIGHTS as readonly unknown[]).includes(raw))
    throw new Error(
      `${where} must be one of ${ICON_WEIGHTS.join(', ')}: thin draws a 1px stroke that fades at the 16px an icon is drawn at, and duotone a second tone no color role says.`,
    );
  return raw as ThemeIconWeight;
}
