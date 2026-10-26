/**
 * Sign-in through SAML 2.0 identity providers, end to end over HTTP: a real
 * Better Auth with @better-auth/sso behind tablewalk's App server, and
 * providers in this process (support/mockSaml.ts) that answer with whatever
 * Response the test writes, signed under fixed keys. What it proves:
 *
 *   - the service-provider-initiated flow: the AuthnRequest, the assertion
 *     consumer service, a session, the account keyed by (entity ID, NameID),
 *     and the provider's session written to the logout index;
 *   - every wrong response is refused: unsigned, signed by a key the config
 *     never named, SHA-1, the Response signed but not its assertion, a second
 *     or wrapped assertion (XSW), a comment in the NameID, a DOCTYPE, one
 *     provider's assertion at another's consumer service, a replay, an
 *     unsolicited one, an answer to another request, an expired one, one not
 *     yet valid; a transient NameID; no address;
 *   - two providers' identical NameIDs are two people; a provider the config
 *     trusts for verified addresses links to the account that has one, and one
 *     it does not trust never does;
 *   - the plugin is closed: every route it has answers 404 but sign-in, the
 *     service provider's metadata and the consumer service of a configured
 *     provider, and the store has no provider table.
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
import { createNativeAccount } from '../packages/mistri/src/server/auth/authAccounts.js';
import { samlConnectionOf, samlServiceProvider, type SamlProviderConfig } from '../packages/mistri/src/server/auth/identityConfig.js';
import { makeDemoDatabase, seedDemoDatabase } from './make-demo-db.js';
import { NAME_ID, assertionXml, authnRequestOf, samlKeys, samlResponse, type SamlAnswer } from './support/mockSaml.js';

process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-thirty-two-characters-long';

const A = samlKeys('idp-a');
const B = samlKeys('idp-b');
const ROGUE = samlKeys('rogue');
const NORTH = 'https://idp-north.example/saml';
const SOUTH = 'https://idp-south.example/saml';
const WEST = 'https://idp-west.example/saml';

describe('signing in through a SAML provider', () => {
  let tmp: string;
  let server: Server;
  let origin = '';
  let host: AppHost;
  let store: string;
  const errors: string[] = [];
  const error = console.error;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'tablewalk-saml-'));
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
          providers: ['email', 'saml:north', 'saml:south', 'saml:west'],
          signUp: { domains: ['crew.example'] },
          store,
          defaultRole: 'viewer',
          roles: {
            viewer: { read: true, claims: { groups: ['crew'] } },
            dispatcher: { read: true, write: true, claims: { groups: ['dispatch'] } },
          },
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
    const identity: SamlProviderConfig[] = [
      samlConnectionOf(
        {
          name: 'north',
          kind: 'saml',
          entityId: NORTH,
          ssoUrl: 'https://idp-north.example/sso',
          certificates: [A.cert],
          label: 'North SSO',
          verifiedEmails: true,
          attributes: { email: 'mail', name: 'displayName' },
        },
        'test',
      ),
      samlConnectionOf(
        {
          name: 'south',
          kind: 'saml',
          entityId: SOUTH,
          ssoUrl: 'https://idp-south.example/sso',
          certificates: [B.cert],
          verifiedEmails: true,
          attributes: { email: 'mail' },
        },
        'test',
      ),
      // Two certificates, as during a rollover; addresses in the NameID, never said to be verified.
      samlConnectionOf(
        { name: 'west', kind: 'saml', entityId: WEST, ssoUrl: 'https://idp-west.example/sso', certificates: [A.cert, B.cert] },
        'test',
      ),
    ];
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };
    host.auth = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin], identity });
  });

  after(() => {
    console.error = error;
    server?.close();
    server?.closeAllConnections();
    host.auth?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const call = async (url: string, init: RequestInit & { cookie?: string; form?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { origin, ...((init.headers as Record<string, string>) ?? {}) };
    if (init.cookie) headers.cookie = init.cookie;
    let body = init.body;
    if (init.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(init.form).toString();
    } else if (body) headers['content-type'] = 'application/json';
    const res = await fetch(url.startsWith('http') ? url : `${origin}${url}`, {
      ...init,
      ...(init.form ? { method: 'POST' } : {}),
      body,
      headers,
      redirect: 'manual',
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
      json,
      text,
      location: res.headers.get('location'),
      cookies: res.headers.getSetCookie().map((c) => c.split(';')[0]),
    };
  };
  const jar = (...lists: string[][]) => {
    const kept = new Map<string, string>();
    for (const cookie of lists.flat()) kept.set(cookie.split('=')[0], cookie);
    return [...kept.values()].filter((cookie) => !cookie.endsWith('=')).join('; ');
  };
  const read = <T>(sql: string, ...params: Array<string | number>) => {
    const file = new DatabaseSync(store, { readOnly: true });
    try {
      return (file.prepare(sql).all(...params) as T[]).map((row) => ({ ...row }));
    } finally {
      file.close();
    }
  };
  const userOf = (email: string) =>
    read<{ id: string; role: string | null; emailVerified: number }>(
      'SELECT id, role, emailVerified FROM "user" WHERE email = ?',
      email,
    )[0];
  const methodsOf = (email: string) =>
    read<{ providerId: string; accountId: string }>(
      'SELECT a.providerId, a.accountId FROM account a JOIN "user" u ON u.id = a.userId WHERE u.email = ? ORDER BY a.providerId',
      email,
    );
  const sp = (name: string) => samlServiceProvider(origin, name);

  /** Ask to sign in through `provider`; the request the browser is sent to the provider with. */
  async function start(provider: string) {
    const started = await call('/api/auth/sign-in/sso', {
      method: 'POST',
      body: JSON.stringify({ providerId: provider, callbackURL: `${origin}/crew/`, errorCallbackURL: `${origin}/crew/sign-in` }),
    });
    assert.equal(started.status, 200, started.text);
    return { ...authnRequestOf(String(started.json.url)), cookies: started.cookies };
  }
  /** Post a Response to a consumer service as the provider's page would: cross-site, without the App's cookies. */
  async function post(provider: string, response: string, relayState: string) {
    const back = await call(`/api/auth/sso/saml2/sp/acs/${provider}`, {
      form: { SAMLResponse: response, RelayState: relayState },
      headers: { origin: 'https://idp.example' },
    });
    const landed = new URL(back.location ?? '/', origin);
    const session = jar(back.cookies);
    const whoami = await call('/api/whoami', { cookie: session });
    return { back, landed, error: landed.searchParams.get('error'), session, who: whoami.json.who as string | null };
  }
  /** The whole flow through `provider`, answered as `answer` says (keys default to the provider's). */
  async function signIn(provider: 'north' | 'south' | 'west', answer: Partial<SamlAnswer> & { nameId: string }) {
    const asked = await start(provider);
    const issuer = { north: NORTH, south: SOUTH, west: WEST }[provider];
    const full: SamlAnswer = {
      issuer,
      inResponseTo: asked.id,
      acs: sp(provider).acs,
      audience: sp(provider).entityId,
      keys: provider === 'south' ? B : A,
      attributes: { groups: ['crew'] },
      ...answer,
    };
    const response = samlResponse(full);
    const done = await post(provider, response, asked.relayState);
    return { ...done, asked, response, replay: () => post(provider, response, asked.relayState) };
  }

  test('the door names each provider by its label, and the metadata is the service provider’s own', async () => {
    const door = await call('/api/whoami');
    const info = door.json.signIn as Record<string, unknown>;
    assert.deepEqual(info.providers, ['email', 'saml:north', 'saml:south', 'saml:west']);
    assert.deepEqual((info.labels as Record<string, string>)['saml:north'], 'North SSO');
    for (const secret of [NORTH, 'idp-north.example', 'crew.example']) assert.equal(door.text.includes(secret), false, secret);
    const metadata = await call(`/api/auth/sso/saml2/sp/metadata?providerId=north`);
    assert.equal(metadata.status, 200, metadata.text);
    assert.ok(metadata.text.includes(`entityID="${sp('north').entityId.replace(/&/g, '&amp;')}"`), metadata.text);
    assert.ok(metadata.text.includes(sp('north').acs), 'the consumer service is said');
    assert.equal((await call('/api/auth/sso/saml2/sp/metadata?providerId=east')).status, 404);
  });

  test('a first sign-in makes the account under the provider’s entity ID and NameID, with roles from its attributes', async () => {
    const done = await signIn('north', {
      nameId: 'n-ada',
      format: NAME_ID.persistent,
      attributes: { mail: 'Ada@Crew.Example', displayName: 'Ada', groups: ['crew', 'dispatch'] },
      sessionIndex: 'north-session-1',
    });
    assert.equal(done.error, null, done.back.location ?? done.back.text);
    assert.equal(done.who, 'ada@crew.example');
    assert.equal(done.landed.pathname, '/crew/');
    const request = done.asked.xml;
    assert.ok(request.includes(`<saml:Issuer`) && request.includes(sp('north').entityId.replace(/&/g, '&amp;')), request);
    const ada = userOf('ada@crew.example');
    assert.equal(ada.emailVerified, 1, 'the config says this provider asserts verified addresses');
    assert.deepEqual(ada.role?.split(',').sort(), ['dispatcher', 'viewer']);
    assert.deepEqual(methodsOf('ada@crew.example'), [{ providerId: 'north', accountId: 'n-ada' }]);
    const index = read<Record<string, string | null>>('SELECT provider, issuer, subject, sid, sessionIndex FROM idpSession');
    assert.deepEqual(index, [{ provider: 'north', issuer: NORTH, subject: 'n-ada', sid: null, sessionIndex: 'north-session-1' }]);
    // The same response again is refused: the request it answered is spent, and so is the assertion.
    const again = await done.replay();
    assert.notEqual(again.error, null);
    assert.equal(again.who, null);
  });

  test('a response that is not a signed answer to this sign-in from this provider is refused', async () => {
    const who = { nameId: 'n-mallory', format: NAME_ID.persistent, attributes: { mail: 'mallory@crew.example', groups: ['crew'] } };
    const refused = async (label: string, answer: Partial<SamlAnswer>, provider: 'north' | 'south' = 'north') => {
      const done = await signIn(provider, { ...who, ...answer });
      // Refused unread (400), or by the plugin (back to the sign-in page with an error).
      assert.ok(done.back.status === 400 || done.error !== null, `${label}: ${done.back.status} ${done.back.location}`);
      assert.equal(done.who, null, label);
      return done;
    };
    await refused('unsigned', { sign: 'none' });
    await refused('signed by a key the config never named', { keys: ROGUE });
    await refused('SHA-1', { sha1: true });
    await refused('the Response signed, its assertion not', { sign: 'response' });
    await refused('signed by another provider’s key', { keys: B });
    await refused('another audience', { audience: sp('south').entityId });
    await refused('another provider’s issuer', { issuer: SOUTH });
    await refused('unsolicited', { inResponseTo: undefined });
    await refused('an answer to another request', { inResponseTo: '_not-the-request' });
    await refused('expired', { notBefore: new Date(Date.now() - 600_000), notOnOrAfter: new Date(Date.now() - 120_000) });
    await refused('not yet valid', { notBefore: new Date(Date.now() + 300_000), notOnOrAfter: new Date(Date.now() + 600_000) });
    // XSW: a second assertion beside the signed one, and the signed one wrapped away under an evil one.
    const evil = assertionXml({
      ...who,
      issuer: NORTH,
      acs: sp('north').acs,
      audience: sp('north').entityId,
      attributes: { mail: 'ada@crew.example', groups: ['dispatch'] },
    });
    await refused('a second assertion', { after: (xml) => xml.replace('</samlp:Response>', `${evil}</samlp:Response>`) });
    await refused('a wrapped assertion', {
      after: (xml) =>
        xml
          .replace(/<saml:Assertion /, `${evil.replace('</saml:Assertion>', '')}<samlp:Extensions><saml:Assertion `)
          .replace('</samlp:Response>', '</samlp:Extensions></saml:Assertion></samlp:Response>'),
    });
    await refused('a comment in the NameID', { after: (xml) => xml.replace('>n-mallory<', '>n-mal<!---->lory<') });
    await refused('a DOCTYPE', {
      after: (xml) => `<!DOCTYPE samlp:Response [<!ENTITY who "ada@crew.example">]>${xml}`,
    });
    // North's assertion at south's consumer service: south's sign-in, answered with north's keys and names.
    await refused(
      'one provider’s assertion at another’s consumer service',
      { issuer: NORTH, keys: A, acs: sp('north').acs, audience: sp('north').entityId },
      'south',
    );
    assert.equal(userOf('mallory@crew.example'), undefined, 'none of them made an account');
    assert.equal(userOf('ada@crew.example')?.role?.includes('dispatcher') ?? false, true, 'nor touched another');
    assert.ok(
      errors.some((line) => /refused unread: the response has 2 Assertion elements/.test(line)),
      errors.join('\n'),
    );
    assert.ok(errors.some((line) => /refused unread: the response has a comment/.test(line)));
    assert.ok(errors.some((line) => /refused unread: the response declares a DOCTYPE/.test(line)));
    assert.ok(errors.some((line) => /refused unread: a signature is not SHA-256/.test(line)));
  });

  test('a response no sign-in started here is refused, and a body that is not a response is too', async () => {
    const response = samlResponse({
      issuer: NORTH,
      nameId: 'n-idp-initiated',
      format: NAME_ID.persistent,
      acs: sp('north').acs,
      audience: sp('north').entityId,
      keys: A,
      attributes: { mail: 'idp@crew.example', groups: ['crew'] },
    });
    const unsolicited = await post('north', response, '');
    assert.equal(unsolicited.who, null);
    assert.equal(userOf('idp@crew.example'), undefined);
    const extra = await call('/api/auth/sso/saml2/sp/acs/north', { form: { SAMLResponse: response, RelayState: '', foo: 'bar' } });
    assert.equal(extra.status, 400, extra.text);
    const huge = await call('/api/auth/sso/saml2/sp/acs/north', { form: { SAMLResponse: 'A'.repeat(200 * 1024) } });
    assert.equal(huge.status, 400, huge.text);
    assert.equal(huge.cookies.length, 0);
  });

  test('a transient NameID, and a response with no address, sign nobody in', async () => {
    const transient = await signIn('north', {
      nameId: 'tr-1',
      format: NAME_ID.transient,
      attributes: { mail: 'tess@crew.example', groups: ['crew'] },
    });
    assert.equal(transient.error, 'saml_transient_name');
    const none = await signIn('west', { nameId: 'w-nobody', format: NAME_ID.persistent });
    assert.equal(none.error, 'saml_no_email');
    assert.equal(userOf('tess@crew.example'), undefined);
  });

  test('the same NameID from two providers is two people', async () => {
    const north = await signIn('north', {
      nameId: 'p-7',
      format: NAME_ID.persistent,
      attributes: { mail: 'carol@crew.example', groups: ['crew'] },
    });
    assert.equal(north.who, 'carol@crew.example', north.back.location ?? '');
    const south = await signIn('south', {
      nameId: 'p-7',
      format: NAME_ID.persistent,
      attributes: { mail: 'dave@crew.example', groups: ['crew'] },
    });
    assert.equal(south.who, 'dave@crew.example', south.back.location ?? '');
    assert.deepEqual(methodsOf('carol@crew.example'), [{ providerId: 'north', accountId: 'p-7' }]);
    assert.deepEqual(methodsOf('dave@crew.example'), [{ providerId: 'south', accountId: 'p-7' }]);
    // And north's p-7 signs in as carol again, not as whoever south's p-7 is.
    const again = await signIn('north', {
      nameId: 'p-7',
      format: NAME_ID.persistent,
      attributes: { mail: 'carol@crew.example', groups: ['crew'] },
    });
    assert.equal(again.who, 'carol@crew.example');
  });

  test('a provider trusted for verified addresses links to the account that has one; an untrusted one never does', async () => {
    // Dee has a password account an operator made: its address was never verified.
    await createNativeAccount(host.auth!, { email: 'dee@crew.example', name: 'Dee', password: 'dee-password-1' }, { by: 'maintenance' });
    const own = await call('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email: 'dee@crew.example', password: 'dee-password-1' }),
    });
    assert.equal(own.status, 200, own.text);
    const held = jar(own.cookies);
    // West never says an address is verified: no link, and no account made by the domain.
    const west = await signIn('west', { nameId: 'dee@crew.example', format: NAME_ID.email });
    assert.notEqual(west.error, null);
    assert.equal(west.who, null);
    assert.deepEqual(
      methodsOf('dee@crew.example').map((m) => m.providerId),
      ['credential'],
    );
    const stranger = await signIn('west', { nameId: 'erin@crew.example', format: NAME_ID.email });
    assert.equal(stranger.error, 'sign_up_closed');
    // South does: it links, and ends what the unproven account held.
    const south = await signIn('south', {
      nameId: 's-dee',
      format: NAME_ID.persistent,
      attributes: { mail: 'dee@crew.example', groups: ['crew'] },
    });
    assert.equal(south.error, null, south.back.location ?? '');
    assert.equal(south.who, 'dee@crew.example');
    assert.deepEqual(methodsOf('dee@crew.example'), [{ providerId: 'south', accountId: 's-dee' }]);
    assert.equal(userOf('dee@crew.example').emailVerified, 1);
    assert.equal((await call('/api/whoami', { cookie: held })).json.who, null, 'the password session is over');
    // A verified address now: north links to the same person beside south.
    const north = await signIn('north', {
      nameId: 'n-dee',
      format: NAME_ID.persistent,
      attributes: { mail: 'dee@crew.example', groups: ['crew'] },
    });
    assert.equal(north.who, 'dee@crew.example', north.back.location ?? '');
    assert.deepEqual(
      methodsOf('dee@crew.example').map((m) => m.providerId),
      ['north', 'south'],
    );
  });

  test('west signs in with an emailAddress NameID under either certificate of a rollover, unverified', async () => {
    const first = await signIn('west', { nameId: 'carol@crew.example', format: NAME_ID.email, keys: A });
    // Carol's account exists and west is not trusted to say her address is hers.
    assert.equal(first.who, null);
    // A new person on the domain: sign-up by domain needs a verified address, so the App's invite would be needed.
    const second = await signIn('west', { nameId: 'fern@crew.example', format: NAME_ID.email, keys: B });
    assert.equal(second.error, 'sign_up_closed', 'the signature under the second certificate was accepted; sign-up was not');
  });

  test('the plugin answers 404 on every route but sign-in, the metadata and a configured consumer service', async () => {
    const { sso } = (await import('@better-auth/sso')) as unknown as {
      sso: (o: Record<string, unknown>) => { endpoints: Record<string, { path: string; options: { method: string | string[] } }> };
    };
    const reachable = new Set(['/sign-in/sso', '/sso/saml2/sp/acs/:providerId', '/sso/saml2/sp/metadata']);
    const routes = Object.values(sso({}).endpoints);
    assert.ok(routes.length >= 10, `the plugin has ${routes.length} routes`);
    for (const route of routes) {
      if (reachable.has(route.path)) continue;
      for (const method of [route.options.method].flat()) {
        const path = route.path.replace(':providerId', 'north');
        const answer = await call(`/api/auth${path}${method === 'GET' ? '?providerId=north' : ''}`, {
          method,
          ...(method === 'GET' ? {} : { body: JSON.stringify({ providerId: 'north' }) }),
        });
        assert.equal(answer.status, 404, `${method} ${path}: ${answer.text}`);
      }
    }
    for (const [method, path] of [
      ['GET', '/sso/saml2/sp/acs/north'],
      ['POST', '/sso/saml2/sp/acs/east'],
      ['POST', '/sso/saml2/sp/acs/north?x=1'],
      ['GET', '/sso/saml2/sp/metadata?providerId=north&format=json'],
      ['GET', '/sso/saml2/sp/metadata'],
      ['GET', '/sign-in/sso'],
      ['GET', '/sso'],
      ['GET', '/sso/anything'],
    ] as const) {
      const answer = await call(`/api/auth${path}`, { method, ...(method === 'POST' ? { form: { SAMLResponse: 'eA==' } } : {}) });
      assert.equal(answer.status, 404, `${method} ${path}: ${answer.text}`);
    }
    const unknown = await call('/api/auth/sign-in/sso', {
      method: 'POST',
      body: JSON.stringify({ providerId: 'east', callbackURL: `${origin}/crew/` }),
    });
    assert.equal(unknown.status, 404, unknown.text);
    const extra = await call('/api/auth/sign-in/sso', {
      method: 'POST',
      body: JSON.stringify({ providerId: 'north', callbackURL: `${origin}/crew/`, email: 'x@crew.example' }),
    });
    assert.equal(extra.status, 400, extra.text);
    const tables = read<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name);
    assert.equal(tables.includes('ssoProvider'), false);
    assert.equal(tables.includes('idpSession'), true);
  });
});
