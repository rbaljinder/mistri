import { RECIPE_MENU, RECIPE_PARTS, recipeAttributes } from '../../../packages/engine/src/shared/themeRecipes';
import {
  effectiveThemeDefinition,
  effectiveThemePalette,
  headingWeight,
  lookNavRole,
  themePreset,
} from '../../../packages/engine/src/shared/themePresets';
import { FONT_TOKENS, PALETTE_TOKENS, shapeTokens } from '../../../packages/engine/src/shared/themeTokens';
import { typeTokens } from '../../../packages/engine/src/shared/themeType';
import { LOOK_PALETTES } from '../../../packages/engine/src/shared/lookPalettes';
import type { WornTheme } from '../src';

/* The gallery wears mistri's own themes, worked out by mistri's own code: the five built-in looks, the twelve
   palettes and the recipe menu are read from the engine's source, not copied here, so what this page shows is
   what an App would hand ui-next. Only the gallery reaches into the engine; the library (src/) imports none of it
   and takes a theme already worked out (src/theme.ts). */
export const LOOKS = ['workshop', 'lumen', 'mono', 'sage', 'ledger'] as const;
export type Look = (typeof LOOKS)[number];
export const PALETTES = LOOK_PALETTES.map((palette) => ({ id: palette.id, label: palette.label }));
export { RECIPE_MENU, RECIPE_PARTS };

/* A look in a palette, with any recipes picked over it, as the attributes and tokens mistri would put on the
   root. `own` is ui-next's own drawing: no theme at all. */
export type Rhythm = 'house' | 'tight' | 'airy';
export function worn(
  look: Look | 'own',
  palette: string | undefined,
  recipes: Record<string, string> = {},
  rhythm?: Rhythm,
): WornTheme | null {
  if (look === 'own') return null;
  const preset = themePreset(look);
  if (!preset) return null;
  const picked = effectiveThemeDefinition(preset, palette);
  const definition = { ...picked, recipes: { ...picked.recipes, ...recipes }, ...(rhythm ? { rhythm } : {}) } as typeof picked;
  const { attributes } = recipeAttributes(definition, lookNavRole(definition));
  const tokens = (dark: boolean): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(effectiveThemePalette(definition[dark ? 'dark' : 'light'], dark))) {
      const name = PALETTE_TOKENS[key as keyof typeof PALETTE_TOKENS];
      if (name && typeof value === 'string') out[name] = value;
    }
    for (const [key, value] of Object.entries(definition.fonts ?? {})) {
      const name = FONT_TOKENS[key as keyof typeof FONT_TOKENS];
      if (name && typeof value === 'string') out[name] = value;
    }
    Object.assign(out, shapeTokens(definition), typeTokens(definition.type));
    out['--heading-weight'] = String(headingWeight(definition));
    return out;
  };
  return { attributes, light: tokens(false), dark: tokens(true) };
}
