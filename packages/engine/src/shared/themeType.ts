/**
 * A theme's type: the base size its text is drawn at and the nine roles, each
 * kind of text by what it is for (docs/theming.md, Type). Checked here,
 * merged over a base look's, and worn as two things the browser needs at
 * first paint: custom properties (`--type-k`, `--type-<role>-<property>`) and
 * one `data-type-<role>` attribute per role naming what that role says, which
 * the rules in themeFamilies.css answer (the attributes are themeRecipes.ts's,
 * with the rest of what a first paint sets on the root). A role that says nothing sets no
 * attribute, so every rule it would draw is off and the look draws as before.
 */
import type {
  ThemeTypeBase,
  ThemeTypeCase,
  ThemeTypeReach,
  ThemeTypeDefinition,
  ThemeTypeFace,
  ThemeTypeRole,
  ThemeTypeRoleDefinition,
} from '../../schema/theme.js';

type Property = keyof ThemeTypeRoleDefinition;
interface RoleRule {
  /** The properties a role takes. */
  takes: readonly Property[];
  /** Its size's range in pixels, at the 13px base. */
  size?: readonly [number, number];
  /** Its leading's range. */
  leading?: readonly [number, number];
  /** The weights it may be drawn at. */
  weights?: readonly number[];
}

const WEIGHTS = [400, 500, 600, 700, 800, 900] as const;
const LEADING = [1.1, 1.8] as const;
/** A title and a display line may be set as tight as 0.85: a short line of large type wants the lines closer than a
    heading's. Under 1.0 a wrapped line sets its descenders into the next, which `check` warns of (theme-type). */
const TIGHT_LEADING = [0.85, 1.8] as const;

/** Each role, what it takes and the ranges it is held to: no text smaller than the look draws it, no menu that
    competes with a heading, no body that is not the base. */
export const TYPE_ROLES: Record<ThemeTypeRole, RoleRule> = {
  display: {
    takes: ['face', 'size', 'leading', 'tracking', 'weight', 'features'],
    size: [28, 56],
    leading: TIGHT_LEADING,
    weights: WEIGHTS,
  },
  title: {
    takes: ['face', 'size', 'leading', 'tracking', 'weight', 'case', 'features'],
    size: [20, 36],
    leading: TIGHT_LEADING,
    weights: WEIGHTS,
  },
  heading: {
    takes: ['face', 'size', 'leading', 'tracking', 'weight', 'case', 'features'],
    size: [16, 28],
    leading: LEADING,
    weights: WEIGHTS,
  },
  section: { takes: ['face', 'size', 'tracking', 'weight', 'case', 'features'], size: [12, 20], weights: WEIGHTS },
  body: { takes: ['leading', 'features'], leading: [1.35, 1.8] },
  label: { takes: ['face', 'tracking', 'weight', 'case', 'features'], weights: [400, 500, 600, 700] },
  data: { takes: ['features', 'reach'] },
  figure: { takes: ['face', 'size', 'tracking', 'weight', 'features'], size: [18, 40], weights: WEIGHTS },
  nav: { takes: ['face', 'tracking', 'weight', 'case'], weights: [400, 500, 600] },
};
const TYPE_ROLE_NAMES = Object.keys(TYPE_ROLES) as ThemeTypeRole[];
export const TYPE_BASES: readonly ThemeTypeBase[] = ['13px', '14px', '15px', '16px'];
/** Each face as the stack it reads: the theme's own, `code` its monospace (`fonts.code`, else the platform's). */
export const TYPE_FACES: Record<ThemeTypeFace, string> = {
  ui: 'var(--sans)',
  heading: 'var(--heading-font, var(--sans))',
  data: 'var(--mono)',
  code: 'var(--code)',
};
const CASES: readonly ThemeTypeCase[] = ['none', 'upper', 'small-caps'];
/** What the data face may set: every value, or only the figures, keys and dates. */
const TYPE_REACHES: readonly ThemeTypeReach[] = ['values', 'figures'];
/** The features `font-variant-numeric` says; the rest are `font-feature-settings`. */
const NUMERIC: Record<string, string> = { lnum: 'lining-nums', onum: 'oldstyle-nums', tnum: 'tabular-nums', zero: 'slashed-zero' };
const FEATURE = /^(?:tnum|lnum|onum|zero|case|ss(?:0[1-9]|1\d|20)|cv(?:0[1-9]|[1-9]\d))$/;
const TRACKING = /^(-?)(0|0?\.\d{1,3})em$/;
/** The size tokens the sheets already read: the title's, the display step's. */
const SIZE_TOKENS: Partial<Record<ThemeTypeRole, string>> = { title: '--type-record-title', display: '--type-display' };

