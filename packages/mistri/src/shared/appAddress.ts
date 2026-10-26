/**
 * An App's addresses: one canonical URI per thing it shows.
 *
 * A record is `/{app}/{route}/{id}` — `/compass/leads/127` — where the route
 * is the view that shows its table, so following a reference from a lead to
 * its account opens `/compass/accounts/13`, the account's own address, not a
 * path that grows with every hop. The walk that got there rides in history
 * state (client url.js), so Back and the crumbs still know it, and a link
 * pasted into chat is the record alone.
 *
 * The route a table's records are addressed through is decided once, here,
 * the same way for the client, the server and `mistri check`, over the
 * views the person reading is served — so a resident's repair is
 * `/my-requests/12` and the office's the same record at `/repairs/12`:
 *
 *   1. the resource's `view`, when it names one of the list views over it
 *      that this reader is served — a preference, passed over quietly for a
 *      person whose role is not served that view;
 *   2. else the first list view over the table in the menu's order that has
 *      no standing query and is not a split — the plain list of them — then
 *      the first without a standing query, then the first;
 *   3. else the page its records open through, by its `path` or key;
 *   4. else the table's own name.
 *
 * A view's route is its `path`, or its key; a page's likewise. Dashboards,
 * free-form pages and forms are their route alone. What the room on screen is showing
 * rides the address's parameters (client publicAddress.ts writes and reads
 * them; `mistri check --routes` lists each one a route reads):
 *
 *   list       `tab=` (a tab's label as a word; none is the first), `search=`
 *              (the name column's box), one per filter column
 *              (`make=Toyota`, `make=Toyota,Honda`, `price=..10000`,
 *              `year=2018..`), `sort=-price,year`, and `q=` for a question
 *              those cannot say, whole
 *   dashboard  `period=` (one of its windows, as a word; `all-time` where it
 *              opens on a `window` of its own), one per pick column
 *              (`owner_id=12`), and `period.<section>=` for a section with
 *              windows of its own, the section named by its title
 *   free-form  the parameters its `definePage` declares (`params: ['list',
 *   page       'line']` → `?list=12&line=3`), and nothing else
 *
 * A parameter a route does not offer is not read: a link naming a window or
 * a column the view no longer has lands on the view as it opens.
 *
 * The id segment is the primary key's value, or — where the resource says
 * `address: '<column>'` — that column's (a natural key the check proves NOT
 * NULL and unique). Composite keys are said under their parent where one of
 * their two columns is a reference to it (`/orders/12/lines/3`), otherwise
 * by name (`order_id=12,line=3`). A slug (`slug: true`) follows a numeric id
 * on a public page — `/forecourt/vehicles/1-2021-toyota-corolla` — and only
 * the leading id is read back, so any spelling of the rest finds the record.
 *
 * Values stay text end to end: an id past 2^53 is a string from the adapter
 * and a string here, never run through Number().
 *
 * Pure and dependency-light on purpose: the server's canonical redirect,
 * the check's route table and the browser's address bar must never disagree
 * about what an address means.
 */
import { filterAddressWord } from '@mistriwork/engine/shared/listFilters.js';
import { slug as slugOf } from '@mistriwork/engine/shared/slug.js';
import { tabKey } from '@mistriwork/engine/shared/addressParams.js';
import { SERVER_SEGMENTS } from '@mistriwork/engine/shared/mount.js';
import { ASSISTANT_ROOM } from '@mistriwork/engine/shared/servedApp.js';
export { ASSISTANT_ROOM } from '@mistriwork/engine/shared/servedApp.js';

/** Words an App route may not take: `new` is the New form's, the rest the server's own (mount.ts). */
export const RESERVED_PATHS: readonly string[] = ['new', ...SERVER_SEGMENTS, '_components', 'sign-in', 'welcome', 'form'];

/** The signed-in person's notifications, in an App that keeps an inbox (appNotify.ts). */
export const INBOX_SEGMENT = 'notifications';

