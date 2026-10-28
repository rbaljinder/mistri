import type { ThemeDefinition, ThemePalette } from '../../schema/theme.js';
import { THEME_PRESETS } from './builtInThemes.js';
import { mergeType } from './themeType.js';
import { deriveAccentInk, deriveOnAccent } from './themeInk.js';

/** The built-in looks as the browser wears them: built from their specs (themeLooks.ts) by
    scripts/theme-presets.mjs and committed, so no reader's first page carries the theme builder. */
export { THEME_PRESETS };

/** A theme's title weight (`type.roles.title.weight`): its own, else its base look's. Every heading reads it, as
    `--heading-weight`. */
export function headingWeight(theme: ThemeDefinition): number {
  return theme.type?.roles?.title?.weight ?? themePreset(theme.base)?.type?.roles?.title?.weight ?? 700;
}

export function themePreset(id: string | undefined): ThemeDefinition | undefined {
  return THEME_PRESETS.find((theme) => theme.id === id);
}

/** The modes a theme has colors for: both, or the dark alone where it is dark-only (its light slot is the dark colors). */
export function themeModes(theme: Pick<ThemeDefinition, 'scheme'>): readonly ('light' | 'dark')[] {
  return theme.scheme === 'dark-only' ? ['dark'] : ['light', 'dark'];
}

/** A theme's `scheme`, read the one way for an App's theme (themeSpec.ts) and a tenant's or host's (theme.ts parseThemes). */
export function parseScheme(raw: unknown, where: string): ThemeDefinition['scheme'] {
  if (raw !== undefined && raw !== 'dark' && raw !== 'dark-only') throw new Error(`${where}.scheme must be "dark" or "dark-only".`);
  return raw as ThemeDefinition['scheme'];
}

/** A palette over another. An accent set without a `focus` of its own drops the base's: that ring is a tint of
    the base's hue, and under another accent it would be the wrong colour; the ring then follows the accent. The inks
    chosen for the base's accent (`onAccent`, `accentInk`) go the same way: they read on that fill, not this one. */
function overlayPalette(base: ThemePalette, over: Partial<ThemePalette> | undefined): ThemePalette {
  const merged = { ...base, ...over };
  if (over?.accent !== undefined && over.focus === undefined) delete merged.focus;
  if (over?.accent !== undefined && over.accent !== base.accent) {
    if (over.onAccent === undefined) delete merged.onAccent;
    if (over.accentInk === undefined) delete merged.accentInk;
  }
  if (over?.primary !== undefined && over.primary !== base.primary && over.onPrimary === undefined) delete merged.onPrimary;
  return merged;
}

/** The nav role its base look sets, which a theme wears on the bar only until it sets the role itself (recipeAttributes). */
export function lookNavRole(theme: ThemeDefinition) {
  return themePreset(theme.base)?.type?.roles?.nav;
}

/** Inherit roles from a data-backed base, then overlay the author's explicit values. */
export function inheritThemePreset(theme: ThemeDefinition): ThemeDefinition {
  const base = themePreset(theme.base);
  if (!base || base === theme) return theme;
  return {
    ...theme,
    light: overlayPalette(base.light, theme.light),
    dark: overlayPalette(base.dark, theme.dark),
    fonts: { ...base.fonts, ...theme.fonts },
    radius: { ...base.radius, ...theme.radius },
    recipes: { ...base.recipes, ...theme.recipes },
    elevation: theme.elevation ?? base.elevation,
    ...((theme.lifts ?? base.lifts) ? { lifts: { ...base.lifts, ...theme.lifts } } : {}),
    ...((theme.type ?? base.type) ? { type: mergeType(base.type, theme.type) } : {}),
    ...((theme.density ?? base.density) ? { density: theme.density ?? base.density } : {}),
    ...((theme.motion ?? base.motion) ? { motion: theme.motion ?? base.motion } : {}),
    ...((theme.rhythm ?? base.rhythm) ? { rhythm: theme.rhythm ?? base.rhythm } : {}),
  };
}

/** Resolve structure first, then theme colors, then a named color variation.
    A removed stored choice falls back to the authored default. */
