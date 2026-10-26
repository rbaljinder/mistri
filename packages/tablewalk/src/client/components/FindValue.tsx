/**
 * Which table mentions this?
 *
 * The question you have when a string arrives from somewhere else — an id
 * in a stack trace, a reference from a ticket — and you do not yet know
 * which table it belongs to. Every other search here starts by naming a
 * table, which is precisely what you cannot do yet. The sweep behind it is
 * the `find` tool the MCP server offers, run through the same endpoint an
 * agent uses, so the two sides agree about what a match is, what is capped
 * and what was skipped. The answer keeps everything the sweep is honest
 * about: an empty result is only "not in this database" when nothing
 * failed and nothing stopped early, and the panel says which it was.
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, findTable, openRecord, state } from '@mistriwork/kit/client/core.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { Modal, type ModalHandle } from '@mistriwork/ui/Modal.js';
import { say } from '../copy/workbench/components/FindValue.js';

interface Match {
  table: string;
  key?: Record<string, unknown>;
  columns?: string[];
  values?: Record<string, unknown>;
}
interface Answer {
  matches?: Match[];
  searched?: number;
  moreIn?: string[];
  failed?: Array<{ table: string }>;
  stopped?: string;
  unreached?: number;
}
interface Reply {
  isError?: boolean;
  content?: Array<{ text?: string }>;
  structuredContent?: Answer;
}

export function FindValueDialog({ initial = '', onClose }: { initial?: string; onClose: () => void }) {
  const dialog = useRef<ModalHandle>(null);
  const input = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState(initial);
  const [asked, setAsked] = useState(initial.trim());
  /* Slower than a filter box on purpose: each keystroke is a scan of every
     table, not a filter over rows already in hand. Enter asks at once. */
  useEffect(() => {
    const timer = setTimeout(() => setAsked(typed.trim()), 450);
    return () => clearTimeout(timer);
  }, [typed]);
  const found = useQuery<Reply>({
    queryKey: ['find', (state as { activeConnection?: string }).activeConnection ?? '', asked],
    queryFn: () => api('/api/agent/call', { name: 'find', arguments: { value: asked } }),
    enabled: asked.length > 0,
    staleTime: 0,
  });
  const close = () => dialog.current?.close();
  return (
    <Modal
      className="conn-manager find-value"
      ref={dialog}
      onClose={onClose}
      initialFocus={input}
      aria-label={say('findAValue')}
      plain
      backdrop={false}
    >
      <div className="conn-inner">
        <div className="conn-head">
          <h2>{say('findAValue')}</h2>
          <button type="button" className="ghost" aria-label={say('common.close')} onClick={close}>
            ×
          </button>
        </div>
        <p className="find-note">{say('searchesTheTextColumns')}</p>
        <input
          ref={input}
          type="search"
          className="find-input"
          placeholder={say('aValueAName')}
          aria-label={say('valueToLook')}
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(e) => setTyped(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              setAsked(typed.trim());
            }
          }}
        />
        <div className="find-results">
          {!asked ? null : found.isPending ? (
            <p className="loading">{say('looking', { asked })}</p>
          ) : found.isError ? (
            <p className="note">{(found.error as Error).message}</p>
          ) : found.data?.isError ? (
            <p className="note">{found.data.content?.[0]?.text ?? say('thatSearchFailed')}</p>
          ) : (
            <Report answer={found.data?.structuredContent ?? {}} value={asked} onOpen={close} />
          )}
        </div>
      </div>
    </Modal>
  );
}

function Report({ answer, value, onOpen }: { answer: Answer; value: string; onOpen: () => void }) {
  const matches = answer.matches ?? [];
  const byTable = new Map<string, Match[]>();
  for (const match of matches) byTable.set(match.table, [...(byTable.get(match.table) ?? []), match]);
  return (
    <>
      {!matches.length ? <p className="note">{say('nothingInTablesHolds', { count: answer.searched ?? 0, sought: value })}</p> : null}
      {[...byTable].map(([tableId, found]) => {
        const table = findTable(tableId) as TableMeta | undefined;
        return (
          <div key={tableId} className="find-group">
            <h3 className="find-group-head">
              <span>{table?.name ?? tableId}</span>
              <span className="find-count">{`${found.length}${answer.moreIn?.includes(tableId) ? '+' : ''}`}</span>
            </h3>
            {found.map((match, i) => (
              /* The key is what makes a match walkable; without one there is nothing to open, so it reads rather than pretends to be a link. */
              <button
                key={i}
                type="button"
                className="find-hit"
                disabled={!match.key}
                title={match.key ? say('openTable', { table: tableId }) : say('thisTableHasNoKey')}
                onClick={() => {
                  onOpen();
                  void openRecord(tableId, match.key, Object.values(match.values ?? {})[0] ?? String(Object.values(match.key ?? {})[0]));
                }}
              >
                <span className="find-hit-columns">{(match.columns ?? []).join(', ')}</span>
                <span className="find-hit-value">{Object.values(match.values ?? {}).join(' · ')}</span>
              </button>
            ))}
          </div>
        );
      })}
      {/* What the sweep could not do, whether or not anything was found: a failed table is the difference between "not here" and "not looked". */}
      {answer.failed?.length ? (
        <p className="note find-warn">
          <strong>{say('tablesCouldNotBeSearched', { count: answer.failed.length })}</strong>
          <span>{answer.failed.map((f) => f.table).join(', ')}</span>
        </p>
      ) : null}
      {answer.stopped ? (
        <p className="note find-warn">
          {answer.unreached
            ? say('stoppedAtWithUnread', { stopped: answer.stopped, count: answer.unreached })
            : say('stoppedAtTheNarrow', { stopped: answer.stopped })}
        </p>
      ) : null}
    </>
  );
}
