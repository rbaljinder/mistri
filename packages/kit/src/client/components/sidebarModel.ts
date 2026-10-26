/**
 * What the sidebar lists, and where its cursor is.
 *
 * Two lists share one shape: the app's nav — its rooms, its words, its
 * order, with a heading over each group and the full table list one row
 * away — and the workbench's every table. Rows that name a table carry the
 * same fields whichever list they are in, so the highlight, the arrow-key
 * skim and the filter box work on both without knowing which one they are
 * working on. The list is computed, not kept: the schema, the app and the
 * filter text are the inputs, and the component and the keyboard both read
 * the same function so they can never disagree about which row is third.
 *
 * The cursor is the keyboard's row, kept beside the tick of the walk it was
 * set at: once the walk moves — the skim's own preview landing, a click, a
 * link — the cursor is the current room again, which is what the old
 * `highlightTable` did by assignment.
 *
 * A table row's number is the catalog's snapshot in the workbench and a
 * live count in an app's menu (navCounts.ts): the row says what to count,
 * `rowCount` says how the answer reads.
 */
import { currentEntry, state, tableView, walkVersion } from '../core.js';
import { shell } from '../shellMode.js';
import { appListFor, appListQuery, currentNavIndex, type ListSpec } from './appListModel.js';
import { menuCount, type CountedMachine } from '@mistriwork/engine/shared/menuCounts.js';
import {
  ASSISTANT_PAGE,
  appMenu,
  dashViewKey,
  formViewKey,
  hasRooms,
  homeRoom,
  isAssistantRoom,
  isListRoom,
  type MenuEntry,
} from './appRooms.js';
import { isServedForm as isFormView } from '@mistriwork/engine/shared/servedApp.js';
import type { AvailableNavigationNode } from './navigationTree.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { shownFavorites } from './favoriteNav.js';
import type { Favorite } from './favorites.js';
import { formatApprox, formatNumber } from '../locale.js';
import type { NavCount, NavCountSpec } from './navCounts.js';
import { say } from '../copy/shell/components/sidebarModel.js';
import { shellBody } from '../shellHost.js';

interface TableLike {
  id: string;
  name: string;
  isView?: boolean;
  approxRows?: number | null;
}

type SidebarItem = (
  | { kind: 'target'; label: string; href: string; color?: number }
  | { kind: 'group'; label: string; groupId?: string; folded?: true; expanded?: boolean; reveal?: boolean }
  | { kind: 'dash'; view: string; label: string; icon?: string; navColor?: number; error?: string }
  /** A signed-in form, or — with `page` — another screen of the App's own walked as that page (the assistant's). */
  | { kind: 'form'; view: string; label: string; icon?: string; navColor?: number; error?: string; page?: string }
  | { kind: 'missing'; label: string; icon?: string; navColor?: number; error: string }
  | {
      kind: 'table';
      table: string;
      navq?: string;
      label: string;
      icon?: string;
      navColor?: number;
      count: number | null;
      tag: 'view' | null;
      entry?: ListSpec;
      /** What the server is asked to count, for a row whose number is live. */
      counted?: NavCountSpec;
      /** The count is of work past its date (shared/menuCounts.ts): said in the danger's ink. */
      late?: boolean;
    }
  | { kind: 'favorite'; favorite: Favorite; label: string }
  | { kind: 'note'; text: string }
  /** The space that holds a footer group to the foot of the sidebar. */
  | { kind: 'gap' }
) & {
  depth?: number;
  /** In a footer group, where it is drawn (a flex `order`): each group's rows, then its heading under them. */
  footOrder?: number;
  /** A footer group's heading, drawn under its rows: it opens upward. */
  anchored?: true;
};

export type TableItem = Extract<SidebarItem, { kind: 'table' }>;

