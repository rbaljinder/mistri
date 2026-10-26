import { randomUUID } from 'node:crypto';
import type { SQLOutputValue } from 'node:sqlite';
import type { JobStore } from './jobStoreContract.js';
import { assertSqliteJobStore, JOB_TABLES as t, openJobStoreFile } from './jobStoreSchema.js';
import {
  assertJobRedrivable,
  captureJobEnqueue,
  captureJobId,
  captureJobInspectFilter,
  captureJobOperator,
  captureJobOutcome,
  captureJobPrune,
  captureJobResult,
  inspectJobRow,
  jobAttemptInspection,
  jobClaimOf,
  JOB_HELD as held,
  JOB_MAX_CLOCK,
  jobRelease,
  oneAtATimeSql,
  verifyJobRow,
  withoutOverlap,
} from './jobStoreRules.js';
import {
  JobStoreUnavailable,
  captureJobPolicy,
  jobFail,
  jobInteger,
  JobRefusal,
  jobRefuse,
  JOB_HISTORY_LIMIT,
  type JobAttemptOutcome,
  type JobInspection,
  type JobOutcomeCode,
  type JobPolicyInput,
  type JobState,
} from './jobStoreTypes.js';

type Row = Record<string, SQLOutputValue>;

/** One private connection over one namespace. Each method is one synchronous,
 * bounded transaction behind the contract's promise; no caller callback,
 * Promise or network operation ever runs inside it. Handlers run between a
 * claim and its settlement, outside. SQLite has one writer, so the caller's
 * clock is the store's clock. */
