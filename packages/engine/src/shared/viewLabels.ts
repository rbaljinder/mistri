/**
 * A view's paths as the planner writes them, including the one kind of path
 * that is not a column: a record's templated name, `$label` (recordLabel.ts),
 * whose words and columns become one text expression on each engine. Split
 * from view.ts, which plans the joins these qualify against.
 */
import type { AnyRows, Condition, SqlStyle } from './filter.js';

import { findTable, type ColumnMeta, type DatabaseSchema, type TableMeta } from './schema.js';
import type { JoinPlan } from './view.js';
import {
  PathError,
  backrefsTo,
  labelColumnMeta,
  resolvePath,
  tableAtPrefix,
  tryResolvePath,
  type ResolvedPath,
  type ViewDef,
} from './viewPaths.js';
import { LABEL_SEGMENT, labelPrefix, parseLabelTemplate } from './recordLabel.js';
import { MASK } from './model.js';
import { rollupColumnMeta, type ComputedPath, type Rollup } from './rollups.js';
import { compileComputed, computedColumnMeta, type ComputedPath as ExpressionPath, type ValueKind } from './computed.js';
import { aggregateInput, columnKind, isFlagColumn } from './schema.js';
import { TAGS_COLUMN, tagsColumnMeta, type TagPath } from './tagLists.js';
import type { ScopedRelations } from './rowScope.js';

/** The comparisons a JSON key answers as a number when it is given one (SqlStyle.jsonKey). */
const RANGES: ReadonlySet<string> = new Set(['<', '<=', '>', '>=']);

/**
 * A view's paths, resolved and written against one join plan.
 *
 * Resolution and alias creation are one step, because a join only exists
 * once some path needs it. Recording the key alongside keeps `clauses` from
 * having to re-resolve anything.
 *
 * A `$label` path is a record's templated name (recordLabel.ts): its words
 * are string literals and its columns are paths from the same prefix, each
 * qualified here like any other, so a label through a reference joins what
 * it needs and a reader's pruned catalog refuses a column it may not read.
 * The template comes from the view's `labels`, which the server fills; the
 * literal text is held to characters every engine reads alike inside quotes.
 */
