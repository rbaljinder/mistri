import { qualifyResource } from '../../shared/app.js';
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { appResourceCatalog, type AppResourceCatalog } from './appResources.js';
import { declaredEdge, withDeclaredEdges, type DeclaredReference } from '@mistriwork/engine/shared/declaredReferences.js';
import type { DeclaredDate } from '../../shared/appModel.js';

export interface AppSourceDefinition {
  /** The connection's physical catalog: all of it, even where `scope` narrows what this source sees. */
  schema: DatabaseSchema;
  resources?: Record<string, string>;
  /** The App's soft keys within this source, in its local names. */
  references?: readonly DeclaredReference[];
  /** The App's TEXT columns it declares dates within this source, in its local names. */
  dates?: readonly DeclaredDate[];
  /** The one engine schema this source sees of its connection (`sources.<name>.schema`). */
  scope?: string;
  /**
   * Sources naming one group share one connection: one database, one
   * transaction, and real keys between their tables. Absent, a source is a
   * group of its own.
   */
  group?: string;
}

export interface AppResourceTarget {
  source: string;
  /** The group executing it: the connection its source shares with others, or the source's own name. */
  group: string;
  /** Logical identity within this source's own resource catalog. */
  table: string;
  physicalTable: string;
}

export interface AppSourceCatalog {
  /**
   * The resource graph used for authoring and presentation. Its
   * dialect/readAt describe the default source, not a shared execution engine.
   * Dispatch by resolve(), using that group's catalog and adapter for execution.
   */
  schema: DatabaseSchema;
  defaultSource: string | undefined;
  /** Each source's own catalog, in its local names. */
  catalogs: ReadonlyMap<string, AppResourceCatalog>;
  /** Each group's catalog, in the App's resource names: what one connection executes. */
  groups: ReadonlyMap<string, AppResourceCatalog>;
  resolve(resource: string): AppResourceTarget;
}

/**
 * A declared reference from one source to another, in the App's names. On
 * one connection it is joined in SQL like a reference within one source. On
 * two it is `stitched`: read in two steps (appStitchedReads.ts), and no
 * group's catalog holds it, so no statement can try to join it.
 */
function crossSourceEdge(
  schema: DatabaseSchema,
  reference: DeclaredReference,
  targets: ReadonlyMap<string, AppResourceTarget>,
  dialectOf: (group: string) => string,
): DatabaseSchema['foreignKeys'][number] {
  const at = `App resource "${reference.table}", references "${reference.column}"`;
  const edge = declaredEdge(schema, reference, at);
  const name = edge.name.replace(/[^A-Za-z0-9_]+/g, '_');
  const from = targets.get(edge.from.table)!,
    to = targets.get(edge.to.table)!;
  if (from.group === to.group) return { ...edge, name };
  /* An API is asked for one record at a time, by its key; the second step is
     one read of every key a page names, which it cannot answer. */
  if (dialectOf(to.group) === 'http') {
    throw new Error(
      `${at}: ${edge.to.table} is read from an API, which looks records up one at a time; a reference from another source needs a database there.`,
    );
  }
  return { ...edge, name, stitched: true };
}

/** The part of a connection's catalog one engine schema holds, with no key leading out of it. */
export function schemaScoped(schema: DatabaseSchema, scope: string): DatabaseSchema {
  return within(schema, new Set(schema.tables.filter((table) => table.schema === scope).map((table) => table.id)));
}

/** A catalog cut to some of its tables: every reference out of them dropped, as if the rest were not there. */
function within(schema: DatabaseSchema, ids: ReadonlySet<string>): DatabaseSchema {
  return {
    ...schema,
    tables: schema.tables
      .filter((table) => ids.has(table.id))
      .map((table) => ({
        ...table,
        columns: table.columns.map((column) => {
          if (!column.references || ids.has(column.references.table)) return column;
          const { references: _outside, ...kept } = column;
          return kept;
        }),
      })),
    foreignKeys: schema.foreignKeys.filter((fk) => ids.has(fk.from.table) && ids.has(fk.to.table)),
  };
}

/**
 * Combine source catalogs into the App's one resource graph. Sources on
 * different connections stay disjoint: nothing is invented between them.
 * Sources that share a connection are one database, so a real key from one
 * of its schemas to another is kept, and joins in SQL like any other.
 */
