/**
 * `mistri check`: the one command of the authoring loop.
 *
 * Authoring an App used to be two commands with different flags — `tsc` with
 * a line of options, then the server's `mistri check` — and a third, easily
 * forgotten, to regenerate the schema types after a migration. This runs the
 * three in the order they depend on each other, against the App's database,
 * and says each one's verdict on its own line:
 *
 *   1. schema types — `mistri-schema.d.ts` regenerated from the database,
 *      so the typecheck judges the App against the schema as it is now;
 *   2. typecheck    — the App's tsconfig.json, or the explicit flags the agent
 *      guide documents, with tsc's structural dumps cut down to where, what,
 *      and for the common DSL mistakes a hint;
 *   3. validation   — the real `mistri check`, run as a child exactly as CI
 *      runs it, its problems and its warnings shown;
 *   4. components   — an App's custom components, compiled by the load above
 *      and read for what may never ship (markup from text, code from text,
 *      the server's environment: fails) and what a look cannot dress
 *      (literal colors and radii, long or unguarded motion: warns).
 *
 * Every step runs even after one fails — an agent fixing an App wants every
 * finding from one pass — and the exit code names the first step that
 * failed, so CI can still say which. Warnings never fail it. It writes one
 * file, and only the generated one: `mistri build` without the bundle.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Registry, redact } from '@mistriwork/engine/server/connections.js';
import { appRoutes, appThemeProblems, loadApp, saidByMessage, type LoadedApp } from '../app/apps.js';
import { placementIn } from '../../shared/appUi.js';
import { fontBudgetProblem, fontSummary } from '../app/appFonts.js';
import { writtenAt, type FixedThemeProblem } from '../../shared/themeFix.js';
import { themePlace, themeSummary, writeThemeFix } from './themeSource.js';
import { appForRoles, pagesForRoles } from '../../shared/appViewRoles.js';
import { loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import { mountClashes, routeTable } from '../../shared/appAddress.js';
import { appHome, segmentsTakenFrom, settingsMount, type AddressMount } from '@mistriwork/engine/shared/mount.js';
import { isTenantApp } from '../../shared/appModel.js';
import { appRealms } from '../../shared/appTenancy.js';
import { tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import {
  AppProblems,
  appCommandGrants,
  homeSourceOf,
  logicalResource,
  resolveAppAccess,
  withRollups,
  type AppDef,
} from '../../shared/app.js';
import { parseArgs, postgresPoolFlags, type Options } from '@mistriwork/engine/server/cli/args.js';
import { sayBudget } from '@mistriwork/engine/adapters/connectionBudget.js';
import { readStartupConfig } from '@mistriwork/engine/server/cli/config.js';
import { moduleTypeProblem } from '../cli/projectSetup.js';
import { appTypes } from '../cli/oneShot.js';
import { commandTypes, sameTypes, typesFileText, typesForSchema } from '../typegen.js';
import { componentTypes } from '../typegenComponents.js';
import { checkApp } from './build.js';
import { documentedFix } from './checkCodes.js';
import { connectionBudgets, deployFindings } from './checkDeploy.js';
import type { ServedFacts } from './servedHosts.js';
import { lintComponents, pageManifestsOf } from '../app/componentLint.js';
import { designLint, sayDesignFinding } from '../app/designLint.js';
import { segmentCost } from '../../shared/appSegments.js';
import { inferredReport } from '@mistriwork/engine/shared/displayDefaults.js';
import { chooseLayout } from '@mistriwork/engine/shared/pageLayouts.js';
import { inferredFormDefaults } from '../../shared/formRules.js';
import { fixRepeatedQueries, fixRestated } from './checkFix.js';
import { promiseOf } from './themeContract.js';
import { previewKeysUsed } from '../../shared/preview.js';
import { hint, parseTsc, readableTypeErrors, shorten, typecheckApp } from './typecheck.js';
import {
  componentCode,
  docsFor,
  near,
  pathAt,
  pathOfMessage,
  placeOf,
  sourceLocator,
  validationCode,
  type CheckProblem,
  type CheckSeverity,
  type CheckStep,
} from './checkProblems.js';
import { CONFIG_SECTIONS } from '../serviceConnections.js';
import { APP_ICONS } from '@mistriwork/engine/shared/appIcons.js';

/** What an unknown-icon refusal ends with: the whole list, which a run says once rather than after each of them. */
const ICON_LIST_TAIL = / The icons: [a-z0-9, -]+\.$/;
const iconListLine = () => `The icons: ${APP_ICONS.join(', ')}. (mistri docs icons lists them too.)`;

/** A line a step said that is advice, not an error: `warning: …`, or the same placed (`file:line  warning: …`). */
const WARNING_LINE = /^(?:\S+ {2})?warning: /;

/** A step's lines, the errors and the warnings, each in the order it was said. */
export function splitWarnings(lines: readonly string[]): { errors: string[]; warnings: string[] } {
  return { errors: lines.filter((line) => !WARNING_LINE.test(line)), warnings: lines.filter((line) => WARNING_LINE.test(line)) };
}

/** What kind of warning a line is: the code it carries (`[restated]`), else the one its words name. */
export function warningKind(line: string): string {
  return validationCode(line.replace(WARNING_LINE, ''));
}

/** The warnings of a run, one line: `45 warnings (restated 40, index-missing 5); --warnings lists them`. */
export function warningSummary(kinds: ReadonlyMap<string, number>): string {
  const total = [...kinds.values()].reduce((sum, n) => sum + n, 0);
  const by = [...kinds].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([kind, n]) => `${kind} ${n}`);
  return `${total} warning${total === 1 ? '' : 's'} (${by.join(', ')}); --warnings lists them.`;
}

/** The exit codes: the first step that failed says which. */
const CHECK_EXIT = { passed: 0, couldNotCheck: 1, types: 2, typecheck: 3, validation: 4, components: 5, pending: 6, deploy: 7 } as const;

const CHECK_USAGE =
  'mistri check --app <dir> [--app-entry <file>] [<db> | --db <target> | --config <path>] [--commands <file>] [--jobs <file>] [--policy <file>] [--bump <command>] [--routes [--mount <app>=<path>] [--base-path <path>]] [--design] [--fix] [--fail-on-design-warning] [--defaults] [--warnings] [--pending [--pending-on <url>] [--migrations <dir>] [--history-table <name>]] [--deploy [--replicas <n>] [--connection-limit <n>] [--cpus <n>]] [--json | --brief]';

type Status = 'passed' | 'failed' | 'skipped';
/** A step's verdict, its lines as the text output says them, and its findings as `--json` gives them (checkProblems.ts). */
interface Step {
  name: CheckStep;
  status: Status;
  detail: string;
  lines: string[];
  problems?: CheckProblem[];
}
const problem = (
  step: CheckStep,
  code: string,
  message: string,
  more: Partial<CheckProblem> = {},
  severity: CheckSeverity = 'error',
): CheckProblem => {
  /* Every finding of a contract code says its promise, so an agent reads which promise broke beside the measurement. */
  const promise = promiseOf(code);
  return { code, severity, step, ...more, message, ...(promise ? { promise } : {}), docs: docsFor(code, step) };
};

/** The one JSON document `--json` prints (schema/check.schema.json). */
interface CheckReport {
  version: 1;
  app: { id: string; name: string } | null;
  dir: string;
  ok: boolean;
  exit: number;
  seconds: number;
  steps: Array<{ step: CheckStep; status: Status; detail: string }>;
  problems: CheckProblem[];
  routes?: Array<{ path: string; what: string }>;
}

const TYPES = 'mistri-schema.d.ts';
/** The App's commands by name, from its commands module (typegen.ts commandTypes). */
const COMMAND_TYPES = 'mistri-commands.d.ts';

/** mistri-commands.d.ts as the App's commands module and its pages say it now, or undefined for an App with neither. */
function appCommandTypes(loaded: LoadedApp): string | undefined {
  const registry = loaded.commands?.registry;
  const pages = Object.entries(loaded.app.views).flatMap(([key, view]) => ('sections' in view && view.page ? [key] : []));
  if (!registry && !pages.length) return undefined;
  return commandTypes(
    registry &&
      Object.fromEntries(
        Object.entries(registry).map(([id, command]) => [
          id,
          {
            target: logicalResource(loaded.app, command.source, command.target),
            targets: command.targets ?? 'one',
            input: command.fields.map((field) => field.name),
            ...(command.public ? { public: true as const } : {}),
          },
        ]),
      ),
    loaded.app.name,
    loaded.loaders ? `./${basename(loaded.commands!.file)}` : undefined,
    pages,
  );
}

/** The commands half of step 1: mistri-commands.d.ts rewritten when the commands module says otherwise. */
async function commandTypesFile(loaded: LoadedApp | undefined, appDir: string, write: boolean): Promise<string | undefined> {
  const types = loaded && appCommandTypes(loaded);
  if (!types) return undefined;
  const file = join(appDir, COMMAND_TYPES);
  const existing = await readFile(file, 'utf8').catch(() => undefined);
  if (existing === types) return `${COMMAND_TYPES} matches the commands module`;
  if (!write) return existing === undefined ? `the App has no ${COMMAND_TYPES} yet` : `${COMMAND_TYPES} is older than the commands module`;
  await writeFile(file, types);
  return existing === undefined
    ? `wrote ${COMMAND_TYPES} from the commands module`
    : `updated ${COMMAND_TYPES} to match the commands module`;
}
/** Each declared component's props type, generated from its declaration (typegenComponents.ts). */
const COMPONENT_TYPES = 'mistri-components.d.ts';

