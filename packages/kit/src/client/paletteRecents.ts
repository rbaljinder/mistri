/**
 * Where this person has just been in an App, for the palette's Recent group: the rooms they opened and the records
 * they read, newest first.
 *
 * Kept in memory for the page's life and nowhere else: a record's name is the reader's data, so it is not written to
 * storage and not asked of the server (the palette answers from what the walk already knew), and it is forgotten when
 * the session changes hands (`subscribeSessionIdentity`) as every other private thing the client holds is.
 */
import { ASSISTANT_ROOM } from '@mistriwork/engine/shared/servedApp.js';
import { ASSISTANT_PAGE, dashViewKey, formViewKey } from './components/appRooms.js';
import { subscribeSessionIdentity } from './sessionIdentity.js';

/** What the walk's entry says about where it stands; only what a visit reads. */
interface WalkEntry {
  kind?: string;
  view?: unknown;
  pageId?: unknown;
  table?: unknown;
  key?: unknown;
  label?: unknown;
}

export type Visit = { id: string; room: string } | { id: string; table: string; key: Record<string, unknown>; label: string };

/** A shortlist, not a log: the palette shows a handful, and the ones it drops for being where you are need spares. */
const MOST = 8;

let visits: Visit[] = [];
let here: string | undefined;

const isKey = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** One record is one visit however it was reached: a key's values compare as text, as pagemarks.js does (5 and "5"). */
function recordId(table: string, key: Record<string, unknown>): string {
  return `record:${table}:${JSON.stringify(
    Object.keys(key)
      .sort()
      .map((name) => [name, key[name] == null ? null : String(key[name])]),
  )}`;
}

/** The visit a walk entry is, or undefined for one that is no place worth coming back to (a drawer, a page with nothing chosen). */
function visitOf(entry: WalkEntry): Visit | undefined {
  if (entry.kind === 'table' && typeof entry.view === 'string') return { id: `room:${entry.view}`, room: entry.view };
  if (entry.kind === 'page' && typeof entry.pageId === 'string' && !entry.key) {
    const room = dashViewKey(entry.pageId) ?? formViewKey(entry.pageId) ?? (entry.pageId === ASSISTANT_PAGE ? ASSISTANT_ROOM : undefined);
    return room === undefined ? undefined : { id: `room:${room}`, room };
  }
  /* A record, on its row's entry or on a page rooted at it. Its name may arrive a tick after it (a link carries only the
     key), and a visit with no name is nothing to say in a list, so it is noted once it has one. */
  if (
    (entry.kind === 'row' || entry.kind === 'page') &&
    typeof entry.table === 'string' &&
    isKey(entry.key) &&
    typeof entry.label === 'string' &&
    entry.label
  ) {
    return { id: recordId(entry.table, entry.key), table: entry.table, key: entry.key, label: entry.label };
  }
  return undefined;
}

/** Note where the walk now stands. Called on every tick of the walk, so a repeat is cheap and moves nothing. */
export function noteVisit(entry: WalkEntry | undefined): void {
  const visit = entry ? visitOf(entry) : undefined;
  here = visit?.id;
  if (!visit) return;
  const at = visits.findIndex((seen) => seen.id === visit.id);
  if (at === 0) {
    visits[0] = visit;
    return;
  }
  visits = [visit, ...visits.filter((seen) => seen.id !== visit.id)].slice(0, MOST);
}

/** The visits before this one, newest first: where you were, which is not where you are. */
export function recentVisits(): Visit[] {
  return visits.filter((visit) => visit.id !== here);
}

/** Forget everything (the session changed hands, or a test starts over). */
export function forgetVisits(): void {
  visits = [];
  here = undefined;
}

subscribeSessionIdentity(forgetVisits);
