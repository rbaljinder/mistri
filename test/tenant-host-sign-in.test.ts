/**
 * Sign-in on a tenant's own host (auth/hostHandoff.ts), end to end through the suite's front door: the only place a
 * request is marked as a mapped host's. The deployment's own host signs a person in; a tenant's host is handed a
 * session pinned to it, which counts there alone, and the deployment's own session counts nowhere but at home.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth, type AppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import { HOST_HANDOFF, HOST_PIN, safeReturnPath, verifierHashOf } from '../packages/mistri/src/server/auth/hostHandoff.js';
import { issueSurfaceToken, SurfaceTokenRefused } from '../packages/mistri/src/server/auth/surfaceToken.js';
import { createSuite } from '../packages/mistri/src/server/http/suite.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantAuthenticatedHttpServer, pinnedRoute } from '../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import type { TenantStoreAdministration } from '../packages/mistri/src/server/tenant/tenantStoreContract.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const appId = 'host-proof';
const STAFF = 'staff.example.test',
  NORTH = 'north.example.test',
  SOUTH = 'south.example.test';
const password = 'host-sign-in-password-123';
const SECRET = 'synthetic-host-sign-in-secret-at-least-thirty-two-characters';

async function portFor() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

/** A Domains service that lists one domain and refuses nothing: what a pinned session must never be able to reach. */
const domainsStub = {
  limit: 2,
  editors: ['member'],
  list: async () => [
    { host: 'shop.example.com', kind: 'custom', status: 'live', primary: false, claimed: true, checkedAt: null, failures: 0 },
  ],
  add: async () => {
    throw new Error('a pinned session reached add');
  },
  check: async () => {
    throw new Error('a pinned session reached check');
  },
  remove: async () => {
    throw new Error('a pinned session reached remove');
  },
  primary: async () => {
    throw new Error('a pinned session reached primary');
  },
  recheckDue: async () => ({ checked: 0, suspended: [], live: [], expired: [] }),
} as never;

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}
const cookiesOf = (answer: Answer) =>
  ((answer.headers['set-cookie'] as string[] | undefined) ?? []).map((line) => line.split(';')[0]).filter((pair) => !pair.endsWith('='));

