/**
 * Multi-table views, built out of **reference paths**.
 *
 * The `Filter` in filter.ts addresses exactly one table and must keep doing
 * so: it is the shape every read goes through, and widening it to carry joins
 * would put join-building into every code path that filters anything. So the
 * multi-table story is a separate idea rather than a bigger filter, and the
 * idea is dot-walking:
 *
 *     invoice     customer_id.name contains Harbour
 *     work_order  assigned_to.last_name = Petrova
 *                 and customer_id.country_code.name = Australia
 *
 * A path is a chain of foreign keys starting at the base table, ending at a
 * column. `customer_id.name` means "follow invoice.customer_id to customer,
 * then take name". Nothing about it is guessed: the foreign key graph is
 * already introspected, so every hop is derivable, checkable, and reversible
 * into SQL — a path compiles to a LEFT JOIN chain and a qualified column.
 *
 * One mechanism answers three separate questions. Filtering across a long
 * walk, showing a field from a related table, and the composer UI are all the
 * same thing seen from three angles; the composer is a visual editor for the
 * path set.
 *
 * Two properties are load-bearing and are pinned by tests:
 *
 *   - **LEFT JOIN, never INNER.** A null foreign key must leave the base row
 *     in the result with nulls beside it. A composer that quietly drops rows
 *     is worse than no composer at all, because the number it shows you is
 *     wrong in a direction you cannot see.
 *   - **Every value is a bound parameter.** Only identifiers are ever quoted
 *     into the text, and they are quoted by the dialect's `SqlStyle`. The
 *     WHERE clause is still built by `buildWhere`, which now takes an
 *     identifier resolver so a path can become `"customer_1"."name"` without
 *     a second predicate builder existing to disagree with the first.
 */
import {
  ANSI_STYLE,
  buildWhere,
  collate,
  orderClauseSql,
  type Condition,
  type Filter,
  type Op,
  type SqlFragment,
  type SqlStyle,
} from './filter.js';
import { clampLimit, clampOffset, countStatement } from './reads.js';
import {
  aggregateInput,
  declaredOrder,
  findTable,
  type ColumnMeta,
  type DatabaseSchema,
  type ForeignKey,
  type TableMeta,
} from './schema.js';
import { ANY_CONDITION, anyConditions, expandSegments, parseQuery, splitClauseTail, type QueryError, type QueryPerson } from './query.js';
import { stitchedListProblem } from './stitchedPaths.js';
import { qualifiedTable } from './sqlRelation.js';
import { ScopedRelations, type RowScope } from './rowScope.js';
import { slug } from './slug.js';
import { maskQuoted } from './maskQuoted.js';
import {
  type ViewColumn,
  type ViewCondition,
  type ViewFilter,
  type ViewOrder,
  type AggregateFn,
  type ViewAggregate,
  type ViewDef,
  PathError,
  type ResolvedPath,
  AGGREGATE_FNS,
  resolveAggregate,
  tryResolvePath,
  labelColumnMeta,
  backrefsTo,
} from './viewPaths.js';
import { viewPaths, withViewComputed, withViewLabels } from './viewLabels.js';
import { rollupColumnMeta } from './rollups.js';
import { TAGS_COLUMN, tagsColumnMeta } from './tagLists.js';
import { computedColumnMeta } from './computed.js';
import { withViewReferences } from './declaredReferences.js';
export { withViewComputed, withViewLabels } from './viewLabels.js';
export {
  type ViewColumn,
  type ViewFilter,
  type ViewOrder,
  type AggregateFn,
  type ViewAggregate,
  type ViewDef,
  MAX_PATH_DEPTH,
  PathError,
  hopName,
  type Hop,
  hopsFrom,
  type ResolvedPath,
  resolvePath,
  backrefsTo,
  resolveAggregate,
  tableAtPrefix,
  tryResolvePath,
} from './viewPaths.js';

/* ---------- compilation ---------- */

/* A view's filter as a column filter, for `buildWhere`. A condition's
   collation travels with it: dropped here, a keyset comparison would fall
   back to the column's collation while its ORDER BY kept the binary one. */
function viewConditions(view: ViewDef): Filter | undefined {
  return view.filter?.groups.length
    ? {
        groups: view.filter.groups.map((group) =>
          group.map((c): Condition => ({
            column: c.path,
            op: c.op,
            value: c.value,
            ...(c.collation === undefined ? {} : { collation: c.collation }),
            ...(c.other === undefined ? {} : { other: c.other }),
            ...(c.any === undefined ? {} : { any: c.any }),
          })),
        ),
      }
    : undefined;
}

export interface CompiledColumn {
  /** The path this column came from. */
  path: string;
  /** The output name in the result set. */
  name: string;
  /** Table the value actually lives on, for the UI's grouping. */
  table: string;
  column: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  /** How many references were followed to reach it. 0 is the base table. */
  hops: number;
  /** Set when the column is a summary of a many-valued relationship; `latest` is a rollup's newest row (rollups.ts). */
  aggregate?: AggregateFn | 'latest';
}

export interface CompiledJoin {
  alias: string;
  table: string;
  /** The path prefix this join corresponds to, e.g. `customer_id.country_code`. */
  path: string;
}

interface CompiledView {
  text: string;
  params: unknown[];
  columns: CompiledColumn[];
  joins: CompiledJoin[];
  limit: number;
}

/**
 * Alias generation.
 *
 * Two requirements pull in opposite directions. Aliases must never collide —
 * `work_order` in the demo has three separate references to `employee`, so a
 * scheme keyed on the target table alone produces three joins all called
 * `employee` and a statement that does not parse. And they must be stable, so
 * the same view compiles to the same SQL every time and a diff of the explain
 * panel means something.
 *
 * Both fall out of keying on the *path prefix* rather than the table: a prefix
 * identifies a join uniquely, so the same path used twice reuses one join and
 * two paths through the same table get two. The readable table name is kept as
 * a prefix and made unique by an ordinal assigned in first-use order.
 */
export class JoinPlan {
  readonly joins: CompiledJoin[] = [];
  private byPrefix = new Map<string, string>();
  private n = 0;

