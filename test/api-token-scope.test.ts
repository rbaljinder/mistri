import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { captureApiTokenRecord, narrowApiTokenScope } from '../packages/mistri/src/server/api/apiTokenScope.js';

function fixture() {
  const app = parseAppConfig(
    {
      id: 'app',
      name: 'App',
      resources: { item: {} },
      auth: { roles: { reader: { read: true }, other: { read: true }, retired: { read: true } } },
      home: 'items',
      views: { items: { kind: 'list', from: 'item' } },
      api: { version: 1, roles: ['reader', 'other'], resources: { item: { fields: ['id'] } } },
    },
    'test',
  );
  const token = {
    id: 'token-one',
    appId: 'app',
    subject: { kind: 'account', id: 'account-one' },
    label: 'Integration',
    roles: ['reader', 'other', 'retired'],
    createdAt: 1000,
    createdBy: 'issuer',
    expiresAt: 5000,
  };
  const current = { appId: 'app', subject: token.subject, eligible: true, roles: ['reader'] };
  const operations = [
    { id: 'list:item', eligibleRoles: ['reader'] },
    { id: 'item:item', eligibleRoles: ['other'] },
  ];
  return {
    app,
    token,
    current,
    operations,
    run: (raw: unknown = token, now = 2000) => narrowApiTokenScope(raw, app, current, operations, now),
  };
}

test('issued, current and API roles only intersect; whole-operation eligibility is never combined', () => {
  const f = fixture(),
    result = f.run();
  assert.deepEqual(result.roles, ['reader']);
  assert.deepEqual(result.operations, ['list:item']);
  assert.equal(result.authorization, 'pending');
  assert.equal(result.credentialVerification, 'pending');
  f.current.roles = ['other'];
  assert.deepEqual(f.run().operations, ['item:item']);
  f.current.roles = [];
  assert.throws(() => f.run(), /unavailable/);
});

test('missing operations adds no narrowing; explicit empty never authorizes anything', () => {
  const f = fixture();
  assert.deepEqual(f.run({ ...f.token, operations: [] }).operations, []);
  assert.deepEqual(f.run({ ...f.token, operations: ['item:item'] }).operations, []);
  assert.deepEqual(f.run({ ...f.token, operations: ['retired-operation'] }).operations, []);
  assert.deepEqual(f.run().operations, ['list:item']);
  f.operations.length = 0;
  assert.deepEqual(f.run().operations, []);
});

test('rotation changes token identity but not stable account subject; capture is immutable', () => {
  const f = fixture(),
    first = f.run(),
    next = f.run({ ...f.token, id: 'rotated' });
  assert.notEqual(first.tokenId, next.tokenId);
  assert.deepEqual(first.subject, next.subject);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.subject) && Object.isFrozen(first.roles) && Object.isFrozen(first.operations));
  f.token.subject.id = 'other';
  f.current.roles.push('other');
  assert.equal(first.subject.id, 'account-one');
  assert.deepEqual(first.roles, ['reader']);
});

test('fresh account eligibility, App binding, expiry and terminal revocation fail closed', () => {
  for (const change of [
    { appId: 'elsewhere' },
    { subject: { kind: 'account', id: 'other' } },
    { revokedAt: 3000, revokedBy: 'admin' },
    { subject: { kind: 'service', id: 'worker' } },
  ]) {
    const f = fixture();
    assert.throws(() => f.run({ ...f.token, ...change }), /unavailable/);
  }
  const f = fixture();
  for (const now of [999, 5000, NaN, Infinity, 1.5]) assert.throws(() => f.run(f.token, now));
  f.current.eligible = false;
  assert.throws(() => f.run());
  f.current.eligible = true;
  f.current.appId = 'other';
  assert.throws(() => f.run());
});

test('hostile records and partial revocation never execute getters or disclose credential data', () => {
  const f = fixture();
  let reads = 0;
  for (const raw of [
    {
      ...f.token,
      get roles() {
        reads++;
        return ['reader'];
      },
    },
    { ...f.token, roles: ['reader', 'reader'] },
    { ...f.token, operations: ['x', 'x'] },
    { ...f.token, revokedAt: 2000 },
    { ...f.token, revokedBy: 'admin' },
    { ...f.token, expiresAt: 1000 },
    { ...f.token, createdAt: -1 },
    { ...f.token, lastUsedAt: 999 },
    { ...f.token, digest: 'DO-NOT-DISCLOSE' },
    { ...f.token, secret: 'DO-NOT-DISCLOSE' },
  ]) {
    assert.throws(
      () => captureApiTokenRecord(raw),
      (error) => error instanceof Error && !error.message.includes('DO-NOT-DISCLOSE'),
    );
  }
  assert.equal(reads, 0);
  const roles = ['reader'];
  roles.length = 2;
  assert.throws(() => captureApiTokenRecord({ ...f.token, roles }));
});

