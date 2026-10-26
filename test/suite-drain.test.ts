/** Suite-owned HTTP requests stay leased even when they are not command routes. */
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import { commandOperations, createApp } from './support/createApp.js';

test('suite drain tracks an ordinary POST while its body is still arriving', async () => {
  const registry = new Registry();
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, sourceClient: false, drainRequests: true });
  await new Promise<void>((resolve) => server.listen(0, bound.host, resolve));
  bound.port = (server.address() as { port: number }).port;
  const req = request({
    host: bound.host,
    port: bound.port,
    method: 'POST',
    path: '/api/unknown',
    headers: { origin: `http://${bound.host}:${bound.port}`, 'content-type': 'application/json', 'content-length': '1024' },
  });
  req.on('error', () => {}); // Deliberately abandoned, like a disconnected form caller.
  try {
    req.write('{');
    const pending = commandOperations.get(server);
    assert.ok(pending);
    for (let i = 0; i < 100 && pending.size === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(pending.size, 1, 'ordinary requests must have a drain lease, not only /api/commands');
  } finally {
    req.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await registry.closeAll();
  }
});
