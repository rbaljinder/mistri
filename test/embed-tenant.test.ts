/**
 * A host's sign-in in a tenant App, on the real tenant host
 * (support/tenantSupportFixture.ts): the exchange opens the account's
 * session as any sign-in does, and gives no membership — a tenant opens only
 * once the tenant store says the account belongs to it. From a host's page on
 * another origin the tenant host holds the ordinary server's rules: CORS for
 * the listed origins only, a bearer that stands for the session only from
 * the origin it was given to, JSON for every write, and a cookie that never
 * stands for anyone cross-origin.
 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { TENANT_HTTP_HEADERS as headers, type TenantContextReply } from '../packages/mistri/src/shared/tenantContext.js';
import { embedConnectionOf } from '../packages/mistri/src/server/embed/issuerConfig.js';
import { mintEmbedAssertion } from '../packages/mistri/src/server/embed/mint.js';
import { appId, tenantSupportFixture } from './support/tenantSupportFixture.js';

const SECRET = 'tenant-host-assertion-secret-of-forty-bytes';
/** The host's own page, on another origin. */
const HOST = 'http://localhost:5999';
const STRANGER = 'http://localhost:6111';

async function fixture(t: TestContext, accounts?: 'link-verified-email') {
  process.env.TEST_EMBED_TENANT_SECRET = SECRET;
  t.after(() => {
    delete process.env.TEST_EMBED_TENANT_SECRET;
  });
  return tenantSupportFixture(t, 'sqlite', {
    embed: (origin) => [
      embedConnectionOf(
        {
          name: 'dealer-portal',
          kind: 'embed',
          issuer: 'https://dealers.example',
          secret: '${TEST_EMBED_TENANT_SECRET}',
          origins: [origin, HOST],
          ...(accounts ? { accounts } : {}),
        },
        'test',
      ),
    ],
  });
}

const cookieOf = (answer: { headers: Headers }) =>
  answer.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');

test('a host signs a person into a tenant App: signed in, and a member of nothing the tenant store does not say', async (t) => {
  const f = await fixture(t);
  const assertion = await mintEmbedAssertion({
    issuer: 'https://dealers.example',
    key: SECRET,
    app: appId,
    origin: f.origin,
    subject: 'dealer-kim',
    email: 'kim@north.example',
    emailVerified: true,
  });
  const signed = await f.call('/api/auth/embed/exchange', { body: { assertion } });
  assert.equal(signed.status, 200, signed.text);
  const cookie = cookieOf(signed);
  const me = await f.call(`/api/whoami?app=${appId}`, { headers: { cookie } });
  assert.equal(me.body.signedIn, true, me.text);
  assert.equal(me.body.who, 'kim@north.example');
  const accountId = String(me.body.accountId);

  // Signed in, and a member of nothing: the exchange made no membership.
  const own = { cookie, [headers.account]: accountId };
  const shut = await f.call(`/api/tenant/context/open?app=${appId}&tenant=north`, { body: {}, headers: own });
  assert.equal(shut.body.code, 'tenant_context_unavailable', shut.text);
  await f.maintenance(async (admin) =>
    admin.putMembership({
      tenantId: 'north',
      accountId,
      membershipId: 'north-kim',
      status: 'active',
      roles: ['dealer_staff'],
      validUntil: Date.now() + 3600000,
      expectedVersion: null,
    }),
  );
  const opened = await f.call(`/api/tenant/context/open?app=${appId}&tenant=north`, { body: {}, headers: own });
  assert.equal(opened.status, 200, opened.text);

  // A page no issuer lists is refused at the door, and gets no CORS answer to read.
  const again = await mintEmbedAssertion({
    issuer: 'https://dealers.example',
    key: SECRET,
    app: appId,
    origin: f.origin,
    subject: 'dealer-kim',
  });
  const crossSite = await f.call('/api/auth/embed/exchange', { body: { assertion: again }, headers: { origin: 'https://evil.example' } });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.headers.get('access-control-allow-origin'), null);
});

