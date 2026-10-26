/**
 * The SQL editor: the last mile of the query language, handed to a
 * connection that cannot write. Two ways in — a statement from scratch, or
 * the one the language compiled to, taken over at the point the language
 * runs out. Why a SQL box at all, at length: `sql.js`.
 *
 * The textarea is uncontrolled on purpose: the completer writes into it
 * directly when a suggestion is accepted, and the value is read when Run
 * is pressed rather than mirrored keystroke by keystroke.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@mistriwork/ui/Button.js';
import { Modal, type ModalHandle } from '@mistriwork/ui/Modal.js';
import { api, go, render, state, toast } from '@mistriwork/kit/client/core.js';
import { attachComplete } from '../complete.js';
import { sqlSuggestions, tokenAt } from '../sqlcomplete.js';
import { promptFor } from '@mistriwork/kit/client/prompt.js';
import { removeStatement, saveStatement, savedStatements } from '../sqlsaved.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { Grid } from '@mistriwork/kit/client/components/Grid.js';
import { say } from '../copy/workbench/components/SqlPane.js';
import { addHostListener, removeHostListener, shellQuery } from '@mistriwork/kit/client/shellHost.js';

interface SqlResult {
  columns: string[];
  rows: unknown[][];
  ms: number;
  truncated?: boolean;
  bounded?: boolean;
  affected?: number;
  errors?: Array<{ message: string }>;
}
interface Statement {
  name: string;
  sql: string;
  description?: string;
  source: 'saved' | 'config';
}
type Outcome =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'error'; message: string }
  | { kind: 'written'; affected: number }
  | { kind: 'rows'; data: SqlResult };

interface SqlPaneProps {
  draft: string;
  onDraft: (text: string) => void;
  onClose: () => void;
}

/* A textarea that grows with its content, to a point. */
function autoGrow(input: HTMLTextAreaElement) {
  input.style.height = 'auto';
  input.style.height = `${Math.min(Math.max(input.scrollHeight, 84), 340)}px`;
}

