/**
 * Named PostgreSQL prepared statements on direct (session-mode) connections.
 *
 * Behind a transaction-mode pooler (PgBouncer `pooler: 'transaction'`), named
 * prepared statements are strictly disabled because consecutive transactions
 * can land on different server backends. On direct / session-mode connections,
 * however, every physical `pg.Client` stays bound to one PostgreSQL backend for
 * its lifetime, so reusing named plans skips server-side `Parse` + `Describe`
 * and lets PostgreSQL switch to generic plans on repeated queries.
 *
 * Safety invariants:
 * - Strictly opt-in at the pool checkout boundary ONLY when `pooler === 'session'`
 *   and `!destroyAfter`, and only for real `pg.Client` instances (preserving
 *   test doubles untouched).
 * - Only parameterized single DML/query statements (`SELECT`, `WITH`, `INSERT`,
 *   `UPDATE`, `DELETE`, no `;`, length <= 16 KiB, non-empty `values`). Simple
 *   protocol multi-statement messages (`BEGIN; LOCK ...; SELECT ...`) stay
 *   untouched.
 * - Two-hit admission filter per client: one-off queries never allocate a
 *   server-side prepared statement.
 * - Bounded at 256 prepared statements per client; reaching the cap marks the
 *   client for `DEALLOCATE ALL` on its next idle checkout (never mid-transaction).
 * - DDL / schema-move invalidation bumps a global generation; on the next idle
 *   checkout each client that holds prepared statements runs `DEALLOCATE ALL`
 *   and advances its unique name prefix (`m<prefix>_<hash>`) so `node-postgres`'s
 *   internal `parsedStatements` table never collides with deallocated names.
 * - Disabled when `MISTRI_PG_PREPARED=off`.
 */
import { createHash } from 'node:crypto';
import type { PgQuery, PgResult } from './postgresPool.js';

const MAX_PREPARED_PER_CLIENT = 256;
const MAX_SEEN_PER_CLIENT = 512;
const MAX_SQL_LENGTH = 16_384;
const MAX_HASH_CACHE = 2_048;

const PREPARABLE = /^\s*(?:SELECT|WITH|INSERT|UPDATE|DELETE)\b/i;
/* Wildcard projections (`SELECT *`, `RETURNING *`) change result row descriptor whenever an external
   session adds or drops a column, triggering PG 0A000 (`cached plan must not change result type`)
   mid-transaction. Skip naming them so external DDL never aborts a warm write transaction. */
const WILDCARD_RESULT = /\b(?:SELECT|RETURNING)\s+\*/i;
const PLAN_INVALIDATED_CODES = new Set(['0A000', '26000', '42P01', '42703']);

interface ClientPreparedState {
  gen: number;
  prefix: number;
  needsReset: boolean;
  lastEpoch?: string;
  readonly seen: Set<string>;
  readonly prepared: Map<string, string>;
}

let globalGen = 0;
let globalPrefix = 0;
const states = new WeakMap<object, ClientPreparedState>();
const hashes = new Map<string, string>();

/** Enabled by default on direct connections unless `MISTRI_PG_PREPARED=off`. */
export function preparedStatementsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.MISTRI_PG_PREPARED?.trim().toLowerCase();
  return raw !== 'off' && raw !== '0' && raw !== 'false';
}

/** True for a real `node-postgres` Client (carries `connection.parsedStatements`). */
export function isRealPgClient(client: object): boolean {
  const conn = (client as { connection?: { parsedStatements?: unknown } }).connection;
  return Boolean(conn && typeof conn === 'object' && 'parsedStatements' in conn);
}

/** Invalidate cached prepared statements across all pooled direct clients (e.g., after DDL). */
export function invalidatePreparedStatements(): void {
  globalGen += 1;
}

/** Test/diagnostics snapshot of a physical client's prepared statement state. */
export function preparedClientStats(client: object): Readonly<{ prepared: number; seen: number; needsReset: boolean; gen: number }> {
  const state = states.get(client);
  return {
    prepared: state?.prepared.size ?? 0,
    seen: state?.seen.size ?? 0,
    needsReset: state?.needsReset ?? false,
    gen: state?.gen ?? globalGen,
  };
}

function stateOf(client: object): ClientPreparedState {
  let state = states.get(client);
  if (!state) {
    state = { gen: globalGen, prefix: ++globalPrefix, needsReset: false, seen: new Set(), prepared: new Map() };
    states.set(client, state);
  }
  return state;
}

