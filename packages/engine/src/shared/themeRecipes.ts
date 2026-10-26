/**
 * The recipe menu: every part a theme may dress, the treatments it may pick,
 * and the `data-look-*` attributes a worn theme sets on the root. The browser
 * needs this at first paint and nothing else of the theme machinery, so it is
 * a module of its own: a module a first-paint file imports is in the first
 * paint whole.
 */
import type {
  ThemeDefinition,
  ThemeDensity,
  ThemeElevation,
  ThemeLift,
  ThemeMotion,
  ThemeRhythm,
  ThemePart,
  ThemePartStyle,
  ThemeRecipes,
  ThemeTypeDefinition,
  ThemeTypeRole,
  ThemeTypeRoleDefinition,
} from '../../schema/theme.js';
/**
 * Every part a theme may dress and the treatments it may pick, and the sheet
 * its rules live in: `null` is the first stylesheet (themeFamilies.css,
 * kit.css), a name is a sheet of its own, fetched when a worn theme picks the
 * value (visualTheme.ts): a built-in look's, or `brand`, the few treatments
 * no built-in wears that an App's own theme may (a bar in its colour, a
 * printed page's rules and small capitals; docs/theming.md). The first value
 * is the default and has no rules of its own. test/theme-recipes.test.ts
 * holds the sheets to this: every `data-look-*` value they answer is here, in
 * its sheet.
 */
export const RECIPE_MENU = {
  nav: { tint: null, inverted: null, wash: 'brand', underline: 'brand', pill: 'lumen', quiet: 'sage' },
  bar: { plain: null, ruled: null, dark: 'brand', airy: 'lumen', soft: 'sage' },
  tabs: { pill: null, inverted: null, underline: 'lumen', rule: 'brand', chosen: 'sage' },
  windows: { segmented: null, lifted: 'lumen', chosen: 'sage' },
  stat: { plain: null, framed: null, topline: 'brand', ruled: 'brand', icon: 'lumen', panel: 'sage', divided: 'lumen' },
  section: { open: null, card: 'lumen', panel: 'sage' },
  fields: { open: null, panel: 'sage', card: 'lumen', rail: 'lumen' },
  table: { open: null, tinted: 'brand', hairline: 'sage', card: 'lumen', quiet: 'lumen', banded: 'brand' },
  status: { dot: null, pill: 'sage', 'pill-dot': 'lumen', quiet: 'lumen' },
  board: { ruled: null, soft: 'sage', strip: 'lumen' },
  chart: { plain: null, wash: 'sage', gradient: 'lumen', line: 'lumen' },
  buttons: { accent: null, raised: 'lumen' },
  links: { plain: null, underline: null },
  rules: { ink: null, hairline: null },
  avatar: { plain: null, large: 'sage', round: 'lumen' },
  workflow: { markers: null, pills: 'lumen' },
  banner: { tint: null, gradient: 'lumen', plain: 'lumen' },
  steps: { flat: null, tinted: 'lumen', strip: 'lumen' },
  lanes: { tint: null, tag: 'brand', plain: 'brand' },
  header: { plain: null, band: null, hero: null },
  /* The four below are a form's: their rules are in @mistriwork/ui's forms.css, which arrives with the first control
     a page draws, so no first stylesheet carries them and the menu names no sheet of a look. */
  required: { star: null, 'optional-word': null },
  checkbox: { native: null, drawn: null },
  formStep: { plain: null, ruled: null },
  actionBar: { plain: null, raised: null },
} as const satisfies Record<keyof ThemeRecipes, Record<string, string | null>>;

/** Recipe parts renamed before 1.0, refused with the new name: "head" is a table's column heads (`rules.head`). */
export const RECIPES_RENAMED: Readonly<Record<string, string>> = { head: 'header' };

/** Shape rides the same attributes (`data-look-elevation`); type rides its own (`data-type-<role>`, themeType.ts). */
export const ELEVATIONS = { hairline: null, flat: null, soft: 'sage', raised: 'lumen' } as const satisfies Record<
  ThemeElevation,
  string | null
>;
export const DENSITIES: readonly ThemeDensity[] = ['compact', 'comfortable', 'spacious'];
/** The lifts (`data-look-card`, `data-look-float`): `look` is the elevation's own drawing, then each step, drawn in
    the theme's shadow colour (themeFamilies.css). */
export const LIFTS = { look: null, none: null, hairline: null, low: null, mid: null, high: null } as const satisfies Record<
  'look' | ThemeLift,
  string | null