/** One route segment as an author spells it in `path:`: the letters a view key allows. */
const ROUTE_PATH = /^[a-z0-9][a-z0-9-]{0,63}$/;

interface ColumnLike {
  name: string;
  primaryKey: boolean;
  references?: { table: string; column: string };
}
interface TableLike {
  id: string;
  name: string;
  columns: readonly ColumnLike[];
}
interface ViewLike {
  table?: string;
  path?: string;
  query?: string;
  presentation?: { kind?: string };
  sections?: unknown;
  command?: unknown;
}

export interface AddressBookInput {
  /** The App's views by key: a list names its `table`, a dashboard has `sections`, a form a `command`. */
  views: Readonly<Record<string, ViewLike>>;
  /** View keys in the menu's order (viewOrder): which list is a table's first. */
  order: readonly string[];
  /** What each resource says about its addresses, by resolved table id. */
  resources: Readonly<Record<string, { view?: string; address?: string; slug?: boolean }>>;
  /** The App's pages in load order — the first over a base is the one its records open through. */
  pages: readonly { id: string; base: string; path?: string; document?: unknown }[];
  tables: readonly TableLike[];
  /** The App keeps an inbox, whose room is `/{app}/notifications`. */
  inbox?: boolean;
  /** The assistant has a page of its own, `/{app}/assistant`, for the person served (appPayload.ts). */
  assistant?: boolean;
  /** The views are what one person is served, not the whole App's: a resource's `view` naming one they are not
   * served is that person's to pass over, not a problem (the whole App's book still says a misnamed one). */
  projected?: boolean;
}

/** What a route's segment names. */
export type RouteTarget =
  | {
      kind: 'list';
      view: string;
      table: string;
      /** The words of the tabs after the first, which is the list as it opens (`?tab=decided`). */
      tabs?: string[];
      /** The filter columns it is refined by (`?make=Toyota`). */
      filters?: string[];
    }
  | {
      kind: 'dashboard';
      view: string;
      /** The dashboard offers windows of its own (`?period=`). */
      window?: true;
      /** The columns its picks are said by (`?owner_id=12`). */
      picks?: string[];
      /** Sections with windows of their own, by the name each rides the address under (`?period.<name>=`). */
      periods?: string[];
      /** A free-form page (`definePage`), drawn as a dashboard of its one component. */
      freeForm?: true;
      /** A free-form page's parameters it keeps its place in (`?list=12&line=3`). */
      params?: string[];
    }
  | { kind: 'form'; view: string }
  | { kind: 'page'; page: string; table: string }
  | { kind: 'table'; table: string }
  | { kind: 'inbox' }
  | { kind: 'assistant' };

/** How one table's records are addressed. */
interface RecordRoute {
  segment: string;
  table: string;
  target: RouteTarget;
  /** The natural key column (`address:`), when the resource names one. */
  column?: string;
  /** A cosmetic slug follows a numeric id on public pages. */
  slug?: true;
  /** A two-column key one of whose columns references its parent: said under the parent's address. */
  parent?: { column: string; table: string; child: string };
}

export interface AddressBook {
  /** Segment → what it names. */
  routes: Map<string, RouteTarget>;
  /** View key → its segment. */
  views: Map<string, string>;
  /** Page id → its segment, where it has one of its own. */
  pages: Map<string, string>;
  /** Page id → its base table. */
  pageBase: Map<string, string>;
  /** Table id → the page its records open through. */
  defaultPage: Map<string, string>;
  /** Table id → how its records are addressed. */
  records: Map<string, RecordRoute>;
  tables: Map<string, TableLike>;
  /** Collisions and misnamed routes, for the check and the shell's count. */
  problems: string[];
}

/** An authored `path:` — one route segment, not a reserved word — or a refusal that names the fix. */
export function parseRoutePath(value: unknown, at: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !ROUTE_PATH.test(value)) {
    throw new Error(`${at}: "path" must be one address segment — lowercase letters, digits and hyphens, like "sales-dashboard".`);
  }
  if (RESERVED_PATHS.includes(value)) throw new Error(`${at}: "path" cannot be "${value}"; ${RESERVED_PATHS.join(', ')} are reserved.`);
  return value;
}

