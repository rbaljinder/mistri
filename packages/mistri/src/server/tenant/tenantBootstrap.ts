import { isPromise, isProxy } from 'node:util/types';
import type { Identity } from '../auth/auth.js';
import {
  captureTenantData,
  denyTenant,
  denyTenantFor,
  tenantIdentifier,
  tenantOptions,
  tenantRecord,
} from '@mistriwork/engine/server/evidence.js';
import type { TenantMembershipRecord } from './tenantMembership.js';
import { captureTenantReadSource, type TenantReadSource } from './tenantReadSource.js';
import { tenantRuntimeClock } from './tenantRuntimeClock.js';

export interface TenantBootstrapOptions<Request> {
  readonly reader: TenantReadSource;
  readonly deployment: string;
  readonly roles: readonly string[];
  readonly maxLifetimeMs: number;
  readonly verifySession: (request: Request) => Identity | null | Promise<Identity | null>;
  readonly now?: () => number;
  /** The platform realm's roles, when the deployment has the realm: discovery
      then also says whether the account may open a platform context. */
  readonly platformRoles?: readonly string[];
}
type TenantBootstrapResult =
  | Readonly<{ status: 'signed_out' }>
  | Readonly<{
      status: 'ready';
      appId: string;
      accountId: string;
      memberships: readonly Readonly<{ tenantId: string }>[];
      /** Present when the account holds an active platform membership. */
      platform?: true;
    }>;
export interface TenantBootstrap<Request> {
  /**
   * The account's tenants. `seen`, where given, is told the tenant ids the first snapshot found, as soon as it has
   * passed its checks, so a caller may start what it would ask of them next (their names, a lease) beside the rest of
   * discovery. It is told nothing to act on: what discovery answers is only its final result, and a caller releases
   * nothing it started until that result agrees.
   */
  read(request: Request, guard?: () => void | Promise<void>, seen?: (tenantIds: readonly string[]) => void): Promise<TenantBootstrapResult>;
  retire(): Promise<void>;
}

/** Capture synchronous provider results before yielding, and never assimilate
 * a custom thenable or invoke a provider object's accessors. */
function delivered<T>(value: T | Promise<T>): T | Promise<T> {
  if (isPromise(value))
    return Promise.prototype.then.call(
      value,
      (result: T) => captureTenantData(result),
      () => denyTenant(),
    ) as Promise<T>;
  return captureTenantData(value);
}
function session(value: unknown): asserts value is Identity | null {
  if (value === null) return;
  tenantRecord(value, ['id', 'who', 'role']);
  tenantIdentifier(value.id, 1024);
  if (typeof value.who !== 'string' || (value.role !== undefined && typeof value.role !== 'string')) denyTenant();
}
function sameMemberships(a: readonly TenantMembershipRecord[], b: readonly TenantMembershipRecord[]): boolean {
  return (
    a.length === b.length &&
    a.every((record, index) => {
      const other = b[index];
      return (
        record.appId === other.appId &&
        record.accountId === other.accountId &&
        record.tenantId === other.tenantId &&
        record.membershipId === other.membershipId &&
        record.membershipVersion === other.membershipVersion &&
        record.tenantVersion === other.tenantVersion &&
        record.status === other.status &&
        record.tenantStatus === other.tenantStatus &&
        record.validUntil === other.validUntil &&
        record.roles.length === other.roles.length &&
        record.roles.every((role) => other.roles.includes(role))
      );
    })
  );
}

/** Private own-membership discovery only. Successful construction transfers
 * the dedicated reader's lifetime; invalid configuration leaves it caller-owned.
 * Three complete snapshots detect intervening changes, not an atomic guarantee
 * across the authentication and business stores or after buffered release. */