>;
/** The paces (`data-look-motion`): each is the house's five durations, quickened or silenced, in themeFamilies.css. */
export const MOTIONS = { house: null, brisk: null, still: null } as const satisfies Record<ThemeMotion, string | null>;
/** The rhythms (`data-look-rhythm`): the space scale's layout steps, closer or wider, in themeFamilies.css. */
export const RHYTHMS = { house: null, tight: null, airy: null } as const satisfies Record<ThemeRhythm, string | null>;
/** A part's root attribute: `data-look-nav`, and for a part of two words `data-look-form-step`, since an attribute
    name is read in lower case and `formStep` would not be found by `[data-look-formStep]` in every context. */
export const lookAttribute = (part: string) => `data-look-${part.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
export const RECIPE_PARTS = Object.keys(RECIPE_MENU) as (keyof ThemeRecipes)[];

export type ResolvedRecipes = { [K in keyof ThemeRecipes]-?: NonNullable<ThemeRecipes[K]> };

/** Every part at its first value: the plain structure a theme that extends nothing starts from. */
export const DEFAULT_RECIPES = Object.fromEntries(RECIPE_PARTS.map((part) => [part, Object.keys(RECIPE_MENU[part])[0]])) as ResolvedRecipes;

/** The attributes a worn theme sets on the root, and the look sheets they need. */
export function recipeAttributes(
  theme: ThemeDefinition,
  lookNav?: ThemeTypeRoleDefinition,
): { attributes: Record<string, string>; sheets: string[] } {
  const recipes = { ...DEFAULT_RECIPES, ...theme.recipes };
  const attributes: Record<string, string> = {};
  const sheets = new Set<string>();
  for (const part of RECIPE_PARTS) {
    const value = recipes[part];
    attributes[lookAttribute(part)] = value;
    const sheet = (RECIPE_MENU[part] as Record<string, string | null>)[value];
    if (sheet) sheets.add(sheet);
  }
  const elevation = theme.elevation ?? 'hairline';
  attributes['data-look-elevation'] = elevation;
  attributes['data-look-motion'] = theme.motion ?? 'house';
  attributes['data-look-rhythm'] = theme.rhythm ?? 'house';
  /* A shadow colour of the theme's own under the platform's hairline draws the platform's popups in it: its low step,
     the house geometry mixed from the theme's shadow rather than the house's black. */
  const ownShadow = Boolean(theme.light.shadow || theme.dark.shadow) && elevation === 'hairline';
  attributes['data-look-card'] = theme.lifts?.card ?? 'look';
  attributes['data-look-float'] = theme.lifts?.float ?? (ownShadow ? 'low' : 'look');
  const lifted = ELEVATIONS[elevation];
  if (lifted) sheets.add(lifted);
  Object.assign(attributes, typeAttributes(theme.type));
  const side = sideNavWords(theme.type, lookNav);
  if (side.length) attributes['data-type-nav-side'] = side.join(' ');
  const bar = barGround(theme, recipes.bar);
  if (bar) attributes['data-bar-ground'] = bar;
  /* What a theme says beyond the menu (themeParts.ts): each an attribute only where it is said, and its sheet. */
  const parts = partAttribute(theme.parts);
  if (parts) {
    attributes['data-parts'] = parts;
    sheets.add('parts');
  }
  for (const place of ['ground', 'nav'] as const) {
    const pattern = theme.surface?.[place];
    if (!pattern) continue;
    attributes[`data-surface-${place}`] = `${pattern.kind} ${pattern.strength ?? 1}`;
    sheets.add('surfaces');
  }
  if (theme.icons && theme.icons !== 'regular') attributes['data-icons'] = theme.icons;
  return { attributes, sheets: [...sheets] };
}

/** Whether a color is dark: nearer black than white for text drawn on it (WCAG's luminance, its even point). */
function dark(hex: string | undefined): boolean | undefined {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return undefined;
  const [r, g, b] = [1, 3, 5].map((start) => {
    const value = parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! < 0.179;
}

/**
 * The bar's ground against the reader's mode, where they disagree: `light:dark` a dark bar by day, `dark:light` a
 * light one by night. The logo is drawn on the bar, so its picture is chosen by the bar's ground (appBrand.css): a
 * light-mode App with an inverted bar wears the night picture there. Undefined where each mode's bar is its mode's.
 */
function barGround(theme: ThemeDefinition, bar: string): string | undefined {
  /* A soft bar is drawn on the page's surface (sageLook.css); every other on the navigation's ground. */
  const ground = (mode: 'light' | 'dark') => dark(bar === 'soft' ? theme[mode].surface : (theme[mode].navGround ?? theme[mode].surface));
  const words = [...(ground('light') ? ['light:dark'] : []), ...(ground('dark') === false ? ['dark:light'] : [])];
  return words.length ? words.join(' ') : undefined;
}

/** The type roles in their attribute order (themeType.ts holds what each takes; test/theme-type.test.ts holds the two
    lists to one). */
const TYPE_ROLE_ORDER: readonly ThemeTypeRole[] = ['display', 'title', 'heading', 'section', 'body', 'label', 'data', 'figure', 'nav'];
/** The features `font-variant-numeric` says, worn as a role's `numeric`; the rest are its `features`. */
const NUMERIC_FEATURES: ReadonlySet<string> = new Set(['lnum', 'onum', 'tnum', 'zero']);
export const TYPE_ATTRIBUTES = [...TYPE_ROLE_ORDER.map((name) => `data-type-${name}`), 'data-type-nav-side'];

/** Each role's `data-type-<role>` attribute: the properties it says, and its capitals. A role that says nothing has
    none, so no rule of its turns on. A title's weight is `--heading-weight`, which every heading reads, so it is no
    word here. */
export function typeAttributes(type: ThemeTypeDefinition | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of TYPE_ROLE_ORDER) {
    const words = roleWords(name, type?.roles?.[name]);
    if (words.length) out[`data-type-${name}`] = words.join(' ');
  }
  return out;
}

function roleWords(name: ThemeTypeRole, role: ThemeTypeRoleDefinition | undefined): string[] {
  const words: string[] = [];
  if (!role) return words;
  for (const property of ['face', 'size', 'leading', 'tracking', 'weight'] as const)
    if (role[property] !== undefined && !(property === 'weight' && name === 'title')) words.push(property);
  if (role.features?.some((feature) => NUMERIC_FEATURES.has(feature))) words.push('numeric');
  if (role.features?.some((feature) => !NUMERIC_FEATURES.has(feature))) words.push('features');
  if (role.case && role.case !== 'none') words.push(role.case);
  if (role.reach === 'figures') words.push('figures');
  return words;
}

/**
 * What the theme itself says of the nav role, beyond what its base look already says: `data-type-nav-side`, which
 * dresses the side menu's entries. The compiled theme carries the look's roles merged under its own, and a look that
 * sets nav (Mono's mono capitals) dresses the bar's entries only, as it always did; the side menu keeps the look's
 * face until a theme sets the role itself. Compared per property, so a theme that only changes the weight does not
 * bring the look's capitals down the side.
 */
function sideNavWords(type: ThemeTypeDefinition | undefined, lookNav: ThemeTypeRoleDefinition | undefined): string[] {
  const role = type?.roles?.nav;
  if (!role) return [];
  const own: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(role))
    if (JSON.stringify(value) !== JSON.stringify((lookNav as Record<string, unknown> | undefined)?.[key])) own[key] = value;
  return roleWords('nav', own as ThemeTypeRoleDefinition);
}

/**
 * The published parts a theme may dress one by one (themeParts.ts says what each may take and how it is worn). Here,
 * with the words the root wears for them, because the first paint sets `data-parts` as it sets the recipes'.
 */
export const THEME_PARTS = [
  'ground',
  'bar',
  'bar.search',
  'nav',
  'nav.item',
  'nav.current',
  'nav.group',
  'logo',
  'page.title',
  'tabs',
  'tab.current',
  'section',
  'section.title',
  'stat',
  'stat.figure',
  'fields',
  'field.label',
  'table',
  'table.head',
  'table.row',
  'status',
  'tag',
  'button.primary',
  'button.secondary',
  'button.quiet',
  'link',
  'board.lane',
  'board.card',
  'workflow.step',
  'banner',
  'steps.step',
  'avatar',
  'menu',
  'dialog',
  'chart',
] as const satisfies readonly ThemePart[];

/** What a part style may say, in the order its words are written. */
export const PART_PROPERTIES = ['ground', 'ink', 'edge', 'radius', 'lift', 'face', 'weight', 'case'] as const;

/** The root's `data-parts`: one word per property a part says (`stat:ground button.primary:case`); undefined when none. */
export function partAttribute(parts: Partial<Record<ThemePart, ThemePartStyle>> | undefined): string | undefined {
  const words: string[] = [];
  for (const part of THEME_PARTS) {
    const style = parts?.[part];
    if (!style) continue;
    for (const property of PART_PROPERTIES) if (style[property] !== undefined) words.push(`${part}:${property}`);
  }
  return words.length ? words.join(' ') : undefined;
}