export function SqlPane({ draft, onDraft, onClose }: SqlPaneProps) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const [savedVersion, bump] = useState(0);
  const [pendingWrite, setPendingWrite] = useState<string | null>(null);
  const schema = (state as { schema?: { label?: string; dialect?: string } }).schema;
  const connections = state as { connections?: Array<{ id: string; writable?: boolean }>; activeConnection?: string };
  const writable = connections.connections?.find((c) => c.id === connections.activeConnection)?.writable;

  useEffect(() => {
    const node = input.current!;
    const detach = attachComplete(node, sqlSuggestions, { anchor: 'caret', split: tokenAt }) as (() => void) | undefined;
    autoGrow(node);
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
    return () => detach?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // The completion list eats Escape first; this only fires when it is closed.
      if (shellQuery('.ac:not([hidden])')) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') {
        (document.activeElement as HTMLElement).blur();
        return;
      }
      e.preventDefault();
      onClose();
    };
    addHostListener(document, 'keydown', onKey, true);
    return () => removeHostListener(document, 'keydown', onKey, true);
  }, [onClose]);

  const setText = (text: string) => {
    onDraft(text);
    if (input.current) {
      input.current.value = text;
      autoGrow(input.current);
    }
  };

  /**
   * Run a statement and render whatever comes back. Errors land beside the
   * editor rather than as a toast that disappears, in the database's own
   * wording because any paraphrase says less.
   */
  const execute = async (text: string, write = false) => {
    const statement = text.trim();
    if (!statement) return;
    setOutcome({ kind: 'running' });
    let data: SqlResult;
    try {
      data = await api('/api/sql', { text: statement, limit: 500, write });
    } catch (err) {
      setOutcome({ kind: 'error', message: (err as Error).message });
      return;
    }
    if (data.errors?.length) {
      setOutcome({ kind: 'error', message: data.errors[0].message });
      return;
    }
    if (write) {
      const affected = data.affected ?? 0;
      toast(`${say('rows', { count: affected })} changed.`, 'ok');
      setOutcome({ kind: 'written', affected });
      // The schema and every open page may now be stale.
      render();
      return;
    }
    setOutcome({ kind: 'rows', data });
  };
  const run = () => void execute(input.current?.value ?? '');

  const save = async () => {
    const statement = (input.current?.value ?? '').trim();
    if (!statement) return;
    const name = await promptFor({
      title: say('nameThisStatement'),
      label: say('common.name'),
      hint: statement.length > 120 ? `${statement.slice(0, 120)}…` : statement,
      placeholder: say('eGCustomersOver'),
    });
    if (!name) return;
    if (saveStatement(name, statement)) {
      toast(say('saved', { name }), 'ok');
      bump((n) => n + 1);
    }
  };

  const saved = savedStatements() as Statement[];
  void savedVersion;
  return (
    <>
      <div className="sql-head">
        <div className="sql-title">
          <span className="sql-eyebrow">SQL</span>
          <span className="sql-target">{`${schema?.label ?? ''} · ${schema?.dialect ?? ''}`}</span>
        </div>
        <div className="sql-head-actions">
          {/* Offered only where the server would allow it. A button that exists to be refused is a button that lies. */}
          {writable ? (
            <Button
              className="sql-write"
              title={say('runThisStatementOnTheWrite')}
              onClick={() => {
                const text = (input.current?.value ?? '').trim();
                if (text) setPendingWrite(text);
              }}
            >
              {say('runAsWrite')}
            </Button>
          ) : null}
          <Button title={say('keepThisStatementUnder')} onClick={() => void save()}>
            {say('save')}
          </Button>
          <Button intent="primary" onClick={run}>
            {say('run')}
          </Button>
          <Button onClick={onClose}>{say('common.done')}</Button>
        </div>
      </div>
      {/* Config-defined and browser-saved together: to whoever is looking for one they are the same thing. */}
      {saved.length ? (
        <div className="sql-saved">
          {saved.map((item) => (
            <span key={`${item.source}:${item.name}`} className={`sql-chip source-${item.source}`}>
              <button type="button" className="sql-chip-open" title={item.description ?? item.sql} onClick={() => setText(item.sql)}>
                {item.name}
              </button>
              {item.source === 'saved' ? (
                <button
                  type="button"
                  className="sql-chip-remove"
                  title={say('forget', { name: item.name })}
                  aria-label={say('forgetName', { name: item.name })}
                  onClick={() => {
                    removeStatement(item.name);
                    bump((n) => n + 1);
                  }}
                >
                  ×
                </button>
              ) : (
                <span className="sql-chip-tag" title={say('definedInTablewalkJson')}>
                  {say('config')}
                </span>
              )}
            </span>
          ))}
        </div>
      ) : (
        <div hidden />
      )}
      <div className="sql-editor">
        <textarea
          ref={input}
          className="sql-input"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          aria-label={say('sqlStatement')}
          placeholder={say('selectFromCustomerWhere')}
          defaultValue={draft}
          onInput={(e) => {
            onDraft(e.currentTarget.value);
            autoGrow(e.currentTarget);
          }}
          onKeyDown={(e) => {
            // ⌘↵ runs. Plain Enter is a newline: a box where Enter submits is a box you cannot write two lines in.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              run();
            }
          }}
        />
      </div>
      <div className="sql-results">
        <Results outcome={outcome} onClose={onClose} />
      </div>
      {pendingWrite !== null && (
        <WriteConfirm statement={pendingWrite} onClose={() => setPendingWrite(null)} onRun={() => void execute(pendingWrite, true)} />
      )}
    </>
  );
}

function Results({ outcome, onClose }: { outcome: Outcome; onClose: () => void }) {
  switch (outcome.kind) {
    case 'idle':
      return null;
    case 'running':
      return <p className="loading">{say('running')}</p>;
    case 'error':
      return (
        <p className="sql-error" role="alert">
          {outcome.message}
        </p>
      );
    case 'written':
      return <p className="note">{`${say('rows', { count: outcome.affected })} changed.`}</p>;
    case 'rows':
      return <RowsResult data={outcome.data} onClose={onClose} />;
  }
}

