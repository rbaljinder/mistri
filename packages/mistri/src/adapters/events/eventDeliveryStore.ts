import { randomUUID } from 'node:crypto';
import type { SQLOutputValue } from 'node:sqlite';
import { COMMAND_JOURNAL_TABLES } from '../commands/commandJournal.js';
import type { EventDeliveryStore } from './eventDeliveryContract.js';
import {
  assertDeliveryRedrivable,
  captureDeliveryCompletion,
  captureDeliveryEventId,
  captureDeliveryInspect,
  captureDeliveryPrune,
  DELIVERY_MAX_CLOCK,
  deliveryAttemptInspection,
  deliveryBackoff,
  deliveryStateAfter,
  inspectDeliveryRow,
  verifyDeliveryHistory,
} from './eventDeliveryRules.js';
import { assertSqliteEventDeliveryStore, EVENT_DELIVERY_TABLES as t, openEventDeliveryFile } from './eventDeliverySchema.js';
import { readEventDeliveryReceipt } from './eventDeliverySource.js';
import {
  EventDeliveryUnavailable,
  captureEventDeliveryPolicy,
  captureEventOperator,
  deliveryFail,
  deliveryInteger,
  deliveryRefuse,
  EventDeliveryRefusal,
  EVENT_DELIVERY_HISTORY_LIMIT,
  EVENT_DELIVERY_OPEN,
  type EventDeliveryCode,
  type EventDeliveryOutcome,
  type EventDeliveryPolicy,
} from './eventDeliveryTypes.js';

type Row = Record<string, SQLOutputValue>;
const OPEN = EVENT_DELIVERY_OPEN.map((state) => `'${state}'`).join(',');

/** One private connection. Each method is one synchronous, bounded
 * transaction behind the contract's promise; no caller callback, Promise or
 * network operation ever runs inside it. SQLite has one writer, so the
 * caller's clock is the store's clock, and receipts commit in the order the
 * discovery scan can trust. */
