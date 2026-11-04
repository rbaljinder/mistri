/**
 * `query-invalid`: the database's own verdict on the reads an App's pages would make.
 *
 * Validation judges the definition against the catalog; only the database knows whether the SQL the planner writes
 * from it is acceptable. A grouped related list once emitted a column name PostgreSQL read as ambiguous, and the page
 * said "This list could not be read" the first time anyone opened a record — `check` passed. This step plans every
 * section of every page as the page route does (planPageSections), builds the adapter the App runs on over the same
 * resources, and has each read EXPLAINed instead of executed: the lists, related lists (grouped and totalled), timelines,
 * breakdowns, charts, figures and rollups they ask for.
 *
 * Read-only by construction: the statements are the compiler's own SELECTs, handed to the adapter's `explainSql` (plain
 * EXPLAIN inside a READ ONLY transaction on PostgreSQL, EXPLAIN QUERY PLAN on the read handle of SQLite), never the
 * analysing form. One EXPLAIN is made for each distinct statement, however many sections ask it. Key values are
 * placeholders of the column's own type, so a uuid key is not refused for being a number; a refusal of a value
 * (SQLSTATE class 22) is that placeholder's and is not reported.
 */
import { ANSI_STYLE, type Adapter, type BreakdownResult, type ViewResult } from '@mistriwork/engine/adapters/adapter.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { compileBreakdown, compileBreakdownCount } from '@mistriwork/engine/shared/breakdown.js';
import { POSTGRES_STYLE } from '@mistriwork/engine/shared/filter.js';
import { resolveOf, validatePage, type OfKeys, type PageDef } from '@mistriwork/engine/shared/page.js';
import { pageAbouts, sectionReading, type PageSection } from '@mistriwork/engine/shared/pageModel.js';
import { planPageSections } from '@mistriwork/engine/shared/pagePlans.js';
import { columnKind, tableNamed, type ColumnMeta, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { compileView, compileViewCount } from '@mistriwork/engine/shared/view.js';
import { homeSourceOf, withRollups, type AppDef } from '../../shared/app.js';
import { textToView } from '@mistriwork/engine/shared/viewtext.js';
import { textToBreakdown } from '@mistriwork/engine/shared/breakdowntext.js';
import { appListQuery, groupedQuestion, type ListQuestionSpec, type ListRules } from '@mistriwork/engine/shared/listQuestion.js';
import { DEFAULT_LIMIT } from '@mistriwork/engine/shared/reads.js';
import type { RoomPlan } from '@mistriwork/engine/server/http/firstPaint.js';
import { findTable } from '@mistriwork/engine/shared/schema.js';
import { isFormView } from '../../shared/appModel.js';
import { servedApp } from '../../shared/appPayload.js';
import { dashboardReads } from '../http/firstPaintRooms.js';
import { loadAppRuntimeResources } from '../app/appRuntimeResources.js';

interface QueryFailure {
  /** `page:section`, as the section is named on its page. */
  at: string;
  /** Where in the App definition. */
  path: string;
  /** What the database said. */
  message: string;
}

/** A value of the column's own type for a placeholder: compiled and planned, never matched against a row. */
function placeholder(column: ColumnMeta): string | number {
  switch (columnKind(column.type)) {
    case 'number':
      return 1;
    case 'date':
      return '2000-01-01';
    default:
      return /uuid/i.test(column.type) ? '00000000-0000-4000-8000-000000000000' : 'x';
  }
}
const placeholders = (table: TableMeta) => Object.fromEntries(table.columns.map((column) => [column.name, placeholder(column)]));

/** The label of a section on its page: its title, else its kind and place. */
const sectionName = (section: PageSection, index: number) =>
  'title' in section && section.title ? section.title : `${section.kind}[${index}]`;

/**
 * The adapter, answering every read by planning it. Writes and everything else go to the real one untouched; the
 * reads the page makes are the four a view or a breakdown asks, each compiled exactly as the adapter compiles it.
 */
function planningAdapter(real: Adapter, catalog: DatabaseSchema, explain: (text: string, params: unknown[]) => Promise<void>): Adapter {
  /* The catalog the connection was opened with, which is what the adapter compiles against. */
  const schema = async () => catalog;
  const style = real.dialect === 'postgres' ? POSTGRES_STYLE : ANSI_STYLE;
  const reads = {
    async runView(view: Parameters<NonNullable<Adapter['runView']>>[0], offset = 0): Promise<ViewResult> {
      const compiled = compileView(await schema(), view, style, offset);
      await explain(compiled.text, compiled.params);
      return {
        columns: compiled.columns.map((column) => column.name),
        rows: [],
        ms: 0,
        sql: { text: compiled.text, params: compiled.params },
        resolved: compiled.columns,
        joins: compiled.joins,
      };
    },
    async countView(view: Parameters<NonNullable<Adapter['countView']>>[0], limit?: number): Promise<number> {
      const compiled = compileViewCount(await schema(), view, style, undefined, limit);
      await explain(compiled.text, compiled.params);
      return 0;
    },
    async runBreakdown(breakdown: Parameters<NonNullable<Adapter['runBreakdown']>>[0], offset = 0): Promise<BreakdownResult> {
      const compiled = compileBreakdown(await schema(), breakdown, style, offset);
      await explain(compiled.text, compiled.params);
      return {
        columns: compiled.columns.map((column) => column.name),
        rows: [],
        ms: 0,
        sql: { text: compiled.text, params: compiled.params },
        resolved: compiled.columns,
      };
    },
    async countBreakdown(breakdown: Parameters<NonNullable<Adapter['countBreakdown']>>[0], limit?: number): Promise<number> {
      const compiled = compileBreakdownCount(await schema(), breakdown, style, undefined, limit);
      await explain(compiled.text, compiled.params);
      return 0;
    },
  };
  return new Proxy(real, {
    get(target, property) {
      if (property in reads) return reads[property as keyof typeof reads];
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** The registry, opening every connection as the planning adapter over it. */
function planningRegistry(registry: Registry, explain: (adapter: Adapter) => (text: string, params: unknown[]) => Promise<void>): Registry {
  return new Proxy(registry, {
    get(target, property) {
      if (property === 'open')
        return async (id: string) => {
          const opened = await target.open(id);
          return { ...opened, adapter: planningAdapter(opened.adapter, opened.schema, explain(opened.adapter)) };
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** A refusal that is about a parameter, which this run only has a placeholder for: a value of the wrong form (SQLSTATE
 * class 22) or a parameter whose type the text leaves open (42P18). The statement is skipped and counted, never failed. */
const aboutTheValue = (error: unknown) => /^(22|42P18)/.test(String((error as { code?: unknown })?.code ?? ''));

/**
 * Every read the App's pages make, planned by the database. `undefined` when there is no database to ask (the
 * connection is not configured); a thrown error is the caller's to say as a skipped step.
 */
export async function pageQueryFailures(
  registry: Registry,
  app: AppDef,
  pages: readonly PageDef[],
  connection: string,
): Promise<{ failures: QueryFailure[]; statements: number; skipped: number; sections: number }> {
  let location: { at: string; path: string } | undefined;
  const failures: QueryFailure[] = [];
  /* One EXPLAIN a statement; the answer is kept so a second section asking the same thing is not a second round trip. */
  const answered = new Map<string, string | undefined>();
  const skipped = new Set<string>();
  const explainOn = (adapter: Adapter) => async (text: string, params: unknown[]) => {
    if (!adapter.explainSql || !location) return;
    let message = answered.get(text);
    if (!answered.has(text)) {
      try {
        await adapter.explainSql({ text, params });
        message = undefined;
      } catch (error) {
        if (aboutTheValue(error)) skipped.add(text);
        message = aboutTheValue(error) ? undefined : (error as Error).message;
      }
      answered.set(text, message);
    }
    if (message !== undefined && !failures.some((each) => each.at === location!.at && each.message === message))
      failures.push({ ...location, message });
  };
  const resources = await loadAppRuntimeResources(planningRegistry(registry, explainOn), app, connection);
  const schema = withRollups(app, resources.schema);
  const reader = resources.adapter;
  let sections = 0;
  /* A read the compiler itself refuses (a column that is not there) is validation's to say, with its own code. */
  const ask = async (run: () => Promise<unknown> | undefined) => {
    try {
      await run();
    } catch {
      /* said by validation */
    }
  };
  const view = async (each: Parameters<NonNullable<Adapter['runView']>>[0] | undefined) => {
    if (!each) return;
    await ask(() => reader.runView?.(each, 0));
    await ask(() => reader.countView?.(each));
  };
  const breakdown = async (each: Parameters<NonNullable<Adapter['runBreakdown']>>[0] | undefined) => {
    if (!each) return;
    await ask(() => reader.runBreakdown?.(each, 0));
    await ask(() => reader.countBreakdown?.(each));
  };
  for (const raw of pages) {
    const page = validatePage(schema, raw);
    const base = page.error ? undefined : tableNamed(schema, page.base);
    if (!base) continue;
    const key = placeholders(base);
    const ofKeys: OfKeys = {};
    for (const about of pageAbouts(page)) {
      const of = resolveOf(schema, page.base, about);
      if (of.error || !of.fk || !of.table) continue;
      ofKeys[about] = placeholders(of.table);
    }
    const plans = planPageSections(schema, page, key, ofKeys, new Date('2000-01-01T00:00:00Z'), key);
    for (const plan of plans) {
      const section = page.sections[plan.index];
      location = { at: `${page.id}:${sectionName(section, plan.index)}`, path: `pages.${page.id}.sections[${plan.index}]` };
      if (sectionReading(section, 'rows')) sections++;
      switch (plan.kind) {
        case 'breakdown':
        case 'chart':
          await breakdown(plan.breakdown);
          break;
        case 'timeline':
          for (const stream of plan.streams) {
            await view(stream.view);
            await view(stream.side?.view);
          }
          break;
        case 'custom':
          for (const read of Object.values(plan.reads)) await view(read.view);
          for (const total of Object.values(plan.aggregates)) await breakdown(total.breakdown);
          break;
        case 'list':
        case 'metric':
          if ('view' in plan) {
            await view(plan.view);
            await breakdown(plan.totals);
            await breakdown(plan.groups);
            await breakdown(plan.breakdown);
          }
          break;
        default:
          break;
      }
    }
  }
  /* The rooms of the App's own views: each list tab (grouped and sorted as the room asks it), each dashboard figure in every
     window it can be over, and each named segment. They are read as the first paint reads them (firstPaintRooms.ts). */
  const now = new Date('2000-01-01T00:00:00Z');
  const text = async (view_: string, at: string, path: string, q: string, limit?: number, countOnly = false) => {
    location = { at: `${view_}${at}`, path };
    const parsed = textToView(schema, q, { id: 'check', name: '', now });
    if (!parsed.view || parsed.errors.length) return;
    /* A condition is asked of the rows it counts: the columns the room would show are its list's, planned there. */
    if (countOnly) await ask(() => reader.countView?.(parsed.view!));
    else await view(limit ? { ...parsed.view, limit } : parsed.view);
  };
  const payload = servedApp(app, schema, pages);
  const rules: ListRules = { schema, resources: payload.resources };
  for (const [key, raw] of Object.entries(payload.views)) {
    const room = raw as unknown as ListQuestionSpec & { error?: string; sections?: unknown; presentation?: { kind?: string } };
    if (room.error || isFormView(room as never)) continue;
    if (Array.isArray(room.sections)) {
      /* Each period a windowed section can be over, the first of every section together, then the second, and so on. */
      const all = [...room.sections, ...((room as { aside?: unknown[] }).aside ?? [])] as Array<{ windows?: string[]; windowKey?: string }>;
      const deepest = Math.max(1, ...all.map((section) => section.windows?.length ?? 0));
      for (let step = 0; step < deepest; step++) {
        const periods: Record<string, string> = {};
        for (const section of all)
          if (section.windowKey && section.windows?.length)
            periods[section.windowKey] = section.windows[Math.min(step, section.windows.length - 1)];
        const plan: RoomPlan = { reads: [], batches: [] };
        dashboardReads(
          { app: app.id, path: '', search: '', payload, schema, pages: {}, me: {}, visitor: false },
          rules,
          key,
          plan,
          periods,
        );
        for (const batch of plan.batches)
          for (const item of batch.items) {
            const sent = item.sent as { text?: string; limit?: number; run?: { q?: string; limit?: number } };
            const name = `dashboard:${key}`;
            if (sent.run?.q) await text(name, '', `views.${key}`, sent.run.q, sent.run.limit);
            else if (sent.text) {
              location = { at: name, path: `views.${key}` };
              const parsed = textToBreakdown(schema, sent.text, { now });
              if (parsed.breakdown) await breakdown(sent.limit ? { ...parsed.breakdown, limit: sent.limit } : parsed.breakdown);
            }
          }
      }
      continue;
    }
    if (!room.table || !findTable(schema, room.table)) continue;
    const kind = room.presentation?.kind;
    /* A board, calendar, tree, gantt or split asks otherwise (and its tabs the same): the list's own are the grid's and cards'. */
    if (kind === 'board' || kind === 'calendar' || kind === 'tree' || kind === 'gantt' || kind === 'split') continue;
    const tabs = room.tabs?.length ? room.tabs : [{ label: '' }];
    for (let index = 0; index < tabs.length; index++) {
      const q = appListQuery(rules, room, index);
      await text(
        `list:${key}`,
        room.tabs?.length ? `[${tabs[index].label}]` : '',
        `views.${key}${room.tabs?.length ? `.tabs[${index}]` : ''}`,
        room.group ? groupedQuestion(q, room.group) : q,
        DEFAULT_LIMIT,
      );
    }
  }
  for (const [table, resource] of Object.entries(app.resources ?? {}))
    for (const [name, segment] of Object.entries(resource.segments ?? {}))
      await text(`segment:${table}.${name}`, '', `resources.${table}.segments.${name}`, `${table} ${segment.query}`, 1, true);
  return { failures, statements: answered.size - skipped.size, skipped: skipped.size, sections };
}

/** The connection an App reads, as the indexes step finds it. */
export function appConnection(registry: Registry, app: AppDef) {
  const bound = app.connection ?? (app.sources ? app.sources[homeSourceOf(app)!]?.connection : undefined);
  return bound ? registry.list().find((c) => c.id === bound || c.name === bound) : registry.list().find((c) => c.id === registry.active);
}