export function viewPaths(schema: DatabaseSchema, view: ViewDef, plan: JoinPlan, style: SqlStyle, relations?: ScopedRelations) {
  const plain = (path: string): string => {
    const resolved = resolvePath(schema, view.base, path);
    let prefix = '';
    for (let i = 0; i < resolved.hops.length; i++) {
      prefix = prefix ? `${prefix}.${resolved.hopNames[i]}` : resolved.hopNames[i];
      plan.record(prefix, resolved.hops[i]);
    }
    return plan.qualify(resolved);
  };
  const template = (path: string, prefix: string) => {
    const table = tableAtPrefix(schema, view.base, prefix);
    const text = view.labels?.[prefix];
    if (!table || !text) {
      throw new PathError(
        `"${path}" names a record label${table ? ` that ${table.name} does not have here` : ', and its reference goes nowhere'}.`,
        path,
        LABEL_SEGMENT,
        prefix ? prefix.split('.').length : 0,
      );
    }
    const parsed = parseLabelTemplate(text);
    if ('problem' in parsed) throw new PathError(`"${path}": ${parsed.problem}`, path, LABEL_SEGMENT, 0);
    return { table, parts: parsed.parts };
  };
  const at = (prefix: string, field: string) => (prefix ? `${prefix}.${field}` : field);
  /* A rollup a path names: the view's own (a server fills it from the App's
     catalog, rollups.ts), or — where the catalog compiling this is the App's
     — the catalog's, so a check that compiles an App's page against its
     catalog reads the same subquery the read will. */
  const computedAt = (path: string): ComputedPath | undefined => {
    if (view.computed && Object.hasOwn(view.computed, path)) return view.computed[path];
    const found = tryResolvePath(schema, view.base, path).resolved;
    return found?.rollup ? { ...found.rollup, on: found.rollupAt ?? path.split('.').slice(0, -1).join('.') } : undefined;
  };
  /* The hops to a prefix, walked through one of the table's own columns —
     the same resolver as every path, so a prefix that is not a chain of
     references fails here as it would anywhere. */
  const prefixHops = (prefix: string) => {
    const table = tableAtPrefix(schema, view.base, prefix);
    if (!table?.columns.length) throw new PathError(`"${prefix}" is not a chain of references from ${view.base}.`, prefix, prefix, 0);
    const { hops, hopNames } = prefix ? resolvePath(schema, view.base, at(prefix, table.columns[0].name)) : { hops: [], hopNames: [] };
    return { table, hops, hopNames };
  };
  /* The correlated subquery a rollup is: its child rows, through the
     statement's own relations (a scope's CTE, and a CTE for the rollup's own
     filter), keyed on the reference to the record at its prefix. */
  const rollup = (path: string, computed: ComputedPath): string => {
    const { table } = prefixHops(computed.on);
    if (computed.on) plain(at(computed.on, table.columns[0].name));
    return subquery(path, computed, table, plan.aliasOfPrefix(computed.on));
  };
  /* One rollup's subquery, keyed on the parent row's alias. A rollup of a
     rollup (`of`) aggregates the inner one's subquery, keyed on this one's
     child alias: every level reads through its own relation, so a row policy
     on the grandchild narrows the number as one on the child does. */
  const subquery = (path: string, computed: Rollup, table: TableMeta, parentAlias: string): string => {
    const match = backrefsTo(schema, table.id).find((b) => `${b.child}.${b.fk.from.columns.join('+')}` === computed.via);
    const child = match && findTable(schema, match.child);
    if (!match || !child) {
      throw new PathError(
        `"${path}" sums rows through "${computed.via}", which does not point at ${table.name} here.`,
        path,
        path.split('.').pop()!,
        0,
      );
    }
    /* A computed column it reads is held to the columns under it: this catalog serves the rollup only where it reads them all. */
    const narrowing = Object.values(computed.computed ?? {}).flatMap((expression) => expression.reads);
    const unread =
      narrowing.find((read) => !child.columns.some((c) => c.name === read)) ??
      (computed.expression
        ? computed.expression.reads.find((read) => !child.columns.some((c) => c.name === read))
        : computed.fn !== 'count' && !computed.of && !child.columns.some((c) => c.name === computed.column)
          ? computed.column
          : computed.by !== undefined && !child.columns.some((c) => c.name === computed.by)
            ? computed.by
            : undefined);
    if (unread !== undefined) {
      throw new PathError(`"${path}" reads "${unread}", which is not a column on ${child.name} here.`, path, path.split('.').pop()!, 0);
    }
    if (computed.filter && !relations) throw new Error(`"${path}" narrows its rows and needs the statement's relations.`);
    /* The rows a level reads: the child's relation, narrowed by the level's query where it has one. */
    const sourceOf = (level: Rollup, of: TableMeta) => {
      const kindOf = (column: string) => columnRead(of.columns.find((c) => c.name === column));
      return level.filter
        ? relations!.filtered(
            of.id,
            level.filter,
            level.computed &&
              Object.fromEntries(
                Object.entries(level.computed).map(([name, expression]) => [
                  name,
                  (own: (column: string) => string) => compileComputed(expression, style, own, kindOf),
                ]),
              ),
          )
        : relations
          ? relations.table(of.id)
          : plan.relationOf(of.id);
    };
    const source = sourceOf(computed, child);
    const childAlias = plan.subAlias(child.name);
    const on = match.fk.to.columns
      .map(
        (toCol, i) =>
          `${style.quote(childAlias)}.${style.quote(match.fk.from.columns[i] ?? match.fk.from.columns[0])} = ` +
          `${style.quote(parentAlias)}.${style.quote(toCol)}`,
      )
      .join(' AND ');
    /* COUNT(*), and a sum over no rows left NULL, for the reasons a view's
       aggregates give (view.ts): a record with no lines has no total. */
    /* A count through two references is the sum of its middle rows' counts,
       and a record with no middle rows still has none: 0, never NULL. */
    const own = (column: string) => `${style.quote(childAlias)}.${style.quote(column)}`;
    /* The newest row's column, as it was written: the greatest `by`, its key breaking a tie, so two rows made in the
       same second still give one answer. LIMIT 1 in a scalar subquery reads the same on all three engines. */
    if (computed.fn === 'latest') {
      /* Through two references the rows are the grandchild's, each joined to the middle record it hangs from: the
         newest of them all, under both levels' relations, so a row policy on either narrows it. */
      const level = computed.of ?? computed;
      let rows = `${source} ${style.quote(childAlias)}`;
      let newest = child;
      let read = own;
      if (computed.of) {
        const inner = backrefsTo(schema, child.id).find((b) => `${b.child}.${b.fk.from.columns.join('+')}` === computed.of!.via);
        const grand = inner && findTable(schema, inner.child);
        const reads = [computed.of.column!, computed.of.by!];
        const missing = !inner || !grand ? computed.of.via : reads.find((name) => !grand.columns.some((c) => c.name === name));
        if (missing !== undefined || !inner || !grand)
          throw new PathError(`"${path}" reads "${missing}", which is not on its rows here.`, path, path.split('.').pop()!, 0);
        const grandAlias = plan.subAlias(grand.name);
        read = (column: string) => `${style.quote(grandAlias)}.${style.quote(column)}`;
        const joined = inner.fk.to.columns
          .map((toCol, i) => `${read(inner.fk.from.columns[i] ?? inner.fk.from.columns[0])} = ${own(toCol)}`)
          .join(' AND ');
        rows = `${sourceOf(computed.of, grand)} ${style.quote(grandAlias)} JOIN ${rows} ON ${joined}`;
        newest = grand;
      }
      const order = [level.by!, ...newest.columns.filter((c) => c.primaryKey && c.name !== level.by).map((c) => c.name)];
      /* A row with no `by` yet is not the newest: PostgreSQL sorts nulls first when descending, the others last. */
      const unset = newest.columns.find((c) => c.name === level.by)?.nullable ? [`${read(level.by!)} IS NULL ASC`] : [];
      const newestKey =
        `(SELECT ${read(level.column!)} FROM ${rows} WHERE ${on}` +
        ` ORDER BY ${[...unset, ...order.map((column) => `${read(column)} DESC`)].join(', ')} LIMIT 1)`;
      /* Read through the key it holds (`resident.name`): that record's column, from its table's own relation, so a row
         policy on it narrows the name as it narrows a join to the same record. A key naming no row reads nothing. */
      if (computed.through) {
        const to = findTable(schema, computed.through.table);
        if (!to?.columns.some((c) => c.name === computed.through!.key) || !to.columns.some((c) => c.name === computed.through!.column)) {
          throw new PathError(
            `"${path}" reads "${computed.through.column}", which is not on ${computed.through.table} here.`,
            path,
            path.split('.').pop()!,
            0,
          );
        }
        const alias = style.quote(plan.subAlias(to.name));
        return (
          `(SELECT ${alias}.${style.quote(computed.through.column)} FROM ${relations ? relations.table(to.id) : plan.relationOf(to.id)} ${alias}` +
          ` WHERE ${alias}.${style.quote(computed.through.key)} = ${newestKey})`
        );
      }
      return newestKey;
    }
    /* A computed column is its expression over the child's own row, written as a list of the child writes it. */
    const read = computed.of
      ? subquery(path, computed.of, child, childAlias)
      : computed.expression
        ? compileComputed(computed.expression, style, own, (column) => columnRead(child.columns.find((c) => c.name === column)))
        : computed.column && own(computed.column);
    /* A yes-or-no is summed as 0 and 1 on every engine (aggregateInput). A
       sum over no rows is 0, as a count over none is: a total of nothing is
       nothing, and an empty one would read as unknown in a when or a
       formula. The least, most and latest of no rows stay empty. */
    const type = computed.expression ? computed.expression.type : child.columns.find((c) => c.name === computed.column)?.type;
    const aggregate = `${computed.fn.toUpperCase()}(${computed.of ? read : aggregateInput(read!, type, style.dialect)})`;
    const expression =
      computed.fn === 'count'
        ? computed.of
          ? `COALESCE(SUM(${read}), 0)`
          : 'COUNT(*)'
        : computed.fn === 'sum'
          ? `COALESCE(${aggregate}, 0)`
          : aggregate;
    return `(SELECT ${expression} FROM ${source} ${style.quote(childAlias)} WHERE ${on})`;
  };
  /* A record's tags a path names (tagLists.ts): the view's own, pinned by the
     server from the App's catalog, or the catalog's where it is the App's. */
  const tagsAt = (path: string): TagPath | undefined => {
    if (view.tagged && Object.hasOwn(view.tagged, path)) return view.tagged[path];
    if (labelPrefix(path) !== undefined || path.split('.').pop() !== TAGS_COLUMN) return undefined;
    const found = tryResolvePath(schema, view.base, path).resolved;
    return found?.tags ? { ...found.tags, on: path.split('.').slice(0, -1).join('.') } : undefined;
  };
  /* The link rows of the record at a tag path's prefix joined to their tags,
     each through the statement's relations, and the condition tying them to
     the record: what the list and `has` both read. */
  const tagRows = (path: string, tags: TagPath) => {
    const { table } = prefixHops(tags.on);
    if (tags.on) plain(at(tags.on, table.columns[0].name));
    const link = findTable(schema, tags.through),
      tag = findTable(schema, tags.to);
    const has = (t: TableMeta | undefined, ...names: (string | undefined)[]) =>
      Boolean(t && names.every((name) => !name || t.columns.some((c) => c.name === name)));
    if (
      !has(link, tags.from, tags.via) ||
      !has(tag, tags.tagKey, tags.label, tags.tone) ||
      !table.columns.some((c) => c.name === tags.key)
    ) {
      throw new PathError(`"${path}" reads tags through "${tags.through}", which this catalog does not read whole.`, path, TAGS_COLUMN, 0);
    }
    const source = (id: string) => (relations ? relations.table(id) : plan.relationOf(id));
    const q = style.quote;
    const linkAlias = q(plan.subAlias(link!.name)),
      tagAlias = q(plan.subAlias(tag!.name));
    return {
      from: `${source(tags.through)} ${linkAlias} JOIN ${source(tags.to)} ${tagAlias} ON ${tagAlias}.${q(tags.tagKey)} = ${linkAlias}.${q(tags.via)}`,
      on: `${linkAlias}.${q(tags.from)} = ${q(plan.aliasOfPrefix(tags.on))}.${q(tags.key)}`,
      label: `${tagAlias}.${q(tags.label)}`,
      tone: tags.tone ? `${tagAlias}.${q(tags.tone)}` : 'NULL',
    };
  };
  /* Every tag of the record, as one JSON array of [label, tone] per row. */
  const tagList = (path: string, tags: TagPath): string => {
    const rows = tagRows(path, tags);
    return `(SELECT ${tagPairs(style, rows.label, rows.tone)} FROM ${rows.from} WHERE ${rows.on})`;
  };
  /* `tags has (a, b)`: the record has a link row to a tag named any of them. */
  /* One key of a JSON column (`specs.capacity`, definedFields.ts): the column
     qualified as any column at its prefix is, read through the style. */
  const jsonKeyAt = (path: string) =>
    labelPrefix(path) === undefined ? tryResolvePath(schema, view.base, path).resolved?.jsonKey : undefined;
  const jsonRead = (path: string, json: { column: string; key: string }, as: 'value' | 'text' | 'number'): string => {
    if (!style.jsonKey)
      throw new PathError(`"${path}" reads a key of a JSON column, which this database is not read for here.`, path, json.key, 0);
    const prefix = path.split('.').slice(0, -2).join('.');
    return style.jsonKey(plain(at(prefix, json.column)), json.key, as);
  };
  const membership = (path: string, holes: readonly string[]): string => {
    const json = jsonKeyAt(path);
    if (json) {
      if (!style.jsonHas)
        throw new PathError(`"${path}" reads a key of a JSON column, which this database is not read for here.`, path, json.key, 0);
      return style.jsonHas(plain(at(path.split('.').slice(0, -2).join('.'), json.column)), json.key, holes);
    }
    const tags = tagsAt(path);
    if (!tags) throw new PathError(`"${path}" is not a record's tags, so "has" asks nothing of it.`, path, path.split('.').pop()!, 0);
    const rows = tagRows(path, tags);
    return `EXISTS (SELECT 1 FROM ${rows.from} WHERE ${rows.on} AND ${rows.label} IN (${holes.join(', ')}))`;
  };
  /* `any opportunity where stage = won`: one of the rows that point at this one, under the statement's relations —
     the child's scope, and a CTE for its own conditions (rowScope.ts `filtered`), which resolves each of them in
     this catalog, so a reader's pruned one refuses a column they may not read. Planned once per condition, before
     the scope prefix is frozen, and written the same each time `buildWhere` asks. */
  const planned = new Map<AnyRows, string>();
  const exists = (rows: AnyRows): string => {
    const kept = planned.get(rows);
    if (kept !== undefined) return kept;
    const match = backrefsTo(schema, view.base).find((b) => `${b.child}.${b.fk.from.columns.join('+')}` === rows.via);
    const child = match && findTable(schema, match.child);
    if (!match || !child || match.fk.stitched) {
      const name = rows.via.slice(0, rows.via.lastIndexOf('.'));
      throw new PathError(`"any ${name}" reads rows through "${rows.via}", which does not point at ${view.base} here.`, rows.via, name, 0);
    }
    if (rows.filter?.groups.length && !relations)
      throw new Error(`"any ${child.name}" narrows its rows and needs the statement's relations.`);
    const source = rows.filter?.groups.length
      ? relations!.filtered(child.id, rows.filter)
      : relations
        ? relations.table(child.id)
        : plan.relationOf(child.id);
    const q = style.quote;
    const childAlias = q(plan.subAlias(child.name));
    const on = match.fk.to.columns
      .map(
        (toCol, i) => `${childAlias}.${q(match.fk.from.columns[i] ?? match.fk.from.columns[0])} = ${q(plan.aliasOfPrefix(''))}.${q(toCol)}`,
      )
      .join(' AND ');
    const text = `EXISTS (SELECT 1 FROM ${source} ${childAlias} WHERE ${on})`;
    planned.set(rows, text);
    return text;
  };
  /* A computed column a path names (computed.ts): the view's own, pinned by the
     server from the App's catalog, or the catalog's where it is the App's. */
  const expressionAt = (path: string): ExpressionPath | undefined => {
    if (view.expressions && Object.hasOwn(view.expressions, path)) return view.expressions[path];
    if (labelPrefix(path) !== undefined) return undefined;
    const found = tryResolvePath(schema, view.base, path).resolved;
    return found?.computed ? { ...found.computed, on: path.split('.').slice(0, -1).join('.') } : undefined;
  };
  /* What a path an expression reads is, as the compiler writes it: a yes-or-no column native or a 0/1 integer. */
  const kindOf = (path: string): { kind: ValueKind; native?: boolean } | undefined => {
    const resolved = resolve(path);
    if (resolved.rollup && !resolved.rollup.through) return { kind: columnKind(resolved.column.type) === 'date' ? 'date' : 'number' };
    return columnRead(resolved.column);
  };
  const expression = (computed: ExpressionPath): string =>
    compileComputed(
      computed,
      style,
      (read) => qualify(at(computed.on, read)),
      (read) => kindOf(at(computed.on, read)),
    );
  const resolve = (path: string): ResolvedPath => {
    const expressed = labelPrefix(path) === undefined ? expressionAt(path) : undefined;
    if (expressed) {
      const { table, hops, hopNames } = prefixHops(expressed.on);
      return { path, hops, hopNames, table, column: computedColumnMeta(path.split('.').pop()!, expressed), computed: expressed };
    }
    const computed = labelPrefix(path) === undefined ? computedAt(path) : undefined;
    if (computed) {
      const { table, hops, hopNames } = prefixHops(computed.on);
      const name = path.split('.').pop()!;
      return { path, hops, hopNames, table, column: rollupColumnMeta(name, computed), rollup: computed };
    }
    const tags = labelPrefix(path) === undefined ? tagsAt(path) : undefined;
    if (tags) {
      const { table, hops, hopNames } = prefixHops(tags.on);
      return { path, hops, hopNames, table, column: tagsColumnMeta(), tags };
    }
    const prefix = labelPrefix(path);
    if (prefix === undefined) return resolvePath(schema, view.base, path);
    const { table, parts } = template(path, prefix);
    const first = parts.find((part): part is { path: string } => 'path' in part)!;
    const { hops, hopNames } = prefix ? resolvePath(schema, view.base, at(prefix, first.path)) : { hops: [], hopNames: [] };
    const depth = prefix ? prefix.split('.').length : 0;
    return { path, hops: hops.slice(0, depth), hopNames: hopNames.slice(0, depth), table, column: labelColumnMeta() };
  };
  const qualify = (path: string, condition?: Condition): string => {
    const prefix = labelPrefix(path);
    if (prefix === undefined) {
      const json = jsonKeyAt(path);
      if (json)
        return jsonRead(
          path,
          json,
          !condition
            ? 'value'
            : RANGES.has(condition.op) && typeof condition.value === 'number' && condition.other === undefined
              ? 'number'
              : 'text',
        );
      const expressed = expressionAt(path);
      if (expressed) {
        // The joins to the record it is on, as any column there would plan them.
        if (expressed.on) plain(at(expressed.on, prefixHops(expressed.on).table.columns[0].name));
        return `(${expression(expressed)})`;
      }
      const computed = computedAt(path);
      if (computed) return rollup(path, computed);
      const tags = tagsAt(path);
      return tags ? tagList(path, tags) : plain(path);
    }
    const { table, parts } = template(path, prefix);
    const literal = (text: string) => `'${text.replace(/'/g, "''")}'`;
    /* A record across a reference that reaches no row — none there, or none
       this reader's scope admits — has no name: not the template's own
       words around empty fields ("Points south for ", " ()"). */
    const reached = prefix ? (table.columns.find((column) => column.primaryKey) ?? table.columns[0]) : undefined;
    const named = (text: string) => (reached ? `CASE WHEN ${plain(at(prefix, reached.name))} IS NULL THEN NULL ELSE ${text} END` : text);
    return named(
      style.concat(
        parts.map((part) => {
          if ('text' in part) return literal(part.text);
          const value = style.text(plain(at(prefix, part.path)));
          /* A masked column says its placeholder in the name too, computed here
         like the rest of it, so no list, picker or breadcrumb reads the value. */
          if (part.mask?.prefix) {
            return `CASE WHEN SUBSTR(${value}, 1, ${[...part.mask.prefix].length}) = ${literal(part.mask.prefix)} THEN ${literal(part.mask.prefix + MASK)} ELSE COALESCE(${value}, '') END`;
          }
          if (part.mask) return `CASE WHEN ${value} IS NULL THEN '' ELSE ${literal(MASK)} END`;
          /* A stored value said as its display rule's word, as a cell says it:
         the words are the catalog's, held to what every engine reads alike. */
          if (part.words) {
            const cases = Object.entries(part.words)
              .map(([stored, word]) => `WHEN ${literal(stored)} THEN ${literal(word)}`)
              .join(' ');
            return `CASE ${value} ${cases} ELSE COALESCE(${value}, '') END`;
          }
          return `COALESCE(${value}, '')`;
        }),
      ),
    );
  };
  return { resolve, qualify, membership, exists };
}