  constructor(
    private schema: DatabaseSchema,
    base: TableMeta,
    private style: SqlStyle,
    private relation: (id: string) => string = (id) => qualifiedTable(schema, id, style),
  ) {
    this.byPrefix.set('', alias(base.name, 0));
  }

  get baseAlias(): string {
    return this.byPrefix.get('')!;
  }

  /** The alias for a path prefix, creating the join chain if it is new. */
  aliasFor(hops: ForeignKey[], hopNames: string[]): string {
    let prefix = '';
    for (let i = 0; i < hops.length; i++) {
      prefix = prefix ? `${prefix}.${hopNames[i]}` : hopNames[i];
      /* Already planned: the same path used twice must reuse one join, not
         add a second copy of the same table under a different alias. */
      if (this.byPrefix.has(prefix)) continue;
      const target = findTable(this.schema, hops[i].to.table)!;
      this.byPrefix.set(prefix, alias(target.name, ++this.n));
      this.joins.push({ alias: this.byPrefix.get(prefix)!, table: target.id, path: prefix });
    }
    return this.byPrefix.get(prefix) ?? this.baseAlias;
  }

  /** The fully qualified, quoted SQL for a resolved path's final column. */
  qualify(resolved: ResolvedPath): string {
    const owner = this.aliasFor(resolved.hops, resolved.hopNames);
    return `${this.style.quote(owner)}.${this.style.quote(resolved.column.name)}`;
  }

  /** The relation a table is read as in this statement: its scoped CTE, or the table itself. */
  relationOf(id: string): string {
    return this.relation(id);
  }

  /** The alias of a path prefix that has already been planned, or the base. */
  aliasOfPrefix(prefix: string): string {
    return this.byPrefix.get(prefix) ?? this.baseAlias;
  }

  /**
   * A fresh alias for something that is not a join — a subquery's table.
   *
   * It draws from the same counter as the joins, which is what guarantees a
   * correlated subquery over `employee` cannot pick the alias a LEFT JOIN
   * over `employee` is already using. Two `employee_3`s in one statement is
   * a self-join nobody asked for, and the wrong answer rather than an error.
   */
  subAlias(name: string): string {
    return alias(name, ++this.n);
  }

  /**
   * The JOIN clauses, in the order the aliases were created.
   *
   * Order matters for more than tidiness: a join may only reference an alias
   * introduced before it, and creation order is exactly path order, so a
   * nested hop always follows the hop it hangs off.
   */
  clauses(): string[] {
    return this.joins.map((join) => {
      const parts = join.path.split('.');
      const parentPrefix = parts.slice(0, -1).join('.');
      const parent = this.byPrefix.get(parentPrefix)!;
      const fk = this.fkFor(join.path)!;
      const target = findTable(this.schema, join.table)!;
      /* Every column of the key, not just the first. A composite foreign key
         joined on one column is a cross product wearing a join's clothes. */
      const on = fk.to.columns
        .map(
          (toCol, i) =>
            `${this.style.quote(join.alias)}.${this.style.quote(toCol)} = ` +
            `${this.style.quote(parent)}.${this.style.quote(fk.from.columns[i] ?? fk.from.columns[0])}`,
        )
        .join(' AND ');
      /* LEFT, always. An INNER JOIN here would drop every base row whose
         foreign key is null — silently, and in a direction that looks like
         the data simply is not there. */
      return `  LEFT JOIN ${this.relation(target.id)} ${this.style.quote(join.alias)} ON ${on}`;
    });
  }

  private fkChain = new Map<string, ForeignKey>();

  /** Remember which key produced each join, so `clauses` can rebuild the ON. */
  record(path: string, fk: ForeignKey): void {
    if (!this.fkChain.has(path)) this.fkChain.set(path, fk);
  }

  private fkFor(path: string): ForeignKey | undefined {
    return this.fkChain.get(path);
  }
}

/** Alias text: the table's own name, made unique by an ordinal. */
function alias(name: string, n: number): string {
  /* Truncated because Postgres silently cuts identifiers at 63 bytes, and a
     silent cut is exactly how two long table names become one alias. */
  const safe = name.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40) || 't';
  return `${safe}_${n}`;
}

/**
 * Compile a view to one parameterised SELECT.
 *
 * Order of work is deliberate and is what makes the output deterministic:
 * columns, then the filter, then the sort. Aliases are handed out on first
 * use, so the same view always produces the same statement.
 */
