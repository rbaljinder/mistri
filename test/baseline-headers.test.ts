/**
 * Every answer carries the referrer and permissions policies, and the
 * transport pin only when it arrived over https (http/baselineHeaders.ts).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from './support/createApp.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { PERMISSIONS_POLICY, REFERRER_POLICY, STRICT_TRANSPORT } from '../packages/engine/src/server/http/baselineHeaders.js';
import { makeDemoDatabase } from './make-demo-db.js';

let tmp: string;
let server: Server;
let origin = '';

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'tablewalk-baseline-headers-'));
  const db = join(tmp, 'demo.db');
  makeDemoDatabase(db);
  const registry = new Registry();
  registry.add({ name: 'demo', url: db, source: 'config' });
  registry.setActive('demo');
  await registry.open('demo');
  server = createApp({ registry, bound: { host: '127.0.0.1', port: 0 } });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server?.close();
  server?.closeAllConnections();
  rmSync(tmp, { recursive: true, force: true });
});

test('a page, an API answer and a refusal each carry the referrer and permissions policies', async () => {
  for (const path of ['/', '/api/connections', '/api/no-such-route']) {
    const res = await fetch(`${origin}${path}`);
    await res.arrayBuffer();
    assert.equal(res.headers.get('referrer-policy'), REFERRER_POLICY, path);
    assert.equal(res.headers.get('permissions-policy'), PERMISSIONS_POLICY, path);
    assert.match(PERMISSIONS_POLICY, /camera=\(\).*microphone=\(\).*geolocation=\(\)/);
    // Plain http: nothing pins this name to https.
    assert.equal(res.headers.get('strict-transport-security'), null, path);
  }
});

test('the transport pin is sent only where a trusted proxy says it forwarded https', async () => {
  // From loopback, a proxy on this machine (trust.ts trustedProxyPeer).
  const proxied = await fetch(`${origin}/api/connections`, { headers: { 'x-forwarded-proto': 'https' } });
  await proxied.arrayBuffer();
  assert.equal(proxied.headers.get('strict-transport-security'), STRICT_TRANSPORT);
  const plain = await fetch(`${origin}/api/connections`, { headers: { 'x-forwarded-proto': 'http' } });
  await plain.arrayBuffer();
  assert.equal(plain.headers.get('strict-transport-security'), null);
});