/* What a stored column is to an expression that reads it: a yes-or-no column native or a 0/1 integer. */
function columnRead(column: ColumnMeta | undefined): { kind: ValueKind; native?: boolean } | undefined {
  if (!column) return undefined;
  if (isFlagColumn(column)) return { kind: 'boolean', native: columnKind(column.type) === 'boolean' };
  const kind = columnKind(column.type);
  return { kind: kind === 'other' ? 'text' : kind };
}

/* One aggregate of [label, tone] pairs, `[]` over no rows, in each engine's JSON. */
function tagPairs(style: SqlStyle, label: string, tone: string): string {
  if (style.dialect === 'postgres') return `COALESCE(json_agg(json_build_array(${label}, ${tone})), '[]'::json)`;
  if (style.dialect === 'mysql') return `COALESCE(JSON_ARRAYAGG(JSON_ARRAY(${label}, ${tone})), JSON_ARRAY())`;
  return `json_group_array(json_array(${label}, ${tone}))`;
}

/**
 * The view with the record-label templates its `$label` paths need, read from
 * a catalog that serves them (an App's, `TableMeta.labelTemplate`) — and with
 * any it arrived with dropped, so a template is always the catalog's and
 * never a request's words written into a statement.
 */
export function withViewLabels(schema: DatabaseSchema, view: ViewDef): ViewDef {
  const { labels: _given, ...rest } = view;
  const paths = [
    ...(view.columns ?? []).map((c) => c.path),
    ...(view.filter?.groups ?? []).flatMap((group) => group.flatMap((c) => [c.path, ...(c.other === undefined ? [] : [c.other])])),
    ...(view.orderBy ?? []).map((o) => o.path),
  ];
  const labels: Record<string, string> = {};
  for (const path of paths) {
    const prefix = typeof path === 'string' ? labelPrefix(path) : undefined;
    if (prefix === undefined || Object.hasOwn(labels, prefix)) continue;
    const template = tableAtPrefix(schema, view.base, prefix)?.labelTemplate;
    if (template) labels[prefix] = template;
  }
  return Object.keys(labels).length ? { ...rest, labels } : rest;
}

