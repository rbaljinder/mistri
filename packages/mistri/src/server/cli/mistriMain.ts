/**
 * The App framework's main: a start that serves, checks, exports or scaffolds an App, and the framework's own
 * commands (mistriCommands.ts). The `mistri` binary runs it (index.ts), and nothing else.
 *
 * Whatever is the database browser's alone — `--mcp`, `--lint`, `--diff`, the schema as md, mermaid or json, a
 * server with no App to serve — is refused with the `npx tablewalk` command that runs it. There is no handing over:
 * the database browser is a binary of its own, which this package neither imports nor installs.
 *
 * It orders a start — the flags checked against each other, the config and the Apps read, the named connection
 * opened — and hands it to the one mode asked for. Each mode is imported where the main reaches it:
 * test/cli-startup.test.ts counts what each start loads.
 */
import type { apiStartupEngine } from './api-read-startup-options.js';
import type { StartupApps } from './apps.js';
import { MISTRI_COMMANDS } from './mistriCommands.js';
import { MISTRI } from './usage.js';
import type { Main } from '@mistriwork/engine/server/cli/startup.js';
import { runSubcommand, subcommandIn } from '@mistriwork/engine/server/cli/subcommand.js';
import { setProduct } from '@mistriwork/engine/server/product.js';

/** The command line as it was typed, for the `npx tablewalk …` that runs it: each word quoted only where a shell needs it. */
const typed = (argv: readonly string[]) =>
  argv.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)).join(' ');

/**
 * Refuses a start that is the database browser's, naming the command that runs it. Exit 2, as a usage error; a
 * registry already open is closed first.
 */
async function refuseBrowser(what: string, argv: readonly string[], registry?: { closeAll(): Promise<void> }): Promise<void> {
  await registry?.closeAll();
  console.error(
    `mistri: ${what} is the database browser's, a command of its own: npx tablewalk ${typed(argv)}\n` +
      'mistri serves Apps; it browses no database without one.',
  );
  process.exitCode = 2;
}

