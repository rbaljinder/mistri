/**
 * The one rule for a path a config file writes: it is the file's folder's. One typed on the command line (--db,
 * --app, --config) is the working directory's, and so is a value from the environment. Kept apart from
 * connections.ts so the testing entry, which copies a config's databases, reads it without the registry.
 */
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A SQLite target as a config file wrote it, said from that file's folder: `./shop.db`, `sqlite:shop.db` and
 * `file:./shop.db` beside the config open that file wherever tablewalk was started — a check run from an App's folder
 * (`--config ../tablewalk.json`) opened a new, empty `./shop.db` there instead. An absolute path, a server URL and a
 * target with no folder to read it from are left as written.
 */
export function sqliteTargetFrom(url: string, base: string | undefined): string {
  if (!base || !url || url === ':memory:' || url.includes('$')) return url;
  if (/^file:/i.test(url)) {
    let file: string;
    try {
      file = /^file:\/\//i.test(url) ? fileURLToPath(url) : decodeURIComponent(url.slice('file:'.length).split('?')[0]);
    } catch {
      return url;
    }
    return isAbsolute(file) ? file : resolve(base, file);
  }
  if (/^sqlite:/i.test(url)) {
    const file = url.replace(/^sqlite:(\/\/)?/i, '');
    return !file || file === ':memory:' || isAbsolute(file) ? url : `sqlite:${resolve(base, file)}`;
  }
  if (url.includes('://')) return url;
  return isAbsolute(url) ? url : resolve(base, url);
}
