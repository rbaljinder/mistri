/**
 * What a change another person made asks the page to read again.
 *
 * A push is only a notification. It never reloads or re-walks the page and
 * it never patches a row: the queries it touches are asked again through
 * their own paths, so every rule a read has (the grants it was answered
 * under, the row it is scoped to) is the one it always had. Scroll, menus,
 * filters and typed input stay.
 *
 * Which queries a change touches follows the families a confirmed write
 * already keys (recordWriteRefresh.ts): a record, a page's fields, a peek, a
 * picker by table and key; a list by its base. The reads of text (a count, a
 * query, a breakdown, a section's plan) are filed with the tables the server
 * says they answered from (liveReads.ts), and with none filed fall back to
 * their family's rule: an extra read, never a missed one.
 *
 * Only what is on screen is asked; the rest is marked stale and asks when it
 * is next shown. A query is asked at most once a second, once more when it
 * was out as the change came, and at most once in five seconds while changes
 * to it keep coming faster than once a second (more than ten in ten seconds).
 * A read already out is never cancelled: changes that come while it is out
 * wait for it and are answered by one read after it (G211).
 * A list its reader is working in is held (liveEngagement.ts); a record they
 * have a draft of is never read over it, and is said beside it instead.
 */
import type { Query, QueryClient, QueryKey } from '@tanstack/react-query';
import { composedReads } from '@mistriwork/kit/client/composedHook.js';
import { state } from '@mistriwork/kit/client/core.js';
import { dirtyDraft } from '@mistriwork/kit/client/write.js';
import { queryClient } from '@mistriwork/kit/client/components/mount.js';
import {
  askAgain,
  KEYED_SECTION_READS,
  liveMark,
  PLANNED_SECTION_READS,
  queryTouches,
  refreshRecordInPlace,
} from '@mistriwork/kit/client/recordWriteRefresh.js';
import { queryReads } from '@mistriwork/kit/client/liveReads.js';
import { ownWriteMark } from '@mistriwork/kit/client/ownWrites.js';
import {
  announcePulse,
  clearHold,
  editingRecords,
  heldChanged,
  holdFor,
  isEngaged,
  liveKeyText,
  noteRecentChanges,
  raiseEditNotice,
  setDraftedTest,
  setHoldRelease,
  type Hold,
} from '@mistriwork/kit/client/liveState.js';

type Key = Record<string, unknown>;
interface LiveTable {
  /** Each key by its text, or 'many' where the change named none. */
  keys: Map<string, Key> | 'many';
  kinds: Set<string>;
}
export interface LiveBatch {
  tables: Map<string, LiveTable>;
  /** Every change in it was the reader's own. */
  self: boolean;
  reset: boolean;
  /** How many events it holds. */
  events: number;
}
export const emptyBatch = (): LiveBatch => ({ tables: new Map(), self: true, reset: false, events: 0 });

/** One `change` event, merged into a batch. */
export function addChange(
  batch: LiveBatch,
  change: { tables?: Record<string, { keys?: Key[] | 'many'; kinds?: string[] }>; self?: boolean },
): void {
  batch.events++;
  batch.self &&= change.self === true;
  for (const [id, table] of Object.entries(change.tables ?? {})) {
    const into = batch.tables.get(id) ?? { keys: new Map<string, Key>(), kinds: new Set<string>() };
    batch.tables.set(id, into);
    for (const kind of table.kinds ?? []) into.kinds.add(kind);
    if (!Array.isArray(table.keys)) into.keys = 'many';
    else if (into.keys !== 'many') for (const key of table.keys) into.keys.set(liveKeyText(key), key);
  }
}

/** Two keys are one where their columns read the same as text. */
const sameLiveKey = (value: unknown, key: Readonly<Record<string, unknown>>): boolean =>
  !!value && typeof value === 'object' && !Array.isArray(value) && liveKeyText(value as Key) === liveKeyText(key);

