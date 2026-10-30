/**
 * A server published at an https address (MISTRI_PUBLIC_URL) stands behind a
 * TLS front end that forwards plain http, from a peer nobody can name in
 * `--trust-proxy` (Cloudflare's, Cloud Run's). Its requests count as https
 * (trust.ts `arrivedOverHttps`): one rule for a Secure cookie, the transport
 * pin and the origin a page writes.
 */
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test, type TestContext } from 'node:test';
import { defaultServerSettings, withServerSettings } from '../packages/engine/src/adapters/serverSettings.js';
import { setBaselineHeaders, STRICT_TRANSPORT } from '../packages/engine/src/server/http/baselineHeaders.js';
import { requestOrigin } from '../packages/engine/src/server/http/requestOrigin.js';
import { httpsAddress, parseTrustedProxies } from '../packages/engine/src/server/http/trust.js';
import { secureRequest } from '../packages/mistri/src/server/forms/savedForms.js';
import { policyServer } from './support/policyServer.js';

/** A request a front end forwarded: plain http, from a peer that is not this machine and that nobody listed. */
const forwarded = (headers: Record<string, string> = {}) =>
  ({ headers: { host: 'app.example.com', ...headers }, socket: { remoteAddress: '198.51.100.7' } }) as unknown as IncomingMessage;

function pinned(req: IncomingMessage, trusted: ReturnType<typeof parseTrustedProxies>['ranges'] = []): string | undefined {
  const headers = new Map<string, string>();
  setBaselineHeaders(
    req,
    { setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value) } as unknown as ServerResponse,
    trusted,
  );
  return headers.get('strict-transport-security');
}

const front = { ...defaultServerSettings(), httpsFront: true };

test('behind an https public address a forwarded request is https: Secure cookies, the pin, an https origin', () => {
  withServerSettings(front, () => {
    const req = forwarded();
    assert.equal(secureRequest(req), true);
    assert.equal(pinned(req), STRICT_TRANSPORT);
    assert.equal(requestOrigin(req, {}), 'https://app.example.com');
  });
});

test('without one the same request is plain http, unless a trusted proxy says it forwarded https', () => {
  withServerSettings(defaultServerSettings(), () => {
    const req = forwarded();
    assert.equal(secureRequest(req), false);
    assert.equal(pinned(req), undefined);
    assert.equal(requestOrigin(req, {}), 'http://app.example.com');
    // The client's own claim is not believed from a peer nobody listed...
    const claimed = forwarded({ 'x-forwarded-proto': 'https' });
    assert.equal(secureRequest(claimed), false);
    assert.equal(pinned(claimed), undefined);
    // ...and is from one the operator named.
    const trusted = parseTrustedProxies(['198.51.100.0/24']).ranges;
    assert.equal(secureRequest(claimed, trusted), true);
    assert.equal(pinned(claimed, trusted), STRICT_TRANSPORT);
    assert.equal(requestOrigin(claimed, { trustedProxies: trusted }), 'https://app.example.com');
    // This machine keeps a Secure cookie over plain http.
    assert.equal(secureRequest({ headers: { host: 'localhost:4000' }, socket: {} } as unknown as IncomingMessage), true);
  });
});

test('only an https address counts as one', () => {
  for (const url of ['https://app.example.com', ' https://app.example.com/desk ', 'HTTPS://APP.EXAMPLE.COM'])
    assert.equal(httpsAddress(url), true, url);
  for (const url of [undefined, '', 'http://app.example.com', 'app.example.com', 'https//app.example.com'])
    assert.equal(httpsAddress(url), false, String(url));
});

test('mistri started with an https MISTRI_PUBLIC_URL pins https on what it answers over plain http', async (t: TestContext) => {
  const server = await policyServer(t, {
    app: { id: 'shelf', name: 'Shelf', resources: { item: {} }, views: { items: { kind: 'list', from: 'item' } }, home: 'items' },
    sql: "CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO item VALUES (1, 'Lamp');",
    env: { MISTRI_PUBLIC_URL: 'https://shelf.example.com', MISTRI_ALLOWED_HOSTS: '127.0.0.1' },
  });
  const answer = await fetch(`${server.origin}/healthz`);
  await answer.arrayBuffer();
  assert.equal(answer.headers.get('strict-transport-security'), STRICT_TRANSPORT);
});
