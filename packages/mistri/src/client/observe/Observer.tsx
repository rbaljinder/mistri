/**
 * The dev observer: what the running App did, for its author.
 *
 * Requests as a list and, for the one picked, a waterfall of its spans —
 * each statement with its parameters, rows and plan, each outbound call and
 * command with what went in and came out, a refusal with its cause, and the
 * log lines written inside each span. Beside it: all logs, live; errors;
 * slow and repeated statements; what the browser reported; and an access
 * explainer. A quiet developer tool (docs/design.md): rules not boxes, the
 * tokens only, one filled action at most, meaning as a dot and its word.
 *
 * The server masks before it keeps (server/observe/mask.ts); a masked value
 * arrives as `[masked: …]` and is drawn as a badge, so the author sees that
 * something was there.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Tabs } from '@base-ui/react/tabs';
import { Dropdown } from '@mistriwork/kit/client/components/Dropdown.js';
import { say } from '../copy/observe/observe/Observer.js';

/* The page is served at `{base}/_mistri/observe/`, whatever base path the server is under: its API is beside it. */
const BASE = `${location.pathname.replace(/\/_mistri\/observe(\/.*)?$/, '')}/_mistri/observe/api`;

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error ?? say('theObserverAnswered', { status: response.status }));
  return body as T;
}
async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const answer = await response.json();
  if (!response.ok) throw new Error(answer?.error ?? say('theObserverAnswered', { status: response.status }));
  return answer as T;
}
const query = (values: Record<string, string | number | boolean | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== '' && value !== false) params.set(key, String(value));
  const text = params.toString();
  return text ? `?${text}` : '';
};

interface TraceSummary {
  traceId: string;
  seq: number;
  start: string;
  durationMs: number;
  name: string;
  method?: string;
  route?: string;
  path?: string;
  status?: number;
  error?: string;
  aborted?: boolean;
  refusal?: { code?: string; message?: string; field?: string; because?: string[] };
  spans: number;
  statements: number;
  slowStatements: number;
  nPlusOne: number;
  commands: Array<{ id?: string; outcome?: string }>;
  logs: number;
}
interface SpanRow {
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: string;
  offsetMs: number;
  durationMs: number;
  attributes: Record<string, unknown>;
  status: { code: string; message?: string };
  events?: Array<{ name: string; offsetMs: number; attributes: Record<string, unknown> }>;
  detail?: Record<string, unknown>;
  flags?: { slow?: boolean; nPlusOne?: number };
  logs?: Array<{ seq: number; level: string; source: string; message: string }>;
}
interface TraceDetail extends Omit<TraceSummary, 'spans'> {
  spans: SpanRow[];
  truncated: boolean;
  droppedSpans: number;
}
interface LogLine {
  seq: number;
  time: number;
  level: string;
  source: string;
  message: string;
  traceId?: string;
  spanId?: string;
}

