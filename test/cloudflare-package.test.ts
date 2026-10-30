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
const { MistriContainer, mistriWorker, forwardEmail, signMail, isRestart, containerEnv } =
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
  status = 503;
  await assert.rejects(forwardEmail(message, env, options), /answered 503/);
  await assert.rejects(forwardEmail(message, { ...env, MAIL_SECRET: undefined }, options), /MAIL_SECRET is not set/);
});
