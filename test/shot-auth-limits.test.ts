import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authLimitsOffForTests } from '../packages/mistri/src/server/auth/requestRules.js';
import { retryAfterMs, shotAuthLimits } from '../packages/mistri/src/server/build/shot.js';

test('the server shot and grade start has the per-address sign-in limits off on loopback (--as all is not 429)', () => {
  assert.equal(authLimitsOffForTests('127.0.0.1', { ...shotAuthLimits }), true);
});

test('Retry-After is honoured in seconds and bounded', () => {
  assert.equal(retryAfterMs('3'), 3000);
  assert.equal(retryAfterMs('9999'), 15000);
  assert.equal(retryAfterMs(undefined), 1000);
});