/** The rows, top to bottom, for the filter text as typed. */
export function sidebarItems(filterText: string): SidebarItem[] {
  const needle = filterText.trim().toLowerCase();
  const app = shell().app();
  const schema = (state as { schema: { tables: TableLike[] } | null }).schema;
  const tables = schema?.tables ?? [];
  const items: SidebarItem[] = [];
  const appCounts = Boolean((app as { ui?: { shell?: { counts?: boolean } } } | null)?.ui?.shell?.counts);
  const machineOf = (table: string) =>
    (app as { resources?: Record<string, { machine?: CountedMachine }> } | null)?.resources?.[table]?.machine;
  if (app && (hasRooms(app) || app.nav.length > 0)) {
    let matches = 0;
    /* A group's heading stands over its rows, and only over rows: a group
       none of whose rooms the filter keeps is not drawn. A group's own
       label matching keeps every room in it.
       Every headed section folds, the top level's and the footer's too, by
       its authored id. */
    const walk = (nodes: AvailableNavigationNode<MenuEntry>[], depth: number, groupMatches: boolean): SidebarItem[] =>
      nodes.flatMap((node): SidebarItem[] => {
        if (node.kind === 'group') {
          const rows = walk(node.children, depth + 1, groupMatches || (needle !== '' && node.label.toLowerCase().includes(needle)));
          const fold = { groupId: node.id, ...(node.folded ? { folded: true as const } : {}) };
          return rows.length ? [{ kind: 'group', label: node.label, depth, ...fold }, ...rows] : [];
        }
        if (node.kind === 'target') {
          if (needle && !groupMatches && !node.label.toLowerCase().includes(needle)) return [];
          matches += 1;
          return [{ kind: 'target', label: node.label, href: node.href, depth, ...(node.color ? { color: node.color } : {}) }];
        }
        const entry = node.entry;
        const dash = 'sections' in entry;
        if (
          needle &&
          !groupMatches &&
          !entry.label.toLowerCase().includes(needle) &&
          !(isListRoom(entry) ? entry.table : '').toLowerCase().includes(needle)
        )
          return [];
        matches += 1;
        /* The view's declared icon rides with the row, into both menus and the rail. */
        const nesting = {
          ...(depth ? { depth } : {}),
          ...(entry.icon ? { icon: entry.icon } : {}),
          ...(entry.navColor ? { navColor: entry.navColor } : {}),
        };
        /* A dashboard is a screen of the app's own, walked as a page entry so
         crumbs and the walk treat it like any place; its address is its key. */
        if (dash) return [{ kind: 'dash', view: entry.id, label: entry.label, error: entry.error, ...nesting }];
        /* A signed-in form is walked as a page entry too, addressed by its key. */
        if (isFormView(entry)) return [{ kind: 'form', view: entry.id, label: entry.label, error: entry.error, ...nesting }];
        if (isAssistantRoom(entry)) return [{ kind: 'form', view: entry.id, label: entry.label, page: ASSISTANT_PAGE, ...nesting }];
        /* Kept, with its reason: a view this connection cannot honour is the
         app author's to fix, and hiding it hides the mistake. */
        if (entry.error) return [{ kind: 'missing', label: entry.label, error: entry.error, ...nesting }];
        const table = tables.find((t) => t.id === entry.table);
        return [
          {
            kind: 'table',
            table: entry.table,
            /* Which of a table's views this row is — the plain list or a
           module — so the highlight and the keyboard skim aim at the row,
           not at whichever view answers for the table first. */
            navq: entry.query ?? '',
            label: entry.label,
            /* Counted live, for what the view stands for — its condition
           included — not from the catalog's snapshot of the whole table,
           which goes stale with the first write. A database view is not
           counted: counting one runs it, and a menu is no place to run a
           report every minute. */
            count: null,
            ...(appCounts && table && !table.isView
              ? countedRow(table.id, entry, machineOf(entry.table), (table as { segments?: Record<string, string> }).segments)
              : {}),
            tag: null,
            entry,
            ...nesting,
          },
        ];
      });
    /* Starred records and views first: the working set is what the menu is opened for most. */
    const starred = shownFavorites(app).filter((favorite) => !needle || favorite.label.toLowerCase().includes(needle));
    if (starred.length)
      items.push(
        { kind: 'group', label: say('common.favorites') },
        ...starred.map((favorite) => ({ kind: 'favorite' as const, favorite, label: favorite.label })),
      );
    matches += starred.length;
    /* A target into another App of the suite leads where the shell says (shellMode.ts `navTargets`), and nowhere where it has none. */
    const menu = appMenu(app, shell().slots.navTargets?.hrefs(app, state.schema as DatabaseSchema | null) ?? leadsNowhere);
    /* A footer group is drawn last, after a gap that takes the room left over: Settings and Help stay at the foot
       however short the menu. Its heading is anchored there, under its rows, so it opens upward: the gap gives up
       what the rows take, and the heading a person pressed stays where they pressed it. The heading still comes
       first in the document (the fold's button, then what it shows); only the drawing order puts it under them. */
    const foot = (node: AvailableNavigationNode<MenuEntry>) => node.kind === 'group' && node.placement === 'footer';
    const footer = menu
      .filter(foot)
      .flatMap((node, k) =>
        walk([node], 0, false).map((item, at) =>
          at === 0 ? { ...item, footOrder: 2 * k + 2, anchored: true as const } : { ...item, footOrder: 2 * k + 1 },
        ),
      );
    items.push(
      ...walk(
        menu.filter((node) => !foot(node)),
        0,
        false,
      ),
    );
    if (footer.length) items.push({ kind: 'gap' }, ...footer);
    if (!matches && needle) items.push({ kind: 'note', text: say('noMatches') });
    return visibleGroups(items, Boolean(needle));
  }
  for (const table of tables) {
    if (needle && !table.id.toLowerCase().includes(needle)) continue;
    items.push({
      kind: 'table',
      table: table.id,
      label: table.name,
      count: !table.isView && table.approxRows != null ? table.approxRows : null,
      tag: table.isView ? 'view' : null,
    });
  }
  if (!items.length) items.push({ kind: 'note', text: say('noMatches') });
  return items;
}

