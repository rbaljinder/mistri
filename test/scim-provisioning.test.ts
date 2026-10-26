/**
 * SCIM 2.0 provisioning, end to end over HTTP (packages/mistri/src/server/auth/scimDirectory.ts):
 * two directories, each bound to its own identity provider, provision a
 * platform App in a SQLite auth file. What it proves:
 *
 *   - the config entry and its problems (scimConfig.ts): references only,
 *     a provider with domains, one directory a provider, mapped roles the App
 *     declares for a person and never the claims';
 *   - a missing, wrong or short token is refused, and one directory's token
 *     never reaches the other's people;
 *   - an address outside the provider's domains is a 409, on create and on
 *     a change of address;
 *   - a verified account is linked as it is; an unverified one loses what it
 *     held; anyone else gets a new account;
 *   - a group gives and takes exactly its mapped role, and an operator's role
 *     stays (Entra's legacy group schema and Okta's PATCH shapes);
 *   - a deactivation bans the account, ends its sessions and revokes its API
 *     tokens and OAuth grants; a reactivation lifts only the directory's own
 *     ban, and what was revoked stays revoked; a DELETE leaves a tombstone a
 *     later create relinks;
 *   - only the plugin's `/scim/v2/` routes are reachable, and each connection
 *     has its own rate;
 *   - a tenant's own directory writes that tenant's member rows and never
 *     touches the global account or another tenant's people.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Server } from 'node:http';
import { createApp } from './support/createApp.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadApp, type AppHost, type LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { captureAppAuthRuntime, createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { oidcConnectionOf, type FederatedProviderConfig } from '../packages/mistri/src/server/auth/identityConfig.js';
import {
  checkScimDirectories,
  scimConnectionOf,
  scimProblems,
  type ScimDirectoryConfig,
} from '../packages/mistri/src/server/auth/scimConfig.js';
import { serviceConnectionOf } from '../packages/engine/src/server/configSections.js';
import { CONFIG_SECTIONS } from '../packages/mistri/src/server/serviceConnections.js';
import { provisionSqliteApiTokenStore } from '../packages/mistri/src/server/auth/provisionSqliteApiTokenStore.js';
import { captureAuthStoreExclusion } from '../packages/mistri/src/server/auth/sqliteStoreIdentity.js';
import { SQLITE_API_TOKEN_TABLES } from '../packages/mistri/src/adapters/auth/sqliteApiTokenLayout.js';
import { signInState } from '../packages/mistri/src/server/auth/signInState.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { makeDemoDatabase, seedDemoDatabase } from './make-demo-db.js';
import { startMockOidc, type MockOidc } from './support/mockOidc.js';
import { tenantSupportFixture } from './support/tenantSupportFixture.js';

process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-thirty-two-characters-long';

const ENTRA_TOKEN = 'entra-scim-token-0123456789abcdefghijklmnop';
const ENTRA_NEXT = 'entra-scim-token-rotated-0123456789abcdefgh';
const OKTA_TOKEN = 'okta-scim-token-0123456789abcdefghijklmnopq';
const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const ENTRA_LEGACY_GROUP = 'http://schemas.microsoft.com/2006/11/ResourceManagement/ADSCIM/2.0/Group';

const provider = (name: string, extra: Record<string, unknown> = {}) =>
  oidcConnectionOf(
    { name, kind: 'oidc', issuer: 'https://idp.example', clientId: 'c', clientSecret: '${TEST_SCIM_IDP_SECRET}', ...extra },
    'test',
  );
const directory = (entry: Record<string, unknown>) => scimConnectionOf({ kind: 'scim', ...entry }, 'test');

describe('a SCIM directory entry', () => {
  test('takes references for tokens, a provider by name, and a map of roles to group names', () => {
    const entry = directory({ name: 'entra', tokens: ['${A}', '${B}'], provider: 'workforce', roles: { manager: ['Sales Managers'] } });
    assert.deepEqual(entry, {
      kind: 'scim',
      name: 'entra',
      tokens: ['${A}', '${B}'],
      provider: 'workforce',
      roles: { manager: ['Sales Managers'] },
    });
    assert.deepEqual(
      serviceConnectionOf(CONFIG_SECTIONS, { name: 'entra', kind: 'scim', tokens: ['${A}'], provider: 'workforce' }, 'test'),
      {
        kind: 'scim',
        name: 'entra',
        tokens: ['${A}'],
        provider: 'workforce',
      },
    );
    assert.throws(
      () => directory({ name: 'entra', tokens: ['literal-token-value-that-is-long-enough'], provider: 'workforce' }),
      /never in this file/,
    );
    assert.throws(() => directory({ name: 'entra', tokens: ['${A}', '${B}', '${C}'], provider: 'workforce' }), /one or two/);
    assert.throws(() => directory({ name: 'entra', tokens: ['${A}', '${A}'], provider: 'workforce' }), /same token twice/);
    assert.throws(() => directory({ name: 'entra', tokens: ['${A}'], provider: 'workforce', url: 'x' }), /takes no "url"/);
    assert.throws(() => directory({ name: 'entra', tokens: ['${A}'] }), /needs "provider"/);
    assert.throws(() => directory({ name: 'entra', tokens: ['${A}'], provider: 'workforce', roles: { manager: [] } }), /nonempty list/);
  });

  test('needs a provider the file names, with domains, and one directory a provider', () => {
    const fenced = provider('workforce', { domains: ['crew.example'] });
    const open = provider('partners');
    const entra = directory({ name: 'entra', tokens: ['${A}'], provider: 'workforce' });
    assert.doesNotThrow(() => checkScimDirectories([entra], [fenced], 'c.json'));
    assert.throws(() => checkScimDirectories([entra], [], 'c.json'), /no oidc or saml entry has that name/);
    assert.throws(
      () => checkScimDirectories([directory({ name: 'okta', tokens: ['${A}'], provider: 'partners' })], [open], 'c.json'),
      /give "partners" its "domains"/,
    );
    assert.throws(
      () => checkScimDirectories([entra, directory({ name: 'second', tokens: ['${B}'], provider: 'workforce' })], [fenced], 'c.json'),
      /a provider has one directory/,
    );
    // Domains alone fence an App-wide provider; a tenant's provider still says both.
    assert.deepEqual(fenced.domains, ['crew.example']);
    assert.throws(() => provider('north', { tenant: 'north' }), /"tenant" and no "domains"/);
  });

  test("is judged against the App: its provider, the App's own person roles, never the claims'", () => {
    const app = (auth: Record<string, unknown>) =>
      parseAppConfig(
        {
          id: 'crew',
          name: 'Crew',
          resources: { work_order: {} },
          auth,
          views: { orders: { kind: 'list', from: 'work_order' } },
          home: 'orders',
          nav: ['orders'],
        },
        'test',
      );
    const providers: FederatedProviderConfig[] = [provider('workforce', { domains: ['crew.example'] })];
    const with_ = (roles: Record<string, string[]>, apps?: string[]): ScimDirectoryConfig[] => [
      directory({ name: 'entra', tokens: ['${A}'], provider: 'workforce', roles, ...(apps ? { apps } : {}) }),
    ];
    const crew = app({
      providers: ['oidc:workforce'],
      roles: {
        viewer: { read: true },
        manager: { read: true },
        approver: { read: true, claims: { groups: ['approvers'] } },
        robot: { read: true, service: true },
      },
    });
    assert.deepEqual(scimProblems(crew, with_({ manager: ['Sales Managers'], admin: ['Admins'] }), providers), []);
    const codes = (found: string[]) => found.map((problem) => /\[(scim-[a-z-]+)\]/.exec(problem)?.[1]);
    assert.deepEqual(codes(scimProblems(crew, with_({ owner: ['Owners'] }), providers)), ['scim-role-unknown']);
    assert.deepEqual(codes(scimProblems(crew, with_({ approver: ['Approvers'] }), providers)), ['scim-role-claims']);
    assert.deepEqual(codes(scimProblems(crew, with_({ robot: ['Robots'] }), providers)), ['scim-role-service']);
    // Named for an App that does not sign people in through its provider.
    const email = app({ providers: ['email'], roles: { viewer: { read: true } } });
    assert.deepEqual(codes(scimProblems(email, with_({ viewer: ['All'] }, ['crew']), providers)), ['scim-provider-unused']);
    // An App with no "auth" at all.
    const plain = parseAppConfig(
      {
        id: 'crew',
        name: 'Crew',
        resources: { work_order: {} },
        views: { orders: { kind: 'list', from: 'work_order' } },
        home: 'orders',
        nav: ['orders'],
      },
      'test',
    );
    assert.deepEqual(codes(scimProblems(plain, with_({ viewer: ['All'] }, ['crew']), providers)), ['scim-no-auth']);
  });
});

describe('SCIM provisioning', () => {
  let tmp: string;
  let server: Server;
  let origin = '';
  let host: AppHost;
  let loaded: LoadedApp;
  let workforce: MockOidc;
  let partners: MockOidc;
  let store: string;
  let db: DatabaseSync;
  let identity: FederatedProviderConfig[];
  let directories: ScimDirectoryConfig[];
  const environment = ['TEST_WORKFORCE_SECRET', 'TEST_PARTNERS_SECRET', 'TEST_ENTRA_TOKEN', 'TEST_ENTRA_NEXT', 'TEST_OKTA_TOKEN'];
  const log = console.log;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'tablewalk-scim-'));
    workforce = await startMockOidc({ clientId: 'workforce-client', path: '/workforce' });
    partners = await startMockOidc({ clientId: 'partners-client', path: '/partners' });
    process.env.TEST_WORKFORCE_SECRET = workforce.clientSecret;
    process.env.TEST_PARTNERS_SECRET = partners.clientSecret;
    process.env.TEST_ENTRA_TOKEN = ENTRA_TOKEN;
    process.env.TEST_ENTRA_NEXT = ENTRA_NEXT;
    process.env.TEST_OKTA_TOKEN = OKTA_TOKEN;
    const business = join(tmp, 'app.db');
    makeDemoDatabase(business);
    seedDemoDatabase(business, { scale: 3 });
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
          signUp: 'open',
          store,
          defaultRole: 'viewer',
          roles: { viewer: { read: true }, manager: { read: true }, auditor: { read: true } },
        },
        views: { 'work-orders': { kind: 'list', from: 'work_order' } },
        home: 'work-orders',
        nav: ['work-orders'],
      }),
    );
    loaded = await loadApp(dir);
    const registry = new Registry();
    registry.add({ name: 'rw', url: business, source: 'config' });
    registry.setActive('rw');
    await registry.open('rw');
    host = { app: loaded, pages: [] };
    server = createApp({ registry, apps: [host], bound: { host: '127.0.0.1', port: 0 } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    identity = [
      oidcConnectionOf(
        {
          name: 'workforce',
          kind: 'oidc',
          issuer: workforce.issuer,
          clientId: workforce.clientId,
          clientSecret: '${TEST_WORKFORCE_SECRET}',
          domains: ['crew.example'],
          insecure: true,
        },
        'test',
      ),
      oidcConnectionOf(
        {
          name: 'partners',
          kind: 'oidc',
          issuer: partners.issuer,
          clientId: partners.clientId,
          clientSecret: '${TEST_PARTNERS_SECRET}',
          domains: ['partner.example'],
          insecure: true,
        },
        'test',
      ),
    ];
    directories = [
      directory({
        name: 'entra',
        tokens: ['${TEST_ENTRA_TOKEN}', '${TEST_ENTRA_NEXT}'],
        provider: 'workforce',
        roles: { manager: ['Sales Managers'] },
      }),
      directory({ name: 'okta', tokens: ['${TEST_OKTA_TOKEN}'], provider: 'partners', roles: { manager: ['Partner Leads'] } }),
    ];
    console.log = () => {};
    // The auth file first, then its API token store beside the accounts, then the server on both.
    (await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin], identity })).close();
    provisionSqliteApiTokenStore(store, { appId: loaded.app.id, storeId: randomUUID(), exclusions: [captureAuthStoreExclusion(business)] });
    host.auth = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin], identity, scim: directories });
    db = new DatabaseSync(store);
  });

  after(async () => {
    console.log = log;
    db?.close();
    server?.close();
    server?.closeAllConnections();
    host.auth?.close();
    await workforce?.close();
    await partners?.close();
    for (const name of environment) delete process.env[name];
    rmSync(tmp, { recursive: true, force: true });
  });

  const scim = async (path: string, init: { method?: string; body?: unknown; token?: string | null } = {}) => {
    const token = init.token === undefined ? ENTRA_TOKEN : init.token;
    const res = await fetch(`${origin}/api/auth/scim/v2${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.body === undefined ? {} : { 'content-type': 'application/scim+json' }),
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
    return { status: res.status, json, text, headers: res.headers };
  };
  const entraUser = (email: string, externalId: string, active = true) => ({
    schemas: [USER, 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'],
    externalId,
    userName: email,
    active,
    displayName: email.split('@')[0],
    emails: [{ primary: true, type: 'work', value: email }],
    name: { formatted: email.split('@')[0], familyName: 'Lee', givenName: email.split('@')[0] },
  });
  const user = (email: string) => db.prepare('SELECT * FROM "user" WHERE email = ?').get(email) as Record<string, unknown> | undefined;
  const signUp = async (email: string) => {
    const res = await fetch(`${origin}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'a-password-long-enough-1', name: email.split('@')[0] }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    return res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
  };
  const session = async (cookie: string) => {
    const res = await fetch(`${origin}/api/auth/get-session`, { headers: { origin, cookie } });
    return (await res.json()) as { user?: { id: string } } | null;
  };
  const audit = (email: string) =>
    (
      db.prepare('SELECT action, actorId FROM accountAudit WHERE targetEmail = ? ORDER BY rowid').all(email) as Array<
        Record<string, unknown>
      >
    ).map((row) => `${row.action}:${row.actorId}`);
  /** A live API token and OAuth grant for the account, as the token store holds them. */
  const credentials = (accountId: string) => {
    const t = SQLITE_API_TOKEN_TABLES;
    const now = Date.now() - 1000;
    const token = randomUUID(),
      grant = randomUUID(),
      client = `twc1.${randomUUID()}`;
    db.prepare(`INSERT INTO "${t.token}" (token_id, app_id, subject_kind, subject_id, label, roles_json, created_at, created_by, expires_at, format, digest, version)
      VALUES (?, ?, 'account', ?, 'cli', '["viewer"]', ?, ?, ?, 'twa1', ?, '1')`).run(
      token,
      loaded.app.id,
      accountId,
      now,
      accountId,
      now + 3_600_000,
      'a'.repeat(64),
    );
    db.prepare(`INSERT INTO "${t.client}" (client_id, redirect_uris_json, created_at) VALUES (?, '["http://127.0.0.1/cb"]', ?)`).run(
      client,
      now,
    );
    db.prepare(`INSERT INTO "${t.grant}" (grant_id, client_id, subject, app_id, version, roles_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, 1, '["viewer"]', ?, ?)`).run(grant, client, accountId, loaded.app.id, now, now + 3_600_000);
    return {
      token: () =>
        db.prepare(`SELECT revoked_at, revoked_by, version FROM "${t.token}" WHERE token_id = ?`).get(token) as Record<string, unknown>,
      grant: () => db.prepare(`SELECT revoked_at FROM "${t.grant}" WHERE grant_id = ?`).get(grant) as Record<string, unknown>,
    };
  };

  test('a directory needs its token: none, a wrong one and a short one are refused', async () => {
    assert.equal((await scim('/Users', { token: null })).status, 401);
    assert.equal((await scim('/Users', { token: 'not-the-token-0123456789abcdefghijklmn' })).status, 401);
    assert.equal((await scim('/Users')).status, 200);
    // Both of a rotating pair work.
    assert.equal((await scim('/Users', { token: ENTRA_NEXT })).status, 200);
    // At startup: an unset or a short token refuses the App.
    const short = [directory({ name: 'entra', tokens: ['${TEST_SCIM_SHORT}'], provider: 'workforce' })];
    process.env.TEST_SCIM_SHORT = 'too-short';
    try {
      await assert.rejects(
        createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin], identity, scim: short }),
        /shorter than 32 characters/,
      );
      delete process.env.TEST_SCIM_SHORT;
      await assert.rejects(createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin], identity, scim: short }), /which is not set/);
    } finally {
      delete process.env.TEST_SCIM_SHORT;
    }
  });

  test("only the plugin's /scim/v2/ routes answer: its server-only operations have no address", async () => {
    const { scim: plugin } = (await import('@better-auth/scim')) as unknown as {
      scim: (o: Record<string, unknown>) => { endpoints: Record<string, { path?: string }> };
    };
    const built = plugin({ connections: [{ id: 'x', credentials: [{ type: 'bearer', id: 'x-0', token: ENTRA_TOKEN }] }] });
    const routed = Object.entries(built.endpoints).filter(([, endpoint]) => endpoint.path);
    assert.ok(routed.length >= 10);
    for (const [name, endpoint] of routed) assert.match(endpoint.path!, /^\/scim\/v2\//, name);
    for (const name of ['decommissionSCIMConnection', 'reconcileSCIMProjection'])
      assert.equal(built.endpoints[name]?.path, undefined, name);
    for (const path of ['decommission-connection', 'reconcile-projection', 'v2/../decommission', 'managed-connections']) {
      const res = await fetch(`${origin}/api/auth/scim/${path}`, { method: 'POST', headers: { authorization: `Bearer ${ENTRA_TOKEN}` } });
      assert.equal(res.status, 404, path);
    }
  });

  test("an address outside the provider's domains is a 409, and one directory never reaches another's people", async () => {
    const outside = await scim('/Users', { body: entraUser('eve@elsewhere.example', 'e-eve') });
    assert.equal(outside.status, 409, outside.text);
    assert.equal(user('eve@elsewhere.example'), undefined);
    // Okta's provider is partner.example: a crew address is not its to make.
    assert.equal((await scim('/Users', { body: entraUser('rae@crew.example', 'o-rae'), token: OKTA_TOKEN })).status, 409);
    const made = await scim('/Users', { body: entraUser('rae@crew.example', 'e-rae') });
    assert.equal(made.status, 201, made.text);
    assert.equal((await scim(`/Users/${made.json.id}`, { token: OKTA_TOKEN })).status, 404);
    assert.equal((await scim('/Users', { token: OKTA_TOKEN })).json.totalResults, 0);
  });

  test('a new person gets an account with no password; a verified one is linked; an unverified one loses what it held', async () => {
    const created = await scim('/Users', { body: entraUser('kim@crew.example', 'e-kim') });
    assert.equal(created.status, 201, created.text);
    const kim = user('kim@crew.example')!;
    assert.equal(kim.role, 'viewer');
    assert.equal((db.prepare('SELECT count(*) AS n FROM account WHERE userId = ?').get(String(kim.id)) as { n: number }).n, 0);
    // Entra's filter, as it asks before a create.
    const found = await scim(`/Users?filter=${encodeURIComponent('userName eq "kim@crew.example"')}`);
    assert.equal(found.json.totalResults, 1);

    const patCookie = await signUp('pat@crew.example');
    db.prepare('UPDATE "user" SET emailVerified = 1 WHERE email = ?').run('pat@crew.example');
    const linked = await scim('/Users', { body: entraUser('pat@crew.example', 'e-pat') });
    assert.equal(linked.status, 201, linked.text);
    assert.equal((await session(patCookie))?.user?.id, user('pat@crew.example')!.id);

    const squatCookie = await signUp('squat@crew.example');
    const squat = user('squat@crew.example')!;
    assert.equal((await scim('/Users', { body: entraUser('squat@crew.example', 'e-squat') })).status, 201);
    assert.equal(await session(squatCookie), null);
    assert.equal((db.prepare('SELECT count(*) AS n FROM account WHERE userId = ?').get(String(squat.id)) as { n: number }).n, 0);

    // A change of address outside the domains is refused, and nothing changes.
    const moved = await scim(`/Users/${created.json.id}`, {
      method: 'PATCH',
      body: { schemas: [PATCH], Operations: [{ op: 'replace', path: 'emails[type eq "work"].value', value: 'kim@elsewhere.example' }] },
    });
    assert.equal(moved.status, 409, moved.text);
    assert.equal(user('kim@crew.example')?.id, kim.id);
  });

  test("a group gives and takes exactly its mapped role; an operator's role stays (Entra and Okta shapes)", async () => {
    const pat = user('pat@crew.example')!;
    db.prepare('UPDATE "user" SET role = ? WHERE id = ?').run('viewer,auditor', String(pat.id));
    const scimPat = (await scim(`/Users?filter=${encodeURIComponent('userName eq "pat@crew.example"')}`)).json.Resources as Array<{
      id: string;
    }>;
    // Entra's POST /Groups still carries the classic schema marker.
    const group = await scim('/Groups', {
      body: {
        schemas: [GROUP, ENTRA_LEGACY_GROUP],
        externalId: 'g-sales',
        displayName: 'Sales Managers',
        members: [{ value: scimPat[0].id }],
      },
    });
    assert.equal(group.status, 201, group.text);
    assert.deepEqual(String(user('pat@crew.example')!.role).split(','), ['viewer', 'auditor', 'manager']);
    // Okta removes a member with a filtered path.
    const removed = await scim(`/Groups/${group.json.id}`, {
      method: 'PATCH',
      body: { schemas: [PATCH], Operations: [{ op: 'remove', path: `members[value eq "${scimPat[0].id}"]` }] },
    });
    assert.ok(removed.status === 200 || removed.status === 204, removed.text);
    assert.deepEqual(String(user('pat@crew.example')!.role).split(','), ['viewer', 'auditor']);
    // Entra adds one back with its capitalised op.
    const added = await scim(`/Groups/${group.json.id}`, {
      method: 'PATCH',
      body: { schemas: [PATCH], Operations: [{ op: 'Add', path: 'members', value: [{ value: scimPat[0].id }] }] },
    });
    assert.ok(added.status === 200 || added.status === 204, added.text);
    assert.deepEqual(String(user('pat@crew.example')!.role).split(','), ['viewer', 'auditor', 'manager']);
    assert.deepEqual(audit('pat@crew.example'), ['setRoles:scim:entra', 'setRoles:scim:entra', 'setRoles:scim:entra']);
  });

  test('a deactivation bans, ends sessions and revokes tokens; a reactivation lifts only its own ban, and what was revoked stays so', async () => {
    const cookie = await (async () => {
      db.prepare('UPDATE "user" SET emailVerified = 1 WHERE email = ?').run('pat@crew.example');
      const res = await fetch(`${origin}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'pat@crew.example', password: 'a-password-long-enough-1' }),
      });
      assert.equal(res.status, 200);
      return res.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
    })();
    const pat = user('pat@crew.example')!;
    const held = credentials(String(pat.id));
    const runtime = captureAppAuthRuntime(host.auth!);
    assert.ok(runtime.lookupEligibleAccount(String(pat.id)));
    const id = (
      (await scim(`/Users?filter=${encodeURIComponent('userName eq "pat@crew.example"')}`)).json.Resources as Array<{ id: string }>
    )[0].id;
    // Entra says "False", a string, in a PATCH without a value object.
    const off = await scim(`/Users/${id}`, {
      method: 'PATCH',
      body: { schemas: [PATCH], Operations: [{ op: 'Replace', path: 'active', value: 'False' }] },
    });
    assert.equal(off.status, 200, off.text);
    const banned = user('pat@crew.example')!;
    assert.equal(banned.banned, 1);
    assert.equal(banned.banReason, 'mistri:scim:entra');
    assert.equal(await session(cookie), null);
    assert.equal(runtime.lookupEligibleAccount(String(pat.id)), null);
    const revoked = held.token();
    assert.ok(revoked.revoked_at !== null);
    assert.equal(revoked.revoked_by, 'scim:entra');
    assert.equal(revoked.version, '2');
    assert.ok(held.grant().revoked_at !== null);

    // Okta's shape: a value object.
    const on = await scim(`/Users/${id}`, {
      method: 'PATCH',
      body: { schemas: [PATCH], Operations: [{ op: 'replace', value: { active: true } }] },
    });
    assert.equal(on.status, 200, on.text);
    assert.equal(user('pat@crew.example')!.banned, 0);
    assert.ok(runtime.lookupEligibleAccount(String(pat.id)));
    assert.deepEqual(held.token(), revoked);
    // A deactivated person's groups give nothing: the mapped role goes with the account, and comes back with it.
    assert.deepEqual(audit('pat@crew.example').slice(-4), [
      'setRoles:scim:entra',
      'deactivate:scim:entra',
      'setRoles:scim:entra',
      'reactivate:scim:entra',
    ]);
    assert.deepEqual(String(user('pat@crew.example')!.role).split(','), ['viewer', 'auditor', 'manager']);

    // An administrator's ban is not the directory's to lift.
    const kim = user('kim@crew.example')!;
    db.prepare('UPDATE "user" SET banned = 1, banReason = ? WHERE id = ?').run('Deactivated by admin@crew.example', String(kim.id));
    const kimId = (
      (await scim(`/Users?filter=${encodeURIComponent('userName eq "kim@crew.example"')}`)).json.Resources as Array<{ id: string }>
    )[0].id;
    for (const active of [false, true]) {
      assert.equal(
        (await scim(`/Users/${kimId}`, { method: 'PATCH', body: { schemas: [PATCH], Operations: [{ op: 'replace', value: { active } }] } }))
          .status,
        200,
      );
    }
    assert.equal(user('kim@crew.example')!.banned, 1);
    assert.equal(user('kim@crew.example')!.banReason, 'Deactivated by admin@crew.example');
  });

  test('a DELETE bans and leaves a tombstone; a later create with the same externalId relinks the account', async () => {
    const rae = user('rae@crew.example')!;
    const id = (
      (await scim(`/Users?filter=${encodeURIComponent('userName eq "rae@crew.example"')}`)).json.Resources as Array<{ id: string }>
    )[0].id;
    assert.equal((await scim(`/Users/${id}`, { method: 'DELETE' })).status, 204);
    assert.equal(user('rae@crew.example')!.banned, 1);
    assert.equal(user('rae@crew.example')!.banReason, 'mistri:scim:entra');
    assert.equal(
      (db.prepare('SELECT count(*) AS n FROM scimIdentityTombstone WHERE userId = ?').get(String(rae.id)) as { n: number }).n,
      1,
    );
    const again = await scim('/Users', { body: entraUser('rae@crew.example', 'e-rae') });
    assert.equal(again.status, 201, again.text);
    assert.equal(user('rae@crew.example')!.id, rae.id);
    assert.equal(user('rae@crew.example')!.banned, 0);
  });

  test('each connection has its own rate: one spent leaves the other answering', async () => {
    for (let i = 0; i < 600; i++) await signInState.consume('scim:okta', { window: 60, max: 600 });
    const limited = await scim('/Users', { token: OKTA_TOKEN });
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get('retry-after'));
    assert.equal((await scim('/Users')).status, 200);
  });
});

test("a tenant's own directory makes and ends that tenant's members, and never touches the global account", async (t) => {
  const north = await startMockOidc({ clientId: 'north-client', path: '/north' });
  process.env.TEST_NORTH_SECRET = north.clientSecret;
  process.env.TEST_NORTH_SCIM = ENTRA_TOKEN;
  t.after(async () => {
    await north.close();
    delete process.env.TEST_NORTH_SECRET;
    delete process.env.TEST_NORTH_SCIM;
  });
  const log = console.log;
  console.log = () => {};
  t.after(() => {
    console.log = log;
  });
  const f = await tenantSupportFixture(t, 'sqlite', {
    manifest: (raw) => {
      (raw.auth as Record<string, unknown>).providers = ['email', 'oidc:*'];
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
    ],
    scim: [
      directory({ name: 'north-dir', tokens: ['${TEST_NORTH_SCIM}'], provider: 'north-sso', roles: { dealer_staff: ['North Staff'] } }),
    ],
    // The tenant owner this directory writes through; nobody operates it by hand here.
    tenantPolicy: {
      administration: {
        id: 'dealer-management',
        version: 'v1',
        maxMembershipLifetimeMs: 3_600_000,
        operators: [{ accountId: 'nobody', tenants: ['north'], operations: ['setTenantStatus'], roles: [] }],
      },
    },
  });
  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await fetch(`${f.origin}/api/auth/scim/v2${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { authorization: `Bearer ${ENTRA_TOKEN}`, ...(init.body === undefined ? {} : { 'content-type': 'application/scim+json' }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await res.text();
    return { status: res.status, text, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  };
  const person = (email: string, externalId: string) => ({
    schemas: [USER],
    externalId,
    userName: email,
    active: true,
    emails: [{ primary: true, type: 'work', value: email }],
    name: { givenName: email.split('@')[0], familyName: 'North' },
  });
  const members = async (accountId: string) =>
    (
      await f.rows(
        `SELECT status, roles_json, valid_until FROM "${TENANT_TABLES.membership}" WHERE tenant_id = 'north' AND account_id = ? AND kind = 'member' ORDER BY rowid`,
        [accountId],
      )
    ).map((row) => `${row.status}:${row.roles_json}`);
  const account = () =>
    f.authDb().prepare('SELECT id, banned, role FROM "user" WHERE email = ?').get('kim@north.example') as Record<string, unknown>;

  // Another tenant's address, or anyone's outside the provider's domains, is not this directory's.
  assert.equal((await call('/Users', { body: person('lee@south.example', 'n-lee') })).status, 409);
  assert.equal((await call('/Users', { body: person(f.accounts.sam.email, 'n-sam') })).status, 409);

  const kim = await call('/Users', { body: person('kim@north.example', 'n-kim') });
  assert.equal(kim.status, 201, kim.text);
  const id = String(account().id);
  // In no mapped group: no member row yet.
  assert.deepEqual(await members(id), []);
  const group = await call('/Groups', { body: { schemas: [GROUP], displayName: 'North Staff', members: [{ value: kim.json.id }] } });
  assert.equal(group.status, 201, group.text);
  assert.deepEqual(await members(id), ['active:["dealer_staff"]']);
  assert.equal(
    (await f.rows(`SELECT valid_until FROM "${TENANT_TABLES.membership}" WHERE account_id = ?`, [id]))[0].valid_until,
    Number.MAX_SAFE_INTEGER,
  );

  const active = (value: boolean) =>
    call(`/Users/${kim.json.id}`, {
      method: 'PATCH',
      body: { schemas: [PATCH], Operations: [{ op: 'replace', value: { active: value } }] },
    });
  assert.equal((await active(false)).status, 200);
  assert.deepEqual(await members(id), ['revoked:["dealer_staff"]']);
  // The global account is the platform's: never banned by a tenant's directory.
  assert.equal(account().banned, 0);
  assert.equal((await active(true)).status, 200);
  assert.deepEqual(await members(id), ['revoked:["dealer_staff"]', 'active:["dealer_staff"]']);
  assert.equal((await call(`/Users/${kim.json.id}`, { method: 'DELETE' })).status, 204);
  assert.deepEqual(await members(id), ['revoked:["dealer_staff"]', 'revoked:["dealer_staff"]']);
  assert.equal(account().banned, 0);
  // Sam's membership in north, an operator's, is untouched throughout.
  assert.deepEqual(
    (await f.rows(`SELECT status FROM "${TENANT_TABLES.membership}" WHERE account_id = ?`, [f.accounts.sam.accountId])).map(
      (row) => row.status,
    ),
    ['active'],
  );
});
