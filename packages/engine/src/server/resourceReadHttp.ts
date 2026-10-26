import { ANSI_STYLE, MYSQL_STYLE, POSTGRES_STYLE, type Adapter, type Filter, type SqlStyle } from '../adapters/adapter.js';
import { findTable, type DatabaseSchema, type Order } from '../shared/schema.js';
import type { Condition } from '../shared/filter.js';
import { parseQuery, explain, type QueryPerson } from '../shared/query.js';
import { PathError, explainView, parseViewQuery, type ViewDef } from '../shared/view.js';
import { textToView, viewToTextWithSchema } from '../shared/viewtext.js';
import { breakdownToText, sectionFromText, textToBreakdown } from '../shared/breakdowntext.js';
import { explainBreakdown, type BreakdownDef } from '../shared/breakdown.js';
import type { ResourceHttpPath, ResourceHttpReply } from '../shared/resourceHttp.js';
import {
  readRecords,
  readCount,
  readCounts,
  readView,
  readViewCount,
  readBreakdown,
  ResourceReadError,
  DEFAULT_COUNT_LIMIT,
} from './resourceReadOperations.js';
import { clampLimit, clampOffset, COUNT_EACH_MAX } from '../shared/reads.js';
import { readPageStep } from '../shared/keysetPage.js';
import { recordsPaging, settlePage, viewPaging, type ViewPaging } from './keysetReadHttp.js';

/**
 * A view's count as a plain count, when it is one: every condition names a
 * column of the base itself — no path through a reference, no rollup, no
 * label — so the view's joins and projection cannot change how many rows
 * there are. Null otherwise, and for a condition compared with another column
 * (`on_hand <= reorder_at`): only the view's compiler resolves the right-hand
 * column against the reader's catalog, so a structured count refuses one, and
 * the tab is counted as its list reads it, through the view.
 */
function plainCount(schema: DatabaseSchema, view: ViewDef): { filter?: Filter } | null {
  const base = findTable(schema, view.base);
  if (!base) return null;
  const own = (path: string | undefined) =>
    path === undefined || (!path.includes('.') && !view.computed?.[path] && base.columns.some((column) => column.name === path));
  const groups = view.filter?.groups ?? [];
  if (!groups.every((group) => group.every((condition) => own(condition.path) && condition.other === undefined))) return null;
  return groups.length
    ? {
        filter: {
          groups: groups.map((group) =>
            group.map((condition): Condition => ({
              column: condition.path,
              op: condition.op,
              ...(condition.value === undefined ? {} : { value: condition.value }),
              ...(condition.collation === undefined ? {} : { collation: condition.collation }),
            })),
          ),
        },
      }
    : {};
}

/* What a batched list's page may say: what `/api/run` reads of a first page. */
const RUN_FIELDS = ['q', 'limit', 'offset', 'count', 'exactCount', 'countLimit'] as const;

/** A dashboard is at most a few dozen sections; a batch past this is not one. */
export const BREAKDOWN_BATCH = 48;
/* How many of a batch's breakdowns read at once: the PostgreSQL read pool's
   default size (--read-pool), so a batch never queues behind itself. */
const BREAKDOWN_CONCURRENCY = 4;

/** The furthest a list is paged by offset over HTTP: past it the rows skipped cost more than the page. */
export const MAX_PAGE_OFFSET = 10_000;
/** The routes a list, a view or a breakdown is paged through. */
const PAGED = new Set(['/api/query', '/api/run', '/api/view/run', '/api/breakdown']);

/**
 * What an App's reads are beside the database browser's, given by the App
 * framework (app/appReads.ts) wherever an App is read: absent, a read is the
 * browser's, which shows its SQL and its compiled columns and says a failure
 * in the engine's own words.
 */
