/**
 * An App's addresses, as the browser writes and reads them: one canonical
 * address per thing on screen.
 *
 * The grammar and the route a table's records take are shared
 * (shared/appAddress.ts): the server's canonical redirect and `mistri
 * check --routes` read the same book. What lives here is the walk's side —
 * which walk entry an address stands for, and which address the entry on
 * screen is — with the App loaded and its schema in hand. It is one module
 * with the list's words below because the two read each other, and the
 * walk's modules read both.
 *
 * The address is the one thing on screen: `/compass/leads/127`, not the walk
 * that reached it. The walk rides in history state (url.js), so Back and the
 * crumbs are unchanged and a shared link is clean. A dashboard says its
 * window as `?period=`, a section's own window as `?period.<section>=`
 * (`?period.lines-moved-by-day=last-7-days`) and its picks by column; a record
 * its id, natural key or slug.
 *
 * A list the App names is written as its view key with its question as
 * address parameters — `/forecourt/vehicles?body_type=Sedan&price=..10000&
 * sort=-price`, `/compass/leads?tab=working&search=stone` — rather than the
 * walk's query text, which carried the table, the view's standing condition
 * and its show clause into every link.
 *
 * Only the view's own filter columns (and its name column's box, `search=`)
 * are named, each in one of four shapes: `make=Toyota`; `make=Toyota,Honda`
 * for one of several; `price=..10000` for at most, `year=2018..` for at
 * least, both for a range. A tab is `tab=<its label as a slug>`, and no tab
 * is the view's first, the one it opens on; the sort is `sort=-price,year`,
 * and no sort is the tab's own. A question that does not fit — a
 * hand-written condition, an `or` the boxes did not write, a column the view
 * does not filter by, a show of the reader's own — is `q=` its text, whole:
 * never a guess that drops a condition.
 */
import { activeApp } from './appState.js';
import { findTable, pageView, quote, state, tableView } from '@mistriwork/kit/client/core.js';
import { isPublicVisitor } from './publicVisitor.js';
import { ownedTails } from '@mistriwork/kit/client/conditions.js';
import { splitQuery } from '@mistriwork/kit/client/clauses.js';
import { canonicalize, squeeze, stripCondition } from '@mistriwork/kit/client/filterbar.js';
import {
  ASSISTANT_PAGE,
  INBOX_PAGE,
  dashPageId,
  dashViewKey,
  formViewKey,
  isListRoom,
  roomPageId,
  viewRoom,
} from '@mistriwork/kit/client/components/appRooms.js';
import {
  litTabFor,
  searchColumn,
  specTabs,
  splitListSpec,
  splitOf,
  tabQuestion,
  visibleQuestion,
  wholeQuery,
  type ListSpec,
} from '@mistriwork/kit/client/components/appListModel.js';
import { andQuery } from '@mistriwork/engine/shared/query.js';
import { TAGS_COLUMN } from '@mistriwork/engine/shared/tagLists.js';
import { filterAddressWord, hasFilterOf } from '@mistriwork/engine/shared/listFilters.js';
import { ALL_TIME, addressFilterValue, addressSortValue, tabKey, tabSlug, tabWord } from '@mistriwork/engine/shared/addressParams.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import {
  INBOX_SEGMENT,
  ASSISTANT_ROOM,
  addressSlug,
  appAddressBook,
  readAppSegments,
  recordSegments,
  type AddressBook,
  type RouteTarget,
} from '../shared/appAddress.js';
import { viewOrder } from '../shared/appModel.js';
import { say } from './copy/public/publicAddress.js';

const NUMBER = /^-?\d+(?:\.\d+)?$/;
const SORT_FIELD = /^([A-Za-z_][\w.]*)(?:\s+(asc|desc))?$/i;

/** A tab's label as an address word: "Hybrid and electric" → "hybrid-and-electric". */
export { tabSlug };

