/**
 * The dev observer's telemetry as MCP tools, for a coding agent in the
 * edit-reload-check loop: what the running App did, rather than a guess at it.
 *
 * Every tool reads the dev server's observer over loopback (http.ts) and is
 * read-only. Answers are shaped for an agent: a summary first, sizes bounded
 * and truncation said, ids to drill into rather than a dump — a trace comes
 * back as a tree of one line per span, with the statement, its parameters and
 * the logs written inside it, and `get_trace` is how to go deeper.
 *
 * The loop the skill teaches (skills/mistri): after an edit, `check`
 * (the same JSON as `mistri check --json`), then `tail` or
 * `recent_errors`; on a refusal, `get_trace` on its trace id, then
 * `explain_access` for the role that was refused. `check` runs the command
 * itself and needs no dev server, so an agent can call it before one starts.
 *
 * Hand-rolled JSON-RPC over stdio, as the database tools' server is
 * (mcp/protocol.ts), and for the same reason.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { DOC_TEMPLATE, docResources, docTopicNames, readDoc } from './docShelf.js';

const VERSIONS = ['2025-03-26', '2025-06-18', '2025-11-25'];

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<unknown>;
  /** Writes a file (the check's generated schema types); every other tool only reads. */
  writes?: true;
}

const TEXT = 1500;
const ITEMS = 60;

/** Bound an answer: long strings cut and said so, long lists cut and counted. */
function bounded(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > TEXT ? `${value.slice(0, TEXT)}… [${value.length - TEXT} more characters]` : value;
  if (Array.isArray(value)) {
    const kept = value.slice(0, ITEMS).map((item) => bounded(item, depth + 1));
    return value.length > ITEMS ? [...kept, `… ${value.length - ITEMS} more`] : kept;
  }
  if (value && typeof value === 'object' && depth < 10) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, bounded(inner, depth + 1)]));
  }
  return value;
}

const property = (type: string, description: string) => ({ type, description });
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

interface TraceSpan {
  spanId: string;
  parentSpanId?: string;
  name: string;
  offsetMs: number;
  durationMs: number;
  attributes: Record<string, unknown>;
  status: { code: string; message?: string };
  detail?: Record<string, unknown>;
  flags?: { slow?: boolean; nPlusOne?: number };
  logs?: Array<{ level: string; source: string; message: string }>;
  events?: Array<{ name: string; attributes: Record<string, unknown> }>;
}

