/**
 * Server-side execution of bounded 1-to-many child includes on `/api/view/run`.
 *
 * Each declared child include runs through `readView` over the same scoped `adapter` and `schema`
 * as the parent query — preserving role grants, field projection, row policy, and tenant isolation —
 * in one batched `WHERE by IN (...parentKeys)` query per child relation within the same HTTP round trip.
 */
import type { Adapter } from '../adapters/adapter.js';
import { findTable, primaryKey, type DatabaseSchema } from '../shared/schema.js';
import { andQuery, type QueryPerson } from '../shared/query.js';
import { compileWhere } from '../shared/pageWhere.js';
import { parseViewQuery, type ViewDef } from '../shared/view.js';
import {
  CHILD_INCLUDE_DEFAULT_LIMIT,
  CHILD_INCLUDE_MAX,
  CHILD_INCLUDE_MAX_LIMIT,
  isChildIncludeEntry,
  type IncludedChildPayload,
} from '../shared/viewInclude.js';
import { readView } from './resourceReadOperations.js';

const CHILD_TOTAL_CAP = 1_000;

interface ValidatedChildInclude {
  readonly alias: string;
  readonly from: string;
  readonly by: readonly string[];
  readonly show?: readonly string[];
  readonly sort?: string;
  readonly limit: number;
  readonly where?: unknown;
  readonly query?: string;
}

/** Canonical lookup key for `rowsByParent`: bare string for 1-column PKs, `col=val,...` for composite PKs. */
function parentGroupKey(cols: readonly string[], values: readonly (string | number)[]): string {
  if (cols.length === 1) return String(values[0]);
  return cols.map((col, idx) => `${col}=${String(values[idx])}`).join(',');
}

/** Validates raw `body.include` on `/api/view/run`, returning either normalized specs or an error message. */
export function parseChildIncludes(raw: unknown): { ok: true; specs: readonly ValidatedChildInclude[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, specs: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'include must be an object mapping aliases to child include specs.' };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > CHILD_INCLUDE_MAX) {
    return { ok: false, error: `include allows at most ${CHILD_INCLUDE_MAX} child relations per request.` };
  }
  const specs: ValidatedChildInclude[] = [];
  for (const [alias, spec] of entries) {
    if (!alias || !isChildIncludeEntry(spec)) {
      return { ok: false, error: `include "${alias}" must specify a "by" foreign-key column.` };
    }
    const from = typeof spec.from === 'string' && spec.from ? spec.from : alias;
    const by = typeof spec.by === 'string' ? (spec.by ? [spec.by] : []) : [...spec.by];
    if (!by.length || by.some((col) => !col)) return { ok: false, error: `include "${alias}" must specify a non-empty "by" column.` };
    const limit = spec.limit === undefined ? CHILD_INCLUDE_DEFAULT_LIMIT : spec.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > CHILD_INCLUDE_MAX_LIMIT) {
      return { ok: false, error: `include "${alias}" limit must be a whole number from 1 to ${CHILD_INCLUDE_MAX_LIMIT}.` };
    }
    if (spec.show !== undefined && (!Array.isArray(spec.show) || spec.show.some((c) => typeof c !== 'string' || !c))) {
      return { ok: false, error: `include "${alias}" show must be a list of column paths.` };
    }
    if (spec.sort !== undefined && typeof spec.sort !== 'string') {
      return { ok: false, error: `include "${alias}" sort must be a string.` };
    }
    if (spec.query !== undefined && typeof spec.query !== 'string') {
      return { ok: false, error: `include "${alias}" query must be a string.` };
    }
    specs.push({
      alias,
      from,
      by,
      ...(spec.show?.length ? { show: spec.show } : {}),
      ...(spec.sort?.trim() ? { sort: spec.sort.trim() } : {}),
      limit,
      ...(spec.where !== undefined ? { where: spec.where } : {}),
      ...(spec.query?.trim() ? { query: spec.query.trim() } : {}),
    });
  }
  return { ok: true, specs };
}