/** The spellings type roles replaced, each with where it went (a clean break: the old key is refused). */
export const TYPE_MOVED: Record<string, string> = {
  'type.scale': "type.roles.title.size: '22px', '26px', '28px' or '30px' (compact, default, large, roomy)",
  'type.headingWeight': "type.roles.title.weight (a list's heading takes it too, unless type.roles.heading.weight says its own)",
  'recipes.labels': "type.roles.label: { face: 'code', case: 'upper' } for mono-caps, { case: 'small-caps' } for small-caps",
  'recipes.headings': "type.roles.section: { case: 'upper', size: '12px' } for caps, { case: 'small-caps' } for small-caps",
  'recipes.figures':
    "type.roles.figure: { face: 'code', weight: 700 } for mono, { face: 'heading', weight: 600, features: ['lnum'] } for book",
};

const record = (raw: unknown, where: string): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where} must be an object.`);
  return raw as Record<string, unknown>;
};
const px = (value: unknown): number | undefined => {
  const match = typeof value === 'string' ? /^(\d{1,2}(?:\.\d)?)px$/.exec(value) : null;
  return match ? Number(match[1]) : undefined;
};

/** `type.base` and `type.roles` checked; anything else in `type` is the caller's. */
export function typeOf(base: unknown, roles: unknown, where: string): ThemeTypeDefinition {
  const out: ThemeTypeDefinition = {};
  if (base !== undefined) {
    if (!TYPE_BASES.includes(base as ThemeTypeBase)) throw new Error(`${where}.base must be one of ${TYPE_BASES.join(', ')}.`);
    out.base = base as ThemeTypeBase;
  }
  if (roles === undefined) return out;
  const value = record(roles, `${where}.roles`);
  out.roles = {};
  for (const [name, raw] of Object.entries(value)) {
    const rule = TYPE_ROLES[name as ThemeTypeRole];
    if (!Object.hasOwn(TYPE_ROLES, name) || !rule)
      throw new Error(`${where}.roles has no "${name}". The roles are: ${TYPE_ROLE_NAMES.join(', ')}.`);
    out.roles[name as ThemeTypeRole] = roleOf(raw, rule, `${where}.roles.${name}`);
  }
  return out;
}

function roleOf(raw: unknown, rule: RoleRule, where: string): ThemeTypeRoleDefinition {
  const value = record(raw, where);
  for (const key of Object.keys(value))
    if (!rule.takes.includes(key as Property))
      throw new Error(
        `${where} has no "${key}". It takes: ${rule.takes.join(', ')}.` +
          (key === 'size' ? ' Its size is the base (type.base), so it grows with every other size.' : ''),
      );
  const out: ThemeTypeRoleDefinition = {};
  if (value.face !== undefined) {
    /* Renamed before 1.0: the monospace face is `code`, the word a display rule and `fonts.code` say. */
    if (value.face === 'mono') throw new Error(`${where}.face "mono" is now "code": the theme's monospace (fonts.code).`);
    if (!Object.hasOwn(TYPE_FACES, value.face as string))
      throw new Error(`${where}.face must be one of ${Object.keys(TYPE_FACES).join(', ')}.`);
    out.face = value.face as ThemeTypeFace;
  }
  if (value.size !== undefined) {
    const size = px(value.size),
      [low, high] = rule.size!;
    if (size === undefined || size < low || size > high) throw new Error(`${where}.size must be a length from ${low}px to ${high}px.`);
    out.size = value.size as string;
  }
  if (value.leading !== undefined) {
    const [low, high] = rule.leading!;
    if (typeof value.leading !== 'number' || !(value.leading >= low && value.leading <= high))
      throw new Error(`${where}.leading must be a number from ${low} to ${high}.`);
    out.leading = value.leading;
  }
  if (value.tracking !== undefined) {
    const match = typeof value.tracking === 'string' ? TRACKING.exec(value.tracking) : null;
    const amount = match ? Number(match[2]) * (match[1] ? -1 : 1) : NaN;
    if (!(amount >= -0.03 && amount <= 0.15)) throw new Error(`${where}.tracking must be a length from -0.03em to 0.15em.`);
    out.tracking = value.tracking as string;
  }
  if (value.weight !== undefined) {
    if (!rule.weights!.includes(value.weight as number)) throw new Error(`${where}.weight must be one of ${rule.weights!.join(', ')}.`);
    out.weight = value.weight as number;
  }
  if (value.case !== undefined) {
    if (!CASES.includes(value.case as ThemeTypeCase)) throw new Error(`${where}.case must be one of ${CASES.join(', ')}.`);
    out.case = value.case as ThemeTypeCase;
  }
  if (value.reach !== undefined) {
    if (!TYPE_REACHES.includes(value.reach as ThemeTypeReach))
      throw new Error(`${where}.reach must be values (every value in the data face) or figures (only figures, keys and dates).`);
    out.reach = value.reach as ThemeTypeReach;
  }
  if (value.features !== undefined) {
    const features = value.features;
    if (!Array.isArray(features) || features.length > 8 || new Set(features).size !== features.length)
      throw new Error(`${where}.features must be at most eight different features.`);
    for (const feature of features)
      if (typeof feature !== 'string' || !FEATURE.test(feature))
        throw new Error(
          `${where}.features takes tnum, lnum, onum, zero, case, ss01 to ss20 and cv01 to cv99; "${String(feature)}" is not one.`,
        );
    out.features = [...(features as string[])];
  }
  return out;
}

