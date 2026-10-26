/**
 * The Connections screen: every connection the server has, its state, and
 * what can be done to it. Changes apply to this session straight away;
 * nothing is written to disk until you save. Full-bleed on purpose — a
 * place you finish and leave — with the wordmark so it still reads as
 * tablewalk's own room.
 */
import { useEffect, useRef, useState } from 'react';
import { api, state, toast, trapFocus } from '@mistriwork/kit/client/core.js';
import type { PublicConnection } from '@mistriwork/engine/shared/connection.js';
import { formatNumber } from '@mistriwork/kit/client/locale.js';
import { say } from '../copy/workbench/components/ConnectionManager.js';
import { addHostListener, removeHostListener, shellQuery } from '@mistriwork/kit/client/shellHost.js';

export type Connection = Pick<PublicConnection, 'id' | 'name'> & Partial<Omit<PublicConnection, 'id' | 'name'>>;
export interface ConnectionManagerProps {
  onClose: () => void;
  /** Open a connection: the manager closes first. */
  onOpen: (conn: Connection) => void;
  onAdd: (refresh: () => Promise<void>) => void;
  onEdit: (conn: Connection, refresh: () => Promise<void>) => void;
  onRemove: (conn: Connection, refresh: () => Promise<void>) => void;
  onSaveFile: (count: number) => void;
  onIntrospect: (conn: Connection) => Promise<void>;
}

export function ConnectionManager({ onClose, onOpen, onAdd, onEdit, onRemove, onSaveFile, onIntrospect }: ConnectionManagerProps) {
  const inner = useRef<HTMLDivElement>(null);
  const filter = useRef<HTMLInputElement>(null);
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [needle, setNeedle] = useState('');
  const [cursor, setCursor] = useState(-1);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const pending = useRef(new Set<string>());
  const alive = useRef(true);
  const generation = useRef(0);
  const active = (state as { activeConnection?: string }).activeConnection;

  const refresh = async () => {
    if (!alive.current) return;
    const request = ++generation.current;
    const current = () => alive.current && request === generation.current;
    try {
      const data = await api('/api/connections');
      if (!current()) return;
      setConnections(data.connections ?? []);
    } catch (err) {
      if (!current()) return;
      toast((err as Error).message, 'error');
      setConnections((was) => was ?? []);
    }
  };
  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const release = trapFocus(inner.current!.parentElement ?? inner.current!) as (() => void) | undefined;
    return () => release?.();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Not while a dialog of our own is on top of us, and not mid-edit.
      if (shellQuery('dialog[open], .modal[role="dialog"], .modal[role="alertdialog"]')) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        (document.activeElement as HTMLElement).blur();
        return;
      }
      e.preventDefault();
      onClose();
    };
    addHostListener(document, 'keydown', onKey, true);
    return () => removeHostListener(document, 'keydown', onKey, true);
  }, [onClose]);

  const all = connections ?? [];
  const q = needle.trim().toLowerCase();
  const shown = q ? all.filter((c) => `${c.name} ${c.detail} ${c.dialect} ${c.source}`.toLowerCase().includes(q)) : all;
  const open = (conn: Connection) => {
    onClose();
    if (conn.id !== active) onOpen(conn);
  };
  const introspect = async (conn: Connection) => {
    if (pending.current.has(conn.id)) return;
    pending.current.add(conn.id);
    setBusy((was) => new Set(was).add(conn.id));
    try {
      await onIntrospect(conn);
    } catch (err) {
      if (alive.current) toast((err as Error).message, 'error');
    } finally {
      pending.current.delete(conn.id);
      if (alive.current) {
        setBusy((was) => {
          const next = new Set(was);
          next.delete(conn.id);
          return next;
        });
        await refresh();
      }
    }
  };
  const onFilterKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (shown.length) setCursor((cursor + 1 + shown.length) % shown.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (shown.length) setCursor((cursor - 1 + shown.length) % shown.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // No explicit highlight means the obvious one: the only match, or the first.
      const conn = shown[cursor >= 0 ? cursor : 0];
      if (conn) open(conn);
    }
  };
  useEffect(() => {
    inner.current?.querySelectorAll<HTMLElement>('.conn-row')[cursor]?.scrollIntoView?.({ block: 'nearest' });
  }, [cursor]);

  return (
    <div className="conn-inner" ref={inner}>
      <div className="conn-head">
        <div className="conn-head-titles">
          <div className="conn-brand" aria-hidden="true">
            <span className="brand-mark" />
            <span className="conn-brand-name">tablewalk</span>
          </div>
          <h2>{say('connections')}</h2>
          <p className="conn-lede">{say('changesApplyToThisSession')}</p>
        </div>
        <div className="conn-head-actions">
          <button type="button" className="ghost" onClick={() => onAdd(refresh)}>
            {say('add')}
          </button>
          <button type="button" className="ghost" onClick={() => onSaveFile(all.length)}>
            {say('saveToFile')}
          </button>
          <button type="button" onClick={onClose}>
            {say('common.done')}
          </button>
        </div>
      </div>
      <div className="conn-toolbar">
        <input
          ref={filter}
          type="search"
          className="conn-filter"
          placeholder={say('filterConnections')}
          aria-label={say('filterConnectionsLabel')}
          value={needle}
          onChange={(e) => {
            setNeedle(e.currentTarget.value);
            setCursor(-1);
          }}
          onKeyDown={onFilterKey}
        />
        <span className="conn-count">
          {q
            ? say('shownOfAll', { shown: formatNumber(shown.length), all: formatNumber(all.length) })
            : say('countConnections', { count: all.length })}
        </span>
      </div>
      <div className="conn-list" role="listbox" aria-label={say('connections')}>
        {connections === null ? (
          <p className="loading">{say('readingConnections')}</p>
        ) : !all.length ? (
          <p className="note">{say('noConnectionsAddOne')}</p>
        ) : !shown.length ? (
          <p className="note">{say('nothingMatches', { needle: needle.trim() })}</p>
        ) : (
          shown.map((conn, i) => (
            <Row
              key={conn.id}
              conn={conn}
              active={conn.id === active}
              cursor={i === cursor}
              busy={busy.has(conn.id)}
              onOpen={() => open(conn)}
              onEdit={() => onEdit(conn, refresh)}
              onIntrospect={() => void introspect(conn)}
              onRemove={() => onRemove(conn, refresh)}
            />
          ))
        )}
      </div>
      {/* Said once, where someone is about to type a password. */}
      <div className="conn-note">
        <p>{say('passwordsTablewalkStoresNone')}</p>
        <ul>
          <li>{say('expandedFromTheEnvironment', { example: 'postgres://app:${PROD_PASSWORD}@host/db' })}</li>
          <li>{say('theMacosKeychainLooked')}</li>
          <li>{say('aCredentialsFileAtMode')}</li>
        </ul>
      </div>
    </div>
  );
}

