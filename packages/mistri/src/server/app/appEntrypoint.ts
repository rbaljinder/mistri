import { signInOf } from '../../shared/app.js';
import type { AppHost } from './apps.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { isDeepStrictEqual } from 'node:util';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';

/** Public App identity is not a registry connection identifier. */
export function appEntrypoint(host: AppHost, registry: Registry): string | undefined {
  const reference = host.app.app.connection;
  const matches = registry.list().filter((connection) => !reference || connection.id === reference || connection.name === reference);
  return matches.length === 1 ? matches[0].id : undefined;
}

export function appHostingError(hosts: AppHost[]): string | undefined {
  if (new Set(hosts.map((host) => host.app.app.id)).size !== hosts.length) return 'Application IDs must be unique.';
  const authenticated = hosts.filter((host) => host.app.app.auth || host.auth);
  if (authenticated.length && hosts.length !== 1) return 'An authenticated application requires its own application server.';
  if (authenticated.some((host) => !host.app.app.auth || !host.auth)) return 'Application authentication is unavailable.';
  try {
    // The native runtime holds detached immutable data. Compare policy values,
    // not the prototype used by the loader versus the captured snapshot.
    if (
      authenticated.some(
        (host) => !isDeepStrictEqual(signInOf(captureTenantData(host.auth!.spec)), signInOf(captureTenantData(host.app.app.auth))),
      )
    )
      return 'Application authentication changed; restart the server.';
  } catch {
    return 'Application authentication changed; restart the server.';
  }
  return undefined;
}
