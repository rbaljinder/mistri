/**
 * A leased PostgreSQL client made safe behind a transaction-mode pooler:
 * PgBouncer with `pool_mode = transaction`, or RDS Proxy, which multiplexes
 * the same way until a session setting pins a connection.
 *
 * Such a pooler lends a server connection for one transaction and gives it to
 * another client for the next. A setting made on the session therefore does
 * not follow this client to its next transaction, and does follow the server
 * connection to the pooler's next client. The direct path's per-connection
 * defaults — `default_transaction_read_only` on every reader, a
 * `statement_timeout` everywhere — are made per transaction here, with
 * `SET LOCAL`, which dies with its transaction:
 *
 * - A transaction a caller begins gets the cap, and on a reader
 *   `SET TRANSACTION READ ONLY`, in the same round trip as its BEGIN.
 * - A statement sent outside a transaction is wrapped in one of its own:
 *   BEGIN with the settings, the statement, COMMIT. A bare statement is
 *   exactly what a pooler may run on any server connection.
 * - An untrusted lease — user-authored SQL — fences each statement with a
 *   savepoint, and before its transaction ends runs the part of DISCARD ALL
 *   a transaction block allows. An advisory lock or a prepared statement
 *   survives ROLLBACK and a setting survives COMMIT; none of them may reach
 *   the pooler's next client.
 *
 * Transaction edges are read off each statement's first keyword. That is
 * sound here: every BEGIN, COMMIT and ROLLBACK this codebase sends is a
 * literal of its own, and user-authored SQL is one statement at a time
 * (refuseStacked) on a lease that is discarded afterwards.
 */
import { trimStatement } from './adapter.js';
import type { PgQuery } from './postgresPool.js';

export interface TransactionScopedClient extends PgQuery {
  /** Invalidate future SQL without waiting for the current driver operation.
   * The lease owner destroys that operation's physical client separately. */
  close(reason: Error): void;
  /** Close a transaction the lease's work left open, rather than hand the
   * pooler a server connection mid-transaction. */
  settle(): Promise<void>;
}

/* The in-transaction half of DISCARD ALL, which itself refuses a transaction
   block. Every part of it also runs inside a read-only transaction. */
const RESET =
  'SET SESSION AUTHORIZATION DEFAULT; RESET ALL; DEALLOCATE ALL; CLOSE ALL; UNLISTEN *; ' +
  'SELECT pg_catalog.pg_advisory_unlock_all(); DISCARD PLANS; DISCARD SEQUENCES; DISCARD TEMP';
const MARK = 'mistri_statement';

const BEGINS = /^(?:BEGIN|START\s+TRANSACTION)\b/i;
/** COMMIT, END, ABORT or ROLLBACK: not ROLLBACK TO a savepoint, and not the PREPARED forms. */
const ENDS = /^(?:COMMIT|END|ABORT|ROLLBACK)\b(?!\s+(?:(?:WORK|TRANSACTION)\s+)?(?:TO|PREPARED)\b)/i;
/** Neither wrapped nor fenced: statements that only mean something at a transaction's edge. */
const EDGES =
  /^(?:SAVEPOINT|RELEASE|ROLLBACK\s+(?:(?:WORK|TRANSACTION)\s+)?TO|PREPARE\s+TRANSACTION|COMMIT\s+PREPARED|ROLLBACK\s+PREPARED)\b/i;

/**
 * The statement past its leading space and comments. PostgreSQL nests block
 * comments, so this does too: a misread edge here is a transaction left open
 * on a pooled server connection, not a cosmetic slip.
 */
function head(text: string): string {
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i += 1;
      continue;
    }
    if (text.startsWith('--', i)) {
      const end = text.indexOf('\n', i);
      if (end < 0) return '';
      i = end + 1;
      continue;
    }
    if (text.startsWith('/*', i)) {
      let depth = 0;
      do {
        if (text.startsWith('/*', i)) {
          depth += 1;
          i += 2;
        } else if (text.startsWith('*/', i)) {
          depth -= 1;
          i += 2;
        } else i += 1;
      } while (depth > 0 && i < text.length);
      continue;
    }
    break;
  }
  return text.slice(i);
}