export function openSqliteEventDeliveryStore(existingPath: string, input: EventDeliveryPolicy): EventDeliveryStore {
  const policy = captureEventDeliveryPolicy(input),
    file = openEventDeliveryFile(existingPath),
    db = file.db;
  const destination = policy.destinationId,
    limits = policy.limits;
  let closed = false;
  const check = () => {
    if (closed) return deliveryFail();
    file.verifyFile();
    assertSqliteEventDeliveryStore(db, policy);
  };
  const transaction = <T>(write: boolean, work: () => T, now?: number): T => {
    try {
      if (closed || db.isTransaction) return deliveryFail();
      file.verifyFile();
      db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
      check();
      if (now !== undefined) {
        deliveryInteger(now, 0, DELIVERY_MAX_CLOCK);
        const clock = db.prepare(`SELECT last_clock FROM main."${t.meta}"`).get()!.last_clock as number;
        // Backward clocks stop publication rather than shortening leases.
        if (now < clock) return deliveryFail();
        db.prepare(`UPDATE main."${t.meta}" SET last_clock=?`).run(now);
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
        return deliveryFail();
      }
      if (error instanceof EventDeliveryRefusal || error instanceof EventDeliveryUnavailable) throw error;
      return deliveryFail();
    }
  };
  try {
    transaction(false, () => {});
  } catch (error) {
    db.close();
    throw error;
  }
  const history = (eventId: string) =>
    db
      .prepare(`SELECT * FROM main."${t.attempt}" WHERE destination_id=? AND event_id=?
    ORDER BY attempt LIMIT ${EVENT_DELIVERY_HISTORY_LIMIT + 1}`)
      .all(destination, eventId);
  const verifyRow = (row: Row) => {
    inspectDeliveryRow(row);
    const events = readEventDeliveryReceipt(db, policy, row.receipt_id as string);
    const envelope = events[row.ordinal as number];
    if (!envelope || envelope.eventId !== row.event_id) return deliveryFail();
    // Receipt order must be represented completely. Missing delivery rows are
    // corruption, never permission to skip an earlier declaration.
    const siblings = db
      .prepare(`SELECT event_id,ordinal FROM main."${t.delivery}"
      WHERE destination_id=? AND receipt_id=? ORDER BY ordinal LIMIT 33`)
      .all(destination, envelope.receiptId);
    if (siblings.length !== events.length || siblings.some((sibling, i) => sibling.ordinal !== i || sibling.event_id !== events[i].eventId))
      return deliveryFail();
    verifyDeliveryHistory(policy, row, history(envelope.eventId));
    return envelope;
  };
  const rowOf = (eventId: string) =>
    db.prepare(`SELECT * FROM main."${t.delivery}" WHERE destination_id=? AND event_id=?`).get(destination, eventId);
  const settle = (row: Row, outcome: EventDeliveryOutcome, code: EventDeliveryCode, now: number, nextAt: number) => {
    const state = deliveryStateAfter(row, outcome);
    const attempt = db
      .prepare(`UPDATE main."${t.attempt}" SET outcome=?,code=?,finished_at=?
      WHERE destination_id=? AND event_id=? AND attempt=? AND token=? AND outcome='leased'`)
      .run(outcome, code, now, destination, row.event_id, row.attempts, row.token);
    if (attempt.changes !== 1) return deliveryFail();
    const changed = db
      .prepare(`UPDATE main."${t.delivery}" SET state=?,next_at=?,token=NULL,lease_until=NULL,last_code=?
      WHERE destination_id=? AND event_id=? AND state='leased' AND token=? AND attempts=?`)
      .run(state, nextAt, code, destination, row.event_id, row.token, row.attempts);
    if (changed.changes !== 1) return deliveryFail();
  };
  const later = <T>(work: () => T): Promise<T> => {
    try {
      return Promise.resolve(work());
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const store: EventDeliveryStore = {
    policy,
    discover: () =>
      later(() =>
        transaction(true, () => {
          let scannedCount = db.prepare(`SELECT scanned_count FROM main."${t.destination}" WHERE id=?`).get(destination)!
            .scanned_count as number;
          // Receipt IDs are durable; SQLite's implicit rowid is not (VACUUM can
          // renumber it). An App-scope receipt keeps the empty namespace. The
          // platform realm's receipts share the store and source but never carry
          // events (its commands declare none): they are not facts to deliver,
          // and reading one as a tenant's would halt the destination.
          const rows = db
            .prepare(`SELECT r.id FROM main."${COMMAND_JOURNAL_TABLES.receipt}" r
        WHERE r.app_id=? AND r.realm='tenant' AND ((r.store_id=? AND r.source_id=?) OR (r.store_id='' AND r.source_id='' AND r.tenant_id='')) AND NOT EXISTS
          (SELECT 1 FROM main."${t.receipt}" seen WHERE seen.destination_id=? AND seen.receipt_id=r.id)
        ORDER BY r.id LIMIT ?`)
            .all(policy.source.appId, policy.source.storeId, policy.source.sourceId, destination, limits.scanBatch);
          let open = db
            .prepare(`SELECT count(*) AS n FROM main."${t.delivery}" WHERE destination_id=? AND state IN (${OPEN})`)
            .get(destination)!.n as number;
          if (!Number.isSafeInteger(open) || open > limits.maxRetained) return deliveryFail();
          let scanned = 0,
            scheduled = 0;
          for (const row of rows) {
            const events = readEventDeliveryReceipt(db, policy, row.id as string);
            const existing = db
              .prepare(`SELECT event_id,ordinal FROM main."${t.delivery}"
          WHERE destination_id=? AND receipt_id=? ORDER BY ordinal LIMIT 33`)
              .all(destination, row.id);
            if (
              existing.length &&
              (existing.length !== events.length ||
                existing.some((saved, i) => saved.event_id !== events[i].eventId || saved.ordinal !== i))
            )
              return deliveryFail();
            const additional = existing.length ? 0 : events.length;
            // A whole receipt or none of it: an ordered batch is never split.
            if (open + additional > limits.maxRetained) return { scanned, scheduled, pressure: true };
            if (!existing.length)
              for (const event of events) {
                db.prepare(`INSERT INTO main."${t.delivery}"
            (destination_id,event_id,receipt_id,ordinal,state,attempts,redrives,attempt_limit,next_at,token,lease_until,last_code)
            VALUES (?,?,?,?,'pending',0,0,?,0,NULL,NULL,NULL)`).run(
                  destination,
                  event.eventId,
                  event.receiptId,
                  event.ordinal,
                  limits.maxAttempts,
                );
              }
            open += additional;
            scheduled += additional;
            scanned++;
            db.prepare(`INSERT INTO main."${t.receipt}" (destination_id,receipt_id,event_count,pruned_at) VALUES (?,?,?,NULL)`).run(
              destination,
              row.id,
              events.length,
            );
            db.prepare(`UPDATE main."${t.destination}" SET scanned_count=? WHERE id=?`).run(++scannedCount, destination);
          }
          return { scanned, scheduled, pressure: false };
        }),
      ),
    claim: (now) =>
      later(() =>
        transaction(
          true,
          () => {
            // Recover a bounded number of abandoned attempts, retaining ambiguity.
            const expired = db
              .prepare(`SELECT * FROM main."${t.delivery}" WHERE destination_id=?
        AND state='leased' AND lease_until<=? ORDER BY lease_until,event_id LIMIT 8`)
              .all(destination, now);
            for (const row of expired) {
              verifyRow(row);
              settle(row, 'unknown', 'lease_expired', now, (row.lease_until as number) + deliveryBackoff(policy, row));
            }
            const row = db
              .prepare(`SELECT d.* FROM main."${t.delivery}" d WHERE d.destination_id=?
        AND d.state IN ('pending','retry','unknown') AND d.next_at<=? AND d.attempts<d.attempt_limit
        AND NOT EXISTS (SELECT 1 FROM main."${t.delivery}" prior WHERE prior.destination_id=d.destination_id
          AND prior.receipt_id=d.receipt_id AND prior.ordinal<d.ordinal AND prior.state<>'delivered')
        ORDER BY d.next_at,d.receipt_id,d.ordinal LIMIT 1`)
              .get(destination, now);
            if (!row) return undefined;
            const envelope = verifyRow(row),
              attempt = (row.attempts as number) + 1,
              token = randomUUID(),
              deadline = now + limits.leaseMs;
            db.prepare(`UPDATE main."${t.delivery}" SET state='leased',attempts=?,token=?,lease_until=?
        WHERE destination_id=? AND event_id=?`).run(attempt, token, deadline, destination, envelope.eventId);
            db.prepare(`INSERT INTO main."${t.attempt}" (destination_id,event_id,attempt,token,started_at,deadline,outcome,code,finished_at,operator)
        VALUES (?,?,?,?,?,?,'leased',NULL,NULL,NULL)`).run(destination, envelope.eventId, attempt, token, now, deadline);
            return Object.freeze({ destinationId: destination, eventId: envelope.eventId, attempt, token, deadline, envelope });
          },
          now,
        ),
      ),
    complete: (claim, outcome, code, now) =>
      later(() =>
        transaction(
          true,
          () => {
            captureDeliveryCompletion(outcome, code);
            if (claim.destinationId !== destination) return false;
            const row = rowOf(claim.eventId);
            if (
              !row ||
              row.state !== 'leased' ||
              row.token !== claim.token ||
              row.attempts !== claim.attempt ||
              row.lease_until !== claim.deadline ||
              now >= claim.deadline
            )
              return false;
            verifyRow(row);
            settle(row, outcome, code, now, outcome === 'accepted' ? now : now + deliveryBackoff(policy, row));
            return true;
          },
          now,
        ),
      ),
    inspect: (state, afterEventId = '', limit = 32) =>
      later(() => {
        captureDeliveryInspect(state, afterEventId, limit);
        return transaction(false, () =>
          Object.freeze(
            db
              .prepare(`SELECT * FROM main."${t.delivery}"
        WHERE destination_id=? AND event_id>? ${state === undefined ? '' : 'AND state=?'} ORDER BY event_id LIMIT ?`)
              .all(...(state === undefined ? [destination, afterEventId, limit] : [destination, afterEventId, state, limit]))
              .map((row) => {
                verifyRow(row);
                return inspectDeliveryRow(row);
              }),
          ),
        );
      }),
    /** Private bounded diagnostics omit payloads, actor IDs, tokens and errors. */
    attempts: (eventId) =>
      later(() => {
        if (typeof eventId !== 'string' || eventId.length !== 36) return deliveryFail();
        return transaction(false, () => Object.freeze(history(eventId).map(deliveryAttemptInspection)));
      }),
    redrive: (eventId, operator, now) =>
      later(() => {
        const who = captureEventOperator(operator),
          id = captureDeliveryEventId(eventId);
        return transaction(
          true,
          () => {
            const row = rowOf(id);
            if (!row) return deliveryRefuse('not_found');
            verifyRow(row);
            assertDeliveryRedrivable(row);
            const attempt = (row.attempts as number) + 1;
            db.prepare(`INSERT INTO main."${t.attempt}" (destination_id,event_id,attempt,token,started_at,deadline,outcome,code,finished_at,operator)
          VALUES (?,?,?,NULL,?,NULL,'redriven','redriven',?,?)`).run(destination, id, attempt, now, now, who);
            const changed = db
              .prepare(`UPDATE main."${t.delivery}" SET state='retry',attempts=?,redrives=redrives+1,attempt_limit=?,next_at=?,
          token=NULL,lease_until=NULL,last_code='redriven' WHERE destination_id=? AND event_id=? AND attempts=?`)
              .run(attempt, attempt + limits.maxAttempts, now, destination, id, row.attempts);
            if (changed.changes !== 1) return deliveryFail();
            const after = rowOf(id)!;
            verifyRow(after);
            return inspectDeliveryRow(after);
          },
          now,
        );
      }),
    prune: (olderThanMs, now, limit = 64) =>
      later(() => {
        captureDeliveryPrune(olderThanMs, limit);
        return transaction(
          true,
          () => {
            // Whole receipts only: every declared fact delivered, the last of
            // them long enough ago. A partly delivered receipt keeps its order.
            const receipts = db
              .prepare(`SELECT receipt_id FROM main."${t.delivery}" WHERE destination_id=? GROUP BY receipt_id
          HAVING sum(state<>'delivered')=0 AND max(next_at)<? ORDER BY max(next_at),receipt_id LIMIT ?`)
              .all(destination, now - olderThanMs, limit);
            let deliveries = 0;
            for (const { receipt_id: receiptId } of receipts) {
              const marker = db
                .prepare(`SELECT event_count FROM main."${t.receipt}" WHERE destination_id=? AND receipt_id=? AND pruned_at IS NULL`)
                .get(destination, receiptId);
              if (!marker) return deliveryFail();
              db.prepare(`DELETE FROM main."${t.attempt}" WHERE destination_id=? AND event_id IN
            (SELECT event_id FROM main."${t.delivery}" WHERE destination_id=? AND receipt_id=?)`).run(destination, destination, receiptId);
              const gone = Number(
                db
                  .prepare(`DELETE FROM main."${t.delivery}" WHERE destination_id=? AND receipt_id=? AND state='delivered'`)
                  .run(destination, receiptId).changes,
              );
              if (gone !== marker.event_count) return deliveryFail();
              deliveries += gone;
              db.prepare(`UPDATE main."${t.receipt}" SET pruned_at=? WHERE destination_id=? AND receipt_id=?`).run(
                now,
                destination,
                receiptId,
              );
            }
            return Object.freeze({ receipts: receipts.length, deliveries, more: receipts.length === limit });
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