export function createAppSourceCatalog(
  sources: Record<string, AppSourceDefinition>,
  defaultSource: string | undefined,
  /** The App's declared references from one source to another, in its resource names (crossSourceReferences). */
  references: readonly DeclaredReference[] = [],
): AppSourceCatalog {
  if (
    !sources ||
    typeof sources !== 'object' ||
    Array.isArray(sources) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(sources))
  ) {
    throw new Error('App sources must be a plain record of named source definitions.');
  }
  const catalogs = new Map<string, AppResourceCatalog>();
  const groupOf = new Map<string, string>();
  for (const [name, source] of Object.entries(sources)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name === 'prototype' || Object.hasOwn(Object.prototype, name)) {
      throw new Error(`Invalid app source name "${name}". Use a non-reserved identifier, such as "operations".`);
    }
    const physical = source.scope === undefined ? source.schema : schemaScoped(source.schema, source.scope);
    catalogs.set(name, appResourceCatalog(physical, source.resources, source.references, source.dates));
    groupOf.set(name, source.group ?? name);
  }
  if (defaultSource !== undefined && !catalogs.has(defaultSource))
    throw new Error(`Default app source "${defaultSource}" is not configured.`);
  if (!catalogs.size) throw new Error('An App needs at least one source.');
  const primary = catalogs.get(defaultSource ?? catalogs.keys().next().value!)!;

  const targets = new Map<string, AppResourceTarget>();
  const qualify = (source: string, table: string) => qualifyResource(defaultSource, source, table);
  /* On more than one connection the merged catalog's dialect is only the
     default source's, so each table says which engine reads it: what encodes
     its values (the App API's apiDialectOf) must not guess from the merge. */
  const several = new Set(groupOf.values()).size > 1;
  const tables: DatabaseSchema['tables'] = [];
  const foreignKeys: DatabaseSchema['foreignKeys'] = [];
  for (const [source, catalog] of catalogs) {
    for (const table of catalog.schema.tables) {
      const resource = qualify(source, table.id);
      if (targets.has(resource))
        throw new Error(`App resource "${resource}" is ambiguous across sources. Configure distinct source and resource names.`);
      targets.set(resource, { source, group: groupOf.get(source)!, table: table.id, physicalTable: catalog.toPhysical(table.id) });
      tables.push({
        ...table,
        id: resource,
        // tableNamed() also searches name. A secondary bare name here would
        // silently resolve unqualified requests against a different source.
        name: resource,
        ...(several ? { sourceDialect: catalog.schema.dialect } : {}),
        columns: table.columns.map((column) => ({
          ...column,
          ...(column.references
            ? {
                references: {
                  ...column.references,
                  table: qualify(source, column.references.table),
                },
              }
            : {}),
        })),
      });
    }
    foreignKeys.push(
      ...catalog.schema.foreignKeys.map((fk) => ({
        ...fk,
        from: { ...fk.from, table: qualify(source, fk.from.table) },
        to: { ...fk.to, table: qualify(source, fk.to.table) },
      })),
    );
  }

  /* Each group's physical tables under the App's names. A physical id is
     unique within one connection (a schema-qualified name), so a table and
     its connection always say which source it belongs to. */
  const members = new Map<string, Map<string, string>>();
  for (const [resource, target] of targets) {
    const physical = members.get(target.group) ?? new Map<string, string>();
    if (physical.has(target.physicalTable)) {
      throw new Error(
        `Table "${target.physicalTable}" belongs to two sources on one connection. Scope each source to a schema of its own.`,
      );
    }
    physical.set(target.physicalTable, resource);
    members.set(target.group, physical);
  }
  const connectionOf = new Map<string, AppSourceDefinition>();
  for (const [name, source] of Object.entries(sources)) connectionOf.set(groupOf.get(name)!, source);
  const byId = new Map(tables.map((table) => [table.id, table]));
  for (const [group, physical] of members) {
    const shared = [...groupOf.values()].filter((value) => value === group).length > 1;
    if (!shared) continue;
    for (const fk of connectionOf.get(group)!.schema.foreignKeys) {
      const from = physical.get(fk.from.table),
        to = physical.get(fk.to.table);
      if (!from || !to || targets.get(from)!.source === targets.get(to)!.source) continue;
      foreignKeys.push({ ...fk, from: { ...fk.from, table: from }, to: { ...fk.to, table: to } });
      if (fk.from.columns.length !== 1) continue;
      const table = byId.get(from)!;
      table.columns = table.columns.map((column) =>
        column.name === fk.from.columns[0] && !column.references
          ? { ...column, references: { table: to, column: fk.to.columns[0] } }
          : column,
      );
    }
  }
  const merged: DatabaseSchema = { ...primary.schema, tables, foreignKeys };
  const dialectOf = (group: string) => connectionOf.get(group)!.schema.dialect;
  const schema = withDeclaredEdges(
    merged,
    references.map((reference) => crossSourceEdge(merged, reference, targets, dialectOf)),
  );

  const groups = new Map<string, AppResourceCatalog>();
  for (const [group, physical] of members) {
    const logical = new Map([...physical].map(([id, resource]) => [resource, id]));
    const names = Object.keys(sources).filter((name) => groupOf.get(name) === group);
    const scoped = names.some((name) => sources[name].scope !== undefined);
    const full = connectionOf.get(group)!.schema;
    groups.set(group, {
      // Its own connection's dialect and reading, never the default source's.
      schema: (({ tables: reach, foreignKeys: keys }) => ({ ...catalogs.get(names[0])!.schema, tables: reach, foreignKeys: keys }))(
        within(schema, new Set(logical.keys())),
      ),
      toPhysical: (resource) => logical.get(resource) ?? refuseResource(resource),
      toLogical: (id) => physical.get(id) ?? refuseTable(id),
      ...(scoped ? { bounds: { full, within: within(full, new Set(physical.keys())) } } : {}),
    });
  }
  return {
    defaultSource,
    catalogs,
    groups,
    schema,
    resolve(resource) {
      const target = targets.get(resource);
      if (!target) throw new Refusal(`Unknown app resource "${resource}".`);
      return { ...target };
    },
  };
}

const refuseResource = (resource: string): never => {
  throw new Refusal(`Unknown app resource "${resource}".`);
};
const refuseTable = (id: string): never => {
  throw new Refusal(`Unknown table "${id}" in the app resource catalog.`);
};
