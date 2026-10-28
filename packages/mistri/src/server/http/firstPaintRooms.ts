/**
 * What the first room of an address asks, as the client will ask it
 * (firstPaint.ts carries the answers). Each request is built by the rule the
 * client's own room builds it by, shared where one lives (shared/): a list's
 * question (listQuestion.ts), an address's reading (appAddress.ts), a record
 * page's compose (recordReads.ts). A room this does not know — a board, a
 * calendar, a split — or an address it cannot read — a search, a filter, a
 * sort, a natural key — asks nothing here, and the client asks as it always
 * did. A request built here that the client builds another way is only an
 * answer nobody takes: the page is correct either way, and
 * e2e/first-paint.spec.ts holds the sample Apps to asking nothing.
 */
import { menuCount, type CountedMachine } from '@mistriwork/engine/shared/menuCounts.js';
import { findTable, labelPath, primaryKey, referencesFrom, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { PaintRooms, RoomBatch, RoomPlan, RoomRead } from '@mistriwork/engine/server/http/firstPaint.js';
import type { AppPayloadApp } from '../../shared/appPayload.js';
import { appAddressBook, readAppSegments } from '../../shared/appAddress.js';
import { isFormView, viewOrder } from '../../shared/appModel.js';
import { tabKey } from '@mistriwork/engine/shared/addressParams.js';
import { appListQuery, referenceNames, type ListQuestionSpec, type ListRules } from '@mistriwork/engine/shared/listQuestion.js';
import { DEFAULT_LIMIT, NAV_COUNT_LIMIT } from '@mistriwork/engine/shared/reads.js';
import { RECORD_COMPOSE_PATH } from '@mistriwork/engine/shared/recordReads.js';
import type { PageDef } from '@mistriwork/engine/shared/page.js';
import { andQuery, quoteValue } from '@mistriwork/engine/shared/query.js';
import {
  boardCountText,
  breakdownText,
  chartLimit,
  dashboardListQuery,
  groupsAskedFor,
  measureText,
  pickQuery,
  sectionPeriod,
  windowed,
  type AskLookups,
  type AskedSection,
} from '@mistriwork/engine/shared/dashboardAsks.js';
import { sparkText } from '@mistriwork/engine/shared/dashboardTrend.js';
import { autoKeyOf } from '@mistriwork/engine/shared/autoBucket.js';
import { funnelText } from '@mistriwork/engine/shared/funnel.js';

/** What the page's boot answers gave, as the client holds them. */
export interface RoomInput {
  app: string;
  /** The inside address (shared/mount.ts) and its query string. */
  path: string;
  search: string;
  payload: AppPayloadApp;
  schema: DatabaseSchema;
  pages: { pages?: Array<PageDef & { error?: string }> };
  filters?: { filters?: Record<string, Array<{ name: string; query: string }>>; store?: unknown };
  me: Record<string, unknown>;
  /** Browsing signed out, within `auth.public`. */
  visitor: boolean;
}

const squeeze = (text: string): string => text.replace(/\s+/g, ' ').trim();

/* The page sizes a reader has not changed (client core.js pageSize, relatedRows.ts). */
const RELATED_ROWS = 10;

type ListView = ListQuestionSpec & { error?: string; countQuery?: string; presentation?: { kind?: string } };

/** The list room a view key names, as the client's rooms read it (appRooms.ts): neither a dashboard nor a form. */
function listView(payload: AppPayloadApp, key: string): ListView | undefined {
  const view = Object.hasOwn(payload.views, key) ? (payload.views[key] as object) : undefined;
  if (!view || 'sections' in view || isFormView(view)) return undefined;
  return (view as ListView).error ? undefined : (view as ListView);
}

export function roomReads(input: RoomInput): RoomPlan {
  const plan: RoomPlan = { reads: [], batches: [] };
  const { payload, schema } = input;
  const rules: ListRules = { schema, resources: payload.resources };
  menuCounts(input, plan);
  const segments = input.path.split('/').filter(Boolean).slice(1);
  /* The App's root is its home (client Content.tsx): a list as it opens, or a dashboard as it opens. */
  if (!segments.length) {
    const home = payload.home;
    if (home === undefined) return plan;
    if (listView(payload, home)) listReads(input, rules, home, plan, true);
    else if (!input.search) dashboardReads(input, rules, home, plan);
    return plan;
  }
  const parsed = readRoom(input, segments);
  if (!parsed) return plan;
  if (parsed.kind === 'route' && parsed.target.kind === 'list') listReads(input, rules, parsed.target.view, plan);
  if (parsed.kind === 'route' && parsed.target.kind === 'dashboard' && !input.search)
    dashboardReads(input, rules, parsed.target.view, plan);
  if (parsed.kind === 'record' && !parsed.natural) recordReads(input, parsed, plan);
  return plan;
}

/** What an address's segments past the App open, read as the client's rooms read them (appAddress.ts). */
function readRoom(input: RoomInput, segments: string[]) {
  return readAppSegments(addressBookOf(input), segments);
}

/* The address book is every view, page and table of the App, claimed in order, and a page's first reads asked for it
   twice (its room, and a natural key's) on every page load: on a large App a tenth of a first page's CPU. It is a pure
   function of the views, resources and pages the reader is served, the catalog's tables and the menu's order, and a
   reader's projection hands the same frozen objects to every request that projects the same (tenantMetadata.ts): so
   it is made once per those objects, by identity, and read only. A handful are kept per views object, as many as the
   shapes that share it. */
type AddressBook = ReturnType<typeof appAddressBook>;
interface KeptBook {
  readonly resources: object;
  readonly pages: object | undefined;
  readonly tables: object;
  readonly order: string;
  readonly inbox: boolean;
  readonly assistant: boolean;
  readonly book: AddressBook;
}
const BOOKS_KEPT = 8;
const addressBooks = new WeakMap<object, KeptBook[]>();
function addressBookOf(input: RoomInput): AddressBook {
  const { payload, schema } = input;
  const order = viewOrder(payload);
  const said = {
    resources: payload.resources,
    pages: payload.pages,
    tables: schema.tables,
    order: order.join('\0'),
    inbox: payload.inbox === true,
    assistant: payload.assistant?.page === true,
  };
  /* Only what cannot change is kept by: a payload built afresh, or not frozen, is read afresh. */
  const lasting = [payload.views, payload.resources, payload.pages ?? Object.freeze([]), schema.tables].every((part) =>
    Object.isFrozen(part),
  );
  let kept = lasting ? addressBooks.get(payload.views) : [];
  if (!kept) addressBooks.set(payload.views, (kept = []));
  const found = kept.find(
    (book) =>
      book.resources === said.resources &&
      book.pages === said.pages &&
      book.tables === said.tables &&
      book.order === said.order &&
      book.inbox === said.inbox &&
      book.assistant === said.assistant,
  );
  if (found) return found.book;
  const book = appAddressBook({
    views: payload.views as never,
    order,
    resources: payload.resources,
    pages: payload.pages ?? [],
    tables: schema.tables,
    inbox: said.inbox,
    assistant: said.assistant,
    projected: true,
  });
  kept.push({ ...said, book });
  if (kept.length > BOOKS_KEPT) kept.shift();
  return book;
}

/**
 * A record its natural key addresses (`/shop/products/SKU-1049`), which `roomReads` leaves to the client: its crumb
 * and the read that finds it by that key, as the client asks them (url.js, client Rooms.tsx `NaturalKeyRoom`), and,
 * once that read has answered with the one row, the record's own reads by its primary key, as the room asks them
 * when the walk has moved to it. For a host that can ask in two steps (a tenant App's boot, shared/tenantBoot.ts);
 * none where the address is not a natural key's.
 */
export function naturalRecordReads(input: RoomInput): { reads: RoomRead[]; find: RoomRead; found(answer: unknown): RoomPlan } | undefined {
  const segments = input.path.split('/').filter(Boolean).slice(1);
  const parsed = segments.length ? readRoom(input, segments) : undefined;
  if (!parsed || parsed.kind !== 'record' || !parsed.natural) return undefined;
  const table = findTable(input.schema, parsed.table);
  if (!table) return undefined;
  const pk = primaryKey(table);
  if (!pk.length) return undefined;
  const { natural } = parsed;
  return {
    reads: parsed.target.kind === 'page' ? [] : [crumb(input, table, parsed.key)],
    find: {
      method: 'POST',
      target: '/api/query',
      body: {
        app: input.app,
        table: table.id,
        filter: { groups: [[{ column: natural.column, op: '=', value: natural.value }]] },
        limit: 2,
        offset: 0,
      },
    },
    found(answer) {
      const plan: RoomPlan = { reads: [], batches: [] };
      const rows = (answer as { rows?: unknown } | undefined)?.rows;
      // One row or none: two would be no key at all (Rooms.tsx).
      if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object') return plan;
      const row = rows[0] as Record<string, unknown>;
      if (pk.some((column) => row[column] === undefined)) return plan;
      const key = Object.fromEntries(pk.map((column) => [column, row[column]])) as Record<string, string>;
      recordReads(input, { ...parsed, key, natural: undefined }, plan, false);
      return plan;
    },
  };
}

/**
 * The menu's counts (client components/navCounts.ts): each list the menu
 * names, what it stands for counted up to the bound. Asked as one batch,
 * answered item by item: which rows ask depends on what is on screen — a
 * phone draws no menu, a folded group asks nothing — which only the client knows.
 */
function menuCounts(input: RoomInput, plan: RoomPlan): void {
  const { payload, schema } = input;
  if (!(payload.ui as { shell?: { counts?: boolean } } | undefined)?.shell?.counts) return;
  const resources = (payload as { resources?: Record<string, { machine?: CountedMachine }> }).resources;
  const items = new Map<string, unknown>();
  const walk = (nodes: AppPayloadApp['nav']): void => {
    for (const node of nodes) {
      if ('group' in node) {
        walk(node.children);
        continue;
      }
      if ('to' in node) continue;
      const view = listView(payload, node.view);
      const table = view ? findTable(schema, view.table) : undefined;
      if (!view || !table || table.isView || (table as { countable?: false }).countable === false) continue;
      const condition = view.countQuery ?? view.query ?? '';
      // Only a list of work is counted, as the menu counts it (shared/menuCounts.ts).
      if (!menuCount(condition, resources?.[view.table]?.machine, (view as { count?: boolean }).count, table.segments).counted) continue;
      const q = condition ? `${table.id} ${condition}` : table.id;
      items.set(q, { q, countLimit: NAV_COUNT_LIMIT });
    }
  };
  walk(payload.nav);
  if (!items.size) return;
  plan.batches.push({
    path: '/api/counts',
    kind: 'count',
    body: { countLimit: NAV_COUNT_LIMIT },
    items: [...items].map(([q, key]) => ({ key, sent: q })),
  });
}

/**
 * A list's first page and its tabs' counts (client components/TableRoom.tsx,
 * AppList.tsx), for the list as it opens or on one of its tabs. Anything
 * else the address says — a search, a filter, a sort — the client reads
 * into its question (publicAddress.ts) and asks itself.
 */
function listReads(input: RoomInput, rules: ListRules, key: string, plan: RoomPlan, home = false): void {
  const view = listView(input.payload, key);
  const kind = view?.presentation?.kind;
  if (!view || kind === 'board' || kind === 'calendar' || kind === 'tree' || kind === 'gantt' || kind === 'split') return;
  const params = new URLSearchParams(input.search);
  /* The home list opens on its first tab, whatever the address carries. */
  if (home ? input.search : [...params.keys()].some((name) => name !== 'tab')) return;
  const tabs = view.tabs?.length ? view.tabs : [];
  const asked = params.get('tab');
  const found = asked === null ? 0 : tabs.findIndex((tab) => tabKey(tab) === asked);
  const index = found < 0 ? 0 : found;
  const q = appListQuery(rules, view, index);
  plan.reads.push({ method: 'POST', target: '/api/run', body: { q, limit: DEFAULT_LIMIT, offset: 0, exactCount: false, app: input.app } });
  /* The tab badges not on screen, and the reader's saved views of this list. */
  const saved = input.visitor ? [] : (input.filters?.filters?.[key] ?? []);
  const yours = Array.isArray(saved) ? saved.filter((item) => item && typeof item.query === 'string') : [];
  if (tabs.length <= 1 && !yours.length) return;
  const items = [
    ...new Set([
      ...(tabs.length ? tabs : [{ label: '' }]).flatMap((_, i) => (i === index ? [] : [appListQuery(rules, view, i)])),
      ...yours.map((item) => squeeze(`${view.table} ${item.query}`)),
    ]),
  ].sort();
  if (items.length) plan.reads.push({ method: 'POST', target: '/api/counts', body: { items, app: input.app } });
}

/**
 * A record's first page: the crumb's name (client url.js resolveLabels) and
 * the page's compose (client recordCompose.ts), whose answers the page's
 * sections take.
 */
function recordReads(
  input: RoomInput,
  parsed: Extract<ReturnType<typeof readAppSegments>, { kind: 'record' }>,
  plan: RoomPlan,
  /* A natural key's crumb was asked by that key, before the walk moved to the primary one. */
  withCrumb = true,
): void {
  const table = findTable(input.schema, parsed.table);
  if (!table) return;
  const key = parsed.key;
  const scoped = (target: string) => `${target}${target.includes('?') ? '&' : '?'}${new URLSearchParams({ app: input.app })}`;
  const target = parsed.target;
  /* An address that names a page opens it, and its crumb is the page's; a record opens through the page its table's records use (client page.js). */
  const pageId = target.kind === 'page' ? target.page : recordPage(input, table);
  if (target.kind !== 'page' && withCrumb) plan.reads.push(crumb(input, table, key));
  if (pageId.startsWith('suggested:'))
    plan.reads.push({ method: 'GET', target: scoped(`/api/pages/suggested?${new URLSearchParams({ table: table.id })}`) });
  plan.reads.push({
    method: 'POST',
    target: RECORD_COMPOSE_PATH,
    body: { app: input.app, page: pageId, key, rows: RELATED_ROWS, ...(parsed.tab === undefined ? {} : { tab: parsed.tab }) },
  });
}

/** Which page a table's records open as (client page.js): the one its resource names, else the first over it, else its suggested page. */
function recordPage(input: RoomInput, table: TableMeta): string {
  // A document is a verb on its record, never the page it opens as (appDocuments.ts).
  const pages = (input.pages.pages ?? []).filter((page) => page.base === table.id && !page.document);
  const named = Object.hasOwn(input.payload.resources, table.id) ? input.payload.resources[table.id].page : undefined;
  const chosen = (named && pages.find((page) => page.id === named)) || pages[0];
  return chosen && !chosen.error ? chosen.id : `suggested:${table.id}`;
}

/** The record's name for its crumb (client url.js): a joined or computed name is read as a view, a column of its own as a row. */
function crumb(input: RoomInput, table: TableMeta, key: Record<string, string>): RoomRead {
  const resource = Object.hasOwn(input.payload.resources, table.id) ? input.payload.resources[table.id] : undefined;
  const path = labelPath(input.schema, table, resource?.recordLabel);
  if (path && (path.includes('.') || path.startsWith('$'))) {
    return {
      method: 'POST',
      target: '/api/view/run',
      body: {
        app: input.app,
        view: {
          id: `crumb:${table.id}`,
          name: table.name,
          base: table.id,
          columns: [...new Set([...primaryKey(table), path])].map((column) => ({ path: column })),
          filter: { groups: [Object.entries(key).map(([column, value]) => ({ path: column, op: '=', value }))] },
          limit: 1,
        },
      },
    };
  }
  return {
    method: 'POST',
    target: '/api/query',
    body: {
      app: input.app,
      table: table.id,
      filter: { groups: [Object.entries(key).map(([column, value]) => ({ column, op: '=', value }))] },
      limit: 1,
      offset: 0,
    },
  };
}

/** The schema as a dashboard's asks read it (shared/dashboardAsks.ts), over the schema the page was answered with.
    The assistant's table blocks are checked by the same asks (assistant/assistantTools.ts). */
export const lookupsOf = (rules: ListRules): AskLookups => ({
  table: (id) => findTable(rules.schema, id),
  references: (id) => referencesFrom(rules.schema, id),
  referenceNames: (tableId, names) => referenceNames(rules, tableId, names),
  naming: (table) =>
    labelPath(rules.schema, table, Object.hasOwn(rules.resources, table.id) ? rules.resources[table.id].recordLabel : undefined),
});

type DashboardView = { sections: AskedSection[]; aside?: AskedSection[]; filters?: string[]; window?: string };

/**
 * A dashboard as it opens — on the window it declares (`window:`) or none,
 * no pick, each section on its own first period (client components/Dashboard.tsx) — its sections' figures,
 * groups and first rows, and its picks' choices. Each is one item of the
 * batch the sections are asked in (breakdownBatch.ts), answered by itself:
 * which sections share a batch is the paint's affair. A section drawn by
 * code of the App's own, a feed, or rows that wait on a count ask
 * themselves; so does a whole dashboard with a first run, whose sections
 * wait on it.
 */
function dashboardReads(input: RoomInput, rules: ListRules, key: string, plan: RoomPlan): void {
  const view = Object.hasOwn(input.payload.views, key) ? (input.payload.views[key] as unknown as DashboardView) : undefined;
  if (!view || !Array.isArray(view.sections)) return;
  const all = [...view.sections, ...(view.aside ?? [])];
  if (all.some((section) => section.kind === 'firstRun')) return;
  const items = new Map<string, RoomBatch['items'][number]>();
  const breakdown = (text: string | null, limit?: number) => {
    if (!text) return;
    const item = { text, ...(limit ? { limit } : {}) };
    items.set(JSON.stringify(item), { key: item, sent: item });
  };
  const run = (ask: Record<string, unknown>) => {
    const item = { run: ask };
    items.set(JSON.stringify(item), { key: item, sent: item, kind: 'run' });
  };
  for (const column of view.filters ?? []) {
    const q = pickQuery(lookupsOf(rules), all, column);
    if (q) run({ q, limit: 50, offset: 0, count: 'none' });
  }
  for (const [placed, sections] of [
    ['main', view.sections],
    ['aside', view.aside ?? []],
  ] as const) {
    for (const raw of sections) {
      if (raw.error) continue;
      const section = raw.windows?.length ? windowed(raw, sectionPeriod(raw, {})) : windowed(raw, view.window ?? null);
      if (section.kind === 'metric') {
        breakdown(measureText(section, section.query), 1);
        if (section.compare) breakdown(measureText(section, section.compare), 1);
        breakdown(sparkText(section));
      } else if (section.kind === 'breakdown') breakdown(breakdownText(section, groupsAskedFor(section)));
      /* An `auto` chart asks in a unit the browser picks from the window and the data (autoBucket.ts): there is no
         question to answer before it has. */
      else if (section.kind === 'chart') {
        if (!autoKeyOf(section.by)) breakdown(breakdownText(section, chartLimit(section)));
      } else if (section.kind === 'funnel') breakdown(funnelText(section));
      else if (section.kind === 'matrix') breakdown(breakdownText(section, 400));
      else if (section.kind === 'board') {
        const lanes = section.lanes?.length
          ? andQuery(section.query, section.lanes.map((value) => `${section.by} = ${quoteValue(value)}`).join(' or '))
          : section.query;
        breakdown(boardCountText({ ...section, query: lanes }));
      } else if (section.kind === 'rows') dashboardList(input, rules, section, placed === 'aside', run);
    }
  }
  if (items.size)
    plan.batches.push({
      path: '/api/breakdowns',
      kind: 'breakdown',
      items: [...items.values()],
      unwrap: (result) => {
        const said = result as { status?: unknown; body?: unknown } | undefined;
        return typeof said?.status === 'number' && said.status < 400 ? said.body : undefined;
      },
    });
}

/** A dashboard list's first rows (client Dashboard.tsx, List): names in the aside, the embedded grid elsewhere. */
function dashboardList(
  input: RoomInput,
  rules: ListRules,
  section: AskedSection,
  aside: boolean,
  run: (ask: Record<string, unknown>) => void,
): void {
  if (!section.table || !findTable(input.schema, section.table)) return;
  const source = section.view !== undefined ? listView(input.payload, section.view) : undefined;
  const own = source && source.table === section.table ? source : undefined;
  /* An embed that works as its room asks as its room does. */
  if ((section as { interactive?: true }).interactive && own) return;
  const { query } = dashboardListQuery(lookupsOf(rules), section, own?.presentation as never);
  const presented = own?.presentation && own.presentation.kind !== 'split';
  const limit = section.limit ?? 5;
  if (aside && !presented && (section.show?.length ?? 0) <= 3) run({ q: query, limit, offset: 0 });
  else run({ q: query, limit, offset: 0, exactCount: false });
}

/* A public form's address, its status check and its account screen; the landing (clientSurface.ts). */
const FORM = /^\/([^/@~]+)\/form\/([a-z0-9][a-z0-9-]{0,63})(?:\/(?:status|claim))?\/?$/;
const WELCOME = /^\/[^/@~]+\/welcome\/?$/;

/** Consult deployment metadata before even invoking firstPaint for this page. */
export function placedPublicFormPage(path: string, isPlacedForm: ((form: string) => boolean) | undefined): boolean {
  const form = FORM.exec(path);
  return !!form && isPlacedForm?.(form[2]) === true;
}

/**
 * An App's first page (http/firstPaint.ts `PaintRooms`): a public form and
 * the landing are all their page reads, asked before who-am-I (boot.js);
 * any other page asks, once who-am-I and the runtime name the App, what the
 * shell asks of it and then what its first room asks (`roomReads`).
 */
export const APP_PAINT_ROOMS: PaintRooms = {
  alone(path) {
    const form = FORM.exec(path);
    if (form) return [{ method: 'GET', target: `/api/forms/${encodeURIComponent(form[2])}` }];
    if (WELCOME.test(path)) return [{ method: 'GET', target: '/api/landing' }];
    return undefined;
  },
  async room({ path, search, requested, me, runtime, ask }) {
    if (me.tenant === true) return undefined;
    const visitor = me.signedIn !== true && me.public === true;
    /* Signed out of an App that signs people in, and not browsing it: the sign-in screen, or the App's public home, draws. */
    if (me.signedIn !== true && me.signIn && !visitor) return undefined;
    if (runtime.appConfigured !== true || !Array.isArray(runtime.apps)) return undefined;
    const selected = requested ?? (typeof runtime.active === 'string' ? runtime.active : undefined);
    if (!selected || !runtime.apps.some((app) => (app as { id?: unknown } | null)?.id === selected)) return undefined;
    const scoped = (route: string) => `${route}?${new URLSearchParams({ app: selected })}`;
    /* As the shell asks them once the runtime has named the App (app.js boot):
       together. A visitor browsing signed out keeps no saved views, and is not asked for them (myViews.ts). */
    const [payload, pages, schema, filters] = await Promise.all([
      ask('GET', scoped('/api/app')),
      ask('GET', scoped('/api/pages')),
      ask('GET', scoped('/api/schema')),
      visitor ? undefined : ask('GET', scoped('/api/filters')),
    ]);
    const app = payload as { app?: unknown; appId?: unknown } | undefined;
    if (!app?.app || app.appId !== selected || !schema || !pages) return undefined;
    const plan: RoomPlan = roomReads({
      app: selected,
      path,
      search,
      payload: app.app as RoomInput['payload'],
      schema: schema as RoomInput['schema'],
      pages: pages as RoomInput['pages'],
      filters: filters as RoomInput['filters'],
      me,
      visitor,
    });
    return { app: selected, plan };
  },
};
