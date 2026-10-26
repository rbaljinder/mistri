/**
 * Part styles (`parts` in a theme, docs/theming.md): the published parts of an App's page a theme may dress one by
 * one, and what it may say of each — its ground, ink and edge as a color role (`nav.ground`, `chart[2]`), never a
 * hex, so `check` measures every pair in every mode and palette; a corner, a lift, a face, a weight and a case from
 * the menus the rest of the theme speaks. Nothing that moves a box: no size, spacing, order or visibility.
 *
 * A part is worn as two things, as a type role is: custom properties, `--part-<part>-<property>`, and one word per
 * property said in the root's `data-parts` (`stat:ground`), which turns on the one rule in partsLook.css that
 * reads it. A part that says nothing turns nothing on, so a theme without parts draws as its look does, and the
 * sheet is fetched only when a worn theme says one (visualTheme.ts). The names are a contract (contract 1): a 1.x
 * release may publish another, none is withdrawn before contract 2. Which elements each one names is the
 * platform's (themePartSelectors.ts), so a part stays where it is drawn when the markup under it changes.
 */
import type { ThemeLift, ThemePart, ThemePartStyle } from '../../schema/theme.js';
import { THEME_PARTS } from './themeRecipes.js';
/* The names and the root's words are the first paint's (themeRecipes.ts), as the recipes' are. */
export { partAttribute, PART_PROPERTIES, THEME_PARTS } from './themeRecipes.js';

export const PART_RADII = ['control', 'field', 'pill', 'panel', 'square'] as const;
export const PART_FACES = ['ui', 'heading', 'data'] as const;
export const PART_WEIGHTS = [400, 500, 600, 700] as const;
export const PART_CASES = ['none', 'upper', 'small-caps'] as const;
export const PART_LIFTS: readonly ThemeLift[] = ['none', 'hairline', 'low', 'mid', 'high'];

/** A part's name as a custom property's piece: `button.secondary` is `button-secondary`. */
const partSlug = (part: string) => part.replace(/\./g, '-');

/** A color role's path (`nav.ground`, `status.good`, `chart[2]`, `inkMuted`) as the custom property it is worn as. */
function roleToken(path: string): string {
  const series = /^chart\[(\d)\]$/.exec(path);
  if (series) return `--chart-${Number(series[1]) + 1}`;
  const flat = path.replace('.', '-').replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  return path === 'shadow' ? '--shadow-ink' : `--${flat}`;
}

/** Each corner as the token the sheets already draw it with: a round control stays a pill only on a control. */
const RADIUS: Record<(typeof PART_RADII)[number], string> = {
  control: 'var(--control-radius, var(--radius))',
  field: 'var(--field-radius, var(--radius))',
  pill: 'var(--pill-radius, 999px)',
  panel: 'var(--radius-lg)',
  square: '0',
};
const FACE: Record<(typeof PART_FACES)[number], string> = {
  ui: 'var(--sans)',
  heading: 'var(--heading-font, var(--sans))',
  data: 'var(--mono)',
};
/** Each lift as the card steps draw it (themeFamilies.css), mixed from the theme's shadow ink. */
const LIFT: Record<ThemeLift, string> = {
  none: 'none',
  hairline: '0 1px 2px color-mix(in srgb, var(--shadow-ink) 5%, transparent)',
  low: '0 1px 2px color-mix(in srgb, var(--shadow-ink) 4%, transparent), 0 6px 16px -4px color-mix(in srgb, var(--shadow-ink) 7%, transparent)',
  mid: '0 1px 2px color-mix(in srgb, var(--shadow-ink) 5%, transparent), 0 10px 28px -16px color-mix(in srgb, var(--shadow-ink) 20%, transparent)',
  high: '0 1px 3px color-mix(in srgb, var(--shadow-ink) 6%, transparent), 0 16px 36px -14px color-mix(in srgb, var(--shadow-ink) 26%, transparent)',
};

type Parts = Partial<Record<ThemePart, ThemePartStyle>> | undefined;

/**
 * The custom properties the parts are worn as. Written where the App's accent is (body, appTheme.js), so a part in
 * `accent` is the App's own accent: a color resolves where its property is declared.
 */
export function partTokens(parts: Parts): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of THEME_PARTS) {
    const style = parts?.[part];
    if (!style) continue;
    const token = (property: string) => `--part-${partSlug(part)}-${property}`;
    for (const property of ['ground', 'ink', 'edge'] as const) {
      const path = style[property];
      if (path !== undefined) out[token(property)] = `var(${roleToken(path)})`;
    }
    if (style.radius) out[token('radius')] = RADIUS[style.radius];
    if (style.lift) out[token('lift')] = LIFT[style.lift];
    if (style.face) out[token('face')] = FACE[style.face];
    if (style.weight !== undefined) out[token('weight')] = String(style.weight);
    if (style.case) {
      out[token('transform')] = style.case === 'upper' ? 'uppercase' : 'none';
      out[token('caps')] = style.case === 'small-caps' ? 'all-small-caps' : 'normal';
      out[token('tracking')] = style.case === 'none' ? 'normal' : 'var(--track-caps)';
    }
  }
  return out;
}
