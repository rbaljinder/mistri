import type { ThemeDefinition, ThemePalette } from '@mistriwork/engine/schema/theme.js';
import { FONT_TOKENS, PALETTE_TOKENS, ROUND, ROUND_BOX, shapeTokens } from '@mistriwork/engine/shared/themeTokens.js';
import { partTokens } from '@mistriwork/engine/shared/themeParts.js';
import { wearIconWeight } from './iconWeight.js';
import { typeTokens } from '@mistriwork/engine/shared/themeType.js';
import {
  effectiveThemeDefinition,
  headingWeight,
  inheritThemePreset,
  lookNavRole,
  themePreset,
  THEME_PRESETS,
} from '@mistriwork/engine/shared/themePresets.js';
import { lookAttribute, RECIPE_PARTS, recipeAttributes, TYPE_ATTRIBUTES } from '@mistriwork/engine/shared/themeRecipes.js';
import { say } from './copy/shell/visualTheme.js';
import { shellById, shellRoot } from './shellHost.js';
import { faceRules } from '@mistriwork/engine/shared/themeFaces.js';
import { appFile } from './addressMount.js';

export const VISUAL_THEME_KEY = 'mistri.visual-theme';
export const WORKBENCH_VISUAL_THEME_KEY = 'mistri.workbench-visual-theme';
export const VISUAL_PALETTE_KEY = 'mistri.visual-palettes';
const CUSTOM_THEME_KEY = 'mistri.custom-theme-choices';
export const VISUAL_THEME_EVENT = 'mistri:visual-theme-change';
export const VISUAL_THEME_REGISTRY_EVENT = 'mistri:visual-theme-registry-change';
/** The look inside an App when neither the reader nor the App names one.
    Workbench instead defaults to its native tokens in style.css. */
export const DEFAULT_VISUAL_THEME = 'lumen';
const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
/** The reader's own pick, kept only while it names a theme this screen offers. */
let preferred: unknown = null;
let workbenchPreferred: string | undefined;
let customPreferences = new Map<string, string>();
let registered: readonly ThemeDefinition[] = [];
let authoredPreset: string | undefined;
let authoredPalette: string | undefined;
let appScope = '';
let palettePreferences = new Map<string, string>();
/** App defaults and policy never become Workbench's explicit reader choice. */
let inApp = false;
let locked = false;
let isolated = false;

const swatches = (theme: ThemeDefinition) =>
  [theme.light.navGround ?? theme.light.surface, theme.light.accent, theme.light.chart2 ?? theme.light.ink] as const;

/** The built-in looks, then the App's own themes. */
export function visualThemeOptions(): Array<{ value: string; label: string; swatches: readonly string[] }> {
  const themes = [...THEME_PRESETS, ...registered]
    .filter((theme) => !locked || theme.id === authoredPreset)
    .map((theme) => ({
      value: theme.id,
      label: theme.label,
      swatches: swatches(effectiveThemeDefinition(theme, paletteChoiceFor(theme))),
    }));
  return inApp ? themes : [{ value: 'default', label: say('workbenchDefault'), swatches: [] }, ...themes];
}

const offered = (value: unknown): value is string =>
  typeof value === 'string' && visualThemeOptions().some((theme) => theme.value === value);

/** The look in force: the reader's pick, else the App's preset, else Lumen. */
export function visualThemeChoice(): string {
  if (!inApp) return workbenchPreferred ?? 'default';
  if (locked && offered(authoredPreset)) return authoredPreset;
  const scoped = appScope ? customPreferences.get(appScope) : undefined;
  // A retired custom choice belongs to this App, not to the global look.
  // Keep it for a later registry reload while falling back to the App default.
  if (scoped !== undefined) {
    if (registered.some((theme) => theme.id === scoped) || (isolated && offered(scoped))) return scoped;
  } else if (!isolated && offered(preferred) && (!appScope || themePreset(preferred))) return preferred;
  if (offered(authoredPreset)) return authoredPreset;
  return DEFAULT_VISUAL_THEME;
}

function selectedThemeBase(): ThemeDefinition {
  const id = visualThemeChoice();
  const custom = registered.find((theme) => theme.id === id);
  return custom ? inheritThemePreset(custom) : (themePreset(id) ?? themePreset(DEFAULT_VISUAL_THEME)!);
}

// A different tuple shape keeps Workbench separate even from an App named "workbench".
const paletteScope = (theme = visualThemeChoice()) => JSON.stringify(inApp ? [appScope, theme] : ['workbench', null, theme]);

