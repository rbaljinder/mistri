import { randomUUID } from 'node:crypto';
import { realpathSync, statSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { PostgresAdapter } from '@mistriwork/engine/adapters/postgres.js';
import { readSqliteReadCatalog } from '@mistriwork/engine/adapters/scoped/sqliteScopeCatalog.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import {
  homeSourceOf,
  isTenantApp,
  declaredReferences,
  physicalBindings,
  platformSourceNames,
  resolveAppAccess,
  resourceCeiling,
  tenantAppShape,
  tenantBusinessApp,
} from '../../shared/app.js';
import { appRoutes, LOADED_APP_KEYS, type LoadedApp } from '../app/apps.js';
import type { SuiteLinkSurface } from '../app/suiteLinks.js';
import { tenantAuthoringSchema } from './tenantVisibleFields.js';
import { appResourceCatalog } from '../app/appResources.js';
import { appAuthStore } from '../auth/auth.js';
import {
  assertAuthStoreSeparation,
  assertPostgresAuthStoreSeparation,
  captureAuthStoreExclusion,
  type AuthStoreExclusion,
} from '../auth/authStoreSeparation.js';
import { isPostgresAuthStore } from '../auth/authStore.js';
import type { ConnectionConfig } from '@mistriwork/engine/server/connections.js';
import { resolveConnection } from '@mistriwork/engine/server/auth/credentials.js';
import { loadAppTenantPolicy } from '../policy/appTenantPolicy.js';
import { loadBusinessCommands } from '../commands/businessCommandLoader.js';
import { lockedVersion } from '../commands/commandContracts.js';
import { CommandLookupRefusal, defineCommands, withCommandVersions } from '../commands/businessCommands.js';
import { describeJobs, loadJobModule } from '../jobs/jobLoader.js';
import { JobDeclarationError } from '../jobs/jobModule.js';
import { withTenantMachineTimers } from './tenantJobs.js';
import { captureTenantData, refusalCause, tenantOptions } from '@mistriwork/engine/server/evidence.js';
import { createTenantEnrollment, type TenantEnrollmentOptions } from './tenantEnrollment.js';
import type { TenantStartupCommands, TenantStartupPolicy } from './tenantFeatureContract.js';
import { TENANT_STARTUP_CHECKS } from './tenantFeatures.js';
import { captureTenantOwnership } from './tenantOwnership.js';
import { tenantClonePlan, type TenantClonePlan } from './tenantClonePlan.js';
import { describeTenantPlatformSource, platformSourceDeclaration, withPlatformSources } from './tenantPlatformSource.js';
import { TenantAuthoringStartupError, TenantCommandStartupError, TenantStartupError } from './tenantStartupError.js';
import { SUPPORT_AUDIT_KEY_VARIABLE, supportAuditKey } from './tenantSupportAuditContract.js';
import { appIndexWarnings } from '../../shared/appIndexWarnings.js';
import { tenantDeleteWarnings } from './tenantAdvice.js';
import { unofferedCommandWarnings } from '../app/appCommandOfferChecks.js';
import { sayTenantAuthoringProblems, tenantAuthoringProblems, type TenantAuthoringProblem } from './tenantAuthoring.js';

export { TenantStartupError };
type Enrollment = Omit<TenantEnrollmentOptions<IncomingMessage>, 'app' | 'pages' | 'verifySession'>;
type PlatformSourceLocation = NonNullable<Enrollment['platformSources']>[number];
export interface TenantStartupOptions {
  readonly loaded: LoadedApp;
  readonly connections: readonly ConnectionConfig[];
  readonly policyFile: string;
  readonly commandsFile?: string;
  /** A server-only defineJobs module, with --commands: its jobs start on the
   * tenants' command events and run as service principals. */
  readonly jobsFile?: string;
}
const PLATFORM_STAGE = "the platform-only sources, apart from the App's own database and the authentication store";
/* One stage a refusal names, one place it can have come from: the grants read
   before the policy is imported, the ownership attested after it, and the
   authoring judged against that ownership are three different failures. */
