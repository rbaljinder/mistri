/**
 * `mistri grade`: the visual and UX review an agent did by hand, run as a
 * command — the mechanical two thirds of the rubric.
 *
 * A field report built an App from the skill and then looked at every page at
 * a desk and on a phone for what the rubric asks: nothing scrolls sideways,
 * no figure is cut off, no two controls sit on each other, a thumb can hit
 * each one, words read against their ground, the page holds still once drawn,
 * nothing throws, an empty section says what belongs in it, one surface says
 * its figures one way, a chart's axis counts in round steps, a record's name
 * keeps to two lines on a phone. Each of those is a measurement, not a taste
 * call, so this serves the App the way `mistri shot` does (shot.ts), opens
 * every view and a record of each page at 1280, 390 and 320 in light and at
 * 390 in dark, measures each in the page (gradeProbe.ts) and judges the
 * measurements here, where they can be tested without a browser.
 *
 * It prints what `check --brief` prints: one line per finding with its fix,
 * at the file and line that declares the page where one can be found. The run
 * ends with a score; an error-level finding fails it. Screenshots are left
 * for questions of taste.
 */
import { resolveTheme } from '@mistriwork/engine/shared/themeResolve.js';
import { statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import type { LoadedApp } from '../app/apps.js';
import { placeOf, sourceLocator } from './checkProblems.js';
import {
  contractProbe,
  contrastReadings,
  focusStops,
  inPage,
  probePage,
  watchEvents,
  watchShifts,
  type ContrastReading,
  type Probe,
} from './gradeProbe.js';
import { matrixLines, matrixTable, type MatrixRow } from './gradeMatrix.js';
import { COLOR_PROMISES } from './themeContract.js';
import { shotsFor } from './shotRoles.js';
import { passingOnGround } from '../../shared/themeFix.js';
import {
  blameLayout,
  count,
  judge,
  LAYOUT_CODES,
  merge,
  MOTION,
  PHONE,
  scoreOf,
  sayFinding,
  TAP,
  foldedDisclosures,
  treeDifference,
  WINDOWS,
  type Events,
  type GradeFinding,
  type GradedTheme,
  type Judged,
  type Window,
} from './gradeJudge.js';
import { openShot, Refusal, shotContext, shotLooks, withShotRun, type SessionState, type Shot, type ShotLook } from './shot.js';
import { themePlace } from './themeSource.js';
import type { ThemeDefinition, ThemePalette } from '@mistriwork/engine/schema/theme.js';
import { effectiveThemeDefinition, effectiveThemePalette, THEME_PRESETS } from '@mistriwork/engine/shared/themePresets.js';
import { colorPath } from '../../shared/themeSpec.js';
import { componentInks } from '@mistriwork/engine/shared/theme.js';
import { authoredRoles } from '../../shared/themeCheck.js';

const GRADE_USAGE =
  'mistri grade [<app-dir>] [<db> | --db <target> | --config <path>] [--commands <file>] [--jobs <file>] [--policy <file>]\n' +
  '                [<route>…] [--as <role|email|all> [--tenant <id>]] [--theme <id|all> [--palette <id|all>]] [--json] [--browser <path>]';
const GRADE_EXIT = { clean: 0, couldNotGrade: 1, errors: 2 } as const;

/** The flags grade reads; the rest are a start's and go to the server, as shot's do. */
function readFlags(argv: string[]): {
  app?: string;
  routes: string[];
  as?: string;
  tenant?: string;
  browser?: string;
  theme?: string;
  palette?: string;
  json: boolean;
  rest: string[];
} {
  const options: ReturnType<typeof readFlags> = { routes: [], json: false, rest: [] };
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
  const value = (i: number, flag: string) => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('-')) throw new Refusal(`${flag} needs a value.`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') options.json = true;
    else if (arg === '--app' || arg === '--as' || arg === '--tenant' || arg === '--browser' || arg === '--theme' || arg === '--palette') {
      const key = arg.slice(2) as 'app' | 'as' | 'tenant' | 'browser' | 'theme' | 'palette';
      if (key === 'app' && options.app) throw new Refusal('the App may be named only once.');
      options[key] = value(i++, arg);
    } else if (takesValue.has(arg)) options.rest.push(arg, value(i++, arg));
    else if (arg.startsWith('-')) options.rest.push(arg);
    // The first bare word that is a directory is the App; a database file or URL is the start's; the rest are routes.
    else if (!options.app && !options.routes.length && isDirectory(arg)) options.app = arg;
    else if (/^(postgres|postgresql|sqlite):/i.test(arg) || /\.(db|db3|sqlite|sqlite3)$/i.test(arg)) options.rest.push(arg);
    else options.routes.push(arg);
  }
  options.app ??= '.';
  return options;
}

