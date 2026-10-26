import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { apiTokenSecretId, matchesApiTokenSecret, mintApiTokenSecret } from '../packages/mistri/src/server/api/apiTokenSecret.js';

const id = '12345678-1234-4abc-8def-123456789abc';
const sample = `twa1.${id}.${'A'.repeat(43)}`;
const refusal = (work: () => unknown) =>
  assert.throws(work, (error) => {
    assert.ok(error instanceof TypeError);
    assert.equal(error.message, 'API token credential is unavailable.');
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  });

test('mint returns frozen random 32-byte one-time handoffs; digest binds app and opaque ID', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 64; i++) {
    const tokenId = randomUUID(),
      result = mintApiTokenSecret('app', tokenId);
    assert.ok(Object.isFrozen(result));
    assert.deepEqual(Object.keys(result).sort(), ['digest', 'token']);
    assert.equal(result.token.length, 85);
    assert.equal(apiTokenSecretId(result.token), tokenId);
    assert.equal(Buffer.from(result.token.slice(42), 'base64url').length, 32);
    assert.match(result.digest, /^[0-9a-f]{64}$/);
    assert.ok(matchesApiTokenSecret('app', tokenId, result.token, result.digest));
    assert.equal(matchesApiTokenSecret('other', tokenId, result.token, result.digest), false);
    assert.equal(matchesApiTokenSecret('app', id, result.token, result.digest), false);
    seen.add(result.token);
  }
  assert.equal(seen.size, 64);
  const one = mintApiTokenSecret('app', id),
    two = mintApiTokenSecret('app', id);
  assert.notEqual(one.token, two.token);
  assert.equal(matchesApiTokenSecret('app', id, one.token, two.digest), false);
});

test('parser rejects versions, separators, whitespace, padding and noncanonical base64 padding bits', () => {
  assert.equal(apiTokenSecretId(sample), id);
  for (const raw of [
    '',
    sample.slice(1),
    sample.slice(0, -1),
    sample + '=',
    sample + '\n',
    ' ' + sample,
    sample.replace('twa1', 'twi1'),
    sample.replace('twa1', 'twa2'),
    sample.replace('.', ':'),
    sample.replace(`${id}.`, `${id}:`),
    sample.replace('4abc', '7abc'),
    sample.replace('8def', '0def'),
    sample.toUpperCase(),
    sample + '.extra',
    sample.repeat(10000),
    sample.slice(0, -1) + '\0',
    sample.slice(0, -1) + '/',
    sample.slice(0, -1) + '+',
    sample.slice(0, -1) + '\ud800',
  ]) {
    refusal(() => apiTokenSecretId(raw));
    assert.equal(matchesApiTokenSecret('app', id, raw, '0'.repeat(64)), false);
  }
  for (const ending of ['B', 'C', 'D']) {
    const alias = sample.slice(0, -1) + ending;
    assert.deepEqual(Buffer.from(alias.slice(42), 'base64url'), Buffer.from(sample.slice(42), 'base64url'));
    refusal(() => apiTokenSecretId(alias));
  }
});

test('digest comparison refuses mutations, noncanonical encodings and another crypto domain', () => {
  const result = mintApiTokenSecret('app', id);
  for (let i = 0; i < 64; i++) {
    const changed = result.digest.slice(0, i) + (result.digest[i] === '0' ? '1' : '0') + result.digest.slice(i + 1);
    assert.equal(matchesApiTokenSecret('app', id, result.token, changed), false);
  }
  for (const value of [
    result.digest.toUpperCase(),
    result.digest + '\n',
    result.digest.slice(1),
    result.digest + '0',
    'g'.repeat(64),
    Buffer.from(result.digest, 'hex'),
  ])
    assert.equal(matchesApiTokenSecret('app', id, result.token, value), false);
  const foreign = createHash('sha256')
    .update(JSON.stringify(['mistri:tenant-invitation-token:twi1', 'app', id, result.token.slice(42)]))
    .digest('hex');
  assert.equal(matchesApiTokenSecret('app', id, result.token, foreign), false);
});

test('namespace is exact scalar UTF8 with bounded bytes and no normalization', () => {
  for (const name of ['😀'.repeat(64), 'é'.repeat(128), 'e\u0301']) {
    const result = mintApiTokenSecret(name, id);
    assert.ok(matchesApiTokenSecret(name, id, result.token, result.digest));
  }
  const result = mintApiTokenSecret('é', id);
  assert.equal(matchesApiTokenSecret('e\u0301', id, result.token, result.digest), false);
  for (const name of ['', ' app', 'app ', 'x\n', 'a\0b', '\ud800', '\udfff', 'é'.repeat(129), 'x'.repeat(257)])
    refusal(() => mintApiTokenSecret(name, id));
});

test('all positions refuse hostile nonstrings without executing getters, proxies or coercion', () => {
  let calls = 0;
  const trap = () => {
    calls++;
    throw new Error('SECRET_DETAIL');
  };
  const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const getter = Object.defineProperty({}, 'token', { get: trap });
  const result = mintApiTokenSecret('app', id);
  for (const value of [
    undefined,
    null,
    1,
    true,
    Symbol('secret'),
    1n,
    {},
    [],
    new String(sample),
    Buffer.from(sample),
    proxy,
    revoked.proxy,
    getter,
    { toString: trap, [Symbol.toPrimitive]: trap },
  ]) {
    refusal(() => apiTokenSecretId(value));
    refusal(() => mintApiTokenSecret(value, id));
    refusal(() => mintApiTokenSecret('app', value));
    for (let index = 0; index < 4; index++) {
      const args: unknown[] = ['app', id, result.token, result.digest];
      args[index] = value;
      assert.equal(Reflect.apply(matchesApiTokenSecret, undefined, args), false);
    }
  }
  assert.equal(calls, 0);
});
