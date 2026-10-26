import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { MemoryCacheStore, ValkeyCacheStore, scopedCache, CacheUnavailable } from '../packages/engine/src/adapters/cache/cacheStore.js';
import { RespClient, decodeReply, encodeCommand } from '../packages/engine/src/adapters/cache/resp.js';
import { startFakeValkey, type FakeValkey } from './support/fakeValkey.js';

const PERMISSIVE = { allowPrivate: true, allowLinkLocal: false };

test('RESP: a command is an array of bulk strings, and each reply type decodes', () => {
  assert.equal(encodeCommand(['SET', 'k', 'v', 'PX', 5]).toString(), '*5\r\n$3\r\nSET\r\n$1\r\nk\r\n$1\r\nv\r\n$2\r\nPX\r\n$1\r\n5\r\n');
  assert.deepEqual(decodeReply(Buffer.from('+OK\r\n'))?.value, 'OK');
  assert.deepEqual(decodeReply(Buffer.from(':42\r\n'))?.value, 42);
  assert.deepEqual(decodeReply(Buffer.from('$-1\r\n'))?.value, null);
  assert.deepEqual(decodeReply(Buffer.from('*2\r\n:1\r\n$2\r\nhi\r\n'))?.value, [1, 'hi']);
  // Half a reply is no reply yet.
  assert.equal(decodeReply(Buffer.from('$5\r\nhel')), undefined);
  const refusal = decodeReply(Buffer.from('-ERR nope\r\n'));
  assert.ok(refusal);
  assert.equal((refusal.value as Error).message, 'ERR nope');
});

test('memory: every value has a time to live, and expires on its own', async () => {
  let now = 1_000;
  const store = new MemoryCacheStore(10, () => now);
  await assert.rejects(store.set('k', 'v', 0), /time to live/);
  await assert.rejects(store.set('k', 'v', Number.POSITIVE_INFINITY), /time to live/);
  await store.set('k', 'v', 500);
  assert.equal(await store.get('k'), 'v');
  now += 500;
  assert.equal(await store.get('k'), undefined);
});

test('memory: bounded — the least recently used entry goes first', async () => {
  const store = new MemoryCacheStore(2);
  await store.set('a', '1', 60_000);
  await store.set('b', '2', 60_000);
  await store.get('a');
  await store.set('c', '3', 60_000);
  assert.equal(await store.get('b'), undefined);
  assert.equal(await store.get('a'), '1');
  assert.equal(store.size, 2);
});

test('memory: a count keeps its window — the first count starts it, the rest do not stretch it', async () => {
  let now = 0;
  const store = new MemoryCacheStore(10, () => now);
  assert.deepEqual(await store.incr('w', 1_000), { count: 1, ttlMs: 1_000 });
  now = 400;
  assert.deepEqual(await store.incr('w', 1_000), { count: 2, ttlMs: 600 });
  now = 1_000;
  assert.deepEqual(await store.incr('w', 1_000), { count: 1, ttlMs: 1_000 });
});

test('scoped: keys carry the prefix, so two namespaces never meet', async () => {
  const store = new MemoryCacheStore();
  await scopedCache(store, 'tw:a:').set('k', '1', 60_000);
  assert.equal(await scopedCache(store, 'tw:b:').get('k'), undefined);
  assert.equal(await store.get('tw:a:k'), '1');
});

let fake: FakeValkey;
before(async () => {
  fake = await startFakeValkey({ password: 'fake-cache-secret' });
});
after(async () => {
  await fake.close();
});

const client = (options: Partial<ConstructorParameters<typeof RespClient>[0]> = {}) =>
  new RespClient({
    host: '127.0.0.1',
    port: fake.port,
    tls: false,
    password: 'fake-cache-secret',
    policy: PERMISSIVE,
    retryAfterMs: 50,
    ...options,
  });

test('valkey: get, set with a time to live, delete and a windowed count, over one connection', async () => {
  const store = new ValkeyCacheStore(client());
  await store.set('tw:k', 'v', 60_000);
  assert.equal(await store.get('tw:k'), 'v');
  await store.delete('tw:k');
  assert.equal(await store.get('tw:k'), undefined);
  assert.equal((await store.incr('tw:w', 60_000)).count, 1);
  const second = await store.incr('tw:w', 60_000);
  assert.equal(second.count, 2);
  assert.ok(second.ttlMs > 0 && second.ttlMs <= 60_000);
  const set = fake.commands.find((command) => command[0] === 'SET' && command[1] === 'tw:k');
  assert.deepEqual(set, ['SET', 'tw:k', 'v', 'PX', '60000']);
  await store.close();
});

test('valkey: a wrong password is a miss, and what is said about it never carries the password', async () => {
  const heard: string[] = [];
  const store = new ValkeyCacheStore(client({ password: 'not-the-password' }), (message) => heard.push(message));
  assert.equal(await store.get('k'), undefined);
  await store.set('k', 'v', 1_000);
  await assert.rejects(store.incr('k', 1_000), CacheUnavailable);
  assert.ok(heard.length > 0);
  assert.ok(heard.every((message) => !message.includes('not-the-password') && /refused the connection's credential/.test(message)));
  await store.close();
});

test('valkey: an outage reads as a miss, quickly, and the cache comes back when the server does', async () => {
  const store = new ValkeyCacheStore(client({ connectTimeoutMs: 200 }));
  await store.set('k', 'v', 60_000);
  await fake.stop();
  const started = Date.now();
  assert.equal(await store.get('k'), undefined);
  // Quiet for a moment after a failure: the next miss does not dial again.
  assert.equal(await store.get('k'), undefined);
  assert.ok(Date.now() - started < 1_000);
  await fake.start();
  await new Promise((resolve) => setTimeout(resolve, 80));
  await store.set('k', 'back', 60_000);
  assert.equal(await store.get('k'), 'back');
  await store.close();
});

test('valkey: the address policy holds — a link-local address is refused before any socket opens, and a name resolving to one is too', async () => {
  const before = fake.commands.length;
  const literal = new ValkeyCacheStore(client({ host: '169.254.169.254' }));
  await assert.rejects(literal.incr('k', 1_000), /may not reach/);
  const rebinding = new ValkeyCacheStore(
    client({
      host: 'cache.internal',
      policy: { ...PERMISSIVE, resolver: (_host, _options, callback) => callback(null, [{ address: '169.254.169.254', family: 4 }]) },
    }),
  );
  await assert.rejects(rebinding.incr('k', 1_000), /may not reach/);
  assert.equal(fake.commands.length, before);
  await literal.close();
  await rebinding.close();
});