export function compileView(
  schema: DatabaseSchema,
  view: ViewDef,
  style: SqlStyle,
  offset: number | unknown = 0,
  scope?: RowScope,
): CompiledView {
  // The App's soft keys, where this catalog is the database's own (declaredReferences.ts).
  schema = withViewReferences(schema, view.references);
  const base = findTable(schema, view.base);
  if (!base) {
    throw new PathError(`No table called "${view.base}" in this database, so the view has nothing to start from.`, view.base, view.base, 0);
  }

  const relations = new ScopedRelations(schema, style, scope);
  const baseRelation = relations.table(base.id);
  const plan = new JoinPlan(schema, base, style, relations.table);

  const { resolve, qualify, membership, exists } = viewPaths(schema, view, plan, style, relations);

  /* An empty column list means the base table's own columns. Expanding it
     here rather than emitting `SELECT *` keeps the result's column list
     knowable without running the statement, which is what the composer's
     field checklist reads. */
  const wanted: ViewColumn[] = view.columns?.length ? view.columns : base.columns.map((c) => ({ path: c.name }));

  const seen = new Map<string, number>();
  const columns: CompiledColumn[] = [];
  const select: string[] = [];

  for (const col of wanted) {
    const resolved = resolve(col.path);
    const sql = qualify(col.path);
    /* Two paths can legitimately end on the same name — `customer_id.name`
       and `sold_by.name` are both "name" if aliased carelessly. The path is
       already unique, so it is the default; an explicit collision gets a
       numeric suffix rather than one column quietly overwriting the other. */
    let name = col.alias?.trim() || resolved.path;
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count) name = `${name}_${count + 1}`;

    columns.push({
      path: resolved.path,
      name,
      table: resolved.table.id,
      column: resolved.column.name,
      type: resolved.column.type,
      /* A column on a joined table is nullable in the result even when the
         column itself is NOT NULL: the LEFT JOIN can produce no row at all.
         Saying otherwise would have the UI render a real null as an error. */
      nullable: resolved.column.nullable || resolved.hops.length > 0,
      primaryKey: resolved.column.primaryKey,
      hops: resolved.hops.length,
      // A rollup reads like a column and is a summary: nothing edits it.
      ...(resolved.rollup && !resolved.rollup.through ? { aggregate: resolved.rollup.fn } : {}),
    });
    select.push(`${sql} AS ${style.quote(name)}`);
  }

  /* Aggregates come after the plain columns, and after them on purpose: a
     summary hanging off a joined table needs that join's alias to exist, and
     resolving columns first is what puts it there. */
  for (const aggregate of view.aggregates ?? []) {
    const resolved = resolveAggregate(schema, view.base, aggregate);
    /* The parent side is a path prefix, so an aggregate can hang off a joined
       table as easily as off the base — "invoice lines on the invoice this
       shipment belongs to" is the same construction one hop along. */
    if (resolved.on) {
      /* Qualifying any column on the parent is what plans the joins leading
         to it and records their keys. Doing it through the same `qualify`
         the columns use is deliberate: two ways of planning a join is two
         ways for the aliases to disagree. */
      qualify(`${resolved.on}.${resolved.parent.columns[0].name}`);
    }
    const parentAlias = resolved.on ? plan.aliasOfPrefix(resolved.on) : plan.baseAlias;

    const childAlias = plan.subAlias(resolved.child.name);
    const on = resolved.fk.to.columns
      .map(
        (toCol, i) =>
          `${style.quote(childAlias)}.${style.quote(resolved.fk.from.columns[i] ?? resolved.fk.from.columns[0])} = ` +
          `${style.quote(parentAlias)}.${style.quote(toCol)}`,
      )
      .join(' AND ');

    /* COUNT(*) rather than COUNT(column): a column count skips nulls, which
       turns "how many parts" into "how many parts have a quantity" without
       saying so. SUM over no rows is left as NULL rather than coerced to 0 —
       a work order with no parts has no total, and 0 is a claim about money
       that nobody made. */
    const expression =
      resolved.aggregate.fn === 'count'
        ? 'COUNT(*)'
        : `${resolved.aggregate.fn.toUpperCase()}(${aggregateInput(
            `${style.quote(childAlias)}.${style.quote(resolved.column!.name)}`,
            resolved.column!.type,
            style.dialect,
          )})`;

    let name = resolved.name;
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count) name = `${name}_${count + 1}`;

    select.push(
      `(SELECT ${expression} FROM ${relations.table(resolved.child.id)} ${style.quote(childAlias)}` +
        ` WHERE ${on}) AS ${style.quote(name)}`,
    );
    columns.push({
      path: resolved.name,
      name,
      table: resolved.child.id,
      column: resolved.column?.name ?? '*',
      type: resolved.aggregate.fn === 'count' ? 'integer' : (resolved.column?.type ?? 'integer'),
      // COUNT is never null; every other summary is, over an empty child set.
      nullable: resolved.aggregate.fn !== 'count',
      primaryKey: false,
      hops: resolved.on ? resolved.on.split('.').length : 0,
      aggregate: resolved.aggregate.fn,
    });
  }

  /* The filter is compiled by `buildWhere`, not beside it. One predicate
     builder means one place where a value could stop being a parameter. */
  const conditions = viewConditions(view);
  // Preserve first-use alias ordering, but discover filter and sort joins
  // before freezing the scope prefix and numbering ordinary parameters.
  for (const group of conditions?.groups ?? []) {
    for (const condition of group) {
      if (condition.any) {
        exists(condition.any);
        continue;
      }
      qualify(condition.column);
      if (condition.other !== undefined) qualify(condition.other);
    }
  }

  const aliasNames = new Set((view.aggregates ?? []).map((a) => a.alias?.trim()).filter(Boolean));
  const order = (view.orderBy ?? []).flatMap((o) => {
    if (o.nulls === undefined) return [orderTerm(o)];
    if (o.nulls !== 'last' || o.alias || o.near !== undefined) {
      throw new PathError(`"${o.path}" puts nulls last only when it is a column.`, o.path, o.path, 0);
    }
    /* NULLS LAST in both directions, said the one way every dialect reads:
       a null sorts after every value whichever way the column runs. */
    return [`${qualify(o.path)} IS NULL ASC`, orderTerm(o)];
  });
  function orderTerm(o: ViewOrder) {
    if (o.collation !== undefined && (o.alias || o.near !== undefined)) {
      throw new PathError(`"${o.path}" orders by a column's own text only when it is a column.`, o.path, o.path, 0);
    }
    if (o.alias) {
      /* Refused by name rather than left to the engine: SQLite quietly
         treats an unknown ORDER BY identifier as a new error anyway, but
         "no such column: invoicez" would not say the fix is the alias two
         words back. */
      if (!aliasNames.has(o.path)) {
        throw new PathError(`"${o.path}" is not an aggregate alias on this view.`, o.path, o.path, 0);
      }
      return `${style.quote(o.path)} ${o.direction === 'desc' ? 'DESC' : 'ASC'}`;
    }
    if (o.near !== undefined) {
      /* Closest first, as a literal rather than a parameter: the ORDER BY is
         written before the WHERE's parameters are numbered, and a finite,
         safe number carries nothing but itself. Parenthesized, so a negative
         value never meets the minus as "--", a comment in SQL. */
      if (typeof o.near !== 'number' || !Number.isFinite(o.near) || Math.abs(o.near) > Number.MAX_SAFE_INTEGER) {
        throw new PathError(`"near" on "${o.path}" must be a finite number.`, o.path, o.path, 0);
      }
      return `ABS(${qualify(o.path)} - (${String(o.near)})) ${o.direction === 'desc' ? 'DESC' : 'ASC'}`;
    }
    /* A vocabulary sorts as declared (schema.ts declaredOrder); an order by
       bytes asked for the bytes, for a cursor that compares them. */
    if (o.collation === undefined)
      return { expression: qualify(o.path), direction: o.direction, declared: declaredOrder(resolve(o.path).column) };
    return `${collate(qualify(o.path), o.collation, style)} ${o.direction === 'desc' ? 'DESC' : 'ASC'}`;
  }

  const limit = clampLimit(view.limit);
  const skip = clampOffset(offset);
  const joins = plan.clauses();
  const prefix = relations.finish();
  /* The other side of a column comparison is a path like any other: resolved
     against this catalog, so a reader's pruned graph refuses one it may not
     read exactly as it refuses the left. */
  const where = buildWhere(conditions, style, prefix.params.length + 1, qualify, qualify, membership, exists);

  /* Placeholder numbering continues across the whole statement, which is the
     one thing Postgres needs and SQLite does not — and the exact place a join
     builder gets it wrong, because the joins sit between the SELECT list and
     the WHERE clause and are easy to count as if they carried parameters. */
  const sorted = orderClauseSql(order, style, prefix.params.length + where.params.length + 1);
  const n = prefix.params.length + where.params.length + sorted.params.length;

  const lines = [`SELECT ${select.join(',\n       ')}`, `  FROM ${baseRelation} ${style.quote(plan.baseAlias)}`, ...joins];
  if (where.text) lines.push(where.text.replace(/^ WHERE /, ' WHERE '));
  if (sorted.text) lines.push(sorted.text);
  lines.push(` LIMIT ${style.placeholder(n + 1)} OFFSET ${style.placeholder(n + 2)}`);

  return {
    text: prefix.text + lines.join('\n'),
    params: [...prefix.params, ...where.params, ...sorted.params, limit, skip],
    columns,
    joins: plan.joins,
    limit,
  };
}

