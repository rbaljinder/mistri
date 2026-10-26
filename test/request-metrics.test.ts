import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RequestMetrics,
  REQUEST_DURATION_BOUNDS_MS,
  REQUEST_METHODS,
  REQUEST_ROUTES,
  REQUEST_STATUS_CLASSES,
} from '../packages/engine/src/server/operations/requestMetrics.js';

test('empty metrics are finite and request lifetimes settle once', () => {
  const metrics = new RequestMetrics();
  assert.deepEqual(metrics.snapshot(), {
    started: 0,
    completed: 0,
    aborted: 0,
    inFlight: 0,
    durationBoundsMs: REQUEST_DURATION_BOUNDS_MS,
    series: [],
  });
  const finish = metrics.begin('POST', 'api.update');
  const abort = metrics.begin('GET', 'api.query');
  assert.equal(metrics.snapshot().inFlight, 2);
  finish(200, 10, 'completed');
  finish(500, 1_000, 'aborted');
  assert.equal(metrics.snapshot().inFlight, 1);
  abort(null, 5, 'aborted');
  abort(200, 5, 'completed');
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.started, 2);
  assert.equal(snapshot.completed, 1);
  assert.equal(snapshot.aborted, 1);
  assert.equal(snapshot.inFlight, 0);
  assert.equal(
    snapshot.series.reduce((sum, series) => sum + series.count, 0),
    2,
  );
  assert.equal(metrics.revision, 4);
});

test('duration buckets have exact inclusive boundaries and a finite overflow slot', () => {
  const metrics = new RequestMetrics();
  const record = (duration: number) => metrics.begin('GET', 'api.query')(200, duration, 'completed');
  record(0);
  for (const bound of REQUEST_DURATION_BOUNDS_MS) {
    record(bound);
    record(bound + 0.001);
  }
  record(Number.MAX_VALUE);
  const series = metrics.snapshot().series[0];
  assert.deepEqual(series.durationBuckets, Array(REQUEST_DURATION_BOUNDS_MS.length + 1).fill(2));
  assert.equal(
    series.count,
    series.durationBuckets.reduce((sum, count) => sum + count, 0),
  );
  assert.ok(REQUEST_DURATION_BOUNDS_MS.every(Number.isFinite));
});

test('invalid durations are counted explicitly without inventing latency samples', () => {
  const metrics = new RequestMetrics();
  for (const duration of [NaN, Infinity, -Infinity, -1]) metrics.begin('GET', 'web')(200, duration, 'completed');
  const series = metrics.snapshot().series[0];
  assert.equal(series.count, 4);
  assert.equal(series.invalidDurationTotal, 4);
  assert.ok(series.durationBuckets.every((count) => count === 0));
  assert.ok(!JSON.stringify(metrics.snapshot()).includes('null'));
});

test('statuses use only emitted HTTP classes and unknown; aborts retain sent status classes', () => {
  const metrics = new RequestMetrics();
  for (const status of [100, 199, 200, 299, 300, 399, 400, 499, 500, 599]) {
    metrics.begin('GET', 'web')(status, 5, 'completed');
  }
  for (const status of [null, 99, 600, 200.5, NaN, Infinity]) metrics.begin('GET', 'web')(status, 5, 'aborted');
  metrics.begin('GET', 'web')(200, 5, 'aborted');
  const series = metrics.snapshot().series;
  assert.deepEqual(
    series.map((row) => row.statusClass),
    REQUEST_STATUS_CLASSES,
  );
  assert.deepEqual(
    series.map((row) => row.count),
    [2, 3, 2, 2, 2, 6],
  );
  assert.equal(series[1].completed, 2);
  assert.equal(series[1].aborted, 1);
  assert.equal(series[5].aborted, 6);
});

test('private and adversarial labels collapse without entering snapshots', () => {
  const metrics = new RequestMetrics();
  for (let i = 0; i < 2_000; i += 1) {
    metrics.begin(`private-method-${i}`, `/api/query?password=private-${i}`)(200, 1, 'completed');
  }
  for (const value of ['__proto__', 'constructor', 'get', 'GET ', 'api.query?private']) {
    metrics.begin(value, value)(200, 1, 'completed');
  }
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.series.length, 1);
  assert.equal(snapshot.series[0].method, 'OTHER');
  assert.equal(snapshot.series[0].route, 'unknown');
  assert.equal(snapshot.series[0].count, 2_005);
  assert.ok(!JSON.stringify(snapshot).includes('private'));
});

test('the complete dimension product stays bounded and sorts independently of arrival order', () => {
  const metrics = new RequestMetrics();
  const reverse = new RequestMetrics();
  const combinations = REQUEST_METHODS.flatMap((method) =>
    REQUEST_ROUTES.flatMap((route) => [100, 200, 300, 400, 500, null].map((status) => ({ method, route, status }))),
  );
  for (const { method, route, status } of combinations) metrics.begin(method, route)(status, 1, 'completed');
  for (const { method, route, status } of combinations.reverse()) reverse.begin(method, route)(status, 1, 'completed');
  metrics.begin('secret', 'secret')(null, 1, 'completed');
  reverse.begin('OTHER', 'unknown')(null, 1, 'completed');
  assert.deepEqual(metrics.snapshot(), reverse.snapshot());
  assert.equal(metrics.snapshot().series.length, 768);
  assert.ok(JSON.stringify(metrics.snapshot()).length < 256_000);
});

test('snapshots and nested arrays are frozen detached values', () => {
  const metrics = new RequestMetrics();
  metrics.begin('GET', 'web')(200, 1, 'completed');
  const old = metrics.snapshot();
  const json = JSON.stringify(old);
  for (const value of [old, old.durationBoundsMs, old.series, old.series[0], old.series[0].durationBuckets]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.equal(Reflect.set(old.series[0].durationBuckets, '0', 900), false);
  assert.equal(Reflect.set(old.series[0], 'method', 'private'), false);
  metrics.begin('GET', 'web')(200, 1, 'completed');
  assert.equal(JSON.stringify(old), json);
  assert.equal(metrics.snapshot().series[0].count, 2);
});
