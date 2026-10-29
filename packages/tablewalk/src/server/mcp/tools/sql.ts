/**
 * The two tools that hand the database a statement it did not build: `sql`
 * runs one read, `explain` plans one without running it. Their guarantees
 * come from the adapter — a read-only transaction, one statement per call, a
 * bounding wrap, the statement cap, and the reserved-table guard both ask
 * for — and their errors are taught here, because the engine's own "no such
 * table" has nothing in it to retry with.
 */
import { clampLimit } from '@mistriwork/engine/adapters/adapter.js';
import { STATEMENT_TIMEOUT_MS } from '@mistriwork/engine/adapters/statementControl.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { distance } from '@mistriwork/engine/shared/suggest.js';
import { READS, STATS, type Handler } from '../toolkit.js';

export const definitions = [
  {
    name: 'sql',
    description:
      'Run a read-only SQL SELECT when the query language cannot say it — window functions, ' +
      'CTEs, self-joins. Ordinary grouping is `breakdown` now, and that is the one to reach ' +
      'for first: it binds every value and checks every path against the catalog, where this ' +
      'hands the database text it did not build. The connection is read-only: writes fail at the database. ' +
      'Results are row-limited; say LIMIT yourself for anything else. ' +
      `Every statement runs under a ${STATEMENT_TIMEOUT_MS / 1000}-second cap, and \`timeout_ms\` lowers it for this ` +
      'one — probing five query shapes wants fast failure. A statement that touches tablewalk’s own ' +
      'runtime or sign-in tables (the `__mistri_` prefix, the `mistri` schema, and their `__tablewalk_` and `tablewalk_auth` names before mistri) is refused, and so is ' +
      'one that could only name a table when it runs.',
    inputSchema: {
      type: 'object',
      properties: {
        statement: { type: 'string' },
        limit: { type: 'number' },
        timeout_ms: {
          type: 'number',
          description: `Lower this statement’s ${STATEMENT_TIMEOUT_MS / 1000}-second cap, in ms. Floor 100; never raises it.`,
        },
        connection: { type: 'string' },
      },
      required: ['statement'],
      additionalProperties: false,
    },
    annotations: { title: 'Read-only SQL', ...READS },
    outputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        columns: { type: 'array', items: { type: 'string' } },
        rows: { type: 'array', items: { type: 'object' } },
        truncated: { type: 'boolean' },
        errors: { type: 'array', description: 'The database’s words, when it refused.', items: { type: 'string' } },
        sql: { type: 'object' },
        stats: STATS,
      },
    },
  },
  {
    name: 'explain',
    description:
      'The planner’s account of how a statement would run, without running it — the ' +
      '"does this use the index or walk the table" answer `sql` cannot give, because its ' +
      'bounding wrap changes the plan. Feed it the `sql` a `query` answer returned — text ' +
      'and params both, placeholders included — or any statement of your own. Plans only, ' +
      'never executes: the analysing variants that run the statement are refused by ' +
      'construction, so explaining a write is safe and tells you what the write would do ' +
      'to the indexes. A statement that touches tablewalk’s own runtime or sign-in tables is ' +
      'refused, as in `sql`.',
    inputSchema: {
      type: 'object',
      properties: {
        statement: { type: 'string', description: 'The SQL to explain, placeholders allowed.' },
        params: {
          type: 'array',
          description: 'Bound values for the placeholders, in order — a `query` answer’s `sql.params`, verbatim.',
          items: { type: ['string', 'number', 'boolean', 'null'] },
        },
        connection: { type: 'string' },
      },
      required: ['statement'],
      additionalProperties: false,
    },
    annotations: { title: 'Explain a statement', ...READS },
    outputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        plan: {
          type: 'array',
          description: 'One line per plan node, indented as the tree nests, in the engine’s own words.',
          items: { type: 'string' },
        },
        stats: STATS,
      },
    },
  },
] as const;

type Name = (typeof definitions)[number]['name'];

export const handlers = {
  sql: async ({ args, adapter, schema, id }) => {
    if (!adapter.runSql) {
      throw new Error(`${schema.dialect} connections cannot run SQL in this build. Use \`query\`.`);
    }
    const statement = String(args.statement ?? '').trim();
    if (!statement) throw new Error('Nothing to run.');
    // Never a write. The read-only handle refuses one anyway; not asking is
    // what makes this tool safe to hand to something that retries.
    const result = await teaching(schema, () =>
      adapter.runSql!({
        text: statement,
        limit: clampLimit(args.limit ?? 100),
        write: false,
        timeoutMs: args.timeout_ms === undefined ? undefined : Number(args.timeout_ms),
        refuseReserved: true,
      }),
    );
    return { connection: id, ...result };
  },
  explain: async ({ args, adapter, schema, id }) => {
    if (!adapter.explainSql) {
      throw new Error(`${schema.dialect} connections cannot explain in this build.`);
    }
    const statement = String(args.statement ?? '').trim();
    if (!statement) throw new Error('Nothing to explain.');
    const params = Array.isArray(args.params) ? args.params : [];
    const result = await teaching(schema, () => adapter.explainSql!({ text: statement, params, refuseReserved: true }));
    return { connection: id, plan: result.plan };
  },
} satisfies Record<Name, Handler>;

/* How each engine says "there is no such table", and where the name sits in
   what it said. Recognising the message rather than an error code because
   that is what the drivers agree on having. */
const NO_SUCH_TABLE = [
  /no such table:\s*([^\s;]+)/i, // sqlite
  /relation "([^"]+)" does not exist/i, // postgres
];

/**
 * Run raw SQL and, if the engine refuses it, answer the way the rest of these
 * tools do.
 *
 * `sql` and `explain` are the two tools that hand a statement to the engine
 * whole, so they are the two that answered "no such table: nonesuch" where
 * `query` answers with what exists and what to ask next. An agent retrying
 * against a message like that has nothing to retry *with* — the whole value
 * of an error here is the sentence after the diagnosis.
 */
async function teaching<T>(schema: DatabaseSchema, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    const named = NO_SUCH_TABLE.map((p) => p.exec(message)).find(Boolean)?.[1];
    if (!named) throw err;
    const bare = named.replace(/^.*\./, '').replace(/["`]/g, '');
    const near = schema.tables
      .map((t) => ({ id: t.id, d: distance(bare.toLowerCase(), t.name.toLowerCase()) }))
      .sort((a, b) => a.d - b.d)[0];
    const suggestion = near && near.d <= 3 ? ` Did you mean "${near.id}"?` : '';
    throw new Error(
      `${message}.${suggestion} Ask \`tables\` for what exists — or \`refresh\` if it was ` +
        'just created. Names here are as the database spells them, schema included.',
    );
  }
}
