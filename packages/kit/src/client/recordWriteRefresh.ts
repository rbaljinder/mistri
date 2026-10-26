import { type Query, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { state } from './core.js';
import { connectionGeneration } from './connectionTransition.js';
import { captureSessionIdentity, sessionIdentity } from './sessionIdentity.js';
import { queryClient } from './components/mount.js';
import { composedEpoch } from './composedReads.js';
import { canonicalText } from '@mistriwork/engine/shared/recordReadKeys.js';
import { setOwnWriteMarker } from './ownWrites.js';

type KeyTest = (value: unknown, key: Readonly<Record<string, unknown>>) => boolean;

function sameKey(value: unknown, key: Readonly<Record<string, unknown>>): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === Object.keys(key).length &&
    Object.keys(key).every((name) => Object.hasOwn(candidate, name) && Object.is(candidate[name], key[name]))
  );
}

/** Existing query families are not uniformly connection-qualified. Only inspect
 * them while their captured schema/connection/session is still the current owner.
 * No `key` is any key of the table (live sync's `many`), and `same` is how a query's
 * key is judged to be it: exactly, for a confirmed write; as text, for a change the
 * server announces, whose ids past 2^53 are strings (liveInvalidate.ts). */
export function queryTouches(
  query: QueryKey,
  connection: string,
  table: string,
  key: Readonly<Record<string, unknown>> | undefined,
  primary: readonly string[],
  same: KeyTest = sameKey,
): boolean {
  const is = (value: unknown) => key === undefined || same(value, key);
  switch (query[0]) {
    case 'record':
    case 'references':
      return query[1] === table && is(query[2]);
    case 'page-fields':
      return query[2] === table && is(query[3]);
    case 'run':
      // TableRoom includes connection; Dashboard's three-part key does not.
      // Text queries may include joins, so invalidate their owner's list family.
      return (
        (query.length > 3 && query[1] === connection) ||
        (query.length === 3 && typeof query[1] === 'string' && typeof query[2] === 'number')
      );
    case 'count':
      return query[1] === connection;
    case 'page-list':
      return !!query[1] && typeof query[1] === 'object' && (query[1] as { base?: unknown }).base === table;
    case 'peek':
      return (
        query[1] === connection &&
        query[2] === table &&
        (key === undefined || (typeof query[3] === 'string' && Object.hasOwn(key, query[3]) && same({ v: query[4] }, { v: key[query[3]] })))
      );
    case 'peekpanel': {
      const values = query[3];
      return (
        query[1] === connection &&
        query[2] === table &&
        primary.length > 0 &&
        Array.isArray(values) &&
        values.length === primary.length &&
        (key === undefined || primary.every((name, index) => Object.hasOwn(key, name) && same({ v: values[index] }, { v: key[name] })))
      );
    }
    case 'picker':
    case 'picker-labels':
      return query[1] === connection && query[2] === table;
    default:
      return false;
  }
}

/** Capture before dispatch; invoke only after a confirmed acknowledgement.
 * Stale reads are cancelled before invalidation. Mounted editors retain their
 * confirmed overlay/caret; lists can refresh and records read fresh on remount.
 * Cache failures cannot turn an acknowledged write into a rejected operation. */
export function captureRecordWriteRefresh(table: string, inputKey: Readonly<Record<string, unknown>>): () => void {
  const identity = captureSessionIdentity(),
    schema = state.schema;
  const connection = state.activeConnection ?? '',
    generation = connectionGeneration();
  const key = Object.freeze({ ...inputKey });
  const primary = (schema?.tables?.find((candidate: { id: string }) => candidate.id === table)?.columns ?? [])
    .filter((column: { primaryKey?: boolean }) => column.primaryKey)
    .map((column: { name: string }) => column.name) as string[];
  const owns = () =>
    identity === sessionIdentity() &&
    schema === state.schema &&
    connection === (state.activeConnection ?? '') &&
    generation === connectionGeneration();
  let acknowledged = false;
  return () => {
    if (acknowledged || !owns()) return;
    acknowledged = true;
    try {
      const cache = queryClient.getQueryCache();
      const matches = cache.getAll().filter((query) => queryTouches(query.queryKey, connection, table, key, primary));
      // Query object identity also fences a cleared/replaced cache during await.
      const current = (query: Query) => owns() && matches.includes(query) && cache.get(query.queryHash) === query;
      void queryClient
        .cancelQueries({ predicate: current })
        .then(async () => {
          if (!owns()) return;
          await queryClient.invalidateQueries({ predicate: current, refetchType: 'none' });
          if (!owns()) return;
          await queryClient.refetchQueries({
            type: 'active',
            predicate: (query) => current(query) && !['record', 'page-fields', 'references'].includes(String(query.queryKey[0])),
          });
        })
        .catch(() => {
          /* Read reconciliation has no authority over the write outcome. */
        });
    } catch {
      /* A disposed cache does not invalidate a confirmed mutation. */
    }
  };
}