test("from a host's page on another origin: a bearer into the tenant App, under the same CORS, CSRF and membership rules", async (t) => {
  const f = await fixture(t);
  const mint = (origin: string) =>
    mintEmbedAssertion({
      issuer: 'https://dealers.example',
      key: SECRET,
      app: appId,
      origin,
      subject: 'dealer-lee',
      email: 'lee@north.example',
    });

  // The preflight is answered for the listed page, with only what a browser route needs.
  const preflight = await f.call(`/api/whoami?app=${appId}`, {
    method: 'OPTIONS',
    headers: { origin: HOST, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), HOST);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
  const stranger = await f.call(`/api/whoami?app=${appId}`, {
    method: 'OPTIONS',
    headers: { origin: STRANGER, 'access-control-request-method': 'POST' },
  });
  assert.equal(stranger.headers.get('access-control-allow-origin'), null);

  // The exchange from the host's page: a bearer, no cookie.
  const signed = await f.call('/api/auth/embed/exchange', { body: { assertion: await mint(HOST) }, headers: { origin: HOST } });
  assert.equal(signed.status, 200, signed.text);
  assert.equal(signed.headers.get('access-control-allow-origin'), HOST);
  assert.deepEqual(signed.headers.getSetCookie(), []);
  const token = String(signed.body.token);
  const bearer = (origin = HOST) => ({ origin, authorization: `Bearer ${token}` });
  const me = await f.call(`/api/whoami?app=${appId}`, { headers: bearer() });
  assert.equal(me.body.signedIn, true, me.text);
  assert.equal(me.body.who, 'lee@north.example');
  assert.equal(me.headers.get('access-control-allow-origin'), HOST);
  assert.match(String(me.headers.get('access-control-expose-headers')), /x-mistri-lease-revision/);
  const accountId = String(me.body.accountId);
  // The same bearer from another page is nobody's: it was given to HOST.
  assert.equal((await f.call(`/api/whoami?app=${appId}`, { headers: bearer(STRANGER) })).body.signedIn, false);

  // A session cookie sent cross-origin stands for no one, though it is a real one.
  const cookie = cookieOf(await f.call('/api/auth/embed/exchange', { body: { assertion: await mint(f.origin) } }));
  assert.equal((await f.call(`/api/whoami?app=${appId}`, { headers: { cookie } })).body.signedIn, true);
  assert.equal((await f.call(`/api/whoami?app=${appId}`, { headers: { cookie, origin: HOST } })).body.signedIn, false);

  // Membership is still the tenant store's: none until it says so, then the tenant opens on the bearer.
  const open = (extra: Record<string, string> = {}) =>
    f.call(`/api/tenant/context/open?app=${appId}&tenant=north`, {
      body: {},
      headers: { ...bearer(), [headers.account]: accountId, ...extra },
    });
  assert.equal((await open()).body.code, 'tenant_context_unavailable');
  await f.maintenance(async (admin) =>
    admin.putMembership({
      tenantId: 'north',
      accountId,
      membershipId: 'north-lee',
      status: 'active',
      roles: ['dealer_staff'],
      validUntil: Date.now() + 3600000,
      expectedVersion: null,
    }),
  );
  const opened = await open();
  assert.equal(opened.status, 200, opened.text);
  assert.equal(opened.headers.get('access-control-allow-origin'), HOST);
  // A write that is not JSON is refused on a bearer as on a cookie: a form cannot make it.
  assert.equal((await open({ 'content-type': 'text/plain' })).status, 403);
  // The bearer opens nothing from a page it was not given to.
  assert.notEqual((await open({ origin: STRANGER })).status, 200);

  // The host's sign-out ends the session the bearer stood for.
  const out = await f.call('/api/auth/embed/sign-out', { body: {}, headers: bearer() });
  assert.equal(out.status, 200, out.text);
  assert.equal((await f.call(`/api/whoami?app=${appId}`, { headers: bearer() })).body.signedIn, false);
});

test("a host that links verified addresses never opens a platform operator's support session, nor rides on one", async (t) => {
  /* The host may name any address, and an operator's is verified here: the
     exchange signs the host's page in as the operator. That reads what the
     operator's own membership reads; it never opens support inside a tenant,
     whose door asks for a fresh sign-in at this App's own page, and it never
     carries a support lease the operator opened there. */
  const f = await fixture(t, 'link-verified-email');
  const { olivia } = f.accounts;
  f.authDb().prepare('UPDATE user SET emailVerified = 1 WHERE email = ?').run(olivia.email);
  const signed = await f.call('/api/auth/embed/exchange', {
    body: {
      assertion: await mintEmbedAssertion({
        issuer: 'https://dealers.example',
        key: SECRET,
        app: appId,
        origin: HOST,
        subject: 'host-olivia',
        email: olivia.email,
        emailVerified: true,
      }),
    },
    headers: { origin: HOST },
  });
  assert.equal(signed.status, 200, signed.text);
  const bearer = { origin: HOST, authorization: `Bearer ${String(signed.body.token)}`, [headers.account]: olivia.accountId };
  assert.equal((await f.call(`/api/whoami?app=${appId}`, { headers: bearer })).body.accountId, olivia.accountId);

  const intent = { operation: 'openSupport', tenantId: 'north', dealerRole: 'dealer_staff', reason: 'From the host page' };
  for (const operation of ['open', 'status', 'exit']) {
    const asked = await f.call(`/api/tenant/support/${operation}?app=${appId}`, {
      body: operation === 'open' ? { idempotencyKey: 'host-open', intent } : {},
      headers: bearer,
    });
    assert.equal(asked.status, 403, `${operation}: ${asked.text}`);
  }
  assert.equal((await f.support(olivia, 'status')).body.session, null, 'no session was opened');

  // The operator opens one at the App's own page; the host's bearer cannot read through its lease.
  const opened = await f.open(olivia, 'north', 'dealer_staff');
  assert.equal(opened.status, 200, opened.text);
  const lease = opened.body.context as TenantContextReply;
  const read = await f.call(`/api/query?${new URLSearchParams({ app: appId, realm: 'support', tenant: lease.tenantId })}`, {
    body: { table: 'lead' },
    headers: { ...bearer, [headers.tab]: lease.tabId, [headers.context]: lease.context, [headers.revision]: String(lease.revision) },
  });
  assert.equal(read.status, 403, read.text);
  assert.doesNotMatch(read.text, /North lead/);
});