export function openSqliteJobStore(existingPath: string, input: JobPolicyInput): JobStore {
  const policy = captureJobPolicy(input),
    file = openJobStoreFile(existingPath),
    db = file.db;
  let closed = false;
  const check = () => {
    if (closed) return jobFail();
    file.verifyFile();
    assertSqliteJobStore(db, policy);
  };
  const transaction = <T>(write: boolean, work: () => T, now?: number): T => {
    try {
      if (closed || db.isTransaction) return jobFail();
      file.verifyFile();
      db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
      check();
      if (now !== undefined) {
        jobInteger(now, 0, JOB_MAX_CLOCK);
        const clock = db.prepare(`SELECT last_clock FROM main."${t.policy}"`).get()!.last_clock as number;
        // A backward clock stops the store rather than shortening a lease or
        // reordering timers; the operator fixes the clock, not the data.
        if (now < clock) return jobFail();
        db.prepare(`UPDATE main."${t.policy}" SET last_clock=?`).run(now);
      }
      const result = work();
      file.verifyFile();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        if (db.isTransaction) db.exec('ROLLBACK');
      } catch {
        closed = true;
        try {
          db.close();
        } catch {
          /* Discard an uncertain connection. */
        }
        return jobFail();
      }
      // A coded refusal changed nothing and is the caller's answer; anything
      // else is an unverifiable store.
      if (error instanceof JobRefusal || error instanceof JobStoreUnavailable) throw error;
      return jobFail();
    }
  };
  try {
    transaction(false, () => {});
  } catch (error) {
    db.close();
    throw error;
  }
  const history = (id: string) =>
    db.prepare(`SELECT * FROM main."${t.attempt}" WHERE job_id=? ORDER BY attempt LIMIT ${JOB_HISTORY_LIMIT + 1}`).all(id);
  const verifyRow = (row: Row): JobInspection => verifyJobRow(policy, row, history(row.id as string));
  const rowById = (id: string): Row | undefined => db.prepare(`SELECT * FROM main."${t.job}" WHERE id=?`).get(captureJobId(id));
  /** The row this fence still owns. A settled, expired or re-leased attempt
   * is stale: the caller's work may have happened, but it cannot record it. */
  const live = (id: string, fence: string, now: number): Row => {
    const row = rowById(id);
    if (!row) return jobRefuse('job_not_found');
    if (typeof fence !== 'string' || row.state !== 'leased' || row.fence !== fence || now >= (row.lease_until as number))
      return jobRefuse('fence_stale');
    verifyRow(row);
    return row;
  };
  const settleAttempt = (row: Row, outcome: JobAttemptOutcome, code: JobOutcomeCode, now: number) => {
    const changed = db
      .prepare(`UPDATE main."${t.attempt}" SET outcome=?,code=?,finished_at=?
      WHERE job_id=? AND attempt=? AND fence=? AND outcome='leased'`)
      .run(outcome, code, now, row.id, row.attempts, row.fence);
    if (changed.changes !== 1) return jobFail();
  };
  const settleJob = (
    row: Row,
    state: JobState,
    code: JobOutcomeCode,
    now: number,
    runAt: number,
    resultJson: string | null = null,
  ): JobInspection => {
    const keep = held.includes(state);
    const changed = db
      .prepare(`UPDATE main."${t.job}" SET state=?,run_at=?,updated_at=?,last_code=?,result_json=?,
      fence=${keep ? 'fence' : 'NULL'},lease_until=${keep ? 'lease_until' : 'NULL'}
      WHERE id=? AND fence=? AND state IN ('leased','unknown')`)
      .run(state, runAt, now, code, resultJson, row.id, row.fence);
    if (changed.changes !== 1) return jobFail();
    return inspectJobRow(policy, rowById(row.id as string)!);
  };
  /** After the lease: the attempt is unknown, the job goes on unless it has
   * reached its budget or someone asked for it to stop. */
  const release = (row: Row, code: JobOutcomeCode, now: number): JobInspection => {
    const next = jobRelease(policy, row, now);
    return settleJob(row, next.state, next.cancelled ? 'cancelled' : code, now, next.runAt);
  };
  const expire = (now: number): number => {
    const rows = db
      .prepare(`SELECT * FROM main."${t.job}" WHERE state IN ('leased','unknown') AND lease_until<=?
      ORDER BY lease_until,seq LIMIT 64`)
      .all(now);
    for (const row of rows) {
      verifyRow(row);
      if (row.state === 'leased') settleAttempt(row, 'unknown', 'lease_expired', now);
      // A recorded unknown keeps its own code; only a silent crash is 'lease_expired'.
      release(row, row.state === 'leased' ? 'lease_expired' : (row.last_code as JobOutcomeCode), now);
    }
    return rows.length;
  };
  // A synchronous throw becomes the contract's rejected promise.
  const later = <T>(work: () => T): Promise<T> => {
    try {
      return Promise.resolve(work());
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const store: JobStore = {
    policy,
    enqueue: (request, now) =>
      later(() => {
        const value = captureJobEnqueue(policy, request);
        return transaction(
          true,
          () => {
            const existing = db
              .prepare(`SELECT id,fingerprint,run_at FROM main."${t.job}" WHERE job=? AND idempotency_key=?`)
              .get(value.job, value.key);
            if (existing) {
              if (existing.fingerprint !== value.fingerprint) return jobRefuse('idempotency_conflict');
              return Object.freeze({ id: existing.id as string, runAt: existing.run_at as number, replayed: true });
            }
            // Insertion order is an explicit sequence: SQLite's rowid is not durable
            // across VACUUM, and equal timers must still run first-come.
            const seq = db.prepare(`SELECT next_seq FROM main."${t.policy}"`).get()!.next_seq as number;
            db.prepare(`UPDATE main."${t.policy}" SET next_seq=?`).run(seq + 1);
            const id = randomUUID(),
              runAt = value.runAt ?? now;
            db.prepare(`INSERT INTO main."${t.job}"
          (id,seq,job,version,idempotency_key,fingerprint,input_json,provenance_json,state,attempts,max_attempts,redrives,attempt_limit,
           run_at,created_at,updated_at,fence,lease_until,cancel_requested,last_code,result_json)
          VALUES (?,?,?,?,?,?,?,?,'scheduled',0,?,0,?,?,?,?,NULL,NULL,0,NULL,NULL)`).run(
              id,
              seq,
              value.job,
              value.version,
              value.key,
              value.fingerprint,
              value.inputJson,
              value.provenanceJson,
              value.maxAttempts,
              value.maxAttempts,
              runAt,
              now,
              now,
            );
            return Object.freeze({ id, runAt, replayed: false });
          },
          now,
        );
      }),
    claim: (now, limit = policy.maxInFlight) =>
      later(() => {
        jobInteger(limit, 1, 64);
        return transaction(
          true,
          () => {
            expire(now);
            const inFlight = db.prepare(`SELECT count(*) AS n FROM main."${t.job}" WHERE state IN ('leased','unknown')`).get()!.n as number;
            const room = Math.min(limit, policy.maxInFlight - inFlight);
            if (room <= 0) return Object.freeze([]);
            const rows = withoutOverlap(
              db
                .prepare(
                  `SELECT * FROM main."${t.job}" AS j WHERE state IN ('scheduled','retry') AND run_at<=?
          AND NOT (${oneAtATimeSql('j')} AND EXISTS (SELECT 1 FROM main."${t.job}" AS o
            WHERE o.job=j.job AND o.state IN ('leased','unknown') AND ${oneAtATimeSql('o')}))
          ORDER BY run_at,seq LIMIT ?`,
                )
                .all(now, room),
            );
            return Object.freeze(
              rows.map((row) => {
                verifyRow(row);
                const attempt = (row.attempts as number) + 1,
                  fence = randomUUID(),
                  deadline = now + policy.leaseMs;
                db.prepare(`UPDATE main."${t.job}" SET state='leased',attempts=?,fence=?,lease_until=?,updated_at=? WHERE id=?`).run(
                  attempt,
                  fence,
                  deadline,
                  now,
                  row.id,
                );
                db.prepare(`INSERT INTO main."${t.attempt}" (job_id,attempt,fence,started_at,deadline,outcome,code,finished_at,operator)
            VALUES (?,?,?,?,?,'leased',NULL,NULL,NULL)`).run(row.id, attempt, fence, now, deadline);
                return jobClaimOf(row, attempt, fence, deadline);
              }),
            );
          },
          now,
        );
      }),
    /** A cancel requested meanwhile is retained as a fact about the job, not
     * a rewrite of the outcome. */
    succeed: (id, fence, now, result) =>
      later(() => {
        const resultJson = captureJobResult(policy, result);
        return transaction(
          true,
          () => {
            const row = live(id, fence, now);
            settleAttempt(row, 'succeeded', 'succeeded', now);
            return settleJob(row, 'succeeded', 'succeeded', now, row.run_at as number, resultJson);
          },
          now,
        );
      }),
    fail: (id, fence, now, outcome) =>
      later(() => {
        const value = captureJobOutcome(outcome),
          state = value === 'cancelled' ? 'cancelled' : 'failed';
        return transaction(
          true,
          () => {
            const row = live(id, fence, now);
            settleAttempt(row, state, value, now);
            return settleJob(row, state, value, now, row.run_at as number);
          },
          now,
        );
      }),
    retry: (id, fence, now, outcome) =>
      later(() => {
        const value = captureJobOutcome(outcome);
        return transaction(
          true,
          () => {
            const row = live(id, fence, now);
            const again = row.cancel_requested !== 1 && (row.attempts as number) < (row.attempt_limit as number);
            settleAttempt(row, again ? 'retry' : 'failed', value, now);
            return release(row, value, now);
          },
          now,
        );
      }),
    unknown: (id, fence, now, outcome) =>
      later(() => {
        const value = captureJobOutcome(outcome);
        return transaction(
          true,
          () => {
            const row = live(id, fence, now);
            settleAttempt(row, 'unknown', value, now);
            return settleJob(row, 'unknown', value, now, row.run_at as number);
          },
          now,
        );
      }),
    cancel: (id, now) =>
      later(() =>
        transaction(
          true,
          () => {
            const row = rowById(id);
            if (!row) return jobRefuse('job_not_found');
            verifyRow(row);
            if (row.state === 'scheduled' || row.state === 'retry') {
              db.prepare(`UPDATE main."${t.job}" SET state='cancelled',last_code='cancelled',updated_at=? WHERE id=?`).run(now, id);
              return Object.freeze({ outcome: 'cancelled' as const, state: 'cancelled' as const });
            }
            if (held.includes(row.state as string)) {
              db.prepare(`UPDATE main."${t.job}" SET cancel_requested=1,updated_at=? WHERE id=?`).run(now, id);
              return Object.freeze({ outcome: 'requested' as const, state: row.state as JobState });
            }
            return Object.freeze({ outcome: 'unchanged' as const, state: row.state as JobState });
          },
          now,
        ),
      ),
    expireLeases: (now) => later(() => transaction(true, () => expire(now), now)),
    cancelRequested: (id, fence) =>
      later(() =>
        transaction(false, () => {
          const row = rowById(id);
          if (!row || row.fence !== fence || !held.includes(row.state as string)) return jobRefuse('fence_stale');
          return row.cancel_requested === 1;
        }),
      ),
    inspect: (filter = {}, limit = 32) =>
      later(() => {
        const captured = captureJobInspectFilter(filter, limit);
        const clauses = ['1=1'],
          values: (string | number)[] = [];
        if (captured.state !== undefined) {
          clauses.push('state=?');
          values.push(captured.state);
        }
        if (captured.job !== undefined) {
          clauses.push('job=?');
          values.push(captured.job);
        }
        if (captured.afterId !== undefined) {
          clauses.push(`seq>(SELECT seq FROM main."${t.job}" WHERE id=?)`);
          values.push(captured.afterId);
        }
        return transaction(false, () =>
          Object.freeze(
            db
              .prepare(`SELECT * FROM main."${t.job}" WHERE ${clauses.join(' AND ')} ORDER BY seq LIMIT ?`)
              .all(...values, captured.limit)
              .map((row) => verifyRow(row)),
          ),
        );
      }),
    attempts: (id) =>
      later(() => {
        if (typeof id !== 'string' || id.length !== 36) return jobFail();
        return transaction(false, () => Object.freeze(history(id).map(jobAttemptInspection)));
      }),
    redrive: (id, operator, now) =>
      later(() => {
        const who = captureJobOperator(operator);
        return transaction(
          true,
          () => {
            const row = rowById(id);
            if (!row) return jobRefuse('job_not_found');
            verifyRow(row);
            assertJobRedrivable(row, now);
            const attempt = (row.attempts as number) + 1;
            db.prepare(`INSERT INTO main."${t.attempt}" (job_id,attempt,fence,started_at,deadline,outcome,code,finished_at,operator)
          VALUES (?,?,NULL,?,NULL,'redriven','redriven',?,?)`).run(row.id, attempt, now, now, who);
            const changed = db
              .prepare(`UPDATE main."${t.job}" SET state='retry',attempts=?,redrives=redrives+1,attempt_limit=?,run_at=?,
          updated_at=?,fence=NULL,lease_until=NULL,last_code='redriven' WHERE id=? AND attempts=?`)
              .run(attempt, attempt + (row.max_attempts as number), now, now, row.id, row.attempts);
            if (changed.changes !== 1) return jobFail();
            return verifyRow(rowById(row.id as string)!);
          },
          now,
        );
      }),
    prune: (olderThanMs, now, limit = 256) =>
      later(() => {
        captureJobPrune(olderThanMs, limit);
        return transaction(
          true,
          () => {
            const ids = db
              .prepare(`SELECT id FROM main."${t.job}" WHERE state='succeeded' AND updated_at<?
          ORDER BY updated_at,seq LIMIT ?`)
              .all(now - olderThanMs, limit)
              .map((row) => row.id as string);
            for (const id of ids) {
              db.prepare(`DELETE FROM main."${t.attempt}" WHERE job_id=?`).run(id);
              if (db.prepare(`DELETE FROM main."${t.job}" WHERE id=? AND state='succeeded'`).run(id).changes !== 1) return jobFail();
            }
            return Object.freeze({ pruned: ids.length, more: ids.length === limit });
          },
          now,
        );
      }),
    close: () =>
      later(() => {
        if (!closed) {
          closed = true;
          db.close();
        }
      }),
  };
  return Object.freeze(store);
}
