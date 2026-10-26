/** Several sources behind one App API: a lane per connection an exposed
 * operation reads. Each engine owner stays one object per App — one token
 * capability, one cursor secret, one document set — and routes a request to
 * the lane its operation was fixed to when the catalog was checked: a read by
 * its resource's source (ReadOperation.source), a command by its target's.
 * A read's runtime resources bind every other connection to an adapter that
 * refuses, so nothing it does can quietly read a second database: one
 * request, one connection, one snapshot. A command needs no such binding: the
 * authorizer keeps its reads and writes on its target's connection, and the
 * command catalog refuses an exposed lookup into another (apiCommandCatalog.ts).
 * Nothing is promised across requests. */
import { Refusal, type Adapter } from '@mistriwork/engine/adapters/adapter.js';
import { declaredDates, declaredReferences, logicalResource, physicalBindings, type AppDef } from '../../shared/app.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { mapOpenedAppRuntimeResources } from '../app/appRuntimeResourceMapping.js';
import type { AppAdapterSource } from '../app/appSourceAdapter.js';
import type { RuntimeResources } from '../app/appRuntimeResources.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import type { ReadCatalog } from './apiReadCatalog.js';

/** The connections a read catalog's operations read, each once, in operation order. */
export function apiReadLaneConnections(catalog: ReadCatalog, bindings: ReadonlyMap<string, string>): string[] {
  const lanes: string[] = [];
  for (const operation of catalog.operations) {
    const connection = bindings.get(operation.source ?? '');
    if (connection === undefined) throw new Refusal('An exposed operation reads a source that is not bound.');
    if (!lanes.includes(connection)) lanes.push(connection);
  }
  return lanes;
}

/** The connection a read operation is served on, or undefined for an operation
 * the catalog does not hold (the owner refuses it as it always has). */
export function apiReadLaneOf(catalog: ReadCatalog, bindings: ReadonlyMap<string, string>, operationId: unknown): string | undefined {
  const operation = catalog.operations.find((candidate) => candidate.id === operationId);
  return operation ? bindings.get(operation.source ?? '') : undefined;
}

/** The connection a command runs on: its target's. Undefined for a name the
 * registry does not hold, which the owner refuses before any business work. */
export function apiCommandLaneOf(
  app: AppDef,
  registry: BusinessCommandRegistry,
  resources: Pick<RuntimeResources, 'connectionFor'>,
  command: unknown,
): string | undefined {
  if (typeof command !== 'string' || !Object.hasOwn(registry, command)) return undefined;
  const declared = registry[command];
  try {
    return resources.connectionFor(logicalResource(app, declared.source, declared.target));
  } catch {
    return undefined;
  }
}

/** The connections the exposed commands of a registry write, each once. */
export function apiCommandLaneConnections(
  app: AppDef,
  registry: BusinessCommandRegistry,
  resources: Pick<RuntimeResources, 'connectionFor'>,
  exposed: Iterable<string>,
): string[] {
  const lanes: string[] = [];
  for (const command of exposed) {
    const connection = apiCommandLaneOf(app, registry, resources, command);
    if (connection !== undefined && !lanes.includes(connection)) lanes.push(connection);
  }
  return lanes;
}

/** A connection this request does not read: its catalog names its tables, and every statement refuses. */
function refusingAdapter(schema: DatabaseSchema): Adapter {
  const refuse = async (): Promise<never> => {
    throw new Refusal('This App API request reads another connection.');
  };
  return Object.freeze({
    dialect: schema.dialect,
    introspect: async () => schema,
    query: refuse,
    count: refuse,
    close: async () => {},
  } satisfies Adapter);
}

/**
 * The App's runtime resources for one read on `lane`: that connection
 * reads through `adapter`, every other one through an adapter that refuses.
 * Each source keeps its own declared references, dates and schema scope, as
 * loading maps them (appRuntimeResources.ts). No database I/O.
 */
export function laneResources(
  app: AppDef,
  home: string,
  bindings: ReadonlyMap<string, string>,
  catalogs: ReadonlyMap<string, DatabaseSchema>,
  lane: string,
  adapter: Adapter,
): RuntimeResources {
  const refusing = new Map<string, Adapter>();
  const sources = new Map<string, AppAdapterSource>();
  for (const [source, connection] of bindings) {
    const schema = catalogs.get(connection);
    if (!schema) throw new Refusal('The application source is unavailable.');
    let reads = adapter;
    if (connection !== lane) {
      // One object per connection: sources sharing it are one group (appSourceAdapter.ts).
      reads = refusing.get(connection) ?? refusingAdapter(schema);
      refusing.set(connection, reads);
    }
    const scope = app.sources?.[source]?.schema;
    sources.set(source, {
      adapter: reads,
      schema,
      resources: physicalBindings(app, source || undefined),
      references: declaredReferences(app, source || undefined),
      dates: declaredDates(app, source || undefined),
      // A read never writes, on its lane or any other.
      writable: false,
      group: connection,
      ...(scope === undefined ? {} : { scope }),
    });
  }
  return mapOpenedAppRuntimeResources(app, home, sources, bindings);
}