async function fixture(t: TestContext, options: { base?: string; tenantDomain?: string; domains?: boolean } = {}) {
  const base = options.base ?? '';
  const directory = mkdtempSync(join(tmpdir(), 'mistri-host-sign-in-'));
  const business = join(directory, 'business.db'),
    store = join(directory, 'auth.db');
  const db = new DatabaseSync(business);
  db.exec('CREATE TABLE physical_item(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL)');
  const source = { id: 'business', connection: 'fixture-business' };
  const binding = { appId, source, storeId: 'fixture-store' };
  provisionSqliteTenantStore(business, binding);
  const maintenance = async (run: (admin: TenantStoreAdministration) => Promise<void>) => {
    const operations = new TransactionOperations();
    db.exec('BEGIN IMMEDIATE');
    try {
      await run(createSqliteTenantAdministration(db, operations, binding));
      await operations.finish();
      db.exec('COMMIT');
    } catch (error) {
      await operations.finish().catch(() => {});
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  };
  await maintenance(async (admin) => {
    for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
  });
  const port = await portFor();
  let auth: AppAuthRuntime | undefined;
  let owner: Awaited<ReturnType<typeof createTenantAuthenticatedHttpServer>> | undefined;
  const loaded: LoadedApp = {
    path: join(directory, 'app.ts'),
    pages: [],
    sources: {},
    app: parseAppConfig(
      {
        id: appId,
        name: 'Host proof',
        auth: { store, signUp: 'open', rows: 'tenant', roles: { member: { read: true } } },
        sources: { business: { connection: source.connection } },
        resources: { item: { physical: 'physical_item', owner: 'tenant' } },
        views: { items: { kind: 'list', from: 'item' } },
        home: 'items',
        nav: ['items'],
      },
      'host fixture',
    ),
  };
  const suite = await createSuite(
    [
      {
        id: appId,
        public: true,
        open: async (basePath, options) => {
          auth = await createAppAuth(loaded, {
            baseURL: `https://${STAFF}${basePath}`,
            listenHost: '127.0.0.1',
            trustedOrigins: [`https://${STAFF}`],
            environment: {
              BETTER_AUTH_SECRET: SECRET,
              MISTRI_TEST_AUTH_LIMITS: 'off',
              NODE_ENV: 'test',
            },
          });
          owner = await createTenantAuthenticatedHttpServer({
            loaded,
            auth,
            sourceClient: false,
            browser: true,
            mount: { base: basePath, apps: { [appId]: '' } },
            bound: { host: '127.0.0.1', port, allowedHosts: options.allowedHosts },
            publicURL: `https://${STAFF}`,
            ...(options.hosts.length ? { hosts: options.hosts } : {}),
            ...(options.hostIntent ? { hostIntent: (_app: string, host: string) => options.hostIntent!(host) } : {}),
            ...(options.suiteBase !== undefined ? { suiteBase: options.suiteBase } : {}),
            ...(options.platformHost ? { platformHost: options.platformHost } : {}),
            ...(options.domains ? { domains: domainsStub } : {}),
            enrollment: {
              policy: defineAppTenantPolicy({
                kind: 'tenant',
                appId,
                storeId: binding.storeId,
                ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
                resolveMembershipRows: () => ({ item: true }),
                resolveRows: () => ({ item: true }),
              }),
              source: { ...source, existingPath: business },
              deployment: 'browser-generation',
              roles: ['member'],
              maxLifetimeMs: 60000,
            },
          });
          const opened = owner;
          return {
            server: opened.server,
            hostSignIn: opened.hostSignIn,
            stop: opened.retire,
            close: async () => {},
          };
        },
      },
    ],
    {
      mounts: { [appId]: '' },
      ...(base ? { base } : {}),
      ...(options.tenantDomain ? { tenantDomain: { domain: options.tenantDomain, reserved: [] } } : {}),
      publicOrigin: `https://${STAFF}`,
      hosts: [
        { host: NORTH, app: appId, tenant: 'north' },
        { host: SOUTH, app: appId, tenant: 'south' },
      ],
    },
  );
  t.after(async () => {
    try {
      suite.server.closeAllConnections();
      await suite.close();
    } finally {
      auth?.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  suite.server.listen(port, '127.0.0.1');
  await once(suite.server, 'listening');

  /* Every request names its Host, as a browser on that host would; fetch cannot. */
  const send = (host: string, method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
    new Promise<Answer>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          headers: {
            host,
            ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }),
            ...headers,
          },
          timeout: 10_000,
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
        },
      );
      req.on('timeout', () => req.destroy(new Error('HTTP test timed out.')));
      req.on('error', reject);
      req.end(payload);
    });
  const signUp = async (name: string, email = `${name.toLowerCase()}@example.test`) => {
    const answer = await send(STAFF, 'POST', `${base}/api/auth/sign-up/email`, { origin: `https://${STAFF}` }, { name, email, password });
    assert.equal(answer.status, 200, answer.text);
    return {
      accountId: String((JSON.parse(answer.text) as { user: { id: string } }).user.id),
      email,
      cookie: cookiesOf(answer).join('; '),
    };
  };
  const signIn = async (email: string) => {
    const answer = await send(STAFF, 'POST', `${base}/api/auth/sign-in/email`, { origin: `https://${STAFF}` }, { email, password });
    assert.equal(answer.status, 200, answer.text);
    return cookiesOf(answer).join('; ');
  };
  const grant = (accountId: string, tenantId: string) =>
    maintenance((admin) =>
      admin.putMembership({
        tenantId,
        accountId,
        membershipId: `${tenantId}-${accountId}`,
        status: 'active',
        roles: ['member'],
        validUntil: Date.now() + 120_000,
        expectedVersion: null,
      }),
    );
  const whoami = async (host: string, cookie: string) => {
    const answer = await send(host, 'GET', `${base}/api/whoami?app=${appId}`, cookie ? { cookie } : {});
    assert.equal(answer.status, 200, answer.text);
    return JSON.parse(answer.text) as Record<string, unknown>;
  };
  /* The browser's whole trip: the tenant's host sets its verifier and leaves, the staff host mints, the handoff spends. */
  const handOff = async (staffCookie: string, host = NORTH, to = `${base}/items`) => {
    const start = await send(host, 'GET', `${base}/_mistri/sign-in?to=${encodeURIComponent(to)}`);
    assert.equal(start.status, 303, start.text);
    const verifier = cookiesOf(start).find((pair) => pair.startsWith('__Host-mistri-host-v='));
    assert.ok(verifier, 'the tenant host sets its verifier');
    const staff = new URL(String(start.headers.location));
    assert.equal(staff.host, STAFF);
    assert.equal(staff.pathname, `${base}/_mistri/host-sign-in`);
    let minted = await send(STAFF, 'GET', staff.pathname + staff.search, { cookie: staffCookie });
    // A custom domain is asked about first; the person's Continue is a same-site POST to the same address.
    if (minted.status === 200) {
      assert.match(minted.text, /<form method="post"/);
      minted = await send(STAFF, 'POST', staff.pathname + staff.search, { cookie: staffCookie, origin: `https://${STAFF}` });
    }
    assert.equal(minted.status, 303, minted.text);
    const back = new URL(String(minted.headers.location));
    return { verifier, back, minted };
  };
  const redeem = (back: URL, verifier: string | undefined) =>
    send(back.host, 'GET', back.pathname + back.search, verifier ? { cookie: verifier } : {});
  const pinnedCookie = async (staffCookie: string, host = NORTH) => {
    const { verifier, back } = await handOff(staffCookie, host);
    const answer = await redeem(back, verifier);
    assert.equal(answer.status, 303, answer.text);
    return cookiesOf(answer).join('; ');
  };
  const authDb = () => {
    const handle = new DatabaseSync(store);
    t.after(() => handle.close());
    return handle;
  };
  return { base, send, signUp, signIn, grant, whoami, handOff, redeem, pinnedCookie, authDb, runtime: () => auth! };
}