/* ---------- which queries a change touches ---------- */

/* Families whose read is a text, filed with the tables it answered from. */
const TEXT = new Set(['run', 'count', 'breakdown', 'measure', 'mistri-ui']);
const PLANNED_TEXT = new Set([...PLANNED_SECTION_READS].filter((family) => family !== 'page-list'));

/** A text read with no tables filed: the rule it has always had after a write. */
function textFallback(key: QueryKey, connection: string): boolean {
  switch (key[0]) {
    case 'run':
      return (key.length > 3 && key[1] === connection) || (key.length === 3 && typeof key[1] === 'string' && typeof key[2] === 'number');
    case 'count':
      return key[1] === connection;
    default:
      return true;
  }
}

function touchedText(query: Query, tables: ReadonlySet<string>, connection: string): boolean {
  const filed = queryReads(query.queryHash);
  return filed ? filed.some((id) => tables.has(id)) : textFallback(query.queryKey, connection);
}

function primaryOf(table: string): string[] {
  const meta = state.schema?.tables?.find((candidate: { id: string }) => candidate.id === table);
  return (meta?.columns ?? [])
    .filter((column: { primaryKey?: boolean }) => column.primaryKey)
    .map((column: { name: string }) => column.name);
}

function touches(query: Query, batch: LiveBatch, connection: string): boolean {
  const key = query.queryKey;
  const family = String(key[0]);
  if (batch.reset) return !family.startsWith('live-');
  const tables = new Set(batch.tables.keys());
  if (TEXT.has(family)) return touchedText(query, tables, connection);
  if (PLANNED_TEXT.has(family)) return touchedText(query, tables, connection);
  if (family === 'page-custom' && key[1] === 'reads') return touchedText(query, tables, connection);
  for (const [table, change] of batch.tables) {
    const inserted = change.kinds.has('insert') || change.kinds.has('delete');
    const keys = change.keys === 'many' ? [undefined] : [...change.keys.values()];
    const primary = primaryOf(table);
    if (keys.some((k) => queryTouches(key, connection, table, k, primary, sameLiveKey))) return true;
    // A record that came or went changes the lists, pickers and children that count it, whichever record it was.
    if (inserted && (family === 'record-children' || family === 'record-children-page') && key[1] === table) return true;
    const at = KEYED_SECTION_READS[family];
    if (at && key[at.table] === table && keys.some((k) => k === undefined || sameLiveKey(key[at.key], k))) return true;
    if (family === 'page-custom' && key[3] === table && keys.some((k) => k === undefined || sameLiveKey(key[4], k))) return true;
  }
  return false;
}

/* ---------- the rate: once a second, and once in five while hot ---------- */

const MIN_GAP = 1_000;
const HOT_GAP = 5_000;
/* Hot is what the changes asking do, not what was asked: more than ten in the last ten seconds, which the one-second
   gap is already dropping some of. Counting the asks made over a minute turned any page watched for a while hot at a
   person's pace — eleven changes a minute is one every five and a half seconds — and every change after that waited
   out the five-second gap (a field report measured 5.0 s from commit to paint). */
const HOT_AFTER = 10;
const HOT_WINDOW = 10_000;
const MINUTE = 60_000;
interface Slot {
  /** When a change asked for it, the last ten seconds' worth. */
  wanted: number[];
  last: number;
  timer?: ReturnType<typeof setTimeout>;
  next?: () => Promise<unknown> | void;
  busy: boolean;
}
const slots = new Map<string, Slot>();

