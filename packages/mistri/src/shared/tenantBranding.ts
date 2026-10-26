/**
 * A tenant's branding: what an App lets each of its customers say about how the
 * App looks to their people — a name, a logo, an accent, one of the App's
 * palettes or themes, a corner and a density — and never the grounds, the ink
 * or the recipes. The App declares the scope (`branding: { themes, allow }`);
 * a tenant admin saves a value in it; the server keeps it in the platform's
 * branding store and dresses that tenant's pages with it from the first paint.
 *
 * Shared by the server (which parses, validates and serves) and the Branding
 * block (which previews and says the refusal before the save does). The one
 * validator is themeCheck.ts; this file turns its findings into the fixed
 * sentences a person can act on.
 */
import type { ThemeDefinition, ThemeDensity, ThemePalette } from '@mistriwork/engine/schema/theme.js';
import { chartsApart, checkTheme, type ThemeProblem } from './themeCheck.js';
import { mixHex } from './themeBuild.js';
import { DENSITIES } from '@mistriwork/engine/shared/themeRecipes.js';
import { effectiveThemeDefinition, themePreset } from '@mistriwork/engine/shared/themePresets.js';
import { compileAppTheme } from './themeSpec.js';
import type { AppAuth, AppUi } from './appModel.js';
import { canonicalLocale } from '@mistriwork/engine/shared/appLocale.js';
import { audienceThemes as audienceThemeIds, resolveTheme, type ThemeAudiences } from '@mistriwork/engine/shared/themeResolve.js';

/** What a tenant may change, when the App allows it. `preset` (the theme it starts from) needs more than one theme to
 * pick from, and names it as `ui.theme.preset` does. */
const BRANDING_KEYS = ['logo', 'name', 'accent', 'palette', 'radius', 'density', 'preset', 'locale'] as const;
export type BrandingKey = (typeof BRANDING_KEYS)[number];

/** The App's declaration, parsed: its themes compiled (the first is the tenants' default), and the keys a tenant may set. */
export interface BrandingDeclaration {
  readonly themes: readonly ThemeDefinition[];
  readonly allow: readonly BrandingKey[];
  /** The tenant roles whose members may save it: a tenant's admins, by the App's own names for them. */
  readonly editors: readonly string[];
  /** `ui.theme.for`, and each theme it dresses an audience in, by id: a role's theme wins over the tenant's pick
      (themeResolve.ts), and the tenant's accent, name, logo, corner and density lay over it as over its own. */
  readonly audiences?: ThemeAudiences;
  readonly audienceThemes?: readonly ThemeDefinition[];
}

/** A tenant's saved branding. Every field is optional; an absent one is the App's. */
export interface TenantBrandingValue {
  /** The name the tenant's people see in the shell, the title and email. */
  readonly name?: string;
  /** The logo's content hash and served type (brandingLogo.ts); the bytes live in the branding store. */
  readonly logo?: { readonly hash: string; readonly type: string };
  /** The logo drawn on a dark bar or by night, where the light one would not read. Allowed with `logo`; the light logo
      stands where this is none. */
  readonly logoDark?: { readonly hash: string; readonly type: string };
  /** One color for both grounds (mixed toward white on the dark one), or one for each. */
  readonly accent?: { readonly light: string; readonly dark: string };
  /** One of the theme's palettes. */
  readonly palette?: string;
  /** A control's corner, 0px to 8px. */
  readonly radius?: string;
  readonly density?: ThemeDensity;
  /** One of `branding.themes`, by id. */
  readonly preset?: string;
  /** The tenant's language and figures for its people whose own row names none (shared/appLocale.ts `resolveLocale`). */
  readonly locale?: string;
}

const HEX = /^#[0-9a-f]{6}$/;
const isPlain = (raw: unknown): raw is Record<string, unknown> =>
  Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw) && [Object.prototype, null].includes(Object.getPrototypeOf(raw));

/**
 * The App's `branding` block, checked against the App it sits in: a tenant App
 * (`auth.rows: 'tenant'`), keys from the closed list, editors that are tenant
 * roles, and themes written with defineTheme or named as built-ins. Without
 * `themes` the tenants' one theme is the App's own look, its accent included.
 */
