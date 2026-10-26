/** Private one-shot operator snapshot for SQLite revoke, not a hot-reload or
 * credential authority proof. Inputs are trusted LoadedApp/config snapshots.
 * No DB opens, bootstrap, migrations, schema reads, or API exposure required. */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import type { LoadedApp } from '../app/apps.js';
import { AUTHORITY_LOCK, checkAuthorityLock } from '../app/authorityLock.js';
import type { ConnectionConfig } from '@mistriwork/engine/server/connections.js';
import { appAuthStore } from '../auth/auth.js';
import { assertAuthStoreSeparation, captureAuthStoreExclusion } from '../auth/authStoreSeparation.js';
import { expandEnv } from '@mistriwork/engine/server/auth/credentials.js';

const refuse = (): never => {
  throw new Error('SQLite token maintenance context is unavailable.');
};
function file(path: string) {
  const canonical = realpathSync(path),
    info = statSync(canonical);
  if (!info.isFile()) return refuse();
  return { canonical, device: info.dev, inode: info.ino, size: info.size, modified: info.mtimeMs, changed: info.ctimeMs };
}
function lock(path: string): string | undefined {
  try {
    if (file(path).size > 1048576) return refuse();
    const value = readFileSync(path, 'utf8');
    if (Buffer.byteLength(value) > 1048576) return refuse();
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return refuse();
  }
}
function pathOnly(value: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.trim() !== value ||
    /[\p{Cc}\p{Cs}]/u.test(value) ||
    value.includes('${') ||
    value.startsWith('~') ||
    /^[a-z][a-z0-9+.-]*:/i.test(value)
  )
    return refuse();
  return resolve(value);
}

export async function resolveSqliteTokenRevokeContext(loadedApps: readonly LoadedApp[], configured: readonly ConnectionConfig[]) {
  try {
    if (loadedApps.length !== 1 || !loadedApps[0].app.auth) return refuse();
    const loaded = loadedApps[0],
      appId = loaded.app.id;
    const connections = captureTenantData(configured);
    if (!Array.isArray(connections) || connections.length > 128) return refuse();
    const ids = new Set<string>();
    for (const connection of connections) {
      if (
        typeof connection.id !== 'string' ||
        !connection.id ||
        ids.has(connection.id) ||
        typeof connection.name !== 'string' ||
        typeof connection.url !== 'string'
      )
        return refuse();
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
    const path = realpathSync(pathOnly(appAuthStore(loaded))),
      identity = file(path);
    const exclusions = connections.flatMap((connection) => {
      // Business connections expand both forms in resolveConnection, so they
      // are judged expanded the same way here: the filename captured is the
      // one runtime opens, and a URL named by reference (`${DATABASE_URL}`)
      // is read as what it names. Auth file paths deliberately keep bare
      // dollars literal in appAuthStore.
      const target = expandEnv(connection.url);
      if (connection.http) {
        if (!/^https?:\/\//i.test(target)) return refuse();
        return [];
      }
      if (/^(?:postgres(?:ql)?|mysql|mariadb):\/\//i.test(target)) return [];
      const excluded = captureAuthStoreExclusion(pathOnly(target));
      assertAuthStoreSeparation(path, excluded);
      return [excluded];
    });
    // LoadedApp/config are trusted invocation snapshots; this checks the actual
    // declared lock, not a partial imported-module/config provenance claim.
    const authority = loaded.authority ? { ...loaded.authority } : undefined;
    const lockPath = authority?.lockPath ?? join(dirname(loaded.path), AUTHORITY_LOCK);
    const currentLock = lock(lockPath);
    if (currentLock !== authority?.lock) return refuse();
    const checked = await checkAuthorityLock(authority, false);
    if (checked.problem || lock(lockPath) !== currentLock || JSON.stringify(file(path)) !== JSON.stringify(identity)) return refuse();
    for (const excluded of exclusions) assertAuthStoreSeparation(path, excluded);
    return Object.freeze({ path, appId, exclusions: Object.freeze(exclusions) });
  } catch {
    return refuse();
  }
}