export interface AppReads {
  /** The adapter with every read of a union answered by its branches (app/unionReads.ts). */
  reader(adapter: Adapter, schema: DatabaseSchema): Adapter;
  /** A reply as an App is told it: rendering and mutation state, never compiler output (app/appResponses.ts). */
  reply(body: Record<string, unknown>): Record<string, unknown>;
  /** A structured read's failure as an App says it (app/appErrors.ts): never a driver's message. */
  error(err: unknown): unknown;
  /**
   * Who `me` is in `texts`, with the memberships they read, through this
   * request's reader (app/appMe.ts), or nothing where no text compares with
   * the person.
   */
  person(
    me: () => Promise<QueryPerson | null>,
    texts: readonly unknown[],
    schema: DatabaseSchema,
    adapter: Adapter,
  ): Promise<{ me?: QueryPerson | null }>;
}

interface ResourceReadHttpOptions {
  /** An App's reads (AppReads), or none: the database browser's. */
  app: AppReads | undefined;
  now: () => Date;
  /**
   * Who `me` is in this request's text, read from the verified session and
   * asked only when the text says `me` (appMe.ts). Absent — the database
   * browser, a tenant App — `me` is the word it is.
   */
  me?: () => Promise<QueryPerson | null>;
  /**
   * The ISO weekday an App's weeks start on (its `ui.locale`, weekStart.ts),
   * set on every breakdown in place of whatever the request said. Absent —
   * the database browser — a request may say its own, and Monday is the default.
   */
  weekStart?: number;
  /**
   * The most rows `/api/run` answers for a table, where its reader may not
   * export it (dataRoutes.ts, by the product's `exports.may`); undefined is no
   * bound past the ceiling. A list's own read of 100,000 rows was an export
   * by another name.
   */
  rowsMost?: (table: string) => number | undefined;
}

interface ResourceReadHttpReply {
  status: number;
  body: unknown;
}

/**
 * Parse and shape the five resource-read routes using an already-authorized
 * adapter. This owns no source acquisition, response stream or HTTP error class:
 * escaping service validation errors retain their identity for the host to map.
 */