const isDashboard = (view: ViewLike) => Object.hasOwn(view, 'sections');
const words = (value: unknown): string[] => (Array.isArray(value) ? value.filter((word): word is string => typeof word === 'string') : []);
/* What a dashboard's address may say beyond its route: its window, its picks,
   each windowed section's own window — or, for a free-form page, the place it keeps. */
function parametersOf(
  view: ViewLike & { aside?: unknown; windows?: unknown; filters?: unknown; page?: { params?: unknown } },
): Omit<Extract<RouteTarget, { kind: 'dashboard' }>, 'kind' | 'view'> {
  if (view.page) {
    const params = words(view.page.params);
    return { freeForm: true as const, ...(params.length ? { params } : {}) };
  }
  const periods = [view.sections, view.aside]
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .flatMap((section: { windowKey?: unknown }) => (typeof section?.windowKey === 'string' ? [section.windowKey] : []));
  const picks = words(view.filters);
  return {
    ...(words(view.windows).length ? { window: true as const } : {}),
    ...(picks.length ? { picks } : {}),
    ...(periods.length ? { periods } : {}),
  };
}
/** A list's parameters as the route table says them: its tabs by their words, and its filter columns. */
function listParametersOf(
  view: ViewLike & { tabs?: unknown; filters?: unknown },
): Omit<Extract<RouteTarget, { kind: 'list' }>, 'kind' | 'view' | 'table'> {
  const tabs = (Array.isArray(view.tabs) ? view.tabs : [])
    .slice(1)
    .flatMap((tab: { label?: unknown; slug?: string }) =>
      typeof tab?.label === 'string' && tabKey({ label: tab.label, slug: tab.slug }) ? [tabKey({ label: tab.label, slug: tab.slug })] : [],
    );
  // Each by its address word: a `has` filter's is `has.<table>.<column>` (listFilters.ts).
  const filters = words(view.filters).map(filterAddressWord);
  return { ...(tabs.length ? { tabs } : {}), ...(filters.length ? { filters } : {}) };
}
const isForm = (view: ViewLike) => Object.hasOwn(view, 'command');
const isList = (view: ViewLike | undefined): view is ViewLike & { table: string } =>
  Boolean(view && !isDashboard(view) && !isForm(view) && typeof view.table === 'string');

const describe = (target: RouteTarget): string => {
  switch (target.kind) {
    case 'list':
      return `the list view "${target.view}"`;
    case 'dashboard':
      return target.freeForm ? `the free-form page "${target.view}"` : `the dashboard "${target.view}"`;
    case 'form':
      return `the form "${target.view}"`;
    case 'page':
      return `the page "${target.page}"`;
    case 'inbox':
      return 'the notifications inbox';
    case 'assistant':
      return "the assistant's page";
    default:
      return `the table "${target.table}"`;
  }
};

const primaryKeyOf = (table: TableLike | undefined): string[] =>
  table ? table.columns.filter((c) => c.primaryKey).map((c) => c.name) : [];

