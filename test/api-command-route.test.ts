import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseApiCommandRoute } from '../packages/mistri/src/server/api/apiCommandRoute.js';

const invalid = { name: 'TypeError', message: 'Invalid App API command route.' };

test('the three command routes keep raw keys and actual positive versions', () => {
  assert.deepEqual(parseApiCommandRoute('/api/apps/Signal%20%E9%9B%AA/v2/lead/41/commands/convertLead/v3'), {
    kind: 'one',
    method: 'POST',
    appId: 'Signal 雪',
    version: 2,
    resource: 'lead',
    rawKey: '41',
    command: 'convertLead',
    commandVersion: 3,
  });
  // Composite delimiters and encoded separators reach the key codec unchanged.
  for (const rawKey of ['a%2Fb', 'id=42,name=A%2CB%3DC%25', '%252F', 'commands']) {
    const route = parseApiCommandRoute(`/api/apps/app/v1/lead/${rawKey}/commands/close/v1`);
    assert.equal(route.kind === 'one' && route.rawKey, rawKey);
  }
  assert.deepEqual(parseApiCommandRoute('/api/apps/app/v1/catalog.lead/commands/close-many/v1'), {
    kind: 'many',
    method: 'POST',
    appId: 'app',
    version: 1,
    resource: 'catalog.lead',
    command: 'close-many',
    commandVersion: 1,
  });
  assert.deepEqual(parseApiCommandRoute('/api/apps/app/v1/commands/close/v2/receipts/owner-attempt-0000001'), {
    kind: 'recover',
    method: 'GET',
    appId: 'app',
    version: 1,
    command: 'close',
    commandVersion: 2,
    idempotencyKey: 'owner-attempt-0000001',
  });
  assert.ok(Object.isFrozen(parseApiCommandRoute('/api/apps/app/v1/lead/1/commands/close/v1')));
});

test('aliases, encodings, reserved names, queries and wrong shapes refuse', () => {
  for (const path of [
    '/api/apps/app/v1/lead/1/commands/close/v1?x=1',
    '/api/apps/app/v1/lead/1/commands/close/v1#x',
    '/api/apps/app/v1/lead/1/commands/cl%6Fse/v1',
    '/api/apps/app/v1/lead/1/commands/constructor/v1',
    '/api/apps/app/v1/lead/1/commands/_close/v1',
    '/api/apps/app/v1/lead/1/commands/close/v01',
    '/api/apps/app/v1/lead/1/commands/close/v0',
    '/api/apps/app/v1/lead/1/commands/close/v9007199254740992',
    '/api/apps/app/v1/lead/1/commands/close',
    '/api/apps/app/v1/lead/1/commands/close/v1/',
    '/api/apps/app/v1/lead/1/command/close/v1',
    '/api/apps/app/v1/lead/%2e/commands/close/v1',
    '/api/apps/app/v1/lead/../commands/close/v1',
    '/api/apps/app/v1/lead//commands/close/v1',
    '/api/apps/app/v1/views/commands/close/v1',
    '/api/apps/app/v1/constructor/commands/close/v1',
    '/api/apps/app/v1/le%61d/commands/close/v1',
    '/api/apps/a%2Fb/v1/lead/commands/close/v1',
    '/api/apps/app/v1/commands/close/v1/receipts/short',
    '/api/apps/app/v1/commands/close/v1/receipts/owner-attempt-00000%31',
    '/api/apps/app/v1/commands/close/v1/receipt/owner-attempt-0000001',
    '/api/apps/app/v1/commands/close/v1',
    '/api/apps/app/v1/commands/close/v1/receipts/owner-attempt-0000001/x',
    `/api/apps/app/v1/lead/${'a'.repeat(8193)}/commands/close/v1`,
    '/api/apps/app/v1/lead/%ED%A0%80/commands/close/v1',
    '/api/apps/app/v1/lead/part=a%00,id=1/commands/close/v1',
    '//host/api/apps/app/v1/lead/1/commands/close/v1',
    'https://h/api/apps/app/v1/lead/1/commands/close/v1',
  ])
    assert.throws(() => parseApiCommandRoute(path), invalid, path);
  assert.throws(
    () =>
      parseApiCommandRoute({
        toString() {
          throw new Error('coercion');
        },
      }),
    invalid,
  );
});

test('preparation is a read-only exact-key route without extra input channels', () => {
  const path = '/api/apps/app/v1/lead/41/commands/close/v2/prepare';
  assert.deepEqual(parseApiCommandRoute(path), {
    kind: 'prepare',
    method: 'GET',
    appId: 'app',
    version: 1,
    resource: 'lead',
    rawKey: '41',
    command: 'close',
    commandVersion: 2,
  });
  for (const suffix of ['/', '?x=1', '/extra']) assert.throws(() => parseApiCommandRoute(path + suffix), invalid);
});
