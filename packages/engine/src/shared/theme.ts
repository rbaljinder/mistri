import type { ThemeDefinition, ThemePalette, ThemePaletteVariant, ThemeRecipes } from '../../schema/theme.js';
import {
  effectiveThemeDefinition,
  effectiveThemePalette,
  parseScheme,
  THEME_PRESETS,
  themeModes,
  withInks,
  type AppAccent,
} from './themePresets.js';
import { colorHex, diagnosticColor, HEAT_TOP, heatTop, measuredContrast, mixColor, over, type Color } from './themeColor.js';
import { DENSITIES, ELEVATIONS, LIFTS, MOTIONS, RECIPE_MENU, RECIPES_RENAMED, RHYTHMS } from './themeRecipes.js';
import { families } from './themeFaces.js';
import { iconsOf, partsOf, pathRole, patternStrength, surfaceOf } from './themePartsCheck.js';
import { TYPE_MOVED, typeOf } from './themeType.js';
import {
  BORDER_MENU,
  CONTROL_HEIGHT,
  controlHeightFits,
  cornerFits,
  FONT_TOKENS,
  PALETTE_TOKENS,
  RADIUS_MAX,
  RADIUS_TOKENS,
  rolePath,
  ROUND,
  ROUND_CORNERS,
  THEME_BASES,
} from './themeTokens.js';
export { FONT_TOKENS, PALETTE_TOKENS, RADIUS_TOKENS, shapeTokens, THEME_BASES } from './themeTokens.js';
export type { ThemeBase, ThemeDefinition, ThemePalette, ThemePaletteVariant } from '../../schema/theme.js';

function object(raw: unknown, where: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where} must be an object.`);
  return raw as Record<string, unknown>;
}

function strings(raw: unknown, keys: readonly string[], valid: (value: string) => boolean, where: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(object(raw, where))) {
    if (!keys.includes(key)) throw new Error(`${where} has no "${key}". It takes: ${keys.join(', ')}.`);
    if (typeof value !== 'string' || !valid(value.trim())) throw new Error(`${where}.${key} has an invalid value.`);
    out[key] = value.trim();
  }
  return out;
}

/** The roles' names before they were the spec's own (0.9.2), each to the one that replaced it. */
const OLD_ROLES: Readonly<Record<string, string>> = {
  background: 'ground',
  subtle: 'raised',
  border: 'line',
  borderStrong: 'lineStrong',
  borderControl: 'lineControl',
  text: 'ink',
  textMuted: 'inkMuted',
  textSubtle: 'inkSubtle',
  positive: 'statusGood',
  warning: 'statusWarning',
  negative: 'statusCritical',
  key: 'statusInfo',
  navSurface: 'navGround',
  navText: 'navInk',
  navBorder: 'navLine',
  navCurrentText: 'navOnCurrent',
  navCurrentInk: 'navOnCurrent',
  sectionRule: 'rulesSection',
  headRule: 'rulesHead',
  ruleWeight: 'rulesWeight',
};

/** A palette's roles: opaque six-digit hex colors, but for `rulesWeight` and `rulesControl`, widths. */
const RULE_WEIGHTS = ['1px', '2px', '3px'] as const;
const CONTROL_WEIGHTS = ['0px', '1px', '2px'] as const;
function paletteStrings(raw: unknown, where: string): Record<string, string> {
  const colors = Object.keys(PALETTE_TOKENS).filter((key) => key !== 'rulesWeight' && key !== 'rulesControl');
  const { rulesWeight, rulesControl, ...rest } = object(raw, where);
  for (const key of Object.keys(rest))
    if (Object.hasOwn(OLD_ROLES, key)) throw new Error(`${where}.${key} is now ${where}.${OLD_ROLES[key]}.`);
  const result = strings(rest, colors, (color) => /^#[0-9a-f]{6}$/i.test(color), where);
  if (rulesWeight !== undefined) {
    if (typeof rulesWeight !== 'string' || !(RULE_WEIGHTS as readonly string[]).includes(rulesWeight.trim())) {
      throw new Error(`${where}.rulesWeight must be one of ${RULE_WEIGHTS.join(', ')}.`);
    }
    result.rulesWeight = rulesWeight.trim();
  }
  if (rulesControl !== undefined) {
    if (typeof rulesControl !== 'string' || !(CONTROL_WEIGHTS as readonly string[]).includes(rulesControl.trim())) {
      throw new Error(`${where}.rulesControl must be one of ${CONTROL_WEIGHTS.join(', ')}.`);
    }
    result.rulesControl = rulesControl.trim();
  }
  return result;
}

export function parseThemes(raw: unknown, where: string, key = 'themes'): ThemeDefinition[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > 20) throw new Error(`${where}.${key} must be an array of at most 20 themes.`);
  const used = new Set<string>(['default', ...THEME_BASES]);
  return raw.map((value, index): ThemeDefinition => {
    const path = `${where}.${key}[${index}]`;
    const theme = object(value, path);
    for (const key of Object.keys(theme)) {
      if (key === 'scale' || key === 'headingWeight') throw new Error(`${path}.${key} is now ${path}.${TYPE_MOVED[`type.${key}`]}.`);
      if (
        ![
          'id',
          'label',
          'base',
          'light',
          'dark',
          'palettes',
          'defaultPalette',
          'scheme',
          'fonts',
          'radius',
          'border',
          'height',
          ...STRUCTURE_KEYS,
        ].includes(key)
      )
        throw new Error(`${path} has no "${key}".`);
    }
    if (typeof theme.id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(theme.id) || used.has(theme.id)) {
      throw new Error(`${path}.id must be a unique slug, not a built-in theme name.`);
    }
    used.add(theme.id);
    if (typeof theme.label !== 'string' || !theme.label.trim() || theme.label.trim().length > 60)
      throw new Error(`${path}.label must have 1 to 60 characters.`);
    if (theme.base !== undefined && (typeof theme.base !== 'string' || !(THEME_BASES as readonly string[]).includes(theme.base)))
      throw new Error(`${path}.base must be one of ${THEME_BASES.join(', ')}.`);
    const palette = (mode: 'light' | 'dark'): ThemePalette => {
      const result = paletteStrings(theme[mode], `${path}.${mode}`);
      for (const required of ['surface', 'ink', 'accent']) {
        if (!result[required]) throw new Error(`${path}.${mode}.${required} is required (a six-digit hex color).`);
      }
      return { ...result, surface: result.surface!, ink: result.ink!, accent: result.accent! };
    };
    const scheme = parseScheme(theme.scheme, path);
    const dark = palette('dark');
    /* One set of colors worn in both slots (themeBuild.ts): a light slot of its own is the colors a dark-only theme lacks. */
    const light = scheme === 'dark-only' ? dark : palette('light');
    if (scheme === 'dark-only' && theme.light !== undefined && JSON.stringify(palette('light')) !== JSON.stringify(dark))
      throw new Error(`${path}.light: a dark-only theme has no light colors; name dark alone, or drop scheme: 'dark-only'.`);
    const palettes = parsePaletteVariants(theme.palettes, path);
    if (
      theme.defaultPalette !== undefined &&
      (typeof theme.defaultPalette !== 'string' ||
        (theme.defaultPalette !== 'default' && !palettes?.some((item) => item.id === theme.defaultPalette)))
    ) {
      throw new Error(`${path}.defaultPalette must be "default" or one of this theme's palettes.`);
    }
    return {
      id: theme.id,
      label: theme.label.trim(),
      base: (theme.base ?? 'mono') as ThemeDefinition['base'],
      light,
      dark,
      ...(scheme === undefined ? {} : { scheme }),
      ...(palettes === undefined ? {} : { palettes }),
      ...(theme.defaultPalette === undefined ? {} : { defaultPalette: theme.defaultPalette as string }),
      ...(theme.fonts === undefined
        ? {}
        : {
            fonts: strings(
              theme.fonts,
              Object.keys(FONT_TOKENS),
              (font) => font.length > 0 && font.length <= 200 && /^[\w\s'",.-]+$/.test(font),
              `${path}.fonts`,
            ),
          }),
      ...(theme.radius === undefined ? {} : { radius: radii(theme.radius, `${path}.radius`) }),
      ...(theme.border === undefined ? {} : { border: borders(theme.border, `${path}.border`) }),
      ...(theme.height === undefined ? {} : { height: heights(theme.height, `${path}.height`) }),
      ...structure(theme, path),
    };
  });
}