const time = (value: number | string) => {
  const date = new Date(value);
  return `${date.toLocaleTimeString('en-US', { hour12: false })}.${String(date.getMilliseconds()).padStart(3, '0')}`;
};
const ms = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(2)} s` : say('milliseconds', { value: value < 10 ? value.toFixed(2) : Math.round(value) });

function useHash(): [string, (next: string) => void] {
  const [hash, setHash] = useState(() => location.hash.slice(1));
  useEffect(() => {
    const read = () => setHash(location.hash.slice(1));
    addEventListener('hashchange', read);
    return () => removeEventListener('hashchange', read);
  }, []);
  return [
    hash,
    (next) => {
      location.hash = next;
    },
  ];
}

/** A value as the observer shows it: masked values as their badge, the rest as JSON. */
function Value({ value }: { value: unknown }) {
  if (typeof value === 'string' && value.startsWith('[masked: ')) {
    return (
      <span className="obs-masked" title={say('maskedByTheObserver')}>
        {say(value.includes('hidden') ? 'maskedHidden' : 'maskedCredential')}
      </span>
    );
  }
  if (value === null) return <span className="obs-faint">null</span>;
  if (typeof value === 'string') return <span className="obs-string">{value}</span>;
  if (typeof value !== 'object') return <span className="obs-literal">{String(value)}</span>;
  return <pre className="obs-code">{JSON.stringify(value, null, 2)}</pre>;
}

function Params({ params }: { params: unknown }) {
  if (!Array.isArray(params)) return <Value value={params} />;
  if (!params.length) return <span className="obs-faint">{say('noParameters')}</span>;
  return (
    <ol className="obs-params">
      {params.map((param, index) => (
        <li key={index}>
          <span className="obs-faint">${index + 1}</span> <Value value={param} />
        </li>
      ))}
    </ol>
  );
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="obs-section">
      <header>
        <h3>{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  );
}

/** A request's outcome: its status, or "aborted" where the browser gave it up — which is not the server's error. */
function Status({ status, error, aborted }: { status?: number; error?: string; aborted?: boolean }) {
  if (aborted) return <span className="obs-dot obs-dim">{say('aborted')}</span>;
  const tone = status === undefined ? (error ? 'danger' : 'dim') : status >= 500 ? 'danger' : status >= 400 ? 'warn' : 'ok';
  return <span className={`obs-dot obs-${tone}`}>{status ?? error ?? '—'}</span>;
}

function Headers({ headers }: { headers?: Record<string, unknown> }) {
  if (!headers || !Object.keys(headers).length) return null;
  return (
    <dl className="obs-pairs">
      {Object.entries(headers).map(([name, value]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>
            <Value value={Array.isArray(value) ? value.join(', ') : value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Body({ body }: { body?: unknown }) {
  if (typeof body !== 'string' || !body) return null;
  return <pre className="obs-code">{body.replace(/"\[masked: (credential|hidden column)\]"/g, '«$1»')}</pre>;
}

function Explain({ spanId }: { spanId: string }) {
  const explain = useMutation({ mutationFn: () => post<{ plan?: string[]; error?: string }>('/explain', { spanId }) });
  return (
    <div className="obs-explain">
      <button type="button" className="btn-compact obs-quiet" onClick={() => explain.mutate()} disabled={explain.isPending}>
        {explain.isPending ? say('explaining') : 'EXPLAIN'}
      </button>
      {explain.error && <p className="obs-problem">{explain.error.message}</p>}
      {explain.data?.error && <p className="obs-problem">{explain.data.error}</p>}
      {explain.data?.plan && <pre className="obs-code">{explain.data.plan.join('\n')}</pre>}
    </div>
  );
}

function SpanDetail({ span }: { span: SpanRow }) {
  const d = span.detail ?? {};
  const request = d.request as { method?: string; url?: string; headers?: Record<string, unknown>; body?: string } | undefined;
  const response = d.response as { status?: number; headers?: Record<string, unknown>; body?: string } | undefined;
  const statement = typeof d.sql === 'string';
  return (
    <div className="obs-detail">
      <h2 className="obs-detail-title">
        {span.name} <span className="obs-faint">{ms(span.durationMs)}</span>
      </h2>
      {span.status.code === 'error' && <p className="obs-problem">{say('failed', { message: span.status.message ?? '' })}</p>}
      {Array.isArray(d.because) && d.because.length > 0 && (
        <Section title={say('why')}>
          <ol className="obs-because">
            {(d.because as string[]).map((reason, index) => (
              <li key={index}>{reason}</li>
            ))}
          </ol>
        </Section>
      )}
      {d.refusal !== undefined && (
        <Section title={say('refusal')}>
          <Value value={d.refusal} />
        </Section>
      )}
      {statement && (
        <Section title={say('statement')}>
          <pre className="obs-code obs-sql">{String(d.sql)}</pre>
          <dl className="obs-pairs">
            <div>
              <dt>{say('parameters')}</dt>
              <dd>
                <Params params={d.params} />
              </dd>
            </div>
            {d.rows !== undefined && (
              <div>
                <dt>{say('rows')}</dt>
                <dd>{String(d.rows)}</dd>
              </div>
            )}
            {d.transaction !== undefined && (
              <div>
                <dt>{say('transaction')}</dt>
                <dd>
                  <code>{String(d.transaction)}</code>
                </dd>
              </div>
            )}
            {span.flags?.slow && (
              <div>
                <dt>{say('flag')}</dt>
                <dd>
                  <span className="obs-dot obs-warn">{say('slow')}</span>
                </dd>
              </div>
            )}
            {span.flags?.nPlusOne && (
              <div>
                <dt>{say('flag')}</dt>
                <dd>
                  <span className="obs-dot obs-warn">{say('nPlusOneRuns', { count: span.flags.nPlusOne })}</span>
                </dd>
              </div>
            )}
          </dl>
          {(span.attributes['db.operation.name'] === 'SELECT' || span.attributes['db.operation.name'] === 'WITH') && (
            <Explain key={span.spanId} spanId={span.spanId} />
          )}
        </Section>
      )}
      {d.input !== undefined && (
        <Section title={say('commandInput')}>
          <Value value={d.input} />
        </Section>
      )}
      {d.output !== undefined && (
        <Section title={say('commandOutput')}>
          <Value value={d.output} />
        </Section>
      )}
      {d.events !== undefined && (
        <Section title={say('events')}>
          <Value value={d.events} />
        </Section>
      )}
      {d.email !== undefined && (
        <Section title={say('email')}>
          <Value value={d.email} />
        </Section>
      )}
      {d.identity !== undefined && (
        <Section title={say('signedInAs')}>
          <Value value={d.identity} />
        </Section>
      )}
      {request && (
        <Section title={say('request', { method: request.method ?? '', url: request.url ?? '' })}>
          <Headers headers={request.headers} />
          <Body body={request.body} />
        </Section>
      )}
      {response && (
        <Section title={say('response', { status: response.status ?? '' })}>
          <Headers headers={response.headers} />
          <Body body={response.body} />
        </Section>
      )}
      {d.error !== undefined && (
        <Section title={say('error')}>
          <Value value={d.error} />
        </Section>
      )}
      {span.events?.length ? (
        <Section title={say('eventsOnThisSpan')}>
          <ul className="obs-lines">
            {span.events.map((event, index) => (
              <li key={index}>
                <code>{event.name}</code> <span className="obs-faint">{JSON.stringify(event.attributes)}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {span.logs?.length ? (
        <Section title={say('logsInThisSpan')}>
          <ul className="obs-lines">
            {span.logs.map((line) => (
              <LogRow key={line.seq} line={line} />
            ))}
          </ul>
        </Section>
      ) : null}
      <Section title={say('attributesExported')}>
        <dl className="obs-pairs">
          {Object.entries(span.attributes).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>
                <code>{JSON.stringify(value)}</code>
              </dd>
            </div>
          ))}
        </dl>
      </Section>
    </div>
  );
}

function Waterfall({
  spans,
  total,
  selected,
  onSelect,
}: {
  spans: SpanRow[];
  total: number;
  selected?: string;
  onSelect: (id: string) => void;
}) {
  const depth = useMemo(() => {
    const ids = new Map(spans.map((span) => [span.spanId, span]));
    const out = new Map<string, number>();
    const of = (span: SpanRow): number => {
      if (out.has(span.spanId)) return out.get(span.spanId)!;
      const parent = span.parentSpanId ? ids.get(span.parentSpanId) : undefined;
      const value = parent ? of(parent) + 1 : 0;
      out.set(span.spanId, value);
      return value;
    };
    for (const span of spans) of(span);
    return out;
  }, [spans]);
  const width = Math.max(total, 0.01);
  return (
    <ol className="obs-waterfall" role="listbox" aria-label={say('spans')}>
      {spans.map((span) => {
        const tone =
          span.status.code === 'error'
            ? 'danger'
            : span.flags?.nPlusOne || span.flags?.slow
              ? 'warn'
              : span.attributes['db.system.name']
                ? 'db'
                : span.kind === 'client'
                  ? 'out'
                  : 'ok';
        return (
          <li
            key={span.spanId}
            role="option"
            aria-selected={selected === span.spanId}
            className={`obs-span${selected === span.spanId ? ' is-selected' : ''}`}
            onClick={() => onSelect(span.spanId)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(span.spanId);
              }
            }}
            tabIndex={0}
          >
            <span className="obs-span-name" style={{ paddingInlineStart: `${(depth.get(span.spanId) ?? 0) * 14}px` }}>
              {span.name}
              {span.flags?.nPlusOne ? <span className="obs-flag">{say('nPlusOne')}</span> : null}
              {span.flags?.slow ? <span className="obs-flag">{say('slow')}</span> : null}
              {span.logs?.length ? <span className="obs-faint">{say('spanLogs', { count: span.logs.length })}</span> : null}
            </span>
            <span className="obs-span-track">
              <span
                className={`obs-bar obs-bar-${tone}`}
                style={{
                  insetInlineStart: `${(span.offsetMs / width) * 100}%`,
                  inlineSize: `max(2px, ${(span.durationMs / width) * 100}%)`,
                }}
              />
            </span>
            <span className="obs-span-ms">{ms(span.durationMs)}</span>
          </li>
        );
      })}
    </ol>
  );
}

function TraceView({ traceId }: { traceId: string }) {
  const trace = useQuery({ queryKey: ['trace', traceId], queryFn: () => get<TraceDetail>(`/traces/${traceId}`), refetchInterval: 3000 });
  const [picked, setPicked] = useState<string>();
  const spans = trace.data?.spans ?? [];
  // The span most worth opening first: the refusal, the error, else the request itself.
  const first =
    spans.find((span) => Array.isArray(span.detail?.because) && (span.detail!.because as unknown[]).length) ??
    spans.find((span) => span.status.code === 'error') ??
    spans[0];
  const selected = spans.find((span) => span.spanId === picked) ?? first;
  if (trace.isPending) return <p className="obs-faint obs-pad">{say('readingTheTrace')}</p>;
  if (trace.error) return <p className="obs-problem obs-pad">{trace.error.message}</p>;
  const t = trace.data!;
  return (
    <div className="obs-trace">
      <header className="obs-trace-head">
        <h2>
          <Status status={t.status} error={t.error} aborted={t.aborted} /> {t.method ?? ''}{' '}
          <span className="obs-path">{t.path ?? t.name}</span>
        </h2>
        <p className="obs-faint">
          {time(t.start)} · {ms(t.durationMs)} · {say('statements', { count: t.statements })}
          {t.nPlusOne ? say('nPlusOnePatterns', { count: t.nPlusOne }) : ''}
          {t.slowStatements ? say('slowCount', { count: t.slowStatements }) : ''} {say('traceId')} <code>{t.traceId}</code>
          {t.truncated ? say('firstSpans') : ''}
          {t.droppedSpans ? say('spansNotKept', { count: t.droppedSpans }) : ''}
        </p>
        {t.refusal && (
          <p className="obs-problem">
            {t.refusal.because?.length
              ? say('refusedBecause', { code: String(t.refusal.code), because: t.refusal.because.at(-1)! })
              : say('refused', { code: String(t.refusal.code) })}
          </p>
        )}
      </header>
      <Waterfall spans={spans} total={t.durationMs} selected={selected?.spanId} onSelect={setPicked} />
      {selected && <SpanDetail span={selected} />}
    </div>
  );
}

function Requests({ hash, go }: { hash: string; go: (next: string) => void }) {
  const [text, setText] = useState('');
  const [failures, setFailures] = useState(false);
  const traces = useQuery({
    queryKey: ['traces', text, failures],
    queryFn: () =>
      get<{ traces: TraceSummary[]; total: number; truncated: boolean }>(
        `/traces${query({ text, error: failures || undefined, limit: 200 })}`,
      ),
    refetchInterval: 1500,
  });
  const open = hash.startsWith('trace/') ? hash.slice('trace/'.length) : undefined;
  return (
    <div className="obs-split">
      <div className="obs-list">
        <div className="obs-filters">
          <input
            type="search"
            className="obs-input"
            placeholder={say('filterByPathOrRoute')}
            value={text}
            onChange={(event) => setText(event.target.value)}
            aria-label={say('filterRequests')}
          />
          <label className="obs-check">
            <input type="checkbox" checked={failures} onChange={(event) => setFailures(event.target.checked)} /> {say('failures')}
          </label>
        </div>
        {traces.error && <p className="obs-problem obs-pad">{traces.error.message}</p>}
        {traces.data && !traces.data.traces.length && <p className="obs-faint obs-pad">{say('nothingYet')}</p>}
        <ol className="obs-rows">
          {traces.data?.traces.map((trace) => (
            <li key={trace.traceId}>
              <a
                href={`#trace/${trace.traceId}`}
                className={`obs-row${open === trace.traceId ? ' is-selected' : ''}`}
                onClick={() => go(`trace/${trace.traceId}`)}
              >
                <Status status={trace.status} error={trace.error} aborted={trace.aborted} />
                <span className="obs-method">{trace.method ?? '·'}</span>
                <span className="obs-path" title={trace.path ?? trace.name}>
                  {trace.path ?? trace.name}
                </span>
                <span className="obs-row-meta">
                  {trace.refusal ? <span className="obs-flag obs-flag-danger">{String(trace.refusal.code)}</span> : null}
                  {trace.nPlusOne ? <span className="obs-flag">{say('nPlusOne')}</span> : null}
                  {trace.slowStatements ? <span className="obs-flag">{say('slow')}</span> : null}
                  {trace.statements ? <span className="obs-faint">{say('sqlCount', { count: trace.statements })}</span> : null}
                  <span className="obs-ms">{ms(trace.durationMs)}</span>
                </span>
              </a>
            </li>
          ))}
        </ol>
      </div>
      <div className="obs-main">
        {open ? <TraceView key={open} traceId={open} /> : <p className="obs-faint obs-pad">{say('pickARequest')}</p>}
      </div>
    </div>
  );
}

