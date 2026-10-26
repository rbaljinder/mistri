/**
 * Counting things by something, on screen: the breakdown as a room.
 *
 * A breakdown is not a table view with a GROUP BY on it — the rows are not
 * records: a group cannot be opened, has no key, has nothing pointing at
 * it. So this is its own room, sharing only what is true of every result
 * here (the keyboard cursor, sort as a text edit) through
 * components/Breakdown.tsx. The fetch is a Query keyed by the line and the
 * page, kept for no longer than the room is up; the globals a reply may
 * touch — the error banner, the SQL pane, the history — are touched once
 * the answer is the one on screen. Whether a line is a breakdown at all is
 * the server's rule, imported (shared/breakdowntext.js).
 */
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { $, api, pageSize, setExplain, showErrors, state } from '../core.js';
import { explicitLimit } from '../clauses.js';
import { recordQuery } from '../history.js';
import { BreakdownView, type BreakdownEntry } from './Breakdown.js';
import type { ResourceClientReply } from '@mistriwork/engine/shared/resourceHttp.js';
import { Delayed, GridSkeleton } from './Skeleton.js';
import { say } from '../copy/dashboards/components/BreakdownRoom.js';

type Reply = ResourceClientReply<'/api/breakdown'>;

export function BreakdownRoom({ entry }: { entry: BreakdownEntry }) {
  useEffect(() => {
    const bar = $('query') as HTMLInputElement | null;
    if (bar) bar.value = entry.query;
  }, [entry.query]);
  const asked = explicitLimit(entry.query) as number | null;
  const limit = asked ?? (pageSize() as number);
  const offset = asked ? 0 : (state as { page: number }).page * (pageSize() as number);
  const run = useQuery<Reply>({
    queryKey: ['breakdown', (state as { activeConnection?: string }).activeConnection ?? '', entry.query, limit, offset],
    queryFn: () => api('/api/breakdown', { text: entry.query, limit, offset }),
    staleTime: 0,
    gcTime: 0,
  });
  const data = run.data;
  useEffect(() => {
    if (!data) return;
    showErrors('errors' in data ? data.errors : []);
    setExplain('explain' in data ? data.explain : undefined);
    if (!('errors' in data)) recordQuery(entry.query);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      {run.isError ? (
        <p className="note">{(run.error as Error).message}</p>
      ) : !data ? (
        /* Two columns is the usual size of a breakdown — one key and one
             measure — and a better guess than the base table's column count. */
        <Delayed>
          <div className="host-contents">
            <GridSkeleton columns={2} rows={Math.min(limit, pageSize() as number)} />
          </div>
        </Delayed>
      ) : 'errors' in data ? (
        /* A half-typed breakdown is the normal state of an input box, so
               the messages are the answer rather than a failure. They are
               already in the banner; this is the space where the grid would be. */
        <p className="note">{say('fixTheLineAbove')}</p>
      ) : (
        <BreakdownView entry={entry} data={data} />
      )}
    </div>
  );
}
