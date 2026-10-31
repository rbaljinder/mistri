/**
 * What an app's list page is, before anything is drawn.
 *
 * Which spec dresses a table, the query text each tab stands for, which
 * tab a query text *is*, what the breadcrumb calls it, and how the app's
 * plumbing (the show clause that fetches its columns and the keys a row
 * needs to open) is folded out of the visible question and back in on the
 * way out. Pure, so the component and the walk read one rule.
 *
 * There is one source of truth for what the list is showing: the entry's
 * query text, exactly as in DB mode. A tab click writes the tab's query
 * into it; the boxes edit it; a header menu appends to it; the URL carries
 * it. Which tab is lit is *derived* from the text, so a refined tab
 * honestly shows as a filter rather than pretending to still be the tab
 * it started from.
 */
import { andQuery, expandSegments, splitClauseTail } from '@mistriwork/engine/shared/query.js';
import { humanName, type AppNoun } from '@mistriwork/engine/shared/model.js';
import { recordNoun } from '@mistriwork/engine/shared/appNoun.js';
import { labelColumn, labelPath as schemaLabelPath, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { findTable, labelPath, recordLabel, state } from '../core.js';
import { referenceProjection } from '@mistriwork/engine/shared/referenceModel.js';
import { LABEL_SEGMENT } from '@mistriwork/engine/shared/recordLabel.js';
import {
  appListQuery as sharedAppListQuery,
  editedReferences as sharedEditedReferences,
  limitClause,
  listReferenceNames as sharedListReferenceNames,
  orderClause,
  referenceNames as sharedReferenceNames,
  showClause as sharedShowClause,
  subtitleColumns as sharedSubtitleColumns,
  withOrder,
  type ListRules,
  type ListTab,
} from '@mistriwork/engine/shared/listQuestion.js';
import { shell } from '../shellMode.js';
import { canonicalize, conditionTail, hasShowClause, squeeze, stripCondition } from '../filterbar.js';
import { maskQuoted, splitConditions, splitQuery } from '../clauses.js';
import { appRooms, isListRoom, offeredBy, resourceOf, viewRoom } from './appRooms.js';
import type { AppAction } from '@mistriwork/engine/schema/model.js';
import type { AppForm } from '@mistriwork/engine/shared/servedApp.js';
import type { AppListPresentation, AppSplitListDetail } from '@mistriwork/engine/shared/listPresentations.js';
import { say } from '../copy/lists/components/appListModel.js';

/* The question's rules live in shared/listQuestion.ts, where a first page's
   is built by the server too; these read them over the App on screen. */
const rules = (): ListRules | undefined => (state.schema ? { schema: state.schema, resources: shell().app()?.resources ?? {} } : undefined);

/** One of the App's list views, with what its resource lets it offer — or the stand-in for a table it has no view of. */
export interface ListSpec {
  /** The view's key, when the App has a view of this list: which view
      opened a room rides the walk as `view` and wins over table and query. */
  id?: string;
  /** How the rows are drawn; a `split` is the list/detail workspace. */
  presentation?: AppListPresentation;
  empty?: import('@mistriwork/engine/shared/listPresentations.js').AppListEmpty;
  quickAdd?: true;
  /** The view carries a Favorites star. */
  favorite?: true;
  /** The menu's mark for the view, one of the App icons. */
  icon?: string;
  /** Columns summed in the grid's footer, over the whole query. */
  totals?: string[];
  /** Row height; 'comfortable' is the default. */
  density?: 'comfortable' | 'compact';
  /** A ⋯ menu at the end of each row with the record's own actions. */
  rowActions?: true;
  /** Cells edited in place, and a selection's "Set field…": every shown writable column, or those named. */
  editable?: true | string[];
  /** 'none' hides the filter form; 'rail' draws the filters as facets beside the rows. */
  filterBar?: import('@mistriwork/engine/shared/listPresentations.js').FilterBar;
  /** A text filter's suggestions: the columns whose values it offers as the reader types. */
  suggest?: Record<string, readonly string[]>;
  advancedFilters?: boolean;
  /** A split's single keys: a key → the id of an action of the picked record. */
  keys?: Record<string, string>;
  /** false draws the list without its title; it stays for a screen reader. */
  heading?: false;
  sizing?: import('@mistriwork/engine/shared/tableSizing.js').TableSizing;
  table: string;
  /** The list's own name, its heading. The menu may call it something else. */
  label: string;
  query?: string;
  tabs?: ListTab[];
  /** The server's word for what the menu counts, where it is not `query`: a saved form's drafts left out. */
  countQuery?: string;
  /** The author's say on the menu's count, over the rule (shared/menuCounts.ts). */
  count?: boolean;
  /** Columns or label paths the list shows, in order. */
  show?: string[];
  filters?: string[];
  /** The orders a reader may choose from the list's Sort menu. */
  sorts?: Array<{ label: string; sort: string }>;
  /** The order the list reads in when nothing else says one: the view's, kept out of the bar as `order` is. */
  sort?: string;
  /** The numeric column holding each row's place: the list reads in it, and an editor puts rows in place (useListOrder.tsx). */
  order?: string;
  /** The resource's New form. */
  form?: AppForm<string>;
  /** What the list offers: its resource's actions, narrowed by a queue's or a board's selector. */
  actions?: AppAction[];
  /** What one of its records is called, and several: its resource's noun. */
  noun?: AppNoun;
  error?: string;
  open?: 'page' | 'drawer' | 'modal';
  /** A reference column whose record a row opens instead of the row (rowOpens.ts). */
  opens?: string;
  /** A split list's authored page size: the view's, like its show clause —
      written into its question, never offered back as a filter. */
  limit?: number;
}

/** The split workspace a list's presentation is, or undefined. */
export const splitOf = (spec: Pick<ListSpec, 'presentation'> | undefined): AppSplitListDetail | undefined =>
  spec?.presentation?.kind === 'split' ? spec.presentation : undefined;

/** The list half of a split workspace: the view's own list, at the split's page size.
    The presentation stays: a split that chose its rows draws them, and one that did not is the plain grid.
    Here rather than beside the room, because an address says the list's question too. */
export function splitListSpec(spec: ListSpec): ListSpec {
  const limit = splitOf(spec)?.limit;
  return { ...spec, ...(limit ? { limit } : {}) };
}

/** A list on the walk. `view` is the key of the view that opened it. */
export interface ListEntry {
  table: string;
  query: string;
  tab?: string;
  view?: string;
}

const table = (id: string) => findTable(id) as TableMeta | undefined;

/**
 * The app's list spec behind a table: one of its views when the app has
 * one, and a synthesized stand-in — the humanized name, derived filter
 * boxes, no tabs, the resource's form and actions — when it does not.
 * Tables without a view used to fall through to the explorer's grid, but
 * every drill from a page lands on one, and each landing swapped the room's
 * dress for raw chrome. The dress is a property of the mode, not of being listed.
 *
 * A table may have several views — the plain list and its modules ("Work
 * orders", "Urgent orders"). The view the room was opened from says which,
 * when the walk carries its key (`view`): a split beside a plain list asks
 * the same question of the same rows, and nothing else can tell them apart;
 * and a list view only a dashboard embeds is reached by its key alone.
 * Without one the walk's own query decides among the rooms the App lists,
 * as it always did: the view one of whose tabs *is* this query, else the
 * module whose standing conditions lead it, else the plain list, else the
 * first.
 */
export function appListFor(tableId: string, query?: string, view?: string): ListSpec {
  const app = shell().app();
  /* A key that names no view over this table — a link from before a view
     was renamed or removed — falls back rather than failing. */
  const own = app && view ? viewRoom(app, view) : undefined;
  if (own && isListRoom(own) && own.table === tableId && !own.error) return own;
  const candidates = (app ? appRooms(app) : []).filter(
    (e): e is ListSpec & { id: string } => isListRoom(e) && e.table === tableId && !e.error,
  );
  if (candidates.length) {
    if (query !== undefined) {
      const exact = candidates.find((e) => activeTab(e, query) >= 0);
      if (exact) return exact;
      const want = squeeze(query);
      const leads = candidates.find((e) => e.query && want.startsWith(squeeze(`${e.table} ${e.query}`)));
      if (leads) return leads;
    }
    return candidates.find((e) => !e.query) ?? candidates[0];
  }
  const base = table(tableId);
  const name = base?.name ?? tableId;
  return {
    table: tableId,
    label: humanName(name) || name,
    ...(base ? { show: defaultListShow(state.schema, base) } : {}),
    ...offeredBy(resourceOf(app, tableId)),
  };
}

/** Only synthesized lists use these defaults; authored projections remain authoritative. */
export function defaultListShow(schema: DatabaseSchema, base: TableMeta): string[] {
  const paths = base.columns.map((column) => column.name);
  const { labels } = referenceProjection(schema, base, paths, true, (target) => schemaLabelPath(schema, target, recordLabel(target)));
  return base.columns.map((column) => (column.primaryKey ? column.name : (labels.get(column.name) ?? column.name)));
}

/**
 * The references among a list's columns, each with the path its record's
 * name is read from (shared/listQuestion.ts): the name rides the row,
 * fetched in the list's own statement, and the key stays the column's value.
 */
export function referenceNames(tableId: string, names: readonly string[]): Record<string, string> {
  const over = rules();
  return over ? sharedReferenceNames(over, tableId, names) : {};
}

export const specTabs = (spec: ListSpec): ListTab[] => (spec.tabs?.length ? spec.tabs : [{ label: say('common.all') }]);

/** The columns a shown column's second line reads: fetched with the row, drawn under it. */
export function subtitleColumns(tableId: string, shown: readonly string[]): string[] {
  const over = rules();
  return over ? sharedSubtitleColumns(over, tableId, shown) : [];
}

/** The references an editable list shows by name (`owner_id.name`): their keys ride along
    with the row, so a cell edits the reference and says what it replaces (GridCellEditor.tsx). */
export function editedReferences(spec: Pick<ListSpec, 'table' | 'show' | 'editable' | 'presentation'>): string[] {
  const over = rules();
  return over ? sharedEditedReferences(over, spec) : [];
}

/** The column a list's search box searches: the one its records are named by,
    where a filter box can read it — not a templated name (`$label`), which is
    computed, nor a column an API cannot filter by. The list draws that box and
    its address says it as `search=` (publicAddress.ts), by this one rule. */
export function searchColumn(t: TableMeta | undefined): string | undefined {
  if (!t) return undefined;
  const label = recordLabel(t) === undefined ? labelColumn(t) : labelPath(t);
  return label && label !== LABEL_SEGMENT && (!t.filterable || t.filterable.includes(label)) ? label : undefined;
}

/** The show clause that fetches the app's columns plus the keys a row needs to open. */
function showClause(spec: ListSpec): string {
  const over = rules();
  return over ? sharedShowClause(over, spec) : '';
}

/** The references a list draws — its `show`, its presentation's columns, or every column — by the path each is named from (referenceNames). */
export function listReferenceNames(spec: Pick<ListSpec, 'table' | 'show' | 'presentation'>): Record<string, string> {
  const over = rules();
  return over ? sharedListReferenceNames(over, spec) : {};
}

/** The full query text one of the app's tabs stands for. A module's
    standing conditions come first; a tab refines on top of them. */
export function appListQuery(spec: ListSpec, index = 0): string {
  const over = rules();
  return over
    ? sharedAppListQuery(over, spec, index)
    : [spec.table, withOrder(spec, andQuery(spec.query, specTabs(spec)[index]?.query) ?? ''), limitClause(spec)].filter(Boolean).join(' ');
}

/** The tabs as the bar reads them: each tab's question as the list asks it, less what the view always asks — its
    standing conditions, its show, and its order. A tab whose own sort is the view's order is said without it, as
    the question it opens is, so it lights on arrival and is never a chip ("Offered is Offered"). */
export function shownTabs(spec: ListSpec): ListTab[] {
  return specTabs(spec).map((tab, i) => {
    const query = tabQuestion(spec, i);
    const { query: _authored, ...rest } = tab;
    return query ? { ...rest, query } : rest;
  });
}

/** Which tab the entry's query text is, or -1 when refined away. Canonical on
    both sides, as the tabs light (litTabFor): a tab clicked asks its `a or b`
    bare, and its question as composed brackets it, `(a or b)` — the same tab,
    which the crumb called by its query instead of its name. */
function activeTab(spec: ListSpec, query: string): number {
  /* The question hides the view's standing conditions, so a query that never
     asked them (the bare table) reads as empty, as an untabbed view's own
     does: without this, a table's plain address was the first filtered view
     over it (Urgent orders for work_order), its conditions and all. */
  const standing = standingHead(spec);
  if (standing && !unplumbed(spec, query).startsWith(standing)) return -1;
  const want = canonicalize(visibleQuestion(spec, query));
  return specTabs(spec).findIndex((_, i) => kept(spec, `\u0001${i}`, () => canonicalize(tabQuestion(spec, i))) === want);
}

/** What the breadcrumb calls this list: the app's label, with the tab or
    what the refinement narrows to — never the raw query text. */
export function appCrumbLabel(entry: ListEntry): string {
  const spec = appListFor(entry.table, entry.query, entry.view);
  if (squeeze(entry.query) === entry.table) return spec.label;
  const tab = activeTab(spec, entry.query);
  if (tab === 0) return spec.label;
  if (tab > 0) return `${spec.label} · ${specTabs(spec)[tab].label}`;
  const words = refinementWords(visibleQuestion(spec, entry.query));
  return words ? `${spec.label} · ${words}` : spec.label;
}

const unquoted = (value: string) => {
  const text = value.trim();
  return /^(["']).*\1$/.test(text) ? text.slice(1, -1) : text;
};

/**
 * A refinement as the crumb says it: the values it narrows to — "Sedan,
 * Toyota" — when every condition is a plain equality, up to three; the first
 * two and how many more when some are; the number of filters when none are.
 * A sort or a column list narrows nothing and says nothing. "· filtered" told
 * a reader that something was hidden and not what.
 */
export function refinementWords(refinement: string): string {
  const { filter } = splitQuery(`list ${refinement}`) as { filter: string };
  const conditions = (splitConditions(filter) as string[]).map(squeeze).filter(Boolean);
  if (!conditions.length) return '';
  /* A word says itself ("Sedan"); a number alone says nothing, so it
     carries its column's name ("Priority 2"). */
  const plain = conditions.flatMap((condition) => {
    const m = /^([A-Za-z_][\w.]*)\s*=\s*(.+)$/.exec(condition);
    // An either-or is no one value: "a or status = b" is the query, not a word.
    if (!m || /\sor\s/i.test(maskQuoted(condition))) return [];
    const value = unquoted(m[2]);
    return [/^-?\d+(?:\.\d+)?$/.test(value) ? `${humanName(m[1].split('.').pop() ?? m[1])} ${value}` : value];
  });
  if (plain.length === conditions.length && plain.length <= 3) return plain.join(', ');
  if (plain.length) {
    const said = plain.slice(0, 2);
    return `${said.join(', ')} +${conditions.length - said.length}`;
  }
  return say('filtersCount', { count: conditions.length });
}

/**
 * The bar shows the question without the table name — the heading already
 * says which table this is — and without the app's show clause, which is
 * plumbing, not part of anyone's question.
 */
export function visibleQuestion(spec: ListSpec, query: string): string {
  return kept(spec, query, () => inTabWords(spec, standingless(spec, query)));
}

/** A tab's question as the bar reads it: the whole question it opens (appListQuery), less the view's plumbing. */
export const tabQuestion = (spec: ListSpec, index: number): string =>
  kept(spec, `\u0000${index}`, () => visibleQuestion(spec, appListQuery(spec, index)));

/* A view's questions as read, kept per view while the schema and the App stand: both are replaced when they change,
   never edited in place. The list, its crumb, its room, its address and the nav each ask them several times a paint,
   every tab's composed and read again for each; a sort asked them all again inside its click
   (test/built-client-vitals.mjs). */
let read = new WeakMap<ListSpec, Map<string, string>>();
let readOver: unknown[] = [];
function kept(spec: ListSpec, key: string, ask: () => string): string {
  const over = [state.schema, shell().app()];
  if (over[0] !== readOver[0] || over[1] !== readOver[1]) [read, readOver] = [new WeakMap(), over];
  const said = read.get(spec) ?? new Map<string, string>();
  read.set(spec, said);
  if (!said.has(key)) {
    if (said.size > 99) said.clear();
    said.set(key, ask());
  }
  return said.get(key)!;
}

/**
 * A question that spells out a tab's segment, said in the tab's word: a dashboard's drill into Incidents asks
 * `status != resolved and status != closed and priority = critical`, which is the Active tab (`active`) and the
 * priority's box. A tab names its segment (appSegments.ts), so without this the drill lit no tab and its address
 * was the whole question; where several tabs fit, the one that accounts for the most conditions.
 */
function inTabWords(spec: ListSpec, question: string): string {
  const segments = (findTable(spec.table) as TableMeta | undefined)?.segments;
  if (!segments || !question) return question;
  const { head, tail } = splitClauseTail(question);
  const said: string[] = splitConditions(head);
  if (!said.length) return question;
  const heard = said.map((condition) => canonicalize(condition));
  let best: { word: string; taken: Set<number> } | undefined;
  for (const tab of specTabs(spec)) {
    const word = tab.query?.trim();
    if (!word || !Object.hasOwn(segments, word)) continue;
    const own: string[] = splitConditions(unwrapped(expandSegments(segments[word]!, segments).text));
    const taken = new Set<number>();
    for (const condition of own) {
      const at = heard.findIndex((candidate, i) => !taken.has(i) && candidate === canonicalize(condition));
      if (at < 0) break;
      taken.add(at);
    }
    if (own.length && taken.size === own.length && (!best || taken.size > best.taken.size)) best = { word, taken };
  }
  if (!best) return question;
  const filter = [best.word, ...said.filter((_, i) => !best!.taken.has(i))].join(' and ');
  return tail ? `${filter} ${tail}` : filter;
}

/** A condition text without the parentheses a segment's expansion stands in. */
function unwrapped(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) return trimmed;
  let depth = 0;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '(') depth++;
    else if (trimmed[i] === ')' && --depth === 0 && i < trimmed.length - 1) return trimmed;
  }
  return trimmed.slice(1, -1).trim();
}

