/**
 * The tool surface as one list: which tools exist and in what order, which a
 * session is offered (writes, row reads, the launch profile), and the one
 * call path — runTool — that the stdio loop and the agent console share.
 * The tools themselves live in tools/, one file per family; this file only
 * assembles them, checks a call against its declaration, and adds what
 * every answer carries.
 */
import type { Registry } from '@mistriwork/engine/server/connections.js';
import {
  STATEMENT_TIMEOUT_MS,
  StatementStopped,
  stoppedReason,
  throwIfCancelled,
  withCancellation,
} from '@mistriwork/engine/adapters/statementControl.js';
import { openFor, sessionEgress, type Handler } from './toolkit.js';
import { distance } from '@mistriwork/engine/shared/suggest.js';
import * as schemaTools from './tools/schema.js';
import * as queryTools from './tools/query.js';
import * as sqlTools from './tools/sql.js';
import * as analysisTools from './tools/analysis.js';
import * as recordTools from './tools/record.js';
import * as writeTools from './tools/write.js';

/**
 * Declared data-first: name, what it answers, and the shape of the question.
 * The descriptions are written for a model deciding which tool to call, which
 * is a reader that rewards saying what a thing is *for*. The output schemas
 * describe without demanding — no `required` — because several tools answer
 * in deliberate variants: a query that does not parse returns errors where
 * rows would go, a record that does not exist returns `found: false` and
 * little else, and a schema that failed both would turn a designed answer
 * into a client-side validation error.
 */
const TOOLS = [
  ...schemaTools.definitions,
  ...queryTools.definitions,
  ...sqlTools.definitions,
  ...analysisTools.definitions,
  ...recordTools.definitions,
];
const WRITE_TOOLS = [...writeTools.definitions];
const WRITE_NAMES = new Set<string>(WRITE_TOOLS.map((t) => t.name));

/* Every handler by tool name. A Map, not an object: a tool called
   "toString" is no tool, not Object.prototype's. */
const HANDLERS = new Map<string, Handler>(
  Object.entries({
    ...schemaTools.handlers,
    ...queryTools.handlers,
    ...sqlTools.handlers,
    ...analysisTools.handlers,
    ...recordTools.handlers,
    ...writeTools.handlers,
  }),
);

/** One tool's answer, before stats: the connection it names is opened first. */
async function callTool(registry: Registry, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (name === 'connections') return schemaTools.connections(registry);
  const opened = await openFor(registry, args.connection);
  const handler = HANDLERS.get(name);
  if (!handler) throw new Error(`No tool called "${name}".`);
  return handler({ registry, args, ...opened });
}

/**
 * Which tools a session is given, chosen at launch.
 *
 * Every definition is a fixed cost every agent pays on connect, before
 * it has asked anything — and most sessions are one job. An agent reading a
 * schema does not need the graph writers; an agent seeding a fixture does not
 * need `explain`. A profile is the caller saying which job this is.
 *
 * `full` stays the default. Narrowing what a server can do by default would
 * remove capability from every existing setup to save tokens in some of them,
 * which is the wrong way round: the cost is real, and so is the surprise of a
 * tool that used to be there.
 *
 * `connections` and `refresh` are in every profile. The first is documented as
 * the call to start with and the second is how an agent recovers from a schema
 * that changed underneath it — a session without them is one that cannot find
 * its footing after a migration.
 */
const ALWAYS = ['connections', 'refresh'];

const TOOL_PROFILES: Record<string, string[] | null> = {
  /* Everything. */
  full: null,
  /* Reading a database you did not write: what is here, what points at what,
     what the columns actually hold. */
  explore: [...ALWAYS, 'schema_summary', 'tables', 'table', 'find', 'query', 'breakdown', 'sql', 'record', 'explain', 'profile'],
  /* Changing a shape safely: what breaks, what it costs, what order it has to
     happen in, and whether it matches somewhere else afterwards. */
  migrate: [...ALWAYS, 'schema_summary', 'tables', 'table', 'change_impact', 'lint', 'order', 'diff', 'profile', 'explain'],
  /* Test data that respects referential integrity, in and out. */
  seed: [
    ...ALWAYS,
    'schema_summary',
    'tables',
    'table',
    'order',
    'fixture',
    'record',
    'query',
    'insert',
    'insert_graph',
    'delete_graph',
    'revert',
  ],
};

