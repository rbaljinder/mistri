/**
 * Loading an app from disk, and answering for it.
 *
 * This file is the whole server side of the app layer. The core hands it a
 * path at startup and a connection at request time; everything in between —
 * the manifest grammar, the page grammar — is shared machinery reused
 * verbatim. That boundary is the design (docs/apps.md): the core stays a
 * database browser, and an app composes it rather than growing into it.
 */
import { zoneColumnProblem } from './readerZone.js';
import { localeColumnProblem } from './readerLocale.js';
import { unionProblems } from '../../shared/appUnions.js';
import { readFile, readdir, stat } from 'node:fs/promises';
import { realpathSync, statSync, watch, type FSWatcher } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import type { WriteWording } from '@mistriwork/engine/server/http/writeRefusal.js';
import {
  appFileRules,
  appTagRules,
  appTransitionRules,
  appCeilingWarnings,
  grantsByRole,
  writeScopeRefusal,
  orderAppPages,
  parseAppConfig,
  parseAppPage,
  parseAppPages,
  listFilterProblems,
  resolveAppAccess,
  resolveDisplay,
  resolveResources,
  resolveViews,
  viewOrder,
  signInOf,
  sourceScopeOf,
  type AppDef,
  type AppDashSection,
  appCatalog,
  appRollupRules,
} from '../../shared/app.js';
import { resolveValidation, resourceValidation } from '../../shared/app.js';
import { compileAppDefinitionValidation } from './appValidation.js';
import { compileAppStamps } from './appStamps.js';
import { cardsProblem } from '@mistriwork/engine/shared/appCards.js';
import { missingAppImports, missingImportsMessage } from './appImports.js';
import { servedApp, type AppPayload, type AppPayloadApp } from '../../shared/appPayload.js';
import { appAddressBook, naturalKeyProblems, type AddressBook } from '../../shared/appAddress.js';
import { appSurfaceForRealm } from '../../shared/appTenancy.js';
import { appForRoles, pagesForRoles } from '../../shared/appViewRoles.js';
import { appThemeWarnings } from '@mistriwork/engine/shared/theme.js';
import { readAppFonts, type AppFonts } from './appFonts.js';
import { readAppBrand, type AppBrand } from './appBrand.js';
import { checkThemeWithFixes, type FixedThemeProblem } from '../../shared/themeFix.js';
import { validatePage, type PageDef } from '@mistriwork/engine/shared/page.js';
import type { PageFields } from '@mistriwork/engine/shared/pageModel.js';
import { publicPrefillProblems } from '../forms/publicPrefill.js';
import {
  CONNECTION_HIDDEN,
  columnKind,
  findTable,
  isFlagColumn,
  isJsonType,
  tableNamed,
  type DatabaseSchema,
} from '@mistriwork/engine/shared/schema.js';
import { ANYONE, parseQuery } from '@mistriwork/engine/shared/query.js';
import { bindRecordBranding, type BrandingBinding, type BrandingCatalog, type BrandingColumnKind } from '../../shared/branding.js';
import { appComputedRules } from '../../shared/appComputed.js';
import { formLinesProblems } from '../../shared/formLines.js';
import { composeFeatures, type AppOrigins } from '../../shared/appFeatures.js';
import { locateProblem, withProvenance } from '../../shared/appProvenance.js';
import { appLiteralWarnings, appMenuWarnings, appReachWarnings, appRestatedWarnings } from '../../shared/appWarnings.js';
import { deprecatedOf } from '../../shared/deprecations.js';
import {
  AUTHORITY_CHANGED,
  AUTHORITY_LOCK,
  assertAuthorityLock,
  authorityChange,
  readAuthority,
  type AppAuthority,
} from './authorityLock.js';
import { withCommandCatalog } from '../../shared/command.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import type { AppEnvName } from '../../shared/appAuthority.js';
import { assertAppApiContext, readApiApp } from '../api/appApiValidation.js';
import { BUILD_MANIFEST, loadBuiltApp, type AppBuildInfo } from './appBuild.js';
import { iconGlyphsIn } from './iconPayload.js';
import { accessibleSchema } from './appAccess.js';
import { isTenantApp, type AppRealm } from '../../shared/appModel.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { appUsesCommands, appUsesCommandsOfItsOwn } from '../../shared/appCommandIds.js';
import { appComponents } from '../../shared/appComponentPlaces.js';
import { machineChecks } from './appMachineChecks.js';
import { segmentProblems, servedSegments } from '../../shared/appSegments.js';
import { appConsumesRules } from '../../shared/appConsumes.js';
import { withMachineSteppers } from '../../shared/appMachine.js';
import { tabSlug } from '@mistriwork/engine/shared/addressParams.js';
import { isMessageRef } from '@mistriwork/engine/shared/appMessages.js';
import { appNotifyRules, notifyAdvisories } from '../../shared/appNotify.js';
import { compileComponents, componentHrefs, type CompiledComponents } from './appComponents.js';
import { pageFiles, placePages, readPageFiles } from './appPages.js';
import { valueLabelFindings, valueLabelHolder } from './valueLabels.js';
import { embeddedOnlyViews } from '@mistriwork/engine/shared/appEmbeds.js';
import { homeViews } from '../../shared/appHome.js';
import {
  catalogFiles,
  holdLocalizer,
  languageOf,
  localizeDefinition,
  countedLabels,
  localizerOf,
  MessageSayer,
  messageAdvisories,
  messageArgProblems,
  readCatalogs,
  type AppCatalogs,
  type MessageOverrides,
} from './appMessages.js';
import { checkPageLoaders } from './pageLoaderCheck.js';
import type { PageLoader } from '../commands/pageLoaders.js';
import { namedChallenge, type HumanCheck } from '../commands/challenges.js';

/**
 * Import a module graph in a throwaway worker and hand back its default
 * export. The worker's whole value is its fresh module cache — see the
 * call site. A config that cannot structured-clone (a function smuggled
 * into the manifest) fails here with the honest reason.
 */
