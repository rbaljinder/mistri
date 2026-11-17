/**
 * @mistriwork/cloudflare/host-certificates against a fake Cloudflare API on a loopback port: a request adds a custom
 * hostname with HTTP validation and a DV certificate, the state is read back until active, a second request reads
 * rather than adds, release deletes it, and neither the zone nor the token ever appears in an error.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { cloudflareHostCertificates } from '../packages/cloudflare/src/hostCertificates.js';

const ZONE = '0123456789abcdef0123456789abcdef';
const TOKEN = 'cf-token-that-must-never-leak';
const TENANT = 'acme';

interface Row {
  id: string;
  hostname: string;
  ssl: { status: string };
  custom_metadata?: Record<string, unknown>;
}
const rows = new Map<string, Row>();
const seen: { method: string; url: string; auth: string | undefined; body: unknown }[] = [];
let failNext: number | null = null;

const read = async (req: IncomingMessage) => {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : undefined;
};
const server = createServer(async (req, res) => {
  const body = await read(req);
  seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
  const send = (status: number, payload: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  if (failNext !== null) {
    const status = failNext;
    failNext = null;
    return send(status, { success: false, errors: [{ code: 10000, message: `Authentication error for zone ${ZONE}` }] });
  }
  const url = new URL(req.url!, 'http://fake');
  const prefix = `/client/v4/zones/${ZONE}/custom_hostnames`;
  if (!url.pathname.startsWith(prefix)) return send(404, { success: false, errors: [{ code: 7003 }] });
  const rest = url.pathname.slice(prefix.length);
  if (req.method === 'GET' && !rest) {
    const host = url.searchParams.get('hostname');
    return send(200, { success: true, result: [...rows.values()].filter((row) => row.hostname === host) });
  }
  if (req.method === 'POST' && !rest) {
    const row = {
      id: `id-${rows.size + 1}`,
      hostname: body.hostname,
      ssl: { status: 'pending_validation' },
      custom_metadata: body.custom_metadata,
    };
    rows.set(row.id, row);
    return send(200, { success: true, result: row });
  }
  if (req.method === 'DELETE' && rest.startsWith('/')) {
    rows.delete(decodeURIComponent(rest.slice(1)));
    return send(200, { success: true, result: { id: rest.slice(1) } });
  }
  return send(405, { success: false, errors: [{ code: 10405 }] });
});
let apiBase = '';
before(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`;
});
after(() => server.close());

const ours = { mistri: 'mistri-tenant-domain', tenant: TENANT };
const certificates = () => cloudflareHostCertificates({ environment: { CLOUDFLARE_ZONE_ID: ZONE, CLOUDFLARE_API_TOKEN: TOKEN }, apiBase });

test('request adds a custom hostname with HTTP validation and a DV certificate, read back until active', async () => {
  rows.clear();
  seen.length = 0;
  const provider = certificates();
  assert.equal(await provider.request('shop.example.com', TENANT), 'pending');
  const post = seen.find((call) => call.method === 'POST')!;
  // Marked as mistri's and the tenant's, so a release can tell this hostname from one someone else made in the zone.
  assert.deepEqual(post.body, {
    hostname: 'shop.example.com',
    ssl: { method: 'http', type: 'dv' },
    custom_metadata: { mistri: 'mistri-tenant-domain', tenant: TENANT },
  });
  assert.equal(post.auth, `Bearer ${TOKEN}`);
  assert.equal(await provider.status('shop.example.com', TENANT), 'pending');
  [...rows.values()][0]!.ssl.status = 'active';
  assert.equal(await provider.status('shop.example.com', TENANT), 'active');
  // Asked again (a restart, a restored suspension), it reads the hostname rather than adding a second.
  assert.equal(await provider.request('shop.example.com', TENANT), 'active');
  assert.equal(seen.filter((call) => call.method === 'POST').length, 1);
  // Another host's row never answers for this one.
  assert.equal(await provider.status('other.example.com', TENANT), 'failed');
});

test('a certificate that timed out is failed, not pending', async () => {
  rows.clear();
  rows.set('x', { id: 'x', hostname: 'late.example.com', ssl: { status: 'validation_timed_out' }, custom_metadata: ours });
  assert.equal(await certificates().status('late.example.com', TENANT), 'failed');
});

test('release deletes the hostname by its id, and releasing one that is gone is quiet', async () => {
  rows.clear();
  const provider = certificates();
  await provider.request('gone.example.com', TENANT);
  await provider.release('gone.example.com', TENANT);
  assert.equal(rows.size, 0);
  await provider.release('gone.example.com', TENANT);
});

test('an error names the host, the status and the codes, never the zone or the token', async () => {
  failNext = 403;
  await assert.rejects(certificates().request('shop.example.com', TENANT), (error: Error) => {
    assert.match(error.message, /shop\.example\.com/);
    assert.match(error.message, /403/);
    assert.match(error.message, /10000/);
    assert.doesNotMatch(error.message, new RegExp(`${ZONE}|${TOKEN}`));
    return true;
  });
  const unreachable = cloudflareHostCertificates({
    environment: { CLOUDFLARE_ZONE_ID: ZONE, CLOUDFLARE_API_TOKEN: TOKEN },
    apiBase: 'http://127.0.0.1:1/client/v4',
  });
  await assert.rejects(
    unreachable.status('shop.example.com', TENANT),
    (error: Error) => !error.message.includes(TOKEN) && !error.message.includes(ZONE),
  );
});

test('a missing or malformed zone or token is refused at start, by name only', () => {
  assert.throws(() => cloudflareHostCertificates({ environment: {} }), /CLOUDFLARE_ZONE_ID and CLOUDFLARE_API_TOKEN/);
  assert.throws(
    () => cloudflareHostCertificates({ environment: { CLOUDFLARE_ZONE_ID: 'zone/../../x', CLOUDFLARE_API_TOKEN: TOKEN } }),
    (error: Error) =>
      /not a Cloudflare zone id/.test(error.message) && !error.message.includes(TOKEN) && !error.message.includes('zone/..'),
  );
});

test("release deletes only a hostname that carries mistri's mark and the tenant's id; anyone else's is left in the zone", async () => {
  rows.clear();
  seen.length = 0;
  const provider = certificates();
  // Made by someone else with the zone's token: no mark. Made by mistri for another tenant: another's id.
  rows.set('theirs', { id: 'theirs', hostname: 'theirs.example.com', ssl: { status: 'active' } });
  rows.set('other', {
    id: 'other',
    hostname: 'other.example.com',
    ssl: { status: 'active' },
    custom_metadata: { mistri: 'mistri-tenant-domain', tenant: 'someone-else' },
  });
  await provider.release('theirs.example.com', TENANT);
  await provider.release('other.example.com', TENANT);
  assert.deepEqual([...rows.keys()], ['theirs', 'other']);
  assert.equal(seen.filter((call) => call.method === 'DELETE').length, 0);
  // Nor is a foreign hostname read as this domain's certificate, or taken over by asking for one.
  assert.equal(await provider.status('theirs.example.com', TENANT), 'failed');
  await assert.rejects(provider.request('theirs.example.com', TENANT), /already holds theirs\.example\.com/);
  assert.equal(seen.filter((call) => call.method === 'POST').length, 0);
  // The tenant's own is deleted.
  await provider.request('mine.example.com', TENANT);
  await provider.release('mine.example.com', TENANT);
  assert.deepEqual([...rows.keys()], ['theirs', 'other']);
});