let toolProfile: string[] | null = null;

/** @throws if the name is not a profile, naming the ones that are. */
export function setToolProfile(name: string): void {
  if (!name) return;
  if (!(name in TOOL_PROFILES)) {
    throw new Error(`"${name}" is not a tool profile. Choose one of: ${Object.keys(TOOL_PROFILES).join(', ')}.`);
  }
  toolProfile = TOOL_PROFILES[name];
}

/**
 * Whether `tools/list` advertises each tool's `outputSchema`.
 *
 * Off by default, and that default is a measurement rather than a taste. On a
 * 66-table schema the whole listing is about 8,500 tokens — paid by every
 * agent, every session, before it has asked anything — and `outputSchema` is
 * exactly half of it. Fourteen per cent is one `stats` block, byte-identical
 * across every tool, because JSON Schema has no way for one document to point
 * at another's definition.
 *
 * It is optional in MCP and it is a contract rather than a prompt: a client
 * that validates `structuredContent` wants it, and most agents never read it.
 * `structuredContent` itself is unaffected either way — the answers carry the
 * same fields whether or not their shape was declared in advance. So the
 * contract stays available to anyone who needs it, and stops being charged to
 * everyone who does not.
 */
let advertiseOutputSchema = false;
export function setAdvertiseOutputSchema(on: boolean): void {
  advertiseOutputSchema = on;
}

/**
 * The full tool complement, for the prose that states it: README and the
 * site both name the number, and test/prose.test.ts holds them to this.
 */
export const toolCounts = () => ({ read: TOOLS.length, write: WRITE_TOOLS.length });
/** Every tool's name, reads then writes, for the prose that must list them all. */
export const toolNames = () => [...TOOLS, ...WRITE_TOOLS].map((t) => t.name);

/**
 * The tools as a client sees them: reads always, writes only when some
 * connection's config allows any. Exported for the agent console, which
 * shows exactly this list — a second list would be a second truth.
 */
export function agentTools(registry: Registry) {
  const connections = registry.list();
  const anyWritable = connections.some((c) => c.writable);
  const listed = anyWritable ? [...TOOLS, ...WRITE_TOOLS] : [...TOOLS];
  /* If no connection will return a row, the tools that only return rows are
     not a capability this server has — and a tool an agent can see is a tool
     it will spend a call discovering. The same reasoning as the write tools,
     one boundary further out. `find` stays: its name mode is shape. */
  const anyRows = connections.some((c) => c.rows !== false);
  const byRows = anyRows ? listed : listed.filter((t) => !ROW_ONLY_TOOLS.has(t.name));
  /* Raw SQL is refused on a connection that hides columns: where every one
     does, the statement tools are not a capability either. */
  const anySql = connections.some((c) => !c.hidesColumns);
  const bySql = anySql ? byRows : byRows.filter((t) => !SQL_TOOLS.has(t.name));
  /* The profile narrows what the connection already allows, rather than
     widening it: a read-only server given the `seed` profile still lists no
     write tools. Every filter here only ever removes. */
  const wanted = toolProfile;
  const visible = wanted ? bySql.filter((t) => wanted.includes(t.name)) : bySql;
  if (advertiseOutputSchema) return visible;
  return visible.map(({ outputSchema: _schema, ...tool }) => tool);
}

/** Tools whose whole answer is row data. */
const ROW_ONLY_TOOLS = new Set(['query', 'sql', 'record', 'breakdown']);
/** Tools that hand the database a statement it did not build. */
const SQL_TOOLS = new Set(['sql', 'explain']);

interface InputSchema {
  properties?: Record<string, { type?: string | string[]; enum?: unknown[] }>;
  required?: string[];
  additionalProperties?: boolean;
}