/** A compiled theme's corners, each within its ceiling, a control's and a pill's `round` as ROUND. */
function radii(raw: unknown, where: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(object(raw, where))) {
    if (!Object.hasOwn(RADIUS_TOKENS, key))
      throw new Error(`${where} has no "${key}". It takes: ${Object.keys(RADIUS_TOKENS).join(', ')}.`);
    const fits = cornerFits(value, RADIUS_MAX[key as keyof typeof RADIUS_MAX]) || (ROUND_CORNERS.has(key) && value === ROUND);
    if (!fits) throw new Error(`${where}.${key} has an invalid value.`);
    out[key] = value as string;
  }
  return out;
}
/** A compiled theme's panel edge and focus ring, each from its menu. */
function borders(raw: unknown, where: string): NonNullable<ThemeDefinition['border']> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(object(raw, where))) {
    if (key !== 'panel' && key !== 'focus') throw new Error(`${where} has no "${key}". It takes: panel, focus.`);
    if (!(BORDER_MENU[key] as readonly unknown[]).includes(value)) throw new Error(`${where}.${key} has an invalid value.`);
    out[key] = value as string;
  }
  return out as NonNullable<ThemeDefinition['border']>;
}

/** A compiled theme's control height: whole pixels from CONTROL_HEIGHT.min to .max. */
function heights(raw: unknown, where: string): NonNullable<ThemeDefinition['height']> {
  const out: { control?: string } = {};
  for (const [key, value] of Object.entries(object(raw, where))) {
    if (key !== 'control') throw new Error(`${where} has no "${key}". It takes: control.`);
    if (!controlHeightFits(value))
      throw new Error(`${where}.control must be a length from ${CONTROL_HEIGHT.min}px to ${CONTROL_HEIGHT.max}px.`);
    out.control = value as string;
  }
  return out;
}

/**
 * What a theme's shape says that `check` warns of (theme-radius): a panel squarer than the controls it holds, its
 * corner cutting under theirs. A round control is a pill, not a corner, so it is never measured against a panel.
 */
export function themeShapeWarnings(themes: readonly ThemeDefinition[]): string[] {
  return themes.flatMap((theme, index) => {
    const control = theme.radius?.control,
      panel = theme.radius?.panel;
    if (!control || !panel || control === ROUND || parseFloat(panel) >= parseFloat(control)) return [];
    return [
      `ui.customThemes[${index}] ("${theme.id}") shape.radius.panel ${panel} is squarer than shape.radius.control ${control}: a panel holds controls, so give its corner at least theirs.`,
    ];
  });
}

/**
 * What a theme's shadow says that `check` warns of (theme-shadow, the contract's C2): a shadow lighter than the ground
 * it falls on, which draws a glow round a card or a menu rather than lifting it off the page — the edge the lift was
 * for is lost. The theme still wears.
 */