function importFresh(
  href: string,
  env: readonly AppEnvName[] = [],
  roots: readonly string[] = [],
  /** Where the files this import loaded are added: its module graph, as the module loader resolved it. */
  graph?: Set<string>,
): Promise<unknown> {
  const names = env.map(({ name }) => name);
  return new Promise((resolveValue, reject) => {
    const worker = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads');
       /* A name mistri.json does not pass is a mistake to say, not an
          undefined to build on: \`process.env.REGION ?? 'us'\` quietly
          served 'us' everywhere. Said only to the App's own modules — the
          reader is the frame under this one — because a loader hook or a
          package reads variables of its own and expects undefined. Node's
          own names (NODE_ENV) read as they are; \`'X' in process.env\` asks
          without throwing. */
       const passed = new Set(workerData.names);
       const real = (root) => { try { return require('node:fs').realpathSync(root); } catch { return root; } };
       const roots = workerData.roots.flatMap((root) => [root, real(root)]).flatMap((root) => [root, require('node:url').pathToFileURL(root).href]);
       const own = () => {
         const caller = (new Error().stack || '').split('\\n')[3] || '';
         return !caller.includes('/node_modules/') && roots.some((root) => caller.includes(root));
       };
       /* The files this import loads, as the loader resolves them: what a watcher reloads for (watchApp). A loader
          that will not take the hook leaves the graph empty, and the watcher then falls back to file types. */
       const seen = new Set();
       try {
         require('node:module').registerHooks({ resolve(specifier, context, next) {
           const out = next(specifier, context);
           if (out.url.startsWith('file:') && !out.url.includes('/node_modules/')) seen.add(out.url);
           return out;
         } });
       } catch {}
       const env = process.env;
       Object.defineProperty(process, 'env', { configurable: true, enumerable: true, writable: true, value: new Proxy(env, {
         get(target, key, receiver) {
           if (typeof key !== 'string' || passed.has(key) || key.startsWith('NODE_') || Object.hasOwn(target, key) || !own()) return Reflect.get(target, key, receiver);
           throw new Error('the App\\'s definition read process.env.' + key + ', which mistri.json does not pass to it. '
             + 'List it in the App\\'s entry, "apps": [{ "dir": "<the App>", "env": ["' + key + '"] }], or ask first with "' + key + '" in process.env. '
             + 'See \`mistri docs secrets\`.');
         },
       }) });
       import(workerData.href).then(
         (mod) => { try { parentPort.postMessage({ ok: true, value: mod.default, files: [...seen] }); } catch (err) {
           parentPort.postMessage({ ok: false, message: 'the app must be plain data — ' + err.message });
         } },
         (err) => parentPort.postMessage({ ok: false, message: String((err && err.message) || err), stack: String((err && err.stack) || '') }),
       );`,
      /* The environment mistri.json passes, and nothing else. The worker
         is isolation, not a sandbox: an app.mjs has all of Node — fs, net,
         child_process — and hot reload means whoever can write the app
         directory runs code in this process on save. That is the contract of
         config-as-code and it is stated in the docs. What the worker does
         *not* need is the server's environment, which is where
         `${PROD_PASSWORD}` lives; a manifest is data, and what it reads of the
         environment ends up in what the browser is sent, so it is handed only
         the names the operator listed (`apps[].env`, recorded in
         authority.lock). */
      {
        eval: true,
        workerData: { href, names, roots },
        env: Object.fromEntries(names.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]!])),
      },
    );
    const collect = (files: string[] = []) => {
      for (const url of files) graph?.add(fileURLToPath(url));
    };
    const done = (fn: () => void) => {
      void worker.terminate();
      fn();
    };
    /* The stack crosses too: where a throw or a syntax error was written is
       in it, and a save that did not load is placed from it (appLive.ts). */
    worker.once('message', (m: { ok: boolean; value?: unknown; files?: string[]; message?: string; stack?: string }) =>
      done(() =>
        m.ok ? (collect(m.files), resolveValue(m.value)) : reject(Object.assign(new Error(m.message), m.stack ? { stack: m.stack } : {})),
      ),
    );
    worker.once('error', (err) => done(() => reject(err)));
    /* An app file that never answers (a top-level await on nothing) must
       not hang the server's own startup. */
    const timer = setTimeout(() => done(() => reject(new Error('the app module did not finish loading within 10s'))), 10_000);
    timer.unref();
  });
}

export interface LoadedApp {
  /** The manifest file actually read, for error messages and logs. */
  path: string;
  /**
   * The app directory, when the app was loaded from one — what a reload and
   * a watcher must be pointed at, so `pages/` comes along. Deriving it from
   * the manifest's extension is how `.ts` apps lost their pages on the first
   * save: the ternary knew `.json` and `.mjs`.
   */
  dir?: string;
  app: AppDef;
  pages: PageDef[];
  /** Which file defined each page (by id) — the manifest, or a pages/ file. */
  sources: Record<string, string>;
  /** What the App grants now, and its authority.lock (authorityLock.ts). */
  authority?: AppAuthority;
  /** Who contributed what, when the App lists features: its refusals and problems name the feature. */
  origins?: AppOrigins;
  /** Set when the App was served from a `mistri build` output (appBuild.ts): never watched, never reloaded. */
  build?: AppBuildInfo;
  /** Its custom components, compiled (appComponents.ts): absent when it declares none. */
  components?: CompiledComponents;
  /** The manifest --app-entry named inside or beside `dir`, which a reload reads again instead of probing. */
  entry?: string;
  /** The environment names mistri.json passes its definition (`apps[].env`), which a reload passes again. */
  env?: readonly AppEnvName[];
  /** Its commands module, when it has one: `--commands`, or commands.ts beside the manifest. Each command at the
      version its contract holds in authority.lock; the App's command names were resolved from it. */
  commands?: { file: string; registry: BusinessCommandRegistry };
  /** Its free-form pages' loaders, by name: the commands module's `loaders` export (commands/pageLoaders.ts). */
  loaders?: Readonly<Record<string, PageLoader>>;
  /** Its human checks, by name: the commands module's `challenges` export, one of which `auth.challenge` names
      (commands/challenges.ts). */
  challenges?: Readonly<Record<string, HumanCheck>>;
  /** Its page modules, from the App directory (`pages/<path>.page.tsx`, `pages/<key>.ts`): what check typechecks. */
  pageFiles?: string[];
  /** Its catalogs' files, from the App directory (`messages/<locale>.ts`): what check typechecks. */
  messageFiles?: string[];
  /** Its themes' font files (`type.faces`), read from the App directory and served at `/{app}/_fonts/` (appFonts.ts). */
  fonts?: AppFonts;
  /** Its logo's pictures (`ui.logo: { src, dark, mark }`), read from the App directory and served at `/{app}/_brand/`
      (appBrand.ts). */
  brand?: AppBrand;
  /** The files its definition, pages and catalogs loaded, as the module loader resolved them (absolute paths, no
      packages): what a watcher reloads for beside the files it names. Absent where the loader did not say. */
  modules?: string[];
}

/**
 * Every key a loaded App has, for the tenant start, which takes an App only
 * by keys it names (evidence.ts tenantOptions). One list the compiler holds
 * to the interface: `pageFiles`, then `fonts`, each grew on LoadedApp alone
 * and stopped every tenant start with only "the tenant context could not be
 * verified".
 */
export const LOADED_APP_KEYS = [
  'path',
  'dir',
  'app',
  'pages',
  'sources',
  'authority',
  'origins',
  'build',
  'components',
  'entry',
  'env',
  'commands',
  'loaders',
  'challenges',
  'pageFiles',
  'messageFiles',
  'fonts',
  'brand',
  'modules',
] as const satisfies readonly (keyof LoadedApp)[];
/* A key added to LoadedApp and not above fails to compile here. */
const everyLoadedAppKey: Exclude<keyof LoadedApp, (typeof LOADED_APP_KEYS)[number]> extends never ? true : never = true;
void everyLoadedAppKey;

/** The commands module an App keeps beside its manifest, when `--commands` names none. */
function besideCommands(home: string): string | undefined {
  return ['commands.ts', 'commands.mjs', 'commands.js']
    .map((name) => join(home, name))
    .find((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
}

/**
 * The App's commands, read before its definition is parsed: the App names
 * them, and each name is resolved from the registration (shared/command.ts).
 * Versions come from the lock's contract lines (commandContracts.ts).
 */
async function loadAppCommands(
  given: string | BusinessCommandRegistry | undefined,
  home: string,
): Promise<(LoadedApp['commands'] & { loaders?: LoadedApp['loaders']; challenges?: LoadedApp['challenges'] }) | undefined> {
  if (!given) return undefined;
  const [{ loadBusinessCommands }, { defineCommands, withCommandVersions }, { lockedVersion }] = await Promise.all([
    import('../commands/businessCommandLoader.js'),
    import('../commands/businessCommands.js'),
    import('../commands/commandContracts.js'),
  ]);
  const lock = await readFile(join(home, AUTHORITY_LOCK), 'utf8').catch(() => undefined);
  const registry = typeof given === 'string' ? await loadBusinessCommands(given) : defineCommands(given);
  /* Its pages' loaders, beside its registry in the same module (the import is the one loadBusinessCommands made). */
  const loaders =
    typeof given === 'string'
      ? (await import('../commands/pageLoaders.js')).pageLoadersOf(await import(pathToFileURL(resolve(given)).href), basename(given))
      : undefined;
  /* And its human checks, from the same module (commands/challenges.ts). */
  const challenges =
    typeof given === 'string'
      ? (await import('../commands/challenges.js')).challengesOf(await import(pathToFileURL(resolve(given)).href), basename(given))
      : undefined;
  return {
    file: typeof given === 'string' ? resolve(given) : '',
    registry: withCommandVersions(registry, lockedVersion(lock)),
    ...(loaders ? { loaders } : {}),
    ...(challenges ? { challenges } : {}),
  };
}

/**
 * Read an app: a directory holding an app.json, or the file itself. Throws
 * on anything wrong, with the path named — an app that silently did not
 * load is a bug report that starts "I definitely wrote it".
 *
 * A directory may also carry a `pages/` folder, one page per `.json` file
 * (the same shape as one entry of a `pages` array). Files are the shape an
 * app grows in: a page per file diffs, reviews, and gets written by an
 * agent without the manifest churning. Read in name order, so load order
 * is a property of the directory rather than of the filesystem's mood.
 *
 * An App whose effective authority differs from its authority.lock does not
 * load, unless `lock: 'report'` asks for it — mistri check, which names the
 * difference and is the one place a lock is rewritten.
 *
 * A directory holding mistri-build.json is a build, and is read as one
 * (appBuild.ts): the compiled definition, no module evaluated. `module`
 * evaluates that module instead of the manifest, everything else still read
 * from the directory — how `mistri build` proves its bundled definition
 * is the same App as its source.
 */
export async function loadApp(
  target: string,
  options: {
    lock?: 'enforce' | 'report';
    module?: string;
    /** The manifest, when it is not the directory's one app.ts / app.mjs / app.json (--app-entry). */
    entry?: string;
    /** What the definition may read of the environment (mistri.json's `apps[].env`). */
    env?: readonly AppEnvName[];
    /** Its commands module (`--commands`), or a registry already loaded (a test's, an embedding's); absent,
      commands.ts beside the manifest when there is one. */
    commands?: string | BusinessCommandRegistry;
    /** Handed what the definition is parsed from, before any msg() is said: `mistri messages extract` reads its literal captions. */
    definition?: (input: DefinitionInput) => void;
  } = {},
): Promise<LoadedApp> {
  let path = target;
  let dir: string | undefined;
  let built = false;
  try {
    const info = await stat(target);
    /* A world-writable app directory is code execution for every account on
       the machine: hot reload evaluates whatever lands in it. Refused with
       the fix, since the fix is one chmod. Windows reports no such bit. */
    if (process.platform !== 'win32' && (info.mode & 0o002) !== 0) {
      throw new Error(
        `${target} is writable by everyone (mode ${(info.mode & 0o777).toString(8)}). An app directory is ` +
          'evaluated as code on every reload, so it must not be: chmod o-w it first.',
      );
    }
    if (
      info.isDirectory() &&
      (await stat(join(target, BUILD_MANIFEST)).then(
        () => true,
        () => false,
      ))
    ) {
      built = true;
    } else if (info.isDirectory() && options.entry !== undefined) {
      /* --app-entry: the manifest is named, and the directory stays the App's
         root — its components, pages/, features/ and authority.lock — so an
         entry kept elsewhere (a generated one, a monorepo's src/) loses none
         of them. The manifest is not bound by the component boundary. */
      dir = target;
      path = resolve(options.entry);
      const entry = await stat(path).catch(() => undefined);
      if (!entry?.isFile() || !['.ts', '.mjs', '.json'].includes(extname(path))) {
        throw new Error(`--app-entry ${options.entry} is not a .ts, .mjs or .json file to read as the manifest.`);
      }
    } else if (options.entry !== undefined) {
      throw new Error(`--app-entry needs --app to name the App's directory; ${target} is a file.`);
    } else if (info.isDirectory()) {
      dir = target;
      /* JSON is the canonical format; app.mjs and app.ts are the typed
         veneer for hands that want an editor's help — .ts runs on Node's
         own type stripping (erasable syntax), which the engines floor
         guarantees. A directory holding more than one manifest is
         refusing to say which is true, so it is refused, all names
         spoken. */
      const present = [];
      for (const name of ['app.json', 'app.mjs', 'app.ts']) {
        if (
          await stat(join(target, name)).then(
            () => true,
            () => false,
          )
        )
          present.push(name);
      }
      if (present.length > 1) {
        throw new Error(`${target} has ${present.join(' and ')} — keep one; the others are stale copies waiting to win.`);
      }
      if (!present.length) throw new Error(`${target} has no app.json (or app.mjs / app.ts).`);
      path = join(target, present[0]);
    }
  } catch (err) {
    /* Only a *missing* target is rewritten as "does not exist"; every other
       refusal above already names its reason. Matching on the text `app.json`
       used to decide this, so "has app.mjs and app.ts — keep one" fell
       through to "does not exist" and sent the author looking for a missing
       directory. */
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${target} does not exist.`);
    throw err;
  }
  // Outside the try above: a build's own missing file is its message, not "does not exist".
  if (built) return loadBuiltApp(target, options);
  let raw: unknown;
  const graph = new Set<string>();
  if (path.endsWith('.mjs') || path.endsWith('.ts')) {
    /* Before anything is evaluated: a removed helper stops the load at the first one Node meets, so an App
       upgraded across a release found its four, one reload each. All of them are said in one pass. */
    const missing = await missingAppImports(dir ?? dirname(path), [path]);
    if (missing.length) throw new Error(`${path}: ${missingImportsMessage(missing, dir ?? dirname(path))}`);
    try {
      /* Evaluated in a throwaway worker, not imported here: a worker gets
         a fresh module cache, so an app.mjs spread across files —
         `import { board } from './board.mjs'` — hot-reloads whole. A
         query-string bust could only refresh the entry file; the imports
         under it stayed the version from before the save, which is the
         one lie an authoring loop must not tell. The config crosses back
         by structured clone, which also enforces the one rule at the
         boundary: data crosses, functions cannot. */
      raw = await importFresh(
        options.module ?? pathToFileURL(path).href,
        options.env,
        [...new Set([dir ?? dirname(path), dirname(path)])],
        graph,
      );
    } catch (err) {
      throw new Error(`${path}: ${(err as Error).message}`, { cause: err });
    }
    if (!raw || typeof raw !== 'object') {
      throw new Error(`${path} must default-export the app object — export default defineApp({ ... }).`);
    }
  } else {
    try {
      raw = JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
      throw new Error(`${path}: ${(err as Error).message}`);
    }
  }
  /* Its free-form pages, each read from its file under stand-ins and written
     into the definition as the view it is (appPages.ts), so everything after
     this judges a page as it judges any view. */
  const pageList = dir ? await pageFiles(dir) : [];
  if (pageList.length) {
    try {
      raw = placePages(raw as Record<string, unknown>, await readPageFiles(dir!, pageList), path);
    } catch (err) {
      throw new Error(`${path}: ${(err as Error).message}`, { cause: err });
    }
  }
  /* Its words (appMessages.ts): messages/<locale>.ts, read in one worker as the manifest is. Every msg() is said
     before anything is parsed, in the source language here and in a reader's own where one is asked for. */
  const catalogList = dir ? await catalogFiles(dir) : [];
  let catalogs: AppCatalogs | undefined;
  try {
    catalogs = await readCatalogs(dir ?? dirname(path), catalogList, sourceLocaleOf(raw), (href) =>
      importFresh(href, options.env, [dir ?? dirname(path)], graph),
    );
  } catch (err) {
    throw new Error(`${path}: ${(err as Error).message}`, { cause: err });
  }
  const sourceSayer = catalogs && new MessageSayer(catalogs, catalogs.source);
  /* Composition and authority: features merge into one root, a refusal
     about what a feature wrote names it, and what the App then grants meets
     its authority.lock (shared/appFeatures.ts, authorityLock.ts). */
  const home = dir ?? dirname(path);
  const loadedCommands = await loadAppCommands(options.commands ?? besideCommands(home), home);
  const loaders = loadedCommands?.loaders;
  let commands: LoadedApp['commands'] = loadedCommands && { file: loadedCommands.file, registry: loadedCommands.registry };
  const { appCommandCatalog } = await import('../commands/commandContracts.js');
  const recordPages = dir ? await readFilePages(dir, (href) => importFresh(href, options.env, [dir], graph)) : { pages: [], modules: [] };
  const catalog = commands ? appCommandCatalog(commands.registry, localizeDefinition(raw, sourceSayer, path) as AppDef) : undefined;
  const definition: DefinitionInput = {
    raw: raw as Record<string, unknown>,
    path,
    ...(catalog ? { catalog } : {}),
    filePages: recordPages.pages,
  };
  options.definition?.(definition);
  const { app, pages, sources, origins } = parseDefinition(definition, sourceSayer);
  /* Where the words a value component's label gives its column are kept once the catalog is known (valueLabels.ts). */
  const labelHolder = valueLabelHolder(app);
  if (labelHolder) app.valueLabels = labelHolder;
  checkPageLoaders(app, loaders, path);
  const challenges = loadedCommands?.challenges;
  /* Asked by every public door that writes, an ordinary App's (http/formRoutes.ts) and each tenant's (tenant/tenantPublicHttp.ts). */
  namedChallenge(app.auth?.challenge, challenges, path);
  /* An API's generic create/update/delete need the command journal, not a commands module of the App's own: an App with
     none keeps the empty registry they are added to (apiGenericWrites.ts). */
  if (!commands && appUsesCommands(app) && !appUsesCommandsOfItsOwn(app)) {
    const { defineCommands } = await import('../commands/businessCommands.js');
    commands = { file: '', registry: defineCommands({}) };
  }
  const authority = await readAuthority(app, origins, dir ?? dirname(path), options.env);
  if (options.lock !== 'report') assertAuthorityLock(authority);
  // Command exposures are checked against their registry where one is hosted.
  assertAppApiContext(readApiApp(app));
  /* The components it places, each compiled from its module: a load that
     cannot compile one fails as any other problem does, the old load serving on. */
  const declared = appComponents(app, pages, path);
  let components: CompiledComponents | undefined;
  if (declared.size) {
    if (!dir)
      throw new Error(
        `${path} declares custom components; load the App from its directory, where their modules live: --app <dir>, with --app-entry ${path} to keep this manifest.`,
      );
    try {
      components = await compileComponents(dir, declared);
    } catch (err) {
      throw new Error(`${path}: ${(err as Error).message}`);
    }
  }
  /* Its themes' faces, read now so a missing file refuses the load as any other problem does (appFonts.ts). */
  const fonts = await readAppFonts(app, dir, path);
  /* Its logo's pictures, the same way: a missing or unreadable picture refuses the load (appBrand.ts). */
  const brand = await readAppBrand(app, dir, path);
  if (catalogs) {
    holdLocalizer(app, { definition, catalogs });
    /* Every catalog's words are parsed now, so a translation that breaks the definition — a key a caption cannot
       take, a windowed section whose title no longer names it — fails the load, not a reader's request. */
    for (const tag of Object.keys(catalogs.locales)) {
      if (tag === catalogs.source) continue;
      try {
        localizedApp({ app, pages }, tag);
      } catch (err) {
        throw new Error(`${path}: ${catalogs.files[tag]}: ${(err as Error).message}`, { cause: err });
      }
    }
  }
  return {
    path,
    ...(dir ? { dir } : {}),
    app,
    pages,
    sources,
    authority,
    origins,
    ...(components ? { components } : {}),
    ...(fonts ? { fonts } : {}),
    ...(brand ? { brand } : {}),
    ...(options.entry !== undefined ? { entry: path } : {}),
    ...(options.env?.length ? { env: options.env } : {}),
    ...(commands ? { commands } : {}),
    ...(loaders ? { loaders } : {}),
    ...(challenges ? { challenges } : {}),
    ...(pageList.length || recordPages.modules.length
      ? { pageFiles: [...pageList, ...recordPages.modules].sort().map((file) => join('pages', file)) }
      : {}),
    ...(catalogList.length ? { messageFiles: catalogList.map((file) => join('messages', file)) } : {}),
    ...(graph.size ? { modules: [...graph].sort() } : {}),
  };
}

/** A pages/<key>.json or pages/<key>.ts file, read: the same shape as one entry of a `pages` array. */
interface FilePage {
  key: string;
  full: string;
  raw: unknown;
}

/** What a definition is parsed from, kept so a reader's locale can parse it again (localizedApp). */
export interface DefinitionInput {
  /** The manifest's export, its free-form pages placed. */
  raw: Record<string, unknown>;
  path: string;
  /** The commands its names resolve to (commandContracts.ts). */
  catalog?: ReturnType<typeof import('../commands/commandContracts.js').appCommandCatalog>;
  filePages: readonly FilePage[];
}

/* A record page is found by its file, as a free-form page and a catalog are: pages/<key>.json, or pages/<key>.ts
   whose default export is the page (`export default page('lead', [ … ])`), keyed by the file's name. A module
   there with no default export is one the pages import (a shared section, a helper), not a page. */
const RECORD_PAGE_MODULE = /^([\w-]+)\.(ts|mts|mjs|js)$/;

/** The pages/ folder's record pages, by name, and the modules read for them. No pages/ folder is the common case, not a complaint. */
async function readFilePages(dir: string, evaluate: (href: string) => Promise<unknown>): Promise<{ pages: FilePage[]; modules: string[] }> {
  let files: string[] = [];
  try {
    files = (await readdir(join(dir, 'pages'))).sort();
  } catch {
    return { pages: [], modules: [] };
  }
  const read: FilePage[] = [];
  for (const file of files.filter((f) => f.endsWith('.json'))) {
    const full = join(dir, 'pages', file);
    try {
      read.push({ key: file.slice(0, -'.json'.length), full, raw: JSON.parse(await readFile(full, 'utf8')) });
    } catch (err) {
      throw new Error(`${full}: ${(err as Error).message}`);
    }
  }
  /* Only a module whose text has a default export is evaluated: an App whose pages/ holds modules it imports by name
     (pages/index.ts listing them) pays no worker for them. The worker still decides what the default is. */
  const modules: string[] = [];
  for (const file of files.filter((f) => RECORD_PAGE_MODULE.test(f)))
    if (/\bexport\s+default\b/.test(await readFile(join(dir, 'pages', file), 'utf8'))) modules.push(file);
  const helpers = new Set<string>();
  if (modules.length) {
    // One worker for every module, as the catalogs are read: a namespace import, so a module without a default is no error.
    const hrefs = modules.map((file) => pathToFileURL(join(dir, 'pages', file)).href);
    const entry = `data:text/javascript,${encodeURIComponent(
      `${hrefs.map((href, i) => `import * as m${i} from ${JSON.stringify(href)};`).join('\n')}\nexport default [${hrefs.map((_, i) => `m${i}.default`).join(', ')}];`,
    )}`;
    let exported: unknown[];
    try {
      exported = (await evaluate(entry)) as unknown[];
    } catch (err) {
      throw new Error(`pages/: ${(err as Error).message}`, { cause: err });
    }
    for (const [i, file] of modules.entries()) {
      if (exported[i] === undefined) helpers.add(file);
      else read.push({ key: RECORD_PAGE_MODULE.exec(file)![1], full: join(dir, 'pages', file), raw: exported[i] });
    }
  }
  return { pages: read, modules: modules.filter((file) => !helpers.has(file)) };
}

/** The App's own language, as its manifest says it: the source catalog is this one's (appMessages.ts). */
function sourceLocaleOf(raw: unknown): string {
  const ui = (raw as { ui?: { locale?: unknown } } | undefined)?.ui;
  const locale = typeof ui?.locale === 'object' && ui.locale ? (ui.locale as { default?: unknown }).default : ui?.locale;
  return typeof locale === 'string' && locale.trim() ? locale.trim() : 'en';
}

/**
 * The definition parsed, its every msg() said by `sayer`: the App, its pages
 * — the manifest's and the pages/ files', each keyed once — and which file
 * defined each. One reading for the load and for every locale after it.
 */
function parseDefinition(input: DefinitionInput, sayer: MessageSayer | undefined) {
  const { path, catalog } = input;
  const raw = localizeDefinition(input.raw, sayer, path);
  const commandCatalog =
    catalog && sayer
      ? new Map([...catalog].map(([id, entry]) => [id, localizeDefinition(entry, sayer, `${path}: commands "${id}"`)]))
      : catalog;
  const parsed = parseAppConfig(raw, path, commandCatalog ? { commands: commandCatalog } : {});
  /* A tenant's words are held to the source catalog on write and on read, wherever the definition goes (recordMessages.ts). */
  const words = parsed.ui.messages;
  if (words && !sayer)
    throw new Error(
      `${path}: [message-missing] ui.messages lets each tenant say the App's messages its own way, and the App has no messages/ catalogs to override.`,
    );
  const said: AppDef =
    words && sayer
      ? {
          ...parsed,
          ui: {
            ...parsed.ui,
            messages: Object.freeze({
              ...words,
              /* Plain, so a build's app.json can hold it (appBuild.ts); every key is dotted, so none is a prototype's. */
              source: Object.freeze({
                locale: sayer.catalogs.source,
                entries: Object.freeze({ ...sayer.catalogs.locales[sayer.catalogs.source] }),
              }),
            }),
          },
        }
      : parsed;
  const app = sayer ? withCountedLabels(said, countedLabels(input.raw, sayer)) : said;
  const composed = withCommandCatalog(commandCatalog, () => composeFeatures(raw, path));
  const root = composed.root;
  /* An app scoped to a connection scopes its pages with it: a page that
     does not name one means "this app's connection", not "every connection
     the server knows". A page that names its own stays as written. */
  const scope = (p: PageDef): PageDef => (p.connection || !app.connection ? p : { ...p, connection: app.connection });
  const pages = parseAppPages(root, path).map(scope);
  const owner = new Map(pages.map((p) => [p.id, path]));
  for (const { key, full, raw: rawPage } of input.filePages) {
    /* The file's basename is the page's key, as `pages.<key>` is inline. */
    const already = owner.get(key);
    if (already) {
      const feature = composed.origins.pages[key];
      throw new Error(
        feature
          ? `${full}: the page "${key}" is already declared by features "${feature}" (${already}). A page is keyed once: in the App, in a feature, or as a pages/ file.`
          : `${full}: the page "${key}" is already declared in ${already}. A page is keyed once — inline or as a pages/ file.`,
      );
    }
    const page = scope(parseAppPage(localizeDefinition(rawPage, sayer, full), key, full, sourceScopeOf(root)));
    owner.set(page.id, full);
    pages.push(page);
  }
  /* A page over a resource with a machine draws its stepper from the graph (appMachine.ts). */
  const stepped = withMachineSteppers(pages, (base) => {
    const resource = app.resources?.[base];
    if (!resource?.machine) return undefined;
    const rule = resource.display?.[resource.machine.column] as { values?: unknown } | undefined;
    return {
      machine: resource.machine,
      ...(rule?.values && typeof rule.values === 'object' ? { words: rule.values as Record<string, string> } : {}),
    };
  });
  return {
    app,
    pages: withProvenance(composed.origins, path, () => orderAppPages(app, stepped, path)),
    sources: Object.fromEntries(owner),
    origins: composed.origins,
  };
}

