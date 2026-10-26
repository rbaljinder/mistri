import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as codec from '../packages/mistri/src/server/tenant/tenantInvitationToken.js';
import {
  invitationTokenId,
  matchesInvitationToken,
  mintInvitationToken,
} from '../packages/mistri/src/server/tenant/tenantInvitationToken.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import type { TenantStoreBinding } from '../packages/mistri/src/server/tenant/tenantStore.js';

const id = '12345678-1234-4abc-8def-123456789abc';
const otherId = '12345678-1234-4abc-9def-123456789abc';
const account = 'native-account';
const binding = () => ({ appId: 'app', storeId: 'store', source: { id: 'business', connection: 'alias' } });
// Deterministic parser examples are not minted secrets or usable invitation records.
const sample = `twi1.${id}.${'A'.repeat(43)}`;
const denied = (work: () => unknown) =>
  assert.throws(work, (error: unknown) => {
    assert.ok(error instanceof TenantContextError);
    assert.equal(error.code, 'tenant_context_unavailable');
    assert.equal(error.message, 'The tenant context could not be verified.');
    assert.equal('cause' in error, false);
    return true;
  });

test('exports only the three invitation codec functions', () => {
  assert.deepEqual(Object.keys(codec).sort(), ['invitationTokenId', 'matchesInvitationToken', 'mintInvitationToken']);
});

test('mints frozen handoffs with 32 random bytes and fixed-length lowercase SHA256 digests', () => {
  const tokens = new Set<string>(),
    digests = new Set<string>();
  for (let index = 0; index < 128; index++) {
    const result = mintInvitationToken(binding(), id, account);
    assert.ok(Object.isFrozen(result));
    assert.deepEqual(Object.keys(result).sort(), ['digest', 'token']);
    assert.equal(result.token.length, 85);
    assert.equal(invitationTokenId(result.token), id);
    const secret = result.token.slice(42),
      bytes = Buffer.from(secret, 'base64url');
    assert.equal(bytes.length, 32);
    assert.ok(/^[A-Za-z0-9_-]{43}$/.test(secret));
    assert.ok(bytes.toString('base64url') === secret);
    assert.ok(bytes.some((byte) => byte !== 0));
    assert.ok(/^[0-9a-f]{64}$/.test(result.digest));
    assert.equal(Buffer.from(result.digest, 'hex').length, 32);
    assert.ok(matchesInvitationToken(binding(), id, account, result.token, result.digest));
    tokens.add(result.token);
    digests.add(result.digest);
  }
  assert.equal(tokens.size, 128);
  assert.equal(digests.size, 128);
});

test('accepts separately generated randomUUID invitation IDs', () => {
  for (let index = 0; index < 16; index++) {
    const generatedId = randomUUID(),
      result = mintInvitationToken(binding(), generatedId, account);
    assert.equal(invitationTokenId(result.token), generatedId);
    assert.ok(matchesInvitationToken(binding(), generatedId, account, result.token, result.digest));
  }
});

test('strict parsing rejects format, version, separator, whitespace and base64 aliases', () => {
  assert.equal(invitationTokenId(sample), id);
  const malformed = [
    '',
    'twi1',
    sample.slice(1),
    sample.slice(0, -1),
    `${sample}A`,
    `${sample}=`,
    ` ${sample}`,
    `${sample} `,
    `${sample}\n`,
    `${sample}\r\n`,
    `${sample}\0`,
    sample.replace('twi1', 'TWI1'),
    sample.replace('twi1', 'twi2'),
    sample.replace('twi1', 'twi01'),
    sample.replace('.', ':'),
    sample.replace(`${id}.`, `${id}:`),
    `${sample}.extra`,
    `twi1.${id}.${'A'.repeat(42)}+`,
    `twi1.${id}.${'A'.repeat(42)}/`,
    `twi1.${id}.${'A'.repeat(42)}=`,
    `twi1.${id}.${'A'.repeat(42)}\n`,
    `twi1.${id}.${'A'.repeat(42)}\0`,
    `twi1.${id}.${'A'.repeat(42)}é`,
    `twi1.${id}.${'A'.repeat(42)}\uD800`,
    `twi1.${id}.${'A'.repeat(42)}\uDC00`,
    sample.replace('.', '%2E'),
    sample.repeat(1000),
  ];
  for (const token of malformed) {
    denied(() => invitationTokenId(token));
    assert.equal(matchesInvitationToken(binding(), id, account, token, '0'.repeat(64)), false);
  }
});

