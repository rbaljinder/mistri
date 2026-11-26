/**
 * Scoped SQL Common Table Expression (`WITH ... AS (...) SELECT ...`) compiler.
 *
 * Compiles structured, multi-stage CTE queries for both:
 *   1. Commands & page loaders (`db.with({ ... }, (cte) => ...)` and 1-hop joined `orderBy`), and
 *   2. Declarative CTE-backed `derived` resources in `app.ts`.
 *
 * Security & scoping invariant: every base table referenced anywhere in `with` or `query`
 * resolves through `ScopedRelations`, so tenant isolation (`auth.rows: 'tenant'`), row policies
 * (`auth.rows: 'policy'`), and field-level catalog pruning are enforced inside every CTE
 * automatically with zero raw SQL injection surface.
 */
import { buildWhere, type DateUnit, type SqlStyle } from './filter.js';
import { clampLimit, clampOffset } from './reads.js';
import { RequestFault } from './refusal.js';
import { findTable, type DatabaseSchema, type TableMeta } from './schema.js';
import { ScopedRelations, type RowScope } from './rowScope.js';
import { declaredScale, exactSqliteSum, sumsExactly } from './decimals.js';
import {
  FORBIDDEN_ANSWER_NAMES,
  type CteGroupKey,
  type CteJoin,
  type CteQuerySpec,
  type CteRequest,
  type CteResult,
  type CteSelect,
  type CteStep,
} from './aggregate.js';
export type { CteGroupKey, CteJoin, CteQuerySpec, CteRequest, CteResult, CteSelect, CteStep };

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/i;
const DATE_UNITS: readonly DateUnit[] = ['year', 'quarter', 'month', 'week', 'day'];
const AGG_FNS = new Set(['count', 'sum', 'avg', 'min', 'max']);
export const CTE_MAX_STEPS = 8;
export const CTE_MAX_JOINS = 8;

export interface CompiledCte {
  readonly text: string;
  readonly params: unknown[];
  readonly columns: readonly string[];
}

interface SourceInfo {
  readonly sqlRelation: string;
  readonly sqlAlias: string;
  readonly columns: ReadonlySet<string>;
  readonly tableMeta?: TableMeta;
}

function checkIdent(name: unknown, what: string): string {
  if (typeof name !== 'string' || !IDENT.test(name) || FORBIDDEN_ANSWER_NAMES.has(name)) {
    throw new RequestFault(`${what} "${String(name).slice(0, 64)}" is not a valid SQL name.`);
  }
  return name;
}

function bucketExpr(expr: string, unit: DateUnit, style: SqlStyle): string {
  if (!DATE_UNITS.includes(unit)) throw new RequestFault(`Unknown date period "${String(unit)}".`);
  if (style.dialect === 'postgres') {
    if (unit === 'weekday') return `EXTRACT(DOW FROM (${expr})::timestamp)::integer`;
    const fmt: Record<Exclude<DateUnit, 'weekday'>, string> = {
      hour: 'YYYY-MM-DD HH24',
      year: 'YYYY',
      quarter: 'YYYY-"Q"Q',
      month: 'YYYY-MM',
      week: 'IYYY-"W"IW',
      day: 'YYYY-MM-DD',
    };
    return `TO_CHAR(DATE_TRUNC('${unit}', (${expr})::timestamp), '${fmt[unit]}')`;
  }
  if (unit === 'hour') return `strftime('%Y-%m-%d %H', ${expr})`;
  if (unit === 'year') return `strftime('%Y', ${expr})`;
  if (unit === 'month') return `strftime('%Y-%m', ${expr})`;
  if (unit === 'day') return `strftime('%Y-%m-%d', ${expr})`;
  if (unit === 'week') return `strftime('%Y-W%W', ${expr})`;
  if (unit === 'weekday') return `CAST(strftime('%w', ${expr}) AS INTEGER)`;
  return `strftime('%Y', ${expr}) || '-Q' || ((CAST(strftime('%m', ${expr}) AS INTEGER) + 2) / 3)`;
}

