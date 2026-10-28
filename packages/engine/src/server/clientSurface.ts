/**
 * Which part of the client an address's first page will need, so the page
 * sent for it names that part and the browser fetches it beside the entry.
 *
 * The client boots in surfaces (vite.config.ts, `surfaces`): the entry
 * decides, from the path and who-am-I, whether to draw a public page or the
 * shell, and imports that chunk. Left to the entry, the chunk would be asked
 * for only once the entry had run — a second round trip before anything
 * paints. So the build writes one page per surface, each preloading its own
 * chunk, and the server sends the one the address asks for. A guess that
 * turns out wrong (a signed-out visitor at an App's root, sent to sign in)
 * costs the import the entry makes anyway, never a wrong page.
 *
 * An App's shell page preloads the kit's shell and the App's chrome. The
 * database browser's pages are a third: its main and the shell, and the
 * `mistri-shell` meta that tells the entry to start that main
 * (packages/kit/src/client/shellStart.js). The browser says so when it sends one
 * (clientHttp.ts `ShellTitle.workbench`); an address alone never does.
 *
 * The paths are the client's own (packages/mistri/src/client/publicRoutes.js), and
 * test/client-surface.test.ts holds the two readings together.
 */
import type { ThemeDefinition } from '../shared/theme.js';
import { recipeAttributes } from '../shared/themeRecipes.js';
import { effectiveThemeDefinition, themePreset } from '../shared/themePresets.js';
import { resolveTheme, type ThemeAudiences } from '../shared/themeResolve.js';
import { faceRules, headingFace } from '../shared/themeFaces.js';

type ClientSurface = 'shell' | 'public' | 'workbench';

/**
 * An App's `ui` as far as the look its page wears goes (the App framework's
 * shared/appModel.ts AppUi): the look it names, the one per audience, and its
 * own themes. A first page is sent in it; nothing else of the App is read.
 */
interface LookChoice {
  theme?: { preset?: string; for?: ThemeAudiences };
  customThemes?: readonly ThemeDefinition[];
}

/** The page the build writes for each surface, under dist/client. */
export const SURFACE_PAGES: Readonly<Record<ClientSurface, string>> = {
  shell: 'index.html',
  public: 'index.public.html',
  workbench: 'index.workbench.html',
};

/** A public form (`/{app}/form/{id}`, its `/status` and `/claim`), the landing for anyone (`/{app}/welcome`) or the staff door (`/{app}/sign-in`). */
const PUBLIC = /^\/[^/@~]+\/(?:form\/[a-z0-9][a-z0-9-]{0,63}(?:\/(?:status|claim))?|welcome|sign-in)\/?$/;

export function surfaceFor(pathname: string): Exclude<ClientSurface, 'workbench'> {
  return PUBLIC.test(pathname) ? 'public' : 'shell';
}

/**
 * The look sheets (`lumen`, `sage`, `brand`) an App's own look wears, so its
 * page can ask for them beside the entry. The client fetches a look's sheet
 * when it applies the look (visualTheme.ts) and holds the reveal until it is
 * here, which left the sheet a second round trip behind the entry on a first
 * visit. The App's own look is the guess: a reader who picked another wears
 * that, and the guess costs one sheet fetched and not used. It stays out of
 * the first-paint bundle — a preload is a request, not bytes in the entry.
 */
export function lookSheetsFor(ui: LookChoice | undefined, audience?: Audience): readonly string[] {
  const theme = wornTheme(ui, audience);
  return theme ? recipeAttributes(theme).sheets : [];
}

/**
 * The density the App's look starts at, so the page zooms to it before its
 * first paint (client density.js). Guessed like the sheets: a reader who
 * picked another look, or a density of their own, wears theirs.
 */
export function lookDensityFor(ui: LookChoice | undefined, audience?: Audience): string | undefined {
  return wornTheme(ui, audience)?.density;
}

/**
 * The scheme the App's look says (`scheme: 'dark'` or `'dark-only'`), so the first page is sent already dark
 * (index.html's boot script stamps it before any style is read). Left to the client, which learns the theme a round
 * trip later, a first visit painted light and flipped. Guessed like the sheets, and a reader's own stored mode still
 * wins when the script runs.
 */