/** Runs validated child includes for the rows returned by a parent `/api/view/run` query. */
export async function runChildIncludes(
  adapter: Adapter,
  schema: DatabaseSchema,
  baseId: string,
  parentView: ViewDef,
  parentColumns: readonly string[],
  parentRows: readonly Record<string, unknown>[],
  specs: readonly ValidatedChildInclude[],
  now: Date,
  person: { readonly me?: QueryPerson | null },
): Promise<{ ok: true; included: Record<string, IncludedChildPayload> } | { ok: false; error: string }> {
  if (!specs.length) return { ok: true, included: {} };
  const baseTable = findTable(schema, baseId);
  if (!baseTable) return { ok: false, error: `Base table "${baseId}" not found for include.` };
  const pkCols = primaryKey(baseTable);
  if (!pkCols.length) {
    return { ok: false, error: `Child include requires "${baseTable.name}" to have a primary key.` };
  }
  const pkResultKeys = pkCols.map((pkCol) => {
    const pkIdx = parentView.columns.findIndex((c) => c.path === pkCol);
    return pkIdx >= 0 ? (parentColumns[pkIdx] ?? pkCol) : pkCol;
  });

  const parentTuples = new Map<string, (string | number)[]>();
  for (const row of parentRows) {
    const tuple: (string | number)[] = [];
    let valid = true;
    for (const key of pkResultKeys) {
      const val = row[key];
      if (typeof val !== 'string' && typeof val !== 'number') {
        valid = false;
        break;
      }
      tuple.push(val);
    }
    if (valid) parentTuples.set(parentGroupKey(pkCols, tuple), tuple);
  }
  const uniqueTuples = [...parentTuples.values()];

  const included: Record<string, IncludedChildPayload> = {};
  if (!uniqueTuples.length) {
    for (const spec of specs) included[spec.alias] = { rowsByParent: {} };
    return { ok: true, included };
  }

  for (const spec of specs) {
    const childTable = findTable(schema, spec.from);
    if (!childTable) {
      return { ok: false, error: `Included table "${spec.from}" was not found.` };
    }
    if (spec.by.length !== pkCols.length) {
      return {
        ok: false,
        error:
          pkCols.length === 1
            ? `Child include requires "${baseTable.name}" to have a single-column primary key.`
            : `Child include "${spec.alias}" must name ${pkCols.length} "by" columns matching "${baseTable.name}" primary key (${pkCols.join(', ')}).`,
      };
    }
    for (const col of spec.by) {
      if (!childTable.columns.some((c) => c.name === col)) {
        return { ok: false, error: `Included table "${childTable.name}" has no column "${col}".` };
      }
    }
    const childPk = primaryKey(childTable);
    const requestedPaths = spec.show?.length
      ? [...new Set([...spec.show, ...childPk, ...spec.by])]
      : [...new Set([...childTable.columns.map((c) => c.name), ...spec.by])];

    let extraText = '';
    if (spec.where !== undefined) {
      const extra = compileWhere(spec.where, childTable);
      if ('error' in extra) return { ok: false, error: extra.error };
      extraText = andQuery(extraText, extra.text);
    }
    if (spec.query) extraText = andQuery(extraText, spec.query);

    let filterGroups: NonNullable<ViewDef['filter']>['groups'];
    let orderBy: ViewDef['orderBy'];
    if (spec.by.length === 1) {
      const parentKeys = uniqueTuples.map((tuple) => tuple[0]!);
      const byWhere = compileWhere({ [spec.by[0]!]: parentKeys }, childTable);
      if ('error' in byWhere) return { ok: false, error: byWhere.error };
      let queryText = andQuery(byWhere.text, extraText);
      if (spec.sort) queryText = queryText ? `${queryText} sort ${spec.sort}` : `sort ${spec.sort}`;
      const parsed = parseViewQuery(schema, childTable.id, queryText, now, person);
      if (parsed.errors.length) return { ok: false, error: parsed.errors[0]!.message };
      filterGroups = parsed.filter.groups;
      orderBy = parsed.orderBy;
    } else {
      let queryText = extraText;
      if (spec.sort) queryText = queryText ? `${queryText} sort ${spec.sort}` : `sort ${spec.sort}`;
      const parsed = queryText
        ? parseViewQuery(schema, childTable.id, queryText, now, person)
        : { filter: { groups: [] }, orderBy: [], errors: [] };
      if (parsed.errors.length) return { ok: false, error: parsed.errors[0]!.message };
      const tupleGroups = uniqueTuples.map((tuple) => spec.by.map((col, idx) => ({ path: col, op: '=' as const, value: tuple[idx]! })));
      filterGroups = parsed.filter.groups.length
        ? tupleGroups.flatMap((tGroup) => parsed.filter.groups.map((eGroup) => [...tGroup, ...eGroup]))
        : tupleGroups;
      orderBy = parsed.orderBy;
    }

    const childView: ViewDef = {
      id: `include:${spec.alias}`,
      name: spec.alias,
      base: childTable.id,
      columns: requestedPaths.map((path) => ({ path })),
      ...(filterGroups.length ? { filter: { groups: filterGroups } } : {}),
      ...(orderBy?.length ? { orderBy } : {}),
    };
    const fetchLimit = Math.min(uniqueTuples.length * spec.limit, CHILD_TOTAL_CAP);
    const { view: validatedChild, result: childResult } = await readView(
      adapter,
      schema,
      childView,
      { limit: fetchLimit, offset: 0 },
      'none',
    );

    const pathToKey = new Map<string, string>();
    validatedChild.columns.forEach((col, i) => {
      if (childResult.columns[i] !== undefined && !pathToKey.has(col.path)) {
        pathToKey.set(col.path, childResult.columns[i]!);
      }
    });
    const outPaths = spec.show?.length ? [...new Set([...spec.show, ...childPk])] : childTable.columns.map((c) => c.name);
    const byKeys = spec.by.map((col) => pathToKey.get(col) ?? col);

    const rowsByParent: Record<string, Record<string, unknown>[]> = {};
    for (const rawRow of childResult.rows) {
      const tuple: (string | number)[] = [];
      let valid = true;
      for (const byKey of byKeys) {
        const val = rawRow[byKey];
        if (typeof val !== 'string' && typeof val !== 'number') {
          valid = false;
          break;
        }
        tuple.push(val);
      }
      if (!valid) continue;
      const groupKey = parentGroupKey(pkCols, tuple);
      let bucket = rowsByParent[groupKey];
      if (!bucket) rowsByParent[groupKey] = bucket = [];
      if (bucket.length >= spec.limit) continue;
      const shaped: Record<string, unknown> = {};
      for (const path of outPaths) {
        const colKey = pathToKey.get(path) ?? path;
        shaped[path] = rawRow[colKey];
      }
      bucket.push(shaped);
    }
    included[spec.alias] = { rowsByParent };
  }

  return { ok: true, included };
}
