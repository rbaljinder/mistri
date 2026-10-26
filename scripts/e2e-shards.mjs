/**
 * Which browser specs a CI shard runs: each lane's spec files packed into
 * shards by recorded time, the way `scripts/test-node.mjs` packs its files.
 *
 * Playwright's own `--shard` splits by test count, and a spec's tests are not
 * alike (one file's twenty tests ran longer than another's sixty), so six
 * shards ran 11 to 39 minutes. `test/e2e-timings.json` holds each spec's
 * recorded seconds — the sum of its tests' durations plus a fixed startup
 * estimate — and `npm run e2e -- --record-timings` refreshes it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseHeadStart, shard } from './test-node.mjs';

export { parseHeadStart };

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const TIMINGS = join(ROOT, 'test', 'e2e-timings.json');

/** What a spec costs beyond its tests: a browser context, and for an owned
 * spec its own server. Added at recording time, so the file holds the weight. */
export const STARTUP_SECONDS = 5;

export function readTimings() {
  try {
    return JSON.parse(readFileSync(TIMINGS, 'utf8'));
  } catch {
    return {};
  }
}

/** The specs of one lane that shard `index` of `total` runs. A spec with no
 * record weighs the lane's median, so a new spec still lands somewhere.
 * Every shard computes the same packing from the same file, so the shards
 * cover the lane exactly once. */
export function shardSpecs(files, index, total, timings = readTimings(), headStart = []) {
  return shard(files, index, total, timings, headStart);
}