export async function dispatchResourceReadHttp(
  path: string,
  body: Record<string, unknown>,
  adapter: Adapter,
  schema: DatabaseSchema,
  options: ResourceReadHttpOptions,
): Promise<ResourceReadHttpReply | undefined> {
  /* A union's reads are its branches', each through this same reader (unionReads.ts). */
  const app = options.app;
  if (app) adapter = app.reader(adapter, schema);
  const sendData = <Path extends ResourceHttpPath>(_route: Path, value: ResourceHttpReply<NoInfer<Path>, 'db'>) =>
    reply(200, app ? app.reply({ ...value }) : { ...value });
  /* The person is looked up once, and only for text that compares with them. */
  /* An App's weeks start where its locale says, never where a request does. */
  const weekOf = (def: BreakdownDef): BreakdownDef => (options.weekStart === undefined ? def : { ...def, weekStart: options.weekStart });
  /* With the memberships the text reads (`me.group_member.group_id`), through this request's own reader. */
  const personFor = async (...texts: unknown[]): Promise<{ me?: QueryPerson | null }> =>
    options.me && app ? app.person(options.me, texts, schema, adapter) : {};
  /* A page is found by skipping every row before it, so the database walks
     them all: page 80,000 of a sorted list was fifteen seconds on SQLite,
     with the server's one handle held the whole time, and two seconds on
     PostgreSQL. Nobody reads that far by paging; they narrow the list. An
     export reads its own way (exportRoute.ts), and the App API by cursor. */
  /* The query bar's list pages by key (keysetReadHttp.ts): a step after a
     row, before one or from the end costs what the first page does, and the
     offset it carries only names the page. A step the order cannot take —
     no key, a sort through a reference — is an offset again, and meets the
     ceiling below. */
  const step = path === '/api/run' ? readPageStep(body) : undefined;
  if (step === 'invalid') return refusal(400, ['A page starts "after" a row, "before" one, or at the "end": one of the three.']);
  const tooDeep = () =>
    clampOffset(body.offset) > MAX_PAGE_OFFSET
      ? reply(200, {
          errors: [
            {
              message:
                `That page starts past the first ${MAX_PAGE_OFFSET.toLocaleString('en-US')} rows, ` +
                'which is further than a list is paged. Narrow the filter, or sort the other way to reach the end.',
            },
          ],
        })
      : undefined;
  if (PAGED.has(path) && !step) {
    const refused = tooDeep();
    if (refused) return refused;
  }
  if (path === '/api/query') {
    const { result, order } = await readRecords(adapter, schema, {
      table: String(body.table ?? ''),
      filter: body.filter as Filter | undefined,
      columns: Array.isArray(body.columns) ? (body.columns as string[]) : undefined,
      orderBy: body.orderBy as Order[] | undefined,
      limit: body.limit,
      offset: body.offset,
    });
    return sendData(path, { ...result, order });
  }

  /**
   * Parse-and-run, for the query bar.
   *
   * The language lives on the server and only on the server. The client could
   * parse it too, but then there would be two implementations to keep in step
   * and a build step to ship the shared one to the browser. Sending the text
   * and getting back rows, the compiled SQL and any errors costs one round
   * trip and keeps the client a static file.
   */
  if (path === '/api/run') {
    /* `count: 'none'` is for a caller that never shows a total — a dashboard
       tile, a palette search, a lookup, the cards and the calendar — and so
       never pays for one. Anything else unreadable is refused rather than
       read as the default, as /api/view/run refuses it. */
    if (body.count !== undefined && body.count !== 'none' && body.count !== 'exact' && body.count !== 'estimate') {
      return refusal(400, ['count must be "none", "exact" or "estimate".']);
    }
    const text = String(body.q ?? '');
    const person = await personFor(text);
    const parsed = parseQuery(text, { schema, now: options.now(), ...person });

    /* A view is a superset of a query, so the bar can take one.
       `invoice customer_id.name contains Harbour` is not a legal single-table
       query — `customer_id.name` is not a column on invoice — but it is a
       perfectly good view, and refusing it because of which endpoint the text
       arrived at would be an implementation detail leaking into the language.

       The fall-through is deliberately one-way and last. Anything that parses
       cleanly as a query still runs as a query, so no text that works today
       can change meaning; only text that would otherwise have been an error
       gets a second reading. */
    if ((!parsed.query || parsed.errors.length) && adapter.runView) {
      const asView = textToView(schema, text, { id: 'bar', name: '', now: options.now(), ...person });
      if (asView.view && !asView.errors.length) {
        const base = findTable(schema, asView.view.base);
        /* A union pages by offset: its rows have no one key order across branches (unionReads.ts). */
        const paging = base && !base.union ? viewPaging(schema, base, asView.view, step) : undefined;
        if (step && !paging?.continuation) {
          const refused = tooDeep();
          if (refused) return refused;
        }
        const most = options.rowsMost?.(asView.view.base);
        const bounded = most === undefined ? body : { ...body, limit: Math.min(clampLimit(body.limit ?? asView.view.limit), most) };
        return runViewForBar(adapter, schema, asView.view, bounded, app, body.count === 'none' ? 'none' : 'exact', paging);
      }
    }

    if (!parsed.query) return reply(200, { errors: parsed.errors });

    // Errors that would change which rows come back must not be papered over
    // with a partial result — a filter clause that failed to compile would
    // otherwise silently return more rows than asked for.
    if (parsed.errors.length) {
      return sendData(path, { errors: parsed.errors, explain: explain(parsed.query) });
    }

    let q = parsed.query;
    /* An explicit `columns` overrides the query's own `show` clause, matching
       /api/query. Without it the two endpoints disagreed: one honoured the
       field and the other ignored it silently, which is the worst of the
       three options — a caller asking for three columns got all of them and
       no indication why. */
    if (Array.isArray(body.columns) && body.columns.length) {
      const known = new Set(findTable(schema, q.table)?.columns.map((c) => c.name) ?? []);
      const requested = (body.columns as string[]).filter((c) => known.has(c));
      const unknown = (body.columns as string[]).filter((c) => !known.has(c));
      if (unknown.length) {
        return refusal(400, [`No column called "${unknown[0]}" on ${q.table}.`]);
      }
      // A copy: a parse is kept and shared (shared/query.ts), never changed.
      q = { ...q, columns: requested };
    }
    /* An API reports no totals (adapters/http), and counting one would walk
       every page of someone else's rate budget: its lists page by whether a
       full page came back, as a view without a count does. */
    const exact = body.exactCount === true || body.count === 'exact';
    const countMode = schema.dialect === 'http' || body.count === 'none' ? 'none' : exact ? 'exact' : 'estimate';
    /* A filtered total is counted to DEFAULT_COUNT_LIMIT unless the request
       asks for the exact number or names its own bound: past it the list says
       "10,000+" and offers to count exactly. Unfiltered, the catalog's
       estimate or a plain count answers as before. */
    const countLimit = body.countLimit ?? (!exact && q.filter?.groups?.length ? DEFAULT_COUNT_LIMIT : undefined);
    const own = findTable(schema, q.table);
    const most = options.rowsMost?.(own?.id ?? q.table);
    const bounded = (limit: unknown) => (most === undefined ? limit : Math.min(clampLimit(limit), most));
    const paging = own && !own.union ? recordsPaging(own, schema.dialect, q.orderBy, q.columns, q.filter, step) : undefined;
    if (step && !paging?.continuation) {
      const refused = tooDeep();
      if (refused) return refused;
    }
    const {
      result,
      total,
      order,
      request: { limit, offset },
    } = await readRecords(
      adapter,
      schema,
      { ...q, ...(paging?.columns ? { columns: paging.columns } : {}), limit: bounded(body.limit ?? q.limit), offset: body.offset },
      countMode,
      countLimit,
      paging?.continuation,
    );
    const settled = paging ? settlePage(paging.order, paging.extra, result) : undefined;
    return sendData(path, {
      table: q.table,
      ...result,
      ...(settled ? { rows: settled.rows, columns: settled.columns, ...(settled.bounds ? { bounds: settled.bounds } : {}) } : {}),
      ...(paging?.continuation ? { keyset: true as const } : {}),
      ...(total ? { total: total.count, exactTotal: total.exact } : {}),
      // Only when a bounded count stopped: `total` is then the bound, and more match.
      ...(total?.capped ? { cappedTotal: true as const } : {}),
      limit,
      offset,
      order,
      explain: explain(q),
      errors: [] as [],
    });
  }

  /**
   * Several counts in one request: a list's tab badges.
   *
   * Each item is a question in the language, as a tab writes it. Every one
   * that reads a table with a plain filter is counted in one statement where
   * the reader can (readCounts: one conditional aggregate per tab over a
   * small table, one bounded count per tab over a large one), through this
   * request's own reader — the same grants, the same row scope. A tab that
   * needs a view (a path through a reference) is counted as a view. Each is
   * bounded as a list's total is, and a question that does not parse fails
   * alone, in its item.
   */
  if (path === '/api/counts') {
    const items = body.items;
    if (!Array.isArray(items) || !items.length || items.length > COUNT_EACH_MAX || items.some((item) => typeof item !== 'string')) {
      return refusal(400, [`A count batch is a list of 1 to ${COUNT_EACH_MAX} questions.`]);
    }
    const person = await personFor(...items);
    type Counted = { total: number; exactTotal: boolean; cappedTotal?: true } | { errors: Array<{ message: string; at?: number }> };
    const results: Counted[] = Array.from({ length: items.length });
    const plain: Array<{ at: number; table: string; filter?: Filter }> = [];
    const views: Array<Promise<void>> = [];
    for (const [at, text] of (items as string[]).entries()) {
      const parsed = parseQuery(text, { schema, now: options.now(), ...person });
      if (parsed.query && !parsed.errors.length) {
        plain.push({ at, table: parsed.query.table, filter: parsed.query.filter });
        continue;
      }
      const asView = adapter.runView ? textToView(schema, text, { id: 'bar', name: '', now: options.now(), ...person }) : undefined;
      /* A list's tab asks its count in the list's own words, `show` paths
         and all, which only a view reads; but a count reads only the
         conditions. Conditions on the base's own columns are a plain count,
         which is counted with the other tabs in one statement (countEach),
         where a view is a statement of its own. */
      const counted = asView?.view && !asView.errors.length ? plainCount(schema, asView.view) : null;
      if (counted) {
        plain.push({ at, table: asView!.view!.base, ...(counted.filter ? { filter: counted.filter } : {}) });
        continue;
      }
      if (asView?.view && !asView.errors.length) {
        /* A view's own statement, begun now and settled beside the plain
           batch below: their waits overlap instead of adding. */
        const view = asView.view;
        views.push(
          readViewCount(adapter, schema, view, body.countLimit).then((counted) => {
            results[at] = { total: counted.count, exactTotal: true, ...(counted.capped ? { cappedTotal: true as const } : {}) };
          }),
        );
        continue;
      }
      results[at] = { errors: parsed.errors.length ? parsed.errors : [{ message: 'That question does not read as a count.' }] };
    }
    const batch = plain.length
      ? readCounts(adapter, schema, plain, body.countLimit).then((counts) => {
          plain.forEach(({ at }, i) => {
            results[at] = {
              total: counts[i].count,
              exactTotal: counts[i].exact,
              ...(counts[i].capped ? { cappedTotal: true as const } : {}),
            };
          });
        })
      : undefined;
    /* Settled whole, so a failure leaves no read running behind the reply. */
    const settled = await Promise.allSettled(batch ? [...views, batch] : views);
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
    return reply(200, { results });
  }

  /**
   * Several breakdowns in one request: a dashboard's cards, and its lists.
   *
   * A metric asks for its number, its compare window's number and its spark,
   * and every chart and table asks once more, so an eight-card home was about
   * thirty requests queued on one active connection and six browser sockets.
   * Each item is answered by the single-breakdown route below, through this
   * request's own adapter, so it reads exactly what that route would have —
   * the same grant, the same row scope, the same errors — and a failing item
   * fails alone. They run a few at a time: a PostgreSQL or MySQL connection
   * reads through a pool of several, so a filter rail's facets and a
   * dashboard's cards cost the slowest of them rather than their sum; SQLite
   * reads in process, where running them together costs nothing more. The
   * answers keep the request's order.
   */
  if (path === '/api/breakdowns') {
    const items = body.items;
    if (
      !Array.isArray(items) ||
      !items.length ||
      items.length > BREAKDOWN_BATCH ||
      items.some((item) => !item || typeof item !== 'object' || Array.isArray(item))
    ) {
      return refusal(400, [`A breakdown batch is a list of 1 to ${BREAKDOWN_BATCH} breakdowns.`]);
    }
    /* A dashboard's lists ride with its numbers: an item that is `run` is a
       list's first page, answered as `/api/run` answers it. Only the page's
       own fields are passed on, so a batch cannot ask anything the single
       route would not. */
    const run = (item: Record<string, unknown>) =>
      item.run && typeof item.run === 'object' && !Array.isArray(item.run) ? (item.run as Record<string, unknown>) : undefined;
    if ((items as Record<string, unknown>[]).some((item) => 'run' in item && !run(item))) {
      return refusal(400, ['A batched list is `run: { q, limit, offset, count, exactCount, countLimit }`.']);
    }
    const results: ResourceReadHttpReply[] = Array.from({ length: items.length });
    const queue = (items as Record<string, unknown>[]).map((item, at) => ({ item, at }));
    const one = async (): Promise<void> => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const page = run(next.item);
        const { def, text, limit, offset } = next.item;
        try {
          results[next.at] = (await (page
            ? dispatchResourceReadHttp(
                '/api/run',
                Object.fromEntries(RUN_FIELDS.filter((field) => page[field] !== undefined).map((field) => [field, page[field]])),
                adapter,
                schema,
                options,
              )
            : dispatchResourceReadHttp('/api/breakdown', { def, text, limit, offset }, adapter, schema, options)))!;
        } catch (error) {
          /* A request's own refusal (a ResourceReadError: the provider's are
             stripped of the class before they get here) is said in its item.
             Anything else is the host's to map and, in an App, to keep private,
             so it fails the whole request; the client then asks each alone.
             The rest of the batch is not started: its answer is not sent. */
          if (!(error instanceof ResourceReadError)) {
            queue.length = 0;
            throw error;
          }
          results[next.at] = reply(error.status, { error: error.message });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(BREAKDOWN_CONCURRENCY, queue.length) }, one));
    return reply(200, { results });
  }

  /**
   * Run a breakdown: counts and sums, grouped by something.
   *
   * Text in, groups out. The language lives on the server and only on the
   * server — the same rule the query bar and the view composer follow — so
   * the client sends the line somebody typed and gets back the rows, what the
   * columns are, and how many groups there are in total.
   *
   * Errors are a 200 with `errors`, not a 4xx: a half-typed breakdown is the
   * normal state of an input box, and an HTTP error code for it would have
   * the client rendering "request failed" over a message that says which
   * column was misspelled.
   */
  if (path === '/api/breakdown') {
    if (!adapter.runBreakdown) {
      return reply(501, { error: `${schema.dialect} connections cannot group in this build.` });
    }
    /* The structured entry, for page sections: their root filters walk
       dotted paths the text grammar cannot write, so they arrive as the
       BreakdownDef the planner built rather than as text. One that does
       not compile is answered in the language's own error vocabulary —
       the def may also be hand-made, and a hand is a thing that slips. */
    if (body.def && typeof body.def === 'object') {
      const given = weekOf(body.def as BreakdownDef);
      try {
        const {
          breakdown: def,
          result,
          names,
          total,
          offset,
        } = await readBreakdown(adapter, schema, given, { limit: body.limit, offset: body.offset });
        return sendData(path, {
          breakdown: def,
          columns: result.columns,
          resolved: result.resolved,
          rows: result.rows,
          ...(names ? { names } : {}),
          total,
          offset,
          ms: result.ms,
          sql: result.sql,
        });
      } catch (err) {
        // ResourceReadError and the host's former HttpError conversion both
        // receive appError's generic read projection here. Do not promote this
        // structured-entry catch into a new public validation exemption.
        return reply(200, { errors: [app ? app.error(err) : { message: (err as Error).message }] });
      }
    }
    const text = String(body.text ?? '');
    const parsed = textToBreakdown(schema, text, { now: options.now(), ...(await personFor(text)) });
    if (!parsed.breakdown) return reply(200, { errors: parsed.errors });

    /* Handed on as the structure it parsed to, without its text. An App's
       access layer re-reads any text it is given (text is authoritative
       until materialized), and it has no request clock: it read "next 7
       days" on the wall clock in the server's zone, so the filter rail's
       counts asked about another week than its list did. Without the text,
       the def is checked as a structured one, the way `body.def` is above. */
    const { text: _text, ...materialized } = weekOf(parsed.breakdown);
    const {
      breakdown: def,
      result,
      names,
      total,
      offset,
    } = await readBreakdown(adapter, schema, materialized, { limit: body.limit, offset: body.offset });
    return sendData(path, {
      breakdown: def,
      text: breakdownToText(schema, def),
      /* The workbench-to-config bridge: the same line, already shaped as
         a dashboard section for the copy button in the breakdown head. */
      section: sectionFromText(schema, text),
      columns: result.columns,
      resolved: result.resolved,
      rows: result.rows,
      /* Each reference key's groups by the name of the record they are, as a grid names it. */
      ...(names ? { names } : {}),
      total,
      offset,
      ms: result.ms,
      sql: result.sql,
      /* The same statement with its values written in, for the SQL pane.
         `sql` above keeps the parameterised form, which is what actually ran
         and what anything machine-readable should be reading. */
      explain: explainBreakdown(schema, def, styleFor(schema), offset),
    });
  }

  /**
   * Run a multi-table view: the composer's whole back end.
   * The optional query box overrides the supplied definition, but parse errors
   * must never be papered over with a partial result and a broader filter.
   */
  if (path === '/api/view/run') {
    /* Views historically count exactly. Opting out is deliberately explicit:
     * malformed input must refuse rather than quietly skip a caller's count. */
    const countMode = body.count === undefined ? 'exact' : body.count;
    if (countMode !== 'none' && countMode !== 'exact') {
      return refusal(400, ['count must be "none" or "exact".']);
    }
    if (!adapter.runView) {
      return reply(501, { error: `${schema.dialect} connections cannot run views in this build.` });
    }
    let view = normaliseView(body.view);
    let merged = view;
    const person = await personFor(body.text, body.query);
    const errors: Array<{ message: string; at?: number }> = [];
    if (!view.base && typeof body.text !== 'string') {
      return refusal(400, ['A view needs a base table.']);
    }
    /* A view may arrive as text instead of a structure — `work_order show
       reference, customer_id.name as customer count …`. It is the same
       language and the same parser; only the shape of what the client sent
       differs, so it is normalised here and everything below is unchanged. */
    if (typeof body.text === 'string' && body.text.trim()) {
      const parsed = textToView(schema, body.text, { id: view.id, name: view.name, now: options.now(), ...person });
      if (parsed.errors.length || !parsed.view) return reply(200, { errors: parsed.errors });
      view = parsed.view;
      merged = parsed.view;
    }

    if (typeof body.query === 'string' && body.query.trim()) {
      const parsed = parseViewQuery(schema, view.base, body.query, options.now(), person);
      errors.push(...parsed.errors);
      merged = {
        ...view,
        filter: parsed.filter.groups.length ? parsed.filter : view.filter,
        /* A `show` clause in the box overrides the checklist, matching how
           `/api/run` lets an explicit column list win. Silently honouring one
           and ignoring the other is the worst of the three options. */
        columns: parsed.columns.length ? parsed.columns.map((p) => ({ path: p })) : view.columns,
        orderBy: parsed.orderBy.length ? parsed.orderBy : view.orderBy,
        limit: parsed.limit ?? view.limit,
      };
    }
    if (errors.length) return reply(200, { errors });

    try {
      const {
        view: validated,
        result,
        total,
        more,
        limit,
        offset,
      } = await readView(adapter, schema, merged, { limit: body.limit, offset: body.offset }, countMode);
      return sendData(path, {
        view: validated,
        text: viewToTextWithSchema(schema, merged),
        total,
        columns: result.columns,
        resolved: result.resolved,
        joins: result.joins,
        rows: result.rows,
        ms: result.ms,
        sql: result.sql,
        explain: explainView(schema, { ...merged, limit }, styleFor(schema)),
        more,
        limit,
        offset,
        errors: [],
      });
    } catch (err) {
      if (err instanceof PathError) {
        return refusal(400, [err.message]);
      }
      throw err;
    }
  }

  /* `countLimit`, here and on /api/run, bounds the count (countLimitOf): at
     most that many rows are counted, and past it the answer is the bound with
     `capped`. Absent, the count is the one these routes always gave. */
  if (path === '/api/count') {
    const result = await readCount(adapter, schema, {
      table: String(body.table ?? ''),
      filter: body.filter as Filter | undefined,
      exact: body.exactCount === true,
      countLimit: body.countLimit,
    });
    return reply(200, {
      count: result.count,
      exact: result.exact,
      ...(result.capped ? { capped: true as const } : {}),
    } satisfies ResourceHttpReply<'/api/count', 'db'>);
  }

  return undefined;
}