test('rejects every nonzero unused base64 padding-bit combination', () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  for (let index = 0; index < alphabet.length; index++) {
    const token = `twi1.${id}.${'A'.repeat(42)}${alphabet[index]}`;
    if (index % 4 === 0) assert.equal(invitationTokenId(token), id);
    else denied(() => invitationTokenId(token));
  }
});

test('canonical UUIDv4 parsing rejects case, padding, other versions and invalid variants', () => {
  for (const invalidId of [
    '',
    id.toUpperCase(),
    id.replaceAll('-', ''),
    `{${id}}`,
    `urn:uuid:${id}`,
    ` ${id}`,
    `${id} `,
    `${id}\n`,
    id.replace('4abc', '1abc'),
    id.replace('4abc', '7abc'),
    id.replace('8def', '7def'),
    id.replace('8def', 'cdef'),
    id.replace('12345678', 'g2345678'),
    '00000000-0000-0000-0000-000000000000',
  ]) {
    denied(() => mintInvitationToken(binding(), invalidId, account));
    denied(() => invitationTokenId(`twi1.${invalidId}.${'A'.repeat(43)}`));
    assert.equal(matchesInvitationToken(binding(), invalidId, account, sample, '0'.repeat(64)), false);
  }
});

test('digest isolates each stable namespace field, recipient and invitation', () => {
  const owner = binding(),
    result = mintInvitationToken(owner, id, account);
  for (const foreign of [
    { ...owner, appId: 'App' },
    { ...owner, storeId: 'Store' },
    { ...owner, source: { ...owner.source, id: 'Business' } },
  ]) {
    assert.equal(matchesInvitationToken(foreign, id, account, result.token, result.digest), false);
  }
  assert.equal(matchesInvitationToken(owner, id, 'Native-account', result.token, result.digest), false);
  assert.equal(matchesInvitationToken(owner, otherId, account, result.token, result.digest), false);
  assert.equal(matchesInvitationToken(owner, otherId, account, result.token.replace(id, otherId), result.digest), false);
  const fresh = mintInvitationToken(owner, id, account);
  assert.equal(matchesInvitationToken(owner, id, account, fresh.token, result.digest), false);
});

test('digest uses domain-separated SHA256 with unambiguous namespace and identity framing', () => {
  const owner = binding(),
    result = mintInvitationToken(owner, id, account);
  const tuple = ['mistri:tenant-invitation-token:twi1', owner.appId, owner.storeId, owner.source.id, id, account, result.token.slice(42)];
  assert.ok(createHash('sha256').update(JSON.stringify(tuple)).digest('hex') === result.digest);
  const alternateDomain = ['mistri:tenant-invitation-token:twi2', ...tuple.slice(1)];
  for (const input of [result.token, result.token.slice(42), JSON.stringify(tuple.slice(1)), JSON.stringify(alternateDomain)]) {
    const digest = createHash('sha256').update(input).digest('hex');
    assert.equal(matchesInvitationToken(owner, id, account, result.token, digest), false);
  }
  for (const [left, right] of [
    [
      { ...owner, appId: 'a:b', storeId: 'c' },
      { ...owner, appId: 'a', storeId: 'b:c' },
    ],
    [
      { ...owner, appId: 'ab', storeId: 'c' },
      { ...owner, appId: 'a', storeId: 'bc' },
    ],
    [
      { ...owner, appId: 'a","b', storeId: 'c' },
      { ...owner, appId: 'a', storeId: 'b","c' },
    ],
  ]) {
    const issued = mintInvitationToken(left, id, account);
    assert.equal(matchesInvitationToken(right, id, account, issued.token, issued.digest), false);
  }
});

