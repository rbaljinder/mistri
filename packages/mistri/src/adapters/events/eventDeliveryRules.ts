/**
 * What a delivery row, its attempt history and a destination's calls must
 * be, shared by the SQLite and PostgreSQL delivery stores so the two engines
 * cannot disagree about a valid delivery. Rows arrive normalised: integers
 * as numbers, text as strings, NULL as null.
 */
import {
  deliveryFail,
  deliveryInteger,
  deliveryRefuse,
  EVENT_DELIVERY_ATTEMPT_OUTCOMES,
  EVENT_DELIVERY_CODES,
  EVENT_DELIVERY_HISTORY_LIMIT,
  EVENT_DELIVERY_REDRIVE_LIMIT,
  EVENT_DELIVERY_STATES,
  EVENT_OPERATOR,
  type EventDeliveryAttemptInspection,
  type EventDeliveryAttemptOutcome,
  type EventDeliveryCode,
  type EventDeliveryInspection,
  type EventDeliveryOutcome,
  type EventDeliveryPolicy,
  type EventDeliveryState,
} from './eventDeliveryTypes.js';

export type DeliveryRow = Readonly<Record<string, unknown>>;
export const DELIVERY_MAX_CLOCK = Number.MAX_SAFE_INTEGER - 86_700_000;
const safe = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Exponential from the last redrive, so a redriven delivery starts its
 * backoff over rather than at the ceiling it already reached. */
export function deliveryBackoff(policy: EventDeliveryPolicy, row: DeliveryRow): number {
  const sinceRedrive = (row.attempts as number) - ((row.attempt_limit as number) - policy.limits.maxAttempts);
  return Math.min(policy.limits.maxBackoffMs, policy.limits.backoffMs * 2 ** (Math.max(1, sinceRedrive) - 1));
}

export function inspectDeliveryRow(row: DeliveryRow): EventDeliveryInspection {
  if (
    !EVENT_DELIVERY_STATES.includes(row.state as EventDeliveryState) ||
    !safe(row.attempts) ||
    !safe(row.redrives) ||
    !safe(row.attempt_limit) ||
    (row.redrives as number) > EVENT_DELIVERY_REDRIVE_LIMIT ||
    (row.attempt_limit as number) < 1 ||
    (row.attempt_limit as number) > EVENT_DELIVERY_HISTORY_LIMIT ||
    (row.attempts as number) > (row.attempt_limit as number) ||
    !safe(row.next_at) ||
    !safe(row.ordinal) ||
    (row.last_code !== null && !EVENT_DELIVERY_CODES.includes(row.last_code as EventDeliveryCode))
  )
    return deliveryFail();
  if (row.state === 'leased') {
    if (!safe(row.lease_until) || typeof row.token !== 'string' || row.token.length !== 36) return deliveryFail();
  } else if (row.lease_until !== null || row.token !== null) return deliveryFail();
  return Object.freeze({
    eventId: row.event_id as string,
    receiptId: row.receipt_id as string,
    ordinal: row.ordinal as number,
    state: row.state as EventDeliveryState,
    attempts: row.attempts as number,
    maxAttempts: row.attempt_limit as number,
    redrives: row.redrives as number,
    nextAt: row.next_at as number,
    leaseUntil: row.lease_until as number | null,
    lastCode: row.last_code as EventDeliveryCode | null,
  });
}

/** The row and its complete history agree: numbered without a gap, only
 * the latest attempt may still be leased, every redrive names its operator,
 * and the budget is exactly the one the last redrive granted. */
