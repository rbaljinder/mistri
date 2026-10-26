/**
 * What every tool family shares: the hints and the cost stanza their
 * declarations spread, the shape of a call, how a call finds its
 * connection, the deep link an answer carries, and the count of rows that
 * have left the machine. A family imports this and none of its siblings.
 */
import type { Registry } from '@mistriwork/engine/server/connections.js';
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import { findTable, primaryKey, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';

/**
 * The hints a client acts on without reading prose: reading is all the read
 * tools do, asking twice is the same as asking once, and the world they touch
 * is the configured database, not the open internet. Declared once and spread
 * — hints that drifted per-tool would lie about exactly the thing they exist
 * to make machine-readable. A client that trusts them can stop asking
 * permission for every look.
 */
export const READS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** The stanza the dispatch loop appends to every answer, declared once for
    the output schemas below. */
export const STATS = {
  type: 'object',
  description: 'What the call cost: wall ms, and rows read/written/deleted when rows moved.',
  properties: {
    ms: { type: 'number' },
    rowsRead: { type: 'number' },
    rowsWritten: { type: 'number' },
    rowsInserted: { type: 'number' },
    rowsDeleted: { type: 'number' },
  },
} as const;

export interface Open {
  adapter: Adapter;
  schema: DatabaseSchema;
  id: string;
}

/** One tool call: its arguments, and the connection they named, opened. */
export interface ToolCall extends Open {
  registry: Registry;
  args: Record<string, unknown>;
}

/** What a tool does with a call. The answer is the structured result, before stats. */
export type Handler = (call: ToolCall) => Promise<Record<string, unknown>>;

export async function openFor(registry: Registry, asked: unknown): Promise<Open> {
  const wanted = typeof asked === 'string' && asked ? asked : registry.active;
  const entry = registry.list().find((c) => c.id === wanted || c.name === wanted);
  if (!entry) {
    const known = registry
      .list()
      .map((c) => c.id)
      .join(', ');
    throw new Error(`No connection called "${String(wanted)}". Known: ${known}.`);
  }
  const { adapter, schema } = await registry.open(entry.id);
  return { adapter, schema, id: entry.id };
}

/** The deep link a result can be opened at, for the human beside the agent. */
export const linkTo = (conn: string, segment: string) => `/${encodeURIComponent(conn)}/${segment}`;

/**
 * Rows that have left the machine this session, per connection.
 *
 * The README's trust boundary — "rows entering an agent's context leave the
 * machine" — as a number instead of a sentence. Counted where stats are
 * made, reported by `connections`, so one call answers "what has the agent
 * seen".
 */
export const sessionEgress = new Map<string, number>();

/**
 * The bound a count in an answer stops at: the one App menus count to. A
 * count is how an agent sizes a question, and "more than ten thousand"
 * sizes it as well as the exact number, for a fraction of the scan. Past
 * the bound an answer carries the bound and says so.
 */
export const COUNT_LIMIT = 10_000;
/* The bound in words, for the tool descriptions. Grouped by hand rather than
   with toLocaleString, which starts ICU (30 to 170 ms) at module load, on
   every --mcp start, to print one number. */
export const COUNT_LIMIT_WORDS = String(COUNT_LIMIT).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** A key that names every primary-key column, or the error that says which are missing. */
export function wholeKeyOrThrow(schema: DatabaseSchema, table: { name: string; id: string }, key: Record<string, string | number>): void {
  const wanted = primaryKey(findTable(schema, table.id)!);
  const missing = wanted.filter((c) => key[c] === undefined);
  if (missing.length) {
    throw new Error(`The key is missing ${missing.join(', ')} — a ${table.name} is identified by (${wanted.join(', ')}).`);
  }
}