/* Stable authored group IDs, scoped to the App/connection, survive label and
   ordering changes. Storage is optional; folding remains usable when blocked.
   What is kept is the person's departure from the App's default: a group's id
   when they folded an open-by-default section, `+id` when they opened one the
   App folds by default (`navGroup(…, { folded: true })`). Ids are slugs, so
   the `+` cannot collide with one. */
/* Where the shell resolves no targets of the nav: each is left out of the menu, as one still being asked is. */
const leadsNowhere = () => undefined;
const groupMemory = new Map<string, Set<string>>();
function groupStorageKey(): string | null {
  const app = shell().app() as { id?: string; name?: string } | null;
  return app ? `mistri.sidebar-groups:${JSON.stringify([state.activeConnection, app.id ?? app.name])}` : null;
}
function collapsedGroups(): Set<string> {
  const key = groupStorageKey();
  if (!key) return new Set();
  if (!groupMemory.has(key)) {
    let groups: unknown;
    try {
      groups = JSON.parse(localStorage.getItem(key) ?? '[]');
    } catch {
      groups = [];
    }
    groupMemory.set(
      key,
      new Set(Array.isArray(groups) ? groups.filter((id): id is string => typeof id === 'string' && id.length <= 200).slice(0, 500) : []),
    );
  }
  return groupMemory.get(key)!;
}

export function setSidebarGroupCollapsed(id: string, collapsed: boolean, foldedByDefault = false): void {
  const key = groupStorageKey();
  if (!key || !shell().inApp()) return;
  const groups = collapsedGroups();
  groups.delete(id);
  groups.delete(`+${id}`);
  if (collapsed !== foldedByDefault && groups.size < 500) groups.add(collapsed ? id : `+${id}`);
  try {
    localStorage.setItem(key, JSON.stringify([...groups]));
  } catch {
    /* Session-only in restricted browsers. */
  }
  cursor = -1;
  cursorAt = walkVersion();
  tell();
}

