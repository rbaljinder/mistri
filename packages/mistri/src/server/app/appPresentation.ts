/**
 * A deployment's presentation of an App (`"presentation": { "<app>": { name, logo, theme, locale } }` in the config
 * file, beside "mount" and "basePath"): one App run as several separate program instances, each under its own name,
 * logo, theme and language, without a build that specializes the source. It is the deployment's fact, so it lives in
 * runtime configuration and never in the definition.
 *
 * Precedence, widest to narrowest: the App definition, then this, then a tenant's own branding (a tenant App's
 * `ui.theme: fromRecord(...)` row, read per request, over whatever the deployment says). The deployment is laid over
 * the definition before it is parsed, so the sign-in screen, the public pages, the shell, the page title, the
 * manifest and every mail that says the App's name read it from the one place they already read it, and a tenant's
 * branding, which is resolved over the parsed App, still wins. A fromRecord App keeps its record binding: the
 * deployment's theme becomes its fallback look.
 */
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { THEME_BASES } from '@mistriwork/engine/shared/theme.js';
import { themePreset } from '@mistriwork/engine/shared/themePresets.js';
import type { AppDef } from '../../shared/app.js';

export interface AppPresentation {
  /** The program's name: the bar, the page title, the sign-in screen, the manifest. Replaces `shortName` too. */
  readonly name?: string;
  /** A picture in the App's directory, as `ui.logo` names one: a path, or `{ src, dark, mark }`. */
  readonly logo?: string | { readonly src: string; readonly dark?: string; readonly mark?: string };
  /** A built-in theme or one the App registers: its name, or `{ preset, palette }`. */
  readonly theme?: string | { readonly preset?: string; readonly palette?: string };
  /** A BCP 47 tag, like "en-AU": the language of the words and the figures. */
  readonly locale?: string;
}

const KEYS = ['name', 'logo', 'theme', 'locale'] as const;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const LOGO_FILE = /\.(?:png|jpe?g|webp|gif|svg)$/i;

/** The config's `"presentation"`, read: a map from App id to its override, every key held to its shape. */
export function parsePresentation(raw: unknown, file: string): Record<string, AppPresentation> {
  if (raw === undefined) return {};
  if (!isRecord(raw))
    throw new Error(
      `${file}: "presentation" must name each App's presentation by its id, like { "main": { "name": "Northside Bank", "theme": "mono" } }.`,
    );
  return Object.fromEntries(Object.entries(raw).map(([id, value]) => [id, parseOne(value, `${file}: "presentation.${id}"`)]));
}

function parseOne(raw: unknown, at: string): AppPresentation {
  if (!isRecord(raw)) throw new Error(`${at} must be an object with any of ${KEYS.join(', ')}.`);
  for (const key of Object.keys(raw)) {
    if (!(KEYS as readonly string[]).includes(key))
      throw new Error(`${at} has no "${key}". It takes: ${KEYS.join(', ')}. Credentials and connection settings are never part of it.`);
  }
  const out: { -readonly [K in keyof AppPresentation]: AppPresentation[K] } = {};
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string' || !raw.name.trim() || Array.from(raw.name.trim()).length > 80)
      throw new Error(`${at}.name must be 1 to 80 characters of text: the program's name.`);
    out.name = raw.name.trim();
  }
  if (raw.logo !== undefined) {
    const parts = typeof raw.logo === 'string' ? { src: raw.logo } : raw.logo;
    if (!isRecord(parts)) throw new Error(`${at}.logo must be a path to a picture in the App's directory, or { src, dark, mark }.`);
    for (const [key, value] of Object.entries(parts)) {
      if (key !== 'src' && key !== 'dark' && key !== 'mark')
        throw new Error(`${at}.logo has no "${key}". It takes: src, dark, mark (or is the picture's path).`);
      if (typeof value !== 'string' || !value.trim() || value.length > 200)
        throw new Error(`${at}.logo.${key} must be a path to a picture in the App's directory.`);
      if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(value.trim()))
        throw new Error(
          `${at}.logo.${key} "${value}" is a URL; a logo is a file in the App's directory, served from the App's own origin.`,
        );
      if (!LOGO_FILE.test(value.trim())) throw new Error(`${at}.logo.${key} "${value}" is not a PNG, JPEG, WebP, GIF or SVG file.`);
    }
    if (typeof parts.src !== 'string') throw new Error(`${at}.logo.src is required: the picture the bar draws.`);
    out.logo =
      typeof raw.logo === 'string'
        ? raw.logo.trim()
        : (Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, (v as string).trim()])) as never);
  }
  if (raw.theme !== undefined) {
    const parts = typeof raw.theme === 'string' ? { preset: raw.theme } : raw.theme;
    if (!isRecord(parts)) throw new Error(`${at}.theme must be a theme's name, like "mono", or { preset, palette }.`);
    for (const [key, value] of Object.entries(parts)) {
      if (key !== 'preset' && key !== 'palette')
        throw new Error(`${at}.theme has no "${key}". It takes: preset, palette (or is the theme's name).`);
      if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(value.trim()))
        throw new Error(`${at}.theme.${key} must be a name like "mono"; "${String(value)}" is not one.`);
    }
    if (parts.preset === undefined) throw new Error(`${at}.theme needs a preset: the built-in or registered theme to wear.`);
    out.theme = typeof raw.theme === 'string' ? raw.theme.trim() : ({ ...parts } as never);
  }
  if (raw.locale !== undefined) {
    let known = false;
    try {
      known = typeof raw.locale === 'string' && Intl.getCanonicalLocales(raw.locale.trim()).length === 1;
    } catch {
      known = false;
    }
    if (!known) throw new Error(`${at}.locale "${String(raw.locale)}" is not a language tag like "en-AU".`);
    out.locale = (raw.locale as string).trim();
  }
  return out;
}

