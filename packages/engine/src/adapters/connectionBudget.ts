/**
 * How many connections this process can hold against each PostgreSQL
 * database, and whether the server would let it.
 *
 * Every pool is sized for the process it lives in and knows nothing of the
 * others: the read and write pools (`--read-pool`, `--write-pool`), the
 * background writer, a LISTEN connection, the auth store's pool. A second
 * replica multiplies all of them, and the server's limit (the role's, or
 * `max_connections`) is the first anyone hears of the product — as a 53300
 * under load. So each holder says what it may open when it is made
 * (`holdConnections`), the totals are read by database, and a start compares
 * them with what the server says it allows (`adviseConnectionLimits`).
 * `mistri check --deploy` does the same sum before anything runs
 * (`processConnections`), for as many replicas as the operator names.
 *
 * Counted: pools at their `max`, whether or not they have opened yet — a
 * ceiling, not a reading. Not counted: the short-lived client that cancels a
 * statement (pg_cancel_backend) and the one-shot clients of migrations and
 * maintenance, which run beside a stopped or starting server.
 */

/** The one thing the advice needs of a connection: a query. */
interface Asks {
  query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>;
}

interface Hold {
  readonly database: string;
  readonly count: number;
  /** A way to ask that database a question, when its holder has one; the first of a database's holders that does is used. */
  readonly ask?: () => Promise<Asks>;
}

/** The connections a manager of PostgreSQL pools may hold: its readers, its writers and the one background writer. */
export const managerConnections = (readers: number, writers: number): number => readers + writers + 1;

/**
 * What a small runtime store (the assistant's, the decisions', the API event feed's) asks of its own manager: one
 * reader and one writer. `mistri check --deploy` counts the same size (servedHosts.ts), so they cannot drift.
 */
export const SMALL_STORE_POOL = Object.freeze({ readers: 1, writers: 1 });

/** `host:port/database` of a connection string, without its credentials: what two URLs share when they name one database. */
export function databaseOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname.replace(/\/+$/, '') || '/'}`;
  } catch {
    return url;
  }
}

const holds = new Set<Hold>();

/**
 * Record that this process may now hold up to `count` connections to `url`'s database. Returns the release, called
 * when the holder closes; calling it twice is harmless.
 */
export function holdConnections(url: string, count: number, ask?: () => Promise<Asks>): () => void {
  const hold: Hold = { database: databaseOf(url), count, ...(ask ? { ask } : {}) };
  holds.add(hold);
  return () => void holds.delete(hold);
}

/** Up to how many connections this process holds now, by database. */
export function heldConnections(): ReadonlyMap<string, number> {
  const totals = new Map<string, number>();
  for (const hold of holds) totals.set(hold.database, (totals.get(hold.database) ?? 0) + hold.count);
  return totals;
}

/** What one App's serving holds against its database, per process. */
interface ProcessShape {
  readers: number;
  writers: number;
  /** Read replicas of the database, each a reader pool of the same size on another server. */
  replicas?: number;
  /** Whether the live-sync LISTEN connection is held (not behind a transaction-mode pooler). */
  listen?: boolean;
}

/** The connections one process may hold on the primary: its manager, plus the LISTEN connection. */
export const primaryConnections = (shape: ProcessShape): number =>
  managerConnections(shape.readers, shape.writers) + (shape.listen === false ? 0 : 1);

export interface DatabaseBudget {
  database: string;
  /** What one process may hold against it. */
  perProcess: number;
  processes: number;
  total: number;
  /** The most the server was told to allow, when the operator said (`--connection-limit`). */
  limit?: number;
  /** The cores the pool defaults were sized for, when they decided any size (`--cpus`). */
  cpus?: number;
  /** What one process's total is made of, term by term. */
  parts?: ReadonlyArray<{ host: string; connections: number }>;
}

/** One database's line for `mistri check --deploy`: "3 processes × 41 connections = 123". */
export function sayBudget(budget: DatabaseBudget): string {
  const times = `${budget.processes} process${budget.processes === 1 ? '' : 'es'} × ${budget.perProcess} connections = ${budget.total}`;
  const limit = budget.limit === undefined ? '' : ` (limit ${budget.limit})`;
  const cpus = budget.cpus === undefined ? '' : ` (at ${budget.cpus} cpus; pass --cpus for the deployment's)`;
  const parts = budget.parts?.length ? `; a process: ${budget.parts.map((part) => `${part.host} ${part.connections}`).join(' + ')}` : '';
  return `${budget.database}: ${times}${limit}${cpus}${parts}`;
}

/** The smaller of the limits that apply to this role, or undefined when neither is set. */
export function effectiveLimit(roleLimit: number | undefined, usable: number | undefined): number | undefined {
  const limits = [roleLimit, usable].filter((limit): limit is number => limit !== undefined && limit >= 0);
  return limits.length ? Math.min(...limits) : undefined;
}

const LIMITS = `SELECT r.rolconnlimit AS role_limit,
  current_setting('max_connections')::int - current_setting('superuser_reserved_connections')::int AS usable
  FROM pg_roles r WHERE r.rolname = current_user`;

/**
 * One line a database whose holders may open more connections than its server allows this role, naming both
 * numbers and the flags that lower them. Never refuses and never throws: one round trip per database, started
 * after the first connection is open, whose failure (a pooler that answers no catalog, a role that may not read
 * it) is silent.
 */
export async function adviseConnectionLimits(say: (line: string) => void): Promise<void> {
  const totals = heldConnections();
  const asked = new Set<string>();
  for (const hold of [...holds]) {
    if (!hold.ask || asked.has(hold.database) || !totals.has(hold.database)) continue;
    asked.add(hold.database);
    try {
      const line = await limitAdvice(hold.database, totals.get(hold.database)!, await hold.ask());
      if (line) say(line);
    } catch {
      /* The advice is a courtesy: a start never depends on it. */
    }
  }
}

/** The warning for one database given a connection to ask, or undefined when it fits. Exported for tests. */
export async function limitAdvice(database: string, held: number, connection: Asks): Promise<string | undefined> {
  const row = (await connection.query(LIMITS)).rows[0];
  if (!row) return undefined;
  const whole = (value: unknown): number | undefined => {
    const number = Number(value);
    return value === null || value === undefined || !Number.isInteger(number) ? undefined : number;
  };
  const roleLimit = whole(row.role_limit);
  const usable = whole(row.usable);
  const limit = effectiveLimit(roleLimit, usable);
  if (limit === undefined || held <= limit) return undefined;
  const source =
    roleLimit !== undefined && roleLimit >= 0 && roleLimit <= (usable ?? Infinity)
      ? `the role's limit`
      : `the server's max_connections less its reserved ones`;
  return (
    `this process may open ${held} connections to ${database}, and ${source} allows ${limit}. ` +
    `Lower --read-pool and --write-pool (or a connection's "pool"), and MISTRI_AUTH_POOL for the sign-in store, or raise the limit; ` +
    `with several replicas the sum of all of them counts.`
  );
}
