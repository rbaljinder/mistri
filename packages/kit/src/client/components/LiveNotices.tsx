/**
 * What live sync says where a change from elsewhere lands (docs/design.md, rule 11): the pill over a list that is
 * held, the line under a record's head, and the notice over a draft with the changes laid beside it.
 *
 * Out of flow, all of it: the pill is fixed to the window, the line sits in the head's top row without taking room
 * from it, the notice over a record's draft hangs from the record's head, over the gap above its fields, and a
 * command form's stands in its status line. None of it moves what the reader is looking at. A part of its own
 * (onDemand.tsx), fetched when the first change that needs it arrives.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { api, columnLabel } from '../core.js';
import { shell } from '../shellMode.js';
import { dirtyDraft, pendingCount, sameRow, stagedVersion, subscribeStaged, takeTheirs } from '../write.js';
import { pathEqualityFilter } from '../resourceRequests.js';
import { historyBody } from '@mistriwork/engine/shared/recordReads.js';
import { recordNoun } from '@mistriwork/engine/shared/appNoun.js';
import { dismissEditNotice, liveKeyText, useEditNotice, useRecentChange } from '../liveState.js';
import type { HistoryEntry } from './PageHistory.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { say } from '../copy/record/components/LiveNotices.js';
import './LiveNotices.css';
import { portalRoot } from '../shellHost.js';

/* ---------- the pill over a held list ---------- */

export function LivePill({ held, show }: { held: number | 'many'; show: () => void }) {
  const label = held === 'many' ? say('pillMany') : say('pill', { updates: say('updates', { count: held }) });
  return createPortal(
    <div className="live-pill-host" role="status">
      <button type="button" className="live-pill" onClick={show} aria-label={say('showUpdates')} title={say('showUpdates')}>
        {label}
      </button>
    </div>,
    portalRoot(),
  );
}

/* ---------- who changed it, without leaking ---------- */

/* Tables whose history the reader cannot read (or that keep none): not asked again. */
const NO_HISTORY = new Set<string>();

/* At most one history read a second for a record, however fast its changes come: a busy record's line under its head
   and the notice over its draft both asked again on every live batch, about four reads a second each. The first change
   in a second is asked at once, so it is named as fast as before; the ones after it wait out the second and are asked
   as one, for the newest, so the name said is still the last author's. Shared by everything drawn for the record. */
const READ_GAP = 1000;
interface Paced {
  /** The change the name is read for now, and the newest one offered. */
  asked: number;
  newest: number;
  /** When it was last read. */
  read: number;
  timer?: ReturnType<typeof setTimeout>;
  readonly listeners: Set<() => void>;
}
const paced = new Map<string, Paced>();
/* The records kept: past it, the longest-kept one nothing draws is let go. */
const PACED_MOST = 200;
function pacedFor(id: string): Paced {
  let found = paced.get(id);
  if (!found) {
    paced.set(id, (found = { asked: 0, newest: 0, read: -Infinity, listeners: new Set() }));
    for (const [other, p] of paced) {
      if (paced.size <= PACED_MOST) break;
      if (!p.listeners.size && !p.timer) paced.delete(other);
    }
  }
  return found;
}
function subscribePaced(id: string, listener: () => void): () => void {
  const p = pacedFor(id);
  p.listeners.add(listener);
  return () => p.listeners.delete(listener);
}
function offerChange(id: string, at: number): void {
  const p = pacedFor(id);
  if (at <= p.newest) return;
  p.newest = at;
  if (p.timer) return;
  const ask = () => {
    p.timer = undefined;
    p.read = Date.now();
    p.asked = p.newest;
    for (const listener of p.listeners) listener();
  };
  const wait = p.read + READ_GAP - Date.now();
  if (wait <= 0) ask();
  else p.timer = setTimeout(ask, wait);
}
/** Tests only: forget every record's pace. */
export function resetChangedBy(): void {
  for (const p of paced.values()) clearTimeout(p.timer);
  paced.clear();
}

/**
 * The name of the newest author of a record, by the record's history under the reader's own grants: undefined where
 * the reader may not read it (the server answers as it does for anyone) or it names no person. The event itself
 * never carries an actor.
 */
function useChangedBy(table: TableMeta, key: Readonly<Record<string, unknown>>, at: number, wanted: boolean): string | undefined {
  const id = `${table.id}\u0000${liveKeyText(key)}`;
  const subscribe = useCallback((listener: () => void) => subscribePaced(id, listener), [id]);
  const asked = useSyncExternalStore(
    subscribe,
    () => paced.get(id)?.asked ?? 0,
    () => 0,
  );
  useEffect(() => {
    if (wanted && at) offerChange(id, at);
  }, [id, at, wanted]);
  const read = useQuery<string | null>({
    queryKey: ['live-history', table.id, liveKeyText(key), asked],
    enabled: wanted && asked > 0 && !NO_HISTORY.has(table.id),
    retry: false,
    staleTime: 60_000,
    gcTime: 60_000,
    /* The name read for the change before stays while the next is read: no flicker to "someone" between them. */
    placeholderData: (previous) => previous,
    queryFn: async () => {
      try {
        const page = (await api('/api/record-history', historyBody(table, key, 1))) as { entries?: HistoryEntry[] };
        const by = page.entries?.[0]?.by;
        return by && !/[^\s@]+@[^\s@]+\.[^\s@]+/.test(by) ? by : null;
      } catch {
        NO_HISTORY.add(table.id);
        return null;
      }
    },
  });
  return read.data ?? undefined;
}

/* ---------- the line under a record's head ---------- */

const GONE_AFTER = 10 * 60_000;

/**
 * "Updated by Ana just now", for ten minutes, said again each minute; "by you" for the reader's own change in another
 * tab. Not while the reader has a draft of the record: the notice over the draft says it, with what to do about it.
 */
