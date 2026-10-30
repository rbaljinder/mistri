/**
 * `mistri shot`: an App's pages as PNG files, so the agent that built them
 * can look at what it made.
 *
 * An agent authoring an App checks it with `mistri check` and never sees
 * it: the dashboards came out well and the record pages basic, and nothing in
 * the loop could tell the two apart. This serves the App the way a person
 * would open it — its own server on a free port, over its own database, its
 * config directory a fresh temporary one, so no auth store, layout or token
 * of the reader's is read or written — drives Chromium to each address, waits
 * for the page to settle and writes one file per address, look and size.
 *
 * Chromium is Playwright's, found where it is installed: beside mistri (a
 * checkout, where it is a devDependency) or in the project it is run from.
 * It is not a dependency of the package: a browser is some 150 MB that every
 * `npx tablewalk` would download for a command most never run, so a person
 * without it is told the one line that installs it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer, type AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser, BrowserContext, BrowserType, Page } from 'playwright-core';
import { settled, watchRequests } from '../testing/settled.js';
import { Registry, redact } from '@mistriwork/engine/server/connections.js';
import { appRoutes, loadApp, type LoadedApp } from '../app/apps.js';
import { loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import { homeSourceOf, isTenantApp } from '../../shared/app.js';
import type { AddressBook } from '../../shared/appAddress.js';
import { THEME_PRESETS } from '@mistriwork/engine/shared/themePresets.js';
import { ROUND } from '@mistriwork/engine/shared/themeTokens.js';
import { placementIn } from '../../shared/appUi.js';
import { RECIPE_MENU, RECIPE_PARTS } from '@mistriwork/engine/shared/themeRecipes.js';
import type { ThemeDefinition, ThemeRecipes } from '@mistriwork/engine/schema/theme.js';
import { parseArgs } from '@mistriwork/engine/server/cli/args.js';
import { appHome, inward, outward, settingsMount, type AddressMount } from '@mistriwork/engine/shared/mount.js';
import { readStartupConfig } from '@mistriwork/engine/server/cli/config.js';
import { selfInvocation } from './build.js';
import { namesAccount, personEmails, shotAccount, shotRoleAccount } from './shotAccount.js';
import type { TenantShotAccount } from './shotTenant.js';
import { asRoleRefusal, peopleRoles } from './shotRoles.js';
import { readPage, sayPage } from './shotText.js';
import { inPage } from './gradeProbe.js';
import { performSteps, STEP_FLAGS, stepOf, type ShotStep } from './shotSteps.js';
import { MATRIX_MODES, MATRIX_SIZES, matrixFile, matrixIndex } from './shotMatrix.js';
import { CONFIG_SECTIONS } from '../serviceConnections.js';

const SHOT_USAGE =
  'mistri shot --app <dir> [<route>…] [<db> | --db <target> | --config <path>] [--commands <file>] [--jobs <file>] [--policy <file>]\n' +
  '               [--theme <id|all>] [--palette <id>] [--compare <look>] [--recipes <part>] [--dark | --light] [--phone | --desk | --both] [--width <px>]\n' +
  '               [--click <name>] [--type <field> <text>] [--press <key>] [--wait-for <text>] [--matrix]\n' +
  '               [--full] [--scale <1-3>] [--as <role|email> [--tenant <id>]] [--out <dir>] [--text] [--browser <path>]';
const SHOT_EXIT = { shot: 0, couldNotShoot: 1, pageErrors: 2 } as const;
const SIZES = { desk: { width: 1280, height: 900 }, phone: { width: 390, height: 844 } } as const;
/* A whole page is captured up to this tall: past it, a list is its pager's job. */
const TALLEST = 8000;
/* shot launches Chromium headless, which is Playwright's headless shell: the one browser it needs installed. */
const SHELL = 'install --only-shell chromium';
const INSTALL_HINT = `mistri shot needs Playwright: npm i -D playwright && npx playwright ${SHELL}`;

/**
 * The line that installs the browser the found Playwright launches: its own CLI's, so the browser is
 * the build that Playwright expects. `npx playwright` reaches it only when it is the project's own.
 */
export function browserInstallLine(packageDir: string | undefined, projectDir: string): string {
  const within = packageDir === undefined ? '' : relative(join(projectDir, 'node_modules'), packageDir);
  const own = packageDir === undefined || (!within.startsWith('..') && !isAbsolute(within) && !within.split(sep).includes('node_modules'));
  return own ? `npx playwright ${SHELL}` : `node ${JSON.stringify(join(packageDir!, 'cli.js'))} ${SHELL}`;
}

interface ShotOptions {
  app?: string;
  routes: string[];
  /** The looks asked for by id (built-in or the App's own), `all` among them; checked once the App is read. */
  looks: string[];
  palette?: string;
  /** A look to shoot beside the App's own (or --theme), one picture of the two. */
  compare?: string;
  /** A recipe part to shoot once per value, the App's theme (or --theme) otherwise as it is: a contact sheet. */
  recipes?: RecipePart;
  dark: boolean;
  /** `--light` or `--dark`: the scheme as the reader's own pick (kept where the page keeps it), not only the machine's. */
  pick?: 'light' | 'dark';
  /** What a reader does before the picture, in the order the flags were given (shotSteps.ts). */
  steps: ShotStep[];
  /** Every built-in look, light and dark, desk and phone, with an index page of them. */
  matrix: boolean;
  /** `--phone`, `--desk`, `--both` or `--width` was given: the matrix has its own sizes. */
  sized: boolean;
  sizes: Array<keyof typeof SIZES>;
  width?: number;
  full: boolean;
  scale: number;
  as?: string;
  tenant?: string;
  out?: string;
  text: boolean;
  /** A Chromium or Chrome executable to launch in place of Playwright's own (`--browser`, else `CHROME`). */
  browser?: string;
  rest: string[];
}

/** A run that cannot go on, said to the reader as one line: shot's and grade's. */
export class Refusal extends Error {}

/** This command's own flags; the rest are a start's (the database, the server entries) and go to the server. */
function readFlags(argv: string[]): ShotOptions {
  const options: ShotOptions = {
    routes: [],
    looks: [],
    dark: false,
    steps: [],
    matrix: false,
    sized: false,
    sizes: ['desk'],
    full: false,
    scale: 1,
    text: false,
    rest: [],
  };
  const value = (i: number, flag: string) => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('-')) throw new Refusal(`${flag} needs a value.`);
    return next;
  };
  const takesValue = new Set([
    '--db',
    '-d',
    '--config',
    '--commands',
    '--jobs',
    '--policy',
    '--app-entry',
    '--schema',
    '--mount',
    '--base-path',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--app') {
      if (options.app) throw new Refusal('--app may be supplied only once.');
      options.app = value(i, arg);
      i++;
    } else if (arg === '--theme') {
      // One list: a built-in look or the App's own theme, by id. The App is not read yet, so each is checked once it is.
      options.looks.push(...value(i, arg).split(','));
      i++;
    } else if (arg === '--palette' || arg === '--compare') {
      options[arg === '--palette' ? 'palette' : 'compare'] = value(i, arg);
      i++;
    } else if (arg === '--recipes') {
      const part = value(i, arg);
      i++;
      if (!RECIPE_SHEET_PARTS.includes(part as RecipePart))
        throw new Refusal(`--recipes "${part}" is not a part a theme dresses: ${RECIPE_SHEET_PARTS.join(', ')}.`);
      options.recipes = part as RecipePart;
    } else if (arg === '--dark' || arg === '--light') {
      options.dark = arg === '--dark';
      options.pick = options.dark ? 'dark' : 'light';
    } else if (arg === '--matrix') options.matrix = true;
    else if (arg in STEP_FLAGS) {
      // Words that may begin with a dash (a key, typed text) are still the step's: it takes exactly as many as it needs.
      const words = argv.slice(i + 1, i + 1 + STEP_FLAGS[arg]!);
      if (words.length < STEP_FLAGS[arg]! || (arg !== '--type' && words[0]!.startsWith('--')))
        throw new Refusal(`${arg} needs ${STEP_FLAGS[arg] === 2 ? 'a field and the text to type' : 'a value'}.`);
      options.steps.push(stepOf(arg, words));
      i += words.length;
    } else if (arg === '--phone' || arg === '--desk' || arg === '--both') {
      options.sizes = arg === '--phone' ? ['phone'] : arg === '--desk' ? ['desk'] : ['desk', 'phone'];
      options.sized = true;
    } else if (arg === '--full') options.full = true;
    else if (arg === '--width') {
      // The window's width in place of the size's own: a docs picture of a narrow desk, a tablet.
      const said = value(i, arg);
      i++;
      const width = Number(said);
      if (!Number.isInteger(width) || width < 320 || width > 2560)
        throw new Refusal(`--width "${said}" is not a whole number of pixels from 320 to 2560.`);
      options.width = width;
      options.sized = true;
    } else if (arg === '--text') options.text = true;
    else if (arg === '--scale') {
      // Device pixels per CSS pixel: the page lays out as at 1, the picture is sharper.
      const said = value(i, arg);
      i++;
      const scale = Number(said);
      if (!Number.isFinite(scale) || scale < 1 || scale > 3) throw new Refusal(`--scale "${said}" is not a number from 1 to 3.`);
      options.scale = scale;
    } else if (arg === '--as') {
      options.as = value(i, arg);
      i++;
    } else if (arg === '--tenant') {
      options.tenant = value(i, arg);
      i++;
    } else if (arg === '--out') {
      options.out = value(i, arg);
      i++;
    } else if (arg === '--browser') {
      options.browser = value(i, arg);
      i++;
    } else if (takesValue.has(arg)) {
      options.rest.push(arg, value(i, arg));
      i++;
    }
    // A bare word is a database when it reads as one (mistri <sqlite-file>), else a route.
    else if (!arg.startsWith('-')) (looksLikeDatabase(arg) ? options.rest : options.routes).push(arg);
    else options.rest.push(arg);
  }
  if (options.width !== undefined && options.sizes.length > 1)
    throw new Refusal("--width sets one window's width; use it with --desk or --phone, not --both.");
  if (options.compare && (options.looks.length > 1 || options.looks.includes('all')))
    throw new Refusal("--compare shoots one look beside one theme: the App's own, or the one --theme names.");
  if (options.compare && options.text) throw new Refusal('--compare makes a picture; --text has none.');
  if (options.recipes && (options.compare || options.text || options.looks.length > 1 || options.looks.includes('all')))
    throw new Refusal("--recipes shoots one theme's part in each of its values: the App's own theme, or the one --theme names.");
  if (options.recipes && options.routes.length > 1) throw new Refusal('--recipes shoots one page: name it, or leave it out for the home.');
  if (options.recipes && !options.routes.length) options.routes.push('/');
  if (options.matrix) {
    const clash = options.compare ? '--compare' : options.recipes ? '--recipes' : options.text ? '--text' : undefined;
    if (clash)
      throw new Refusal(`--matrix shoots every look (built-in and the App's own) for the routes; it cannot be combined with ${clash}.`);
    if (options.looks.length || options.palette || options.pick || options.sized)
      throw new Refusal(
        "--matrix shoots every built-in look and the App's own, light and dark, at a desk and on a phone: it takes no --theme, --palette, --dark, --light, --desk, --phone, --both or --width.",
      );
  }
  return options;
}