/** Every route the App answers to, and how each table's records are addressed. */
export function appAddressBook(input: AddressBookInput): AddressBook {
  const book: AddressBook = {
    routes: new Map(),
    views: new Map(),
    pages: new Map(),
    pageBase: new Map(),
    defaultPage: new Map(),
    records: new Map(),
    tables: new Map(input.tables.map((table) => [table.id, table])),
    problems: [],
  };
  const reserved = new Set(RESERVED_PATHS);
  /* Claimed in a fixed order — views in the menu's, then pages, then the
     tables nothing else shows — so which of two claimants a collision keeps
     never depends on object key order. */
  const claim = (segment: string, target: RouteTarget, what: string, said: boolean): boolean => {
    if (reserved.has(segment)) {
      if (said) book.problems.push(`${what}: its address "${segment}" is reserved (${RESERVED_PATHS.join(', ')}). Give it another "path".`);
      return false;
    }

    const held = book.routes.get(segment);
    if (held) {
      if (said)
        book.problems.push(
          `${what}: its address "/${segment}" is already ${describe(held)}'s. Two routes cannot share a path; give one of them another "path".`,
        );
      return false;
    }
    book.routes.set(segment, target);
    return true;
  };
  /* Claimed first: an App that keeps an inbox has it at one address in
     every App, and a view that would take the word is told to take another. */
  if (input.inbox) book.routes.set(INBOX_SEGMENT, { kind: 'inbox' });
  if (input.assistant) book.routes.set(ASSISTANT_ROOM, { kind: 'assistant' });

  for (const key of input.order) {
    const view = input.views[key];
    if (!view) continue;
    const target: RouteTarget | undefined = isDashboard(view)
      ? { kind: 'dashboard', view: key, ...parametersOf(view) }
      : isForm(view)
        ? { kind: 'form', view: key }
        : isList(view)
          ? { kind: 'list', view: key, table: view.table, ...listParametersOf(view) }
          : undefined;
    if (!target) continue;
    const segment = view.path ?? key;
    // A key is always said: a view is its address, and a collision there is the author's to resolve.
    if (claim(segment, target, `views "${key}"`, true)) book.views.set(key, segment);
  }
  const listed = new Set([...book.views.keys()].flatMap((key) => (isList(input.views[key]) ? [input.views[key].table] : [])));
  for (const page of input.pages) {
    /* A document is said under its record (`/orders/12/invoice`, appDocuments.ts): no route, and never the page a
       record opens through. */
    if (page.document !== undefined) continue;
    book.pageBase.set(page.id, page.base);
    const first = !book.defaultPage.has(page.base);
    if (first) book.defaultPage.set(page.base, page.id);
    const segment = page.path ?? page.id;
    /* A page answers to its own address only where it needs one: its `path`
       is written, its base has no list to be addressed through, or it is a
       second page over the base. Otherwise `/compass/lead` stays what it
       always was — the lead table, read the older way — and the lead page's
       records are `/compass/leads/127`. A key a view already answers to is
       no collision the author made; a `path` they wrote is theirs, and said. */
    if (page.path === undefined && (!ROUTE_PATH.test(segment) || (first && listed.has(page.base)))) continue;
    if (claim(segment, { kind: 'page', page: page.id, table: page.base }, `pages "${page.id}"`, page.path !== undefined))
      book.pages.set(page.id, segment);
  }

  for (const table of input.tables) {
    const resource = Object.hasOwn(input.resources, table.id) ? input.resources[table.id] : undefined;
    const lists = input.order.filter((key) => book.views.has(key) && isList(input.views[key]) && input.views[key].table === table.id);
    let view: string | undefined;
    if (resource?.view !== undefined) {
      if (lists.includes(resource.view)) view = resource.view;
      else if (input.projected && !Object.hasOwn(input.views, resource.view)) view = undefined;
      else
        book.problems.push(
          `resources "${table.name}": "view" names "${resource.view}", which is not a list view over "${table.name}". It names the view its records are addressed through.`,
        );
    }
    view ??=
      lists.find((key) => !input.views[key].query && input.views[key].presentation?.kind !== 'split') ??
      lists.find((key) => !input.views[key].query) ??
      lists[0];
    let route: RecordRoute | undefined;
    if (view) route = { segment: book.views.get(view)!, table: table.id, target: { kind: 'list', view, table: table.id } };
    const page = book.defaultPage.get(table.id);
    if (!route && page && book.pages.has(page))
      route = { segment: book.pages.get(page)!, table: table.id, target: { kind: 'page', page, table: table.id } };
    if (!route) {
      const target: RouteTarget = { kind: 'table', table: table.id };
      // Only a resource the App declares is the author's to be told about.
      if (claim(table.id, target, `resources "${table.name}"`, Boolean(resource))) route = { segment: table.id, table: table.id, target };
    }
    if (!route) continue;
    if (resource?.address !== undefined) {
      if (table.columns.some((column) => column.name === resource.address)) route.column = resource.address;
      else
        book.problems.push(`resources "${table.name}": "address" names "${resource.address}", which is not a column of "${table.name}".`);
    }
    if (resource?.slug) route.slug = true;
    book.records.set(table.id, route);
  }

  /* Second pass: a parent must itself have an address said by its primary
     key, or the child's could not be written before the parent's name is
     known. */
  for (const route of book.records.values()) {
    if (route.column) continue;
    const key = book.tables.get(route.table)!.columns.filter((column) => column.primaryKey);
    if (key.length !== 2) continue;
    for (const [i, column] of key.entries()) {
      const reference = column.references;
      if (!reference || reference.table === route.table) continue;
      const parent = book.records.get(reference.table);
      const parentKey = primaryKeyOf(book.tables.get(reference.table));
      if (!parent || parent.column || parentKey.length !== 1 || parentKey[0] !== reference.column) continue;
      route.parent = { column: column.name, table: reference.table, child: key[1 - i].name };
      break;
    }
  }
  return book;
}

