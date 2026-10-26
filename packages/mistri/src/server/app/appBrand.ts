/**
 * An App's own logo picture (`ui.logo: { src, dark, mark }`): read from the
 * App's directory when the App loads, admitted as a tenant's upload is
 * (brandImage.ts: a raster its first bytes say is one, or an SVG written again
 * from an allowlist), held in memory and served from the App's own origin at
 * `/{app}/_brand/<name>-<hash>.<ext>` (http/brandRoutes.ts), the way a theme's
 * faces are (appFonts.ts). A file is named for its content, so a changed logo
 * is a new address and the old one may be kept for a year.
 *
 * A file is read only from inside the App's directory, after its links are
 * resolved: `src` is a path a load follows, and nothing else on the machine is
 * the App's to serve.
 */
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import type { AppDef } from '../../shared/app.js';
import type { AppLogoImage } from '../../shared/appModel.js';
import { BRAND_SEGMENT } from '../../shared/appBrandAddress.js';
import { admitLogo, LogoRefused } from './brandImage.js';
import { readThemeStylesheet, STYLESHEET_MAX } from './themeStylesheet.js';
import { partSelector } from './themePartSelectors.js';
import { themeFileRoot } from '../../shared/themeSpec.js';
import type { ThemeDefinition } from '@mistriwork/engine/shared/theme.js';

export interface AppBrand {
  /** The bytes of each served file, by its name. */
  files: Record<string, Buffer>;
  /** Each served file's type, as its bytes said it. */
  types: Record<string, string>;
  /** Each served file's source in the App directory, relative to it: what a watcher and a build follow. */
  sources: Record<string, string>;
}

/* A file past this is refused before it is read: admitLogo holds a raster to 256 KB and an SVG to 64 KB. */
const READ_MOST = 1024 * 1024;
const EXTENSION: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
};
const PARTS = [
  ['src', 'href'],
  ['dark', 'darkHref'],
  ['mark', 'markHref'],
] as const;

/** A theme's stylesheet as it is served: its own type, which no picture's bytes say. */
export const STYLESHEET_TYPE = 'text/css; charset=utf-8';

/** The App's logo when it is a picture; an icon's name is drawn from the App's own glyphs. */
function logoImage(app: Pick<AppDef, 'ui'>): AppLogoImage | undefined {
  const logo = app.ui.logo;
  return logo && typeof logo === 'object' ? logo : undefined;
}

/** A served name: the file's own name, cut to a slug, its content's hash and the extension its bytes say. */
function servedName(src: string, bytes: Buffer, type: string): string {
  const stem =
    basename(src, extname(src))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'logo';
  return `${stem}-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}${EXTENSION[type]}`;
}

/**
 * Reads each of the logo's pictures from the App directory and names it on the logo (`href`, `darkHref`,
 * `markHref`), so the payload and the first paint say where it is served. Refuses a file that is missing, outside
 * the directory, or not a picture its bytes say is one. Undefined for an App whose logo is an icon or none.
 */
export async function readAppBrand(
  app: Pick<AppDef, 'id' | 'ui'>,
  dir: string | undefined,
  manifest: string,
): Promise<AppBrand | undefined> {
  const logo = logoImage(app);
  const brand: AppBrand = { files: {}, types: {}, sources: {} };
  /* Its themes' stylesheets are served the same way, beside the logo (readThemeSheets). */
  const sheets = await readThemeSheets(app, dir, manifest, brand);
  if (!logo) return sheets ? brand : undefined;
  if (!dir)
    throw new Error(
      `${manifest}: ui.logo.src is a file in the App's directory; load the App from its directory: --app <dir>, with --app-entry ${manifest} to keep this manifest.`,
    );
  const home = await realpath(dir);
  for (const [key, served] of PARTS) {
    const src = logo[key];
    if (!src) continue;
    const said = `${manifest}: ui.logo.${key} "${src}"`;
    let file: string;
    try {
      file = await realpath(resolve(dir, src));
    } catch {
      throw new Error(`${said} is not a file in the App's directory.`);
    }
    const inside = relative(home, file);
    if (!inside || inside.startsWith('..') || inside.split(sep).includes('..') || resolve(home, inside) !== file)
      throw new Error(`${said} leads outside the App's directory; a logo serves only the App's own files.`);
    const info = await stat(file);
    if (!info.isFile()) throw new Error(`${said} is not a file in the App's directory.`);
    if (info.size > READ_MOST) throw new Error(`${said} is ${Math.round(info.size / 1024)} KB; a logo is at most 256 KB.`);
    let admitted;
    try {
      admitted = admitLogo(await readFile(file));
    } catch (error) {
      if (error instanceof LogoRefused) throw new Error(`${said}: ${error.message}`);
      throw error;
    }
    const name = servedName(src, admitted.bytes, admitted.type);
    brand.files[name] = admitted.bytes;
    brand.types[name] = admitted.type;
    brand.sources[name] = inside.split(sep).join('/');
    logo[served] = `/${encodeURIComponent(app.id)}/${BRAND_SEGMENT}/${name}`;
  }
  return brand;
}