/** The look a window wears: a built-in look or one of the App's own themes (`own`), and a palette of it. */
export interface ShotLook {
  /** The App's id: what the page keeps an App's theme and palette choices under. */
  app: string;
  theme: string;
  own: boolean;
  palette?: string;
  label: string;
  /** Where the menu stands in this look, where that is not where the App draws it now (defineTheme's
      `shell.placement`, else the side): the page is told it, as the App would draw it wearing the theme. Absent
      where the App puts the menu itself. */
  placement?: 'side' | 'top';
  /** The one line that says the App's own placement overrides the one this look suggests. */
  overridden?: string;
}

/**
 * The looks asked for, checked against the App: each a built-in look or a
 * theme of the App's own (`all`: every built-in, then the App's), and the
 * palette, which every look shot must have. None asked and no palette: the
 * App's own, as a reader first sees it (an empty list).
 */
export function shotLooks(loaded: LoadedApp, asked: readonly string[], palette?: string): ShotLook[] {
  const own = loaded.app.ui.customThemes ?? [];
  const every = [...THEME_PRESETS, ...own];
  const ids = asked.length ? asked.flatMap((id) => (id === 'all' ? every.map((theme) => theme.id) : [id])) : palette ? [worn(loaded)] : [];
  return [...new Set(ids)].map((id) => {
    const theme = every.find((candidate) => candidate.id === id);
    if (!theme)
      throw new Refusal(
        `"${id}" is not a look: a built-in one (${THEME_PRESETS.map((item) => item.id).join(', ')})${own.length ? `, one of "${loaded.app.name}"'s own (${own.map((item) => item.id).join(', ')})` : ''}, or all.`,
      );
    if (palette && palette !== 'default' && !theme.palettes?.some((item) => item.id === palette))
      throw new Refusal(
        `--palette "${palette}" is not a palette of ${theme.label}: ${['default', ...(theme.palettes ?? []).map((item) => item.id)].join(', ')}.`,
      );
    const shell = placementIn(loaded.app.ui, theme);
    return {
      app: loaded.app.id,
      theme: id,
      own: own.includes(theme),
      ...(palette ? { palette } : {}),
      label: `${theme.label}${palette && palette !== 'default' ? ` ${theme.palettes!.find((item) => item.id === palette)!.label}` : ''}`,
      ...(shell.moved ? { placement: shell.moved } : {}),
      ...(shell.overridden ? { overridden: shell.overridden } : {}),
    };
  });
}

/** The theme the App wears before a reader picks one. */
const worn = (loaded: LoadedApp) => loaded.app.ui.theme?.preset ?? 'workshop';

/**
 * What the page reads to wear a look (client visualTheme.ts): a built-in look
 * is the reader's one global pick, an App's own theme a pick kept under the
 * App's id, and a palette a pick kept under the App and the theme.
 */
function lookStorage(look: ShotLook | undefined): Array<{ name: string; value: string }> {
  if (!look) return [];
  return [
    look.own
      ? { name: 'mistri.custom-theme-choices', value: JSON.stringify([[look.app, look.theme]]) }
      : { name: 'mistri.visual-theme', value: look.theme },
    ...(look.palette
      ? [{ name: 'mistri.visual-palettes', value: JSON.stringify([[JSON.stringify([look.app, look.theme]), look.palette]]) }]
      : []),
  ];
}

const looksLikeDatabase = (arg: string) =>
  /^(postgres|postgresql|sqlite):/i.test(arg) || /\.(db|db3|sqlite|sqlite3)$/i.test(arg) || (existsSync(arg) && statSync(arg).isFile());

/** Playwright's Chromium, from beside mistri or from the project it is run in, with the line that installs
 * its browser; undefined when neither has it. */
async function findChromium(): Promise<{ chromium: BrowserType; install: string } | undefined> {
  const from = [import.meta.url, pathToFileURL(join(process.cwd(), 'package.json')).href];
  for (const name of ['playwright', 'playwright-core', '@playwright/test']) {
    for (const base of from) {
      try {
        const path = createRequire(base).resolve(name);
        const loaded = (await import(pathToFileURL(path).href)) as { chromium?: BrowserType; default?: { chromium?: BrowserType } };
        const chromium = loaded.chromium ?? loaded.default?.chromium;
        let packageDir: string | undefined;
        try {
          packageDir = dirname(createRequire(base).resolve(`${name}/package.json`));
        } catch {
          /* said as npx */
        }
        if (chromium) return { chromium, install: browserInstallLine(packageDir, process.cwd()) };
      } catch {
        /* not there; the next place */
      }
    }
  }
  return undefined;
}

/**
 * Every Chromium Playwright has installed on this machine, newest first: the cache holds one build per Playwright
 * version, and a project that pins another Playwright (for its own tests) asked shot for a build it never installed
 * while the one it had sat beside it.
 */
export function installedChromiums(
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const caches = [
    environment.PLAYWRIGHT_BROWSERS_PATH && environment.PLAYWRIGHT_BROWSERS_PATH !== '0' ? environment.PLAYWRIGHT_BROWSERS_PATH : undefined,
    platform === 'darwin'
      ? join(home, 'Library', 'Caches', 'ms-playwright')
      : platform === 'win32'
        ? join(environment.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'ms-playwright')
        : join(environment.XDG_CACHE_HOME ?? join(home, '.cache'), 'ms-playwright'),
  ].filter((dir): dir is string => Boolean(dir));
  /* Where each build keeps its executable, by the folder it unpacks to. */
  const inside = (folder: string): string[] =>
    folder.startsWith('chromium_headless_shell-')
      ? platform === 'win32'
        ? ['chrome-headless-shell-win64/chrome-headless-shell.exe', 'chrome-win/headless_shell.exe']
        : platform === 'darwin'
          ? [
              'chrome-headless-shell-mac-arm64/chrome-headless-shell',
              'chrome-headless-shell-mac-x64/chrome-headless-shell',
              'chrome-mac/headless_shell',
            ]
          : ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/headless_shell']
      : folder.startsWith('chromium-')
        ? platform === 'win32'
          ? ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']
          : platform === 'darwin'
            ? [
                'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
                'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
              ]
            : ['chrome-linux64/chrome', 'chrome-linux/chrome']
        : [];
  const build = (folder: string) => Number(/-(\d+)$/.exec(folder)?.[1] ?? 0);
  const found: string[] = [];
  for (const cache of caches) {
    let folders: string[];
    try {
      folders = readdirSync(cache);
    } catch {
      continue;
    }
    /* The headless shell first, as Playwright launches headless; then the full browser. Newest build of each first. */
    for (const kind of ['chromium_headless_shell-', 'chromium-'])
      for (const folder of folders.filter((name) => name.startsWith(kind)).sort((a, b) => build(b) - build(a)))
        for (const file of inside(folder)) if (existsSync(join(cache, folder, file))) found.push(join(cache, folder, file));
  }
  return found;
}

/**
 * The browser shot opens: the one named (`--browser`, else `CHROME`) and nothing else; else Playwright's own, the
 * machine's Chrome, and then any Chromium another Playwright installed here.
 */
async function launch(chromium: BrowserType, named?: string): Promise<Browser> {
  if (named) return chromium.launch({ executablePath: named });
  try {
    return await chromium.launch();
  } catch (first) {
    try {
      return await chromium.launch({ channel: 'chrome' });
    } catch {
      for (const executablePath of installedChromiums()) {
        try {
          return await chromium.launch({ executablePath });
        } catch {
          /* another build; the next */
        }
      }
      throw first;
    }
  }
}

