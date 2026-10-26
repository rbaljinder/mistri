/*
 * A page against a schema: the reference path a section follows from the
 * root, the filter that pins it to one root row, and the list and metric
 * views a section runs. Pure; nothing fetches.
 */
import { columnOrRollup, findTable, labelColumn, primaryKey, type DatabaseSchema, type ForeignKey, type TableMeta } from './schema.js';
import { MAX_PATH_DEPTH, hopName, parseViewQuery, validateView, type ViewDef, type ViewFilter } from './view.js';
import { quoteValue, saidAt } from './query.js';
import { type PageMetric, type PageList, type PageDef, type PageCustom, DEFAULT_PAGE_LIST_LIMIT, GROUPS_DEFAULT } from './pageModel.js';
import type { PageCustomRead } from './appComponents.js';
import { cardsColumns } from './appCards.js';
import type { BreakdownDef } from './breakdown.js';
import { tryResolvePath } from './viewPaths.js';

/* ---------- resolving against a schema ---------- */

/**
 * A path from a table back to the root, one foreign key per hop.
 *
 * Returned rather than a boolean because the caller needs the same thing the
 * validator does: which columns to compare, and whether the last hop actually
 * lands on the root. Composite keys are carried whole — a path that resolved
 * only the first column of a two-column key would build a filter that matched
 * every row sharing that column.
 */
export interface ResolvedPath {
  hops: ForeignKey[];
  /** The table the path ends at. Must be the page's base for the path to be usable. */
  endsAt: string;
}

/**
 * Follow `a.b.c` from a table, hop by hop, and say where it lands.
 *
 * Each segment names a foreign key on the current table by its canonical
 * column(s), as in view paths (`a+b` for a composite), or by its constraint
 * name, which tells apart two references over the same columns; a dotted
 * constraint name is not a forward path segment.
 */
export function resolvePath(schema: DatabaseSchema, from: string, path: string): { path?: ResolvedPath; error?: string } {
  const segments = path
    .split('.')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!segments.length) return { error: 'A path cannot be empty.' };
  if (segments.length > MAX_PATH_DEPTH) {
    return { error: `"${path}" follows more than ${MAX_PATH_DEPTH} references.` };
  }

  let current = from;
  const hops: ForeignKey[] = [];
  for (const segment of segments) {
    const table = findTable(schema, current);
    if (!table) return { error: `"${current}" is not a table on this connection.` };

    const outgoing = schema.foreignKeys.filter((fk) => fk.from.table === table.id);
    const matches = outgoing.filter((fk) => hopName(fk) === segment || fk.name === segment);
    if (matches.length > 1) return { error: `"${segment}" is ambiguous on ${table.name} — ${matches.length} foreign keys match.` };
    const hop = matches[0];
    if (!hop) {
      /* The commonest cause is a key the database does not declare: a text
         column holding another table's code. Said as that, since "no
         reference" beside a column the author can see reads as a typo. */
      const column = table.columns.some((c) => c.name === segment);
      return {
        error:
          `"${table.name}" has no reference called "${segment}".` +
          (column ? ` "${segment}" is a column of ${table.name}, but not a foreign key: paths follow declared foreign keys only.` : '') +
          (outgoing.length ? ` It points at: ${outgoing.map((fk) => hopName(fk)).join(', ')}.` : ' It points at nothing.') +
          ' See `mistri docs relationships`.',
      };
    }
    hops.push(hop);
    current = hop.to.table;
  }
  return { path: { hops, endsAt: current } };
}

/** Prefer column-based paths, retaining explicit names when columns alone
 * cannot identify the relationship. Never emit a dotted name as one hop. */
export function pageHop(schema: DatabaseSchema, fk: ForeignKey): string | undefined {
  return [...new Set([hopName(fk), fk.name])].find((name) => {
    const resolved = resolvePath(schema, fk.from.table, name).path;
    return resolved?.hops.length === 1 && resolved.hops[0] === fk;
  });
}

/**
 * The filter that ties a section to one root record.
 *
 * Built as a structured `ViewFilter` rather than as text, for the reason the
 * whole tool is built that way: a key value that happens to contain a quote
 * or the word `and` is a value, and text would make it grammar.
 *
 * The path is written into the column, so the compiler does the joining —
 * `invoice_id.customer_id` is a path it already knows how to walk, and the
 * one place that knows how to join is better than a second one here.
 */