test('a code is spent once, by the browser that set out, on the host it was minted for', async (t) => {
  const f = await fixture(t);
  const olivia = await f.signUp('Olivia');
  await f.grant(olivia.accountId, 'north');
  const { verifier, back, minted } = await f.handOff(olivia.cookie, NORTH, '/items?tab=open');
  assert.equal(minted.headers['cache-control'], 'no-store');
  assert.equal(minted.headers['referrer-policy'], 'no-referrer');
  assert.equal(back.origin, `https://${NORTH}`, 'the target is the router-held host on the deployment origin scheme');
  assert.equal(back.pathname, '/_mistri/handoff');
  assert.deepEqual([...back.searchParams.keys()], ['code'], 'the landing path rides in the code, not beside it');

  // Another browser's verifier, and none at all, spend nothing.
  assert.equal((await f.redeem(back, `__Host-mistri-host-v=${'A'.repeat(43)}`)).status, 403);
  assert.equal((await f.redeem(back, undefined)).status, 403);
  // A refused attempt spends the code all the same: a guess gets one try per code.
  assert.equal((await f.redeem(back, verifier)).status, 403, 'the right verifier, after a wrong one');
  const fresh = await f.handOff(olivia.cookie);
  const spent = await f.redeem(fresh.back, fresh.verifier);
  assert.equal(spent.status, 303, spent.text);
  assert.equal(spent.headers.location, '/items');
  // A `to` added to the handoff's address is not followed: the landing path is the one minted with the code.
  const steered = await f.handOff(olivia.cookie, NORTH, '/items?tab=open');
  const sent = new URL(steered.back);
  sent.searchParams.set('to', '/elsewhere');
  const landed = await f.redeem(sent, steered.verifier);
  assert.equal(landed.status, 303, landed.text);
  assert.equal(landed.headers.location, '/items?tab=open');
  assert.equal(spent.headers['cache-control'], 'no-store');
  assert.equal(spent.headers['referrer-policy'], 'no-referrer');
  const lines = spent.headers['set-cookie'] as string[];
  const session = lines.find((line) => /session_token=[^;]/.test(line));
  assert.ok(session, 'a session cookie is set');
  assert.doesNotMatch(session, /;\s*domain=/i, 'host-only');
  assert.match(session, /;\s*httponly/i);
  assert.match(
    lines.find((line) => line.startsWith('__Host-mistri-host-v=;'))!,
    /Path=\/;.*Max-Age=0.*Secure/,
    'the verifier is cleared',
  );
  assert.equal((await f.redeem(fresh.back, fresh.verifier)).status, 403, 'a second spend of the same code');

  // Minted for north, presented on south: refused, and spent with it.
  const elsewhere = await f.handOff(olivia.cookie);
  const moved = new URL(elsewhere.back);
  moved.host = SOUTH;
  assert.equal((await f.redeem(moved, elsewhere.verifier)).status, 403);
  assert.equal((await f.redeem(elsewhere.back, elsewhere.verifier)).status, 403);
});