const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * What a theme's capture holds behind its folds: each collapsed disclosure opened, the page read with it open, and
 * closed again. C13 finds a control the theme folded away there, or does not excuse it (field report T5).
 */
async function foldsOpened(page: Page, tree: string): Promise<string[]> {
  const held: string[] = [];
  for (const { role, name } of foldedDisclosures(tree)) {
    try {
      await page
        .getByRole(role as Parameters<Page['getByRole']>[0], { name, exact: true })
        .first()
        .click({ timeout: 2_000 });
      await page.waitForTimeout(150);
      held.push(await page.locator('body').ariaSnapshot());
    } catch {
      /* A fold that does not open holds nothing a reader reaches. */
    }
    await page.keyboard.press('Escape').catch(() => undefined);
  }
  return held;
}

/** What one capture is asked to measure beyond the probe: the contract's promises a desk shows once per page. */
interface Asked {
  /** The desk window of a page: the Tab key's stops (C3), motion as set (C9), and a record printed (C12). */
  desk: boolean;
  /** The first capture of a row, a cold visit: the bytes of the theme's own files (C11). */
  cold: boolean;
  /** The accessibility tree, to hold against the App's own look's (C13), and in a theme's capture what its folds hold. */
  tree: boolean;
}

/** A probe that measured nothing: what a finding made outside one capture is judged on. */
const EMPTY_PROBE: Probe = { sideways: 0, clipped: [], overlaps: [], small: [], empty: [], figures: [], axes: [], shift: 0 };