export function verifyDeliveryHistory(policy: EventDeliveryPolicy, row: DeliveryRow, history: readonly DeliveryRow[]): void {
  // A delivered row whose tries were all forgotten by retention (server/retention.ts) has an empty history;
  // the pruner removes a delivery's tries together, so a partial history is still a defect.
  if (history.length === 0 && (row.attempts as number) > 0 && row.state === 'delivered') return;
  if (history.length !== row.attempts) return deliveryFail();
  let redrives = 0,
    lastRedrive = 0;
  history.forEach((attempt, i) => {
    if (
      attempt.attempt !== i + 1 ||
      !safe(attempt.started_at) ||
      !EVENT_DELIVERY_ATTEMPT_OUTCOMES.includes(attempt.outcome as EventDeliveryAttemptOutcome)
    )
      return deliveryFail();
    if (attempt.outcome === 'redriven') {
      if (
        attempt.token !== null ||
        attempt.deadline !== null ||
        attempt.code !== 'redriven' ||
        attempt.finished_at !== attempt.started_at ||
        typeof attempt.operator !== 'string' ||
        !EVENT_OPERATOR.test(attempt.operator)
      )
        return deliveryFail();
      redrives++;
      lastRedrive = i + 1;
      return;
    }
    if (
      typeof attempt.token !== 'string' ||
      attempt.token.length !== 36 ||
      !safe(attempt.deadline) ||
      attempt.deadline <= (attempt.started_at as number) ||
      attempt.operator !== null ||
      (i < history.length - 1 && attempt.outcome === 'leased')
    )
      return deliveryFail();
  });
  if (redrives !== row.redrives || row.attempt_limit !== lastRedrive + policy.limits.maxAttempts) return deliveryFail();
  const latest = history.at(-1);
  if (
    latest &&
    (row.state === 'leased'
      ? latest.outcome !== 'leased' || latest.token !== row.token || latest.deadline !== row.lease_until
      : latest.outcome === 'leased' || latest.code !== row.last_code || (row.state === 'delivered' && latest.outcome !== 'accepted'))
  )
    return deliveryFail();
}

/** Where an attempt's outcome leaves the delivery: delivered on acceptance,
 * failed at the budget, otherwise unknown or a retry. */
export function deliveryStateAfter(row: DeliveryRow, outcome: EventDeliveryOutcome): EventDeliveryState {
  return outcome === 'accepted' ? 'delivered' : row.attempts === row.attempt_limit ? 'failed' : outcome === 'unknown' ? 'unknown' : 'retry';
}

export function captureDeliveryCompletion(outcome: unknown, code: unknown): void {
  if (
    !['accepted', 'rejected', 'unknown'].includes(outcome as string) ||
    !EVENT_DELIVERY_CODES.includes(code as EventDeliveryCode) ||
    code === 'redriven' ||
    (outcome === 'accepted' && code !== 'accepted') ||
    (outcome === 'rejected' && code !== 'rejected') ||
    (outcome === 'unknown' && ['accepted', 'rejected'].includes(code as string))
  )
    deliveryFail();
}
export function captureDeliveryInspect(state: unknown, afterEventId: unknown, limit: unknown): void {
  if (state !== undefined && !EVENT_DELIVERY_STATES.includes(state as EventDeliveryState)) deliveryFail();
  deliveryInteger(limit, 1, 128);
  if (typeof afterEventId !== 'string' || afterEventId.length > 36) deliveryFail();
}
export function captureDeliveryPrune(olderThanMs: unknown, limit: unknown): void {
  deliveryInteger(olderThanMs, 0, DELIVERY_MAX_CLOCK);
  deliveryInteger(limit, 1, 1_000);
}
export function captureDeliveryEventId(eventId: unknown): string {
  if (typeof eventId !== 'string' || eventId.length !== 36) return deliveryRefuse('not_found');
  return eventId;
}

/** Whether an operator may redrive this delivery. A delivered fact is done;
 * a leased one belongs to its publisher until the lease runs out. */
export function assertDeliveryRedrivable(row: DeliveryRow): void {
  if (row.state !== 'failed' && row.state !== 'unknown') deliveryRefuse('not_redrivable');
  if ((row.redrives as number) >= EVENT_DELIVERY_REDRIVE_LIMIT) deliveryRefuse('redrive_limit');
}

export function deliveryAttemptInspection(row: DeliveryRow): EventDeliveryAttemptInspection {
  return Object.freeze({
    attempt: row.attempt as number,
    startedAt: row.started_at as number,
    deadline: row.deadline as number | null,
    outcome: row.outcome as EventDeliveryAttemptOutcome,
    code: row.code as EventDeliveryCode | null,
    finishedAt: row.finished_at as number | null,
    operator: row.operator as string | null,
  });
}
