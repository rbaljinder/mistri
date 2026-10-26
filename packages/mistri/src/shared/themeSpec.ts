/**
 * `defineTheme`: a theme by purpose — colors for what they are for, a shape, a
 * type, a density and a pick from a closed menu of treatments — compiled to the
 * ThemeDefinition every surface already wears. The built-in looks are written in
 * it (themePresets.ts), so the menu is exactly what they do and an App's theme
 * can only ask for what one of them already draws. There is no CSS in a theme:
 * each recipe is a `data-look-<part>` attribute the shipped sheets answer.
 *
 * This module checks; themeBuild.ts builds. The built-in looks are built there
 * without these checks, because the browser wears them at first paint and the
 * checks' messages are weight no reader needs; test/theme-spec.test.ts holds
 * every built-in to them. An App's or a tenant's theme comes through here.
 */
import type {
  ThemeColorsOver,
  ThemeDefinition,
  ThemeDensity,
  ThemePalette,
  ThemePaletteVariant,
  ThemeSpec,
} from '@mistriwork/engine/schema/theme.js';
import { buildTheme, COLOR_ROLES } from './themeBuild.js';
import {
  BORDER_MENU,
  CONTROL_HEIGHT,
  controlHeightFits,
  cornerFits,
  RADIUS_MAX,
  ROUND_CORNERS,
  rolePath,
} from '@mistriwork/engine/shared/themeTokens.js';
import {
  DENSITIES,
  ELEVATIONS,
  LIFTS,
  MOTIONS,
  RECIPE_MENU,
  RECIPES_RENAMED,
  RHYTHMS,
  RECIPE_PARTS,
  type ResolvedRecipes,
} from '@mistriwork/engine/shared/themeRecipes.js';
import { TYPE_MOVED, typeOf } from '@mistriwork/engine/shared/themeType.js';
import { parseScheme, THEME_PRESETS, themePreset } from '@mistriwork/engine/shared/themePresets.js';
import { iconsOf, partsOf, surfaceOf } from '@mistriwork/engine/shared/themePartsCheck.js';

/* ---------- colors: names by purpose, and the roles they fill ---------- */

/** The spec's name for a role, for a message an author can act on: `status.critical`, not `statusCritical`. */
export function colorPath(role: string): string {
  return rolePath(role);
}

const HEX = /^#[0-9a-f]{6}$/i;
const GROUPS = {
  status: ['good', 'warning', 'critical', 'info'],
  nav: ['ground', 'ink', 'muted', 'line', 'accent', 'current', 'onCurrent'],
  rules: ['section', 'head'],
} as const;
const FLAT = [
  'ground',
  'surface',
  'field',
  'raised',
  'ink',
  'inkMuted',
  'inkSubtle',
  'line',
  'lineStrong',
  'lineControl',
  'accent',
  'onAccent',
  'accentInk',
  'accentSoft',
  'primary',
  'onPrimary',
  'link',
  'focus',
  'shadow',
  'band',
];

/** The names a color went by before the spec's were the only ones (0.9.2): the palette's, which the sheets and the
    compiled theme used. There is one name per color now, and a theme that says an old one is told the new. */