/* ---------- the query language, over paths ----------

   The composer's filter box takes the same language as the bar at the top,
   because two languages for one idea is one too many. It is parsed by the
   same parser, too: `parseQuery` already handles and/or, parentheses, quoting,
   relative dates and per-column value coercion, and a second implementation
   of those would be a second set of bugs.

   The trick that makes it work is a *synthetic* table. `parseQuery` resolves
   every field against a table's column list, so the base table is handed to it
   with one extra column per path mentioned in the text, each carrying the
   declared type of the column the path actually ends on. Coercion, date
   handling and "did you mean" then work over paths for free.

   Paths are resolved on demand rather than enumerated: `work_order.parent_id`
   points back at `work_order`, so the set of paths four hops deep is tens of
   thousands of entries and building it per keystroke would be absurd. */

/* One segment of a path: a column name, or — for a composite key — the
   columns of it joined with `+`, exactly as `hopName` writes them.

   `+` has to be admitted here as well as in `parseQuery`'s FIELD, or the two
   disagree about where a token begins: the scanner reads only `line_no.sku`
   out of `invoice_id+line_no.sku`, builds the synthetic column for a path that
   does not exist, and a composite hop becomes something you can show but never
   filter. It is legal only *between* identifier characters, never leading —
   a leading `+` would let a signed number start a path. */
const SEGMENT = String.raw`[A-Za-z_$][\w$]*(?:\+[A-Za-z_$][\w$]*)*`;

/* A dotted token. `@` and `+` are excluded from the lookbehind on purpose:
   without `@`, `email = ops@harbour.example` reads its own value as a path and
   reports a confident error about a table that was never mentioned; without
   `+`, the tail of a composite hop matches on its own and reports the same
   kind of confident error about half a key. */
const DOTTED_TOKEN = new RegExp(String.raw`(?<![\w.$@+])(${SEGMENT}(?:\.${SEGMENT})+)`, 'g');

/** What makes a token a *field* rather than a value: an operator after it. */
const OPERATOR_AFTER = /^\s*(?:!=|<=|>=|=|<|>|\bcontains\b|\bstartswith\b|\bendswith\b|\blike\b|\bnot\s+in\b|\bin\b|\bis\b)/i;

