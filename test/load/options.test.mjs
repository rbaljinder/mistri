import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOptions } from './options.mjs';

test('safe defaults and smoke overrides are independent of flag order', () => {
  const defaults = parseOptions([]);
  assert.equal(defaults.users, 4);
  assert.equal(defaults.duration, 15);
  assert.equal(defaults.browserUsers, 1);
  assert.equal(defaults.rows, 500);
  assert.equal(parseOptions(['--smoke']).duration, 5);
  assert.equal(parseOptions(['--smoke']).warmup, 1);
  assert.equal(parseOptions(['--users', '2', '--smoke']).users, 2);
  assert.deepEqual(parseOptions(['--duration', '2', '--smoke']), parseOptions(['--smoke', '--duration', '2']));
});

test('custom targets, extra flags and duplicate flags are refused', () => {
  for (const args of [
    ['--url', 'https://example.test'],
    ['http://127.0.0.1:4111'],
    ['--port', '4111'],
    ['--config', '/tmp/config.json'],
    ['--host', '127.0.0.1'],
    ['--db', 'thread.db'],
    ['--production', '--production'],
    ['--users=2'],
    ['--smoke', '--smoke'],
    ['--users', '1', '--users', '2'],
    ['--help', '--url', 'https://example.test'],
  ]) {
    assert.throws(() => parseOptions(args), /Unsupported|Duplicate/);
  }
});

test('production is explicit and retains every workload and safety option', () => {
  assert.equal(parseOptions([]).production, false);
  assert.deepEqual(parseOptions(['--production', '--smoke']), { ...parseOptions(['--smoke']), production: true });
  assert.throws(() => parseOptions(['--production', '--url', 'http://localhost']), /Unsupported/);
});

test('all workload controls reject out-of-bound or noncanonical numbers', () => {
  for (const [flag, min, max] of [
    ['--users', 1, 32],
    ['--browser-users', 1, 4],
    ['--duration', 1, 300],
    ['--warmup', 1, 60],
    ['--rows', 24, 10000],
    ['--think-ms', 10, 5000],
    ['--arrival-rps', 1, 100],
    ['--request-timeout-ms', 100, 30000],
    ['--ui-timeout-ms', 500, 30000],
    ['--http-p95-ms', 1, 60000],
    ['--ui-p95-ms', 1, 120000],
  ]) {
    for (const value of [String(min - 1), String(max + 1), 'NaN', 'Infinity', '1e2', '0x10', ' 4', '4.2', '01', '-1', '']) {
      assert.throws(() => parseOptions([flag, value]), /requires/, `${flag}: ${value}`);
    }
    assert.doesNotThrow(() => parseOptions([flag, String(min)]));
    assert.doesNotThrow(() => parseOptions([flag, String(max)]));
    assert.throws(() => parseOptions([flag]), /requires/);
  }
  assert.equal(parseOptions(['--max-error-rate', '0.05']).maxErrorRate, 0.05);
  assert.throws(() => parseOptions(['--max-error-rate', '1.01']), /requires/);
});

test('CLI module imports without seeding, starting a server, or registering signals', async () => {
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  const imported = await import('./run.mjs');
  assert.equal(typeof imported.main, 'function');
  assert.deepEqual([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], before);
});
