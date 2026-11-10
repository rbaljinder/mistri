/**
 * Every table a read request reaches, for the two doors that hold a request to a declared list of tables (a page's
 * manifest, a surface): the base it names and the table at each hop of every explicit path it walks. A view of
 * `orders` that shows `customer_id.email`, filters on `customer_id.region` or sorts by a path reads `customers` too,
 * so a list that judged the base alone would let a read through to a table it never declared.
 */
import { measurePaths, type BreakdownDef, type Measure } from '@mistriwork/engine/shared/breakdown.js';
import { textToBreakdown } from '@mistriwork/engine/shared/breakdowntext.js';
import { tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { parseViewQuery } from '@mistriwork/engine/shared/view.js';
import { textToView } from '@mistriwork/engine/shared/viewtext.js';
import { PathError, resolveAggregate, tableAtPrefix, tryResolvePath, type ViewDef } from '@mistriwork/engine/shared/viewPaths.js';

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const leading = (text: unknown) => (typeof text === 'string' ? (text.trim().split(/\s+/)[0] ?? '') : '');

/** What a request names of one read: a structured view or breakdown, and the text it may be written as. */
interface Asked {
  view?: unknown;
  def?: unknown;
  text?: unknown;
  /** The query box's text, which a view run merges into its view: its paths are read from the view's base. */
  query?: unknown;
}

/** The paths a read walks from one base, collected into the tables they land on. */
function walker(schema: DatabaseSchema, baseId: string, into: Set<string>) {
  /* A path that does not resolve reaches nothing: the run refuses it. One that ends on the base's own column, a
     reference included, has no hops and so reaches nothing either. */
  const path = (value: unknown) => {
    if (typeof value !== 'string') return;
    for (const fk of tryResolvePath(schema, baseId, value).resolved?.hops ?? []) into.add(fk.to.table);
  };
  const filter = (value: unknown): void => {
    const groups = isRecord(value) && Array.isArray(value.groups) ? value.groups : [];
    for (const condition of groups.flat()) {
      if (!isRecord(condition)) continue;
      path(condition.path);
      path(condition.column);
      path(condition.other);
      /* `any child where …` asks the rows that point at this one: the child is reached, and its filter reads from it. */
      const any = isRecord(condition.any) ? condition.any : undefined;
      if (typeof any?.via !== 'string') continue;
      const child = tableNamed(schema, any.via.slice(0, Math.max(0, any.via.lastIndexOf('.'))));
      if (!child) continue;
      into.add(child.id);
      walker(schema, child.id, into).filter(any.filter);
    }
  };
  const aggregate = (value: unknown) => {
    if (!isRecord(value)) return;
    try {
      const resolved = resolveAggregate(schema, baseId, value as never);
      into.add(resolved.child.id);
      const segments = resolved.on ? resolved.on.split('.') : [];
      for (let at = 1; at <= segments.length; at++) {
        const table = tableAtPrefix(schema, baseId, segments.slice(0, at).join('.'));
        if (table) into.add(table.id);
      }
    } catch (error) {
      if (!(error instanceof PathError)) throw error;
    }
  };
  return { path, filter, aggregate };
}

function walkView(schema: DatabaseSchema, view: Partial<ViewDef>, into: Set<string>): void {
  const baseId = tableNamed(schema, String(view.base))?.id;
  if (!baseId) return;
  /* The base is reached too: a text that names another base than the structure beside it is run on the text's. */
  into.add(baseId);
  const walk = walker(schema, baseId, into);
  for (const column of Array.isArray(view.columns) ? view.columns : []) walk.path(column?.path);
  for (const order of Array.isArray(view.orderBy) ? view.orderBy : []) if (!order?.alias) walk.path(order?.path);
  for (const aggregate of Array.isArray(view.aggregates) ? view.aggregates : []) walk.aggregate(aggregate);
  walk.filter(view.filter);
}

function walkBreakdown(schema: DatabaseSchema, def: Partial<BreakdownDef>, into: Set<string>): void {
  const baseId = tableNamed(schema, String(def.base))?.id;
  if (!baseId) return;
  into.add(baseId);
  const walk = walker(schema, baseId, into);
  for (const key of Array.isArray(def.by) ? def.by : []) walk.path(key?.path);
  walk.filter(def.filter);
  for (const measure of Array.isArray(def.measures) ? (def.measures as Measure[]) : []) {
    if (!isRecord(measure)) continue;
    for (const path of measurePaths(measure)) walk.path(path);
    for (const term of [measure, ...(Array.isArray(measure.steps) ? measure.steps.map((step) => step?.term) : [])]) {
      if (isRecord(term)) walk.filter(term.where);
    }
  }
}

/** The base one read names, and with a catalog every table its paths reach. */
function reachedBy(schema: DatabaseSchema | undefined, asked: Asked): string[] {
  const structured = isRecord(asked.def) ? asked.def : isRecord(asked.view) ? asked.view : undefined;
  const base = typeof structured?.base === 'string' ? structured.base : leading(asked.text ?? structured?.text);
  const into = new Set<string>();
  if (schema) {
    if (isRecord(asked.def)) walkBreakdown(schema, asked.def as Partial<BreakdownDef>, into);
    if (isRecord(asked.view)) walkView(schema, asked.view as Partial<ViewDef>, into);
    /* A structured read that carries its text is defined by the text (ViewDef.text), so both are read. `me: null`
       reads a condition on the reader as one that matches no one rather than refusing to parse it. */
    let runBase = typeof structured?.base === 'string' ? structured.base : undefined;
    for (const text of [asked.text, structured?.text]) {
      if (typeof text !== 'string' || !text.trim()) continue;
      const view = textToView(schema, text, { me: null }).view;
      if (view) walkView(schema, view, into);
      if (view && text === asked.text) runBase = view.base;
      const breakdown = textToBreakdown(schema, text, { me: null }).breakdown;
      if (breakdown) walkBreakdown(schema, breakdown, into);
    }
    /* The route parses the query box against the base it runs (the request's text's, when it has one) and merges
       its columns, conditions and orders into the view: each path it walks reaches a table as the view's own do. */
    const baseId = runBase && tableNamed(schema, runBase)?.id;
    if (baseId && typeof asked.query === 'string' && asked.query.trim()) {
      const parsed = parseViewQuery(schema, baseId, asked.query, undefined, { me: null });
      walkView(
        schema,
        { base: baseId, columns: parsed.columns.map((path) => ({ path })), orderBy: parsed.orderBy, filter: parsed.filter },
        into,
      );
    }
  }
  return [base, ...into];
}

/**
 * The tables a `/api/view/run`, `/api/breakdown` or `/api/breakdowns` request reaches, or undefined for any other
 * route. Without the reader's catalog only each read's base can be told; the routes that judge a read always have it.
 */
export function tablesReached(schema: DatabaseSchema | undefined, path: string, body: Record<string, unknown>): string[] | undefined {
  if (path === '/api/view/run') return reachedBy(schema, { view: body.view, text: body.text, query: body.query });
  if (path === '/api/breakdown') return reachedBy(schema, { def: body.def, text: body.text });
  if (path === '/api/breakdowns' && Array.isArray(body.items)) {
    return body.items.flatMap((item) => {
      const given = isRecord(item) ? item : {};
      /* A batched list is a text query (`run.q`), read as a view is. */
      const run = isRecord(given.run) ? given.run : undefined;
      return reachedBy(schema, run ? { text: run.q } : { def: given.def, text: given.text });
    });
  }
  return undefined;
}

/**
 * The first table a read request reaches that `reads` does not declare, or undefined: the rule a page's manifest and a
 * surface hold a request to, and `mistri check` holds a page's literal reads to (app/appPages.ts scanPageSource), so
 * the check refuses what the server would. A request that is not a read reaches nothing here.
 */
export function strayRead(
  schema: DatabaseSchema | undefined,
  reads: readonly string[],
  path: string,
  body: Record<string, unknown>,
): string | undefined {
  const asked = tablesReached(schema, path, body);
  return asked && strayTable(schema, reads, asked);
}

/** The first of `asked` that `reads` does not declare, each named by its catalog id where the catalog has it. */
export function strayTable(schema: DatabaseSchema | undefined, reads: readonly string[], asked: readonly string[]): string | undefined {
  const id = (name: string) => (schema && tableNamed(schema, name)?.id) ?? name;
  const declared = new Set(reads.map(id));
  return asked.find((table) => !declared.has(id(table)));
}