export function themeShadowWarnings(themes: readonly ThemeDefinition[]): string[] {
  return themes.flatMap((theme, index) => {
    const worn = effectiveThemeDefinition(theme, 'default');
    return themeModes(theme).flatMap((mode) => {
      const shadow = worn[mode].shadow,
        ground = worn[mode].ground ?? worn[mode].surface;
      if (!shadow || !/^#[0-9a-f]{6}$/i.test(shadow) || !/^#[0-9a-f]{6}$/i.test(ground) || luminance(shadow) <= luminance(ground))
        return [];
      return [
        `ui.customThemes[${index}] ("${theme.id}") colors.${mode}.shadow ${shadow} is lighter than its ground ${ground}: a shadow lighter than the page is a glow, not a lift, so give it a color darker than the ground.`,
      ];
    });
  });
}

/**
 * What a banded table's parts say that `check` warns of (theme-band, the contract's C13): a `status` or `tag` part
 * given an opaque ground. Part rules live in the `theme` cascade layer, above the `look` layer's band, so the chip
 * keeps its own ground on every other row and shows as a pale column. The author's color is not touched: a
 * translucent ground lets the band through, and so does the default.
 */
export function themeBandWarnings(themes: readonly ThemeDefinition[]): string[] {
  return themes.flatMap((theme, index) => {
    if (theme.recipes?.table !== 'banded') return [];
    const worn = effectiveThemeDefinition(theme, 'default');
    return (['status', 'tag'] as const).flatMap((part) => {
      const role = theme.parts?.[part]?.ground;
      if (!role) return [];
      const key = pathRole(role) as keyof ThemePalette;
      const opaque = themeModes(theme).filter((mode) => {
        const value = worn[mode][key];
        const color = value ? diagnosticColor(value) : undefined;
        return color !== undefined && color[3] >= 1;
      });
      if (!opaque.length) return [];
      return [
        `ui.customThemes[${index}] ("${theme.id}") parts.${part}.ground ${role} is opaque (${opaque.join(', ')}) on a banded table: a ${part} cell will not take the band and shows as a pale column on every other row, so give it a translucent ground or leave it out for the look's.`,
      ];
    });
  });
}

/** The stack a role's face reads when the role names none: the titles' the heading face, the rest the interface's. */
const ROLE_FACE: Record<string, 'heading' | 'ui'> = { display: 'heading', title: 'heading', heading: 'heading', section: 'heading' };

/**
 * What a theme's type says that `check` warns of (theme-type, the contract's C8): a role heavier than 700 whose face
 * leads with a family the theme does not ship at that weight. design.md keeps titles at 700 or under for this: a
 * heavier weight a family has no file for is drawn by the browser as a smeared 700, or resolves a book face to its
 * Black cut, a masthead where a title was meant.
 */
export function themeTypeWarnings(themes: readonly ThemeDefinition[]): string[] {
  return themes.flatMap((theme, index) => {
    const worn = effectiveThemeDefinition(theme, 'default');
    return Object.entries(worn.type?.roles ?? {}).flatMap(([role, said]) => {
      /* A line under 1.0 sets its descenders into the next: a title that wraps (a long name, a phone) collides with
         itself. Allowed down to 0.85 for a short large line, so it warns rather than refuses. */
      const leading =
        said.leading !== undefined && said.leading < 1
          ? [
              `ui.customThemes[${index}] ("${theme.id}") type.roles.${role}.leading ${said.leading} is under 1.0: a ${role} that wraps sets its descenders into the next line, so keep it at 1.0 or over unless it is one short line.`,
            ]
          : [];
      const weight = said.weight;
      if (weight === undefined || weight <= 700) return leading;
      const face = said.face ?? ROLE_FACE[role] ?? 'ui';
      const stack = (face === 'heading' ? (worn.fonts?.heading ?? worn.fonts?.ui) : worn.fonts?.[face]) ?? '';
      const lead = families(stack)[0];
      const shipped = (worn.faces ?? []).some((file) => {
        const [low, high = low] = file.weight.split(' ').map(Number);
        return file.family.toLowerCase() === lead?.toLowerCase() && weight >= low! && weight <= high!;
      });
      if (shipped) return leading;
      return [
        ...leading,
        `ui.customThemes[${index}] ("${theme.id}") type.roles.${role}.weight ${weight} is past 700 in a face the theme does not ship at that weight${lead ? ` (${lead})` : ''}: the browser draws a smeared 700 or a Black cut, so ship the face at ${weight} in type.faces or keep the weight at 700 or under.`,
      ];
    });
  });
}

const STRUCTURE_KEYS = ['recipes', 'elevation', 'type', 'density', 'motion', 'rhythm', 'lifts', 'surface', 'parts', 'icons'] as const;
/** A compiled theme's structure, as `compileTheme` writes it: every value from the menu. */
function structure(theme: Record<string, unknown>, path: string): Partial<ThemeDefinition> {
  const out: Partial<ThemeDefinition> = {};
  if (theme.recipes !== undefined) {
    const recipes = object(theme.recipes, `${path}.recipes`);
    for (const [part, value] of Object.entries(recipes)) {
      if (TYPE_MOVED[`recipes.${part}`]) throw new Error(`${path}.recipes.${part} is now ${path}.${TYPE_MOVED[`recipes.${part}`]}.`);
      if (Object.hasOwn(RECIPES_RENAMED, part)) throw new Error(`${path}.recipes.${part} is now ${path}.recipes.${RECIPES_RENAMED[part]}.`);
      const menu = (RECIPE_MENU as Record<string, Record<string, unknown>>)[part];
      if (!menu || typeof value !== 'string' || !Object.hasOwn(menu, value)) throw new Error(`${path}.recipes.${part} is not on the menu.`);
    }
    out.recipes = { ...recipes } as ThemeDefinition['recipes'];
  }
  if (theme.elevation !== undefined) {
    if (typeof theme.elevation !== 'string' || !Object.hasOwn(ELEVATIONS, theme.elevation))
      throw new Error(`${path}.elevation is not on the menu.`);
    out.elevation = theme.elevation as ThemeDefinition['elevation'];
  }
  if (theme.type !== undefined) {
    const type = object(theme.type, `${path}.type`);
    for (const key of Object.keys(type))
      if (key !== 'base' && key !== 'roles') throw new Error(`${path}.type has no "${key}". It takes: base, roles.`);
    out.type = typeOf(type.base, type.roles, `${path}.type`);
  }
  if (theme.density !== undefined) {
    if (!(DENSITIES as readonly unknown[]).includes(theme.density))
      throw new Error(`${path}.density must be one of ${DENSITIES.join(', ')}.`);
    out.density = theme.density as ThemeDefinition['density'];
  }
  if (theme.lifts !== undefined) {
    const lifts = object(theme.lifts, `${path}.lifts`);
    for (const [key, step] of Object.entries(lifts))
      if ((key !== 'card' && key !== 'float') || typeof step !== 'string' || step === 'look' || !Object.hasOwn(LIFTS, step))
        throw new Error(`${path}.lifts.${key} is not on the menu.`);
    out.lifts = { ...lifts } as ThemeDefinition['lifts'];
  }
  if (theme.motion !== undefined) {
    if (typeof theme.motion !== 'string' || !Object.hasOwn(MOTIONS, theme.motion))
      throw new Error(`${path}.motion must be one of ${Object.keys(MOTIONS).join(', ')}.`);
    out.motion = theme.motion as ThemeDefinition['motion'];
  }
  if (theme.rhythm !== undefined) {
    if (typeof theme.rhythm !== 'string' || !Object.hasOwn(RHYTHMS, theme.rhythm))
      throw new Error(`${path}.rhythm must be one of ${Object.keys(RHYTHMS).join(', ')}.`);
    out.rhythm = theme.rhythm as ThemeDefinition['rhythm'];
  }
  if (theme.surface !== undefined) out.surface = surfaceOf(theme.surface, `${path}.surface`);
  if (theme.parts !== undefined) out.parts = partsOf(theme.parts, `${path}.parts`);
  if (theme.icons !== undefined) out.icons = iconsOf(theme.icons, `${path}.icons`);
  return out;
}

function parsePaletteVariants(raw: unknown, where: string): ThemePaletteVariant[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > 20) throw new Error(`${where}.palettes must be an array of at most 20 palettes.`);
  const used = new Set(['default']);
  return raw.map((value, index) => {
    const path = `${where}.palettes[${index}]`,
      variant = object(value, path);
    for (const key of Object.keys(variant)) {
      if (!['id', 'label', 'light', 'dark'].includes(key)) throw new Error(`${path} has no "${key}".`);
    }
    if (typeof variant.id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(variant.id) || used.has(variant.id)) {
      throw new Error(`${path}.id must be a unique slug, not "default".`);
    }
    used.add(variant.id);
    if (typeof variant.label !== 'string' || !variant.label.trim() || variant.label.trim().length > 60)
      throw new Error(`${path}.label must have 1 to 60 characters.`);
    const palette = (mode: 'light' | 'dark') => paletteStrings(variant[mode], `${path}.${mode}`);
    return { id: variant.id, label: variant.label.trim(), light: palette('light'), dark: palette('dark') };
  });
}