/** The table whose rows these are, if the columns can say. */
function walkableTable(columns: string[]): TableMeta | null {
  const present = new Set(columns);
  const tables = (state as { schema?: { tables?: TableMeta[] } }).schema?.tables ?? [];
  const candidates = tables.filter((t) => {
    const key = t.columns.filter((c) => c.primaryKey).map((c) => c.name);
    return key.length > 0 && key.every((c) => present.has(c));
  });
  if (!candidates.length) return null;
  /* Several tables can share a key shape — `id` is not distinctive. The one whose other columns also appear is the one the statement is about. */
  const overlap = (table: TableMeta) => table.columns.filter((c) => present.has(c.name)).length;
  return candidates.sort((a, b) => overlap(b) - overlap(a))[0];
}

/**
 * Rows as a grid, walkable when the columns can identify a row. When they
 * cannot, the rows are inert and look it — the grid is given no click.
 */
function RowsResult({ data, onClose }: { data: SqlResult; onClose: () => void }) {
  const target = walkableTable(data.columns);
  /* The wire format is positional so duplicate names survive the trip; rebuilt as objects here. */
  const rows = data.rows.map((row) => Object.fromEntries(data.columns.map((name, i) => [name, row[i]])));
  const open = (row: Record<string, unknown>) => {
    const key: Record<string, unknown> = {};
    for (const column of target!.columns.filter((c) => c.primaryKey)) key[column.name] = row[column.name];
    onClose();
    go({ kind: 'row', table: target!.id, key, label: String(Object.values(key).join('/')) }, 'reset');
  };
  return (
    <>
      <div className="sql-stats">
        <span>{say('rows', { count: data.rows.length })}</span>
        <span>{say('msMs', { ms: data.ms })}</span>
        {/* Said rather than implied: "the front of the answer" is a different fact from "there are more rows". */}
        {data.truncated ? (
          <span className="sql-truncated">
            {data.bounded
              ? say('firstAddALimit', { rowsCount: data.rows.length })
              : say('firstOfWhatTheDatabase', { rowsCount: data.rows.length })}
          </span>
        ) : null}
      </div>
      <div>
        {!data.rows.length ? (
          /* An empty result still knows its shape, and saying so is the difference between "nothing matched" and "something went wrong". */
          <p className="sql-empty">
            <strong>{say('noRows')}</strong>
            <span>
              {data.columns.length
                ? say('theStatementReturnedThese', { columns: data.columns.join(', ') })
                : say('theStatementReturnedNoColumns')}
            </span>
          </p>
        ) : (
          <>
            {target ? <p className="sql-walk">{say('rowsOpenAsRecords', { name: target.name })}</p> : null}
            <div className="grid-host">
              <Grid
                table={target ?? undefined}
                data={{ columns: data.columns, rows }}
                onRowClick={target ? open : undefined}
                virtual={false}
                interactive={false}
              />
            </div>
          </>
        )}
      </div>
    </>
  );
}

/** A write, with the statement in front of you: the question is whether it says what you think it says. */
function WriteConfirm({ statement, onClose, onRun }: { statement: string; onClose: () => void; onRun: () => void }) {
  const dialog = useRef<ModalHandle>(null);
  return (
    <Modal className="confirm" ref={dialog} onClose={onClose}>
      <h2>{say('runThisAsAWrite')}</h2>
      <p>{say('thisRunsOnTheWrite')}</p>
      <pre className="confirm-params">{statement}</pre>
      <div className="confirm-actions">
        <Button onClick={() => dialog.current?.close()}>{say('common.cancel')}</Button>
        <Button
          intent="danger"
          onClick={() => {
            dialog.current?.close();
            onRun();
          }}
        >
          {say('runAsWriteConfirm')}
        </Button>
      </div>
    </Modal>
  );
}