/* ---------- ids ---------- */

/* The walk's own form spells a page `@page~id`, a list `view:query` and a
   New form `!new`: an App address escapes those marks inside a value, so a
   raw one in a segment always means the older form (readAppSegments). */
const encode = (value: unknown) =>
  encodeURIComponent(String(value)).replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const OLDER_MARKS = /[@~!:]/;

/** A key named column by column: `order_id=12,line=3`, each value escaped so a `,` or `=` in one is data. */
function namedKey(key: Readonly<Record<string, unknown>>, columns: readonly string[]): string | undefined {
  if (!columns.length || columns.some((column) => key[column] === undefined || key[column] === null)) return undefined;
  return columns.map((column) => `${column}=${encode(key[column])}`).join(',');
}

/** The text a record's name becomes after its id: "2021 Toyota Corolla" → "2021-toyota-corolla". */
export function addressSlug(label: string | undefined): string {
  return label ? slugOf(label, '') : '';
}

interface RecordAddress {
  /** The record's key: its primary key, as the walk holds it. */
  key: Readonly<Record<string, unknown>>;
  /** The natural key's value, when the route has one and it is known. */
  natural?: unknown;
  /** The record's name, for a slug where the route takes one. */
  slug?: string;
  /** The tab open on it, as its word. */
  tab?: string;
  /** The segment to say it under, when not the table's own: a split's, a second page's. */
  via?: string;
}

/**
 * A record's address after the App's id: `['leads', '127']`. Undefined when
 * the table has no route, or the key is incomplete — the caller writes the
 * walk's own form then. A natural-key route whose value is not known yet is
 * said by its primary key, named (`id=12`), which reads back without doubt.
 */
export function recordSegments(book: AddressBook, table: string, at: RecordAddress): string[] | undefined {
  const route = book.records.get(table);
  if (!route) return undefined;
  const pk = primaryKeyOf(book.tables.get(table));
  if (!pk.length) return undefined;
  const tab = at.tab ? [encode(at.tab)] : [];
  const segment = encode(at.via ?? route.segment);
  if (route.column) {
    if (
      at.natural !== undefined &&
      at.natural !== null &&
      String(at.natural) !== '' &&
      !String(at.natural).includes('=') &&
      String(at.natural) !== 'new'
    ) {
      return [segment, encode(at.natural), ...tab];
    }
    const named = namedKey(at.key, pk);
    return named ? [segment, named, ...tab] : undefined;
  }
  if (route.parent && at.via === undefined) {
    const parent = book.records.get(route.parent.table)!;
    const up = at.key[route.parent.column],
      down = at.key[route.parent.child];
    if (up !== undefined && up !== null && down !== undefined && down !== null) {
      return [encode(parent.segment), single(up), segment, single(down), ...tab];
    }
  }
  if (pk.length === 1) {
    const value = at.key[pk[0]];
    if (value === undefined || value === null) return undefined;
    let id = single(value, pk[0]);
    const words = route.slug && at.slug && /^\d+$/.test(String(value)) ? at.slug : '';
    if (words) id += `-${words}`;
    return [segment, id, ...tab];
  }
  const named = namedKey(at.key, pk);
  return named ? [segment, named, ...tab] : undefined;
}

