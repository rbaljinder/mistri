/**
 * A reporter for `node scripts/test-node.mjs`, to stderr beside the spec
 * reporter on stdout: one line when a test file starts and one when it ends,
 * with how long it took. A file that never ends is then the last `start` with
 * no `done` after it, which a log of only the failures cannot say.
 *
 * The runner hands events over file by file, in order, so the clock here is not
 * the file's: the duration is the one the runner measured (the file-level
 * entry's `duration_ms`), and a `start` may be read a moment after the file
 * began. test-node.mjs does not rely on these lines to name what hangs — it
 * asks the process table, which does not wait on an earlier file.
 */
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const shown = (file) => relative(ROOT, file).split('\\').join('/');

export default async function* progress(source) {
  for await (const event of source) {
    const { name, file, details, nesting } = event.data ?? {};
    /* The file-level entry is the one named by its own path, as it was given on
       the command line; its tests carry the same `file` and a title. */
    if (!file || nesting !== 0 || typeof name !== 'string' || resolve(name) !== file) continue;
    if (event.type === 'test:dequeue') yield `# start ${shown(file)}\n`;
    else if (event.type === 'test:complete') {
      const seconds = typeof details?.duration_ms === 'number' ? ` ${(details.duration_ms / 1000).toFixed(1)}s` : '';
      yield `# done  ${shown(file)}${seconds}${details?.passed === false ? ' (failed)' : ''}\n`;
    }
  }
}