export function parseBrandingDeclaration(raw: unknown, app: { ui: AppUi; auth?: AppAuth }, where: string): BrandingDeclaration {
  const at = `${where}: branding`;
  if (!isPlain(raw)) throw new Error(`${at} must be an object: { allow: [...], editors: [...], themes?: [...] }.`);
  for (const key of Object.keys(raw))
    if (!['allow', 'editors', 'themes'].includes(key))
      throw new Error(`${at} has an unsupported field "${key}". It takes allow, editors and themes.`);
  if (app.auth?.rows !== 'tenant')
    throw new Error(`${at}: branding is chosen per tenant, so it needs a tenant App (auth.rows: 'tenant'). An App's own look is ui.theme.`);
  const custom = app.ui.customThemes ?? [];
  const taken = new Set(custom.map((theme) => theme.id));
  let themes: ThemeDefinition[];
  if (raw.themes === undefined) themes = [ownLook(app.ui)];
  else {
    if (!Array.isArray(raw.themes) || !raw.themes.length || raw.themes.length > 6)
      throw new Error(`${at}.themes must list one to six themes: defineTheme(...) results or built-in names.`);
    themes = raw.themes.map((spec: unknown, index: number) => {
      const here = `${at}.themes[${index}]`;
      if (typeof spec === 'string') {
        const preset = themePreset(spec);
        if (!preset) throw new Error(`${here} "${spec}" is not a built-in theme.`);
        return preset;
      }
      if (!isPlain(spec) || spec.kind !== 'theme')
        throw new Error(`${here} must be a theme written with defineTheme(...) or a built-in's name.`);
      /* The App's own theme, offered to its tenants too, is the one ui compiled, not a second copy. */
      const same = custom.find((theme) => theme.id === spec.id);
      if (same) return same;
      const theme = compileAppTheme(spec, here, taken);
      taken.add(theme.id);
      return theme;
    });
    if (new Set(themes.map((theme) => theme.id)).size !== themes.length) throw new Error(`${at}.themes names a theme twice.`);
  }
  if (!Array.isArray(raw.allow) || !raw.allow.length)
    throw new Error(`${at}.allow must list what a tenant may change: ${BRANDING_KEYS.join(', ')}.`);
  const allow: BrandingKey[] = [];
  for (const key of raw.allow) {
    if (key === 'theme') throw new Error(`${at}.allow has "theme", which is now "preset": which of branding.themes a tenant starts from.`);
    if (typeof key !== 'string' || !(BRANDING_KEYS as readonly string[]).includes(key))
      throw new Error(
        `${at}.allow has "${String(key)}"; a tenant may change only ${BRANDING_KEYS.join(', ')}. Grounds, ink and recipes stay the App's.`,
      );
    if (allow.includes(key as BrandingKey)) throw new Error(`${at}.allow names "${key}" twice.`);
    allow.push(key as BrandingKey);
  }
  if (allow.includes('preset') && themes.length < 2)
    throw new Error(`${at}.allow has "preset", which needs more than one theme in branding.themes to pick from.`);
  if (allow.includes('palette') && !themes.some((theme) => theme.palettes?.length))
    throw new Error(`${at}.allow has "palette", and no theme offered has a palette to pick.`);
  const roles = app.auth?.roles ?? {};
  if (!Array.isArray(raw.editors) || !raw.editors.length)
    throw new Error(`${at}.editors must name the tenant roles whose members may change it (a tenant's admins).`);
  const editors: string[] = [];
  for (const role of raw.editors) {
    const declared = typeof role === 'string' ? (roles as Record<string, { realm?: string }>)[role] : undefined;
    /* A role names no realm when it is the App's own, a tenant's; a platform-realm role is the provider's staff. */
    if (!declared || (declared.realm !== undefined && declared.realm !== 'tenant'))
      throw new Error(`${at}.editors has "${String(role)}", which is not a tenant role of auth.roles.`);
    if (!editors.includes(role as string)) editors.push(role as string);
  }
  const audiences = app.ui.theme?.for;
  const audienceThemes = audienceThemeIds(audiences).flatMap((id) => {
    const theme = custom.find((item) => item.id === id) ?? themePreset(id);
    return theme ? [theme] : [];
  });
  return Object.freeze({
    themes: Object.freeze(themes),
    allow: Object.freeze(allow),
    editors: Object.freeze(editors),
    ...(audiences ? { audiences, audienceThemes: Object.freeze(audienceThemes) } : {}),
  });
}