function LogRow({ line, go }: { line: Pick<LogLine, 'level' | 'source' | 'message'> & Partial<LogLine>; go?: (next: string) => void }) {
  const tone = line.level === 'error' ? 'danger' : line.level === 'warn' ? 'warn' : line.level === 'debug' ? 'dim' : 'ok';
  return (
    <li className="obs-log">
      {line.time !== undefined && <span className="obs-faint obs-time">{time(line.time)}</span>}
      <span className={`obs-dot obs-${tone}`}>{line.level}</span>
      <span className="obs-source">{line.source}</span>
      <span className="obs-message">{line.message}</span>
      {go && line.traceId && (
        <a className="obs-link" href={`#trace/${line.traceId}`} onClick={() => go(`trace/${line.traceId}`)}>
          {say('trace')}
        </a>
      )}
    </li>
  );
}

const levels = () => [
  { value: 'debug', label: say('allLevels') },
  { value: 'info', label: say('infoAndAbove') },
  { value: 'warn', label: say('warningsAndErrors') },
  { value: 'error', label: say('errorsOnly') },
];

function Logs({ go }: { go: (next: string) => void }) {
  const [level, setLevel] = useState('debug');
  const [source, setSource] = useState('');
  const [text, setText] = useState('');
  const [scope, setScope] = useState('all');
  const logs = useQuery({
    queryKey: ['logs', level, source, text, scope],
    queryFn: () =>
      get<{ logs: LogLine[]; sources: string[]; total: number; truncated: boolean }>(
        `/logs${query({ level, source, text, limit: 1000, outside: scope === 'outside' ? true : undefined })}`,
      ),
    refetchInterval: 1500,
  });
  const lines = logs.data?.logs ?? [];
  const groups = useMemo(() => {
    if (scope !== 'outside') return undefined;
    const by = new Map<string, LogLine[]>();
    for (const line of lines) by.set(line.source, [...(by.get(line.source) ?? []), line]);
    return [...by.entries()];
  }, [lines, scope]);
  return (
    <div className="obs-logs">
      <div className="obs-filters">
        <Dropdown ariaLabel={say('level')} items={levels()} value={level} onChange={setLevel} />
        <Dropdown
          ariaLabel={say('source')}
          items={[{ value: '', label: say('everySource') }, ...(logs.data?.sources ?? []).map((name) => ({ value: name, label: name }))]}
          value={source}
          onChange={setSource}
        />
        <Dropdown
          ariaLabel={say('scope')}
          items={[
            { value: 'all', label: say('allLines') },
            { value: 'outside', label: say('outsideRequests') },
          ]}
          value={scope}
          onChange={setScope}
        />
        <input
          type="search"
          className="obs-input"
          placeholder={say('search')}
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-label={say('searchLogs')}
        />
        <span className="obs-faint">{logs.data ? say(logs.data.truncated ? 'linesLatest' : 'lines', { count: logs.data.total }) : ''}</span>
      </div>
      {groups ? (
        groups.map(([name, grouped]) => (
          <Section key={name} title={name}>
            <ul className="obs-lines">
              {grouped.map((line) => (
                <LogRow key={line.seq} line={line} go={go} />
              ))}
            </ul>
          </Section>
        ))
      ) : (
        <ul className="obs-lines obs-pad-x">
          {lines.map((line) => (
            <LogRow key={line.seq} line={line} go={go} />
          ))}
        </ul>
      )}
      {logs.data && !lines.length && <p className="obs-faint obs-pad">{say('noLinesMatch')}</p>}
    </div>
  );
}