test('connection aliases and property order do not change durable meaning', () => {
  const result = mintInvitationToken(binding(), id, account);
  const alias = { source: { connection: 'new-connection', id: 'business' }, storeId: 'store', appId: 'app' };
  assert.ok(matchesInvitationToken(alias, id, account, result.token, result.digest));
  const nullPrototype = Object.assign(Object.create(null), alias, { source: Object.assign(Object.create(null), alias.source) });
  assert.ok(matchesInvitationToken(nullPrototype, id, account, result.token, result.digest));
});

test('binding capture and matching neither mutate nor freeze caller data', () => {
  const owner = binding(),
    before = structuredClone(owner);
  const result = mintInvitationToken(owner, id, account);
  assert.ok(matchesInvitationToken(owner, id, account, result.token, result.digest));
  assert.deepEqual(owner, before);
  assert.equal(Object.isFrozen(owner), false);
  assert.equal(Object.isFrozen(owner.source), false);
  owner.appId = 'changed';
  owner.source.id = 'changed';
  assert.ok(matchesInvitationToken(before, id, account, result.token, result.digest));
  assert.equal(matchesInvitationToken(owner, id, account, result.token, result.digest), false);
  assert.equal(Reflect.set(result, 'token', sample), false);
  assert.equal(Reflect.set(result, 'digest', '0'.repeat(64)), false);
  const frozen = Object.freeze({ ...before, source: Object.freeze(before.source) });
  assert.ok(matchesInvitationToken(frozen, id, account, result.token, result.digest));
});

test('digests must be exactly 64 lowercase hex characters and never use prefix comparison', () => {
  const result = mintInvitationToken(binding(), id, account);
  for (const digest of [
    '',
    result.digest.slice(0, -1),
    result.digest.slice(0, -2),
    `${result.digest}00`,
    result.digest.toUpperCase(),
    `${result.digest}\n`,
    ` ${result.digest}`,
    `${result.digest}\0`,
    `0x${result.digest}`,
    'g'.repeat(64),
    'é'.repeat(64),
    '0'.repeat(10000),
  ]) {
    assert.equal(matchesInvitationToken(binding(), id, account, result.token, digest), false);
  }
  for (let index = 0; index < 64; index++) {
    const digest = result.digest.slice(0, index) + (result.digest[index] === '0' ? '1' : '0') + result.digest.slice(index + 1);
    assert.equal(matchesInvitationToken(binding(), id, account, result.token, digest), false);
  }
});

test('requires all and only the binding and source data fields', () => {
  const result = mintInvitationToken(binding(), id, account);
  const malformed: unknown[] = [];
  for (const key of ['appId', 'storeId', 'source']) {
    const missing: Record<string, unknown> = { ...binding() };
    delete missing[key];
    malformed.push(missing, { ...binding(), [key]: undefined });
  }
  for (const key of ['id', 'connection']) {
    const missing: Record<string, unknown> = { ...binding().source };
    delete missing[key];
    malformed.push({ ...binding(), source: missing }, { ...binding(), source: { ...binding().source, [key]: undefined } });
  }
  for (const key of ['extra', 'deployment', 'then', 'toJSON', '__proto__']) {
    malformed.push({ ...binding(), [key]: 'extra' }, { ...binding(), source: { ...binding().source, [key]: 'extra' } });
  }
  malformed.push(
    { ...binding(), [Symbol('hidden')]: true },
    { ...binding(), source: { ...binding().source, [Symbol('hidden')]: true } },
    Object.defineProperty(binding(), 'appId', { enumerable: false }),
    { ...binding(), source: Object.defineProperty(binding().source, 'connection', { enumerable: false }) },
    Object.create(binding()),
    { ...binding(), source: Object.create(binding().source) },
  );
  for (const input of malformed) {
    denied(() => mintInvitationToken(input as TenantStoreBinding, id, account));
    assert.equal(matchesInvitationToken(input as TenantStoreBinding, id, account, result.token, result.digest), false);
  }
});

