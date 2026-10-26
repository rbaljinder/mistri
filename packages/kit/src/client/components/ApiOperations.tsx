/**
 * The explorer's API tab, on a table read from an HTTP connection: the
 * resource's two documented reads — its list GET and its item GET — as a
 * form drawn from the description alone, sent by the server, and answered
 * exactly as the API answered.
 *
 * Narrower than a request builder on purpose. The browser never names a URL,
 * a header or a parameter the description does not declare: the server builds
 * the request from the description, attaches the connection's credential and
 * sends it through egress, then says back the path, the query string, the
 * status and the body — never a header (packages/engine/src/server/http/httpOperationRoutes.ts).
 * A list's question can be opened as the table view asking the same thing,
 * where its parameters are filters and a sort the table view can say.
 */
import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, go, quote, state, tableView } from '../core.js';
import type { HttpOperationReply, HttpOperations, HttpParam } from '@mistriwork/engine/shared/httpOperations.js';
import { JsonView } from './JsonView.js';
import { Delayed, GridSkeleton } from './Skeleton.js';
import { say } from '../copy/workbench/components/ApiOperations.js';

type Kind = 'list' | 'item';
interface SchemaLike {
  dialect?: string;
  tables?: Array<{ id: string; columns: Array<{ name: string }> }>;
}
const schema = () => (state as { schema?: SchemaLike | null }).schema ?? null;
const connection = () => (state as { activeConnection?: string | null }).activeConnection ?? '';

/* What a box is, said under it; a filter's own label is its column. */
const HINT: Record<HttpParam['kind'], string> = {
  filter: 'equals',
  search: say('theApisOwnSearch'),
  sort: '',
  offset: say('rowsToSkip'),
  limit: say('rowsPerPage'),
  page: say('pageNumber'),
  size: 'rows per page',
  cursor: '',
};

/** RFC 6901: where a cursor-paged answer names its next page. */
function at(value: unknown, pointer: string): unknown {
  let current = value;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    current =
      current && typeof current === 'object' && !Array.isArray(current) && Object.hasOwn(current, key)
        ? (current as Record<string, unknown>)[key]
        : undefined;
  }
  return current;
}

/* A documented sort value as the table view says it — "-shipped_at" is "sort
   shipped_at desc" — the spellings the adapter itself reads. Undefined when
   the value names no column of the table. */
function sortClause(value: string, columns: readonly string[]): string | undefined {
  const suffixed = /^(.+?)(?::| |_)(asc|desc)$/.exec(value);
  const spelled = value.startsWith('-')
    ? { column: value.slice(1), desc: true }
    : value.startsWith('+')
      ? { column: value.slice(1), desc: false }
      : suffixed
        ? { column: suffixed[1], desc: suffixed[2] === 'desc' }
        : { column: value, desc: false };
  if (!columns.includes(spelled.column)) return undefined;
  return `sort ${spelled.column}${spelled.desc ? ' desc' : ''}`;
}

/**
 * The table view's question for a list's parameters, or undefined when a
 * parameter has no equivalent there: the API's search is its own, and a
 * sort value that names no column cannot be said.
 */
function tableQuery(table: string, params: readonly HttpParam[], values: Record<string, string>): string | undefined {
  const columns =
    schema()
      ?.tables?.find((each) => each.id === table)
      ?.columns.map((column) => column.name) ?? [];
  const conditions: string[] = [];
  let sort = '';
  for (const param of params) {
    const value = (values[param.name] ?? '').trim();
    if (!value) continue;
    if (param.kind === 'search') return undefined;
    if (param.kind === 'filter' && param.column) {
      const each = param.many
        ? value
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
        : [value];
      conditions.push(each.length > 1 ? `${param.column} in (${each.map(quote).join(', ')})` : `${param.column} = ${quote(each[0])}`);
    }
    if (param.kind === 'sort') {
      const clause = sortClause(value, columns);
      if (!clause) return undefined;
      sort = clause;
    }
  }
  return [table, conditions.join(' and '), sort].filter(Boolean).join(' ');
}

function ParamField({ param, value, onChange }: { param: HttpParam; value: string; onChange: (value: string) => void }) {
  const label = param.kind === 'filter' ? (param.column ?? param.name) : param.kind === 'search' ? say('navigation.search') : param.name;
  const hint =
    param.kind === 'filter'
      ? `${param.many ? say('oneValueOrSeveral') : HINT.filter} · ?${param.name}=`
      : HINT[param.kind]
        ? `${HINT[param.kind]} · ?${param.name}=`
        : `?${param.name}=`;
  return (
    <label className="field-stack">
      <span>{label}</span>
      {param.kind === 'sort' ? (
        <select value={value} onChange={(event) => onChange(event.target.value)} aria-label={label}>
          <option value="">{say('theApisOwnOrder')}</option>
          {(param.values ?? []).map((each) => (
            <option key={each} value={each}>
              {each}
            </option>
          ))}
        </select>
      ) : (
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label={label}
          inputMode={['offset', 'limit', 'page', 'size'].includes(param.kind) ? 'numeric' : undefined}
        />
      )}
      <span className="field-hint">{hint}</span>
    </label>
  );
}