function Errors({ go }: { go: (next: string) => void }) {
  const errors = useQuery({
    queryKey: ['errors'],
    queryFn: () => get<{ errors: Array<Record<string, unknown>> }>('/errors?limit=100'),
    refetchInterval: 2000,
  });
  if (errors.data && !errors.data.errors.length) return <p className="obs-faint obs-pad">{say('noErrors')}</p>;
  return (
    <ul className="obs-lines obs-pad-x">
      {errors.data?.errors.map((error) => (
        <li key={String(error.seq)} className="obs-error">
          <span className={`obs-dot obs-${error.kind === 'refusal' ? 'warn' : 'danger'}`}>{String(error.kind)}</span>
          <span className="obs-path">{String(error.path ?? error.name ?? '')}</span>
          {error.status !== undefined && <span className="obs-faint">{String(error.status)}</span>}
          <span className="obs-message">
            {(() => {
              // The sentence the reader was told, the field it names, then the cause the server recorded.
              const refusal = error.refusal as { message?: string; field?: string; because?: string[] } | undefined;
              const told = refusal?.message ? `${refusal.field ? `${refusal.field}: ` : ''}${refusal.message}` : undefined;
              const cause = refusal?.because?.at(-1);
              return (
                [told, cause].filter(Boolean).join(' — ') ||
                String(
                  error.message ?? (error.failure as { error?: { message?: string } } | undefined)?.error?.message ?? error.error ?? '',
                )
              );
            })()}
          </span>
          {typeof error.traceId === 'string' && (
            <a className="obs-link" href={`#trace/${error.traceId}`} onClick={() => go(`trace/${error.traceId}`)}>
              {say('trace')}
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

function Statements({ go }: { go: (next: string) => void }) {
  const slow = useQuery({
    queryKey: ['slow'],
    queryFn: () => get<{ thresholdMs: number; statements: Array<Record<string, unknown>> }>('/slow?limit=50'),
    refetchInterval: 3000,
  });
  const repeated = useQuery({
    queryKey: ['n+1'],
    queryFn: () => get<{ threshold: number; patterns: Array<Record<string, unknown>> }>('/n-plus-one?limit=50'),
    refetchInterval: 3000,
  });
  return (
    <div className="obs-pad-x">
      <Section title={say('repeatedStatements', { count: repeated.data?.threshold ?? 5 })}>
        {repeated.data && !repeated.data.patterns.length && <p className="obs-faint">{say('noneSeen')}</p>}
        <ul className="obs-lines">
          {repeated.data?.patterns.map((pattern, index) => (
            <li key={index} className="obs-error">
              <span className="obs-dot obs-warn">×{String(pattern.count)}</span>
              <span className="obs-faint">{ms(Number(pattern.totalMs))}</span>
              <code className="obs-message">{String(pattern.shape)}</code>
              <a className="obs-link" href={`#trace/${String(pattern.traceId)}`} onClick={() => go(`trace/${String(pattern.traceId)}`)}>
                {String(pattern.trace)}
              </a>
            </li>
          ))}
        </ul>
      </Section>
      <Section title={say('slowStatements', { value: slow.data?.thresholdMs ?? 100 })}>
        {slow.data && !slow.data.statements.length && <p className="obs-faint">{say('noneSeen')}</p>}
        <ul className="obs-lines">
          {slow.data?.statements.map((statement) => (
            <li key={String(statement.spanId)} className="obs-error">
              <span className="obs-dot obs-warn">{ms(Number(statement.durationMs))}</span>
              <code className="obs-message">{String(statement.sql ?? statement.summary)}</code>
              <a className="obs-link" href={`#trace/${String(statement.traceId)}`} onClick={() => go(`trace/${String(statement.traceId)}`)}>
                {say('trace')}
              </a>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function Page({ go }: { go: (next: string) => void }) {
  const pages = useQuery({
    queryKey: ['pages'],
    queryFn: () => get<{ reports: Array<Record<string, unknown>> }>('/pages?limit=100'),
    refetchInterval: 2000,
  });
  if (pages.data && !pages.data.reports.length) return <p className="obs-faint obs-pad">{say('pagesReport')}</p>;
  return (
    <ul className="obs-lines obs-pad-x">
      {pages.data?.reports.map((report) => (
        <li key={String(report.seq)} className="obs-error">
          <span className={`obs-dot obs-${report.kind === 'error' ? 'danger' : 'warn'}`}>{String(report.kind)}</span>
          <span className="obs-path">{String(report.path)}</span>
          <span className="obs-message">
            {report.kind === 'error'
              ? String(report.message ?? '')
              : `${String(report.name ?? 'CLS')} ${Number(report.value ?? 0).toFixed(3)}`}
            {Array.isArray(report.sources) && report.sources.length > 0 && (
              <span className="obs-faint">
                {say('moved', { nodes: (report.sources as Array<{ node: string }>).map((source) => source.node).join(', ') })}
              </span>
            )}
            {typeof report.stack === 'string' && <pre className="obs-code">{report.stack}</pre>}
          </span>
          {typeof report.traceId === 'string' && (
            <a className="obs-link" href={`#trace/${report.traceId}`} onClick={() => go(`trace/${report.traceId}`)}>
              {say('trace')}
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

function Access() {
  const status = useQuery({
    queryKey: ['status'],
    queryFn: () => get<{ apps: Array<{ id: string; name: string; roles: string[] }> }>('/status'),
  });
  const apps = status.data?.apps ?? [];
  const [app, setApp] = useState('');
  const chosen = apps.find((each) => each.id === app) ?? apps[0];
  const [role, setRole] = useState('');
  const [table, setTable] = useState('');
  const [column, setColumn] = useState('');
  const [command, setCommand] = useState('');
  const ask = useMutation({
    mutationFn: () =>
      get<Record<string, unknown>>(`/access${query({ app: chosen?.id, role: role || chosen?.roles[0], table, column, command })}`),
  });
  if (!apps.length) return <p className="obs-faint obs-pad">{say('noApp')}</p>;
  return (
    <div className="obs-pad-x obs-access">
      <form
        className="obs-filters"
        onSubmit={(event) => {
          event.preventDefault();
          ask.mutate();
        }}
      >
        {apps.length > 1 && (
          <Dropdown
            ariaLabel={say('app')}
            items={apps.map((each) => ({ value: each.id, label: each.name }))}
            value={chosen!.id}
            onChange={setApp}
          />
        )}
        <Dropdown
          ariaLabel={say('role')}
          items={[...chosen!.roles, 'public'].map((name) => ({ value: name, label: name }))}
          value={role || chosen!.roles[0] || 'public'}
          onChange={setRole}
        />
        <input
          className="obs-input"
          placeholder={say('table')}
          value={table}
          onChange={(event) => setTable(event.target.value)}
          aria-label={say('table')}
        />
        <input
          className="obs-input"
          placeholder={say('column')}
          value={column}
          onChange={(event) => setColumn(event.target.value)}
          aria-label={say('column')}
        />
        <input
          className="obs-input"
          placeholder={say('command')}
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          aria-label={say('command')}
        />
        <button type="submit" className="btn-compact">
          {say('explain')}
        </button>
      </form>
      {ask.error && <p className="obs-problem">{ask.error.message}</p>}
      {ask.data && (
        <Section title={say('answer')}>
          {typeof ask.data.because === 'string' && <p className="obs-because-text">{ask.data.because}</p>}
          <Value value={ask.data} />
        </Section>
      )}
    </div>
  );
}

export function Observer() {
  const [hash, go] = useHash();
  const [tab, setTab] = useState(hash.startsWith('trace/') || !hash ? 'requests' : hash);
  useEffect(() => {
    if (hash.startsWith('trace/')) setTab('requests');
  }, [hash]);
  const client = useQueryClient();
  const clear = useMutation({
    mutationFn: () => post('/clear', {}),
    onSuccess: () => {
      void client.invalidateQueries();
      go('');
    },
  });
  const errors = useQuery({ queryKey: ['errors-count'], queryFn: () => get<{ total: number }>('/errors?limit=1'), refetchInterval: 2000 });
  return (
    <div className="obs">
      <Tabs.Root
        value={tab}
        onValueChange={(value) => {
          setTab(String(value));
          if (value !== 'requests') go(String(value));
        }}
      >
        <header className="obs-head">
          <span className="obs-brand">
            <span className="brand-mark" aria-hidden="true" /> {say('observer')}
          </span>
          <Tabs.List className="obs-tabs" aria-label={say('views')}>
            <Tabs.Tab className="obs-tab" value="requests">
              {say('requests')}
            </Tabs.Tab>
            <Tabs.Tab className="obs-tab" value="logs">
              {say('logs')}
            </Tabs.Tab>
            <Tabs.Tab className="obs-tab" value="errors">
              {say('errors')}
              {errors.data?.total ? <span className="obs-count">{errors.data.total}</span> : null}
            </Tabs.Tab>
            <Tabs.Tab className="obs-tab" value="statements">
              {say('statementsTab')}
            </Tabs.Tab>
            <Tabs.Tab className="obs-tab" value="page">
              {say('page')}
            </Tabs.Tab>
            <Tabs.Tab className="obs-tab" value="access">
              {say('access')}
            </Tabs.Tab>
          </Tabs.List>
          <span className="obs-head-end">
            <span className="obs-faint">{say('devOnly')}</span>
            <button type="button" className="btn-compact obs-quiet" onClick={() => clear.mutate()}>
              {say('clear')}
            </button>
          </span>
        </header>
        <Tabs.Panel value="requests" className="obs-panel">
          <Requests hash={hash} go={go} />
        </Tabs.Panel>
        <Tabs.Panel value="logs" className="obs-panel">
          <Logs go={go} />
        </Tabs.Panel>
        <Tabs.Panel value="errors" className="obs-panel">
          <Errors go={go} />
        </Tabs.Panel>
        <Tabs.Panel value="statements" className="obs-panel">
          <Statements go={go} />
        </Tabs.Panel>
        <Tabs.Panel value="page" className="obs-panel">
          <Page go={go} />
        </Tabs.Panel>
        <Tabs.Panel value="access" className="obs-panel">
          <Access />
        </Tabs.Panel>
      </Tabs.Root>
    </div>
  );
}
