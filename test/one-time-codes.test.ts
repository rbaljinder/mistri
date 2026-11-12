/**
 * One-time codes are kept in the state every instance of a deployment shares
 * (auth/signInState.ts), so two instances over one store agree on them: a
 * code sent by one is spent on the other, wrong tries count across both, a
 * right code typed at both at once opens once, and three codes an hour is
 * three across the deployment.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryCacheStore } from '@mistriwork/engine/adapters/cache/cacheStore.js';
import { signInStateIn } from '../packages/mistri/src/server/auth/signInState.js';
import { oneTimeCodes } from '../packages/mistri/src/server/forms/oneTimeCode.js';

const twoInstances = () => {
  const store = new MemoryCacheStore(1_000);
  return [oneTimeCodes(signInStateIn(store)), oneTimeCodes(signInStateIn(store))] as const;
};
const other = (code: string) => (code === '123456' ? '654321' : '123456');

test('a code sent by one instance is spent on the other, once', async () => {
  const [a, b] = twoInstances();
  const sent = (await a.issue('status\u0000apply\u0000R-1')) as { code: string };
  assert.equal(await b.spend('status\u0000apply\u0000R-1', sent.code), true);
  assert.equal(await a.spend('status\u0000apply\u0000R-1', sent.code), false, 'spent everywhere');
});

test('wrong tries counted on either instance burn the code for both', async () => {
  const [a, b] = twoInstances();
  const sent = (await a.issue('link\u0000L-1')) as { code: string };
  for (let i = 0; i < 5; i++) assert.equal(await (i % 2 ? a : b).spend('link\u0000L-1', other(sent.code)), false);
  assert.equal(await a.spend('link\u0000L-1', sent.code), false, 'five wrong tries across two instances burn it');
  assert.equal(await b.spend('link\u0000L-1', sent.code), false);
});

test('a right code typed at both instances at once opens one of them', async () => {
  const [a, b] = twoInstances();
  const sent = (await a.issue('link\u0000L-2')) as { code: string };
  const opened = await Promise.all([a.spend('link\u0000L-2', sent.code), b.spend('link\u0000L-2', sent.code)]);
  assert.deepEqual(opened.filter(Boolean).length, 1, JSON.stringify(opened));
});

test('three codes an hour is three across the deployment, and a newer code replaces the one before', async () => {
  const [a, b] = twoInstances();
  const first = (await a.issue('verify\u0000apply\u0000d')) as { code: string };
  const second = (await b.issue('verify\u0000apply\u0000d')) as { code: string };
  assert.ok('code' in (await a.issue('verify\u0000apply\u0000d')));
  assert.deepEqual(await b.issue('verify\u0000apply\u0000d'), { limited: true });
  assert.deepEqual(await a.issue('verify\u0000apply\u0000d'), { limited: true });
  if (first.code !== second.code) assert.equal(await b.spend('verify\u0000apply\u0000d', first.code), false, 'the older code is gone');
});

test('a code proves what it was bound to, and expires', async () => {
  const [a, b] = twoInstances();
  const now = Date.now();
  const bound = (await a.issue('verify\u0000x', now, 'ada@example.test')) as { code: string };
  assert.equal(await b.spend('verify\u0000x', bound.code, now, 'mallory@example.test'), false);
  const late = (await a.issue('verify\u0000y', now)) as { code: string };
  assert.equal(await b.spend('verify\u0000y', late.code, now + 10 * 60_000), false, 'ten minutes, then gone');
});

test('instances over different stores do not see each other’s codes', async () => {
  const a = oneTimeCodes(signInStateIn(new MemoryCacheStore(100)));
  const b = oneTimeCodes(signInStateIn(new MemoryCacheStore(100)));
  const sent = (await a.issue('s')) as { code: string };
  assert.equal(await b.spend('s', sent.code), false);
  assert.equal(await a.spend('s', sent.code), true);
});