const themeParts = (theme: NonNullable<AppPresentation['theme']>) => (typeof theme === 'string' ? { preset: theme } : theme);
const logoParts = (logo: NonNullable<AppPresentation['logo']>) => (typeof logo === 'string' ? { src: logo } : logo);

/** The theme names this App can wear: the built-ins and the themes it registers. */
function offeredThemes(customThemes: unknown): { ids: string[]; palettes: Map<string, string[]> } {
  const palettes = new Map<string, string[]>();
  const ids: string[] = [...THEME_BASES];
  for (const id of THEME_BASES)
    palettes.set(
      id,
      (themePreset(id)?.palettes ?? []).map((palette) => palette.id),
    );
  if (Array.isArray(customThemes))
    for (const spec of customThemes) {
      if (!isRecord(spec) || typeof spec.id !== 'string') continue;
      ids.push(spec.id);
      palettes.set(
        spec.id,
        Array.isArray(spec.palettes) ? spec.palettes.flatMap((p) => (isRecord(p) && typeof p.id === 'string' ? [p.id] : [])) : [],
      );
    }
  return { ids, palettes };
}

function checkTheme(theme: NonNullable<AppPresentation['theme']>, customThemes: unknown, at: string): void {
  const { preset, palette } = themeParts(theme);
  const { ids, palettes } = offeredThemes(customThemes);
  if (!preset || !ids.includes(preset))
    throw new Error(`${at}.theme "${preset}" is not a built-in theme or one this App registers in ui.customThemes (${ids.join(', ')}).`);
  if (palette !== undefined && palette !== 'default' && !palettes.get(preset)?.includes(palette))
    throw new Error(
      `${at}.theme.palette "${palette}" is not a palette of "${preset}": "default"${(palettes.get(preset) ?? []).map((id) => `, "${id}"`).join('')}.`,
    );
}

/** Every file the logo names must be a file in the directory: said here by the presentation's own key, before the load names it as `ui.logo`. */
async function checkLogo(logo: NonNullable<AppPresentation['logo']>, dir: string | undefined, at: string): Promise<void> {
  if (!dir) throw new Error(`${at}.logo is a file in the App's directory; load the App from its directory: --app <dir>.`);
  for (const [key, value] of Object.entries(logoParts(logo))) {
    const info = await stat(resolve(dir, value)).catch(() => undefined);
    if (!info?.isFile())
      throw new Error(`${at}.logo${key === 'src' ? '' : `.${key}`} "${value}" is not a file in the App's directory (${dir}).`);
  }
}

/**
 * The definition as the deployment presents it, before it is parsed (so every validation, the catalogs, a reader's
 * language and every consumer of the App's name see one App). Throws, naming the config key and the fix.
 */
export async function overlayPresentation(
  raw: Record<string, unknown>,
  presentation: AppPresentation,
  where: { file?: string; id: string; dir?: string },
): Promise<Record<string, unknown>> {
  const at = `${where.file ?? 'the config file'}: "presentation.${where.id}"`;
  const ui = isRecord(raw.ui) ? { ...raw.ui } : {};
  const out: Record<string, unknown> = { ...raw };
  if (presentation.name !== undefined) {
    out.name = presentation.name;
    // The phone's bar would keep saying the program it was written for.
    delete out.shortName;
  }
  if (presentation.logo !== undefined) {
    await checkLogo(presentation.logo, where.dir, at);
    ui.logo = { ...logoParts(presentation.logo) };
  }
  if (presentation.theme !== undefined) {
    checkTheme(presentation.theme, ui.customThemes, at);
    const { preset, palette } = themeParts(presentation.theme);
    // A theme bound to a tenant's record keeps the binding; the deployment's theme is what a tenant with none wears.
    ui.theme =
      isRecord(ui.theme) && Object.hasOwn(ui.theme, 'kind')
        ? { ...ui.theme, fallback: { preset } }
        : { preset, ...(palette === undefined ? {} : { palette }) };
  }
  if (presentation.locale !== undefined) {
    // A reader-owned column stays; the deployment's tag is the default under it.
    ui.locale = isRecord(ui.locale) ? { ...ui.locale, default: presentation.locale } : presentation.locale;
  }
  out.ui = ui;
  return out;
}

/** The same overlay on a definition already parsed (a build's): name, theme and locale, where the logo is the build's own. */
export function presentServed(app: AppDef, presentation: AppPresentation, where: { file?: string; id: string }): AppDef {
  const at = `${where.file ?? 'the config file'}: "presentation.${where.id}"`;
  if (presentation.logo !== undefined)
    throw new Error(
      `${at}.logo cannot change a built App: a build carries the logo it was built with. Serve the App from its source directory, or rebuild it with the logo.`,
    );
  const { shortName: _short, ...rest } = app;
  const ui = { ...app.ui };
  if (presentation.theme !== undefined) {
    checkTheme(presentation.theme, app.ui.customThemes, at);
    const { preset, palette } = themeParts(presentation.theme);
    ui.theme = { preset, ...(palette === undefined ? {} : { palette }) };
  }
  if (presentation.locale !== undefined) ui.locale = presentation.locale;
  return { ...(presentation.name === undefined ? app : { ...rest, name: presentation.name }), ui };
}