function standingless(spec: ListSpec, query: string): string {
  const asked = unplumbed(spec, query);
  /* A view's standing condition leads every question it asks (appListQuery).
     It is the view's, not the reader's: the bar, the tabs and the chips see
     only what follows it, and wholeQuery puts it back. A link that arrives
     without it shows the whole of what it asks. */
  const standing = standingHead(spec);
  if (!standing || !asked.startsWith(standing)) return asked;
  const rest = asked.slice(standing.length).trim();
  if (!rest) return '';
  if (rest.startsWith('and ')) return rest.slice(4).trim();
  return splitClauseTail(rest).head ? asked : rest;
}

/** The query without the table name and the view's own show, page size and order. */
function unplumbed(spec: ListSpec, query: string): string {
  const plumbing = squeeze(showClause(spec));
  const whole = squeeze(query);
  const bare = whole.startsWith(spec.table) ? whole.slice(spec.table.length).trim() : whole;
  const shown = plumbing && bare.includes(plumbing) ? squeeze(bare.replace(plumbing, ' ')) : bare;
  /* The authored page size is the view's too: "limit 25" was a chip with a ×
     on every split list, a filter nobody had set. */
  const paged = limitClause(spec);
  const limited = paged && new RegExp(`(^|\\s)${paged}$`).test(shown) ? squeeze(shown.slice(0, -paged.length)) : shown;
  const order = orderClause(spec);
  return order && new RegExp(`(^|\\s)${order.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).test(limited)
    ? squeeze(limited.slice(0, -order.length))
    : limited;
}

/** The conditions a view always asks, as appListQuery writes them first. */
function standingHead(spec: ListSpec): string {
  const head = spec.query ? splitClauseTail(spec.query).head : '';
  return head ? squeeze(andQuery(head)) : '';
}

/** The plumbing folded back in on the way out — unless the reader wrote a
    show of their own, which wins and stays visible. */
export function wholeQuery(spec: ListSpec, typed: string): string {
  const plumbing = squeeze(showClause(spec));
  // The view's hand order, unless the reader sorts the list another way.
  const kept = withOrder(spec, squeeze(typed));
  const shown = plumbing && !hasShowClause(typed) ? `${kept} ${plumbing}` : kept;
  // The authored page size goes back on too, unless the reader wrote a limit of their own.
  const paged = limitClause(spec);
  const question = paged && !/(^|\s)limit\s+\d+/.test(squeeze(typed)) ? `${shown} ${paged}` : shown;
  // The view's standing condition first, unless the reader wrote it out themselves.
  const standing = standingHead(spec);
  const asked = standing && !squeeze(typed).startsWith(standing) ? andQuery(spec.query, question) : question;
  return squeeze(`${spec.table} ${asked}`);
}

/**
 * Which tab the state is, boxes aside. A box column can also be a tab's
 * own dimension — status is both, on many lists — so each tab is compared
 * with only the *other* box columns stripped: the tab's own condition
 * keeps its value, and "Open" does not light up for a state that says
 * in_progress. Canonical on both sides: narrowing an or-tab wrapped its
 * group in parens, and `(a or b)` still *is* the "a or b" tab.
 */
export function litTabFor(tabs: ListTab[], refinement: string, boxColumns: string[]): number {
  /* Several tabs can match once box columns are stripped — an "All" tab
     with no conditions matches anything the boxes account for — so the
     most specific match wins: the tab that says the most itself. "Open"
     lights for `status = open and priority = 2` even where status is also
     a box, and "All" only when no other tab explains the text. */
  let best = -1;
  let said = -1;
  tabs.forEach((tab, i) => {
    const tq = canonicalize(tab.query ?? '');
    let r = refinement;
    for (const name of boxColumns) {
      if (!conditionTail(tab.query ?? '', name)) r = stripCondition(r, name);
    }
    if (canonicalize(r) !== tq) return;
    if (tq.length > said) {
      best = i;
      said = tq.length;
    }
  });
  return best;
}

/** The refinement with every box column's conditions taken out. */
export function residueOf(refinement: string, boxColumns: string[]): string {
  return boxColumns.reduce((out, name) => stripCondition(out, name), squeeze(refinement));
}

/** What the New button makes: one of the table's records, by its resource's
    noun ("New issue", "New update"), else by the table's own name. Never the
    list's label, which may name a layout ("Task calendar") or a workspace
    ("Inbox"), and never a label singularised by rule ("Statuses" made
    "New statuse"). */
export function newRecordNoun(spec: Pick<ListSpec, 'noun'>, tableName: string): string {
  return recordNoun(spec.noun, tableName);
}

/**
 * Which menu entry over a table the walk is on — the row to light. A table
 * may sit in the menu more than once, the plain list and its modules: the
 * view whose standing conditions lead the query wins, preferring the most
 * specific; a bare table query lights the plain list. -1 for none. The
 * view the walk says opened the room (`view`) wins over all of that.
 */
export function currentNavIndex(
  entries: Array<Pick<ListSpec, 'table' | 'query' | 'id'>>,
  tableId: string,
  query: string,
  view?: string,
): number {
  if (view) {
    const own = entries.findIndex((entry) => entry.table === tableId && entry.id === view);
    if (own >= 0) return own;
  }
  const want = query.replace(/\s+/g, ' ').trim();
  let best = -1;
  let bestLen = -1;
  entries.forEach((entry, i) => {
    if (entry.table !== tableId) return;
    const navq = entry.query ?? '';
    const base = navq ? `${tableId} ${navq}`.replace(/\s+/g, ' ') : tableId;
    const leads = navq ? want === base || want.startsWith(`${base} `) : true;
    const len = navq ? base.length : 0;
    if (leads && len > bestLen) {
      best = i;
      bestLen = len;
    }
  });
  return best;
}