/** Both keyboard and DOM consume this projection, never a CSS-only hiding rule. */
function visibleGroups(items: SidebarItem[], filtering: boolean): SidebarItem[] {
  const collapsed = collapsedGroups();
  const rail = railed() && typeof document !== 'undefined' && shellBody().classList.contains('sidebar-hidden');
  const currentTable = tableRows(items)[currentSidebarIndex(items)];
  const dash = currentDashView(),
    form = currentFormView();
  let hiddenBelow: number | undefined;
  return items.flatMap((item, index): SidebarItem[] => {
    const depth = item.depth ?? 0;
    if (hiddenBelow !== undefined) {
      if (depth > hiddenBelow) return [];
      hiddenBelow = undefined;
    }
    if (item.kind !== 'group' || !item.groupId) return [item];
    let active = false;
    for (let next = index + 1; next < items.length && (items[next].depth ?? 0) > depth; next++) {
      const child = items[next];
      if (child === currentTable || (child.kind === 'dash' && child.view === dash) || (child.kind === 'form' && child.view === form)) {
        active = true;
        break;
      }
    }
    const reveal = filtering || rail || active;
    const expanded = reveal || (item.folded ? collapsed.has(`+${item.groupId}`) : !collapsed.has(item.groupId));
    if (!expanded) hiddenBelow = depth;
    return [{ ...item, expanded, reveal }];
  });
}

export const tableRows = (items: SidebarItem[]): TableItem[] => items.filter((i): i is TableItem => i.kind === 'table');

/** App menus retain their icons when folded unless explicitly opted out. */
export function railed(): boolean {
  return shell().inApp() && (shell().app() as { ui?: { shell?: { rail?: boolean } } } | null)?.ui?.shell?.rail !== false;
}

/**
 * What a table row shows beside its label. A counted row shows the live
 * answer and nothing else — the snapshot it replaces is the number that
 * went stale; an estimate wears the `~` and the rounding the explorer's
 * result head gives one; a count the server stopped at its bound is the
 * bound and a `+`, in full and with no `~` — every row up to it was
 * counted, so it is a floor, not a guess; and a row with no answer (not
 * yet, refused, failed) shows nothing, since a zero there would be a claim.
 */
export function rowCount(item: TableItem, live: NavCount | null | undefined): string | null {
  if (item.counted) {
    if (!live) return null;
    if (live.capped) return `${formatNumber(live.count)}+`;
    return live.exact ? formatNumber(live.count) : `~${formatApprox(live.count)}`;
  }
  return item.count != null ? formatNumber(item.count) : null;
}

/**
 * Which table row is the current room. A table may sit in the list more
 * than once — the plain list and its modules — and the walk's query says
 * which: the row whose standing conditions lead the query, preferring the
 * most specific; a bare table query lights the plain row. With nothing on
 * the walk, a visitor served a list home is on that list, so its row is lit
 * the way a home dashboard's is.
 */
export function currentSidebarIndex(items: SidebarItem[]): number {
  const here = currentEntry() as { table?: string; query?: string; view?: string } | undefined;
  if (!here) {
    const app = shell().inApp() ? shell().app() : null;
    const home = app ? homeRoom(app) : undefined;
    return home && isListRoom(home) ? tableRows(items).findIndex((row) => row.entry?.id === home.id) : -1;
  }
  if (!here.table) return -1;
  return currentNavIndex(
    tableRows(items).map((row) => ({ table: row.table, query: row.navq || undefined, id: row.entry?.id })),
    here.table,
    here.query ?? '',
    here.view,
  );
}

/**
 * Which dashboard row is lit, by its view key: the one on the walk, or —
 * with nothing on the walk — the dashboard the server served as this
 * visitor's home. None when the home is a list or a public view.
 */