function Answer({ reply }: { reply: HttpOperationReply }) {
  const line = `${reply.request.method} ${reply.request.path}${reply.request.query ? `?${reply.request.query}` : ''}`;
  const answered = reply.status >= 200 && reply.status <= 299;
  return (
    <section className="api-answer" aria-label={say('theApisAnswer')}>
      <p className="api-request">
        <code>{line}</code>
        <span className="api-meta">{say('statusTime', { status: reply.status, ms: reply.ms })}</span>
      </p>
      {!answered ? (
        <p className="note">{say('theApiAnsweredTablewalk', { status: reply.status })}</p>
      ) : reply.json !== null && typeof reply.json === 'object' ? (
        <JsonView value={reply.json} />
      ) : (
        <pre className="ddl">{JSON.stringify(reply.json)}</pre>
      )}
    </section>
  );
}

export function ApiOperations({ table }: { table: string }) {
  const described = useQuery<HttpOperations>({
    queryKey: ['api-operations', connection(), table],
    queryFn: () => api('/api/http/operations', { resource: table }) as Promise<HttpOperations>,
  });
  const [kind, setKind] = useState<Kind>('list');
  const [values, setValues] = useState<Record<string, string>>({});
  const [key, setKey] = useState('');
  const [reply, setReply] = useState<HttpOperationReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (described.isError) return <p className="note">{(described.error as Error).message}</p>;
  if (!described.data)
    return (
      <Delayed>
        <div className="host-contents">
          <GridSkeleton columns={2} rows={4} />
        </div>
      </Delayed>
    );
  const operations = described.data;
  const boxes = operations.list.params.filter((param) => param.kind !== 'cursor');
  const cursor = operations.list.params.find((param) => param.kind === 'cursor');
  // Only what was typed: an empty box asks nothing of the API.
  const filled = Object.fromEntries(boxes.map((param) => [param.name, (values[param.name] ?? '').trim()]).filter(([, value]) => value));

  const send = async (params: Record<string, string>) => {
    setPending(true);
    setError(null);
    try {
      setReply((await api('/api/http/operation', { resource: table, operation: kind, params })) as HttpOperationReply);
    } catch (failure) {
      setReply(null);
      setError((failure as Error).message);
    } finally {
      setPending(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void send(kind === 'list' ? filled : { [operations.item.key]: key });
  };
  const choose = (next: Kind) => {
    setKind(next);
    setReply(null);
    setError(null);
  };
  /* A cursor-paged answer names its next page; asking for it sends that cursor with the same question. */
  const next =
    kind === 'list' && cursor && operations.list.next && reply?.json !== undefined ? at(reply.json, operations.list.next) : undefined;
  const question = kind === 'list' ? tableQuery(table, boxes, values) : undefined;

  return (
    <div className="panel-pad api-ops">
      <form className="api-form" onSubmit={submit} aria-label={say('tryTheApi', { table })}>
        <fieldset className="api-kind">
          <legend>{say('read')}</legend>
          <label>
            <input type="radio" name="api-kind" checked={kind === 'list'} onChange={() => choose('list')} /> {say('aList')}{' '}
            <code>GET {operations.list.path}</code>
          </label>
          <label>
            <input type="radio" name="api-kind" checked={kind === 'item'} onChange={() => choose('item')} /> {say('oneRecord')}{' '}
            <code>GET {operations.item.path}</code>
          </label>
        </fieldset>
        <div className="api-fields">
          {kind === 'item' ? (
            <label className="field-stack">
              <span>{operations.item.key}</span>
              <input value={key} onChange={(event) => setKey(event.target.value)} aria-label={operations.item.key} />
              <span className="field-hint">{say('theKeyTheItem')}</span>
            </label>
          ) : boxes.length ? (
            boxes.map((param) => (
              <ParamField
                key={param.name}
                param={param}
                value={values[param.name] ?? ''}
                onChange={(value) => setValues((current) => ({ ...current, [param.name]: value }))}
              />
            ))
          ) : (
            <p className="field-hint">{say('thisListTakesNoParameters')}</p>
          )}
        </div>
        <div className="api-actions">
          <button type="submit" className="primary" disabled={pending || (kind === 'item' && !key.trim())}>
            {say('send')}
          </button>
          {typeof next === 'string' && next && cursor && (
            <button type="button" className="ghost" disabled={pending} onClick={() => void send({ ...filled, [cursor.name]: next })}>
              {say('nextPage')}
            </button>
          )}
          {kind === 'list' && (
            <button
              type="button"
              className="ghost"
              disabled={question === undefined}
              title={question === undefined ? say('theApisSearchOrASort') : undefined}
              onClick={() => {
                if (question !== undefined) go(tableView(table, question), 'push');
              }}
            >
              {say('openAsTable')}
            </button>
          )}
        </div>
      </form>
      {error && (
        <p className="note" role="alert">
          {error}
        </p>
      )}
      {reply && <Answer reply={reply} />}
    </div>
  );
}