/** Run `ask` for `id` within the rate: now, or when the gap is up. A newer `ask` replaces one waiting. */
function throttled(id: string, ask: () => Promise<unknown> | void): void {
  const slot = slots.get(id) ?? { wanted: [], last: 0, busy: false };
  slots.set(id, slot);
  const now = Date.now();
  slot.wanted = slot.wanted.filter((at) => now - at < HOT_WINDOW);
  slot.wanted.push(now);
  slot.next = ask;
  if (slot.timer || slot.busy) return;
  schedule(id, slot);
}
function schedule(id: string, slot: Slot): void {
  const now = Date.now();
  const hot = slot.wanted.filter((at) => now - at < HOT_WINDOW).length > HOT_AFTER;
  const wait = slot.last + (hot ? HOT_GAP : MIN_GAP) - now;
  const fire = () => {
    slot.timer = undefined;
    const ask = slot.next;
    slot.next = undefined;
    if (!ask) return void slots.delete(id);
    slot.last = Date.now();
    slot.busy = true;
    void Promise.resolve()
      .then(ask)
      .catch(() => {})
      .finally(() => {
        slot.busy = false;
        if (slot.next) schedule(id, slot);
      });
  };
  if (wait <= 0) fire();
  else slot.timer = setTimeout(fire, wait);
}

/** Slots idle for a minute are what a quiet query leaves behind: drop them, with their history. */
function prune(): void {
  const now = Date.now();
  for (const [id, slot] of slots) if (!slot.busy && !slot.timer && !slot.next && now - slot.last > MINUTE) slots.delete(id);
}

/** Stop everything waiting: the page's session or connection ended. */
export function forgetLive(): void {
  for (const slot of slots.values()) clearTimeout(slot.timer);
  slots.clear();
}

/* ---------- asking ---------- */

/* Never a cancel: a read already out when the change came is let land and asked once more after it, and one that began
   since is joined (askAgain). Invalidating cancelled and restarted it, and two paths asking one record's reads (its
   query's slot and the record's refresh) cancelled each other's, so a steady stream of changes starved the paint. */
const refetchQuery = (client: QueryClient, query: Query, since: number) => () =>
  askAgain(client, (candidate) => candidate === query, since);

/** The drafts a change must not be read over: the record form's, and any other form holding what was typed. */
function drafts(): Array<{ table: string; key: Key }> {
  const draft = dirtyDraft();
  return [
    ...(draft ? [{ table: draft.table, key: draft.key as Key }] : []),
    ...editingRecords().map((each) => ({ table: each.table, key: each.key as Key })),
  ];
}

/** Families that carry a record's own fields: a form is drawn from them, so a draft's record is not read over. */
const FORM_FAMILIES = new Set(['record', 'page-fields']);
/* A command form's prepare (CommandForm.tsx) fills its starting values: asked again under typed input, it would fill
   every field not yet typed in with the record's new values, under the reader. */
const preparing = (query: Query, held: ReadonlyArray<{ table: string; key: Key }>): boolean => {
  if (query.queryKey[0] !== 'command-prepare') return false;
  const owner = query.queryKey[2] as { target?: unknown; key?: unknown; keys?: unknown[] } | undefined;
  const keys = [owner?.key, ...(Array.isArray(owner?.keys) ? owner.keys : [])];
  return held.some(({ table, key }) => owner?.target === table && keys.some((each) => sameLiveKey(each, key)));
};
const guarded = (query: Query, held: ReadonlyArray<{ table: string; key: Key }>, connection: string): boolean =>
  preparing(query, held) ||
  (FORM_FAMILIES.has(String(query.queryKey[0])) &&
    held.some(({ table, key }) => queryTouches(query.queryKey, connection, table, key, [], sameLiveKey)));

/**
 * Ask again what a batch of changes touches.
 *
 * @param batch The changes of the last 150 ms, merged (liveSync.ts).
 */