test('an expired code is refused, and no code is ever kept in the store', async (t) => {
  const f = await fixture(t);
  const olivia = await f.signUp('Olivia');
  await f.grant(olivia.accountId, 'north');
  const { verifier, back } = await f.handOff(olivia.cookie);
  const code = back.searchParams.get('code')!;
  const db = f.authDb();
  const rows = db.prepare('SELECT id, value, expiresAt FROM verification WHERE identifier = ?').all(HOST_HANDOFF) as Array<{
    id: string;
    value: string;
    expiresAt: unknown;
  }>;
  assert.equal(rows.length, 1);
  assert.ok(!rows[0].id.includes(code) && !rows[0].value.includes(code), 'only a digest of the code is stored');
  assert.ok(rows[0].value.includes(verifierHashOf(verifier!.split('=')[1])), 'the verifier is held as its hash');
  const past = typeof rows[0].expiresAt === 'number' ? Date.now() - 1000 : new Date(Date.now() - 1000).toISOString();
  db.prepare('UPDATE verification SET expiresAt = ? WHERE identifier = ?').run(past, HOST_HANDOFF);
  assert.equal((await f.redeem(back, verifier)).status, 403);
});

test('the staff leg sends the browser only to a host the router holds, and back only to a path on it', async (t) => {
  const f = await fixture(t);
  const olivia = await f.signUp('Olivia');
  await f.grant(olivia.accountId, 'north');
  const v = verifierHashOf('B'.repeat(43));
  // Each as the custom domain's Continue: the GET only asks (below), and mints nothing.
  const leg = (query: string, cookie = olivia.cookie, host = STAFF) =>
    f.send(host, 'POST', `/_mistri/host-sign-in?${query}`, { cookie, origin: `https://${host}` });
  for (const host of ['evil.example.test', 'north.example.test.evil', STAFF, '127.0.0.1', 'example.test'])
    assert.equal((await leg(`app=${appId}&host=${encodeURIComponent(host)}&v=${v}`)).status, 404, host);
  // The asked spelling is not echoed: the stored host is the target.
  const spelled = await leg(`app=${appId}&host=${encodeURIComponent('NORTH.example.test:8443')}&v=${v}`);
  assert.equal(spelled.status, 303);
  assert.equal(new URL(String(spelled.headers.location)).host, NORTH);
  for (const to of ['//evil.test/x', 'https://evil.test/', '/\\evil.test', 'javascript:alert(1)', 'items']) {
    const answer = await leg(`app=${appId}&host=${NORTH}&v=${v}&to=${encodeURIComponent(to)}`);
    assert.equal(answer.status, 303, to);
  }
  // Each was minted to land at the host's home, whatever was asked.
  const landings = (
    f.authDb().prepare('SELECT value FROM verification WHERE identifier = ?').all(HOST_HANDOFF) as Array<{ value: string }>
  ).map((row) => (JSON.parse(row.value) as { to: unknown }).to);
  assert.ok(landings.length >= 5);
  assert.deepEqual(new Set(landings), new Set(['/']));
  // Two `to`s, a bad verifier hash: refused before anything is minted.
  assert.equal((await leg(`app=${appId}&host=${NORTH}&v=${v}&to=/a&to=/b`)).status, 400);
  assert.equal((await leg(`app=${appId}&host=${NORTH}&v=short`)).status, 400);
  const other = await leg(`app=other&host=${NORTH}&v=${v}`);
  assert.equal(other.headers.location, undefined, 'another App is no staff leg at all');
  // Not a member of south: nothing for its host.
  assert.equal((await leg(`app=${appId}&host=${SOUTH}&v=${v}`)).status, 403);
  // Signed out: the deployment's own sign-in, which comes back here.
  const out = await leg(`app=${appId}&host=${NORTH}&v=${v}`, '');
  assert.equal(out.status, 303);
  assert.match(String(out.headers.location), /^\/_mistri\/apps\?next=%2F_mistri%2Fhost-sign-in/);
  // The staff leg is the staff host's: on a tenant's host it is no route.
  assert.equal((await leg(`app=${appId}&host=${NORTH}&v=${v}`, olivia.cookie, NORTH)).headers.location, undefined);
  // The tenant host's own leg sends nothing but a same-host path along.
  const start = await f.send(NORTH, 'GET', `/_mistri/sign-in?to=${encodeURIComponent('//evil.test')}`);
  assert.equal(new URL(String(start.headers.location)).searchParams.get('to'), '/');
});

