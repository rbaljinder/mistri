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
import { formPageId, isListRoom, viewRoom, type ShownApp } from './appRooms.js';
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

/** The palette's words for a line: "New ticket" — a noun keeps its own case after the verb; a name like "SLA" keeps its capitals. */
const phrase = (entry: NewMenuEntry): string =>
  /^[A-Z][a-z]/.test(entry.label) ? entry.label.charAt(0).toLowerCase() + entry.label.slice(1) : entry.label;

/**
 * The same lines as the palette lists them, searchable ("new supplier"). The
 * palette (Palette.tsx) fetches this module when it opens over an App that
 * declares the menu, so none of this is in the first page.
 */
export function newPaletteItems(
  app: NewMenuApp | null | undefined,
): Array<{ kind: 'action'; label: string; search: string; run: () => void }> {
  if (!app) return [];
  return appNewEntries(app).map((entry) => {
    const label = say('newThing', { thing: phrase(entry) });
    return { kind: 'action', label, search: label, run: () => openNewEntry(app, entry) };
  });
}