/** Why the arguments do not fit the tool's declared shape, or null. */
function argumentProblem(schema: InputSchema, args: Record<string, unknown>): string | null {
  const known = Object.keys(schema.properties ?? {});
  if (schema.additionalProperties === false) {
    /* `connection` is every tool's, as the `connections` tool says, whether
       or not the tool's own schema spells it out. */
    const stray = Object.keys(args).filter((k) => !known.includes(k) && k !== 'connection');
    if (stray.length) {
      const hint = stray.map((k) => {
        /* A guess when one is close: a shared prefix (`qeury` → `q`,
           `tabel` → `table`), or two edits apart (`limt` → `limit`). */
        const near = known.find((n) => k.startsWith(n) || n.startsWith(k) || distance(n, k) <= 2);
        return near ? `"${k}" (did you mean "${near}"?)` : `"${k}"`;
      });
      return `unknown argument ${hint.join(', ')}. It takes: ${known.join(', ') || 'no arguments'}.`;
    }
  }
  const missing = (schema.required ?? []).filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
  if (missing.length) return `missing ${missing.map((k) => `"${k}"`).join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} required.`;
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    const types = Array.isArray(spec.type) ? spec.type : spec.type ? [spec.type] : [];
    if (!types.length) continue;
    const fits = types.some((t) => {
      if (t === 'string') return typeof value === 'string';
      if (t === 'number' || t === 'integer')
        return typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)));
      if (t === 'boolean') return typeof value === 'boolean' || value === 'true' || value === 'false';
      if (t === 'array') return Array.isArray(value) || typeof value === 'string';
      if (t === 'object') return typeof value === 'object' && !Array.isArray(value);
      return true;
    });
    if (!fits) return `"${key}" should be ${types.join(' or ')}, not ${Array.isArray(value) ? 'an array' : typeof value}.`;
    if (spec.enum && !spec.enum.includes(value)) return `"${key}" must be one of ${spec.enum.map((v) => JSON.stringify(v)).join(', ')}.`;
  }
  return null;
}

/**
 * Run one tool and shape the answer the way MCP shapes it — content, the
 * structured answer, stats, isError. The stdio loop and the agent console
 * both call this, which is what makes the console's claim true: what it
 * shows is byte-identical to what an agent receives.
 *
 * `signal` is the client's cancel. Every statement the call runs can be
 * stopped by it — the adapters read it (statementControl.ts) — and without
 * one the call still runs under a signal of its own, so a raw SQLite read
 * has its cap on the console as over stdio.
 */