/** One id, bare — unless bare would be read as something else: `new`, or nothing. */
function single(value: unknown, column?: string): string {
  const text = String(value);
  if (column && (text === 'new' || text === '')) return `${column}=${encode(text)}`;
  return encode(text);
}

/* ---------- reading ---------- */

type ParsedAddress =
  | { kind: 'route'; target: RouteTarget }
  | { kind: 'new'; target: RouteTarget & { table: string } }
  /** One of the person's conversations with the assistant: `/assistant/{id}`. */
  | { kind: 'conversation'; target: RouteTarget; id: string }
  | {
      kind: 'record';
      target: RouteTarget;
      table: string;
      key: Record<string, string>;
      natural?: { column: string; value: string };
      tab?: string;
      slugged?: boolean;
    };

const decode = (text: string): string | undefined => {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
};

/**
 * An address after the App's id, read: the segments as the browser sent
 * them, still escaped. Undefined for anything that is not an App address —
 * a query-language segment, the walk's `@`/`~` forms — which the caller
 * reads the older way and rewrites.
 */
export function readAppSegments(book: AddressBook, raw: readonly string[]): ParsedAddress | undefined {
  if (!raw.length || raw.some((segment) => OLDER_MARKS.test(segment))) return undefined;
  const head = decode(raw[0]);
  /* A table's own name over a record (`/desk/incident/BLU-201`, where the
     incident's view is `tickets`) is read under the route its records are
     addressed through, and so said there — never as the older reading's
     table and question, which made a list of the id. The name alone stays
     the older reading's: `/compass/lead` is the lead table. */
  const named =
    head === undefined || raw.length < 2
      ? undefined
      : book.tables.has(head)
        ? book.records.get(head)
        : /* A page's id over a record is the same: a page that had no list view was `/deal/1270`, and a list view
             over its table, added later, moved the records to the list's address; the old one still opens them. */
          book.records.get(book.pageBase.get(head) ?? '');
  const target = head === undefined ? undefined : (book.routes.get(head) ?? (named && book.routes.get(named.segment)));
  if (!target) return undefined;
  if (raw.length === 1) return { kind: 'route', target };
  if (target.kind === 'assistant') {
    const id = raw.length === 2 ? decode(raw[1]) : undefined;
    return id ? { kind: 'conversation', target, id } : undefined;
  }
  if (target.kind === 'dashboard' || target.kind === 'form' || target.kind === 'inbox') return undefined;
  if (raw.length === 2 && raw[1] === 'new') return target.kind === 'page' ? undefined : { kind: 'new', target };
  const table = target.table;
  const read = readKey(book, table, raw[1]);
  if (!read) return undefined;
  if (raw.length === 2 || raw.length === 3) {
    const tab = raw.length === 3 ? decode(raw[2]) : undefined;
    if (raw.length === 3 && !tab) return undefined;
    return { kind: 'record', target, table, ...read, ...(tab ? { tab } : {}) };
  }
  if (raw.length > 5 || read.natural) return undefined;
  // A child keyed under this record: `/orders/12/lines/3`.
  const under = decode(raw[2]);
  const childTarget = under === undefined ? undefined : book.routes.get(under);
  const childTable = childTarget && 'table' in childTarget ? childTarget.table : undefined;
  const child = childTable ? book.records.get(childTable) : undefined;
  const pk = primaryKeyOf(book.tables.get(table));
  const down = decode(raw[3]);
  if (!childTarget || !child?.parent || child.parent.table !== table || pk.length !== 1 || down === undefined) return undefined;
  const tab = raw.length === 5 ? decode(raw[4]) : undefined;
  if (raw.length === 5 && !tab) return undefined;
  return {
    kind: 'record',
    target: childTarget,
    table: child.table,
    key: { [child.parent.column]: read.key[pk[0]], [child.parent.child]: down },
    ...(tab ? { tab } : {}),
  };
}