export function rootFilter(path: string, key: Record<string, string | number>, resolved: ResolvedPath): ViewFilter {
  const last = resolved.hops[resolved.hops.length - 1];
  // The path's segments reach the view compiler as written: a constraint
  // name tells apart two references sharing the same columns, and replacing
  // it with a canonical hop would lose the choice.
  const prefix = path
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .slice(0, -1)
    .join('.');
  /* Every column of the root's key, compared through the same path. A
     composite key compared on one column matches every row that shares it,
     which on `invoice_line` is most of the table. */
  /* A declared reference (a soft key) meets the root at another unique
     column than its key: `product_sku` holds a product's `sku`, and the
     page knows the product by `id`. Compared through the path instead, so
     the join the reference already is finds the root by its own key. */
  if (last.to.columns.some((column) => key[column] === undefined)) {
    const whole = path
      .split('.')
      .map((segment) => segment.trim())
      .filter(Boolean)
      .join('.');
    return { groups: [Object.entries(key).map(([column, value]) => ({ path: `${whole}.${column}`, op: '=' as const, value }))] };
  }
  const conditions = last.to.columns.map((rootColumn, i) => {
    const childColumn = last.from.columns[i] ?? last.from.columns[0];
    return {
      path: prefix ? `${prefix}.${childColumn}` : childColumn,
      op: '=' as const,
      value: key[rootColumn],
    };
  });
  return { groups: [conditions] };
}

/**
 * Resolve a section's `of` — the forward reference naming which record the
 * section is about.
 *
 * One hop, deliberately. `of: 'site_id.address_id'` is expressible in the
 * type and refused here: each extra hop is another row the planner must read
 * before any section can run, and nobody has yet asked for a section about
 * the address of the site of the record they are looking at. The error says
 * the limit rather than pretending the path is malformed.
 */
export function resolveOf(schema: DatabaseSchema, baseId: string, of: string): { fk?: ForeignKey; table?: TableMeta; error?: string } {
  const resolved = resolvePath(schema, baseId, of);
  if (resolved.error) return { error: resolved.error };
  if (resolved.path!.hops.length !== 1) {
    return { error: `"of" reaches one reference from ${baseId}; "${of}" is ${resolved.path!.hops.length} hops.` };
  }
  const fk = resolved.path!.hops[0];
  const table = findTable(schema, resolved.path!.endsAt);
  if (!table) return { error: `"${of}" leads to a table this connection does not have.` };
  return { fk, table };
}

/**
 * The keys of the records the page's `of` sections are about, by prefix.
 *
 * `null` says the root's reference is empty — a work order with no site —
 * which is different from "unknown": a section given null renders its empty
 * state instead of a filter that can never match.
 */
export type OfKeys = Record<string, Record<string, string | number> | null>;

/**
 * The section's own narrowing, ANDed onto the root's.
 *
 * `filter` has been in the model and in the config parser since the start and
 * was never applied: a page saying `"filter": "status = open"` listed every
 * order, silently. Documented, accepted, ignored — the worst shape a bug can
 * take, because the file says the behaviour is there.
 *
 * Written in the query language and parsed against the *child*, which is what
 * "recent open orders" means: the condition is about the order, not about the
 * customer the page is on. Errors come back rather than throwing, so a
 * mistyped filter names its section instead of blanking the page.
 */
function withSectionFilter(
  schema: DatabaseSchema,
  from: string,
  root: ViewFilter,
  filter: string | undefined,
  now?: Date,
): { filter?: ViewFilter; error?: string } {
  if (!filter) return { filter: root };
  const parsed = parseViewQuery(schema, from, filter, now);
  if (parsed.errors.length) return { error: parsed.errors[0].message };

  const extra = parsed.filter.groups;
  if (!extra.length) return { filter: root };
  /* ANDed into every root group rather than appended as another group: groups
     are OR-ed, so appending would have widened the result instead of
     narrowing it — a filter that added rows. With one root group, which is
     what `rootFilter` always builds, this is the ordinary case of "and also".
  
     A filter with its own OR becomes a product, which is what AND-of-ORs
     means when both sides have alternatives. */
  const groups = [];
  for (const rootGroup of root.groups) {
    for (const extraGroup of extra) groups.push([...rootGroup, ...extraGroup]);
  }
  return { filter: { groups } };
}

/** The record's own values, read on the server from its row for the sections that match on them (a similar list). */
export type RootValues = Record<string, unknown>;

/* The engines' number types, by the names each gives its columns. */
const NUMERIC_TYPE = /int|real|num|dec|float|double|money/i;

/**
 * What is wrong with a list's match (`same`, `near`) against this schema, or
 * undefined. Said at startup (validatePage) and again when the list is
 * planned, in the same words, so a page that loads is a page whose matched
 * list can run. Each column is one of the listed table and of the page's own,
 * the record's value being read off the page's row.
 */
export function similarProblem(schema: DatabaseSchema, page: PageDef, section: PageList): string | undefined {
  const similar = section.similar;
  if (!similar) return undefined;
  const table = findTable(schema, section.from);
  if (!table) return `"${section.from}" is not a table on this connection.`;
  const base = findTable(schema, page.base);
  const near = Object.keys(similar.near ?? {});
  for (const column of [...similar.same, ...near]) {
    if (!table.columns.some((c) => c.name === column)) return `"same" names "${column}", which is not a column on ${table.name}.`;
    if (!base?.columns.some((c) => c.name === column)) {
      return `"same" names "${column}", which the page's own table, ${base?.name ?? page.base}, does not have: a row shares it with the record the page is on.`;
    }
  }
  for (const column of near) {
    const type = table.columns.find((c) => c.name === column)?.type ?? '';
    if (!NUMERIC_TYPE.test(type)) {
      return `"near" keeps "${column}" near the record's value, so it must be a number column; it is ${type || 'untyped'}.`;
    }
  }
  if (table.id === page.base && !primaryKey(table).length)
    return `A match leaves out the record the page is on, and ${table.name} has no primary key to know it by.`;
  return undefined;
}