/**
 * The resources' actions with each counting label's parsed message beside its
 * words (`counted`, appMessages.ts countedLabels): set by the server, never
 * authored, and read by the browser only for a selection.
 */
function withCountedLabels(app: AppDef, counted: ReturnType<typeof countedLabels>): AppDef {
  if (!counted.size || !app.resources) return app;
  const resources = { ...app.resources };
  for (const [name, places] of counted) {
    const resource = resources[name];
    if (!resource?.actions) continue;
    resources[name] = {
      ...resource,
      actions: resource.actions.map((action) => (places.has(action.id) ? { ...action, counted: places.get(action.id) } : action)),
    };
  }
  return { ...app, resources };
}

/* ---------- a definition in a reader's language ---------- */

/**
 * The App as one reader reads it: every caption in their locale, and a
 * tenant's own words over the App's. The load itself where the App has no
 * catalogs, or the locale says the source's words with nothing overridden.
 * Each (locale, tenant words) is parsed once and kept beside the load — the
 * per-definition caches after it (the payload's, the projections') key on the
 * definition, so they key on the locale too — and never across tenants: a
 * tenant's words are in the key by their content.
 */
export function localizedApp<L extends Pick<LoadedApp, 'app' | 'pages'>>(
  loaded: L,
  locale: string | undefined,
  overrides?: { stamp: string; words: MessageOverrides },
): L {
  const localizer = localizerOf(loaded.app);
  if (!localizer || !locale) return loaded;
  const { catalogs } = localizer;
  const words = Object.hasOwn(catalogs.locales, locale) ? locale : languageOf(locale);
  const own = !Object.hasOwn(catalogs.locales, words) || words === catalogs.source;
  if (own && !overrides?.words.size) return loaded;
  const key = JSON.stringify([locale, overrides?.words.size ? overrides.stamp : null]);
  const held = (localizer.held ??= new Map()) as Map<string, Pick<LoadedApp, 'app' | 'pages'>>;
  let hit = held.get(key);
  if (!hit) {
    const { app, pages } = parseDefinition(localizer.definition as DefinitionInput, new MessageSayer(catalogs, locale, overrides?.words));
    /* Addresses are one per thing in every language: a tab's word and a section's window key stay the source's. */
    keepAddresses(loaded.app.views, app.views);
    keepAddresses(loaded.pages, pages);
    keepFaces(loaded.app, app);
    if (loaded.app.valueLabels) app.valueLabels = loaded.app.valueLabels;
    hit = { app, pages };
    if (held.size >= LOCALES_PER_DEFINITION) held.delete(held.keys().next().value!);
    held.set(key, hit);
    /* A reader's definition is the load's, in other words: its own catalogs come with it. */
    holdLocalizer(app, localizer, false);
  }
  return { ...loaded, app: hit.app, pages: hit.pages };
}