const OLD_NAMES: Readonly<Record<string, string>> = {
  background: 'ground',
  subtle: 'raised',
  border: 'line',
  borderStrong: 'lineStrong',
  borderControl: 'lineControl',
  text: 'ink',
  textMuted: 'inkMuted',
  textSubtle: 'inkSubtle',
  positive: 'status.good',
  warning: 'status.warning',
  negative: 'status.critical',
  key: 'status.info',
  navSurface: 'nav.ground',
  navText: 'nav.ink',
  navMuted: 'nav.muted',
  navBorder: 'nav.line',
  navAccent: 'nav.accent',
  navCurrent: 'nav.current',
  navCurrentText: 'nav.onCurrent',
  sectionRule: 'rules.section',
  headRule: 'rules.head',
  ruleWeight: 'rules.weight',
};
/** The widths that were colors' neighbors until 0.9.4: a rule's and a control's edge are shape, said once for both modes. */
const MOVED_TO_SHAPE: Readonly<Record<string, string>> = { weight: 'shape.border.rule', control: 'shape.border.control' };
function renamed(colors: Record<string, unknown>, where: string) {
  for (const key of Object.keys(colors))
    if (Object.hasOwn(OLD_NAMES, key)) throw new Error(`${where}.${key} is now ${where}.${OLD_NAMES[key]}.`);
  /* Renamed before 1.0: words on a fill are `on<Fill>` (onAccent), and `<color>Ink` is a color used as text (accentInk). */
  const nav = colors.nav;
  if (nav && typeof nav === 'object' && Object.hasOwn(nav, 'currentInk'))
    throw new Error(`${where}.nav.currentInk is now ${where}.nav.onCurrent: the words on nav.current.`);
  const rules = colors.rules;
  if (rules && typeof rules === 'object')
    for (const key of Object.keys(rules))
      if (Object.hasOwn(MOVED_TO_SHAPE, key)) throw new Error(`${where}.rules.${key} is now ${MOVED_TO_SHAPE[key]}.`);
}

function record(raw: unknown, where: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where} must be an object.`);
  return raw as Record<string, unknown>;
}
function only(raw: Record<string, unknown>, keys: readonly string[], where: string) {
  for (const key of Object.keys(raw)) if (!keys.includes(key)) throw new Error(`${where} has no "${key}". It takes: ${keys.join(', ')}.`);
}
function hex(value: unknown, where: string): string {
  if (typeof value !== 'string' || !HEX.test(value.trim())) throw new Error(`${where} must be a six-digit hex color like #1d4ed8.`);
  return value.trim().toLowerCase();
}

/** One mode's colors, by purpose, to roles. `required` names the four a theme that extends nothing must say. */
function colorsToRoles(raw: unknown, where: string, required: boolean): Partial<ThemePalette> {
  if (raw === undefined && !required) return {};
  const colors = record(raw, where);
  renamed(colors, where);
  only(colors, [...FLAT, 'status', 'nav', 'rules', 'chart'], where);
  const out: Partial<Record<keyof ThemePalette, string>> = {};
  for (const [path, role] of COLOR_ROLES) {
    const [group, key] = path.split('.') as [string, string | undefined];
    if (path.startsWith('chart[')) continue;
    if (key === undefined) {
      if (colors[group] !== undefined) out[role] = hex(colors[group], `${where}.${group}`);
      continue;
    }
    const inner = colors[group];
    if (inner === undefined) continue;
    const values = record(inner, `${where}.${group}`);
    only(values, GROUPS[group as keyof typeof GROUPS], `${where}.${group}`);
    if (values[key] === undefined) continue;
    out[role] = hex(values[key], `${where}.${path}`);
  }
  if (colors.chart !== undefined) {
    if (!Array.isArray(colors.chart) || colors.chart.length > 8) throw new Error(`${where}.chart must be at most eight colors.`);
    colors.chart.forEach((value, index) => {
      if (value === null && !required) return;
      out[`chart${index + 1}` as keyof ThemePalette] = hex(value, `${where}.chart[${index}]`);
    });
  }
  if (required)
    for (const key of ['ground', 'surface', 'ink', 'accent'])
      if (colors[key] === undefined) throw new Error(`${where}.${key} is required.`);
  /* The words on a fill are said with the fill: on their own they would sit on whichever color a look chose. */
  if (colors.onPrimary !== undefined && colors.primary === undefined)
    throw new Error(`${where}.onPrimary is the words on ${where}.primary: name primary beside it.`);
  return out as Partial<ThemePalette>;
}

/* ---------- the spec ---------- */

const THEME_ID = /^[a-z][a-z0-9-]{0,47}$/;