function Row({
  conn,
  active,
  cursor,
  busy,
  onOpen,
  onEdit,
  onIntrospect,
  onRemove,
}: {
  conn: Connection;
  active: boolean;
  cursor: boolean;
  busy: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onIntrospect: () => void;
  onRemove: () => void;
}) {
  const status = busy
    ? { tone: 'busy', text: say('reading') }
    : conn.error
      ? { tone: 'bad', text: say('willNotOpen') }
      : conn.connected
        ? { tone: 'ok', text: say('tables', { count: conn.tables ?? 0 }) }
        : { tone: 'idle', text: say('notOpened') };
  /* The row itself opens the connection; an action inside it must not also do that on its way through. */
  const action = (label: string, title: string, run: () => void, extra = '') => (
    <button
      type="button"
      disabled={busy}
      className={`conn-action ${extra}`}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        run();
      }}
    >
      {label}
    </button>
  );
  return (
    <div
      className={`conn-row${active ? ' active' : ''}${conn.error ? ' failed' : ''}${cursor ? ' cursor' : ''}${busy ? ' busy' : ''}`}
      role="option"
      aria-selected={cursor}
      tabIndex={0}
      title={active ? say('alreadyOpen') : say('openName', { name: conn.name })}
      onClick={() => {
        if (!busy) onOpen();
      }}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          if (!busy) onOpen();
        }
      }}
    >
      <span className={`conn-dot ${status.tone}`} aria-hidden="true" />
      <span className="conn-name">
        <span className="conn-name-text">{conn.name}</span>
        {active ? <span className="conn-badge current">{say('current')}</span> : null}
      </span>
      {/* Host and database, or a file name. Never a password. */}
      <span className="conn-detail" title={conn.detail}>
        {conn.detail}
      </span>
      <span className="conn-meta">
        <span className="conn-badge">{conn.dialect}</span>
        <span className={`conn-badge source-${conn.source}`}>{conn.source}</span>
        {conn.secret && conn.secret !== 'none' ? (
          <span className="conn-badge" title={say('password', { secret: conn.secret })}>
            {conn.secret}
          </span>
        ) : null}
        {/* Said where the connection is chosen: this one answers the schema and nothing out of its rows. */}
        {conn.rows === false ? (
          <span className="conn-badge shape-only" title={say('shapeOnlyTheCatalog')}>
            {say('shapeOnly')}
          </span>
        ) : null}
      </span>
      <span className={`conn-status ${status.tone}`}>{status.text}</span>
      <span className="conn-actions">
        {action(say('edit'), say('editName', { name: conn.name }), onEdit)}
        {busy ? (
          <span className="conn-action working">{say('introspecting')}</span>
        ) : (
          action(say('introspect'), say('readThisDatabasesSchema'), onIntrospect)
        )}
        {action(say('common.remove'), say('remove', { name: conn.name }), onRemove, 'conn-remove')}
      </span>
      {/* The reason a row is red, on its own line under it. */}
      {conn.error ? <p className="conn-error">{conn.error}</p> : null}
      {conn.warning ? <p className="conn-warning">{conn.warning}</p> : null}
    </div>
  );
}