/** One address to shoot: its path, the file name it is saved under, and the view or page it draws (grade names its source). */
export interface Shot {
  path: string;
  name: string;
  view?: string;
  page?: string;
  /** A record's table, where the address is one record's. */
  table?: string;
}

const slug = (path: string) =>
  path
    .replace(/^\/+/, '')
    .replace(/[?&=/.~@]+/g, '-')
    .replace(/[^\w-]+/g, '')
    .replace(/-+$/, '') || 'home';

/**
 * The addresses asked for, each checked against the App's own route book —
 * a segment it does not answer to is refused with the ones it does — or, with
 * none asked, every view and page it declares: each room, and one record of
 * each table a page draws, the first by its key.
 */
async function addresses(
  asked: readonly string[],
  loaded: LoadedApp,
  book: AddressBook,
  firstKey: (table: string, column?: string) => Promise<string | undefined>,
  realm: 'tenant' | 'platform' | undefined,
  mount: AddressMount,
): Promise<Shot[]> {
  const app = encodeURIComponent(loaded.app.id);
  if (asked.length) {
    return asked.map((said) => {
      // An address as the browser shows it (shared/mount.ts), or a route of the App's own.
      const path = said.startsWith('/') ? (inward(mount, said) ?? said) : `/${app}/${said.replace(/^\/+/, '')}`;
      const [first, segment, ...deeper] = path
        .split('?')[0]
        .split('/')
        .filter(Boolean)
        .map((part) => decodeURIComponent(part));
      if (first !== loaded.app.id)
        throw new Refusal(
          `"${said}" is not an address of "${loaded.app.id}": its addresses start ${appHome(mount, loaded.app.id)}. mistri check --routes lists them.`,
        );
      /* A query-language or @/~ address still opens (the App rewrites it); a segment is checked. */
      const known = segment === undefined || segment.startsWith('@') || segment.includes('~') || book.routes.has(segment);
      if (!known) {
        throw new Refusal(
          `"${said}" names no route of "${loaded.app.id}": ${outward(mount, `/${app}/${segment}`)} is not one. Known: ${[...book.routes.keys()].slice(0, 12).join(', ')}${book.routes.size > 12 ? ', …' : ''}. mistri check --routes lists every address.`,
        );
      }
      const target = segment === undefined ? undefined : book.routes.get(segment);
      const form = deeper.length === 1 && deeper[0] === 'new' && (target?.kind === 'list' || target?.kind === 'table');
      if (deeper.length && target && !form && ![...book.records.values()].some((route) => route.segment === segment)) {
        const table = 'table' in target ? target.table : undefined;
        const home = table ? book.records.get(table) : undefined;
        throw new Refusal(
          `"${said}": ${outward(mount, `/${app}/${segment}`)} has no records under it` +
            (home
              ? `; a "${book.tables.get(home.table)?.name ?? home.table}" is addressed ${outward(mount, `/${app}/${home.segment}`)}/{id}.`
              : '.') +
            ' mistri check --routes lists every address.',
        );
      }
      return { path, name: slug(path.slice(app.length + 1)) };
    });
  }
  const shots: Shot[] = [{ path: `/${app}`, name: 'home' }];
  /* A tenant App's context offers its own realm's rooms: the other's are not there to shoot. */
  const elsewhere = (target: { kind: string; view?: string; page?: string }) => {
    if (!realm) return false;
    const said =
      target.view !== undefined
        ? (loaded.app.views[target.view] as { realm?: string } | undefined)?.realm
        : target.page !== undefined
          ? (loaded.pages.find((page) => page.id === target.page) as { realm?: string } | undefined)?.realm
          : undefined;
    return said !== undefined && said !== realm;
  };
  for (const [segment, target] of book.routes) {
    if (target.kind === 'table' || elsewhere(target)) continue; // a table no view declares, or the other realm's
    shots.push({
      path: `/${app}/${segment}`,
      name: slug(segment),
      ...('view' in target ? { view: target.view } : {}),
      ...('page' in target ? { page: target.page } : {}),
    });
  }
  for (const [table, route] of book.records) {
    if (route.parent || !book.defaultPage.has(table) || elsewhere(route.target)) continue;
    const key = await firstKey(table, route.column);
    if (key !== undefined)
      shots.push({
        path: `/${app}/${route.segment}/${encodeURIComponent(key)}`,
        name: slug(`${route.segment}-${key}`),
        page: book.defaultPage.get(table),
        table,
      });
  }
  return [...new Map(shots.map((shot) => [shot.path, shot])).values()];
}

/* A port the system says is free. Asked for, not `--port 0`: an App that signs
   people in needs its port before it listens, for its sign-in's own address. */
const freePort = () =>
  new Promise<number>((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => done(port));
    });
  });

/** The App served on a free port, its config directory a temporary one: never the reader's auth store or layouts. */
async function serve(args: string[], env: Record<string, string>): Promise<{ origin: string; child: ChildProcess }> {
  const child = spawn(process.execPath, [...selfInvocation(), ...args, '--port', String(await freePort()), '--host', '127.0.0.1'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  let said = '';
  const origin = await new Promise<string>((done, fail) => {
    const timer = setTimeout(() => fail(new Refusal('the App did not start within 90 seconds.')), 90_000);
    const hear = (chunk: Buffer) => {
      said += String(chunk);
      const port = /Listening on http:\/\/[^:\s]+:(\d+)/.exec(said)?.[1];
      if (port) {
        clearTimeout(timer);
        done(`http://127.0.0.1:${port}`);
      }
    };
    child.stdout!.on('data', hear);
    child.stderr!.on('data', hear);
    child.once('exit', (code) => {
      clearTimeout(timer);
      const why = said
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !/^mistri: (app ".*" from |\d+ connection)/.test(line))
        .slice(-4)
        .join(' ');
      fail(
        new Refusal(
          `the App's server stopped before it listened (exit ${code})${why ? `: ${why}` : ''}. mistri check --app says what is wrong with it.`,
        ),
      );
    });
  });
  child.stdout!.removeAllListeners('data');
  child.stderr!.removeAllListeners('data');
  child.stdout!.resume();
  child.stderr!.resume();
  return { origin, child };
}

/** Signed in as an account of `role`: the bootstrapped admin, one it makes with that role, or — `made` — one already made (shotTenant.ts). */
async function signIn(browser: Browser, origin: string, admin: { email: string; password: string }, role: string, made = false) {
  const context = await browser.newContext();
  const post = async (path: string, data: Record<string, string>) => {
    const answer = await context.request.post(`${origin}${path}`, { headers: { origin }, data });
    if (!answer.ok()) throw new Refusal(`signing in as "${role}" failed: ${path} answered ${answer.status()}.`);
  };
  await post('/api/auth/sign-in/email', admin);
  if (role !== 'admin' && !made) {
    const account = { email: `shot-${role}@example.invalid`, password: randomBytes(18).toString('base64url') };
    await post('/api/auth/admin/create-user', { ...account, name: `A ${role}`, role });
    await context.clearCookies();
    await post('/api/auth/sign-in/email', account);
  }
  const state = await context.storageState();
  await context.close();
  return state;
}

export type SessionState = Awaited<ReturnType<typeof signIn>>;

/** A window onto the App as a reader opens it: its size and scheme, motion reduced, the tour already taken, the look asked for, signed in. */
export async function shotContext(
  browser: Browser,
  origin: string,
  window: {
    viewport: { width: number; height: number };
    scale?: number;
    dark: boolean;
    look?: ShotLook;
    /** The scheme as the reader's own pick, kept where the page keeps it: a dark theme is dark until a reader says light. */
    pick?: 'light' | 'dark';
    session?: SessionState;
    touch?: boolean;
  },
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: window.viewport,
    /* A touch screen answers `(pointer: coarse)`, which is where the page gives its small controls a finger's hit area. */
    ...(window.touch ? { hasTouch: true } : {}),
    deviceScaleFactor: window.scale ?? 1,
    colorScheme: window.dark ? 'dark' : 'light',
    reducedMotion: 'reduce',
    storageState: {
      cookies: window.session?.cookies ?? [],
      origins: [
        {
          origin,
          localStorage: [
            { name: 'mistri.tour.v1', value: 'done' },
            ...(window.pick ? [{ name: 'mistri.theme', value: window.pick }] : []),
            ...lookStorage(window.look),
          ],
        },
      ],
    },
  });
  watchRequests(context);
  /* A reader who picks a look keeps the App's menu where it was; a look shot by name is the App wearing it, so its
     menu stands where the theme suggests, unless the App says where itself (placementIn). */
  const placement = window.look?.placement;
  if (placement) await context.addInitScript({ content: ASK_FOR_THE_APP });
  if (placement)
    await context.route(/\/api\/app(?:\?|$)/, async (route) => {
      const response = await route.fetch();
      const payload = (await response.json().catch(() => undefined)) as { app?: { ui?: { shell?: Record<string, unknown> } } } | undefined;
      if (!payload?.app?.ui) return route.fulfill({ response });
      payload.app.ui.shell = { ...payload.app.ui.shell, placement };
      return route.fulfill({ response, json: payload });
    });
  return context;
}

/**
 * The first page carries the App's answer in it (http/firstPaint.ts): a page whose App is rewritten on its way in
 * (a variant, a look's menu placement) drops that block, so it asks /api/app, which the route answers. As text: a
 * function would be compiled with the names tsx keeps (`__name`), which the page has not got.
 */