/**
 * The components half of step 1: mistri-components.d.ts rewritten when a declaration says otherwise, and removed
 * when the App declares no component any more, so a stale type never outlives the component it described. An App
 * that keeps its types inline has no generated rows to import; its props types read rows loosely.
 */
async function componentTypesFile(loaded: LoadedApp | undefined, appDir: string, write: boolean): Promise<string | undefined> {
  if (!loaded) return undefined;
  const file = join(appDir, COMPONENT_TYPES);
  const existing = await readFile(file, 'utf8').catch(() => undefined);
  const rows = await readFile(join(appDir, TYPES), 'utf8').then(
    () => true,
    () => false,
  );
  const types = componentTypes(loaded.app, loaded.pages, loaded.app.name, rows);
  if (types === undefined) {
    /* Only a file this tool wrote is its to remove. */
    if (existing === undefined || !ownedTypes(existing)) return undefined;
    if (write) await rm(file);
    return write
      ? `removed ${COMPONENT_TYPES}: the App declares no component`
      : `${COMPONENT_TYPES} describes components the App no longer declares`;
  }
  if (existing === types) return `${COMPONENT_TYPES} matches the component declarations`;
  if (existing !== undefined && !ownedTypes(existing)) return `${COMPONENT_TYPES} was not generated by mistri, so it is left as it is`;
  if (!write)
    return existing === undefined ? `the App has no ${COMPONENT_TYPES} yet` : `${COMPONENT_TYPES} is older than the component declarations`;
  await writeFile(file, types);
  return existing === undefined
    ? `wrote ${COMPONENT_TYPES} from the component declarations`
    : `updated ${COMPONENT_TYPES} to match the component declarations`;
}

/* What the App's directory holds that no file lists: record pages (pages/<key>.ts or .json), free-form pages
   (pages/<path>.page.tsx) and catalogs (messages/<locale>.ts), each beside what it became. Said so an author who
   adds a file sees it was read, and one who forgot a default export sees it was not. */
