import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { MemoryCacheStore, ValkeyCacheStore } from '../packages/engine/src/adapters/cache/cacheStore.js';
import { RespClient } from '../packages/engine/src/adapters/cache/resp.js';
import {
  FixedWindowLimiter,
  SharedWindowLimiter,
  configurePublicFormLimits,
  invitationClaimLimiter,
  publicFormLimiter,
} from '../packages/engine/src/server/http/rateLimit.js';
import { startFakeValkey, type FakeValkey } from './support/fakeValkey.js';

let fake: FakeValkey;
before(async () => {
  fake = await startFakeValkey();
});
after(async () => {
  await fake.close();
});

const cache = () =>
  new ValkeyCacheStore(
    new RespClient({
      host: '127.0.0.1',
      port: fake.port,
      tls: false,
      policy: { allowPrivate: true, allowLinkLocal: false },
      retryAfterMs: 50,
      connectTimeoutMs: 200,
    }),
  );
const WINDOWS = [{ limit: 2, ms: 60_000 }];

test('two instances over one cache spend one budget per client', async () => {
  const a = new SharedWindowLimiter('t1', WINDOWS, cache(), new FixedWindowLimiter(WINDOWS));
  const b = new SharedWindowLimiter('t1', WINDOWS, cache(), new FixedWindowLimiter(WINDOWS));
  assert.deepEqual(await a.take('192.0.2.1'), { ok: true, remaining: 1 });
  assert.deepEqual(await b.take('192.0.2.1'), { ok: true, remaining: 0 });
  const refused = await a.take('192.0.2.1');
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && refused.scope === 'client' && refused.retryAfterSeconds > 0 && refused.retryAfterSeconds <= 60);
  // Another client has its own budget; one IPv6 /64 is one client.
  assert.equal((await b.take('192.0.2.2')).ok, true);
  assert.equal((await a.take('2001:db8::1')).ok, true);
  assert.equal((await b.take('2001:db8::2')).ok, true);
  assert.equal((await a.take('2001:db8::3')).ok, false);
});

test('the shared ceiling holds across clients and instances', async () => {
  const total = [{ limit: 3, ms: 60_000 }];
  const a = new SharedWindowLimiter('t2', WINDOWS, cache(), new FixedWindowLimiter(WINDOWS), total);
  const b = new SharedWindowLimiter('t2', WINDOWS, cache(), new FixedWindowLimiter(WINDOWS), total);
  for (const [limiter, address] of [
    [a, '198.51.100.1'],
    [b, '198.51.100.2'],
    [a, '198.51.100.3'],
  ] as const) {
    assert.equal((await limiter.take(address)).ok, true);
  }
  const refused = await b.take('198.51.100.4');
  assert.ok(!refused.ok && refused.scope === 'all');
});

test("the shared ceiling is spent apart from the client's part, across instances", async () => {
  const total = [{ limit: 2, ms: 60_000 }];
  const a = new SharedWindowLimiter('t2b', WINDOWS, cache(), new FixedWindowLimiter(WINDOWS), total);
  const b = new SharedWindowLimiter('t2b', WINDOWS, cache(), new FixedWindowLimiter(WINDOWS), total);
  for (let i = 0; i < 10; i++) assert.equal((await a.take(`198.51.100.${i}`, 'client')).ok, true);
  assert.equal((await b.take('198.51.100.1', 'all')).ok, true);
  assert.equal((await a.take('198.51.100.2', 'all')).ok, true);
  const refused = await b.take('198.51.100.3', 'all');
  assert.ok(!refused.ok && refused.scope === 'all');
});

test('when the cache cannot count, this process counts — degraded to one instance, never open', async () => {
  const fallback = new FixedWindowLimiter(WINDOWS);
  const limiter = new SharedWindowLimiter('t3', WINDOWS, cache(), fallback);
  await fake.stop();
  try {
    assert.equal((await limiter.take('203.0.113.9')).ok, true);
    assert.equal((await limiter.take('203.0.113.9')).ok, true);
    assert.equal((await limiter.take('203.0.113.9')).ok, false);
    assert.equal(fallback.size, 1);
  } finally {
    await fake.start();
  }
});

test('public forms count in this process unless the deployment names a shared cache', async () => {
  configurePublicFormLimits(new MemoryCacheStore(), 'crm');
  assert.ok(publicFormLimiter('submit') instanceof FixedWindowLimiter);
  configurePublicFormLimits(cache(), 'crm');
  assert.ok(publicFormLimiter('submit') instanceof SharedWindowLimiter);
  assert.ok(publicFormLimiter('read') instanceof SharedWindowLimiter);
  await publicFormLimiter('read').take('192.0.2.50');
  assert.ok(fake.commands.some((command) => command[0] === 'EVAL' && command[3] === 'tw:crm:form:read:192.0.2.50:0'));
  // Invitation claims count in the same cache under a key prefix of their own.
  assert.ok(invitationClaimLimiter() instanceof SharedWindowLimiter);
  await invitationClaimLimiter().take('192.0.2.51');
  assert.ok(fake.commands.some((command) => command[0] === 'EVAL' && command[3] === 'tw:crm:form:claim:192.0.2.51:0'));
  configurePublicFormLimits(undefined, 'crm');
  assert.ok(publicFormLimiter('submit') instanceof FixedWindowLimiter);
  assert.ok(invitationClaimLimiter() instanceof FixedWindowLimiter);
});
