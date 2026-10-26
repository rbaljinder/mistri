/**
 * `buildTheme`: a spec already known to be good, assembled into the
 * ThemeDefinition every surface wears — the colour roles, the colours a theme
 * leaves unsaid, a built-in's colours under an author's. The built-in looks
 * are built with it ahead of time (scripts/theme-presets.mjs); an App's or a
 * tenant's theme is checked by themeSpec.ts's `compileTheme` and then built
 * here, on the server or in the branding form, never at first paint.
 */
import { mergeType } from '@mistriwork/engine/shared/themeType.js';
import type { ThemeColorsOver, ThemeDefinition, ThemeDensity, ThemePalette, ThemeSpec } from '@mistriwork/engine/schema/theme.js';
import { DEFAULT_RECIPES } from '@mistriwork/engine/shared/themeRecipes.js';
import { ROUND } from '@mistriwork/engine/shared/themeTokens.js';

/* ---------- colors: names by purpose, and the roles they fill ---------- */

/** A spec color's path and the role it fills in a compiled palette: the same name, flattened (`nav.ground` is
    `navGround`), and worn as the custom property of that name (PALETTE_TOKENS). */
export const COLOR_ROLES: ReadonlyArray<readonly [string, keyof ThemePalette]> = [
  ['ground', 'ground'],
  ['surface', 'surface'],
  ['field', 'field'],
  ['raised', 'raised'],
  ['ink', 'ink'],
  ['inkMuted', 'inkMuted'],
  ['inkSubtle', 'inkSubtle'],
  ['line', 'line'],
  ['lineStrong', 'lineStrong'],
  ['lineControl', 'lineControl'],
  ['accent', 'accent'],
  ['onAccent', 'onAccent'],
  ['accentInk', 'accentInk'],
  ['accentSoft', 'accentSoft'],
  ['primary', 'primary'],
  ['onPrimary', 'onPrimary'],
  ['link', 'link'],
  ['focus', 'focus'],
  ['status.good', 'statusGood'],
  ['status.warning', 'statusWarning'],
  ['status.critical', 'statusCritical'],
  ['status.info', 'statusInfo'],
  ['nav.ground', 'navGround'],
  ['nav.ink', 'navInk'],
  ['nav.muted', 'navMuted'],
  ['nav.line', 'navLine'],
  ['nav.accent', 'navAccent'],
  ['nav.current', 'navCurrent'],
  ['nav.onCurrent', 'navOnCurrent'],
  ['rules.section', 'rulesSection'],
  ['rules.head', 'rulesHead'],
  ['shadow', 'shadow'],
  ['band', 'band'],
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => [`chart[${n - 1}]`, `chart${n}` as keyof ThemePalette] as const),
];

/* ---------- the colors a theme leaves unsaid ---------- */