function reply(status: number, body: unknown): ResourceReadHttpReply {
  return { status, body };
}

function refusal(status: number, messages: string[]): ResourceReadHttpReply {
  return reply(status, { error: messages[0], errors: messages.map((message) => ({ message })) });
}

/**
 * Run a view for the query bar, answering in the shape the grid expects.
 *
 * Same keys as `/api/run`'s ordinary answer — `table`, `columns`, `rows`,
 * `total`, `explain` — so the renderer needs no branch. What it gains is
 * `resolved`, which says what each output column actually is; a client that
 * ignores it renders path-named columns as plain text, which is a degradation
 * rather than a break.
 */
async function runViewForBar(
  adapter: Adapter,
  schema: DatabaseSchema,
  view: ViewDef,
  body: Record<string, unknown>,
  app: AppReads | undefined,
  countMode: 'none' | 'exact' = 'exact',
  paging?: ViewPaging,
): Promise<ResourceReadHttpReply> {
  try {
    const {
      view: validated,
      result,
      total,
      limit,
      offset,
    } = await readView(
      adapter,
      schema,
      paging?.view ?? view,
      { limit: body.limit, offset: body.offset },
      countMode,
      undefined,
      paging?.continuation,
    );
    /* A row's value for an order path is under the column that path compiled to. */
    const named = (path: string) => result.resolved?.find((column) => column.path === path)?.name ?? path;
    const settled = paging ? settlePage(paging.order, paging.extra, result, named) : undefined;
    const dropped = new Set(paging?.extra ?? []);
    const value = {
      table: view.base,
      view: validated,
      text: viewToTextWithSchema(schema, view),
      columns: settled?.columns ?? result.columns,
      resolved: dropped.size ? result.resolved?.filter((column) => !dropped.has(column.path)) : result.resolved,
      joins: result.joins,
      rows: settled?.rows ?? result.rows,
      ...(settled?.bounds ? { bounds: settled.bounds } : {}),
      ...(paging?.continuation ? { keyset: true as const } : {}),
      ms: result.ms,
      total,
      limit,
      offset,
      explain: explainView(schema, { ...view, limit }, styleFor(schema)),
      errors: [],
    } satisfies ResourceHttpReply<'/api/run', 'db'>;
    return reply(200, app ? app.reply(value) : value);
  } catch (err) {
    if (err instanceof PathError) return refusal(400, [err.message]);
    throw err;
  }
}