/** The theme the App itself wears, where this screen is an App's and the reader may pick another: what the picker marks and what a reset returns to. */
export function appVisualTheme(): string | undefined {
  return inApp && !locked && offered(authoredPreset) ? authoredPreset : undefined;
}

/** Whether the reader's own pick (a theme, or a palette of the App's theme) is what is worn instead of the App's. */
export function readerOverridesAppTheme(): boolean {
  const own = appVisualTheme();
  return own !== undefined && (visualThemeChoice() !== own || palettePreferences.has(paletteScope(own)));
}

/** Back to the App's own theme and palette: the reader's picks for this App are forgotten, not replaced by new ones. */
export function resetVisualTheme() {
  const own = appVisualTheme();
  if (own === undefined) return;
  setVisualTheme(own);
  if (palettePreferences.delete(paletteScope(own))) {
    try {
      window.localStorage.setItem(VISUAL_PALETTE_KEY, JSON.stringify([...palettePreferences]));
    } catch {
      /* Tab-local choice still applies. */
    }
    apply();
    window.dispatchEvent(new Event(VISUAL_THEME_EVENT));
  }
}

/** Palette choices belong to their theme, not to an unrelated App using the same slug. */
export function visualPaletteOptions(): Array<{ value: string; label: string; swatches: readonly string[] }> {
  if (!inApp && !workbenchPreferred) return [];
  const theme = selectedThemeBase();
  return [
    { value: 'default', label: say('default'), swatches: swatches(theme) },
    ...(theme.palettes ?? []).map((palette) => ({
      value: palette.id,
      label: palette.label,
      swatches: swatches(effectiveThemeDefinition(theme, palette.id)),
    })),
  ];
}

function paletteChoiceFor(theme: ThemeDefinition): string {
  const offered = (value: string | undefined): value is string =>
    value === 'default' || Boolean(theme.palettes?.some((palette) => palette.id === value));
  const preferred = palettePreferences.get(paletteScope(theme.id));
  if (!locked && offered(preferred)) return preferred;
  if (theme.id === authoredPreset && offered(authoredPalette)) return authoredPalette;
  const fallback = theme.defaultPalette;
  return offered(fallback) ? fallback : 'default';
}

export function visualPaletteChoice(): string {
  if (!inApp && !workbenchPreferred) return 'default';
  return paletteChoiceFor(selectedThemeBase());
}

function selectedThemeDefinition(): ThemeDefinition {
  return effectiveThemeDefinition(selectedThemeBase(), visualPaletteChoice());
}

export function setVisualPalette(value: string) {
  if (locked || !visualPaletteOptions().some((palette) => palette.value === value)) return;
  palettePreferences.set(paletteScope(), value);
  // Bound retained preferences while keeping the current tab independent of storage availability.
  if (palettePreferences.size > 200) palettePreferences.delete(palettePreferences.keys().next().value!);
  try {
    window.localStorage.setItem(VISUAL_PALETTE_KEY, JSON.stringify([...palettePreferences]));
  } catch {
    /* Tab-local choice still applies. */
  }
  apply();
  window.dispatchEvent(new Event(VISUAL_THEME_EVENT));
}

/** Called by the app-theme owner after load, reload, workspace changes and every
    flip between an App and its Workbench; `app` says which this screen is. */
export function configureVisualThemes(
  themes: readonly ThemeDefinition[] = [],
  preset?: string,
  app = false,
  palette?: string,
  scope = '',
  policy: { locked?: boolean; isolated?: boolean } = {},
) {
  if (!app) {
    themes = [];
    preset = undefined;
    palette = undefined;
    scope = '';
    policy = {};
  }
  const changed =
    registered.length !== themes.length ||
    registered.some((theme, index) => theme !== themes[index]) ||
    authoredPreset !== preset ||
    inApp !== app ||
    authoredPalette !== palette ||
    appScope !== scope ||
    locked !== Boolean(policy.locked) ||
    isolated !== Boolean(policy.isolated);
  registered = themes;
  authoredPreset = preset;
  authoredPalette = palette;
  appScope = scope;
  inApp = app;
  locked = Boolean(policy.locked);
  isolated = Boolean(policy.isolated);
  apply();
  if (changed) window.dispatchEvent(new Event(VISUAL_THEME_REGISTRY_EVENT));
}

/** Workbench always offers its own looks; an App may lock its authored branding. */
export function visualThemesOffered(): boolean {
  return !locked;
}