/** One window of one page, drawn and measured. */
async function measure(
  browser: Browser,
  origin: string,
  shot: Shot,
  window: Window,
  session: SessionState | undefined,
  choice: string | undefined,
  look: ShotLook | undefined,
  theme?: GradedTheme,
  asked: Asked = { desk: false, cold: false, tree: false },
): Promise<{ found: Judged[]; tree?: string; revealed?: string[] }> {
  const context = await shotContext(browser, origin, {
    viewport: { width: window.width, height: window.height },
    dark: window.dark,
    session,
    ...(look ? { look } : {}),
    // A phone is held as one: a finger, so the page's coarse-pointer hit areas are the ones measured.
    touch: window.width <= PHONE,
  });
  const events: Events = { errors: [], failed: [] };
  try {
    await context.addInitScript(inPage(watchShifts, null));
    const page = await context.newPage();
    watchEvents(page, events);
    /* A theme's own files (its faces, its logo), by the bytes a cold visit fetches. */
    const own: Array<Promise<number>> = [];
    if (asked.cold)
      page.on('response', (response) => {
        if (/\/_(?:fonts|brand)\//.test(new URL(response.url()).pathname))
          own.push(
            response.body().then(
              (body) => body.length,
              () => 0,
            ),
          );
      });
    await openShot(page, origin, shot.path, choice);
    const broken = await page.locator('[data-section-error]').count();
    if (broken) events.errors.push(`${count(broken, 'section')} could not be drawn`);
    const probe = (await page.evaluate(inPage(probePage, { tap: window.width <= PHONE ? TAP : 0, record: Boolean(shot.table) }))) as Probe;
    const contrast = (await page.evaluate(inPage(contrastReadings, { states: [], text: true }))) as ContrastReading[];
    /* Every window is opened with motion reduced (shotContext): what moves there moves for a reader who asked it not to. */
    Object.assign(probe, (await page.evaluate(inPage(contractProbe, { reduced: true, ms: MOTION }))) as Partial<Probe>);
    const tree = asked.tree
      ? await page
          .locator('body')
          .ariaSnapshot()
          .catch(() => undefined)
      : undefined;
    /* Last, since opening a fold moves focus and the page: on screen, as a reader opens it. */
    const revealed = async () => {
      if (!look || !tree) return [];
      await page.emulateMedia({ media: 'screen' });
      return foldsOpened(page, tree);
    };
    if (asked.desk) {
      probe.focus = await focusStops(page);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      const set = (await page.evaluate(inPage(contractProbe, { reduced: false, ms: MOTION }))) as Partial<Probe>;
      probe.motion = [...(probe.motion ?? []), ...(set.motion ?? [])];
      if (shot.table && !window.dark) {
        /* Paper: what reads on screen and not printed; a reading already low on screen is said once, there. */
        const screen = new Set(contrast.filter((reading) => reading.ratio < reading.need).map((reading) => reading.what));
        await page.emulateMedia({ media: 'print' });
        const printed = (await page.evaluate(inPage(contrastReadings, { states: [], text: true }))) as ContrastReading[];
        probe.print = printed.filter((reading) => !screen.has(reading.what));
      }
      if (asked.cold) probe.themeBytes = (await Promise.all(own)).reduce((sum, n) => sum + n, 0);
      return { found: judge(probe, contrast, events, window, theme), ...(tree ? { tree, revealed: await revealed() } : {}) };
    }
    if (asked.cold) probe.themeBytes = (await Promise.all(own)).reduce((sum, n) => sum + n, 0);
    return { found: judge(probe, contrast, events, window, theme), ...(tree ? { tree, revealed: await revealed() } : {}) };
  } finally {
    await context.close();
  }
}

/**
 * The file and line that declare what an address draws: a view's key in the App's definition, a page's own module
 * (a `pages/` file) or its place in the definition, else the resource its records belong to.
 */
async function locator(loaded: LoadedApp, appDir: string): Promise<(shot: Shot) => Promise<{ file: string; line: number } | undefined>> {
  const { files } = await sourceLocator(appDir);
  const shown = (file: string) => relative(process.cwd(), file) || file;
  const found = new Map<string, { file: string; line: number } | undefined>();
  const at = async (path: string) => {
    if (!found.has(path)) {
      const place = await placeOf(files, path, '', appDir).catch(() => undefined);
      found.set(path, place ? { file: shown(resolve(appDir, place.file)), line: place.line } : undefined);
    }
    return found.get(path);
  };
  return async (shot) => {
    if (shot.view) return at(`views.${shot.view}`);
    if (shot.page) {
      const own = loaded.sources[shot.page];
      if (own && own !== loaded.path) {
        const lines = (await readFile(own, 'utf8')).split('\n');
        const index = lines.findIndex((text) => /\b(page|definePage)\s*\(|^export default\b/.test(text));
        return { file: shown(own), line: index + 1 || 1 };
      }
      const page = await at(`pages.${shot.page}`);
      if (page) return page;
    }
    const resource = Object.entries(loaded.app.resources ?? {}).find(([name, def]) => (def.physical ?? name) === shot.table)?.[0];
    return resource ? at(`resources.${resource}`) : undefined;
  };
}

/**
 * The theme graded by name, as its findings say it: each colour it draws with in each mode, by hex, to the path it is
 * written at — the palette's own where the palette says it, else the theme's (`cadence.colors.light.lineControl`).
 */
function gradedTheme(theme: ThemeDefinition, label: string, paletteId: string | undefined, own: boolean): GradedTheme {
  /* An App's theme answers for the colours it says, not for those it keeps from the look it extends: those the App's
     own look draws the same. A built-in look graded by name answers for all of its own. */
  const authored = own
    ? authoredRoles(
        theme,
        THEME_PRESETS.find((preset) => preset.id === theme.base),
      )
    : () => true;
  const variant = paletteId && paletteId !== 'default' ? theme.palettes?.findIndex((item) => item.id === paletteId) : -1;
  const tokens = (mode: 'light' | 'dark') => {
    const palette = effectiveThemePalette(effectiveThemeDefinition(theme, paletteId ?? 'default')[mode], mode === 'dark') as ThemePalette;
    const own = variant !== undefined && variant >= 0 ? theme.palettes![variant]![mode] : undefined;
    const map = new Map<string, string[]>();
    for (const [role, value] of Object.entries(palette)) {
      if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value) || role.startsWith('chart') || role.startsWith('rules')) continue;
      if (!authored(paletteId ?? 'default', mode, role as keyof ThemePalette)) continue;
      const where = own && own[role as keyof ThemePalette] !== undefined ? `palettes[${variant}]` : 'colors';
      const hex = value.toLowerCase();
      map.set(hex, [...(map.get(hex) ?? []), `${theme.id}.${where}.${mode}.${colorPath(role)}`]);
    }
    return map;
  };
  /* What a part mixes from a token — a category chip's ink from its series — by the hex the page paints. */
  const components = (mode: 'light' | 'dark') => {
    const definition = effectiveThemeDefinition(theme, paletteId ?? 'default');
    const palette = effectiveThemePalette(definition[mode], mode === 'dark') as ThemePalette;
    const own = variant !== undefined && variant >= 0 ? theme.palettes![variant]![mode] : undefined;
    const map = new Map<string, string[]>();
    for (const item of componentInks(palette, definition.recipes)) {
      if (!authored(paletteId ?? 'default', mode, item.role)) continue;
      const where = own && own[item.role] !== undefined ? `palettes[${variant}]` : 'colors';
      const key = `${item.fg} ${item.bg}`;
      map.set(key, [...(map.get(key) ?? []), `${theme.id}.${where}.${mode}.${colorPath(item.role)} as ${item.what}`]);
    }
    return map;
  };
  return {
    label,
    tokens: { light: tokens('light'), dark: tokens('dark') },
    components: { light: components('light'), dark: components('dark') },
  };
}