test('identifiers reject invalid text, malformed Unicode and excessive UTF8 bytes', () => {
  const result = mintInvitationToken(binding(), id, account);
  const fields = ['appId', 'storeId', 'id', 'connection', 'accountId'] as const;
  for (const field of fields) {
    const maximum = field === 'accountId' || field === 'connection' ? 1024 : 256;
    for (const value of [
      '',
      ' padded',
      'padded ',
      'a\0b',
      'a\nb',
      'a\u007Fb',
      'a\u0085b',
      '\uD800',
      '\uDC00',
      'a\uD800b',
      'a\uDC00b',
      'x'.repeat(maximum + 1),
      'é'.repeat(maximum),
    ]) {
      const owner = binding();
      let recipient = account;
      if (field === 'accountId') recipient = value;
      else if (field === 'id' || field === 'connection') owner.source[field] = value;
      else owner[field] = value;
      denied(() => mintInvitationToken(owner, id, recipient));
      assert.equal(matchesInvitationToken(owner, id, recipient, result.token, result.digest), false);
    }
  }
  for (const sourceId of ['1business', 'business-name', 'business.name', 'business name', 'é']) {
    denied(() => mintInvitationToken({ ...binding(), source: { id: sourceId, connection: 'alias' } }, id, account));
  }
});

test('valid Unicode and exact byte limits survive without normalization', () => {
  const owner = { appId: 'é'.repeat(128), storeId: '😀'.repeat(64), source: { id: 'B'.repeat(256), connection: '😀'.repeat(256) } };
  const recipient = 'é'.repeat(512),
    result = mintInvitationToken(owner, id, recipient);
  assert.ok(matchesInvitationToken(owner, id, recipient, result.token, result.digest));
  assert.equal(matchesInvitationToken(owner, id, recipient.normalize('NFD'), result.token, result.digest), false);
  const composed = mintInvitationToken(binding(), id, 'é');
  assert.equal(matchesInvitationToken(binding(), id, 'e\u0301', composed.token, composed.digest), false);
});

test('all type-invalid arguments refuse without coercion, accessors or proxy traps', () => {
  let calls = 0;
  const hook = () => {
    calls++;
    throw new Error('private-input-detail');
  };
  const proxy = new Proxy({}, { get: hook, ownKeys: hook, getPrototypeOf: hook, getOwnPropertyDescriptor: hook });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const coercible = { toString: hook, valueOf: hook, [Symbol.toPrimitive]: hook };
  const invalid: unknown[] = [
    undefined,
    null,
    true,
    false,
    0,
    1,
    NaN,
    Infinity,
    1n,
    Symbol('secret'),
    [],
    {},
    new Date(0),
    new String(sample),
    Buffer.from(sample),
    hook,
    proxy,
    revoked.proxy,
    coercible,
  ];
  const result = mintInvitationToken(binding(), id, account);
  for (const input of invalid) {
    denied(() => invitationTokenId(input));
    denied(() => mintInvitationToken(input as TenantStoreBinding, id, account));
    denied(() => mintInvitationToken(binding(), input as string, account));
    denied(() => mintInvitationToken(binding(), id, input as string));
    for (const args of [
      [input, id, account, result.token, result.digest],
      [binding(), input, account, result.token, result.digest],
      [binding(), id, input, result.token, result.digest],
      [binding(), id, account, input, result.digest],
      [binding(), id, account, result.token, input],
    ]) {
      assert.equal(Reflect.apply(matchesInvitationToken, undefined, args), false);
    }
    for (const field of ['appId', 'storeId', 'source']) denied(() => mintInvitationToken({ ...binding(), [field]: input }, id, account));
    for (const field of ['id', 'connection']) {
      denied(() => mintInvitationToken({ ...binding(), source: { ...binding().source, [field]: input } }, id, account));
    }
  }
  for (const field of ['appId', 'storeId', 'source']) {
    const getter = Object.defineProperty(binding(), field, { enumerable: true, get: hook });
    denied(() => mintInvitationToken(getter, id, account));
    assert.equal(matchesInvitationToken(getter, id, account, result.token, result.digest), false);
  }
  for (const field of ['id', 'connection']) {
    const getter = { ...binding(), source: Object.defineProperty(binding().source, field, { enumerable: true, get: hook }) };
    denied(() => mintInvitationToken(getter, id, account));
    assert.equal(matchesInvitationToken(getter, id, account, result.token, result.digest), false);
  }
  assert.equal(calls, 0);
});