export function transactionScoped(
  client: PgQuery,
  options: Readonly<{
    role: 'read' | 'write';
    capMs: number;
    untrusted: boolean;
    /** A writer's lock wait (writeLanes.ts). */
    lockTimeoutMs?: number;
    /** The path a store's unqualified names resolve on (the authentication
     * store's, for Better Auth), set per transaction for the same reason. */
    searchPath?: string;
  }>,
): TransactionScopedClient {
  let closed: Error | undefined;
  const raw = (request: unknown, params?: unknown): Promise<unknown> => {
    if (closed) return Promise.reject(closed);
    return (client.query as (request: unknown, params?: unknown) => Promise<unknown>)(request, params);
  };
  const reader = options.role === 'read';
  /* On a reader the transaction is read-only whatever its BEGIN said: the
     session default that promised it on a direct connection is not here. */
  const lockWait =
    !reader && options.lockTimeoutMs !== undefined ? `; SET LOCAL lock_timeout = ${Math.max(1, Math.floor(options.lockTimeoutMs))}` : '';
  const path = options.searchPath === undefined ? '' : `; SET LOCAL search_path TO ${options.searchPath}`;
  const settings = `${reader ? 'SET TRANSACTION READ ONLY; ' : ''}SET LOCAL statement_timeout = ${Math.max(1, Math.floor(options.capMs))}${lockWait}${path}`;
  const settingCount = 1 + (reader ? 1 : 0) + (lockWait ? 1 : 0) + (path ? 1 : 0);
  let open = false;
  // A simple-protocol string with several statements answers with one result each.
  const first = (result: unknown) => (Array.isArray(result) ? result[0] : result);
  const simple = (request: unknown, params: unknown) =>
    typeof request === 'string' && (params === undefined || (Array.isArray(params) && params.length === 0));

  const begin = async (text: string, request: unknown, params: unknown): Promise<unknown> => {
    /* Open from the moment the BEGIN is sent, not answered: a statement a
       pipelining caller sends right behind it (pipelined,
       postgresTransactionHandle.ts) belongs to this transaction, and must not
       be wrapped in one of its own. */
    open = true;
    try {
      let result: unknown;
      if (simple(request, params)) {
        /* A BEGIN may carry a prologue (a read snapshot's LOCK and first
           query, PostgresAdapter.readSnapshot). The settings go straight
           after the BEGIN, so the cap is in force before the prologue runs,
           and the settings' own results are taken out of the answer. The
           BEGIN is one of this codebase's literals, so its first `;` is
           where it ends. */
        const statement = trimStatement(text),
          cut = statement.indexOf(';');
        if (cut < 0) result = first(await raw(`${statement}; ${settings}`));
        else {
          const answers = (await raw(`${statement.slice(0, cut)}; ${settings}; ${statement.slice(cut + 1).trimStart()}`)) as unknown[];
          result = [answers[0], ...answers.slice(1 + settingCount)];
        }
      } else {
        /* Asked together, so the settings are in force before anything a
           pipelining caller sent behind the BEGIN. */
        const answer = raw(request, params),
          set = raw(settings);
        void set.catch(() => {});
        result = await answer;
        await set;
      }
      return result;
    } catch (error) {
      open = false;
      // BEGIN may have taken effect before a setting failed; if not, ROLLBACK costs a warning.
      await raw('ROLLBACK').catch(() => {});
      throw error;
    }
  };

  const end = async (request: unknown, params: unknown): Promise<unknown> => {
    open = false;
    if (options.untrusted) {
      try {
        await raw(RESET);
      } catch (error) {
        // A transaction that cannot shed what its statement left behind does not commit with it.
        await raw('ROLLBACK').catch(() => {});
        throw error;
      }
    }
    return raw(request, params);
  };

  const within = async (request: unknown, params: unknown): Promise<unknown> => {
    if (!options.untrusted) return raw(request, params);
    await raw(`SAVEPOINT ${MARK}`);
    try {
      return await raw(request, params);
    } catch (error) {
      /* Back to before the statement, so the transaction can still shed what
         the statement took before it failed: an advisory lock outlives both
         the failure and a rollback. */
      await raw(`ROLLBACK TO SAVEPOINT ${MARK}`).catch(() => {});
      throw error;
    }
  };

  const alone = async (request: unknown, params: unknown): Promise<unknown> => {
    try {
      await raw(`BEGIN${reader ? ' READ ONLY' : ''}; ${settings}${options.untrusted ? `; SAVEPOINT ${MARK}` : ''}`);
    } catch (error) {
      await raw('ROLLBACK').catch(() => {});
      throw error;
    }
    let result: unknown;
    try {
      result = await raw(request, params);
    } catch (error) {
      await raw(options.untrusted ? `ROLLBACK TO SAVEPOINT ${MARK}; ${RESET}; ROLLBACK` : 'ROLLBACK').catch(() =>
        raw('ROLLBACK').catch(() => {}),
      );
      throw error;
    }
    try {
      await raw(options.untrusted ? `${RESET}; COMMIT` : 'COMMIT');
    } catch (error) {
      await raw('ROLLBACK').catch(() => {});
      throw error;
    }
    return result;
  };

  const query = (request: unknown, params?: unknown): Promise<unknown> => {
    if (closed) return Promise.reject(closed);
    const text =
      typeof request === 'string'
        ? request
        : request && typeof request === 'object' && typeof (request as { text?: unknown }).text === 'string'
          ? (request as { text: string }).text
          : undefined;
    // Nothing to read an edge from: the driver says what is wrong with it.
    if (text === undefined) return raw(request, params);
    const statement = head(text);
    if (BEGINS.test(statement)) return open ? raw(request, params) : begin(text, request, params);
    if (ENDS.test(statement)) return open ? end(request, params) : raw(request, params);
    if (EDGES.test(statement)) return raw(request, params);
    return open ? within(request, params) : alone(request, params);
  };

  const settle = async (): Promise<void> => {
    if (!open) return;
    open = false;
    await raw(options.untrusted ? `${RESET}; ROLLBACK` : 'ROLLBACK').catch(() => raw('ROLLBACK'));
  };

  return {
    query: query as PgQuery['query'],
    settle,
    close: (reason) => {
      closed ??= reason;
    },
  };
}