test('a pinned session counts on its own host alone, and a staff session never on a tenant host', async (t) => {
  const f = await fixture(t);
  const olivia = await f.signUp('Olivia');
  await f.grant(olivia.accountId, 'north');
  await f.grant(olivia.accountId, 'south');
  const pinned = await f.pinnedCookie(olivia.cookie);

  const onNorth = await f.whoami(NORTH, pinned);
  assert.equal(onNorth.signedIn, true);
  assert.equal(onNorth.pinned, true);
  assert.equal((await f.whoami(SOUTH, pinned)).signedIn, false, 'a north pin on south');
  assert.equal((await f.whoami(STAFF, pinned)).signedIn, false, 'a pin replayed on the staff host');
  const staffOnNorth = await f.whoami(NORTH, olivia.cookie);
  assert.equal(staffOnNorth.signedIn, false, "the staff host's cookie on a tenant host");
  assert.equal(staffOnNorth.hostSignIn, '/_mistri/sign-in', 'and it is offered the host sign-in');
  assert.equal((await f.whoami(STAFF, olivia.cookie)).signedIn, true);

  // The pinned session reaches north's data, and nothing else by asking for it.
  const open = (tenant: string, cookie = pinned, extra = '') =>
    f.send(NORTH, 'POST', `/api/tenant/context/open?app=${appId}&tenant=${tenant}${extra}`, { cookie, origin: `https://${NORTH}` }, {});
  const opened = await open('north');
  assert.equal(opened.status, 200, opened.text);
  assert.ok((await open('south')).status >= 400, 'a north pin asking for south');
  assert.ok((await open('north', pinned, '&realm=platform')).status >= 400, 'a realm on a tenant host');
  assert.ok((await f.send(NORTH, 'GET', `/api/tenant/bootstrap?app=${appId}&realm=platform`, { cookie: pinned })).status >= 400);
  assert.ok((await open('north', olivia.cookie)).status >= 400, 'a staff cookie opening north on north');
  // The proposal routes run under the member's grant like any tenant route: a north pin reaches no south proposal,
  // whether it names south on north's host or carries the pin to south's.
  for (const path of ['/api/commands/proposals', '/api/commands/proposals/approve', '/api/commands/proposals/dismiss'])
    for (const host of [NORTH, SOUTH]) {
      const asked = await f.send(
        host,
        'POST',
        `${path}?app=${appId}&tenant=south`,
        { cookie: pinned, origin: `https://${host}` },
        { id: 'p1', command: 'x' },
      );
      assert.ok(asked.status >= 400, `${path} on ${host}: ${asked.status}`);
    }
  // Discovery on a tenant host lists its tenant alone.
  const boot = await f.send(NORTH, 'GET', `/api/tenant/bootstrap?app=${appId}`, { cookie: pinned });
  if (boot.status === 200) assert.doesNotMatch(boot.text, /"south"/);

  // The deployment's own surfaces stay closed to a pinned session on its host.
  for (const path of [
    '/api/auth/session',
    '/api/tenant/administration/open',
    '/api/tenant/invitations/open-issuer',
    '/api/tenant/support/open',
    '/api/flags',
    '/api/tokens',
  ])
    assert.ok([403, 404].includes((await f.send(NORTH, 'GET', `${path}?app=${appId}`, { cookie: pinned })).status), path);
  assert.ok(
    [401, 403, 404].includes(
      (await f.send(NORTH, 'GET', `/api/query?app=${appId}&tenant=north`, { authorization: 'Bearer anything', cookie: pinned })).status,
    ),
  );
});

