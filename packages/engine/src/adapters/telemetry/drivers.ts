/**
 * A span for every statement the process runs, whichever of the three
 * drivers runs it: node:sqlite and pg.
 *
 * At the driver, not in each adapter, because statements reach the database
 * from dozens of places — the adapters, the command journal, the auth store,
 * the job and event stores — and a span added to each would be a span
 * forgotten in the next. Wrapping the driver's own `query` is also how the
 * vendors' agents do it (dd-trace, OneAgent), and the wrappers chain: each
 * keeps the function it found, so an agent loaded first or last still sees
 * every call, and the modules keep their identity.
 *
 * Installed only when something listens (start.ts), and a statement is a
 * span only inside another one — a request, a job, a command. Startup's
 * catalog reads are not a trace anyone asked for.
 *
 * What travels: `db.system.name`, `db.operation.name`, `db.collection.name`,
 * `db.query.summary` (statement.ts). What stays local, for the dev observer:
 * the text, the parameters, the rows returned, the transaction, and a way to
 * EXPLAIN it later.
 */
import { AsyncResource } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { startSpan, observing, currentSpan, type Span } from './trace.js';
import { summarizeStatement } from './statement.js';

type Dialect = 'sqlite' | 'postgresql';

/** How to EXPLAIN a statement the observer shows, by its span. Bounded, and filled only while observing. */
const explainers = new Map<string, () => Promise<string[]>>();
const EXPLAINERS = 4000;
function keepExplainer(spanId: string, explain: () => Promise<string[]>) {
  explainers.set(spanId, explain);
  if (explainers.size > EXPLAINERS) explainers.delete(explainers.keys().next().value!);
}
/** The plan of a statement the observer recorded, run read-only; undefined when it can no longer be asked. */
export async function explainStatement(spanId: string): Promise<string[] | undefined> {
  const explain = explainers.get(spanId);
  return explain ? explain() : undefined;
}

const EXPLAINABLE = new Set(['SELECT', 'WITH']);

/** A statement's span, begun but not made current: a statement has no children. The caller ends it. */
function beginStatement(
  dialect: Dialect,
  text: string,
  params: unknown,
  explain?: (span: Span) => (() => Promise<string[]>) | undefined,
): Span {
  const { operation, table, summary } = summarizeStatement(text);
  const span = startSpan(summary, {
    kind: 'client',
    childOnly: true,
    attributes: {
      'db.system.name': dialect,
      'db.operation.name': operation,
      'db.collection.name': table,
      'db.query.summary': summary,
    },
  });
  if (span.recording) {
    span.detail(() => ({
      sql: text.length > 20_000 ? `${text.slice(0, 20_000)}…` : text,
      ...(params !== undefined ? { params: Array.isArray(params) ? params.slice(0, 200) : params } : {}),
    }));
    if (observing() && EXPLAINABLE.has(operation)) {
      const explainer = explain?.(span);
      if (explainer) keepExplainer(span.spanId, explainer);
    }
  }
  return span;
}

/** Settle a statement's span with its promise. */
function settle<T>(span: Span, out: T): T {
  if (!out || typeof (out as { then?: unknown }).then !== 'function') {
    span.end();
    return out;
  }
  return (out as unknown as Promise<unknown>).then(
    (result) => {
      noteRows(span, result);
      span.end();
      return result;
    },
    (error) => {
      span.fail(errorKind(error), error);
      span.end();
      throw error;
    },
  ) as T;
}

const rowsOf = (result: unknown): number | undefined => {
  if (Array.isArray(result)) return result.length;
  if (result && typeof result === 'object') {
    const r = result as { rowCount?: unknown; rows?: unknown; affectedRows?: unknown; changes?: unknown };
    if (typeof r.rowCount === 'number') return r.rowCount;
    if (Array.isArray(r.rows)) return r.rows.length;
    if (typeof r.affectedRows === 'number') return r.affectedRows;
    if (typeof r.changes === 'number' || typeof r.changes === 'bigint') return Number(r.changes);
  }
  return undefined;
};
const noteRows = (span: Span, result: unknown) => {
  const rows = rowsOf(result);
  if (rows !== undefined) {
    span.setAttribute('db.response.returned_rows', rows);
    span.detail(() => ({ rows }));
  }
};

