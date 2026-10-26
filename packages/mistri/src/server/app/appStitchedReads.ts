/**
 * Stitched references: an App's declared reference to a table in another
 * source, on another connection (`stock_move.product_sku` → `catalog.product`).
 * No statement can join two databases, so a view that shows one is read in
 * two steps, the HTTP adapter's lookUp lifted to the App's composite: the
 * list's own rows first, then one batched read per reference of the distinct
 * keys the page names, through the target source's own reads. Those are the
 * reader's scoped reads where there is a row scope, so the target's policy,
 * grants and hidden columns apply to the second step as to any read of it; a
 * target the reader cannot see is a LEFT JOIN's null, never a disclosure.
 *
 * What would need the targets inside the first statement (a filter or a
 * sort on them, a summary through them, a reference followed past its first
 * step) is refused with why. One shape is answered: a related list on the
 * target, which names its root by the target's primary key
 * (`product_sku.id = 1`, pagePaths.rootFilter). That key is read from the
 * target first and the list is filtered by the value it holds.
 */
import { Refusal, type ViewResult } from '@mistriwork/engine/adapters/adapter.js';
import { primaryKey, type DatabaseSchema, type ForeignKey } from '@mistriwork/engine/shared/schema.js';
import { compileView, resolveAggregate, type ViewDef } from '@mistriwork/engine/shared/view.js';
import { stitchedFarProblem, stitchedHop, type StitchedHop } from '@mistriwork/engine/shared/stitchedPaths.js';
import type { ViewCondition } from '@mistriwork/engine/shared/viewPaths.js';
import { ANSI_STYLE } from '@mistriwork/engine/shared/filter.js';
import { filterPaths, measureConditions, measurePaths, type BreakdownDef } from '@mistriwork/engine/shared/breakdown.js';

/** The most distinct keys one page may ask another source for, as an API is asked (httpAdapter.ts). */
export const MAX_STITCHED_KEYS = 500;

export interface StitchedCatalog {
  /** The App's one resource graph, stitched edges included. */
  schema: DatabaseSchema;
  /** The source a resource belongs to, for the words of a refusal. */
  sourceOf(resource: string): string;
}

type Read = (view: ViewDef) => Promise<ViewResult>;

/** One stitched hop a view takes, keyed by the prefix as the view wrote it. */
type Stitch = Omit<StitchedHop, 'deep'>;

const under = (path: string, prefix: string) => path.startsWith(`${prefix}.`);

/** The stitched hop a path's first step takes, or none; refused when it takes one further in. */
function stitchOf(schema: DatabaseSchema, base: string, path: string): Stitch | undefined {
  const hop = stitchedHop(schema, base, path);
  if (hop?.deep)
    throw new Refusal(
      `"${path}" follows a reference to another source past its first step. ` +
        `Show it from ${hop.edge.from.table}'s own list, or follow it there.`,
    );
  return hop;
}

/** Whether a view could take a stitched hop at all: an edge from its base, or one into it that an aggregate could read back. */
const touches = (schema: DatabaseSchema, base: string) =>
  schema.foreignKeys.some((fk) => fk.stitched && (fk.from.table === base || fk.to.table === base));

function farRefusal(stitch: Stitch, path: string, what: string): never {
  throw new Refusal(stitchedFarProblem({ ...stitch, deep: false }, path, what));
}

/** The value of a stitched reference's key the target's primary key names: read through the target's own reads. */
async function keyOf(stitch: Stitch, conditions: ViewCondition[], readFar: Read): Promise<ViewCondition> {
  const column = stitch.edge.from.columns[0],
    toColumn = stitch.edge.to.columns[0];
  const found = await readFar({
    id: 'stitched-root',
    name: 'Stitched root',
    base: stitch.edge.to.table,
    columns: [{ path: toColumn }],
    filter: { groups: [conditions.map((condition) => ({ ...condition, path: condition.path.slice(stitch.prefix.length + 1) }))] },
    limit: 2,
  });
  const values = found.rows.map((row) => row[found.resolved[0]?.name ?? toColumn]).filter((value) => value !== null && value !== undefined);
  // Nothing matched, or two did: the list names no one record, so it lists nothing.
  return values.length === 1 ? { path: column, op: '=', value: values[0] as string | number } : { path: column, op: 'in', value: [] };
}