/** Why `column` cannot be summed over `table`'s rows: not a column, rollup or computed column, or not a number. */
function numberColumnProblem(table: TableMeta, column: string, option: string, verb: string): string | undefined {
  const computed = table.computed && Object.hasOwn(table.computed, column) ? table.computed[column] : undefined;
  const type =
    table.columns.find((c) => c.name === column)?.type ??
    (table.rollups && Object.hasOwn(table.rollups, column) ? table.rollups[column].type : undefined) ??
    (computed ? (computed.type === 'number' ? 'NUMERIC' : computed.type) : undefined);
  if (type === undefined) return `"${option}" names "${column}", which is not a column, rollup or computed column on ${table.name}.`;
  if (!NUMERIC_TYPE.test(type)) return `"${option}" ${verb} "${column}", so it must be a number; it is ${type || 'untyped'}.`;
  return undefined;
}

/**
 * What is wrong with a related list's footer of sums (`totals`) against this
 * schema, or undefined — said at startup and again when the list is planned.
 * A total is a number column of the rows, or one of their numeric rollups or
 * computed columns (`refunded`, the refunds of each order), through any
 * reference `whose` walks.
 */
export function relatedMatchProblem(schema: DatabaseSchema, page: PageDef, section: PageList): string | undefined {
  const table = findTable(schema, section.from);
  if (!table) return `"${section.from}" is not a table on this connection.`;
  void page;
  for (const column of section.totals ?? []) {
    const problem = numberColumnProblem(table, column, 'totals', 'sums');
    if (problem) return problem;
  }
  return undefined;
}

/** The grouped record's columns a header says, as paths from the listed rows: read with each group's rows, so a header costs no read. */
export function groupFactPaths(section: Pick<PageList, 'group'>): string[] {
  const group = section.group;
  return group?.show?.length ? group.show.map((column) => `${group.by}.${column}`) : [];
}

/** The table a group's header is a record of, or undefined where the groups are plain values (or the path does not resolve). */
export function groupTable(schema: DatabaseSchema, section: Pick<PageList, 'from' | 'group'>): TableMeta | undefined {
  if (!section.group) return undefined;
  const { resolved } = tryResolvePath(schema, section.from, section.group.by);
  if (!resolved) return undefined;
  const { table, column } = resolved;
  /* The declared key the column is the whole of: a leg of a composite key names no one record. */
  const fk = schema.foreignKeys.find((k) => k.from.table === table.id && k.from.columns.length === 1 && k.from.columns[0] === column.name);
  return fk ? findTable(schema, fk.to.table) : undefined;
}

/**
 * What is wrong with a grouped list against this schema, or undefined — said at startup and again when the list is
 * planned. The header is the record the rows point at through `by`; where `by` ends at a plain column the groups are
 * its values, and there is no record to take facts or an order from.
 */
export function groupProblem(schema: DatabaseSchema, page: PageDef, section: PageList): string | undefined {
  const group = section.group;
  if (!group) return undefined;
  const table = findTable(schema, section.from);
  if (!table) return `"${section.from}" is not a table on this connection.`;
  const found = tryResolvePath(schema, table.id, group.by);
  if (!found.resolved)
    return `"group.by" names "${group.by}", which is not a column of ${table.name} or a path from it. ${found.error?.message ?? ''}`.trim();
  for (const column of group.sum ?? []) {
    const problem = numberColumnProblem(table, column, 'group.sum', 'sums');
    if (problem) return problem;
  }
  const target = groupTable(schema, section);
  if (target && target.id === page.base && !section.of)
    return `"group.by" names "${group.by}", which is the record this page is on, so every row would fall in one group. Group by a record between them, such as the middle of the chain.`;
  if (!target) {
    if (group.show?.length)
      return `"group.show" says facts of the record a group is, and "${group.by}" is a plain column: its groups are its values. Leave "show" out, or group by a reference.`;
    if (group.sort)
      return `"group.sort" orders by a column of the record a group is, and "${group.by}" is a plain column: its groups are values, largest first. Leave "sort" out, or group by a reference.`;
    return undefined;
  }
  for (const name of group.show ?? []) {
    if (!target.columns.some((c) => c.name === name) && !(target.computed && Object.hasOwn(target.computed, name)))
      return `"group.show" names "${name}", which is not a column of ${target.name}, the record each group is.`;
  }
  if (group.sort && !target.columns.some((c) => c.name === group.sort!.column))
    return `"group.sort" names "${group.sort.column}", which is not a column of ${target.name}, the record each group is.`;
  return undefined;
}

