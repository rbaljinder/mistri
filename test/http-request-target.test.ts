/** Malformed raw request targets must not escape the HTTP server's error boundary. */
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { test } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';

function raw(port: number, target: string, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let reply = '';
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy(new Error('HTTP response timed out.')));
    socket.on('error', reject);
    socket.on('data', (data) => {
      reply += data;
    });
    socket.on('end', () => resolve(reply));
    socket.on('connect', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
  });
}

test('malformed targets return a bounded 400 and leave the server responsive', { timeout: 15000 }, async (t) => {
  const registry = new Registry(),
    bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await registry.closeAll();
  });
  await new Promise<void>((resolve) => server.listen(0, bound.host, resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  for (const target of ['//[', '//]', 'http://[', 'http://%']) {
    // These pass Node's HTTP parser but fail URL parsing. Even an untrusted
    // Host used to reach the synchronous throw before the admission gate.
    const refusal = await raw(bound.port, target, 'attacker.example');
    assert.match(refusal, /^HTTP\/1\.1 400 /, target);
    assert.equal(refusal.slice(refusal.indexOf('\r\n\r\n') + 4), '{"error":"Invalid request target."}');
    const healthy = await raw(bound.port, '/api/connections', `127.0.0.1:${bound.port}`);
    assert.match(healthy, /^HTTP\/1\.1 200 /);
    assert.deepEqual(JSON.parse(healthy.slice(healthy.indexOf('\r\n\r\n') + 4)).connections, []);
  }
});