const ASK_FOR_THE_APP =
  "const remove = () => document.getElementById('mistri-first-paint')?.remove();" +
  'const observer = new MutationObserver(remove);' +
  'observer.observe(document, { childList: true, subtree: true });' +
  "document.addEventListener('DOMContentLoaded', () => (remove(), observer.disconnect()), { once: true });";

/** Opened at `path` as shot opens it: the server's pinned clock, the tenant chosen where one must be, settled. The answer's status. */
export async function openShot(page: Page, origin: string, path: string, choice?: string): Promise<number | undefined> {
  /* A clock the server was pinned to (MISTRI_CLOCK, http/clock.ts) is the page's too, so "in 3 days" in a
     docs picture says what the server meant, on any day it is taken. */
  const pinned = process.env.MISTRI_CLOCK ? new Date(process.env.MISTRI_CLOCK) : undefined;
  if (pinned && !Number.isNaN(pinned.getTime())) await page.clock.setFixedTime(pinned);
  const answer = await page.goto(`${origin}${path}`, { waitUntil: 'load', timeout: 60_000 });
  await quiet(page);
  /* A tenant App asks which context a tab opens in, as a person makes the
     choice — except where the reader's one membership is that tenant, which
     the page enters by itself (tenantBrowser.ts). */
  if (choice) {
    // By its place, not its name: an App that names its tenants ("Available dealers") says its own word.
    // By the id the choice sends: the button says the tenant's name. Enabled: a busy one is the page entering it.
    const offered = page.locator(`.tenant-chooser-list button[data-tenant="${choice.replace(/["\\]/g, '\\$&')}"]:enabled`);
    const entered = page.locator('.tenant-control-host');
    await offered.or(entered).first().waitFor({ timeout: 30_000 });
    if (await offered.isVisible()) await offered.click();
    await entered.waitFor({ timeout: 30_000 });
  }
  await settle(page);
  return answer?.status();
}

/** One capture, once the page has settled: requests done, fonts loaded, nothing busy, two shots alike. */
async function capture(
  browser: Browser,
  origin: string,
  shot: Shot,
  look: ShotLook | undefined,
  dark: boolean,
  size: keyof typeof SIZES,
  width: number | undefined,
  full: boolean,
  scale: number,
  file: string | undefined,
  session: SessionState | undefined,
  choice?: string,
  variant?: { theme: ThemeDefinition; region?: readonly string[] },
  reader?: { pick?: 'light' | 'dark'; steps?: readonly ShotStep[] },
): Promise<{ errors: string[]; text?: string; picture?: Buffer }> {
  const viewport = { width: width ?? SIZES[size].width, height: SIZES[size].height };
  let taken: Buffer | undefined;
  const context = await shotContext(browser, origin, { viewport, scale, dark, look, pick: reader?.pick, session });
  const errors: string[] = [];
  let text: string | undefined;
  try {
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(`page error: ${error.message.split('\n')[0]}`));
    if (variant) await wearVariant(page, variant.theme);
    const status = await openShot(page, origin, shot.path, choice);
    if (status !== undefined && status >= 400) errors.push(`the server answered ${status}`);
    if (reader?.steps?.length)
      await performSteps(page, reader.steps, shot.path, settle, (why) => {
        throw new Refusal(why);
      });
    const caught = await page.locator('[data-section-error]').count();
    if (caught) errors.push(`${caught} section${caught === 1 ? '' : 's'} could not be drawn`);
    /* --text: what the page says, instead of a picture of it. */
    if (!file) {
      text = sayPage(shot.path, await readPage(page), errors, status);
      return { errors, text };
    }
    if (full) await growToContent(page, viewport.width, viewport.height);
    let picture: Buffer | undefined;
    /* Two shots alike, of one document: a page that started a new one while it was taken is settled again and
       taken again. */
    for (let round = 0; round <= RELOADS && !picture; round++) {
      const watch = pageWatch(page);
      try {
        const clip = variant?.region ? await regionOf(page, variant.region) : undefined;
        let taken = await page.screenshot({ caret: 'hide', animations: 'disabled', fullPage: full, ...(clip ? { clip } : {}) });
        for (let tries = 0; tries < 6; tries++) {
          await page.waitForTimeout(250);
          const again = await page.screenshot({ caret: 'hide', animations: 'disabled', fullPage: full, ...(clip ? { clip } : {}) });
          if (again.equals(taken)) break;
          taken = again;
        }
        if (!watch.loaded()) picture = taken;
      } catch (error) {
        // A document torn down under the shot is a page that loaded again; anything else is the shot's own failure.
        if (!watch.loaded()) throw error;
      } finally {
        watch.stop();
      }
      if (!picture) await settle(page);
    }
    if (!picture) throw new Error(`${shot.path} kept loading itself again: it was not still long enough to take`);
    await writeFile(file, picture);
    taken = picture;
  } finally {
    await context.close();
  }
  return { errors, text, ...(taken ? { picture: taken } : {}) };
}

/**
 * Where each recipe part shows, for `--recipes`: the first of these drawn on the page is the picture, with a margin
 * round it, so a part's values are told apart in a row of thumbnails rather than lost in a whole window. A page that
 * draws none of them is shot whole. The selectors are the ones the part's own rules dress (themeFamilies.css and the
 * look sheets).
 */
export const RECIPE_REGIONS: Readonly<Record<RecipePart, readonly string[]>> = {
  nav: ['.sidebar', '.topbar .tn-links'],
  bar: ['.topbar'],
  tabs: ['.page-tabstrip', '.tabs'],
  windows: ['.dash-windows', '.activity-periods'],
  stat: ['.dash-strip'],
  section: ['.dash-body .page-section:not(.dash-strip)', '.page-section'],
  fields: ['.page-section:has(.page-field)', '.page-properties'],
  table: ['.table-wrap'],
  status: ['.table-wrap:has(.tone)', '.page-head:has(.tone)'],
  board: ['.board-list'],
  chart: ['.page-section:has(.chart-area)', '.page-section:has(.chart-grid)'],
  buttons: ['.page-head', '.applist-head'],
  links: ['.page-section:has(a.value-link)', '.table-wrap'],
  rules: ['.page-section'],
  avatar: ['.page-head:has(.page-record-avatar)', '.page-head'],
  workflow: ['.workflow-steps'],
  required: ['.form-field.is-required', '.form-field'],
  checkbox: ['.form-field-check-row', '.field-check'],
  formStep: ['.intake-head'],
  actionBar: ['.intake-actions', '.action-bar'],
  banner: ['.page-section.dash-banner', '.dashboard-note.is-banner'],
  steps: ['.dash-steps', ':has(> .dash-step)'],
  lanes: ['.board-list', '.dash-board', '.triage-board'],
  /* The header is the pane's top, from the trail to the facts or the tabs: the band runs edge to edge. */
  header: ['.content:has(.page-head.is-room, .applist-controls)', '.content'],
  'radius.pill': ['.table-wrap:has(.tone)', '.board-list', '.page-head:has(.tone)'],
  'radius.control': ['.page-head', '.applist-head'],
  'border.control': ['.insert-group-fields', ':has(> .insert-field)'],
  'type.title': ['.page-head', '.dash-head'],
  'type.section': ['.page-section:has(> .page-section-head)', '.page-section'],
  'type.label': ['.dash-strip', '.table-wrap'],
  'type.figure': ['.dash-strip'],
};

/** The window's part a region draws, with room round it; none drawn, the whole window. */
async function regionOf(page: Page, selectors: readonly string[]) {
  const box = await page.evaluate((list) => {
    for (const selector of list) {
      const found = [...globalThis.document.querySelectorAll(selector)].find((el) => el.checkVisibility());
      if (found) {
        const r = found.getBoundingClientRect();
        if (r.width > 4 && r.height > 4) return { x: r.left, y: r.top, width: r.width, height: r.height };
      }
    }
    return undefined;
  }, selectors);
  if (!box) return undefined;
  const size = page.viewportSize()!;
  const x = Math.max(0, Math.floor(box.x - 16)),
    y = Math.max(0, Math.floor(box.y - 16));
  return {
    x,
    y,
    width: Math.min(size.width - x, Math.ceil(box.width + 32)),
    height: Math.min(size.height - y, Math.ceil(box.height + 32), 640),
  };
}

/**
 * The App wears `theme` as its own, for one window: its payload names it, and the copy the first paint carries is
 * dropped so the page asks for the one answered here. Nothing is written to the App or the reader's choices.
 */
async function wearVariant(page: Page, theme: ThemeDefinition): Promise<void> {
  await page.addInitScript({ content: ASK_FOR_THE_APP });
  await page.route(/\/api\/app(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const payload = (await response.json().catch(() => undefined)) as { app?: { ui?: Record<string, unknown> } } | undefined;
    if (!payload?.app?.ui) return route.fulfill({ response });
    const ui = payload.app.ui;
    ui.customThemes = [...((ui.customThemes as ThemeDefinition[] | undefined) ?? []).filter((item) => item.id !== theme.id), theme];
    ui.theme = { preset: theme.id };
    return route.fulfill({ response, json: payload });
  });
}

/**
 * What `--recipes` shoots: every recipe part, and the shape values a theme says beside them that are drawn as a
 * choice among a few — a control's corner (square to round), a pill's (round, or the look's square-ish lengths) and a
 * control's edge.
 */