/** A trace as an agent reads it: one indented line per span, the detail that matters beneath it. */
export function traceTree(trace: { spans: TraceSpan[] } & Record<string, unknown>): Record<string, unknown> {
  const children = new Map<string | undefined, TraceSpan[]>();
  const ids = new Set(trace.spans.map((span) => span.spanId));
  for (const span of trace.spans) {
    const parent = span.parentSpanId && ids.has(span.parentSpanId) ? span.parentSpanId : undefined;
    children.set(parent, [...(children.get(parent) ?? []), span]);
  }
  const lines: string[] = [];
  const walk = (parent: string | undefined, depth: number) => {
    for (const span of children.get(parent) ?? []) {
      const pad = '  '.repeat(depth);
      const flags = [
        span.status.code === 'error' ? `ERROR ${span.status.message ?? ''}`.trim() : '',
        span.flags?.slow ? 'SLOW' : '',
        span.flags?.nPlusOne ? `N+1 ×${span.flags.nPlusOne}` : '',
      ]
        .filter(Boolean)
        .join(' ');
      lines.push(`${pad}${span.name}  ${span.durationMs}ms @${span.offsetMs}ms  [${span.spanId}]${flags ? `  ${flags}` : ''}`);
      const d = span.detail ?? {};
      if (typeof d.sql === 'string') lines.push(`${pad}  sql: ${d.sql.replace(/\s+/g, ' ').slice(0, 400)}`);
      if (d.params !== undefined) lines.push(`${pad}  params: ${JSON.stringify(d.params).slice(0, 300)}`);
      if (d.rows !== undefined) lines.push(`${pad}  rows: ${String(d.rows)}${d.transaction ? `  (${String(d.transaction)})` : ''}`);
      if (d.input !== undefined) lines.push(`${pad}  input: ${JSON.stringify(d.input).slice(0, 400)}`);
      if (d.output !== undefined) lines.push(`${pad}  output: ${JSON.stringify(d.output).slice(0, 400)}`);
      if (d.refusal !== undefined) lines.push(`${pad}  refusal: ${JSON.stringify(d.refusal).slice(0, 400)}`);
      if (Array.isArray(d.because) && d.because.length) lines.push(`${pad}  because: ${d.because.join(' ← ')}`.slice(0, 800));
      const error = d.error as { name?: string; message?: string } | undefined;
      if (error?.message) lines.push(`${pad}  error: ${error.name ?? 'Error'}: ${error.message.slice(0, 400)}`);
      const request = d.request as { method?: string; url?: string; body?: string } | undefined;
      if (request?.url)
        lines.push(
          `${pad}  ${request.method ?? ''} ${request.url}${request.body ? `  body: ${request.body.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`,
        );
      const response = d.response as { status?: number; body?: string } | undefined;
      if (response?.body && span.status.code === 'error')
        lines.push(`${pad}  answered ${response.status}: ${response.body.replace(/\s+/g, ' ').slice(0, 300)}`);
      for (const event of span.events ?? []) lines.push(`${pad}  · ${event.name} ${JSON.stringify(event.attributes)}`);
      for (const line of span.logs ?? []) lines.push(`${pad}  log ${line.level} [${line.source}] ${line.message.slice(0, 300)}`);
      walk(span.spanId, depth + 1);
    }
  };
  walk(undefined, 0);
  const { spans: _spans, ...summary } = trace;
  return {
    ...summary,
    tree: lines.length > 400 ? [...lines.slice(0, 400), `… ${lines.length - 400} more lines; ask get_trace with full for the rest`] : lines,
  };
}

/**
 * `mistri check --json` for the App the agent is building, as a child of
 * this mistri, from where the MCP server was started: the one document an
 * edit is judged by, whatever the dev server is doing. It writes one file,
 * the generated schema types, as the command does.
 */
async function runCheckJson(args: Record<string, unknown>): Promise<unknown> {
  const { selfInvocation } = await import('../build/build.js');
  const text = (key: string) => (typeof args[key] === 'string' && (args[key] as string).trim() ? [(args[key] as string).trim()] : []);
  const argv = [
    'check',
    '--json',
    '--app',
    ...(text('app').length ? text('app') : ['.']),
    ...text('config').flatMap((file) => ['--config', file]),
    ...text('db').flatMap((target) => ['--db', target]),
    ...(args.design === true ? ['--design'] : []),
    ...(args.routes === true ? ['--routes'] : []),
    ...(args.pending === true ? ['--pending'] : []),
  ];
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [...selfInvocation(), ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      err += String(chunk);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);
    child.once('error', fail);
    child.once('close', () => {
      clearTimeout(timer);
      try {
        done(JSON.parse(out));
      } catch {
        fail(new Error(`mistri check did not answer with JSON: ${(err || out).trim().slice(0, 400)}`));
      }
    });
  });
}

function tools(get: (path: string) => Promise<unknown>, post: (path: string, body: unknown) => Promise<unknown>): Tool[] {
  const query = (values: Record<string, unknown>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values))
      if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
    const text = params.toString();
    return text ? `?${text}` : '';
  };
  return [
    {
      name: 'check',
      description:
        'Run mistri check on the App and answer with every problem of every step (schema types, typecheck, validation, ' +
        'components, and on request routes and design) as { code, severity, step, file, line, column, path, message, fix, docs }, the same JSON as ' +
        '`mistri check --json`. Call it after every edit; the App is done when "ok" is true. Needs no running dev server.',
      inputSchema: schema({
        app: property('string', 'The App directory (default: the current directory).'),
        config: property('string', 'A mistri.json naming the database (default: the one beside where the server started).'),
        db: property('string', 'A database to check against instead: a SQLite file or a URL.'),
        design: property('boolean', 'Also the design warnings.'),
        routes: property('boolean', 'Also every address the App answers to.'),
        pending: property('boolean', 'Judge against the schema after the pending migrations.'),
      }),
      run: runCheckJson,
      writes: true,
    },
    {
      name: 'recent_errors',
      description:
        'The latest refusals — the sentence the reader was told, the field it names and the cause the server recorded — server errors (5xx) and browser page errors, newest first. Start here after an edit. Each has a traceId for get_trace.',
      inputSchema: schema({
        limit: property('number', 'At most this many (default 20).'),
        since: property('number', 'Only what happened after this cursor (from an earlier answer).'),
      }),
      run: (args) => get(`/api/errors${query({ limit: args.limit, since: args.since })}`),
    },
    {
      name: 'list_traces',
      description:
        'Recent requests, jobs and commands as one line each: route, status, duration, statement count, N+1 and slow flags, refusal code. Filter to find the one to open with get_trace.',
      inputSchema: schema({
        route: property('string', 'A route template or path fragment, e.g. /api/commands/execute or /compass/leads.'),
        status: property('number', 'An HTTP status (404) or a class (4 for every 4xx).'),
        error: property('boolean', 'Only failures (true) or only successes (false).'),
        slower_than_ms: property('number', 'Only traces at least this slow.'),
        app: property('string', 'Only this App id.'),
        since: property('number', 'Only traces newer than this cursor.'),
        limit: property('number', 'At most this many (default 30).'),
      }),
      run: (args) =>
        get(
          `/api/traces${query({ route: args.route, status: args.status, error: args.error, slowerThan: args.slower_than_ms, app: args.app, since: args.since, limit: args.limit })}`,
        ),
    },
    {
      name: 'get_trace',
      description:
        'One trace as a tree: each span with its timing; SQL with parameters, rows and transaction; outbound calls with bodies; command input, output and refusal cause; access decisions; and the log lines written inside each span. Credentials and hidden columns come back masked.',
      inputSchema: schema(
        {
          trace_id: property('string', 'The trace id (or its first 8+ characters).'),
          full: property('boolean', 'Every span rather than the first 200.'),
        },
        ['trace_id'],
      ),
      run: async (args) => {
        const trace = (await get(`/api/traces/${encodeURIComponent(String(args.trace_id ?? ''))}${query({ full: args.full })}`)) as {
          spans?: TraceSpan[];
        } & Record<string, unknown>;
        return trace && Array.isArray(trace.spans) ? traceTree(trace as { spans: TraceSpan[] } & Record<string, unknown>) : trace;
      },
    },
    {
      name: 'search_logs',
      description:
        "Structured log lines — mistri's own and the App's console output from commands, jobs and policies — each with its trace and span id. Filter by level (at least), text, trace, source; outside=true for lines written outside any request (startup, reload, the scheduler).",
      inputSchema: schema({
        level: property('string', 'debug, info, warn or error: this level and above.'),
        text: property('string', 'Words the line contains.'),
        trace_id: property('string', 'Only lines written inside this trace.'),
        source: property('string', 'mistri, app, app-load, refusal, console…'),
        outside: property('boolean', 'Only lines written outside any request.'),
        since: property('number', 'Only lines newer than this cursor.'),
        limit: property('number', 'At most this many (default 100).'),
      }),
      run: (args) =>
        get(
          `/api/logs${query({ level: args.level, text: args.text, trace: args.trace_id, source: args.source, outside: args.outside, since: args.since, limit: args.limit })}`,
        ),
    },
    {
      name: 'slow_queries',
      description:
        "Statements slower than the observer's threshold, slowest first, with SQL, parameters, rows, and the trace and span ids (explain_statement shows the plan).",
      inputSchema: schema({ limit: property('number', 'At most this many (default 20).') }),
      run: (args) => get(`/api/slow${query({ limit: args.limit })}`),
    },
    {
      name: 'n_plus_one',
      description:
        "Statements of one shape run five or more times under one parent — the N+1 pattern — with the count, total time, the shape and an example's parameters.",
      inputSchema: schema({ limit: property('number', 'At most this many (default 20).') }),
      run: (args) => get(`/api/n-plus-one${query({ limit: args.limit })}`),
    },
    {
      name: 'explain_statement',
      description:
        'The query plan of a statement the observer recorded (a read, on SQLite or PostgreSQL), run read-only on a separate connection.',
      inputSchema: schema({ span_id: property('string', "The statement's span id, from get_trace or slow_queries.") }, ['span_id']),
      run: (args) => post('/api/explain', { spanId: args.span_id }),
    },
    {
      name: 'explain_access',
      description:
        "Why a role can or cannot read or write a table or column, or run a command, in a served App: the server's own resolution of its grants, with the rule that decided quoted from the App. With only a role, lists what it reads and writes.",
      inputSchema: schema(
        {
          role: property('string', 'The role (or "public" for a signed-out visitor).'),
          app: property('string', 'The App id, when the server serves several.'),
          table: property('string', 'A table (resource) id.'),
          column: property('string', 'A column of that table.'),
          command: property('string', 'A command id.'),
        },
        ['role'],
      ),
      run: (args) =>
        get(`/api/access${query({ app: args.app, role: args.role, table: args.table, column: args.column, command: args.command })}`),
    },
    {
      name: 'page_vitals',
      description:
        'What the browser reported for the latest navigations: page errors with stacks, layout shifts with the elements that moved, and web vitals, newest first.',
      inputSchema: schema({
        kind: property('string', 'error, layout-shift or vital; all when absent.'),
        limit: property('number', 'At most this many (default 30).'),
      }),
      run: (args) => get(`/api/pages${query({ kind: args.kind, limit: args.limit })}`),
    },
    {
      name: 'tail',
      description:
        'Everything new since a cursor: traces, log lines and page reports. Call with no cursor to get the current one, make an edit, reload, then call again with it.',
      inputSchema: schema({
        cursor: property(
          'number',
          'The cursor from the previous answer; 0 for the recent past. Absent, only the current cursor comes back.',
        ),
        limit: property('number', 'At most this many of each (default 50).'),
      }),
      run: (args) => get(`/api/tail${query({ cursor: args.cursor, limit: args.limit })}`),
    },
  ];
}

/** `base` is the observer's address, asked at each call: a dev server started after the agent's session is found then. */
export async function serveObserverMcp(base: () => string | undefined, version: string): Promise<void> {
  const call = async (path: string, init?: RequestInit) => {
    const at = base();
    if (at === undefined) throw new Error('no dev server is running');
    const response = await fetch(`${at}${path}`, { ...init, signal: AbortSignal.timeout(15_000) });
    const body = await response.json().catch(() => ({ error: `The dev server answered ${response.status} without JSON.` }));
    return response.ok ? body : { status: response.status, ...(body as object) };
  };
  const list = tools(
    (path) => call(path),
    (path, body) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  );
  const write = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const rl = createInterface({ input: process.stdin });
  let chain: Promise<unknown> = Promise.resolve();
  rl.on('line', (line) => {
    chain = chain
      .then(async () => {
        let rpc: { id?: string | number | null; method?: string; params?: Record<string, unknown> };
        try {
          rpc = JSON.parse(line);
        } catch {
          return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        }
        const reply = (result: unknown) => rpc.id !== undefined && write({ jsonrpc: '2.0', id: rpc.id, result });
        const fail = (code: number, message: string) =>
          rpc.id !== undefined && write({ jsonrpc: '2.0', id: rpc.id, error: { code, message } });
        switch (rpc.method) {
          case 'initialize': {
            const asked = String(rpc.params?.protocolVersion ?? '');
            return reply({
              protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS.at(-1),
              capabilities: { tools: {}, resources: {}, completions: {} },
              serverInfo: { name: 'mistri-observe', version },
              instructions:
                "After an edit call check: every problem of the App with its code, file, line and fix. Then the running mistri dev server's telemetry: what it did, not a guess. Call recent_errors or tail; on a refusal call get_trace with its traceId, then explain_access for the role.",
            });
          }
          case 'ping':
            return reply({});
          /* The App reference (docShelf.ts): read here, beside `check`, which cites it. */
          case 'resources/list':
            return reply({ resources: docResources() });
          case 'resources/templates/list':
            return reply({ resourceTemplates: [DOC_TEMPLATE] });
          case 'resources/read': {
            const read = readDoc(String(rpc.params?.uri ?? ''));
            return 'error' in read ? fail(-32002, read.error) : reply(read);
          }
          case 'completion/complete': {
            const argument = rpc.params?.argument as { name?: string; value?: string } | undefined;
            const prefix = String(argument?.value ?? '').toLowerCase();
            const values = argument?.name === 'topic' ? docTopicNames().filter((name) => name.toLowerCase().startsWith(prefix)) : [];
            return reply({ completion: { values: values.slice(0, 100), total: values.length, hasMore: values.length > 100 } });
          }
          case 'tools/list':
            return reply({
              tools: list.map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
                annotations: tool.writes
                  ? { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
                  : { readOnlyHint: true, openWorldHint: false },
              })),
            });
          case 'tools/call': {
            const tool = list.find((each) => each.name === rpc.params?.name);
            if (!tool) return fail(-32602, `Unknown tool: ${String(rpc.params?.name)}`);
            try {
              const result = bounded(await tool.run((rpc.params?.arguments ?? {}) as Record<string, unknown>));
              return reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 1) }], structuredContent: result });
            } catch (error) {
              const said = error instanceof Error ? error.message : String(error);
              if (tool.name === 'check') return reply({ isError: true, content: [{ type: 'text', text: said }] });
              const at = base();
              return reply({
                isError: true,
                content: [
                  {
                    type: 'text',
                    text:
                      at === undefined
                        ? 'No dev server is running: start one with --dev (e.g. mistri --app ./myapp --dev), then ask again. The check tool needs none.'
                        : `The dev server at ${at} did not answer: ${said}. Is it still running with --dev?`,
                  },
                ],
              });
            }
          }
          default:
            if (rpc.method?.startsWith('notifications/')) return;
            return fail(-32601, `Method not found: ${String(rpc.method)}`);
        }
      })
      .catch(() => {});
  });
  await new Promise<void>((resolve) =>
    rl.once('close', () => {
      void chain.then(() => resolve());
    }),
  );
}
