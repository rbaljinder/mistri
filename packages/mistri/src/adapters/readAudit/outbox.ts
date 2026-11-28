/**
 * Crash-safe local SQLite WAL outbox for opt-in asynchronous read-audit delivery
 * (`audit: { reads: { delivery: 'outbox' } }`).
 *
 * Instead of making every audited read wait on a remote database write round
 * trip, each read commits its audit row durably to a local SQLite WAL file
 * (group-committed across concurrent reads) and returns as soon as the local
 * commit lands. A background drainer batches queued rows (up to 256 at a time)
 * to the audited database with exponential backoff, deleting local rows only
 * after the remote commit succeeds.
 *
 * It remains fail-closed: malformed rows, an unwritable local disk, or a full
 * backlog cap reject with ReadAuditUnavailable (answered 503 read_not_recorded)
 * so rows never leave without a durable local record. On startup, any rows left
 * from a prior process crash are drained automatically.
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { withoutAdmission } from '@mistriwork/engine/adapters/poolAdmission.js';
import { withoutCancellation } from '@mistriwork/engine/adapters/statementControl.js';
import { untimed } from '@mistriwork/engine/adapters/telemetry/serverTiming.js';
import { groupCommit } from './groupCommit.js';
import { assertReadAuditRow, ReadAuditUnavailable, type ReadAuditRow } from './readAudit.js';

const OUTBOX_BATCH_SIZE = 256;
const DEFAULT_MAX_ROWS = 50_000;
const BASE_RETRY_MS = 500;
const MAX_RETRY_MS = 60_000;
const FAULT_LOG_MS = 60_000;

interface ReadAuditOutboxOptions {
  /** Override the SQLite file path (used in tests or custom operators). */
  readonly filePath?: string;
  /** Maximum queued rows before backpressure rejects new audited reads fail-closed. */
  readonly maxRows?: number;
  /** Clock seam for tests. */
  readonly now?: () => number;
}

interface QueuedRow {
  readonly seq: number;
  readonly row_json: string;
  readonly attempts: number;
}

function defaultOutboxPath(key: string): string {
  const base =
    process.env.MISTRI_READ_AUDIT_OUTBOX_DIR?.trim() ||
    join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'), 'mistri', 'read-audit-outbox');
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 20);
  return join(base, `outbox-${digest}.db`);
}

export class ReadAuditOutbox {
  private readonly db: DatabaseSync;
  private readonly maxRows: number;
  private readonly now: () => number;
  private readonly commitLocal: (row: ReadAuditRow) => Promise<void>;
  private pendingCount: number;
  private closed = false;
  private draining?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private lastFaultAt = -Infinity;