export const main: Main = async () => {
  /* Before any flag is read: the variables both binaries read are said in this one's name (MISTRI_*). */
  setProduct('mistri');
  /* Nothing typed: the first screen, since a start with no App and nothing to do serves nothing here. */
  if (process.argv.length <= 2) {
    console.error(MISTRI.shortUsage);
    process.exitCode = 2;
    return;
  }
  if (process.argv[2] === 'schema' && (process.argv.includes('--help') || process.argv.includes('-h'))) {
    process.stdout.write((await import('./usage.js')).SCHEMA_USAGE);
    return;
  }
  /* `schema --brief` is the schema export in the form an agent's context wants: the same connection flags, read
     as `--export brief`. Only with the flag, so `./schema` still opens a SQLite file of that name. */
  if (process.argv[2] === 'schema' && process.argv.includes('--brief')) {
    process.argv = [...process.argv.slice(0, 2), ...process.argv.slice(3).filter((arg) => arg !== '--brief'), '--export', 'brief'];
  }
  const command = subcommandIn(MISTRI_COMMANDS, process.argv.slice(2));
  if (command) return runSubcommand(command, process.argv.slice(3), 'mistri');
  /* Past the commands, a start: what it needs is loaded now, and not for a command above. */
  const [{ CHECK_VALIDATION, parseArgs }, { configureWriteOrder }, { apiReadStartupOptions, appMcpStartupOptions, readAppMcpToken }] =
    await Promise.all([
      import('@mistriwork/engine/server/cli/args.js'),
      import('@mistriwork/engine/adapters/writeLanes.js'),
      import('@mistriwork/engine/server/cli/startupOptions.js'),
    ]);
  const [{ answeredFirst, configureProcess, startFor, SCHEMA_EXPORTS }, { packageVersion }, { USAGE }] = await Promise.all([
    import('@mistriwork/engine/server/cli/startup.js'),
    import('@mistriwork/engine/server/cli/usage.js'),
    import('./usage.js'),
  ]);
  /* `mistri dev`: the serve path below with a dev environment settled first (cli/devMode.ts), not a server of its own. */
  let dev: import('./devMode.js').DevSession | undefined;
  if (process.argv[2] === 'dev') {
    const { prepareDev, DevRefusal } = await import('./devMode.js');
    try {
      dev = prepareDev(process.argv.slice(3));
    } catch (error) {
      console.error(`mistri dev: ${(error as Error).message}`);
      process.exitCode = error instanceof DevRefusal ? 2 : 1;
      return;
    }
    process.argv.splice(2, Infinity, ...dev.argv);
  }
  /* `mistri serve --app …` read `serve` as the database to open, and the refusal that followed spoke of
     alternate modes. Serving is what a start does; a file called serve is still opened. */
  if (process.argv[2] === 'serve' && !(await import('node:fs')).existsSync('serve')) {
    console.error('mistri: there is no serve command: a start serves. Run mistri --app <dir> [--config <path>] …, or mistri dev <dir>.');
    process.exitCode = 2;
    return;
  }
  const opts = parseArgs(process.argv.slice(2));
  if (process.env[CHECK_VALIDATION] === '1') opts.checkApp = true;
  if (await answeredFirst(opts, MISTRI)) return;
  /* The database browser's modes, before anything is read: they open a database with no App, which is the
     database browser's to do. */
  const browsing = opts.mcp
    ? '--mcp'
    : opts.lint
      ? '--lint'
      : opts.diff
        ? '--diff'
        : opts.export !== undefined && SCHEMA_EXPORTS.has(opts.export.toLowerCase())
          ? `--export ${opts.export}`
          : undefined;
  if (browsing) return refuseBrowser(browsing, process.argv.slice(2));
  try {
    apiReadStartupOptions(opts);
  } catch (error) {
    console.error(`mistri: ${(error as Error).message}`);
    process.exit(1);
  }
  let appMcp: ReturnType<typeof appMcpStartupOptions>, credential: string | undefined;
  try {
    appMcp = appMcpStartupOptions(opts);
    // Taken before any config, App or command code is read: none of it can
    // find the token in the environment afterwards.
    if (appMcp) credential = readAppMcpToken(process.env);
  } catch (error) {
    console.error(`mistri: ${(error as Error).message}`);
    process.exit(1);
  }
  if (
    ['openapi', 'asyncapi'].includes(opts.export?.toLowerCase() ?? '') &&
    (opts.fromOpenapi !== undefined ||
      opts.openapi !== undefined ||
      opts.scaffoldApp !== undefined ||
      opts.checkApp ||
      opts.writeAuthority ||
      opts.reindex !== undefined ||
      opts.demo)
  ) {
    console.error(`mistri: --export ${opts.export!.toLowerCase()} cannot be combined with another startup, import or one-shot mode.`);
    process.exit(1);
  }
  /* A spec needs no connection, config or server: read it, print the
     drafted description, and stop, as --help does. */
  if (opts.fromOpenapi !== undefined) {
    const { draftFromOpenapi } = await import('@mistriwork/engine/server/openapiDraft.js');
    process.exitCode = await draftFromOpenapi(opts.fromOpenapi);
    return;
  }
  configureProcess(opts, 'mistri');
  /* Published at an https address, the server stands behind a TLS front end: its cookies are Secure, its answers pin
     https and the pages it writes name https, though the front end forwards plain http (trust.ts arrivedOverHttps). */
  if (process.env.MISTRI_PUBLIC_URL) {
    const [{ httpsAddress }, { configureServerSettings }] = await Promise.all([
      import('@mistriwork/engine/server/http/trust.js'),
      import('@mistriwork/engine/adapters/serverSettings.js'),
    ]);
    if (httpsAddress(process.env.MISTRI_PUBLIC_URL)) configureServerSettings({ httpsFront: true });
  }
  /* An App names its commands, so loading one reads its commands module:
     the HTTP runtime, mistri check and an export of an App. The modes that
     load no App take none. */
  if (opts.commands !== undefined && (!opts.commands || opts.commands.startsWith('-') || opts.scaffoldApp)) {
    console.error('mistri: --commands requires a file and an --app: the HTTP App runtime, mistri check or --export.');
    process.exit(1);
  }
  if (opts.jobs !== undefined) {
    const refusal =
      !opts.jobs || opts.jobs.startsWith('-') || (opts.export && opts.export.toLowerCase() !== 'asyncapi') || opts.scaffoldApp
        ? '--jobs requires a file and the HTTP App runtime (or mistri check).'
        : opts.apps?.length !== 1
          ? '--jobs requires exactly one explicit --app, whose commands the jobs run.'
          : undefined;
    if (refusal) {
      console.error(`mistri: ${refusal}`);
      process.exit(1);
    }
  }
  if (opts.writeAuthority && !opts.checkApp) {
    console.error("mistri: --write-authority works with mistri check, which writes each app's authority.lock.");
    process.exit(1);
  }
  if (opts.bump && (!opts.checkApp || opts.bump.some((name) => !/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)))) {
    console.error('mistri: --bump <command> works with mistri check (mistri check --bump <command>), naming a command of the App.');
    process.exit(1);
  }
  const nonPolicyMode = opts.export || opts.scaffoldApp;
  if (opts.policy !== undefined && (!opts.policy || opts.policy.startsWith('-') || nonPolicyMode)) {
    console.error('mistri: --policy requires a file and the HTTP App runtime (or mistri check).');
    process.exit(1);
  }
  /* In MCP mode stdout is the protocol channel; in export mode it is the
     document — `--export md >> CLAUDE.md` must append a brief, not a brief
     with a startup banner stapled to its forehead. Every startup line goes
     to stderr in both, redirected here, once, rather than guarded at each
     of the nine call sites. */
  /* The dev observer watches an HTTP server's requests; a mode that serves
     none has nothing for it to watch, and says so rather than start without it. */
  const noHttp = opts.appMcp
    ? '--app-mcp'
    : opts.export
      ? '--export'
      : opts.scaffoldApp
        ? '--scaffold-app'
        : opts.checkApp
          ? 'mistri check'
          : undefined;
  if (opts.dev && noHttp) {
    console.error(
      `mistri: --dev watches a running server's requests, and ${noHttp} serves none. Drop --dev; ` +
        '`mistri observe --mcp` reads a --dev server that is running.',
    );
    process.exit(2);
  }
  if (opts.appMcp || opts.export || opts.scaffoldApp || opts.checkApp) {
    console.log = (...args: unknown[]) => console.error(...args);
  }
  const [{ Registry, redact }, { readStartupConfig }, { configLocations }, { homeSourceOf, isRowPolicyApp, isTenantApp }] =
    await Promise.all([
      import('@mistriwork/engine/server/connections.js'),
      import('@mistriwork/engine/server/cli/config.js'),
      import('@mistriwork/engine/server/config/locations.js'),
      import('../../shared/appModel.js'),
    ]);
  const registry = new Registry();

  /* Config first, then the command line, so an explicitly named database is
     the one you land on even when a config file lists others. */
  const config = await readStartupConfig(opts, registry, async () => (await import('../serviceConnections.js')).CONFIG_SECTIONS);
  /* A server with no App to serve, from the command line or the config, is the database browser's, whose dispatcher
     (http/browserHandler.ts) is the one that manages connections: this one's is an App's. Said before an App or a
     connection is opened. */
  if (!config.apps.length && !opts.apps?.length && opts.appEntry === undefined && !dev && startFor(opts) !== 'mistri')
    return refuseBrowser('a server with no App', process.argv.slice(2), registry);
  /* Before any App opens a writer: a tenant App's is bound to live sync as it is made (tenantLive.ts). */
  if (opts.noLive) (await import('../live/liveBinding.js')).setLiveSync(false);
  /* The wait each database round trip is given, to feel a remote database in development (dbLatency.ts): before any
     App opens a connection, so none is leased without it. */
  /* `--dev` times its requests without MISTRI_SERVER_TIMING (serverTiming.ts): a cost line each, and a warning past the budget. */
  if (opts.dev) (await import('@mistriwork/engine/adapters/telemetry/serverTiming.js')).setServerTimingDev();
  const latency = await import('@mistriwork/engine/adapters/dbLatency.js');
  try {
    latency.configureDbLatency(opts.dbLatency);
  } catch (error) {
    console.error(`mistri: ${(error as Error).message}`);
    process.exitCode = 2;
    return;
  }
  /* An App's writes are ordered by record and run on a writer pool; the
     database browser's run one at a time, the order its Undo needs
     (writeLanes.ts). Decided on the names alone, before loading an App
     opens its first connection. */
  configureWriteOrder(config.apps.length || opts.apps?.length || opts.appEntry !== undefined ? 'keyed' : 'serial');
  const apps: StartupApps = await (await import('./apps.js')).loadStartupApps(opts, registry, config);
  const { loadedApps } = apps;
  try {
    if (loadedApps.some((loaded) => loaded.build)) latency.refuseForBuild();
  } catch (error) {
    console.error(`mistri: ${(error as Error).message}`);
    await registry.closeAll();
    process.exitCode = 2;
    return;
  }
  // Commands are hosted when the App was loaded with its module: --commands, or its commands.ts.
  const hasCommands = opts.commands !== undefined || loadedApps.some((loaded) => loaded.commands);
  if (opts.apiReads) {
    const { assertApiReadStartupComposition } = await import('./api-read-startup-options.js');
    try {
      assertApiReadStartupComposition(
        loadedApps,
        registry.configs(),
        hasCommands,
        opts.policy !== undefined,
        apiReadStartupOptions(opts)?.network === true,
      );
    } catch (error) {
      console.error(`API startup error: ${(error as Error).message}`);
      await registry.closeAll();
      process.exit(1);
    }
  }
  let appMcpEngine: ReturnType<typeof apiStartupEngine> | undefined;
  if (appMcp) {
    const { apiStartupEngine } = await import('./api-read-startup-options.js');
    try {
      appMcpEngine = apiStartupEngine(loadedApps, registry.configs(), hasCommands, '--app-mcp', opts.policy !== undefined);
    } catch (error) {
      console.error(`App MCP startup error: ${(error as Error).message}`);
      await registry.closeAll();
      process.exit(1);
    }
  }
  if (opts.checkApp && !opts.writeAuthority) {
    // A declared integration surface cannot probe data under unaccepted
    // exposure authority. Explicit --write-authority retains its normal flow.
    const { checkAuthorityLock } = await import('../app/authorityLock.js');
    for (const loaded of loadedApps.filter((loaded) => loaded.app.api)) {
      const lock = await checkAuthorityLock(loaded.authority, false);
      if (lock.problem) {
        console.error(lock.problem);
        await registry.closeAll();
        process.exit(1);
      }
    }
  }
  if (opts.writeAuthority && loadedApps.some((loaded) => loaded.build)) {
    console.error("mistri: a build's authority.lock is its source's. Write the lock in the App's directory, then rebuild.");
    await registry.closeAll();
    process.exit(1);
  }

  if (opts.reindex !== undefined) {
    const { reindexApps } = await import('./reindex.js');
    await reindexApps(registry, loadedApps, opts.reindex, opts.policy);
    return;
  }

  // A tenant App's MCP session has no listener: it enrolls the deployment
  // itself, as the tenant host does, and never reaches that host.
  if (appMcp && loadedApps.some((loaded) => isTenantApp(loaded.app))) {
    const { serveAppMcp } = await import('./appMcpMode.js');
    await serveAppMcp(opts, registry, loadedApps, {
      credential: credential!,
      integers: appMcp.integers,
      engine: appMcpEngine!,
      version: await packageVersion(),
    });
    return;
  }
  // A tenant App has a dedicated owner, never the ordinary registry adapter or
  // createApp fallback below. Refuse incompatible modes before data acquisition.
  if (loadedApps.some((loaded) => isTenantApp(loaded.app))) {
    const { serveTenantApp } = await import('./tenant.js');
    // `mistri dev`: once it answers, a sign-in per role, each a member where it works (cli/devMode.ts).
    dev?.serving(opts, loadedApps, registry);
    await serveTenantApp(opts, registry, config, apps, Boolean(nonPolicyMode));
    return;
  }

  // Before any print/export/tool path can open unrestricted application data.
  if (opts.policy !== undefined || loadedApps.some((loaded) => isRowPolicyApp(loaded.app))) {
    try {
      /* Types are generated from the App's declared resources and their
         configured schemas. They neither admit a principal nor load a policy,
         command module or auth store, so this one offline authoring step can
         describe a row-policy App without opening its private runtime. */
      const offlineTypes =
        opts.export?.toLowerCase() === 'types' && opts.policy === undefined && opts.apps?.length === 1 && loadedApps.length === 1;
      if (!offlineTypes && (!opts.policy || opts.apps?.length !== 1 || loadedApps.length !== 1 || nonPolicyMode)) {
        throw new Error('Row policies require --policy <file> and exactly one explicit --app in the HTTP runtime (or mistri check).');
      }
      if (!offlineTypes) {
        const { assertHttpRowPolicyApp } = await import('../policy/appPolicyHttp.js');
        assertHttpRowPolicyApp(loadedApps[0].app, hasCommands);
      }
    } catch (error) {
      console.error(`Policy startup error: ${(error as Error).message}`);
      await registry.closeAll();
      process.exit(1);
    }
  }

  /* `--demo`: a throwaway database, built on the fly, so a fresh install has
     something to walk without a database of its own. It is written into the
     OS temp directory, small and deterministic, and rebuilt each run (a few
     tens of milliseconds) so it never drifts from the schema this version
     knows. Naming a real target alongside it is a contradiction, so the target
     wins and the flag is ignored with a word rather than silently. */
  /* `--demo`: a throwaway database, built on the fly, so a fresh install has
     something to walk without a database of its own. It is written into the
     OS temp directory, small and deterministic, and rebuilt each run (a few
     tens of milliseconds) so it never drifts from the schema this version
     knows. Naming a real target alongside it is a contradiction, so the target
     wins and the flag is ignored with a word rather than silently. */
  if (opts.demo) {
    if (opts.target) {
      console.log(`mistri: ignoring --demo because a database was named (${redact(opts.target)}).`);
    } else {
      const { demoDatabaseFile, makeDemoDatabase, seedDemoDatabase } = await import('@mistriwork/engine/server/demo.js');
      const file = demoDatabaseFile();
      makeDemoDatabase(file);
      seedDemoDatabase(file, { scale: 150 });
      opts.target = file;
      /* Serving a demo without opening it would be handing someone a URL and
         hoping they paste it. The one mode where that is wrong is a
         print-and-exit or MCP run, which never opens anything. */
      if (!opts.export && !opts.scaffoldApp && !opts.checkApp) opts.open = true;
      console.log('mistri: built a demo database — 11 tables to walk. Nothing of yours is touched.');
    }
  }

  /* `--openapi`: an API as a connection, straight from its spec. A command-line
     connection like a named database, and the active one unless a database
     is named too; a spec that cannot be served is a startup error. */
  if (opts.openapi !== undefined) {
    try {
      const { openapiConnection } = await import('@mistriwork/engine/server/openapiDraft.js');
      const api = await openapiConnection(opts.openapi, { apiUrl: opts.apiUrl, tokenEnv: opts.apiTokenEnv });
      const added = registry.add({ ...api, writable: false, source: 'argument' });
      if (!opts.target) registry.setActive(added.id);
    } catch (error) {
      console.error(`mistri: --openapi ${(error as Error).message}`);
      await registry.closeAll();
      process.exit(1);
    }
  } else if (opts.apiUrl !== undefined || opts.apiTokenEnv !== undefined) {
    console.error('mistri: --api-url and --api-token-env go with --openapi.');
    process.exit(1);
  }

  if (opts.target) {
    /* A database named on the command line beside one App is that App's: named after the connection the App binds
       (its `connection`, or its one source's), not after the file. Named "shop.db", it left an App bound to "shop"
       with no database, which `startTestApp({ database })` met as a host that never became ready. */
    const bound = new Set(
      loadedApps.flatMap((loaded) => {
        const sources = Object.values(loaded.app.sources ?? {});
        return loaded.app.connection
          ? [loaded.app.connection]
          : sources.length === 1 && sources[0].connection
            ? [sources[0].connection]
            : [];
      }),
    );
    const owner = loadedApps.length === 1 && bound.size === 1 ? [...bound][0] : undefined;
    /* A database named on the command line is read-only, as everywhere: writes are a config's "writable": true. The
       one exception is a test host's (`startTestApp({ database })`, over a file the test owns or a copy of one): it
       is writable when its one App writes — a resource with access 'write', or commands — since an App that writes
       refuses to start over a read-only source, and a test of it has no config to say otherwise. */
    const testWrites =
      process.env.NODE_ENV === 'test' &&
      process.env.MISTRI_TEST_DATABASE === 'app-writes' &&
      owner !== undefined &&
      ((await import('../../shared/appModel.js')).resourceCeiling(loadedApps[0].app).write.length > 0 ||
        Object.keys(loadedApps[0].commands?.registry ?? {}).length > 0);
    const added = registry.add({
      name: opts.demo ? 'demo' : owner && !registry.list().some((c) => c.id === owner || c.name === owner) ? owner : redact(opts.target),
      url: opts.target,
      schemas: opts.schemas,
      ...(testWrites ? { writable: true } : {}),
      source: 'argument',
    });
    registry.setActive(added.id);
  }

  /**
   * Nothing named a database.
   *
   * Every mode below except the server needs one before it can do anything at
   * all: `--export` describes an App over its database, `--scaffold-app` drafts
   * one from it, and `mistri check` validates against it. There is nothing for
   * them to start without — so those still stop here, with the usage and the
   * list of places a config was looked for.
   *
   * The server does not, and used to. Someone running `mistri` for the
   * first time, having installed it to find out what it is, got a wall of
   * flags and no program — while the thing that would have answered their
   * question, a dialog that takes a connection and tests it before keeping
   * it, was already built and sitting one successful startup away. The
   * browser can ask. So it starts, and asks.
   */
  const nothingToOpen = !registry.list().length;
  if (nothingToOpen && (opts.export || opts.scaffoldApp || opts.checkApp)) {
    console.log(USAGE);
    console.log(`\nLooked for a config file in:\n  ${configLocations(opts.config).join('\n  ')}`);
    process.exit(1);
  }

  /* The active connection is opened eagerly so a bad target is a startup
     error with a clear message rather than a broken page. The rest stay
     closed until someone selects them — naming eight databases should not
     mean dialling eight databases. Explicit API serving validates its exact
     App source instead; the active browser connection may be unrelated. */
  if (
    !nothingToOpen &&
    !opts.apiReads &&
    !opts.appMcp &&
    !(
      ['openapi', 'asyncapi'].includes(opts.export?.toLowerCase() ?? '') ||
      ((opts.export?.toLowerCase() === 'types' || opts.checkApp) && loadedApps.length)
    )
  ) {
    const activeId = registry.active!;
    try {
      const { schema } = await registry.open(activeId);
      console.log(
        `mistri: ${schema.label} (${schema.dialect}) — ${schema.tables.length} tables, ${schema.foreignKeys.length} foreign keys`,
      );
    } catch (err) {
      console.error(`Could not open the active connection:`);
      console.error(`  ${(err as Error).message}`);
      process.exit(1);
    }
  }

  /* The print-and-exit modes, in the order they always took precedence. */
  if (opts.export) {
    const { exportSchema } = await import('./oneShot.js');
    await exportSchema(opts.export, registry, loadedApps, opts.apiIntegers, opts.commands, opts.jobs);
    return;
  }
  if (opts.scaffoldApp) {
    const { scaffoldApp } = await import('./oneShot.js');
    await scaffoldApp(opts.scaffoldApp, opts, registry);
    return;
  }

  /* Commands and jobs before mistri check, which attests them, and before the
     server, which serves them. */
  // API exposure is an opt-in contract, not an asynchronous UI warning. Its
  // logical catalog must validate before any serving mode becomes available.
  // App loading has already enforced its authority lock before database I/O.
  if (!opts.checkApp && loadedApps.some((loaded) => loaded.app.api)) {
    const { loadAppRuntimeResources } = await import('../app/appRuntimeResources.js');
    try {
      for (const loaded of loadedApps.filter((loaded) => loaded.app.api)) {
        if (opts.apiReads || opts.appMcp) {
          const app = loaded.app;
          const reference = app.sources ? app.sources[homeSourceOf(app)!]?.connection : app.connection;
          const matches = registry
            .list()
            .filter((connection) => reference === undefined || connection.id === reference || connection.name === reference);
          if (matches.length !== 1) throw new Error('API application entry connection is unavailable or ambiguous.');
          await loadAppRuntimeResources(registry, app, matches[0].id);
          continue;
        }
        const scoped = loaded.app.connection;
        const match = registry.list().find((connection) => connection.id === scoped || connection.name === scoped);
        if (scoped && !match) throw new Error('API application entry connection is unavailable.');
        await loadAppRuntimeResources(registry, loaded.app, match?.id ?? registry.active!);
      }
    } catch (error) {
      console.error(`API startup error: ${(error as Error).message}`);
      await registry.closeAll();
      process.exit(1);
    }
  }
  // Before the shared command host: App MCP hosts commands only when given them.
  if (appMcp) {
    const { serveAppMcp } = await import('./appMcpMode.js');
    await serveAppMcp(opts, registry, loadedApps, {
      credential: credential!,
      integers: appMcp.integers,
      engine: appMcpEngine!,
      version: await packageVersion(),
    });
    return;
  }
  const { hostCommands } = await import('./commandHost.js');
  const hosted = await hostCommands(opts, registry, loadedApps);

  if (opts.checkApp) {
    const { checkApps } = await import('./oneShot.js');
    await checkApps(opts, registry, loadedApps, hosted);
    return;
  }
  const { serveHttp } = await import('./serve.js');
  dev?.serving(opts, loadedApps, registry);
  await serveHttp(opts, registry, config, apps, hosted, nothingToOpen);
};