export function createTenantBootstrap<Request>(options: TenantBootstrapOptions<Request>): TenantBootstrap<Request> {
  const raw = tenantOptions(options, ['reader', 'deployment', 'roles', 'maxLifetimeMs', 'verifySession', 'now', 'platformRoles']);
  const platformRoles = raw.platformRoles === undefined ? undefined : captureTenantData(raw.platformRoles);
  if (
    platformRoles !== undefined &&
    (!Array.isArray(platformRoles) || platformRoles.length > 256 || new Set(platformRoles).size !== platformRoles.length)
  )
    return denyTenant();
  for (const role of platformRoles ?? []) tenantIdentifier(role);
  const platformAllowed = new Set(platformRoles ?? []);
  const reader = captureTenantReadSource(raw.reader as TenantReadSource);
  const deployment = captureTenantData(raw.deployment);
  tenantIdentifier(deployment);
  const roles = captureTenantData(raw.roles);
  if (!Array.isArray(roles) || roles.length > 256 || new Set(roles).size !== roles.length) return denyTenant();
  for (const role of roles) tenantIdentifier(role);
  const allowed = new Set(roles);
  const lifetime = raw.maxLifetimeMs;
  if (
    typeof lifetime !== 'number' ||
    !Number.isSafeInteger(lifetime) ||
    lifetime < 1 ||
    lifetime > 300_000 ||
    typeof raw.verifySession !== 'function' ||
    isProxy(raw.verifySession) ||
    (raw.now !== undefined && (typeof raw.now !== 'function' || isProxy(raw.now)))
  )
    return denyTenant();
  const verify = raw.verifySession as TenantBootstrapOptions<Request>['verifySession'];
  const now = tenantRuntimeClock((raw.now ?? Date.now) as () => number);
  const { appId, source } = reader.ownership;
  let retired = false;
  let retirement: Promise<void> | undefined;
  const pending = new Set<Promise<void>>();
  const active = () => {
    if (retired) denyTenant();
  };
  return Object.freeze({
    retire(): Promise<void> {
      retired = true;
      retirement ??= (async () => {
        await Promise.allSettled([...pending]);
        try {
          await reader.close();
        } catch {
          return denyTenant();
        }
      })();
      void retirement.catch(() => {});
      return retirement;
    },
    async read(
      request: Request,
      guard?: () => void | Promise<void>,
      seen?: (tenantIds: readonly string[]) => void,
    ): Promise<TenantBootstrapResult> {
      active();
      if (guard !== undefined && (typeof guard !== 'function' || isProxy(guard))) return denyTenant();
      if (seen !== undefined && (typeof seen !== 'function' || isProxy(seen))) return denyTenant();
      let finish!: () => void;
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      pending.add(held); // Reserve before any trusted clock/provider can retire.
      try {
        const clock = () => {
          active();
          const instant = now();
          active();
          return instant;
        };
        const started = clock();
        if (started > Number.MAX_SAFE_INTEGER - lifetime) return denyTenant();
        const check = () => {
          const instant = clock();
          if (instant >= started + lifetime) return denyTenant();
          return instant;
        };
        const guarded = async () => {
          check();
          if (guard) {
            const result = guard();
            const value = isPromise(result)
              ? await Promise.prototype.then.call(result, captureTenantData, () => denyTenant())
              : captureTenantData(result);
            if (value !== undefined) return denyTenant();
          }
          check();
        };
        const firstResult = delivered(verify(request));
        const first = isPromise(firstResult) ? await firstResult : firstResult;
        check();
        session(first);
        if (guard) await guarded();
        if (first === null) return Object.freeze({ status: 'signed_out' });
        const lookup = captureTenantData({ appId, accountId: first.id, source, deployment });
        const validate = (records: readonly TenantMembershipRecord[], instant: number) => {
          // The genuine reader validates the complete record shape and ordering.
          // Configuration roles and this request's lifetime remain owner checks.
          if (
            records.length > 256 ||
            records.some(
              (record) =>
                record.appId !== appId ||
                record.accountId !== first.id ||
                record.status !== 'active' ||
                record.tenantStatus !== 'active' ||
                record.validUntil <= instant ||
                record.roles.some((role) => !allowed.has(role)),
            )
          )
            denyTenant();
        };
        const initial = await reader.readMemberships(lookup);
        validate(initial, check());
        if (seen) {
          const ids = Object.freeze(initial.map((record) => record.tenantId));
          try {
            seen(ids);
          } catch {
            /* The caller's own: discovery goes on as if it had not been told. */
          }
        }
        const secondResult = delivered(verify(request));
        const second = isPromise(secondResult) ? await secondResult : secondResult;
        check();
        session(second);
        if (second === null || second.id !== first.id || second.who !== first.who || second.role !== first.role) return denyTenant();
        if (guard) await guarded();
        // Whether a platform context is open to the account: advisory, as the
        // tenant list is; opening one is its own admission. Asked beside the
        // second snapshot, under the same two verifications either way: one
        // after the other they were one more round trip before a chooser.
        const [final, held] = await Promise.all([
          reader.readMemberships(lookup),
          platformRoles === undefined
            ? undefined
            : reader.readPlatformMembership(
                captureTenantData({ realm: 'platform' as const, appId, accountId: first.id, source, deployment }),
              ),
        ]);
        validate(final, check());
        if (!sameMemberships(initial, final)) return denyTenant();
        let platform = false;
        if (held !== undefined) {
          const instant = check();
          platform =
            held !== null &&
            held.status === 'active' &&
            held.platformStatus === 'active' &&
            held.validUntil > instant &&
            held.roles.every((role) => platformAllowed.has(role));
        }
        // Authentication brackets all awaited database work. This is a final
        // account check, not an atomic auth/business-store revocation fence.
        const releasedResult = delivered(verify(request));
        const released = isPromise(releasedResult) ? await releasedResult : releasedResult;
        validate(final, check());
        session(released);
        if (released === null || released.id !== first.id || released.who !== first.who || released.role !== first.role)
          return denyTenant();
        if (guard) await guarded();
        // A finite release barrier follows the latest authentication wait, as
        // in the read runtime's verify -> source.assertCurrent completion path.
        const barrier = await reader.readMemberships(lookup);
        validate(barrier, check());
        if (!sameMemberships(final, barrier)) return denyTenant();
        return captureTenantData({
          status: 'ready' as const,
          appId,
          accountId: first.id,
          memberships: barrier.map((record) => ({ tenantId: record.tenantId })),
          ...(platform ? { platform: true as const } : {}),
        });
      } catch (error) {
        /* A read the database did not answer stays unavailable (503): said as a
           denial, a busy pool turned new tabs away as if their person had lost
           their tenants (a field report, at a step from 25 to 50 users). */
        return denyTenantFor(error);
      } finally {
        pending.delete(held);
        finish();
      }
    },
  });
}