  constructor(
    private readonly key: string,
    private readonly flushBatch: (rows: readonly ReadAuditRow[]) => Promise<void>,
    options: ReadAuditOutboxOptions = {},
  ) {
    this.maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
    this.now = options.now ?? Date.now;
    const filePath = options.filePath ?? defaultOutboxPath(key);
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS read_audit_outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        row_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS read_audit_outbox_due ON read_audit_outbox (next_attempt_at, seq);
    `);
    const row = this.db.prepare('SELECT count(*) AS n FROM read_audit_outbox').get() as { n: number | bigint } | undefined;
    this.pendingCount = Number(row?.n ?? 0);
    this.commitLocal = groupCommit<ReadAuditRow>(
      async (rows) => {
        if (this.closed) throw new ReadAuditUnavailable('The read audit outbox is closed.');
        if (this.pendingCount + rows.length > this.maxRows)
          throw new ReadAuditUnavailable('The read audit outbox is full; the database could not keep up.');
        const at = this.now();
        this.db.exec('BEGIN IMMEDIATE');
        try {
          const insert = this.db.prepare(
            'INSERT INTO read_audit_outbox (row_json, created_at, attempts, next_attempt_at) VALUES (?, ?, 0, 0)',
          );
          for (const item of rows) insert.run(JSON.stringify(item), at);
          this.db.exec('COMMIT');
        } catch (error) {
          try {
            if (this.db.isTransaction) this.db.exec('ROLLBACK');
          } catch {
            /* Preserve the local commit failure. */
          }
          throw error;
        }
        this.pendingCount += rows.length;
        this.scheduleDrain(0);
      },
      (row) => {
        if (this.closed) throw new ReadAuditUnavailable('The read audit outbox is closed.');
        assertReadAuditRow(row);
        if (this.pendingCount >= this.maxRows)
          throw new ReadAuditUnavailable('The read audit outbox is full; the database could not keep up.');
      },
    );
    if (this.pendingCount > 0) this.scheduleDrain(0);
  }

  /** Number of audit rows currently queued locally waiting to be delivered. */
  get pending(): number {
    return this.pendingCount;
  }

  /** Durably persist one row into the local WAL outbox before returning, then drain asynchronously. */
  enqueue(row: ReadAuditRow): Promise<void> {
    if (this.closed) return Promise.reject(new ReadAuditUnavailable('The read audit outbox is closed.'));
    return this.commitLocal(row);
  }

  private scheduleDrain(delayMs: number): void {
    if (this.closed || this.timer) return;
    /* Run outside any active HTTP request's Server-Timing or cancellation context. */
    this.timer = untimed(() =>
      setTimeout(() => {
        this.timer = undefined;
        void this.drain().catch(() => {});
      }, delayMs),
    );
    this.timer.unref?.();
  }

  private logFault(error: unknown): void {
    const at = this.now();
    if (at - this.lastFaultAt < FAULT_LOG_MS) return;
    this.lastFaultAt = at;
    console.error(`mistri: read audit outbox (${this.key}): ${error instanceof Error ? error.message : String(error)}`);
  }

  /** Drain all currently due batches to the audited database. */
  drain(forceDue = false): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.draining) return this.draining;
    const run = untimed(() =>
      withoutCancellation(() =>
        withoutAdmission(async () => {
          for (;;) {
            if (this.closed) return;
            const at = this.now();
            const queued = (forceDue
              ? this.db.prepare('SELECT seq, row_json, attempts FROM read_audit_outbox ORDER BY seq ASC LIMIT ?').all(OUTBOX_BATCH_SIZE)
              : this.db
                  .prepare('SELECT seq, row_json, attempts FROM read_audit_outbox WHERE next_attempt_at <= ? ORDER BY seq ASC LIMIT ?')
                  .all(at, OUTBOX_BATCH_SIZE)) as unknown as QueuedRow[];
            if (!queued.length) {
              if (!forceDue) {
                const next = this.db.prepare('SELECT min(next_attempt_at) AS next_at FROM read_audit_outbox').get() as
                  | { next_at: number | null }
                  | undefined;
                if (next && typeof next.next_at === 'number') this.scheduleDrain(Math.max(50, next.next_at - this.now()));
              }
              return;
            }
            const parsed = queued.map((entry) => JSON.parse(entry.row_json) as ReadAuditRow);
            try {
              await this.flushBatch(parsed);
            } catch (error) {
              this.logFault(error);
              if (this.closed) return;
              const failedAt = this.now();
              const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
              let soonest = Infinity;
              this.db.exec('BEGIN IMMEDIATE');
              try {
                const bump = this.db.prepare(
                  'UPDATE read_audit_outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE seq = ?',
                );
                for (const entry of queued) {
                  const attempts = Number(entry.attempts) + 1;
                  const delay = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.min(attempts - 1, 7));
                  const nextAt = failedAt + delay;
                  if (nextAt < soonest) soonest = nextAt;
                  bump.run(attempts, nextAt, message, entry.seq);
                }
                this.db.exec('COMMIT');
              } catch {
                try {
                  if (this.db.isTransaction) this.db.exec('ROLLBACK');
                } catch {
                  /* Best effort retry bookkeeping. */
                }
              }
              if (!forceDue && Number.isFinite(soonest)) this.scheduleDrain(Math.max(50, soonest - this.now()));
              return;
            }
            if (this.closed) return;
            const placeholders = queued.map(() => '?').join(', ');
            this.db.prepare(`DELETE FROM read_audit_outbox WHERE seq IN (${placeholders})`).run(...queued.map((entry) => entry.seq));
            this.pendingCount = Math.max(0, this.pendingCount - queued.length);
          }
        }),
      ),
    ).finally(() => {
      if (this.draining === run) this.draining = undefined;
    });
    this.draining = run;
    return run;
  }

  /** Wait for any in-flight drain and push all queued rows now (used before reading the audit store and on shutdown). */
  async flush(): Promise<void> {
    if (this.closed) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.draining) await this.draining;
    if (!this.closed && this.pendingCount > 0) await this.drain(true);
  }

  /** Attempt a bounded final flush, then close the local SQLite file (any undelivered rows remain on disk for next startup). */
  async close(timeoutMs = 5_000): Promise<void> {
    if (this.closed) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    try {
      let cut: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.flush(),
        new Promise<void>((resolve) => {
          cut = setTimeout(resolve, timeoutMs);
          cut.unref?.();
        }),
      ]).finally(() => {
        if (cut) clearTimeout(cut);
      });
    } catch {
      /* Undelivered rows stay durable in the WAL file for the next process start. */
    }
    this.closed = true;
    try {
      this.db.close();
    } catch {
      /* Already closed. */
    }
  }
}

const outboxes = new Map<string, ReadAuditOutbox>();

/** Shared process-local outbox for `key`, created lazily on first outbox-delivered read. */
export function readAuditOutboxFor(
  key: string,
  flushBatch: (rows: readonly ReadAuditRow[]) => Promise<void>,
  options?: ReadAuditOutboxOptions,
): ReadAuditOutbox {
  let held = outboxes.get(key);
  if (!held) {
    held = new ReadAuditOutbox(key, flushBatch, options);
    outboxes.set(key, held);
  }
  return held;
}

/** Existing outbox for `key` if one has been opened, without creating a file. */
export const existingReadAuditOutbox = (key: string): ReadAuditOutbox | undefined => outboxes.get(key);

/** Drain and close one outbox (e.g., when a tenant writer closes). */
export async function closeReadAuditOutbox(key: string, timeoutMs = 5_000): Promise<void> {
  const held = outboxes.get(key);
  if (!held) return;
  outboxes.delete(key);
  await held.close(timeoutMs);
}

/** Drain and close every open read-audit outbox during graceful server shutdown. */
export async function closeAllReadAuditOutboxes(timeoutMs = 5_000): Promise<void> {
  const entries = [...outboxes.entries()];
  outboxes.clear();
  await Promise.allSettled(entries.map(([, box]) => box.close(timeoutMs)));
}