const SHAPE_VALUES = {
  'radius.control': ['0px', '4px', '8px', 'round'],
  'radius.pill': ['round', '4px', '0px'],
  'border.control': ['1px', '2px'],
  /* The type roles a theme most often changes, each in the values that draw it apart: a title's size, a section's
     and a label's capitals, a figure's face. */
  'type.title': ['22px', '26px', '28px', '30px'],
  'type.section': ['none', 'upper', 'small-caps'],
  'type.label': ['none', 'upper', 'small-caps'],
  'type.figure': ['ui', 'heading', 'mono'],
} as const;
type RecipePart = keyof ThemeRecipes | keyof typeof SHAPE_VALUES;
/** The role property each `type.<role>` part shoots. */
const TYPE_PROPERTY = { 'type.title': 'size', 'type.section': 'case', 'type.label': 'case', 'type.figure': 'face' } as const;
export const RECIPE_SHEET_PARTS: readonly RecipePart[] = [...RECIPE_PARTS, ...(Object.keys(SHAPE_VALUES) as (keyof typeof SHAPE_VALUES)[])];

/** The theme a part's value is shot in: the one asked for (or the App's), that part alone changed. */
export function recipeVariants(base: ThemeDefinition, part: RecipePart): Array<{ value: string; theme: ThemeDefinition }> {
  const preset = THEME_PRESETS.includes(base);
  const values: readonly string[] =
    part in SHAPE_VALUES ? SHAPE_VALUES[part as keyof typeof SHAPE_VALUES] : Object.keys(RECIPE_MENU[part as keyof ThemeRecipes]);
  return values.map((value) => {
    const theme: ThemeDefinition = {
      ...base,
      id: `${base.id}-${part.replace('.', '-')}-${value}`,
      label: `${base.label}, ${part} ${value}`,
      ...(preset ? { base: base.id as ThemeDefinition['base'] } : {}),
    };
    if (part === 'radius.control') {
      theme.radius = { ...base.radius, control: value === 'round' ? ROUND : value };
    } else if (part === 'radius.pill') {
      const { pill: _pill, ...radius } = base.radius ?? {};
      theme.radius = value === 'round' ? radius : { ...radius, pill: value };
    } else if (part === 'border.control') {
      theme.light = { ...base.light, rulesControl: value as '1px' | '2px' };
      theme.dark = { ...base.dark, rulesControl: value as '1px' | '2px' };
    } else if (part in TYPE_PROPERTY) {
      const role = part.slice('type.'.length) as 'title' | 'section' | 'label' | 'figure';
      const property = TYPE_PROPERTY[part as keyof typeof TYPE_PROPERTY];
      theme.type = { ...base.type, roles: { ...base.type?.roles, [role]: { ...base.type?.roles?.[role], [property]: value } } };
    } else theme.recipes = { ...base.recipes, [part]: value };
    return { value, theme };
  });
}

/**
 * Pictures in rows under their labels, drawn by the same Chromium and written as one PNG: `--recipes`' contact
 * sheet. Each thumbnail keeps its own width up to `widest`, so a narrow region is not blown up.
 */
async function contactSheet(
  browser: Browser,
  title: string,
  pictures: ReadonlyArray<{ label: string; png: Buffer }>,
  scale: number,
  file: string,
): Promise<void> {
  const escape = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const widest = Math.max(...pictures.map(({ png }) => pngSize(png).width / scale));
  // Two across when a thumbnail is most of a desk window, three when it is a panel's width, four when it is a strip.
  const across = widest > 700 ? 2 : widest > 360 ? 3 : 4;
  const context = await browser.newContext({ viewport: { width: 400, height: 300 }, deviceScaleFactor: scale });
  try {
    const page = await context.newPage();
    const figures = pictures
      .map(({ label, png }) => {
        const { width } = pngSize(png);
        return (
          `<figure><figcaption>${escape(label)}</figcaption>` +
          `<img style="width:${Math.min(Math.round(width / scale), 640)}px" src="data:image/png;base64,${png.toString('base64')}"></figure>`
        );
      })
      .join('');
    await page.setContent(
      `<!doctype html><style>body{margin:0;padding:16px;width:max-content;background:#6b6b6b;font:15px/1.2 system-ui,sans-serif;color:#fff}` +
        `h1{font-size:17px;margin:0 0 14px}main{display:grid;grid-template-columns:repeat(${Math.min(across, pictures.length)},auto);gap:16px;align-items:start}` +
        `figure{margin:0}figcaption{font-weight:600;padding:0 0 8px}img{display:block;height:auto}</style><h1>${escape(title)}</h1><main>${figures}</main>`,
    );
    await page.evaluate(() => Promise.all([...globalThis.document.images].map((image) => image.decode())));
    await writeFile(file, await page.screenshot({ fullPage: true }));
  } finally {
    await context.close();
  }
}

/** A PNG's size in pixels, from its header. */
const pngSize = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

/**
 * Under this share of a picture changed, two values of a part draw the page nearly alike. Measured on the CRM
 * fixture's sheets: values a reader tells apart at a glance (a status pill against a dot, mono capitals against
 * plain labels) change 0.4% or more of the region; a word's color alone changes 0.1%.
 */
const ALIKE = 0.0025;

/** Run in the page (gradeProbe's inPage, so tsx's `__name` is defined there): each pair's share of differing pixels. */
async function comparePixels({ sources, pairs }: { sources: string[]; pairs: Array<{ a: number; b: number }> }) {
  const read = async (source: string) => {
    const image = new globalThis.Image();
    image.src = source;
    await image.decode();
    const canvas = globalThis.document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const drawing = canvas.getContext('2d')!;
    drawing.drawImage(image, 0, 0);
    return drawing.getImageData(0, 0, canvas.width, canvas.height).data;
  };
  const pixels = await Promise.all(sources.map(read));
  return pairs.map(({ a, b }) => {
    const x = pixels[a]!,
      y = pixels[b]!;
    let differ = 0;
    for (let i = 0; i < x.length; i += 4)
      if (Math.abs(x[i]! - y[i]!) > 2 || Math.abs(x[i + 1]! - y[i + 1]!) > 2 || Math.abs(x[i + 2]! - y[i + 2]!) > 2) differ++;
    return differ / (x.length / 4);
  });
}

/**
 * For each pair of pictures the same size, the share of their pixels that differ (any channel by more than a
 * rounding step), measured in the browser that took them: how far apart two values of a part draw the page.
 */
export async function pictureDifferences(
  browser: Browser,
  pictures: ReadonlyArray<{ png: Buffer }>,
): Promise<Array<{ a: number; b: number; share: number }>> {
  const pairs: Array<{ a: number; b: number }> = [];
  for (let a = 0; a < pictures.length; a++)
    for (let b = a + 1; b < pictures.length; b++) {
      const x = pngSize(pictures[a]!.png),
        y = pngSize(pictures[b]!.png);
      if (x.width === y.width && x.height === y.height) pairs.push({ a, b });
    }
  if (!pairs.length) return [];
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const shares = (await page.evaluate(
      inPage(comparePixels, { sources: pictures.map(({ png }) => `data:image/png;base64,${png.toString('base64')}`), pairs }),
    )) as number[];
    return pairs.map((pair, index) => ({ ...pair, share: shares[index]! }));
  } finally {
    await context.close();
  }
}

const SITE_RECIPES = 'https://mistriwork.dev/docs/theme-recipes/';

/**
 * The note for each pair of a part's values that draw a page nearly alike, closest first: an author picking by the
 * picture could not tell them apart there.
 */
export function alikeNotes(
  part: string,
  path: string,
  values: readonly string[],
  differences: ReadonlyArray<{ a: number; b: number; share: number }>,
): string[] {
  /* A recipe's values are said in words (themeRecipeWords.ts): the page that lists them tells the pair apart where the picture cannot. */
  const words = part.startsWith('recipes.') ? `; ${SITE_RECIPES} says each in words` : '';
  /* No value changed a pixel: the page draws nothing of the part, which is one thing to say, not a note per pair. */
  if (differences.length && differences.every(({ share }) => share === 0))
    return [`note: no value of ${part} changes ${path}: nothing on it is drawn by that part. Name a route that shows one.`];
  return differences
    .filter(({ share }) => share < ALIKE)
    .sort((x, y) => x.share - y.share)
    .map(({ a, b, share }) =>
      share === 0
        ? `note: ${part} ${values[a]} and ${values[b]} draw ${path} the same: nothing on it shows them apart${words}.`
        : `note: ${part} ${values[a]} and ${values[b]} draw ${path} nearly alike: ${(share * 100).toFixed(share < 0.001 ? 2 : 1)}% of the picture differs${words}.`,
    );
}

/**
 * Two pictures of one page side by side, each under its label, drawn by the
 * same Chromium and written as one PNG: `--compare`'s answer to "what does my
 * theme change?", without an image library the package does not ship.
 */
async function sideBySide(
  browser: Browser,
  pictures: ReadonlyArray<{ label: string; png: Buffer }>,
  scale: number,
  file: string,
): Promise<void> {
  const escape = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const context = await browser.newContext({ viewport: { width: 400, height: 300 }, deviceScaleFactor: scale });
  try {
    const page = await context.newPage();
    const figures = pictures
      .map(({ label, png }) => {
        const { width } = pngSize(png);
        return (
          `<figure><figcaption>${escape(label)}</figcaption>` +
          `<img width="${Math.round(width / scale)}" src="data:image/png;base64,${png.toString('base64')}"></figure>`
        );
      })
      .join('');
    await page.setContent(
      '<!doctype html><style>body{margin:0;padding:12px;display:flex;gap:12px;align-items:flex-start;width:max-content;background:#6b6b6b}' +
        'figure{margin:0}figcaption{font:600 15px/1 system-ui,sans-serif;color:#fff;padding:0 0 8px}img{display:block}</style>' +
        figures,
    );
    await page.evaluate(() => Promise.all([...globalThis.document.images].map((image) => image.decode())));
    await writeFile(file, await page.screenshot({ fullPage: true }));
  } finally {
    await context.close();
  }
}