/** WCAG relative luminance, for the opaque hex colors accepted by the contract. */
function luminance(hex: string): number {
  const channels = [1, 3, 5]
    .map((start) => parseInt(hex.slice(start, start + 2), 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

export function contrastRatio(a: string, b: string): number {
  const left = luminance(a),
    right = luminance(b);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

/**
 * The least luminance ratio a field's fill may be from the ground and the surface it sits on, when the field draws
 * no edge. 1.08:1 is Lintel's Hearth (a warm #eeede7 well on a #f7f6f2 page, 1.085, and on white, 1.173): the faintest
 * field we ship that still reads as a well, and the faintest a calibrated laptop screen shows in daylight. Below it
 * (white on #fcfbf8, 1.03) the field is gone. WCAG 1.4.11 asks 3:1 of a control's boundary unless it is identified
 * some other way; the label stands over the field and the focus ring draws a 2px edge, which is that other way.
 */
export const EDGELESS_FIELD_DELTA = 1.08;

/** What startup checks in each mode, and the ratio each pair must reach: text
    at 4.5:1 (WCAG 1.4.3) — the meaning colors on the page as well as on a
    panel, since a status word sits on both, and the page is where Meridian's
    red read at 4.4:1 while its panels passed — and a form control's edge at
    3:1 (1.4.11) on the field it frames and on the page around it. Section and
    table hairlines are decoration, and are not checked. */
const CONTRAST_PAIRS: ReadonlyArray<readonly [keyof ThemePalette, keyof ThemePalette, number, string?]> = [
  ['ink', 'surface', 4.5],
  ['inkMuted', 'surface', 4.5],
  ['inkSubtle', 'surface', 4.5],
  ['ink', 'ground', 4.5],
  ['ink', 'raised', 4.5],
  /* A field's own fill (`colors.field`, the surface where it names none): the words typed in it, the faint ink of its
     placeholder and the muted ink of its hint stand on it, and its edge. Skipped where the fill is the surface, which
     the pairs above already measure. */
  ['ink', 'field', 4.5, 'the words in a field'],
  ['inkMuted', 'field', 4.5, "a field's muted words"],
  ['inkSubtle', 'field', 4.5, "a field's placeholder"],
  ['lineControl', 'field', 3, "a control's edge on a field's fill"],
  /* Every ink is drawn where the text it is for is drawn, not only on the panel it was picked on: a caption under a
     page's title and a count beside a tab stand on the page (TC13, a theme check passed and its pages failed). */
  ['inkMuted', 'ground', 4.5, 'a caption on the page'],
  ['inkSubtle', 'ground', 4.5, 'a faint caption on the page'],
  ['link', 'ground', 4.5],
  ['link', 'raised', 4.5],
  ['navAccent', 'navGround', 4.5, "the menu's current entry"],
  /* The accent is a fill, and is read as text in its ink (`accentInk`, the accent itself where a theme names none and
     it reads); the words drawn on a fill are `onAccent`. A bright brand accent can be a good fill and a poor text. */
  ['accentInk', 'surface', 4.5],
  // A quiet button's word and a current tab are the accent's ink on the page, and on a raised panel or a hovered row.
  ['accentInk', 'ground', 4.5, 'an action in the accent on the page'],
  ['accentInk', 'raised', 4.5, 'an action in the accent on a raised panel or a hovered row'],
  ['onAccent', 'accent', 4.5, 'the words on an accent fill'],
  ['onPrimary', 'primary', 4.5, "the words on a form's primary action"],
  ['link', 'surface', 4.5],
  ['navInk', 'navGround', 4.5, "the menu's entries"],
  ['navMuted', 'navGround', 4.5, "the menu's group headings, counts and icons"],
  ...(['statusGood', 'statusWarning', 'statusCritical', 'statusInfo'] as const).flatMap(
    (role) =>
      [
        [role, 'surface', 4.5],
        [role, 'ground', 4.5],
        [role, 'raised', 4.5, 'a status word in a hovered row or on a raised panel'],
      ] as const,
  ),
  ['lineControl', 'surface', 3],
  ['lineControl', 'ground', 3],
  /* A field stands on a raised panel too, and a list's sort and filter controls on its head: a control's edge that
     passed on the panel and the page read 2.94:1 there. */
  ['lineControl', 'raised', 3, "a control's edge on a raised panel or a table's head"],
  // The focus ring is a graphic the keyboard reader follows (1.4.11): on the field, the page and the subtle panel it can sit on.
  ['focus', 'surface', 3],
  ['focus', 'ground', 3],
  ['focus', 'raised', 3],
  /* A chart's first four series are graphics a reader has to tell from the
     card they sit on; past four, a chart is already a legend's job. */
  ...(['chart1', 'chart2', 'chart3', 'chart4'] as const).map((series) => [series, 'surface', 3] as const),
];

export { HEAT_TOP, heatTop };

const SERIES = ['chart1', 'chart2', 'chart3', 'chart4', 'chart5', 'chart6', 'chart7', 'chart8'] as const;

/**
 * The colours a platform component mixes from a theme's series and its ink rather than wears as a token: no pair of
 * tokens is what it draws, so each is measured as drawn, and named by the series it comes from. A board card's
 * category chip (TriageBoard.css: 45% of its series in the ink, except under the `strip` board, which says it in words, on a 13% tint of it over the card), a person's
 * initials on their avatar (features.css: 45% in the ink, on a 15% tint over a 7% ink wash), and under the `icon`
 * stat recipe, a stat card's mark (lumenLook.css: 80% in the ink on a 12% tint, a graphic at 3:1). `check` holds a
 * theme to each, and `grade` names the series behind a reading of one.
 */
export function componentInks(
  palette: ThemePalette,
  recipes: Partial<ThemeRecipes> = {},
): Array<{ role: keyof ThemePalette; what: string; fg: string; bg: string; needs: number }> {
  const color = (key: keyof ThemePalette) => (palette[key] ? diagnosticColor(palette[key]!) : undefined);
  const ink = color('ink'),
    surface = color('surface');
  if (!ink || !surface) return [];
  const clear: Color = [0, 0, 0, 0];
  const out: Array<{ role: keyof ThemePalette; what: string; fg: Color; bg: Color; needs: number }> = [];
  SERIES.forEach((role, index) => {
    const series = color(role);
    if (!series) return;
    if (recipes.board !== 'strip')
      out.push({
        role,
        what: "a board card's category chip",
        fg: mixColor(series, ink, 0.45),
        bg: over(mixColor(series, clear, 0.13), surface),
        needs: 4.5,
      });
    if (index < 7)
      out.push({
        role,
        what: "an avatar's initials",
        fg: mixColor(series, ink, 0.45),
        bg: mixColor(series, mixColor(ink, surface, 0.07), 0.15),
        needs: 4.5,
      });
    if (recipes.stat === 'icon' && index < 4)
      out.push({
        role,
        what: "a stat card's mark",
        fg: mixColor(series, ink, 0.8),
        bg: mixColor(series, surface, 0.12),
        needs: 3,
      });
  });
  /* The eighth avatar is the second and third series half and half: said by the second. */
  const second = color('chart2'),
    third = color('chart3');
  if (second && third) {
    const slot = mixColor(second, third, 0.5);
    out.push({
      role: 'chart2',
      what: "the eighth avatar's initials (chart[1] and chart[2] half and half)",
      fg: mixColor(slot, ink, 0.45),
      bg: mixColor(slot, mixColor(ink, surface, 0.07), 0.15),
      needs: 4.5,
    });
  }
  return out.map((item) => ({ ...item, fg: colorHex(over(item.fg, item.bg)), bg: colorHex(item.bg) }));
}

/**
 * The pairs a role is read in (CONTRAST_PAIRS), measured with `value` drawn in its place: what an author wrote for a
 * colour the page wears as another (a link written as the accent is drawn in the accent's ink), so the colour as
 * written is held to the rule its role is.
 */
export function rolePairs(
  palette: ThemePalette,
  role: keyof ThemePalette,
  value: string,
): Array<{ background: keyof ThemePalette; needs: number; what?: string; ratio: number }> {
  const foreground = diagnosticColor(value);
  if (!foreground) return [];
  return CONTRAST_PAIRS.flatMap(([ink, background, needs, what]) => {
    const ground = palette[background];
    if (ink !== role || !ground || ((background === 'ground' || background === 'field') && ground === palette.surface)) return [];
    const backgroundColor = diagnosticColor(ground);
    const ratio = backgroundColor && measuredContrast(foreground, backgroundColor);
    return ratio === undefined || !ratio ? [] : [{ background, needs, ...(what ? { what } : {}), ratio }];
  });
}

/** One failed check: which theme, palette and mode, the role it is about, and the sentence for it. */
export interface ThemeFinding {
  themeId: string;
  paletteId: string;
  mode: 'light' | 'dark';
  /** The role (`accent`, `navMuted`, `chart3`); rolePath gives the spec's name for it (`nav.muted`, `chart[2]`). */
  token: keyof ThemePalette;
  /** What the check measures, in a few words: "accent on surface", "chart2 beside chart3 for deuteranopia". */
  check: string;
  ratio: number;
  needs: number;
  message: string;
}

export function themeWarnings(themes: readonly ThemeDefinition[], own: { accent?: AppAccent } = {}): string[] {
  return themeFindings(themes, own).map((finding) => finding.message);
}

/** Every failed check of the themes; with `all`, every check measured, passed or not (a fix reads what it reaches). */
export function themeFindings(themes: readonly ThemeDefinition[], own: { accent?: AppAccent } = {}, all = false): ThemeFinding[] {
  return themes.flatMap((theme) =>
    ['default', ...(theme.palettes ?? []).map((item) => item.id)].flatMap((id) =>
      themeModes(theme).flatMap((mode) => {
        const definition = effectiveThemeDefinition(theme, id);
        const palette = withInks(effectiveThemePalette(definition[mode], mode === 'dark', own));
        const name = id === 'default' ? theme.label : `${theme.label} / ${theme.palettes!.find((item) => item.id === id)!.label}`;
        const at = { themeId: theme.id, paletteId: id, mode };
        return CONTRAST_PAIRS.flatMap(([foreground, background, needs, what]): ThemeFinding[] => {
          const a = palette[foreground],
            b = palette[background];
          // A page the colour of its panels is one ground, and one warning; a field the colour of its panel the same.
          if (!a || !b || ((background === 'ground' || background === 'field') && b === palette.surface)) return [];
          // With no edge there is no edge to measure: the fill's own distance from its grounds is (stateFindings).
          if (background === 'field' && foreground === 'lineControl' && palette.rulesControl === '0px') return [];
          const foregroundColor = diagnosticColor(a),
            backgroundColor = diagnosticColor(b);
          if (!foregroundColor || !backgroundColor) return [];
          const ratio = measuredContrast(foregroundColor, backgroundColor);
          if (ratio === undefined || (!all && ratio >= needs)) return [];
          const rule =
            needs === 4.5
              ? 'normal text needs 4.5:1'
              : foreground.startsWith('chart')
                ? 'a chart series needs 3:1'
                : foreground === 'focus'
                  ? 'the focus ring needs 3:1'
                  : "a form control's edge needs 3:1";
          return [
            {
              ...at,
              token: foreground,
              check: `${foreground} on ${background}${what ? ` (${what})` : ''}`,
              ratio,
              needs,
              message: `Theme "${name}" (${mode}): ${what ? `${what}, ` : ''}${rolePath(foreground)}/${rolePath(background)} contrast is ${ratio.toFixed(2)}:1; ${rule}.`,
            },
          ];
        }).concat(stateFindings(definition, name, at, palette, all));
      }),
    ),
  );
}

/** Readers can select any offered look, so App-wide overrides are checked on
    built-ins too. Without overrides retain the registered-theme warning scope. */
export function appThemeWarnings(
  themes: readonly ThemeDefinition[],
  own: { accent?: AppAccent; radius?: string; font?: string } = {},
): string[] {
  const warnings = themeWarnings(own.accent ? [...THEME_PRESETS, ...themes] : themes, own);
  const accents =
    typeof own.accent === 'object'
      ? [
          ['accent.light', own.accent.light],
          ['accent.dark', own.accent.dark],
        ]
      : [['accent', own.accent]];
  for (const [key, value] of accents) {
    if (value && /\burl\s*\(/i.test(value)) warnings.push(`App ui.theme.${key}: a CSS image URL is not a color; use a CSS color value.`);
    else if (value && !diagnosticColor(value))
      warnings.push(
        `App ui.theme.${key}: contrast was not checked for this legacy CSS color; use a hex color for numeric contrast diagnostics.`,
      );
  }
  if (own.radius) {
    const diagnostic = radiusDiagnostic(own.radius);
    if (diagnostic) warnings.push(`App ui.theme.radius: ${diagnostic}`);
  }
  return warnings;
}

/** Recognize literal border-radius syntax only. Expressions remain compatible;
    an unmeasured diagnostic is not a declaration that the browser rejects them. */
function radiusDiagnostic(raw: string): string | undefined {
  const value = raw.trim().toLowerCase();
  if (/^(?:initial|inherit|unset|revert|revert-layer)$/.test(value)) return undefined;
  const unmeasured = 'validity was not checked for this legacy CSS radius expression; verify its computed border-radius in the browser.';
  if (/[()\\]/.test(value)) return unmeasured;
  const groups = value.split('/').map((group) => group.trim().split(/\s+/));
  if (groups.length > 2 || groups.some((group) => group.length > 4 || !group[0])) return unmeasured;
  for (const token of groups.flat()) {
    const literal = /^([+-]?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?)([a-z]+|%)?$/.exec(token);
    if (!literal) {
      if (/^[a-z-]+$/.test(token)) return 'an unrecognized bare keyword is not a CSS radius; use nonnegative lengths or percentages.';
      return unmeasured;
    }
    const number = Number(literal[1]);
    const unit = literal[2];
    // Unknown/future units are not rejected by this deliberately bounded check.
    if (
      unit &&
      !/^(?:%|px|cm|mm|q|in|pt|pc|em|rem|ex|rex|cap|rcap|ch|rch|ic|ric|lh|rlh|(?:s|l|d)?v(?:w|h|i|b|min|max)|cq(?:w|h|i|b|min|max))$/.test(
        unit,
      )
    )
      return unmeasured;
    if (number < 0) return 'a negative radius is not valid CSS; use a nonnegative CSS length.';
    if (!unit && number !== 0) return 'a nonzero unitless radius is not valid CSS; include a CSS length unit or percentage.';
  }
  return undefined;
}

function stateFindings(
  theme: ThemeDefinition,
  name: string,
  at: Pick<ThemeFinding, 'themeId' | 'paletteId' | 'mode'>,
  palette: ThemePalette,
  all: boolean,
): ThemeFinding[] {
  const result: ThemeFinding[] = [];
  const mode = at.mode;
  const recipes = theme.recipes ?? {};
  const color = (key: keyof ThemePalette) => (palette[key] ? diagnosticColor(palette[key]!) : undefined);
  const check = (
    label: string,
    foreground: Color | undefined,
    background: Color | undefined,
    needs = 4.5,
    token?: keyof ThemePalette,
    said?: string,
  ) => {
    if (!foreground || !background) return;
    const ratio = measuredContrast(foreground, background);
    if (ratio === undefined || (!all && ratio >= needs)) return;
    const rule = said ?? (needs === 4.5 ? 'normal text needs 4.5:1' : 'the focus ring needs 3:1');
    result.push({
      ...at,
      token: token ?? (/^[a-zA-Z0-9]+/.exec(label)![0] as keyof ThemePalette),
      check: label,
      ratio,
      needs,
      message: `Theme "${name}" (${mode}): ${label.replace(/^\w+/, rolePath).replace(/\/(\w+)$/, (_, role: string) => `/${rolePath(role)}`)} contrast is ${ratio.toFixed(2)}:1; ${rule}.`,
    });
  };
  const surface = color('surface'),
    subtle = color('raised'),
    text = color('ink');
  /* A field with no edge (shape.border.control 0px) is told from the page by its fill alone, so the fill must stand
     apart from both grounds it sits on (EDGELESS_FIELD_DELTA says how far). A field that names no fill is the surface,
     which is no distance from the surface at all. */
  if (palette.rulesControl === '0px')
    for (const ground of ['ground', 'surface'] as const) {
      if (ground === 'ground' && (!palette.ground || palette.ground === palette.surface)) continue;
      check(
        `field/${ground}`,
        color('field') ?? surface,
        color(ground),
        EDGELESS_FIELD_DELTA,
        'field',
        `a field with no edge (shape.border.control 0px) must stand ${EDGELESS_FIELD_DELTA}:1 apart from the ${ground} by its fill, so give colors.field a fill that does or keep a 1px edge`,
      );
    }
  /* The hover and row ground (--raised) carries every kind of text a row
     holds, not only the full ink the pair list checks there: a muted date, a
     faint count, a link. */
  for (const key of ['inkMuted', 'inkSubtle'] as const) check(`${key}/raised`, color(key), subtle);
  /* A tone chip (features.css .tone-*) writes 78% of the meaning colour into
     the text ink, on a 12% tint of it over the panel. Neither end of that is
     a palette colour, so no pair above could see it. */
  for (const role of ['statusGood', 'statusWarning', 'statusCritical', 'statusInfo'] as const) {
    const ink = color(role);
    if (!ink || !text || !surface) continue;
    check(`${role} tone chip`, mixColor(ink, text, 0.78), over(mixColor(ink, [0, 0, 0, 0], 0.12), surface));
  }
  /* A series is drawn as words and marks too, mixed into the ink (componentInks): measured as each is drawn. */
  for (const item of componentInks(palette, recipes))
    check(
      `${item.role} as ${item.what}`,
      diagnosticColor(item.fg),
      diagnosticColor(item.bg),
      item.needs,
      item.role,
      item.needs === 3 ? 'a mark needs 3:1' : undefined,
    );
  /* A danger banner (a page's errors, pending edits) writes the danger colour
     on a 10% tint of it mixed into the panel. */
  const danger = color('statusCritical');
  if (danger && surface) check('statusCritical/danger banner', danger, mixColor(danger, surface, 0.1));
  /* A matrix's heaviest cell says its figure in the ink on the accent's tint, drawn no stronger than heatTop allows:
     only a palette whose ink is too near its accent for even the floor's tint is short here. */
  const accent = color('accent');
  if (accent && surface)
    check(
      "ink/accent's heat tint (a matrix's heaviest cell)",
      text,
      over(mixColor(accent, [0, 0, 0, 0], heatTop(palette)), surface),
      4.5,
      'accent',
    );
  /* A printed page is white paper whatever the page's ground (style.css's print layer), so a light palette's accent
     and links are read there too: one drawn for a dark "light" mode reads on its panel and vanishes on paper (C12).
     A theme that says it is dark has no light palette to be read as paper: its one set of colors is judged as dark. */
  if (mode === 'light' && theme.scheme !== 'dark-only')
    for (const key of ['accentInk', 'link'] as const) {
      /* Darker than its panel, a color reads better on paper than there: the panel's own pair already says it. */
      const value = palette[key];
      const hex = (css: string | undefined) => css !== undefined && /^#[0-9a-f]{6}$/i.test(css);
      if (!hex(value) || !hex(palette.surface) || contrastRatio(value!, '#ffffff') < contrastRatio(palette.surface!, '#ffffff'))
        check(`${key} on printed paper`, color(key), [1, 1, 1, 1], 4.5, key);
    }
  const soft = color('accentSoft');
  for (const ground of ['surface', 'ground'] as const) {
    const base = color(ground);
    if (ground === 'ground' && palette.ground === palette.surface) continue;
    // Selected menu items and pressed controls use accent ink on this tint.
    check(`accentInk/accentSoft over ${ground}`, color('accentInk'), soft && base ? over(soft, base) : undefined);
  }
  // A chosen row, a chosen card and a current step keep their words in the ink on that tint.
  check('ink/accentSoft over surface (a chosen row)', text, soft && surface ? over(soft, surface) : undefined);
  const nav = color('navGround'),
    navInk = color('navInk');
  // visualThemes.css topbar item hover/current and expanded group overlays.
  const navGround = (weight: number) => (nav && navInk ? over(mixColor(navInk, [0, 0, 0, 0], weight), nav) : undefined);
  check('navAccent/navigation hover', color('navAccent'), navGround(0.05));
  // The current entry's block, when a theme names one: its words on it (structure.css).
  if (palette.navCurrent) check('navOnCurrent/navCurrent', color('navOnCurrent') ?? navInk, color('navCurrent'));
  check('navInk/navigation expanded', navInk, navGround(0.07));
  /* The pill menu marks its current entry with the accent's tint, laid on the menu's own ground, in the menu's
     accent (lumenLook.css --current-ground): a pair neither the menu's nor the page's checks see. A theme that
     names its own block (nav.current) is measured on that instead. */
  if (recipes.nav === 'pill' && !palette.navCurrent)
    check(
      "navAccent/accentSoft over navGround (the pill menu's current entry)",
      color('navAccent'),
      soft && nav ? over(soft, nav) : undefined,
    );
  /* The search is a field on the surface in the page's ink (themeFamilies.css), a pair the page's checks read; the
     dark bar alone draws it on an 8% ink tint of its own ground in its muted ink (brandLook.css). */
  if (recipes.bar === 'dark') check('navMuted/navigation search', color('navMuted'), navGround(0.08));
  /* The dark bar draws its keys — New, the customer chooser — on the same tint in the menu's ink (brandLook.css), and
     a phone's menu, search and New marks in its muted ink on its ground (visualThemes.css, structure.css): until
     0.9.6 those stayed the page's keys and greys, about 1.5:1 on a green menu, and no pair here read them. */
  if (recipes.bar === 'dark') check('navInk/navigation bar button', navInk, navGround(0.08));
  if (recipes.table === 'tinted') {
    const accent = color('accent'),
      surface = color('surface');
    const hover = accent && surface ? mixColor(accent, surface, 0.04) : undefined;
    check('ink/tinted row hover', color('ink'), hover);
    check('link/tinted row hover', color('link'), hover);
  }
  /* A banded table lays every other row on the band (brandLook.css): whatever a row says is said on it. */
  if (recipes.table === 'banded' && palette.band)
    for (const key of [
      'ink',
      'inkMuted',
      'inkSubtle',
      'link',
      'accentInk',
      'statusGood',
      'statusWarning',
      'statusCritical',
      'statusInfo',
    ] as const)
      check(`${key}/band`, color(key), color('band'), 4.5, 'band');
  /* A pattern is the theme's line color at its strength over the ground it is drawn on (surfacesLook.css): the words
     on the page, or in the menu, are measured where a line crosses under them, the darkest point of it. */
  const patterned = (place: 'ground' | 'nav') => {
    const pattern = theme.surface?.[place];
    if (!pattern) return;
    const line = color(place === 'nav' ? 'navLine' : 'line') ?? color('line');
    const ground = place === 'nav' ? color('navGround') : (color('ground') ?? surface);
    if (!line || !ground) return;
    const under = over(mixColor(line, [line[0], line[1], line[2], 0], patternStrength(pattern)), ground);
    const where = place === 'nav' ? `the menu's ${pattern.kind} pattern` : `the page's ${pattern.kind} pattern`;
    const inks = place === 'nav' ? (['navInk', 'navMuted'] as const) : (['ink', 'inkMuted', 'inkSubtle', 'link', 'accentInk'] as const);
    for (const key of inks) check(`${key} on ${where}`, color(key), under, 4.5, place === 'nav' ? 'navLine' : 'line');
  };
  patterned('ground');
  patterned('nav');
  /* A part's words on its ground (theme-part): its own ink on its own ground, or the one it is drawn on unsaid. */
  for (const [part, style] of Object.entries(theme.parts ?? {})) {
    if (!style || (style.ground === undefined && style.ink === undefined)) continue;
    const ink = style.ink ? pathRole(style.ink) : partInk(part);
    const ground = style.ground ? pathRole(style.ground) : partGround(part, palette);
    if (!ink || !ground) continue;
    const said = (role: string) => rolePath(role);
    const label = `parts.${part}: ${ink} on ${ground}`;
    const foreground = color(ink as keyof ThemePalette),
      background = color(ground as keyof ThemePalette);
    if (!foreground || !background) continue;
    const ratio = measuredContrast(foreground, background);
    if (ratio === undefined || (!all && ratio >= 4.5)) continue;
    result.push({
      ...at,
      token: (style.ground ? ground : ink) as keyof ThemePalette,
      check: label,
      ratio,
      needs: 4.5,
      message: `Theme "${name}" (${mode}): parts.${part}: ${said(ink)} on ${said(ground)} contrast is ${ratio.toFixed(2)}:1; normal text needs 4.5:1.`,
    });
  }
  return result;
}

/** The ink a part's words are drawn in when its style says none: the menu's for the menu's parts, the link's for a
    link; a primary button's is the ink drawn on the accent fill. */
function partInk(part: string): string | undefined {
  if (part === 'button.primary') return 'onAccent';
  if (/^(?:nav|bar|logo)\b/.test(part)) return 'navInk';
  return part === 'link' ? 'link' : 'ink';
}
/** The ground a part is drawn on when its style says none. */
function partGround(part: string, palette: ThemePalette): string {
  if (/^(?:nav|bar|logo)\b/.test(part)) return 'navGround';
  if (part === 'button.primary') return 'accent';
  return (part === 'ground' || part === 'page.title') && palette.ground ? 'ground' : 'surface';
}