export function lookSchemeFor(ui: LookChoice | undefined, audience?: Audience): 'dark' | 'dark-only' | undefined {
  return wornTheme(ui, audience)?.scheme;
}

/** The grounds a page is sent for the browser's own chrome (`theme-color`, `color-scheme`): the page's colour in each
    mode, and whether the theme is dark in both (`dark-only`). */
export interface PageGrounds {
  light: string;
  dark: string;
  scheme?: 'dark' | 'dark-only';
}

/** A theme's ground in each mode, the surface where it names none (a palette's page is then its panels'). */
export function groundsOf(theme: ThemeDefinition): PageGrounds {
  const worn = effectiveThemeDefinition(theme, 'default');
  const ground = (mode: 'light' | 'dark') => worn[mode].ground ?? worn[mode].surface;
  return { light: ground('light'), dark: ground('dark'), ...(theme.scheme ? { scheme: theme.scheme } : {}) };
}

/**
 * The grounds the App's look wears, said in the page's head as `theme-color` and `color-scheme`, so the address bar and
 * the overscroll are the page's colour from the first byte instead of white until a script runs. Guessed like the
 * sheets: a reader who picked another look or mode wears theirs.
 */
export function lookGroundsFor(ui: LookChoice | undefined, audience?: Audience): PageGrounds | undefined {
  const theme = wornTheme(ui, audience);
  return theme ? groundsOf(theme) : undefined;
}

/** Who the page is for: a signed-out visitor, or a member holding these roles (`ui.theme.for`). */
export interface Audience {
  public?: boolean;
  roles?: readonly string[];
}

/** The theme an App's page is guessed to wear: its audience's (themeResolve.ts) without a reader's pick, which the
    server cannot see, else the App's own look, else Workshop's. */
function wornTheme(ui: LookChoice | undefined, audience: Audience = {}) {
  if (!ui) return undefined;
  const offered = (id: string) => Boolean(ui.customThemes?.some((item) => item.id === id) ?? false) || Boolean(themePreset(id));
  const { id } = resolveTheme({ ...audience, for: ui.theme?.for, preset: ui.theme?.preset, offered });
  return ui.customThemes?.find((item) => item.id === id) ?? themePreset(id) ?? themePreset('workshop');
}

/** The faces each look sheet declares, by the families a stack begins with to be set in them (lumenLook.css,
    workshopLook.css), and the files preloaded: Workshop's regular and its condensed bold, which every page draws;
    its semibold comes when a line asks for it. */
const SHEET_FACES: Readonly<Record<string, { families: readonly string[]; file: RegExp }>> = {
  workshop: { families: ['Barlow', 'Barlow Semi Condensed'], file: /^assets\/barlow-(?:400|semi-condensed-700)-[\w-]+\.woff2$/ },
  lumen: { families: ['Inter'], file: /^assets\/inter-latin-[\w-]+\.woff2$/ },
};

/**
 * The sheets whose face the App's look is set in, so its page can ask for
 * the face beside the sheet. A sheet is worn for its recipes, and a theme on
 * Sage that borrows one of Lumen's wears Lumen's sheet with its own stack:
 * the face is preloaded only where the interface or its headings begin with
 * it, never fetched for a page that would not draw a line in it.
 */