/** Lists every base table name referenced by `request` (ignoring CTE names defined in earlier steps). */
export function cteTables(request: CteRequest): string[] {
  const defined = new Set<string>();
  const tables: string[] = [];
  const visit = (spec: CteQuerySpec) => {
    if (!defined.has(spec.from) && !tables.includes(spec.from)) tables.push(spec.from);
    for (const join of spec.joins ?? []) {
      if (!defined.has(join.target) && !tables.includes(join.target)) tables.push(join.target);
    }
  };
  for (const step of request.with) {
    visit(step);
    defined.add(step.name);
  }
  visit(request.query);
  return tables;
}

/**
 * Rewrites base table references inside a `CteRequest` via `mapTable`, leaving
 * earlier CTE names untouched and preserving original logical names as aliases
 * when the physical name differs.
 */
export function remapCteTables(request: CteRequest, mapTable: (table: string) => string): CteRequest {
  const defined = new Set<string>();
  const mapSpec = <S extends CteQuerySpec>(spec: S): S => {
    const fromMapped = defined.has(spec.from) ? spec.from : mapTable(spec.from);
    const alias = spec.alias ?? (!defined.has(spec.from) && fromMapped !== spec.from ? spec.from : undefined);
    const joins = spec.joins?.map((join) => {
      if (defined.has(join.target)) return join;
      const targetMapped = mapTable(join.target);
      return targetMapped === join.target ? join : { ...join, target: targetMapped, alias: join.alias ?? join.target };
    });
    return {
      ...spec,
      from: fromMapped,
      ...(alias ? { alias } : {}),
      ...(joins ? { joins } : {}),
    };
  };
  const steps = request.with.map((step) => {
    const mapped = mapSpec(step);
    defined.add(step.name);
    return mapped;
  });
  return { with: steps, query: mapSpec(request.query) };
}

/**
 * Every base table and its referenced columns across all CTE steps and the final query,
 * for grant & hidden-column enforcement (`columnGrants.ts`, `hiddenColumns.ts`).
 */
export function cteReadReferences(
  request: CteRequest,
): Array<{ readonly table: string; readonly columns: readonly string[]; readonly allColumns: boolean }> {
  const defined = new Set<string>();
  const byTable = new Map<string, { cols: Set<string>; all: boolean }>();
  const touch = (table: string) => {
    let entry = byTable.get(table);
    if (!entry) byTable.set(table, (entry = { cols: new Set(), all: false }));
    return entry;
  };
  const visit = (spec: CteQuerySpec) => {
    const aliasToBase = new Map<string, string>();
    const baseAlias = spec.alias ?? spec.from;
    if (!defined.has(spec.from)) {
      aliasToBase.set(baseAlias, spec.from);
      touch(spec.from);
    }
    for (const join of spec.joins ?? []) {
      const targetAlias = join.alias ?? join.target;
      if (!defined.has(join.target)) {
        aliasToBase.set(targetAlias, join.target);
        touch(join.target).cols.add(join.on[1]);
      }
      const left = join.on[0];
      const dot = left.indexOf('.');
      if (dot > 0) {
        const base = aliasToBase.get(left.slice(0, dot));
        if (base) touch(base).cols.add(left.slice(dot + 1));
      } else {
        const base = aliasToBase.get(baseAlias);
        if (base) touch(base).cols.add(left);
      }
    }
    const recordRef = (ref: string | undefined) => {
      if (!ref) return;
      const dot = ref.indexOf('.');
      if (dot > 0) {
        const base = aliasToBase.get(ref.slice(0, dot));
        if (base) touch(base).cols.add(ref.slice(dot + 1));
      } else {
        const base = aliasToBase.get(baseAlias);
        if (base) touch(base).cols.add(ref);
      }
    };
    const isAgg = Boolean(spec.measures?.length || spec.by?.length);
    if (isAgg) {
      for (const k of spec.by ?? []) recordRef(k.column);
      for (const m of spec.measures ?? []) recordRef(m.column);
    } else if (spec.select?.length) {
      for (const s of spec.select) recordRef(s.column);
    } else if (!defined.has(spec.from)) {
      touch(spec.from).all = true;
    }
    for (const group of spec.filter?.groups ?? []) {
      for (const cond of group) {
        recordRef(cond.column);
        recordRef(cond.other);
      }
    }
    for (const o of spec.orderBy ?? []) recordRef(o.column);
  };
  for (const step of request.with) {
    visit(step);
    defined.add(step.name);
  }
  visit(request.query);
  return [...byTable].map(([table, info]) => ({ table, columns: [...info.cols], allColumns: info.all }));
}

