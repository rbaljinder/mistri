import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createOperationsAdapter,
  OperationsAdapterError,
  type OperationsGrant,
} from '../packages/mistri/src/server/operations/operationsAdapter.js';

const NOW = 1_000;
const sourceId = 'local';
const caller = { kind: 'standalone' as const, id: 'local-operator', sourceId };
const grant = (action: 'readiness' | 'support', scope: 'standalone' | 'app' = 'standalone'): OperationsGrant => ({
  audience: 'mistri.operations',
  action,
  scope,
  sourceId,
  expiresAt: NOW + 10_000,
});

test('adapter binds the fixed scope, authorizes the action, and declares no-store', async () => {
  const seen: string[] = [];
  const adapter = createOperationsAdapter({
    scope: 'standalone',
    sourceId,
    now: () => NOW,
    authorize: (request) => {
      seen.push(`${request.scope}:${request.action}:${request.caller.id}`);
      return grant(request.action);
    },
    collect: (context) => ({
      checks: [{ name: 'listener', state: 'ready', code: 'ok' }],
      metrics: context.action === 'support' ? undefined : undefined,
    }),
  });
  const result = await adapter.readiness(caller);
  assert.deepEqual(seen, ['standalone:readiness:local-operator']);
  assert.equal(result.cacheControl, 'no-store');
  assert.equal(result.scope, 'standalone');
  assert.equal(result.value.ready, true);
  assert.equal(Object.isFrozen(result), true);
});

test('caller scope mismatch is refused before authorization or collection', async () => {
  let authorized = false;
  let collected = false;
  const adapter = createOperationsAdapter({
    scope: 'app',
    sourceId,
    now: () => NOW,
    authorize: () => {
      authorized = true;
      return grant('support', 'app');
    },
    collect: () => {
      collected = true;
      return { checks: [] };
    },
  });
  await assert.rejects(
    adapter.support({ kind: 'standalone', id: 'wrong-surface', sourceId }),
    (error) => error instanceof OperationsAdapterError && error.code === 'invalid_caller',
  );
  assert.equal(authorized, false);
  assert.equal(collected, false);
});

test('denied, mismatched, and expired grants do not expose collector errors or output', async () => {
  const cases: Array<[string, OperationsGrant | null]> = [
    ['denied', null],
    ['wrong action', grant('readiness')],
    ['wrong scope', grant('support', 'app')],
    ['expired', { ...grant('support'), expiresAt: NOW }],
  ];
  for (const [label, supplied] of cases) {
    const adapter = createOperationsAdapter({
      scope: 'standalone',
      sourceId,
      now: () => NOW,
      authorize: () => supplied,
      collect: () => {
        throw new Error(`private ${label} collector detail`);
      },
    });
    await assert.rejects(adapter.support(caller), (error) => {
      if (!(error instanceof OperationsAdapterError)) return false;
      return label === 'expired' ? error.code === 'grant_expired' : error.code === 'grant_invalid';
    });
  }
});

test('authorization and collection failures are safe and support is sanitized', async () => {
  const authFailure = createOperationsAdapter({
    scope: 'standalone',
    sourceId,
    now: () => NOW,
    authorize: () => {
      throw new Error('cookie/password/private path');
    },
    collect: () => ({ checks: [] }),
  });
  await assert.rejects(
    authFailure.readiness(caller),
    (error) => error instanceof OperationsAdapterError && error.code === 'not_authorized' && !String(error).includes('private'),
  );

  const adapter = createOperationsAdapter({
    scope: 'standalone',
    sourceId,
    now: () => NOW,
    authorize: (request) => grant(request.action),
    collect: () => ({
      checks: [{ name: 'listener', state: 'ready', code: 'ok' }],
      metrics: {
        started: 1,
        completed: 1,
        aborted: 0,
        inFlight: 0,
        durationBoundsMs: [],
        series: [],
      },
    }),
  });
  const result = await adapter.support(caller);
  assert.equal(result.value.event, 'mistri.support');
  assert.equal(result.value.scope, 'standalone');
  assert.equal(result.value.metrics?.started, 1);
  assert.equal(Object.isFrozen(result.value), true);
});

test('grant expiry is checked after a slow collector', async () => {
  let now = NOW;
  const adapter = createOperationsAdapter({
    scope: 'standalone',
    sourceId,
    now: () => now,
    authorize: () => grant('support'),
    collect: () => {
      now = NOW + 20_000;
      return { checks: [] };
    },
  });
  await assert.rejects(adapter.support(caller), (error) => error instanceof OperationsAdapterError && error.code === 'grant_expired');
});
