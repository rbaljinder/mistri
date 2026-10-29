/** File identity captured without depending on auth owners. */
import { realpathSync, statSync } from 'node:fs';
import type { Registry } from '@mistriwork/engine/server/connections.js';

export interface AuthStoreExclusion {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

export function captureAuthStoreExclusion(path: string): AuthStoreExclusion {
  const canonical = realpathSync(path),
    info = statSync(canonical);
  if (!info.isFile())
    throw new Error('Authentication storage must remain separate from the captured business database and its SQLite sidecars.');
  return Object.freeze({ path: canonical, device: info.dev, inode: info.ino });
}

/**
 * Capture each SQLite business file before a suite App opens its auth store.
 * The registry resolves references through its captured environment, exactly
 * as opening the connection does; the caller must fence every result.
 */
export function sqliteAuthExclusions(registry: Registry): AuthStoreExclusion[] {
  const exclusions = [];
  // The URLs are read in one pass with no await: an update between captures could
  // otherwise retarget an already-visited connection without an exclusion.
  for (const url of registry.openableUrls()) {
    if (/^postgres(ql)?:\/\//i.test(url)) continue;
    const file = /^sqlite:/i.test(url) ? url.replace(/^sqlite:(\/\/)?/i, '') : url;
    // Unknown remote schemes must not be mistaken for a safe local file.
    if (!file || file.includes('://')) throw new Error('Cannot capture a SQLite business file for authentication separation.');
    exclusions.push(captureAuthStoreExclusion(file));
  }
  return exclusions;
}