export async function runTool(
  registry: Registry,
  name: string,
  args: Record<string, unknown>,
  options: { signal?: AbortSignal } = {},
): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown>; isError: boolean }> {
  const signal = options.signal ?? new AbortController().signal;
  try {
    /* The profile is enforced here, not only in the listing. `--tools explore`
       used to hide `delete` from tools/list and then run it for any client
       that knew the name — a filter on the menu, not on the kitchen. A profile
       only ever removes, so a tool outside it is refused with the profile
       named; a client that needs it starts the server with a wider one. */
    if (toolProfile && !toolProfile.includes(name)) {
      throw new Error(
        `"${name}" is not offered by this server's tool profile. ` +
          `Offered: ${toolProfile.join(', ')}. Start tablewalk with --tools full to widen it.`,
      );
    }
    /* The declared shape, enforced. `additionalProperties: false` and
       `required` were advertised and then ignored: a misspelled argument
       (`tabel`) vanished and the error was about the one that was missing —
       the opposite of an error that teaches. Types are checked loosely, in
       the direction the handlers already coerce: a number may arrive as a
       numeric string, an array as a comma-separated one. */
    const declared = [...TOOLS, ...WRITE_TOOLS].find((t) => t.name === name);
    if (declared) {
      const problem = argumentProblem(declared.inputSchema as InputSchema, args);
      if (problem) throw new Error(`${name}: ${problem}`);
    }
    /* A call withdrawn before its turn never starts. */
    throwIfCancelled(signal);
    const started = Date.now();
    const answered = await withCancellation(signal, () => callTool(registry, name, args));
    /* A read the client cancelled answers as cancelled even when its last
       statement beat the cancel home. A write that finished says what it
       did: an agent told "cancelled" about a write that landed would make it
       again. */
    if (signal.aborted && !WRITE_NAMES.has(name)) throw new StatementStopped('cancelled');
    /* Every answer says what it cost: wall time for the whole call,
       the data rows it returned, and — on the write tools — the rows
       it changed. The read/write split is deliberate: an update that
       read nothing and wrote one row should say exactly that. */
    const delivered = (record: Record<string, unknown>) =>
      (record.found === true ? 1 : 0) +
      (Array.isArray(record.pointedAtBy)
        ? (record.pointedAtBy as Array<{ rows?: unknown[] }>).reduce((n, r) => n + (r.rows?.length ?? 0), 0)
        : 0);
    const rows =
      typeof answered.rowsRead === 'number'
        ? /* A fixture counts what it read, since its rows are grouped by table
         rather than being one list — and every one of them left the
         machine. */
          answered.rowsRead
        : Array.isArray(answered.rows)
          ? (answered.rows as unknown[]).length
          : Array.isArray(answered.matches)
            ? (answered.matches as unknown[]).length
            : Array.isArray(answered.records)
              ? (answered.records as Array<Record<string, unknown>>).reduce((n, r) => n + delivered(r), 0)
              : answered.found === true || answered.found === false
                ? delivered(answered)
                : undefined;
    const affected = typeof answered.affected === 'number' ? answered.affected : undefined;
    /* A graph counts its own list rather than an `affected` it never has —
       and `inserted` is a boolean for `insert` and a list for `insert_graph`,
       which is what the array check tells apart. */
    const graphIn = name === 'insert_graph' && Array.isArray(answered.inserted) ? (answered.inserted as unknown[]).length : undefined;
    const graphOut =
      name === 'delete_graph' && Array.isArray(answered.removed)
        ? (answered.removed as Array<{ affected?: number }>).reduce((n, r) => n + (r.affected ?? 0), 0)
        : undefined;
    const written = name === 'update' ? affected : name === 'delete' && answered.deleted === true ? affected : (graphOut ?? graphIn);
    const removals = name === 'delete' || name === 'delete_graph';
    const inserted = name === 'insert' && answered.inserted === true ? 1 : graphIn;
    if (rows && typeof answered.connection === 'string') {
      sessionEgress.set(answered.connection, (sessionEgress.get(answered.connection) ?? 0) + rows);
    }
    const structured = {
      ...answered,
      stats: {
        ms: Date.now() - started,
        ...(rows === undefined ? {} : { rowsRead: rows }),
        ...(written === undefined ? {} : removals ? { rowsDeleted: written } : { rowsWritten: written }),
        ...(inserted === undefined ? {} : { rowsInserted: inserted }),
      },
    };
    return {
      /* Compact. The text is a byte-for-byte duplicate of structuredContent
         for clients that read only text; pretty-printing it was the largest
         avoidable cost in every answer — a quarter again on nested rows —
         spent on whitespace no model reads. */
      content: [{ type: 'text', text: JSON.stringify(structured) }],
      structuredContent: structured,
      isError: false,
    };
  } catch (err) {
    /* A tool that fails is a result, not a protocol error — the model
       reads the message and adjusts; a JSON-RPC error would read as
       the server being broken. */
    return {
      content: [{ type: 'text', text: stoppedText(err, signal.aborted) ?? (err as Error).message }],
      isError: true,
    };
  }
}

/**
 * A stopped call, said so the agent knows what to do next: a cancelled one
 * is over, and one that ran into its cap wants a narrower question.
 */
function stoppedText(error: unknown, cancelled: boolean): string | undefined {
  if (cancelled) return 'Cancelled: the client withdrew this call, and the statement it was running was stopped.';
  if (stoppedReason(error) !== 'timeout') return undefined;
  const cap = error instanceof StatementStopped ? error.capMs : undefined;
  const lowered = cap !== undefined && cap < STATEMENT_TIMEOUT_MS ? ` (${cap} ms for this one)` : '';
  return (
    `${(error as Error).message.replace(/\.?$/, '.')} Every statement runs under a ${STATEMENT_TIMEOUT_MS / 1000}-second ` +
    `cap${lowered}: narrow the question — a filter, a smaller limit — and ask again.`
  );
}
