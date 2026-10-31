/**
 * @mistriwork/cloudflare: the environment the container starts with, the token-gated restart, the patient startup, the
 * image pin and the mail forwarder's signature, with @cloudflare/containers stubbed (it imports `cloudflare:workers`,
 * which only the Workers runtime has).
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const stub = pathToFileURL(new URL('./support/containersStub.ts', import.meta.url).pathname).href;
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === '@cloudflare/containers' ? { url: stub, shortCircuit: true } : next(specifier, context),
});
const { MistriContainer, mistriWorker, forwardEmail, signMail, isRestart, isProbe, containerEnv } =
  await import('../packages/cloudflare/src/index.js');

const TOKEN = 'a'.repeat(40);

class App extends MistriContainer {
  static override options = {
    vars: ['MISTRI_PUBLIC_URL'],
    secrets: ['BETTER_AUTH_SECRET', 'EMPTY'],
    startupTimeoutMs: 123_000,
    image: 'app',
    instanceType: 'standard-1',
  };
}

const make = (env: Record<string, unknown>, container?: unknown) => new App({ container } as never, env) as App & Record<string, any>;

test('the container starts with the image environment, the deploy id and only the named names that are set', () => {
  const app = make({
    MISTRI_PUBLIC_URL: 'https://app.test',
    MISTRI_DEPLOY_ID: 'abc',
    BETTER_AUTH_SECRET: 's',
    EMPTY: '',
    UNNAMED: 'x',
  });
  assert.equal(app.envVars.MISTRI_PUBLIC_URL, 'https://app.test');
  assert.equal(app.envVars.MISTRI_DEPLOY_ID, 'abc');
  assert.equal(app.envVars.BETTER_AUTH_SECRET, 's');
  assert.equal(app.envVars.NODE_ENV, 'production');
  assert.equal(app.envVars.PORT, '4111');
  assert.equal(app.envVars.MISTRI_TRUST_PROXY_CLOUDFLARE, '1');
  assert.ok(!('EMPTY' in app.envVars) && !('UNNAMED' in app.envVars));
  assert.equal(containerEnv({ port: 8080 }, {}).PORT, '8080');
});

test('only a POST with the restart token destroys the container', async () => {
  const env = { MISTRI_RESTART_TOKEN: TOKEN };
  const app = make(env);
  const ask = (init: RequestInit) => app.fetch(new Request('https://app.test/', init));
  assert.equal(await (await ask({ method: 'GET', headers: { 'x-mistri-restart': TOKEN } })).text(), 'from the container');
  assert.equal(await (await ask({ method: 'POST', headers: { 'x-mistri-restart': 'b'.repeat(40) } })).text(), 'from the container');
  assert.equal(app.destroyed, 0);
  assert.match(await (await ask({ method: 'POST', headers: { 'x-mistri-restart': TOKEN } })).text(), /stopped/);
  assert.equal(app.destroyed, 1);
  /* A short token never opens the gate, even when the header equals it. */
  assert.equal(
    isRestart(new Request('https://x/', { method: 'POST', headers: { 'x-mistri-restart': 'short' } }), { MISTRI_RESTART_TOKEN: 'short' }),
    false,
  );
  /* The token's env name is configurable. */
  assert.equal(
    isRestart(new Request('https://x/', { method: 'POST', headers: { 'x-mistri-restart': TOKEN } }), { OTHER: TOKEN }, 'OTHER'),
    true,
  );
});

test('it stays on when idle, waits the whole startup for the port, and keeps a caller limit', async () => {
  const app = make({});
  await app.onActivityExpired();
  assert.equal(app.expired, undefined);
  await app.startAndWaitForPorts();
  assert.deepEqual(app.started[0][1], { instanceGetTimeoutMS: 60_000, portReadyTimeoutMS: 123_000 });
  await app.startAndWaitForPorts(4111, { portReadyTimeoutMS: 5 });
  assert.equal((app.started[1][1] as { portReadyTimeoutMS: number }).portReadyTimeoutMS, 5);
  await app.startAndWaitForPorts({ ports: 4111, cancellationOptions: { instanceGetTimeoutMS: 7 } } as never);
  const given = app.started[2][0] as { cancellationOptions: Record<string, number> };
  assert.deepEqual(given.cancellationOptions, { instanceGetTimeoutMS: 7, portReadyTimeoutMS: 123_000 });
});

test('the start is pinned to the image and instance type, and the rest of the runtime passes through', () => {
  const calls: unknown[] = [];
  const runtime = {
    images: { app: 'IMG' },
    start: (options: unknown) => calls.push(options),
    running: true,
    ping() {
      return this.running;
    },
  };
  const app = make({}, runtime);
  const proxied = (app as unknown as { container: typeof runtime }).container;
  proxied.start({ env: { A: '1' } } as never);
  assert.deepEqual(calls[0], { env: { A: '1' }, image: 'IMG', instance: 'standard-1' });
  assert.equal(proxied.ping(), true);
});