export function invalidateLive(batch: LiveBatch, client: QueryClient = queryClient): void {
  const connection = (state.activeConnection as string | null | undefined) ?? '';
  /* When the change arrived, in the order reads begin in: a read begun after it already shows it. The echo of the
     page's own write had committed when that write was answered, so it is measured from there: what the write's own
     refresh began since already shows it, and is neither asked twice nor stripped of a compose's answers. */
  const arrived = liveMark(client);
  const own = batch.self && !batch.reset ? ownWriteMark() : undefined;
  const since = own ?? arrived;
  /* A refetch is the reader's own read, not a composed page's answer from before the change. */
  if (own === undefined) composedReads()?.forget();
  const held = drafts();
  if (!batch.reset) {
    announcePulse({
      id: Date.now(),
      at: Date.now(),
      tables: new Map([...batch.tables].map(([id, table]) => [id, table.keys === 'many' ? ('many' as const) : new Set(table.keys.keys())])),
    });
    for (const [table, change] of batch.tables) {
      if (change.keys === 'many') continue;
      noteRecentChanges(table, change.keys.keys(), batch.self);
      for (const [text, key] of change.keys)
        if (held.some((draft) => draft.table === table && sameLiveKey(draft.key, key)))
          raiseEditNotice({
            table,
            key: text,
            kind: change.kinds.has('delete') && !change.kinds.has('insert') && !change.kinds.has('update') ? 'delete' : 'update',
            self: batch.self,
          });
    }
  }
  const touched: Query[] = [];
  for (const query of client.getQueryCache().getAll()) if (touches(query, batch, connection)) touched.push(query);
  prune();
  const quiet = touched.filter((query) => !guarded(query, held, connection));
  /* Inactive reads only go stale; they ask again when next shown. */
  const asking = quiet.filter((query) => query.getObserversCount() > 0 && query.isActive());
  const idle = quiet.filter((query) => !asking.includes(query));
  if (idle.length) void client.invalidateQueries({ predicate: (query) => idle.includes(query), refetchType: 'none' });
  for (const query of asking) {
    const hold = holdFor(query.queryKey);
    if (hold && isEngaged()) {
      defer(hold, query, batch);
      continue;
    }
    throttled(`q:${query.queryHash}`, refetchQuery(client, query, since));
  }
  /* A record on screen asks its page as a write to it would: its sections, its verbs. */
  if (!batch.reset)
    for (const [table, change] of batch.tables) {
      if (change.keys === 'many') continue;
      for (const [text, key] of change.keys) {
        if (held.some((draft) => draft.table === table && sameLiveKey(draft.key, key))) continue;
        const shown = client
          .getQueryCache()
          .getAll()
          .some(
            (query) =>
              query.getObserversCount() > 0 &&
              FORM_FAMILIES.has(String(query.queryKey[0])) &&
              queryTouches(query.queryKey, connection, table, key, [], sameLiveKey),
          );
        if (shown) throttled(`r:${table}:${text}`, () => refreshRecordInPlace(client, { connection, table, key }, true, true, since));
      }
    }
}

/* ---------- a list that is held ---------- */

function defer(hold: Hold, query: Query, batch: LiveBatch): void {
  hold.queries.add(query.queryHash);
  for (const [table, change] of batch.tables) {
    if (table !== hold.table && !(queryReads(query.queryHash) ?? []).includes(table)) continue;
    if (batch.reset || change.keys === 'many') hold.keys = 'many';
    else if (hold.keys !== 'many') for (const text of change.keys.keys()) hold.keys.add(text);
  }
  if (batch.reset) hold.keys = 'many';
  heldChanged();
}

/** Show a held list its changes: its reads asked again now, and the pill gone. */
export function showHeld(hold: Hold, client: QueryClient = queryClient): void {
  const hashes = new Set(hold.queries);
  clearHold(hold);
  const since = liveMark(client);
  for (const query of client.getQueryCache().getAll())
    if (hashes.has(query.queryHash)) throttled(`q:${query.queryHash}`, refetchQuery(client, query, since));
}
setHoldRelease((hold) => showHeld(hold));
setDraftedTest((table, key) => {
  const draft = dirtyDraft();
  return Boolean(draft && draft.table === table && liveKeyText(draft.key as Key) === key);
});
