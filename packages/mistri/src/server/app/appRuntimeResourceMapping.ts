/** Mapping only over already-opened sources. Callers retain all connection,
 * lease, schema provenance and authorization responsibilities. No database I/O. */
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import {
  crossSourceReferences,
  declaredDates,
  declaredReferences,
  defaultSourceOf,
  homeSourceOf,
  physicalBindings,
  type AppDef,
} from '../../shared/app.js';
import { createAppResources } from './appResources.js';
import { createAppSourceAdapter, type AppAdapterSource } from './appSourceAdapter.js';
import type { RuntimeResources } from './appRuntimeResources.js';

export function mapOpenedAppRuntimeResources(
  app: AppDef,
  connection: string,
  sources: ReadonlyMap<string, AppAdapterSource>,
  bindings: ReadonlyMap<string, string>,
): RuntimeResources {
  if (!app.sources) {
    const opened = sources.get('');
    if (!opened || sources.size !== 1 || bindings.size !== 1 || bindings.get('') !== connection)
      throw new Refusal('The application source is unavailable.');
    const resources = createAppResources(opened.adapter, opened.schema, physicalBindings(app), declaredReferences(app), declaredDates(app));
    return {
      ...resources,
      connections: [connection],
      connectionFor: (resource) => {
        resources.toPhysical(resource);
        return connection;
      },
      toLogicalAt: (table, owner) => {
        if (owner !== connection) throw new Refusal('This write belongs to a different data source.');
        return resources.toLogical(table);
      },
      forConnection: (owner) => {
        if (owner !== connection) throw new Refusal('This write belongs to a different data source.');
        return resources.adapter;
      },
    };
  }
  const home = homeSourceOf(app)!;
  if (
    bindings.get(home) !== connection ||
    bindings.size !== sources.size ||
    Object.keys(app.sources).length !== bindings.size ||
    [...bindings.keys()].some((source) => !sources.has(source) || !Object.hasOwn(app.sources!, source)) ||
    [...bindings].some(([source, owner]) => (sources.get(source)!.group ?? owner) !== owner)
  ) {
    throw new Refusal('This is not the application entry point.');
  }
  /* Each source's group is its connection: sources that share one are
     executed, journaled and attributed as that one database, and a physical
     table and its connection always name exactly one resource. */
  const runtime = createAppSourceAdapter(
    Object.fromEntries([...bindings].map(([source, owner]) => [source, { ...sources.get(source)!, group: owner }])),
    defaultSourceOf(app),
    crossSourceReferences(app),
  );
  const connections = [...new Set(bindings.values())];
  const groupAt = (owner: string) => {
    const group = runtime.groups.get(owner);
    if (!group || !connections.includes(owner)) throw new Refusal('This write belongs to a different data source.');
    return group;
  };
  const toLogicalAt = (table: string, owner: string) => groupAt(owner).toLogical(table);
  return {
    adapter: runtime.adapter,
    schema: runtime.schema,
    connections,
    connectionFor: (resource) => bindings.get(runtime.resolve(resource).source)!,
    toPhysical: (resource) => runtime.resolve(resource).physicalTable,
    toLogical: (table) => toLogicalAt(table, connection),
    toLogicalAt,
    forConnection: (owner) => {
      groupAt(owner);
      return runtime.forGroup(owner);
    },
  };
}
