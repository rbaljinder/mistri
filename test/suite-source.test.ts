/** A source suite's real Vite transport belongs to the listening server. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { createSuite } from '../packages/mistri/src/server/http/suite.js';

test('root and child source pages share a live HMR transport which shuts down with the suite', { timeout: 30_000 }, async (t) => {
  const bound = { host: '127.0.0.1', port: 0 };
  const suite = await createSuite(
    ['root', 'sub'].map((id) => ({
      id,
      open: async (basePath: string) => {
        const registry = new Registry();
        return {
          server: createApp({ registry, bound, addresses: { base: basePath }, sourceClient: false }),
          stop: async () => {},
          close: () => registry.closeAll(),
        };
      },
    })),
    { mounts: { root: '', sub: 'sub' } },
  );
  t.after(() => suite.close());
  await new Promise<void>((resolve) => suite.server.listen(0, '127.0.0.1', resolve));
  bound.port = (suite.server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${bound.port}`;
  for (const path of ['/', '/sub/']) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /@vite\/client/);
  }
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/`, 'vite-hmr');
  t.after(() => socket.close());
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('Shared source HMR did not open')), { once: true });
  });
  const disconnected = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve(), { once: true }));
  await suite.close();
  await disconnected;
  assert.equal(suite.server.listening, false);
});
