/** `--drain-delay` and `--shutdown-grace` (args.ts shutdownTimings): seconds in, milliseconds out, a sentence for what cannot be used. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SHUTDOWN_TIMINGS, parseArgs, shutdownTimings } from '../packages/engine/src/server/cli/args.js';

test("the defaults drain nothing and cut a stuck response at ten seconds, the whole of Cloud Run's stop window", () => {
  assert.deepEqual(shutdownTimings({}), { drainMs: 0, graceMs: 10_000 });
  assert.deepEqual(shutdownTimings({}), DEFAULT_SHUTDOWN_TIMINGS);
});

test('seconds are read, fractions allowed, and a value out of range is refused naming where it came from', () => {
  assert.deepEqual(shutdownTimings({ drainDelay: '5', shutdownGrace: '25.5' }), { drainMs: 5_000, graceMs: 25_500 });
  assert.deepEqual(shutdownTimings({ drainDelay: '0' }), { drainMs: 0, graceMs: 10_000 });
  for (const drainDelay of ['-1', 'soon', '', '121'])
    assert.match(shutdownTimings({ drainDelay }) as string, /--drain-delay takes seconds from 0 to 120.*MISTRI_DRAIN_DELAY/);
  for (const shutdownGrace of ['0', '301', 'x'])
    assert.match(shutdownTimings({ shutdownGrace }) as string, /--shutdown-grace takes seconds from 1 to 300.*MISTRI_SHUTDOWN_GRACE/);
});

test('the flags and the variables both set them, the flag winning', () => {
  const saved = { drain: process.env.MISTRI_DRAIN_DELAY, grace: process.env.MISTRI_SHUTDOWN_GRACE };
  process.env.MISTRI_DRAIN_DELAY = '4';
  process.env.MISTRI_SHUTDOWN_GRACE = '20';
  try {
    assert.deepEqual(shutdownTimings(parseArgs(['--db', 'x.db'])), { drainMs: 4_000, graceMs: 20_000 });
    assert.deepEqual(shutdownTimings(parseArgs(['--db', 'x.db', '--drain-delay', '1', '--shutdown-grace', '2'])), {
      drainMs: 1_000,
      graceMs: 2_000,
    });
  } finally {
    for (const [name, value] of [
      ['MISTRI_DRAIN_DELAY', saved.drain],
      ['MISTRI_SHUTDOWN_GRACE', saved.grace],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