test('the worker sends fetch to the named instance and checks /readyz on schedule', async () => {
  const seen: Array<{ name: string; hint?: string; url: string }> = [];
  const env = {
    MISTRI_PUBLIC_URL: 'https://app.test',
    APP: {
      idFromName: (name: string) => name,
      get: (id: string, options?: { locationHint?: string }) => ({
        fetch: async (request: Request) => {
          seen.push({ name: id, hint: options?.locationHint, url: request.url });
          return new Response('ok', { status: request.url.endsWith('/readyz') ? 200 : 201 });
        },
      }),
    },
  };
  const worker = mistriWorker({ binding: 'APP', instance: 'app-1', location: 'enam' });
  assert.equal((await worker.fetch(new Request('https://app.test/x'), env)).status, 201);
  await worker.scheduled(undefined, env);
  assert.deepEqual(seen, [
    { name: 'app-1', hint: 'enam', url: 'https://app.test/x' },
    { name: 'app-1', hint: 'enam', url: 'https://app.test/readyz' },
  ]);
  assert.throws(
    () => mistriWorker({ binding: 'NOPE', instance: 'a' }).fetch(new Request('https://x/'), env),
    /no Durable Object binding "NOPE"/,
  );
});

test('the mail forwarder signs <timestamp>.<body> with HMAC-SHA-256 and maps the answer', async () => {
  assert.equal(await signMail('k', '1', 'body'), `v1=${createHmac('sha256', 'k').update('1.body').digest('hex')}`);
  let sent: Request | undefined;
  let status = 200;
  const env = {
    MISTRI_PUBLIC_URL: 'https://app.test',
    MAIL_SECRET: 'secret',
    APP: {
      idFromName: (n: string) => n,
      get: () => ({ fetch: async (request: Request) => ((sent = request), new Response(null, { status })) }),
    },
  };
  const rejected: string[] = [];
  const message = { to: 'help@app.test', raw: new ReadableStream<Uint8Array>(), setReject: (why: string) => rejected.push(why) };
  const parse = async () => ({
    from: { address: 'a@b.test' },
    subject: 'Hi',
    headers: [{ key: 'x', value: 'y' }],
    attachments: [{ filename: null, mimeType: 'text/plain', content: 'c' }],
  });
  const options = { binding: 'APP', instance: 'app-1', secretEnv: 'MAIL_SECRET', parse };
  await forwardEmail(message, env, options);
  const body = await sent!.text();
  assert.equal(new URL(sent!.url).pathname, '/api/mail/inbound');
  const timestamp = sent!.headers.get('x-mistri-timestamp')!;
  assert.equal(
    sent!.headers.get('x-mistri-signature'),
    `v1=${createHmac('sha256', 'secret').update(`${timestamp}.${body}`).digest('hex')}`,
  );
  assert.deepEqual(JSON.parse(body).attachments, [{ name: 'attachment', type: 'text/plain', content: 'c' }]);
  assert.equal(JSON.parse(body).recipient, 'help@app.test');
  status = 404;
  await forwardEmail(message, env, { ...options, path: '/in' });
  assert.equal(new URL(sent!.url).pathname, '/in');
  status = 413;
  await forwardEmail(message, env, options);
  assert.deepEqual(rejected, ['No such mailbox', 'Message too large']);
  rejected.length = 0;
  // Taken, dropped and logged, and a replay of a delivery already taken finish quietly.
  for (const done of [200, 202, 204, 409]) {
    status = done;
    await forwardEmail(message, env, options);
  }
  assert.deepEqual(rejected, []);
  // The message's own fault is rejected with a reason; nothing else finishes quietly.
  for (const [refused, why] of [
    [400, 'Message could not be processed'],
    [422, 'Message could not be processed'],
  ] as const) {
    status = refused;
    await forwardEmail(message, env, options);
    assert.equal(rejected.pop(), why);
  }
  for (const failed of [301, 401, 403, 408, 429, 500, 503]) {
    status = failed;
    await assert.rejects(forwardEmail(message, env, options), new RegExp(`answered ${failed}`));
  }
  status = 401;
  await assert.rejects(forwardEmail(message, env, options), /signing secret/);
  assert.deepEqual(rejected, []);
  await assert.rejects(forwardEmail(message, { ...env, MAIL_SECRET: undefined }, options), /MAIL_SECRET is not set/);
});

