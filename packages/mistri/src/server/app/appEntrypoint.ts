import type { AppHost } from './apps.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { isDeepStrictEqual } from 'node:util';
import { isProxy } from 'node:util/types';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';

/** Public App identity is not a registry connection identifier. */
export function appEntrypoint(host: AppHost, registry: Registry): string | undefined {
  const reference = host.app.app.connection;
  const matches = registry.list().filter((connection) => !reference || connection.id === reference || connection.name === reference);
  return matches.length === 1 ? matches[0].id : undefined;
}

function plainDataProp(obj: object, key: string): { ok: true; value: unknown } | { ok: false } {
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (!desc) return { ok: true, value: undefined };
  if (!desc.enumerable || !('value' in desc)) return { ok: false };
  return { ok: true, value: desc.value };
}

function samePlainObject(value: unknown): value is object {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return typeof a !== 'object' || a === null || !isProxy(a);
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  return isDeepStrictEqual(captureTenantData(a), captureTenantData(b));
}

function sameSignIn(spec: unknown, auth: unknown): boolean {
  if (!samePlainObject(spec) || !samePlainObject(auth)) return false;
  for (const key of ['signUp', 'store', 'defaultRole'] as const) {
    const a = plainDataProp(spec, key);
    const b = plainDataProp(auth, key);
    if (!a.ok || !b.ok || !sameValue(a.value, b.value)) return false;
  }
  const pa = plainDataProp(spec, 'providers');
  const pb = plainDataProp(auth, 'providers');
  if (!pa.ok || !pb.ok) return false;
  if (
    !Array.isArray(pa.value) ||
    !Array.isArray(pb.value) ||
    isProxy(pa.value) ||
    isProxy(pb.value) ||
    Object.getPrototypeOf(pa.value) !== Array.prototype ||
    Object.getPrototypeOf(pb.value) !== Array.prototype ||
    pa.value.length !== pb.value.length
  )
    return false;
  for (let i = 0; i < pa.value.length; i++) {
    const da = Object.getOwnPropertyDescriptor(pa.value, i);
    const db = Object.getOwnPropertyDescriptor(pb.value, i);
    if (!da || !db || !da.enumerable || !db.enumerable || !('value' in da) || !('value' in db) || !sameValue(da.value, db.value))
      return false;
  }
  return true;
}

export function appHostingError(hosts: AppHost[]): string | undefined {
  if (hosts.length > 1 && new Set(hosts.map((host) => host.app.app.id)).size !== hosts.length) return 'Application IDs must be unique.';
  let authenticated: AppHost | undefined;
  let authCount = 0;
  for (let i = 0; i < hosts.length; i++) {
    const host = hosts[i];
    if (host.app.app.auth || host.auth) {
      authenticated = host;
      authCount++;
    }
  }
  if (!authCount) return undefined;
  if (hosts.length !== 1) return 'An authenticated application requires its own application server.';
  if (!authenticated!.app.app.auth || !authenticated!.auth) return 'Application authentication is unavailable.';
  try {
    // Compare sign-in policy values without invoking getters or deep-copying auth.roles on every request.
    if (!sameSignIn(authenticated!.auth.spec, authenticated!.app.app.auth))
      return 'Application authentication changed; restart the server.';
  } catch {
    return 'Application authentication changed; restart the server.';
  }
  return undefined;
}
