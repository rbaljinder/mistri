/** Stateful virtual HTTP acceptance, including failures that must reach tests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay, setImmediate as nextTurn } from 'node:timers/promises';
import { defineService } from '../packages/mistri/src/server/virtualization/definition.js';
import { startService } from '../packages/mistri/src/server/virtualization/service.js';

const credit = defineService({
  name: 'credit',
  state: { checks: {} as Record<string, number>, counter: 0 },
  routes: [
    {
      id: 'create',
      match: { method: 'POST', path: '/checks', body: { partial: { name: 'Ada' } } },
      reply: ({ state, random }) => {
        const id = String(++state.counter);
        state.checks[id] = Math.floor(random() * 1000);
        return { status: 201, body: { id, score: state.checks[id] } };
      },
    },
    {
      id: 'read',
      match: { method: 'GET', path: '/checks/:id' },
      reply: ({ state, params }) =>
        Object.hasOwn(state.checks, params.id)
          ? { body: { id: params.id, score: state.checks[params.id] } }
          : { status: 404, body: { error: 'unknown check' } },
    },
  ],
  scenarios: { unavailable: [{ id: 'create', match: { method: 'POST', path: '/checks' }, reply: { status: 503 } }] },
});
const create = (url: string) =>
  fetch(`${url}/checks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ada' }) });

test('credit check roundtrip, isolated instances, scenario reset and seeded replay', async () => {
  await using service = await startService(credit, { seed: 42 });
  await using other = await startService(credit, { seed: 42 });
  const first = await (await create(service.url)).json();
  assert.equal(first.id, '1');
  assert.deepEqual(await (await fetch(`${service.url}/checks/1`)).json(), first);
  assert.equal((await fetch(`${other.url}/checks/1`)).status, 404);
  service.verify({ method: 'POST' }, { times: 1 });
  service.verify({ method: 'DELETE' }, { times: 0 });
  service.scenario('unavailable');
  assert.equal((await create(service.url)).status, 503);
  service.reset();
  assert.deepEqual(await (await create(service.url)).json(), first);
  assert.equal(service.journal().length, 1);
});

test('concurrent handlers serialize state and retained context cannot mutate committed state', async () => {
  let retained: { counter: number } | undefined;
  await using service = await startService(
    defineService({
      name: 'atomic',
      state: { counter: 0 },
      routes: [
        {
          id: 'increment',
          match: { path: '/' },
          reply: async ({ state }) => {
            const before = state.counter;
            await delay(5);
            state.counter = before + 1;
            retained = state;
            return { body: state.counter };
          },
        },
      ],
    }),
  );
  const values = await Promise.all(Array.from({ length: 8 }, async () => (await fetch(service.url)).json()));
  assert.deepEqual(
    values.slice().sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  retained!.counter = 999;
  assert.equal(service.state().counter, 8);
});

test('unexpected requests and ambiguous matching fail teardown, not merely HTTP', async () => {
  const missing = await startService(credit);
  assert.equal((await fetch(`${missing.url}/wrong`)).status, 500);
  assert.throws(() => missing.assertSatisfied(), /Unexpected/);
  await assert.rejects(missing.close(), /Unexpected/);
  const ambiguous = await startService(
    defineService({
      name: 'ambiguous',
      state: {},
      routes: [
        { id: 'a', match: { path: '/:id' }, reply: {} },
        { id: 'b', match: { path: '/thing' }, reply: {} },
      ],
    }),
  );
  assert.equal((await fetch(`${ambiguous.url}/thing`)).status, 500);
  await assert.rejects(ambiguous.close(), /Ambiguous/);
});

test('handler timeout rolls back state and fences an uncooperative late continuation', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = await startService(
    defineService({
      name: 'timeout',
      state: { value: 0 },
      routes: [
        {
          id: 'hold',
          match: { path: '/' },
          reply: async ({ state }) => {
            state.value = 1;
            await held;
            state.value = 2;
            return {};
          },
        },
      ],
    }),
    { handlerTimeoutMs: 40 },
  );
  assert.equal((await fetch(service.url)).status, 500);
  release();
  await delay(5);
  assert.equal(service.state().value, 0);
  await assert.rejects(service.close(), /exceeded/);
});

test('controlled time drives pending completion, and scenario changes preserve admitted requests', async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  await using service = await startService(
    defineService({
      name: 'clock',
      state: {},
      routes: [
        {
          id: 'read',
          match: { path: '/' },
          reply: async ({ clock }) => {
            started();
            await clock.sleep(100);
            return { body: clock.now() };
          },
        },
      ],
      scenarios: { failed: [{ id: 'read', match: { path: '/' }, reply: { status: 503 } }] },
    }),
    { now: 1000 },
  );
  const request = fetch(service.url);
  await ready;
  service.scenario('failed');
  assert.throws(() => service.reset(), /still active/);
  service.clock.advance(100);
  assert.equal(await (await request).json(), 1100);
  assert.equal((await fetch(service.url)).status, 503);
});

test('declared disconnect and timeout faults are expected, not handler failures', async () => {
  let admitted!: () => void;
  const ready = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  await using service = await startService(
    defineService({
      name: 'faults',
      state: {},
      routes: [
        { id: 'disconnect', match: { path: '/disconnect' }, reply: { fault: 'disconnect' } },
        {
          id: 'timeout',
          match: { path: '/timeout' },
          reply: () => {
            admitted();
            return { fault: 'timeout' };
          },
        },
      ],
    }),
  );
  await assert.rejects(fetch(`${service.url}/disconnect`));
  const controller = new AbortController();
  const pending = fetch(`${service.url}/timeout`, { signal: controller.signal });
  const refused = assert.rejects(pending);
  await ready;
  controller.abort();
  await refused;
  await service.close();
  assert.equal(service.journal().filter((entry) => entry.outcome === 'fault').length, 2);
});

test('repeatable retries and explicit priority coexist with a fallback route', async () => {
  await using service = await startService(
    defineService({
      name: 'retry',
      state: { attempts: 0 },
      routes: [
        { id: 'fallback', match: {}, reply: { status: 404 }, priority: -1 },
        { id: 'retry', match: { method: 'POST', path: '/submit' }, reply: ({ state }) => ({ status: ++state.attempts <= 2 ? 503 : 201 }) },
      ],
    }),
  );
  const statuses = [];
  for (let attempt = 0; attempt < 3; attempt++) statuses.push((await fetch(`${service.url}/submit`, { method: 'POST' })).status);
  assert.deepEqual(statuses, [503, 503, 201]);
  assert.equal((await fetch(`${service.url}/other`)).status, 404);
  service.verify({ method: 'POST', path: '/submit' }, { times: 3 });
  assert.throws(() => service.verify({ path: '/submit' }, { times: 4 }), /expected 4.*received 3/);
});

test('journal preserves request inputs when a handler mutates its body', async () => {
  await using service = await startService(
    defineService({
      name: 'journal',
      state: {},
      routes: [
        {
          id: 'edit',
          match: { path: '/' },
          reply: ({ body }) => {
            (body as { value: number }).value = 2;
            return {};
          },
        },
      ],
    }),
  );
  await fetch(service.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"value":1}' });
  assert.deepEqual(service.journal()[0].body, { value: 1 });
  (service.journal()[0].body as { value: number }).value = 3;
  assert.deepEqual(service.journal()[0].body, { value: 1 });
});

test('closing an active logical wait cancels it and reports failure without hanging', async () => {
  let admitted!: () => void;
  const ready = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  const service = await startService(
    defineService({
      name: 'shutdown',
      state: {},
      routes: [
        {
          id: 'wait',
          match: { path: '/' },
          reply: async ({ clock }) => {
            admitted();
            await clock.sleep(100);
            return {};
          },
        },
      ],
    }),
  );
  const request = fetch(service.url).catch(() => undefined);
  await ready;
  await assert.rejects(service.close(), /failure/);
  await request;
});

test('startup captures mutable route definitions and reset seed', async () => {
  const reply = { body: { value: 1 } };
  const route = { id: 'read', match: { path: '/', query: { q: ['a'] } }, reply };
  const options = { seed: 42 };
  await using service = await startService({ name: 'captured', state: {}, routes: [route] }, options);
  route.match.path = '/changed';
  route.match.query.q[0] = 'b';
  reply.body.value = 9;
  assert.deepEqual(await (await fetch(`${service.url}/?q=a`)).json(), { value: 1 });
  await using seeded = await startService(credit, options);
  const first = await (await create(seeded.url)).json();
  options.seed = 12;
  seeded.reset();
  assert.deepEqual(await (await create(seeded.url)).json(), first);
});

test('a caller timing out on an intentional slow reply is an expected transport fault', async () => {
  let admitted!: () => void;
  const ready = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  await using service = await startService(
    defineService({
      name: 'slow',
      state: {},
      routes: [
        {
          id: 'slow',
          match: { path: '/' },
          reply: () => {
            admitted();
            return { delayMs: 5000 };
          },
        },
      ],
    }),
  );
  const controller = new AbortController();
  const refused = assert.rejects(fetch(service.url, { signal: controller.signal }));
  await ready;
  await nextTurn();
  controller.abort();
  await refused;
  await service.close();
  assert.equal(service.journal()[0].outcome, 'fault');
});