const FONT = /^[\w\s'",.-]+$/;
const SPEC_KEYS = [
  'kind',
  'id',
  'label',
  'extends',
  'colors',
  'palettes',
  'defaultPalette',
  'scheme',
  'shape',
  'type',
  'density',
  'motion',
  'rhythm',
  'recipes',
  'shell',
  'surface',
  'parts',
  'stylesheet',
  'contract',
  'from',
];

/** The theme contract this mistri reads (docs: theme-contract). A package says the one it was written to. */
const THEME_CONTRACT = 1;
/* A stylesheet beside the theme, downward only: `./theme.css`, `./looks/ledger.css`. The server holds the resolved
   file to the theme's directory as well (appBrand.ts), so a link out of it is refused there. */
const SHEET_SRC = /^\.\/(?:[\w.-]+\/)*[\w.-]+\.css$/;

/**
 * The directory a theme's files are read from (its faces and its stylesheet), where it is not the App's: a package's,
 * from its `from`. Kept here rather than on the definition, which is sent to the browser and written into a build:
 * a path on the machine is neither's to carry. Keyed by the face or the stylesheet record, so one inherited from a
 * package's theme is read from the package.
 */
const FILE_ROOTS = new WeakMap<object, string>();
export function themeFileRoot(file: object): string | undefined {
  return FILE_ROOTS.get(file);
}
/** The theme a compiled theme extends when that is a theme value (`extends: ledger`), for the validator. */
const PARENTS = new WeakMap<ThemeDefinition, ThemeDefinition>();
function themeParent(theme: ThemeDefinition): ThemeDefinition | undefined {
  return PARENTS.get(theme);
}

/** A theme spec checked and compiled. `builtIn` resolves `extends`; `reserved` are ids it may not take. */
export function compileTheme(
  raw: unknown,
  where: string,
  builtIn: (id: string) => ThemeDefinition | undefined,
  reserved: ReadonlySet<string> = new Set(),
  options: ThemeCompileOptions = {},
): ThemeDefinition {
  const spec = record(raw, where) as Record<string, unknown> & Partial<ThemeSpec>;
  // The key was `palette` until 1.0; `palettes` and `ui.theme.palette` name variations, so the colors moved out of their way.
  if ('palette' in spec) throw new Error(`${where}.palette is now colors: { light, dark }.`);
  only(spec, SPEC_KEYS, where);
  if (spec.kind !== undefined && spec.kind !== 'theme') throw new Error(`${where}.kind must be "theme" (write it with defineTheme).`);
  if (typeof spec.id !== 'string' || !THEME_ID.test(spec.id) || reserved.has(spec.id))
    throw new Error(`${where}.id must be a unique lowercase slug, not a built-in look's name.`);
  if (typeof spec.label !== 'string' || !spec.label.trim() || spec.label.trim().length > 60)
    throw new Error(`${where}.label must have 1 to 60 characters.`);
  /* A package's theme says the contract it was written to, and where its files are (theme-contract). */
  if (spec.contract !== undefined && spec.contract !== THEME_CONTRACT)
    throw new Error(
      `${where}.contract is ${JSON.stringify(spec.contract)}: this mistri reads theme contract ${THEME_CONTRACT}, and a theme written to another is refused. Use the package's release for contract ${THEME_CONTRACT}, or upgrade mistri.`,
    );
  let root: string | undefined;
  if (spec.from !== undefined) {
    if (typeof spec.from !== 'string' || !spec.from.startsWith('file://'))
      throw new Error(`${where}.from must be the theme module's import.meta.url, a file: URL.`);
    if (spec.contract === undefined)
      throw new Error(
        `${where}.from names a package's directory, and a package says the contract it was written to: contract: ${THEME_CONTRACT}.`,
      );
    if (!options.faces) throw new Error(`${where}.from reads files from a package, and this theme has no server to read them.`);
    root = decodeURIComponent(new URL('.', spec.from).pathname).replace(/\/$/, '');
  }
  let base: ThemeDefinition | undefined;
  if (spec.extends !== undefined && typeof spec.extends === 'object' && spec.extends !== null) {
    /* A theme value (a package's look): itself extending a built-in or nothing, so a chain is two deep at most. */
    const parent = spec.extends as unknown as Record<string, unknown>;
    if (parent.kind !== 'theme') throw new Error(`${where}.extends must name a built-in look or be a theme written with defineTheme.`);
    if (parent.extends !== undefined && typeof parent.extends !== 'string')
      throw new Error(
        `${where}.extends is a theme that extends another theme; a theme extends a built-in look or one theme that extends one, no deeper.`,
      );
    base = compileTheme(parent, `${where}.extends`, builtIn, new Set(['default']), options);
  } else if (spec.extends !== undefined) {
    base = typeof spec.extends === 'string' ? builtIn(spec.extends) : undefined;
    if (!base) throw new Error(`${where}.extends must name a built-in look.`);
  }
  const colors = spec.colors === undefined && base ? {} : record(spec.colors, `${where}.colors`);
  only(colors, ['light', 'dark'], `${where}.colors`);
  const darkOnly = parseScheme(spec.scheme, where) === 'dark-only';
  if (darkOnly && colors.light !== undefined)
    throw new Error(`${where}.colors.light: a dark-only theme has no light colors; name colors.dark alone, or drop scheme: 'dark-only'.`);
  for (const name of darkOnly ? (['dark'] as const) : (['light', 'dark'] as const))
    colorsToRoles(colors[name], `${where}.colors.${name}`, !base);

  const palettes = spec.palettes === undefined ? undefined : variants(spec.palettes, `${where}.palettes`, darkOnly);
  if (
    spec.defaultPalette !== undefined &&
    (typeof spec.defaultPalette !== 'string' ||
      (spec.defaultPalette !== 'default' && !palettes?.some((item) => item.id === spec.defaultPalette)))
  )
    throw new Error(`${where}.defaultPalette must be "default" or one of this theme's palettes.`);

  const shape = spec.shape === undefined ? {} : record(spec.shape, `${where}.shape`);
  only(shape, ['radius', 'elevation', 'border', 'height'], `${where}.shape`);
  if (shape.radius !== undefined) radiiOf(shape.radius, `${where}.shape.radius`);
  if (shape.border !== undefined) bordersOf(shape.border, `${where}.shape.border`);
  if (shape.height !== undefined) {
    const height = record(shape.height, `${where}.shape.height`);
    only(height, ['control'], `${where}.shape.height`);
    if (height.control !== undefined && !controlHeightFits(height.control))
      throw new Error(
        `${where}.shape.height.control must be a length from ${CONTROL_HEIGHT.min}px to ${CONTROL_HEIGHT.max}px, in whole pixels.`,
      );
  }
  if (shape.elevation !== undefined && typeof shape.elevation === 'object') liftsOf(shape.elevation, `${where}.shape.elevation`);
  else if (shape.elevation !== undefined && !Object.hasOwn(ELEVATIONS, shape.elevation as string))
    throw new Error(`${where}.shape.elevation must be one of ${Object.keys(ELEVATIONS).join(', ')}, or { card, float }.`);

  const type = spec.type === undefined ? {} : record(spec.type, `${where}.type`);
  for (const key of ['scale', 'headingWeight'])
    if (key in type) throw new Error(`${where}.type.${key} is now ${where}.${TYPE_MOVED[`type.${key}`]}.`);
  only(type, ['font', 'faces', 'base', 'roles', 'icons'], `${where}.type`);
  if (type.icons !== undefined) iconsOf(type.icons, `${where}.type.icons`);
  if (type.font !== undefined) fontsOf(type.font, `${where}.type.font`);
  if (type.faces !== undefined) {
    /* A face is a file in the App's directory, read and served by the server that loaded the App (appFonts.ts):
       a tenant's saved theme or a host page's has no directory to read it from. */
    if (!options.faces)
      throw new Error(`${where}.type.faces ships font files from an App's directory, and this theme has none to read them from.`);
    facesOf(type.faces, `${where}.type.faces`);
  }
  typeOf(type.base, type.roles, `${where}.type`);
  if (spec.density !== undefined && !DENSITIES.includes(spec.density as ThemeDensity))
    throw new Error(`${where}.density must be one of ${DENSITIES.join(', ')}.`);
  if (spec.motion !== undefined && !Object.hasOwn(MOTIONS, spec.motion as string))
    throw new Error(`${where}.motion must be one of ${Object.keys(MOTIONS).join(', ')}.`);
  if (spec.rhythm !== undefined && !Object.hasOwn(RHYTHMS, spec.rhythm as string))
    throw new Error(`${where}.rhythm must be one of ${Object.keys(RHYTHMS).join(', ')}.`);

  recipesOf(spec.recipes, `${where}.recipes`);
  if (spec.shell !== undefined) {
    const shell = record(spec.shell, `${where}.shell`);
    only(shell, ['placement'], `${where}.shell`);
    if (shell.placement !== undefined && shell.placement !== 'side' && shell.placement !== 'top')
      throw new Error(`${where}.shell.placement must be "side" or "top".`);
  }
  if (spec.surface !== undefined) surfaceOf(spec.surface, `${where}.surface`);
  if (spec.parts !== undefined) partsOf(spec.parts, `${where}.parts`);
  if (spec.stylesheet !== undefined) {
    /* Read, checked against its allowlist and served by the server that loaded the App (appBrand.ts). */
    if (!options.faces) throw new Error(`${where}.stylesheet is a file in an App's directory, and this theme has none to read it from.`);
    if (typeof spec.stylesheet !== 'string' || !SHEET_SRC.test(spec.stylesheet) || spec.stylesheet.split('/').includes('..'))
      throw new Error(`${where}.stylesheet must be a .css file beside the theme, written like "./theme.css".`);
  }
  const built = buildTheme(spec as ThemeSpec, base);
  if (base && typeof spec.extends === 'object') PARENTS.set(built, base);
  /* The files this theme names itself are read from its package, when it is one; inherited ones keep their own. */
  if (root) {
    for (const face of built.faces ?? []) if (!base?.faces?.includes(face)) FILE_ROOTS.set(face, root);
    if (built.stylesheet && built.stylesheet !== base?.stylesheet) FILE_ROOTS.set(built.stylesheet, root);
  }
  return built;
}

function variants(raw: unknown, where: string, darkOnly = false): ThemePaletteVariant[] {
  if (!Array.isArray(raw) || raw.length > 20) throw new Error(`${where} must be at most 20 palettes.`);
  const used = new Set(['default']);
  return raw.map((value, index) => {
    const path = `${where}[${index}]`,
      variant = record(value, path);
    only(variant, ['id', 'label', 'light', 'dark'], path);
    if (typeof variant.id !== 'string' || !THEME_ID.test(variant.id) || used.has(variant.id))
      throw new Error(`${path}.id must be a unique slug, not "default".`);
    used.add(variant.id);
    if (typeof variant.label !== 'string' || !variant.label.trim() || variant.label.trim().length > 60)
      throw new Error(`${path}.label must have 1 to 60 characters.`);
    if (darkOnly && variant.light !== undefined)
      throw new Error(`${path}.light: a dark-only theme has no light colors; name the palette's dark alone.`);
    return {
      id: variant.id,
      label: variant.label.trim(),
      light: colorsToRoles(variant.light, `${path}.light`, false),
      dark: colorsToRoles(variant.dark, `${path}.dark`, false),
    };
  });
}

function radiiOf(raw: unknown, where: string): Record<string, string> {
  if (typeof raw === 'string')
    throw new Error(
      `${where} is { control, field, pill, panel }, each a length (a control's and a pill's may be 'round'); one length is not accepted. Write { control: '${raw}', field: '${raw}' }.`,
    );
  const value = record(raw, where);
  only(value, Object.keys(RADIUS_MAX), where);
  for (const [key, length] of Object.entries(value)) {
    const max = RADIUS_MAX[key as keyof typeof RADIUS_MAX];
    const round = ROUND_CORNERS.has(key);
    if (!(cornerFits(length, max) || (round && length === 'round')))
      throw new Error(`${where}.${key} must be a length from 0px to ${max}px${round ? ", or 'round'" : ''}.`);
  }
  return value as Record<string, string>;
}

/** `{ card, float }`: a step for each, from the platform's lifts (the attribute's `look` is not one an author says). */
function liftsOf(raw: unknown, where: string): void {
  const value = record(raw, where);
  only(value, ['card', 'float'], where);
  const steps = Object.keys(LIFTS).slice(1);
  for (const [key, step] of Object.entries(value))
    if (!steps.includes(step as string)) throw new Error(`${where}.${key} must be one of ${steps.join(', ')}.`);
}

function bordersOf(raw: unknown, where: string): void {
  const value = record(raw, where);
  only(value, Object.keys(BORDER_MENU), where);
  for (const [key, width] of Object.entries(value)) {
    const menu = BORDER_MENU[key as keyof typeof BORDER_MENU] as readonly string[];
    if (!menu.includes(width as string)) throw new Error(`${where}.${key} must be ${menu.slice(0, -1).join(', ')} or ${menu.at(-1)}.`);
  }
}

function fontsOf(raw: unknown, where: string): Partial<Record<'ui' | 'data' | 'heading' | 'code', string>> {
  const ok = (font: unknown): font is string => typeof font === 'string' && font.length > 0 && font.length <= 200 && FONT.test(font);
  if (typeof raw === 'string') {
    if (!ok(raw)) throw new Error(`${where} must be a CSS font-family list (letters, digits, spaces, quotes, commas).`);
    return { ui: raw, data: raw, heading: raw };
  }
  const value = record(raw, where);
  only(value, ['ui', 'data', 'heading', 'code'], where);
  for (const [key, font] of Object.entries(value))
    if (!ok(font)) throw new Error(`${where}.${key} must be a CSS font-family list (letters, digits, spaces, quotes, commas).`);
  return value as Record<string, string>;
}

/** What a compile allows beyond the spec's own rules. */
interface ThemeCompileOptions {
  /** `type.faces`: only an App's own theme, whose files the server reads from its directory. */
  faces?: boolean;
}

/* A family name as an `@font-face` and a stack both say it, quoted: no quote, comma or semicolon to close either. */
const FACE_FAMILY = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$/;
/* Relative to the App's directory, downward only: `./fonts/x.woff2`. The server holds the resolved file to the
   directory as well (appFonts.ts), so a link out of it is refused there. */
const FACE_SRC = /^\.\/(?:[\w.-]+\/)*[\w.-]+\.(?:woff2|woff)$/;
const FACE_WEIGHT = /^[1-9]00(?: [1-9]00)?$/;
/** At most this many faces: a regular, a bold and their italics in each of three families. */
const MAX_FACES = 12;

function facesOf(raw: unknown, where: string) {
  if (!Array.isArray(raw) || raw.length > MAX_FACES) throw new Error(`${where} must be at most ${MAX_FACES} faces.`);
  const seen = new Set<string>();
  raw.forEach((value, index) => {
    const path = `${where}[${index}]`,
      face = record(value, path);
    only(face, ['family', 'src', 'weight', 'style', 'subset'], path);
    if (typeof face.family !== 'string' || !FACE_FAMILY.test(face.family))
      throw new Error(`${path}.family must be a family name of letters, digits, spaces, hyphens or underscores (at most 60).`);
    if (typeof face.src !== 'string' || !FACE_SRC.test(face.src) || face.src.split('/').includes('..'))
      throw new Error(`${path}.src must be a .woff2 or .woff file inside the App's directory, written like "./fonts/face.woff2".`);
    if (
      face.weight !== undefined &&
      !(typeof face.weight === 'number' && Number.isInteger(face.weight) && face.weight >= 100 && face.weight <= 900) &&
      !(typeof face.weight === 'string' && FACE_WEIGHT.test(face.weight))
    )
      throw new Error(`${path}.weight must be 100 to 900, or a variable file's range like "100 900".`);
    if (face.style !== undefined && face.style !== 'normal' && face.style !== 'italic')
      throw new Error(`${path}.style must be "normal" or "italic".`);
    // Latin is the default cut; the one other choice is the whole file.
    if (face.subset !== undefined && face.subset !== false)
      throw new Error(`${path}.subset must be false (ship the file whole), or left out to cut it to Latin.`);
    const key = `${face.family.toLowerCase()} ${String(face.weight ?? 400)} ${String(face.style ?? 'normal')}`;
    if (seen.has(key)) throw new Error(`${path} repeats ${face.family} at that weight and style.`);
    seen.add(key);
  });
}

function recipesOf(raw: unknown, where: string): Partial<ResolvedRecipes> {
  if (raw === undefined) return {};
  const value = record(raw, where);
  for (const [part, pick] of Object.entries(value)) {
    const moved = TYPE_MOVED[`recipes.${part}`];
    if (moved) throw new Error(`${where}.${part} is now ${where.replace(/\.recipes$/, '')}.${moved}.`);
    if (Object.hasOwn(RECIPES_RENAMED, part)) throw new Error(`${where}.${part} is now ${where}.${RECIPES_RENAMED[part]}.`);
    const menu = (RECIPE_MENU as Record<string, Record<string, unknown>>)[part];
    if (!menu) throw new Error(`${where} has no part "${part}". The parts are: ${RECIPE_PARTS.join(', ')}.`);
    if (typeof pick !== 'string' || !Object.hasOwn(menu, pick))
      throw new Error(`${where}.${part} is not on the menu: pick one of ${Object.keys(menu).join(', ')}.`);
  }
  return value as Partial<ResolvedRecipes>;
}

/** A compiled theme's colors back into the spec's words, for the reference and the round-trip test. */
export function rolesToColors(palette: Partial<ThemePalette>): ThemeColorsOver {
  const out: Record<string, unknown> = {};
  for (const [path, role] of COLOR_ROLES) {
    const value = palette[role];
    if (value === undefined) continue;
    const chart = /^chart\[(\d)\]$/.exec(path);
    if (chart) {
      const series = (out.chart ??= []) as (string | null)[];
      while (series.length < Number(chart[1])) series.push(null);
      series[Number(chart[1])] = value;
    } else if (path.includes('.')) {
      const [group, key] = path.split('.') as [string, string];
      ((out[group] ??= {}) as Record<string, string>)[key] = value;
    } else out[path] = value;
  }
  return out as ThemeColorsOver;
}

const BUILT_IN_IDS: ReadonlySet<string> = new Set(['default', ...THEME_PRESETS.map((look) => look.id)]);

/** Which built-in each compiled App theme extends, so the validator holds against its author only the colours they set. */
const EXTENDED = new WeakMap<ThemeDefinition, ThemeDefinition | null>();

/** An App's `defineTheme` result, checked and compiled over the built-in it extends. */
export function compileAppTheme(
  raw: unknown,
  where: string,
  taken: ReadonlySet<string> = new Set(),
  options: ThemeCompileOptions = {},
): ThemeDefinition {
  let extended: ThemeDefinition | null = null;
  const theme = compileTheme(
    raw,
    where,
    (id) => {
      extended = BUILT_IN_IDS.has(id) ? (themePreset(id) ?? null) : null;
      return extended ?? undefined;
    },
    new Set([...BUILT_IN_IDS, ...taken]),
    options,
  );
  EXTENDED.set(theme, themeParent(theme) ?? extended);
  /* The spec as written, for what a check suggests in its words and where `check --fix` writes (themeFix.ts). */
  /* The ids taken then, copied: the caller goes on to add this theme's own, which a variation must still be allowed. */
  SPECS.set(theme, { raw: raw as ThemeSpec, where, taken: new Set(taken), options });
  return theme;
}

/** Each compiled App theme's spec and how it was compiled, so a fix can be tried by compiling the spec again. */
const SPECS = new WeakMap<ThemeDefinition, { raw: ThemeSpec; where: string; taken: ReadonlySet<string>; options: ThemeCompileOptions }>();

/** The spec a compiled App theme came from, and how to compile a variation of it; undefined for a theme not compiled here. */
export function themeSpecOf(
  theme: ThemeDefinition,
): { raw: ThemeSpec; where: string; taken: ReadonlySet<string>; options: ThemeCompileOptions } | undefined {
  return SPECS.get(theme);
}

/** The built-in a compiled App theme extends: `null` for one that extends nothing, `undefined` for a theme not compiled here. */
export function themeExtends(theme: ThemeDefinition): ThemeDefinition | null | undefined {
  return EXTENDED.get(theme);
}