/** A Durable Object context whose container is running, with storage that remembers. */
function upgradable(env: Record<string, unknown>, images: Record<string, unknown> = { app: 'IMG-2' }, aborts: string[] = []) {
  const kv = new Map<string, unknown>();
  const runtime = {
    images,
    running: true,
    inspect: async () => ({ image: 'IMG-1' }),
    start: () => undefined,
  };
  const app = make({ MISTRI_RESTART_TOKEN: TOKEN, ...env }, runtime);
  (app.ctx as { storage: unknown }).storage = undefined;
  const storage = { get: async (k: string) => kv.get(k), put: async (k: string, v: unknown) => void kv.set(k, v) };
  const abort = (reason?: string) => {
    aborts.push(reason ?? '');
    throw new Error('aborted');
  };
  const rebuilt = new App({ container: runtime, storage, abort } as never, { MISTRI_RESTART_TOKEN: TOKEN, ...env }) as App &
    Record<string, any>;
  return { app: rebuilt, runtime, kv };
}
const get = (path = '/') => new Request(`https://app.test${path}`);
const probe = () => new Request('https://app.test/__mistri/status', { headers: { 'x-mistri-restart': TOKEN } });

test('a request replaces a healthy container that was started with another deploy, once', async () => {
  const { app, kv } = upgradable({ MISTRI_DEPLOY_ID: 'new' });
  await app.onStart();
  assert.equal((kv.get('mistri:started') as { deployId: string }).deployId, 'new');
  await app.fetch(get());
  assert.equal(app.destroyed, 0, 'the container already runs what this Worker version wants');
  kv.set('mistri:started', { image: 'IMG-2', deployId: 'old', instanceType: 'standard-1', at: 't' });
  (app as any).recorded = undefined;
  await app.fetch(get());
  assert.equal(app.destroyed, 1);
  /* No storm: the next requests inside the minute, from the same stale record, replace nothing more. */
  await Promise.all([app.fetch(get()), app.fetch(get()), app.fetch(get('/x'))]);
  assert.equal(app.destroyed, 1);
});

test('the scheduled tick upgrades through the same path, and a changed image or instance type counts', async () => {
  const stale = { image: 'IMG-1', deployId: 'new', instanceType: 'standard-1', at: 't' };
  const { app, kv } = upgradable({ MISTRI_DEPLOY_ID: 'new' });
  kv.set('mistri:started', stale);
  const env = {
    APP: { idFromName: (n: string) => n, get: () => ({ fetch: (r: Request) => app.fetch(r) }) },
    MISTRI_PUBLIC_URL: 'https://app.test',
  };
  await mistriWorker({ binding: 'APP', instance: 'a' }).scheduled(undefined, env);
  assert.equal(app.destroyed, 1, 'the image differs although the deploy id does not');
  const typed = upgradable({ MISTRI_DEPLOY_ID: 'new' });
  typed.kv.set('mistri:started', { ...stale, image: 'IMG-2', instanceType: 'basic' });
  await typed.app.fetch(get());
  assert.equal(typed.app.destroyed, 1, 'the instance type differs');
  /* A container with no record was started before the Durable Object kept one: replaced once. */
  const unrecorded = upgradable({ MISTRI_DEPLOY_ID: 'new' });
  await unrecorded.app.fetch(get());
  assert.equal(unrecorded.app.destroyed, 1);
});

test('a container that is still starting, stopped or not asked about a deploy is left alone', async () => {
  const stale = { image: 'IMG-2', deployId: 'old', instanceType: 'standard-1', at: 't' };
  const starting = upgradable({ MISTRI_DEPLOY_ID: 'new' });
  starting.kv.set('mistri:started', stale);
  starting.app.containerStatus = 'running';
  await starting.app.fetch(get());
  assert.equal(starting.app.destroyed, 0);
  const stopped = upgradable({ MISTRI_DEPLOY_ID: 'new' });
  stopped.kv.set('mistri:started', stale);
  stopped.runtime.running = false;
  await stopped.app.fetch(get());
  assert.equal(stopped.app.destroyed, 0);
  const local = upgradable({}, {});
  await local.app.fetch(get());
  assert.equal(local.app.destroyed, 0, 'nothing is wanted, so nothing differs');
});