let installed = false;
/** Wrap the drivers once, for the life of the process. */
export function instrumentDrivers(): void {
  if (installed) return;
  installed = true;
  instrumentSqlite();
  const require = createRequire(import.meta.url);
  try {
    instrumentPg(require('pg'));
  } catch {
    /* pg is optional */
  }
}

/**
 * A pool's checkout, bound to whoever asked for it. A pool that is full
 * queues the waiter and calls it back when another request releases its
 * connection — from inside that request's release, and so inside its async
 * context. `pool.query` asks through that callback, so without this its
 * statement was counted in the releasing request's trace (a finished one,
 * often) and never in its own, and a busy row-policy App's traces showed
 * N+1 patterns that were only other requests' lookups. A promise checkout
 * needs nothing: `await` resumes in the awaiting context.
 */
function bindCheckouts(proto: Record<string, unknown> | undefined, method: string): void {
  const original = proto?.[method];
  if (!proto || typeof original !== 'function') return;
  proto[method] = function (this: unknown, ...args: unknown[]) {
    const at = args.findIndex((arg) => typeof arg === 'function');
    // Bound whether or not a span is current: a waiter outside any request must not land in the releaser's either.
    if (at >= 0) args[at] = AsyncResource.bind(args[at] as (...a: unknown[]) => unknown);
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  };
}

/* ---------- node:sqlite ---------- */

const statementDb = new WeakMap<StatementSync, WeakRef<DatabaseSync>>();
const sqliteTx = new WeakMap<DatabaseSync, { n: number; open: boolean; id: number }>();
let sqliteIds = 0;

function sqliteTransaction(db: DatabaseSync | undefined): string | undefined {
  if (!db) return undefined;
  let state = sqliteTx.get(db);
  if (!state) sqliteTx.set(db, (state = { n: 0, open: false, id: ++sqliteIds }));
  let inside = false;
  try {
    inside = db.isTransaction;
  } catch {
    return undefined;
  }
  if (inside && !state.open) state.n++;
  state.open = inside;
  return inside ? `sqlite:${state.id}/tx${state.n}` : undefined;
}

function instrumentSqlite() {
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, ...args: Parameters<typeof prepare>) {
    const statement = prepare.apply(this, args);
    if (currentSpan()) statementDb.set(statement, new WeakRef(this));
    return statement;
  } as typeof prepare;
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
    if (!currentSpan()) return exec.call(this, sql);
    const span = beginStatement('sqlite', sql, undefined);
    try {
      const out = exec.call(this, sql);
      const tx = sqliteTransaction(this);
      if (tx) span.detail(() => ({ transaction: tx }));
      return out;
    } catch (error) {
      span.fail(errorKind(error), error);
      throw error;
    } finally {
      span.end();
    }
  } as typeof exec;
  for (const method of ['all', 'get', 'run'] as const) {
    const original = StatementSync.prototype[method] as (...args: unknown[]) => unknown;
    (StatementSync.prototype as unknown as Record<string, unknown>)[method] = function (this: StatementSync, ...args: unknown[]) {
      if (!currentSpan()) return original.apply(this, args);
      const db = statementDb.get(this)?.deref();
      const text = this.sourceSQL;
      const ref = statementDb.get(this);
      const span = beginStatement('sqlite', text, args, () =>
        ref
          ? () => {
              const target = ref.deref();
              if (!target || !target.isOpen) return Promise.resolve(['The database this ran on is closed.']);
              const rows = prepare.call(target, `EXPLAIN QUERY PLAN ${text}`).all(...(args as never[])) as Array<{
                id: number;
                parent: number;
                detail: string;
              }>;
              const depth = new Map<number, number>();
              return Promise.resolve(
                rows.map((row) => {
                  const level = (depth.get(row.parent) ?? -1) + 1;
                  depth.set(row.id, level);
                  return `${'  '.repeat(level)}${row.detail}`;
                }),
              );
            }
          : undefined,
      );
      try {
        const tx = sqliteTransaction(db);
        const result = original.apply(this, args);
        if (method === 'get') {
          span.setAttribute('db.response.returned_rows', result === undefined ? 0 : 1);
          span.detail(() => ({ rows: result === undefined ? 0 : 1 }));
        } else noteRows(span, result);
        if (tx) span.detail(() => ({ transaction: tx }));
        return result;
      } catch (error) {
        span.fail(errorKind(error), error);
        throw error;
      } finally {
        span.end();
      }
    };
  }
}