/**
 * The groups of a grouped list: one row for each record (or value) the listed rows point at through `by`, with how
 * many rows it holds, its subtotals when the list has `totals`, and, when the groups are ordered by a column of the
 * grouped record, the largest of that column — the sort column depends on the key, so the maximum is exact. It is a
 * plain breakdown over the same rows the list reads, so it adds no SQL shape of its own and the reader's grants,
 * row policy and tenant scope narrow it as they narrow every breakdown.
 */
export function groupsView(
  schema: DatabaseSchema,
  page: PageDef,
  section: PageList,
  key: Record<string, string | number>,
  ofKeys?: OfKeys,
  now?: Date,
): { breakdown?: BreakdownDef; empty?: boolean; error?: string } {
  const group = section.group;
  if (!group) return {};
  const problem = groupProblem(schema, page, section) ?? relatedMatchProblem(schema, page, section);
  if (problem) return { error: problem };
  const root = sectionRoot(schema, page, section, key, ofKeys);
  if (root.error) return { error: root.error };
  if (root.empty) return { empty: true };
  const resolved = resolvePath(schema, section.from, section.path);
  if (resolved.error) return { error: resolved.error };
  const table = findTable(schema, section.from)!;
  const narrowed = withSectionFilter(schema, table.id, rootFilter(section.path, root.key!, resolved.path!), section.filter, now);
  if (narrowed.error) return { error: narrowed.error };
  const sort = group.sort;
  return {
    breakdown: {
      base: table.id,
      by: [{ path: group.by }],
      measures: [
        { fn: 'count', alias: 'group_rows' },
        ...(sort ? [{ fn: 'max' as const, path: `${group.by}.${sort.column}`, alias: 'group_order' }] : []),
        ...(section.totals ?? []).map((column, i) => ({ fn: 'sum' as const, path: column, alias: `total_${i}` })),
        ...(group.sum ?? []).map((column, i) => ({ fn: 'sum' as const, path: column, alias: `group_sum_${i}` })),
      ],
      filter: narrowed.filter,
      /* The rows with no value are one group, and they come last whatever the order: the breakdown is paged, so only
         the query can keep them last on every page (a client could place them on the page they happen to fall on). */
      orderBy: [
        { name: group.by, direction: 'asc', emptyLast: true },
        sort ? { name: 'group_order', direction: sort.direction } : { name: 'group_rows', direction: 'desc' },
      ],
      limit: group.limit ?? GROUPS_DEFAULT,
    },
  };
}

/**
 * The sums a related list's footer says, as a breakdown with no key over the
 * rows the list's reference matches — one row, a `sum` a column, as a
 * narrowed page metric is measured — so the footer counts every row, not the
 * page of them the list has loaded, and a rollup of the rows sums as a column
 * does.
 */
export function totalsView(
  schema: DatabaseSchema,
  page: PageDef,
  section: PageList,
  key: Record<string, string | number>,
  ofKeys?: OfKeys,
  rootValues?: RootValues,
): { breakdown?: BreakdownDef; empty?: boolean; error?: string } {
  if (!section.totals?.length) return {};
  /* A matched list sums the rows it shows: the same filter, built from the record's own values. */
  if (section.similar) {
    const problem = relatedMatchProblem(schema, page, section);
    if (problem) return { error: problem };
    const matched = similarView(schema, page, section, key, 0, undefined, rootValues);
    if (!matched.view) return matched.empty ? { empty: true } : { error: matched.error };
    return {
      breakdown: {
        base: matched.view.base,
        by: [],
        measures: section.totals.map((column, i) => ({ fn: 'sum' as const, path: column, alias: `total_${i}` })),
        filter: matched.view.filter,
        limit: 1,
      },
    };
  }
  const root = sectionRoot(schema, page, section, key, ofKeys);
  if (root.error) return { error: root.error };
  if (root.empty) return { empty: true };
  const resolved = resolvePath(schema, section.from, section.path);
  if (resolved.error) return { error: resolved.error };
  const problem = relatedMatchProblem(schema, page, section);
  if (problem) return { error: problem };
  const table = findTable(schema, section.from)!;
  return {
    breakdown: {
      base: table.id,
      by: [],
      measures: section.totals.map((column, i) => ({ fn: 'sum' as const, path: column, alias: `total_${i}` })),
      filter: rootFilter(section.path, root.key!, resolved.path!),
      limit: 1,
    },
  };
}

/**
 * A matched list: rows that share the record's values — equal on `same`,
 * within a fraction of the record's value on `near` — and, where they are
 * rows of the page's own table, the record itself left out; closest first on
 * the first `near` column, then the section's own sort, then the key, so equal
 * distances still come back in one order.
 *
 * Built from values the caller read from the root row on the server, never
 * from anything the client sent, and returned as an ordinary view, so the
 * reader's grants, row policy, the public read ceiling and tenant scope
 * narrow it exactly as they narrow any list. A value the record lacks — an
 * empty `same`, a `near` that is not a number — empties the section: a
 * "similar" list of everything, because this record's body type is blank,
 * would be a list that lies.
 */
