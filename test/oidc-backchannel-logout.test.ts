/**
 * OpenID Connect Back-Channel Logout, end to end over HTTP: people sign in
 * through providers in this process (support/mockOidc.ts), and a provider
 * then POSTs a logout token to `/api/auth/backchannel-logout/<name>`
 * (packages/mistri/src/server/auth/backchannelLogout.ts). What it proves:
 *
 *   - a token names sessions by the provider's session id (`sid`), by the
 *     subject, or by both, and exactly those end: both of one subject's
 *     sessions, and nobody else's, and never another provider's;
 *   - every wrong token is refused with 400 and ends nothing: another key,
 *     HS256 under the client secret, another audience or issuer, no logout
 *     event, a nonce, neither sub nor sid, a spent `jti`, a body that is not
 *     one form field;
 *   - a provider whose entry does not say `"backchannelLogout": true`, and a
 *     name no entry has, answer 404.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Server } from 'node:http';
import { createApp } from './support/createApp.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadApp, type AppHost } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { oidcConnectionOf } from '../packages/mistri/src/server/auth/identityConfig.js';
import { makeDemoDatabase, seedDemoDatabase } from './make-demo-db.js';
import { startMockOidc, type MockOidc, type NextSignIn } from './support/mockOidc.js';

process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-thirty-two-characters-long';

describe('back-channel logout', () => {
  let tmp: string;
  let server: Server;
  let origin = '';
  let host: AppHost;
  let workforce: MockOidc;
  let partners: MockOidc;
  let store: string;
  const errors: string[] = [];
  const error = console.error;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'tablewalk-logout-'));
    workforce = await startMockOidc({ clientId: 'workforce-client', path: '/workforce' });
    partners = await startMockOidc({ clientId: 'partners-client', path: '/partners' });
    process.env.TEST_WORKFORCE_SECRET = workforce.clientSecret;
    process.env.TEST_PARTNERS_SECRET = partners.clientSecret;
    const db = join(tmp, 'app.db');
    makeDemoDatabase(db);
    seedDemoDatabase(db, { scale: 3 });
    const dir = join(tmp, 'crew');
    mkdirSync(dir, { recursive: true });
    store = join(tmp, 'auth.db');
    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify({
        name: 'Crew',
        resources: { work_order: { access: 'write' } },
        auth: {
          providers: ['email', 'oidc:workforce', 'oidc:partners'],
          signUp: { domains: ['crew.example'] },
          store,
          defaultRole: 'viewer',
          roles: { viewer: { read: true } },
        },
        views: { 'work-orders': { kind: 'list', from: 'work_order' } },
        home: 'work-orders',
        nav: ['work-orders'],
      }),
    );
    const loaded = await loadApp(dir);
    const registry = new Registry();
    registry.add({ name: 'rw', url: db, source: 'config' });
    registry.setActive('rw');
    await registry.open('rw');
    host = { app: loaded, pages: [] };
    server = createApp({ registry, apps: [host], bound: { host: '127.0.0.1', port: 0 } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const identity = [
      oidcConnectionOf(
        {
          name: 'workforce',
          kind: 'oidc',
          issuer: workforce.issuer,
          clientId: workforce.clientId,
          clientSecret: '${TEST_WORKFORCE_SECRET}',
          backchannelLogout: true,
          insecure: true,
        },
        'test',
      ),
      // No back-channel logout: its sessions are its own to keep.
      oidcConnectionOf(
        {
          name: 'partners',
          kind: 'oidc',
          issuer: partners.issuer,
          clientId: partners.clientId,
          clientSecret: '${TEST_PARTNERS_SECRET}',
          insecure: true,
        },
        'test',
      ),
    ];
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };
    host.auth = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin], identity });
  });

  after(async () => {
    console.error = error;
    server?.close();
    server?.closeAllConnections();
    host.auth?.close();
    await workforce?.close();
    await partners?.close();
    delete process.env.TEST_WORKFORCE_SECRET;
    delete process.env.TEST_PARTNERS_SECRET;
    rmSync(tmp, { recursive: true, force: true });
  });

  const call = async (url: string, init: RequestInit & { cookie?: string } = {}) => {
    const headers: Record<string, string> = { origin, ...((init.headers as Record<string, string>) ?? {}) };
    if (init.cookie) headers.cookie = init.cookie;
    if (init.body && !headers['content-type']) headers['content-type'] = 'application/json';
    const res = await fetch(url.startsWith('http') ? url : `${origin}${url}`, { ...init, headers, redirect: 'manual' });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return {
      status: res.status,
      json,
      text,
      cacheControl: res.headers.get('cache-control'),
      location: res.headers.get('location'),
      cookies: res.headers.getSetCookie().map((c) => c.split(';')[0]),
    };
  };
  const jar = (...lists: string[][]) => {
    const kept = new Map<string, string>();
    for (const cookie of lists.flat()) kept.set(cookie.split('=')[0], cookie);
    return [...kept.values()].filter((cookie) => !cookie.endsWith('=')).join('; ');
  };
  async function signIn(idp: MockOidc, who: NextSignIn) {
    const provider = idp === workforce ? 'workforce' : 'partners';
    const started = await call('/api/auth/sign-in/social', {
      method: 'POST',
      body: JSON.stringify({ provider, callbackURL: `${origin}/crew/`, errorCallbackURL: `${origin}/crew/sign-in` }),
    });
    assert.equal(started.status, 200, started.text);
    idp.next(who);
    const answered = await call(String(started.json.url));
    assert.equal(answered.status, 302, answered.text);
    const back = await call(answered.location!, { cookie: jar(started.cookies) });
    const session = jar(started.cookies, back.cookies);
    assert.equal(await whoIs(session), who.email, back.location ?? '');
    return session;
  }
  const whoIs = async (session: string) => (await call('/api/whoami', { cookie: session })).json.who as string | null;
  /** The provider's POST: server to server, no cookie, no Origin. */
  const logout = (name: string, body: string, contentType = 'application/x-www-form-urlencoded') =>
    fetch(`${origin}/api/auth/backchannel-logout/${name}`, { method: 'POST', headers: { 'content-type': contentType }, body }).then(
      async (res) => ({ status: res.status, text: await res.text(), cacheControl: res.headers.get('cache-control') }),
    );
  const send = (name: string, token: string) => logout(name, new URLSearchParams({ logout_token: token }).toString());
  const indexed = () => {
    const file = new DatabaseSync(store, { readOnly: true });
    try {
      return (
        file.prepare('SELECT provider, subject, sid FROM idpSession ORDER BY subject, sid').all() as Array<Record<string, unknown>>
      ).map((row) => ({
        ...row,
      }));
    } finally {
      file.close();
    }
  };

  test("a token with a sid ends that session of the provider's, and nobody else's", async () => {
    const one = await signIn(workforce, { sub: 'u-ada', email: 'ada@crew.example', email_verified: true, claims: { sid: 'S-1' } });
    const two = await signIn(workforce, { sub: 'u-ada', email: 'ada@crew.example', email_verified: true, claims: { sid: 'S-2' } });
    assert.deepEqual(
      indexed().filter((row) => row.subject === 'u-ada'),
      [
        { provider: 'workforce', subject: 'u-ada', sid: 'S-1' },
        { provider: 'workforce', subject: 'u-ada', sid: 'S-2' },
      ],
    );
    const done = await send('workforce', workforce.logoutToken({ sid: 'S-1' }));
    assert.equal(done.status, 200, done.text);
    assert.equal(done.text, '');
    assert.equal(done.cacheControl, 'no-store');
    assert.equal(await whoIs(one), null);
    assert.equal(await whoIs(two), 'ada@crew.example');
    assert.deepEqual(
      indexed().filter((row) => row.subject === 'u-ada'),
      [{ provider: 'workforce', subject: 'u-ada', sid: 'S-2' }],
    );
  });

  test("a token with only a sub ends every session of that subject's, and another provider's survive", async () => {
    const one = await signIn(workforce, { sub: 'u-bo', email: 'bo@crew.example', email_verified: true });
    const two = await signIn(workforce, { sub: 'u-bo', email: 'bo@crew.example', email_verified: true, claims: { sid: 'S-9' } });
    const other = await signIn(workforce, { sub: 'u-cy', email: 'cy@crew.example', email_verified: true });
    // The same subject at another provider is somebody that provider signed in: its logout is not this one's.
    const partner = await signIn(partners, { sub: 'u-bo', email: 'bo@crew.example', email_verified: true });
    const done = await send('workforce', workforce.logoutToken({ sub: 'u-bo' }));
    assert.equal(done.status, 200, done.text);
    assert.equal(await whoIs(one), null);
    assert.equal(await whoIs(two), null);
    assert.equal(await whoIs(other), 'cy@crew.example');
    assert.equal(await whoIs(partner), 'bo@crew.example');
    // Both: the session must be that subject's and that sid.
    const three = await signIn(workforce, { sub: 'u-cy', email: 'cy@crew.example', email_verified: true, claims: { sid: 'S-cy' } });
    assert.equal((await send('workforce', workforce.logoutToken({ sub: 'u-bo', sid: 'S-cy' }))).status, 200);
    assert.equal(await whoIs(three), 'cy@crew.example');
    assert.equal((await send('workforce', workforce.logoutToken({ sub: 'u-cy', sid: 'S-cy' }))).status, 200);
    assert.equal(await whoIs(three), null);
    assert.equal(await whoIs(other), 'cy@crew.example');
  });

  test('a wrong token is refused and ends nothing; a spent one is refused the second time', async () => {
    const held = await signIn(workforce, { sub: 'u-dee', email: 'dee@crew.example', email_verified: true, claims: { sid: 'S-dee' } });
    const wrong: Array<[string, string]> = [
      ['another key', workforce.logoutToken({ sid: 'S-dee' }, { foreignKey: true })],
      ['HS256 under the client secret', workforce.logoutToken({ sid: 'S-dee' }, { alg: 'HS256' })],
      ['another audience', workforce.logoutToken({ sid: 'S-dee', aud: 'someone-else' })],
      ['another issuer', workforce.logoutToken({ sid: 'S-dee', iss: partners.issuer })],
      ["another provider's token", partners.logoutToken({ sid: 'S-dee' })],
      ['no logout event', workforce.logoutToken({ sid: 'S-dee', events: undefined })],
      [
        'an event that is not an object',
        workforce.logoutToken({ sid: 'S-dee', events: { 'http://schemas.openid.net/event/backchannel-logout': 1 } }),
      ],
      ['a nonce', workforce.logoutToken({ sid: 'S-dee', nonce: 'n' })],
      ['neither sub nor sid', workforce.logoutToken({})],
      ['no jti', workforce.logoutToken({ sid: 'S-dee', jti: undefined })],
      ['an old one', workforce.logoutToken({ sid: 'S-dee', iat: Math.floor(Date.now() / 1000) - 3600 })],
      ['another type', workforce.logoutToken({ sid: 'S-dee' }, { typ: 'at+jwt' })],
    ];
    for (const [label, token] of wrong) {
      const done = await send('workforce', token);
      assert.equal(done.status, 400, `${label}: ${done.text}`);
      assert.deepEqual(JSON.parse(done.text), { error: 'invalid_request' }, label);
    }
    // A body that is not one logout_token form field.
    const token = workforce.logoutToken({ sid: 'S-dee' });
    assert.equal((await logout('workforce', JSON.stringify({ logout_token: token }), 'application/json')).status, 400);
    assert.equal((await logout('workforce', `logout_token=${token}&logout_token=${token}`)).status, 400);
    assert.equal((await logout('workforce', `logout_token=${'x'.repeat(17 * 1024)}`)).status, 400);
    assert.equal(await whoIs(held), 'dee@crew.example', 'none of them ended anything');
    assert.ok(errors.some((line) => /identity provider "workforce" sent a logout token that was refused/.test(line)));
    // The right one ends it; the same token again is refused.
    const right = workforce.logoutToken({ sid: 'S-dee' });
    assert.equal((await send('workforce', right)).status, 200);
    assert.equal(await whoIs(held), null);
    const again = await send('workforce', right);
    assert.equal(again.status, 400, again.text);
    assert.ok(errors.some((line) => /sent a logout token twice/.test(line)));
  });

  test('a provider that does not take back-channel logout, and a name no entry has, answer 404', async () => {
    const partner = await signIn(partners, { sub: 'u-eve', email: 'eve@crew.example', email_verified: true, claims: { sid: 'P-1' } });
    const refused = await send('partners', partners.logoutToken({ sid: 'P-1' }));
    assert.equal(refused.status, 404, refused.text);
    assert.equal(await whoIs(partner), 'eve@crew.example');
    assert.equal((await send('nobody', workforce.logoutToken({ sid: 'P-1' }))).status, 404);
    const get = await fetch(`${origin}/api/auth/backchannel-logout/workforce`);
    assert.equal(get.status, 405);
  });
});