/* ---------- pg ---------- */

interface PgClientLike {
  query(...args: unknown[]): unknown;
  connectionParameters?: Record<string, unknown>;
}
type PgClientClass = { prototype: PgClientLike } & (new (
  config: unknown,
) => PgClientLike & { connect(): Promise<void>; end(): Promise<void> });
const pgTx = new WeakMap<object, { n: number; open: boolean; id: number }>();
let pgIds = 0;

export function instrumentPg(pg: { Client?: PgClientClass; Pool?: { prototype: Record<string, unknown> } }) {
  bindCheckouts(pg?.Pool?.prototype, 'connect');
  const Client = pg?.Client;
  if (!Client?.prototype?.query) return;
  const query = Client.prototype.query;
  Client.prototype.query = function (this: PgClientLike, ...args: unknown[]) {
    const [config, values] = args;
    const submittable = config && typeof config === 'object' && typeof (config as { submit?: unknown }).submit === 'function';
    if (!currentSpan() || submittable) return query.apply(this, args);
    const text = typeof config === 'string' ? config : String((config as { text?: unknown })?.text ?? '');
    const params = typeof values === 'function' || values === undefined ? (config as { values?: unknown })?.values : values;
    let state = pgTx.get(this);
    if (!state) pgTx.set(this, (state = { n: 0, open: false, id: ++pgIds }));
    const head = text.trimStart().slice(0, 20).toUpperCase();
    if (/^(BEGIN|START TRANSACTION)/.test(head)) {
      state.n++;
      state.open = true;
    }
    const tx = state.open ? `pg:${state.id}/tx${state.n}` : undefined;
    if (/^(COMMIT|ROLLBACK|END)\b/.test(head) && !head.startsWith('ROLLBACK TO')) state.open = false;
    const settings = this.connectionParameters;
    const span = beginStatement('postgresql', text, params, () =>
      settings ? pgExplainer(Client, { ...settings }, text, params) : undefined,
    );
    if (tx) span.detail(() => ({ transaction: tx }));
    const callbackAt = args.findIndex((arg) => typeof arg === 'function');
    if (callbackAt >= 0) {
      const done = args[callbackAt] as (error: unknown, result: unknown) => void;
      args[callbackAt] = (error: unknown, result: unknown) => {
        if (error) span.fail(errorKind(error), error);
        else noteRows(span, result);
        span.end();
        done(error, result);
      };
      try {
        return query.apply(this, args);
      } catch (error) {
        span.fail(errorKind(error), error);
        span.end();
        throw error;
      }
    }
    return settle(span, query.apply(this, args));
  } as typeof query;
}

function pgExplainer(Client: PgClientClass, settings: Record<string, unknown>, text: string, params: unknown) {
  return async () => {
    // Its own connection, read-only: the one the statement ran on may be in someone's transaction now.
    const probe = new Client({
      user: settings.user,
      password: settings.password,
      host: settings.host,
      port: settings.port,
      database: settings.database,
      ssl: settings.ssl,
      options: settings.options,
      connectionTimeoutMillis: 5000,
    });
    await probe.connect();
    try {
      await probe.query('BEGIN READ ONLY');
      await probe.query("SET LOCAL statement_timeout = '5s'");
      const plan = (await probe.query(`EXPLAIN ${text}`, Array.isArray(params) ? params : [])) as { rows: Array<Record<string, string>> };
      return plan.rows.map((row) => String(Object.values(row)[0]));
    } finally {
      await (probe.query('ROLLBACK') as Promise<unknown>).catch(() => {});
      await probe.end().catch(() => {});
    }
  };
}

/** A driver error's travelling name: its SQLSTATE or errno name when it has one (never its message). */
function errorKind(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'DatabaseError';
}
