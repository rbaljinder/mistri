/**
 * Declarative CTE-backed derived resources (`defineQuery('seller_scorecard', { with, from, join, select })`).
 *
 * A derived resource compiles to a virtual read-only `TableMeta` in the reader's catalog,
 * typed automatically in `mistri-schema.d.ts` and readable through `listView`, `chart`,
 * `metric`, `page.useRows`, and `/api/view/run` as a single parameterized SQL
 * `WITH ... AS (...) SELECT ...` query (server/app/derivedReads.ts).
 *
 * Security: every base table and column referenced by any CTE step or the outer query must
 * exist in the reader's pruned catalog (`schema`); if a reader lacks grants to any source
 * table or column, the derived resource is omitted from their catalog rather than exposing
 * restricted data. Row policies and tenant isolation wrap every base table automatically via
 * `compileCte`'s `ScopedRelations`.
 */
import type { AppDef, AppDerived, AppDerivedStep } from './appModel.js';
export type { AppDerived, AppDerivedStep } from './appModel.js';
import { allowKeys, isRecord } from '@mistriwork/engine/shared/model.js';
import {
  compileCte,
  CTE_MAX_STEPS,
  cteReadReferences,
  cteTables,
  type CteGroupKey,
  type CteJoin,
  type CteQuerySpec,
  type CteRequest,
  type CteSelect,
  type CteStep,
} from '@mistriwork/engine/shared/cte.js';
import type { AggregateMeasure } from '@mistriwork/engine/shared/aggregate.js';
import { DATE_UNITS } from '@mistriwork/engine/shared/breakdown.js';
import { ANSI_STYLE, type DateUnit, type Filter } from '@mistriwork/engine/shared/filter.js';
import { parseQuery } from '@mistriwork/engine/shared/query.js';
import { columnKind, tableNamed, type ColumnMeta, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
export type { DerivedTable } from '@mistriwork/engine/shared/servedApp.js';

export type AppDerivedJoin = NonNullable<AppDerivedStep['join']>[number];
export type AppDerivedMeasure = NonNullable<AppDerivedStep['measures']>[string];
export type AppDerivedGroupKey = NonNullable<AppDerivedStep['groupBy']>[number];

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const AGG_FNS = new Set(['count', 'sum', 'avg', 'min', 'max']);
const STEP_KEYS = ['from', 'alias', 'where', 'join', 'groupBy', 'measures', 'select', 'orderBy', 'limit'] as const;
const QUERY_KEYS = ['name', 'with', ...STEP_KEYS] as const;

function parseStep(raw: unknown, at: string, allowedKeys: readonly string[]): AppDerivedStep {
  if (!isRecord(raw)) throw new Error(`${at} must be an object with { from, ... }.`);
  allowKeys(raw, allowedKeys, at);
  if (typeof raw.from !== 'string' || !raw.from.trim()) throw new Error(`${at} names no "from" resource or CTE.`);
  if (raw.alias !== undefined && (typeof raw.alias !== 'string' || !NAME.test(raw.alias))) {
    throw new Error(`${at}: "alias" must be a valid SQL identifier.`);
  }
  if (raw.where !== undefined && typeof raw.where !== 'string') {
    throw new Error(`${at}: "where" must be a query string (e.g. "status = active").`);
  }
  let join: AppDerivedJoin[] | undefined;
  if (raw.join !== undefined) {
    if (!Array.isArray(raw.join)) throw new Error(`${at}: "join" must be an array of { target, on, kind? }.`);
    join = raw.join.map((entry, idx) => {
      const jAt = `${at}.join[${idx}]`;
      if (!isRecord(entry)) throw new Error(`${jAt} must be { target, on, kind? }.`);
      allowKeys(entry, ['target', 'alias', 'kind', 'on'], jAt);
      if (typeof entry.target !== 'string' || !entry.target.trim()) throw new Error(`${jAt} names no "target".`);
      if (entry.alias !== undefined && (typeof entry.alias !== 'string' || !NAME.test(entry.alias))) {
        throw new Error(`${jAt}: "alias" must be a valid identifier.`);
      }
      const kind = entry.kind === undefined ? 'inner' : entry.kind;
      if (kind !== 'inner' && kind !== 'left') throw new Error(`${jAt}: "kind" must be "inner" or "left".`);
      if (
        !Array.isArray(entry.on) ||
        entry.on.length !== 2 ||
        typeof entry.on[0] !== 'string' ||
        typeof entry.on[1] !== 'string' ||
        !entry.on[0].trim() ||
        !entry.on[1].trim()
      ) {
        throw new Error(`${jAt}: "on" must be a [leftColumn, rightColumn] pair.`);
      }
      return {
        target: entry.target.trim(),
        ...(entry.alias ? { alias: entry.alias } : {}),
        kind,
        on: [entry.on[0].trim(), entry.on[1].trim()] as const,
      };
    });
  }
  let groupBy: AppDerivedGroupKey[] | undefined;
  if (raw.groupBy !== undefined) {
    if (!Array.isArray(raw.groupBy)) throw new Error(`${at}: "groupBy" must be an array of columns.`);
    groupBy = raw.groupBy.map((g, idx) => {
      if (typeof g === 'string' && g.trim()) return g.trim();
      if (isRecord(g)) {
        const gAt = `${at}.groupBy[${idx}]`;
        allowKeys(g, ['column', 'bucket', 'as'], gAt);
        if (typeof g.column !== 'string' || !g.column.trim()) throw new Error(`${gAt} names no "column".`);
        if (g.bucket !== undefined && (typeof g.bucket !== 'string' || !DATE_UNITS.includes(g.bucket as DateUnit))) {
          throw new Error(`${gAt}: "bucket" must be one of ${DATE_UNITS.join(', ')}.`);
        }
        if (g.as !== undefined && (typeof g.as !== 'string' || !NAME.test(g.as))) {
          throw new Error(`${gAt}: "as" must be a valid identifier.`);
        }
        return {
          column: g.column.trim(),
          ...(g.bucket ? { bucket: g.bucket as DateUnit } : {}),
          ...(g.as ? { as: g.as } : {}),
        };
      }
      throw new Error(`${at}.groupBy[${idx}] must be a column name or { column, bucket?, as? }.`);
    });
  }
  let measures: Record<string, AppDerivedMeasure> | undefined;
  if (raw.measures !== undefined) {
    if (!isRecord(raw.measures) || !Object.keys(raw.measures).length) {
      throw new Error(`${at}: "measures" must be a non-empty map of { alias: { fn, column? } }.`);
    }
    measures = {};
    for (const [alias, spec] of Object.entries(raw.measures)) {
      const mAt = `${at}.measures.${alias}`;
      if (!NAME.test(alias)) throw new Error(`${mAt}: "${alias}" is not a valid column identifier.`);
      if (!isRecord(spec)) throw new Error(`${mAt} must be { fn, column? }.`);
      allowKeys(spec, ['fn', 'column'], mAt);
      if (typeof spec.fn !== 'string' || !AGG_FNS.has(spec.fn)) {
        throw new Error(`${mAt}: "fn" must be one of count, sum, avg, min, max.`);
      }
      if (spec.fn !== 'count' && (typeof spec.column !== 'string' || !spec.column.trim())) {
        throw new Error(`${mAt}: "${spec.fn}" requires a "column".`);
      }
      if (spec.column !== undefined && (typeof spec.column !== 'string' || !spec.column.trim())) {
        throw new Error(`${mAt}: "column" must be a non-empty string.`);
      }
      measures[alias] = {
        fn: spec.fn as AppDerivedMeasure['fn'],
        ...(typeof spec.column === 'string' ? { column: spec.column.trim() } : {}),
      };
    }
  }
  let select: Record<string, string> | undefined;
  if (raw.select !== undefined) {
    if (!isRecord(raw.select) || !Object.keys(raw.select).length) {
      throw new Error(`${at}: "select" must be a non-empty map of { outputColumn: sourceColumn }.`);
    }
    select = {};
    for (const [alias, col] of Object.entries(raw.select)) {
      if (!NAME.test(alias)) throw new Error(`${at}.select: "${alias}" is not a valid column identifier.`);
      if (typeof col !== 'string' || !col.trim()) throw new Error(`${at}.select.${alias} must name a source column.`);
      select[alias] = col.trim();
    }
  }
  let orderBy: { column: string; direction: 'asc' | 'desc' }[] | undefined;
  if (raw.orderBy !== undefined) {
    if (!Array.isArray(raw.orderBy)) throw new Error(`${at}: "orderBy" must be an array of { column, direction? }.`);
    orderBy = raw.orderBy.map((o, idx) => {
      const oAt = `${at}.orderBy[${idx}]`;
      if (!isRecord(o)) throw new Error(`${oAt} must be { column, direction? }.`);
      allowKeys(o, ['column', 'direction'], oAt);
      if (typeof o.column !== 'string' || !o.column.trim()) throw new Error(`${oAt} names no "column".`);
      const dir = o.direction ?? 'asc';
      if (dir !== 'asc' && dir !== 'desc') throw new Error(`${oAt}: "direction" must be "asc" or "desc".`);
      return { column: o.column.trim(), direction: dir };
    });
  }
  let limit: number | undefined;
  if (raw.limit !== undefined) {
    if (typeof raw.limit !== 'number' || !Number.isSafeInteger(raw.limit) || raw.limit < 1) {
      throw new Error(`${at}: "limit" must be a positive whole number.`);
    }
    limit = raw.limit;
  }
  return {
    from: raw.from.trim(),
    ...(raw.alias ? { alias: raw.alias } : {}),
    ...(raw.where ? { where: raw.where } : {}),
    ...(join ? { join } : {}),
    ...(groupBy ? { groupBy } : {}),
    ...(measures ? { measures } : {}),
    ...(select ? { select } : {}),
    ...(orderBy ? { orderBy } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

/** Parses `derived: [defineQuery('name', { ... }), ...]` in an App manifest. */
export function parseDerived(raw: unknown, where: string): AppDerived[] {
  if (!Array.isArray(raw)) throw new Error(`${where}: "derived" is a list of defineQuery('name', { ... }).`);
  const seen = new Set<string>();
  return raw.map((item, i) => {
    const at = `${where}: derived[${i}]`;
    if (!isRecord(item)) throw new Error(`${at} is not a defineQuery('name', { ... }).`);
    allowKeys(item, QUERY_KEYS, at);
    if (typeof item.name !== 'string' || !NAME.test(item.name) || item.name === '_derived') {
      throw new Error(`${at} has no valid resource name (e.g. "seller_scorecard").`);
    }
    if (seen.has(item.name)) throw new Error(`${at}: a second derived resource is called "${item.name}".`);
    seen.add(item.name);

    let withSteps: Record<string, AppDerivedStep> | undefined;
    if (item.with !== undefined) {
      if (!isRecord(item.with)) throw new Error(`${at} ("${item.name}"): "with" must be an object of named CTE steps.`);
      const entries = Object.entries(item.with);
      if (entries.length > CTE_MAX_STEPS - 1) {
        throw new Error(`${at} ("${item.name}"): "with" may define at most ${CTE_MAX_STEPS - 1} CTE steps.`);
      }
      withSteps = {};
      for (const [stepName, stepRaw] of entries) {
        if (!NAME.test(stepName) || stepName === '_derived') {
          throw new Error(`${at} ("${item.name}").with: "${stepName}" is not a valid CTE name.`);
        }
        withSteps[stepName] = parseStep(stepRaw, `${at} ("${item.name}").with.${stepName}`, STEP_KEYS);
      }
    }
    const { name: _name, with: _with, ...outerRaw } = item;
    const outer = parseStep(outerRaw, `${at} ("${item.name}")`, STEP_KEYS);
    return {
      name: item.name,
      ...(withSteps ? { with: withSteps } : {}),
      ...outer,
    };
  });
}

function parseStepWhere(from: string, text: string, at: string): Filter {
  const parsed = parseQuery(`${from} where ${text}`);
  if (parsed.errors.length || !parsed.query) {
    throw new Error(`${at}: invalid "where" expression: ${parsed.errors[0]?.message ?? 'could not parse'}`);
  }
  return parsed.query.filter ?? { groups: [] };
}

function toCteSpec(step: AppDerivedStep, at: string): CteQuerySpec {
  const filter = step.where ? parseStepWhere(step.from, step.where, at) : undefined;
  const joins: CteJoin[] | undefined = step.join?.map((j) => ({
    target: j.target,
    ...(j.alias ? { alias: j.alias } : {}),
    kind: j.kind ?? 'inner',
    on: j.on,
  }));
  const by: CteGroupKey[] | undefined = step.groupBy?.map((g) => {
    if (typeof g === 'string') {
      const leaf = g.includes('.') ? g.slice(g.indexOf('.') + 1) : g;
      return { column: g, name: leaf };
    }
    const leaf = g.column.includes('.') ? g.column.slice(g.column.indexOf('.') + 1) : g.column;
    return { column: g.column, name: g.as ?? leaf, ...(g.bucket ? { bucket: g.bucket } : {}) };
  });
  const measures: AggregateMeasure[] | undefined = step.measures
    ? Object.entries(step.measures).map(([name, m]) => ({
        name,
        fn: m.fn,
        ...(m.column ? { column: m.column } : {}),
      }))
    : undefined;
  const select: CteSelect[] | undefined = step.select
    ? Object.entries(step.select).map(([alias, column]) => ({ column, alias }))
    : undefined;
  const orderBy = step.orderBy?.map((o) => ({ column: o.column, direction: o.direction ?? ('asc' as const) }));
  return {
    from: step.from,
    ...(step.alias ? { alias: step.alias } : {}),
    ...(joins?.length ? { joins } : {}),
    ...(filter?.groups.length ? { filter } : {}),
    ...(by?.length ? { by } : {}),
    ...(measures?.length ? { measures } : {}),
    ...(select?.length ? { select } : {}),
    ...(orderBy?.length ? { orderBy } : {}),
    ...(step.limit !== undefined ? { limit: step.limit } : {}),
  };
}

/** Converts a parsed `AppDerived` declaration into a `CteRequest`. */
export function derivedToCteRequest(derived: AppDerived): CteRequest {
  const withSteps: CteStep[] = Object.entries(derived.with ?? {}).map(([name, step]) => ({
    name,
    ...toCteSpec(step, `derived "${derived.name}".with.${name}`),
  }));
  return {
    with: withSteps,
    query: toCteSpec(derived, `derived "${derived.name}"`),
  };
}

function inferStepColumns(
  spec: CteQuerySpec,
  schema: DatabaseSchema,
  cteCols: ReadonlyMap<string, ReadonlyMap<string, ColumnMeta>>,
): ColumnMeta[] {
  const sources = new Map<string, { cols: ReadonlyMap<string, ColumnMeta>; leftJoined: boolean }>();
  const register = (target: string, aliasHint: string | undefined, leftJoined: boolean) => {
    const cteMap = cteCols.get(target);
    if (cteMap) {
      sources.set(aliasHint ?? target, { cols: cteMap, leftJoined });
      return;
    }
    const tbl = tableNamed(schema, target);
    if (!tbl) return;
    sources.set(aliasHint ?? tbl.name, {
      cols: new Map(tbl.columns.map((c) => [c.name, c])),
      leftJoined,
    });
  };
  register(spec.from, spec.alias, false);
  for (const j of spec.joins ?? []) register(j.target, j.alias, j.kind === 'left');

  const baseSource = sources.get(spec.alias ?? (cteCols.has(spec.from) ? spec.from : (tableNamed(schema, spec.from)?.name ?? spec.from)));
  const lookup = (ref: string): { meta?: ColumnMeta; leftJoined: boolean } => {
    const dot = ref.indexOf('.');
    if (dot > 0) {
      const src = sources.get(ref.slice(0, dot));
      return { meta: src?.cols.get(ref.slice(dot + 1)), leftJoined: Boolean(src?.leftJoined) };
    }
    return { meta: baseSource?.cols.get(ref), leftJoined: false };
  };

  if (spec.by?.length || spec.measures?.length) {
    const out: ColumnMeta[] = [];
    for (const key of spec.by ?? []) {
      const { meta, leftJoined } = lookup(key.column);
      out.push({
        name: key.name,
        type: key.bucket ? (key.bucket === 'weekday' ? 'INTEGER' : 'TEXT') : (meta?.type ?? 'TEXT'),
        nullable: leftJoined || (meta?.nullable ?? true),
        primaryKey: false,
      });
    }
    for (const m of spec.measures ?? []) {
      const { meta } = m.column ? lookup(m.column) : { meta: undefined };
      const type =
        m.fn === 'count'
          ? 'INTEGER'
          : m.fn === 'avg' || m.fn === 'sum'
            ? meta && columnKind(meta.type) === 'number'
              ? meta.type
              : 'NUMERIC'
            : (meta?.type ?? 'TEXT');
      out.push({
        name: m.name,
        type,
        nullable: m.fn !== 'count',
        primaryKey: false,
      });
    }
    return out;
  }

  const items = spec.select?.length ? spec.select : [...(baseSource?.cols.keys() ?? [])].map((col) => ({ column: col, alias: col }));
  return items.map((item) => {
    const { meta, leftJoined } = lookup(item.column);
    const outName = item.alias ?? (item.column.includes('.') ? item.column.replace(/\./g, '_') : item.column);
    return {
      name: outName,
      type: meta?.type ?? 'TEXT',
      nullable: leftJoined || (meta?.nullable ?? true),
      primaryKey: false,
    };
  });
}

function inferDerivedColumns(request: CteRequest, schema: DatabaseSchema): ColumnMeta[] {
  const cteCols = new Map<string, ReadonlyMap<string, ColumnMeta>>();
  for (const step of request.with) {
    const cols = inferStepColumns(step, schema, cteCols);
    cteCols.set(step.name, new Map(cols.map((c) => [c.name, c])));
  }
  return inferStepColumns(request.query, schema, cteCols);
}

/** Startup and `mistri check` validation of declarative CTE-backed derived resources. */
export function derivedProblems(app: AppDef, schema: DatabaseSchema): string[] {
  const problems: string[] = [];
  for (const derived of app.derived ?? []) {
    const at = `derived "${derived.name}"`;
    if (
      tableNamed(schema, derived.name) ||
      Object.hasOwn(app.resources ?? {}, derived.name) ||
      app.unions?.some((u) => u.name === derived.name)
    ) {
      problems.push(`${at}: "${derived.name}" is already a table or union; a derived resource needs a name of its own.`);
      continue;
    }
    let request: CteRequest;
    try {
      request = derivedToCteRequest(derived);
    } catch (error) {
      problems.push(`${at}: ${(error as Error).message}`);
      continue;
    }
    let missingBase = false;
    for (const tbl of cteTables(request)) {
      if (!Object.hasOwn(app.resources ?? {}, tbl) || !tableNamed(schema, tbl)) {
        problems.push(`${at}: "${tbl}" is not one of the App's resources.`);
        missingBase = true;
      }
    }
    if (missingBase) continue;
    try {
      compileCte(schema, request, ANSI_STYLE);
    } catch (error) {
      problems.push(`${at}: ${(error as Error).message}`);
    }
  }
  return problems;
}

/**
 * Adds every declarative `derived` resource that this reader's pruned catalog can satisfy
 * (every referenced base table and column exists in `schema`) as a virtual read-only `TableMeta`.
 */
export function withDerived(app: AppDef, schema: DatabaseSchema): DatabaseSchema {
  if (!app.derived?.length) return schema;
  const added: TableMeta[] = [];
  for (const derived of app.derived) {
    if (schema.tables.some((t) => t.id === derived.name)) continue;
    let request: CteRequest;
    try {
      request = derivedToCteRequest(derived);
    } catch {
      continue;
    }
    const refs = cteReadReferences(request);
    let readable = refs.length > 0;
    for (const ref of refs) {
      const tbl = tableNamed(schema, ref.table);
      if (!tbl) {
        readable = false;
        break;
      }
      const ownCols = new Set(tbl.columns.map((c) => c.name));
      if (ref.columns.some((col) => !ownCols.has(col))) {
        readable = false;
        break;
      }
    }
    if (!readable) continue;
    try {
      compileCte(schema, request, ANSI_STYLE);
    } catch {
      continue;
    }
    const columns = inferDerivedColumns(request, schema);
    if (!columns.length) continue;
    added.push({
      id: derived.name,
      name: derived.name,
      schema: '',
      isView: true,
      insertable: false,
      deletable: false,
      columns,
      derived: { request },
    });
  }
  return added.length ? { ...schema, tables: [...schema.tables, ...added] } : schema;
}
