/**
 * The app layer at startup: every `--app` and every directory the config's
 * "apps" names, loaded in order, their scopes checked against each other and
 * their searches against the configured services, and their pages merged
 * onto the config file's own.
 */
import { startupReport } from '@mistriwork/engine/shared/refusal.js';
import { relative, resolve } from 'node:path';
import { isPublicCommandPage, isTenantApp, problemsOf } from '../../shared/app.js';
import { ticketKeyStart } from '../forms/publicTicket.js';
import type { PageDef } from '@mistriwork/engine/shared/page.js';
import { refusalHeadline, refusalReasonsBelow } from '@mistriwork/engine/shared/refusal.js';
import { assertAppScopes, loadApp, mergeAppPages, type LoadedApp } from '../app/apps.js';
import { BUILD_ENTRY_KINDS, type BuildEntryKind } from '../app/appBuild.js';
import { assertAppSearch } from '../app/appSearchRuntime.js';
import { assertAppDialects } from '../app/appDialect.js';
import { configurePublicFormLimits } from '@mistriwork/engine/server/http/rateLimit.js';
import { configureSignInState } from '../auth/signInState.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import type { Options } from '@mistriwork/engine/server/cli/args.js';
import type { StartupConfig } from '@mistriwork/engine/server/cli/config.js';

/**
 * The variable a build's own `mistri check` child reads (build.ts): the App
 * directory the config lists that the `--app` build stands for, so the child
 * checks the build in its place instead of loading the source beside it.
 */
export const CHECK_BUILD_OF = 'MISTRI_CHECK_BUILD_OF';
import type { AppEnvName } from '../../shared/appAuthority.js';

/* A built App is started with the entries it was built with. The flag still
   names each one — an entry is never inferred from the App — but it must be
   the build's own bundle, so what runs is the code the build hashed and
   checked, and never TypeScript. A suite's App entry names them the same way (suiteCommand.ts). */
export function assertBuildEntries(opts: Partial<Record<BuildEntryKind, string>>, loadedApps: LoadedApp[]): void {
  for (const { build } of loadedApps) {
    if (!build) continue;
    for (const kind of BUILD_ENTRY_KINDS) {
      const given = opts[kind];
      if (given === undefined) continue;
      const own = build.entries[kind];
      if (!own)
        throw new Error(
          `${build.dir} was built without --${kind}, so it has no ${kind} entry. Rebuild it with mistri build --${kind} <file>.`,
        );
      if (resolve(given) !== own)
        throw new Error(`${build.dir} is a build: --${kind} must be its own ${relative(process.cwd(), own) || own}, not ${given}.`);
    }
  }
}

export interface StartupApps {
  loadedApps: LoadedApp[];
  /* The config file's own pages, before any app's join on. A reload
     re-merges against these — merging against the merged output would
     collide an app's pages with their own previous load. */
  pagesBeforeApp: PageDef[];
  /** Those pages with every app's merged on: what the server serves. */
  pages: PageDef[];
  loadOptions: { lock: 'report' | 'enforce' };
}

/**
 * The Apps a start loads: the config's "apps", then each --app. An --app
 * naming a directory the config already lists is that App, not a second
 * copy of it — the config is where its environment is written (`env`), and
 * `mistri check --app <dir>` beside it is the authoring loop. With one
 * App, --app-entry names its manifest. `builtFrom` is the listed directory a
 * build's own mistri check checks the build in place of (CHECK_BUILD_OF):
 * that entry is the --app build's, so the source is not loaded beside it.
 */
export function startupTargets(
  opts: Pick<Options, 'apps' | 'appEntry'>,
  config: Pick<StartupConfig, 'apps' | 'appEnv'>,
  builtFrom?: string,
): Array<{ target: string; env?: AppEnvName[]; entry?: string }> {
  const listed = builtFrom === undefined ? config.apps : config.apps.filter((dir) => resolve(dir) !== resolve(builtFrom));
  const targets: Array<{ target: string; env?: AppEnvName[]; entry?: string }> = listed.map((dir) => ({
    target: dir,
    ...(config.appEnv[dir] ? { env: config.appEnv[dir] } : {}),
  }));
  for (const dir of opts.apps ?? []) {
    if (!targets.some((listed) => resolve(listed.target) === resolve(dir))) targets.push({ target: dir });
  }
  if (opts.appEntry !== undefined) {
    if (opts.apps?.length !== 1 || targets.length !== 1) {
      throw new Error("--app-entry names the manifest of one App: give exactly one --app <dir>, the App's directory, beside it.");
    }
    targets[0].entry = opts.appEntry;
  }
  return targets;
}

