import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shortLived } from '../packages/mistri/src/server/http/sitemapCache.js';

test('a sitemap answer is built once for concurrent requests, kept for its time, built again after, and never kept when it is not an answer', async () => {
  let clock = 0;
  const kept = shortLived<string | null | undefined>({ ttlMs: () => 1000, kept: 2, now: () => clock });
  const app = {};
  let built = 0;
  const build = (answer: string | null | undefined) => async () => {
    built++;
    await new Promise((resolve) => setImmediate(resolve));
    return answer;
  };
  // Three requests at once share one build.
  assert.deepEqual(await Promise.all([1, 2, 3].map(() => kept(app, 'a', build('<xml/>')))), ['<xml/>', '<xml/>', '<xml/>']);
  assert.equal(built, 1);
  clock = 999;
  assert.equal(await kept(app, 'a', build('<new/>')), '<xml/>');
  clock = 1000;
  assert.equal(await kept(app, 'a', build('<new/>')), '<new/>', 'after its time it is built again');
  assert.equal(built, 2);
  // A refusal or a failure is not kept.
  assert.equal(await kept(app, 'gone', build(null)), null);
  assert.equal(await kept(app, 'gone', build('<now/>')), '<now/>');
  assert.equal(await kept(app, 'down', build(undefined)), undefined);
  assert.equal(await kept(app, 'down', build('<up/>')), '<up/>');
  // Bounded: only two answers per App are kept, the oldest dropped.
  await kept(app, 'x', build('x'));
  await kept(app, 'y', build('y'));
  await kept(app, 'z', build('z'));
  const before = built;
  await kept(app, 'z', build('z'));
  await kept(app, 'y', build('y'));
  assert.equal(built, before, 'the newest two are still kept');
  await kept(app, 'x', build('x'));
  assert.equal(built, before + 1, 'the oldest was dropped');
  // Another App starts empty; a ttl of 0 keeps nothing.
  assert.equal(await kept({}, 'a', build('<other/>')), '<other/>');
  const off = shortLived<string>({ ttlMs: () => 0, kept: 2 });
  let count = 0;
  await off(app, 'a', async () => `${++count}`);
  await off(app, 'a', async () => `${++count}`);
  assert.equal(count, 2);
});
