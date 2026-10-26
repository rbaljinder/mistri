import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCipheriv, randomBytes } from 'node:crypto';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { checkApiReadCatalog } from '../packages/mistri/src/server/api/apiReadCatalog.js';
import { createApiReadCursorCodec } from '../packages/mistri/src/server/api/apiReadCursor.js';
import { snapshot } from '../packages/engine/src/adapters/commands/canonicalJson.js';

function fixture(key = randomBytes(32)) {
  const schema: DatabaseSchema = {
    label: 'Local',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'item',
        name: 'item',
        schema: '',
        isView: false,
        columns: [
          { name: 'id', type: 'INTEGER', primaryKey: true, nullable: false },
          { name: 'name', type: 'TEXT', primaryKey: false, nullable: false },
        ],
      },
    ],
  };
  const app = parseAppConfig(
    {
      id: 'app',
      name: 'App',
      resources: { item: {} },
      auth: { roles: { reader: { read: true } } },
      home: 'items',
      views: { items: { kind: 'list', from: 'item' } },
      api: { version: 1, roles: ['reader'], resources: { item: { fields: ['id', 'name'], sorts: ['name'] } } },
    },
    'test',
  );
  const operation = checkApiReadCatalog(app.api!, app, schema).operations.find((operation) => operation.kind === 'list')!;
  const order = [
    { column: 'name', direction: 'asc' as const },
    { column: 'id', direction: 'asc' as const },
  ];
  const options = { integers: 'decimal-string' as const };
  const codec = createApiReadCursorCodec(key, operation, schema, order, options);
  const binding = {
    appId: 'app',
    apiVersion: 1,
    operationId: operation.id,
    scopeFingerprint: 'scope-v1',
    queryFingerprint: 'query-v1',
    orderFingerprint: 'order-v1',
    integers: 'decimal-string',
  };
  const boundary = { id: '9007199254740993', name: 'PRIVATE-雪😀,=%/' };
  return { key, codec, binding, boundary, operation, schema, order, options };
}
const unavailable = (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'API read cursor is unavailable.');
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return true;
};

test('encrypted typed boundaries retain exact digits and Unicode, with fresh nonces and captured keys', () => {
  const f = fixture(),
    original = Buffer.from(f.key);
  const one = f.codec.seal(f.binding, f.boundary, 1000, 2000),
    two = f.codec.seal(f.binding, f.boundary, 1000, 2000);
  assert.notEqual(one, two);
  assert.ok(one.length <= 4096);
  assert.ok(!one.includes('PRIVATE') && !Buffer.from(one.slice(5), 'base64url').includes(Buffer.from('PRIVATE')));
  f.key.fill(0);
  const opened = f.codec.open(one, f.binding, 1500);
  assert.deepEqual({ ...opened.boundary }, f.boundary);
  assert.ok(Object.isFrozen(opened.boundary));
  assert.equal(opened.authorization, 'pending');
  assert.deepEqual(fixture(original).codec.open(one, f.binding, 1500), opened);
  assert.throws(() => fixture().codec.open(one, f.binding, 1500), unavailable);
});

test('tampering, every wrong binding and exact lifetime boundaries refuse uniformly', () => {
  const f = fixture(),
    token = f.codec.seal(f.binding, f.boundary, 1000, 2000);
  for (const key of Object.keys(f.binding)) {
    const binding = { ...f.binding, [key]: key === 'apiVersion' ? 2 : 'different' };
    assert.throws(() => f.codec.open(token, binding, 1500), unavailable);
  }
  assert.throws(() => f.codec.open(token, { ...f.binding, extra: true }, 1500), unavailable);
  for (const now of [999, 2000, NaN, Infinity, 1.5]) assert.throws(() => f.codec.open(token, f.binding, now), unavailable);
  assert.ok(f.codec.open(token, f.binding, 1000));
  const bytes = Buffer.from(token.slice(5), 'base64url');
  for (const index of [0, 12, bytes.length - 1]) {
    const changed = Buffer.from(bytes);
    changed[index] ^= 1;
    assert.throws(() => f.codec.open('twc1.' + changed.toString('base64url'), f.binding, 1500), unavailable);
  }
  for (const bad of [token + '=', 'twc2.' + token.slice(5), token.slice(0, -1), 'x'.repeat(4097), {}, null]) {
    assert.throws(() => f.codec.open(bad, f.binding, 1500), unavailable);
  }
});

test('seal refuses extra/invalid/oversized boundary data and never runs input gadgets', () => {
  const f = fixture();
  let calls = 0;
  for (const boundary of [
    { ...f.boundary, extra: 'secret' },
    { name: 'x' },
    { ...f.boundary, id: '01' },
    { ...f.boundary, name: 'x'.repeat(3001) },
    {
      ...f.boundary,
      get name() {
        calls++;
        return 'x';
      },
    },
    {
      ...f.boundary,
      toJSON() {
        calls++;
        return {};
      },
    },
  ]) {
    assert.throws(() => f.codec.seal(f.binding, boundary, 1000, 2000), unavailable);
  }
  assert.throws(
    () =>
      f.codec.seal(
        {
          ...f.binding,
          get appId() {
            calls++;
            return 'app';
          },
        },
        f.boundary,
        1000,
        2000,
      ),
    unavailable,
  );
  for (const expires of [1000, 999, Infinity]) assert.throws(() => f.codec.seal(f.binding, f.boundary, 1000, expires), unavailable);
  const key = Buffer.alloc(32);
  Object.defineProperty(key, 'extra', {
    get() {
      calls++;
      return 1;
    },
  });
  for (const bad of [
    key,
    new Proxy(Buffer.alloc(32), {}),
    Buffer.alloc(31),
    {
      valueOf() {
        calls++;
        return Buffer.alloc(32);
      },
    },
  ]) {
    assert.throws(() => createApiReadCursorCodec(bad, f.operation, f.schema, f.order, f.options), unavailable);
  }
  assert.equal(calls, 0);
});

test('even authenticated malformed or noncanonical payloads refuse after decryption', () => {
  const f = fixture();
  const encrypt = (plain: Buffer, domain = 'mistri:api-read-cursor:twc1') => {
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', f.key, nonce, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(domain));
    const bytes = Buffer.concat([cipher.update(plain), cipher.final()]);
    return 'twc1.' + Buffer.concat([nonce, bytes, cipher.getAuthTag()]).toString('base64url');
  };
  for (const raw of ['{}', '{"__proto__":{}}', '{"x":1,"x":2}', ' {"x":1}', Buffer.from([0xff]), 'x'.repeat(3001)]) {
    assert.throws(() => f.codec.open(encrypt(Buffer.isBuffer(raw) ? raw : Buffer.from(raw)), f.binding, 1500), unavailable);
  }
  assert.throws(() => f.codec.open(encrypt(Buffer.from('{}'), 'another-domain'), f.binding, 1500), unavailable);
  const valid = snapshot({ binding: f.binding, boundary: f.boundary, issuedAt: 1000, expiresAt: 2000 }, 3000).json;
  assert.ok(f.codec.open(encrypt(Buffer.from(valid)), f.binding, 1500));
  const prefixed = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(valid)]);
  assert.throws(() => f.codec.open(encrypt(prefixed), f.binding, 1500), unavailable);
});