/** A theme's type over its base look's: the theme's base, and each role's properties over the look's own. */
export function mergeType(under: ThemeTypeDefinition | undefined, over: ThemeTypeDefinition | undefined): ThemeTypeDefinition | undefined {
  if (!under && !over) return undefined;
  const roles: Partial<Record<ThemeTypeRole, ThemeTypeRoleDefinition>> = {};
  for (const name of TYPE_ROLE_NAMES) {
    const role = { ...under?.roles?.[name], ...over?.roles?.[name] };
    if (Object.keys(role).length) roles[name] = role;
  }
  const base = over?.base ?? under?.base;
  return { ...(base ? { base } : {}), ...(Object.keys(roles).length ? { roles } : {}) };
}

const sized = (length: string) => `calc(${length} * var(--type-k))`;

/** The custom properties a theme's type is worn as. A title's weight is not here: it is `--heading-weight`, which
    every heading reads (headingWeight). */
export function typeTokens(type: ThemeTypeDefinition | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (type?.base && type.base !== '13px') out['--type-k'] = `calc(${parseFloat(type.base)} / 13)`;
  for (const name of TYPE_ROLE_NAMES) {
    const role = type?.roles?.[name];
    if (!role) continue;
    const token = (property: string) => `--type-${name}-${property}`;
    if (role.face) out[token('font')] = TYPE_FACES[role.face];
    if (role.size) out[SIZE_TOKENS[name] ?? token('size')] = sized(role.size);
    if (role.leading !== undefined) out[token('leading')] = String(role.leading);
    if (role.tracking) out[token('tracking')] = role.tracking;
    if (role.weight !== undefined && name !== 'title') out[token('weight')] = String(role.weight);
    const numeric = numericOf(name, role.features);
    if (numeric) out[token('numeric')] = numeric;
    const settings = (role.features ?? []).filter((feature) => !NUMERIC[feature]);
    if (settings.length) out[token('features')] = settings.map((feature) => `"${feature}"`).join(', ');
  }
  return out;
}

/** A role's figures as `font-variant-numeric`, tabular kept where the role's figures line up in columns. */
function numericOf(role: ThemeTypeRole, features: readonly string[] | undefined): string | undefined {
  const named = (features ?? []).filter((feature) => NUMERIC[feature]);
  if (!named.length) return undefined;
  if ((role === 'data' || role === 'figure') && !named.includes('tnum')) named.push('tnum');
  /* In the order the property's own value is written, so what the page computes is what is said. */
  return ['lnum', 'onum', 'tnum', 'zero']
    .filter((feature) => named.includes(feature))
    .map((feature) => NUMERIC[feature])
    .join(' ');
}