export function currentDashView(): string | null {
  const here = currentEntry() as { kind?: string; pageId?: string } | undefined;
  const onWalk = here?.kind === 'page' ? dashViewKey(here.pageId) : undefined;
  if (onWalk !== undefined) return onWalk;
  const app = shell().inApp() ? shell().app() : null;
  if (here || !app) return null;
  const home = homeRoom(app);
  return home && 'sections' in home ? home.id : null;
}

/** Which form row is lit, by its view key: the one on the walk, or the signed-in form served as this visitor's home. */
export function currentFormView(): string | null {
  const here = currentEntry() as { kind?: string; pageId?: string } | undefined;
  if (here?.kind === 'page' && here.pageId === ASSISTANT_PAGE) return ASSISTANT_PAGE;
  const onWalk = here?.kind === 'page' ? formViewKey(here.pageId) : undefined;
  if (onWalk !== undefined) return onWalk;
  const app = shell().inApp() ? shell().app() : null;
  if (here || !app) return null;
  const home = homeRoom(app);
  return home && isFormView(home) ? home.id : null;
}

/**
 * The tab the current view is on, if it is a table view. Rows for anything
 * else: arriving from a record, the reader has not chosen a tab, and
 * defaulting to whatever they last looked at three walks ago would be
 * guessing.
 */
export function stickyTab(): string {
  const entry = currentEntry() as { kind?: string; tab?: string } | undefined;
  return entry?.kind === 'table' ? (entry.tab ?? 'rows') : 'rows';
}

/**
 * The query a row opens on. In app mode a list opens on its first tab —
 * the app decided what matters most — and the keyboard path
 * arriving on the raw table was a different, undressed room.
 */
function rowQuery(row: TableItem): string | undefined {
  if (!shell().inApp()) return undefined;
  const spec = appListFor(row.table, `${row.table} ${row.navq ?? ''}`.trim(), row.entry?.id);
  return spec ? appListQuery(spec) : undefined;
}

/**
 * Where a row goes: its list, saying which view opened it. Choosing a menu
 * row is choosing that view, so a row without one says so too
 * (`view: undefined`) rather than inheriting the key of the list being left.
 */
export function sidebarView(row: TableItem, tab?: string): ReturnType<typeof tableView> & { view?: string } {
  return { ...tableView(row.table, rowQuery(row), tab), view: row.entry?.id };
}

/* ---------- the store: the filter text and the keyboard's cursor ---------- */

let filter = '';
let cursor = -1;
let cursorAt = -1;
let tick = 0;
const listeners = new Set<() => void>();

function tell(): void {
  tick += 1;
  for (const fn of listeners) fn();
}

export function subscribeSidebar(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export const sidebarVersion = (): number => tick;
export const sidebarFilter = (): string => filter;

/** A new filter is a new list, and the cursor into the old one means nothing. */
export function setSidebarFilter(text: string): void {
  filter = text;
  cursor = -1;
  cursorAt = walkVersion();
  tell();
}

export function setSidebarCursor(index: number): void {
  cursor = index;
  cursorAt = walkVersion();
  tell();
}

/** The keyboard's row while the walk stands still; the current room once it moves. */
export function effectiveCursor(currentIndex: number): number {
  return cursorAt === walkVersion() ? cursor : currentIndex;
}

/* A menu row's count, where the list is work (shared/menuCounts.ts): what the server is asked, and whether it is late. */
function countedRow(
  table: string,
  entry: ListSpec,
  machine: CountedMachine | undefined,
  segments: Record<string, string> | undefined,
): { counted?: NavCountSpec; late?: true } {
  const condition = entry.countQuery ?? entry.query ?? '';
  const { counted, late } = menuCount(condition, machine, entry.count, segments);
  if (!counted) return {};
  return { counted: { table, condition }, ...(late ? { late: true as const } : {}) };
}
