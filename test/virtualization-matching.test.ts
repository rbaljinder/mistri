/** Virtual services and verification must agree on request matching. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchRequest, validateRequestMatcher, type VirtualRequest } from '../packages/mistri/src/server/virtualization/matching.js';

const request = (url: string, body: unknown = undefined): VirtualRequest => ({
  method: 'POST',
  url,
  headers: { 'Content-Type': 'application/json' },
  body,
});

test('path params, repeated query values, case-insensitive headers and partial JSON compose', () => {
  const result = matchRequest(
    {
      method: 'post',
      path: '/checks/:id',
      query: { tag: ['a', 'b'] },
      headers: { 'content-type': 'application/json' },
      body: { partial: { person: { name: 'Ada' } } },
    },
    request('/checks/a%20b?tag=a&tag=b', { person: { name: 'Ada', age: 30 }, extra: true }),
  );
  assert.equal(result.matched, true);
  assert.equal(result.params.id, 'a b');
});

test('exact body rejects extras; partial arrays still require order and cardinality', () => {
  assert.equal(matchRequest({ body: { exact: { a: 1 } } }, request('/', { a: 1, b: 2 })).matched, false);
  assert.equal(matchRequest({ body: { partial: { a: [1] } } }, request('/', { a: [1, 2] })).matched, false);
  assert.equal(matchRequest({ body: { partial: { a: 1 } } }, request('/', Object.create({ a: 1 }))).matched, false);
});

test('wildcards are explicit and empty parameters are refused', () => {
  assert.equal(matchRequest({ path: '/checks/*' }, request('/checks/a/b')).matched, true);
  assert.equal(matchRequest({ path: '/checks/:id' }, request('/checks/')).matched, false);
  assert.equal(matchRequest({ path: '/checks/:id' }, request('/checks/a/b')).matched, false);
  assert.equal(matchRequest({ path: '/checks/:id' }, request('/checks/%ZZ')).matched, false);
  assert.equal(matchRequest({ path: '/checks/:id' }, request('/checks/a%2Fb')).params.id, 'a/b');
  for (const path of ['checks', '/:id/:id', '/a/*/b', '/:']) assert.throws(() => validateRequestMatcher({ path }));
});

test('global regular expressions do not alternate between matches', () => {
  const pattern = /^a$/g;
  pattern.lastIndex = 1;
  for (let i = 0; i < 3; i++) assert.equal(matchRequest({ query: { q: pattern } }, request('/?q=a')).matched, true);
  assert.equal(pattern.lastIndex, 1);
});

test('missing and duplicate fields remain distinct and diagnostics identify all mismatches', () => {
  const result = matchRequest(
    { method: 'GET', path: '/other', query: { q: 'a' }, headers: { authorization: 'secret' }, body: { exact: null } },
    request('/?q=a&q=a'),
  );
  assert.equal(result.matched, false);
  assert.equal(result.differences.length, 5);
  assert.ok(!result.differences.join().includes('secret'));
  assert.equal(matchRequest({ query: { q: [] } }, request('/')).matched, true);
  assert.equal(matchRequest({ query: { q: '' } }, request('/')).matched, false);
});

test('predicates must return synchronous booleans and validation rejects ambiguous definitions', () => {
  assert.equal(matchRequest({ body: { predicate: (value) => value === 42 } }, request('/', 42)).matched, true);
  assert.throws(() => matchRequest({ body: { predicate: (() => Promise.resolve(true)) as never } }, request('/')), /synchronous boolean/);
  assert.throws(
    () => matchRequest({ body: { predicate: (() => Promise.reject(new Error('async predicate'))) as never } }, request('/')),
    /synchronous boolean/,
  );
  assert.throws(() => validateRequestMatcher({ body: { exact: 1, partial: 1 } as never }), /exactly one/);
  assert.throws(() => validateRequestMatcher({ headers: { Accept: 'a', accept: 'b' } }), /Duplicate/);
});