/**
 * The view with the rollups and the computed columns its paths name
 * (rollups.ts, computed.ts), read from a catalog that serves them — an App's,
 * `TableMeta.rollups` and `TableMeta.computed` — and with any it arrived with
 * dropped: like a label template, each is always the catalog's, never a
 * request's words about which rows to sum or what to write into the statement.
 * A computed column's own reads come with it, a rollup among them too.
 */
export function withViewComputed(schema: DatabaseSchema, view: ViewDef): ViewDef {
  const { computed: _given, expressions: _written, tagged: _tagged, ...rest } = view;
  const paths = [
    ...(view.columns ?? []).map((c) => c.path),
    ...(view.filter?.groups ?? []).flatMap((group) => group.flatMap((c) => [c.path, ...(c.other === undefined ? [] : [c.other])])),
    ...(view.orderBy ?? []).filter((o) => !o.alias).map((o) => o.path),
  ];
  const computed: Record<string, ComputedPath> = {};
  const expressions: Record<string, ExpressionPath> = {};
  const tagged: Record<string, TagPath> = {};
  const pin = (path: string, depth = 0): void => {
    if (typeof path !== 'string' || Object.hasOwn(computed, path) || Object.hasOwn(expressions, path) || labelPrefix(path) !== undefined)
      return;
    const resolved = tryResolvePath(schema, view.base, path).resolved;
    const on = path.split('.').slice(0, -1).join('.');
    if (resolved?.rollup) computed[path] = { ...resolved.rollup, on: resolved.rollupAt ?? on };
    if (resolved?.tags) tagged[path] = { ...resolved.tags, on };
    if (resolved?.computed && depth === 0) {
      expressions[path] = { ...resolved.computed, on };
      for (const read of resolved.computed.reads) pin(on ? `${on}.${read}` : read, depth + 1);
    }
  };
  for (const path of paths) pin(path);
  return {
    ...rest,
    ...(Object.keys(computed).length ? { computed } : {}),
    ...(Object.keys(expressions).length ? { expressions } : {}),
    ...(Object.keys(tagged).length ? { tagged } : {}),
  };
}
