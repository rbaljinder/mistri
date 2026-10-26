/**
 * A tenant's own identity provider, and a step-up from an App-wide one, in a
 * tenant App on the real tenant host (support/tenantSupportFixture.ts), with
 * providers in this process (support/mockOidc.ts).
 *
 *   - "Sign in with your work email" finds the tenant's provider by the
 *     address's domain, and says nothing else: not the tenant, not the issuer;
 *   - a tenant's provider asserts only verified addresses in its own domains:
 *     never another tenant's person, never an account on another domain;
 *   - signing in through it gives no membership: the tenant store does;
 *   - a platform login through an App-wide provider opens a support session
 *     only when the provider authenticated the person within five minutes,
 *     with more than one factor where the provider demands it; otherwise the
 *     dialog is told to confirm at that provider, never with a password.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TENANT_HTTP_HEADERS as headers } from '../packages/mistri/src/shared/tenantContext.js';
import { SUPPORT_REFUSAL_CODES } from '../packages/mistri/src/shared/tenantSupport.js';
import { oidcConnectionOf, samlConnectionOf, samlServiceProvider } from '../packages/mistri/src/server/auth/identityConfig.js';
import { appId, tenantSupportFixture, type SupportFixture } from './support/tenantSupportFixture.js';
import { startMockOidc, type MockOidc, type NextSignIn } from './support/mockOidc.js';
import { NAME_ID, authnRequestOf, samlKeys, samlResponse } from './support/mockSaml.js';

async function setUp(t: Parameters<typeof tenantSupportFixture>[0]) {
  const north = await startMockOidc({ clientId: 'north-client', path: '/north' });
  const lender = await startMockOidc({ clientId: 'lender-client', path: '/lender' });
  t.after(async () => {
    await north.close();
    await lender.close();
    delete process.env.TEST_NORTH_SECRET;
    delete process.env.TEST_LENDER_SECRET;
  });
  process.env.TEST_NORTH_SECRET = north.clientSecret;
  process.env.TEST_LENDER_SECRET = lender.clientSecret;
  const f = await tenantSupportFixture(t, 'sqlite', {
    manifest: (raw) => {
      (raw.auth as Record<string, unknown>).providers = ['email', 'oidc:workforce', 'oidc:*'];
    },
    identity: [
      oidcConnectionOf(
        {
          name: 'north-sso',
          kind: 'oidc',
          issuer: north.issuer,
          clientId: north.clientId,
          clientSecret: '${TEST_NORTH_SECRET}',
          tenant: 'north',
          domains: ['north.example'],
          insecure: true,
        },
        'test',
      ),
      oidcConnectionOf(
        {
          name: 'workforce',
          kind: 'oidc',
          issuer: lender.issuer,
          clientId: lender.clientId,
          clientSecret: '${TEST_LENDER_SECRET}',
          label: 'Lender SSO',
          mfa: ['urn:lender:mfa'],
          insecure: true,
        },
        'test',
      ),
    ],
  });
  return { f, north, lender };
}

const jar = (...lists: string[][]) => {
  const kept = new Map<string, string>();
  for (const cookie of lists.flat()) kept.set(cookie.split('=')[0], cookie);
  return [...kept.values()].filter((cookie) => !cookie.endsWith('=')).join('; ');
};

async function http(
  f: SupportFixture,
  url: string,
  init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {},
) {
  const res = await fetch(url.startsWith('http') ? url : `${f.origin}${url}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    redirect: 'manual',
    headers: {
      origin: f.origin,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return {
    status: res.status,
    text,
    json,
    location: res.headers.get('location'),
    cookies: res.headers.getSetCookie().map((c) => c.split(';')[0]),
  };
}

async function signIn(f: SupportFixture, idp: MockOidc, provider: string, who: NextSignIn, stepUp = false, from = '/') {
  const started = await http(f, '/api/auth/sign-in/social', {
    body: {
      provider,
      callbackURL: `${f.origin}${from}`,
      errorCallbackURL: `${f.origin}${from}`,
      ...(stepUp ? { additionalParams: { mistri_step_up: '1' } } : {}),
    },
  });
  assert.equal(started.status, 200, started.text);
  idp.next(who);
  const answered = await http(f, String(started.json.url));
  assert.equal(answered.status, 302, answered.text);
  const back = await http(f, answered.location!, { cookie: jar(started.cookies) });
  const cookie = jar(started.cookies, back.cookies);
  const me = await http(f, `/api/whoami?app=${appId}`, { cookie });
  return {
    back: back.location,
    error: new URL(back.location ?? '/', f.origin).searchParams.get('error'),
    cookie,
    accountId: me.json.accountId as string | null,
    who: me.json.who as string | null,
    authorize: new URL(String(started.json.url)),
  };
}

test("a tenant's own provider is found by the email's domain, asserts only its own addresses, and grants nothing the tenant store does not", async (t) => {
  const { f, north } = await setUp(t);
  const door = await http(f, `/api/whoami?app=${appId}`);
  const info = door.json.signIn as Record<string, unknown>;
  assert.deepEqual(info.providers, ['email', 'oidc:workforce', 'oidc:*']);
  assert.deepEqual(info.labels, { 'oidc:workforce': 'Lender SSO' }, "a tenant's provider is never listed");
  for (const hidden of ['north-sso', 'north.example', north.issuer, north.clientId])
    assert.equal(door.text.includes(hidden), false, hidden);

  const found = await http(f, '/api/auth/work-email', { body: { email: 'Kim@North.Example' } });
  assert.deepEqual(found.json, { provider: 'north-sso', kind: 'oidc' }, "the provider's name and kind to sign in with, and nothing else");
  assert.deepEqual((await http(f, '/api/auth/work-email', { body: { email: 'kim@south.example' } })).json, { provider: null });
  assert.equal((await http(f, '/api/auth/work-email', { body: { email: 'not an address' } })).status, 400);
  assert.equal((await http(f, '/api/auth/work-email')).status, 405);

  const kim = await signIn(f, north, 'north-sso', { sub: 'n-kim', email: 'kim@north.example', email_verified: true, name: 'Kim' });
  assert.equal(kim.error, null);
  assert.equal(kim.who, 'kim@north.example');
  assert.equal(kim.authorize.searchParams.get('login_hint'), null, 'a hint is only what the browser typed');
  // Signed in, and a member of nothing: membership is the tenant store's.
  const own = { cookie: kim.cookie, [headers.account]: kim.accountId! };
  const shut = await f.call(`/api/tenant/context/open?app=${appId}&tenant=north`, { body: {}, headers: own });
  assert.equal(shut.body.code, 'tenant_context_unavailable', shut.text);
  await f.maintenance(async (admin) =>
    admin.putMembership({
      tenantId: 'north',
      accountId: kim.accountId!,
      membershipId: 'north-kim',
      status: 'active',
      roles: ['dealer_staff'],
      validUntil: Date.now() + 3600000,
      expectedVersion: null,
    }),
  );
  const opened = await f.call(`/api/tenant/context/open?app=${appId}&tenant=north`, { body: {}, headers: own });
  assert.equal(opened.status, 200, opened.text);

  // Another tenant's person, an account on another domain, and an unverified address are all refused.
  const eve = await signIn(f, north, 'north-sso', { sub: 'n-eve', email: 'eve@south.example', email_verified: true });
  assert.equal(eve.error, 'outside_domain');
  const sam = await signIn(f, north, 'north-sso', { sub: 'n-sam', email: f.accounts.sam.email, email_verified: true });
  assert.equal(sam.error, 'outside_domain');
  assert.equal(sam.who, null);
  assert.equal(
    (await http(f, '/api/auth/sign-in/email', { body: { email: f.accounts.sam.email, password: f.accounts.sam.password } })).status,
    200,
    'sam keeps his own sign-in',
  );
  const unverified = await signIn(f, north, 'north-sso', { sub: 'n-lee', email: 'lee@north.example', email_verified: false });
  assert.equal(unverified.error, 'outside_domain');
});

test("a provider's sign-in begun on an OAuth consent address comes back to it, as a password sign-in does", async (t) => {
  const { f, lender } = await setUp(t);
  // The sign-in page's own address, with the pending request an application sent the person there with.
  const consent = '/sign-in?authorize=0b8f7c1e-2d4a-4f6b-9c3e-1a2b3c4d5e6f';
  const who = await signIn(
    f,
    lender,
    'workforce',
    { sub: 'w-ann', email: 'ann@lender.example', email_verified: true, name: 'Ann' },
    false,
    consent,
  );
  assert.equal(who.error, null);
  assert.ok(who.accountId);
  assert.equal(new URL(who.back!, f.origin).pathname + new URL(who.back!, f.origin).search, consent);
});

test("a support session opens on a provider's recent sign-in with more than one factor, and otherwise is confirmed there", async (t) => {
  const { f, lender } = await setUp(t);
  const olivia = f.accounts.olivia;
  const through = (claims: Record<string, unknown>) =>
    signIn(f, lender, 'workforce', { sub: 'l-olivia', email: olivia.email, email_verified: true, claims });

  const single = await through({ amr: ['pwd'] });
  assert.equal(single.error, null);
  assert.equal(single.accountId, olivia.accountId, 'the verified address links to her account');
  const who = { accountId: olivia.accountId, cookie: single.cookie };
  const status = await f.support(who, 'status');
  assert.equal(status.body.signInRequired, true, status.text);
  assert.equal(status.body.reauthenticate, 'workforce');
  assert.equal(status.body.passwordSignIn, false, 'a password never stands in for the provider');
  assert.equal((await f.open(who, 'north', 'dealer_staff')).body.code, SUPPORT_REFUSAL_CODES.signInRequired);

  // Silent: the provider's own session, authenticated long ago.
  const silent = await through({ amr: ['pwd', 'mfa'], auth_time: Math.floor(Date.now() / 1000) - 900 });
  assert.equal(
    (await f.open({ accountId: olivia.accountId, cookie: silent.cookie }, 'north', 'dealer_staff')).body.code,
    SUPPORT_REFUSAL_CODES.signInRequired,
  );

  // Confirmed at the provider: afresh, asking for the factors it names.
  const fresh = await signIn(
    f,
    lender,
    'workforce',
    { sub: 'l-olivia', email: olivia.email, email_verified: true, claims: { amr: ['pwd', 'mfa'] } },
    true,
  );
  assert.equal(fresh.authorize.searchParams.get('prompt'), 'login');
  assert.equal(fresh.authorize.searchParams.get('max_age'), '0');
  assert.equal(fresh.authorize.searchParams.get('acr_values'), 'urn:lender:mfa');
  const entered = await f.open({ accountId: olivia.accountId, cookie: fresh.cookie }, 'north', 'dealer_staff');
  assert.equal(entered.status, 200, entered.text);
});

for (const sharedIdentity of [false, true]) {
  test(`a tenant's SAML provider is found by the work email, fenced to its domains, and a tenant's OIDC provider may end its sessions${
    sharedIdentity ? ' (suite identity)' : ''
  }`, async (t) => {
    const north = await startMockOidc({ clientId: 'north-client', path: '/north' });
    t.after(async () => {
      await north.close();
      delete process.env.TEST_NORTH_SECRET;
    });
    process.env.TEST_NORTH_SECRET = north.clientSecret;
    const SOUTH = 'https://idp-south.example/saml';
    const CORP = 'https://idp-corp.example/saml';
    const keys = samlKeys('idp-a');
    const f = await tenantSupportFixture(t, 'sqlite', {
      sharedIdentity,
      manifest: (raw) => {
        (raw.auth as Record<string, unknown>).providers = ['email', 'saml:corp', 'oidc:*', 'saml:*'];
      },
      identity: [
        oidcConnectionOf(
          {
            name: 'north-sso',
            kind: 'oidc',
            issuer: north.issuer,
            clientId: north.clientId,
            clientSecret: '${TEST_NORTH_SECRET}',
            tenant: 'north',
            domains: ['north.example'],
            backchannelLogout: true,
            insecure: true,
          },
          'test',
        ),
        samlConnectionOf(
          {
            name: 'south-saml',
            kind: 'saml',
            entityId: SOUTH,
            ssoUrl: 'https://idp-south.example/sso',
            certificates: [keys.cert],
            tenant: 'south',
            domains: ['south.example'],
            verifiedEmails: true,
            attributes: { email: 'mail' },
          },
          'test',
        ),
        // The lender's own staff directory: App-wide, demanding more than one factor for a support session.
        samlConnectionOf(
          {
            name: 'corp',
            kind: 'saml',
            entityId: CORP,
            ssoUrl: 'https://idp-corp.example/sso',
            certificates: [samlKeys('idp-b').cert],
            label: 'Lender SSO',
            verifiedEmails: true,
            mfa: ['urn:corp:mfa'],
          },
          'test',
        ),
      ],
    });
    const door = await http(f, `/api/whoami?app=${appId}`);
    assert.deepEqual((door.json.signIn as Record<string, unknown>).providers, ['email', 'saml:corp', 'oidc:*', 'saml:*']);
    for (const hidden of ['south-saml', 'south.example', SOUTH]) assert.equal(door.text.includes(hidden), false, hidden);
    // The work-email question is asked at the App's door, a suite App's as well (for either kind).
    assert.deepEqual((await http(f, '/api/auth/work-email', { body: { email: 'kim@south.example' } })).json, {
      provider: 'south-saml',
      kind: 'saml',
    });

    const saml = async (nameId: string, mail: string, through: 'south-saml' | 'corp' = 'south-saml', authnContext?: string) => {
      const started = await http(f, '/api/auth/sign-in/sso', {
        body: { providerId: through, callbackURL: `${f.origin}/`, errorCallbackURL: `${f.origin}/` },
      });
      assert.equal(started.status, 200, started.text);
      const asked = authnRequestOf(String(started.json.url));
      const sp = samlServiceProvider(f.origin, through);
      const response = samlResponse({
        issuer: through === 'corp' ? CORP : SOUTH,
        nameId: through === 'corp' ? mail : nameId,
        format: through === 'corp' ? NAME_ID.email : NAME_ID.persistent,
        inResponseTo: asked.id,
        acs: sp.acs,
        audience: sp.entityId,
        keys: through === 'corp' ? samlKeys('idp-b') : keys,
        ...(through === 'corp' ? {} : { attributes: { mail } }),
        ...(authnContext ? { authnContext } : {}),
      });
      // The provider's page posts it: cross-site, without the App's cookies.
      const back = await fetch(sp.acs, {
        method: 'POST',
        redirect: 'manual',
        headers: { origin: 'https://idp-south.example', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ SAMLResponse: response, RelayState: asked.relayState }).toString(),
      });
      const cookie = jar(back.headers.getSetCookie().map((c) => c.split(';')[0]));
      const me = await http(f, `/api/whoami?app=${appId}`, { cookie });
      return {
        error: new URL(back.headers.get('location') ?? '/', f.origin).searchParams.get('error'),
        who: me.json.who as string | null,
        cookie,
      };
    };
    const kim = await saml('s-kim', 'kim@south.example');
    assert.equal(kim.error, null);
    // A suite App's door shows only who the suite grants it; the session is the identity store's either way.
    if (sharedIdentity) assert.match(kim.cookie, /session_token=/);
    else assert.equal(kim.who, 'kim@south.example');
    // Another tenant's person, and an account on another domain, are refused.
    assert.equal((await saml('s-eve', 'eve@north.example')).error, 'outside_domain');
    const sam = await saml('s-sam', f.accounts.sam.email);
    assert.equal(sam.error, 'outside_domain');
    assert.equal(sam.who, null);

    // North's provider ends the session its own sign-in opened.
    const lee = await signIn(f, north, 'north-sso', {
      sub: 'n-lee',
      email: 'lee@north.example',
      email_verified: true,
      claims: { sid: 'N-1' },
    });
    if (!sharedIdentity) assert.equal(lee.who, 'lee@north.example');
    assert.match(lee.cookie, /session_token=/);
    const opened = () =>
      f
        .authDb()
        .prepare('SELECT s.id FROM idpSession i JOIN session s ON s.id = i.sessionId WHERE i.provider = ? AND i.sid = ?')
        .all('north-sso', 'N-1');
    assert.equal(opened().length, 1, "the provider's session is indexed");
    const logout = await fetch(`${f.origin}/api/auth/backchannel-logout/north-sso`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ logout_token: north.logoutToken({ sid: 'N-1' }) }).toString(),
    });
    assert.equal(logout.status, 200, await logout.text());
    assert.equal((await http(f, `/api/whoami?app=${appId}`, { cookie: lee.cookie })).json.who, null);
    assert.equal(opened().length, 0, 'and ended');
    assert.equal((await fetch(`${f.origin}/api/auth/backchannel-logout/south-saml`, { method: 'POST' })).status, 404);

    if (sharedIdentity) return;
    // A support session through the App-wide SAML provider: confirmed there, by its own route, with the factors it names.
    const olivia = f.accounts.olivia;
    const single = await saml('', olivia.email, 'corp');
    assert.equal(single.error, null);
    const who = { accountId: olivia.accountId, cookie: single.cookie };
    const status = await f.support(who, 'status');
    assert.equal(status.body.signInRequired, true, status.text);
    assert.equal(status.body.reauthenticate, 'corp');
    assert.equal(status.body.reauthenticateKind, 'saml');
    assert.equal(status.body.passwordSignIn, false);
    const fresh = await saml('', olivia.email, 'corp', 'urn:corp:mfa');
    const entered = await f.open({ accountId: olivia.accountId, cookie: fresh.cookie }, 'north', 'dealer_staff');
    assert.equal(entered.status, 200, entered.text);
  });
}