/**
 * The App is a fixed shell whose pane scrolls, so a full-page screenshot is
 * one window: the window is made as tall as the pane's content instead.
 * Grown once, a record page still ended where its main column did and cut
 * the aside: a taller window lays the page out again (the pane's chrome and a
 * list sized to the window grow with it), so it grows until nothing is left
 * below — in any scrolling box, the aside's own included — up to TALLEST.
 */
export async function growToContent(page: Page, width: number, height: number): Promise<number> {
  for (let round = 0; round < 4 && height < TALLEST; round++) {
    const below = await page.evaluate(() =>
      Math.max(
        0,
        ...[...globalThis.document.querySelectorAll('*')]
          .filter(
            (element) =>
              element.scrollHeight - element.clientHeight > 1 && /auto|scroll/.test(globalThis.getComputedStyle(element).overflowY),
          )
          .map((element) => element.scrollHeight - element.clientHeight),
      ),
    );
    if (below <= 1) break;
    height = Math.min(TALLEST, height + below);
    await page.setViewportSize({ width, height });
    await settle(page);
  }
  return height;
}

/** How long a page must stand still — no new document, no request — before it is taken as settled. */
const STEADY_MS = 500;

/* Network idle, less the page's streams (testing/settled.ts): the one wait an App's own browser tests are offered too. */
const quiet = (page: Page) => settled(page, { quietMs: STEADY_MS });
/** How many times a page may start again (a reload, a late fetch that redraws it) before it is taken as it stands. */
const RELOADS = 5;

/**
 * Wait for the page to settle: its document loaded, requests done, fonts in, nothing busy — and then still for a
 * moment: no new document started and no request made. A page that loads itself again after its first paint (a
 * dev server's reload when it finds a dependency, a sign-in that reloads) or redraws in place (an App asked for
 * again when its theme file is saved) was taken mid-reload, a blank or half-drawn window; each is waited for in turn.
 */
async function settle(page: Page): Promise<void> {
  const watch = pageWatch(page);
  try {
    for (let round = 0; round <= RELOADS; round++) {
      await page.waitForLoadState('load').catch(() => {});
      await quiet(page);
      /* These run in the page: its document, not a global of this process. */
      await page.evaluate(() => globalThis.document.fonts.ready.then(() => undefined)).catch(() => {});
      await page
        .waitForFunction(() => !globalThis.document.querySelector('[aria-busy="true"]'), undefined, { timeout: 5_000 })
        .catch(() => {});
      watch.reset();
      await page.waitForTimeout(STEADY_MS);
      if (!watch.loaded() && !watch.asked()) break;
    }
    // A page that focuses its first field would carry its ring into the picture.
    await page
      .evaluate(() => {
        const active = globalThis.document.activeElement as { blur?: () => void } | null;
        active?.blur?.();
      })
      .catch(() => {});
  } finally {
    watch.stop();
  }
}

/**
 * What the page started since `reset`: a new document of its own (a reload, a redirect, a link followed — not the
 * App's own address changes, which move no document) and any request at all.
 */
function pageWatch(page: Page): { loaded(): boolean; asked(): boolean; reset(): void; stop(): void } {
  let loaded = false,
    asked = false;
  const seen = (request: { isNavigationRequest(): boolean; frame(): unknown }) => {
    asked = true;
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) loaded = true;
  };
  page.on('request', seen);
  return {
    loaded: () => loaded,
    asked: () => asked,
    reset: () => {
      loaded = asked = false;
    },
    stop: () => {
      page.off('request', seen);
    },
  };
}

/** What `ShotRun.open` reads from a command line: the App, the routes, who signs in, the browser, and a start's flags. */
interface ShotRunOptions {
  app?: string;
  routes: string[];
  as?: string;
  tenant?: string;
  browser?: string;
  rest: string[];
  /** Without --as, sign in as the role that reads the most where the App signs in by email (grade): a signed-out
      run of such an App measures its sign-in card on every page. */
  widest?: boolean;
  /** Every role a person signs in as, each its own session, and signed out (grade --as all). */
  everyRole?: boolean;
}

/** The App served and Chromium open, signed in where asked: what each capture needs. */
interface OpenedShotRun {
  loaded: LoadedApp;
  schema: Awaited<ReturnType<typeof loadAppRuntimeResources>>['schema'];
  shots: Shot[];
  origin: string;
  browser: Browser;
  session?: SessionState;
  /** The tenant a page is entered in, where the account holds one. */
  choice?: string;
  /** The role signed in as, and whether the run chose it (`widest`) rather than --as. */
  as?: { role: string; chosen: boolean };
  /** With `everyRole`: signed out, then a session for each role a person signs in as. */
  sessions?: Array<{ role: string; session?: SessionState }>;
}

/**
 * The role a run signs in as when none is named: the one that reads the most resources (`read: true` is all of
 * them), the first declared on a tie — the role whose screens hold the most to measure. With no roles, the
 * bootstrapped administrator.
 */
export function widestRole(app: Pick<LoadedApp['app'], 'auth' | 'resources'>): string {
  const all = Object.keys(app.resources ?? {}).length;
  let best: { role: string; reads: number } | undefined;
  for (const [role, grant] of Object.entries(app.auth?.roles ?? {})) {
    if (grant.service === true) continue;
    const reads = grant.read === true ? all : Array.isArray(grant.read) ? grant.read.length : 0;
    if (!best || reads > best.reads) best = { role, reads };
  }
  return best?.role ?? 'admin';
}

/**
 * One run over an App's pages, set up and undone once: the App read as a start reads it, served on a free port
 * over a temporary config directory, Chromium launched and an account signed in where asked. shot photographs the
 * pages it opens; grade measures them.
 */
class ShotRun {
  child?: ChildProcess;
  browser?: Browser;
  member?: TenantShotAccount;
  readonly xdg = mkdtempSync(join(tmpdir(), 'tablewalk-shot-'));
  readonly registry = new Registry();
  private cleaning?: Promise<void>;
  constructor(private readonly warn: (line: string) => void) {}

  /** Everything the run started or wrote, undone once, whether it ends, fails or is interrupted. */
  cleanup(): Promise<void> {
    return (this.cleaning ??= (async () => {
      await this.browser?.close().catch(() => {});
      const child = this.child;
      if (child && child.exitCode === null) {
        const exited = new Promise((done) => child.once('exit', done));
        child.kill('SIGTERM');
        await Promise.race([exited, new Promise((done) => setTimeout(done, 5_000))]);
        if (child.exitCode === null) {
          child.kill('SIGKILL');
          /* A killed child is not a reaped one: the old code returned
             while the server was still dying, and a grade that exited 1
             left its server on its port until killed by hand. Wait for
             the exit (or a second grace period) before the run ends. */
          await Promise.race([exited, new Promise((done) => setTimeout(done, 5_000))]);
        }
      }
      const unreleased = await this.member?.release();
      if (unreleased) this.warn(`warning: ${unreleased}`);
      await this.registry.closeAll();
      rmSync(this.xdg, { recursive: true, force: true });
    })());
  }

