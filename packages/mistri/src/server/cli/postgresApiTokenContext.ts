/** Private one-shot operator context, not authority provenance or live server
 * validation. Trusted LoadedApp/config snapshots only; no DB/schema/bootstrap.
 * Current compatibility is intentionally narrower than general PostgreSQL:
 * explicit user/host/port/database, no identity-overriding URI parameters.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LoadedApp } from '../app/apps.js';
import { AUTHORITY_LOCK, checkAuthorityLock } from '../app/authorityLock.js';
import type { ConnectionConfig } from '@mistriwork/engine/server/connections.js';
import { appAuthStore } from '../auth/auth.js';
import { resolveConnection } from '@mistriwork/engine/server/auth/credentials.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import { assertApiTokenAppId } from '../api/apiTokenSecret.js';
import { assertPostgresAuthStoreSeparation } from '../auth/authStoreSeparation.js';

const refuse = (): never => {
  throw new Error('PostgreSQL token maintenance context is unavailable.');
};
function lock(path: string): string | undefined {
  try {
    const canonical = realpathSync(path),
      info = statSync(canonical);
    if (!info.isFile() || info.size > 1048576) return refuse();
    const value = readFileSync(canonical, 'utf8');
    if (Buffer.byteLength(value) > 1048576) return refuse();
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return refuse();
  }
}
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\p{Cc}\p{Cs}]/u.test(value)) return refuse();
}
function postgres(value: string): string {
  text(value);
  if (!/^postgres(?:ql)?:\/\//i.test(value) || value.includes('${')) return refuse();
  const parsed = new URL(value);
  if (!parsed.username || !parsed.hostname || !parsed.port || parsed.pathname.length < 2 || parsed.hash) return refuse();
  const seen = new Set<string>();
  for (const [key] of parsed.searchParams) {
    // These options are forwarded identically by the ordinary pg client and
    // the live separation probe. Host/user/db/port overrides are not inferred.
    if (!['sslmode', 'options'].includes(key) || seen.has(key)) return refuse();
    seen.add(key);
  }
  return value;
}

/** The same rule for a served App's PostgreSQL targets: explicit user, host,
 * port and database, and no identity-overriding URI parameters. */
export function isExplicitPostgresUrl(value: string): boolean {
  try {
    postgres(value);
    return true;
  } catch {
    return false;
  }
}

export async function resolvePostgresTokenRevokeContext(loadedApps: readonly LoadedApp[], configured: readonly ConnectionConfig[]) {
  try {
    if (loadedApps.length !== 1 || !loadedApps[0].app.auth) return refuse();
    const loaded = loadedApps[0],
      appId = loaded.app.id;
    assertApiTokenAppId(appId);
    const connections = captureTenantData(configured);
    if (!Array.isArray(connections) || connections.length > 128) return refuse();
    const ids = new Set<string>();
    for (const connection of connections) {
      text(connection.id);
      text(connection.name);
      text(connection.url);
      if (ids.has(connection.id)) return refuse();
      ids.add(connection.id);
    }
    const select = (reference?: string) => {
      const matches = connections.filter(
        (connection) => reference === undefined || connection.id === reference || connection.name === reference,
      );
      if (matches.length !== 1) return refuse();
    };
    if (loaded.app.sources) {
      for (const source of Object.values(loaded.app.sources)) select(source.connection);
      if (loaded.app.connection !== undefined) select(loaded.app.connection);
    } else select(loaded.app.connection);
    // appAuthStore deliberately expands braced references only; bare dollars
    // in an auth password remain literal, unlike ordinary business URLs.
    const url = postgres(appAuthStore(loaded));
    const authority = loaded.authority ? { ...loaded.authority } : undefined;
    const lockPath = authority?.lockPath ?? join(dirname(loaded.path), AUTHORITY_LOCK);
    const currentLock = lock(lockPath);
    if (currentLock !== authority?.lock) return refuse();
    if ((await checkAuthorityLock(authority, false)).problem || lock(lockPath) !== currentLock) return refuse();
    // Start all resolutions before waiting. resolveConnection performs each
    // environment expansion before its first credential-provider await.
    const resolved = await Promise.all(
      connections.map(async (connection) => ({
        connection,
        url: (await resolveConnection(connection.name, connection.url, { secrets: connection.source !== 'session' })).url,
      })),
    );
    const excludeConnections = resolved.flatMap(({ connection, url: target }) => {
      text(target);
      if (target.includes('${')) return refuse();
      if (connection.http) {
        const parsed = new URL(target);
        if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return refuse();
        return [];
      }
      if (/^postgres(?:ql)?:\/\//i.test(target))
        return [Object.freeze({ url: postgres(target), name: connection.name, source: 'session' as const })];
      if (/^(?:mysql|mariadb):\/\//i.test(target)) {
        const parsed = new URL(target);
        if (!parsed.hostname) return refuse();
        return [];
      }
      // A resolved plain SQLite filename cannot alias a PostgreSQL database.
      // Unknown schemes, URI SQLite and tilde expansion remain unsupported.
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('~') || target.startsWith(':')) return refuse();
      return [];
    });
    if (lock(lockPath) !== currentLock) return refuse();
    // Session-source exclusion URLs are already resolved, immutable secrets.
    // The owner/probe must not apply credentials/environment a second time.
    assertPostgresAuthStoreSeparation(url, excludeConnections);
    return Object.freeze({ url, appId, excludeConnections: Object.freeze(excludeConnections) });
  } catch {
    return refuse();
  }
}