/** A theme this screen offers, or the default look. */
export function validVisualTheme(value: unknown): string {
  return offered(value) ? value : inApp ? DEFAULT_VISUAL_THEME : 'default';
}

/* The look sheets fetched when a worn theme picks one of their recipes rather
   than carried in every first paint (brandLook.css says why). Mono's and the
   defaults' rules are in the first stylesheet (themeFamilies.css); which sheet
   answers which recipe is the menu's (themeRecipes.ts RECIPE_MENU). */
/* A stylesheet is a module to Vite, which splits it into a file of its own; its type is packages/mistri/schema/css.d.ts's. */
const LOOK_SHEETS: Readonly<Record<string, () => Promise<unknown>>> = {
  lumen: () => import('./lumenLook.css'),
  sage: () => import('./sageLook.css'),
  brand: () => import('./brandLook.css'),
  /* What a theme says beyond the menu: its parts' own styles and its patterns (themeParts.ts). */
  parts: () => import('./partsLook.css'),
  surfaces: () => import('./surfacesLook.css'),
};
const lookSheets = new Map<string, Promise<void>>();
let lookSheet: Promise<void> = Promise.resolve();

/** Settles once the worn look's own sheets have arrived (or could not), so boot
    reveals the page in its look rather than a moment before it. */
export function lookSheetReady(): Promise<void> {
  return lookSheet;
}

function sheet(style: string): Promise<void> | undefined {
  const load = LOOK_SHEETS[style];
  if (!load) return undefined;
  let arriving = lookSheets.get(style);
  if (!arriving) {
    /* A sheet that cannot come leaves the look's tokens on the page, which read; it is not worth a failed boot. */
    arriving = load().then(
      () => undefined,
      (error: unknown) => {
        console.error(`The ${style} look's sheet did not load.`, error);
      },
    );
    lookSheets.set(style, arriving);
  }
  return arriving;
}

/* A theme's own stylesheet, as the server read and scoped it (appBrand.ts): only an address of that shape is linked,
   so nothing a payload carries can link another site's sheet. Every rule in it is scoped to its theme's root
   attribute, so a sheet left linked after another theme is worn draws nothing. */
const THEME_SHEET = /^\/[^/?#]+\/_brand\/[a-z0-9][a-z0-9-]*\.css$/;
const themeSheets = new Map<string, Promise<void>>();
function themeSheet(href: string | undefined): Promise<void> | undefined {
  if (!href || !THEME_SHEET.test(href)) return undefined;
  let arriving = themeSheets.get(href);
  if (!arriving) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    /* An inside address, as the faces are: `/acme/_brand/…` is `/_brand/…` with the App at the root, and the
       Provider's endpoint's in an embed, never the host's address (addressMount appFile). */
    link.href = appFile(href);
    link.dataset.themeSheet = '';
    arriving = new Promise<void>((settle) => {
      link.addEventListener('load', () => settle(), { once: true });
      /* A sheet that cannot come leaves the theme its look and parts, which read; it is not worth a failed boot. */
      link.addEventListener(
        'error',
        () => {
          console.error(`The theme's stylesheet ${href} did not load.`);
          settle();
        },
        { once: true },
      );
    });
    document.head.append(link);
    themeSheets.set(href, arriving);
  }
  return arriving;
}

function wearSheets(styles: readonly string[], ...also: (Promise<void> | undefined)[]) {
  const arriving = [...styles.map(sheet), ...also].filter((value): value is Promise<void> => value !== undefined);
  lookSheet = arriving.length ? Promise.all(arriving).then(() => undefined) : Promise.resolve();
}

/** The attributes a worn theme sets only when it says something there, so one the last theme set goes. */
const OPTIONAL_ATTRIBUTES = [
  ...TYPE_ATTRIBUTES,
  'data-bar-ground',
  'data-parts',
  'data-surface-ground',
  'data-surface-nav',
  'data-icons',
] as const;

/** Every attribute a worn look sets on the root: its name, palette and each recipe. */
const LOOK_ATTRIBUTES = [
  'data-custom-theme',
  'data-visual-theme',
  'data-theme-style',
  'data-theme-palette',
  ...RECIPE_PARTS.map(lookAttribute),
  'data-look-elevation',
  'data-look-motion',
  'data-look-rhythm',
  'data-look-card',
  'data-look-float',
  ...OPTIONAL_ATTRIBUTES,
] as const;