export function LiveUpdatedLine({ table, recordKey }: { table: TableMeta; recordKey: Readonly<Record<string, unknown>> }) {
  useSyncExternalStore(subscribeStaged, stagedVersion, stagedVersion);
  const drafting = sameRow(table.id, recordKey) && pendingCount() > 0;
  const recent = useRecentChange(table.id, liveKeyText(recordKey));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const name = useChangedBy(table, recordKey, recent?.at ?? 0, Boolean(recent && !recent.self));
  if (!recent || drafting || now - recent.at >= GONE_AFTER) return null;
  const minutes = Math.floor((now - recent.at) / 60_000);
  const when = minutes < 1 ? say('justNow') : say('minutesAgo', { count: minutes });
  const who = recent.self ? say('you') : name;
  return (
    <span className="live-updated" role="status">
      {who ? say('updatedBy', { who, when }) : say('updated', { when })}
    </span>
  );
}

/* ---------- the notice over a draft ---------- */

/** What another person changed of the fields the reader is changing, side by side. */
function Review({ table, recordKey }: { table: TableMeta; recordKey: Readonly<Record<string, unknown>> }) {
  const draft = dirtyDraft();
  const columns = draft ? Object.keys(draft.values) : [];
  const theirs = useQuery<Record<string, unknown> | null>({
    // A copy of its own: the record the form is drawn from is not read over a draft.
    queryKey: ['live-review', table.id, liveKeyText(recordKey), columns.join(',')],
    enabled: columns.length > 0,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    queryFn: async () => {
      const reply = (await api('/api/view/run', {
        count: 'none',
        view: {
          id: `live:${table.id}`,
          name: table.name,
          base: table.id,
          columns: columns.map((path) => ({ path })),
          filter: pathEqualityFilter(recordKey as Record<string, unknown>),
          limit: 1,
        },
      })) as { rows?: Array<Record<string, unknown>> };
      return reply.rows?.[0] ?? null;
    },
  });
  if (!draft) return null;
  if (theirs.isPending) return <p className="live-review-note">{say('reading')}</p>;
  if (theirs.isError || !theirs.data) return <p className="live-review-note">{say('couldNotRead')}</p>;
  const said = (value: unknown) => (value === null || value === undefined || value === '' ? say('empty') : String(value));
  const differing = columns.filter((column) => said(theirs.data![column]) !== said(draft.originals[column]));
  if (!differing.length) return <p className="live-review-note">{say('nothingDiffers')}</p>;
  return (
    <dl className="live-review" aria-label={say('theirChanges')}>
      {differing.map((column) => (
        <div key={column} className="live-review-field">
          <dt>{(columnLabel(table.id, column) as string | null) ?? column}</dt>
          <dd>
            <span className="live-review-col">
              <small>{say('original')}</small>
              {said(draft.originals[column])}
            </span>
            <span className="live-review-col">
              <small>{say('yours')}</small>
              {said(draft.values[column])}
            </span>
            <span className="live-review-col">
              <small>{say('theirs')}</small>
              {said(theirs.data![column])}
            </span>
            <button type="button" className="ghost" onClick={() => takeTheirs(column, theirs.data![column])}>
              {say('takeTheirs')}
            </button>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * "Ana changed this ticket", beside a draft of that ticket, with Review changes and Keep editing. `anchored` hangs it
 * from the record's head over the gap above the fields, out of flow (a record room's draft); `inline` says it in a
 * form's status line, without Review, since what a command form holds is not the record's fields.
 */
export function LiveEditNotice({
  table,
  recordKey,
  place,
}: {
  table: TableMeta;
  recordKey: Readonly<Record<string, unknown>>;
  place?: 'anchored' | 'inline';
}) {
  const text = liveKeyText(recordKey);
  const notice = useEditNotice(table.id, text);
  const [reviewing, setReviewing] = useState(false);
  /* Asked for this change, not the last one: a second person's change under the same draft names the second person. */
  const name = useChangedBy(table, recordKey, notice?.at ?? 0, Boolean(notice && !notice.self));
  useEffect(() => {
    if (!notice) setReviewing(false);
  }, [notice]);
  if (!notice) return null;
  const record = recordNoun(shell().app()?.resources[table.id]?.noun, table.name);
  const sentence =
    notice.kind === 'delete'
      ? name
        ? say('deletedBy', { name, record })
        : say('deletedBySomeone', { record })
      : notice.self
        ? say('changedByYou', { record })
        : name
          ? say('changedBy', { name, record })
          : say('changedBySomeone', { record });
  if (place === 'inline')
    return (
      <span className="live-notice is-inline">
        <span className="live-notice-text">{sentence}</span>
        <button type="button" className="ghost" onClick={() => dismissEditNotice(table.id, text)}>
          {say('keepEditing')}
        </button>
      </span>
    );
  return (
    <div className={`live-notice${place === 'anchored' ? ' is-anchored' : ''}${reviewing ? ' is-reviewing' : ''}`} role="status">
      <span className="live-notice-text" title={sentence}>
        {sentence}
      </span>
      {notice.kind === 'update' && (
        <button
          type="button"
          className={`ghost${place === 'anchored' ? ' live-act' : ''}`}
          aria-expanded={reviewing}
          onClick={() => setReviewing((on) => !on)}
        >
          {say('review')}
        </button>
      )}
      <button type="button" className={`ghost${place === 'anchored' ? ' live-act' : ''}`} onClick={() => dismissEditNotice(table.id, text)}>
        {say('keepEditing')}
      </button>
      {reviewing && notice.kind === 'update' && <Review table={table} recordKey={recordKey} />}
    </div>
  );
}
