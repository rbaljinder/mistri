/**
 * Every HTTP server tablewalk creates keeps idle connections longer than the
 * proxies in front of it, and bounds slow headers and bodies, through one
 * helper rather than numbers repeated per server.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, createServer, get as httpGet } from 'node:http';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { applyServerTimeouts, HEADERS_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS } from '../packages/engine/src/server/serverTimeouts.js';

test('keep-alive outlives a proxy idle minute, and the headers timeout stays above it', () => {
  const server = applyServerTimeouts(createServer());
  assert.equal(server.keepAliveTimeout, KEEP_ALIVE_TIMEOUT_MS);
  assert.ok(server.keepAliveTimeout > 60_000, 'longer than a typical proxy or load balancer idle timeout');
  assert.equal(server.headersTimeout, HEADERS_TIMEOUT_MS);
  assert.ok(server.headersTimeout > server.keepAliveTimeout);
  assert.equal(server.requestTimeout, 600_000);
});

test('every server tablewalk creates applies them and sets none of its own', () => {
  for (const file of [
    'packages/engine/src/server/http/serverCore.ts',
    'packages/mistri/src/server/tenant/tenantHttp.ts',
    'packages/mistri/src/server/tenant/tenantAuthenticatedHttp.ts',
  ]) {
    const text = readFileSync(file, 'utf8');
    assert.match(text, /applyServerTimeouts\(server\)/, file);
    assert.doesNotMatch(text, /\.(keepAliveTimeout|headersTimeout|requestTimeout)\s*=/, `${file} sets no timeout of its own`);
  }
});

test('close() does not wait out keep-alive on a response that finished after it ran', async () => {
  const server = applyServerTimeouts(
    createServer((_req, res) => {
      setTimeout(() => res.end('ok'), 200);
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const agent = new Agent({ keepAlive: true });
  try {
    const answered = new Promise<string | undefined>((resolve, reject) => {
      httpGet({ port: (server.address() as { port: number }).port, host: '127.0.0.1', agent }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.headers.connection));
      }).on('error', reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    assert.equal(await answered, 'keep-alive', 'the in-flight response kept its socket, as Node does');
    await closed;
    assert.ok(Date.now() - started < 2_000, `close took ${Date.now() - started} ms`);
  } finally {
    agent.destroy();
  }
});

test("the request listener stays the server's only one", () => {
  const server = applyServerTimeouts(createServer(() => {}));
  assert.equal(server.listenerCount('request'), 1, 'the tenant and flag servers wrap exactly one');
});

test('close() does not wait on a connection that never sent a request', async () => {
  const server = applyServerTimeouts(createServer((_req, res) => res.end('ok')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  /* A browser's spare connection: open, and silent. */
  const spare = connect((server.address() as { port: number }).port, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => spare.once('connect', () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.ok(Date.now() - started < 2_000, `close took ${Date.now() - started} ms`);
  } finally {
    spare.destroy();
  }
});