/**
 * Each App theme's stylesheet (`stylesheet: './theme.css'`, themeStylesheet.ts): read from the theme's directory (a
 * package's, by its `from`, or the App's), held to it as a face is, checked against the allowlist and served scoped,
 * at `/{app}/_brand/<theme>-<hash>.css`, with each picture it names admitted as a logo is and served beside it.
 * A sheet with any problem refuses the load naming its line and why (theme-css): nothing of it is served. Whether
 * any theme had one.
 */
async function readThemeSheets(
  app: Pick<AppDef, 'id' | 'ui'>,
  dir: string | undefined,
  manifest: string,
  brand: AppBrand,
): Promise<boolean> {
  const themes = (app.ui.customThemes ?? []).flatMap((theme, index) =>
    theme.stylesheet ? [{ theme, index, sheet: theme.stylesheet }] : [],
  );
  /* One sheet a theme inherits from another (a package's look) is read once and served for each theme scoped to it. */
  for (const { theme, index, sheet } of themes) {
    const said = `${manifest}: ui.customThemes[${index}] ("${theme.id}") stylesheet ${sheet.src}`;
    const base = themeFileRoot(sheet) ?? dir;
    if (!base)
      throw new Error(
        `${said} is a file in the App's directory; load the App from its directory: --app <dir>, with --app-entry ${manifest} to keep this manifest.`,
      );
    const owner = themeFileRoot(sheet) ? 'its package' : "the App's directory";
    const home = await realpath(base);
    const within = async (src: string, what: string, most: number) => {
      let file: string;
      try {
        file = await realpath(resolve(base, src));
      } catch {
        throw new Error(`${what} is not a file in ${owner}.`);
      }
      const inside = relative(home, file);
      if (!inside || inside.startsWith('..') || inside.split(sep).includes('..') || resolve(home, inside) !== file)
        throw new Error(`${what} leads outside ${owner}; a theme serves only its own files.`);
      const info = await stat(file);
      if (!info.isFile()) throw new Error(`${what} is not a file in ${owner}.`);
      if (info.size > most) throw new Error(`${what} is ${Math.round(info.size / 1024)} KB; it is at most ${Math.round(most / 1024)} KB.`);
      return { bytes: await readFile(file), inside: inside.split(sep).join('/') };
    };
    const css = await within(sheet.src, said, Math.max(STYLESHEET_MAX, 1));
    const source = css.bytes.toString('utf8');
    const at = (problem: { line: number; text: string; why: string }) => `${said} line ${problem.line}: ${problem.text}: ${problem.why}`;
    /* First its pictures, by the names the sheet says, relative to the sheet; then the sheet with their addresses. */
    const first = readThemeStylesheet(source, { themeId: theme.id, selectorFor: partSelector });
    if (first.problems.length) throw new Error(first.problems.map(at).join('\n'));
    const served = new Map<string, string>();
    const folder = sheet.src.slice(0, sheet.src.lastIndexOf('/') + 1);
    for (const file of first.files) {
      const picture = await within(`${folder}${file.slice(2)}`, `${said} url(${file})`, 1024 * 1024);
      let admitted;
      try {
        admitted = admitLogo(picture.bytes);
      } catch (error) {
        if (error instanceof LogoRefused) throw new Error(`${said} url(${file}): ${error.message}`);
        throw error;
      }
      const name = servedName(file, admitted.bytes, admitted.type);
      brand.files[name] = admitted.bytes;
      brand.types[name] = admitted.type;
      brand.sources[name] = picture.inside;
      /* Beside the sheet, by its served name alone: the sheet's own address resolves it wherever the App is
         mounted (at `/`, under `/{app}`, behind a base path), so the sheet never says where that is. */
      served.set(file, name);
    }
    const read = readThemeStylesheet(source, { themeId: theme.id, selectorFor: partSelector, url: (file) => served.get(file) });
    if (read.problems.length) throw new Error(read.problems.map(at).join('\n'));
    const bytes = Buffer.from(read.css, 'utf8');
    const name = `${theme.id}-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.css`;
    brand.files[name] = bytes;
    brand.types[name] = STYLESHEET_TYPE;
    brand.sources[name] = css.inside;
    /* The served addresses on the theme, for the payload and a build; an inherited sheet is a new record per theme. */
    const named = { src: sheet.src, href: `/${encodeURIComponent(app.id)}/${BRAND_SEGMENT}/${name}`, files: [...served.values()] };
    (theme as { stylesheet?: ThemeDefinition['stylesheet'] }).stylesheet = named;
  }
  return themes.length > 0;
}