const LOCALES_PER_DEFINITION = 32;

/** The served names a load gave its themes' faces (appFonts.ts), onto a definition parsed again in other words. */
function keepFaces(source: AppDef, said: AppDef): void {
  source.ui.customThemes?.forEach((theme, t) =>
    theme.faces?.forEach((face, f) => {
      const other = said.ui.customThemes?.[t]?.faces?.[f];
      if (other) Object.assign(other, { file: face.file, href: face.href });
    }),
  );
}

/**
 * The source's address words onto a definition said in other words: the two
 * were parsed from one definition, so they have one shape, and only captions
 * differ. A tab whose label reads otherwise keeps the source label's slug; a
 * section with windows keeps its key; a page section keeps its tab's and
 * title's source words (`addressWords`).
 */
function keepAddresses(source: unknown, said: unknown): void {
  if (!source || !said || typeof source !== 'object' || typeof said !== 'object') return;
  if (Array.isArray(source)) {
    if (Array.isArray(said)) source.forEach((item, i) => keepAddresses(item, said[i]));
    return;
  }
  const from = source as Record<string, unknown>;
  const to = said as Record<string, unknown>;
  if (Object.isFrozen(to)) return;
  if (typeof from.windowKey === 'string') to.windowKey = from.windowKey;
  /* A page section's tab and title name its tab in an address (client PageSections.tsx): the source's words, kept beside the reader's. */
  if (Array.isArray(from.sections) && Array.isArray(to.sections))
    from.sections.forEach((section: { tab?: unknown; title?: unknown }, i) => {
      const other = (to.sections as Array<Record<string, unknown>>)[i];
      if (!section || !other || Object.isFrozen(other)) return;
      const words: { tab?: string; title?: string } = {};
      if (typeof section.tab === 'string' && section.tab !== other.tab) words.tab = section.tab;
      if (typeof section.title === 'string' && section.title !== other.title) words.title = section.title;
      if (words.tab !== undefined || words.title !== undefined) other.addressWords = words;
    });
  if (Array.isArray(from.tabs) && Array.isArray(to.tabs))
    from.tabs.forEach((tab: { label?: unknown; slug?: unknown }, i) => {
      const other = (to.tabs as Array<Record<string, unknown>>)[i];
      if (!other || Object.isFrozen(other) || typeof tab?.label !== 'string' || typeof other.label !== 'string') return;
      const word = typeof tab.slug === 'string' ? tab.slug : tabSlug(tab.label);
      if (tabSlug(other.label) !== word) other.slug = word;
    });
  for (const [key, value] of Object.entries(from)) if (key !== 'tabs' && value && typeof value === 'object') keepAddresses(value, to[key]);
}

/**
 * Every problem the load can name, each line starting with the file it
 * lives in — the manifest, or the pages/ file that defined the page.
 * What a feature wrote is named by the feature, after the file.
 * One list, three readers: the startup log, mistri check, and the shell's
 * issues pill. An author mid-loop should never have to guess which of
 * five files holds the line to fix.
 */
const OUTSIDE_RESOURCES = 'The App serves only its declared resources: declare the table in "resources".';

/** The catalog an App without role grants serves its one reader; undefined with role grants, or a grant that does not resolve (named on its own). */
function servedReach(app: AppDef, schema: DatabaseSchema): DatabaseSchema | undefined {
  if (grantsByRole(app)) return undefined;
  try {
    return accessibleSchema(schema, resolveAppAccess(app, schema, []));
  } catch {
    return undefined;
  }
}

/** The branding compiler's small, immutable catalog, in logical resource names.
 * Supply RuntimeResources.schema (already source-bound), never a physical or
 * per-reader catalog. This checks the App's ceiling, not a request's authority. */
export function appBrandingCatalog(app: AppDef, schema: DatabaseSchema): BrandingCatalog {
  const files = appFileRules(app, schema).rules;
  const exact = grantsByRole(app);
  const resources: Record<string, BrandingCatalog['resources'][string]> = Object.create(null);
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    const table = exact ? schema.tables.find((table) => table.id === name) : tableNamed(schema, name);
    if (!table) continue;
    const hidden = new Set([...(resource.hidden ?? []), ...(table[CONNECTION_HIDDEN] ?? [])]);
    const columns: Record<string, BrandingColumnKind> = Object.create(null);
    for (const column of table.columns) {
      if (hidden.has(column.name) || (resource.fields?.read && !column.primaryKey && !resource.fields.read.includes(column.name))) continue;
      const kind = columnKind(column.type);
      if (isFlagColumn(column)) columns[column.name] = 'boolean';
      else if (/^(?:tinyint|smallint|mediumint|int(?:eger|[248])?|bigint|smallserial|serial[248]?|bigserial)\b/i.test(column.type.trim()))
        columns[column.name] = 'integer';
      else if (kind === 'number') columns[column.name] = 'number';
      else if (kind === 'text' && !isJsonType(column.type)) columns[column.name] = 'text';
    }
    resources[name] = Object.freeze({
      columns: Object.freeze(columns),
      primaryKey: Object.freeze(table.columns.filter((column) => column.primaryKey).map((column) => column.name)),
      ...(files.has(table.id) ? { file: true } : {}),
    });
  }
  return Object.freeze({ resources: Object.freeze(resources) });
}

/** Bind once against the logical catalog. No database reads, row selection or
 * authorization: those remain the request branding owner's responsibility. */
export function bindAppBranding(app: AppDef, schema: DatabaseSchema): BrandingBinding | undefined {
  if (!app.ui.branding) return undefined;
  try {
    return bindRecordBranding(app.ui.branding, appBrandingCatalog(app, schema));
  } catch (error) {
    throw new Error(`ui.theme fromRecord "${app.ui.branding.from}": ${(error as Error).message}`);
  }
}

/* What every request compiles before it serves the App (http/source.ts servedFor), against the catalog it is
   handed there. A rule that fails to compile there answers /api/app with a 500 and the App does not load, so
   check and startup compile it here too, every resource's rules rather than the first that fails. */
