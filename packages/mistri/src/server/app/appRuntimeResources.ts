import { Refusal, type Adapter } from '@mistriwork/engine/adapters/adapter.js';
import { declaredDates, declaredReferences, homeSourceOf, physicalBindings, type AppDef } from '../../shared/app.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { AppResources } from './appResources.js';
import type { AppAdapterSource } from './appSourceAdapter.js';
import { mapOpenedAppRuntimeResources } from './appRuntimeResourceMapping.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { assertAppApiContext, readApiApp } from '../api/appApiValidation.js';
import { checkApiReadCatalog } from '../api/apiReadCatalog.js';
import { apiWriteProblems } from '../api/apiGenericWrites.js';

export interface RuntimeResources extends AppResources {
  /** Physical registry owners. Never derived from a request's table spelling. */
  connections: string[];
  connectionFor(resource: string): string;
  toLogicalAt(table: string, connection: string): string;
  forConnection(connection: string): Adapter;
}

export class AppSourceUnavailable extends Error {
  constructor(source: string) {
    super(`Application data source "${source}" is unavailable.`);
    this.name = 'AppSourceUnavailable';
  }
}

/** Bind source names to registry IDs, without dialing or changing active state. */
export function appSourceConnections(registry: Registry, app: AppDef): Map<string, string> {
  const bound = new Map<string, string>();
  for (const [source, binding] of Object.entries(app.sources ?? {})) {
    const matches = registry.list().filter((connection) => connection.id === binding.connection || connection.name === binding.connection);
    if (matches.length !== 1) throw new AppSourceUnavailable(source);
    /* One connection backs several sources only when each is scoped to a
       schema of its own. Parsing checks the names; a connection named once
       by id and once by name is the same one, so it is judged again here. */
    const beside = [...bound].filter(([, id]) => id === matches[0].id).map(([other]) => app.sources![other].schema);
    if (beside.length && (!binding.schema || beside.some((schema) => !schema || schema === binding.schema))) {
      throw new Refusal('Sources that share a database connection each need a schema of their own.');
    }
    const listed = registry.configOf(matches[0].id)?.schemas;
    if (binding.schema && listed?.length && !listed.includes(binding.schema)) {
      throw new Refusal(
        `Source "${source}" sees schema "${binding.schema}", which connection "${binding.connection}" does not read. ` +
          `Add "${binding.schema}" to its "schemas".`,
      );
    }
    bound.set(source, matches[0].id);
  }
  return bound;
}

/** What one source sees of its opened connection: the whole of it, or the one schema it names. */
function sourceSchema(source: string, schema: string | undefined, catalog: DatabaseSchema): string | undefined {
  if (schema === undefined) return undefined;
  if (catalog.dialect !== 'postgres' && catalog.dialect !== 'mysql') {
    throw new Refusal(
      `Source "${source}" names schema "${schema}", but its connection is ${catalog.dialect === 'sqlite' ? 'SQLite' : `a ${catalog.dialect} source`}, ` +
        'which has no schemas to choose from. Drop "schema" there; it is for PostgreSQL schemas and MySQL databases.',
    );
  }
  return schema;
}

