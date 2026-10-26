import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createHeadlessOperationsReader,
  HeadlessOperationsInputError,
} from '../packages/mistri/src/server/operations/operationsHeadless.js';
import { OperationsAdapterError, type OperationsAdapter } from '../packages/mistri/src/server/operations/operationsAdapter.js';

const NOW = '2026-09-08T08:00:00.000Z';
const sourceId = 'ignition';
const caller = { kind: 'app' as const, id: 'ignition', sourceId };

function adapter(overrides: Partial<OperationsAdapter> = {}): OperationsAdapter {
  return {
    scope: 'app',
    sourceId,
    readiness: async () => ({
      value: {
        event: 'mistri.readiness',
        version: 1,
        generatedAt: NOW,
        scope: 'app',
        ready: true,
        checks: [{ name: 'listener', state: 'ready', code: 'ok' }],
      },
      action: 'readiness',
      scope: 'app',
      sourceId,
      cacheControl: 'no-store',
    }),
    support: async () => ({
      value: {
        event: 'mistri.support',
        version: 1,
        generatedAt: NOW,
        scope: 'app',
        readiness: {
          event: 'mistri.readiness',
          version: 1,
          generatedAt: NOW,
          scope: 'app',
          ready: true,
          checks: [{ name: 'listener', state: 'ready', code: 'ok' }],
        },
      },
      action: 'support',
      scope: 'app',
      sourceId,
      cacheControl: 'no-store',
    }),
    ...overrides,
  } as OperationsAdapter;
}

test('headless reader delegates only the bounded readiness/support contract', async () => {
  const calls: string[] = [];
  const reader = createHeadlessOperationsReader(
    adapter({
      readiness: async (value) => {
        calls.push(`readiness:${value.id}`);
        return adapter().readiness(value);
      },
      support: async (value) => {
        calls.push(`support:${value.id}`);
        return adapter().support(value);
      },
    }),
  );
  const readiness = await reader.read({ action: 'readiness', caller });
  const support = await reader.read({ action: 'support', caller });
  assert.equal(readiness.ok, true);
  if (readiness.ok && readiness.action === 'readiness') assert.equal(readiness.value.summary.total, 1);
  assert.equal(support.ok, true);
  if (support.ok && support.action === 'support') assert.equal(support.value.readiness.summary.ready, 1);
  assert.deepEqual(calls, ['readiness:ignition', 'support:ignition']);
  assert.equal(Object.isFrozen(readiness), true);
});

test('invalid requests fail closed without invoking the adapter', async () => {
  let calls = 0;
  const reader = createHeadlessOperationsReader(
    adapter({
      readiness: async (value) => {
        calls++;
        return adapter().readiness(value);
      },
      support: async (value) => {
        calls++;
        return adapter().support(value);
      },
    }),
  );
  for (const input of [
    null,
    {},
    { action: 'write', caller },
    { action: 'readiness', caller: { kind: 'standalone', id: 'x', sourceId } },
    { action: 'support', caller: { kind: 'app', id: '', sourceId } },
    { action: 'support', caller, extra: true },
  ]) {
    const result = await reader.read(input);
    assert.deepEqual(result, { ok: false, cacheControl: 'no-store', error: 'invalid_request' });
  }
  assert.equal(calls, 0);
});

test('authorization failures are reduced to safe failure codes', async () => {
  const reader = createHeadlessOperationsReader(
    adapter({
      readiness: async () => {
        throw new Error('secret grant details');
      },
      support: async () => {
        throw new Error('secret collector details');
      },
    }),
  );
  assert.deepEqual(await reader.read({ action: 'readiness', caller }), {
    ok: false,
    cacheControl: 'no-store',
    error: 'unavailable',
  });
  const denied = createHeadlessOperationsReader(
    adapter({
      readiness: async () => {
        throw new OperationsAdapterError('not_authorized');
      },
    }),
  );
  assert.deepEqual(await denied.read({ action: 'readiness', caller }), {
    ok: false,
    cacheControl: 'no-store',
    error: 'not_authorized',
  });
});

test('malformed adapter output is sanitized or refused without leaking fields', async () => {
  const reader = createHeadlessOperationsReader(
    adapter({
      readiness: async () =>
        ({
          value: {
            event: 'mistri.readiness',
            version: 1,
            generatedAt: NOW,
            scope: 'app',
            ready: true,
            checks: [{ name: 'listener', state: 'ready', code: 'ok' }],
            leaked: 'secret',
          },
          action: 'readiness',
          scope: 'app',
          sourceId,
          cacheControl: 'no-store',
          leaked: 'secret',
        }) as never,
    }),
  );
  const result = await reader.read({ action: 'readiness', caller });
  assert.equal(result.ok, true);
  if (result.ok && result.action === 'readiness') assert.equal('leaked' in result.value, false);
  const malformed = createHeadlessOperationsReader(
    adapter({
      support: async () => ({ value: { secret: 'payload' }, action: 'support', scope: 'app', sourceId, cacheControl: 'no-store' }) as never,
    }),
  );
  assert.deepEqual(await malformed.read({ action: 'support', caller }), {
    ok: false,
    cacheControl: 'no-store',
    error: 'unavailable',
  });
});

test('invalid adapters are rejected at construction and cannot become an auth bypass', () => {
  assert.throws(() => createHeadlessOperationsReader({} as OperationsAdapter), HeadlessOperationsInputError);
  assert.throws(
    () =>
      createHeadlessOperationsReader({
        ...adapter(),
        scope: 'public',
      } as unknown as OperationsAdapter),
    HeadlessOperationsInputError,
  );
});
