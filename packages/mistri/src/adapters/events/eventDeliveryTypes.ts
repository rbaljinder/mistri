import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { captureCommandEventStoreBinding, type CommandEventStoreBinding } from './commandEventSchema.js';
import type { CommandEventEnvelope, CommandEventManifest } from './commandEventTypes.js';
import { captureCommandEventManifest } from './commandEventCapture.js';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';

export class EventDeliveryUnavailable extends Refusal {
  constructor(message = 'Event publication storage or policy could not be verified. Operator review is required.') {
    super(message);
    this.name = 'EventDeliveryUnavailable';
  }
}
export const deliveryFail = (message?: string): never => {
  throw new EventDeliveryUnavailable(message);
};

type EventDeliveryRefusalCode = 'not_found' | 'operator_invalid' | 'not_redrivable' | 'redrive_limit';
/** A refused maintenance call that changed nothing. The code is the whole
 * diagnostic: no payload, key or provenance is ever echoed back. */
export class EventDeliveryRefusal extends Refusal {
  constructor(readonly code: EventDeliveryRefusalCode) {
    super(`The event delivery store refused this call: ${code}.`);
    this.name = 'EventDeliveryRefusal';
  }
}
export const deliveryRefuse = (code: EventDeliveryRefusalCode): never => {
  throw new EventDeliveryRefusal(code);
};
/** An operator may put one delivery back in line at most this many times;
 * each redrive grants the destination's attempt budget once more. */
export const EVENT_DELIVERY_REDRIVE_LIMIT = 3;
/** History rows one delivery can hold: every budget spent, plus one row per redrive. */
export const EVENT_DELIVERY_HISTORY_LIMIT = 16 * (EVENT_DELIVERY_REDRIVE_LIMIT + 1) + EVENT_DELIVERY_REDRIVE_LIMIT;
/** Who redrove a delivery: an operator's stable id, kept in the history row. */
export const EVENT_OPERATOR = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
export function deliveryText(value: unknown, maximum: number): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value !== value.trim() ||
    Buffer.byteLength(value) > maximum ||
    /\p{Cc}|[\uD800-\uDFFF]/u.test(value)
  )
    deliveryFail();
}
export function deliveryInteger(value: unknown, min: number, max: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) deliveryFail();
}

/** Which committed facts a destination takes: an App-scope command's, one
 * named tenant's, or every tenant's (a tenant App's jobs, which carry the
 * fact's own tenant on). The manifest is the deployment's expectation, not
 * the batch's own, so a missing or reordered batch refuses. */
export type EventDeliveryRoute =
  | Readonly<{ scope: 'app'; commandId: string; commandVersion: number; manifest: CommandEventManifest }>
  | Readonly<{ scope: 'tenant'; tenantId: string; commandId: string; commandVersion: number; manifest: CommandEventManifest }>
  | Readonly<{ scope: 'tenants'; commandId: string; commandVersion: number; manifest: CommandEventManifest }>;
/** Private trusted deployment configuration. No request/session or envelope can
 * create this authority. Destination IDs identify immutable routing semantics;
 * changing service, routes or bounds requires a new destination ID. */
export interface EventDeliveryPolicy {
  readonly source: CommandEventStoreBinding;
  readonly serviceId: string;
  readonly destinationId: string;
  readonly routes: readonly EventDeliveryRoute[];
  readonly limits: Readonly<{
    maxAttempts: number;
    leaseMs: number;
    timeoutMs: number;
    backoffMs: number;
    maxBackoffMs: number;
    maxRetained: number;
    scanBatch: number;
  }>;
}
function exact(value: object, keys: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys.sort().join(','))
    deliveryFail();
}
export function captureEventDeliveryPolicy(input: EventDeliveryPolicy): EventDeliveryPolicy {
  try {
    // Captures descriptors without invoking accessors/toJSON; refuses proxies,
    // cycles and excess allocation before consulting any configuration value.
    const value = JSON.parse(canonicalCommandJson(input, 65_536)) as EventDeliveryPolicy;
    exact(value, ['source', 'serviceId', 'destinationId', 'routes', 'limits']);
    const source = captureCommandEventStoreBinding(value.source);
    deliveryText(value.serviceId, 128);
    deliveryText(value.destinationId, 128);
    if (!Array.isArray(value.routes) || !value.routes.length || value.routes.length > 64) deliveryFail();
    const routes = value.routes.map((route): EventDeliveryRoute => {
      const tenant = route && typeof route === 'object' && route.scope === 'tenant';
      if (!tenant && route?.scope !== 'app' && route?.scope !== 'tenants') return deliveryFail();
      exact(
        route,
        tenant ? ['scope', 'tenantId', 'commandId', 'commandVersion', 'manifest'] : ['scope', 'commandId', 'commandVersion', 'manifest'],
      );
      if (route.scope === 'tenant') {
        deliveryText(route.tenantId, 128);
        if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(route.tenantId)) deliveryFail();
      }
      deliveryText(route.commandId, 128);
      deliveryInteger(route.commandVersion, 1, Number.MAX_SAFE_INTEGER);
      return Object.freeze({ ...route, manifest: captureCommandEventManifest(route.manifest) });
    });
    if (
      new Set(
        routes.map((route) =>
          canonicalCommandJson([route.scope, route.scope === 'tenant' ? route.tenantId : '', route.commandId, route.commandVersion]),
        ),
      ).size !== routes.length
    )
      deliveryFail();
    // One receipt, one route: every tenant's route for a command version
    // leaves no named tenant's beside it to take the same receipt.
    const everyTenant = new Set(
      routes.filter((route) => route.scope === 'tenants').map((route) => canonicalCommandJson([route.commandId, route.commandVersion])),
    );
    if (routes.some((route) => route.scope === 'tenant' && everyTenant.has(canonicalCommandJson([route.commandId, route.commandVersion]))))
      deliveryFail();
    const limits = value.limits;
    exact(limits, ['maxAttempts', 'leaseMs', 'timeoutMs', 'backoffMs', 'maxBackoffMs', 'maxRetained', 'scanBatch']);
    deliveryInteger(limits.maxAttempts, 1, 16);
    deliveryInteger(limits.leaseMs, 20, 300_000);
    deliveryInteger(limits.timeoutMs, 1, limits.leaseMs - 1);
    deliveryInteger(limits.backoffMs, 1, 86_400_000);
    deliveryInteger(limits.maxBackoffMs, limits.backoffMs, 86_400_000);
    // Rows still to deliver, per destination. Delivered and failed rows do not
    // count: pruning bounds those, so a destination never stops for age.
    deliveryInteger(limits.maxRetained, 32, 10_000);
    deliveryInteger(limits.scanBatch, 1, 8);
    return Object.freeze({
      source,
      serviceId: value.serviceId,
      destinationId: value.destinationId,
      routes: Object.freeze(routes),
      limits: Object.freeze({ ...limits }),
    });
  } catch {
    return deliveryFail();
  }
}

