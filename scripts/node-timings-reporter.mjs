/**
 * A reporter for `node scripts/test-node.mjs --record-timings`: the seconds
 * each test file's top-level tests took, summed, as one JSON object keyed by
 * the file's path from the repository root. What `--shard` packs by.
 */
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export default async function* timings(source) {
  const seconds = {};
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const { nesting, file, details } = event.data;
    if (nesting !== 0 || !file || typeof details?.duration_ms !== 'number') continue;
    const key = relative(ROOT, file).split('\\').join('/');
    seconds[key] = (seconds[key] ?? 0) + details.duration_ms / 1000;
  }
  yield `${JSON.stringify(Object.fromEntries(Object.entries(seconds).map(([file, time]) => [file, Math.round(time * 10) / 10])))}\n`;
}
