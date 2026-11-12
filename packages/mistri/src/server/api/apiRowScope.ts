/** A token's row scope (`api.scopes`, `--scope name:key`, `$scope`): one key
 * row, and per resource the column — or one-hop path — that holds it. It is
 * compiled into the row scope the request already resolves, so a scoped read
 * costs no round trip of its own: the rows are grants ∧ row policy ∧ scope. */
import type { Condition } from '@mistriwork/engine/shared/filter.js';
import { snapshotRowScope, via, type RowScope, type RowScopeFilter, type ViaCondition } from '@mistriwork/engine/shared/rowScope.js';
import { coerceForColumn, columnKind, primaryKey, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { resolvePath } from '@mistriwork/engine/shared/viewPaths.js';
import { Refusal, type InsertRequest, type WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import type { ApiScopeDef, AppApiDef } from '../../shared/appApi.js';
import { BusinessCommandExecutionError } from '../commands/commandErrors.js';
import { requestScope } from '../tenant/tenantApiRequest.js';

/** The scope a token carries: a declared scope's name and its key, as text. */
export type ApiRowScopeRef = Readonly<{ name: string; key: string }>;

const fail = (at: string, message: string): never => {
  throw new Error(`${at}: ${message}.`);
};
const tableOf = (schema: DatabaseSchema, id: string): TableMeta | undefined => schema.tables.find((table) => table.id === id);
const columnOf = (table: TableMeta, name: string) => table.columns.find((column) => column.name === name);

/** What one resource's mapping reaches: the column it compares, and for a path the parent it walks to. */
interface Reach {
  readonly column: string;
  readonly type: string;
  readonly hop?: { readonly fk: string; readonly parent: string; readonly key: string };
}

function reachOf(schema: DatabaseSchema, resource: string, mapping: string, at: string): Reach {
  const table = tableOf(schema, resource) ?? fail(at, `"${resource}" is not in the App's catalog`);
  const parts = mapping.split('.');
  if (parts.length === 1) {
    const column = columnOf(table, mapping) ?? fail(at, `"${resource}" has no column "${mapping}"`);
    return { column: column.name, type: column.type };
  }
  let resolved;
  try {
    resolved = resolvePath(schema, resource, mapping);
  } catch (error) {
    return fail(at, `"${mapping}" is not a path of "${resource}": ${(error as Error).message}`);
  }
  const hop = resolved.hops[0];
  if (resolved.hops.length !== 1 || !hop || hop.from.columns.length !== 1 || hop.to.columns.length !== 1 || hop.from.table !== resource)
    return fail(at, `"${mapping}" must follow one reference of "${resource}" to its parent, then name a column there`);
  if (resolved.rollup || resolved.computed || resolved.tags || resolved.jsonKey)
    return fail(at, `"${mapping}" must end on a stored column`);
  return {
    column: resolved.column.name,
    type: resolved.column.type,
    hop: { fk: hop.from.columns[0]!, parent: hop.to.table, key: hop.to.columns[0]! },
  };
}

/** `mistri check`'s word on a declaration, against the logical catalog the API reads. */
export function checkApiScopes(api: Pick<AppApiDef, 'resources' | 'scopes'>, schema: DatabaseSchema): void {
  for (const [name, scope] of Object.entries(api.scopes ?? {})) {
    const at = `api.scopes.${name}`;
    if (!api.resources[scope.key]) fail(`${at}.key`, `"${scope.key}" must be a resource in api.resources`);
    const keyTable = tableOf(schema, scope.key) ?? fail(`${at}.key`, `"${scope.key}" is not in the App's catalog`);
    const keyMapping = scope.rows[scope.key];
    if (typeof keyMapping !== 'string' || keyMapping.includes('.'))
      fail(`${at}.rows.${scope.key}`, 'the key resource names one of its own columns');
    const keyColumn =
      columnOf(keyTable, keyMapping as string) ?? fail(`${at}.rows.${scope.key}`, `"${scope.key}" has no column "${keyMapping}"`);
    const pk = primaryKey(keyTable);
    if (pk.length !== 1 || pk[0] !== keyColumn.name)
      fail(
        `${at}.rows.${scope.key}`,
        `"${keyColumn.name}" must be the single-column primary key of "${scope.key}", so one key names one row`,
      );
    const kind = columnKind(keyColumn.type);
    for (const [resource, mapping] of Object.entries(scope.rows)) {
      const spot = `${at}.rows.${resource}`;
      if (!api.resources[resource]) fail(spot, `"${resource}" must be a resource in api.resources`);
      if (mapping === true) {
        if (!tableOf(schema, resource)) fail(spot, `"${resource}" is not in the App's catalog`);
        continue;
      }
      const reach = reachOf(schema, resource, mapping, spot);
      if (columnKind(reach.type) !== kind)
        fail(
          spot,
          `"${mapping}" is ${reach.type}, and the key "${scope.key}.${keyColumn.name}" is ${keyColumn.type}; they must be the same kind`,
        );
      if (reach.hop && scope.rows[reach.hop.parent] === undefined)
        fail(spot, `"${mapping}" walks to "${reach.hop.parent}", which the scope does not reach; map it too`);
    }
  }
}

/** `[api-scope-unreached]`: a resource the API serves that a scope leaves out reads nothing under it. Advice, not a refusal. */
export function apiScopeAdvisories(api: AppApiDef | undefined): string[] {
  return Object.entries(api?.scopes ?? {}).flatMap(([name, scope]) =>
    Object.keys(api!.resources)
      .filter((resource) => scope.rows[resource] === undefined)
      .sort()
      .map(
        (resource) =>
          `api.scopes.${name} [api-scope-unreached]: api.resources "${resource}" is not in the scope, so a token scoped to "${name}" reads no rows of it. Map it, or leave it as intended.`,
      ),
  );
}

/** A scope as the audit names it (the read audit's `scope`, a receipt's): `name:key`. */
export const apiScopeName = (scope: ApiRowScopeRef): string => `${scope.name}:${scope.key}`;

/** A request's token scope with its declaration: what narrows its rows and admits its inserts. */
interface ApiScopeBinding {
  readonly name: string;
  readonly scope: ApiScopeDef;
  readonly key: string;
}

/** The scope an API request's token carries (tenantApiRequest.ts), bound to the App's declaration. A scope the
 * App no longer declares is refused through `deny`: its tokens serve nothing rather than everything. */
export function requestApiScope(
  api: Pick<AppApiDef, 'scopes'> | undefined,
  request: unknown,
  deny: () => never,
): ApiScopeBinding | undefined {
  const ref = requestScope(request);
  if (!ref) return undefined;
  const scope = api?.scopes?.[ref.name];
  return scope && Object.hasOwn(api!.scopes!, ref.name) ? Object.freeze({ name: ref.name, scope, key: ref.key }) : deny();
}

/** The key's value as the key column holds it: a number column compares a number, never the text a token carries. */
function keyValue(schema: DatabaseSchema, scope: ApiScopeDef, key: string): string | number | boolean {
  const table = tableOf(schema, scope.key);
  const column = table && columnOf(table, scope.rows[scope.key] as string);
  if (!column) throw new Error(`api.scopes: "${scope.key}" is not in the catalog.`);
  const value = coerceForColumn(column.type, key);
  if (value === null) throw new Error('api.scopes: the scope key is empty.');
  return value;
}

/** One resource's condition under the scope: `column = key`, or the parent's rows that hold it. */
function conditionFor(schema: DatabaseSchema, resource: string, mapping: string, key: string | number | boolean): Condition | ViaCondition {
  const reach = reachOf(schema, resource, mapping, `api.scopes rows.${resource}`);
  const value = coerceForColumn(reach.type, String(key)) ?? key;
  const test: Condition = { column: reach.column, op: '=', value: value as Condition['value'] };
  return reach.hop ? via(reach.hop.fk, reach.hop.parent, reach.hop.key, [[test]]) : test;
}

/**
 * `rows` narrowed to one key: each resource the scope maps keeps its rule with
 * the scope's condition ANDed into every group; one it marks `true` keeps its
 * rule; every other resource reads nothing. Never wider than `rows`: a resource
 * `rows` leaves out stays out.
 */
export function narrowRowsToApiScope(rows: RowScope, scope: ApiScopeDef, key: string, schema: DatabaseSchema): RowScope {
  const value = keyValue(schema, scope, key);
  const out: Record<string, boolean | RowScopeFilter> = {};
  for (const [resource, rule] of Object.entries(rows)) {
    const mapping = scope.rows[resource];
    if (mapping === undefined || rule === false) out[resource] = false;
    else if (mapping === true) out[resource] = rule;
    else {
      const condition = conditionFor(schema, resource, mapping, value);
      out[resource] = rule === true ? { groups: [[condition]] } : { ...rule, groups: rule.groups.map((group) => [...group, condition]) };
    }
  }
  return out;
}

/** The parents a path mapping walks to from the given resources: an insert there is proven against its parent's rows. */
export function apiScopeParents(scope: ApiScopeDef, schema: DatabaseSchema, resources: Iterable<string>): Set<string> {
  const parents = new Set<string>();
  for (const resource of resources) {
    const mapping = scope.rows[resource];
    if (typeof mapping !== 'string' || !mapping.includes('.')) continue;
    const hop = reachOf(schema, resource, mapping, `api.scopes rows.${resource}`).hop;
    if (hop) parents.add(hop.parent);
  }
  return parents;
}

/** A tenant App's authored rows narrowed to the token's key, before they meet the membership layer. */
export function narrowAuthoredRows(schema: DatabaseSchema, authored: RowScope, binding: ApiScopeBinding): RowScope {
  return snapshotRowScope(schema, narrowRowsToApiScope(snapshotRowScope(schema, authored), binding.scope, binding.key, schema));
}

const outOfScope = (table: string, column?: string) =>
  new BusinessCommandExecutionError(
    'out_of_scope',
    'not_applied',
    column,
    undefined,
    `A row of "${table}" must belong to this token's scope.`,
  );

/**
 * A write transaction whose inserts land inside the scope: a mapped column the
 * insert leaves out is filled from the key, one that names another key is
 * refused, and so is a row under a path whose parent is not in scope or a
 * resource the scope does not reach. Updates and deletes need nothing here: the
 * row scope already hides every row outside it, so they answer not-found.
 */
export function admitScopedInserts(
  records: WriteTransaction,
  scope: ApiScopeDef,
  key: string,
  schema: DatabaseSchema,
  count: WriteTransaction['count'] = records.count,
): WriteTransaction {
  const value = keyValue(schema, scope, key);
  const admit = async (request: InsertRequest): Promise<InsertRequest> => {
    const mapping = scope.rows[request.table];
    if (mapping === undefined) throw outOfScope(request.table);
    if (mapping === true) return request;
    const reach = reachOf(schema, request.table, mapping, `api.scopes rows.${request.table}`);
    const expected = coerceForColumn(reach.type, String(value));
    if (!reach.hop) {
      const given = request.values?.[reach.column];
      if (given === undefined) return { ...request, values: { ...request.values, [reach.column]: expected } };
      if (given === null || String(coerceForColumn(reach.type, given)) !== String(expected)) throw outOfScope(request.table, reach.column);
      return request;
    }
    // The parent must be a row of the key: read under the scoped rows, so a parent outside them counts nothing.
    const fk = request.values?.[reach.hop.fk];
    if (fk === undefined || fk === null) throw outOfScope(request.table, reach.hop.fk);
    let found = 0;
    try {
      found = await count(reach.hop.parent, {
        groups: [
          [
            { column: reach.hop.key, op: '=', value: fk as Condition['value'] },
            { column: reach.column, op: '=', value: expected as Condition['value'] },
          ],
        ],
      });
    } catch (error) {
      // A grant or row policy that hides the parent table is the same answer as a parent outside the scope; a lost
      // connection or a timeout is not an answer about the row, so it surfaces as the server error it is.
      if (!(error instanceof Refusal)) throw error;
      found = 0;
    }
    if (found !== 1) throw outOfScope(request.table, reach.hop.fk);
    return request;
  };
  return Object.freeze<WriteTransaction>({
    ...records,
    insert: async (request) => records.insert(await admit(request)),
    ...(records.insertMany
      ? {
          insertMany: async (requests: readonly InsertRequest[]) => {
            const admitted: InsertRequest[] = [];
            for (const request of requests) admitted.push(await admit(request));
            return records.insertMany!(admitted);
          },
        }
      : {}),
  });
}