/** A build's logo and theme stylesheets, read back from its `brand/` folder by the names its definition carries. */
export async function readBuiltBrand(app: Pick<AppDef, 'ui'>, dir: string, rebuild: string): Promise<AppBrand | undefined> {
  const logo = logoImage(app);
  const brand: AppBrand = { files: {}, types: {}, sources: {} };
  const read = async (name: string) => {
    const bytes = await readFile(join(dir, 'brand', name)).catch(() => undefined);
    if (!bytes) throw new Error(`${dir}: brand/${name} is missing. ${rebuild}`);
    return bytes;
  };
  const sheets = (app.ui.customThemes ?? []).flatMap((theme) => (theme.stylesheet ? [theme.stylesheet] : []));
  for (const sheet of sheets) {
    const name = sheet.href?.split('/').pop();
    if (!name) throw new Error(`${dir}: a theme's stylesheet ${sheet.src} has no built file. ${rebuild}`);
    brand.files[name] = await read(name);
    brand.types[name] = STYLESHEET_TYPE;
    brand.sources[name] = sheet.src.replace(/^\.\//, '');
    for (const picture of sheet.files ?? []) {
      const type = Object.entries(EXTENSION).find(([, extension]) => picture.endsWith(extension))?.[0];
      if (!type) throw new Error(`${dir}: brand/${picture} is not a picture this build wrote. ${rebuild}`);
      brand.files[picture] = await read(picture);
      brand.types[picture] = type;
      brand.sources[picture] = picture;
    }
  }
  if (!logo) return sheets.length ? brand : undefined;
  for (const [key, served] of PARTS) {
    if (!logo[key]) continue;
    const name = logo[served]?.split('/').pop();
    if (!name) throw new Error(`${dir}: ui.logo.${key} ${logo[key]} has no built file. ${rebuild}`);
    const bytes = await readFile(join(dir, 'brand', name)).catch(() => undefined);
    if (!bytes) throw new Error(`${dir}: brand/${name} is missing. ${rebuild}`);
    const type = Object.entries(EXTENSION).find(([, extension]) => name.endsWith(extension))?.[0];
    if (!type) throw new Error(`${dir}: brand/${name} is not a picture this build wrote. ${rebuild}`);
    brand.files[name] = bytes;
    brand.types[name] = type;
    brand.sources[name] = logo[key]!.replace(/^\.\//, '');
  }
  return brand;
}

/**
 * What `check` says about the logo beyond what refuses the load: a picture with no dark answer is drawn as it is on
 * the dark bar (the theme contract's C10, `theme-dark`).
 */
export function brandWarnings(app: Pick<AppDef, 'ui'>): string[] {
  const logo = logoImage(app);
  if (!logo || logo.dark) return [];
  return [
    `ui.logo.src "${logo.src}" has no dark: the same picture is drawn on the dark bar. Say ui.logo.dark, or name the same file there when it reads on both.`,
  ];
}
