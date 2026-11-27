/**
 * Jepsen SQLite WAL Multi-Process `SIGKILL` Crash-Consistency & Undo Journal workload.
 *
 * Spawns real independent OS child worker processes writing concurrently to a
 * shared SQLite WAL database via Mistri's real `SqliteAdapter` + persistent
 * Undo journal (`provisionSqliteWriteJournal` + `keepWriteJournal` + `recordedUpdate`),
 * while the nemesis repeatedly hits workers with real OS `SIGKILL` mid-flight
 * and respawns replacements.
 *
 * Verifies after crash recovery:
 *  - `PRAGMA integrity_check === 'ok'` (zero B-tree / WAL corruption)
 *  - exact bank balance conservation (`SUM(balance) === initialTotal`) and `MIN(balance) >= 0`
 *  - Mistri's persistent Undo journal (`__mistri_undo_meta` / `__mistri_undo_entry`)
 *    remains structurally valid (`sqliteWriteJournalReady === true`) with valid JSON entries
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SqliteAdapter } from '../../../packages/engine/src/adapters/sqlite.js';
import { clearJournal } from '../../../packages/engine/src/server/journal.js';
import {
  keepWriteJournal,
  provisionSqliteWriteJournal,
  sqliteWriteJournalReady,
} from '../../../packages/engine/src/server/journalStore.js';
import { recordedUpdate } from '../../../packages/engine/src/server/recordWriteOperations.js';
import { checkSqliteCrash, type SqliteCrashCheckResult } from '../checkers.js';
import type { FaultProxyStats } from '../faultProxy.js';
import { HistoryRecorder } from '../history.js';
import { SeededRng, sleep } from '../pgHelper.js';

export interface SqliteCrashWorkloadOptions {
  readonly durationSec: number;
  readonly concurrency: number;
  readonly nemesis: boolean;
  readonly seed: number;
  readonly outDir?: string;
}

export interface SqliteCrashWorkloadReport {
  readonly workload: 'sqlite-crash';
  readonly valid: boolean;
  readonly durationMs: number;
  readonly nemesisEvents: number;
  readonly proxyStats: readonly { readonly node: string; readonly stats: FaultProxyStats }[];
  readonly check: SqliteCrashCheckResult;
  readonly historyFiles?: { readonly jsonl: string; readonly edn: string };
}

const THIS_FILE = fileURLToPath(import.meta.url);
const ACCOUNT_COUNT = 6;
const INITIAL_BALANCE = 1_000;

/**
 * Worker child-process entrypoint: continuously executes real Mistri SQLite
 * multi-row transactions (`adapter.transaction`) and persistent-journaled
 * `recordedUpdate` writes until terminated by `SIGKILL` or `SIGTERM`.
 */
async function runSqliteCrashWorker(dbPath: string, workerId: string, seed: number): Promise<void> {
  const rng = new SeededRng(seed);
  const adapter = new SqliteAdapter(dbPath, workerId);
  const connectionName = `jepsen-sqlite-${workerId}`;
  await keepWriteJournal(connectionName, adapter, () => {});

  let seq = 0;
  let stopping = false;
  process.on('SIGTERM', () => {
    stopping = true;
  });

  try {
    while (!stopping) {
      seq++;
      const fromId = rng.int(1, ACCOUNT_COUNT + 1);
      let toId = rng.int(1, ACCOUNT_COUNT + 1);
      while (toId === fromId) toId = rng.int(1, ACCOUNT_COUNT + 1);
      const amount = rng.int(1, 21);
      const txKey = `${workerId}-${seed}-${seq}`;

      // 1. Atomic multi-row balance transfer inside Mistri's SqliteAdapter transaction.
      try {
        await adapter.transaction(async (tx) => {
          const fromRes = await tx.query({
            table: 'account',
            filter: { groups: [[{ column: 'id', op: '=', value: fromId }]] },
            limit: 1,
            offset: 0,
          });
          const toRes = await tx.query({
            table: 'account',
            filter: { groups: [[{ column: 'id', op: '=', value: toId }]] },
            limit: 1,
            offset: 0,
          });
          const fromBal = Number(fromRes.rows[0]?.balance ?? 0);
          const toBal = Number(toRes.rows[0]?.balance ?? 0);
          if (fromBal < amount) return;
          await tx.update({ table: 'account', key: { id: fromId }, values: { balance: fromBal - amount } });
          await tx.update({ table: 'account', key: { id: toId }, values: { balance: toBal + amount } });
          await tx.insert({
            table: 'ledger',
            values: { tx_key: txKey, from_account: fromId, to_account: toId, amount },
          });
        });
      } catch {
        // SQLITE_BUSY under multi-process contention is expected; retry on next loop.
      }

      // 2. Periodically exercise Mistri's persistent Undo journal via `recordedUpdate`.
      if (seq % 3 === 0 && !stopping) {
        const noteId = rng.int(1, ACCOUNT_COUNT + 1);
        try {
          await recordedUpdate(
            { adapter, connection: connectionName, by: workerId },
            { table: 'note', key: { id: noteId }, values: { body: `w=${workerId} s=${seq}` } },
          );
        } catch {
          // Busy / conflict under concurrent SIGKILL contention; safe to continue.
        }
      }

      await sleep(rng.int(2, 12));
    }
  } finally {
    await adapter.close();
    clearJournal(connectionName);
  }
}