export async function loadStartupApps(opts: Options, registry: Registry, config: StartupConfig): Promise<StartupApps> {
  /* The app layer. Loaded whether or not a config file was — `--app` is
     an explicit ask, and the config's "apps" list is the same ask written
     down. With more than one app, every app must name its connection and
     no two the same one (assertAppScopes) — connection switching is the
     app switcher, and a question with two answers is refused. Pages join
     the config pages in order; the manifests ride along for `/api/app`. */
  let appTargets: ReturnType<typeof startupTargets>;
  try {
    appTargets = startupTargets(opts, config, opts.checkApp ? process.env[CHECK_BUILD_OF] || undefined : undefined);
  } catch (err) {
    console.error(`App error: ${startupReport(err)}`);
    if (opts.embedded) throw err;
    process.exit(1);
  }
  const loadedApps: LoadedApp[] = [];
  const pagesBeforeApp = config.pages;
  let pages = config.pages;
  /* mistri check loads an App whose authority differs from its lock, to name the difference; nothing else does. */
  const loadOptions = { lock: opts.checkApp ? ('report' as const) : ('enforce' as const) };
  if (appTargets.length) {
    try {
      for (const { target, ...more } of appTargets) {
        /* --commands names the one --app's module; an App without it may keep commands.ts beside its manifest. */
        const own = opts.commands !== undefined && opts.apps?.length === 1 && resolve(opts.apps[0]) === resolve(target);
        const loaded = await loadApp(target, { ...loadOptions, ...more, ...(own ? { commands: opts.commands } : {}) });
        if (isTenantApp(loaded.app) && !opts.policy)
          throw new Error('Tenant applications are not enabled without explicit --policy enrollment.');
        loadedApps.push(loaded);
        console.log(
          `mistri: app "${loaded.app.name}" from ${loaded.path}` +
            `${loaded.build ? ` — a build by mistri ${loaded.build.mistri}, served as built: no reload` : ''}`,
        );
      }
      assertBuildEntries(opts, loadedApps);
      assertAppScopes(loadedApps, (scope) => registry.list().find((c) => c.id === scope || c.name === scope)?.id ?? scope);
      // An App runs on PostgreSQL or SQLite; MySQL/MariaDB is for browsing (appDialect.ts).
      assertAppDialects(
        loadedApps.map((loaded) => loaded.app),
        registry,
      );
      // A search names a search connection the config has; said here, not at the first keystroke.
      assertAppSearch(
        loadedApps.map((loaded) => loaded.app),
        registry,
      );
      /* A bucket without credentials refuses the start, as a missing secrets key does; mistri check says it. */
      const { bucketCredentialsProblem, probeBuckets } = await import('../files/fileStorage.js');
      const noBucket = bucketCredentialsProblem(loadedApps.map((loaded) => loaded.app));
      if (noBucket && !opts.checkApp) throw new Error(noBucket);
      if (noBucket) console.warn(`warning: ${noBucket}`);
      else if (!opts.checkApp) void probeBuckets(loadedApps.map((loaded) => loaded.app));
      /* With a cache named, public forms count their windows there, so every
         instance of the deployment spends one budget; without one, in this
         process, as before. Sign-in state (a status check's lockouts, its
         step-up sessions, an identity provider's step-up evidence) follows
         the same switch, so every instance honours what one decided. */
      const sharedCache = registry.serviceConfigs().some((service) => service.kind === 'cache');
      /* A public page's tickets are signed with the deployment's form key: several processes without one refuse each
         other's, so a start that knows it is one of several refuses, and a production one warns (forms/publicTicket.ts). */
      const ticketKey = ticketKeyStart({
        doors: loadedApps.some((loaded) => Object.values(loaded.app.views).some((view) => isPublicCommandPage(view))),
        shared: sharedCache,
        production: process.env.NODE_ENV === 'production' || loadedApps.some((loaded) => loaded.build),
      });
      if (ticketKey && 'refuse' in ticketKey && !opts.checkApp) throw new Error(ticketKey.refuse);
      if (ticketKey) console.warn(`warning: ${'refuse' in ticketKey ? ticketKey.refuse : ticketKey.warn}`);
      if (sharedCache) {
        const namespace = loadedApps.length === 1 ? loadedApps[0].app.id : 'deployment';
        configurePublicFormLimits(registry.cache(), namespace);
        configureSignInState(registry.cache(), namespace);
      }
      for (const loaded of loadedApps) {
        pages = mergeAppPages(pages, loaded, config.configPath);
      }
    } catch (err) {
      // Same contract as the config file: wrong is reported, never skipped.
      const problems = problemsOf(err);
      /* One refusal is said with its recorded cause, as a policy's is: "the commands module could not be loaded" alone
         sent the author (and a test host's error, which carries this log) to bisect a module the loader had read. */
      console.error(
        problems.length > 1
          ? `App error: ${problems.length} problems\n${problems.map((problem) => `  ${problem}`).join('\n')}`
          : `App error: ${refusalHeadline(err)}`,
      );
      if (problems.length === 1) for (const because of refusalReasonsBelow(err)) console.error(`  because: ${because}`);
      if (opts.embedded) throw err;
      process.exit(1);
    }
  }
  return { loadedApps, pagesBeforeApp, pages, loadOptions };
}