/**
 * A tenant's branding as one audience wears it: where `ui.theme.for` dresses a signed-out visitor or one of the
 * account's roles (themeResolve.ts), that theme replaces the tenant's pick and its palette, and the tenant's accent,
 * name, logo, corner and density lay over it; otherwise the tenant's own, as saved.
 */
export function audienceBranding(
  declaration: BrandingDeclaration,
  value: TenantBrandingValue,
  audience: { public?: boolean; roles?: readonly string[] },
): { declaration: BrandingDeclaration; value: TenantBrandingValue } {
  const themes = declaration.audienceThemes ?? [];
  const worn = resolveTheme({ ...audience, for: declaration.audiences, offered: (id) => themes.some((theme) => theme.id === id) });
  if (worn.source !== 'public' && worn.source !== 'role') return { declaration, value };
  const { palette: _palette, ...rest } = value;
  return { declaration: { ...declaration, themes: themes.filter((theme) => theme.id === worn.id) }, value: { ...rest, preset: worn.id } };
}

/** The App's look as one theme: its preset or its own theme, with its accent laid over as a tenant's would be. */
function ownLook(ui: AppUi): ThemeDefinition {
  const preset = ui.theme?.preset;
  const base = ui.customThemes?.find((theme) => theme.id === preset) ?? themePreset(preset) ?? themePreset('lumen')!;
  const accent = ui.theme?.accent;
  const value: TenantBrandingValue = {
    ...(ui.theme?.palette && ui.theme.palette !== 'default' ? { palette: ui.theme.palette } : {}),
    ...(typeof accent === 'string' && HEX.test(accent.toLowerCase())
      ? { accent: { light: accent.toLowerCase(), dark: mixHex(accent.toLowerCase(), '#ffffff', 0.62) } }
      : typeof accent === 'object' && HEX.test(accent.light.toLowerCase()) && HEX.test(accent.dark.toLowerCase())
        ? { accent: { light: accent.light.toLowerCase(), dark: accent.dark.toLowerCase() } }
        : {}),
  };
  if (!value.accent && !value.palette) return base;
  const theme = tenantTheme({ themes: [base], allow: [], editors: [] }, value);
  return { ...theme, id: base.id, label: base.label };
}
const RADIUS = /^(?:[0-7]|8)px$/;
const SLUG = /^[a-z][a-z0-9-]{0,47}$/;

/** Why a save was refused: the field and a sentence that says what to do. */
export interface BrandingRefusal {
  readonly field: BrandingKey;
  readonly message: string;
}

export class BrandingRefused extends Error {
  readonly refusals: readonly BrandingRefusal[];
  constructor(refusals: readonly BrandingRefusal[]) {
    super(refusals.map((refusal) => refusal.message).join(' '));
    this.name = 'BrandingRefused';
    this.refusals = refusals;
  }
}

function plain(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)))
    throw new BrandingRefused([{ field: 'name', message: 'Branding is a set of named fields.' }]);
  return raw as Record<string, unknown>;
}

/**
 * A tenant's value checked field by field against the App's declaration: a key
 * the App does not allow, or a value outside its type, is refused with the field
 * named. Colours are lowercase six-digit hex; nothing here reaches CSS before it
 * has matched one of these patterns.
 */