function channels(value: string): [number, number, number] {
  return [1, 3, 5].map((start) => parseInt(value.slice(start, start + 2), 16)) as [number, number, number];
}
/** `weight` of `a` over `b`, in sRGB, as hex: the derivations below are colors an author could have written. */
export function mixHex(a: string, b: string, weight: number): string {
  const x = channels(a),
    y = channels(b);
  return `#${x
    .map((value, index) =>
      Math.round(value * weight + y[index]! * (1 - weight))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** What a theme that extends nothing starts from where it says nothing: meaning colors that read on white and on
    near-black, and Lumen's chart series after the theme's own accent, spaced for color-blind readers. */
const STARTING = {
  light: {
    statusGood: '#117a38',
    statusWarning: '#a84d07',
    statusCritical: '#c81e1e',
    statusInfo: '#0369a1',
    chart: ['#2557e0', '#9a6cf7', '#0e9a6c', '#d97706', '#e0428a', '#0e8fb0', '#a3510b', '#94a3b8'],
  },
  dark: {
    statusGood: '#4ade80',
    statusWarning: '#fbbf24',
    statusCritical: '#f87171',
    statusInfo: '#7dd3fc',
    chart: ['#3559e6', '#9a78ec', '#12a678', '#c88317', '#e0559b', '#1597b9', '#d26b3b', '#6b7694'],
  },
} as const;

/** Every role, from the four a theme must name. Mixes toward the surface keep a derived ink readable on it; the validator measures them anyway. */
function derive(given: Partial<ThemePalette>, mode: 'light' | 'dark'): ThemePalette {
  const surface = given.surface!,
    ink = given.ink!,
    accent = given.accent!;
  const start = STARTING[mode];
  const palette: ThemePalette = {
    ground: given.ground,
    surface,
    raised: mixHex(ink, surface, 0.04),
    line: mixHex(ink, surface, 0.16),
    lineStrong: mixHex(ink, surface, 0.56),
    lineControl: mixHex(ink, surface, 0.52),
    ink,
    inkMuted: mixHex(ink, surface, 0.82),
    inkSubtle: mixHex(ink, surface, 0.7),
    accent,
    accentSoft: mixHex(accent, surface, 0.12),
    link: accent,
    focus: accent,
    statusGood: start.statusGood,
    statusWarning: start.statusWarning,
    statusCritical: start.statusCritical,
    statusInfo: start.statusInfo,
    navGround: given.surface,
    navInk: ink,
    navMuted: undefined,
    navLine: undefined,
    navAccent: undefined,
    chart1: accent,
    ...Object.fromEntries(start.chart.slice(1).map((color, index) => [`chart${index + 2}`, color])),
  };
  const merged = { ...palette, ...given };
  merged.navGround = given.navGround ?? merged.surface;
  merged.navInk = given.navInk ?? merged.ink;
  merged.navMuted = given.navMuted ?? merged.inkSubtle;
  merged.navLine = given.navLine ?? merged.line;
  merged.navAccent = given.navAccent ?? merged.accent;
  return merged;
}

/** A built-in's colors under an author's: an accent said without its tint, link, focus, menu accent or first
    series takes them along where the built-in had them equal to its own accent — they were that accent, not
    a color of their own. */
function overlay(base: ThemePalette, over: Partial<ThemePalette>): ThemePalette {
  const merged: ThemePalette = { ...base, ...over };
  if (over.accent !== undefined && over.accent !== base.accent) {
    const surface = merged.surface;
    if (over.accentSoft === undefined) merged.accentSoft = mixHex(over.accent, surface, 0.12);
    /* The inks a base chose for its own accent read on that fill, not this one: they are chosen again where worn. */
    if (over.onAccent === undefined) delete merged.onAccent;
    if (over.accentInk === undefined) delete merged.accentInk;
    if (over.focus === undefined) merged.focus = over.accent;
    for (const role of ['link', 'navAccent'] as const)
      if (over[role] === undefined && base[role] === base.accent) merged[role] = over.accent;
    /* The first series and the metric sparkline are the brand's colour in every look, whether or not the look drew
       its own first hue (Mono's accent is the ink, its first series a blue): a theme that names an accent and no
       chart wears it, so a chart is never the look's colour beside the App's. */
    if (over.chart1 === undefined) merged.chart1 = over.accent;
  }
  /* A form's primary action was the built-in's ink or its accent, not a color of its own: a theme that says another
     of that color and no `primary` takes it along, and the words on it are chosen again where worn. */
  if (over.primary === undefined && base.primary !== undefined)
    for (const role of ['ink', 'accent'] as const)
      if (over[role] !== undefined && over[role] !== base[role] && base.primary === base[role]) {
        merged.primary = over[role];
        if (over.onPrimary === undefined) delete merged.onPrimary;
      }
  if (over.primary !== undefined && over.primary !== base.primary && over.onPrimary === undefined) delete merged.onPrimary;
  return merged;
}

/** One mode's colours, by purpose, to roles, as written. */
function rolesOf(colors: ThemeColorsOver | undefined): Partial<ThemePalette> {
  const out: Partial<Record<keyof ThemePalette, string>> = {};
  if (!colors) return {};
  const source = colors as Record<string, unknown>;
  for (const [path, role] of COLOR_ROLES) {
    if (path.startsWith('chart[')) continue;
    const [group, key] = path.split('.') as [string, string | undefined];
    const value = key === undefined ? source[group] : (source[group] as Record<string, unknown> | undefined)?.[key];
    if (typeof value === 'string') out[role] = value.trim().toLowerCase();
  }
  colors.chart?.forEach((value, index) => {
    if (typeof value === 'string') out[`chart${index + 1}` as keyof ThemePalette] = value.trim().toLowerCase();
  });
  return out as unknown as Partial<ThemePalette>;
}

/** A spec that is known to be good — a built-in, or one `compileTheme` has checked — as the definition it compiles
    to. `base` is the built-in it extends, resolved by the caller. */
export function buildTheme(spec: ThemeSpec, base?: ThemeDefinition): ThemeDefinition {
  const colors = (spec.colors ?? {}) as { light?: ThemeColorsOver; dark?: ThemeColorsOver };
  /* A rule's and a control's width are shape, said once, and worn as each mode's palette roles they always were. */
  const border = spec.shape?.border;
  const widths: Partial<ThemePalette> = {
    ...(border?.rule ? { rulesWeight: border.rule } : {}),
    ...(border?.control ? { rulesControl: border.control } : {}),
  };
  /* A dark-only theme has one set of colors, worn in both slots: nothing downstream has a light mode to be missing. */
  const darkOnly = spec.scheme === 'dark-only';
  const mode = (name: 'light' | 'dark'): ThemePalette => {
    const given = { ...rolesOf(colors[name]), ...widths };
    return base ? overlay(base[name], given) : derive(given, name);
  };
  /* `round` is a pill's corner: a length past any box's (themeTokens.ts ROUND). */
  const radius = Object.fromEntries(
    Object.entries(spec.shape?.radius ?? {}).map(([key, length]) => [key, length === 'round' ? ROUND : length]),
  );
  const ownBorder = {
    ...(border?.panel ? { panel: border.panel } : {}),
    ...(border?.focus ? { focus: border.focus } : {}),
  };
  const height = spec.shape?.height?.control ? { control: spec.shape.height.control } : undefined;
  const palettes = spec.palettes?.map((variant) => ({
    id: variant.id,
    label: variant.label.trim(),
    light: rolesOf(darkOnly ? variant.dark : variant.light),
    dark: rolesOf(variant.dark),
  }));
  const font = spec.type?.font;
  const fonts = typeof font === 'string' ? { ui: font, data: font, heading: font } : font;
  const density = spec.density ?? base?.density;
  const motion = spec.motion ?? base?.motion;
  const rhythm = spec.rhythm ?? base?.rhythm;
  const type = mergeType(base?.type, spec.type && { base: spec.type.base, roles: spec.type.roles });
  const steps = typeof spec.shape?.elevation === 'object' ? spec.shape.elevation : undefined;
  const lifts = base?.lifts || steps ? { ...base?.lifts, ...steps } : undefined;
  /* A face is a theme's own file: a built-in ships none (Lumen's Inter is its sheet's); a theme value it extends (a
     package's look) may, and its faces stand under this theme's own, which win at a family, weight and style. */
  const own = spec.type?.faces?.map((face) => ({
    family: face.family,
    src: face.src,
    weight: String(face.weight ?? 400),
    style: face.style ?? ('normal' as const),
    ...(face.subset === false ? { subset: false as const } : {}),
  }));
  const cut = (face: { family: string; weight: string; style: string }) => `${face.family.toLowerCase()} ${face.weight} ${face.style}`;
  const faces = base?.faces?.length ? [...base.faces.filter((face) => !own?.some((mine) => cut(mine) === cut(face))), ...(own ?? [])] : own;
  /* A theme's stylesheet is its own, or the one it extends: a built-in has none. */
  const stylesheet = spec.stylesheet ? { src: spec.stylesheet } : base?.stylesheet;
  /* A pattern says its strength (1 when omitted); a part's style lies over the one it extends, property by property. */
  const patterns = Object.entries(spec.surface ?? {}).map(([place, pattern]) => [
    place,
    { kind: pattern!.kind, strength: pattern!.strength ?? 1 },
  ]);
  const surface = base?.surface || patterns.length ? { ...base?.surface, ...Object.fromEntries(patterns) } : undefined;
  let parts: ThemeDefinition['parts'] = base?.parts ? { ...base.parts } : undefined;
  for (const [part, style] of Object.entries(spec.parts ?? {}))
    parts = { ...parts, [part]: { ...parts?.[part as keyof typeof parts], ...style } };
  const icons = spec.type?.icons ?? base?.icons;
  return {
    id: spec.id,
    label: spec.label.trim(),
    ...(base?.base ? { base: base.base } : {}),
    light: mode(darkOnly ? 'dark' : 'light'),
    dark: mode('dark'),
    ...((spec.scheme ?? base?.scheme) ? { scheme: (spec.scheme ?? base?.scheme)! } : {}),
    ...(palettes === undefined ? (base?.palettes && spec.colors === undefined ? { palettes: base.palettes } : {}) : { palettes }),
    ...(spec.defaultPalette === undefined ? {} : { defaultPalette: spec.defaultPalette }),
    fonts: { ...base?.fonts, ...fonts },
    ...(faces?.length ? { faces } : {}),
    radius: { control: '4px', field: '4px', ...base?.radius, ...radius },
    ...(base?.border || Object.keys(ownBorder).length ? { border: { ...base?.border, ...ownBorder } } : {}),
    ...(base?.height || height ? { height: { ...base?.height, ...height } } : {}),
    recipes: { ...DEFAULT_RECIPES, ...base?.recipes, ...spec.recipes },
    /* A preset is the look's own drawing of its lifts; `{ card, float }` steps over the base's, which stays. */
    elevation: (typeof spec.shape?.elevation === 'string' ? spec.shape.elevation : undefined) ?? base?.elevation ?? 'hairline',
    ...(lifts ? { lifts } : {}),
    ...(type ? { type } : {}),
    ...(density ? { density: density as ThemeDensity } : {}),
    ...(motion ? { motion } : {}),
    ...(rhythm ? { rhythm } : {}),
    /* The theme's own suggestion only: a built-in suggests none, so there is nothing to inherit. */
    ...(spec.shell?.placement ? { shell: { placement: spec.shell.placement } } : {}),
    ...(surface ? { surface } : {}),
    ...(parts ? { parts } : {}),
    ...(icons ? { icons } : {}),
    ...(stylesheet ? { stylesheet } : {}),
  };
}