/** …or a word before it that can only be followed by a field. */
const FIELD_BEFORE = /(?:^|[\s(,])(?:and|or|where|filter|show|select|sort|by)\s*$|(?:^|,)\s*$/i;

export interface ParsedView {
  filter: ViewFilter;
  columns: string[];
  orderBy: ViewOrder[];
  limit?: number;
  errors: QueryError[];
}

/**
 * Parse the composer's filter/clause text against a base table.
 *
 * Returns errors rather than throwing, because this runs on every keystroke
 * and a half-typed path is the normal state of the input, not an exception.
 */
export function parseViewQuery(
  schema: DatabaseSchema,
  baseId: string,
  text: string,
  now?: Date,
  options: {
    aggregateAliases?: string[];
    /** Who `me` is for this request; null, nobody signed in; absent, `me` is refused (query.ts). */
    me?: QueryPerson | null;
    /** Admit a column on a condition's right-hand side (the default); an API's standing query does not. */
    columnValues?: boolean;
  } = {},
): ParsedView {
  const empty: ParsedView = { filter: { groups: [] }, columns: [], orderBy: [], errors: [] };
  const base = findTable(schema, baseId);
  if (!base) {
    return { ...empty, errors: [{ message: `No table called "${baseId}" in this database.` }] };
  }
  const written = String(text ?? '').trim();
  if (!written) return empty;

  const errors: QueryError[] = [];
  /* A segment's name is written out first (query.ts expandSegments), so the paths, rollups and computed
     columns its conditions name are found below as if they had been typed; a position is said in the text
     as written. */
  let body = written;
  let said = (at: number) => at;
  if (base.segments) {
    const { head } = splitClauseTail(written);
    const start = head ? written.indexOf(head) : -1;
    if (start >= 0) {
      const expanded = expandSegments(head, base.segments);
      if (expanded.error) return { ...empty, errors: [{ message: expanded.error.message, at: start + (expanded.error.at ?? 0) }] };
      if (expanded.text !== head) {
        body = written.slice(0, start) + expanded.text + written.slice(start + head.length);
        const end = start + expanded.text.length;
        said = (at) => (at < start ? at : at < end ? start + expanded.at(at - start) : at - (expanded.text.length - head.length));
      }
    }
  }
  const extra: ColumnMeta[] = [];
  /* Each `any`/`no` condition is read on its own, against the child, and stands in the text the parser reads as a
     synthetic column asked `is (not) empty`; it becomes the condition it is when the parse comes back. */
  const anys = new Map<string, ViewCondition>();
  if (/\b(?:any|no)\s/i.test(body)) {
    const read = anyRowsOf(schema, base, body, now, options, anys, extra);
    if (read.errors.length)
      return { ...empty, errors: read.errors.map((error) => ({ ...error, at: error.at === undefined ? undefined : said(error.at) })) };
    if (read.text !== body) {
      const outer = said;
      body = read.text;
      said = (at) => outer(read.at(at));
    }
  }
  const added = new Set<string>();
  /* Paths already reported as broken. The synthetic table cannot contain
     them, so the parser will reach them too and say "not a column on invoice"
     — true, useless, and directly under a message that named the real
     problem. Two errors for one mistake reads as two mistakes. */
  const failed = new Set<string>();

  const scanned = maskQuoted(body);
  for (const match of scanned.matchAll(DOTTED_TOKEN)) {
    const path = match[1];
    const start = match.index ?? 0;
    /* Whether this token is being used as a field decides whether a failure
       to resolve is worth reporting. In value position — `external_ref =
       a.b` — a dotted word that is not a path is simply a value, and an error
       about it would be noise on a query that is perfectly correct. */
    /* …or a path on the right of a comparison whose first hop is a column
       of the base: `on_hand < product_id.reorder_level` compares with it,
       so a hop that goes nowhere is a mistake to name, not text. */
    const isField =
      OPERATOR_AFTER.test(scanned.slice(start + path.length)) ||
      FIELD_BEFORE.test(scanned.slice(0, start)) ||
      (/(?:!=|<=|>=|=|<|>)\s*$/.test(scanned.slice(0, start)) && base.columns.some((c) => c.name === path.split('.')[0].split('+')[0]));
    if (added.has(path)) continue;
    added.add(path);
    const { resolved, error } = tryResolvePath(schema, baseId, path);
    if (error) {
      /* Located at the token so the composer can underline the right word.
         The offset is into the filter text, and the caller shifts it. */
      if (isField) {
        errors.push({ message: error.message, at: said(start) });
        failed.add(path);
      }
      continue;
    }
    if (!resolved) continue;
    /* The synthetic column keeps the *declared* type of the real column, so
       `signed_up = last 30 days` through a path behaves exactly as it does
       on the base table. Nullability is widened because the join can miss. */
    extra.push({
      name: resolved.path,
      type: resolved.column.type,
      nullable: true,
      primaryKey: false,
      references: resolved.column.references,
    });
  }

  /* The base's own record label (`show $label`, `$label contains 12`) is a
     column of the synthetic table where the catalog serves a template. */
  if (base.labelTemplate && /(?<![\w.$])\$label(?![\w$])/.test(scanned)) {
    extra.push(labelColumnMeta());
  }

  /* The base's rollups (rollups.ts) are columns of the synthetic table where
     the text names one, typed as the catalog serves them, so `sort
     line_total desc` and `open_deals > 0` parse and coerce like any number.
     A rollup through a reference is a dotted path, found above. */
  for (const [name, rollup] of Object.entries(base.rollups ?? {})) {
    if (added.has(name) || base.columns.some((c) => c.name === name)) continue;
    if (new RegExp(`(?<![\\w.$])${name}(?![\\w$])`).test(scanned)) extra.push(rollupColumnMeta(name, rollup));
  }
  /* And its computed columns (computed.ts), typed as they come out: `is_overdue = true`, `sort days_open desc`. */
  for (const [name, computed] of Object.entries(base.computed ?? {})) {
    if (added.has(name) || base.columns.some((c) => c.name === name)) continue;
    if (new RegExp(`(?<![\\w.$])${name}(?![\\w$])`).test(scanned)) extra.push(computedColumnMeta(name, computed));
  }
  /* And its tags (tagLists.ts), a column only `has` may ask: `tags has bug`, `show name, tags`. */
  if (
    base.tags &&
    !added.has(TAGS_COLUMN) &&
    !base.columns.some((c) => c.name === TAGS_COLUMN) &&
    new RegExp(`(?<![\\w.$])${TAGS_COLUMN}(?![\\w$])`).test(scanned)
  )
    extra.push(tagsColumnMeta());

  /* Aggregate aliases join the synthetic table so `sort invoices desc`
     parses — and only sort. A WHERE runs before the SELECT list exists, so
     filtering by an alias is refused below with the reason, not with
     "not a column", which is true and useless. */
  const aliases = new Set(options.aggregateAliases ?? []);
  for (const alias of aliases) {
    if (!added.has(alias)) extra.push({ name: alias, type: 'NUMERIC', nullable: true, primaryKey: false });
  }

  const synthetic: DatabaseSchema = {
    ...schema,
    tables: schema.tables.map((t) => (t.id === base.id ? { ...t, columns: [...t.columns, ...extra] } : t)),
  };

  /* The parser wants `<table> <clauses>`, which is also what the composer's
     hint text shows, so the base name is prepended rather than the grammar
     being special-cased. */
  const offset = base.id.length + 1;
  const parsed = parseQuery(`${base.id} ${body}`, {
    schema: synthetic,
    now,
    columnValues: options.columnValues !== false,
    ...(options.me !== undefined ? { me: options.me } : {}),
  });
  for (const err of parsed.errors) {
    if ([...failed].some((path) => err.message.includes(`"${path}"`))) continue;
    errors.push({ message: err.message, at: err.at === undefined ? undefined : said(Math.max(0, err.at - offset)) });
  }

  const query = parsed.query;
  if (!query) return { ...empty, errors };

  for (const group of query.filter.groups) {
    for (const c of group) {
      if (aliases.has(c.column)) {
        errors.push({
          message: `"${c.column}" is an aggregate result, and a filter runs before it exists. ` + 'Filter on the child table instead.',
        });
      }
    }
  }
  for (const column of query.columns ?? []) {
    if (aliases.has(column)) {
      errors.push({ message: `"${column}" is already shown — the aggregate adds its own column.` });
    }
  }

  return {
    filter: {
      groups: query.filter.groups.map((group) =>
        group.map(
          (c): ViewCondition =>
            anys.get(c.column) ??
            (c.other === undefined ? { path: c.column, op: c.op, value: c.value } : { path: c.column, op: c.op, other: c.other }),
        ),
      ),
    },
    columns: query.columns,
    orderBy: query.orderBy.map((o) =>
      aliases.has(o.column) ? { path: o.column, direction: o.direction, alias: true } : { path: o.column, direction: o.direction },
    ),
    limit: query.limit,
    errors,
  };
}

/* The name an `any` condition stands under while the parser reads the rest: no column can be called it. */
const ANY_STANDIN = '$any';

/**
 * The `any`/`no` conditions of a view's text, each read against its child
 * table: the text with each written as a stand-in column asked `is (not)
 * empty`, the stand-ins (in `extra`) and the conditions they become (in
 * `anys`), and a position in the new text said in the old.
 *
 * The child is the table whose one reference points at the base, or the one
 * `via` names; its conditions are its own columns and paths up from it, and
 * its segments — what a row scope's narrowing reads (rowScope.ts `filtered`),
 * which is how the EXISTS is written. A second `any` inside, a rollup, a
 * computed column, tags or a record label are refused by name rather than
 * left to fail as SQL.
 */
function anyRowsOf(
  schema: DatabaseSchema,
  base: TableMeta,
  body: string,
  now: Date | undefined,
  options: { me?: QueryPerson | null; columnValues?: boolean },
  anys: Map<string, ViewCondition>,
  extra: ColumnMeta[],
): { text: string; at: (position: number) => number; errors: QueryError[] } {
  const same = { text: body, at: (position: number) => position, errors: [] as QueryError[] };
  const { head } = splitClauseTail(body);
  const start = head ? body.indexOf(head) : -1;
  if (start < 0) return same;
  const found = anyConditions(head);
  if (!found.length) return same;
  const errors: QueryError[] = [];
  const splices: Array<{ at: number; was: number; from: number; length: number }> = [];
  let text = '';
  let last = 0;
  for (const condition of found) {
    const at = start + condition.at;
    const [, word, childName, via, rest] = ANY_CONDITION.exec(condition.text)!;
    const fail = (message: string, offset = 0) => errors.push({ message, at: at + offset });
    const named = backrefsTo(schema, base.id).filter((b) => {
      const table = findTable(schema, b.child);
      return table && (table.id === childName || table.name === childName);
    });
    const through = via === undefined ? named : named.filter((b) => b.fk.from.columns.join('+') === via);
    if (!named.length) {
      fail(
        findTable(schema, childName) || schema.tables.some((t) => t.name === childName)
          ? `${childName} has no reference to ${base.name}, so "${word} ${childName}" has no rows to ask about.`
          : `No table called "${childName}" here.`,
        word.length + 1,
      );
      continue;
    }
    if (!through.length) {
      fail(
        `${childName} points at ${base.name} through ${named.map((b) => b.fk.from.columns.join('+')).join(', ')}, not "${via}".`,
        condition.text.indexOf(via!, word.length + childName.length + 1),
      );
      continue;
    }
    if (through.length > 1) {
      const columns = through.map((b) => b.fk.from.columns.join('+'));
      fail(
        `${childName} points at ${base.name} through ${columns.join(' and ')}: say which — ${word} ${childName} via ${columns[0]}.`,
        word.length + 1,
      );
      continue;
    }
    const { fk } = through[0];
    if (fk.stitched) {
      fail(
        `${childName} is in another source, on another connection, so a list of ${base.name} cannot ask about its rows: ` +
          'each database filters what it holds.',
        word.length + 1,
      );
      continue;
    }
    const child = findTable(schema, fk.from.table)!;
    let filter: Filter | undefined;
    if (rest !== undefined) {
      const restAt = condition.text.length - rest.length;
      const parsed = parseViewQuery(schema, child.id, rest, now, { me: options.me, columnValues: options.columnValues });
      for (const error of parsed.errors) fail(error.message, restAt + (error.at ?? 0));
      if (parsed.errors.length) continue;
      if (parsed.columns.length || parsed.orderBy.length || parsed.limit !== undefined) {
        fail(`"${word} ${childName}" takes conditions only: a show, sort or limit there has no rows to shape.`, restAt);
        continue;
      }
      const unread = parsed.filter.groups
        .flat()
        .flatMap((c) => (c.any ? [c.path] : [c.path, ...(c.other === undefined ? [] : [c.other])]))
        .find((path) => {
          if (path.startsWith('any ') || path.startsWith('no ')) return true;
          const { resolved } = tryResolvePath(schema, child.id, path);
          return !resolved || Boolean(resolved.rollup || resolved.computed || resolved.tags || resolved.jsonKey || path.includes('$'));
        });
      if (unread !== undefined) {
        fail(
          /^(?:any|no)\s/i.test(unread)
            ? `"${word} ${childName}" cannot ask about rows of its own rows: say that as its own condition.`
            : `"${unread}" is not a stored column of ${child.name}, and "${word} ${childName}" reads only those.`,
          restAt + Math.max(0, rest.indexOf(unread)),
        );
        continue;
      }
      const stitched = stitchedListProblem(schema, child.id, { filter: parsed.filter });
      if (stitched) {
        fail(stitched, restAt);
        continue;
      }
      filter = {
        groups: parsed.filter.groups.map((group) =>
          group.map((c): Condition =>
            c.other === undefined ? { column: c.path, op: c.op, value: c.value } : { column: c.path, op: c.op, other: c.other },
          ),
        ),
      };
    }
    const standin = `${ANY_STANDIN}${anys.size}`;
    const said = condition.text.replace(/\s+/g, ' ');
    anys.set(standin, {
      path: said,
      op: word.toLowerCase() === 'no' ? 'isNull' : 'isNotNull',
      any: { via: `${child.id}.${fk.from.columns.join('+')}`, ...(filter ? { filter } : {}) },
    });
    extra.push({ name: standin, type: 'INTEGER', nullable: true, primaryKey: false });
    const written = `${standin} ${word.toLowerCase() === 'no' ? 'is empty' : 'is not empty'}`;
    text += body.slice(last, at);
    splices.push({ at, was: condition.text.length, from: text.length, length: written.length });
    text += written;
    last = at + condition.text.length;
  }
  if (errors.length) return { ...same, errors };
  text += body.slice(last);
  return {
    text,
    errors,
    at: (position) => {
      let shift = 0;
      for (const splice of splices) {
        if (position < splice.from) break;
        if (position < splice.from + splice.length) return splice.at;
        shift = splice.from + splice.length - (splice.at + splice.was);
      }
      return position - shift;
    },
  };
}

/**
 * How many rows the view matches, ignoring the page.
 *
 * A separate compilation rather than a wrapper around the other one, because
 * the two differ in more than a keyword: the SELECT list, the ORDER BY and the
 * page are all irrelevant here, and every aggregate in the view would be a
 * correlated subquery evaluated per row for a number nobody reads.
 *
 * The count is exact rather than estimated, and it is *base rows* — which is
 * only true because every join is to-one. That is the same property the whole
 * design rests on: a view never multiplies, so counting it is counting the
 * table it started from. With `limit`, it stops after that many.
 */
export function compileViewCount(schema: DatabaseSchema, view: ViewDef, style: SqlStyle, scope?: RowScope, limit?: number): SqlFragment {
  schema = withViewReferences(schema, view.references);
  const base = findTable(schema, view.base);
  if (!base) {
    throw new PathError(`No table called "${view.base}" in this database, so the view has nothing to start from.`, view.base, view.base, 0);
  }
  const relations = new ScopedRelations(schema, style, scope);
  const baseRelation = relations.table(base.id);
  const plan = new JoinPlan(schema, base, style, relations.table);
  const { qualify, membership, exists } = viewPaths(schema, view, plan, style, relations);

  const conditions = viewConditions(view);
  for (const group of conditions?.groups ?? []) {
    for (const condition of group) {
      if (condition.any) {
        exists(condition.any);
        continue;
      }
      qualify(condition.column);
      if (condition.other !== undefined) qualify(condition.other);
    }
  }
  const joins = plan.clauses();
  const prefix = relations.finish();
  const where = buildWhere(conditions, style, prefix.params.length + 1, qualify, qualify, membership, exists);

  /* Only filter joins affect row count. Projection-only joins and scalar
     aggregates deliberately do not register relations in this statement. */
  const relation = `${baseRelation} ${style.quote(plan.baseAlias)}` + (joins.length ? `\n${joins.join('\n')}` : '') + where.text;
  /* A bound stops the count the way every bounded count stops
     (countStatement): at most `limit` base rows are read. */
  const text =
    limit === undefined ? prefix.text + `SELECT COUNT(*) AS n\n  FROM ${relation}` : prefix.text + countStatement(relation, limit);
  return { text, params: [...prefix.params, ...where.params] };
}

/**
 * Render a view as the SQL it will become, values inline.
 *
 * The mirror of `explain` in query.ts and used the same way: this string never
 * reaches a database, and showing `"customer_1"."name" LIKE '%Harbour%'` next
 * to the path that produced it is how someone learns what the composer is
 * doing on their behalf.
 */
export function explainView(schema: DatabaseSchema, view: ViewDef, style: SqlStyle): string {
  const compiled = compileView(schema, withViewComputed(schema, withViewLabels(schema, view)), style);
  let i = 0;
  return compiled.text.replace(/\$\d+|\?/g, () => sqlLiteral(compiled.params[i++]));
}

/**
 * One parameter, written the way SQL would have to spell it.
 *
 * Exported because a breakdown explains itself the same way a view does, and
 * two spellings of `NULL` — or two different ideas about escaping a quote —
 * would show up as a difference between two panes that claim to be the same
 * statement.
 */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

/* ---------- config file support ----------

   Views can be predefined in `tablewalk.json` beside `connections`, and are
   validated the same strict way: a malformed entry is an error naming the
   entry, never a silent skip. Quietly dropping a view someone wrote is the
   worst outcome — they see a shorter list and no reason for it. */

export function parseViewsConfig(raw: unknown, where: string): ViewDef[] {
  const views = (raw as { views?: unknown })?.views;
  if (views === undefined) return [];
  if (!Array.isArray(views)) throw new Error(`${where}: "views" must be an array.`);

  const seen = new Set<string>();
  return views.map((entry, i) => {
    const at = `${where}: view ${i + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${at} is not an object.`);
    }
    const v = entry as Record<string, unknown>;
    if (typeof v.name !== 'string' || !v.name.trim()) throw new Error(`${at} has no "name".`);

    /* A view may be written down instead of built out of objects. The text
       form needs a schema to resolve, which a config file does not have, so
       it is carried through and expanded when a connection is open — and any
       error it holds is reported against that view rather than swallowed. */
    const text = v.text === undefined ? undefined : String(v.text).trim();
    if (v.text !== undefined && (typeof v.text !== 'string' || !text)) {
      throw new Error(`${at} ("${v.name}") has a "text" that is not a non-empty string.`);
    }
    if (text && v.base !== undefined) {
      throw new Error(`${at} ("${v.name}") has both "text" and "base". The text form already names its table.`);
    }
    if (!text && (typeof v.base !== 'string' || !v.base.trim())) {
      throw new Error(`${at} ("${v.name}") has no "base" table.`);
    }
    const id = v.id === undefined ? `config-${slug(v.name, 'view')}` : String(v.id);
    if (v.id !== undefined && (typeof v.id !== 'string' || !v.id.trim())) {
      throw new Error(`${at} ("${v.name}") has an "id" that is not a non-empty string.`);
    }
    if (seen.has(id)) throw new Error(`${at} ("${v.name}") repeats the id "${id}".`);
    seen.add(id);

    const columns = parseColumns(v.columns, at, String(v.name));
    const aggregates = parseAggregates(v.aggregates, at, String(v.name));
    const filter = parseFilter(v.filter, at, String(v.name));
    const orderBy = parseOrder(v.orderBy, at, String(v.name));

    if (v.limit !== undefined && (typeof v.limit !== 'number' || !Number.isFinite(v.limit))) {
      throw new Error(`${at} ("${v.name}") has a "limit" that is not a number.`);
    }
    if (v.connection !== undefined && typeof v.connection !== 'string') {
      throw new Error(`${at} ("${v.name}") has a "connection" that is not a string.`);
    }

    return {
      id,
      name: v.name.trim(),
      base: text ? text.trim().split(/\s+/)[0] : (v.base as string).trim(),
      text,
      columns,
      aggregates,
      filter,
      orderBy,
      limit: v.limit as number | undefined,
      connection: v.connection as string | undefined,
      source: 'config' as const,
    };
  });
}

