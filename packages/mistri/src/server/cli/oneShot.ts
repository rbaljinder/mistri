/**
 * The App framework's modes that answer and exit rather than serve: --export
 * of an App's types and contracts, --scaffold-app and mistri check (the
 * database browser's — --diff, --lint, a schema in words — are in
 * databaseOneShot.ts). Each is a build step — its answer
 * on stdout, every startup line already sent to stderr — and a build step
 * that starts a web server is one nobody wires into CI.
 */
import { learnValueLabels } from '../app/valueLabels.js';
import { startupReport } from '@mistriwork/engine/shared/refusal.js';
import { fontWarnings } from '../app/appFonts.js';
import { themeBandWarnings, themeShadowWarnings, themeShapeWarnings, themeTypeWarnings } from '@mistriwork/engine/shared/theme.js';
import { brandWarnings } from '../app/appBrand.js';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { type Registry } from '@mistriwork/engine/server/connections.js';
import { labelColumn, primaryKey, tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { isRuntimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import {
  appRollupRules,
  homeSourceOf,
  grantsByRole,
  logicalResource,
  resolveAppAccess,
  withRollups,
  type AppDef,
} from '../../shared/app.js';
import { appAdvisories, appProblems, type LoadedApp } from '../app/apps.js';
import { appRoleReach, appRoleWarnings } from '../app/appRoleChecks.js';
import { commandRestatedWarnings } from '../commands/commandRestated.js';
import { consumesCommandWarnings, machineCommandWarnings } from '../app/appMachineChecks.js';
import { appIndexWarnings } from '../../shared/appIndexWarnings.js';
import { appSignUpProblems } from '../../shared/appWarnings.js';
import { checkAuthorityLock } from '../app/authorityLock.js';
import { CONTRACT_PREFIX, contractDigest, contractLines, lockedContracts } from '../commands/commandContracts.js';
import { WORKFLOW_LINE_PREFIX, workflowLines } from '../workflows/workflowContracts.js';
import type { WorkflowShape } from '../workflows/workflowProbe.js';
import { accessibleSchema } from '../app/appAccess.js';
import { appSourceConnections, loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import { assertAppApiContext, readApiApp } from '../api/appApiValidation.js';
import { apiExposesCommands } from '../../shared/appApi.js';
import { checkApiReadCatalog } from '../api/apiReadCatalog.js';
import { loadHttpAppPolicy } from '../policy/appPolicyHttp.js';
import type { Options } from '@mistriwork/engine/server/cli/args.js';
import type { CommandHost } from './commandHost.js';
import { unofferedCommandWarnings } from '../app/appCommandOfferChecks.js';
import { policyStartupLines } from './policyStartup.js';
import { identityProblems } from '../auth/identityConfig.js';
import { embedProblems } from '../embed/issuerConfig.js';
import { scimProblems } from '../auth/scimConfig.js';
import { oauthProblems } from '../api/oauthConfig.js';
import { emailConfigOf, embedIssuersOf, identityProvidersOf, oauthServerOf, scimDirectoriesOf } from '../serviceConnections.js';
import { commandsOf } from '../stores/commandStores.js';

/* Print and exit: the same text the browser's Export menu downloads,
   importable here because the converters are pure — a schema in, text
   out. `mistri --export md >> CLAUDE.md` is the whole workflow this
   exists for: an agent's next session starts oriented for zero calls. */
/**
 * `--export types` for one App: its resources in its connections' names. One
 * function for the flag and for `mistri build`, which writes the same
 * file into a build.
 */
export async function appTypes(registry: Registry, app: LoadedApp): Promise<string> {
  const scope = app.app.connection;
  const source = scope ? registry.list().find((connection) => connection.id === scope || connection.name === scope) : undefined;
  if (scope && !source) throw new Error(`App "${app.app.name}" names connection "${scope}", which is not configured.`);
  const { schema: whole } = await loadAppRuntimeResources(registry, app.app, source?.id ?? registry.active!);
  return typesOfApp(
    app.app,
    whole,
    registry.list().map((connection) => connection.name),
  );
}

/**
 * The generated types of an App over its catalog. An App is typed to what it
 * serves — its declared resources, and with role grants what any role can
 * reach — so bookkeeping that lives beside them (a migration marker, say)
 * stays out of the generated Tables the way it stays out of every read. A
 * declared resource no role reads is still typed: a tenant App declares
 * every table, and a table only commands write is one a handler names. A
 * column no reader is served is typed apart (`Hidden`), never dropped: the
 * App's own `hidden` and access rules name it, and a handler's `Rows` read
 * it. The connection's whole schema is `--export types` without --app.
 */
export async function typesOfApp(app: AppDef, whole: DatabaseSchema, connections: readonly string[]): Promise<string> {
  const access = resolveAppAccess(app, whole, grantsByRole(app) ? Object.keys(app.auth!.roles!) : []);
  const served = accessibleSchema(whole, access);
  const declared = new Set(
    Object.keys(app.resources ?? {}).flatMap(
      (name) => (whole.tables.find((table) => table.id === name) ?? tableNamed(whole, name))?.id ?? [],
    ),
  );
  const ids = new Set([...served.tables.map((table) => table.id), ...declared]);
  const hiddenOf = (id: string) =>
    new Set(
      Object.entries(app.resources ?? {})
        .filter(([name]) => (whole.tables.find((table) => table.id === name) ?? tableNamed(whole, name))?.id === id)
        .flatMap(([, resource]) => resource.hidden ?? []),
    );
  /* What a reader may be served of each table: what the grants resolve to,
     or for a table no role reads, every column but its `hidden` ones. */
  const hidden: Record<string, string[]> = {};
  const tables = whole.tables
    .filter((table) => ids.has(table.id))
    .map((table) => {
      const shown = served.tables.find((candidate) => candidate.id === table.id);
      const cut = shown
        ? new Set(table.columns.map((column) => column.name).filter((name) => !shown.columns.some((column) => column.name === name)))
        : hiddenOf(table.id);
      if (cut.size) hidden[table.id] = table.columns.map((column) => column.name).filter((name) => cut.has(name));
      return table;
    });
  const all: DatabaseSchema = {
    ...whole,
    tables,
    foreignKeys: whole.foreignKeys.filter((fk) => ids.has(fk.from.table) && ids.has(fk.to.table)),
  };
  const shown: DatabaseSchema = {
    ...all,
    tables: tables.map((table) => ({ ...table, columns: table.columns.filter((column) => !hidden[table.id]?.includes(column.name)) })),
    foreignKeys: all.foreignKeys.filter((fk) => !fk.from.columns.some((column) => hidden[fk.from.table]?.includes(column))),
  };
  /* A rollup that does not resolve is refused here rather than typed as
     absent: a page naming it then failed the typecheck with "not a column",
     far from the cause (two references and no `whose`, say). One that
     resolves over every column but not over what readers are served reads
     a column no reader is served, so it is never served either. */
  const { rules, problems } = appRollupRules(app, all);
  if (problems.length) throw new Error(`App "${app.name}": ${problems.join('\n')}`);
  const reachable = appRollupRules(app, shown).rules;
  const unserved = [...rules].flatMap(([table, made]) =>
    Object.keys(made)
      .filter((key) => !reachable.get(table)?.[key])
      .map((key) => `resources "${tables.find((candidate) => candidate.id === table)!.name}", rollups "${key}"`),
  );
  if (unserved.length) {
    throw new Error(
      `App "${app.name}": ${unserved.join(', ')} ${unserved.length === 1 ? 'reads' : 'read'} a column or reference no reader is served ` +
        "(`hidden`, or outside every role's `fields`), so no reader is ever served it. Count a column readers are served, or drop the rollup.",
    );
  }
  /* Rollups, computed columns and tags all: each reads like a column wherever one is shown or queried, and a
     computed column missing here made the typed query checker (packages/mistri/schema/query.d.ts) refuse a tab that names it. */
  const typed = withRollups(app, shown);
  /* A computed column whose own expression is refused is still typed by the kind it declares, a refused segment by
     its name and refused tags as tags: validation says the one problem, and the pages and tabs that name them are not
     each a "not a column" beside it (a segment named like a query word, refused on upgrade, dropped every tab's
     type). One left out because it reads a column no reader is served stays out, as the reader is never served it. */
  const judged = withRollups(app, all);
  const declaredOf = (id: string) =>
    Object.entries(app.resources ?? {}).find(
      ([name]) => (whole.tables.find((t) => t.id === name) ?? tableNamed(whole, name))?.id === id,
    )?.[1];
  const refused = (id: string) => {
    const declared = declaredOf(id);
    const fair = judged.tables.find((t) => t.id === id);
    return {
      computed: Object.fromEntries(
        Object.entries(declared?.computed ?? {})
          .filter(([name]) => !fair?.computed?.[name])
          .map(([name, said]) => [name, { type: said.type, expr: { k: 'nobody' as const }, reads: [] }]),
      ),
      segments: Object.fromEntries(
        Object.entries(declared?.segments ?? {})
          .filter(([name]) => !fair?.segments?.[name])
          .map(([name, said]) => [name, said.query]),
      ),
      // Only whether a table has tags is typed (typegen.ts), so the rule that did not resolve stands as its two tables.
      tags:
        declared?.tags && !fair?.tags
          ? { through: declared.tags.through, to: declared.tags.to, from: '', key: '', via: '', tagKey: '', label: '' }
          : undefined,
    };
  };
  const withTyped: DatabaseSchema = {
    ...all,
    tables: tables.map((table) => {
      const made = typed.tables.find((candidate) => candidate.id === table.id);
      const kept = refused(table.id);
      const computed = { ...kept.computed, ...made?.computed };
      // A segment is a word a typed query may say; one no reader is served is not typed.
      const segments = { ...kept.segments, ...made?.segments };
      const tags = made?.tags ?? kept.tags;
      return {
        ...table,
        ...(made?.rollups ? { rollups: made.rollups } : {}),
        ...(Object.keys(computed).length ? { computed } : {}),
        ...(tags ? { tags } : {}),
        ...(Object.keys(segments).length ? { segments } : {}),
      };
    }),
  };
  // An App binds connections by name; the standalone export is one connection's schema.
  return (await import('../typegen.js')).typesForSchema(withTyped, app.name, connections, hidden);
}

/** Local operator metadata only: neither a caller principal nor a served API.
 * The runtime loader enforces context/catalog refusals before rendering. */
export async function appOpenApi(registry: Registry, loadedApps: LoadedApp[], integers?: string, commandsFile?: string): Promise<string> {
  if (loadedApps.length !== 1 || !loadedApps[0].app.api) {
    throw new Error('--export openapi requires exactly one App with an explicit api declaration.');
  }
  if (integers !== 'number' && integers !== 'decimal-string') throw new Error('Choose --api-integers decimal-string or number.');
  const loaded = loadedApps[0];
  const lock = await checkAuthorityLock(loaded.authority, false);
  if (lock.problem) throw new Error(lock.problem);
  // Command code loads only when asked for, and only for an App that exposes
  // commands — decided before any data is acquired or module imported.
  const exposed = apiExposesCommands(loaded.app.api);
  const loadedCommands = loaded.commands?.registry;
  if (exposed && !loadedCommands && commandsFile === undefined) {
    throw new Error(
      'This App exposes API commands: --export openapi needs its commands module, commands.ts beside the manifest or --commands <file>.',
    );
  }
  // The read foundation and catalog refuse command exposures; commands are
  // described separately below, so they check the App with commands projected
  // out. Tenant and multi-source refusals still apply; a row-policy App's document is its catalog's, as served.
  const readApp = readApiApp(loaded.app);
  assertAppApiContext(readApp);
  const scope = loaded.app.connection;
  const matches = scope ? registry.list().filter((connection) => connection.id === scope || connection.name === scope) : [];
  if (scope && matches.length !== 1) throw new Error(`App "${loaded.app.name}" names an unconfigured or ambiguous connection.`);
  const source = matches[0];
  const entry = loaded.app.sources
    ? appSourceConnections(registry, loaded.app).get(homeSourceOf(loaded.app)!)!
    : (source?.id ?? registry.active!);
  const runtime = await loadAppRuntimeResources(registry, readApp, entry);
  const problems = appProblems(loaded, runtime.schema);
  if (problems.length) throw new Error(problems.join('\n'));
  checkApiReadCatalog(readApp.api!, readApp, runtime.schema);
  /* A composite key is one path parameter, an object serialized the standard
     way (style simple, explode true: `id=7,part=a`); the document says so on
     the parameter, as the served one does. A generated client must be given
     that serializer, and mistri's own OpenAPI importer skips such a
     resource rather than misreading it. */
  const { renderAppApiOpenApi } = await import('../api/apiPublicSpec.js');
  if (!exposed) return JSON.stringify(renderAppApiOpenApi(loaded.app, runtime.schema, { integers }), null, 2);
  const { loadBusinessCommands } = await import('../commands/businessCommandLoader.js');
  const commands = loadedCommands ?? (await loadBusinessCommands(commandsFile!));
  // The same trusted binding facts the command owner hands the catalog.
  const evidence = {
    connectionFor: runtime.connectionFor,
    writableConnection: (id: string) => registry.configOf(id)?.writable === true,
    transactionalConnection: (id: string) => !!commandsOf(runtime.forConnection(id)).commandTransaction,
  };
  return JSON.stringify(renderAppApiOpenApi(loaded.app, runtime.schema, { integers, commands, evidence }), null, 2);
}

/** The App's event-driven surface as AsyncAPI 3.0 (apiAsyncApi.ts): its feed
 * events, the webhooks its commands post to and, with `--jobs`, the signed
 * inbound endpoints that run them. The operator's whole document, unnarrowed
 * by any token; no data is read. */
async function appAsyncApi(loadedApps: LoadedApp[], integers?: string, commandsFile?: string, jobsFile?: string): Promise<string> {
  if (loadedApps.length !== 1 || !loadedApps[0].app.api) {
    throw new Error('--export asyncapi requires exactly one App with an explicit api declaration.');
  }
  if (integers !== 'number' && integers !== 'decimal-string') throw new Error('Choose --api-integers decimal-string or number.');
  const loaded = loadedApps[0];
  const lock = await checkAuthorityLock(loaded.authority, false);
  if (lock.problem) throw new Error(lock.problem);
  const [{ loadBusinessCommands }, { renderApiAsyncApi }, { apiEventProblems }] = await Promise.all([
    import('../commands/businessCommandLoader.js'),
    import('../api/apiAsyncApi.js'),
    import('../api/apiEventFeed.js'),
  ]);
  const commands = loaded.commands?.registry ?? (commandsFile === undefined ? undefined : await loadBusinessCommands(commandsFile));
  const problems = apiEventProblems(loaded.app, commands);
  if (problems.length) throw new Error(problems.join(' '));
  const inbound = jobsFile === undefined ? undefined : (await (await import('../jobs/jobLoader.js')).loadJobModule(jobsFile)).inbound;
  return JSON.stringify(renderApiAsyncApi(loaded.app, commands, { integers, ...(inbound ? { inbound } : {}) }), null, 2);
}

export async function exportSchema(
  given: string,
  registry: Registry,
  loadedApps: LoadedApp[],
  integers?: string,
  commandsFile?: string,
  jobsFile?: string,
): Promise<void> {
  const format = given.toLowerCase();
  try {
    if (jobsFile !== undefined && format !== 'asyncapi') throw new Error('--jobs runs with --export asyncapi only, of the exports.');
    if (format === 'asyncapi') {
      process.stdout.write(`${await appAsyncApi(loadedApps, integers, commandsFile, jobsFile)}\n`);
      return;
    }
    if (format === 'openapi') {
      process.stdout.write(`${await appOpenApi(registry, loadedApps, integers, commandsFile)}\n`);
      return;
    }
    if (format === 'types' && loadedApps.length > 1) {
      throw new Error(
        '--export types needs one app, but multiple apps are loaded. Use a config containing one app, or pass --app <dir> with a connection-only config.',
      );
    }
    if (format === 'types' && loadedApps.length) {
      // The file `check` writes, byte for byte, so `> mistri-schema.d.ts` is one check and build agree with.
      process.stdout.write((await import('../typegen.js')).typesFileText(await appTypes(registry, loadedApps[0])));
      return;
    }
    const { schema } = await registry.open(registry.active!);
    // md, mermaid and json are the database browser's (databaseOneShot.ts), and its main answers them.
    const text =
      format === 'brief'
        ? (await import('../../shared/schemaBrief.js')).toBrief(schema)
        : format === 'types'
          ? (await import('../typegen.js')).typesForSchema(schema)
          : null;
    if (text === null) throw new Error(`--export takes md, mermaid, json, brief, types, openapi or asyncapi — not "${given}".`);
    process.stdout.write(format === 'types' ? (await import('../typegen.js')).typesFileText(text) : `${text}\n`);
  } catch (error) {
    console.error(`mistri: ${startupReport(error)}`);
    process.exitCode = 1;
  } finally {
    await registry.closeAll();
  }
}

/**
 * The would-be name columns (labelColumn) a sample of each table's rows finds
 * empty in every row, as `table.column` by the App's name for the table: the
 * scaffold names those records by their noun and key instead. A table that
 * cannot be sampled keeps its column.
 */
async function sampledEmptyColumns(
  registry: Registry,
  connection: string,
  schema: DatabaseSchema,
  logical: (id: string) => string,
  into = new Set<string>(),
): Promise<Set<string>> {
  const { adapter } = await registry.open(connection);
  for (const table of schema.tables) {
    const column = labelColumn(table);
    if (!column || primaryKey(table).includes(column)) continue;
    try {
      const sample = await adapter.query({ table: table.id, columns: [column], limit: 200, offset: 0 });
      if (
        sample.rows.length &&
        sample.rows.every((row) => row[column] === null || row[column] === undefined || String(row[column]).trim() === '')
      ) {
        into.add(`${logical(table.id)}.${column}`);
      }
    } catch {
      /* unsampled: its column stands */
    }
  }
  return into;
}

/* The schemas a draft makes a source of, in the order a person reads them:
   the engine's default schema first. Only engines with schemas have them. */
function draftedSchemas(schema: DatabaseSchema): string[] {
  if (schema.dialect !== 'postgres' && schema.dialect !== 'mysql') return [];
  const found = [...new Set(schema.tables.filter((table) => !isRuntimeTable(table.name)).map((table) => table.schema))]
    .filter(Boolean)
    .sort();
  return found.includes('public') ? ['public', ...found.filter((name) => name !== 'public')] : found;
}

/** A connection's name as a source name: an identifier, as `sources` keys must be. */
const sourceName = (name: string) =>
  name
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(?=[0-9])/, '_') || 'source';

/* Draft and exit, like --lint: a build step, not a server. The drafting
 *and* the writing live in scaffold.ts; this is a front door. */
export async function scaffoldApp(into: string, opts: Options, registry: Registry): Promise<void> {
  const { writeScaffold, shownPath } = await import('../scaffold.js');
  const { appResourceCatalog } = await import('../app/appResources.js');
  const { schemaScoped } = await import('../app/appSourceCatalog.js');
  const { qualifyResource } = await import('../../shared/app.js');
  const { schema } = await registry.open(registry.active!);
  const dir = resolve(into);
  const active = registry.list().find((connection) => connection.id === registry.active);
  /* How the project reaches its database, said without a secret and from the
     App's own directory: the config file, or an absolute SQLite path in
     mistri.json so an explicit --config works from another directory.
     A URL can carry a password, so it is left for the author to supply. */
  const from = (path: string) => {
    const near = relative(dir, resolve(path)) || '.';
    return near.startsWith('.') || isAbsolute(near) ? near : `./${near}`;
  };
  const database = opts.config
    ? { config: from(opts.config) }
    : !opts.target || /^[a-z][a-z0-9+.-]*:\/\//i.test(opts.target)
      ? undefined
      : { sqlite: resolve(opts.target.replace(/^sqlite:(\/\/)?/i, '')) };
  /* A config naming several connections is drafted as one App over all of
     them: a source per connection, the active one the default whose tables
     stay bare, the others named `source.table`. A PostgreSQL or MySQL
     connection holding tables in several schemas is a source per schema on
     that one connection (`schema:`), never the same URL configured again. */
  const configured = registry.list().filter((connection) => connection.source === 'config');
  let sources: Array<{ name: string; connection: string; schema: DatabaseSchema; writable: boolean; scope?: string }> | undefined;
  const emptyColumns = new Set<string>();
  try {
    const units: NonNullable<typeof sources> = [];
    if (active?.source === 'config') {
      const ordered = [active, ...configured.filter((connection) => connection.id !== active.id)];
      const taken = new Set<string>();
      const named = (wanted: string) => {
        let name = sourceName(wanted);
        for (let n = 2; taken.has(name); n++) name = `${sourceName(wanted)}_${n}`;
        taken.add(name);
        return name;
      };
      for (const connection of ordered) {
        const opened = await registry.open(connection.id).catch(() => {
          const file = registry.sqliteFile(connection.id);
          throw new Error(
            `the database of connection "${connection.name}" could not be opened${file ? ` (tried the SQLite file ${file})` : ''}`,
          );
        });
        const writable = registry.configOf(connection.id)?.writable === true;
        const schemas = draftedSchemas(opened.schema);
        if (schemas.length > 1) {
          for (const scope of schemas)
            units.push({ name: named(scope), connection: connection.name, schema: opened.schema, writable, scope });
        } else units.push({ name: named(connection.name), connection: connection.name, schema: opened.schema, writable });
      }
    }
    if (units.length > 1) {
      sources = units;
      for (const source of sources) {
        const seen = source.scope ? schemaScoped(source.schema, source.scope) : source.schema;
        const catalog = appResourceCatalog(seen);
        /* A name nobody filled in names nothing: sampled per source, said by the App's name for the table. */
        await sampledEmptyColumns(
          registry,
          configured.find((c) => c.name === source.connection)!.id,
          seen,
          (id) => qualifyResource(sources![0].name, source.name, catalog.toLogical(id)),
          emptyColumns,
        );
      }
    } else {
      const catalog = appResourceCatalog(schema);
      await sampledEmptyColumns(registry, registry.active!, schema, (id) => catalog.toLogical(id), emptyColumns);
    }
  } catch (err) {
    console.error(`mistri: ${startupReport(err)}`);
    process.exit(1);
  }
  let made;
  try {
    made = await writeScaffold(schema, dir, {
      ...(opts.name ? { name: opts.name } : {}),
      // An App binds a configured connection by its name; a command-line target has no name worth writing.
      connection: active?.source === 'config' ? active.name : undefined,
      connections: registry.list().map((connection) => connection.name),
      database,
      emptyColumns,
      writable: registry.configOf(registry.active!)?.writable === true,
      ...(sources ? { sources } : {}),
    });
  } catch (err) {
    console.error(`mistri: ${startupReport(err)}`);
    process.exit(1);
  }
  const at = shownPath(dir);
  const shellArg = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const reach =
    database && 'config' in database && database.config
      ? `--config ${shellArg(database.config)}`
      : database
        ? ''
        : opts.target
          ? '<database URL>'
          : '';
  process.stdout.write(
    `Drafted "${made.name}" in ${at}: ${made.navCount} view${made.navCount === 1 ? '' : 's'} in nav` +
      `${sources ? ` over ${sources.length} sources (${sources.map((source) => source.name).join(', ')})` : ''}` +
      `${made.pageCount ? `, ${made.pageCount} record page${made.pageCount === 1 ? '' : 's'}` : ''}.\n` +
      `  wrote ${made.written.join(', ')}\n` +
      `${made.kept.length ? `  kept ${made.kept.join(', ')}, which already stood\n` : ''}` +
      `${made.packageNote ? `  ${made.packageNote}\n` : ''}` +
      `Nearest recipe: ${made.recipe.name} — ${made.recipe.why}\n` +
      'Next:\n' +
      `  cd ${shellArg(at)}\n` +
      `${made.written.includes('package.json') ? '  npm install        mistri and TypeScript, for the imports and the typecheck\n' : ''}` +
      `  mistri check --app .${reach ? ` ${reach}` : ''}\n` +
      `  mistri seed --app .${reach ? ` ${reach}` : ''}      rows to look at, on a writable connection\n` +
      `  mistri${reach ? ` ${reach}` : ''} --app .\n` +
      'Then curate: rename, regroup, cut — a save reloads the App (a change to its grants,\n' +
      'sources or sign-in needs a restart), and mistri check regenerates the schema types,\n' +
      'typechecks and validates. mistri docs lists the reference topics.\n' +
      'Going multi-tenant later (auth.rows "tenant") needs text ids declared NOT NULL, or keys\n' +
      'and unique indexes that include the ownership column: mistri docs tenant-apps.\n',
  );
  for (const p of made.problems) console.error(`mistri: scaffold problem (a bug, not your config): ${p}`);
  process.exit(made.problems.length ? 1 : 0);
}

/**
 * What depends durably on each command's contract, in the words a problem
 * says it: the App API and MCP that publish it, a job that runs it or starts
 * on it, and receipts it answered, which a retry after a deploy is replayed
 * from. Receipts are asked of the journal; a journal that cannot say is
 * taken to hold none, as a first deploy does.
 */
async function durableDependents(
  loaded: LoadedApp,
  registry: Registry,
  jobCommands: ReadonlySet<string>,
): Promise<(id: string) => string[]> {
  const previous = lockedContracts(loaded.authority?.lock);
  const commands = loaded.commands!.registry;
  const published = new Set((loaded.app.api?.commands ?? []).map(({ command }) => command.id));
  const kept = new Set<string>();
  try {
    const bound = loaded.app.connection ?? (loaded.app.sources ? loaded.app.sources[homeSourceOf(loaded.app)!]?.connection : undefined);
    const connection =
      registry.list().find((c) => c.id === bound || c.name === bound) ?? registry.list().find((c) => c.id === registry.active);
    if (connection) {
      const resources = await loadAppRuntimeResources(registry, loaded.app, connection.id);
      for (const [id, command] of Object.entries(commands)) {
        const old = previous.get(id);
        if (!old || old.digest === contractDigest(loaded.app, command)) continue;
        const adapter = resources.forConnection(resources.connectionFor(logicalResource(loaded.app, command.source, command.target)));
        // Maintenance has no record authority. Enrolled Apps must never open
        // the ordinary journal path merely to inspect retained contracts.
        const read = async (_records: unknown, journal: import('../../adapters/commands/commandJournal.js').CommandJournal) =>
          journal.kept?.(loaded.app.id, id, command.version) ?? false;
        const found =
          loaded.app.auth?.rows === 'policy' || loaded.app.auth?.rows === 'tenant'
            ? await commandsOf(adapter)
                .scopeCommandTransaction?.({}, read)
                .catch(() => false)
            : await commandsOf(adapter)
                .commandTransaction?.(read)
                .catch(() => false);
        if (found) kept.add(id);
      }
    }
  } catch {
    /* A catalog that cannot be read is judged by the validation step; no receipts are counted. */
  }
  return (id) => [
    ...(published.has(id) ? ['the App API publishes it'] : []),
    ...(jobCommands.has(id) ? ['a job runs it or starts on it'] : []),
    ...(kept.has(id) ? ['receipts it answered are kept'] : []),
  ];
}

/**
 * The commands' half of authority.lock (commandContracts.ts): the problems a
 * changed contract makes where something durable depends on it, and the lock
 * as --write-authority or --bump writes it — the App's authority, then one
 * line per command.
 */
async function commandContractCheck(
  loaded: LoadedApp,
  registry: Registry,
  jobCommands: ReadonlySet<string>,
  bump: readonly string[],
  workflows: readonly WorkflowShape[] = [],
): Promise<{ problems: string[]; lines: string[] }> {
  if (!loaded.commands || !loaded.authority) return { problems: [], lines: [] };
  const unknown = bump.find((id) => !Object.hasOwn(loaded.commands!.registry, id));
  if (unknown) return { problems: [`--bump names "${unknown}", which the commands module does not register.`], lines: [] };
  const durable = await durableDependents(loaded, registry, jobCommands);
  const { lines, changes } = contractLines(loaded.app, loaded.commands.registry, loaded.authority.lock, durable, bump);
  const owned = workflowLines(workflows, loaded.authority.lock);
  const problems = [
    ...changes
      .filter((change) => change.durable.length)
      .map(
        (change) =>
          `command "${change.id}" changed its contract (its input, output, target or events), and ${change.durable.join(' and ')}: ` +
          `bump it with mistri check --bump ${change.id}, which moves it to version ${change.version + 1} in authority.lock; ` +
          `version ${change.version}'s receipts stay in the journal, a request still pinned to it is refused as a version mismatch, ` +
          `and its API route is v${change.version + 1} from then on.`,
      ),
    ...owned.problems,
  ];
  return { problems, lines: [...lines, ...owned.lines] };
}

export async function checkApps(opts: Options, registry: Registry, loadedApps: LoadedApp[], hosted: CommandHost): Promise<void> {
  const { commandHosting, jobHost, jobLines, effectHost, effectLines, jobCommands, jobRoles, workflows, workflowProblems } = hosted;
  let services: { problems: string[]; warnings: string[] } = { problems: [], warnings: [] };
  /* The policy's refusal, said beside the App's own problems rather than instead of them: it exited here, and every
     problem the App's validation would have named sat behind one opaque line, so each probe of a skill run looked
     the same until the author bisected the App by hand. */
  let policyFailure: string[] = [];
  if (opts.policy) {
    try {
      const policy = await loadHttpAppPolicy({
        registry,
        app: loadedApps[0].app,
        file: opts.policy,
        commands: commandHosting?.registry,
        // The event source serving binds too: a policy App's command that declares events loads as it serves.
        ...(commandHosting?.events ? { events: commandHosting.events } : {}),
        verifySession: async () => null,
      });
      await policy.retire();
      /* The services its jobs run as, said as problems and advice rather than the one refusal startup makes. */
      if (hosted.jobPrincipals.size || policy.services.length) {
        const { policyServiceFindings } = await import('../policy/policyServiceChecks.js');
        services = await policyServiceFindings({
          registry,
          app: loadedApps[0].app,
          file: opts.policy,
          commands: commandHosting?.registry,
          principals: hosted.jobPrincipals,
          runs: hosted.serviceRuns,
        });
      }
    } catch (error) {
      policyFailure = await policyStartupLines(error, loadedApps[0]);
      for (const line of policyFailure) console.error(line);
    }
  }
  // The stores were attested as the host opened; nothing ran.
  hosted.retentionTimer?.stop();
  await jobHost?.stop();
  await effectHost?.stop();
  for (const line of [...jobLines, ...effectLines]) process.stdout.write(`${line}\n`);
  /* Validate and exit: the startup warnings as a build step, for the CI
     of a repo that keeps an app in it. Non-zero when anything is wrong. */
  if (!loadedApps.length) {
    console.error('mistri: check needs an app — pass --app <dir>, or list "apps" in the config.');
    process.exit(1);
  }
  let bad = 0;
  /* --bump names a command or a decision: a decision's contract is kept in decisions.lock, not authority.lock. */
  const decisions: NonNullable<CommandHost['decisions']> = hosted.decisions ?? new Map();
  const decisionBump = new Set((opts.bump ?? []).filter((name) => decisions.has(name)));
  const commandRegistry = commandHosting?.registry ?? loadedApps.find((loaded) => loaded.commands)?.commands?.registry;
  const bump = (opts.bump ?? []).filter((name) => !decisionBump.has(name) || Object.hasOwn(commandRegistry ?? {}, name));
  for (const app of loadedApps) {
    /* The commands' contracts first: a bump or an accepted lock writes them beside the authority. */
    const contracts = await commandContractCheck(app, registry, jobCommands, bump, workflows);
    const authority =
      app.authority && contracts.lines.length
        ? { ...app.authority, report: `${app.authority.report.trimEnd()}\n\n${contracts.lines.join('\n')}\n` }
        : app.authority;
    /* The authority lock needs no catalog: written when asked, otherwise checked line by line. A bump
       writes the contract lines alone, keeping the authority the lock already holds. */
    /* A bump naming a command the module lacks writes nothing: the lines it would write are none. */
    const refused = contracts.problems.some((problem) => problem.startsWith('--bump'));
    const lock =
      bump.length && !opts.writeAuthority && authority?.lock !== undefined && !refused
        ? await writeContractLines(authority, contracts.lines)
        : await checkAuthorityLock(refused ? app.authority : authority, opts.writeAuthority && !refused);
    if (lock.wrote) console.error(`mistri: wrote ${lock.wrote}`);
    const scoped = app.app.connection;
    const match = registry.list().find((c) => c.id === scoped || c.name === scoped);
    /* An app scoped to a connection this server does not have is
       validated against nothing, not against whatever happens to be
       active: "ok" against the wrong database is the one answer a CI
       step must never give. */
    if (scoped && !match) {
      bad += 1;
      process.stdout.write(
        `${app.app.name}: 1 problem\n  ${app.path}: names connection "${scoped}", which this server does not have. ` +
          `Known: ${
            registry
              .list()
              .map((c) => c.id)
              .join(', ') || 'none'
          }.\n`,
      );
      continue;
    }
    let lines: string[];
    let advice: string[] = [];
    try {
      const { schema } = await loadAppRuntimeResources(registry, app.app, match?.id ?? registry.active!);
      resolveAppAccess(app.app, schema, []);
      await learnValueLabels(app, schema);
      /* What a role meets only when it signs in, judged once per role over
         the catalog it is served: here, where every role's reach is known. */
      const reach = appRoleReach(app, schema, jobRoles);
      lines = [
        ...appProblems(app, schema),
        ...reach.problems,
        // Open sign-up the config gives nothing to prove an address with.
        ...appSignUpProblems(app.app, Boolean(emailConfigOf(registry))).map((problem) => `${app.path}: ${problem}`),
        // The identity providers it names are the config file's: named and none of them a tenant's.
        ...identityProblems(app.app, identityProvidersOf(registry)).map((problem) => `${app.path}: ${problem}`),
        // The hosts that sign people in to it: the App signs people in, and each role they map is one it declares.
        ...embedProblems(app.app, embedIssuersOf(registry)).map((problem) => `${app.path}: ${problem}`),
        // The directories that provision it: through a provider it signs people in with, mapping roles it declares.
        ...scimProblems(app.app, scimDirectoriesOf(registry), identityProvidersOf(registry)).map((problem) => `${app.path}: ${problem}`),
        // The authorization server that issues for it: a person's token, for a network API, within its API's roles.
        ...oauthProblems(
          app.app,
          [oauthServerOf(registry)].filter((server) => server !== undefined),
        ).map((problem) => `${app.path}: ${problem}`),
      ];
      /* The indexes its reads lean on: here and not at startup, where a
         missing index is the same every start and says nothing new. */
      advice = [
        ...appAdvisories(app, schema),
        ...reach.warnings,
        ...appRoleWarnings(app, schema, commandHosting?.registry),
        ...machineCommandWarnings(app.app, commandHosting?.registry ?? app.commands?.registry),
        ...consumesCommandWarnings(app.app, schema, commandHosting?.registry ?? app.commands?.registry),
        // A targeted command nothing offers: prepare refuses it. Those a job, workflow or endpoint runs prepare nothing.
        ...unofferedCommandWarnings(
          app.app,
          commandHosting?.registry ?? app.commands?.registry,
          new Set([...hosted.serviceRuns.values()].flatMap((commands) => [...commands])),
        ),
        ...commandRestatedWarnings(commandHosting?.registry ?? app.commands?.registry),
        ...appIndexWarnings(app.app, app.pages, schema),
        // Its themes' font files: one past its size, all past the budget, one never drawn (appFonts.ts).
        ...fontWarnings(app.app, app.fonts).map((warning) => `${app.path}: ${warning}`),
        // A panel squarer than its controls (theme.ts): the theme still wears, and is said.
        ...themeShapeWarnings(app.app.ui.customThemes ?? []).map((warning) => `${app.path}: ${warning}`),
        // A shadow lighter than its ground (theme.ts): a glow, not a lift, the contract's C2.
        ...themeShadowWarnings(app.app.ui.customThemes ?? []).map((warning) => `${app.path}: ${warning}`),
        // A status or tag ground that is opaque on a banded table (theme.ts): the chip will not take the band, C13.
        ...themeBandWarnings(app.app.ui.customThemes ?? []).map((warning) => `${app.path}: ${warning}`),
        // A role past 700 in a face the theme does not ship at that weight (theme.ts): the contract's C8.
        ...themeTypeWarnings(app.app.ui.customThemes ?? []).map((warning) => `${app.path}: ${warning}`),
        // A logo picture with no dark answer (appBrand.ts): the theme contract's C10.
        ...brandWarnings(app.app).map((warning) => `${app.path}: ${warning}`),
      ];
      /* Its decisions' inputs against the schema served, and their contracts against decisions.lock. */
      if (decisions.size && commandRegistry && app === loadedApps[0]) {
        const { checkDecisions, decisionLockDirectory } = await import('../decide/decisionCheck.js');
        const judged = await checkDecisions({
          decisions,
          app: app.app,
          schema,
          commands: commandRegistry,
          directory: decisionLockDirectory(app),
          bump: decisionBump,
          write: Boolean(opts.writeAuthority),
        });
        if (judged.wrote) console.error(`mistri: wrote ${judged.wrote}`);
        lines.push(...judged.problems);
        advice.push(...judged.warnings);
      }
    } catch (error) {
      lines = [(error as Error).message];
    }
    if (lock.problem) lines.push(lock.problem);
    /* Mail to an address a record holds: the same findings startup refuses and warns with (email/contactMail.ts). */
    const { appEmailsContacts, contactMailPlaces } = await import('../email/contactMail.js');
    if (appEmailsContacts(app.app)) {
      const { contactEmailFindings } = await import('../integrations/integrationChecks.js');
      const service = emailConfigOf(registry);
      const places = await contactMailPlaces(registry, { app, pages: [] }).catch(() => undefined);
      const contact = contactEmailFindings(app.app, {
        email: service ? { links: Boolean(service.links?.secret) } : undefined,
        commands: commandHosting?.registry ?? app.commands?.registry,
        ...(places ? { connectionOf: places.connectionOf } : {}),
      });
      lines.push(...contact.problems);
      advice.push(...contact.warnings);
    }
    // What a workflow's steps name that is not there: the same refusal startup makes, here as problems.
    lines.push(...workflowProblems);
    lines.push(...services.problems);
    /* The policy's refusal is on stderr, where startup says it; the verdict counts it, after the App's own problems.
       A policy refused over one of the App's problems is that problem, counted once. */
    const [refusal] = app === loadedApps[0] ? policyFailure : [];
    const cause = refusal?.replace(/^(App|Policy startup) error: /, '');
    const restates = (line: string) => {
      const own = line.replace(/^[^:]+: /, '');
      return line.includes(cause!) || (own.length > 20 && cause!.includes(own));
    };
    if (refusal && !lines.some(restates)) lines.push(`--policy ${opts.policy}: it did not start, as said above: ${cause}`);
    /* A breaking change the lock was not bumped for fails the check; writing the lock cannot accept it. */
    if (!bump.length) lines.push(...contracts.problems);
    else if (contracts.problems.some((problem) => problem.startsWith('--bump'))) lines.push(...contracts.problems);
    bad += lines.length;
    /* Advice follows the verdict and never changes it or the exit code: a
       literal the database never holds, a button no role may press. */
    process.stdout.write(
      (lines.length
        ? `${app.app.name}: ${lines.length} problem${lines.length === 1 ? '' : 's'}\n${lines.map((l) => `  ${l}`).join('\n')}\n`
        : `${app.app.name}: ok\n`) + advice.map((l) => `  warning: ${l}\n`).join(''),
    );
  }
  await registry.closeAll();
  process.exitCode = bad ? 1 : 0;
}

/** --bump: authority.lock with its contract lines replaced, and nothing else of it touched. */
async function writeContractLines(
  authority: NonNullable<LoadedApp['authority']>,
  lines: readonly string[],
): Promise<{ wrote?: string; problem?: string }> {
  const kept = (authority.lock ?? '')
    .split('\n')
    .filter((line) => !line.startsWith(CONTRACT_PREFIX) && !line.startsWith(WORKFLOW_LINE_PREFIX))
    .join('\n')
    .trimEnd();
  const next = `${kept}\n\n${lines.join('\n')}\n`;
  if (next === authority.lock) return {};
  await writeFile(authority.lockPath, next);
  return { wrote: authority.lockPath };
}