test('identity strings cannot collapse through UTF8 replacement and lifetime policy stays outside capture', () => {
  const f = fixture();
  for (const value of ['bad\ud800', 'bad\udfff']) {
    for (const changed of [
      { id: value },
      { appId: value },
      { subject: { kind: 'account', id: value } },
      { roles: [value] },
      { operations: [value] },
      { createdBy: value },
      { label: value },
    ]) {
      assert.throws(() => captureApiTokenRecord({ ...f.token, ...changed }));
    }
  }
  assert.equal(captureApiTokenRecord({ ...f.token, id: 'valid-😀', expiresAt: 1000 + 367 * 86400000 }).id, 'valid-😀');
});

test('current catalog must be bounded and exact; no subject or role fallback exists', () => {
  const f = fixture();
  assert.throws(() => narrowApiTokenScope(f.token, f.app, { ...f.current, extra: true }, f.operations, 2000));
  assert.throws(() => narrowApiTokenScope(f.token, f.app, f.current, [...f.operations, f.operations[0]], 2000));
  assert.throws(() => narrowApiTokenScope(f.token, f.app, f.current, [{ id: 'x', eligibleRoles: ['unknown'] }], 2000));
  f.current.roles = ['reader', 'other'];
  assert.deepEqual(narrowApiTokenScope(f.token, f.app, f.current, [{ id: 'x', eligibleRoles: [] }], 2000).operations, []);
  const service = { kind: 'service', id: 'worker' };
  assert.throws(() => narrowApiTokenScope({ ...f.token, subject: service }, f.app, { ...f.current, subject: service }, f.operations, 2000));
});

test('native account and actor IDs retain their full exact UTF16 bound without normalization', () => {
  const f = fixture();
  for (const id of ['x'.repeat(1024), '雪'.repeat(1024), '😀'.repeat(512)]) {
    const record = captureApiTokenRecord({ ...f.token, subject: { kind: 'account', id }, createdBy: id, revokedAt: 2000, revokedBy: id });
    assert.equal(record.subject.id, id);
    assert.equal(record.createdBy, id);
    assert.equal(record.revokedBy, id);
    assert.equal(
      narrowApiTokenScope(
        { ...f.token, subject: { kind: 'account', id } },
        f.app,
        { ...f.current, subject: { kind: 'account', id } },
        f.operations,
        2000,
      ).subject.id,
      id,
    );
  }
  for (const id of ['x'.repeat(1025), '雪'.repeat(1025), '😀'.repeat(513), ' bad', 'bad\ud800']) {
    assert.throws(() => captureApiTokenRecord({ ...f.token, subject: { kind: 'account', id } }));
    assert.throws(() => captureApiTokenRecord({ ...f.token, createdBy: id }));
    assert.throws(() => captureApiTokenRecord({ ...f.token, revokedAt: 2000, revokedBy: id }));
  }
});

test("a role the App maps from claims never rides a token: it is the provider's, for the provider's sessions only", () => {
  const app = parseAppConfig(
    {
      id: 'app',
      name: 'App',
      resources: { item: {} },
      auth: {
        providers: ['email', 'oidc:workforce'],
        roles: { reader: { read: true }, steward: { read: true, claims: { groups: ['stewards'] } } },
      },
      home: 'items',
      views: { items: { kind: 'list', from: 'item' } },
      api: { version: 1, roles: ['reader', 'steward'], resources: { item: { fields: ['id'] } } },
    },
    'test',
  );
  const token = {
    id: 'token-one',
    appId: 'app',
    subject: { kind: 'account', id: 'account-one' },
    label: 'Integration',
    roles: ['reader', 'steward'],
    createdAt: 1000,
    createdBy: 'issuer',
    expiresAt: 5000,
  };
  const operations = [
    { id: 'list:item', eligibleRoles: ['reader'] },
    { id: 'item:item', eligibleRoles: ['steward'] },
  ];
  // The account's stored role still says steward (the provider's last sign-in gave it); the token does not.
  const scope = narrowApiTokenScope(
    token,
    app,
    { appId: 'app', subject: token.subject, eligible: true, roles: ['reader', 'steward'] },
    operations,
    2000,
  );
  assert.deepEqual(scope.roles, ['reader']);
  assert.deepEqual(scope.operations, ['list:item']);
  assert.throws(
    () =>
      narrowApiTokenScope(
        { ...token, roles: ['steward'] },
        app,
        { appId: 'app', subject: token.subject, eligible: true, roles: ['steward'] },
        operations,
        2000,
      ),
    /unavailable/,
  );
});