export async function runSqliteCrashWorkload(options: SqliteCrashWorkloadOptions): Promise<SqliteCrashWorkloadReport> {
  const startedAt = Date.now();
  const rng = new SeededRng(options.seed);
  const workDir = mkdtempSync(join(tmpdir(), 'mistri-jepsen-sqlite-'));
  const dbPath = join(workDir, 'bank.db');
  const initialTotal = ACCOUNT_COUNT * INITIAL_BALANCE;
  const history = new HistoryRecorder<unknown>();

  const children = new Set<ChildProcess>();
  let nemesisEvents = 0;
  let killsInjected = 0;
  let workerSeq = 0;

  try {
    // Initialize SQLite WAL schema + Mistri persistent Undo journal.
    const setupDb = new DatabaseSync(dbPath);
    try {
      setupDb.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE account (
          id INTEGER PRIMARY KEY,
          balance INTEGER NOT NULL CHECK (balance >= 0)
        );
        CREATE TABLE ledger (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tx_key TEXT NOT NULL UNIQUE,
          from_account INTEGER NOT NULL,
          to_account INTEGER NOT NULL,
          amount INTEGER NOT NULL CHECK (amount > 0)
        );
        CREATE TABLE note (
          id INTEGER PRIMARY KEY,
          body TEXT NOT NULL
        );
      `);
      const insertAcc = setupDb.prepare('INSERT INTO account (id, balance) VALUES (?, ?)');
      const insertNote = setupDb.prepare('INSERT INTO note (id, body) VALUES (?, ?)');
      for (let id = 1; id <= ACCOUNT_COUNT; id++) {
        insertAcc.run(id, INITIAL_BALANCE);
        insertNote.run(id, 'init');
      }
    } finally {
      setupDb.close();
    }
    provisionSqliteWriteJournal(dbPath);

    const spawnWorker = (): ChildProcess => {
      const id = `w${++workerSeq}`;
      const childSeed = options.seed + workerSeq * 97;
      const child = spawn(process.execPath, ['--import', 'tsx', THIS_FILE, '--jepsen-worker', dbPath, id, String(childSeed)], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      children.add(child);
      child.once('exit', () => {
        children.delete(child);
      });
      history.invoke(workerSeq, 'spawn-worker', { workerId: id, pid: child.pid });
      return child;
    };

    const targetWorkers = Math.max(2, Math.min(options.concurrency, 4));
    for (let i = 0; i < targetWorkers; i++) spawnWorker();

    const stopAt = Date.now() + Math.max(3_000, options.durationSec * 1_000);

    // Let workers warm up & start committing before the first SIGKILL.
    await sleep(600);

    while (Date.now() < stopAt) {
      await sleep(rng.int(300, 600));
      if (Date.now() >= stopAt) break;
      const alive = [...children].filter((c) => c.exitCode === null && c.pid !== undefined);
      if (options.nemesis && alive.length > 0) {
        const victim = rng.pick(alive);
        const pid = victim.pid;
        nemesisEvents++;
        killsInjected++;
        history.info('nemesis', 'sigkill-worker', { pid });
        const exited = once(victim, 'exit').catch(() => {});
        victim.kill('SIGKILL');
        await exited;
        // Respawn a replacement worker right away so crash recovery happens under live write contention.
        if (Date.now() + 300 < stopAt) spawnWorker();
      }
    }

    // Stop remaining workers cleanly and wait for exit.
    await Promise.all(
      [...children].map(async (child) => {
        if (child.exitCode === null) {
          const exited = once(child, 'exit').catch(() => {});
          child.kill('SIGTERM');
          const timer = setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
          }, 2_000);
          await exited;
          clearTimeout(timer);
        }
      }),
    );

    // Reopen fresh after all crashes to trigger SQLite WAL recovery and check every invariant.
    const verifyDb = new DatabaseSync(dbPath);
    let integrityCheck = 'unknown';
    let finalTotal = 0;
    let minBalance = 0;
    let appliedTransfers = 0;
    let undoEntriesPersisted = 0;
    let journalValid = false;
    try {
      verifyDb.exec('PRAGMA busy_timeout = 5000');
      const icRow = verifyDb.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
      integrityCheck = String(icRow?.integrity_check ?? 'missing');

      const agg = verifyDb
        .prepare('SELECT COALESCE(SUM(balance), 0) AS total, COALESCE(MIN(balance), 0) AS min_bal FROM account')
        .get() as {
        total: number;
        min_bal: number;
      };
      finalTotal = Number(agg.total);
      minBalance = Number(agg.min_bal);

      const ledgerRow = verifyDb.prepare('SELECT COUNT(*) AS c FROM ledger').get() as { c: number };
      appliedTransfers = Number(ledgerRow.c);

      journalValid = sqliteWriteJournalReady(verifyDb);
      const undoRows = verifyDb.prepare('SELECT entry_json FROM "__mistri_undo_entry"').all() as { entry_json: string }[];
      undoEntriesPersisted = undoRows.length;
      for (const row of undoRows) {
        JSON.parse(row.entry_json);
      }
    } finally {
      verifyDb.close();
    }

    if (!journalValid) {
      integrityCheck = 'undo_journal_schema_invalid';
    }

    const check = checkSqliteCrash({
      integrityCheck,
      initialTotal,
      finalTotal,
      minBalance,
      appliedTransfers,
      killsInjected,
      undoEntriesPersisted,
    });

    const historyFiles = options.outDir ? history.writeFiles(join(options.outDir, 'sqlite-crash-history')) : undefined;

    return {
      workload: 'sqlite-crash',
      valid: check.valid,
      durationMs: Date.now() - startedAt,
      nemesisEvents,
      proxyStats: [],
      check,
      ...(historyFiles ? { historyFiles } : {}),
    };
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href && process.argv[2] === '--jepsen-worker') {
  const [, , , dbPath, workerId, seedRaw] = process.argv;
  runSqliteCrashWorker(dbPath, workerId, Number(seedRaw || 1)).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