function apply() {
  const root = shellRoot();
  /* Native Workbench has no look attributes. Explicit picks use the same
     definitions, token owner and sheets as the App looks. */
  if (!inApp && !workbenchPreferred) {
    for (const name of LOOK_ATTRIBUTES) root.removeAttribute(name);
    void wearIconWeight(undefined);
    facesStyle?.remove();
    facesStyle = undefined;
    return;
  }
  const definition = selectedThemeDefinition();
  root.setAttribute('data-custom-theme', '');
  root.dataset.visualTheme = definition.id;
  root.dataset.themeStyle = definition.base ?? '';
  root.dataset.themePalette = visualPaletteChoice();
  const { attributes, sheets } = recipeAttributes(definition, lookNavRole(definition));
  /* A role the worn theme leaves to the look has no attribute, so one the last theme set goes. */
  for (const name of OPTIONAL_ATTRIBUTES) if (!(name in attributes)) root.removeAttribute(name);
  for (const [name, value] of Object.entries(attributes)) root.setAttribute(name, value);
  wearSheets(sheets, wearIconWeight(definition.icons), themeSheet(definition.stylesheet?.href));
  wearFaces(definition);
}

/**
 * The worn theme's own font files (`type.faces`) as `@font-face` rules, in the
 * one style element the server's first paint writes them in
 * (clientSurface.ts appFaceHead) — replaced, not added to, when the reader
 * picks another theme or the App's theme is edited and reloads. A rule costs
 * nothing until a line is drawn in its family.
 */
function wearFaces(definition: ThemeDefinition) {
  /* Each face where its App serves it: the endpoint's in an embed, where `shown` would be the host's address. */
  const rules = faceRules(definition, appFile);
  /* A theme without faces leaves the first paint's rules where they are: a rule for a family no stack names is never
     fetched, and the page then needs no DOM at all for a theme that ships no fonts. */
  if (!rules) {
    facesStyle?.remove();
    facesStyle = undefined;
    return;
  }
  facesStyle ??= (shellById('mistri-theme-faces') as HTMLStyleElement | null) ?? undefined;
  if (!facesStyle) {
    facesStyle = document.createElement('style');
    facesStyle.id = 'mistri-theme-faces';
    document.head.append(facesStyle);
  }
  if (facesStyle.textContent !== rules) facesStyle.textContent = rules;
}
let facesStyle: HTMLStyleElement | undefined;

export function initVisualTheme() {
  try {
    preferred = window.localStorage.getItem(VISUAL_THEME_KEY);
  } catch {
    preferred = null; /* The default needs no storage. */
  }
  try {
    const value = window.localStorage.getItem(WORKBENCH_VISUAL_THEME_KEY);
    workbenchPreferred = value && themePreset(value) ? value : undefined;
  } catch {
    workbenchPreferred = undefined; /* Native Workbench needs no storage. */
  }
  customPreferences = new Map();
  try {
    const entries: unknown = JSON.parse(window.localStorage.getItem(CUSTOM_THEME_KEY) ?? '[]');
    if (Array.isArray(entries))
      for (const entry of entries.slice(-200)) {
        if (
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === 'string' &&
          entry[0].length > 0 &&
          entry[0].length <= 256 &&
          typeof entry[1] === 'string' &&
          /^[a-z][a-z0-9-]{0,47}$/.test(entry[1]) &&
          (!themePreset(entry[1]) || entry[0].startsWith('["branding",'))
        )
          customPreferences.set(entry[0], entry[1]);
      }
  } catch {
    /* Missing or malformed custom choices do not prevent boot. */
  }
  palettePreferences = new Map();
  try {
    const entries: unknown = JSON.parse(window.localStorage.getItem(VISUAL_PALETTE_KEY) ?? '[]');
    if (Array.isArray(entries))
      for (const entry of entries.slice(-200)) {
        if (
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === 'string' &&
          entry[0].length <= 256 &&
          typeof entry[1] === 'string' &&
          /^[a-z][a-z0-9-]{0,47}$/.test(entry[1])
        )
          palettePreferences.set(entry[0], entry[1]);
      }
  } catch {
    /* Invalid or unavailable storage cannot prevent boot. */
  }
  apply();
}

