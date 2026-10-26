/**
 * The browser suite's CI shards (scripts/e2e-shards.mjs): packed by recorded
 * time, so every spec of both lanes runs in exactly one shard, and the same
 * one every time.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lanes } from '../../scripts/e2e-lanes.mjs';
import { readTimings, shardSpecs } from '../../scripts/e2e-shards.mjs';

const SHARDS = 6;

test('the e2e shards cover every spec of both lanes exactly once', () => {
  const { owned, shared } = lanes();
  for (const [name, lane] of [
    ['owned', owned],
    ['shared', shared],
  ] as const) {
    /* A spec with no record rides along: it weighs the median and still lands somewhere. */
    const files = [...lane, 'e2e/never-recorded.spec.ts'];
    const pieces = Array.from({ length: SHARDS }, (_, at) => shardSpecs(files, at + 1, SHARDS)).flat();
    assert.deepEqual(pieces.sort(), [...files].sort(), `the ${name} lane's shards must cover it exactly once`);
  }
});

test('the e2e packing is deterministic and follows recorded time, not count', () => {
  const { owned } = lanes();
  const again = (index: number) => shardSpecs(owned, index, SHARDS);
  for (let index = 1; index <= SHARDS; index += 1) assert.deepEqual(again(index), again(index));
  const packed = [1, 2].map((index) => shardSpecs(['a', 'b', 'c', 'd'], index, 2, { a: 9, b: 1, c: 1, d: 1 }));
  assert.deepEqual(packed, [['a'], ['b', 'c', 'd']]);
});

test('every spec has a recorded time', () => {
  const { owned, shared } = lanes();
  const timings = readTimings();
  /* A new spec runs fine without one (it weighs the median); this says to record it. */
  assert.deepEqual(
    [...owned, ...shared].filter((file) => !(timings[file] > 0)),
    [],
    'run `npm run e2e -- --record-timings` to record these specs',
  );
});