  async open(options: ShotRunOptions): Promise<OpenedShotRun> {
    const warn = this.warn;
    const log = console.log;
    if (!options.app) throw new Refusal('--app <dir> names the App to shoot.');
    try {
      options.browser ??= process.env.CHROME || undefined;
      if (options.browser && !existsSync(options.browser))
        throw new Refusal(`${options.browser} (--browser, or CHROME) is not a file. Name a Chromium or Chrome executable.`);
      const opts = parseArgs(options.rest);
      if (opts.unknown) throw new Refusal(`unknown option "${opts.unknown}".`);
      const appDir = resolve(options.app);
      if (!(await stat(appDir).catch(() => undefined))?.isDirectory()) throw new Refusal(`${options.app} is not a directory.`);
      const found = await findChromium();
      if (!found) throw new Refusal(INSTALL_HINT);
      const { chromium } = found;

      // The App, read as a start reads it, for its routes and a first record of each page.
      console.log = () => {};
      const config = await readStartupConfig(opts, this.registry, CONFIG_SECTIONS);
      if (opts.target)
        this.registry.setActive(
          this.registry.add({ name: redact(opts.target), url: opts.target, schemas: opts.schemas, source: 'argument' }).id,
        );
      const env = config.appEnv[appDir];
      const loaded = await loadApp(appDir, {
        lock: 'report',
        ...(opts.appEntry !== undefined ? { entry: opts.appEntry } : {}),
        ...(env ? { env } : {}),
      }).catch((error) => {
        throw new Refusal(`the App did not load: ${(error as Error).message.split('\n')[0]} mistri check --app says more.`);
      });
      const bound = loaded.app.connection ?? (loaded.app.sources ? loaded.app.sources[homeSourceOf(loaded.app)!]?.connection : undefined);
      const connection = bound
        ? this.registry.list().find((c) => c.id === bound || c.name === bound)
        : this.registry.list().find((c) => c.id === this.registry.active);
      if (!connection)
        throw new Refusal(
          bound
            ? `the App names connection "${bound}", which is not configured.`
            : 'no database to serve the App over: a SQLite file, --db <url> or --config <file>.',
        );
      const { schema } = await loadAppRuntimeResources(this.registry, loaded.app, connection.id);
      const { adapter } = await this.registry.open(connection.id);
      console.log = log;
      const firstKey = async (tableId: string, column?: string) => {
        const table = schema.tables.find((candidate) => candidate.id === tableId);
        const key = column ?? table?.columns.find((candidate) => candidate.primaryKey)?.name;
        if (!table || !key || (table.columns.filter((candidate) => candidate.primaryKey).length > 1 && !column)) return undefined;
        /* A tenant's reader sees its own rows: its first record is the tenant's first. */
        const owner = this.member?.owner(tableId);
        const rows = await adapter
          .query({
            table: tableId,
            columns: [key],
            orderBy: [{ column: key, direction: 'asc' }],
            limit: 1,
            offset: 0,
            ...(owner ? { filter: { groups: [[{ column: owner, op: '=', value: this.member!.tenant! }]] } } : {}),
          })
          .catch(() => undefined);
        const value = rows?.rows[0]?.[key as never];
        return value === undefined || value === null ? undefined : String(value);
      };

      // Sign-in, where asked: always in the temporary store — a copy of the App's own, or a fresh one — never the original.
      const auth = loaded.app.auth;
      let admin: { email: string; password: string } | undefined;
      let account: { email: string; password: string } | undefined;
      if (options.tenant && !(options.as && isTenantApp(loaded.app))) {
        throw new Refusal(
          isTenantApp(loaded.app)
            ? '--tenant chooses the context of the account --as <role> signs in as.'
            : `--tenant: "${loaded.app.name}" is not a tenant App.`,
        );
      }
      if (options.everyRole) {
        if (isTenantApp(loaded.app))
          throw new Refusal("--as all: a tenant App's roles sign in to one tenant's context; name one, --as <role> --tenant <id>.");
        if (!auth) throw new Refusal(`--as all: "${loaded.app.name}" has no sign-in, so every page is already what a reader sees.`);
        if (!(auth.providers ?? ['email']).includes('email'))
          throw new Refusal('--as all signs in by email and password, which this App does not offer.');
        if (auth.store) throw new Refusal('--as all makes its accounts in a store of its own, and this App names its auth.store.');
        admin = { email: 'shot-admin@example.invalid', password: randomBytes(18).toString('base64url') };
      }
      const chosen =
        !options.everyRole &&
        !options.as &&
        options.widest === true &&
        auth !== undefined &&
        !isTenantApp(loaded.app) &&
        (auth.providers ?? ['email']).includes('email') &&
        !auth.store;
      if (chosen) options.as = widestRole(loaded.app);
      if (options.as && namesAccount(options.as) && isTenantApp(loaded.app))
        throw new Refusal(`--as ${options.as}: a tenant App's shot signs in as --as <role> --tenant <id>, an account it makes.`);
      if (options.as && isTenantApp(loaded.app)) {
        const stored = this.registry.configs().find((each) => each.id === connection.id)!;
        // Loaded only here: an ordinary App's shot has no business with the tenant stores.
        const { tenantShotAccount } = await import('./shotTenant.js');
        warn("note: shot writes a temporary membership to the App's tenant store and removes it after.");
        this.member = await tenantShotAccount({
          loaded,
          appDir,
          role: options.as,
          tenant: options.tenant,
          policy: opts.policy,
          connection: stored,
          xdg: this.xdg,
          refuse: (why) => {
            throw new Refusal(why);
          },
        });
      } else if (options.as && namesAccount(options.as)) {
        // An account that is there already, signed in over a snapshot of its store: never a write to the original.
        account = shotAccount(loaded, options.as, this.xdg, process.env, (why) => {
          throw new Refusal(why);
        });
      } else if (options.as && !options.everyRole) {
        if (!auth) throw new Refusal(`--as: "${loaded.app.name}" has no sign-in, so every page is already what a reader sees.`);
        if (!(auth.providers ?? ['email']).includes('email'))
          throw new Refusal('--as signs in by email and password, which this App does not offer.');
        if (auth.store) throw new Refusal('--as makes an account in a store of its own, and this App names its auth.store.');
        const roles = Object.keys(auth.roles ?? {});
        const refused = asRoleRefusal(loaded.app.name, auth.roles, options.as);
        if (refused) throw new Refusal(refused);
        /* An account of the role the App's own accounts hold (AG5), signed in over a copy of its store: its rows,
           its name. A fresh account owns nothing, so the pictures would show an empty person; that is the fallback. */
        account = await shotRoleAccount(loaded, options.as, this.xdg, process.env, await personEmails(loaded.app, adapter));
        if (account)
          warn(`note: signed in as ${account.email}, the earliest "${options.as}" account, in a copy of ${loaded.app.name}'s accounts.`);
        else {
          admin = { email: 'shot-admin@example.invalid', password: randomBytes(18).toString('base64url') };
          warn(`note: ${loaded.app.name}'s accounts hold no "${options.as}" account, so a fresh one signs in, and it owns no rows.`);
        }
        /* The picture would be the App with nothing in it, which reads as a fault in the shot unless it is said. */
        if (options.as === 'admin' && !roles.includes('admin'))
          warn(`note: "${loaded.app.name}" declares no admin role, so an administrator sees nothing in it (check: admin-grants-nothing).`);
      } else if (options.everyRole) {
        /* Every role is signed in below, once the server is up. */
      } else if (auth && isTenantApp(loaded.app)) {
        warn(
          `note: shot signed out. --as <role> --tenant <id> signs in to a tenant's context (${peopleRoles(auth.roles).join(', ')}); a platform role needs no --tenant.`,
        );
      } else if (auth) {
        warn(
          `note: shot signed out. --as <role> signs in (admin${peopleRoles(auth.roles)
            .filter((role) => role !== 'admin')
            .map((role) => `, ${role}`)
            .join('')}).`,
        );
      }

      /* Served as the server started below serves it: one App at the root,
         a tenant App's too, unless the flags say otherwise. */
      const mount = settingsMount([loaded.app.id], opts, config);
      const shots = (await addresses(options.routes, loaded, appRoutes(loaded, schema), firstKey, this.member?.realm, mount)).map(
        (shot) => ({
          ...shot,
          path: outward(mount, shot.path),
        }),
      );

      const started = await serve(
        [...options.rest, ...(config.configPath && !opts.config ? ['--config', config.configPath] : []), '--app', appDir],
        {
          XDG_CONFIG_HOME: this.xdg,
          ...(auth ? { BETTER_AUTH_SECRET: randomBytes(32).toString('base64url') } : {}),
          ...(admin ? { MISTRI_AUTH_ADMIN_EMAIL: admin.email, MISTRI_AUTH_ADMIN_PASSWORD: admin.password } : {}),
        },
      );
      this.child = started.child;
      const browser = (this.browser = await launch(chromium, options.browser).catch((error) => {
        if (error instanceof Refusal) throw error;
        const said = (error as Error).message.split('\n')[0];
        /* Playwright is there and its browser is not: the one line that installs it, not the package again. */
        throw new Refusal(
          /Executable doesn't exist/i.test(said)
            ? `Playwright's headless Chromium is not installed. Run: ${found.install}, or name a browser: --browser <path>`
            : `Chromium did not start (${said}). Run: ${found.install}, or name a browser: --browser <path>`,
        );
      }));
      /* Each role a person signs in as, by an account the bootstrapped administrator makes, and signed out first. */
      let sessions: OpenedShotRun['sessions'];
      if (options.everyRole) {
        sessions = [{ role: 'signed-out' }];
        // One at a time: each makes an account in the run's store.
        for (const role of peopleRoles(auth!.roles)) sessions.push({ role, session: await signIn(browser, started.origin, admin!, role) });
      }
      const session = options.everyRole
        ? undefined
        : admin
          ? await signIn(browser, started.origin, admin, options.as!)
          : account
            ? await signIn(browser, started.origin, account, options.as!, true)
            : this.member
              ? await signIn(browser, started.origin, this.member, options.as!, true)
              : undefined;
      return {
        loaded,
        schema,
        shots,
        origin: started.origin,
        browser,
        session,
        choice: this.member?.choice,
        ...(session && options.as ? { as: { role: options.as, chosen } } : {}),
        ...(sessions ? { sessions } : {}),
      };
    } finally {
      console.log = log;
    }
  }
}

/**
 * A run, undone once whatever happens: a signal waits for the undoing before the process exits, so a tenant
 * membership granted for the run is revoked on Ctrl-C too.
 */
export async function withShotRun<T>(warn: (line: string) => void, body: (run: ShotRun) => Promise<T>): Promise<T> {
  const run = new ShotRun(warn);
  const interrupted = (signal: NodeJS.Signals) => {
    void run.cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    return await body(run);
  } finally {
    await run.cleanup();
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
  }
}