export function effectiveThemeDefinition(theme: ThemeDefinition, paletteId?: string): ThemeDefinition {
  const inherited = inheritThemePreset(theme);
  const selected =
    paletteId === 'default'
      ? undefined
      : (theme.palettes?.find((palette) => palette.id === (paletteId ?? theme.defaultPalette)) ??
        theme.palettes?.find((palette) => palette.id === theme.defaultPalette));
  if (!selected) return inherited;
  return { ...inherited, light: overlayPalette(inherited.light, selected.light), dark: overlayPalette(inherited.dark, selected.dark) };
}

/** App overrides are applied after inheritance and palette selection. Keep the
    CSS expressions intact: legacy authored colors may use browser CSS syntax.
    An authored accent is the first chart series too: a brand blue on the tabs
    beside the look's own blue in the chart read as two products on one page. */
/**
 * A look's palette under the App's own accent. One colour is authored for the light ground and mixed toward white on
 * the dark one; `{ light, dark }` says both, each worn as written. The soft tint is always derived from the accent worn.
 */
export function effectiveThemePalette(palette: ThemePalette, dark: boolean, own: { accent?: AppAccent } = {}) {
  const authored = typeof own.accent === 'object' ? (dark ? own.accent.dark : own.accent.light) : own.accent;
  const accent = !authored
    ? palette.accent
    : typeof own.accent === 'string' && dark
      ? `color-mix(in srgb, ${authored} 62%, white)`
      : authored;
  /* The inks an accent needs beyond itself: the theme's own, else the one that reads where the accent as it stands
     would not. An App's accent is not the one the theme chose them for, so they are chosen again. */
  const under = authored ? { ...palette, onAccent: undefined, accentInk: undefined, accent } : palette;
  const onAccent = under.onAccent ?? deriveOnAccent(under);
  const accentInk = under.accentInk ?? deriveAccentInk(under, Boolean(authored));
  /* What a theme left as its accent and an App's accent is drawn as a line or a word, not a fill: a link, the ring, the
     menu's current mark, the first series. It follows the accent's ink; a color the theme chose for it stays. */
  const ink = accentInk ?? accent;
  const follows = (value: string | undefined) => authored || value === undefined || value === palette.accent;
  const out = {
    ...palette,
    accent,
    focus: follows(palette.focus) ? ink : palette.focus!,
    link: follows(palette.link) ? ink : palette.link!,
    ...(palette.navAccent !== undefined && !authored && palette.navAccent === palette.accent ? { navAccent: ink } : {}),
    chart1: authored ? ink : follows(palette.chart1) ? ink : palette.chart1!,
    accentSoft: authored
      ? `color-mix(in srgb, ${authored} 14%, transparent)`
      : (palette.accentSoft ?? `color-mix(in srgb, ${palette.accent} 14%, transparent)`),
  };
  if (onAccent) out.onAccent = onAccent;
  else delete out.onAccent;
  /* A form's primary action, where the theme names one: the words on it as the theme says, else the ones that read. */
  if (palette.primary) out.onPrimary = palette.onPrimary ?? onPrimaryOf(palette as ThemePalette & { primary: string });
  if (accentInk) out.accentInk = accentInk;
  else delete out.accentInk;
  return out;
}

/** A worn palette's inks said whole: what a check or a fix measures when the theme named neither. */
export function withInks<T extends ThemePalette>(palette: T): T & { onAccent: string; accentInk: string } {
  return {
    ...palette,
    onAccent: palette.onAccent ?? palette.ground ?? palette.surface,
    accentInk: palette.accentInk ?? palette.accent,
    ...(palette.primary ? { onPrimary: palette.onPrimary ?? onPrimaryOf(palette as T & { primary: string }) } : {}),
  };
}

/** The words on a form's primary action the theme left unsaid: the page's color where it reads on the fill, else the
    ink, white or black, as for the accent. */
function onPrimaryOf(palette: ThemePalette & { primary: string }): string {
  return deriveOnAccent({ ...palette, accent: palette.primary }) ?? palette.ground ?? palette.surface;
}

/** An App's accent: one colour for both grounds, or one for each. */
export type AppAccent = string | { light: string; dark: string };