test('sign-out on a tenant host ends that session; everywhere ends its staff session too, and no other', async (t) => {
  const f = await fixture(t);
  const olivia = await f.signUp('Olivia');
  await f.grant(olivia.accountId, 'north');
  const elsewhere = await f.signIn(olivia.email);
  const out = (cookie: string, query = '', origin = `https://${NORTH}`) =>
    f.send(NORTH, 'POST', `/_mistri/sign-out${query}`, { cookie, origin });

  const first = await f.pinnedCookie(olivia.cookie);
  assert.equal((await out(first, '', `https://${SOUTH}`)).status, 403, 'a cross-origin sign-out');
  const ended = await out(first);
  assert.equal(ended.status, 204, ended.text);
  assert.ok((ended.headers['set-cookie'] as string[]).some((line) => /session_token=;/.test(line) && /Max-Age=0/i.test(line)));
  assert.equal((await f.whoami(NORTH, first)).signedIn, false);
  assert.equal((await f.whoami(STAFF, olivia.cookie)).signedIn, true, 'the staff session outlives an ordinary sign-out');

  const second = await f.pinnedCookie(olivia.cookie),
    third = await f.pinnedCookie(olivia.cookie);
  const fromElsewhere = await f.pinnedCookie(elsewhere);
  assert.equal((await out(second, '?everywhere=1')).status, 204);
  assert.equal((await f.whoami(NORTH, second)).signedIn, false);
  assert.equal((await f.whoami(NORTH, third)).signedIn, false, 'a pin the same staff session handed out');
  assert.equal((await f.whoami(STAFF, olivia.cookie)).signedIn, false, 'the staff session that handed it out');
  assert.equal((await f.whoami(STAFF, elsewhere)).signedIn, true, "the account's other session");
  assert.equal((await f.whoami(NORTH, fromElsewhere)).signedIn, true, 'and the pin that one handed out');
  // A signed-out sign-out is no error, and clears nothing it does not hold.
  assert.equal((await out('')).status, 204);
  // Pins left in the store are only the live one's, under their own identifier.
  const pins = f.authDb().prepare('SELECT COUNT(*) AS n FROM verification WHERE identifier = ?').get(HOST_PIN) as { n: number };
  assert.equal(Number(pins.n), 1);
});

