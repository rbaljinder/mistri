/** Native membership observations for suite flag management. Only enrollment
 * registers this port; selectors and structural enrollment copies cannot mint it. */
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import type { IncomingMessage } from 'node:http';
import { captureAppAuthRuntime, type AppAuthRuntime } from '../auth/auth.js';
import { captureTenantData, denyTenant } from '@mistriwork/engine/server/evidence.js';
import type { FlagAuthorityOptions } from '../flags/authority.js';
import { captureTenantReadSource, type TenantReadSource } from './tenantReadSource.js';
import { parseTenantSelector } from './tenantMembership.js';
import { readSqlitePlatformMembership, readSqliteTenantMembership, type TenantStoreBinding } from './tenantStore.js';
import type { TenantEnrollment } from './tenantEnrollment.js';

type Observe = NonNullable<FlagAuthorityOptions['observeMembership']>;
const owners = new WeakMap<object, Observe>();

/** Enrollment supplies its already-attested reader. SQLite gets a lazy native
 * snapshot reader for the final synchronous row fence; PostgreSQL uses fresh
 * observations plus a local lifetime fence, as native PG sessions do. Neither
 * claims a distributed transaction with the flag control database. */
export function registerSuiteFlagAccess(
  enrollment: object,
  input: {
    reader: TenantReadSource;
    binding: TenantStoreBinding;
    deployment: string;
    path?: string;
    now: () => number;
    maxLifetimeMs: number;
  },
) {
  const reader = captureTenantReadSource(input.reader);
  const { binding, deployment, path, maxLifetimeMs } = captureTenantData({
    binding: input.binding,
    deployment: input.deployment,
    path: input.path,
    maxLifetimeMs: input.maxLifetimeMs,
  });
  const now = input.now;
  if (reader.ownership.appId !== binding.appId || !isDeepStrictEqual(reader.ownership.source, binding.source)) return denyTenant();
  let retired = false,
    db: DatabaseSync | undefined;
  const active = () => {
    if (retired) denyTenant();
  };
  const observe: Observe = async (scope, accountId) => {
    active();
    if (scope.appId !== binding.appId) return denyTenant();
    const base = { appId: binding.appId, accountId, source: binding.source, deployment };
    const tenant = scope.tenantId === null ? null : { ...base, tenantId: parseTenantSelector([scope.tenantId]) };
    const platform = { ...base, realm: 'platform' as const };
    const syncRead = () => {
      active();
      db ??= new DatabaseSync(path!, { readOnly: true });
      return tenant ? readSqliteTenantMembership(db, binding, tenant) : readSqlitePlatformMembership(db, binding, platform);
    };
    const started = now();
    // Admission always comes from the enrolled source, including SQLite. The
    // final independent SQLite reader can only confirm those exact rows; a
    // replacement file cannot substitute different membership authority.
    const original = await (tenant ? reader.readMembership(tenant) : reader.readPlatformMembership(platform));
    active();
    if (!original) return null;
    const validUntil = Math.min(original.validUntil, started + maxLifetimeMs);
    const assertCurrent = () => {
      active();
      const instant = now();
      if (!Number.isSafeInteger(instant) || instant < started || instant >= validUntil) return denyTenant();
      if (path !== undefined && !isDeepStrictEqual(original, syncRead())) return denyTenant();
    };
    assertCurrent();
    return Object.freeze({ record: captureTenantData({ ...original, validUntil }), assertCurrent });
  };
  owners.set(enrollment, observe);
  return Object.freeze({
    async retire() {
      retired = true;
      owners.delete(enrollment);
    },
    async close() {
      retired = true;
      owners.delete(enrollment);
      db?.close();
      db = undefined;
    },
  });
}

export function captureSuiteFlagAccess(enrollment: object, current: () => void): Observe {
  const observe = owners.get(enrollment) ?? denyTenant();
  return async (scope, accountId) => {
    current();
    const result = await observe(scope, accountId);
    current();
    if (!result) return null;
    return Object.freeze({
      record: result.record,
      assertCurrent() {
        current();
        result.assertCurrent();
      },
    });
  };
}

/** Native membership lease for a composed response owner. It carries no role
 * grants or rows across the owner boundary, only current-observation fences. */
export function captureSuiteFlagScopeProof(
  enrollment: object,
  current: () => void,
  input: {
    auth: AppAuthRuntime;
    roles: Readonly<Record<string, { readonly realm?: string }>>;
  },
) {
  const observe = captureSuiteFlagAccess(enrollment, current),
    auth = captureAppAuthRuntime(input.auth);
  const roles = captureTenantData(Object.fromEntries(Object.entries(input.roles).map(([id, role]) => [id, role.realm])));
  return (environment: string) => async (request: IncomingMessage, accountId: string, tenantId: string | null) => {
    current();
    const native = await auth.sessionInstance(request);
    if (!native || native.identity.id !== accountId) return null;
    const scope = { appId: auth.appId, environment, tenantId };
    const realm = tenantId === null ? 'platform' : 'tenant';
    const read = async () => {
      current();
      auth.assertSessionCurrent(native);
      await auth.observeSession(native);
      const observation = await observe(scope, accountId);
      if (!observation) return null;
      const value = observation.record;
      if (
        value.appId !== auth.appId ||
        value.accountId !== accountId ||
        value.status !== 'active' ||
        !value.roles.length ||
        value.roles.some((role) => !Object.hasOwn(roles, role) || roles[role] !== realm) ||
        (tenantId === null
          ? !('realm' in value) || value.realm !== 'platform' || value.platformStatus !== 'active'
          : !('tenantId' in value) || value.tenantId !== tenantId || value.tenantStatus !== 'active')
      )
        return null;
      observation.assertCurrent();
      auth.assertSessionCurrent(native);
      current();
      return observation;
    };
    const original = await read();
    if (!original) return null;
    let latest = original;
    const signature = (value: typeof original) => {
      const { validUntil: _validUntil, ...record } = value.record;
      return record;
    };
    const assertCurrent = () => {
      current();
      auth.assertSessionCurrent(native);
      original.assertCurrent();
      latest.assertCurrent();
    };
    return Object.freeze({
      assertCurrent,
      async reobserve() {
        assertCurrent();
        const next = await read();
        if (!next || !isDeepStrictEqual(signature(original), signature(next))) return denyTenant();
        latest = next;
        assertCurrent();
      },
    });
  };
}

/** Advisory choices from native own-membership discovery. Each selected scope
 * still needs its independent retained lease and flag capability checks. */
export function captureSuiteFlagScopes(enrollment: TenantEnrollment<IncomingMessage>, current: () => void, native: AppAuthRuntime) {
  captureSuiteFlagAccess(enrollment, current); // Attest the actual enrollment key.
  const discover = enrollment.discover,
    auth = captureAppAuthRuntime(native);
  return async (request: IncomingMessage, accountId: string) => {
    current();
    const proof = await auth.sessionInstance(request);
    if (!proof || proof.identity.id !== accountId) return Object.freeze([]);
    const guard = async () => {
      current();
      await auth.observeSession(proof);
      auth.assertSessionCurrent(proof);
      current();
    };
    const value = await discover(request, guard);
    await guard();
    if (value.status !== 'ready' || value.accountId !== accountId || value.appId !== auth.appId) return denyTenant();
    if (value.memberships.length > 100) return denyTenant();
    return Object.freeze(value.memberships.map(({ tenantId }) => Object.freeze({ tenantId, label: tenantId })));
  };
}