function servedCompileProblems(loaded: LoadedApp, schema: DatabaseSchema): string[] {
  const problems: string[] = [];
  if (resourceValidation(loaded.app)) {
    try {
      problems.push(...resolveValidation(loaded.app, schema).warnings);
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  for (const compile of [compileAppDefinitionValidation, compileAppStamps]) {
    try {
      compile(schema, loaded.app);
    } catch (error) {
      const message = (error as Error).message;
      if (!problems.includes(message)) problems.push(message);
    }
  }
  return problems;
}

/**
 * Every failure of the App's own themes, each with the fix that passes where
 * one of its hue does (themeFix.ts): what validation says, and what `check`
 * places at the color's own line and `check --fix` writes.
 */
export function appThemeProblems(app: AppDef): FixedThemeProblem[] {
  return (app.ui.customThemes ?? []).flatMap((theme) => checkThemeWithFixes(theme, app.ui.theme));
}

export function appProblems(loaded: LoadedApp, schema: DatabaseSchema): string[] {
  const home = loaded.dir ?? dirname(loaded.path);
  const at = (file: string) => relative(home, file) || file;
  const manifest = at(loaded.path);
  /* The App's own themes meet the one validator (themeCheck.ts): contrast and the chart's colour-blind
     separation, each failure by its colour's name. Its accent is held against every look it offers. */
  const problems: string[] = [
    ...appThemeWarnings([], loaded.app.ui.theme),
    ...appThemeProblems(loaded.app).map((problem) => problem.message),
  ];
  try {
    bindAppBranding(loaded.app, schema);
  } catch (error) {
    problems.push(`${manifest}: ${(error as Error).message}`);
  }
  const zone = zoneColumnProblem(loaded.app, schema);
  if (zone) problems.push(`${manifest}: ${zone}`);
  const locale = localeColumnProblem(loaded.app, schema);
  if (locale) problems.push(`${manifest}: ${locale}`);
  problems.push(...messageProblems(loaded, schema).map((p) => `${manifest}: ${p}`));
  problems.push(...unionProblems(loaded.app, schema).map((p) => `${manifest}: ${p}`));
  /* Rollups read like columns wherever a view, a page or a sort names one,
     so everything below is judged against the catalog that serves them. */
  problems.push(...servedCompileProblems(loaded, schema).map((p) => `${manifest}: ${locateProblem(loaded.origins, p)}`));
  const rollups = appRollupRules(loaded.app, schema);
  problems.push(...rollups.problems.map((p) => `${manifest}: ${locateProblem(loaded.origins, p)}`));
  /* Each machine's graph (appMachine.ts): its states reached and left, its column the table's, and each verb one some role may run. */
  problems.push(...machineChecks(loaded.app, schema).map((p) => `${manifest}: ${locateProblem(loaded.origins, p)}`));
  /* A segment is judged before one that does not read is left out of what is served (appSegments.ts). */
  const whole = appCatalog(loaded.app, schema);
  problems.push(...segmentProblems(loaded.app, whole).map((p) => `${manifest}: ${locateProblem(loaded.origins, p)}`));
  problems.push(...appConsumesRules(loaded.app, schema).problems.map((p) => `${manifest}: ${locateProblem(loaded.origins, p)}`));
  schema = servedSegments(whole);
  /* A list's filters across its related tables, judged whole: a reader's catalog leaves one it cannot read off. */
  problems.push(...listFilterProblems(loaded.app, schema).map((p) => `${manifest}: ${locateProblem(loaded.origins, p)}`));
  /* A computed column is judged over the rollups it may read. */
  problems.push(...appComputedRules(loaded.app, schema).problems.map((p) => `${manifest}: ${locateProblem(loaded.origins, p)}`));
  /* A form's lines and live figures read those rollups and computed columns (formLines.ts). */
  problems.push(...formLinesProblems(loaded.app, schema).map((p) => `${manifest}: ${locateProblem(loaded.origins, p)}`));
  const views = resolveViews(loaded.app, schema);
  for (const key of viewOrder({ views, nav: loaded.app.nav })) {
    const view = views[key];
    const every = 'errors' in view && view.errors?.length ? view.errors : view.error ? [view.error] : [];
    for (const line of every) problems.push(`${manifest}: ${locateProblem(loaded.origins, `view "${key}": ${line}`)}`);
  }
  /* Without role grants there is one reader, served the declared resources
     and nothing else: a view or page that reaches past them would be an
     empty room for everyone, so it is named here. With role grants a room
     one role cannot read is that role's to lose, and is dropped for it. */
  const reach = servedReach(loaded.app, schema);
  if (reach) {
    const within = resolveViews(loaded.app, reach);
    for (const key of viewOrder({ views, nav: loaded.app.nav })) {
      const before = views[key];
      if (('errors' in before && before.errors?.length) || before.error) continue;
      const after = within[key];
      const line = ('errors' in after && after.errors?.[0]) || after.error;
      if (line) problems.push(`${manifest}: ${locateProblem(loaded.origins, `view "${key}": ${line} ${OUTSIDE_RESOURCES}`)}`);
    }
  }
  problems.push(...resolveResources(loaded.app, schema).problems.map((p) => `${manifest}: ${locateProblem(loaded.origins, p)}`));
  problems.push(...appTransitionRules(loaded.app, schema).problems.map((p) => `${manifest}: ${locateProblem(loaded.origins, p)}`));
  problems.push(...appNotifyRules(loaded.app, schema).problems.map((p) => `${manifest}: ${locateProblem(loaded.origins, p)}`));
  const files = appFileRules(loaded.app, schema, { strict: true });
  problems.push(...files.problems.map((p) => `${manifest}: ${locateProblem(loaded.origins, p)}`));
  problems.push(...appTagRules(loaded.app, schema).problems.map((p) => `${manifest}: ${locateProblem(loaded.origins, p)}`));
  problems.push(...resolveDisplay(loaded.app, schema).warnings.map((w) => `${manifest}: ${locateProblem(loaded.origins, w)}`));
  problems.push(...valueLabelFindings(loaded.app).problems.map((p) => `${manifest}: ${locateProblem(loaded.origins, p)}`));
  problems.push(...appCeilingWarnings(loaded.app, schema).map((w) => `${manifest}: ${w}`));
  /* Every address the App answers to, once: a collision, a reserved word, a
     natural key the database does not keep unique (shared/appAddress.ts). */
  const routes = appRoutes(loaded, schema);
  const tenantOwned = (table: string) => loaded.app.resources?.[table]?.owner === 'tenant';
  problems.push(
    ...[...routes.problems, ...naturalKeyProblems(routes, tenantOwned)].map((p) => `${manifest}: ${locateProblem(loaded.origins, p)}`),
  );
  for (const p of loaded.pages) {
    const checked = validatePage(schema, p);
    const feature = loaded.origins?.pages[p.id];
    const outside = !checked.error && reach ? validatePage(reach, p).error : undefined;
    if (checked.error || outside)
      problems.push(
        `${at(loaded.sources[p.id] ?? loaded.path)}: ${feature ? `features "${feature}", ` : ''}page "${p.name}": ` +
          (checked.error ?? `${outside} ${OUTSIDE_RESOURCES}`),
      );
    /* A record header names its verbs by id: each one of the base resource's
       actions, or the filled button silently falls to another. */
    const header = p.sections.find((section): section is PageFields => section.kind === 'fields' && section.presentation === 'header');
    if (header && (header.primary !== undefined || header.destructive?.length || header.headerActions?.length)) {
      const baseId = tableNamed(schema, p.base)?.id;
      const actions =
        Object.entries(loaded.app.resources ?? {}).find(([name]) => baseId !== undefined && tableNamed(schema, name)?.id === baseId)?.[1]
          .actions ?? [];
      const ids = actions.map((action) => action.id);
      for (const [key, id] of [
        ...(header.primary === undefined ? [] : [['primary', header.primary] as const]),
        ...(header.destructive ?? []).map((id) => ['destructive', id] as const),
        ...(header.headerActions ?? []).map((id) => ['actions', id] as const),
      ]) {
        /* `header: false` is the action saying it is never drawn there, so the head would fill or list nothing. */
        if (actions.find((action) => action.id === id)?.header === false) {
          problems.push(
            `${at(loaded.sources[p.id] ?? loaded.path)}: ${feature ? `features "${feature}", ` : ''}page "${p.name}": the header's ${key} "${id}" ` +
              `says header: false, so the record's action bar never draws it. Drop one of the two.`,
          );
          continue;
        }
        if (ids.includes(id)) continue;
        problems.push(
          `${at(loaded.sources[p.id] ?? loaded.path)}: ${feature ? `features "${feature}", ` : ''}page "${p.name}": the header's ${key} "${id}" is not an action of "${p.base}". ` +
            (ids.length
              ? `Its actions: ${ids.map((each) => `"${each}"`).join(', ')}.`
              : `It declares none: add it to resources.${p.base}.actions.`),
        );
      }
    }
    /* A related list's `actions` are the record's own verbs drawn in the list's head: each one the base resource
       declares, and one its action bar may draw. */
    for (const section of p.sections) {
      if (section.kind !== 'list' || !section.listActions?.length) continue;
      const baseId = tableNamed(schema, p.base)?.id;
      const actions =
        Object.entries(loaded.app.resources ?? {}).find(([name]) => baseId !== undefined && tableNamed(schema, name)?.id === baseId)?.[1]
          .actions ?? [];
      const where = `${at(loaded.sources[p.id] ?? loaded.path)}: ${feature ? `features "${feature}", ` : ''}page "${p.name}": the list of "${section.from}"`;
      for (const id of section.listActions) {
        const action = actions.find((each) => each.id === id);
        if (!action)
          problems.push(
            `${where} has actions "${id}", which is not an action of "${p.base}". ` +
              (actions.length
                ? `Its actions: ${actions.map((each) => `"${each.id}"`).join(', ')}.`
                : `It declares none: add it to resources.${p.base}.actions.`),
          );
        else if (action.header === false)
          problems.push(`${where} has actions "${id}", which says header: false, so no action bar draws it. Drop one of the two.`);
      }
    }
    /* A related list's row menu draws its rows' own verbs: a resource that declares none would draw no menu. */
    for (const section of p.sections) {
      if (section.kind !== 'list' || !section.rowActions) continue;
      const fromId = tableNamed(schema, section.from)?.id;
      const resource = Object.entries(loaded.app.resources ?? {}).find(
        ([name]) => fromId !== undefined && tableNamed(schema, name)?.id === fromId,
      )?.[1];
      if (!resource?.actions?.some((action) => action.header !== false) && !resource?.machine)
        problems.push(
          `${at(loaded.sources[p.id] ?? loaded.path)}: ${feature ? `features "${feature}", ` : ''}page "${p.name}": the list of "${section.from}" has rowActions, ` +
            `but resources.${section.from} declares no action or machine for its rows' menu.`,
        );
    }
    /* A conversation's composer runs commands by name, and the browser finds each through an action of the base
       resource that offers it (the way a component's useCommand does), so a name no action offers is a composer
       that can never send. */
    for (const section of p.sections) {
      if (section.kind !== 'timeline' || !section.composer) continue;
      const baseId = tableNamed(schema, p.base)?.id;
      const templates = section.composer.templates;
      if (templates) {
        const where = `${at(loaded.sources[p.id] ?? loaded.path)}: page "${p.name}": the composer's templates`;
        const from = tableNamed(schema, templates.from);
        if (!from || !loaded.app.resources?.[templates.from])
          problems.push(`${where} read "${templates.from}", which is not a resource of the App.`);
        else {
          for (const column of [templates.labelColumn, templates.text])
            if (!from.columns.some((c) => c.name === column)) problems.push(`${where}: "${templates.from}" has no column "${column}".`);
          /* The rows offered: judged by the parser that will read them, against the resource they narrow. */
          const error =
            templates.query === undefined ? undefined : parseQuery(`${from.id} ${templates.query}`, { schema, me: ANYONE }).errors[0];
          if (error) problems.push(`${where}: "query" does not read on "${templates.from}": ${error.message}`);
        }
      }
      const actions =
        Object.entries(loaded.app.resources ?? {}).find(([name]) => baseId !== undefined && tableNamed(schema, name)?.id === baseId)?.[1]
          .actions ?? [];
      for (const [mode, name] of [
        ['reply', section.composer.reply],
        ['note', section.composer.note],
      ] as const) {
        if (name === undefined) continue;
        const offered = actions.find((action) => 'command' in action && action.command?.id === name);
        if (offered) {
          if (
            'command' in offered &&
            offered.command &&
            offered.command.target !== baseId &&
            tableNamed(schema, offered.command.target)?.id !== baseId
          ) {
            problems.push(
              `${at(loaded.sources[p.id] ?? loaded.path)}: page "${p.name}": the composer's ${mode} command "${name}" acts on "${offered.command.target}", not on "${p.base}", the record the page is about.`,
            );
          }
          continue;
        }
        problems.push(
          `${at(loaded.sources[p.id] ?? loaded.path)}: ${feature ? `features "${feature}", ` : ''}page "${p.name}": the composer's ${mode} command "${name}" is offered by no action of "${p.base}". ` +
            `Add one to resources.${p.base}.actions: ${name}: action('${mode === 'reply' ? 'Reply' : 'Add note'}', { command: '${name}' }).`,
        );
      }
    }
    /* A gallery draws image files: over rows that are not files it would be
       a grid pretending, so the page names which section and why. */
    for (const section of p.sections) {
      if (section.kind !== 'list' || section.presentation !== 'gallery') continue;
      const table = tableNamed(schema, section.from);
      if (table && files.rules.has(table.id)) continue;
      problems.push(
        `${at(loaded.sources[p.id] ?? loaded.path)}: ${feature ? `features "${feature}", ` : ''}page "${p.name}": ` +
          `section "${section.title ?? section.from}" draws a gallery over "${section.from}", whose rows are not files. Declare "file" on that resource, or drop the presentation.`,
      );
    }
    /* Related cards are the list view's cards, judged the same way: a title through a reference, an icon its
       display rule draws, a fact past one join. */
    for (const section of p.sections) {
      if (section.kind !== 'list' || typeof section.presentation !== 'object' || section.presentation.kind !== 'cards') continue;
      const table = tableNamed(schema, section.from);
      if (!table) continue;
      const resource = loaded.app.resources?.[section.from];
      const problem = cardsProblem(section.presentation, table, schema, new Set(files.rules.keys()), (column) =>
        Boolean(resource?.display?.[column]?.icons && Object.keys(resource.display[column].icons!).length),
      );
      if (!problem) continue;
      problems.push(
        `${at(loaded.sources[p.id] ?? loaded.path)}: ${feature ? `features "${feature}", ` : ''}page "${p.name}": ` +
          `section "${section.title ?? section.from}": ${problem}`,
      );
    }
    /* A headline's call to action that opens nothing is a typo. */
    for (const section of p.sections) {
      if (section.kind !== 'fields') continue;
      for (const action of section.actions ?? []) {
        if (!('view' in action)) continue;
        if (Object.hasOwn(loaded.app.views, action.view)) continue;
        problems.push(
          `${at(loaded.sources[p.id] ?? loaded.path)}: ${feature ? `features "${feature}", ` : ''}page "${p.name}": ` +
            `the headline's "${action.label}" opens "${action.view}", which is not one of this App's views.`,
        );
      }
    }
  }
  for (const { page, problem } of publicPrefillProblems(loaded.app, loaded.pages, schema)) {
    const feature = loaded.origins?.pages[page.id];
    problems.push(
      `${at(loaded.sources[page.id] ?? loaded.path)}: ${feature ? `features "${feature}", ` : ''}page "${page.name}": ${problem}`,
    );
  }
  return problems;
}

/**
 * What an App says that parses, resolves and can never happen: a literal
 * outside a column's values, an action no role may run. Advice, not a
 * problem — kept out of appProblems, which the API owners, token commands and
 * tenant startup treat as a refusal. Startup prints these as App warnings and
 * `mistri check` beside its verdict; neither fails on them.
 */
export function appAdvisories(loaded: LoadedApp, schema: DatabaseSchema): string[] {
  const manifest = relative(dirname(loaded.path), loaded.path) || loaded.path;
  return [
    ...appLiteralWarnings(loaded.app, loaded.pages, schema),
    ...appReachWarnings(loaded.app, schema),
    ...appMenuWarnings(loaded.app),
    ...appRestatedWarnings(loaded.app, schema).filter((warning) => !saidByMessage(loaded, warning)),
    ...messageAdvice(loaded),
    ...deprecatedOf(loaded.app),
    ...editableAddressWarnings(loaded.app, schema),
    ...metricWarnings(loaded.app),
    ...drillWarnings(loaded.app, schema),
    ...emptyRunWarnings(loaded.pages),
    ...rawIdWarnings(loaded.app, loaded.pages),
    ...mixedCurrencyWarnings(loaded.app),
    ...liveOffWarnings(loaded.app),
    ...notifyAdvisories(loaded.app, schema),
    ...valueLabelFindings(loaded.app).warnings,
  ].map((w) => `${manifest}: ${locateProblem(loaded.origins, w)}`);
}

/* ---------- what check says about the App's words (appMessages.ts) ---------- */

/** The definition a load was parsed from, its catalogs beside it, where it has any. */
const wordsOf = (loaded: LoadedApp) => {
  const localizer = localizerOf(loaded.app);
  return localizer ? { raw: (localizer.definition as DefinitionInput).raw, catalogs: localizer.catalogs } : undefined;
};

/**
 * `[message-arg]`: a notify title's or a record name's argument that reads no
 * column, or one of the wrong kind; and a `ui.messages` binding the catalog
 * cannot serve: a declared resource whose tenant, key, locale and text are text columns.
 */
function messageProblems(loaded: LoadedApp, schema: DatabaseSchema): string[] {
  const problems: string[] = [];
  const words = wordsOf(loaded);
  if (words) {
    const kindOf = (resource: string, path: string) => {
      let table = tableNamed(schema, resource);
      const steps = path.split('.');
      for (const [i, step] of steps.entries()) {
        const column = table?.columns.find((candidate) => candidate.name === step);
        if (!column) return undefined;
        if (i === steps.length - 1) {
          const kind = columnKind(column.type);
          return kind === 'number' || kind === 'boolean' || kind === 'date' || kind === 'text' ? kind : 'other';
        }
        table = column.references ? findTable(schema, column.references.table) : undefined;
      }
      return undefined;
    };
    problems.push(...messageArgProblems(words.raw, words.catalogs, kindOf));
  }
  const spec = loaded.app.ui.messages;
  if (spec) {
    const where = `ui.messages reads "${spec.from}"`;
    const table = tableNamed(schema, spec.from);
    if (!Object.hasOwn(loaded.app.resources ?? {}, spec.from)) problems.push(`${where}, which is not one of the App's resources.`);
    else if (!table) problems.push(`${where}, which this connection does not have.`);
    else
      for (const name of [spec.tenantField, spec.fields.key, spec.fields.locale, spec.fields.text]) {
        const column = table.columns.find((candidate) => candidate.name === name);
        if (!column) problems.push(`${where}, which has no column "${name}".`);
        else if (columnKind(column.type) !== 'text')
          problems.push(`${where}: "${name}" is ${column.type}; a tenant, a key, a locale and words are text.`);
      }
  }
  return problems;
}

/** `[message-untranslated]` and `[message-unused]`: advice about the catalogs, never a refusal. */
function messageAdvice(loaded: LoadedApp): string[] {
  const words = wordsOf(loaded);
  return words ? messageAdvisories(words.raw, words.catalogs) : [];
}

/* A label said from the App's messages restates nothing: its words differ in every other language. */
export function saidByMessage(loaded: LoadedApp, warning: string): boolean {
  const found = /^resources "([^"]+)" \[restated\]: labels "([^"]+)"/.exec(warning);
  const raw = found && wordsOf(loaded)?.raw;
  if (!found || !raw) return false;
  type Resources = Record<string, { labels?: Record<string, unknown> }> | undefined;
  /* A feature's resources are the App's too: its labels are said there. */
  const declared = [
    raw.resources as Resources,
    ...((raw.features as { resources?: Resources }[] | undefined) ?? []).map((feature) => feature?.resources),
  ];
  return declared.some((resources) => isMessageRef(resources?.[found[1]]?.labels?.[found[2]]));
}

/**
 * The App's address book on this catalog, as the browser builds it from the
 * payload it is served (client publicAddress.ts): the check, the route table
 * and the browser route by one rule. With `roles`, the book of a person who
 * holds them — the views and pages they are served, so a link written for
 * them (a mail, a suite link) is the address their browser says; without,
 * the whole App's, every address it answers to.
 */
type RoutedApp = { app: LoadedApp['app']; pages: readonly LoadedApp['pages'][number][] };
export function appRoutes(loaded: RoutedApp, schema: DatabaseSchema, realm?: AppRealm, roles?: readonly string[]): AddressBook {
  /* One realm of a two-realm App is what that realm's context is served: its
     own surface (appSurfaceForRealm) over the tables it has, a tenant's
     without the platform's own. */
  let surface: RoutedApp = realm ? appSurfaceForRealm(loaded.app, loaded.pages, realm) : loaded;
  if (roles) surface = { app: appForRoles(surface.app, roles), pages: pagesForRoles(surface.pages, roles, surface.app.auth) };
  if (realm === 'tenant')
    schema = { ...schema, tables: schema.tables.filter((table) => loaded.app.resources?.[table.id]?.owner !== 'platform') };
  const served = servedApp(surface.app, schema, surface.pages);
  return appAddressBook({
    views: served.views as never,
    order: viewOrder(served),
    resources: served.resources,
    pages: served.pages ?? [],
    tables: schema.tables,
    inbox: served.inbox === true,
    assistant: served.assistant?.page === true,
    ...(roles ? { projected: true } : {}),
  });
}

/**
 * A natural key someone can change is a link that breaks: every address
 * written with the old value opens nothing. Allowed — a SKU is sometimes
 * corrected — but said, where an action sets it or the resource lets its
 * records be edited with it among the fields.
 */
/* A metric's "better" says which way its change is good; with no "compare"
   and no "over" (whose metric compares with the period before by default)
   there is no change, so it colours nothing. Said, never refused: the rest
   of the metric is right, and the author may be adding the compare next. */
function metricWarnings(app: LoadedApp['app']): string[] {
  const warnings: string[] = [];
  for (const [key, view] of Object.entries(app.views)) {
    const dashboard = view as { sections?: ReadonlyArray<AppDashSection>; aside?: ReadonlyArray<AppDashSection> };
    for (const section of [...(dashboard.sections ?? []), ...(dashboard.aside ?? [])]) {
      if (section.kind !== 'metric' || section.better === undefined || section.compare !== undefined || section.over) continue;
      warnings.push(
        `view "${key}": metric "${section.title}" has "better" and no "compare" or "over", so there is no change for it to colour. Give it over: '<a date column>' to compare with the period before, or drop "better". See \`mistri docs dashboards\`.`,
      );
    }
  }
  return warnings;
}

/* A breakdown, chart or matrix opens its groups in one of the App's lists, never in the database browser. Without a
   `to`, that is the one list over its table that is not only an embed; with none, or with several, its groups are
   text, and this says so while the author can still choose. A bucketed `by` ("month opened_on") is never a doorway. */
function drillWarnings(app: LoadedApp['app'], schema: DatabaseSchema): string[] {
  const warnings: string[] = [];
  const embedded = embeddedOnlyViews(app as never, homeViews(app));
  const listsOver = (id: string) =>
    Object.entries(app.views).flatMap(([key, view]) => {
      const table = 'table' in view && !('sections' in view) && typeof view.table === 'string' ? tableNamed(schema, view.table) : undefined;
      return table?.id === id && !embedded.has(key) ? [key] : [];
    });
  for (const [key, view] of Object.entries(app.views)) {
    const dashboard = view as { sections?: ReadonlyArray<AppDashSection>; aside?: ReadonlyArray<AppDashSection> };
    for (const section of [...(dashboard.sections ?? []), ...(dashboard.aside ?? [])]) {
      if (!['breakdown', 'chart', 'matrix', 'funnel'].includes(section.kind) || section.view || section.noDrill) continue;
      const first = (section.by ?? '').split(',')[0].trim();
      const table = section.table ? tableNamed(schema, section.table) : undefined;
      /* A funnel's stages are doorways whatever they count; the others' groups, only a plain column's. */
      if (!table || (section.kind !== 'funnel' && (!first || /\s/.test(first)))) continue;
      const lists = listsOver(table.id);
      const name = `${section.kind} "${section.title ?? section.by}"`;
      if (!lists.length)
        warnings.push(
          `view "${key}" [drill-none]: ${name} reads ${table.name}, which has no list view, so its groups are not links. Add a list view over ${table.name}, or say to: false.`,
        );
      else if (lists.length > 1)
        warnings.push(
          `view "${key}" [drill-ambiguous]: ${name} reads ${table.name}, which has ${lists.length} list views (${lists.join(', ')}), so its groups are not links. Say which one with to: '…', or to: false.`,
        );
    }
  }
  return warnings;
}

/* Three or more related lists in a row that say nothing of `empty` draw three empty tables on a record with no history.
   One word on the page (`empty: 'collapse'`) folds them into a line; a list's own `empty` or a strip of tabs
   (`listTabs`) already decides, so those are not counted. */
const EMPTY_RUN = 3;
function emptyRunWarnings(pages: readonly PageDef[]): string[] {
  const warnings: string[] = [];
  for (const page of pages) {
    if ((page as { listTabs?: boolean }).listTabs) continue;
    let run: string[] = [];
    let tab: string | undefined;
    const end = () => {
      if (run.length >= EMPTY_RUN)
        warnings.push(
          `page "${page.name}" [empty-run]: ${run.length} related lists in a row (${run.join(', ')}) say nothing of what they do while empty, so a record with none draws ${run.length} empty tables. ` +
            `Say empty: 'collapse' on the page to fold them into one line, or empty: 'hide' where an empty list is not worth a place.`,
        );
      run = [];
    };
    for (const section of page.sections) {
      const quiet = section.kind === 'list' && section.emptyMode === undefined && section.empty === undefined;
      if (!quiet || (run.length && section.tab !== tab)) end();
      if (quiet) {
        tab = section.tab;
        run.push(section.title ?? section.from);
      }
    }
    end();
  }
  return warnings;
}

/* A label or title the author wrote as an identifier (`billing.order_line`, `EVENT_ENUM`) is drawn to the reader as it
   stands: platform defaults are humanised (humanName), authored text is trusted, so this says it while it can be fixed. */
const RAW_ID = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+$|^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/;
function rawIdWarnings(app: LoadedApp['app'], pages: readonly PageDef[]): string[] {
  const warnings: string[] = [];
  const check = (where: string, kind: string, text: unknown) => {
    if (typeof text === 'string' && RAW_ID.test(text.trim()))
      warnings.push(
        `${where} [raw-id]: the ${kind} "${text}" is an identifier, and is drawn to the reader as written. Say it in words ("${humanName(text.trim())}"), or leave it out to have the platform say it.`,
      );
  };
  for (const [key, view] of Object.entries(app.views)) {
    const shown = view as { label?: unknown; sections?: ReadonlyArray<{ title?: unknown }>; aside?: ReadonlyArray<{ title?: unknown }> };
    check(`view "${key}"`, 'label', shown.label);
    for (const section of [...(shown.sections ?? []), ...(shown.aside ?? [])]) check(`view "${key}"`, 'section title', section.title);
  }
  for (const page of pages) {
    check(`page "${page.id}"`, 'label', page.name);
    for (const section of page.sections) check(`page "${page.id}"`, 'section title', (section as { title?: unknown }).title);
  }
  return warnings;
}

/* Money each row says its own currency for (`currency: { column }`) is summed apart per currency on a metric, a
   record's figure and a board's lanes. A chart or a breakdown has no second axis for it: summed over its groups, it
   would add yen to dollars, so it says to group by the currency or keep to one. */
function mixedCurrencyWarnings(app: LoadedApp['app']): string[] {
  const warnings: string[] = [];
  const resources = (app.resources ?? {}) as Record<string, { display?: Record<string, { format?: string; currencyColumn?: string }> }>;
  for (const [key, view] of Object.entries(app.views)) {
    const dashboard = view as { sections?: ReadonlyArray<AppDashSection>; aside?: ReadonlyArray<AppDashSection> };
    for (const section of [...(dashboard.sections ?? []), ...(dashboard.aside ?? [])]) {
      const asked = section as { kind: string; table?: string; measure?: string; by?: string; query?: string; title?: string };
      if (!['chart', 'breakdown', 'matrix'].includes(asked.kind) || !asked.table) continue;
      const column = /^(?:sum|avg|min|max|median)\s+([A-Za-z0-9_]+)\b/i.exec(asked.measure ?? '')?.[1];
      const by = column ? resources[asked.table]?.display?.[column] : undefined;
      const currency = by?.format === 'money' ? by.currencyColumn : undefined;
      if (!currency) continue;
      const grouped = (asked.by ?? '').split(',').some((part) => part.trim().split(/\s+/).pop() === currency);
      const kept = new RegExp(`(?:^|\\s)${currency}\\s*=\\s*"?[A-Za-z]{3}"?(?:\\s|$)`).test(asked.query ?? '');
      if (grouped || kept) continue;
      warnings.push(
        `view "${key}": ${asked.kind} "${asked.title ?? asked.measure}" adds up ${asked.table}.${column}, whose rows each say their own currency in "${currency}". Group it by "${currency}" too, or keep it to one (query: '${currency} = USD').`,
      );
    }
  }
  return warnings;
}

/* A resource's `live: false` takes its table out of live sync, which an App joins only with `live: true` at its top.
   On an App that does not, nothing is followed and the word changes nothing: said, so the author does not believe a
   table is held out of something the App never does, or that the rest of it follows changes. */
function liveOffWarnings(app: LoadedApp['app']): string[] {
  if ((app as { live?: true }).live === true) return [];
  return Object.entries(app.resources ?? {}).flatMap(([name, resource]) =>
    (resource as { live?: false }).live === false
      ? [
          `resources "${name}" [live-unused]: it says live: false, but the App does not ask for live sync, so no table of it is followed and this changes nothing. Drop it, or say live: true at the App's top.`,
        ]
      : [],
  );
}

function editableAddressWarnings(app: LoadedApp['app'], schema: DatabaseSchema): string[] {
  const warnings: string[] = [];
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    const column = resource.address;
    if (!column || !tableNamed(schema, name)) continue;
    const setters = (resource.actions ?? []).flatMap((action) =>
      'set' in action && action.set && Object.hasOwn(action.set, column) ? [action.label] : [],
    );
    const edited = resource.fields?.write ? resource.fields.write.includes(column) : resource.access === 'write';
    const by = [...setters.map((label) => `the action "${label}"`), ...(edited ? ['editing a record'] : [])];
    if (by.length)
      warnings.push(
        `resources "${name}": its address is "${column}", which ${by.join(' and ')} can change; every link written with the old value would then open nothing.`,
      );
  }
  return warnings;
}

/**
 * The app's pages joined onto the config file's. A shared id is refused
 * with both files named: two definitions under one id would mean the last
 * one loaded silently wins, and which that is would be a fact about load
 * order rather than about either file.
 */
export function mergeAppPages(configPages: PageDef[], loaded: LoadedApp, configPath?: string): PageDef[] {
  const have = new Set(configPages.map((p) => p.id));
  for (const p of loaded.pages) {
    if (have.has(p.id)) {
      throw new Error(`${loaded.path}: page id "${p.id}" is already defined in ${configPath ?? 'the config file'}.`);
    }
  }
  return [...configPages, ...loaded.pages];
}

/**
 * Resolve the app for one connection. Most servers have no app, and an app
 * bound to another connection is no app here — both are `app: null`, and
 * the client draws the ordinary sidebar without a word.
 *
 * `loadError` is the hot-reload story leaking through, on purpose: while the
 * copy on disk is broken the server keeps serving the last good load, and
 * this is where a client finds out the two have diverged.
 *
 * `connection` is for the route, which answers with its own public scope.
 */
export function appPayload(
  loaded: LoadedApp | undefined,
  connectionId: string,
  connectionName: string | undefined,
  schema: DatabaseSchema,
  loadError?: string,
): AppPayload & { connection: string } {
  const app = loaded?.app;
  const mine = app && (!app.connection || app.connection === connectionId || app.connection === connectionName);
  if (!app || !mine) {
    return { connection: connectionId, app: null, ...(loadError ? { loadError } : {}) };
  }
  /* Resolved once per (definition, connection, catalog): every request used
     to re-parse every query and measure twice — once for the payload, once
     for the problems — which a wall-board on `refresh: 5` across ten tabs
     turned into steady work for nothing.

     Keyed on the definition object itself, not the LoadedApp around it: a
     request works on a copy of the host (handler.ts) and a projection of the
     definition (appProjection.ts), so a key on the wrapper never matched and
     every request rebuilt. The definition survives both — the projection is
     memoized to one object per principal shape — and a reload is a new one.
     The catalog is in the key by content (schemaStamp), so a refresh, or a
     principal who sees other columns, is another entry. */
  const stamp = `${connectionId}\n${schemaStamp(schema)}`;
  const held = payloadCache.get(app);
  const hit = held?.get(stamp);
  if (hit) {
    return { connection: connectionId, app: hit, ...(loadError ? { loadError } : {}) };
  }
  const served = servedApp(app, schema, loaded!.pages);
  /* Every problem the startup log and mistri check would name, carried to
     the one place the author is actually looking: the browser. The shell
     shows a quiet count; each line names its file and its fix. */
  // Branding is bound on the full server catalog, not on a principal's
  // narrowed presentation catalog. Its private binding diagnostics must not
  // disclose resource/column names through the browser's problems list.
  const { branding: _branding, ...publicUi } = app.ui;
  const problems = appProblems({ ...loaded!, app: { ...app, ui: publicUi } }, schema);
  const built: AppPayloadApp = {
    ...served,
    // The write scope is the route's to say, per reader (appProjection).
    ...(problems.length ? { problems } : {}),
    /* Where each custom component is served, for the page to load it the first time it is drawn. */
    ...(loaded!.components ? { components: componentHrefs(app.id, loaded!.components) } : {}),
  };
  /* A page's note names its icon too, and pages are answered by their own
     route (/api/pages): their glyphs ride here, where the shell learns every
     drawing it may need before a page asks. */
  const icons = iconGlyphsIn([built, loaded!.pages]);
  if (icons) built.icons = icons;
  const entries = held ?? new Map<string, AppPayloadApp>();
  if (!held) payloadCache.set(app, entries);
  // A handful of catalogs per definition — roles that see different columns — never one per request.
  if (entries.size >= PAYLOADS_PER_DEFINITION) entries.delete(entries.keys().next().value!);
  entries.set(stamp, built);
  return { connection: connectionId, app: built, ...(loadError ? { loadError } : {}) };
}

const PAYLOADS_PER_DEFINITION = 16;
const payloadCache = new WeakMap<AppDef, Map<string, AppPayloadApp>>();
const schemaStamps = new WeakMap<DatabaseSchema, string>();

/**
 * A catalog's content as a short digest: its read time, tables and keys.
 * Cached per catalog object, so the route that asks twice (the projection's
 * memo, then the payload's) serializes it once.
 */
export function schemaStamp(schema: DatabaseSchema): string {
  let stamp = schemaStamps.get(schema);
  if (stamp === undefined) {
    stamp = createHash('sha256')
      .update(JSON.stringify([schema.readAt, schema.label, schema.tables, schema.foreignKeys]))
      .digest('base64url');
    schemaStamps.set(schema, stamp);
  }
  return stamp;
}

/**
 * The app a running server serves, held so a reload can swap it in place.
 *
 * `app` and `pages` only ever hold a load that succeeded whole — a broken
 * save mid-edit must not take a working app down, because the authoring loop
 * this exists for (docs/apps.md) is someone saving every few seconds with the
 * browser open, and half of those saves are between two keystrokes.
 */
/**
 * The rule that keeps "which app answers here" a lookup, not a guess:
 * with one app, its scope is its own business (unscoped means every
 * connection, as always); with more than one, every app must name its
 * connection and no two may name the same one. Refused at startup with
 * the apps and the fix named, because two apps both claiming a
 * connection is a question the server must not answer by ordering.
 */
export function assertAppScopes(apps: LoadedApp[], resolve: (scope: string) => string = (s) => s): void {
  const ids = new Set<string>();
  for (const { app } of apps) {
    if (ids.has(app.id)) throw new Error(`App ID "${app.id}" is duplicated. Every app on this server must have a unique ID.`);
    ids.add(app.id);
  }
  const unscoped = apps.filter((x) => !x.app.connection);
  if (apps.length > 1 && unscoped.length) {
    throw new Error(
      `With more than one app, every app must name its "connection" — ${unscoped.map((x) => `"${x.app.name}" (${x.path})`).join(', ')} name${unscoped.length === 1 ? 's' : ''} none.`,
    );
  }
  /* Compared as the registry knows them, not as spelled: one app naming a
     connection by id and another by its name were two spellings of one
     scope, and both passed. `resolve` maps either spelling to the id. */
  const seen = new Map<string, LoadedApp>();
  for (const x of apps) {
    const bindings = x.app.sources
      ? Object.values(x.app.sources).map((source) => [source.connection, source.schema] as const)
      : x.app.connection
        ? [[x.app.connection, undefined] as const]
        : [];
    /* One App's sources may share a connection when each is scoped to a
       schema of its own (appResourceBlocks.ts); two Apps may not share one. */
    const schemas = new Map<string, Array<string | undefined>>();
    for (const [binding, schema] of bindings) {
      const scope = resolve(binding);
      const other = seen.get(scope);
      if (other && other !== x) {
        throw new Error(`"${other.app.name}" and "${x.app.name}" both claim connection "${binding}" — one connection, one app source.`);
      }
      const beside = schemas.get(scope) ?? [];
      if (beside.length && (!schema || beside.includes(undefined) || beside.includes(schema))) {
        throw new Error(
          `"${x.app.name}" binds connection "${binding}" to several sources; sources that share a connection each need a schema of their own.`,
        );
      }
      schemas.set(scope, [...beside, schema]);
      seen.set(scope, x);
    }
  }
}

/**
 * Which app answers for this connection: the one naming it (by id or
 * name), or the single unscoped app that answers for everyone. Pure, so
 * the picking rule is a test rather than a request.
 */
export function appForConnection<T extends { app: LoadedApp }>(
  hosts: T[],
  connectionId: string,
  connectionName: string | undefined,
): T | undefined {
  return hosts.find((h) => {
    const scope = h.app.app.connection;
    if (!scope) return hosts.length === 1;
    return scope === connectionId || scope === connectionName;
  });
}

/**
 * A refused write in the words of the App that answers for its connection
 * (http/writeRefusal.ts): never the config file, which its reader does not
 * own. Without role grants, a declared resource the App does not write is
 * said as the App's write scope, for its author; anything else answers as a
 * table that is not there.
 */
export function appWriteWording(hosts: AppHost[] | undefined): WriteWording {
  return (connection, name) => {
    const host = hosts?.length ? appForConnection(hosts, connection, name) : undefined;
    if (!host) return undefined;
    return {
      readOnly: 'This resource is read-only.',
      denied: (tableId, readable) =>
        !grantsByRole(host.app.app) && tableId !== undefined && readable
          ? writeScopeRefusal(host.app.app, tableId)
          : 'Access to this resource is denied.',
    };
  };
}

export interface AppHost {
  /** The app as last successfully loaded. */
  app: LoadedApp;
  /** Sign-in, when the manifest asks for it. See server/auth.ts. */
  auth?: import('../auth/auth.js').AppAuthRuntime;
  /** The config file's pages with the app's joined on, re-merged per reload. */
  pages: PageDef[];
  /** Why the latest reload failed, cleared by the next good one. */
  loadError?: string;
  /** What `loadError` was raised from, kept for its stack: the error's own place (appLive.ts). */
  loadFailure?: { of: string; error: unknown };
  /** `loadError` placed in the App's files, for the page's overlay; stale once `of` is not the current error. */
  loadProblem?: { of: string; problem: import('../../shared/appPayload.js').AppLoadProblem };
  /** Open pages told of each save: only a watched App's (cli/serve.ts, appLive.ts). */
  live?: import('./appLive.js').AppLive;
  /**
   * Set when a reload would change what the App grants or who may sign in
   * to it: every App request answers 503 with it until the server restarts,
   * and nothing reloads.
   * Serving the old authority after someone narrowed it, or the new one
   * before a restart, would each be wrong, so neither is served.
   */
  unavailable?: string;
}

/**
 * Re-run the loading path startup used and swap the host on success.
 *
 * A plain function rather than part of the watcher, so a test can exercise
 * the swap-or-keep decision without racing fs.watch. Both `app` and `pages`
 * move together, after everything that can throw has run: a reload that
 * updated the manifest but kept last save's pages would be a mixture neither
 * save described. On failure nothing moves but `loadError`, and the caller
 * decides what to say. Returns whether the swap happened.
 */
export async function reloadApp(host: AppHost, target: string, configPages: PageDef[], configPath?: string): Promise<boolean> {
  // Closed by an authority change: nothing reloads until a restart.
  if (host.unavailable) return false;
  try {
    const loaded = await loadApp(target, {
      entry: host.app.entry,
      env: host.app.env,
      ...(host.app.commands ? { commands: host.app.commands.file || host.app.commands.registry } : {}),
    });
    /* What a running server grants, and who may sign in to it, are what it
       started with (authorityLock.ts): its sign-in runtime was built for that
       App. A reload that would change either fails closed: the App's requests
       stop until a restart, serving neither the old nor the new. A row-policy
       App reloads under the same rule (cli/serve.ts starts its policy again
       for the new App); a tenant App restarts on any change but to its look (tenantLook.ts). */
    if (!isTenantApp(loaded.app)) {
      const signIn =
        !isDeepStrictEqual(signInOf(loaded.app.auth), signInOf(host.app.app.auth)) ||
        Boolean(host.app.app.auth && loaded.app.id !== host.app.app.id);
      const change = authorityChange(host.app, loaded);
      if (signIn || change) {
        host.unavailable = AUTHORITY_CHANGED;
        /* The operator's detail: the grants that moved, never the store's path. */
        host.loadError = [
          change ?? AUTHORITY_CHANGED,
          ...(signIn ? ['    The sign-in configuration changed: its providers, sign-up, default role, session store or App id.'] : []),
          '    What reloads and what needs a restart: `mistri docs reload-and-restart`.',
        ].join('\n');
        return false;
      }
    }
    const pages = mergeAppPages(configPages, loaded, configPath);
    host.app = loaded;
    host.pages = pages;
    host.loadError = undefined;
    host.loadFailure = undefined;
    return true;
  } catch (err) {
    host.loadError = (err as Error).message;
    host.loadFailure = { of: host.loadError, error: err };
    return false;
  }
}

/**
 * The directories an App's custom components were compiled from, for its
 * watcher: a save to a widget, or to a module or stylesheet it imports,
 * recompiles it (appComponents.ts) wherever in the App directory it lives.
 */
export function componentWatchDirs(loaded: LoadedApp): string[] {
  if (!loaded.dir || !loaded.components) return [];
  return [
    ...new Set(
      Object.values(loaded.components.entries).flatMap((entry) => entry.sources.map((source) => dirname(join(loaded.dir!, source)))),
    ),
  ];
}

/**
 * The directories an App's look is kept in beyond its root, watched so an edit
 * to a theme reloads the page as an edit to the manifest does: the folders its
 * themes' font files sit in (appFonts.ts), and a `theme/` or `themes/` folder
 * of theme modules (a palette per file) where the App keeps one.
 */
export function themeWatchDirs(loaded: LoadedApp): string[] {
  if (!loaded.dir) return [];
  const fonts = [...Object.values(loaded.fonts?.sources ?? {}), ...Object.values(loaded.brand?.sources ?? {})].map((source) =>
    dirname(join(loaded.dir!, source)),
  );
  const folders = ['theme', 'themes']
    .map((name) => join(loaded.dir!, name))
    .filter((folder) => {
      try {
        return statSync(folder).isDirectory();
      } catch {
        return false;
      }
    });
  return [...new Set([...fonts, ...folders])].filter((folder) => folder !== loaded.dir);
}

/* What a write to a database leaves in a directory: the file, and SQLite's journals beside it. */
const DATABASE_FILE = /(?:\.(?:db|db3|sqlite|sqlite3)|-(?:wal|shm|journal))$/i;
/* Code can be imported by anything the loader runs (the commands module, a component), so any module file is a change. */
const CODE_FILE = /\.[cm]?[jt]sx?$/i;
/* What the loader reads without importing: stylesheets, JSON, the authority lock, a theme's fonts, the App's pictures.
   Of these only a file beside a subfolder's others counts when the loader did not say it read it (below). */
const DATA_FILE = /\.(?:json|css|lock|woff2?|ttf|otf|png|jpe?g|webp|gif|avif|svg|ico)$/i;

/**
 * The files an App's load read, for its watcher: the manifest, each page's and catalog's file, the commands module,
 * the fonts and pictures it serves, the components' sources, and the module graph its definition, pages and catalogs
 * imported (`LoadedApp.modules`). Absolute paths. `undefined` when a module manifest's load gave no graph, and the
 * watcher then judges by file type alone.
 */
export function loadedFiles(loaded: LoadedApp): ReadonlySet<string> | undefined {
  // A module manifest whose load gave no graph cannot say what it imported: judged by file type, as before.
  if (!loaded.dir || (!loaded.modules && /\.(?:mjs|ts)$/.test(loaded.path))) return undefined;
  const home = loaded.dir;
  const within = (file: string) => resolve(home, file);
  return new Set(
    [
      loaded.path,
      ...(loaded.modules ?? []),
      ...Object.values(loaded.sources),
      ...(loaded.entry ? [loaded.entry] : []),
      ...(loaded.commands ? [loaded.commands.file] : []),
      ...(loaded.pageFiles ?? []).map(within),
      ...(loaded.messageFiles ?? []).map(within),
      ...Object.values(loaded.fonts?.sources ?? {}).map(within),
      ...Object.values(loaded.brand?.sources ?? {}).map(within),
      ...Object.values(loaded.components?.entries ?? {}).flatMap((entry) => entry.sources.map(within)),
    ].flatMap((file) => [resolve(file), real(file)]),
  );
}

/* A path as the loader sees it, links followed: a module graph is resolved to real paths, an event is named by the watched spelling. */
function real(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return resolve(file);
  }
}