function foundByFile(loaded: LoadedApp, appDir: string): string[] {
  const pagesDir = join(resolve(appDir), 'pages');
  const records = Object.entries(loaded.sources)
    .filter(([, file]) => resolve(file).startsWith(pagesDir))
    .map(([id, file]) => [relative(appDir, file), `record page "${id}"`] as const);
  const free = (loaded.pageFiles ?? [])
    .map((file) => [file, /^pages\/(.+)\.page\.[jt]sx$/.exec(file)?.[1]] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
    .map(([file, path]) => [file, `page "${path}"`] as const);
  const catalogs = (loaded.messageFiles ?? []).map((file) => [file, `catalog "${basename(file).replace(/\.[^.]+$/, '')}"`] as const);
  const found = [...records, ...free, ...catalogs].sort(([a], [b]) => a.localeCompare(b));
  const width = Math.max(0, ...found.map(([file]) => file.length));
  return found.map(([file, what]) => `${file.padEnd(width)}  ${what}`);
}

const shown = (path: string) => {
  const near = relative(process.cwd(), path);
  return !near ? '.' : near.startsWith('..') ? path : near;
};

/* Flags that start a mode of their own. `check` is the loop's one mode; each
   of these would be a second answer to "what does this command do". */
const MODES: Array<[keyof Options, string]> = [
  ['mcp', '--mcp'],
  ['appMcp', '--app-mcp'],
  ['export', '--export'],
  ['lint', '--lint'],
  ['diff', '--diff'],
  ['scaffoldApp', '--scaffold-app'],
  ['reindex', '--reindex'],
  ['demo', '--demo'],
  ['fromOpenapi', '--from-openapi'],
  ['openapi', '--openapi'],
  ['apiReads', '--api-reads'],
  ['help', '--help'],
  ['version', '--version'],
];

/** The Tables block of a generated file, one line per table: what drift is reported in. */
function tableLines(text: string, type = 'Tables'): Map<string, string> {
  const block = new RegExp(`export type ${type} = \\{\\n([\\s\\S]*?)\\n\\};`).exec(text)?.[1] ?? '';
  return new Map(
    block
      .split('\n')
      .map((line) => /^\s+("?[^:"]+"?): (.*);$/.exec(line))
      .filter(Boolean)
      .map((m) => [m![1].replace(/"/g, ''), m![2]]),
  );
}

function drift(before: string, after: string): string {
  const was = tableLines(before);
  const now = tableLines(after);
  const said: string[] = [];
  for (const [table, columns] of now)
    if (!was.has(table)) said.push(`${table} (new)`);
    else if (was.get(table) !== columns) said.push(`${table} (columns changed)`);
  for (const table of was.keys()) if (!now.has(table)) said.push(`${table} (gone)`);
  return said.length ? said.join(', ') : 'its row types or connections';
}

/** Every column name the App's generated types list: what lets a typecheck hint tell a column from a typo. */
async function schemaColumns(dir: string): Promise<Set<string>> {
  const text = await readFile(join(dir, TYPES), 'utf8').catch(() => '');
  return new Set([...tableLines(text).values()].flatMap((columns) => [...columns.matchAll(/"([^"]+)"/g)].map((match) => match[1])));
}

/** Each table's columns no reader is served (the generated `Hidden`): what lets a hint say why one is refused where it is shown. */
async function hiddenColumns(dir: string): Promise<Map<string, Set<string>>> {
  const text = await readFile(join(dir, TYPES), 'utf8').catch(() => '');
  return new Map(
    [...tableLines(text, 'Hidden')].map(([table, columns]) => [
      table,
      new Set([...columns.matchAll(/"([^"]+)"/g)].map((match) => match[1])),
    ]),
  );
}

/** Whether any authored module imports the generated file: an App that types itself inline has no use for one. */
async function importsGeneratedTypes(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(m?ts|mjs|js)$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
    const path = join(entry.parentPath, entry.name);
    if (path.split(/[\\/]/).includes('node_modules')) continue;
    if ((await readFile(path, 'utf8')).includes(TYPES.replace(/\.d\.ts$/, ''))) return true;
  }
  return false;
}

/* Every header mistri has ever put on this file (typegen.ts), under the wording it had then: the file is mistri's
   whichever version wrote it, and `check` regenerates it. A header only the generator's current words match would
   leave an older App's types to go stale, with a typecheck that never says why. */
const OWNED_TYPES = /^\/\/ Generated by `mistri[ `]/;
const ownedTypes = (text: string): boolean => OWNED_TYPES.test(text);
/** Written by an older mistri: owned, but not under either header the generator writes now. */
const olderGeneratedTypes = (text: string): boolean =>
  ownedTypes(text) && !/^\/\/ Generated by `mistri (?:check --app <app>|--export types)` from the /.test(text);

/** Step 1: the generated schema types, rewritten when the database says otherwise. `migrate status` asks with `write` false, and hears a stale file as a failure. */
export async function schemaTypes(registry: Registry, loaded: LoadedApp | undefined, appDir: string, write = true): Promise<Step> {
  const generated = [await commandTypesFile(loaded, appDir, write), await componentTypesFile(loaded, appDir, write)].filter(
    (line): line is string => line !== undefined,
  );
  const step = (status: Status, detail: string, lines: string[] = []): Step => ({
    name: 'schema types',
    status,
    detail,
    lines: [...generated, ...lines],
    ...(status === 'failed'
      ? {
          problems: [
            problem(
              'schema types',
              /is not configured/.test(detail)
                ? 'unknown-connection'
                : /could not be opened/.test(detail)
                  ? 'database-unreachable'
                  : /older than the database|has no mistri-schema/.test(detail)
                    ? 'schema-types-stale'
                    : 'schema-types',
              detail,
              { file: near(join(appDir, TYPES)) },
            ),
          ],
        }
      : {}),
  });
  if (!loaded) return step('skipped', 'the App did not load; the validation step says why');
  const file = join(appDir, TYPES);
  const existing = await readFile(file, 'utf8').catch(() => undefined);
  if (existing === undefined && !(await importsGeneratedTypes(appDir))) {
    return step('skipped', `the App keeps its types inline; it imports no ${TYPES}`);
  }
  /* Two generated spellings: the App's resources (--app --export types) and a
     whole connection (--export types), which an App may keep on purpose.
     Each is regenerated as what it is; a file mistri did not write is
     someone's, and left alone. */
  const connectionLevel = existing !== undefined && ownedTypes(existing) && /\sconnection\.$/.test(existing.split('\n', 1)[0]!);
  if (existing !== undefined && !ownedTypes(existing)) {
    return step('skipped', `${TYPES} was not generated by mistri, so it is left as it is`);
  }
  const app = loaded.app;
  const bound = app.connection ?? (app.sources ? app.sources[homeSourceOf(app)!]?.connection : undefined);
  const connection = bound
    ? registry.list().find((c) => c.id === bound || c.name === bound)
    : registry.list().find((c) => c.id === registry.active);
  if (!connection)
    return step(
      'failed',
      `the App names connection "${bound}", which is not configured. Known: ${
        registry
          .list()
          .map((c) => c.name)
          .join(', ') || 'none'
      }.`,
    );
  let types: string;
  try {
    // The connection first, on its own: an unreachable database is said as that, never as the driver's text, which can carry a host and a user.
    const { schema } = await registry.open(connection.id).catch(() => {
      // A SQLite file is named as the path tried, absolute: a relative one is the config file's folder's.
      const file = registry.sqliteFile(connection.id);
      throw new Error(
        `the database of connection "${connection.name}" could not be opened${file ? ` (tried the SQLite file ${file})` : ''}`,
      );
    });
    /* A connection-level file is the whole connection, and still the App's:
       its rollups read like columns wherever a column is shown (typegen.ts),
       and a declared reference is a hop a label path takes. Written from the
       raw catalog, a check dropped every rollup the App's pages name. */
    types = !connectionLevel
      ? await appTypes(registry, loaded)
      : // Several sources: the connection's catalog alone. One (a root `connection` is one too): its rollups with it.
        Object.keys(app.sources ?? {}).length > 1
        ? typesForSchema(schema)
        : typesForSchema({
            ...withRollups(app, (await loadAppRuntimeResources(registry, app, connection.id)).schema),
            label: schema.label,
          });
  } catch (error) {
    return step('failed', (error as Error).message);
  }
  if (existing !== undefined && sameTypes(existing, types)) {
    return step('passed', `${TYPES} matches the database`);
  }
  if (!write)
    return step(
      'failed',
      existing === undefined ? `the App has no ${TYPES} yet` : `${TYPES} is older than the database — ${drift(existing, types)}`,
    );
  await writeFile(file, typesFileText(types));
  return existing === undefined
    ? step('passed', `wrote ${TYPES} from the database`)
    : /* Said as what changed, not why: an App that binds a resource, adds a
       rollup or narrows a role changes the file as surely as a migration. */
      step('passed', `updated ${TYPES} to match the database and the App's resources — ${drift(existing, types)}`);
}

/* The lines mistri check sends to stderr that are only its startup narration. */
/** The App's verdict as `mistri check` prints it (oneShot.ts checkApps): its name, then ok or its count of problems. */
const VERDICT = /^[^:]+: (?:ok|\d+ problems?)$/;
const NARRATION = /^mistri: (app ".*" from |\d+ connection\(s\)|.+ \((sqlite|postgres|http)\) — )/;

/**
 * `mistri check …`, as the command line runs it. Returns the exit code.
 * With `--json` the same steps run and the output is one JSON document
 * (schema/check.schema.json) instead of the lines: every finding with its
 * code, place and fix, a refusal to check included, and the exit code unchanged.
 */
export async function runCheck(
  argv: string[],
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<number> {
  const brief = argv.includes('--brief');
  if (!(argv.includes('--json') || brief) || argv.includes('--help') || argv.includes('-h'))
    return runSteps(
      argv.filter((arg) => arg !== '--json' && arg !== '--brief'),
      write,
    );
  const started = performance.now();
  /* A refusal to check is said on stderr; as JSON it is the one problem. */
  const refused: string[] = [];
  const error = console.error;
  console.error = (...said: unknown[]) => {
    refused.push(said.map(String).join(' '));
  };
  let report: CheckReport | undefined;
  let code: number;
  try {
    code = await runSteps(
      argv.filter((arg) => arg !== '--json' && arg !== '--brief'),
      () => {},
      (made) => {
        report = made;
      },
    );
  } finally {
    console.error = error;
  }
  const given = argv[argv.indexOf('--app') + 1];
  report ??= {
    version: 1,
    app: null,
    dir: argv.includes('--app') && given ? near(resolve(given)) : '.',
    ok: false,
    exit: code,
    seconds: Number(((performance.now() - started) / 1000).toFixed(1)),
    steps: [],
    problems: (refused.length ? refused : ['the App could not be checked']).map((message) =>
      problem(
        'check',
        'could-not-check',
        message.replace(/^mistri check: /, '').replace(new RegExp(` ${CHECK_USAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), ''),
      ),
    ),
  };
  if (brief && !argv.includes('--json')) for (const line of briefLines(report, { all: argv.includes('--warnings') })) write(line);
  else write(JSON.stringify(report, null, 2));
  return code;
}

/**
 * `--brief`: a problem per line, `code file:line message — fix: …`, for the context of the agent
 * that fixes them. A finding the check gave no fix for borrows the documented one, else has no fix
 * part (a pointer to the message is filler); a warning says so; info is not a problem. Nothing
 * else is printed, so a clean App prints `ok`.
 */
/** The one information finding the text outputs say (briefLines and the step lines): which Preview features the App uses. */
const PREVIEW_FEATURE = 'preview-feature';

/* Where the documentation's fix points at the message ("the nearest"), the shortest hint that stands alone. */
const BRIEF_HINTS: Record<string, string> = {
  'unknown-column': 'use a column the table has (the message names the nearest; mistri schema --brief lists them)',
  'unknown-key': 'use one of the keys the message lists',
};

/** The resource a finding is about, where its path says one (`resources.lead.actions…`), to group repeats by. */
function tableOf(found: CheckProblem): string {
  return /^resources\.([^.[]+)/.exec(found.path ?? '')?.[1] ?? '';
}

/**
 * `all` lists every warning as its own line (`check --brief --warnings`). Otherwise warnings that repeat — the same
 * code on the same table, the same advice once per role — are one line a group with its count and one example, and a
 * last line points at `--warnings`: a green run of a big App printed 43k characters of them. Errors are never grouped.
 */
export function briefLines(report: { problems: CheckProblem[] }, opts: { all?: boolean } = {}): string[] {
  const place = (found: CheckProblem) =>
    found.file
      ? ` ${isAbsolute(found.file) ? relative(process.cwd(), found.file) || found.file : found.file}${found.line ? `:${found.line}` : ''}`
      : '';
  const said = (found: CheckProblem, tag: string) => {
    const fix = found.fix ?? BRIEF_HINTS[found.code] ?? documentedFix(found.code);
    return `${found.code}${tag}${place(found)} ${found.message.replace(/\s*\n\s*/g, ' ').replace(ICON_LIST_TAIL, '')}${fix ? ` — fix: ${fix}` : ''}`;
  };
  const lines: string[] = [];
  const groups = new Map<string, CheckProblem[]>();
  for (const found of report.problems) {
    if (found.severity === 'info') continue;
    if (found.severity !== 'warning' || opts.all) {
      lines.push(said(found, found.severity === 'warning' ? ' (warning)' : ''));
      continue;
    }
    const key = `${found.code}\u0000${tableOf(found)}`;
    groups.set(key, [...(groups.get(key) ?? []), found]);
  }
  let collapsed = 0;
  let kinds = 0;
  for (const [key, group] of groups) {
    if (group.length === 1) {
      lines.push(said(group[0]!, ' (warning)'));
      continue;
    }
    collapsed += group.length;
    kinds++;
    const table = key.split('\u0000')[1];
    lines.push(said(group[0]!, ` (warning ×${group.length}${table ? ` on ${table}` : ''}, first shown)`));
  }
  if (collapsed) lines.push(`${collapsed} warnings in ${kinds} groups, one example each; --warnings lists every one`);
  if (report.problems.some((found) => found.severity !== 'info' && ICON_LIST_TAIL.test(found.message.replace(/\s*\n\s*/g, ' '))))
    lines.push(iconListLine());
  /* Info is not a problem, but an author should hear once which Preview features the App leans on: the one info
     finding said, after `ok` or the problems, with no fix, since there is nothing to fix. */
  const preview = report.problems.find((found) => found.code === PREVIEW_FEATURE);
  return [...(lines.length ? lines : ['ok']), ...(preview ? [`${preview.code} (info)${place(preview)} ${preview.message}`] : [])];
}

async function runSteps(argv: string[], write: (line: string) => void, emit?: (report: CheckReport) => void): Promise<number> {
  const started = performance.now();
  let app: string | undefined;
  let routes = false;
  let design = false;
  let fix = false;
  let defaults = false;
  let failOnDesignWarning = false;
  let showWarnings = false;
  let pending = false;
  let pendingOn: string | undefined;
  let deploy = false;
  let replicas: number | undefined;
  let connectionLimit: number | undefined;
  let cpus: number | undefined;
  let migrations: string | undefined;
  let historyTable: string | undefined;
  let rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') {
      write(
        `${CHECK_USAGE}\n\nRegenerate the App's schema types, typecheck it and validate it against its database,\n` +
          'one line per step, and lint its custom components. Exit codes: 1 could not check, 2 schema types, 3 typecheck, 4 validation, 5 components.\n' +
          '--routes also prints every address the App answers to, and what each one opens.\n' +
          '--design also reads its pages, forms and shell for the compositions that come out basic, each a warning with its fix (mistri docs design).\n' +
          "--fix writes into each App theme's source the color or chart order its contrast and color-blind failures say passes, and checks it again;\n" +
          '  with --design it also deletes each rule the `restated` warnings name: one the platform infers anyway, and names each query the `repeated-query` warnings find as a segment, first, so every step after it says what is left.\n' +
          '--fail-on-design-warning includes design checks and fails with exit 4 when they report warnings.\n' +
          '--warnings lists every warning in full; without it they are one line a kind after the errors (a failing App was buried under ~60 of them).\n' +
          "--defaults prints every rule the platform infers for each resource (mistri docs conventions) and the layout each page is drawn in, and whether the App's own wins.\n" +
          '--bump <command> moves a command whose contract changed to its next version in authority.lock (its API route, receipts and jobs follow).\n' +
          "--pending judges the App against the schema as it will be after the pending migrations (mistri migrate), applied to a scratch copy, or with --pending-on <url> to the scratch database that URL names (a branch of the database, never the App's own). Exit 6: one failed there.\n" +
          "--deploy judges whether the App survives a container being replaced (mistri docs build-and-deploy): it refuses a source or auth.store on a SQLite file, the default auth.store, and a missing BETTER_AUTH_SECRET or ${NAME} the environment lacks, and with --replicas <n> above one it warns about per-process rate limits. Run it with the deployment's environment. Exit 7.\n" +
          '--json prints one JSON document instead (schema/check.schema.json): every finding with its code, file, line, column, path and fix.\n' +
          '--brief prints one line per problem, `code file:line message — fix: …`, and nothing else (ok when there is none): errors each in full, warnings a group by code and resource with its count and one example (--warnings lists every one). Exit codes are the same. mistri explain <code> says more.',
      );
      return CHECK_EXIT.passed;
    }
    // This command's own: the route table is a reading of the App, not a mode of the server.
    if (argv[i] === '--routes') {
      routes = true;
      continue;
    }
    if (argv[i] === '--design') {
      design = true;
      continue;
    }
    if (argv[i] === '--fix') {
      fix = true;
      continue;
    }
    if (argv[i] === '--defaults') {
      defaults = true;
      continue;
    }
    if (argv[i] === '--warnings') {
      showWarnings = true;
      continue;
    }
    if (argv[i] === '--fail-on-design-warning') {
      design = true;
      failOnDesignWarning = true;
      continue;
    }
    if (argv[i] === '--pending') {
      pending = true;
      continue;
    }
    if (argv[i] === '--pending-on') {
      const given = argv[++i];
      if (given === undefined || given.startsWith('-')) {
        console.error(`mistri check: --pending-on needs the URL of a scratch database. ${CHECK_USAGE}`);
        return CHECK_EXIT.couldNotCheck;
      }
      pending = true;
      pendingOn = given;
      continue;
    }
    if (argv[i] === '--deploy') {
      deploy = true;
      continue;
    }
    if (argv[i] === '--replicas') {
      const given = argv[++i];
      if (given === undefined || !/^[1-9]\d{0,3}$/.test(given)) {
        console.error(`mistri check: --replicas takes the number of instances you will run, like 3. ${CHECK_USAGE}`);
        return CHECK_EXIT.couldNotCheck;
      }
      replicas = Number(given);
      continue;
    }
    if (argv[i] === '--connection-limit') {
      const given = argv[++i];
      if (given === undefined || !/^[1-9]\d{0,5}$/.test(given)) {
        console.error(`mistri check: --connection-limit takes the connections the database allows this role, like 100. ${CHECK_USAGE}`);
        return CHECK_EXIT.couldNotCheck;
      }
      connectionLimit = Number(given);
      continue;
    }
    if (argv[i] === '--cpus') {
      const given = argv[++i];
      if (given === undefined || !/^[1-9]\d{0,3}$/.test(given)) {
        console.error(`mistri check: --cpus takes the cores the deployment has, like 1 or 4. ${CHECK_USAGE}`);
        return CHECK_EXIT.couldNotCheck;
      }
      cpus = Number(given);
      continue;
    }
    if (argv[i] === '--migrations' || argv[i] === '--history-table') {
      const given = argv[++i];
      if (given === undefined || given.startsWith('-')) {
        console.error(`mistri check: ${argv[i - 1]} needs a value. ${CHECK_USAGE}`);
        return CHECK_EXIT.couldNotCheck;
      }
      if (argv[i - 1] === '--migrations') migrations = given;
      else historyTable = given;
      continue;
    }
    if (argv[i] === '--app') {
      if (app !== undefined) {
        console.error(`mistri check: --app may be supplied only once. ${CHECK_USAGE}`);
        return CHECK_EXIT.couldNotCheck;
      }
      app = argv[++i];
      if (app === undefined || app.startsWith('-')) {
        console.error(`mistri check: --app needs a directory. ${CHECK_USAGE}`);
        return CHECK_EXIT.couldNotCheck;
      }
      continue;
    }
    rest.push(argv[i]);
  }
  if (!app) {
    console.error(`mistri check: --app <dir> names the App to check. ${CHECK_USAGE}`);
    return CHECK_EXIT.couldNotCheck;
  }
  if (replicas !== undefined && !deploy) {
    console.error(`mistri check: --replicas says how many instances --deploy judges for. ${CHECK_USAGE}`);
    return CHECK_EXIT.couldNotCheck;
  }
  if ((connectionLimit !== undefined || cpus !== undefined) && !deploy) {
    console.error(
      `mistri check: --connection-limit says what --deploy holds the pools to, and --cpus the cores it sizes them for. ${CHECK_USAGE}`,
    );
    return CHECK_EXIT.couldNotCheck;
  }
  if ((migrations !== undefined || historyTable !== undefined) && !pending) {
    console.error(`mistri check: --migrations and --history-table say where --pending finds the migrations. ${CHECK_USAGE}`);
    return CHECK_EXIT.couldNotCheck;
  }
  let opts = parseArgs(rest);
  const mode = MODES.find(([key]) => opts[key] !== undefined && opts[key] !== false);
  const refusal = opts.unknown
    ? `unknown option "${opts.unknown}"`
    : mode
      ? `${mode[1]} is a mode of its own; mistri check takes the App's database and its server entries`
      : undefined;
  if (refusal) {
    console.error(`mistri check: ${refusal}. ${CHECK_USAGE}`);
    return CHECK_EXIT.couldNotCheck;
  }
  const appDir = resolve(app);
  const info = await stat(appDir).catch(() => undefined);
  if (!info?.isDirectory()) {
    console.error(`mistri check: ${app} is not a directory. Check an App's directory: its manifest, pages/ and types travel together.`);
    return CHECK_EXIT.couldNotCheck;
  }
  /* Read as CommonJS, every import in the App is an error of its own (TS1295) and the load fails
     with "Cannot use import statement outside a module": one line with the fix says it instead. */
  const commonJs = moduleTypeProblem(appDir, shown);
  if (commonJs) {
    console.error(`mistri check: ${commonJs}`);
    return CHECK_EXIT.couldNotCheck;
  }

  /* With --pending, the database is a scratch copy with the pending
     migrations applied (build/pending.ts), and every step below reads it. */
  let copy: Awaited<ReturnType<typeof import('./pending.js').pendingCopy>> | undefined;
  if (pending) {
    const { pendingCopy } = await import('./pending.js');
    try {
      copy = await pendingCopy(appDir, rest, {
        ...(migrations !== undefined ? { migrations } : {}),
        ...(historyTable !== undefined ? { table: historyTable } : {}),
        ...(pendingOn !== undefined ? { on: pendingOn } : {}),
      });
    } catch (error) {
      console.error(`mistri check: --pending could not make its copy: ${(error as Error).message}`);
      return CHECK_EXIT.couldNotCheck;
    }
    if (copy.status === 'failed') {
      write(`Checking in ${shown(appDir)}`);
      write(`  pending  failed  ${copy.detail}`);
      for (const line of copy.lines) write(`                   ${line}`);
      write(`pending failed: the App was not judged. Exit ${CHECK_EXIT.pending}.`);
      emit?.({
        version: 1,
        app: null,
        dir: shown(appDir),
        ok: false,
        exit: CHECK_EXIT.pending,
        seconds: Number(((performance.now() - started) / 1000).toFixed(1)),
        steps: [{ step: 'pending', status: 'failed', detail: copy.detail }],
        problems: [problem('pending', 'pending-migration', [copy.detail, ...copy.lines].join('\n'))],
      });
      return CHECK_EXIT.pending;
    }
    rest = copy.args;
    opts = parseArgs(rest);
  }

  /* The database, as a start would reach it. Its narration is not this
     command's to print: stdout is the three verdicts. */
  const registry = new Registry();
  const log = console.log;
  console.log = () => {};
  try {
    const config = await readStartupConfig(opts, registry, CONFIG_SECTIONS);
    /* A config beside the App may list it — that is where its environment is
       written (`apps[].env`) — but not another App, which would be checked
       beside this one. */
    const others = config.apps.filter((dir) => resolve(dir) !== appDir);
    if (others.length) {
      console.error(
        `mistri check: ${config.configPath} lists "apps" other than ${shown(appDir)}, which would check a second App beside this one. ` +
          'Give it a config that lists only this App, or connections only.',
      );
      return CHECK_EXIT.couldNotCheck;
    }
    const env = config.appEnv[appDir];
    if (opts.target) {
      const added = registry.add({ name: redact(opts.target), url: opts.target, schemas: opts.schemas, source: 'argument' });
      registry.setActive(added.id);
    }
    if (!registry.list().length) {
      console.error(
        'mistri check: no database to check the App against. Name it — a SQLite file, --db <url>, or --config <file> — ' +
          'or keep a mistri.json beside where you run it.',
      );
      return CHECK_EXIT.couldNotCheck;
    }

    let loaded: LoadedApp | undefined;
    /* An App whose views or pages are refused still has its data half —
       connections, resources, grants — and that is all the schema types
       read. Typechecking against last week's types instead turned one
       refusal into a screen of "not a column" errors for columns that exist. */
    let partial: LoadedApp | undefined;
    const manifest =
      opts.appEntry !== undefined
        ? resolve(opts.appEntry)
        : ['app.ts', 'app.mjs', 'app.json'].map((name) => join(appDir, name)).find((file) => existsSync(file));
    const load = async () => {
      loaded = partial = undefined;
      try {
        loaded = await loadApp(appDir, {
          lock: 'report',
          // Its own components step names each finding, coded and placed; a refused load would say them once, unplaced.
          componentLint: false,
          ...(opts.appEntry !== undefined ? { entry: opts.appEntry } : {}),
          ...(env ? { env } : {}),
          ...(opts.commands !== undefined ? { commands: opts.commands } : {}),
        });
      } catch (error) {
        // Said once, by the validation step, in mistri check's own words.
        if (error instanceof AppProblems && error.partial && manifest) {
          partial = { path: manifest, dir: appDir, app: error.partial as AppDef, pages: [], sources: {} };
        }
      }
    };
    await load();
    /* The catalog the App is served with, rollups and soft keys included: what the fix, the addresses and the
       design lint read it over. */
    const catalogOf = async (app: LoadedApp): Promise<{ schema?: DatabaseSchema; why: string }> => {
      try {
        const bound = app.app.connection ?? (app.app.sources ? app.app.sources[homeSourceOf(app.app)!]?.connection : undefined);
        const connection = bound
          ? registry.list().find((c) => c.id === bound || c.name === bound)
          : registry.list().find((c) => c.id === registry.active);
        if (!connection) throw new Error(`the App names connection "${bound}", which is not configured`);
        return { schema: (await loadAppRuntimeResources(registry, app.app, connection.id)).schema, why: '' };
      } catch (error) {
        return { why: `could not read the App's catalog: ${(error as Error).message}` };
      }
    };
    /* The fix runs first and the App is read again after it, so every step below — the validation's warnings, the
       design lint — says what is left rather than what the fix just deleted. */
    let fixStep: Step | undefined;
    if (design && fix && loaded) {
      const { schema, why } = await catalogOf(loaded);
      if (!schema) fixStep = { name: 'fix', status: 'skipped', detail: why, lines: [] };
      else {
        const before: LoadedApp = loaded;
        const { fixed, left } = fixRestated(before.app, withRollups(before.app, schema), appDir, (warning) =>
          saidByMessage(before, warning),
        );
        // A query said in several places becomes a segment said once (appSegments.ts repeatedQueries).
        const lifted = fixRepeatedQueries(before.app, withRollups(before.app, schema), appDir);
        fixStep = {
          name: 'fix',
          status: 'passed',
          detail:
            [
              fixed.length ? `${fixed.length} restated rule${fixed.length === 1 ? '' : 's'} deleted` : '',
              lifted.fixed.length ? `${lifted.fixed.length} repeated quer${lifted.fixed.length === 1 ? 'y' : 'ies'} named as segments` : '',
            ]
              .filter(Boolean)
              .join(', ') || 'nothing restated',
          lines: [...fixed, ...lifted.fixed, ...[...left, ...lifted.left].map((line) => `left: ${line}`)],
        };
        if (fixed.length || lifted.fixed.length) await load();
      }
    }
    /* The App's own themes are fixed in the same pass, --design or not: each failure's passing color is written into
       the theme's source and the App read again, until none is left that can be written — a fix moves one color, and
       a color beside it may then want its own. Three rounds is more than a theme takes. */
    if (fix && loaded) {
      /* A color written in one round and moved again in the next is said once, as it was left. */
      const written = new Map<string, string>();
      const left: string[] = [];
      let now: LoadedApp | undefined = loaded;
      let found = appThemeProblems(now.app);
      for (let round = 0; round < 3 && now && found.some((problem) => problem.fix); round++) {
        const seen = new Set<string>();
        let wrote = false;
        for (const failure of found) {
          if (!failure.fix || seen.has(`${failure.themeId} ${failure.fix.path}`)) continue;
          seen.add(`${failure.themeId} ${failure.fix.path}`);
          const theme = now.app.ui.customThemes?.find((item) => item.id === failure.themeId);
          const result = writeThemeFix(appDir, failure.themeId, failure.fix, theme ? writtenAt(theme, failure.fix.path) : undefined);
          if ('done' in result) {
            written.delete(`${failure.themeId} ${failure.fix.path}`);
            written.set(`${failure.themeId} ${failure.fix.path}`, result.done.replace(`${appDir}/`, ''));
            wrote = true;
          } else left.push(result.left);
        }
        if (!wrote) break;
        await load();
        now = loaded as LoadedApp | undefined;
        found = now ? appThemeProblems(now.app) : [];
      }
      if (written.size || left.length) {
        const detail = `${written.size} theme color${written.size === 1 ? '' : 's'} written`;
        const lines = [...written.values(), ...[...new Set(left)].map((line) => `left: ${line}`)];
        fixStep =
          fixStep?.status === 'passed'
            ? { ...fixStep, detail: `${detail}, ${fixStep.detail}`, lines: [...lines, ...fixStep.lines] }
            : { name: 'fix', status: 'passed', detail: fixStep ? `${detail}; ${fixStep.detail}` : detail, lines };
      }
    }
    const named = loaded ?? partial;
    write(`Checking ${named ? `"${named.app.name}" ` : ''}in ${shown(appDir)}`);
    if (config.environmentTargetNote) write(`  note: ${config.environmentTargetNote}`);
    let routeTableSaid: Array<{ path: string; what: string }> | undefined;
    const steps: Step[] = copy ? [{ name: 'pending', status: copy.status, detail: copy.detail, lines: copy.lines }] : [];
    if (fixStep) steps.push(fixStep);
    /* A page is named by its label in a sentence and by its key in the definition. */
    const pageIds = new Map((named?.pages ?? []).map((page) => [page.name, page.id] as const));

    /* The App's own themes, judged first: each failure with the color that passes (shared/themeFix.ts). */
    const themeProblems: FixedThemeProblem[] = named ? appThemeProblems(named.app) : [];
    const themed = loaded ?? named;
    if (themed?.app.ui.customThemes?.length) {
      /* The theme the App wears may suggest where the menu goes; where the App says so itself, its word wins, said once. */
      const wornTheme = themed.app.ui.customThemes.find((theme) => theme.id === themed.app.ui.theme?.preset);
      const overridden = placementIn(themed.app.ui, wornTheme).overridden;
      steps.push({
        name: 'themes',
        status: themeProblems.length ? 'failed' : 'passed',
        detail: themeSummary(themed.app.ui.customThemes, themeProblems),
        lines: overridden ? [`note: ${overridden}`] : [],
      });
    }
    const faces = loaded ? fontSummary(loaded.app, loaded.fonts) : undefined;
    /* The budget fails check, not a warning beside it: past it, the faces move every page's text as they land. */
    const overBudget = loaded ? fontBudgetProblem(loaded.app, loaded.fonts) : undefined;
    if (faces)
      steps.push({
        name: 'fonts',
        status: overBudget ? 'failed' : 'passed',
        detail: faces,
        lines: overBudget ? [overBudget] : [],
        /* The theme contract's C11: the budget's own code and its sentence, not the step's summary of the faces. */
        ...(overBudget
          ? { problems: [problem('fonts', 'theme-budget', overBudget, { fix: 'Ship fewer weights, or a variable file cut to Latin.' })] }
          : {}),
      });
    const byFile = loaded ? foundByFile(loaded, appDir) : [];
    if (byFile.length)
      steps.push({
        name: 'files',
        status: 'passed',
        detail: `${byFile.length} found by ${byFile.length === 1 ? 'its file' : 'their files'}`,
        lines: byFile,
      });
    /* A theme's failure is said by validation in the words it was found with; it is placed at the key that says the color. */
    const themeSaid = new Map(themeProblems.map((found) => [found.message, found] as const));

    // 1. The schema types, before the typecheck that reads them.
    steps.push(await schemaTypes(registry, named, appDir));
    /* The server entries, the commands module the App was loaded with among them, and the command types it generated. */
    const generated = existsSync(join(appDir, COMMAND_TYPES)) ? [join(appDir, COMMAND_TYPES)] : [];
    const entries = [
      ...new Set(
        [opts.commands, loaded?.commands?.file || undefined, opts.jobs, opts.policy]
          .filter((file): file is string => Boolean(file))
          .map((file) => resolve(file)),
      ),
    ];
    entries.push(...generated);
    /* Its free-form pages too: each is checked against the reads, commands and loaders it declares (packages/mistri/schema/page.d.ts). */
    entries.push(...(loaded?.pageFiles ?? []).map((file) => join(appDir, file)));
    /* Its catalogs: a translation is typed against the source catalog's keys (packages/mistri/schema/app.d.ts defineMessages). */
    entries.push(...(loaded?.messageFiles ?? []).map((file) => join(appDir, file)));
    const typed = await typecheckApp(appDir, [...((loaded?.path ?? manifest) ? [loaded?.path ?? manifest!] : []), ...entries]);
    const columns = await schemaColumns(appDir);
    const hidden = await hiddenColumns(appDir);
    /* Types an older version wrote, left as they were: the errors below are likely theirs, so the cause leads. */
    const olderTypes = typed.status === 'failed' && olderGeneratedTypes(await readFile(join(appDir, TYPES), 'utf8').catch(() => ''));
    const olderSaid = 'schema types are from an older version; run mistri check to regenerate';
    const typecheckStep: Step =
      typed.status === 'failed'
        ? {
            name: 'typecheck',
            status: 'failed',
            detail: olderTypes ? `${olderSaid}. ${typed.detail}` : typed.detail,
            lines: [...(olderTypes ? [olderSaid] : []), ...readableTypeErrors(typed.output ?? '', 20, columns, !named, hidden)],
            /* Each of tsc's errors at its own file, line and column, with the definition path the position is inside. */
            problems: await Promise.all(
              parseTsc(typed.output ?? '').map(async (error) => {
                const file = error.file === undefined ? undefined : resolve(appDir, error.file);
                const inner = error.detail.at(-1);
                const fix = hint(error, columns, hidden);
                const path = file && error.line ? await pathAt(file, error.line, error.column ?? 1, appDir) : undefined;
                return problem(
                  'typecheck',
                  error.code,
                  shorten(inner && inner !== error.message ? `${error.message} ${inner}` : error.message),
                  {
                    ...(file ? { file: near(file), line: error.line, column: error.column } : {}),
                    ...(path ? { path } : {}),
                    ...(fix ? { fix } : {}),
                  },
                );
              }),
            ),
          }
        : { name: 'typecheck', status: typed.status === 'none' ? 'skipped' : typed.status, detail: typed.detail, lines: [] };
    /* An App that did not load at all had its schema types left as they were, so its typecheck reads stale types: one
       misplaced key became a screen of "not a column" for every rollup and new column, printed before the one real
       problem. The load's problem is said first, and the typecheck waits for it. */
    const unloaded = !named;
    if (!unloaded) steps.push(typecheckStep);

    // 3. Validation: the real mistri check, as CI runs it.
    const checked = await checkApp([...rest, '--app', appDir]);
    // Placed only in the modules the App was loaded from, and what they import: never a copy kept beside them.
    const locator = await sourceLocator(appDir, [...(loaded?.path ? [loaded.path] : manifest ? [manifest] : []), ...entries]);
    const verdict = checked.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    /* A finding's own lines under it (indented past the finding's two spaces): a changed authority lock's diff, one
       granted fact a line. They are the finding's, not findings of their own: each was an `invalid-app` error that
       said "Correct the declaration" over a change the author made on purpose and accepts with --write-authority. */
    const under = new Map<string, string[]>();
    const continued = new Set<string>();
    let lead: string | undefined;
    for (const raw of checked.stdout.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (lead !== undefined && /^ {4,}/.test(raw)) {
        under.set(lead, [...(under.get(lead) ?? []), line]);
        continued.add(line);
      } else lead = line;
    }
    const stderr = checked.stderr.split('\n').filter((line) => line.trim() && !NARRATION.test(line));
    /* Each line's place, once, for the text and the JSON alike: the definition path walked in the module that
       defines the App where the sentence says one, else the sentence's own words found in the App's modules. */
    const places = new Map<string, { file: string; line: number } | undefined>();
    for (const line of [...verdict, ...stderr]) {
      const text = line.replace(/^warning: /, '');
      const own = /^([^\s:]+\.(?:m?ts|mjs|js|json)): /.exec(text);
      const theme = themeSaid.get(own ? text.slice(own[0].length) : text);
      if (theme) {
        const place = themePlace(appDir, theme.themeId, theme.at);
        places.set(line, place ? { file: near(place.file), line: place.line } : locator.at(text));
        continue;
      }
      const path = pathOfMessage(own ? text.slice(own[0].length) : text, pageIds);
      const walked = path && !/\.(m?[tj]s|json):\d+/.test(text) ? await placeOf(locator.files, path, text, appDir) : undefined;
      places.set(line, walked ? { file: near(walked.file), line: walked.line } : locator.at(text));
    }
    const located = (line: string) => {
      const place = places.get(line);
      return place ? `${place.file}:${place.line}  ${line}` : line;
    };
    const notes = stderr.map(located);
    /* The App's verdict, "<name>: ok" or "<name>: 2 problems": what comes before it is the listing of the automation
       the App was checked with (jobLoader.ts describeJobs: a line a job, workflow, endpoint and integration), which
       says what runs and is never a problem, however the App fared (TR12). Without one, the load itself failed. */
    const head = verdict.findIndex((line) => VERDICT.test(line));
    const listing = new Set(head > 0 ? verdict.slice(0, head) : []);
    /* The verdict is the last line that is not advice: the warnings follow it. */
    const said = verdict.findLastIndex((line) => !line.startsWith('warning:') && !continued.has(line));
    /* One finding per line the validation said, beside its verdict: a warning or a problem. */
    const found = (line: string, failed: boolean): CheckProblem | undefined => {
      if (continued.has(line)) return undefined;
      const severity: CheckSeverity = line.startsWith('warning: ') ? 'warning' : failed && !listing.has(line) ? 'error' : 'info';
      const text = line.replace(/^warning: /, '');
      /* A sentence starts with the file the load names ("app.ts: …"), which the place below says better. */
      const own = /^([^\s:]+\.(?:m?ts|mjs|js|json)): /.exec(text);
      const message = own ? text.slice(own[0].length) : text;
      if (VERDICT.test(message)) return undefined;
      const place = places.get(line);
      const theme = themeSaid.get(message);
      const path = theme ? `ui.customThemes.${theme.themeId}.${theme.at}` : pathOfMessage(message, pageIds);
      const code = validationCode(message);
      return problem(
        'validation',
        code,
        under.has(line) ? `${message} ${under.get(line)!.join('; ')}` : message,
        {
          ...(place ? { file: place.file, line: place.line } : own ? { file: near(join(appDir, own[1])) } : {}),
          ...(path ? { path } : {}),
          ...(theme?.fix ? { fix: `${theme.fix.said} (mistri check --fix writes it)` } : {}),
        },
        severity,
      );
    };
    /* The Preview features the App uses (packages/mistri/src/shared/preview.ts): said once, as information; the check still passes. */
    const preview = loaded ? previewKeysUsed(loaded.app) : [];
    const previewFinding = preview.length
      ? problem(
          'validation',
          PREVIEW_FEATURE,
          `This App uses Preview features (${preview.join(', ')}). They work as documented and may change in any 1.x release.`,
          { file: shown(loaded!.path) },
          'info',
        )
      : undefined;
    steps.push(
      checked.code === 0
        ? {
            name: 'validation',
            status: 'passed',
            detail: verdict[said] ?? 'ok',
            lines: [...verdict.filter((_, i) => i !== said), ...notes],
            problems: [
              ...[...verdict.filter((_, i) => i !== said), ...stderr].flatMap((line) => found(line, false) ?? []),
              ...(previewFinding ? [previewFinding] : []),
            ],
          }
        : {
            name: 'validation',
            status: 'failed',
            detail: verdict[Math.max(head, 0)] ?? 'the App did not load',
            lines: [...verdict.filter((_, i) => i !== Math.max(head, 0)).map(located), ...notes],
            problems: [...verdict.filter((_, i) => i !== Math.max(head, 0)), ...stderr].flatMap((line) => found(line, true) ?? []),
          },
    );

    if (unloaded)
      steps.push(
        typecheckStep.status === 'failed'
          ? {
              name: 'typecheck',
              status: 'skipped',
              detail: `not judged: the App did not load, so its schema types are as they were. Fix what validation says, then check again`,
              lines: [],
            }
          : typecheckStep,
      );

    // 4. Custom components, when it declares any: their sources, as compiled.
    if (loaded?.components) {
      /* A free-form page's sources are held to what it declares: each a dashboard of one component, with its manifest. */
      const pages = pageManifestsOf(loaded.app);
      const lint = await lintComponents(appDir, loaded.components, pages);
      const said = (finding: { file: string; line: number; text: string }) =>
        `${shown(join(appDir, finding.file))}:${finding.line}  ${finding.text}`;
      const count = Object.keys(loaded.components.entries).length;
      const findings = [
        ...lint.problems.map((finding) => [finding, 'error'] as const),
        ...lint.warnings.map((finding) => [finding, 'warning'] as const),
      ].map(([finding, severity]) =>
        problem(
          'components',
          componentCode(finding.text),
          finding.text,
          { file: shown(join(appDir, finding.file)), line: finding.line, path: `components.${finding.component}` },
          severity,
        ),
      );
      steps.push(
        lint.problems.length
          ? {
              name: 'components',
              status: 'failed',
              detail: `${lint.problems.length} problem${lint.problems.length === 1 ? '' : 's'} in ${count} component${count === 1 ? '' : 's'}`,
              lines: [...lint.problems.map(said), ...lint.warnings.map((finding) => `warning: ${said(finding)}`)],
              problems: findings,
            }
          : {
              name: 'components',
              status: 'passed',
              detail: `${count} compiled${lint.warnings.length ? `, ${lint.warnings.length} warning${lint.warnings.length === 1 ? '' : 's'}` : ''}`,
              lines: lint.warnings.map((finding) => `warning: ${said(finding)}`),
              problems: findings,
            },
      );
    }

    /* The addresses and the design lint, on request: both read the App over
       the catalog it is served with, rollups and soft keys included. */
    if ((routes || design || defaults) && loaded) {
      const catalog = await catalogOf(loaded);
      const schema = catalog.schema;
      let why = catalog.why;
      if (routes) {
        if (!schema) steps.push({ name: 'routes', status: 'skipped', detail: why, lines: [] });
        else {
          /* Where the App is served, as a server started with these flags
             and this config would serve it (shared/mount.ts): the Apps the
             mounts name are its neighbours, and at the root it may not
             route to one of theirs. */
          let mount: AddressMount | undefined;
          try {
            mount = settingsMount([...new Set([loaded.app.id, ...Object.keys({ ...config.mount, ...opts.mounts })])], opts, config);
          } catch (error) {
            why = (error as Error).message;
          }
          if (!mount) steps.push({ name: 'routes', status: 'failed', detail: why, lines: [], problems: [problem('routes', 'mount', why)] });
          else {
            const table = checkedRoutes(loaded, schema, mount);
            const clashes = mountClashes(appRoutes(loaded, schema), segmentsTakenFrom(mount, loaded.app.id));
            const width = Math.max(...table.map((row) => row.path.length));
            routeTableSaid = table;
            steps.push(
              clashes.length
                ? {
                    name: 'routes',
                    status: 'failed',
                    detail: `${clashes.length} address${clashes.length === 1 ? '' : 'es'} another App holds`,
                    lines: clashes,
                    problems: clashes.map((clash) => problem('routes', 'route-clash', clash, { file: shown(loaded!.path) })),
                  }
                : {
                    name: 'routes',
                    status: 'passed',
                    detail: `${table.length} addresses`,
                    lines: table.map((row) => `${row.path.padEnd(width)}  ${row.what}`),
                  },
            );
          }
        }
      }
      /* Every read a command makes under its own authority rather than its
         caller's (`elevate`), for review: which tables, and which granted
         roles would not read them otherwise. Listed, never a warning — an
         elevation is a decision, and this is where it is seen. */
      if (design) {
        const lines = commandElevations(loaded.app, loaded.commands?.registry ?? {}, schema);
        // An App that elevates nothing has nothing to review: no step.
        if (lines.length)
          steps.push({
            name: 'elevations',
            status: 'passed',
            detail: `${lines.length} command${lines.length === 1 ? '' : 's'} read${lines.length === 1 ? 's' : ''} above the caller`,
            lines,
          });
      }
      /* Each segment and what it costs where it is named: its own columns, a join per reference it reads
         through, or a subquery per row for a rollup. Listed, never a warning: the cost is the query's. */
      if (design && schema) {
        const stated = withRollups(loaded.app, schema);
        const lines = Object.entries(loaded.app.resources ?? {}).flatMap(([resource, block]) => {
          const table = tableNamed(stated, block.physical ?? resource);
          return Object.entries(block.segments ?? {}).map(
            ([name, segment]) =>
              `${`${resource}.${name}`.padEnd(28)}  ${(table ? (segmentCost(stated, table.id, name) ?? 'unread') : 'unread').padEnd(8)}  ${segment.query}`,
          );
        });
        if (lines.length)
          steps.push({
            name: 'segments',
            status: 'passed',
            detail: `${lines.length} segment${lines.length === 1 ? '' : 's'}`,
            lines,
          });
      }
      /* Every convention the platform applies, per resource: what `restated` measures against, made visible. */
      if (defaults) {
        if (!schema) steps.push({ name: 'defaults', status: 'skipped', detail: why, lines: [] });
        else {
          const stated = withRollups(loaded.app, schema);
          const rows = inferredReport(loaded.app, stated);
          const forms = Object.entries(loaded.app.resources ?? {}).flatMap(([resource]) => {
            const table = tableNamed(stated, resource);
            return Object.entries(table ? inferredFormDefaults(table) : {}).map(([column, value]) => ({ resource, column, value }));
          });
          /* Each screen page's layout: the one its sections make where it names none (pageLayouts.ts), and why. */
          const layouts = loaded.pages
            .filter((page) => !page.document)
            .map((page) => {
              const written = page.layout !== undefined && page.layoutWhy === undefined;
              const chosen = written ? undefined : page.layout ? { layout: page.layout, why: page.layoutWhy! } : chooseLayout(page);
              return { name: `page ${page.id}`, layout: page.layout ?? chosen!.layout, why: chosen?.why, written };
            });
          const chosen = layouts.filter((row) => !row.written).length;
          const width = Math.max(
            0,
            ...rows.map((row) => `${row.resource}.${row.column}`.length),
            ...forms.map((row) => `${row.resource}.${row.column}`.length),
            ...layouts.map((row) => row.name.length),
          );
          steps.push({
            name: 'defaults',
            status: 'passed',
            detail: `${rows.length} display rule${rows.length === 1 ? '' : 's'}, ${forms.length} form default${forms.length === 1 ? '' : 's'} and ${chosen} page layout${chosen === 1 ? '' : 's'} inferred`,
            lines: [
              ...rows.map(
                (row) =>
                  `${`${row.resource}.${row.column}`.padEnd(width)}  ${JSON.stringify(row.rule)}  ${row.why}${row.overridden ? ' (the App says its own)' : ''}`,
              ),
              ...forms.map(
                (row) =>
                  `${`${row.resource}.${row.column}`.padEnd(width)}  form default ${JSON.stringify(row.value)}  the schema's DEFAULT`,
              ),
              ...layouts.map(
                (row) => `${row.name.padEnd(width)}  layout '${row.layout}'  ${row.written ? 'the App says its own' : row.why}`,
              ),
            ],
          });
        }
      }
      if (design) {
        if (!schema) steps.push({ name: 'design', status: 'skipped', detail: why, lines: [] });
        else {
          const findings = designLint(loaded.app, loaded.pages, schema);
          const where = (at: string): string | undefined => {
            const m = /^(page|view|resource) "([^"]+)"/.exec(at);
            return m
              ? `${{ page: 'pages', view: 'views', resource: 'resources' }[m[1] as 'page']}.${m[2]}`
              : at === 'the shell'
                ? 'ui.shell'
                : undefined;
          };
          const warned = findings.map((finding) => {
            const file = finding.page ? loaded!.sources[finding.page] : undefined;
            const path = where(finding.at);
            const [said, fix] = finding.text.split(' → ');
            return problem(
              'design',
              finding.code,
              said,
              { file: shown(file ?? loaded!.path), ...(path ? { path } : {}), ...(fix ? { fix } : {}) },
              'warning',
            );
          });
          steps.push({
            name: 'design',
            status: failOnDesignWarning && findings.length ? 'failed' : 'passed',
            detail: findings.length ? `${findings.length} warning${findings.length === 1 ? '' : 's'}` : 'nothing to say',
            problems: warned,
            /* A page's findings name the file that defines it; the words
               alone would send the locator to whichever line shares most of them. */
            lines: findings.map((finding) => {
              // The manifest is every imported module's "source"; only a pages/ file is a place.
              const file = finding.page ? loaded!.sources[finding.page] : undefined;
              if (file === loaded!.path) return `warning: ${sayDesignFinding(finding)}`;
              return `${file ? `${shown(file)}  ` : ''}warning: ${sayDesignFinding(finding)}`;
            }),
          });
        }
      }
    }

    if (deploy) {
      if (!loaded)
        steps.push({ name: 'deploy', status: 'skipped', detail: 'the App did not load, so there is nothing to judge', lines: [] });
      else {
        const pools = postgresPoolFlags(opts);
        const deployInput = {
          app: loaded.app,
          connections: registry.configs(),
          activeId: registry.active ?? undefined,
          cache: registry.serviceConfigs().some((service) => service.kind === 'cache'),
          ...(replicas !== undefined ? { replicas } : {}),
          ...(connectionLimit !== undefined ? { connectionLimit } : {}),
          ...(cpus !== undefined ? { cpus } : {}),
          served: await servedFactsOf(loaded.app, loaded.commands?.registry, opts.jobs),
          ...(typeof pools === 'string' ? {} : { pools: { readers: pools.readers, writers: pools.writers } }),
          env: process.env,
        };
        const budget = connectionBudgets(deployInput);
        const findings = [...deployFindings(deployInput), ...budget.findings];
        const errors = findings.filter((finding) => finding.severity === 'error');
        steps.push({
          name: 'deploy',
          status: errors.length ? 'failed' : 'passed',
          detail: errors.length
            ? `${errors.length} thing${errors.length === 1 ? '' : 's'} that would not survive a replaced container`
            : 'every store is a network database and the secrets are set',
          lines: [
            ...budget.rows.map((row) => `connections ${sayBudget(row)}`),
            ...findings.map((finding) => `${finding.severity === 'warning' ? 'warning: ' : ''}${finding.message} Fix: ${finding.fix}`),
          ],
          problems: findings.map((finding) =>
            problem('deploy', finding.code, finding.message, { fix: finding.fix, file: shown(loaded!.path) }, finding.severity),
          ),
        });
      }
    }

    const width = Math.max(...steps.map((step) => step.name.length));
    /* Errors first, warnings after them: a failing App printed its two real problems among ~60 warnings, most of
       them the same sentence about a rule the platform infers anyway. A step's errors stay under its verdict; the
       warnings are a summary line a kind unless --warnings asks for them, and then follow the errors. */
    const warned = new Map<string, number>();
    let iconsNamed = false;
    for (const step of steps) {
      write(`  ${step.name.padEnd(width)}  ${step.status.padEnd(7)} ${step.detail}`);
      const { errors, warnings } = splitWarnings(step.lines);
      for (const line of errors) {
        if (ICON_LIST_TAIL.test(line)) iconsNamed = true;
        write(`  ${' '.repeat(width)}  ${' '.repeat(7)} ${line.replace(ICON_LIST_TAIL, '')}`);
      }
      for (const line of warnings) {
        if (ICON_LIST_TAIL.test(line)) iconsNamed = true;
        if (showWarnings) write(`  ${' '.repeat(width)}  ${' '.repeat(7)} ${line.replace(ICON_LIST_TAIL, '')}`);
        else warned.set(warningKind(line), (warned.get(warningKind(line)) ?? 0) + 1);
      }
    }
    if (iconsNamed) write(`  ${iconListLine()}`);
    if (warned.size) write(`  ${warningSummary(warned)}`);
    /* The Preview features the App uses: one line, not a step's, since it fails nothing (the finding is info). */
    const previewed = steps.flatMap((step) => step.problems ?? []).find((found) => found.code === PREVIEW_FEATURE);
    if (previewed) write(`  preview: ${previewed.message}`);
    const failed = steps.find((step) => step.status === 'failed');
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const code = !failed
      ? CHECK_EXIT.passed
      : failed.name === 'pending'
        ? CHECK_EXIT.pending
        : failed.name === 'schema types'
          ? CHECK_EXIT.types
          : failed.name === 'typecheck'
            ? CHECK_EXIT.typecheck
            : failed.name === 'components'
              ? CHECK_EXIT.components
              : failed.name === 'deploy'
                ? CHECK_EXIT.deploy
                : CHECK_EXIT.validation;
    const passed = steps.filter((step) => step.status === 'passed').length;
    write(
      failed
        ? `${steps
            .filter((step) => step.status === 'failed')
            .map((step) => step.name)
            .join(' and ')} failed (${passed} of ${steps.length} passed) in ${seconds}s. Exit ${code}.`
        : `Checked in ${seconds}s: ${passed} of ${steps.length} steps passed${passed < steps.length ? ', the rest skipped as said' : ''}.`,
    );
    /* A failed step that found nothing it could place still fails with one problem: its verdict. */
    const problems = steps.flatMap((step) =>
      step.problems?.length || step.status !== 'failed' || step.name === 'themes'
        ? (step.problems ?? [])
        : [
            problem(
              step.name,
              step.name === 'validation' ? 'invalid-app' : step.name === 'typecheck' ? 'typecheck' : step.name.replace(' ', '-'),
              step.detail,
            ),
          ],
    );
    emit?.({
      version: 1,
      app: named ? { id: named.app.id, name: named.app.name } : null,
      dir: shown(appDir),
      ok: !failed,
      exit: code,
      seconds: Number(seconds),
      steps: steps.map((step) => ({ step: step.name, status: step.status, detail: step.detail })),
      problems,
      ...(routeTableSaid ? { routes: routeTableSaid } : {}),
    });
    return code;
  } finally {
    console.log = log;
    await registry.closeAll();
    await copy?.cleanup();
  }
}

/**
 * The route table `--routes` prints. A tenant App's addresses carry their
 * context after the App's own parameters (client tenantLink.ts): a tenant's
 * `tenant=`, the platform realm's `realm=platform`, each realm with the rooms
 * its own context is served.
 */
export function checkedRoutes(loaded: LoadedApp, schema: DatabaseSchema, mount: AddressMount): Array<{ path: string; what: string }> {
  const app = appHome(mount, loaded.app.id);
  if (!isTenantApp(loaded.app)) {
    const whole = routeTable(appRoutes(loaded, schema), app);
    /* A record's address is the first view showing its table among the views
       the person is served: a role served other views may say a record
       elsewhere (a resident's repair at /my-requests/12, the office's at
       /repairs/12). One line per role whose address differs. */
    const known = new Set(whole.map((row) => row.path));
    const rows = [
      ...whole,
      ...Object.keys(loaded.app.auth?.roles ?? {}).flatMap((role) =>
        routeTable(appRoutes(loaded, schema, undefined, [role]), app)
          .filter((row) => row.what.startsWith('one record of') && !known.has(row.path))
          .map((row) => ({ path: row.path, what: `${row.what}, as the role "${role}" opens it` })),
      ),
    ];
    const open = loaded.app.auth?.public?.read;
    if (!open) return rows;
    /* A signed-out visitor is served fewer views, so a record may be
       addressed under a different list for them (the first they can open):
       those addresses too, as the sitemap and a public page's canonical
       link say them (http/sitemap.ts, http/publicHead.ts). */
    const said = new Set(rows.map((row) => row.path));
    const visitor = routeTable(
      appRoutes(
        { ...loaded, app: appForRoles(loaded.app, []), pages: pagesForRoles(loaded.pages, [], loaded.app.auth) },
        { ...schema, tables: schema.tables.filter((table) => open.includes(table.id)) },
      ),
      app,
    );
    return [
      ...rows,
      ...visitor
        .filter((row) => !said.has(row.path))
        .map((row) => ({ path: row.path, what: `${row.what}, as a signed-out visitor opens it` })),
    ];
  }
  const qualified = (rows: Array<{ path: string; what: string }>, selector: string) =>
    rows.map((row) => ({ path: `${row.path}${row.path.includes('?') ? '&' : '?'}${selector}`, what: row.what }));
  const tenant = qualified(routeTable(appRoutes(loaded, schema, 'tenant'), app), 'tenant={tenant}');
  if (!appRealms(loaded.app).platform) return tenant;
  return [...tenant, ...qualified(routeTable(appRoutes(loaded, schema, 'platform'), app), 'realm=platform')];
}

/**
 * Every read a command makes under its own authority rather than its
 * caller's (`elevate`), as `check --design` lists them: which tables, and
 * which roles granted the command would not read them otherwise.
 */
export function commandElevations(app: AppDef, commands: BusinessCommandRegistry, schema: DatabaseSchema | undefined): string[] {
  return Object.entries(commands)
    .filter(([, command]) => command.elevate?.read.length)
    .map(([id, command]) => {
      const tables = command.elevate!.read.map((local) => logicalResource(app, command.source, local));
      const roles = Object.keys(app.auth?.roles ?? {}).filter((role) => appCommandGrants(app, [role]).has(id));
      const blind = schema
        ? roles.filter((role) => {
            try {
              const readable = resolveAppAccess(app, schema, [role]).readable;
              return tables.some((table) => !readable.has(table));
            } catch {
              return false;
            }
          })
        : [];
      return (
        `command "${id}" reads ${tables.map((table) => `"${table}"`).join(', ')} under its own authority` +
        (blind.length ? `, for role${blind.length === 1 ? '' : 's'} ${blind.map((role) => `"${role}"`).join(', ')}` : '')
      );
    });
}

/** What the App and its jobs module declare that makes a served App build more hosts (servedHosts.ts). */
async function servedFactsOf(
  app: AppDef,
  commands: BusinessCommandRegistry | undefined,
  jobsFile: string | undefined,
): Promise<ServedFacts> {
  const { getCommandEffects } = await import('../commands/businessCommands.js');
  const facts: ServedFacts = {
    tenant: app.auth?.rows === 'tenant',
    assistant: app.assistant !== undefined,
    apiEvents: Boolean(app.api?.events?.length),
    effects: Object.values(commands ?? {}).some((command) => getCommandEffects(command)),
  };
  if (jobsFile === undefined) return facts;
  try {
    const { loadJobModule } = await import('../jobs/jobLoader.js');
    const module = await loadJobModule(jobsFile);
    return {
      ...facts,
      jobs: module.jobs.size + module.workflows.size > 0,
      decisions: (module.decisions?.size ?? 0) > 0,
      integrations: module.integrations !== undefined,
      inbound: module.inbound.size > 0,
    };
  } catch {
    // A jobs module that does not load is the validation step's to say; the sum then counts without it.
    return facts;
  }
}
