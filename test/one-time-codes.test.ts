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

/* Counts what the store is asked to charge, so a try that was judged without being charged shows. */
const chargedStore = () => {
  const store = new MemoryCacheStore(1_000);
  const charges: number[] = [];
  const incr = store.incr.bind(store);
  store.incr = async (key, ttlMs) => {
    const counted = await incr(key, ttlMs);
    if (key.startsWith('fail:otp:')) charges.push(counted.count);
    return counted;
  };
  return { store, charges };
};

test('every try is charged before it is judged: no more than five are ever judged against one code', async () => {
  const { store, charges } = chargedStore();
  const [a, b] = [oneTimeCodes(signInStateIn(store)), oneTimeCodes(signInStateIn(store))];
  const subject = 'link\u0000L-burst';
  const sent = (await a.issue(subject)) as { code: string };
  // Twenty wrong guesses typed together with the right one, which sits tenth in line: only the first five attempts
  // may be judged, so the right code is past the budget and refused. Counting only the wrong ones after the compare
  // let a burst all read the count before any write landed, and charged the right one nothing.
  const burst = Array.from({ length: 21 }, (_, i) => (i === 9 ? sent.code : other(sent.code)));
  const results = await Promise.all(burst.map((typed, i) => (i % 2 ? a : b).spend(subject, typed)));
  assert.equal(results.filter(Boolean).length, 0, JSON.stringify(results));
  assert.equal(charges.length, 21, 'a right try is charged as a wrong one is');
  assert.equal(charges.filter((count) => count <= 5).length, 5, 'five tries within the budget, the rest refused unjudged');
  assert.equal(await a.spend(subject, sent.code), false, 'the code is burned');
});

test('the right code alone opens; after four wrong tries it still opens; after five it is refused', async () => {
  const [a] = twoInstances();
  const alone = (await a.issue('link\u0000L-alone')) as { code: string };
  assert.equal(await a.spend('link\u0000L-alone', alone.code), true);

  const four = (await a.issue('link\u0000L-four')) as { code: string };
  for (let i = 0; i < 4; i++) assert.equal(await a.spend('link\u0000L-four', other(four.code)), false);
  assert.equal(await a.spend('link\u0000L-four', four.code), true, 'the fifth try is within the budget');

  const five = (await a.issue('link\u0000L-five')) as { code: string };
  for (let i = 0; i < 5; i++) assert.equal(await a.spend('link\u0000L-five', other(five.code)), false);
  assert.equal(await a.spend('link\u0000L-five', five.code), false);
});

test('a right code that lands within the budget in a burst opens exactly once', async () => {
  const [a, b] = twoInstances();
  const subject = 'link\u0000L-early';
  const sent = (await a.issue(subject)) as { code: string };
  const burst = [other(sent.code), sent.code, other(sent.code), sent.code, ...Array(10).fill(other(sent.code))];
  const results = await Promise.all(burst.map((typed, i) => (i % 2 ? a : b).spend(subject, typed)));
  assert.equal(results.filter(Boolean).length, 1, JSON.stringify(results));
});