/** The folders under the App holding a file its load imported, so a module in `lib/` is watched where it lives. */
function importedDirs(read: ReadonlySet<string> | undefined, root: string): string[] {
  if (!read) return [];
  // The graph is in real paths and the App may be named by a link to its folder: each file is placed under the spelling given.
  const placed = (file: string): string | undefined => {
    const base = [real(root), root].find((spelled) => file === spelled || file.startsWith(`${spelled}${sep}`));
    return base === undefined ? undefined : join(root, relative(base, file));
  };
  return [...new Set([...read].flatMap((file) => placed(dirname(file)) ?? []))].slice(0, 256);
}

/**
 * Whether a write to `file` can change what the App loads. A log, a database's journal, an editor's swap file and
 * a JSON the App's own process writes beside its source are not: reloading for them told every open page the App
 * had changed, in a loop when the file was written by the server itself (output redirected into the App folder).
 * What the loader read, or imported, is a change; so is any module file (the commands module's imports are not
 * followed), and a data file in a folder of the App's own — a new `pages/` entry, a font, a stylesheet — but not
 * one loose in its root, which is read only when the manifest says so, and is then in `read`.
 */
function movesApp(file: string, root: string, read: ReadonlySet<string> | undefined): boolean {
  const name = basename(file);
  if (DATABASE_FILE.test(name)) return false;
  if (read?.has(file) || read?.has(real(file))) return true;
  if (CODE_FILE.test(name)) return true;
  if (name === 'authority.lock' || name === 'mistri.json') return true;
  /* A name with no type is a folder made or taken away (its files are the ones that matter, and a removed one may have
     held some) unless it is a file there now: a log called `out`, `.DS_Store`, an editor's probe. */
  if (!extname(name)) {
    try {
      return !statSync(file).isFile();
    } catch {
      return true;
    }
  }
  return DATA_FILE.test(name) && (read === undefined || dirname(file) !== root);
}