function similarView(
  schema: DatabaseSchema,
  page: PageDef,
  section: PageList,
  key: Record<string, string | number>,
  index: number,
  now: Date | undefined,
  rootValues: RootValues | undefined,
): { view?: ViewDef; empty?: boolean; error?: string } {
  const problem = similarProblem(schema, page, section);
  if (problem) return { error: problem };
  if (!rootValues) return { error: 'The record\'s values for "same" were not read before planning.' };
  const table = findTable(schema, section.from)!;
  const similar = section.similar!;
  const conditions: ViewFilter['groups'][number] = [];
  for (const column of similar.same) {
    const value = rootValues[column];
    if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return { empty: true };
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return { empty: true };
    conditions.push({ path: column, op: '=', value });
  }
  const closest: NonNullable<ViewDef['orderBy']> = [];
  for (const [column, fraction] of Object.entries(similar.near ?? {})) {
    const raw = rootValues[column];
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : Number.NaN;
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) return { empty: true };
    let [low, high] = [value * (1 - fraction), value * (1 + fraction)].sort((a, b) => a - b);
    /* A whole-number column keeps whole-number bounds — the same rows, and a
       question the query bar can read back ("price >= 22497"). */
    if (/int/i.test(table.columns.find((c) => c.name === column)?.type ?? '')) [low, high] = [Math.ceil(low), Math.floor(high)];
    conditions.push({ path: column, op: '>=', value: low }, { path: column, op: '<=', value: high });
    if (!closest.length) closest.push({ path: column, direction: 'asc', near: value });
  }
  /* The record itself, left out as NOT (every key column equal): one OR-ed
     group per key column, so a composite key leaves out exactly one row. Rows of another table are not it. */
  const keyColumns = primaryKey(table);
  const own = table.id === page.base;
  if (own && keyColumns.some((column) => key[column] === undefined))
    return { error: `The record's key does not name ${table.name}'s ${keyColumns.join(', ')}.` };
  const groups = own ? keyColumns.map((column) => [...conditions, { path: column, op: '!=' as const, value: key[column] }]) : [conditions];
  const narrowed = withSectionFilter(schema, table.id, { groups }, section.filter, now);
  if (narrowed.error) return { error: narrowed.error };

  const cardColumns =
    typeof section.presentation === 'object'
      ? section.presentation.kind === 'custom'
        ? [...section.presentation.show]
        : cardsColumns(section.presentation)
      : [];
  const columns = [...new Set([...(section.columns?.length ? section.columns : defaultColumns(table, '')), ...cardColumns])].map((p) => ({
    path: p,
  }));
  const sorted = section.orderBy?.map((o) => ({ path: o.column, direction: o.direction })) ?? [];
  const tieBreak = keyColumns.filter((c) => !sorted.some((o) => o.path === c)).map((c) => ({ path: c, direction: 'asc' as const }));
  return {
    view: {
      id: `page:${page.id}:${index}`,
      name: section.title ?? table.name,
      base: table.id,
      columns,
      filter: narrowed.filter,
      orderBy: [...closest, ...sorted, ...tieBreak],
      limit: section.limit ?? DEFAULT_PAGE_LIST_LIMIT,
    },
  };
}

/**
 * What a list section needs to run, as a view the existing compiler can take.
 *
 * A page adds no query machinery of its own. Every section is a view — that
 * is the point of having built one — so a page is an arrangement of views
 * around a shared root rather than a second way to ask a database questions.
 */
export function listView(
  schema: DatabaseSchema,
  page: PageDef,
  section: PageList,
  key: Record<string, string | number>,
  index: number,
  now?: Date,
  ofKeys?: OfKeys,
  rootValues?: RootValues,
): { view?: ViewDef; empty?: boolean; error?: string } {
  /* A similar list walks no path: it is matched on the record's own values. */
  if (section.similar) return similarView(schema, page, section, key, index, now, rootValues);
  const root = sectionRoot(schema, page, section, key, ofKeys);
  if (root.error) return { error: root.error };
  if (root.empty) return { empty: true };

  const resolved = resolvePath(schema, section.from, section.path);
  if (resolved.error) return { error: resolved.error };
  if (resolved.path!.endsAt !== root.table) {
    return {
      error: `"${section.path}" leads from ${section.from} to ` + `${resolved.path!.endsAt}, not to ${root.table}.`,
    };
  }

  const table = findTable(schema, section.from);
  if (!table) return { error: `"${section.from}" is not a table on this connection.` };
  /* Cards read their own columns (title, figure, badge, lines, summary)
     beside whatever the section shows. */
  const cardColumns =
    typeof section.presentation === 'object'
      ? section.presentation.kind === 'custom'
        ? [...section.presentation.show]
        : cardsColumns(section.presentation)
      : [];
  /* A current card is titled by its row's name, which its facts leave out. */
  const titled = section.presentation === 'card' ? [labelColumn(table)].filter((name): name is string => Boolean(name)) : [];
  const columns = [
    ...new Set([
      ...titled,
      ...(section.columns?.length ? section.columns : defaultColumns(table, section.path, resolved.path!)),
      ...cardColumns,
      ...groupFactPaths(section),
    ]),
  ].map((p) => ({ path: p }));

  const joined = rootFilter(section.path, root.key!, resolved.path!);
  const narrowed = withSectionFilter(schema, table.id, joined, section.filter, now);
  if (narrowed.error) return { error: narrowed.error };

  return {
    view: {
      id: `page:${page.id}:${index}`,
      name: section.title ?? table.name,
      base: table.id,
      columns,
      filter: narrowed.filter,
      orderBy: section.orderBy?.map((o) => ({ path: o.column, direction: o.direction })),
      limit: section.limit ?? DEFAULT_PAGE_LIST_LIMIT,
    },
  };
}