/** An id segment as the table's route reads it. */
function readKey(
  book: AddressBook,
  table: string,
  raw: string,
): { key: Record<string, string>; natural?: { column: string; value: string }; slugged?: boolean } | undefined {
  const route = book.records.get(table);
  const pk = primaryKeyOf(book.tables.get(table));
  if (!pk.length) return undefined;
  if (raw.includes('=')) {
    const key: Record<string, string> = {};
    for (const pair of raw.split(',')) {
      const eq = pair.indexOf('=');
      const column = decode(pair.slice(0, eq)),
        value = decode(pair.slice(eq + 1));
      if (eq <= 0 || column === undefined || value === undefined || Object.hasOwn(key, column)) return undefined;
      key[column] = value;
    }
    const names = Object.keys(key);
    if (names.length === pk.length && pk.every((column) => Object.hasOwn(key, column))) return { key };
    if (route?.column && names.length === 1 && names[0] === route.column)
      return { key, natural: { column: route.column, value: key[route.column] } };
    return undefined;
  }
  const value = decode(raw);
  if (value === undefined || value === '') return undefined;
  if (route?.column) return { key: { [route.column]: value }, natural: { column: route.column, value } };
  if (pk.length !== 1) return undefined;
  if (route?.slug) {
    const leading = /^(\d+)(?:-.*)?$/s.exec(value);
    if (leading) return { key: { [pk[0]]: leading[1] }, ...(leading[1] !== value ? { slugged: true } : {}) };
  }
  return { key: { [pk[0]]: value } };
}

/* ---------- the check ---------- */

interface CatalogColumn extends ColumnLike {
  nullable: boolean;
}
interface CatalogTable extends TableLike {
  columns: readonly CatalogColumn[];
  unique?: readonly string[];
  uniquePairs?: ReadonlyArray<readonly [string, string]>;
}

/**
 * A natural key is an address only where the database keeps it one: NOT
 * NULL and unique by a constraint or a unique index the catalog reports.
 * Two rows under one key would make a shared link open whichever the
 * database found first, and a null would have no address at all, so the
 * check refuses rather than warns. The primary key alone proves itself.
 */
export function naturalKeyProblems(book: AddressBook, tenantOwned: (table: string) => boolean = () => false): string[] {
  const problems: string[] = [];
  for (const route of book.records.values()) {
    if (!route.column) continue;
    const table = book.tables.get(route.table) as CatalogTable | undefined;
    const column = table?.columns.find((candidate) => candidate.name === route.column);
    if (!table || !column) continue;
    const at = `resources "${table.name}": "address" names "${column.name}"`;
    if (column.nullable) problems.push(`${at}, which can be null. A natural key must be NOT NULL: a record without one has no address.`);
    const pk = primaryKeyOf(table);
    /* A tenant's rows are addressed within the tenant (every read is the
       session's tenant's), so a key unique beside one other column is one:
       `UNIQUE (tenant_id, number)` gives each customer its own ticket 1.
       Which column that is, the tenant policy says, not the App; but a
       tenant-owned table's every unique index must include its tenant
       column or the deployment refuses to start (tenantUniqueRefusal), so a
       pair that holds here, there holds with the tenant column. */
    const tenant = tenantOwned(table.id);
    const proven =
      (pk.length === 1 && pk[0] === column.name) ||
      Boolean(table.unique?.includes(column.name)) ||
      (tenant && Boolean(table.uniquePairs?.some((pair) => pair.includes(column.name) && pair[0] !== pair[1])));
    if (!proven)
      problems.push(
        `${at}, which the database does not keep unique. ${
          tenant
            ? `Add a UNIQUE constraint on it within its tenant, "UNIQUE (<tenant column>, ${column.name})"`
            : `Add a UNIQUE constraint or a unique index on "${column.name}" alone`
        }, so two records can never share an address.`,
      );
  }
  return problems;
}

