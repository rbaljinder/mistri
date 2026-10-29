/**
 * Evidence: capturing what a caller handed in as frozen plain data, and
 * failing closed when it cannot be trusted.
 *
 * It lived in `src/server/tenant/` because tenancy is where it was first
 * needed, and 27 modules outside tenancy ended up importing tenancy for it —
 * `auth/`, `app/`, `cli/`, `commands/` and every non-tenant `api/` file — which
 * made a folder boundary unreadable: almost every arrow into tenant/ was this
 * one file. Nothing in it is tenant-specific. It stays under `src/server/`
 * rather than `src/shared/` because it reads `node:util/types` and the
 * adapters' outcome error, neither of which the client may carry.
 *
 * The names are unchanged, tenant spelling and all: they are what the refusal
 * path reads as, and renaming them would have made one mechanical move into a
 * diff nobody could review.
 */
import { isProxy, isUint8Array } from 'node:util/types';
import { TransactionOutcomeUnknown } from '../adapters/adapter.js';
import { PoolBusy } from '../adapters/poolMetrics.js';
import { Refusal, recordRefusalCause, refusalCause } from '../shared/refusal.js';
import type { DatabaseSchema } from '../shared/schema.js';
import { isCapturedScopeCatalog } from '../shared/scopeCatalog.js';
import { keepBreakdownsAgainst } from '../shared/breakdown.js';
import { isRowScopeSnapshot } from '../shared/rowScope.js';
import { carryServerRequest } from './serverRequests.js';

/** Private admission errors reveal neither membership existence nor provider data. */
export class TenantContextError extends Error {
  readonly code: string = 'tenant_context_unavailable';
  constructor() {
    super('The tenant context could not be verified.');
    this.name = 'TenantContextError';
  }
}
/* The recorded reason behind every opaque refusal lives with the refusal
   class itself (shared/refusal.ts), so an adapter's scope check records one
   the same way a tenant denial does. */
export { recordRefusalCause, refusalCause, refusalHeadline, refusalReasons, refusalReasonsBelow } from '../shared/refusal.js';
export const denyTenant = (cause?: unknown): never => {
  throw recordRefusalCause(new TenantContextError(), cause);
};
/** The database could not answer, so authority was never decided: not a
 * refusal. Still a TenantContextError — every consumer that denies on one
 * still denies — and carries no `cause`, so no driver text travels with it
 * (the driver's error is recorded for the operator, as any refusal's is).
 * Only an owner that answers a caller tells the two apart (503, not 403). */
export class TenantUnavailableError extends TenantContextError {
  override readonly code: string = 'tenant_temporarily_unavailable';
}

const NETWORK = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN']);
/* Recognized positively. Every refusal in the tenant path is a
   TenantContextError, and anything unrecognized denies, so a new failure
   shape can only ever be answered as a refusal, never as a fault that hides
   one. */
