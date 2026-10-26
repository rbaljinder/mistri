/**
 * Where the built server keeps V8's compile cache (`module.enableCompileCache`).
 *
 * Under the user's cache directory rather than Node's default of the OS temp
 * directory: the temp directory is emptied on reboot on some systems and is
 * shared on others, and the cache is only worth having if the next start finds
 * it. `NODE_COMPILE_CACHE` names another place, and
 * `NODE_DISABLE_COMPILE_CACHE` turns it off, as they do for Node itself.
 * Entries are keyed by file content and V8 version, so two installed versions
 * never read each other's.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { product } from './product.js';

export function compileCacheDirectory(env: NodeJS.ProcessEnv): string | undefined {
  if (env.NODE_DISABLE_COMPILE_CACHE) return undefined;
  if (env.NODE_COMPILE_CACHE) return env.NODE_COMPILE_CACHE;
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, product(), 'compile');
  let home: string;
  try {
    home = homedir();
  } catch {
    return undefined;
  }
  return home ? join(home, '.cache', product(), 'compile') : undefined;
}
