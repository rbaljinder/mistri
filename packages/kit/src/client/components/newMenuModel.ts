/**
 * The header's New menu as this browser reads it (`ui.shell.new`, PREVIEW;
 * packages/mistri/src/shared/appNewMenu.ts holds the rule): the served entries this reader
 * may use, and where each one goes. One reading for the two places that list
 * them — the button's menu (NewMenu.tsx) and the palette — so an entry
 * cannot be in one and missing from the other.
 */
import { findTable, go, pageView, tableView } from '../core.js';
import { canInsert } from '../insert.js';
import { newMenuEntries, type NewMenuEntry } from '@mistriwork/engine/shared/servedApp.js';
import { appListQuery, newRecordNoun, type ListSpec } from './appListModel.js';
import { appMenu, appRooms, formPageId, isListRoom, viewRoom, type ShownApp } from './appRooms.js';
import { navigationPaths } from './navigationTree.js';
import { say } from '../copy/shell/components/newMenuModel.js';

type NewMenuApp = Pick<ShownApp, 'views' | 'nav' | 'resources' | 'home' | 'ui' | 'grantedCommands'> & Partial<Pick<ShownApp, 'assistant'>>;

/** "ticket" → "Ticket": a menu line starts with a capital, and a noun is held in the sentence's case. */
const lineCase = (said: string): string => said.charAt(0).toUpperCase() + said.slice(1);

/**
 * The New menu's lines for this reader, in the App's order. A list's line is
 * offered where this reader may add to its table — the gate the list's own
 * New button keeps (`canInsert`) — and a form's where its command was granted.
 */
export function appNewEntries(app: NewMenuApp | null | undefined): NewMenuEntry[] {
  const served = app?.ui.shell?.new;
  if (!app || !served?.length) return [];
  return newMenuEntries(
    served,
    app.views,
    { grantedCommands: app.grantedCommands, canAdd: (table) => canInsert(findTable(table), true) },
    (key, table) => {
      const room = viewRoom(app, key);
      const spec = room && isListRoom(room) ? (room as ListSpec) : {};
      return lineCase(newRecordNoun(spec, findTable(table)?.name ?? table));
    },
  );
}

/**
 * Opens what a line names: a list with its New drawer over it — the address
 * a list's own New gives (`…/new`), so a reload keeps the form open — or the
 * signed-in form's page.
 */
export function openNewEntry(app: NewMenuApp, entry: NewMenuEntry): void {
  const room = viewRoom(app, entry.view);
  if (entry.table !== undefined && room && isListRoom(room)) {
    go({ ...tableView(entry.table, appListQuery(room), 'new'), view: entry.view }, 'reset');
    return;
  }
  go(pageView(formPageId(entry.view), undefined, undefined, room && 'label' in room ? room.label : entry.label), 'reset');
}

/** The palette's words for a list's line: "New ticket" — a noun keeps its own case after the verb; a name like "SLA" keeps its capitals. */
const phrase = (entry: NewMenuEntry): string =>
  /^[A-Z][a-z]/.test(entry.label) ? entry.label.charAt(0).toLowerCase() + entry.label.slice(1) : entry.label;

/** One create line as the palette lists it: its words, what a search matches, its mark, and what it opens. */
interface NewPaletteItem {
  kind: 'create';
  label: string;
  search: string;
  icon?: string;
  run: () => void;
}

/**
 * The same lines as the palette lists them, searchable ("new supplier"). The
 * palette (Palette.tsx) fetches this module when it opens over an App that
 * declares the menu, so none of this is in the first page.
 *
 * A list's line is "New ticket", the verb its button says. A form's line is the
 * command's own words ("Post this month's rent"): putting "New" before a verb
 * made "New post this month's rent". Both are found by "new …", as the menu's
 * button is the thing people reach for.
 */
export function newPaletteItems(app: NewMenuApp | null | undefined): NewPaletteItem[] {
  if (!app) return [];
  return (app.ui.shell?.new?.length ? appNewEntries(app) : listedNewEntries(app)).map((entry) => {
    const made = say('newThing', { thing: phrase(entry) });
    const label = entry.table === undefined ? entry.label : made;
    return {
      kind: 'create',
      label,
      search: label === made ? made : `${label} ${made}`,
      ...(entry.icon === undefined ? {} : { icon: entry.icon }),
      run: () => openNewEntry(app, entry),
    };
  });
}

/**
 * Where the App declares no New menu, what its lists offer: one line per table, the first list of it in the menu's
 * order — the New its list's own button says ("New visit"), where this reader may add to it. A palette over an App
 * with seven lists and a New button on each offered none of them, so "new visit" found nothing.
 */
function listedNewEntries(app: NewMenuApp): NewMenuEntry[] {
  const menu = navigationPaths(appMenu(app)).map(({ entry }) => entry);
  const rooms = [...menu, ...appRooms(app).filter((room) => !menu.some((listed) => listed.id === room.id))];
  const tables = new Set<string>();
  return rooms.flatMap((room): NewMenuEntry[] => {
    if (('error' in room && room.error) || !isListRoom(room) || tables.has(room.table)) return [];
    tables.add(room.table);
    if (!canInsert(findTable(room.table), true)) return [];
    const noun = lineCase(newRecordNoun(room as ListSpec, findTable(room.table)?.name ?? room.table));
    return [{ view: room.id, table: room.table, label: noun, ...(room.icon ? { icon: room.icon as NewMenuEntry['icon'] } : {}) }];
  });
}