/** The reader's pick. Choosing what the App or the default would have given anyway keeps no preference. */
export function setVisualTheme(value: string) {
  if (locked || !offered(value)) return;
  if (!inApp) {
    workbenchPreferred = value === 'default' ? undefined : value;
    try {
      if (workbenchPreferred) window.localStorage.setItem(WORKBENCH_VISUAL_THEME_KEY, workbenchPreferred);
      else window.localStorage.removeItem(WORKBENCH_VISUAL_THEME_KEY);
    } catch {
      /* A Workbench choice is still usable in this tab. */
    }
    apply();
    window.dispatchEvent(new Event(VISUAL_THEME_EVENT));
    return;
  }
  if (appScope) {
    const fallback = offered(authoredPreset) ? authoredPreset : DEFAULT_VISUAL_THEME;
    const custom = registered.some((theme) => theme.id === value);
    if ((custom || isolated) && value !== fallback) {
      customPreferences.set(appScope, value);
      if (customPreferences.size > 200) customPreferences.delete(customPreferences.keys().next().value!);
    } else {
      customPreferences.delete(appScope);
      if (!isolated) preferred = value === fallback ? null : value;
      try {
        if (!isolated && preferred === null) window.localStorage.removeItem(VISUAL_THEME_KEY);
        else if (!isolated) window.localStorage.setItem(VISUAL_THEME_KEY, preferred as string);
      } catch {
        /* The global choice remains usable in this tab. */
      }
    }
    try {
      window.localStorage.setItem(CUSTOM_THEME_KEY, JSON.stringify([...customPreferences]));
    } catch {
      /* Keep the scoped choice in this tab. */
    }
    apply();
    window.dispatchEvent(new Event(VISUAL_THEME_EVENT));
    return;
  }
  const before = preferred;
  preferred = null;
  const fallback = visualThemeChoice();
  preferred = offered(value) && value !== fallback ? value : null;
  if (!offered(value)) preferred = before;
  apply();
  try {
    if (preferred === null) window.localStorage.removeItem(VISUAL_THEME_KEY);
    else window.localStorage.setItem(VISUAL_THEME_KEY, preferred as string);
  } catch {
    /* Keep the current tab usable when preferences cannot be saved. */
  }
  window.dispatchEvent(new Event(VISUAL_THEME_EVENT));
}

/** The look's own radius and data face; an App's authored values win over them in appnav. */
export function visualThemeOverrides(): { radius?: string; font: string; square: boolean; density?: string } {
  if (!inApp && !workbenchPreferred) return { font: 'var(--code)', square: false };
  const definition = selectedThemeDefinition();
  return {
    ...(definition.density ? { density: definition.density } : {}),
    /* Round controls are a pill only where a control is drawn (--control-radius): every other box keeps a box's corner. */
    ...(definition.radius?.control ? { radius: definition.radius.control === ROUND ? ROUND_BOX : definition.radius.control } : {}),
    font: definition.fonts?.data ?? SANS,
    square: definition.radius?.control === '0px',
  };
}

/** The worn theme's `scheme`: dark until the reader picks a mode, or dark only (theme.js). */
export function visualThemeScheme(): ThemeDefinition['scheme'] {
  return selectedThemeDefinition().scheme;
}

export function visualThemePalette(dark: boolean): ThemePalette {
  return selectedThemeDefinition()[dark ? 'dark' : 'light'];
}

/** The worn theme's part styles as custom properties, written where the App's accent is (appTheme.js) so a part in
    `accent` is the App's own accent; none outside an App or for a theme without parts. */
export function customThemePartTokens(): Record<string, string> {
  if (!inApp && !workbenchPreferred) return {};
  return partTokens(selectedThemeDefinition().parts);
}

/** Values only; appnav remains the sole writer of inline theme tokens. */
export function customThemeTokens(dark: boolean): Record<string, string> {
  if (!inApp && !workbenchPreferred) return {};
  const definition = selectedThemeDefinition();
  const tokens: Record<string, string> = {};
  for (const [key, value] of Object.entries(definition[dark ? 'dark' : 'light'])) {
    tokens[PALETTE_TOKENS[key as keyof ThemePalette]] = value;
  }
  for (const [key, value] of Object.entries(definition.fonts ?? {})) {
    if (key !== 'data') tokens[FONT_TOKENS[key as keyof typeof FONT_TOKENS]] = value;
  }
  /* The corners and widths but the control's own, which appnav writes as --radius (visualThemeOverrides). */
  const { '--radius': _control, ...shape } = shapeTokens(definition);
  Object.assign(tokens, shape, typeTokens(definition.type));
  tokens['--heading-weight'] = String(headingWeight(definition));
  return tokens;
}