export function parseTenantBranding(raw: unknown, declaration: BrandingDeclaration): TenantBrandingValue {
  const input = plain(raw);
  const refusals: BrandingRefusal[] = [];
  const allowed = new Set<string>(declaration.allow);
  const out: { -readonly [K in keyof TenantBrandingValue]: TenantBrandingValue[K] } = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (
      !(BRANDING_KEYS as readonly string[]).includes(key === 'logoDark' ? 'logo' : key) ||
      !allowed.has(key === 'logoDark' ? 'logo' : key)
    ) {
      refusals.push({ field: 'name', message: `This App does not let a customer change "${key}".` });
      continue;
    }
    switch (key as BrandingKey | 'logoDark') {
      case 'name':
        // eslint-disable-next-line no-control-regex -- a name is one line of text
        if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f\u007f<>]/.test(value))
          refusals.push({ field: 'name', message: 'The name must be one line of at most 80 characters, without < or >.' });
        else out.name = value.trim();
        break;
      case 'logo':
      case 'logoDark': {
        const logo = typeof value === 'object' ? (value as Record<string, unknown>) : {};
        if (
          typeof logo.hash !== 'string' ||
          !/^[0-9a-f]{64}$/.test(logo.hash) ||
          typeof logo.type !== 'string' ||
          !/^image\/(png|jpeg|webp|gif|svg\+xml)$/.test(logo.type)
        )
          refusals.push({
            field: 'logo',
            message:
              key === 'logo'
                ? 'Upload the logo again: the saved one was not recognized.'
                : 'Upload the dark logo again: the saved one was not recognized.',
          });
        else out[key as 'logo' | 'logoDark'] = { hash: logo.hash, type: logo.type };
        break;
      }
      case 'accent': {
        /* One color is for the light ground; the dark one is derived from it once the theme it will stand in is
           known, below. */
        const one = typeof value === 'string' ? value.trim().toLowerCase() : '';
        const pair = HEX.test(one) ? { light: one, dark: one } : typeof value === 'object' ? (value as Record<string, unknown>) : {};
        const light = typeof pair.light === 'string' ? pair.light.trim().toLowerCase() : '';
        const dark = typeof pair.dark === 'string' ? pair.dark.trim().toLowerCase() : '';
        if (!HEX.test(light) || !HEX.test(dark)) refusals.push({ field: 'accent', message: 'The accent must be a color like #1d4ed8.' });
        else out.accent = { light, dark };
        break;
      }
      case 'palette':
        if (typeof value !== 'string' || !SLUG.test(value))
          refusals.push({ field: 'palette', message: 'Pick one of the palettes offered.' });
        else out.palette = value;
        break;
      case 'radius':
        if (typeof value !== 'string' || !RADIUS.test(value))
          refusals.push({ field: 'radius', message: 'The corner must be between 0px and 8px.' });
        else out.radius = value;
        break;
      case 'density':
        if (!(DENSITIES as readonly unknown[]).includes(value))
          refusals.push({ field: 'density', message: 'Pick compact, comfortable or spacious.' });
        else out.density = value as ThemeDensity;
        break;
      case 'preset':
        if (typeof value !== 'string' || !declaration.themes.some((theme) => theme.id === value))
          refusals.push({ field: 'preset', message: 'Pick one of the themes offered.' });
        else out.preset = value;
        break;
      case 'locale': {
        const tag = canonicalLocale(value);
        if (!tag) refusals.push({ field: 'locale', message: 'Pick a language like "en-US" or "es-MX".' });
        else out.locale = tag;
        break;
      }
    }
  }
  if (out.accent && typeof input.accent === 'string') out.accent = accentFor(declaration, out, out.accent.light);
  if (out.palette !== undefined) {
    const theme = themeOf(declaration, out.preset);
    if (out.palette !== 'default' && !theme.palettes?.some((palette) => palette.id === out.palette))
      refusals.push({ field: 'palette', message: 'Pick one of the palettes offered.' });
  }
  if (refusals.length) throw new BrandingRefused(refusals);
  return out;
}

function themeOf(declaration: BrandingDeclaration, id: string | undefined): ThemeDefinition {
  return declaration.themes.find((theme) => theme.id === id) ?? declaration.themes[0]!;
}

/** The roles an accent stands for where the theme already wore its accent: the link and the menu's current room. */
const FOLLOWS_ACCENT = ['link', 'navAccent'] as const;

/**
 * The theme a tenant's people wear: the App's chosen theme and palette, with the
 * tenant's accent laid over the roles that were that accent, and its corner and
 * density. Grounds, ink, lines and recipes are the App's and stay so.
 */