/**
 * The record a section is actually about: the root, or — through `of` — a
 * record the root points at, whose key the planner has already read.
 */
function sectionRoot(
  schema: DatabaseSchema,
  page: PageDef,
  section: PageMetric | PageList,
  key: Record<string, string | number>,
  ofKeys: OfKeys | undefined,
): { table?: string; key?: Record<string, string | number>; empty?: boolean; error?: string } {
  if (!section.of) return { table: page.base, key };
  const of = resolveOf(schema, page.base, section.of);
  if (of.error) return { error: of.error };
  const referenced = ofKeys?.[section.of];
  if (referenced === undefined) {
    /* The planner read the root row before building sections, so a missing
       entry is the caller's bug, not the page's. Said as what it is. */
    return { error: `The key for "${section.of}" was not resolved before planning.` };
  }
  if (referenced === null) return { empty: true };
  return { table: of.table!.id, key: referenced };
}

/**
 * What a metric section needs to run.
 *
 * Expressed as a one-row view over the *root* table with a single aggregate,
 * rather than as a count over the child: the aggregate machinery already
 * guarantees that two counts over different children cannot inflate each
 * other, and doing it any other way here would give up that guarantee for a
 * number nobody would think to check.
 */
/**
 * How the query bar would say what a section shows — when it can say it.
 *
 * A count on a page is a number, and a number you cannot get behind is a
 * number you have to take on trust. Clicking one should open the rows it
 * counted, narrowed the same way — and for a long time it opened the child
 * table with no filter at all, because the plan carried no query and the
 * client fell back to the table's own name. The count said 3 and the grid
 * said 20.
 *
 * The query language has no dotted paths: `invoice_line invoice_id.customer_id
 * = 4` is not a thing it can parse, and a page two hops out produces exactly
 * that. So this answers `undefined` rather than something that will not run —
 * the caller opens the composer on the view itself in that case, which can
 * say it. The distinction is deliberate: it is better to be told the language
 * cannot express this than to be shown a filter that quietly is not the one.
 *
 * `is empty` for a null test, because that is the grammar's spelling; `in` is
 * left out, since a list needs bracket syntax the parser writes differently
 * from how it reads it.
 */
const QUERY_OPS: Partial<Record<string, string>> = {
  '=': '=',
  '!=': '!=',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
  contains: 'contains',
  startsWith: 'startswith',
  endsWith: 'endswith',
};

export function sectionQuery(view: ViewDef | undefined): string | undefined {
  if (!view?.base) return undefined;
  const groups = view.filter?.groups?.filter((g) => g.length) ?? [];
  if (!groups.length) return view.base;

  const parts: string[] = [];
  for (const group of groups) {
    const conditions: string[] = [];
    for (const c of group) {
      /* A path, not a column: the language filters the table in front of it
         and nothing further out. */
      if (!c.path || c.path.includes('.')) return undefined;
      if (c.op === 'isNull' || c.op === 'isNotNull') {
        conditions.push(`${c.path} is ${c.op === 'isNull' ? '' : 'not '}empty`);
        continue;
      }
      const op = QUERY_OPS[c.op];
      if (c.other !== undefined) {
        if (!op || c.other.includes('.')) return undefined;
        conditions.push(`${c.path} ${op} ${c.other}`);
        continue;
      }
      if (!op || c.value === undefined || c.value === null || Array.isArray(c.value)) return undefined;
      conditions.push(`${c.path} ${op} ${quoteValue(c.value)}`);
    }
    parts.push(conditions.join(' and '));
  }
  return `${view.base} ${parts.join(' or ')}`;
}