export function databaseFault(error: unknown): boolean {
  if (error instanceof TenantUnavailableError) return true;
  if (error instanceof TenantContextError || !(error instanceof Error)) return false;
  if (error instanceof TransactionOutcomeUnknown) return true;
  /* A pool that would not lend a connection in time (poolMetrics.ts): nothing
     was leased, so nothing was asked. Under load this is the commonest fault
     there is, and answered as a denial it told a person their tenant context
     was gone because the server was busy (a field report: 403s on reads at
     twelve users on half a core). */
  if (error instanceof PoolBusy) return true;
  // A check refused because the engine could not answer (the SQLite catalog
  // scan): the cause, one level deep and itself a raw driver error, decides.
  if (error instanceof Refusal) return !(error.cause instanceof Refusal) && databaseFault(error.cause);
  const { code, severity } = error as { code?: unknown; severity?: unknown };
  // node:sqlite: busy, locked, I/O, a missing or unreadable file.
  if (code === 'ERR_SQLITE_ERROR') return true;
  if (typeof code === 'string' && NETWORK.has(code)) return true;
  // pg's DatabaseError: a server-reported SQLSTATE (a terminated backend, a
  // database refusing connections, a cancelled or timed-out statement).
  if (typeof severity === 'string' && typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return true;
  // pg's own connection errors, and this pool's, carry no code.
  return /^(?:Connection terminated|Client has encountered a connection error|Client was closed|timeout exceeded when trying to connect|Observed PostgreSQL checkout is unavailable|Postgres connection manager is closed)/.test(
    error.message,
  );
}

/** The request's own fault, said to the caller as that, not as the context's
 * denial: no record this context reads has the key (`not_found`, the same for
 * one that is missing and one that is another tenant's), or a read that cannot
 * be answered as asked (`invalid_read`). The context read and decided
 * nothing to its detriment, and revalidates before this is let out
 * (tenantReadRuntime.ts), so the session that asked keeps going. It carries
 * no data: its words are fixed here. */
export class TenantRequestFault extends Error {
  constructor(
    readonly status: 400 | 404 | 501,
    readonly code: 'not_found' | 'invalid_read',
  ) {
    super(code === 'not_found' ? 'No such record.' : 'This read cannot be answered.');
    this.name = 'TenantRequestFault';
  }
}

/**
 * Whether the database not answering is what failed, under however many
 * refusals and failures it was recorded: a tenant write's failure is
 * value-free on purpose and keeps what failed beneath it, and a read that
 * waited on that write (an inbox's mail) refuses with it as its cause. Read
 * positively, as `databaseFault` is, and a denial anywhere on the way down
 * stays a denial: it decided something, whatever lies beneath it.
 */
export function databaseUnanswered(error: unknown): boolean {
  let at: unknown = error;
  for (let depth = 0; at !== null && typeof at === 'object' && depth < 16; depth++) {
    if (databaseFault(at)) return true;
    if (at instanceof TenantContextError) return false;
    at = refusalCause(at) ?? (at instanceof Error ? at.cause : undefined);
  }
  return false;
}

/** Deny, unless the cause is the database failing to answer: then the tenant
 * context is unavailable. Fails closed either way. */
export const denyTenantFor = (cause: unknown): never => {
  throw recordRefusalCause(databaseUnanswered(cause) ? new TenantUnavailableError() : new TenantContextError(), cause);
};

/* What a capture produced, with what it cost: the nodes, characters and depth
   the budget below counted for it, and whether it holds bytes. A request read
   its App, ownership snapshot and catalogs through here, and copied all of
   them again on every request — a tenant server spent most of its time
   re-copying data that could not have changed (G118). A value in this map is
   one this function built and froze from plain data, so capturing it again
   could only produce an equal copy: it is reused, and its recorded cost is
   still charged, so the budget refuses exactly what it refused before. A
   subtree holding bytes is never entered — a byte array cannot be frozen —
   and so is copied every time, as before. */
interface Cost {
  nodes: number;
  characters: number;
  depth: number;
}
const capturedData = new WeakMap<object, Cost>();
/* A scope catalog (shared/scopeCatalog.ts) is detached, validated and deeply
   frozen plain data too; its cost is measured once, without copying it. So is
   a row scope snapshotRowScope made (shared/rowScope.ts): a tenant read hands
   its request's scope through several captures, and each copied it whole. */
const catalogCosts = new WeakMap<object, Cost>();
function catalogCost(value: object): Cost {
  let cost = catalogCosts.get(value);
  if (cost) return cost;
  cost = { nodes: 0, characters: 0, depth: 0 };
  const walk = (node: unknown, depth: number) => {
    cost!.nodes++;
    if (depth > cost!.depth) cost!.depth = depth;
    if (typeof node === 'string') cost!.characters += node.length;
    else if (node && typeof node === 'object')
      for (const key of Object.keys(node)) {
        if (!Array.isArray(node)) cost!.characters += key.length;
        walk((node as Record<string, unknown>)[key], depth + 1);
      }
  };
  walk(value, 0);
  catalogCosts.set(value, cost);
  return cost;
}
/* A caller's value frozen all the way down — every object and array in it frozen as given, plain data with no
   accessor (a copy refuses one) and no proxy — is one nothing can change either: freezing cannot be undone, and a
   frozen object's values cannot be swapped. A policy's row scope is such a constant (`Object.freeze({ lead: true,
   … })`), handed back on every request and copied afresh by each, so every request's scope was new data and nothing
   keyed by it was ever found again (tenantReadScope.ts). Its capture is kept with it, and reused as a captured value
   is: same object, same cost charged. */
const frozenCaptures = new WeakMap<object, object>();
/** Test-only: how many objects and arrays captures have copied, as opposed to reused. */
export const captureCounters = { copied: 0 };

/** Whether a value is one captureTenantData froze all the way down, or a
 * captured scope catalog: data that cannot change for as long as it lives, so
 * an answer derived from it alone may be kept with it (a WeakMap keyed by it)
 * and is gone when it is. A reload captures new values and starts afresh. */
export function isCapturedTenantData(value: unknown): boolean {
  return value !== null && typeof value === 'object' && (capturedData.has(value) || isCapturedScopeCatalog(value as DatabaseSchema));
}

/* A breakdown compiled against such a catalog is kept with it (breakdown.ts compileBreakdown): a served tenant
   catalog is one, and an enter compiles each of its breakdowns against it for the access check and the SQL pane. */
keepBreakdownsAgainst(isCapturedTenantData);

/** Server evidence is data, never getters, proxies, thenables or inherited grants. */
export function captureTenantData<T>(input: T): T {
  /* A capture handed back whole is itself, within every bound by having been
     made within them: answered before the walk's state is set up, since a
     request hands the same evidence through dozens of these. */
  if (input !== null && typeof input === 'object' && capturedData.has(input)) return carryServerRequest(input, input);
  let nodes = 0,
    characters = 0,
    reach = 0,
    bytes = 0,
    /* Objects copied that were not frozen as given: a subtree with none is the caller's constant. */
    thawed = 0;
  const reuse = (value: object, depth: number): unknown => {
    const cost =
      capturedData.get(value) ??
      (isCapturedScopeCatalog(value as DatabaseSchema) || isRowScopeSnapshot(value) ? catalogCost(value) : undefined);
    if (!cost) return undefined;
    // Exactly the counts a fresh copy of this value would have added.
    if ((nodes += cost.nodes) > 262_144 || depth + cost.depth > 24 || (characters += cost.characters) > 16_777_216) return denyTenant();
    if (depth + cost.depth > reach) reach = depth + cost.depth;
    return value;
  };
  const copy = (value: unknown, depth = 0): unknown => {
    if (value !== null && typeof value === 'object' && !isProxy(value)) {
      const kept = reuse(frozenCaptures.get(value) ?? value, depth);
      if (kept !== undefined) return kept;
    }
    if (++nodes > 262_144 || depth > 24) return denyTenant();
    if (depth > reach) reach = depth;
    if (value === undefined || value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : denyTenant();
    if (typeof value === 'string') {
      if ((characters += value.length) > 16_777_216) return denyTenant();
      return value;
    }
    if (typeof value !== 'object' || isProxy(value)) return denyTenant();
    /* A file's bytes (a file resource's content column, read or written): a
       genuine byte array, copied, so nothing the caller still holds changes
       what was captured. Counted against the same budget as text. */
    if (isUint8Array(value)) {
      const copied = Buffer.from(value);
      bytes++;
      if ((characters += copied.byteLength) > 16_777_216) return denyTenant();
      return copied;
    }
    const array = Array.isArray(value),
      prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== null && prototype !== Object.prototype) return denyTenant();
    const keys = Reflect.ownKeys(value);
    if (keys.length > 65_537) return denyTenant();
    captureCounters.copied++;
    const before = { nodes: nodes - 1, characters, reach, bytes, thawed };
    // Counted after `before`: the value itself must have been frozen too, not only what it holds.
    if (!Object.isFrozen(value)) thawed++;
    reach = depth;
    let result: object;
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
      if (!Number.isInteger(length) || length > 65_536 || keys.length !== length + 1) return denyTenant();
      result = Object.freeze(
        Array.from({ length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor?.enumerable || !('value' in descriptor)) return denyTenant();
          return copy(descriptor.value, depth + 1);
        }),
      );
    } else {
      const record: Record<string, unknown> = Object.create(null);
      for (const key of keys) {
        if (typeof key !== 'string' || (characters += key.length) > 16_777_216) return denyTenant();
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) return denyTenant();
        record[key] = copy(descriptor.value, depth + 1);
      }
      result = Object.freeze(record);
    }
    if (bytes === before.bytes) {
      capturedData.set(result, {
        nodes: nodes - before.nodes,
        characters: characters - before.characters,
        depth: reach - depth,
      });
      if (thawed === before.thawed) frozenCaptures.set(value, result);
    }
    reach = Math.max(reach, before.reach);
    return result;
  };
  try {
    // A request the server built for a file's own columns stays the server's through the copy (serverRequests.ts).
    return carryServerRequest(input, copy(input) as T);
  } catch {
    return denyTenant();
  }
}

export function tenantRecord(value: unknown, fields?: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (fields && Object.keys(value).some((key) => !fields.includes(key))))
    denyTenant();
}

export function tenantIdentifier(value: unknown, maximum = 256): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > maximum || value !== value.trim() || /\p{Cc}/u.test(value)) denyTenant();
}

/** Trusted callbacks are captured without invoking configuration accessors. */
export function tenantOptions(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || isProxy(input) || Array.isArray(input)) return denyTenant();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) return denyTenant();
  const result: Record<string, unknown> = Object.create(null);
  const keys = Reflect.ownKeys(input);
  /* The refusal names the key it did not expect: a loader that grows a key
     (an App's pageFiles did) otherwise stops every tenant start with only
     "the tenant context could not be verified". Recorded for the operator's
     reader alone, and cut short, since the key is the caller's text. */
  const unknown = keys.find((key) => typeof key !== 'string' || !fields.includes(key));
  if (unknown !== undefined) return denyTenant(`"${String(unknown).slice(0, 64)}" is not a key this takes; it takes ${fields.join(', ')}.`);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return denyTenant();
    result[key as string] = descriptor.value;
  }
  return result;
}
