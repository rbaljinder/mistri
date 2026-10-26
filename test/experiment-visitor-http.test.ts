/** Visitor opt-in is POST-only and publishes only after public ownership releases. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createExperimentVisitorIdentity } from '../packages/mistri/src/server/experiments/visitorIdentity.js';
import { createExperimentVisitorHttp } from '../packages/mistri/src/server/experiments/visitorHttp.js';

test('explicit public opt-in, CSRF refusal and ownership loss never leak identity', async (t) => {
  let route: ReturnType<typeof createExperimentVisitorHttp> | undefined;
  const server = createServer((req, res) => {
    void route!(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closing = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    server.closeAllConnections();
    await closing;
  });
  const port = (server.address() as { port: number }).port,
    origin = `http://127.0.0.1:${port}`;
  let retired = false,
    signedIn = false;
  route = createExperimentVisitorHttp({
    appId: 'shop',
    mount: '',
    bound: { host: '127.0.0.1', port },
    identity: createExperimentVisitorIdentity({
      binding: { suiteId: 'suite', deploymentId: 'test' },
      appId: 'shop',
      environment: 'test',
      key: new Uint8Array(32).fill(2),
      mount: '',
      secure: false,
    }),
    async withPublic(req, _res, _guard, use) {
      await use({ request: req, accountId: (signedIn ? 'subject' : null) as null, current: async () => {}, assertCurrent() {} });
      if (retired) throw new Error('Owner retired before release.');
    },
  });
  const address = `${origin}/api/experiments/visitor`;
  const post = (headers = {}, body = '{}') =>
    fetch(address, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'x-mistri-visitor': 'establish',
        ...headers,
      },
      body,
    });
  const get = await fetch(address);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('set-cookie'), null);
  const created = await post();
  assert.equal(created.status, 200);
  assert.deepEqual(await created.json(), { ready: true });
  assert.ok(created.headers.get('set-cookie'));
  const cookie = created.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await post({ cookie })).headers.get('set-cookie'), null);
  for (const response of [
    await post({ origin: 'https://foreign.invalid' }),
    await post({ 'x-mistri-visitor': '' }),
    await post({}, '{"visitorId":"forged"}'),
  ]) {
    assert.ok([400, 403].includes(response.status));
    assert.equal(response.headers.get('set-cookie'), null);
  }
  signedIn = true;
  assert.equal((await post()).status, 403);
  signedIn = false;
  retired = true;
  const lost = await post();
  assert.equal(lost.status, 503);
  assert.equal(lost.headers.get('set-cookie'), null);
});