/** Resolve an App's data graph; the caller owns registry leases and shutdown. */
export async function loadAppRuntimeResources(
  registry: Registry,
  app: AppDef,
  connection: string,
  onOpen: (connection: string) => void = () => {},
): Promise<RuntimeResources> {
  /* Loading checks the read half of the API. A command exposure needs its
     registry, which only a command host has; that host checks it
     (checkApiCommandCatalog), and loading never widens what it may run. */
  const readApp = readApiApp(app);
  assertAppApiContext(readApp);
  /* Only an ordinary App's exposure is checked here. A tenant App's is served
     by its tenant host alone, which checks it against the tenant-visible
     catalog (apiTenantReadCatalog) with that membership's own grants; this
     foundation knows only `auth.rows: 'all'`, so applying it to a tenant App
     refused a correct two-realm App at load — the Ignition sample could not
     start once it declared `api`. */
  const checksApi = readApp.api !== undefined && app.auth?.rows === 'all';
  if (!app.sources) {
    const opened = await registry.open(connection);
    onOpen(connection);
    return keptResources(app, connection, [...declared(app), opened.adapter, opened.schema], () => {
      const resources = mapOpenedAppRuntimeResources(app, connection, new Map([['', opened]]), new Map([['', connection]]));
      if (checksApi) {
        checkApiReadCatalog(readApp.api!, readApp, resources.schema);
        assertApiWrites(app, resources.schema);
      }
      return resources;
    });
  }
  const bindings = appSourceConnections(registry, app);
  if (bindings.get(homeSourceOf(app)!) !== connection) throw new Refusal('This is not the application entry point.');
  /* Each connection opens once, however many sources share it. Wait for all
     opens before returning an error, so response-owned leases cannot be
     registered after the failed response has already closed. */
  const owners = [...new Set(bindings.values())];
  const databases = new Map<string, Awaited<ReturnType<Registry['open']>>>();
  const opened = await Promise.allSettled(
    owners.map(async (owner) => {
      let database;
      try {
        database = await registry.open(owner);
      } catch {
        throw new AppSourceUnavailable([...bindings].find(([, id]) => id === owner)![0]);
      }
      onOpen(owner);
      databases.set(owner, database);
    }),
  );
  const failed = opened.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  const inputs = [
    ...declared(app),
    ...[...bindings].flatMap(([source, owner]) => [
      source,
      owner,
      databases.get(owner)!.adapter,
      databases.get(owner)!.schema,
      registry.configOf(owner)?.writable === true,
    ]),
  ];
  return keptResources(app, connection, inputs, () => mapSources(app, connection, bindings, databases, registry, readApp, checksApi));
}

/* The mapping is 15–20 ms of every App request — every source's catalog
   bound, every resource named — and depends only on the App, the entry
   connection and what each opened connection is: its adapter and catalog
   (a reopened or refreshed connection is a new one) and whether the config
   lets it write. Kept per App under exactly those, and compared by identity,
   so any change is a miss. The App's own declarations are in the key too,
   not only the App: a loaded App is replaced, never changed, but one that
   is changed in place (a test's, an embedder's) is then read again rather
   than trusted. The leases are the caller's, taken above as before, per
   request. */
const declared = (app: AppDef): readonly unknown[] => [app.sources, app.resources, app.api, app.auth, app.connection];
type Kept = Map<string, { inputs: readonly unknown[]; resources: RuntimeResources }>;
const runtimeResources = new WeakMap<AppDef, Kept>();
function keptResources(app: AppDef, connection: string, inputs: readonly unknown[], map: () => RuntimeResources): RuntimeResources {
  const byConnection: Kept = runtimeResources.get(app) ?? new Map();
  runtimeResources.set(app, byConnection);
  const kept = byConnection.get(connection);
  if (kept && kept.inputs.length === inputs.length && kept.inputs.every((value, index) => value === inputs[index])) return kept.resources;
  const resources = map();
  byConnection.set(connection, { inputs, resources });
  return resources;
}

/** An API's generic writes are judged with its reads, against the same catalog (apiGenericWrites.ts). */
function assertApiWrites(app: AppDef, schema: DatabaseSchema): void {
  const problems = apiWriteProblems(app, schema);
  if (problems.length) throw new Error(problems.join(' '));
}

function mapSources(
  app: AppDef,
  connection: string,
  bindings: ReturnType<typeof appSourceConnections>,
  databases: Map<string, Awaited<ReturnType<Registry['open']>>>,
  registry: Registry,
  readApp: AppDef,
  checksApi: boolean,
): RuntimeResources {
  const sources = new Map<string, AppAdapterSource>();
  for (const [source, owner] of bindings) {
    const database = databases.get(owner)!;
    const scope = sourceSchema(source, app.sources![source].schema, database.schema);
    sources.set(source, {
      ...database,
      resources: physicalBindings(app, source),
      references: declaredReferences(app, source),
      dates: declaredDates(app, source),
      writable: registry.configOf(owner)?.writable === true,
      group: owner,
      ...(scope === undefined ? {} : { scope }),
    });
  }
  const runtime = mapOpenedAppRuntimeResources(app, connection, sources, bindings);
  if (checksApi) {
    checkApiReadCatalog(readApp.api!, readApp, runtime.schema);
    assertApiWrites(app, runtime.schema);
  }
  return runtime;
}
