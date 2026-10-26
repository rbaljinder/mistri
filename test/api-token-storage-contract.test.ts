import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  captureStoredApiToken,
  decodeApiTokenSqlRow,
  encodeApiTokenSqlRow,
  planApiTokenRevocation,
} from '../packages/mistri/src/server/api/apiTokenStorageContract.js';
import {
  assertApiTokenDigest,
  assertApiTokenSecretId,
  mintApiTokenSecret,
  matchesApiTokenSecret,
} from '../packages/mistri/src/server/api/apiTokenSecret.js';

const id = '36c77f92-cf69-412d-ade3-3971490fb83a';
const token = () => ({
  format: 'twa1',
  digest: 'ab'.repeat(32),
  version: '9007199254740993',
  record: {
    id,
    appId: 'app',
    subject: { kind: 'account', id: 'account' },
    label: 'Automation',
    roles: ['writer', 'reader'],
    createdAt: 100,
    createdBy: 'operator',
    expiresAt: 8_640_000_000_000_000,
  },
});
const revoke = () => ({ tokenId: id, appId: 'app', expectedVersion: '9007199254740993', revokedAt: 200, revokedBy: 'operator' });
const opaque = (error: unknown) => {
  assert.ok(error instanceof TypeError);
  assert.equal(error.message, 'API token storage is unavailable.');
  return true;
};

test('token SQL codec preserves all facts, exact large revision and null versus empty narrowing', () => {
  for (const operations of [undefined, [], ['read:list', 'read:item']]) {
    const input = token();
    const stored = captureStoredApiToken({
      ...input,
      record: { ...input.record, ...(operations === undefined ? {} : { operations }), lastUsedAt: 150 },
    });
    const sql = encodeApiTokenSqlRow(stored),
      decoded = decodeApiTokenSqlRow(sql);
    assert.deepEqual(decoded, stored);
    assert.equal(decoded.version, '9007199254740993');
    assert.equal(sql.operations_json, operations === undefined ? null : JSON.stringify(operations));
    assert.equal(Object.hasOwn(decoded.record, 'operations'), operations !== undefined);
    assert.ok(Object.isFrozen(decoded));
    assert.ok(Object.isFrozen(decoded.record.roles));
    assert.ok(Object.isFrozen(sql));
    assert.deepEqual(decoded.record.roles, ['writer', 'reader'], 'do not silently reorder issued facts');
  }
  const revoked = { ...token(), record: { ...token().record, revokedAt: 200, revokedBy: 'operator', lastUsedAt: 300 } };
  assert.deepEqual(decodeApiTokenSqlRow(encodeApiTokenSqlRow(revoked)), captureStoredApiToken(revoked));
});

test('token storage captures Unicode bytes and rejects malformed exact SQL meanings', () => {
  const unicode = { ...token(), record: { ...token().record, label: '😀'.repeat(128), createdBy: 'é'.repeat(128) } };
  assert.deepEqual(decodeApiTokenSqlRow(encodeApiTokenSqlRow(unicode)), captureStoredApiToken(unicode));
  assert.throws(() => captureStoredApiToken({ ...unicode, record: { ...unicode.record, label: '😀'.repeat(129) } }), opaque);
  const sql = encodeApiTokenSqlRow(token());
  for (const patch of [
    { roles_json: '[ "writer", "reader" ]' },
    { roles_json: '["reader","reader"]' },
    { roles_json: '{}' },
    { operations_json: 'null' },
    { operations_json: '["x","x"]' },
    { operations_json: undefined },
    { revoked_at: 200 },
    { revoked_by: 'operator' },
    { expires_at: '8640000000000000' },
    { expires_at: 8_640_000_000_000_001 },
    { created_at: new Date(100) },
    { last_used_at: 99 },
    { version: '01' },
    { version: '1\n' },
    { version: 1 },
    { digest: 'secret' },
    { format: 'twa2' },
    { token_id: id.toUpperCase() },
    { extra: 'private' },
  ])
    assert.throws(() => decodeApiTokenSqlRow({ ...sql, ...patch }), opaque);
  const { label: _label, ...missing } = sql;
  assert.throws(() => decodeApiTokenSqlRow(missing), opaque);
});

test('revocation is terminal exact CAS and preserves actor and immutable issued facts', () => {
  const before = captureStoredApiToken(token()),
    plan = planApiTokenRevocation(before, revoke());
  assert.deepEqual(plan.where, { tokenId: id, appId: 'app', version: '9007199254740993', revokedAt: null });
  assert.equal(plan.next.version, '9007199254740994');
  assert.deepEqual(plan.next.record, { ...before.record, revokedAt: 200, revokedBy: 'operator' });
  assert.equal(plan.next.digest, before.digest);
  assert.deepEqual(plan.next.record.subject, before.record.subject);
  assert.ok(Object.isFrozen(plan.where));
  for (const patch of [
    { appId: 'other' },
    { tokenId: '21a53156-f274-4622-8a68-3f0b82c2c45a' },
    { expectedVersion: '9007199254740992' },
    { revokedAt: 99 },
    { revokedBy: ' operator' },
    { extra: true },
  ]) {
    assert.throws(() => planApiTokenRevocation(before, { ...revoke(), ...patch }), opaque);
  }
  assert.throws(() => planApiTokenRevocation(plan.next, { ...revoke(), expectedVersion: plan.next.version }), opaque);
  assert.throws(() => planApiTokenRevocation(null, revoke()), opaque);
  assert.throws(
    () => planApiTokenRevocation({ ...token(), version: '9'.repeat(128) }, { ...revoke(), expectedVersion: '9'.repeat(128) }),
    opaque,
  );
});

test('private shared credential validators keep canonical grammar and opaque failures', () => {
  assert.doesNotThrow(() => assertApiTokenSecretId(id));
  assert.doesNotThrow(() => assertApiTokenDigest('ab'.repeat(32)));
  for (const value of [id.toUpperCase(), `${id}\n`, id.replace('-4', '-5'), null, { toString: () => id }])
    assert.throws(() => assertApiTokenSecretId(value));
  for (const value of ['AB'.repeat(32), 'ab'.repeat(32) + '\n', 'g'.repeat(64), null]) assert.throws(() => assertApiTokenDigest(value));
  const minted = mintApiTokenSecret('app', id);
  assert.equal(matchesApiTokenSecret('app', id, minted.token, minted.digest), true);
  assert.equal(matchesApiTokenSecret('other', id, minted.token, minted.digest), false);
  assert.equal(matchesApiTokenSecret('app', id, minted.token, minted.digest + '\n'), false);
});

test('storage snapshot never executes user getters, proxies or conversion hooks', () => {
  let calls = 0;
  assert.throws(
    () =>
      captureStoredApiToken({
        ...token(),
        get digest() {
          calls++;
          return 'ab'.repeat(32);
        },
      }),
    opaque,
  );
  assert.throws(
    () =>
      decodeApiTokenSqlRow(
        new Proxy(encodeApiTokenSqlRow(token()), {
          get() {
            calls++;
            return '';
          },
        }),
      ),
    opaque,
  );
  assert.throws(
    () =>
      planApiTokenRevocation(token(), {
        ...revoke(),
        get revokedBy() {
          calls++;
          return 'operator';
        },
      }),
    opaque,
  );
  assert.equal(calls, 0);
  const input = token(),
    captured = captureStoredApiToken(input);
  input.record.roles.push('admin');
  assert.deepEqual(captured.record.roles, ['writer', 'reader']);
});