export function watchApp(
  target: string,
  onChange: () => void,
  debounceMs = 150,
  extra: () => readonly string[] = () => [],
  /** The files the last load read (`loadedFiles`), asked on every event: a write to any other file the loader does not
      read by type (`movesApp`) is not a change to the App. */
  read: () => ReadonlySet<string> | undefined = () => undefined,
): () => void {
  const root = (() => {
    try {
      return statSync(target).isDirectory() ? resolve(target) : dirname(resolve(target));
    } catch {
      return dirname(resolve(target));
    }
  })();
  const watchers = new Map<string, FSWatcher>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const attach = (): void => {
    if (closed) return;
    let dirs: string[];
    try {
      dirs = statSync(target).isDirectory()
        ? [target, join(target, 'pages'), join(target, 'features'), ...extra(), ...importedDirs(read(), root)]
        : [dirname(target)];
    } catch {
      /* The target itself is gone. The last good app keeps serving; there is
         nothing left to watch until a restart points at something real. */
      return;
    }
    for (const [dir, watcher] of watchers) {
      /* A directory deleted out from under its watcher leaves the watcher
         alive and silent. Dropping it here lets the recreation re-attach. */
      try {
        statSync(dir);
      } catch {
        watcher.close();
        watchers.delete(dir);
      }
    }
    for (const dir of dirs) {
      if (watchers.has(dir)) continue;
      try {
        const watcher = watch(dir, (event, filename) => burst(event, filename, dir));
        watcher.on('error', () => {
          watcher.close();
          watchers.delete(dir);
        });
        watchers.set(dir, watcher);
      } catch {
        // pages/ is not there yet. Its creation is an event on the parent,
        // which lands back here.
      }
    }
  };

  const burst = (_event: string, filename: string | Buffer | null, dir: string): void => {
    /* Only a file the App loads is a change to it. A SQLite database kept beside the source is written by every save
       (and its -wal and -journal with it), and a server started with its output redirected into the App folder writes
       its log on every request: reloading on those told each open page the App had changed, and a record mid-edit lost
       its editor and its saved note. A burst that names no file still counts. */
    attach();
    if (typeof filename === 'string' && !movesApp(resolve(dir, filename), root, read())) return;
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      onChange();
    }, debounceMs);
  };

  attach();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  };
}
