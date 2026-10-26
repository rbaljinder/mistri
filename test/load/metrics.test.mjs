import test from 'node:test';
import assert from 'node:assert/strict';
import { collector, record, summarize, percentile, evaluateGates, markdownReport } from './metrics.mjs';
import { parseOptions } from './options.mjs';

test('nearest-rank percentiles sort numerically and never invent empty samples', () => {
  const values = [100, 2, 10, 1];
  assert.equal(percentile(values, 0.5), 2);
  assert.equal(percentile(values, 0.95), 100);
  assert.equal(percentile([], 0.99), null);
  assert.deepEqual(values, [100, 2, 10, 1]);
  assert.throws(() => percentile([NaN], 0.5));
});

test('throughput uses completions and actual elapsed; failed latencies stay separate and errors are bounded', () => {
  const target = collector();
  record(target, 'list', 0, 10);
  record(target, 'count', 1, 20);
  for (let i = 0; i < 30; i++) record(target, 'list', 0, 900, new Error('x'.repeat(4000)));
  const metric = summarize(target, 2500);
  assert.equal(metric.completedPerSecond, 0.8);
  assert.equal(metric.attempts, 32);
  assert.equal(metric.errors, 30);
  assert.equal(metric.errorRate, 30 / 32);
  assert.equal(metric.latencyMs.p95, 20);
  assert.equal(metric.errorSamples.length, 20);
  assert.equal(metric.errorSamples[0].message.length, 1500);
  assert.deepEqual(metric.byUser, { 0: 31, 1: 1 });
  assert.deepEqual(metric.byOperation, { list: 31, count: 1 });
  assert.equal(metric.durations, undefined);
  assert.throws(() => summarize(target, 0));
});

function measured() {
  const http = collector(),
    browser = collector();
  record(http, 'list', 0, 1000);
  record(browser, 'journey', 0, 5000);
  return { http: summarize(http, 1000), browser: summarize(browser, 1000), browserEvents: { errors: 0 } };
}

test('gates accept boundaries, reject empty/failed/missing users and browser errors', () => {
  const options = parseOptions(['--smoke']);
  assert.equal(evaluateGates(measured(), options).passed, true);
  const slow = measured();
  slow.http.latencyMs.p95 = 1000.01;
  assert.equal(evaluateGates(slow, options).passed, false);
  const failed = measured();
  failed.http.errorRate = 0.1;
  assert.equal(evaluateGates(failed, options).passed, false);
  assert.equal(evaluateGates(failed, { ...options, maxErrorRate: 0.1 }).passed, true);
  const empty = measured();
  empty.browser = summarize(collector(), 1000);
  assert.equal(evaluateGates(empty, { ...options, maxErrorRate: 1 }).passed, false);
  assert.equal(evaluateGates(measured(), { ...options, browserUsers: 2 }).passed, false);
  const event = measured();
  event.browserEvents.errors = 1;
  assert.equal(evaluateGates(event, { ...options, maxErrorRate: 1 }).passed, false);
  const retired = measured();
  retired.retiredBrowserUsers = [0];
  assert.equal(evaluateGates(retired, { ...options, maxErrorRate: 1 }).passed, false);
});

test('Markdown includes source context, actual duration and endpoint latency', () => {
  const phase = { ...measured(), elapsedMs: 1250, windowSeconds: 1, endpoints: { '/api/run': measured().http } };
  const text = markdownReport({
    status: 'passed',
    mode: 'source-dev-vite',
    runId: 'test',
    options: parseOptions(['--smoke']),
    machine: { node: 'v24' },
    git: { head: 'abc', dirty: true },
    measured: phase,
  });
  assert.match(text, /not production capacity/);
  assert.match(text, /not INP/);
  assert.match(text, /1.250s actual elapsed/);
  assert.match(text, /\/api\/run/);
});

test('arrival gates require every offered slot, not every concurrency slot, even with permissive errors', () => {
  const options = { ...parseOptions(['--smoke']), users: 4, arrivalRps: 1, maxErrorRate: 1 };
  const phase = {
    ...measured(),
    windowSeconds: 1,
    arrivals: { rate: 1, scheduled: 1, admitted: 1, droppedBusy: 0, droppedLate: 0, cancelled: 0 },
  };
  assert.equal(evaluateGates(phase, options).passed, true);
  for (const key of ['droppedBusy', 'droppedLate', 'cancelled']) {
    assert.equal(evaluateGates({ ...phase, arrivals: { ...phase.arrivals, [key]: 1 } }, options).passed, false);
  }
  assert.equal(evaluateGates({ ...phase, arrivals: undefined }, options).passed, false);
  assert.equal(evaluateGates({ ...phase, arrivals: { ...phase.arrivals, admitted: 0 } }, options).passed, false);
});
