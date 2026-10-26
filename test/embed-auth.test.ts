/**
 * Signing in from a host's own app (embed/): a host that has already signed
 * its person in signs a short-lived assertion, and the App exchanges it for
 * its ordinary session — on the same origin a cookie, from another a bearer.
 * Each property the exchange promises is one refusal here, against a real
 * Better Auth store and the real gate:
 *
 *   - signature, issuer, audience, lifetime, expiry and replay — the spent ids
 *     kept in the auth store, so a second server on it refuses the replay too;
 *   - a budget per issuer and client address;
 *   - the origin the assertion names, and the origins the issuer lists;
 *   - roles: the claim counts only through the issuer's mapping;
 *   - accounts: separate by default, linked by email only when both sides verified it;
 *   - cross-origin: CORS for listed origins only, a bearer only on browser
 *     routes and only from its own origin, and a cookie never standing for
 *     anyone cross-origin (the CSRF line);
 *   - sign-out ends the session the host's page holds.
 */
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth, type AppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import { resetSignInState } from '../packages/mistri/src/server/auth/signInState.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { embedConnectionOf, embedProblems } from '../packages/mistri/src/server/embed/issuerConfig.js';
import { mintEmbedAssertion } from '../packages/mistri/src/server/embed/mint.js';
import { SPENT_ASSERTION } from '../packages/mistri/src/server/embed/ledger.js';
import { EMBED_EXCHANGE_BUDGET } from '../packages/mistri/src/server/embed/exchange.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const appId = 'embed-atlas';
const SECRET = 'host-portal-assertion-secret-of-forty-bytes!';
const OTHER = 'some-other-hosts-secret-also-forty-bytes-long';
const HOST = 'http://localhost:5999';
const STRANGER = 'http://localhost:6111';
/** Another page the same host is on: listed, but not the one a bearer was given to. */
const SIBLING = 'http://localhost:5998';

const directory = mkdtempSync(join(tmpdir(), 'mistri-embed-auth-'));
const path = join(directory, 'data.db');
const store = join(directory, 'sessions.db');
const connection = 'embed-auth-database';
const environment: Record<string, string> = {
  BETTER_AUTH_SECRET: 'isolated-embed-test-secret-at-least-thirty-two-characters',
  MISTRI_AUTH_ADMIN_EMAIL: 'admin@example.test',
  MISTRI_AUTH_ADMIN_PASSWORD: 'admin-embed-password-1',
  EMBED_PORTAL_SECRET: SECRET,
  XDG_CONFIG_HOME: directory,
};
const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
let server: ReturnType<typeof createApp>;
let jwks: Server;
let registry: Registry;
let host: AppHost;
let origin = '';
let jwksUrl = '';

/** An HS256 token with whatever header and claims a test wants: the shapes a host must not get away with. */
function craft(claims: Record<string, unknown>, secret = SECRET, header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' }): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signed = `${encode(header)}.${encode(claims)}`;
  return `${signed}.${createHmac('sha256', secret).update(signed).digest('base64url')}`;
}
let serial = 0;
const claims = (over: Record<string, unknown> = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://portal.example',
    aud: appId,
    sub: `p-${++serial}`,
    jti: `j-${serial}`,
    iat: now,
    exp: now + 60,
    origin,
    email: `p${serial}@portal.example`,
    ...over,
  };
};