export function tenantTheme(declaration: BrandingDeclaration, value: TenantBrandingValue): ThemeDefinition {
  const chosen = themeOf(declaration, value.preset);
  const base = effectiveThemeDefinition(chosen, value.palette ?? chosen.defaultPalette);
  const mode = (name: 'light' | 'dark'): ThemePalette => {
    const palette = { ...base[name] };
    const accent = value.accent?.[name];
    if (!accent) return palette;
    for (const role of FOLLOWS_ACCENT) if (palette[role] === palette.accent) palette[role] = accent;
    /* The first chart series is the brand's, whatever the theme drew it in: Lumen's navy accent beside its blue
       first series left a tenant's teal on the bar and its charts blue, and the form says the accent colors them.
       Unless that would set it beside the second series for a color-blind reader: then the theme's own first
       series stays, as it did, and an accent that was already the first series is still held to the check. */
    if (palette.chart1 === palette.accent || !palette.chart2 || chartsApart(accent, palette.chart2)) palette.chart1 = accent;
    palette.accent = accent;
    /* A tenant picks one color, and it must read as text on the page: `accentInk` said, so the check holds the pick
       to it where an App's theme, which names its inks, is given the one that reads. */
    palette.accentInk = accent;
    palette.focus = accent;
    /* The selected item's tint: as faint as the built-ins draw theirs (Lumen's is about 8% on white), so the accent still reads on it. */
    palette.accentSoft = mixHex(accent, palette.surface, name === 'light' ? 0.08 : 0.2);
    return palette;
  };
  const { palettes: _palettes, defaultPalette: _default, ...rest } = base;
  return {
    ...rest,
    id: 'tenant',
    label: value.name ?? chosen.label,
    light: mode('light'),
    dark: mode('dark'),
    ...(value.radius ? { radius: { control: value.radius, field: value.radius } } : {}),
    ...(value.density ? { density: value.density } : {}),
  };
}

/**
 * The one validator over the theme a tenant would wear, holding against the
 * tenant only the colors its accent changed, said in a fixed sentence per
 * kind of failure — the person saving picked a color, not a token.
 */
export function brandingProblems(declaration: BrandingDeclaration, value: TenantBrandingValue): BrandingRefusal[] {
  const problems = wornFindings(declaration, value);
  const seen = new Set<string>();
  const refusals: BrandingRefusal[] = [];
  for (const [problem, worn] of problems) {
    const message = worn ? sentence(problem).replace(/\.$/, ` in ${worn}, which some of your people wear.`) : sentence(problem);
    if (seen.has(message)) continue;
    seen.add(message);
    refusals.push({ field: 'accent', message });
  }
  return refusals;
}

/** The findings on every theme the tenant's accent is worn over: its own pick, and each theme an audience wears
    (ui.theme.for), which the tenant did not pick and so is named beside a failure there. */
function wornFindings(declaration: BrandingDeclaration, value: TenantBrandingValue): (readonly [ThemeProblem, string])[] {
  const { palette: _palette, ...over } = value;
  return [
    ...accentFindings(declaration, value).map((problem) => [problem, ''] as const),
    ...(declaration.audienceThemes ?? [])
      .filter((theme) => theme.id !== themeOf(declaration, value.preset).id)
      .flatMap((theme) =>
        accentFindings({ ...declaration, themes: [theme] }, { ...over, preset: theme.id }).map(
          (problem) => [problem, theme.label] as const,
        ),
      ),
  ];
}

/** The validator's findings against the colors the tenant's accent changed. */
function accentFindings(declaration: BrandingDeclaration, value: TenantBrandingValue): ThemeProblem[] {
  if (!value.accent) return [];
  const chosen = themeOf(declaration, value.preset);
  const before = effectiveThemeDefinition(chosen, value.palette ?? chosen.defaultPalette);
  const after = tenantTheme(declaration, value);
  const changed = (_palette: string, mode: 'light' | 'dark', role: keyof ThemePalette) => before[mode][role] !== after[mode][role];
  return checkTheme({ ...after, palettes: undefined }, { authored: changed });
}