test('a custom domain is asked about by name before anything is minted; a platform subdomain goes straight back', async (t) => {
  const f = await fixture(t);
  const olivia = await f.signUp('Olivia');
  await f.grant(olivia.accountId, 'north');
  const v = verifierHashOf('C'.repeat(43));
  const path = `/_mistri/host-sign-in?app=${appId}&host=${NORTH}&v=${v}&to=%2Fitems`;
  const minted = () => f.authDb().prepare('SELECT COUNT(*) AS n FROM verification WHERE identifier = ?').get(HOST_HANDOFF) as { n: number };

  const asked = await f.send(STAFF, 'GET', path, { cookie: olivia.cookie });
  assert.equal(asked.status, 200, asked.text);
  assert.match(String(asked.headers['content-type']), /^text\/html/);
  assert.equal(asked.headers['cache-control'], 'no-store');
  assert.equal(asked.headers['referrer-policy'], 'same-origin');
  const csp = String(asked.headers['content-security-policy']);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, new RegExp(`form-action 'self' https://${NORTH.replace(/\./g, '\\.')}`));
  assert.doesNotMatch(csp, /script-src/);
  assert.doesNotMatch(asked.text, /<script/i);
  assert.match(asked.text, new RegExp(`Continue to ${NORTH.replace(/\./g, '\\.')}`));
  assert.match(asked.text, /olivia@example\.test/);
  assert.match(asked.text, /<form method="post" action="\/_mistri\/host-sign-in\?app=/);
  assert.match(asked.text, /href="\/_mistri\/apps"/, 'Cancel goes back to the deployment');
  assert.equal(Number(minted().n), 0, 'asking mints nothing');
  // The page escapes what it echoes, the address it posts back to included.
  const echoed = await f.send(STAFF, 'GET', `${path}&x="><b>`, { cookie: olivia.cookie });
  assert.equal(echoed.status, 200, echoed.text);
  assert.doesNotMatch(echoed.text, /"><b>/);
  assert.match(echoed.text, /&quot;&gt;&lt;b&gt;/);

  // Continue from another site, or with no proof of origin at all, is refused and mints nothing.
  for (const headers of <Array<Record<string, string>>>[
    { origin: 'https://evil.test' },
    { origin: `https://${NORTH}` },
    { origin: `https://${STAFF}`, 'sec-fetch-site': 'cross-site' },
  ])
    assert.equal((await f.send(STAFF, 'POST', path, { cookie: olivia.cookie, ...headers })).status, 403, JSON.stringify(headers));
  assert.equal(Number(minted().n), 0);
  const went = await f.send(STAFF, 'POST', path, { cookie: olivia.cookie, origin: `https://${STAFF}`, 'sec-fetch-site': 'same-origin' });
  assert.equal(went.status, 303, went.text);
  assert.equal(new URL(String(went.headers.location)).host, NORTH);
  assert.equal(Number(minted().n), 1);
  assert.equal((await f.send(STAFF, 'PUT', path, { cookie: olivia.cookie, origin: `https://${STAFF}` })).status, 405);
});

test("a subdomain of the deployment's tenant domain is its own, and is not asked about", async (t) => {
  const f = await fixture(t, { tenantDomain: 'example.test' });
  const olivia = await f.signUp('Olivia');
  await f.grant(olivia.accountId, 'north');
  const v = verifierHashOf('D'.repeat(43));
  const direct = await f.send(STAFF, 'GET', `/_mistri/host-sign-in?app=${appId}&host=${NORTH}&v=${v}`, { cookie: olivia.cookie });
  assert.equal(direct.status, 303, direct.text);
  assert.equal(new URL(String(direct.headers.location)).host, NORTH);
});

test('a session pinned to a host mints no surface token, and a token for one is admitted nowhere off it', async (t) => {
  const f = await fixture(t);
  const olivia = await f.signUp('Olivia');
  await f.grant(olivia.accountId, 'north');
  const db = f.authDb();
  const before = new Set((db.prepare('SELECT id FROM session').all() as Array<{ id: string }>).map((row) => row.id));
  const pinned = await f.pinnedCookie(olivia.cookie);
  const pinnedSession = (db.prepare('SELECT id FROM session').all() as Array<{ id: string }>)
    .map((row) => row.id)
    .find((id) => !before.has(id));
  assert.ok(pinnedSession);
  const tokens = f.runtime().surfaceTokens!;
  await assert.rejects(
    tokens.mint({ headers: new Headers({ cookie: pinned }) }, { surface: 'items' }),
    (error: unknown) => error instanceof SurfaceTokenRefused && /not signed in here/.test(error.message),
  );
  // The staff session passes the same check, and goes on to the surface's own (this App names none).
  await assert.rejects(
    tokens.mint({ headers: new Headers({ cookie: olivia.cookie }) }, { surface: 'items' }),
    (error: unknown) => error instanceof SurfaceTokenRefused && !/not signed in here/.test(error.message),
  );
  const token = issueSurfaceToken(SECRET, {
    app: appId,
    person: olivia.accountId,
    session: pinnedSession,
    surface: 'items',
    expires: Date.now() + 30_000,
  });
  assert.equal(await tokens.admit({ headers: { authorization: `Bearer ${token}` } } as unknown as IncomingMessage), undefined);
});

test('a pinned session takes no dot segment, which some layer may yet resolve', () => {
  assert.equal(pinnedRoute('/api/whoami/x'), true);
  for (const path of ['/api/x/../auth/session', '/api/./auth/session', '/api/x/..', '/api/x/.'])
    assert.equal(pinnedRoute(path), false, path);
});

test('a landing path is made header-safe when it is minted, not when it is spent', async (t) => {
  assert.equal(safeReturnPath('/items/caf\u00e9?q=\u65e5'), '/items/caf%C3%A9?q=%E6%97%A5');
  assert.equal(safeReturnPath('/items/\ud800', '/home'), '/home', 'a lone surrogate');
  assert.equal(safeReturnPath(`/${'\u00e9'.repeat(1000)}`, '/home'), '/home', 'too long once encoded');
  const f = await fixture(t);
  const olivia = await f.signUp('Olivia');
  await f.grant(olivia.accountId, 'north');
  const { verifier, back } = await f.handOff(olivia.cookie, NORTH, '/items/caf\u00e9');
  const landed = await f.redeem(back, verifier);
  assert.equal(landed.status, 303, landed.text);
  assert.equal(landed.headers.location, '/items/caf%C3%A9');
});

test("the host sign-in's addresses follow the suite's base path", async (t) => {
  const f = await fixture(t, { base: '/suite' });
  const olivia = await f.signUp('Olivia');
  await f.grant(olivia.accountId, 'north');
  const offer = await f.whoami(NORTH, '');
  assert.equal(offer.hostSignIn, '/suite/_mistri/sign-in');
  const { verifier, back } = await f.handOff(olivia.cookie);
  assert.equal(back.pathname, '/suite/_mistri/handoff');
  const landed = await f.redeem(back, verifier);
  assert.equal(landed.status, 303, landed.text);
  assert.equal(landed.headers.location, '/suite/items');
  // Asked for nothing in particular, it lands at the App's home under the base.
  const home = await f.send(NORTH, 'GET', `/suite/_mistri/sign-in?to=${encodeURIComponent('//evil.test')}`);
  assert.equal(new URL(String(home.headers.location)).searchParams.get('to'), '/suite/');
});

test('a banned account is handed no session on a tenant host', async (t) => {
  const f = await fixture(t);
  const olivia = await f.signUp('Olivia');
  await f.grant(olivia.accountId, 'north');
  const { verifier, back } = await f.handOff(olivia.cookie);
  const db = f.authDb();
  const sessions = () => Number((db.prepare('SELECT COUNT(*) AS n FROM session').get() as { n: number }).n);
  const had = sessions();
  db.prepare('UPDATE user SET banned = 1 WHERE id = ?').run(olivia.accountId);
  assert.equal((await f.redeem(back, verifier)).status, 403);
  assert.equal(sessions(), had, 'no session is made for it');
});

test("sign-out clears the session cache's cookies the request carries, beside the session's own", async (t) => {
  const f = await fixture(t);
  const olivia = await f.signUp('Olivia');
  await f.grant(olivia.accountId, 'north');
  const pinned = await f.pinnedCookie(olivia.cookie);
  const tokenName = pinned
    .split('; ')
    .map((pair) => pair.split('=')[0])
    .find((name) => name.endsWith('session_token'))!;
  const data = tokenName.replace(/session_token$/, 'session_data');
  const out = await f.send(NORTH, 'POST', '/_mistri/sign-out?everywhere=1', {
    cookie: `${pinned}; ${data}=a; ${data}.0=b; ${data}.1=c; ${data}.x=d`,
    origin: `https://${NORTH}`,
  });
  assert.equal(out.status, 204, out.text);
  const cleared = (out.headers['set-cookie'] as string[]).filter((line) => /Max-Age=0/i.test(line)).map((line) => line.split('=')[0]);
  for (const name of [tokenName, data, `${data}.0`, `${data}.1`]) assert.ok(cleared.includes(name), name);
  assert.ok(!cleared.includes(`${data}.x`), 'a name that is no chunk of it');
  assert.equal((await f.whoami(NORTH, pinned)).signedIn, false);
  assert.equal((await f.whoami(STAFF, olivia.cookie)).signedIn, false);
});

test("a session pinned to a tenant's own host is refused the Domains routes there, for a read and for every change", async (t) => {
  const f = await fixture(t, { domains: true });
  const olivia = await f.signUp('Olivia');
  await f.grant(olivia.accountId, 'north');
  const pinned = await f.pinnedCookie(olivia.cookie);
  const opened = await f.send(
    NORTH,
    'POST',
    `/api/tenant/context/open?app=${appId}&tenant=north`,
    { cookie: pinned, origin: `https://${NORTH}` },
    {},
  );
  assert.equal(opened.status, 200, opened.text);
  const lease = JSON.parse(opened.text) as { tabId: string; context: string; revision: number };
  const leaseHeaders = {
    cookie: pinned,
    origin: `https://${NORTH}`,
    'x-mistri-tab': lease.tabId,
    'x-mistri-context': lease.context,
    'x-mistri-lease-revision': String(lease.revision),
  };
  // The same session on the same lease reads the tenant's own data there: only the Domains routes are closed to it.
  assert.equal((await f.send(NORTH, 'GET', `/api/schema?app=${appId}&tenant=north`, leaseHeaders)).status, 200);
  for (const [path, body] of [
    ['/api/domains', {}],
    ['/api/domains/add', { host: 'pinned.example.com' }],
    ['/api/domains/check', { host: 'shop.example.com' }],
    ['/api/domains/primary', { host: 'shop.example.com' }],
    ['/api/domains/remove', { host: 'shop.example.com' }],
  ] as const) {
    const answer = await f.send(NORTH, 'POST', `${path}?app=${appId}&tenant=north`, leaseHeaders, body);
    assert.equal(answer.status, 403, `${path}: ${answer.text}`);
    assert.doesNotMatch(answer.text, /shop\.example\.com|records/);
  }
});