/** `mistri shot …`, as the command line runs it. Returns the exit code. */
export async function runShot(
  argv: string[],
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  warn: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    write(
      `${SHOT_USAGE}\n\nServe the App on a free port with a temporary config directory, open each address in Chromium once it\n` +
        "has settled, and write a PNG of it; each file's path is printed. With no route, every view and page the App\n" +
        "declares (a page on its first record). --theme <id> shoots a built-in look or one of the App's own themes\n" +
        "instead of the theme it wears (all: every built-in look, then the App's); --palette <id> one of that theme's palettes;\n" +
        "--compare <look> shoots the App's theme (or --theme) beside that look and writes one picture of the two,\n" +
        '<page>-<light|dark>.png, the look on the left; --recipes <part> shoots one page (the home unless\n' +
        'named) once per value of that recipe part, the theme otherwise as it is, cropped to where the part shows, and writes\n' +
        'one contact sheet, <part>-<page>-<light|dark>.png;\n' +
        "--dark or --light the scheme as the reader's own pick; --click <name>, --type <field> <text>, --press <key> and\n" +
        '--wait-for <text> are performed in the order given, on every route, the page settled before and after each (css:<selector>\n' +
        "names an element by selector); --matrix shoots every built-in look and the App's own, light and dark, desk and phone, to\n" +
        '<page>-<look>-<light|dark>-<desk|phone>.png with an index.html;\n' +
        "--desk (1280 wide, the default), --phone (390) or --both; --width <px> the window's\n" +
        'width instead (320 to 2560, with --desk or --phone); --full the whole page, not\n' +
        'the window; --scale <1-3> device pixels per CSS pixel (default 1; 2 is sharp); --as <role> signs in as a fresh account with that role (admin: the bootstrapped one), on a tenant App\n' +
        'in the tenant --tenant <id> names (a temporary membership in its tenant store, journaled, revoked when the shot ends;\n' +
        'a platform role needs no --tenant); --text prints what each page shows (title, headings, table columns and row count,\n' +
        'actions, empty states, errors) as compact text instead of writing PNGs; --out the\n' +
        "directory every file goes in (default: mistri-shots/<app> in the system's temporary directory, where --compare,\n" +
        '--recipes and --matrix each write to a folder of their own: compare/, recipes/, matrix/); --browser <path> the Chromium or\n' +
        "Chrome to shoot with (default: CHROME, else Playwright's own, the machine's Chrome, then any installed Chromium).\n" +
        "Needs Playwright's Chromium. Exit codes: 1 could not shoot, 2 a page threw or a section could not be drawn.",
    );
    return SHOT_EXIT.shot;
  }
  return withShotRun(warn, async (run) => {
    try {
      const options = readFlags(argv);
      const { loaded, shots, origin, browser, session, choice } = await run.open(options);
      const out = resolve(options.out ?? join(tmpdir(), 'mistri-shots', loaded.app.id));
      /* `--out` is where the files go, whatever the mode: a matrix asked into ./shots wrote ./shots/matrix/ and its index
         there. Only the shared default keeps each mode's pictures in a folder of their own, beside the plain ones. */
      const modeFolder = (mode: 'compare' | 'recipes' | 'matrix') => (options.out ? out : join(out, mode));
      if (!options.text) mkdirSync(out, { recursive: true });
      let broken = 0;
      const chosen = shotLooks(loaded, options.looks, options.palette);
      const looks = chosen.length ? chosen : [undefined];
      for (const look of chosen) if (look.overridden) warn(`note: ${look.overridden}`);
      const mode = options.dark ? 'dark' : 'light';
      const reader = { pick: options.pick, steps: options.steps };
      if (options.matrix) {
        const folder = modeFolder('matrix');
        mkdirSync(folder, { recursive: true });
        /* The built-in looks, then the App's own (`defineTheme`): the look it ships is the one its readers see first. */
        const matrixLooks = [...THEME_PRESETS, ...(loaded.app.ui.customThemes ?? [])];
        for (const shot of shots)
          for (const preset of matrixLooks)
            for (const scheme of MATRIX_MODES)
              for (const size of MATRIX_SIZES) {
                const look = shotLooks(loaded, [preset.id])[0]!;
                const file = join(folder, matrixFile(shot.name, preset.id, scheme, size));
                const { errors } = await capture(
                  browser,
                  origin,
                  shot,
                  look,
                  scheme === 'dark',
                  size,
                  undefined,
                  options.full,
                  options.scale,
                  file,
                  session,
                  choice,
                  undefined,
                  { pick: scheme, steps: options.steps },
                );
                write(file);
                for (const error of errors) warn(`warning: ${shot.path} (${look.label}, ${scheme}) ${size}: ${error}`);
                if (errors.length) broken++;
              }
        const index = join(folder, 'index.html');
        await writeFile(
          index,
          matrixIndex(
            loaded.app.name,
            shots.map(({ name, path }) => ({ name, path })),
            matrixLooks,
          ),
        );
        write(index);
        return broken ? SHOT_EXIT.pageErrors : SHOT_EXIT.shot;
      }
      if (options.recipes) {
        const part = options.recipes;
        const id = looks[0]?.theme ?? worn(loaded);
        const base = [...THEME_PRESETS, ...(loaded.app.ui.customThemes ?? [])].find((theme) => theme.id === id)!;
        const folder = modeFolder('recipes');
        const parts = mkdtempSync(join(tmpdir(), 'tablewalk-recipes-'));
        mkdirSync(folder, { recursive: true });
        try {
          const [shot] = shots;
          for (const size of options.sizes) {
            const pictures: Array<{ label: string; png: Buffer }> = [];
            for (const [index, { value, theme }] of recipeVariants(base, part).entries()) {
              const taken = await capture(
                browser,
                origin,
                shot!,
                undefined,
                options.dark,
                size,
                options.width,
                options.full,
                options.scale,
                join(parts, `${index}.png`),
                session,
                choice,
                { theme, region: options.full ? undefined : RECIPE_REGIONS[part] },
                reader,
              );
              for (const error of taken.errors) warn(`warning: ${shot!.path} (${part} ${value}) ${size}: ${error}`);
              if (taken.errors.length) broken++;
              const worn = part in SHAPE_VALUES ? undefined : base.recipes?.[part as keyof ThemeRecipes];
              pictures.push({ label: `${value}${value === worn ? ` (${base.label})` : ''}`, png: taken.picture! });
            }
            const file = join(folder, `${part}-${shot!.name}-${mode}${options.sizes.length > 1 ? `-${size}` : ''}.png`);
            const said = part.includes('.') ? part : `recipes.${part}`;
            for (const note of alikeNotes(
              said,
              shot!.path,
              recipeVariants(base, part).map(({ value }) => value),
              await pictureDifferences(browser, pictures),
            ))
              warn(note);
            await contactSheet(
              browser,
              `${part === 'radius.pill' ? 'shape.radius.pill' : part.includes('.') ? part : `recipes.${part}`} on ${shot!.path}, ${base.label}, ${mode}`,
              pictures,
              options.scale,
              file,
            );
            write(`${file}  (${pictures.map((picture) => picture.label).join(' | ')})`);
          }
        } finally {
          rmSync(parts, { recursive: true, force: true });
        }
        return broken ? SHOT_EXIT.pageErrors : SHOT_EXIT.shot;
      }
      if (options.compare) {
        const [against] = shotLooks(loaded, [options.compare]);
        const ownTheme = (loaded.app.ui.customThemes ?? []).find((theme) => theme.id === worn(loaded));
        const label = looks[0]?.label ?? ownTheme?.label ?? THEME_PRESETS.find((theme) => theme.id === worn(loaded))?.label ?? worn(loaded);
        const folder = modeFolder('compare');
        const parts = mkdtempSync(join(tmpdir(), 'tablewalk-compare-'));
        mkdirSync(folder, { recursive: true });
        try {
          for (const shot of shots)
            for (const size of options.sizes) {
              const pictures: Array<{ label: string; png: Buffer }> = [];
              for (const [index, look] of [against, looks[0]].entries()) {
                const taken = await capture(
                  browser,
                  origin,
                  shot,
                  look,
                  options.dark,
                  size,
                  options.width,
                  options.full,
                  options.scale,
                  join(parts, `${index}.png`),
                  session,
                  choice,
                  undefined,
                  reader,
                );
                for (const error of taken.errors) warn(`warning: ${shot.path} (${index ? label : against!.label}) ${size}: ${error}`);
                if (taken.errors.length) broken++;
                pictures.push({ label: index ? label : against!.label, png: taken.picture! });
              }
              const file = join(folder, `${shot.name}-${mode}${options.sizes.length > 1 ? `-${size}` : ''}.png`);
              await sideBySide(browser, pictures, options.scale, file);
              write(`${file}  (${against!.label} | ${label})`);
            }
        } finally {
          rmSync(parts, { recursive: true, force: true });
        }
        return broken ? SHOT_EXIT.pageErrors : SHOT_EXIT.shot;
      }
      for (const shot of shots) {
        for (const look of looks) {
          for (const size of options.sizes) {
            const named = look ? `-${look.theme}${look.palette ? `-${look.palette}` : ''}` : '';
            const file = options.text ? undefined : join(out, `${shot.name}${named}${options.dark ? '-dark' : ''}-${size}.png`);
            const { errors, text } = await capture(
              browser,
              origin,
              shot,
              look,
              options.dark,
              size,
              options.width,
              options.full,
              options.scale,
              file,
              session,
              choice,
              undefined,
              reader,
            );
            write(text ?? file!);
            // --text already says each error under its page.
            if (!options.text) for (const error of errors) warn(`warning: ${shot.path}${look ? ` (${look.label})` : ''} ${size}: ${error}`);
            if (errors.length) broken++;
          }
        }
      }
      return broken ? SHOT_EXIT.pageErrors : SHOT_EXIT.shot;
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      warn(`mistri shot: ${error.message}`);
      if (/needs a value|names the App|unknown option|only once/.test(error.message)) warn(SHOT_USAGE);
      return SHOT_EXIT.couldNotShoot;
    }
  });
}
