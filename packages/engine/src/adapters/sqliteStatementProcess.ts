/**
 * A raw SQLite read, run in a process of its own so that it can be stopped.
 *
 * node:sqlite runs a statement synchronously on the thread that asked and
 * offers neither an interrupt nor a progress handler, so an aggregate over a
 * cross join holds the whole server until it finishes — its cancel included,
 * which cannot even be read while the thread is busy. A worker thread would
 * not help: terminating one waits for the native call to return. A process
 * can be killed. So a read whose caller may stop it is handed to a child
 * with its own read-only handle on the same file, and killed at its cap or
 * on cancel. The cost is a process start per statement, which a statement
 * someone typed can afford; the cap counts from when the child is ready.
 *
 * The child's program is plain JavaScript run with `node -e`, so it needs no
 * build step and no loader, under tsx or from dist alike. It answers raw rows
 * (BigInts, bytes) over an advanced-serialization channel, and the adapter
 * makes them JSON-safe the way it does its own.
 */
import { spawn } from 'node:child_process';
import { RUNTIME_TABLE_PREFIXES } from '../shared/runtimeTables.js';
import { onCancel, StatementStopped } from './statementControl.js';

interface ProcessStatement {
  file: string;
  /** The statement to prepare: the bounded wrap, when `bounded`. */
  text: string;
  /** What runs when the wrapped text does not prepare. */
  fallback: string;
  bounded: boolean;
  limit: number;
  /** Listen with SQLite's authorizer and answer `reserved` instead of rows. */
  refuseReserved: boolean;
  /** The statement's bound values, for one the adapter compiled (sqliteCostlyReads.ts). */
  params?: unknown[];
}

interface ProcessAnswer {
  columns: string[];
  /** Each column's declared type, null for an expression (see sqliteDecimals.ts). */
  types: Array<string | null>;
  rows: unknown[][];
  wrapped: boolean;
  /** Set instead of rows when the statement reads one of tablewalk's own tables. */
  reserved?: string;
}

/* How long the child may take to start before the statement's own cap. */
const STARTUP_MS = 10_000;

/* The child. SQLITE_OK and SQLITE_READ are the C API's authorizer codes. The
   rows stop one past the limit, so an unwrapped statement is not read whole
   to learn that there was more. */
const CHILD = `
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
const SQLITE_OK = 0, SQLITE_READ = 20;
process.once('message', (job) => {
  let answer;
  try {
    const db = new DatabaseSync(job.file, { readOnly: true });
    try { db.exec('PRAGMA busy_timeout = 5000'); } catch {}
    let reserved;
    const prepare = (text) => {
      if (!job.refuseReserved || typeof db.setAuthorizer !== 'function') return db.prepare(text);
      db.setAuthorizer((action, table) => {
        if (action === SQLITE_READ && typeof table === 'string' && job.prefixes.some((prefix) => table.toLowerCase().startsWith(prefix))) reserved ??= table;
        return SQLITE_OK;
      });
      try { return db.prepare(text); } finally { db.setAuthorizer(null); }
    };
    let wrapped = job.bounded;
    let statement;
    try { statement = prepare(job.text); }
    catch (error) {
      if (!job.bounded) throw error;
      wrapped = false;
      statement = prepare(job.fallback);
    }
    if (reserved !== undefined) answer = { reserved };
    else {
      statement.setReturnArrays(true);
      statement.setReadBigInts(true);
      const described = statement.columns();
      const columns = described.map((c) => c.name ?? c.column ?? '?');
      const types = described.map((c) => c.type ?? null);
      const rows = [];
      for (const row of statement.iterate(...(job.params || []))) {
        rows.push(row);
        if (rows.length > job.limit) break;
      }
      answer = { columns, types, rows, wrapped };
    }
  } catch (error) {
    answer = { error: String((error && error.message) || error) };
  }
  process.send(answer, () => process.exit(0));
});
process.send({ ready: true });
`;

/**
 * Run one read in a child process, stopped when `capMs` runs out or when
 * `signal` aborts. The engine's own errors come back as errors with the
 * engine's words, as they would in-process.
 */
export function runInStatementProcess(job: ProcessStatement, capMs: number, signal: AbortSignal): Promise<ProcessAnswer> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new StatementStopped('cancelled'));
      return;
    }
    const child = spawn(process.execPath, ['-e', CHILD], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'advanced',
      /* Electron's binary is Node only when told so; plain Node ignores it. */
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2_000);
    });
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let disarm = () => {};
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      disarm();
      outcome();
    };
    const stop = (reason: 'cancelled' | 'timeout') =>
      settle(() => {
        child.kill('SIGKILL');
        reject(new StatementStopped(reason, capMs));
      });
    timer = setTimeout(() => stop('timeout'), STARTUP_MS + capMs);
    disarm = onCancel(signal, () => stop('cancelled'));
    child.on('message', (message: Partial<ProcessAnswer> & { ready?: true; error?: string }) => {
      if (message.ready) {
        /* The cap is the statement's, not the process start's. */
        clearTimeout(timer);
        timer = setTimeout(() => stop('timeout'), capMs);
        child.send({ ...job, prefixes: RUNTIME_TABLE_PREFIXES });
        return;
      }
      settle(() => {
        if (message.error !== undefined) reject(new Error(message.error));
        else resolve(message as ProcessAnswer);
      });
    });
    child.once('error', (error) => settle(() => reject(error)));
    child.once('exit', (code, killedBy) =>
      settle(() =>
        reject(
          new Error(
            `The SQLite statement process ended without an answer (${killedBy ?? `exit ${code}`}).` +
              (stderr.trim() ? ` ${stderr.trim()}` : ''),
          ),
        ),
      ),
    );
  });
}
