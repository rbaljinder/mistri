import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readApiBearerHeader } from '../packages/mistri/src/server/api/apiBearerHeader.js';
import { mintApiTokenSecret } from '../packages/mistri/src/server/api/apiTokenSecret.js';

const tokenId = '12345678-1234-4abc-8def-123456789abc';
const { token } = mintApiTokenSecret('app', tokenId);
function denied(headers: unknown) {
  assert.throws(
    () => readApiBearerHeader(headers),
    (error) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, 'An unambiguous API bearer credential is required.');
      assert.equal(Object.hasOwn(error, 'cause'), false);
      return true;
    },
  );
}

test('extracts one case-insensitive bearer scheme without authenticating it', () => {
  const parsed = readApiBearerHeader(['Host', 'example.test', 'aUtHoRiZaTiOn', `bEaReR ${token}`, 'Cookie', 'session=ignored']);
  assert.deepEqual(parsed, { tokenId, credential: token });
  assert.ok(Object.isFrozen(parsed));
});

test('duplicate raw fields, joined values and alternate credential sources refuse', () => {
  for (const headers of [
    [],
    ['Cookie', `session=${token}`],
    ['X-API-Key', token],
    ['Authorization', `Bearer ${token}`, 'authorization', `Bearer ${token}`],
    ['Authorization', '', 'Authorization', `Bearer ${token}`],
  ])
    denied(headers);
  for (const value of [
    `Bearer ${token}, Bearer ${token}`,
    `Bearer  ${token}`,
    `Bearer\t${token}`,
    ` Bearer ${token}`,
    `Bearer ${token} `,
    `Basic ${token}`,
    token,
    `Bearer ${token}\r\nX: private`,
  ])
    denied(['Authorization', value]);
});

test('hostile, malformed and excessive header arrays never invoke input getters', () => {
  let calls = 0;
  const trap = () => {
    calls++;
    throw new Error('PRIVATE_INPUT');
  };
  const sparse = Array(2);
  sparse[0] = 'Authorization';
  for (const headers of [
    null,
    {},
    ['Authorization'],
    sparse,
    ['Bad Header', 'x'],
    ['Authorization', `Bearer ${token}`, 'X-Header\n', 'x'],
    ['Host', null],
    Array(514).fill('x'),
    ['X-Long', 'x'.repeat(65536)],
    new Proxy([], { ownKeys: trap, get: trap }),
    Object.defineProperty([], '0', { get: trap, enumerable: true }),
  ])
    denied(headers);
  assert.equal(calls, 0);
});