/**
 * A write landed on the record on screen — a command, a Save that asked for a
 * repaint, a reply posted from its timeline — so its page re-reads where it
 * stands: every read on it asks again and keeps what it shows until the new
 * answer lands. A routed page used to repaint by replacing its walk entry,
 * which started the room over; its reads, kept only while the room is up,
 * went with it, and the record page stood blank until every one of them had
 * been asked again and the page composed (about 8 s for a tenant's ticket).
 * Dialogs and split panes always refreshed this way.
 *
 * Asked once per write: a command's receipt refreshes the record, and the
 * form's Done (or a one-click verb's end) asks the same of the host a moment
 * later. With no write sent or answered between them (composedReads.ts
 * composedEpoch), the second has nothing new to read, and asking it cancelled
 * the first's reads mid-flight and composed the page a second time (G173).
 */
export function refreshRecordInPlace(
  client: QueryClient,
  record: {
    readonly connection: string;
    readonly table: string;
    readonly key: Readonly<Record<string, unknown>>;
    /** The surface's own reads only, when it has an owner's scope. */
    readonly queryScope?: number;
  },
  fields: boolean,
  /** A change another person made, which no write of this page's sits between: asked again though nothing was sent since
      the last ask. With `since` (liveMark), no read already out is cancelled: one that began before the change is let
      land and asked once more, one that began since is joined (askAgain). */
  again = false,
  since?: number,
): Promise<void> {
  const asked = canonicalText([record.connection, record.table, record.key, record.queryScope ?? null, fields]);
  const epoch = composedEpoch();
  if (!again && refreshed.get(client)?.asked === asked && refreshed.get(client)?.epoch === epoch) return Promise.resolve();
  refreshed.set(client, { asked, epoch });
  /* A write of this page's asks its table's lists and counts again here. A change pushed by someone else does not:
     live sync has already asked each read that change touches, by the tables it names (liveInvalidate.ts), and this
     asked every list and count on the connection once more on top, cancelling those it had just begun. */
  if (since === undefined) captureRecordWriteRefresh(record.table, record.key)();
  /* A write of this page's cancels what was out, since it began before the write; a change pushed by another
     person's write never does, or a steady stream of them starves every read (G211). */
  const ask = (predicate: (query: Query) => boolean, refetch: 'active' | 'none' = 'active'): Promise<void> =>
    since === undefined ? client.invalidateQueries({ predicate, refetchType: refetch }) : askAgain(client, predicate, since, refetch);
  const planned = ask(
    (query) =>
      ['page-root', 'page-plan'].includes(String(query.queryKey[0])) &&
      query.queryKey[1] === record.connection &&
      (record.queryScope === undefined || query.queryKey.at(-1) === record.queryScope),
  );
  const asking: Array<Promise<unknown>> = [planned];
  /* Every page that shows the record's fields, by the record, not by one page's id: a command's receipt does
     not know which page it was run from. */
  if (fields)
    asking.push(
      ask((query) => query.queryKey[0] === 'page-fields' && query.queryKey[2] === record.table && sameKey(query.queryKey[3], record.key)),
    );
  /* With the lists' invalidation above, in the same moment: the verbs' availability follows both as one
     (commandAvailability.ts), and waits for the compose that answers it. */
  asking.push(ask((query) => query.queryKey[0] === 'when' && query.queryKey[1] === record.table));
  /* Every section's read asks again, as the remount did: the write may have
     added a history entry, a timeline row, a flow step or a related row. They
     are marked now and asked once the page's compose is back, which brings
     their answers with it (composedReads.ts): asked beside it, each went out
     on its own (G173). One a new plan has already asked anew is no longer
     stale, so it is not asked twice. */
  const section = (query: Query) => pageSectionRead(query.queryKey, record.table, record.key);
  /* Marked as a pushed change marks: one that has landed since the change already shows it, and is left fresh. */
  void (since === undefined
    ? client.invalidateQueries({ predicate: section, refetchType: 'none' })
    : askAgain(client, section, since, 'none'));
  asking.push(
    planned
      .catch(() => {})
      .then(() => {
        const stale = (query: Query) => section(query) && query.state.isInvalidated;
        return since === undefined ? client.refetchQueries({ type: 'active', predicate: stale }) : askAgain(client, stale, since);
      }),
  );
  return Promise.allSettled(asking).then(() => {});
}

/* ---------- a change another person made: asked again, never cancelled ---------- */

/* One order for the moments that matter here: a change arriving (liveMark) and a read beginning. A read that began
   after a change was marked was answered after its commit, so it already shows it. */
let sequence = 0;
const begun = new WeakMap<QueryClient, WeakMap<Query, number>>();

