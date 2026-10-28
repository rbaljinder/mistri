/*
 * The delivery store contract both engines satisfy: the SQLite store
 * (eventDeliveryStore.ts) and the PostgreSQL store
 * (postgresEventDeliveryStore.ts). The publisher, maintenance and the
 * contract suites depend on this and never on an engine.
 */
import type {
  EventDeliveryAttemptInspection,
  EventDeliveryClaim,
  EventDeliveryCode,
  EventDeliveryInspection,
  EventDeliveryOutcome,
  EventDeliveryPolicy,
  EventDeliveryPruneResult,
  EventDeliveryStanding,
  EventDeliveryState,
  EventDiscovery,
} from './eventDeliveryTypes.js';

/**
 * One destination's delivery store, as both engines provide it. Each method
 * is one bounded store transaction; no transport call, callback or tick
 * ever runs inside one, and on PostgreSQL no pooled client is held between
 * calls. A coded `EventDeliveryRefusal` changed nothing; any other failure
 * is `EventDeliveryUnavailable`, and the store's account stands.
 *
 * `now` is the caller's clock. A store that keeps its own (PostgreSQL, by
 * default: the database's) uses that instead; the persisted floor still
 * stops the store if the clock it uses runs backwards.
 */
export interface EventDeliveryStore {
  readonly policy: EventDeliveryPolicy;
  /** Schedules every declared fact of newly committed, routed receipts, a
   * whole receipt at a time, and never regenerates one. Pressure is the
   * bound on rows still to deliver; delivered and failed rows do not count. */
  discover(): Promise<EventDiscovery>;
  /** Leases the next due delivery whose earlier declarations in the same
   * receipt are delivered. Expired leases are released first, as unknown. */
  claim(now: number): Promise<EventDeliveryClaim | undefined>;
  /** False when the claim no longer holds its lease: nothing is recorded. */
  complete(claim: EventDeliveryClaim, outcome: EventDeliveryOutcome, code: EventDeliveryCode, now: number): Promise<boolean>;
  /** Private bounded diagnostics: no payload, actor, token or error text. */
  inspect(state?: EventDeliveryState, afterEventId?: string, limit?: number): Promise<readonly EventDeliveryInspection[]>;
  attempts(eventId: string): Promise<readonly EventDeliveryAttemptInspection[]>;
  /** Where the destination stands, in one read and without verifying any row: the jobs host's readiness, and how
   * long it may wait before a delivery falls due (jobHost.ts). Inspecting every waiting row for it verified each
   * against its receipt, its siblings and its history, every few seconds. */
  standing(now: number): Promise<EventDeliveryStanding>;
  /** Operator maintenance: a failed or unknown delivery goes back to retry
   * now, with a fresh attempt budget, recorded as a history row naming the
   * operator. Delivered and in-flight deliveries refuse, and so does a
   * delivery already redriven as often as the limit allows. */
  redrive(eventId: string, operator: string, now: number): Promise<EventDeliveryInspection>;
  /** Deletes up to `limit` receipts' delivery rows, with their history, once
   * every fact in the receipt was delivered more than `olderThanMs` ago. The
   * receipt's marker stays, so discovery never takes it up again. */
  prune(olderThanMs: number, now: number, limit?: number): Promise<EventDeliveryPruneResult>;
  close(): Promise<void>;
}