/**
 * Which dialect writes the SQL shown in the explain panel.
 *
 * The adapter picks its own style when it runs the statement; this is the
 * copy the user reads, and it has to agree with what actually ran or the
 * panel is teaching the wrong thing.
 */
export function styleFor(schema: DatabaseSchema): SqlStyle {
  if (schema.dialect === 'postgres') return POSTGRES_STYLE;
  if (schema.dialect === 'mysql') return MYSQL_STYLE;
  return ANSI_STYLE;
}

/**
 * Coerce a JSON body into a `ViewDef`.
 *
 * Shape only. Whether the paths mean anything is `compileView`'s job, and it
 * refuses what it cannot resolve — so this does not need to know the schema,
 * and there is no second, weaker validator to disagree with the first.
 */
export function normaliseView(raw: unknown): ViewDef {
  const v = (raw ?? {}) as Record<string, unknown>;
  const columns = Array.isArray(v.columns) ? v.columns : [];
  const orderBy = Array.isArray(v.orderBy) ? v.orderBy : [];
  return {
    id: String(v.id ?? ''),
    name: String(v.name ?? ''),
    base: String(v.base ?? '').trim(),
    columns: columns
      .map((c) =>
        typeof c === 'string'
          ? { path: c }
          : { path: String((c as { path?: unknown })?.path ?? ''), alias: (c as { alias?: string })?.alias },
      )
      .filter((c) => c.path),
    aggregates: Array.isArray(v.aggregates) ? (v.aggregates as ViewDef['aggregates']) : undefined,
    filter: (v.filter ?? undefined) as ViewDef['filter'],
    orderBy: orderBy
      .map((o) => {
        const entry = o as { path?: unknown; direction?: unknown; near?: unknown };
        return {
          path: String(entry?.path ?? ''),
          direction: entry?.direction === 'desc' ? ('desc' as const) : ('asc' as const),
          /* A similar list's closest-first order. Only a number passes here,
             and the compiler refuses one that is not finite and safe. */
          ...(typeof entry?.near === 'number' ? { near: entry.near } : {}),
        };
      })
      .filter((o) => o.path),
    limit: typeof v.limit === 'number' ? v.limit : undefined,
  };
}