/**
 * The view as its own source can run it: every stitched condition refused
 * but the related-list one, answered by the target's key, and each path
 * through a stitched hop gathered for the second step.
 */
async function localPart(catalog: StitchedCatalog, view: ViewDef, readFar: (edge: ForeignKey) => Read) {
  const { schema } = catalog;
  const stitches = new Map<string, Stitch>();
  const note = (path: string) => {
    const stitch = stitchOf(schema, view.base, path);
    if (stitch) stitches.set(stitch.prefix, stitch);
    return stitch;
  };
  for (const aggregate of view.aggregates ?? []) {
    // `on` is a prefix, so any last segment asks whether it crosses.
    if (aggregate.on && stitchOf(schema, view.base, `${aggregate.on}.*`)) {
      throw new Refusal(`A count or sum of rows that point at ${aggregate.on} needs them in one database; it is in another source.`);
    }
    const { fk } = resolveAggregate(schema, view.base, aggregate);
    if (fk.stitched)
      throw new Refusal(
        `${fk.from.table} is in source "${catalog.sourceOf(fk.from.table)}", on another connection: a count or sum of its rows needs them in the same database as ${view.base}.`,
      );
  }
  for (const order of view.orderBy ?? []) {
    const stitch = !order.alias && note(order.path);
    if (stitch) farRefusal(stitch, order.path, 'sort');
  }
  const groups: ViewCondition[][] = [];
  for (const group of view.filter?.groups ?? []) {
    const kept: ViewCondition[] = [];
    const rooted = new Map<string, ViewCondition[]>();
    for (const condition of group) {
      const other = condition.other !== undefined ? note(condition.other) : undefined;
      if (other) farRefusal(other, condition.other!, 'filter');
      const stitch = note(condition.path);
      if (!stitch) {
        kept.push(condition);
        continue;
      }
      const rest = condition.path.slice(stitch.prefix.length + 1);
      const target = schema.tables.find((table) => table.id === stitch.edge.to.table);
      if (condition.op !== '=' || !target || !primaryKey(target).includes(rest)) farRefusal(stitch, condition.path, 'filter');
      rooted.set(stitch.prefix, [...(rooted.get(stitch.prefix) ?? []), condition]);
    }
    for (const [prefix, conditions] of rooted) {
      const stitch = stitches.get(prefix)!;
      const target = schema.tables.find((table) => table.id === stitch.edge.to.table)!;
      if (primaryKey(target).some((key) => !conditions.some((condition) => condition.path === `${prefix}.${key}`))) {
        farRefusal(stitch, conditions[0].path, 'filter');
      }
      kept.push(await keyOf(stitch, conditions, readFar(stitch.edge)));
    }
    groups.push(kept);
  }
  for (const column of view.columns) note(column.path);
  const near = (path: string) => ![...stitches.keys()].some((prefix) => under(path, prefix));
  const keep = <T>(record: Record<string, T> | undefined) =>
    record && Object.fromEntries(Object.entries(record).filter(([path]) => near(path)));
  const columns = view.columns.filter((column) => near(column.path));
  for (const { edge } of stitches.values()) {
    if (!columns.some((column) => column.path === edge.from.columns[0] && column.alias === undefined))
      columns.push({ path: edge.from.columns[0] });
  }
  const local: ViewDef = {
    ...view,
    columns,
    ...(view.filter ? { filter: { groups } } : {}),
    ...(view.labels ? { labels: keep(view.labels) } : {}),
    ...(view.computed ? { computed: keep(view.computed) } : {}),
  };
  return { local, stitches: [...stitches.values()] };
}