function hashOf(text: string): string {
  let digest = hashes.get(text);
  if (digest !== undefined) return digest;
  digest = createHash('sha256').update(text).digest('base64url').slice(0, 22);
  if (hashes.size >= MAX_HASH_CACHE) hashes.delete(hashes.keys().next().value!);
  hashes.set(text, digest);
  return digest;
}

function eligible(text: string, values: readonly unknown[] | undefined): boolean {
  return (
    values !== undefined &&
    values.length > 0 &&
    text.length <= MAX_SQL_LENGTH &&
    !text.includes(';') &&
    PREPARABLE.test(text) &&
    !WILDCARD_RESULT.test(text)
  );
}

function observePrologueEpoch(state: ClientPreparedState, result: unknown): void {
  const last = Array.isArray(result) ? result.at(-1) : result;
  const rows = (last as { rows?: readonly Record<string, unknown>[] } | null)?.rows;
  if (!rows || rows.length !== 1) return;
  const row = rows[0];
  const marker = typeof row?.epoch === 'string' ? row.epoch : typeof row?.digest === 'string' ? row.digest : undefined;
  if (!marker) return;
  if (state.lastEpoch !== undefined && state.lastEpoch !== marker) {
    if (state.prepared.size > 0) state.needsReset = true;
    state.prepared.clear();
    state.seen.clear();
    state.prefix = ++globalPrefix;
    invalidatePreparedStatements();
  }
  state.lastEpoch = marker;
}

/**
 * Flush server-side prepared statements on an idle client before a new checkout
 * begins whenever global DDL invalidation moved or the client hit its plan cap.
 * No-op (0 queries) when the client has no prepared statements or is current.
 */
export async function syncPreparedClient(client: PgQuery): Promise<void> {
  const state = states.get(client);
  if (!state) return;
  if (!state.needsReset && state.gen === globalGen) return;
  const hadPrepared = state.prepared.size > 0;
  state.prepared.clear();
  state.seen.clear();
  state.needsReset = false;
  state.gen = globalGen;
  state.prefix = ++globalPrefix;
  if (hadPrepared) await client.query('DEALLOCATE ALL');
}

/**
 * Wrap a direct (session-mode) `PgClient` so repeated parameterized DML/query
 * statements are automatically named with a 2-hit admission filter and bounded
 * per-client plan count.
 */
export function preparedClient(client: PgQuery): PgQuery {
  const state = stateOf(client);
  function query(text: string, params?: unknown[]): Promise<PgResult<Record<string, unknown>>>;
  function query(config: {
    text: string;
    values?: unknown[];
    rowMode?: string;
    queryMode?: 'extended';
    name?: string;
  }): Promise<PgResult<unknown[]>>;
  function query(
    request:
      | string
      | {
          text: string;
          values?: unknown[];
          rowMode?: string;
          queryMode?: 'extended';
          name?: string;
        },
    params?: unknown[],
  ): Promise<PgResult<Record<string, unknown>> | PgResult<unknown[]>> {
    const isString = typeof request === 'string';
    const text = isString ? request : request.text;
    const values = isString ? params : request.values;
    const alreadyNamed = !isString && request.name !== undefined;
    if (alreadyNamed || !eligible(text, values)) {
      const pending = isString ? client.query(request, params) : client.query(request);
      if (isString && values === undefined && (text.includes('AS epoch') || text.includes('AS digest'))) {
        return pending.then((res) => {
          observePrologueEpoch(state, res);
          return res;
        });
      }
      return pending;
    }
    let name = state.prepared.get(text);
    if (name === undefined) {
      if (state.seen.has(text)) {
        if (state.prepared.size < MAX_PREPARED_PER_CLIENT && !state.needsReset && state.gen === globalGen) {
          name = `m${state.prefix}_${hashOf(text)}`;
          state.prepared.set(text, name);
          state.seen.delete(text);
        } else {
          state.needsReset = true;
        }
      } else {
        if (state.seen.size >= MAX_SEEN_PER_CLIENT) state.seen.clear();
        state.seen.add(text);
      }
    }
    if (name === undefined) {
      return isString ? client.query(request, params) : client.query(request);
    }
    const config = isString ? { text, values, name } : { ...request, name };
    return (
      client.query(config as { text: string; values?: unknown[]; rowMode?: string; queryMode?: 'extended' }) as Promise<
        PgResult<Record<string, unknown>> | PgResult<unknown[]>
      >
    ).catch((error: unknown) => {
      state.prepared.delete(text);
      state.needsReset = true;
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code === 'string' && PLAN_INVALIDATED_CODES.has(code)) invalidatePreparedStatements();
      throw error;
    });
  }
  return Object.freeze({ query });
}