export type EventDeliveryState = 'pending' | 'leased' | 'retry' | 'unknown' | 'delivered' | 'failed';
export type EventDeliveryOutcome = 'accepted' | 'rejected' | 'unknown';
export type EventDeliveryCode = 'accepted' | 'rejected' | 'transport' | 'timeout' | 'shutdown' | 'lease_expired' | 'redriven';
export const EVENT_DELIVERY_STATES: readonly EventDeliveryState[] = Object.freeze([
  'pending',
  'leased',
  'retry',
  'unknown',
  'delivered',
  'failed',
]);
export const EVENT_DELIVERY_CODES: readonly EventDeliveryCode[] = Object.freeze([
  'accepted',
  'rejected',
  'transport',
  'timeout',
  'shutdown',
  'lease_expired',
  'redriven',
]);
export type EventDeliveryAttemptOutcome = 'leased' | 'accepted' | 'rejected' | 'unknown' | 'redriven';
export const EVENT_DELIVERY_ATTEMPT_OUTCOMES: readonly EventDeliveryAttemptOutcome[] = Object.freeze([
  'leased',
  'accepted',
  'rejected',
  'unknown',
  'redriven',
]);
/** Rows still to deliver: the only ones pressure counts. */
export const EVENT_DELIVERY_OPEN: readonly EventDeliveryState[] = Object.freeze(['pending', 'leased', 'retry', 'unknown']);
export interface EventDeliveryClaim {
  readonly destinationId: string;
  readonly eventId: string;
  readonly attempt: number;
  readonly token: string;
  readonly deadline: number;
  readonly envelope: CommandEventEnvelope;
}
/** Where a destination stands, read without any row's receipt or history (EventDeliveryStore `standing`). */
export interface EventDeliveryStanding {
  /** Some delivery has failed. */
  readonly failed: boolean;
  /** When the longest-waiting pending, retrying or unknown delivery was due, or null with none waiting. */
  readonly waitingSince: number | null;
  /** The next moment after `at` a delivery falls due or a lease runs out, or null with none ahead. */
  readonly next: number | null;
  /** The store's clock when it looked: the database's on PostgreSQL, so `next - at` is a wait free of skew. */
  readonly at: number;
}
/** A standing row as either store reads it: PostgreSQL's `next` already the earlier of its two, SQLite's `due` and `lease` apart. */
export function deliveryStanding(row: Readonly<Record<string, unknown>> | undefined): EventDeliveryStanding {
  const time = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
  const ahead = [time(row?.next), time(row?.due), time(row?.lease)].filter((value): value is number => value !== null);
  return Object.freeze({
    failed: row?.failed === true || Number(row?.failed) === 1,
    waitingSince: time(row?.waiting),
    next: ahead.length ? Math.min(...ahead) : null,
    at: Number(row?.at),
  });
}

export interface EventDeliveryInspection {
  readonly eventId: string;
  readonly receiptId: string;
  readonly ordinal: number;
  readonly state: EventDeliveryState;
  /** Rows in the attempt history: attempts made, plus one per redrive. */
  readonly attempts: number;
  /** The attempt at which the delivery fails: the budget, raised by a redrive. */
  readonly maxAttempts: number;
  readonly redrives: number;
  readonly nextAt: number;
  readonly leaseUntil: number | null;
  readonly lastCode: EventDeliveryCode | null;
}
export interface EventDeliveryAttemptInspection {
  readonly attempt: number;
  readonly startedAt: number;
  /** Null on a redrive row, which leased nothing. */
  readonly deadline: number | null;
  readonly outcome: EventDeliveryAttemptOutcome;
  readonly code: EventDeliveryCode | null;
  readonly finishedAt: number | null;
  /** The operator who redrove the delivery; null on every transport attempt. */
  readonly operator: string | null;
}
export interface EventDiscovery {
  readonly scanned: number;
  readonly scheduled: number;
  /** Retention for rows still to deliver is full: nothing new was scheduled. */
  readonly pressure: boolean;
}
export interface EventDeliveryPruneResult {
  readonly receipts: number;
  readonly deliveries: number;
  /** The batch was full: call again for the next one. */
  readonly more: boolean;
}
export function captureEventOperator(value: unknown): string {
  if (typeof value !== 'string' || !EVENT_OPERATOR.test(value)) return deliveryRefuse('operator_invalid');
  return value;
}