export function lookFacesFor(ui: LookChoice | undefined, audience?: Audience): readonly string[] {
  const theme = wornTheme(ui, audience);
  if (!theme) return [];
  const first = (stack: string | undefined) =>
    stack
      ?.split(',')[0]
      ?.trim()
      .replace(/^["']|["']$/g, '');
  const leads = new Set([first(theme.fonts?.ui), first(theme.fonts?.heading)]);
  return recipeAttributes(theme).sheets.filter((sheet) => SHEET_FACES[sheet]?.families.some((family) => leads.has(family)));
}

/**
 * The App's own faces in its page's head (`type.faces`, server/app/appFonts.ts):
 * their `@font-face` rules, so a line is drawn in its face as soon as the face
 * is here rather than once the script has declared it, and a preload of the
 * face its headings are drawn in, so that one is fetched beside the entry
 * instead of a round trip after the first heading is laid out. Only the worn
 * theme's heading face is preloaded: a preload is a request every visit pays,
 * and the rest are fetched where a line needs them. A face is the App's own
 * file from its own origin (`font-src 'self'`), never the bundle's bytes, so it
 * stands outside the first-paint budgets (scripts/bundle-budget.mjs). `shown`
 * says an inside address the way the browser asks for it (shared/mount.ts).
 */
export function appFaceHead(ui: LookChoice | undefined, shown: (href: string) => string, audience?: Audience): string {
  const theme = wornTheme(ui, audience);
  const rules = faceRules(theme, shown);
  if (!rules) return '';
  const heading = theme && headingFace(theme);
  const type = heading?.href?.endsWith('.woff') ? 'font/woff' : 'font/woff2';
  return (
    /* A face is fetched in CORS mode, so its preload says `crossorigin`, or it is fetched twice (lookPreloads). */
    (heading ? `    <link rel="preload" as="font" type="${type}" crossorigin href="${shown(heading.href!)}">\n` : '') +
    `    <style id="mistri-theme-faces">${rules}</style>\n`
  );
}

/** A built look sheet's file, `assets/lumenLook-<hash>.css`, by the sheet's name. */
/** The chrome's words in one language (vite.config.ts LOCALE_GROUP): `assets/copy.es-<hash>.js`. */
const WORDS_FILE = /^assets\/copy\.([a-z]{2,3})-[\w-]+\.js$/;

/**
 * The chrome's words for a reader who does not read English, preloaded beside
 * the entry: the client asks for them before it draws its first words
 * (messages.ts `setMessageScope`), and left to it that is one round trip more
 * than an English reader pays. English is in the entry, so it needs nothing;
 * a language the chrome has no words for has no chunk and so no preload.
 */
export function localePreloads(locale: string | undefined, files: Iterable<string>): string {
  const language = locale?.split('-')[0]?.toLowerCase();
  if (!language || language === 'en') return '';
  for (const file of files)
    if (WORDS_FILE.exec(file)?.[1] === language) return `    <link rel="modulepreload" crossorigin href="/${file}">\n`;
  return '';
}

/** The tenant's flows (vite.config.ts `surfaces`, `tenant`): `assets/tenant-<hash>.js` and its sheet. */
const TENANT_FILE = /^assets\/tenant-[\w-]+\.(js|css)$/;

/**
 * A tenant host's shell page asks for the tenant's flows beside the entry. The shell imports them once who-am-I
 * has said the session is a tenant's (appChrome.js `loadTenancy`), which left their fetch a round trip behind
 * who-am-I and in front of entering; on a tenant host a signed-in session is always one. A visitor sent on to sign
 * in costs the fetch and nothing else. The sheet says `crossorigin`, as the loader's own stylesheet link does.
 */
export function tenantPreloads(files: Iterable<string>): string {
  let links = '';
  for (const file of files) {
    const kind = TENANT_FILE.exec(file)?.[1];
    if (kind === 'js') links += `    <link rel="modulepreload" crossorigin href="/${file}">\n`;
    else if (kind === 'css') links += `    <link rel="preload" as="style" crossorigin href="/${file}">\n`;
  }
  return links;
}

const LOOK_FILE = /^assets\/([a-z]+)Look-[\w-]+\.css$/;

/**
 * The preload links for the look sheets a page will wear, and the faces they
 * declare, from the files the build wrote (none under the dev server). A face
 * is otherwise asked for only once the sheet has been parsed and a line
 * drawn in it, a round trip after the sheet; preloaded, it comes beside it.
 */
export function lookPreloads(sheets: readonly string[], files: Iterable<string>, faces: readonly string[] = []): string {
  if (!sheets.length) return '';
  const wanted = new Set(sheets);
  let links = '';
  for (const file of files) {
    const name = LOOK_FILE.exec(file)?.[1];
    /* `crossorigin`, as the loader's own stylesheet link is: a preload in another mode would be fetched twice. */
    if (name && wanted.has(name)) links += `    <link rel="preload" as="style" crossorigin href="/${file}">\n`;
    /* A face is always fetched in CORS mode, so its preload says `crossorigin` too, or it is fetched again. */
    if (faces.some((sheet) => sheets.includes(sheet) && SHEET_FACES[sheet]?.file.test(file)))
      links += `    <link rel="preload" as="font" type="font/woff2" crossorigin href="/${file}">\n`;
  }
  return links;
}