/**
 * One brand color for both grounds. The dark theme's accent starts where an
 * App's own does, the color mixed 62% toward white, and where that still reads
 * too dark there — a deep brand blue such as #1d4ed8 on its own tint, in Lumen
 * or Sage by night — it is lifted in OKLCH lightness, its hue and as much of
 * its chroma as sRGB holds kept, until the validator passes it: the brand
 * stays recognisably the brand rather than the save being refused. A color no
 * lift makes readable keeps the plain mix, and the validator says why.
 */
export function accentFor(
  declaration: BrandingDeclaration,
  value: TenantBrandingValue,
  light: string,
): { readonly light: string; readonly dark: string } {
  const start = mixHex(light, '#ffffff', 0.62);
  const darkOk = (dark: string) => !wornFindings(declaration, { ...value, accent: { light, dark } }).some(([p]) => p.mode === 'dark');
  if (darkOk(start)) return { light, dark: start };
  const [l, c, h] = oklch(start);
  for (let lift = l + 0.02; lift <= 0.96; lift += 0.02) {
    const dark = fromOklch(lift, c, h);
    if (darkOk(dark)) return { light, dark };
  }
  return { light, dark: start };
}

/* OKLab (Björn Ottosson), polar: lightness 0 to 1, chroma, hue in radians. */
function oklch(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const v = parseInt(hex.slice(at, at + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const lms = [
    Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b),
    Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b),
    Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b),
  ] as const;
  const L = 0.2104542553 * lms[0] + 0.793617785 * lms[1] - 0.0040720468 * lms[2];
  const A = 1.9779984951 * lms[0] - 2.428592205 * lms[1] + 0.4505937099 * lms[2];
  const B = 0.0259040371 * lms[0] + 0.7827717662 * lms[1] - 0.808675766 * lms[2];
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

/** A lightness, chroma and hue as hex, the chroma eased down until the color is one sRGB can show. */
function fromOklch(l: number, c: number, h: number): string {
  for (let chroma = c; ; chroma = Math.max(0, chroma - 0.005)) {
    const a = chroma * Math.cos(h),
      b = chroma * Math.sin(h);
    const lms = [
      l + 0.3963377774 * a + 0.2158037573 * b,
      l - 0.1055613458 * a - 0.0638541728 * b,
      l - 0.0894841775 * a - 1.291485548 * b,
    ].map((v) => v ** 3) as [number, number, number];
    const rgb = [
      4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2],
      -1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2],
      -0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2],
    ];
    if (chroma === 0 || rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4))
      return `#${rgb
        .map((v) => {
          const x = Math.min(1, Math.max(0, v));
          return Math.round((x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055) * 255)
            .toString(16)
            .padStart(2, '0');
        })
        .join('')}`;
  }
}

/** A finding as the person who picked the color would say it. */
function sentence(problem: ThemeProblem): string {
  const light = problem.mode === 'light';
  const ground = light ? 'white' : 'the dark background';
  if (problem.token.startsWith('chart'))
    return `This accent is too close to the next chart color for color-blind readers in the ${problem.mode} theme. Pick a color further from it.`;
  if (problem.token === 'nav.accent') return `This accent is too ${light ? 'light' : 'dark'} on the menu in the ${problem.mode} theme.`;
  if (problem.token === 'focus' || /focus ring/.test(problem.reason))
    return `This accent is too ${light ? 'light' : 'dark'} on ${ground} for the keyboard focus ring.`;
  if (/selected tab|accentSoft/.test(problem.reason))
    return `This accent is too ${light ? 'light' : 'dark'} to read on its own tint (a selected item) in the ${problem.mode} theme.`;
  if (problem.token === 'link') return `This accent is too ${light ? 'light' : 'dark'} on ${ground} for links.`;
  return `This accent is too ${light ? 'light' : 'dark'} on ${ground} for buttons.`;
}

/** Everything a save must clear: the value's shape, then the validator. Throws BrandingRefused. */
export function validateTenantBranding(raw: unknown, declaration: BrandingDeclaration): TenantBrandingValue {
  const value = parseTenantBranding(raw, declaration);
  const problems = brandingProblems(declaration, value);
  if (problems.length) throw new BrandingRefused(problems);
  return value;
}