async function call(
  endpoint: string,
  init: { body?: unknown; cookie?: string; origin?: string | null; headers?: Record<string, string>; method?: string } = {},
) {
  const response = await fetch(`${origin}${endpoint}`, {
    signal: AbortSignal.timeout(10_000),
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(init.origin === null ? {} : { origin: init.origin ?? origin }),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return {
    status: response.status,
    body,
    headers: response.headers,
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; '),
  };
}
const exchange = (assertion: string, from = origin) => call('/api/auth/embed/exchange', { body: { assertion }, origin: from });
/** The tables a session reads: viewer reads incidents, a manager everything. */
const tables = async (cookie: string, headers: Record<string, string> = {}, from?: string) => {
  const schema = await call(`/api/schema?app=${appId}`, { cookie, headers, ...(from ? { origin: from } : {}) });
  return schema.status === 200 ? (schema.body.tables as Array<{ id: string }>).map((table) => table.id).sort() : schema.status;
};

before(async () => {
  Object.assign(process.env, environment);
  resetSignInState();
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE incident (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE service (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO incident VALUES (1, 'Initial incident'); INSERT INTO service VALUES (1, 'Identity service');`);
  db.close();
  jwks = createHttpServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'ES256', use: 'sig' }] }));
  });
  jwks.listen(0, '127.0.0.1');
  await once(jwks, 'listening');
  jwksUrl = `http://127.0.0.1:${(jwks.address() as { port: number }).port}/jwks.json`;
  registry = new Registry();
  registry.add({ id: connection, name: 'Embed connection', url: path, writable: true, source: 'config' });
  clearJournal(connection);
  host = {
    app: {
      path: join(directory, 'app.ts'),
      pages: [],
      sources: {},
      app: parseAppConfig(
        {
          id: appId,
          name: 'Embed Atlas',
          connection,
          resources: { incident: {}, service: {} },
          auth: {
            providers: ['email'],
            signUp: 'invite',
            defaultRole: 'viewer',
            store,
            roles: { viewer: { read: ['incident'] }, manager: { read: ['incident', 'service'] } },
          },
          views: { incident: { kind: 'list', from: 'incident' }, service: { kind: 'list', from: 'service' } },
          home: 'incident',
          nav: ['incident', 'service'],
        },
        'embed auth fixture',
      ),
    },
    pages: [],
  };
  const bound = { host: '127.0.0.1', port: 0 };
  server = createApp({ registry, apps: [host], bound });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  origin = `http://${bound.host}:${bound.port}`;
  const issuer = (entry: Record<string, unknown>) =>
    embedConnectionOf({ kind: 'embed', secret: '${EMBED_PORTAL_SECRET}', ...entry }, 'test');
  host.auth = await createAppAuth(host.app, {
    baseURL: origin,
    trustedOrigins: [origin],
    embed: [
      issuer({ name: 'portal', issuer: 'https://portal.example', origins: [origin, HOST, SIBLING] }),
      issuer({ name: 'mapped', issuer: 'https://mapped.example', origins: [origin], roles: { manager: ['sales-lead'] } }),
      issuer({ name: 'linker', issuer: 'https://linker.example', origins: [origin], accounts: 'link-verified-email' }),
      issuer({ name: 'closed', issuer: 'https://closed.example', origins: [origin], createAccounts: false }),
      issuer({ name: 'elsewhere', issuer: 'https://elsewhere.example', origins: [origin], apps: ['another-app'] }),
      issuer({ name: 'twin', issuer: 'https://twin.example', origins: [origin] }),
      issuer({ name: 'budget', issuer: 'https://budget.example', origins: [origin] }),
      embedConnectionOf(
        { name: 'keys', kind: 'embed', issuer: 'https://keys.example', jwks: jwksUrl, insecure: true, origins: [origin] },
        'test',
      ),
    ],
  });
});

after(async () => {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
  jwks.close();
  host.auth?.close();
  await registry.closeAll();
  clearJournal(connection);
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

test('a host signs its person in: the App sets its own session cookie and grants the account its role', async () => {
  const assertion = await mintEmbedAssertion({
    issuer: 'https://portal.example',
    key: SECRET,
    app: appId,
    origin,
    subject: 'u-ada',
    email: 'ada@portal.example',
    name: 'Ada Byron',
  });
  const signed = await exchange(assertion);
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  assert.equal(signed.body.token, undefined, 'the same origin gets a cookie, never a bearer');
  assert.match(signed.cookie, /mistri-[A-Za-z0-9_-]+\.session_token=/);
  const who = await call('/api/whoami', { cookie: signed.cookie });
  assert.equal(who.body.signedIn, true);
  assert.equal(who.body.who, 'ada@portal.example');
  assert.equal(who.body.accountId, signed.body.accountId);
  assert.deepEqual(await tables(signed.cookie), ['incident'], "the App's default role, as any account made here");
  // The same person again is the same account.
  const again = await exchange(
    await mintEmbedAssertion({
      issuer: 'https://portal.example',
      key: SECRET,
      app: appId,
      origin,
      subject: 'u-ada',
      email: 'ada@portal.example',
    }),
  );
  assert.equal(again.body.accountId, signed.body.accountId);
  const sessions = new DatabaseSync(store, { readOnly: true });
  try {
    assert.equal(sessions.prepare('SELECT providerId FROM account WHERE accountId = ?').get('u-ada')?.providerId, 'embed:portal');
  } finally {
    sessions.close();
  }
});

test('an assertion that is expired, too long-lived, for another App, from an unknown issuer or badly signed is refused', async () => {
  const now = Math.floor(Date.now() / 1000);
  const refused = async (token: string, code: string) => {
    const answer = await exchange(token);
    assert.equal(answer.status, 401, `${code}: ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body.code, code);
    assert.equal(answer.cookie, '', 'no session for a refused assertion');
  };
  await refused(craft(claims({ iat: now - 200, exp: now - 100 })), 'assertion_expired');
  await refused(craft(claims({ exp: now + 3600 })), 'assertion_lifetime');
  await refused(craft(claims({ aud: 'another-app' })), 'assertion_audience');
  await refused(craft(claims({ iss: 'https://evil.example' })), 'assertion_issuer');
  // An issuer the config names for another App is no issuer of this one.
  await refused(craft(claims({ iss: 'https://elsewhere.example' })), 'assertion_issuer');
  await refused(craft(claims(), OTHER), 'assertion_signature');
  await refused(craft(claims(), SECRET, { alg: 'none', typ: 'JWT' }).replace(/\.[^.]+$/, '.'), 'assertion_signature');
  await refused(craft(claims({ jti: undefined })), 'assertion_claims');
  await refused('not.a-token', 'assertion_malformed');
});

test("an issuer's JWKS signs ES256, and an HMAC made with its public key is refused", async () => {
  const signed = await exchange(
    await mintEmbedAssertion({
      issuer: 'https://keys.example',
      key: keys.privateKey,
      kid: 'k1',
      app: appId,
      origin,
      subject: 'k-1',
      email: 'k1@keys.example',
    }),
  );
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  const publicPem = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const confused = await exchange(craft(claims({ iss: 'https://keys.example' }), publicPem));
  assert.equal(confused.status, 401);
  assert.equal(confused.body.code, 'assertion_signature');
});

test('an assertion is spent once: replayed, it is refused', async () => {
  const assertion = craft(claims());
  assert.equal((await exchange(assertion)).status, 200);
  const replayed = await exchange(assertion);
  assert.equal(replayed.status, 401);
  assert.equal(replayed.body.code, 'assertion_replayed');
  assert.equal(replayed.cookie, '');
});

test('the spent ids are kept in the auth store: a second server on it refuses the replay, and sweeps what has expired', async (t) => {
  const twin = (over: Record<string, unknown> = {}) => craft(claims({ iss: 'https://twin.example', ...over }));
  const assertion = twin();
  assert.equal((await exchange(assertion)).status, 200);
  // Nothing this process holds in memory may be what refuses it below.
  resetSignInState();

  // A row of this ledger's that expired and was never swept, and one of Better Auth's own.
  const sessions = new DatabaseSync(store);
  t.after(() => sessions.close());
  const kept = sessions.prepare('SELECT expiresAt FROM verification WHERE identifier = ?').get(SPENT_ASSERTION) as { expiresAt: unknown };
  const past = typeof kept.expiresAt === 'number' ? Date.now() - 3_600_000 : new Date(Date.now() - 3_600_000).toISOString();
  const row = sessions.prepare(
    'INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
  );
  row.run('embed-stale', SPENT_ASSERTION, 'twin', past, past, past);
  row.run('native-stale', 'email-verification', 'x', past, past, past);

  // A second server on the same auth store, as a second instance behind a load balancer is.
  const bound = { host: '127.0.0.1', port: 0 };
  const other: AppHost = { app: host.app, pages: [] };
  const second = createApp({ registry, apps: [other], bound });
  second.listen(0, bound.host);
  await once(second, 'listening');
  bound.port = (second.address() as { port: number }).port;
  const secondOrigin = `http://${bound.host}:${bound.port}`;
  other.auth = await createAppAuth(host.app, {
    baseURL: secondOrigin,
    trustedOrigins: [secondOrigin],
    embed: [
      embedConnectionOf(
        { name: 'twin', kind: 'embed', issuer: 'https://twin.example', secret: '${EMBED_PORTAL_SECRET}', origins: [origin] },
        'test',
      ),
    ],
  });
  t.after(async () => {
    const closed = new Promise<void>((resolve) => second.close(() => resolve()));
    second.closeAllConnections();
    await closed;
    (other.auth as AppAuthRuntime).close();
  });
  const atSecond = (token: string) =>
    fetch(`${secondOrigin}/api/auth/embed/exchange`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ assertion: token }),
      signal: AbortSignal.timeout(10_000),
    }).then(async (reply) => ({ status: reply.status, body: (await reply.json()) as Record<string, unknown> }));
  const replayed = await atSecond(assertion);
  assert.equal(replayed.status, 401, JSON.stringify(replayed.body));
  assert.equal(replayed.body.code, 'assertion_replayed');
  // The second server takes a fresh one, so the refusal above was the replay and nothing else.
  assert.equal((await atSecond(twin())).status, 200);

  const ids = (sessions.prepare('SELECT id FROM verification').all() as { id: string }[]).map((entry) => entry.id);
  assert.ok(!ids.includes('embed-stale'), 'an expired spent id is swept');
  assert.ok(ids.includes('native-stale'), "Better Auth's own rows are its own to sweep");
  assert.ok(ids.filter((id) => id.startsWith('embed-')).length >= 2, 'the live spent ids stay');
});

test('the exchange has a budget per issuer and client address', async () => {
  const budget = (over: Record<string, unknown> = {}) => craft(claims({ iss: 'https://budget.example', ...over }));
  const from = (address: string) => ({ 'x-forwarded-for': address });
  const tryOne = (token: string, address: string) =>
    call('/api/auth/embed/exchange', { body: { assertion: token }, headers: from(address) });
  // Guesses count: a badly signed assertion spends the budget as a good one does.
  for (let i = 0; i < EMBED_EXCHANGE_BUDGET.max; i++) {
    const guess = i % 2 === 1;
    assert.equal(
      (await tryOne(guess ? craft(claims({ iss: 'https://budget.example' }), OTHER) : budget(), '203.0.113.7')).status,
      guess ? 401 : 200,
    );
  }
  const spent = await tryOne(craft(claims({ iss: 'https://budget.example' }), OTHER), '203.0.113.7');
  assert.equal(spent.status, 429, JSON.stringify(spent.body));
  assert.equal(spent.body.code, 'rate_limited');
  assert.ok(Number(spent.headers.get('retry-after')) > 0);
  assert.equal((await tryOne(budget(), '203.0.113.7')).status, 429, 'a good assertion waits too');
  // Another client of the same issuer, and the same client with another issuer, each have their own.
  assert.equal((await tryOne(budget(), '198.51.100.4')).status, 200);
  assert.equal((await tryOne(craft(claims({ iss: 'https://twin.example' })), '203.0.113.7')).status, 200);
});

test('an assertion is taken only from the origin it names, and only from origins its issuer lists', async () => {
  // Minted for the host's page, presented from the App's own: refused.
  const misplaced = await exchange(craft(claims({ origin: HOST })));
  assert.equal(misplaced.status, 401);
  assert.equal(misplaced.body.code, 'assertion_origin');
  // A page the issuer does not list, whatever the assertion says.
  const stranger = await exchange(craft(claims({ origin: STRANGER })), STRANGER);
  assert.equal(stranger.status, 403);
  assert.equal(stranger.body.code, 'origin_refused');
  assert.equal(stranger.headers.get('access-control-allow-origin'), null);
  // The mapped issuer lists only the App's origin: the host's is a stranger to it.
  const unlisted = await exchange(craft(claims({ iss: 'https://mapped.example', origin: HOST })), HOST);
  assert.equal(unlisted.status, 401);
  assert.equal(unlisted.body.code, 'assertion_origin');
});

test('login CSRF: the exchange takes JSON from a page that says where it is', async () => {
  const form = await call('/api/auth/embed/exchange', { body: undefined, method: 'POST', headers: { 'content-type': 'text/plain' } });
  assert.equal(form.status, 415);
  const nowhere = await call('/api/auth/embed/exchange', { body: { assertion: craft(claims()) }, origin: null });
  assert.equal(nowhere.status, 403);
  assert.equal(nowhere.body.code, 'origin_required');
});

test("roles come from the account; an assertion's roles count only through the issuer's mapping", async () => {
  const unmapped = await exchange(craft(claims({ roles: ['admin', 'manager', 'sales-lead'] })));
  assert.equal(unmapped.status, 200);
  assert.deepEqual(await tables(unmapped.cookie), ['incident'], 'the claim is ignored where the issuer maps nothing');
  const mapped = await exchange(craft(claims({ iss: 'https://mapped.example', roles: ['sales-lead', 'admin'] })));
  assert.equal(mapped.status, 200);
  assert.deepEqual(await tables(mapped.cookie), ['incident', 'service'], 'the mapping gives manager, and nothing it does not name');
  const notGiven = await exchange(craft(claims({ iss: 'https://mapped.example', roles: ['admin'] })));
  assert.deepEqual(await tables(notGiven.cookie), ['incident']);
});

test('accounts are separate by default; an email links only where both sides verified it, and only where the issuer says so', async () => {
  const admin = await call('/api/auth/sign-in/email', {
    body: { email: environment.MISTRI_AUTH_ADMIN_EMAIL, password: environment.MISTRI_AUTH_ADMIN_PASSWORD },
  });
  const adminId = (await call('/api/whoami', { cookie: admin.cookie })).body.accountId;
  const separate = await exchange(craft(claims({ email: 'admin@example.test', email_verified: true })));
  assert.equal(separate.status, 409);
  assert.equal(separate.body.code, 'account_exists', 'never taken over by an email claim');
  const unverified = await exchange(craft(claims({ iss: 'https://linker.example', email: 'admin@example.test' })));
  assert.equal(unverified.status, 409);
  assert.equal(unverified.body.code, 'account_unverified');
  const linked = await exchange(craft(claims({ iss: 'https://linker.example', email: 'admin@example.test', email_verified: true })));
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  assert.equal(linked.body.accountId, adminId);
  const closed = await exchange(craft(claims({ iss: 'https://closed.example' })));
  assert.equal(closed.status, 403);
  assert.equal(closed.body.code, 'no_account');
});

test('from another origin: a bearer, good on browser routes from that origin only, and a cookie never stands for anyone', async () => {
  const preflight = await call('/api/schema', {
    method: 'OPTIONS',
    origin: HOST,
    headers: {
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type, x-mistri-account',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), HOST);
  assert.equal(preflight.headers.get('vary'), 'Origin');
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null, 'no credentials: the bearer is the credential');
  const strangerPreflight = await call('/api/schema', {
    method: 'OPTIONS',
    origin: STRANGER,
    headers: { 'access-control-request-method': 'POST' },
  });
  assert.notEqual(strangerPreflight.status, 204);
  assert.equal(strangerPreflight.headers.get('access-control-allow-origin'), null);

  const signed = await exchange(craft(claims({ origin: HOST })), HOST);
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  assert.equal(signed.cookie, '', 'no cookie is set across origins');
  assert.equal(signed.headers.get('access-control-allow-origin'), HOST);
  const token = String(signed.body.token);
  const bearer = { authorization: `Bearer ${token}` };
  const who = await call('/api/whoami', { origin: HOST, headers: bearer });
  assert.equal(who.body.signedIn, true);
  assert.equal(who.headers.get('access-control-allow-origin'), HOST);
  assert.match(String(who.headers.get('access-control-expose-headers')), /x-mistri-account/);
  assert.deepEqual(await tables('', bearer, HOST), ['incident']);
  const read = await call('/api/query', { body: { app: appId, table: 'incident', columns: ['name'] }, origin: HOST, headers: bearer });
  assert.equal(read.status, 200, JSON.stringify(read.body));

  // From another origin, or on a route that is not a reader's, the bearer is nobody.
  assert.equal((await call('/api/whoami', { origin: STRANGER, headers: bearer })).body.signedIn, false);
  assert.equal(
    (await call('/api/whoami', { origin: SIBLING, headers: bearer })).body.signedIn,
    false,
    'bound to the origin it was given to',
  );
  assert.equal((await call('/api/accounts', { origin: HOST, headers: bearer })).status, 401);
  // A write still takes JSON only.
  const plain = await call('/api/query', { method: 'POST', origin: HOST, headers: { ...bearer, 'content-type': 'text/plain' } });
  assert.equal(plain.status, 403);

  // CSRF: a real session's cookie, sent cross-origin from the host's page, counts for nothing.
  const cookieSession = await exchange(craft(claims()));
  assert.equal(await tables(cookieSession.cookie, {}, HOST), 401);
  const forged = await call('/api/query', { body: { app: appId, table: 'incident' }, cookie: cookieSession.cookie, origin: HOST });
  assert.equal(forged.status, 401, JSON.stringify(forged.body));
  // ...and a cookie's value is not a bearer: only what the exchange gave this origin is.
  const cookieValue = cookieSession.cookie.split('=').slice(1).join('=');
  assert.equal((await call('/api/whoami', { origin: HOST, headers: { authorization: `Bearer ${cookieValue}` } })).body.signedIn, false);

  // The bearer is not the session cookie: replayed as one, with no Origin, it is nobody on any route.
  const asCookie = `${cookieSession.cookie.split('=')[0]}=${token}`;
  assert.equal((await call('/api/whoami', { origin: null, cookie: asCookie })).body.signedIn, false);
  assert.equal((await call('/api/auth/get-session', { origin: null, cookie: asCookie })).body?.session ?? null, null);
  assert.equal((await call('/api/query', { body: { app: appId, table: 'incident' }, origin: null, cookie: asCookie })).status, 401);

  // The host's sign-out ends it.
  const out = await call('/api/auth/embed/sign-out', { body: {}, origin: HOST, headers: bearer });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal((await call('/api/whoami', { origin: HOST, headers: bearer })).body.signedIn, false);
});

test('sign-out on the same origin ends the cookie session', async () => {
  const signed = await exchange(craft(claims()));
  const out = await call('/api/auth/embed/sign-out', { body: {}, cookie: signed.cookie });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal((await call('/api/whoami', { cookie: signed.cookie })).body.signedIn, false);
  // Another page cannot end it.
  const again = await exchange(craft(claims()));
  const forged = await call('/api/auth/embed/sign-out', { body: {}, cookie: again.cookie, origin: STRANGER });
  assert.notEqual(forged.status, 200);
  assert.equal((await call('/api/whoami', { cookie: again.cookie })).body.signedIn, true);
});

test('the config refuses wildcard, plain-http and path origins, a literal secret, and a role the App does not declare', () => {
  const entry = { name: 'portal', kind: 'embed', issuer: 'https://portal.example', secret: '${S}', origins: ['https://portal.example'] };
  assert.doesNotThrow(() => embedConnectionOf(entry, 'test'));
  for (const origins of [['*'], ['https://*.portal.example'], ['http://portal.example'], ['https://portal.example/app'], []]) {
    assert.throws(() => embedConnectionOf({ ...entry, origins }, 'test'), /origin/, JSON.stringify(origins));
  }
  assert.throws(() => embedConnectionOf({ ...entry, secret: 'a-literal-secret' }, 'test'), /reference/);
  assert.throws(() => embedConnectionOf({ ...entry, jwks: 'https://portal.example/jwks' }, 'test'), /exactly one key/);
  assert.throws(() => embedConnectionOf({ ...entry, secret: undefined, jwks: 'http://portal.example/jwks' }, 'test'), /https/);
  const problems = embedProblems(host.app.app, [embedConnectionOf({ ...entry, roles: { owner: ['boss'] } }, 'test')]);
  assert.match(problems[0], /\[embed-issuer-role-unknown\]/);
});
