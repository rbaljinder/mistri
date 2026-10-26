import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildReadiness,
  buildSupportBundle,
  OperationsInputError,
  supportBundleJson,
} from '../packages/mistri/src/server/operations/operations.js';

const NOW = '2026-09-08T08:00:00.000Z';

test('readiness is scoped, deterministic and fails closed for non-ready checks', () => {
  const result = buildReadiness(
    'standalone',
    [
      { name: 'listener', state: 'ready', code: 'ok' },
      { name: 'primary-store', state: 'degraded', code: 'connection_unavailable' },
      { name: 'app-config', state: 'not_ready', code: 'configuration_invalid' },
    ],
    NOW,
  );
  assert.equal(result.ready, false);
  assert.equal(result.scope, 'standalone');
  assert.deepEqual(result.summary, { total: 3, ready: 1, degraded: 1, notReady: 1 });
  assert.deepEqual(result.checks[1], {
    name: 'primary-store',
    state: 'degraded',
    code: 'connection_unavailable',
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.checks), true);
});

test('empty readiness is ready and App scope remains explicit', () => {
  const result = buildReadiness('app', [], NOW);
  assert.equal(result.ready, true);
  assert.equal(result.scope, 'app');
  assert.deepEqual(result.summary, { total: 0, ready: 0, degraded: 0, notReady: 0 });
  assert.deepEqual(result.checks, []);
  assert.equal(Object.isFrozen(result.summary), true);
});

test('readiness rejects unbounded or ambiguous check declarations', () => {
  assert.throws(
    () => buildReadiness('standalone', [{ name: 'Connection / users', state: 'ready', code: 'ok' }], NOW),
    OperationsInputError,
  );
  assert.throws(
    () =>
      buildReadiness(
        'standalone',
        [
          { name: 'store', state: 'ready', code: 'ok' },
          { name: 'store', state: 'ready', code: 'ok' },
        ],
        NOW,
      ),
    OperationsInputError,
  );
  assert.throws(
    () =>
      buildReadiness(
        'standalone',
        Array.from({ length: 33 }, (_, i) => ({
          name: `check-${i}`,
          state: 'ready' as const,
          code: 'ok' as const,
        })),
        NOW,
      ),
    OperationsInputError,
  );
});

test('support bundle preserves only fixed diagnostics dimensions', () => {
  const bundle = buildSupportBundle({
    scope: 'app',
    generatedAt: NOW,
    checks: [{ name: 'app-load', state: 'ready', code: 'ok' }],
    metrics: {
      started: 3,
      completed: 2,
      aborted: 1,
      inFlight: 0,
      durationBoundsMs: [999],
      series: [
        {
          method: 'private-method' as never,
          route: '/api/query?password=secret' as never,
          statusClass: 'private' as never,
          count: 1,
          completed: 1,
          aborted: 0,
          durationBuckets: [1],
          invalidDurationTotal: 0,
        },
      ],
    },
  });
  const text = supportBundleJson(bundle);
  assert.equal(bundle.scope, 'app');
  assert.equal(bundle.metrics?.durationBoundsMs.length, 13);
  assert.equal(bundle.metrics?.series[0].method, 'OTHER');
  assert.equal(bundle.metrics?.series[0].route, 'unknown');
  assert.equal(bundle.metrics?.series[0].statusClass, 'unknown');
  assert.equal(bundle.metrics?.series[0].durationBuckets.length, 14);
  assert.ok(!text.includes('password'));
  assert.ok(!text.includes('secret'));
  assert.ok(!text.includes('private-method'));
  assert.equal(Object.isFrozen(bundle), true);
  assert.equal(Object.isFrozen(bundle.metrics?.series[0]), true);
});

test('support bundle has no diagnostic section unless explicitly supplied', () => {
  const bundle = buildSupportBundle({
    scope: 'standalone',
    checks: [{ name: 'listener', state: 'ready', code: 'ok' }],
    generatedAt: NOW,
  });
  assert.equal('metrics' in bundle, false);
  assert.ok(!supportBundleJson(bundle).includes('connection'));
});

test('serialization re-sanitizes a structurally forged bundle', () => {
  const forged = {
    event: 'mistri.support',
    version: 1,
    generatedAt: NOW,
    scope: 'standalone',
    readiness: {
      event: 'mistri.readiness',
      version: 1,
      generatedAt: NOW,
      scope: 'standalone',
      ready: true,
      checks: [{ name: 'listener', state: 'ready', code: 'ok' }],
    },
    metrics: {
      started: 1,
      completed: 1,
      aborted: 0,
      inFlight: 0,
      durationBoundsMs: [],
      series: [
        {
          method: 'GET',
          route: 'web',
          statusClass: '2xx',
          count: 1,
          completed: 1,
          aborted: 0,
          durationBuckets: [1],
          invalidDurationTotal: 0,
          leaked: 'secret',
        },
      ],
    },
  } as never;
  const json = supportBundleJson(forged);
  assert.ok(!json.includes('leaked'));
  assert.ok(!json.includes('secret'));
});

test('timestamps, scopes and serialized size are bounded', () => {
  assert.throws(() => buildSupportBundle({ scope: 'standalone', checks: [], generatedAt: 'not-a-date' }), OperationsInputError);
  assert.throws(() => buildSupportBundle({ scope: 'public' as never, checks: [], generatedAt: NOW }), OperationsInputError);
  const metrics = {
    started: Number.MAX_SAFE_INTEGER + 1,
    completed: -1,
    aborted: NaN,
    inFlight: Infinity,
    durationBoundsMs: [],
    series: Array.from({ length: 769 }, () => ({
      method: 'GET' as const,
      route: 'web' as const,
      statusClass: '2xx' as const,
      count: 1,
      completed: 1,
      aborted: 0,
      durationBuckets: [1],
      invalidDurationTotal: 0,
    })),
  };
  const bundle = buildSupportBundle({ scope: 'standalone', checks: [], metrics, generatedAt: NOW });
  assert.ok(supportBundleJson(bundle).length < 256_000);
});