/** `mistri grade …`, as the command line runs it. Returns the exit code. */
export async function runGrade(
  argv: string[],
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  warn: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    write(
      `${GRADE_USAGE}\n\nServe the App as mistri shot does and open every view and a record of each page at 1280, 390 and 320 wide,\n` +
        'and at 390 in the dark scheme. Each is measured, not looked at: sideways scroll, figures and words cut off, controls\n' +
        `drawn over each other, targets under ${TAP}px on a phone, text and field edges below the contrast rule, layout shift after\n` +
        'the first paint, page errors and failed requests, empty sections, two number formats in one surface, chart axes in\n' +
        "steps that are not round, and a record's name past two lines on a phone. One line per finding,\n" +
        '`code file:line page@windows message — fix: …`, then a score. --json prints one JSON document instead.\n' +
        "--theme <id> grades in a built-in look or one of the App's own themes instead of the one it wears; --palette <id> in one of its palettes.\n" +
        '--theme all grades every look the App can wear as one table, a row each, a column each window; --palette all adds each\n' +
        'palette at 390 in light and dark (color promises only); --as all a row for signed out and each role a person signs in as.\n' +
        'Every finding of a theme contract code says its promise, C1 to C13 (mistri explain C2, mistri docs theme-contract).\n' +
        "A finding the theme causes is the theme's, placed at the theme: a color that is one of its tokens, named by its path\n" +
        "(cadence.colors.light.lineControl), and a layout finding the App's own look does not have on the same page and window\n" +
        '(its type scale or density). Any error fails the theme, whatever the score.\n' +
        'An App with sign-in is graded as the role that reads the most, unless --as names one.\n' +
        'Exit codes: 1 could not grade, 2 an error-level finding.',
    );
    return GRADE_EXIT.clean;
  }
  return withShotRun(warn, async (run) => {
    try {
      const options = readFlags(argv);
      const appDir = resolve(options.app!);
      if (!(await stat(appDir).catch(() => undefined))?.isDirectory()) throw new Refusal(`${options.app} is not a directory.`);
      if (options.theme?.includes(',')) throw new Refusal('--theme grades in one theme, or every one: --theme all.');
      const everyTheme = options.theme === 'all',
        everyPalette = options.palette === 'all',
        everyRole = options.as === 'all';
      const matrix = everyTheme || everyPalette || everyRole;
      const opened = await run.open({
        ...options,
        ...(everyRole ? { as: undefined, everyRole: true } : {}),
        app: appDir,
        widest: !everyRole,
      });
      const { loaded, origin, browser, session, choice } = opened;
      if (opened.as?.chosen)
        warn(`note: grade signed in as "${opened.as.role}", the role that reads the most. --as <role> grades another.`);
      /* The App's home draws the view its first rule for everyone names: measured once, under that view's own address. */
      const home = loaded.app.home.find((rule) => !rule.roles?.length && !rule.signedOut)?.view;
      const shots = options.routes.length
        ? opened.shots
        : opened.shots.flatMap((shot, i) =>
            i > 0 || !home ? [shot] : opened.shots.some((other) => other.view === home) ? [] : [{ ...shot, view: home }],
          );
      const place = await locator(loaded, appDir);
      /* A theme graded by name answers for what it causes: a colour that is one of its tokens, and a layout finding the
         App's own look does not have on the same page and window (its type and density). The rest is the App's. */
      const own = loaded.app.ui.customThemes ?? [];
      const wornId = loaded.app.ui.theme?.preset ?? 'workshop';
      const wornLabel = [...own, ...THEME_PRESETS].find((theme) => theme.id === wornId)?.label ?? wornId;

      /* A whole-App grade over every look is thousands of captures and ran 25 minutes in silence: each capture says where it
         is on stderr, whatever the output mode, so stdout and --json stay what a script reads. `total` is set before the
         first capture, from the same rows the run will take. */
      const progress = { done: 0, total: 0 };
      const say = (look: ShotLook | undefined, page: string, window: Window) =>
        warn(`grade: ${look?.label ?? wornLabel} · ${page} · ${window.label} (${++progress.done}/${progress.total})`);

      /** One look, as one session, over its pages and windows: its findings merged and placed. */
      const gradeRow = async (
        look: ShotLook | undefined,
        signed: SessionState | undefined,
        rowShots: readonly Shot[],
        windows: readonly Window[],
        colorOnly: boolean,
      ): Promise<GradeFinding[]> => {
        const definition = look ? [...own, ...THEME_PRESETS].find((theme) => theme.id === look.theme) : undefined;
        /* Graded as worn, an App's own theme still answers for its colours: a reading in one is named by its token. */
        const worn = look ? undefined : own.find((theme) => theme.id === wornId);
        const graded =
          definition && look
            ? gradedTheme(definition, look.label, look.palette, look.own)
            : worn
              ? gradedTheme(worn, wornLabel, undefined, true)
              : undefined;
        const blamed = look?.own ? look.theme : worn?.id;
        const another = look && (look.theme !== wornId || (look.palette ?? 'default') !== 'default');
        /* The menu moved by the theme graded (its shell.placement, where the App says none): it is the theme's too. */
        const moved = look?.placement;
        const seen: Array<{ page: string; window: string; found: Judged[] }> = [];
        for (const [s, shot] of rowShots.entries()) {
          for (const [w, window] of windows.entries()) {
            say(look, shot.path, window);
            const desk = window.label === '1280' && !colorOnly;
            /* The tree is held against the App's own look's, except where the theme moves the menu, which is a menu's tree. */
            const tree = Boolean(desk && another && !moved);
            const measured = await measure(browser, origin, shot, window, signed, choice, look, graded, {
              desk,
              cold: s === 0 && w === 0,
              tree,
            });
            let found = measured.found;
            if (another && !colorOnly && (tree || found.some((finding) => LAYOUT_CODES.has(finding.code)))) {
              const plain = await measure(browser, origin, shot, window, signed, choice, undefined, undefined, {
                desk: false,
                cold: false,
                tree,
              });
              const codes = new Set(plain.found.map((finding) => finding.code));
              found = found.map((finding) =>
                LAYOUT_CODES.has(finding.code) && !codes.has(finding.code)
                  ? blameLayout(finding, { label: look!.label, worn: wornLabel, ...(moved ? { placement: moved } : {}) })
                  : finding,
              );
              const differs =
                tree && plain.tree && measured.tree ? treeDifference(plain.tree, measured.tree, measured.revealed) : undefined;
              if (differs) found.push(...judge({ ...EMPTY_PROBE, changed: differs }, [], { errors: [], failed: [] }, window));
            }
            /* A palette changes colors and moves nothing: only the promises a color keeps are read in it. */
            if (colorOnly) found = found.filter((finding) => finding.promise && COLOR_PROMISES.has(finding.promise));
            seen.push({ page: shot.path, window: window.label, found });
          }
        }
        const findings = merge(seen);
        for (const finding of findings) {
          /* The theme's finding is placed at the theme: the token it names, or its type. */
          if (finding.cause === 'theme' && blamed) {
            const token = new RegExp(`\\b${blamed}\\.((?:colors|palettes\\[\\d+\\])\\.(?:light|dark)\\.[\\w.]+)`).exec(
              finding.message,
            )?.[1];
            const at = themePlace(appDir, blamed, token ?? 'type');
            if (at) {
              Object.assign(finding, { file: relative(process.cwd(), at.file) || at.file, line: at.line });
              continue;
            }
          }
          const shot = rowShots.find((candidate) => candidate.path === finding.page);
          const at = shot ? await place(shot) : undefined;
          if (at) Object.assign(finding, at);
        }
        return findings;
      };

      if (matrix) {
        /* Every look the App can wear, each palette of it at a phone in light and dark, each role: one table. */
        const looks = everyTheme
          ? shotLooks(loaded, ['all'])
          : shotLooks(loaded, [options.theme ?? wornId], everyPalette ? undefined : options.palette);
        const roles: Array<{ role: string; session?: SessionState }> = opened.sessions ?? [
          { role: opened.as?.role ?? (loaded.app.auth ? 'signed-out' : 'everyone'), ...(session ? { session } : {}) },
        ];
        const phone = WINDOWS.filter((window) => window.label === '390' || window.label === '390-dark');
        const rows: MatrixRow[] = [];
        for (const look of looks)
          for (const { role } of roles) {
            const taken = everyRole ? shotsFor(loaded.app, role, shots).length : shots.length;
            progress.total +=
              taken * WINDOWS.length +
              (everyPalette
                ? (own.concat(THEME_PRESETS).find((t) => t.id === look.theme)?.palettes ?? []).length * taken * phone.length
                : 0);
          }
        for (const look of looks) {
          if (look.overridden) warn(`note: ${look.overridden}`);
          const definition = [...own, ...THEME_PRESETS].find((theme) => theme.id === look.theme)!;
          const palettes = everyPalette ? (definition.palettes ?? []).map((item) => item.id) : [];
          for (const { role, session: signed } of roles) {
            const rowShots = everyRole ? shotsFor(loaded.app, role, shots) : shots;
            if (!rowShots.length) continue;
            /* Graded as worn: a role the App dresses in a theme of its own (ui.theme.for) wears that one, and a visitor the
               public's, unless a theme is asked for by name (themeResolve.ts). */
            const audience =
              options.theme || everyTheme || !loaded.app.ui.theme?.for
                ? undefined
                : resolveTheme({
                    public: role === 'signed-out',
                    roles: [role],
                    for: loaded.app.ui.theme.for,
                    preset: wornId,
                    offered: (id) => [...own, ...THEME_PRESETS].some((theme) => theme.id === id),
                  });
            const rowLook = audience && audience.id !== look.theme ? (shotLooks(loaded, [audience.id])[0] ?? look) : look;
            rows.push({
              theme: rowLook.theme,
              palette: rowLook.palette ?? 'default',
              role,
              windows: WINDOWS.map((window) => window.label),
              findings: await gradeRow(rowLook, signed, rowShots, WINDOWS, false),
            });
            for (const palette of palettes) {
              const [variant] = shotLooks(loaded, [look.theme], palette);
              rows.push({
                theme: look.theme,
                palette,
                role,
                windows: phone.map((window) => window.label),
                findings: await gradeRow(variant, signed, rowShots, phone, true),
              });
            }
          }
        }
        const all = rows.flatMap((row) => row.findings);
        const errors = all.filter((finding) => finding.severity === 'error').length;
        const failing = rows.filter((row) => row.findings.some((finding) => finding.severity === 'error')).length;
        if (options.json)
          write(
            JSON.stringify(
              {
                app: loaded.app.id,
                ok: errors === 0,
                errors,
                warnings: all.length - errors,
                matrix: {
                  windows: WINDOWS.map((window) => window.label),
                  rows: rows.map((row) => ({
                    ...row,
                    ok: !row.findings.some((finding) => finding.severity === 'error'),
                  })),
                },
              },
              null,
              2,
            ),
          );
        else {
          for (const line of matrixTable(rows)) write(line);
          const lines = matrixLines(rows, (token) => passingOnGround(token.value, token.ground, token.need));
          if (lines.length) write('');
          for (const line of lines) write(line);
          write(
            `grade: ${count(rows.length, 'row')} over ${count(shots.length, 'page')}${failing ? `, ${failing} with an error` : ', no errors'}${all.length - errors ? `, ${count(all.length - errors, 'warning')}` : ''}. mistri grade --theme <id> --json says every finding of one.`,
          );
        }
        return errors ? GRADE_EXIT.errors : GRADE_EXIT.clean;
      }

      /* A theme in draft is graded as worn: the App's own, a built-in look, or one of its palettes. */
      const [look] = shotLooks(loaded, options.theme ? [options.theme] : [], options.palette);
      if (look?.overridden) warn(`note: ${look.overridden}`);
      progress.total = shots.length * WINDOWS.length;
      const findings = await gradeRow(look, session, shots, WINDOWS, false);
      const captures = shots.length * WINDOWS.length;
      const score = scoreOf(findings, captures);
      const errors = findings.filter((finding) => finding.severity === 'error').length;
      const warnings = findings.length - errors;
      const caused = findings.filter((finding) => finding.cause === 'theme').length;
      if (options.json) {
        write(
          JSON.stringify(
            {
              app: loaded.app.id,
              ok: errors === 0,
              score,
              as: opened.as?.role ?? null,
              pages: shots.length,
              captures,
              errors,
              warnings,
              /* A theme graded by name gates on any error, whatever the score; `caused` counts the findings that are its own. */
              ...(look ? { theme: { id: look.theme, label: look.label, ok: errors === 0, caused } } : {}),
              findings,
            },
            null,
            2,
          ),
        );
      } else {
        for (const finding of findings) write(sayFinding(finding));
        write(
          `grade: ${score}/100 — ${findings.length ? `${count(errors, 'error')}, ${count(warnings, 'warning')}` : 'nothing to fix'} over ${count(shots.length, 'page')} at ${WINDOWS.map((window) => window.label).join(', ')}${opened.as ? `, signed in as ${opened.as.role}` : session ? ', signed in' : ''}`,
        );
        /* The score is a share of checks passed; an error is a gate. With --theme, say which way the theme went. */
        if (look)
          write(
            errors
              ? `${look.label} fails: ${count(errors, 'error')} gate it whatever the score${caused ? `, ${caused} of the findings its own` : ''}.`
              : `${look.label} passes${caused ? `, though ${count(caused, 'warning')} ${caused === 1 ? 'is' : 'are'} its own` : ''}.`,
          );
      }
      return errors ? GRADE_EXIT.errors : GRADE_EXIT.clean;
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      warn(`mistri grade: ${error.message}`);
      if (/needs a value|unknown option|only once/.test(error.message)) warn(GRADE_USAGE);
      return GRADE_EXIT.couldNotGrade;
    }
  });
}