function parseColumns(raw: unknown, at: string, name: string): ViewColumn[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${at} ("${name}") has "columns" that is not an array.`);
  return raw.map((col, j) => {
    const where = `${at} ("${name}"), column ${j + 1}`;
    if (typeof col === 'string') {
      if (!col.trim()) throw new Error(`${where} is empty.`);
      return { path: col.trim() };
    }
    if (!col || typeof col !== 'object') throw new Error(`${where} is not a string or an object.`);
    const c = col as Record<string, unknown>;
    if (typeof c.path !== 'string' || !c.path.trim()) throw new Error(`${where} has no "path".`);
    if (c.alias !== undefined && (typeof c.alias !== 'string' || !c.alias.trim())) {
      throw new Error(`${where} has an "alias" that is not a non-empty string.`);
    }
    return { path: c.path.trim(), alias: c.alias as string | undefined };
  });
}

function parseAggregates(raw: unknown, at: string, name: string): ViewAggregate[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error(`${at} ("${name}") has "aggregates" that is not an array.`);
  return raw.map((entry, j) => {
    const where = `${at} ("${name}"), aggregate ${j + 1}`;
    if (!entry || typeof entry !== 'object') throw new Error(`${where} is not an object.`);
    const a = entry as Record<string, unknown>;
    if (typeof a.fn !== 'string' || !AGGREGATE_FNS.includes(a.fn as AggregateFn)) {
      throw new Error(`${where} has an unknown "fn". Use one of: ${AGGREGATE_FNS.join(', ')}.`);
    }
    if (typeof a.via !== 'string' || !a.via.trim()) throw new Error(`${where} has no "via".`);
    if (a.fn !== 'count' && (typeof a.column !== 'string' || !a.column.trim())) {
      throw new Error(`${where} is a ${a.fn} and needs a "column" to summarise.`);
    }
    if (a.on !== undefined && typeof a.on !== 'string') {
      throw new Error(`${where} has an "on" that is not a string.`);
    }
    if (a.alias !== undefined && (typeof a.alias !== 'string' || !a.alias.trim())) {
      throw new Error(`${where} has an "alias" that is not a non-empty string.`);
    }
    return {
      fn: a.fn as AggregateFn,
      via: a.via.trim(),
      on: a.on as string | undefined,
      column: typeof a.column === 'string' ? a.column.trim() : undefined,
      alias: a.alias as string | undefined,
    };
  });
}

const OPS: Op[] = ['=', '!=', '>', '>=', '<', '<=', 'contains', 'startsWith', 'endsWith', 'like', 'in', 'isNull', 'isNotNull'];

function parseFilter(raw: unknown, at: string, name: string): ViewFilter | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${at} ("${name}") has a "filter" that is not an object.`);
  }
  const groups = (raw as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) throw new Error(`${at} ("${name}") has a "filter" with no "groups" array.`);
  return {
    groups: groups.map((group, g) => {
      if (!Array.isArray(group)) throw new Error(`${at} ("${name}"), filter group ${g + 1} is not an array.`);
      return group.map((cond, c) => {
        const where = `${at} ("${name}"), filter group ${g + 1} condition ${c + 1}`;
        if (!cond || typeof cond !== 'object') throw new Error(`${where} is not an object.`);
        const x = cond as Record<string, unknown>;
        if (typeof x.path !== 'string' || !x.path.trim()) throw new Error(`${where} has no "path".`);
        if (typeof x.op !== 'string' || !OPS.includes(x.op as Op)) {
          throw new Error(`${where} has an unknown operator "${String(x.op)}". Use one of: ${OPS.join(', ')}.`);
        }
        if (x.other !== undefined && (typeof x.other !== 'string' || !x.other.trim())) {
          throw new Error(`${where} has an "other" that is not a path.`);
        }
        return typeof x.other === 'string'
          ? { path: x.path.trim(), op: x.op as Op, other: x.other.trim() }
          : { path: x.path.trim(), op: x.op as Op, value: x.value as ViewCondition['value'] };
      });
    }),
  };
}