/** A view whose base has no stitched edge runs as it is; one that shows a stitched path runs in two steps. */
export async function runStitchedView(
  catalog: StitchedCatalog,
  view: ViewDef,
  offset: number | undefined,
  run: (view: ViewDef, offset?: number) => Promise<ViewResult>,
  readFar: (edge: ForeignKey) => Read,
): Promise<ViewResult> {
  if (!touches(catalog.schema, view.base)) return run(view, offset);
  const started = performance.now();
  const { local, stitches } = await localPart(catalog, view, readFar);
  if (!stitches.length) return run(local, offset);
  // Names, types and joins as one statement would have them, so the client cannot tell the difference.
  const whole = compileView(catalog.schema, view, ANSI_STYLE, offset);
  const near = await run(local, offset);
  const nameOf = (result: ViewResult, path: string) =>
    result.resolved.find((column) => column.path === path && column.aggregate === undefined)?.name ?? path;
  const reads: string[] = [];
  const found = new Map<string, { rows: Map<string, Record<string, unknown> | null>; names: Map<string, string> }>();
  for (const stitch of stitches) {
    const { edge, prefix } = stitch;
    const key = nameOf(near, edge.from.columns[0]);
    const values = [...new Set(near.rows.map((row) => row[key]).filter((value) => value !== null && value !== undefined && value !== ''))];
    if (values.length > MAX_STITCHED_KEYS) {
      throw new Refusal(
        `${edge.from.table} names ${values.length} different ${edge.to.table} on this page, more than the ${MAX_STITCHED_KEYS} ` +
          `read from source "${catalog.sourceOf(edge.to.table)}" at once. Show fewer rows.`,
      );
    }
    const toColumn = edge.to.columns[0];
    const paths = [
      ...new Set([
        toColumn,
        ...view.columns.filter((column) => under(column.path, prefix)).map((column) => column.path.slice(prefix.length + 1)),
      ]),
    ];
    const strip = <T>(record: Record<string, T> | undefined) => {
      if (!record) return undefined;
      const kept = Object.entries(record).flatMap(([path, value]): Array<[string, T]> =>
        path === prefix ? [['', value]] : under(path, prefix) ? [[path.slice(prefix.length + 1), value]] : [],
      );
      return kept.length ? Object.fromEntries(kept) : undefined;
    };
    const labels = strip(view.labels),
      computed = strip(view.computed);
    const rows = new Map<string, Record<string, unknown> | null>();
    const names = new Map<string, string>();
    if (values.length) {
      const far = await readFar(edge)({
        id: `${view.id}:${prefix}`,
        name: view.name,
        base: edge.to.table,
        columns: paths.map((path) => ({ path })),
        filter: { groups: [[{ path: toColumn, op: 'in', value: values as Array<string | number> }]] },
        // One past each key, so a key two rows share is seen as shared.
        limit: values.length * 2,
        ...(labels ? { labels } : {}),
        ...(computed ? { computed } : {}),
      });
      for (const path of paths) names.set(path, nameOf(far, path));
      for (const row of far.rows) {
        const value = String(row[names.get(toColumn)!]);
        // A key the target holds twice names no one record: no label, rather than whichever came first.
        rows.set(value, rows.has(value) ? null : row);
      }
      reads.push(far.sql.text);
    }
    found.set(prefix, { rows, names });
  }
  const columns = whole.columns;
  return {
    ...near,
    columns: columns.map((column) => column.name),
    rows: near.rows.map((row) =>
      Object.fromEntries(
        columns.map((column) => {
          const stitch = stitches.find(({ prefix }) => under(column.path, prefix));
          if (!stitch) return [column.name, row[column.name] ?? null];
          const { rows, names } = found.get(stitch.prefix)!;
          const value = row[nameOf(near, stitch.edge.from.columns[0])];
          const target = value === null || value === undefined ? undefined : rows.get(String(value));
          return [column.name, target?.[names.get(column.path.slice(stitch.prefix.length + 1))!] ?? null];
        }),
      ),
    ),
    ms: Math.round(performance.now() - started),
    sql: { text: [near.sql.text, ...reads].join('\n'), params: near.sql.params },
    resolved: columns,
    joins: whole.joins,
  };
}

/** A count needs no far columns: the view without them, its related-list condition answered first. */
export async function stitchedCountView(catalog: StitchedCatalog, view: ViewDef, readFar: (edge: ForeignKey) => Read): Promise<ViewDef> {
  if (!touches(catalog.schema, view.base)) return view;
  return (await localPart(catalog, view, readFar)).local;
}

/** A breakdown groups and measures in one statement, so nothing of it may be across a stitched hop. */
export function checkStitchedBreakdown(catalog: StitchedCatalog, breakdown: BreakdownDef): void {
  if (!touches(catalog.schema, breakdown.base)) return;
  const paths = [
    ...breakdown.by.map((key) => key.path),
    ...breakdown.measures.flatMap(measurePaths),
    ...filterPaths(breakdown.filter),
    ...measureConditions(breakdown.measures).flatMap(filterPaths),
  ];
  for (const path of paths) {
    const stitch = stitchOf(catalog.schema, breakdown.base, path);
    if (stitch) farRefusal(stitch, path, 'group or count');
  }
}