/* ---------- the route table ---------- */

/**
 * An App mounted at the root beside other Apps (mount.ts): `/billing` is the
 * Billing App's before it is any route of this one, so a route of that name
 * could never be reached. `taken` is each other App's segment, by its id.
 */
export function mountClashes(book: AddressBook, taken: Readonly<Record<string, string>>): string[] {
  return Object.entries(taken).flatMap(([app, segment]) => {
    const target = book.routes.get(segment);
    return target
      ? [
          `${describe(target)}: its address "/${segment}" is where the App "${app}" is mounted, beside this one at the root. ` +
            `Give it another "path", or mount "${app}" elsewhere (--mount ${app}=/<segment>).`,
        ]
      : [];
  });
}

/**
 * Every route, one line each, as `mistri check --routes` prints it.
 * `home` is the App's home as the browser shows it (mount.ts `appHome`):
 * `/` at the root, `/compass` under its id, `/tools/` under a base path.
 */
export function routeTable(book: AddressBook, home: string): Array<{ path: string; what: string }> {
  const rows: Array<{ path: string; what: string }> = [{ path: home, what: 'home' }];
  const under = home.replace(/\/$/, '');
  const records = [...book.records.values()];
  for (const [segment, target] of book.routes) {
    const at = `${under}/${segment}`;
    const what = describe(target);
    if (target.kind === 'dashboard') {
      /* The route itself, then one line per parameter it reads, each said
         only where the dashboard offers it: a room's place, a window, a pick. */
      rows.push({ path: at, what });
      if (target.params)
        rows.push({ path: `${at}?${target.params.map((name) => `${name}=…`).join('&')}`, what: `${what}, at the place it keeps` });
      if (target.window) rows.push({ path: `${at}?period=…`, what: `${what}, over one of its windows` });
      for (const column of target.picks ?? []) rows.push({ path: `${at}?${column}=…`, what: `${what}, picked by "${column}"` });
      for (const key of target.periods ?? [])
        rows.push({ path: `${at}?period.${key}=…`, what: `${what}, the section "${key}"'s own window` });
      continue;
    }
    rows.push({ path: at, what });
    if (target.kind === 'list') {
      if (target.tabs) rows.push({ path: `${at}?tab=…`, what: `${what}, on one of its tabs (${target.tabs.join(', ')})` });
      if (target.filters) rows.push({ path: `${at}?{filter}=…`, what: `${what}, refined by its filters (${target.filters.join(', ')})` });
    }
    if (target.kind === 'list' || target.kind === 'table') rows.push({ path: `${at}/new`, what: `the New form over "${target.table}"` });
    for (const route of records.filter((route) => route.segment === segment)) {
      const table = book.tables.get(route.table)!;
      const id = route.column
        ? `{${route.column}}`
        : route.parent
          ? undefined
          : primaryKeyOf(table).length === 1
            ? `{${primaryKeyOf(table)[0]}}${route.slug ? '[-slug]' : ''}`
            : primaryKeyOf(table)
                .map((column) => `${column}={…}`)
                .join(',');
      if (id) rows.push({ path: `${at}/${id}`, what: `one record of "${table.name}"` });
      if (route.parent) {
        const parent = book.records.get(route.parent.table)!;
        rows.push({
          path: `${under}/${parent.segment}/{${route.parent.column}}/${segment}/{${route.parent.child}}`,
          what: `one record of "${table.name}", under its "${book.tables.get(parent.table)!.name}"`,
        });
      }
    }
  }
  return rows;
}