function parseOrder(raw: unknown, at: string, name: string): ViewOrder[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error(`${at} ("${name}") has an "orderBy" that is not an array.`);
  return raw.map((entry, j) => {
    const where = `${at} ("${name}"), orderBy ${j + 1}`;
    if (typeof entry === 'string') return { path: entry, direction: 'asc' as const };
    if (!entry || typeof entry !== 'object') throw new Error(`${where} is not a string or an object.`);
    const o = entry as Record<string, unknown>;
    if (typeof o.path !== 'string' || !o.path.trim()) throw new Error(`${where} has no "path".`);
    const direction = o.direction === undefined ? 'asc' : o.direction;
    if (direction !== 'asc' && direction !== 'desc') {
      throw new Error(`${where} has a "direction" that is not "asc" or "desc".`);
    }
    return { path: o.path.trim(), direction };
  });
}

/**
 * Check a view against a schema without running it.
 *
 * Used by `GET /api/views` so a config view naming a table that does not exist
 * on this connection is listed *with its reason*, rather than either vanishing
 * or blowing up the endpoint for every other view beside it.
 */
export function validateView(schema: DatabaseSchema, view: ViewDef): string | undefined {
  try {
    /* Any style will do: this compiles to throw away the text and keep the
       error, and no dialect refuses a view another accepts. */
    compileView(schema, view, ANSI_STYLE);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}
