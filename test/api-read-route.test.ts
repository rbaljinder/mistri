import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseApiReadRoute } from '../packages/mistri/src/server/api/apiReadRoute.js';

test('read routes retain raw query/key and actual positive API versions', () => {
  assert.deepEqual(parseApiReadRoute('/api/apps/Signal%20%E9%9B%AA/v23/person?app=other&appId=x&sort=-name'), {
    appId: 'Signal 雪',
    version: 23,
    operationId: 'list:person',
    rawQuery: 'app=other&appId=x&sort=-name',
  });
  assert.deepEqual(parseApiReadRoute('/api/apps/app/v1/views/open-items?limit=2'), {
    appId: 'app',
    version: 1,
    operationId: 'view:open-items',
    rawQuery: 'limit=2',
  });
  for (const rawKey of ['a%2Fb', 'a%5Cb', 'id=42,name=A%2CB%3DC%25', '%252F', '%3F', '%23']) {
    assert.deepEqual(parseApiReadRoute(`/api/apps/app/v1/person/${rawKey}`), {
      appId: 'app',
      version: 1,
      operationId: 'item:person',
      rawQuery: '',
      rawKey,
    });
  }
  assert.equal(parseApiReadRoute('/api/apps/app/v1/catalog.person').operationId, 'list:catalog.person');
});

test('structural aliases, reserved namespaces and URL normalization are refused', () => {
  for (const path of [
    'https://host/api/apps/app/v1/person',
    '//host/api/apps/app/v1/person',
    '/api/apps/a%2Fb/v1/person',
    '/api/apps/%61pp/v1/person',
    '/api/apps/app/v1/per%73on',
    '/api/apps/app/v1/person%2F1',
    '/api/apps/app/v1/views/a%2Fb',
    '/api/apps/app/v1/commands',
    '/api/apps/app/v1/views',
    '/api/apps/app/v1/person/',
    '/api/apps/app/v1/person/../x',
    '/api/apps/app/v1/person/%2e',
    '/api/apps/app/v1/person/.%2E',
    '/api/apps/app/v1/person/a\\b',
    '/api/apps/app/v01/person',
    '/api/apps/app/v0/person',
    '/api/apps/app/v9007199254740992/person',
    '/api/apps/app/v1/constructor',
    '/api/apps/app/v1/person/1?limit=2',
    '/api/apps/app/v1/person#x',
  ]) {
    assert.throws(() => parseApiReadRoute(path), { name: 'TypeError', message: 'Invalid App API read route.' }, path);
  }
});

test('malformed encoding, duplicate decoded query names and excessive input refuse', () => {
  for (const suffix of [
    '?app=a&%61pp=b',
    '?appId=a&appId=b',
    '?x=%FF',
    '?x=%',
    '?x=%00',
    '?x=1&&y=2',
    '?x',
    '?=x',
    '?x=1#fragment',
    '/' + '%ED%A0%80',
    '/' + 'a'.repeat(8193),
    '?' + Array.from({ length: 65 }, (_, i) => `x${i}=1`).join('&'),
    '?x=' + 'a'.repeat(16385),
  ]) {
    assert.throws(() => parseApiReadRoute('/api/apps/app/v1/person' + suffix));
  }
  assert.throws(() =>
    parseApiReadRoute({
      toString() {
        throw new Error('coercion');
      },
    }),
  );
  assert.ok(Object.isFrozen(parseApiReadRoute('/api/apps/app/v1/person')));
});