const unquoted = (value: string) => {
  const text = value.trim();
  return /^(["']).*\1$/s.test(text) ? text.slice(1, -1) : text;
};

const literal = (value: string) => (NUMBER.test(value) ? value : String(quote(value)));

/** The name column, whose box is the list's search: the list's own rule (appListModel.ts). */
function nameColumn(spec: ListSpec): string | undefined {
  return searchColumn(findTable(spec.table) as TableMeta | undefined);
}

/** Whether a filter is a whole condition, with no value after it: one of the segments of the rows that point at the record. */
function wholeFilter(name: string): boolean {
  const has = hasFilterOf(name);
  const child = has ? (findTable(has.child) as TableMeta | undefined) : undefined;
  return Boolean(has && child?.segments && Object.hasOwn(child.segments, has.asks));
}

/** The columns an address may name: the list's filter boxes, the name column's box first. */
function addressColumns(spec: ListSpec): string[] {
  const name = nameColumn(spec);
  return [...new Set([...(name ? [name] : []), ...(spec.filters ?? [])])];
}

type Shape = { op: 'eq' | 'in' | 'has' | 'max' | 'min' | 'range' | 'search'; value: string };

/** A box's condition tail in one of the four shapes, or undefined. A rail's
    range is one `between` and says both ends at once. */
function shapeOf(tail: string): Shape | undefined {
  const text = squeeze(tail);
  let m = /^between\s+(-?\d+(?:\.\d+)?)\s+and\s+(-?\d+(?:\.\d+)?)$/i.exec(text);
  if (m) return { op: 'range', value: `${m[1]}..${m[2]}` };
  m = /^=\s*(.+)$/.exec(text);
  if (m) {
    const value = unquoted(m[1]);
    return value.includes(',') ? undefined : { op: 'eq', value };
  }
  m = /^in\s*\((.+)\)$/i.exec(text);
  if (m) {
    const items = m[1].split(',').map((item) => unquoted(item));
    return items.every((item) => item && !item.includes(',')) ? { op: 'in', value: items.join(',') } : undefined;
  }
  /* A record's tags (tagLists.ts): `?tags=bug,docs` is any of them. */
  m = /^has\s*(?:\((.+)\)|(.+))$/i.exec(text);
  if (m) {
    const items = (m[1] ?? m[2]).split(',').map((item) => unquoted(item));
    return items.every((item) => item && !item.includes(',')) ? { op: 'has', value: items.join(',') } : undefined;
  }
  /* The search box writes `contains` on the name column; any other column's
     `contains` is no box's word and is said whole (`q=`). */
  m = /^contains\s+(.+)$/i.exec(text);
  if (m) return { op: 'search', value: unquoted(m[1]) };
  m = /^<=\s*(-?\d+(?:\.\d+)?)$/.exec(text);
  if (m) return { op: 'max', value: m[1] };
  m = /^>=\s*(-?\d+(?:\.\d+)?)$/.exec(text);
  if (m) return { op: 'min', value: m[1] };
  return undefined;
}

/** The one value a column's shapes make, or undefined when they do not combine. */
function paramOf(shapes: Shape[]): string | undefined {
  if (shapes.length === 1 && (shapes[0].op === 'eq' || shapes[0].op === 'in' || shapes[0].op === 'has' || shapes[0].op === 'range'))
    return shapes[0].value;
  if (shapes.some((shape) => shape.op === 'has')) return undefined;
  if (shapes.some((shape) => shape.op === 'range')) return undefined;
  const max = shapes.filter((shape) => shape.op === 'max');
  const min = shapes.filter((shape) => shape.op === 'min');
  if (max.length > 1 || min.length > 1 || max.length + min.length !== shapes.length) return undefined;
  return `${min[0]?.value ?? ''}..${max[0]?.value ?? ''}`;
}

/** A sort clause as the address says it — `sort price desc, year` is
    `-price,year` — '' for none, undefined when it says more than columns
    and their directions. */
function sortParam(clause: string | undefined): string | undefined {
  if (!clause) return '';
  const said = clause
    .replace(/^(?:sort|order\s+by)\s+/i, '')
    .split(',')
    .map((field) => {
      const m = SORT_FIELD.exec(squeeze(field));
      return m ? `${m[2]?.toLowerCase() === 'desc' ? '-' : ''}${m[1]}` : undefined;
    });
  return said.some((field) => !field) ? undefined : said.join(',');
}

type TabQuestion = { label: string; slug: string; query: string; order: string; sort: string | undefined };

/** Each tab's question as the list shows it, its conditions and its order
    apart: Compass's Working tab is `status = working sort created_on desc`,
    and that sort is the tab's own, not a reader's refinement. */
function tabQuestions(spec: ListSpec): TabQuestion[] {
  return specTabs(spec).map((tab, index) => {
    const parts = splitQuery(`${spec.table} ${tabQuestion(spec, index)}`) as { filter: string; sort?: string };
    return {
      label: tab.label,
      slug: tabKey(tab),
      query: squeeze(parts.filter ?? ''),
      order: parts.sort ?? '',
      sort: sortParam(parts.sort),
    };
  });
}

/** The list an entry is, when it is one of the App's list views. */
function specOf(view: string | undefined): ListSpec | undefined {
  const app = activeApp();
  const room = app && view ? viewRoom(app, view) : undefined;
  return room && isListRoom(room) && !room.error ? (room as ListSpec) : undefined;
}

/** The spec whose plumbing a list's query carries: a split's list half is
    asked with its own show and page size once its pick is closed
    (Rooms.tsx), the view's own everywhere else. */
function plumbingOf(spec: ListSpec, query: string): ListSpec {
  if (!splitOf(spec)) return spec;
  const own = splitQuery(`${spec.table} ${visibleQuestion(spec, query)}`) as { show?: string; limit?: string };
  return own.show || own.limit ? splitListSpec(spec) : spec;
}

/**
 * A list's question as address parameters: '' for the view as it opens, the
 * parameters otherwise, undefined when the entry is not one of the App's list
 * views (the caller writes it as ever).
 */
export function listParams(
  entry: { table: string; query: string; view?: string },
  options: { adoptOrder?: boolean } = {},
): string | undefined {
  const view = specOf(entry.view);
  if (!view || view.table !== entry.table) return undefined;
  const spec = plumbingOf(view, entry.query);
  const refinement = visibleQuestion(spec, entry.query);
  if (canonicalize(refinement) === canonicalize(tabQuestion(spec, 0))) return '';
  const parts = splitQuery(`${spec.table} ${refinement}`) as { filter: string; sort?: string; show?: string; limit?: string };
  const whole = new URLSearchParams({ q: refinement }).toString();
  if (parts.show || parts.limit) return whole;
  const tabs = tabQuestions(spec);
  const names = addressColumns(spec);
  const filter = squeeze(parts.filter ?? '');
  const lit = litTabFor(tabs, filter, names);
  if (lit < 0) return whole;
  const tabQuery = tabs[lit].query;
  const owned = (name: string) => Boolean(tabQuery) && ownedTails(tabQuery, name).length > 0;
  const params = new URLSearchParams();
  if (lit > 0) params.set('tab', tabs[lit].slug);
  let residue = filter;
  const naming = names[0] === nameColumn(spec) ? names[0] : undefined;
  for (const name of names) {
    if (owned(name)) continue;
    const tails = ownedTails(filter, name) as string[];
    if (!tails.length) continue;
    // A whole condition (a segment of the rows that point at the record) is a yes.
    if (wholeFilter(name)) {
      if (tails.length !== 1 || tails[0]) return whole;
      params.set(filterAddressWord(name), 'yes');
      residue = stripCondition(residue, name);
      continue;
    }
    const shapes = tails.map(shapeOf);
    if (shapes.some((shape) => !shape)) return whole;
    if (shapes.some((shape) => shape!.op === 'search')) {
      // `search=` is the name column's box alone, one phrase.
      if (name !== naming || shapes.length !== 1) return whole;
      params.set('search', shapes[0]!.value);
      residue = stripCondition(residue, name);
      continue;
    }
    const value = paramOf(shapes as Shape[]);
    if (value === undefined) return whole;
    params.set(filterAddressWord(name), value);
    residue = stripCondition(residue, name);
  }
  /* What is left once the boxes speak must be the tab's own words exactly:
     anything else is a condition the parameters would drop. */
  if (canonicalize(residue) !== canonicalize(tabQuery)) return whole;
  /* The tab's own order goes unsaid and another is `sort=`. A tab that
     sorts, asked unsorted, has no parameter to say so. */
  /* A question the view did not ask itself — a dashboard's drill — has no
     order of its own to keep: it takes the tab's, and is said in the tab's words. */
  const sort = !parts.sort && options.adoptOrder ? tabs[lit].sort : sortParam(parts.sort);
  if (sort === undefined) return whole;
  if (sort !== tabs[lit].sort) {
    if (!sort) return whole;
    params.set('sort', sort);
  }
  return params.toString();
}

/** The question an address's parameters ask of a list, as the reader's refinement text. */
export function addressQuestion(spec: ListSpec, params: URLSearchParams): string {
  const q = params.get('q');
  if (q !== null) return squeeze(q);
  const tabs = tabQuestions(spec);
  // No tab, or one the view no longer has, is the tab the view opens on.
  const tab = tabs.find((candidate) => candidate.slug === params.get('tab')) ?? tabs[0];
  const conditions: string[] = [];
  const naming = nameColumn(spec);
  const search = params.get('search');
  if (naming && search?.trim()) conditions.push(`${naming} contains ${String(quote(search.trim()))}`);
  for (const name of addressColumns(spec)) {
    const raw = params.get(filterAddressWord(name));
    if (wholeFilter(name)) {
      if (raw === 'yes') conditions.push(name);
      continue;
    }
    const parsed = raw === null ? undefined : addressFilterValue(raw);
    if (!parsed) continue;
    if (parsed.kind === 'range') {
      // Both ends are one `between`, the one condition a rail's range reads back.
      if (parsed.min && parsed.max) conditions.push(`${name} between ${parsed.min} and ${parsed.max}`);
      else if (parsed.min) conditions.push(`${name} >= ${parsed.min}`);
      else conditions.push(`${name} <= ${parsed.max}`);
      continue;
    }
    const values = parsed.values;
    // `tags` is a record's tags only where its list filters by them; it is asked with `has`.
    if (name === TAGS_COLUMN) {
      conditions.push(`${name} has ${values.length > 1 ? `(${values.map(literal).join(', ')})` : literal(values[0])}`);
      continue;
    }
    conditions.push(values.length > 1 ? `${name} in (${values.map(literal).join(', ')})` : `${name} = ${literal(values[0])}`);
  }
  // The tab's words as the list writes them, so the tab lights; the boxes after them.
  const where = conditions.length ? andQuery(tab.query, ...conditions) : tab.query;
  const sort = params.get('sort');
  const parsedSort = sort ? addressSortValue(sort) : undefined;
  const order = parsedSort
    ? `sort ${parsedSort.map(({ field, descending }) => (descending ? `${field} desc` : field)).join(', ')}`
    : tab.order;
  return squeeze(`${where} ${order}`);
}

/** A named room uses the same entry as navigation; only lists read filter parameters. */
export function viewEntryFromAddress(
  key: string,
  search: string,
): ReturnType<typeof pageView> | ({ view: string } & ReturnType<typeof tableView>) | null {
  const app = activeApp();
  const spec = app ? viewRoom(app, key) : undefined;
  if (!spec || spec.error) return null;
  if (!isListRoom(spec)) return pageView(roomPageId(spec)!, undefined, undefined, spec.label);
  return { ...tableView(spec.table, wholeQuery(spec, addressQuestion(spec, new URLSearchParams(search)))), view: key };
}

/* ---------- canonical addresses ---------- */

type Entry = {
  kind: 'table' | 'breakdown' | 'row' | 'page';
  table?: string;
  query?: string;
  tab?: string;
  view?: string;
  key?: Record<string, unknown>;
  label?: string;
  pageId?: string;
  rootBody?: string;
  /** A natural key's value, when the route has one and it is known (url.js fills it). */
  address?: string;
};

let held: { app: object; schema: object; book: AddressBook } | undefined;

/** The address book of the App on screen, or undefined outside one. Built once per App payload and schema. */
function addressBook(): AddressBook | undefined {
  const app = activeApp();
  const schema = state.schema as { tables: AddressBook extends { tables: Map<string, infer T> } ? T[] : never } | null;
  if (!app || !schema) return undefined;
  if (held?.app !== app || held.schema !== schema) {
    held = {
      app,
      schema,
      book: appAddressBook({
        views: app.views,
        order: viewOrder(app),
        resources: app.resources,
        pages: app.pages ?? [],
        tables: schema.tables,
        inbox: app.inbox === true,
        assistant: app.assistant?.page === true,
        projected: true,
      }),
    };
  }
  return held.book;
}

/* ---------- dashboards ---------- */

/** A window phrase as an address says it: "last 30 days" → "last-30-days" (dashboardModel's windowSlug). */
const windowSlug = (phrase: string) => phrase.replace(/\s+/g, '-');

/** A dashboard's slot — `last-30-days;owner_id=12` — as its parameters. */
function dashboardParams(body: string | undefined): URLSearchParams {
  const params = new URLSearchParams();
  for (const part of String(body ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) params.set(part.slice(0, eq), part.slice(eq + 1));
    else if (part) params.set('period', part);
  }
  return params;
}

/** The dashboard behind a view key as the walk holds it, its window and picks read from the parameters. */
function dashboardEntry(key: string, search: string, home: boolean): Entry | undefined {
  const app = activeApp();
  const room = app ? viewRoom(app, key) : undefined;
  if (!room || !('sections' in room)) return undefined;
  const params = new URLSearchParams(search);
  /* A dashboard's picks by its filters' columns; a free-form page's place by the parameters it declares. */
  const picks = [...(room.filters ?? []), ...((room as { page?: { params: string[] } }).page?.params ?? [])].flatMap((column) =>
    params.has(column) ? [`${column}=${params.get(column)}`] : [],
  );
  const period = params.get('period');
  /* All time is said only where the dashboard opens on a window of its own (`window:`, shared/addressParams.ts ALL_TIME). */
  const windowed =
    period && (room.windows?.some((phrase) => windowSlug(phrase) === period) || (room.window && period === ALL_TIME)) ? period : '';
  /* A section with windows of its own says its period as `period.<its key>`; one it does not offer is not read. */
  const periods = [...room.sections, ...(room.aside ?? [])].flatMap((section) => {
    const said = section.windowKey ? params.get(`period.${section.windowKey}`) : null;
    return said && section.windows?.some((phrase) => windowSlug(phrase) === said) ? [`period.${section.windowKey}=${said}`] : [];
  });
  const named = [...picks, ...periods];
  const body = [windowed, ...named].filter((part, i) => part || (i === 0 && named.length)).join(';');
  return {
    kind: 'page',
    pageId: dashPageId(key),
    table: undefined,
    label: room.label,
    rootBody: body || undefined,
    ...(home ? { tab: 'home' } : {}),
  };
}

/* ---------- writing ---------- */

/** The key a page entry arrived with and has not resolved yet: `id` or `a=1,b=2`. */
function keyOfBody(body: string | undefined, table: string, book: AddressBook): Record<string, unknown> | undefined {
  if (body === undefined || body === '') return undefined;
  if (body.includes('='))
    return Object.fromEntries(
      body.split(',').map((pair) => {
        const [column, ...rest] = pair.split('=');
        return [column, rest.join('=')];
      }),
    );
  const pk =
    book.tables
      .get(table)
      ?.columns.filter((column) => column.primaryKey)
      .map((column) => column.name) ?? [];
  return pk.length === 1 ? { [pk[0]]: body } : undefined;
}

/** A label that is a record's name, not the placeholder a link arrives with (its key). */
function knownName(entry: Entry): string | undefined {
  const label = entry.label?.trim();
  if (!label || !entry.key) return undefined;
  return Object.values(entry.key).some((value) => String(value) === label) ? undefined : label;
}

/** The list room a view key names, when it is one. */
function listRoom(view: string | undefined): (ListSpec & { id: string }) | undefined {
  const app = activeApp();
  const room = app && view ? viewRoom(app, view) : undefined;
  return room && isListRoom(room) && !room.error ? room : undefined;
}

interface Said {
  segments: string[];
  search?: string;
}

/**
 * The address one walk entry stands for, after the App's id, or undefined
 * when it has none in words — a breakdown, a Workbench tab, a list no view
 * shows — and the caller writes the walk's own form for it. A tenant's
 * address is the same, its selector after these (tenantLink.ts).
 */
function sayEntry(book: AddressBook, entry: Entry): Said | undefined {
  const app = activeApp();
  if (entry.kind === 'table') {
    if (entry.tab && entry.tab !== 'rows' && entry.tab !== 'new') return undefined;
    const tail = entry.tab === 'new' ? ['new'] : [];
    /* A list the App's own view opened, or — a dashboard's drill, a link
       that named only the table — the view its table's records live under:
       the drill becomes that view's filter parameters. */
    const route = book.records.get(entry.table ?? '');
    const own = listRoom(entry.view)?.table === entry.table;
    const view = own ? entry.view : route?.target.kind === 'list' ? route.target.view : undefined;
    if (view && book.views.has(view)) {
      const params = listParams({ table: entry.table!, query: entry.query ?? entry.table!, view }, { adoptOrder: !own });
      if (params === undefined) return undefined;
      return { segments: [encodeURIComponent(book.views.get(view)!), ...tail], search: params };
    }
    /* A table no view shows is its own name, as it opens: the columns the
       grid chose to show are its default, not a question. */
    const asked = (entry.query ?? entry.table ?? '').trim().replace(/\s+show\s+[^]*$/i, '');
    if (route?.target.kind === 'table' && asked === entry.table) {
      return { segments: [encodeURIComponent(route.segment), ...tail] };
    }
    return undefined;
  }
  if (entry.kind === 'row') {
    const split = listRoom(entry.view);
    const via = split && split.table === entry.table && splitOf(split) ? book.views.get(entry.view!) : undefined;
    const segments = recordSegments(book, entry.table!, {
      key: entry.key ?? {},
      natural: entry.address,
      via,
      slug: isPublicVisitor() ? addressSlug(knownName(entry)) : undefined,
      tab: entry.tab ? tabWord(entry.tab) : undefined,
    });
    return segments && { segments };
  }
  if (entry.kind === 'page') {
    if (entry.pageId === INBOX_PAGE) return book.routes.get(INBOX_SEGMENT)?.kind === 'inbox' ? { segments: [INBOX_SEGMENT] } : undefined;
    // The assistant's page, and one conversation on it (`tab` holds its id).
    if (entry.pageId === ASSISTANT_PAGE)
      return book.routes.get(ASSISTANT_ROOM)?.kind === 'assistant'
        ? { segments: [ASSISTANT_ROOM, ...(entry.tab ? [encodeURIComponent(entry.tab)] : [])] }
        : undefined;
    const dash = dashViewKey(entry.pageId);
    if (dash !== undefined && book.views.has(dash)) {
      const params = dashboardParams(entry.rootBody).toString();
      if (entry.tab === 'home' && app?.home === dash) return { segments: [], search: params };
      return { segments: [encodeURIComponent(book.views.get(dash)!)], search: params };
    }
    const form = formViewKey(entry.pageId);
    if (form !== undefined) return book.views.has(form) ? { segments: [encodeURIComponent(book.views.get(form)!)] } : undefined;
    const pageId = entry.pageId ?? '';
    /* A walk read back from its own form names a suggested page by its
       table (`@sales_rep~7`, pageToken), before the page has said its base. */
    const table =
      entry.table ??
      book.pageBase.get(pageId) ??
      (pageId.startsWith('suggested:') ? pageId.slice('suggested:'.length) : book.tables.has(pageId) ? pageId : undefined);
    if (!table) return undefined;
    const key = entry.key ?? keyOfBody(entry.rootBody, table, book);
    /* A second page over its base is said under its own address; the one
       the records open through — or one this browser built — under theirs. */
    const own = book.pages.get(pageId);
    const via = own && book.defaultPage.get(table) !== pageId ? own : undefined;
    if (!key) return own ? { segments: [encodeURIComponent(own)] } : undefined;
    const segments = recordSegments(book, table, {
      key,
      natural: entry.address,
      via,
      slug: isPublicVisitor() ? addressSlug(knownName({ ...entry, key })) : undefined,
      tab: entry.tab ? tabWord(entry.tab) : undefined,
    });
    return segments && { segments };
  }
  return undefined;
}

/**
 * The canonical address of what is on screen — the walk's last entry — or
 * undefined when it has none in words and the caller writes the walk's own
 * form for it (still no `@` for a list, and every such address still opens).
 */
export function appAddress(connection: string, stack: readonly Entry[]): string | undefined {
  const book = addressBook();
  if (!book) return undefined;
  const root = `/${encodeURIComponent(connection)}`;
  const last = stack[stack.length - 1];
  if (!last) return root;
  const said = sayEntry(book, last);
  if (!said) return undefined;
  const path = said.segments.length ? `${root}/${said.segments.join('/')}` : root;
  return said.search ? `${path}?${said.search}` : path;
}

/** A view's own address, `/compass/leads`, as the App on screen says it; undefined for a key it does not open as a room. */
export function viewPath(view: string): string | undefined {
  const book = addressBook(),
    app = activeApp();
  const segment = book?.views.get(view);
  return app && segment ? `/${encodeURIComponent(app.id)}/${encodeURIComponent(segment)}` : undefined;
}

/** Whether a walk entry is a record whose natural key is not known yet. */
export function needsNaturalKey(entry: Entry | undefined): { table: string; column: string } | undefined {
  const book = addressBook();
  if (!book || !entry || entry.address !== undefined || (entry.kind !== 'row' && entry.kind !== 'page') || !entry.key) return undefined;
  const table = entry.table ?? book.pageBase.get(entry.pageId ?? '');
  const column = table ? book.records.get(table)?.column : undefined;
  return table && column ? { table, column } : undefined;
}

/* ---------- reading ---------- */

/** The notifications room as the walk holds it. */
export const inboxEntry = (): Entry => ({ kind: 'page', pageId: INBOX_PAGE, table: undefined, label: say('notifications') });

/** The assistant's page as the walk holds it, on one conversation when `conversation` names it. */
export const assistantEntry = (conversation?: string): Entry => ({
  kind: 'page',
  pageId: ASSISTANT_PAGE,
  table: undefined,
  label: say('assistant'),
  ...(conversation ? { tab: conversation } : {}),
});

const labelFor = (text: string) => (text.length > 24 ? `${text.slice(0, 23)}…` : text);

/** The list a record route stands under, as it opens: the crumb back to it. */
function listEntryFor(target: RouteTarget): Entry[] {
  if (target.kind !== 'list') return [];
  const entry = viewEntryFromAddress(target.view, '');
  return entry ? [entry as Entry] : [];
}

/**
 * An App address read into a walk: `/compass/leads/127` is the leads list
 * as it opens and lead 127 beside or after it. Null for anything that is not
 * an App address — a query-language path, the walk's `@`/`~` forms — which
 * the caller reads the older way and then rewrites to this one.
 */
export function appStackFrom(hash: string): { connection: string; stack: Entry[]; slugged?: boolean } | null {
  const book = addressBook();
  const app = activeApp();
  if (!book || !app) return null;
  const [raw, search = ''] = String(hash ?? '')
    .replace(/^\//, '')
    .split(/\?(.*)/s);
  const segments = raw.split('/').filter(Boolean);
  if (!segments.length) return null;
  let connection: string;
  try {
    connection = decodeURIComponent(segments[0]);
  } catch {
    return null;
  }
  const rest = segments.slice(1);
  if (!rest.length) {
    // The App's root: its landing, or its home dashboard with a window.
    const home = search && app.home ? dashboardEntry(app.home, search, true) : undefined;
    return { connection, stack: home ? [home] : [] };
  }
  const parsed = readAppSegments(book, rest);
  if (!parsed) return null;
  const target = parsed.target;
  if (parsed.kind === 'route') {
    if (target.kind === 'dashboard') {
      const entry = dashboardEntry(target.view, search, false);
      return entry ? { connection, stack: [entry] } : null;
    }
    if (target.kind === 'list' || target.kind === 'form') {
      const entry = viewEntryFromAddress(target.view, target.kind === 'list' ? search : '');
      return entry ? { connection, stack: [entry as Entry] } : null;
    }
    if (target.kind === 'page') return { connection, stack: [{ kind: 'page', pageId: target.page, table: target.table }] };
    if (target.kind === 'inbox') return { connection, stack: [inboxEntry()] };
    if (target.kind === 'assistant') return { connection, stack: [assistantEntry()] };
    return { connection, stack: [tableView(target.table) as Entry] };
  }
  if (parsed.kind === 'conversation') return { connection, stack: [assistantEntry(parsed.id)] };
  if (parsed.kind === 'new') {
    if (target.kind === 'list') {
      const entry = viewEntryFromAddress(target.view, search);
      return entry ? { connection, stack: [{ ...(entry as Entry), tab: 'new' }] } : null;
    }
    return { connection, stack: [tableView(parsed.target.table, parsed.target.table, 'new') as Entry] };
  }
  const shown = Object.values(parsed.key).join(' · ');
  const row: Entry = {
    kind: 'row',
    table: parsed.table,
    key: parsed.key,
    label: labelFor(shown),
    ...(parsed.tab ? { tab: parsed.tab } : {}),
    ...(parsed.natural ? { address: parsed.natural.value } : {}),
  };
  if (target.kind === 'list') {
    const room = listRoom(target.view);
    if (!room || room.table !== parsed.table) return { connection, stack: [row], slugged: parsed.slugged };
    return { connection, stack: [...listEntryFor(target), { ...row, view: target.view }], slugged: parsed.slugged };
  }
  if (target.kind === 'page' && !parsed.natural) {
    return {
      connection,
      stack: [
        {
          kind: 'page',
          pageId: target.page,
          table: parsed.table,
          key: parsed.key,
          label: row.label,
          ...(parsed.tab ? { tab: parsed.tab } : {}),
        },
      ],
      slugged: parsed.slugged,
    };
  }
  return { connection, stack: [row], slugged: parsed.slugged };
}