export function metricView(
  schema: DatabaseSchema,
  page: PageDef,
  section: PageMetric,
  key: Record<string, string | number>,
  index: number,
  now?: Date,
  ofKeys?: OfKeys,
): { view?: ViewDef; counts?: boolean; breakdown?: BreakdownDef; empty?: boolean; error?: string } {
  const root = sectionRoot(schema, page, section, key, ofKeys);
  if (root.error) return { error: root.error };
  if (root.empty) return { empty: true, counts: section.fn === 'count' };

  const resolved = resolvePath(schema, section.from, section.path);
  if (resolved.error) return { error: resolved.error };
  if (resolved.path!.endsAt !== root.table) {
    return {
      error: `"${section.path}" leads from ${section.from} to ` + `${resolved.path!.endsAt}, not to ${root.table}.`,
    };
  }
  if (section.fn !== 'count' && !section.column) {
    return { error: `"${section.fn}" needs a column to ${section.fn}.` };
  }

  const table = findTable(schema, section.from);
  if (!table) return { error: `"${section.from}" is not a table on this connection.` };
  if (section.column && !columnOrRollup(table, section.column)) {
    return { error: `"${table.name}" has no column called "${section.column}".` };
  }

  /* The record this section is about — the page's base, or the table `of`
     reaches. The aggregate view below anchors on it, so a sum "of its site"
     is a one-row view over site exactly as a sum over the root is one over
     the root. */
  const base = findTable(schema, root.table!);
  if (!base) return { error: `"${root.table}" is not a table on this connection.` };

  /**
   * A count is a filtered count of the child, not an aggregate on the root.
   *
   * It used to be an aggregate, with `via` taken from the *first* hop — which
   * is the right constraint only when there is one. For anything further out
   * the first hop names a key that does not point at the root at all: on a
   * customer page, `invoice_line via invoice_id.customer_id` handed the
   * aggregate `line_invoice_fk`, which joins lines to invoices and knows
   * nothing about customers. The number that came back was not the number
   * asked for, and looked like one.
   *
   * Counting the child directly is correct at any depth, and it is what the
   * list beside it already does — so a count and the list it summarises can
   * no longer disagree. The view returns one row and its `total`, which is
   * exact: a view only ever joins to-one, so counting it is counting the
   * table it started from.
   */
  const narrowed = withSectionFilter(schema, table.id, rootFilter(section.path, root.key!, resolved.path!), section.filter, now);
  if (narrowed.error) return { error: narrowed.error };
  /* The rows it measures, as the list beside it would show them: what a
     count reads its total from, and what any metric reopens as. */
  const rowsView: ViewDef = {
    id: `page:${page.id}:${index}`,
    name: section.title ?? table.name,
    base: table.id,
    columns: (primaryKey(table)[0] ? [primaryKey(table)[0]] : [table.columns[0].name]).map((path) => ({ path })),
    filter: narrowed.filter,
    limit: 1,
  };
  if (section.fn === 'count') return { counts: true, view: rowsView };

  /* A narrowed `sum`, `avg`, `min` or `max` — or one further out than one
     hop — is measured the way a count is counted: over the child's own rows,
     filtered by the path to the root and the section's query, as a
     breakdown with no key, which answers one row. That is correct at any
     depth for the same reason the count is (a path only joins to-one), and
     it is the same filter the list beside it reads, so the figure and the
     list cannot disagree. The aggregate compiler below reaches one hop and
     takes no filter; it was refusing both, which `mistri check` could not
     see coming. */
  /* A rollup of the child (rollups.ts) is not a column the one-hop
     aggregate below can read, so it is measured this way too. */
  const rollup = Boolean(section.column && !table.columns.some((c) => c.name === section.column));
  if (section.filter || resolved.path!.hops.length > 1 || rollup) {
    return {
      view: rowsView,
      breakdown: {
        base: table.id,
        by: [],
        measures: [{ fn: section.fn, path: section.column, alias: 'value' }],
        filter: narrowed.filter,
        limit: 1,
      },
    };
  }

  return {
    view: {
      id: `page:${page.id}:${index}`,
      name: section.title ?? `${section.fn} of ${table.name}`,
      base: base.id,
      columns: primaryKey(base).map((c) => ({ path: c })),
      aggregates: [
        {
          fn: section.fn,
          via: `${table.id}.${resolved.path!.hops[0].from.columns.join('+')}`,
          column: section.column,
          alias: 'value',
        },
      ],
      filter: { groups: [primaryKey(base).map((c) => ({ path: c, op: '=' as const, value: root.key![c] }))] },
      limit: 1,
    },
  };
}

/**
 * Columns worth showing in a list nobody has configured.
 *
 * The path back to the root is dropped: every row in the section has the same
 * value for it, so a column of forty identical numbers is the one column that
 * cannot tell two rows apart. The key and the label come first, because they
 * are what a row is called.
 */
export function defaultColumns(table: TableMeta, path: string, resolved?: ResolvedPath): string[] {
  /* The columns the first hop actually uses, not the segment that named it.
  
     A saved path segment can be a constraint name, so splitting the
     path for a column name found `address_country_fk`, matched nothing, and
     left `country_code` in the table: a column reading NZ on every row of a
     section that is *about* NZ. The one column that cannot tell two rows
     apart, kept in the one place it is guaranteed useless. */
  const pathHead = resolved ? resolved.hops[0].from.columns : [path.split('.')[0]];
  const key = primaryKey(table);
  const label = labelColumn(table);
  const ordered = [
    ...key,
    ...(label && !key.includes(label) ? [label] : []),
    ...table.columns.map((c) => c.name).filter((n) => !key.includes(n) && n !== label),
  ];
  return ordered.filter((name) => !pathHead.includes(name)).slice(0, 6);
}