function readsBegun(client: QueryClient): WeakMap<Query, number> {
  let known = begun.get(client);
  if (known) return known;
  const marks = (known = new WeakMap());
  begun.set(client, marks);
  client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated') return;
    /* A read that failed, or was cancelled and put back as it was (a revert is a setState), showed nothing new: it is
       no longer one that began since, so the change still asks it again. */
    const type = event.action.type;
    if (type === 'fetch') marks.set(event.query, ++sequence);
    else if (type === 'error' || type === 'setState') marks.delete(event.query);
  });
  return known;
}

/** The moment a pushed change arrived, in the order reads begin in; reads of `client` are followed from now on. */
export function liveMark(client: QueryClient): number {
  readsBegun(client);
  return ++sequence;
}
/* A write of this page's is marked as it is answered: its echo on the live stream is measured from there (ownWrites.ts). */
setOwnWriteMarker(() => liveMark(queryClient));

/**
 * Ask the reads `predicate` matches again for a change marked at `since` (liveMark), never cancelling one already out:
 * a read that began before the change is let land and then asked once more, a read that began since is joined, and a
 * read that has landed since is left as it is. Inactive reads are only marked stale. Invalidating instead cancelled
 * and restarted every read in flight, so while changes kept coming faster than a read took, none ever landed (G211).
 */
export async function askAgain(
  client: QueryClient,
  predicate: (query: Query) => boolean,
  since: number,
  refetch: 'active' | 'none' = 'active',
): Promise<void> {
  const marks = readsBegun(client);
  const after = (query: Query) => (marks.get(query) ?? 0) > since;
  const landedSince = (query: Query) => after(query) && query.state.fetchStatus !== 'fetching';
  const matched = client
    .getQueryCache()
    .findAll({ predicate })
    .filter((query) => !landedSince(query));
  if (!matched.length) return;
  await client.invalidateQueries({ predicate: (query) => matched.includes(query), refetchType: 'none' });
  if (refetch === 'none') return;
  const active = matched.filter((query) => query.isActive());
  const behind = active.filter((query) => query.state.fetchStatus === 'fetching' && !after(query));
  /* Joined, not cancelled: each settles as it would have, and is then asked once more. */
  if (behind.length) await client.refetchQueries({ predicate: (query) => behind.includes(query) }, { cancelRefetch: false });
  const asking = active.filter((query) => !landedSince(query));
  if (asking.length) await client.refetchQueries({ predicate: (query) => asking.includes(query) }, { cancelRefetch: false });
}
/* Per cache, the record last asked again and where the writes stood then. */
const refreshed = new WeakMap<QueryClient, { asked: string; epoch: number }>();

/**
 * A command applied to the record on screen. What it changed is that record —
 * its fields, its sections, the verbs its state allows — and the lists and
 * counts it stands in, so those are asked again now. Every other read is only
 * marked stale, to be asked when next shown: refetching the whole cache on a
 * receipt (the shell, other rooms kept in memory) was most of the two dozen
 * requests one command cost a tenant's ticket page (G173).
 */
export function refreshAfterCommand(
  client: QueryClient,
  record: {
    readonly connection: string;
    readonly table: string;
    readonly key: Readonly<Record<string, unknown>>;
    readonly queryScope?: number;
  },
): void {
  void client.invalidateQueries({ predicate: (query) => query.getObserversCount() === 0, refetchType: 'none' });
  refreshRecordInPlace(client, record, true);
}

/* The record page's section reads. Those keyed by the record are matched by
   it; those keyed by the plan the server composed for this record (a related
   list, a timeline, a metric) carry no key of their own, so the whole family
   is marked stale and only what is on screen asks again. */
export const KEYED_SECTION_READS: Readonly<Record<string, { table: number; key: number }>> = {
  'page-history': { table: 1, key: 2 },
  'page-flows': { table: 1, key: 2 },
  'page-link-fields': { table: 3, key: 4 },
  'record-children': { table: 1, key: 2 },
  'record-children-page': { table: 1, key: 2 },
};
export const PLANNED_SECTION_READS = new Set(['page-list', 'page-timeline', 'page-metric', 'page-metric-measure', 'page-breakdown']);

function pageSectionRead(
  query: QueryKey,
  table: string,
  key: Readonly<Record<string, unknown>> | undefined,
  same: KeyTest = sameKey,
): boolean {
  const family = String(query[0]);
  if (PLANNED_SECTION_READS.has(family)) return true;
  if (family === 'page-custom') return query[1] === 'reads' || (query[3] === table && (key === undefined || same(query[4], key)));
  /* What a custom component asked for itself (sdk/hooks.ts useRecord, useRows, useBreakdown) is keyed by a
     resource's name, not the table, and may be a roll-up of the record's own rows, so the family is marked as
     the declared reads are and only what is on screen asks again. Left out, a section drew the status from
     before its page's action until a reload. */
  if (family === 'mistri-ui') return true;
  const at = KEYED_SECTION_READS[family];
  return !!at && query[at.table] === table && (key === undefined || same(query[at.key], key));
}