const GRANTS_STAGE = 'the authored resource ceilings and role grants';
const OWNERSHIP_STAGE = 'the attested ownership of the authored resources';
const AUTHORING_STAGE = 'the authored resource and page definitions';

/** No adapter, auth migration, module import or network acquisition precedes
 * these declaration checks. A tenant host never uses Registry.open. */
export async function prepareTenantStartup(
  input: TenantStartupOptions,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{
  /** Present for a SQLite source: the file native auth must never alias. */
  readonly enrollment: Enrollment;
  readonly authStoreExclusion?: AuthStoreExclusion;
  /** The effective automation, one line a job, as `mistri check` prints it. */
  readonly jobLines: readonly string[];
  /** What the App has that startup accepts and `mistri check` advises on: the indexes its reads lean on and the catalog lacks (appIndexWarnings.ts), a delete no policy callback allows (tenantAdvice.ts), a command nothing offers. */
  readonly adviceLines: readonly string[];
  /** Reuse the catalogs already validated by this startup owner. */
  readonly linkSurfaces: readonly SuiteLinkSurface[];
  /** What a clone of a tenant copies, where the App marks resources clone (tenantClonePlan.ts): `mistri tenant`'s. */
  readonly clone?: TenantClonePlan;
}> {
  // Capture before any acquisition yields; suite Apps never install their secrets globally.
  const capturedEnvironment = Object.freeze({ ...environment });
  // A loader owns executable command definitions beside its metadata. Capture
  // descriptors before separating trusted handlers from the data declaration.
  const given = tenantOptions(input, ['loaded', 'connections', 'policyFile', 'commandsFile', 'jobsFile']);
  const metadata = tenantOptions(given.loaded, LOADED_APP_KEYS);
  const commandModule = metadata.commands === undefined ? undefined : tenantOptions(metadata.commands, ['file', 'registry']);
  const discovered = commandModule ? defineCommands(commandModule.registry as NonNullable<LoadedApp['commands']>['registry']) : undefined;
  const { loaded, connections, policyFile, commandsFile, jobsFile } = captureTenantData({
    ...given,
    // A page's loaders are code beside the commands: the data host takes them from the App itself (tenantAuthenticatedHttp.ts).
    loaded: { ...metadata, commands: undefined, loaders: undefined, challenges: undefined },
  }) as unknown as TenantStartupOptions;
  const app = loaded.app,
    source = homeSourceOf(app);
  if (!isTenantApp(app) || !tenantAppShape(app) || !source || !app.sources) {
    throw new TenantStartupError('Tenant startup requires native auth with auth.rows "tenant", membership roles and one named source.');
  }
  // Every feature is judged, and every owner but the platform realm's reads is
  // built, on the App without its platform-only sources: to them those do not exist.
  const business = tenantBusinessApp(app),
    outside = platformSourceNames(app);
  const configured = app.sources[source].connection;
  const matching = (name: string) => connections.filter((each) => [each.id, each.name].includes(app.sources![name].connection));
  const connection = matching(source).length === 1 ? matching(source)[0] : undefined;
  if (connections.length !== 1 + outside.length || !connection || connection.rows === false || connection.schemas?.length) {
    throw new TenantStartupError(
      outside.length
        ? "Tenant startup requires one matching, row-readable connection for the App's own source, one for each platform-only source, and no other."
        : 'Tenant startup requires exactly one matching, row-readable SQLite connection, or one such PostgreSQL connection.',
    );
  }
  const platformConnections = outside.map((name) => (matching(name).length === 1 ? matching(name)[0] : undefined));
  if (
    platformConnections.some((each) => !each || each === connection || each.rows === false || each.schemas?.length) ||
    new Set(platformConnections).size !== outside.length
  ) {
    throw new TenantStartupError(
      "Tenant startup requires one matching, row-readable connection for the App's own source, one for each platform-only source, and no other.",
    );
  }
  // Read, never written: an operator's writable: true here is a contradiction, not a grant.
  if (platformConnections.some((each) => each!.writable === true)) {
    throw new TenantStartupError('A platform-only source is read only: its connection must not say writable: true.');
  }
  // Its reads are the platform's few, made in one snapshot each: the primary serves them.
  if (platformConnections.some((each) => each!.replicas?.length)) {
    throw new TenantStartupError('A platform-only source reads its primary: remove "replicas" from its connection.');
  }
  // Reject contradictory operator intent instead of allowing the private
  // writer to bypass the connection's ordinary read-only default.
  if (connection.writable !== true && (resourceCeiling(app).write.length || commandsFile !== undefined || discovered !== undefined)) {
    throw new TenantStartupError('Tenant write grants or commands require writable: true on the configured connection.');
  }
  if (
    !policyFile?.trim() ||
    policyFile.startsWith('-') ||
    (commandsFile !== undefined && (!commandsFile.trim() || commandsFile.startsWith('-')))
  ) {
    throw new TenantStartupError('Tenant startup requires a server-only --policy file and an optional --commands file.');
  }
  if (
    jobsFile !== undefined &&
    ((commandsFile === undefined && discovered === undefined) || !jobsFile.trim() || jobsFile.startsWith('-'))
  ) {
    throw new TenantStartupError(
      'Tenant --jobs requires a server-only jobs file and an App command registry: keep commands.ts beside the App or pass --commands.',
    );
  }
  let stage = 'the SQLite source and separate authentication store';
  let absentStores: readonly string[] = [];
  try {
    const resolved = await resolveConnection(connection.name, connection.url, { environment: capturedEnvironment });
    const postgres = /^postgres(ql)?:\/\//i.test(resolved.url);
    let describe: () => Promise<DatabaseSchema>, enrollmentSource: Enrollment['source'];
    let authStoreExclusion: AuthStoreExclusion | undefined;
    if (postgres) {
      stage = 'the PostgreSQL source and separate authentication store';
      // A file store cannot alias a PostgreSQL database. A postgres:// store may
      // not reach this one; native auth asks both servers who they are later.
      const url = resolved.url,
        store = appAuthStore(loaded, capturedEnvironment);
      /* The source's replicas serve its lag-tolerant reads under the same
         membership and row scope (tenantReadSource.ts). Each is the same
         engine, and the authentication store may alias none of them. */
      const replicas: string[] = [];
      for (const replica of connection.replicas ?? []) {
        const found = (await resolveConnection(connection.name, replica, { environment: capturedEnvironment })).url;
        if (!/^postgres(ql)?:\/\//i.test(found)) throw new TenantStartupError("A PostgreSQL source's replicas must be postgres:// URLs.");
        replicas.push(found);
      }
      /* The connection's "listen": where the jobs host holds its LISTEN when `url` is a transaction-mode pooler's. */
      const listen = connection.listen
        ? (await resolveConnection(connection.name, connection.listen, { environment: capturedEnvironment })).url
        : undefined;
      if (listen && !/^postgres(ql)?:\/\//i.test(listen))
        throw new TenantStartupError('A PostgreSQL source\'s "listen" must be a postgres:// URL.');
      if (isPostgresAuthStore(store)) assertPostgresAuthStoreSeparation(store, [{ url }, ...replicas.map((each) => ({ url: each }))]);
      describe = async () => {
        const adapter = new PostgresAdapter(url, 'Tenant startup');
        try {
          return await adapter.readSnapshot((snapshot) => snapshot.describe());
        } finally {
          await adapter.close();
        }
      };
      enrollmentSource = Object.freeze({
        id: source,
        connection: configured,
        url,
        ...(replicas.length ? { replicas: Object.freeze(replicas) } : {}),
        ...(listen ? { listen } : {}),
      });
    } else {
      if (connection.replicas?.length)
        throw new TenantStartupError('SQLite has no replicas: a file is read where it is. Remove "replicas".');
      const path = resolved.url.replace(/^sqlite:(\/\/)?/i, '');
      if (!path || path.includes('://') || /^file:/i.test(path) || path === ':memory:') throw new TenantStartupError();
      const file = realpathSync(path),
        exclusion = (authStoreExclusion = captureAuthStoreExclusion(file));
      // A postgres:// store cannot alias the business file or its sidecars.
      if (!isPostgresAuthStore(appAuthStore(loaded, capturedEnvironment)))
        assertAuthStoreSeparation(appAuthStore(loaded, capturedEnvironment), exclusion);
      describe = async () => {
        const db = new DatabaseSync(file, { readOnly: true, enableForeignKeyConstraints: true });
        try {
          db.exec('BEGIN');
          const physical = readSqliteReadCatalog(db).schema;
          db.exec('COMMIT');
          return physical;
        } finally {
          db.close();
        }
      };
      enrollmentSource = Object.freeze({ id: source, connection: configured, existingPath: file });
    }
    // Each platform-only source: an existing SQLite file or a postgres:// URL,
    // never the App's own database or the authentication store, by path and
    // inode or by host, port and database here; enrollment then asks each
    // PostgreSQL server who it is, and native auth asks every connection.
    const platform: PlatformSourceLocation[] = [];
    if (outside.length) stage = PLATFORM_STAGE;
    for (const [index, name] of outside.entries()) {
      const entry = platformConnections[index]!,
        found = await resolveConnection(entry.name, entry.url, { environment: capturedEnvironment });
      const store = appAuthStore(loaded, capturedEnvironment);
      if (/^postgres(ql)?:\/\//i.test(found.url)) {
        if (postgres) assertPostgresAuthStoreSeparation(found.url, [{ url: resolved.url }]);
        if (isPostgresAuthStore(store)) assertPostgresAuthStoreSeparation(store, [{ url: found.url }]);
        platform.push(Object.freeze({ id: name, connection: app.sources[name].connection, url: found.url }));
        continue;
      }
      const path = found.url.replace(/^sqlite:(\/\/)?/i, '');
      if (!path || path.includes('://') || /^file:/i.test(path) || path === ':memory:') throw new TenantStartupError();
      const file = realpathSync(path);
      if (authStoreExclusion) assertAuthStoreSeparation(file, authStoreExclusion);
      if (!isPostgresAuthStore(store)) assertAuthStoreSeparation(store, captureAuthStoreExclusion(file));
      platform.push(Object.freeze({ id: name, connection: app.sources[name].connection, existingPath: file }));
    }
    // Their declared resources, each in one snapshot: every one must exist.
    const declarations = outside.map((name) => platformSourceDeclaration(app, name));
    // `after` is the caller's own stage: each source is read inside another
    // check, and a refusal there must name that check, not this detour.
    const describeOutside = async (after: string) => {
      stage = PLATFORM_STAGE;
      const schemas: DatabaseSchema[] = [];
      for (const [index, where] of platform.entries()) schemas.push(await describeTenantPlatformSource(where, declarations[index]));
      stage = after;
      return schemas;
    };
    // Refuse invalid source/catalog grants before importing trusted policy code.
    // Form requirements need the policy's attested managed-column declaration.
    stage = GRANTS_STAGE;
    const { schema } = appResourceCatalog(await describe(), physicalBindings(app, source), declaredReferences(app, source));
    resolveAppAccess(app, withPlatformSources(schema, await describeOutside(GRANTS_STAGE)), []);
    stage = 'the server-only tenant policy';
    const policy = await loadAppTenantPolicy(policyFile);
    // Each feature's declaration checks, in tenantFeatures.ts's order: the
    // first to fail names the refusal, before the catalog is read again.
    const declared: TenantStartupPolicy = Object.freeze({
      loaded,
      app: business,
      connection,
      engine: postgres ? 'postgres' : 'sqlite',
      policy,
      environment: capturedEnvironment,
      platformSources: Object.freeze(outside.map((name, index) => Object.freeze({ name, connection: platformConnections[index]! }))),
    });
    for (const check of TENANT_STARTUP_CHECKS) {
      if (check.phase !== 'policy') continue;
      if (check.stage !== undefined) stage = check.stage;
      await check.run(declared);
    }
    stage = OWNERSHIP_STAGE;
    const physical = await describe();
    const outsideSchemas = await describeOutside(OWNERSHIP_STAGE);
    const catalog = appResourceCatalog(physical, physicalBindings(app, source), declaredReferences(app, source));
    /* Every table is owned, so one the database has and the policy does not — a migration applied ahead of the code —
       stops startup. Named, it is a minute's fix; refused as evidence, it was found by dropping tables one at a time. Table names only: they are the App's own words, never where the deployment's files live. */
    const unowned = catalog.schema.tables.map((table) => table.id).filter((id) => !Object.hasOwn(policy.ownership, id));
    const missing = Object.keys(policy.ownership).filter((id) => !catalog.schema.tables.some((table) => table.id === id));
    if (unowned.length || missing.length) {
      const names = (ids: string[]) => ids.map((id) => `"${id}"`).join(', ');
      throw new TenantAuthoringStartupError(
        `Tenant startup could not validate ${OWNERSHIP_STAGE}:` +
          (unowned.length
            ? `\n  the database has ${unowned.length === 1 ? 'a table' : 'tables'} the tenant policy's ownership does not name: ${names(unowned)}. ` +
              "Give each an owner in the policy's ownership (tenant with its column, global or platform) and declare it in the App, " +
              'or run the code the database was migrated for.'
            : '') +
          (missing.length
            ? `\n  the tenant policy's ownership names ${missing.length === 1 ? 'a table' : 'tables'} the database does not have: ${names(missing)}. ` +
              'Migrate the database, or take them out of the ownership.'
            : ''),
      );
    }
    resolveAppAccess(app, withPlatformSources(catalog.schema, outsideSchemas), []);
    const owned = captureTenantOwnership({
      appId: app.id,
      source: { id: source, connection: configured },
      physicalSchema: physical,
      schema: catalog.schema,
      resources: Object.fromEntries(catalog.schema.tables.map((table) => [table.id, catalog.toPhysical(table.id)])),
      ownership: policy.ownership,
      ...(app.auth?.tenancy?.profile === undefined ? {} : { profile: app.auth.tenancy.profile }),
    });
    /* Every tenant read is `ownership column = ?`: the one index a tenant App cannot do without. */
    const indexLines = Object.freeze(
      appIndexWarnings(business, loaded.pages, catalog.schema, {
        owners: Object.fromEntries(
          Object.entries(policy.ownership).flatMap(([id, owner]) => (owner.kind === 'tenant' ? [[id, owner.column]] : [])),
        ),
      }),
    );
    // Each declaration against its own realm's catalog: a tenant App with a
    // platform realm is two authored surfaces, and neither is judged by the
    // other's catalog (tenantAuthoring.ts).
    stage = AUTHORING_STAGE;
    const authoring: readonly TenantAuthoringProblem[] = tenantAuthoringProblems(loaded, owned, { platformSources: outsideSchemas });
    // Name them. The operator running mistri check asked what is wrong, and the
    // lines say which realm's catalog judged each one; the HTTP boundary never
    // sees a startup refusal, so nothing here reaches an untrusted caller.
    if (authoring.length) {
      throw new TenantAuthoringStartupError(
        `Tenant startup could not validate ${AUTHORING_STAGE}:\n` +
          sayTenantAuthoringProblems(authoring)
            .map((line) => `  ${line}`)
            .join('\n'),
      );
    }
    stage = 'the server-only command registry';
    const commandDeclarations = commandsFile === undefined ? discovered : await loadBusinessCommands(commandsFile);
    const registry = commandDeclarations && withCommandVersions(commandDeclarations, lockedVersion(loaded.authority?.lock));
    stage = 'the server-only jobs module';
    const loadedJobs = jobsFile === undefined ? undefined : await loadJobModule(jobsFile);
    /* The App's machine timers (`after`, `at`) run as jobs of this module, in the tenant each row's owner names
       (tenantJobs.ts); without --commands the jobs check below refuses the module whole. */
    const jobs = loadedJobs && registry ? withTenantMachineTimers(loadedJobs, app, registry) : loadedJobs;
    // The registry-bound checks, in the same order and under the same rule.
    const commands: TenantStartupCommands = Object.freeze({ ...declared, configured, owned, registry, jobs });
    for (const check of TENANT_STARTUP_CHECKS) {
      if (check.phase !== 'commands') continue;
      if (check.stage !== undefined) stage = check.stage;
      await check.run(commands);
    }
    const enrollment: Enrollment = Object.freeze({
      policy,
      ...(policy.support === undefined ? {} : { supportAuditKey: supportAuditKey(capturedEnvironment[SUPPORT_AUDIT_KEY_VARIABLE] ?? '') }),
      source: enrollmentSource,
      deployment: randomUUID(),
      roles: Object.freeze(Object.keys(app.auth!.roles!)),
      maxLifetimeMs: 300000,
      ...(registry ? { commands: Object.freeze({ registry }) } : {}),
      ...(jobs ? { jobs: Object.freeze({ module: jobs }) } : {}),
      ...(platform.length ? { platformSources: Object.freeze(platform) } : {}),
    });
    // Attest all tenant/journal/catalog invariants before native auth can
    // create its independent store. No principal or business callback runs.
    /* Enrollment captures the host's declarations before it opens anything, so
       a refusal here may be either; naming only the stores sent a reader after
       a database that was never touched. */
    stage = 'the host declarations, and the existing tenant store, ownership and command/administration journals';
    let checked: Awaited<ReturnType<typeof createTenantEnrollment>>;
    try {
      checked = await createTenantEnrollment({ ...enrollment, app, pages: loaded.pages, verifySession: async () => null });
    } catch (error) {
      /* Startup never creates a store, and enrollment's refusal names a stage: the stores the database holds none of
         are said with the error, so the operator is given the command that makes them. */
      const [{ tenantStoresNeeded, storesAbsentAt }, { historyRules }] = await Promise.all([
        import('../stores/storesCli.js'),
        import('../recordHistory.js'),
      ]);
      absentStores = await storesAbsentAt(resolved.url, tenantStoresNeeded(loaded, policy, registry, historyRules));
      throw error;
    }
    await checked.retire();
    if (!isPostgresAuthStore(appAuthStore(loaded, capturedEnvironment))) {
      if (authStoreExclusion) assertAuthStoreSeparation(appAuthStore(loaded, capturedEnvironment), authStoreExclusion);
      for (const where of platform)
        if (where.existingPath !== undefined)
          assertAuthStoreSeparation(appAuthStore(loaded, capturedEnvironment), captureAuthStoreExclusion(where.existingPath));
    }
    const realms = app.auth?.tenancy?.platform ? (['tenant', 'platform'] as const) : (['tenant'] as const);
    const linkSurfaces = realms.map((realm) => {
      const schema =
        realm === 'platform' ? withPlatformSources(tenantAuthoringSchema(owned, realm), outsideSchemas) : tenantAuthoringSchema(owned);
      return { realm, schema, book: appRoutes(loaded, schema, realm) };
    });
    // Judged by the clone check above, so this cannot refuse here.
    const clone = tenantClonePlan(app, owned, policy);
    return Object.freeze({
      enrollment,
      ...(clone ? { clone } : {}),
      linkSurfaces: Object.freeze(linkSurfaces),
      ...(authStoreExclusion ? { authStoreExclusion } : {}),
      jobLines: Object.freeze(jobs ? describeJobs(jobs) : []),
      adviceLines: Object.freeze([
        ...indexLines,
        ...tenantDeleteWarnings(business, catalog.schema, policy),
        // A jobs module's workflows and endpoints run commands no button offers; a tenant check cannot tell which, so it says nothing then.
        ...(jobs ? [] : unofferedCommandWarnings(app, registry)),
      ]),
    });
  } catch (error) {
    // A jobs module's own refusals name only ids, like the command checks', and
    // the authoring check names the problems it found: those messages stand.
    // Every other failure says the stage, and the cause travels with it for the
    // operator who started this deployment — a tenant refusal records why it
    // denied without putting it on `cause`, so read that first.
    const because = refusalCause(error) ?? error;
    throw new TenantStartupError(
      error instanceof CommandLookupRefusal ||
        error instanceof TenantCommandStartupError ||
        error instanceof TenantAuthoringStartupError ||
        error instanceof JobDeclarationError
        ? error.message
        : `Tenant startup could not validate ${stage}.`,
      { cause: because, absentStores },
    );
  }
}

/** Restart-only authoring, but for the look. Watch directories rather than file inodes so atomic
 * editor replacements are observed. SQLite/auth sidecar traffic is not an App
 * edit. Imported policy dependencies outside these roots require explicit restart.
 * With `look`, a burst of saves under the App directory is first offered to it
 * (tenantLook.ts): it answers whether the save was the look alone and was worn in
 * place, and anything else is the restart it always was. The policy, commands,
 * jobs and connection files are never offered: they are authority. */
/** `mistri dev`'s folder in the App's directory (devMode.ts): its secret, passwords, auth store and tools. */
const DEV_STATE = '.mistri';
export function watchTenantStartup(
  options: {
    loaded: LoadedApp;
    policyFile: string;
    commandsFile?: string;
    jobsFile?: string;
    configPath?: string;
    look?: (touched: string[]) => Promise<boolean>;
    debounceMs?: number;
  },
  changed: () => void,
): () => void {
  const watchers: FSWatcher[] = [];
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    closed = true;
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
  const invalidate = () => {
    if (!closed) {
      close();
      changed();
    }
  };
  /* Saves gathered while one is being judged wait for its answer, then are judged against what it left. */
  let touched = new Set<string>();
  let judging: Promise<void> = Promise.resolve();
  const judge = () => {
    const files = [...touched];
    touched = new Set();
    judging = judging.then(async () => {
      if (closed) return;
      let worn = false;
      try {
        worn = await options.look!(files);
      } catch {
        worn = false;
      }
      if (!worn) invalidate();
    });
  };
  try {
    const root = resolve(options.loaded.dir ?? dirname(options.loaded.path));
    const required = [options.loaded.path, ...Object.values(options.loaded.sources)];
    const appWatcher = watch(root, { recursive: true }, (_event, filename) => {
      /* `mistri dev` keeps its own state in the App's .mistri/ (devMode.ts) and rewrites dev.json on every
         start: not an App edit, and taking it for one restarted a dev-served tenant App forever. */
      if (filename !== null && filename.split(/[\\/]/)[0] === DEV_STATE) return;
      try {
        if (!statSync(root).isDirectory() || required.some((file) => !statSync(file).isFile())) return invalidate();
      } catch {
        return invalidate();
      }
      if (filename !== null && !['.ts', '.mjs', '.js', '.json'].includes(extname(filename))) return;
      if (filename === null || !options.look) return invalidate();
      touched.add(join(root, filename));
      clearTimeout(timer);
      timer = setTimeout(judge, options.debounceMs ?? 150);
    });
    watchers.push(appWatcher);
    appWatcher.on('error', invalidate);
    for (const file of [options.policyFile, options.commandsFile, options.jobsFile, options.configPath]) {
      if (!file) continue;
      const path = resolve(file);
      const watcher = watch(dirname(path), (_event, filename) => {
        if (filename === null || filename === basename(path)) invalidate();
      });
      watchers.push(watcher);
      watcher.on('error', invalidate);
    }
    return close;
  } catch {
    close();
    throw new TenantStartupError('Tenant deployment files could not be watched for restart-only changes.');
  }
}