/* ---------- a custom section's reads ---------- */

/**
 * One declared read of a custom section, planned as the list it is: with
 * `whose`, exactly a related list (listView), the same join back to the
 * record; without, the resource's own rows narrowed by its query — the
 * dashboard's rows section, on a page. Either way the result is a view the
 * server compiles and authorizes on every run, like any section's.
 */
export function customReadView(
  schema: DatabaseSchema,
  page: PageDef,
  name: string,
  read: PageCustomRead,
  key: Record<string, string | number>,
  index: number,
  now?: Date,
): { view?: ViewDef; empty?: boolean; error?: string } {
  if (read.path) {
    const built = listView(
      schema,
      page,
      {
        kind: 'list',
        from: read.from,
        path: read.path,
        columns: read.columns,
        filter: read.filter,
        orderBy: read.orderBy,
        limit: read.limit ?? DEFAULT_PAGE_LIST_LIMIT,
      },
      key,
      index,
      now,
    );
    return built.view ? { ...built, view: { ...built.view, id: `page:${page.id}:${index}:${name}` } } : built;
  }
  const table = findTable(schema, read.from);
  if (!table) return { error: `"${read.from}" is not a table on this connection.` };
  let filter: ViewFilter | undefined;
  if (read.filter) {
    const parsed = parseViewQuery(schema, table.id, read.filter, now);
    if (parsed.errors.length) return { error: parsed.errors[0].message };
    if (parsed.filter.groups.length) filter = parsed.filter;
  }
  return {
    view: {
      id: `page:${page.id}:${index}:${name}`,
      name,
      base: table.id,
      columns: read.columns.map((path) => ({ path })),
      ...(filter ? { filter } : {}),
      orderBy: read.orderBy?.map((o) => ({ path: o.column, direction: o.direction })),
      limit: read.limit ?? DEFAULT_PAGE_LIST_LIMIT,
    },
  };
}

/**
 * What is wrong with a custom section against this schema, or undefined:
 * the record's fields judged as a fields section's, each read as the list it
 * is planned as — its `whose` leading home, its columns, order and query
 * through the compiler that will run them. Said at startup, so a misspelled
 * column is refused before a reader sees the section.
 */
export function customProblem(schema: DatabaseSchema, page: PageDef, section: PageCustom, index: number): string | undefined {
  if (section.record?.length) {
    const error = validateView(schema, {
      id: `page:${page.id}:${index}:record`,
      name: 'record',
      base: page.base,
      columns: section.record.map((path) => ({ path })),
    });
    if (error) return `"record": ${error}`;
  }
  for (const [name, read] of Object.entries(section.reads ?? {})) {
    const here = `rows "${name}"`;
    const table = findTable(schema, read.from);
    if (!table) return `${here}: "${read.from}" is not a table on this connection.`;
    if (read.path) {
      const resolved = resolvePath(schema, read.from, read.path);
      if (resolved.error) return `${here}: ${resolved.error}`;
      if (resolved.path!.endsAt !== page.base)
        return `${here}: "${read.path}" leads from ${read.from} to ${resolved.path!.endsAt}, not to ${page.base}.`;
    }
    if (read.filter) {
      const parsed = parseViewQuery(schema, table.id, read.filter);
      if (parsed.errors.length) return `${here}: ${saidAt(parsed.errors[0], read.filter.trim())}`;
    }
    const error = validateView(schema, {
      id: `page:${page.id}:${index}:${name}`,
      name,
      base: table.id,
      columns: read.columns.map((path) => ({ path })),
      orderBy: read.orderBy?.map((o) => ({ path: o.column, direction: o.direction })),
    });
    if (error) return `${here}: ${error}`;
  }
  return undefined;
}

/* ---------- captions ---------- */

/** The hop every path shares, where each is one field past it (`dealer_id.name`, `dealer_id.city` → `dealer_id`), or ''. */
export function sharedPrefix(paths: readonly string[] | undefined): string {
  if (!paths?.length) return '';
  const first = paths[0];
  if (!first.includes('.')) return '';
  const prefix = first.slice(0, first.lastIndexOf('.'));
  return paths.every((p) => p.startsWith(`${prefix}.`) && !p.slice(prefix.length + 1).includes('.')) ? prefix : '';
}

/**
 * The hop a card's facts are captioned without. A card's title is the record
 * (`bike_id`, the reference itself) and its facts are that record's own fields
 * (`bike_id.make`, `bike_id.serial_number`): read with the title, the paths
 * share no hop, and a fact that is the parent's label column was captioned as
 * the reference ("Bike" over a serial number). Its own name is what it is there.
 */
export function cardStem(paths: readonly string[] | undefined): string {
  const [title, ...facts] = paths ?? [];
  const stem = sharedPrefix(facts);
  /* Only where the title is that record: beside a title of its own, `dealer_id.name` is still "Dealer". */
  return stem && (title === stem || title.startsWith(`${stem}.`)) ? stem : sharedPrefix(paths);
}
