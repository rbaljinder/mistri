/** Visitor identities have no authority, are opaque, scoped and explicitly minted. */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { createExperimentVisitorIdentity } from '../packages/mistri/src/server/experiments/visitorIdentity.js';

const request = (cookie = '') => ({ headers: { cookie } }) as IncomingMessage;
const binding = { suiteId: 'suite', deploymentId: 'test' };
const configuration = { binding, appId: 'storefront', environment: 'test', key: new Uint8Array(32).fill(7), mount: '/shop', secure: true };

test('read never creates identity; explicit establishment produces an opaque HttpOnly scoped cookie', () => {
  const owner = createExperimentVisitorIdentity(configuration);
  assert.equal(owner.read(request()), null);
  const established = owner.establish(request());
  assert.match(established.setCookie!, /Path=\/shop;.*HttpOnly; SameSite=Lax; Secure/);
  const cookie = established.setCookie!.split(';')[0],
    proof = owner.read(request(cookie))!;
  assert.ok(proof);
  const identity = owner.capture(proof);
  assert.ok(!cookie.includes(identity.visitorId));
  assert.match(identity.visitorId, /^v-[A-Za-z0-9_-]{32}$/);
  assert.match(identity.proofId, /^p-[A-Za-z0-9_-]{32}$/);
  assert.notEqual(identity.visitorId, identity.proofId);
  assert.equal(owner.establish(request(cookie)).setCookie, null);
  owner.assertCurrent(proof, request(cookie));
  assert.throws(() => owner.assertCurrent(proof, request()), /changed/);
});

test('tampered, duplicate, cross-owner and expired cookies are refused', () => {
  let now = 1000;
  const owner = createExperimentVisitorIdentity({ ...configuration, clock: () => now, lifetimeMs: 1000 });
  const established = owner.establish(request()),
    cookie = established.setCookie!.split(';')[0];
  const proof = owner.read(request(cookie))!;
  assert.equal(owner.read(request(`${cookie}; ${cookie}`)), null);
  assert.equal(owner.read(request(`${cookie.slice(0, -4)}AAAA`)), null);
  const other = createExperimentVisitorIdentity({ ...configuration, appId: 'other', clock: () => now, lifetimeMs: 1000 });
  assert.equal(other.read(request(cookie.replace(owner.cookieName, other.cookieName))), null);
  assert.throws(() => createExperimentVisitorIdentity(configuration).capture(proof), /another owner/);
  now = 2000;
  assert.equal(owner.read(request(cookie)), null);
  assert.throws(() => owner.capture(proof), /expired/);
});

test('restarts preserve valid identities with the same dedicated key and binding', () => {
  const one = createExperimentVisitorIdentity(configuration),
    two = createExperimentVisitorIdentity(configuration);
  const issued = one.establish(request()),
    cookie = issued.setCookie!.split(';')[0];
  assert.deepEqual(one.capture(issued.proof), two.capture(two.read(request(cookie))!));
  const wrongKey = createExperimentVisitorIdentity({ ...configuration, key: new Uint8Array(32).fill(8) });
  assert.equal(wrongKey.read(request(cookie)), null);
});