test('the status probe is gated by the token and answers what is desired, started and running', async () => {
  const { app, kv } = upgradable({ MISTRI_DEPLOY_ID: 'new', CF_VERSION_METADATA: { id: 'ver-1' } });
  kv.set('mistri:started', { image: 'IMG-2', deployId: 'new', instanceType: 'standard-1', at: '2026-10-29T00:00:00.000Z' });
  assert.equal(isProbe(probe(), { MISTRI_RESTART_TOKEN: TOKEN }), true);
  assert.equal(
    isProbe(new Request('https://x/__mistri/status', { method: 'POST', headers: { 'x-mistri-restart': TOKEN } }), {
      MISTRI_RESTART_TOKEN: TOKEN,
    }),
    false,
  );
  assert.equal(isProbe(new Request('https://x/', { headers: { 'x-mistri-restart': TOKEN } }), { MISTRI_RESTART_TOKEN: TOKEN }), false);
  assert.equal(await (await app.fetch(new Request('https://app.test/__mistri/status'))).text(), 'from the container');
  assert.deepEqual(await (await app.fetch(probe())).json(), {
    workerVersion: 'ver-1',
    desired: { image: 'IMG-2', deployId: 'new' },
    startedWith: { image: 'IMG-2', deployId: 'new', at: '2026-10-29T00:00:00.000Z' },
    container: { running: true, image: 'IMG-1' },
  });
  const bare = upgradable({ MISTRI_DEPLOY_ID: 'new' }, {});
  assert.deepEqual(await (await bare.app.fetch(probe())).json(), {
    workerVersion: null,
    desired: { image: null, deployId: 'new' },
    startedWith: null,
    container: { running: true, image: 'IMG-1' },
  });
});

test('the Worker stamps its version on the token-carrying probe and the tick only, and drops a client copy', async () => {
  const seen: Array<string | null> = [];
  const env = {
    MISTRI_PUBLIC_URL: 'https://app.test',
    MISTRI_RESTART_TOKEN: TOKEN,
    CF_VERSION_METADATA: { id: 'v2', timestamp: '2026-10-30T05:00:00.000Z' },
    APP: {
      idFromName: (n: string) => n,
      get: () => ({ fetch: async (r: Request) => (seen.push(r.headers.get('x-mistri-worker-version')), new Response('ok')) }),
    },
  };
  const worker = mistriWorker({ binding: 'APP', instance: 'a' });
  await worker.fetch(probe(), env);
  await worker.scheduled(undefined, env);
  await worker.fetch(get('/x'), env);
  await worker.fetch(new Request('https://app.test/x', { headers: { 'x-mistri-worker-version': 'forged 2099-01-01' } }), env);
  // A visitor's status request, without the token or with a wrong one, is not stamped: it cannot reset the object.
  await worker.fetch(get('/__mistri/status'), env);
  await worker.fetch(new Request('https://app.test/__mistri/status', { headers: { 'x-mistri-restart': 'b'.repeat(40) } }), env);
  await worker.fetch(new Request('https://app.test/__mistri/status', { headers: { 'x-mistri-worker-version': 'forged 2099-01-01' } }), env);
  assert.deepEqual(seen, ['v2 2026-10-30T05:00:00.000Z', 'v2 2026-10-30T05:00:00.000Z', null, null, null, null, null]);
  // A project that names its own token secret names it to the Worker too.
  seen.length = 0;
  const own = mistriWorker({ binding: 'APP', instance: 'a', restartTokenEnv: 'OWN_TOKEN' });
  await own.fetch(probe(), { ...env, MISTRI_RESTART_TOKEN: undefined, OWN_TOKEN: TOKEN });
  await own.fetch(probe(), env);
  assert.deepEqual(seen, ['v2 2026-10-30T05:00:00.000Z', null]);
});

test('a Durable Object behind a newer Worker resets itself, once per gap, and never for an older one', async () => {
  const own = { id: 'v1', timestamp: '2026-10-30T04:00:00.000Z' };
  const aborts: string[] = [];
  const { app, kv } = upgradable({ MISTRI_DEPLOY_ID: 'd', CF_VERSION_METADATA: own }, undefined, aborts);
  await app.onStart();
  const stampedBy = (value: string) => new Request('https://app.test/readyz', { headers: { 'x-mistri-worker-version': value } });
  await assert.rejects(app.fetch(stampedBy('v2 2026-10-30T05:00:00.000Z')), /aborted/);
  assert.deepEqual(aborts, ['Worker version v2 is live']);
  assert.equal(typeof kv.get('mistri:reset-at'), 'number');
  /* Inside the gap a second stamp passes through: the object the platform started again is still old. */
  assert.equal(await (await app.fetch(stampedBy('v2 2026-10-30T05:00:00.000Z'))).text(), 'from the container');
  kv.set('mistri:reset-at', 0);
  for (const value of ['v0 2026-10-30T03:00:00.000Z', 'v1 2026-10-30T04:00:00.000Z', 'v2', '']) {
    assert.equal(await (await app.fetch(stampedBy(value))).text(), 'from the container', `no reset for "${value}"`);
  }
  assert.equal(aborts.length, 1);
});