/**
 * Compiles a structured `CteRequest` into a single parameterized `WITH ... AS (...) SELECT ...` SQL statement.
 * All base tables go through `ScopedRelations` so tenant scoping and row policies apply inside every CTE.
 */
export function compileCte(
  schema: DatabaseSchema,
  request: CteRequest,
  style: SqlStyle,
  scope?: RowScope,
  policy: DatabaseSchema = schema,
): CompiledCte {
  if (!request || typeof request !== 'object' || !Array.isArray(request.with) || !request.query) {
    throw new RequestFault('A CTE request requires `with` steps and a final `query`.');
  }
  if (request.with.length > CTE_MAX_STEPS) {
    throw new RequestFault(`A CTE query may define at most ${CTE_MAX_STEPS} CTE steps.`);
  }

  const q = style.quote;
  const relations = new ScopedRelations(schema, style, scope, policy);
  const cteSchemas = new Map<string, ReadonlySet<string>>();

  /* Pre-plan all base table relations so `relations.finish()` captures every scoped CTE before parameter numbering. */
  const preplanSource = (target: string, knownCtes: ReadonlySet<string>) => {
    if (knownCtes.has(target)) return;
    const table = findTable(schema, target);
    if (!table) throw new RequestFault(`Unknown table or CTE "${target}".`);
    relations.table(table.id);
  };
  const preKnown = new Set<string>();
  for (const step of request.with) {
    const name = checkIdent(step.name, 'CTE name');
    if (preKnown.has(name)) throw new RequestFault(`Duplicate CTE name "${name}".`);
    preplanSource(step.from, preKnown);
    for (const j of step.joins ?? []) preplanSource(j.target, preKnown);
    preKnown.add(name);
  }
  preplanSource(request.query.from, preKnown);
  for (const j of request.query.joins ?? []) preplanSource(j.target, preKnown);

  const prefix = relations.finish();
  const params: unknown[] = [...prefix.params];

  const resolveSource = (
    target: string,
    aliasHint: string | undefined,
    knownCtes: Map<string, ReadonlySet<string>>,
    usedAliases: Set<string>,
  ): SourceInfo => {
    const cteCols = knownCtes.get(target);
    if (cteCols) {
      const alias = checkIdent(aliasHint ?? target, 'CTE alias');
      if (usedAliases.has(alias)) throw new RequestFault(`Duplicate table/CTE alias "${alias}" in query.`);
      usedAliases.add(alias);
      return { sqlRelation: q(target), sqlAlias: q(alias), columns: cteCols };
    }
    const table = findTable(schema, target);
    if (!table) throw new RequestFault(`Unknown table or CTE "${target}".`);
    const alias = checkIdent(aliasHint ?? table.name, 'Table alias');
    if (usedAliases.has(alias)) throw new RequestFault(`Duplicate table/CTE alias "${alias}" in query.`);
    usedAliases.add(alias);
    return {
      sqlRelation: relations.table(table.id),
      sqlAlias: q(alias),
      columns: new Set(table.columns.map((c) => c.name)),
      tableMeta: table,
    };
  };

  const compileSpec = (spec: CteQuerySpec, knownCtes: Map<string, ReadonlySet<string>>): { sql: string; columns: string[] } => {
    const joins = spec.joins ?? [];
    if (joins.length > CTE_MAX_JOINS) throw new RequestFault(`A CTE step may join at most ${CTE_MAX_JOINS} relations.`);

    const usedAliases = new Set<string>();
    const sources = new Map<string, SourceInfo>();
    const baseAlias = checkIdent(
      spec.alias ?? (knownCtes.has(spec.from) ? spec.from : (findTable(schema, spec.from)?.name ?? spec.from)),
      'From alias',
    );
    const baseSource = resolveSource(spec.from, baseAlias, knownCtes, usedAliases);
    sources.set(baseAlias, baseSource);

    const resolveCol = (ref: string): { expr: string; leaf: string; source: SourceInfo } => {
      const dot = ref.indexOf('.');
      if (dot > 0) {
        const prefixAlias = ref.slice(0, dot);
        const col = ref.slice(dot + 1);
        const src = sources.get(prefixAlias);
        if (!src) throw new RequestFault(`Unknown relation alias "${prefixAlias}" in "${ref}".`);
        if (!src.columns.has(col)) throw new RequestFault(`"${prefixAlias}" has no column "${col}".`);
        return { expr: `${src.sqlAlias}.${q(col)}`, leaf: col, source: src };
      }
      if (!baseSource.columns.has(ref)) {
        throw new RequestFault(`"${baseAlias}" has no column "${ref}".`);
      }
      return { expr: `${baseSource.sqlAlias}.${q(ref)}`, leaf: ref, source: baseSource };
    };

    const joinClauses: string[] = [];
    for (const join of joins) {
      const kind = join.kind ?? 'inner';
      if (kind !== 'inner' && kind !== 'left') throw new RequestFault(`Unsupported join kind "${String(kind)}".`);
      if (!Array.isArray(join.on) || join.on.length !== 2) throw new RequestFault('Each join requires on: [leftColumn, rightColumn].');
      const [leftRef, rightCol] = join.on;
      const left = resolveCol(leftRef);
      const targetAlias = checkIdent(
        join.alias ?? (knownCtes.has(join.target) ? join.target : (findTable(schema, join.target)?.name ?? join.target)),
        'Join alias',
      );
      const targetSource = resolveSource(join.target, targetAlias, knownCtes, usedAliases);
      if (!targetSource.columns.has(rightCol)) {
        throw new RequestFault(`Join target "${targetAlias}" has no column "${rightCol}".`);
      }
      sources.set(targetAlias, targetSource);
      const kw = kind === 'left' ? 'LEFT JOIN' : 'INNER JOIN';
      joinClauses.push(
        `${kw} ${targetSource.sqlRelation} AS ${targetSource.sqlAlias} ON ${left.expr} = ${targetSource.sqlAlias}.${q(rightCol)}`,
      );
    }

    const fromClause = `FROM ${baseSource.sqlRelation} AS ${baseSource.sqlAlias}${joinClauses.length ? ` ${joinClauses.join(' ')}` : ''}`;
    const whereBuilt = spec.filter
      ? buildWhere(spec.filter, style, params.length + 1, (col) => resolveCol(col).expr)
      : { text: '', params: [] };
    params.push(...whereBuilt.params);

    const outputCols: string[] = [];
    const selectClauses: string[] = [];
    const groupClauses: string[] = [];
    const outputExprs = new Map<string, string>();
    const isAggregating = Boolean(spec.measures?.length || spec.by?.length);

    if (isAggregating) {
      for (const key of spec.by ?? []) {
        const outName = checkIdent(key.name, 'Group key name');
        if (outputExprs.has(outName)) throw new RequestFault(`Duplicate output column "${outName}".`);
        const resolved = resolveCol(key.column);
        const expr = key.bucket ? bucketExpr(resolved.expr, key.bucket, style) : resolved.expr;
        selectClauses.push(`${expr} AS ${q(outName)}`);
        groupClauses.push(expr);
        outputCols.push(outName);
        outputExprs.set(outName, expr);
      }
      for (const m of spec.measures ?? []) {
        if (!AGG_FNS.has(m.fn)) throw new RequestFault(`Unsupported aggregate function "${m.fn}".`);
        const outName = checkIdent(m.name, 'Measure name');
        if (outputExprs.has(outName)) throw new RequestFault(`Duplicate output column "${outName}".`);
        let expr: string;
        if (m.fn === 'count' && !m.column) {
          expr = 'COUNT(*)';
        } else {
          if (!m.column) throw new RequestFault(`Aggregate "${m.fn}" requires a column.`);
          const resolved = resolveCol(m.column);
          if (m.fn === 'sum' && style.dialect === 'sqlite' && resolved.source.tableMeta) {
            const colMeta = resolved.source.tableMeta.columns.find((c) => c.name === resolved.leaf);
            const scale = colMeta ? declaredScale(colMeta.type) : undefined;
            if (colMeta && sumsExactly(colMeta.type) && scale !== undefined && scale > 0) {
              expr = exactSqliteSum(resolved.expr, scale, resolved.leaf).text;
            } else {
              expr = `SUM(${resolved.expr})`;
            }
          } else {
            expr = `${m.fn.toUpperCase()}(${resolved.expr})`;
          }
        }
        selectClauses.push(`${expr} AS ${q(outName)}`);
        outputCols.push(outName);
        outputExprs.set(outName, expr);
      }
    } else {
      const selected = spec.select?.length ? spec.select : [...baseSource.columns].map((col) => ({ column: col, alias: col }));
      for (const item of selected) {
        const resolved = resolveCol(item.column);
        const outName = checkIdent(
          item.alias ?? (item.column.includes('.') ? item.column.replace(/\./g, '_') : resolved.leaf),
          'Select alias',
        );
        if (outputExprs.has(outName)) throw new RequestFault(`Duplicate output column "${outName}".`);
        selectClauses.push(`${resolved.expr} AS ${q(outName)}`);
        outputCols.push(outName);
        outputExprs.set(outName, resolved.expr);
      }
    }

    const orderClauses: string[] = [];
    for (const o of spec.orderBy ?? []) {
      const dir = o.direction === 'desc' ? 'DESC' : 'ASC';
      if (outputExprs.has(o.column)) {
        orderClauses.push(`${q(o.column)} ${dir}`);
      } else {
        orderClauses.push(`${resolveCol(o.column).expr} ${dir}`);
      }
    }

    const limitSql = spec.limit !== undefined ? ` LIMIT ${clampLimit(spec.limit)}` : '';
    const offsetSql = spec.offset ? ` OFFSET ${clampOffset(spec.offset)}` : '';
    const groupSql = groupClauses.length ? ` GROUP BY ${groupClauses.join(', ')}` : '';
    const orderSql = orderClauses.length ? ` ORDER BY ${orderClauses.join(', ')}` : '';
    const sql = `SELECT ${selectClauses.join(', ')} ${fromClause}${whereBuilt.text}${groupSql}${orderSql}${limitSql}${offsetSql}`;
    return { sql, columns: outputCols };
  };

  const cteDefinitions: string[] = [];
  for (const step of request.with) {
    const name = checkIdent(step.name, 'CTE name');
    const compiledStep = compileSpec(step, cteSchemas);
    cteDefinitions.push(`${q(name)} AS (${compiledStep.sql})`);
    cteSchemas.set(name, new Set(compiledStep.columns));
  }

  const main = compileSpec(request.query, cteSchemas);
  const ctePrefix = cteDefinitions.length
    ? prefix.text
      ? `${prefix.text.trimEnd()},\n     ${cteDefinitions.join(',\n     ')}\n`
      : `WITH ${cteDefinitions.join(',\n     ')}\n`
    : prefix.text;

  return {
    text: `${ctePrefix}${main.sql}`,
    params,
    columns: main.columns,
  };
}
