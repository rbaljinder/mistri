import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, IncomingMessage, request as httpRequest } from 'node:http';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth, type AppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import { createTenantAuthenticatedHttpServer } from '../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { defineCommand, defineCommands, literal } from '../packages/mistri/src/server/commands.js';
import { defineLoader, defineLoaders, type PageLoader } from '../packages/mistri/src/server/commands/pageLoaders.js';
import { fromRecord, type ResolvedBranding } from '../packages/mistri/src/shared/branding.js';

const appId = 'tenant-auth-http';
const password = 'Disposable-local-password-123!';
type Owner = Awaited<ReturnType<typeof createTenantAuthenticatedHttpServer>>;
type Options = Parameters<typeof createTenantAuthenticatedHttpServer>[0];
type Answer = { status: number; headers: Headers; body: Record<string, unknown>; text: string };
type Account = { accountId: string; cookie: string; email: string };
function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function noTenantHeaders(reply: Answer) {
  for (const name of ['tenant', 'tab', 'context', 'lease-revision']) assert.equal(reply.headers.get(`x-mistri-${name}`), null);
}
function safeBody(reply: Answer) {
  assert.doesNotMatch(reply.text, /PRIVATE_|physical_item|tenant_id|sessionId|session-secret|password|"stack"|"cause"/i);
}
function denied(reply: Answer) {
  assert.ok(reply.status >= 400, reply.text);
  noTenantHeaders(reply);
  safeBody(reply);
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function reservePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}
/* A free-form page with a loader, and one whose loader tries to write: what a tenant's member is served of each. */
const PAGE_LOADERS = defineLoaders({
  board: defineLoader({
    reads: ['item'],
    async load({ db, viewer }) {
      return { items: (await db.item.where({})).map((row) => String(row.name)), roles: viewer.roles };
    },
  }),
  scribble: defineLoader({
    reads: ['item'],
    load: async ({ db }) =>
      (db.item as never as { update: (...args: unknown[]) => unknown }).update({ id: 'north-id' }, { name: 'WRITTEN' }),
  }),
}) as unknown as Readonly<Record<string, PageLoader>>;
const pageView = (key: string) => ({
  kind: 'page',
  label: key,
  component: { id: `page-${key}`, module: `./pages/${key}.page.tsx`, kind: 'page' },
  reads: ['item'],
  loader: key,
});

async function fixture(t: TestContext, start = true, pages = false) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-auth-http-'));
  const business = join(directory, 'business.db'),
    authStore = join(directory, 'auth.db');
  const db = new DatabaseSync(business),
    port = await reservePort(),
    origin = `http://127.0.0.1:${port}`;
  let owner: Owner | undefined, auth: AppAuthRuntime | undefined;
  t.after(async () => {
    try {
      if (owner) {
        owner.server.closeAllConnections();
        await owner.retire();
      }
    } finally {
      auth?.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0;
    CREATE TABLE physical_item(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL COLLATE NOCASE,
      business_id TEXT NOT NULL, name TEXT NOT NULL, UNIQUE(tenant_id COLLATE BINARY,business_id));
    INSERT INTO physical_item VALUES ('north-id','north','same','North item'),('south-id','south','same','South item'),
      ('case-id','North','same','PRIVATE_CASE_SENTINEL');`);
  const binding = { appId, source: { id: 'business', connection: 'PRIVATE_BUSINESS_CONNECTION' }, storeId: 'PRIVATE_STORE' };
  provisionSqliteTenantStore(business, binding);
  const maintenance = async (run: (admin: ReturnType<typeof createSqliteTenantAdministration>) => Promise<void>) => {
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
  const loaded: LoadedApp = {
    path: join(directory, 'app.ts'),
    pages: [],
    sources: {},
    app: parseAppConfig(
      {
        id: appId,
        name: 'Tenant auth fixture',
        auth: { providers: ['email'], signUp: 'open', store: authStore, rows: 'tenant', roles: { member: { read: true, write: true } } },
        sources: { business: { connection: binding.source.connection } },
        resources: {
          item: {
            physical: 'physical_item',
            owner: 'tenant',
            access: 'write',
            fields: { read: ['id', 'business_id', 'name'], write: ['id', 'business_id', 'name'] },
          },
        },
        views: { item: { kind: 'list', from: 'item' }, ...(pages ? { board: pageView('board'), scribble: pageView('scribble') } : {}) },
        home: 'item',
        nav: ['item', ...(pages ? ['board', 'scribble'] : [])],
      },
      'PRIVATE_APP_PATH',
    ),
    ...(pages ? { loaders: PAGE_LOADERS } : {}),
  };
  const env = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
  const previous = env.map((name) => process.env[name]);
  process.env.BETTER_AUTH_SECRET = 'synthetic-tenant-auth-secret-at-least-thirty-two-characters';
  delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
  delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
  try {
    auth = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin] });
  } finally {
    env.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
  const capturedAuth = auth;
  const control = { reads: 0, resolve: undefined as (() => void | Promise<void>) | undefined, now: () => Date.now() };
  const options: Options = {
    loaded,
    auth: capturedAuth,
    bound: { host: '127.0.0.1', port },
    enrollment: {
      policy: defineAppTenantPolicy({
        kind: 'tenant',
        appId,
        storeId: binding.storeId,
        ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
        resolveMembershipRows: () => ({ item: true }),
        resolveRows: async () => {
          control.reads++;
          await control.resolve?.();
          return { item: true };
        },
      }),
      source: { ...binding.source, existingPath: business },
      deployment: 'auth-http-generation',
      roles: ['member'],
      maxLifetimeMs: 60000,
      now: () => control.now(),
    },
  };
  const launch = async () => {
    owner = await createTenantAuthenticatedHttpServer(options);
    owner.server.listen(port, '127.0.0.1');
    await once(owner.server, 'listening');
    return owner;
  };
  if (start) await launch();
  const parse = async (response: Response): Promise<Answer> => {
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: text ? object(JSON.parse(text)) : {} };
  };
  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}, method = body === undefined ? 'GET' : 'POST') =>
    parse(
      await fetch(origin + path, {
        method,
        headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10000),
        redirect: 'manual',
      }),
    );
  const raw = (path: string, headers: string[], method = 'POST', body = '{}'): Promise<Answer> =>
    new Promise((resolve, reject) => {
      const has = (name: string) => headers.some((value, index) => index % 2 === 0 && value.toLowerCase() === name);
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: [
            ...(has('host') ? [] : ['Host', `127.0.0.1:${port}`]),
            ...(has('origin') ? [] : ['Origin', origin]),
            'Content-Type',
            'application/json',
            'Content-Length',
            String(Buffer.byteLength(body)),
            ...headers,
          ],
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (part) => chunks.push(Buffer.from(part)));
          res.on('end', () => {
            try {
              const text = Buffer.concat(chunks).toString('utf8'),
                responseHeaders = new Headers();
              for (let index = 0; index < res.rawHeaders.length; index += 2)
                responseHeaders.append(res.rawHeaders[index], res.rawHeaders[index + 1]);
              resolve({ status: res.statusCode!, headers: responseHeaders, text, body: text ? object(JSON.parse(text)) : {} });
            } catch (error) {
              reject(error);
            }
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error('fixture request timeout')));
      req.end(body);
    });
  const signup = async (name = 'Ada'): Promise<Account> => {
    const email = `${name.toLowerCase()}@example.test`,
      answer = await call('/api/auth/sign-up/email', { name, email, password });
    assert.equal(answer.status, 200, answer.text);
    noTenantHeaders(answer);
    const user = object(answer.body.user);
    assert.equal(typeof user.id, 'string');
    const cookie = answer.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    assert.ok(cookie);
    return { accountId: String(user.id), cookie, email };
  };
  const grant = async (account: Account, tenantId = 'north') =>
    maintenance(async (admin) => {
      await admin.putMembership({
        tenantId,
        accountId: account.accountId,
        membershipId: `${tenantId}-${account.accountId}`,
        status: 'active',
        roles: ['member'],
        validUntil: Date.now() + 120000,
        expectedVersion: null,
      });
    });
  const select = (path: string, tenant = 'north') => `${path}?app=${appId}&tenant=${tenant}`;
  const authHeaders = (account: Account) => ({ cookie: account.cookie, 'x-mistri-account': account.accountId });
  const open = async (account: Account, tenant = 'north') => {
    const result = await call(select('/api/tenant/context/open', tenant), {}, authHeaders(account));
    assert.equal(result.status, 200, result.text);
    assert.equal(typeof result.body.tabId, 'string');
    assert.equal(typeof result.body.context, 'string');
    safeBody(result);
    assert.equal(result.body.revision, 1);
    return {
      ...authHeaders(account),
      'x-mistri-tab': String(result.body.tabId),
      'x-mistri-context': String(result.body.context),
      'x-mistri-lease-revision': String(result.body.revision),
    };
  };
  const strong = async (cookie?: string) => {
    const req = new IncomingMessage(new Socket());
    if (cookie) req.headers.cookie = cookie;
    try {
      return await capturedAuth.sessionInstance!(req);
    } finally {
      req.destroy();
    }
  };
  return {
    auth: capturedAuth,
    options,
    loaded,
    db,
    authStore,
    business,
    origin,
    control,
    launch,
    get owner() {
      assert.ok(owner);
      return owner;
    },
    call,
    raw,
    signup,
    grant,
    select,
    authHeaders,
    open,
    strong,
  };
}

test('native branding shells use a private base without admitting selector-only tenant reads', async (t) => {
  const f = await fixture(t, false);
  f.loaded.app.ui = {
    ...f.loaded.app.ui,
    theme: { preset: 'sage' },
    branding: fromRecord('item', {
      by: 'tenant',
      tenantField: 'business_id',
      fallback: { preset: 'sage' },
      fields: { name: 'name' },
    }),
  };
  Object.assign(f.options, { browser: true });
  await f.launch();
  const account = await f.signup();
  await f.grant(account);
  const reads = f.control.reads;
  for (const tenant of ['north', 'south']) {
    const url = `${f.origin}/${appId}/item?tenant=${tenant}`;
    const response = await fetch(url, { headers: { cookie: account.cookie, 'if-none-match': '*' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('etag'), null);
    assert.match(response.headers.get('vary')!, /Cookie/);
    const html = await response.text();
    const block = /<script type="application\/json" id="mistri-branding">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(block);
    const presentation = JSON.parse(block[1]) as { private: boolean; value: ResolvedBranding };
    assert.equal(presentation.private, true);
    assert.equal(presentation.value.status, 'fallback');
    assert.equal(presentation.value.identity.tenant, null);
    assert.equal(presentation.value.identity.recordKey, null);
    assert.equal(presentation.value.identity.version, null);
    assert.deepEqual(presentation.value.content, {});
    assert.deepEqual(presentation.value.images, {});
    assert.equal(presentation.value.theme.base, 'sage');
    assert.ok(html.indexOf('id="mistri-branding"') < html.indexOf('Runs before styles'));
    const head = await fetch(url, { method: 'HEAD', headers: { cookie: account.cookie, 'if-none-match': '*' } });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('cache-control'), 'private, no-store');
    assert.equal(head.headers.get('etag'), null);
    assert.equal(await head.text(), '');
  }
  assert.equal(f.control.reads, reads, 'a native navigation never opens a tenant context for branding');
});

test('real auth WHOAMI captures loader metadata without executable command handlers', async (t) => {
  const f = await fixture(t, false);
  Object.assign(f.loaded, {
    entry: 'app.ts',
    env: [],
    commands: {
      file: 'commands.ts',
      registry: defineCommands({
        unused: defineCommand({
          source: 'business',
          target: 'item',
          input: {},
          output: literal('unused'),
          handle() {
            throw new Error('Command handlers must not run while capturing host metadata');
          },
        }),
      }),
    },
  });
  await f.launch();
  const answer = await f.call(`/api/whoami?app=${appId}`);
  assert.equal(answer.status, 200);
  noTenantHeaders(answer);
  safeBody(answer);
  assert.deepEqual(answer.body, {
    signedIn: false,
    accountId: null,
    appId,
    who: null,
    header: null,
    signIn: { app: 'Tenant auth fixture', providers: ['email'], signUp: 'open' },
  });
  assert.equal(answer.headers.get('cache-control'), 'no-store');
  const head = await f.call(`/api/whoami?app=${appId}`, undefined, {}, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  noTenantHeaders(head);
  assert.equal(f.control.reads, 0);
});

test('signup, own-membership bootstrap and two contexts use one real session with isolated equal business IDs', async (t) => {
  const f = await fixture(t),
    account = await f.signup();
  await f.grant(account);
  await f.grant(account, 'south');
  const who = await f.call(`/api/whoami?app=${appId}`, undefined, f.authHeaders(account));
  assert.equal(who.status, 200);
  noTenantHeaders(who);
  safeBody(who);
  assert.deepEqual(who.body, {
    signedIn: true,
    accountId: account.accountId,
    appId,
    who: account.email,
    header: null,
    accountProfile: true,
    hasRoles: true,
  });
  const discovery = await f.call(`/api/tenant/bootstrap?app=${appId}`, undefined, f.authHeaders(account));
  assert.equal(discovery.status, 200);
  assert.equal(discovery.body.status, 'ready');
  safeBody(discovery);
  assert.ok(Array.isArray(discovery.body.memberships));
  assert.equal(discovery.body.memberships.length, 2);
  for (const tenant of ['north', 'south']) {
    const headers = await f.open(account, tenant),
      result = await f.call(f.select('/api/query', tenant), { table: 'item' }, headers);
    assert.equal(result.status, 200, result.text);
    safeBody(result);
    assert.deepEqual(result.body.rows, [
      { id: `${tenant}-id`, business_id: 'same', name: tenant === 'north' ? 'North item' : 'South item' },
    ]);
    assert.equal(result.headers.get('x-mistri-tenant'), tenant);
    assert.equal(result.headers.get('x-mistri-account'), account.accountId);
  }
});

test('real authenticated renewal keeps the selected context and reauthorizes exact receipt replay', async (t) => {
  const f = await fixture(t),
    account = await f.signup();
  await f.grant(account);
  const selected = await f.open(account),
    expected = { tabId: selected['x-mistri-tab'], expectedContext: selected['x-mistri-context'], expectedRevision: 1 };
  const path = f.select('/api/tenant/context/renew');
  const renewed = await f.call(path, expected, f.authHeaders(account));
  assert.equal(renewed.status, 200, renewed.text);
  safeBody(renewed);
  assert.equal(renewed.body.context, expected.expectedContext);
  assert.equal(renewed.body.tabId, expected.tabId);
  assert.equal(renewed.body.revision, 2);
  assert.equal(renewed.headers.get('x-mistri-lease-revision'), '2');
  const duplicate = await f.call(path, expected, f.authHeaders(account));
  assert.equal(duplicate.status, 200, duplicate.text);
  assert.deepEqual(duplicate.body, renewed.body);
  const current = { ...selected, 'x-mistri-lease-revision': '2' };
  const query = await f.call(f.select('/api/query'), { table: 'item' }, current);
  assert.equal(query.status, 200, query.text);
  assert.equal(query.headers.get('x-mistri-lease-revision'), '2');
  const stale = await f.call(f.select('/api/query'), { table: 'item' }, selected);
  denied(stale);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'tenant_lease_stale');
  const signout = await f.call('/api/auth/sign-out', {}, f.authHeaders(account));
  assert.equal(signout.status, 200);
  denied(await f.call(path, expected, f.authHeaders(account)));
  denied(await f.call(f.select('/api/query'), { table: 'item' }, current));
});

test('authenticated account without enrollment sees no memberships and cannot open tenant data', async (t) => {
  const f = await fixture(t),
    account = await f.signup();
  const discovery = await f.call(`/api/tenant/bootstrap?app=${appId}`, undefined, f.authHeaders(account));
  assert.equal(discovery.status, 200);
  assert.deepEqual(discovery.body.memberships, []);
  denied(await f.call(f.select('/api/tenant/context/open'), {}, f.authHeaders(account)));
  assert.equal(f.control.reads, 0);
});

test('tenant host never forwards deployment-wide native admin routes, including for a real native admin', async (t) => {
  const f = await fixture(t),
    operator = await f.signup('Operator'),
    target = await f.signup('Target');
  const db = new DatabaseSync(f.authStore);
  try {
    db.prepare('UPDATE "user" SET role = ? WHERE id = ?').run('admin', operator.accountId);
  } finally {
    db.close();
  }
  assert.equal((await f.strong(operator.cookie))?.identity.role, 'admin');
  const snapshot = () => {
    const source = new DatabaseSync(f.authStore, { readOnly: true });
    try {
      return ['user', 'account', 'session'].map((table) => source.prepare(`SELECT * FROM "${table}" ORDER BY id`).all());
    } finally {
      source.close();
    }
  };
  const before = snapshot(),
    business = f.db.prepare('SELECT * FROM physical_item ORDER BY id').all();
  for (const headers of [{}, f.authHeaders(target), f.authHeaders(operator)]) {
    for (const path of [
      '/api/auth/admin/list-users',
      `/api/auth/admin/get-user?id=${target.accountId}`,
      '/api/auth/%61dmin/list-users',
      '/api/auth/admin%2flist-users',
      '/api/auth//admin/list-users',
      '/api/auth/ADMIN/list-users',
    ]) {
      const reply = await f.call(path, undefined, headers);
      denied(reply);
      assert.equal(reply.status, 403);
      assert.equal(reply.headers.get('set-cookie'), null);
      assert.equal(reply.headers.get('x-mistri-account'), null);
    }
    for (const action of ['create-user', 'set-role', 'impersonate-user', 'ban-user', 'remove-user']) {
      const reply = await f.call(`/api/auth/admin/${action}`, { userId: target.accountId, role: 'admin' }, headers);
      denied(reply);
      assert.equal(reply.status, 403);
      assert.equal(reply.body.outcome, undefined);
      assert.equal(reply.headers.get('set-cookie'), null);
    }
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(f.db.prepare('SELECT * FROM physical_item ORDER BY id').all(), business);
  }
  assert.equal(f.control.reads, 0);
  assert.equal((await f.call(`/api/whoami?app=${appId}`, undefined, f.authHeaders(operator))).body.signedIn, true);
  assert.deepEqual((await f.call(`/api/tenant/bootstrap?app=${appId}`, undefined, f.authHeaders(operator))).body.memberships, []);
});

test('an existing selected login with impersonation provenance cannot retain or reacquire tenant authority', async (t) => {
  const f = await fixture(t),
    account = await f.signup();
  await f.grant(account);
  const context = await f.open(account),
    proof = await f.strong(account.cookie);
  assert.ok(proof);
  const db = new DatabaseSync(f.authStore);
  try {
    db.prepare('UPDATE session SET impersonatedBy = ? WHERE id = ?').run('PRIVATE_DEPLOYMENT_OPERATOR', proof.sessionId);
  } finally {
    db.close();
  }
  const reads = f.control.reads,
    before = f.db.prepare('SELECT * FROM physical_item ORDER BY id').all();
  denied(await f.call(`/api/whoami?app=${appId}`, undefined, f.authHeaders(account)));
  denied(await f.call(`/api/tenant/bootstrap?app=${appId}`, undefined, f.authHeaders(account)));
  denied(await f.call(f.select('/api/tenant/context/open'), {}, f.authHeaders(account)));
  denied(await f.call(f.select('/api/query'), { table: 'item' }, context));
  denied(await f.call(f.select('/api/update'), { table: 'item', key: { id: 'north-id' }, values: { name: 'Delegated edit' } }, context));
  assert.equal(f.control.reads, reads);
  assert.deepEqual(f.db.prepare('SELECT * FROM physical_item ORDER BY id').all(), before);
  // Native auth still recognizes the cookie; refusal is not an expired-session
  // false positive. No tenant scope is attached to the native session endpoint.
  const native = await f.call('/api/auth/get-session', undefined, { cookie: account.cookie });
  assert.equal(native.status, 200);
  assert.equal(object(native.body.user).id, account.accountId);
});

test('real profile remains own-account name-only while tenant context and business records stay unchanged', async (t) => {
  const f = await fixture(t),
    account = await f.signup();
  await f.grant(account);
  const context = await f.open(account);
  const route = `/api/auth/profile?app=${appId}`;
  const saved = await f.call(route, { name: '  Ada Lovelace  ' }, f.authHeaders(account));
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.body.outcome, 'applied');
  noTenantHeaders(saved);
  safeBody(saved);
  assert.equal(object(saved.body.profile).name, 'Ada Lovelace');
  assert.equal(saved.headers.get('set-cookie'), null);
  const read = await f.call(route, undefined, f.authHeaders(account));
  assert.equal(object(read.body.profile).email, account.email);
  assert.deepEqual(object(read.body.profile).providers, ['email']);
  noTenantHeaders(read);
  const db = new DatabaseSync(f.authStore, { readOnly: true });
  try {
    assert.deepEqual(
      { ...db.prepare('SELECT name,email,emailVerified,role FROM user WHERE id=?').get(account.accountId) },
      { name: 'Ada Lovelace', email: account.email, emailVerified: 0, role: 'user' },
    );
  } finally {
    db.close();
  }
  const rows = await f.call(f.select('/api/query'), { table: 'item' }, context);
  assert.equal(rows.status, 200);
  assert.equal(f.db.prepare("SELECT name FROM physical_item WHERE id='north-id'").get()!.name, 'North item');
});

test('logout clears the real session; same-account login cannot reuse old context tokens', async (t) => {
  const f = await fixture(t),
    account = await f.signup();
  await f.grant(account);
  const old = await f.open(account);
  const first = await f.strong(account.cookie);
  assert.ok(first);
  const logout = await f.call('/api/auth/sign-out', {}, f.authHeaders(account));
  assert.equal(logout.status, 200, logout.text);
  noTenantHeaders(logout);
  assert.ok(logout.headers.getSetCookie().length);
  const gone = await f.call(`/api/whoami?app=${appId}`, undefined, { cookie: account.cookie });
  assert.equal(gone.body.signedIn, false);
  denied(await f.call(f.select('/api/query'), { table: 'item' }, old));
  const login = await f.call('/api/auth/sign-in/email', { email: account.email, password });
  assert.equal(login.status, 200, login.text);
  account.cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const next = await f.strong(account.cookie);
  assert.ok(next);
  assert.equal(next.identity.id, first.identity.id);
  assert.notEqual(next.sessionId, first.sessionId);
  denied(await f.call(f.select('/api/query'), { table: 'item' }, { ...old, cookie: account.cookie }));
  const current = await f.open(account);
  assert.equal((await f.call(f.select('/api/query'), { table: 'item' }, current)).status, 200);
});

test('stale account signout refuses before native logout and preserves the newer account session', async (t) => {
  const f = await fixture(t),
    ada = await f.signup(),
    bob = await f.signup('Bob');
  const result = await f.call('/api/auth/sign-out', {}, { cookie: bob.cookie, 'x-mistri-account': ada.accountId });
  assert.equal(result.status, 409);
  denied(result);
  assert.equal(result.headers.get('set-cookie'), null);
  assert.equal((await f.strong(bob.cookie))?.identity.id, bob.accountId);
  assert.equal((await f.strong(ada.cookie))?.identity.id, ada.accountId);
});

test('profile refuses stale account and non-name mutations without affecting either real user', async (t) => {
  const f = await fixture(t),
    ada = await f.signup(),
    bob = await f.signup('Bob'),
    route = `/api/auth/profile?app=${appId}`;
  const stale = await f.call(route, { name: 'Wrong' }, { cookie: bob.cookie, 'x-mistri-account': ada.accountId });
  assert.equal(stale.status, 409);
  noTenantHeaders(stale);
  for (const body of [
    { name: 'Wrong', role: 'admin' },
    { name: 'Wrong', email: 'wrong@example.test' },
    { name: 'Wrong', userId: bob.accountId },
    { name: 'Wrong', tenantId: 'south' },
    { name: '' },
  ]) {
    const result = await f.call(route, body, f.authHeaders(ada));
    assert.equal(result.status, 400, result.text);
    noTenantHeaders(result);
  }
  for (const [account, name] of [
    [ada, 'Ada'],
    [bob, 'Bob'],
  ] as const) {
    const result = await f.call(route, undefined, f.authHeaders(account));
    assert.equal(object(result.body.profile).name, name);
  }
});

for (const path of [
  '/api/whoami',
  `/api/whoami?app=${appId}&app=${appId}`,
  '/api/whoami?app=other',
  `/api/whoami?app=${appId}&tenant=north`,
  `/api/whoami?app=${appId}&conn=private`,
  '/api/auth/sign-out?app=other',
  `/api/auth/sign-out?app=${appId}&app=${appId}`,
  '/api/auth/sign-out?tenant=north',
  '/api/auth/sign-out?conn=private',
])
  test(`auth selectors refuse ${path} without signing out the real session`, async (t) => {
    const f = await fixture(t),
      account = await f.signup();
    denied(await f.call(path, path.startsWith('/api/auth/') ? {} : undefined, f.authHeaders(account)));
    assert.equal((await f.strong(account.cookie))?.identity.id, account.accountId);
  });

for (const name of ['x-mistri-account', 'x-mistri-app', 'x-mistri-tab', 'x-mistri-context', 'x-mistri-tenant', 'x-mistri-lease-revision']) {
  test(`native auth refuses duplicated ${name} before logging out`, async (t) => {
    const f = await fixture(t),
      account = await f.signup(),
      value = name === 'x-mistri-account' ? account.accountId : appId;
    denied(await f.raw('/api/auth/sign-out', ['Cookie', account.cookie, name, value, name.toUpperCase(), value]));
    assert.equal((await f.strong(account.cookie))?.identity.id, account.accountId);
  });
}

test('native auth forbids context/tenant headers and mismatching App assertions, but accepts the matching App', async (t) => {
  const f = await fixture(t),
    account = await f.signup();
  const attempts: Array<Record<string, string>> = [
    { 'x-mistri-tab': 'tab' },
    { 'x-mistri-context': 'context' },
    { 'x-mistri-tenant': 'north' },
    { 'x-mistri-lease-revision': '1' },
    { 'x-mistri-app': 'other' },
  ];
  for (const headers of attempts) {
    denied(await f.call('/api/auth/sign-out', {}, { ...f.authHeaders(account), ...headers }));
  }
  const result = await f.call(`/api/auth/sign-out?app=${appId}`, {}, { ...f.authHeaders(account), 'x-mistri-app': appId });
  assert.equal(result.status, 200, result.text);
  noTenantHeaders(result);
});

test('host and cross-origin mutation checks refuse before native signout or profile writes', async (t) => {
  const f = await fixture(t),
    account = await f.signup();
  const attempts: Array<Record<string, string>> = [
    { host: 'attacker.invalid' },
    { origin: 'https://attacker.invalid' },
    { 'sec-fetch-site': 'cross-site' },
    ...['', 'null', `${f.origin}/`, `${f.origin}?q=1`, f.origin.replace('http:', 'ftp:'), f.origin.replace('://', '://user:password@')].map(
      (origin) => ({ origin }),
    ),
  ];
  for (const headers of attempts) {
    const rawHeaders = Object.entries({ ...f.authHeaders(account), ...headers }).flat();
    const signout = await f.raw('/api/auth/sign-out', rawHeaders);
    assert.ok(signout.status >= 400, JSON.stringify({ headers, status: signout.status, body: signout.body }));
    denied(signout);
    denied(await f.raw(`/api/auth/profile?app=${appId}`, rawHeaders, 'POST', JSON.stringify({ name: 'Wrong' })));
  }
  assert.equal((await f.strong(account.cookie))?.identity.id, account.accountId);
  const read = await f.call(`/api/auth/profile?app=${appId}`, undefined, f.authHeaders(account));
  assert.equal(object(read.body.profile).name, 'Ada');
});

test('an unknown native auth route carries no attested tenant ownership', async (t) => {
  const f = await fixture(t),
    account = await f.signup();
  const response = await fetch(f.origin + '/api/auth/not-a-real-route', {
    headers: f.authHeaders(account),
    signal: AbortSignal.timeout(10000),
  });
  assert.ok(response.status >= 400);
  for (const name of ['tenant', 'tab', 'context']) assert.equal(response.headers.get(`x-mistri-${name}`), null);
});

test('dispatched real profile storage failure stays unknown without tenant ownership or private diagnostics', async (t) => {
  const f = await fixture(t),
    account = await f.signup();
  let failures = 0;
  const prepare = DatabaseSync.prototype.prepare;
  const fault = t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (/^update\s+["`]?user["`]?\s/i.test(sql)) {
      failures++;
      throw new Error('PRIVATE_PROFILE_DRIVER_FAILURE');
    }
    return prepare.call(this, sql);
  });
  let result: Answer;
  try {
    result = await f.call(`/api/auth/profile?app=${appId}`, { name: 'Unconfirmed' }, f.authHeaders(account));
  } finally {
    fault.mock.restore();
  }
  assert.equal(failures, 1);
  assert.equal(result.status, 503, result.text);
  assert.equal(result.body.outcome, 'unknown');
  assert.equal(result.body.code, 'profile_unknown');
  noTenantHeaders(result);
  safeBody(result);
  // Recovery uses the actual auth provider after the fault, not a claimed rollback.
  const recovery = await f.call(`/api/auth/profile?app=${appId}`, undefined, f.authHeaders(account));
  assert.equal(recovery.status, 200);
  assert.equal(object(recovery.body.profile).name, 'Ada');
});

test('factory refuses an independent verifier or transport clock without invoking it', async (t) => {
  const f = await fixture(t, false);
  let invoked = 0;
  const provider = () => {
    invoked++;
    throw new Error('PRIVATE_INDEPENDENT_PROVIDER');
  };
  for (const input of [
    { ...f.options, verifySessionInstance: provider },
    { ...f.options, now: provider },
    { ...f.options, enrollment: { ...f.options.enrollment, verifySession: provider } },
  ]) {
    await assert.rejects(Reflect.apply(createTenantAuthenticatedHttpServer, undefined, [input]));
  }
  assert.equal(invoked, 0);
  assert.equal(await f.strong(), null);
});

test('factory rejects proxy/getter auth substitutes without executing traps or closing real auth', async (t) => {
  const f = await fixture(t, false);
  let traps = 0;
  const trap = () => {
    traps++;
    throw new Error('PRIVATE_AUTH_TRAP');
  };
  const proxy = new Proxy(f.auth, { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
  await assert.rejects(createTenantAuthenticatedHttpServer({ ...f.options, auth: proxy }));
  const malformed = { ...f.options };
  Object.defineProperty(malformed, 'auth', { enumerable: true, get: trap });
  await assert.rejects(createTenantAuthenticatedHttpServer(malformed));
  assert.equal(traps, 0);
  assert.equal(await f.strong(), null);
});

test('factory rejects structural auth copies and wrong-App auth without closing the caller-owned runtime', async (t) => {
  const f = await fixture(t, false);
  await assert.rejects(createTenantAuthenticatedHttpServer({ ...f.options, auth: { ...f.auth } }));
  await assert.rejects(
    createTenantAuthenticatedHttpServer({ ...f.options, loaded: { ...f.loaded, app: { ...f.loaded.app, id: 'other-app' } } }),
  );
  assert.equal(await f.strong(), null);
  await f.launch();
  const account = await f.signup();
  assert.equal((await f.strong(account.cookie))?.identity.id, account.accountId);
});

test('failed enrollment acquisition leaves the real auth runtime open and preserves its store', async (t) => {
  const f = await fixture(t, false);
  await assert.rejects(
    createTenantAuthenticatedHttpServer({
      ...f.options,
      enrollment: { ...f.options.enrollment, source: { ...f.options.enrollment.source, existingPath: join(f.business, 'missing.db') } },
    }),
  );
  assert.equal(await f.strong(), null);
  await f.launch();
  const account = await f.signup();
  const db = new DatabaseSync(f.authStore, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM user WHERE id=?').get(account.accountId)!.n, 1);
  } finally {
    db.close();
  }
});

test('concurrent and successful factories cannot acquire the same genuine auth owner twice', async (t) => {
  const f = await fixture(t, false);
  const first = f.launch();
  await assert.rejects(createTenantAuthenticatedHttpServer(f.options));
  await first;
  await assert.rejects(createTenantAuthenticatedHttpServer(f.options));
  const account = await f.signup();
  assert.equal((await f.strong(account.cookie))?.identity.id, account.accountId);
  const who = await f.call(`/api/whoami?app=${appId}`, undefined, f.authHeaders(account));
  assert.equal(who.status, 200);
  assert.equal(who.body.accountId, account.accountId);
});

test('post-construction auth method replacement refuses without running the substituted verifier or native handler', async (t) => {
  const f = await fixture(t),
    account = await f.signup();
  let calls = 0,
    replacements = 0;
  const descriptors = new Map(['session', 'sessionInstance', 'handler'].map((key) => [key, Object.getOwnPropertyDescriptor(f.auth, key)!]));
  try {
    for (const key of descriptors.keys()) {
      const replaced = Reflect.defineProperty(f.auth, key, {
        configurable: true,
        enumerable: true,
        value: () => {
          calls++;
          throw new Error('PRIVATE_REPLACEMENT');
        },
      });
      if (replaced) replacements++;
      // A frozen public runtime is also sufficient; no replacement is forced.
      if (!replaced) assert.equal(Object.getOwnPropertyDescriptor(f.auth, key)?.value, descriptors.get(key)?.value);
    }
    const who = await f.call(`/api/whoami?app=${appId}`, undefined, f.authHeaders(account));
    const profile = await f.call(`/api/auth/profile?app=${appId}`, undefined, f.authHeaders(account));
    if (replacements) {
      denied(who);
      denied(profile);
    } else {
      assert.equal(who.status, 200, who.text);
      assert.equal(who.body.accountId, account.accountId);
      assert.equal(profile.status, 200, profile.text);
    }
    assert.equal(calls, 0);
  } finally {
    for (const [key, descriptor] of descriptors) Reflect.defineProperty(f.auth, key, descriptor);
  }
});

test('retirement drains accepted tenant verification before closing auth and is idempotent', async (t) => {
  const f = await fixture(t),
    account = await f.signup();
  await f.grant(account);
  const context = await f.open(account);
  const entered = gate(),
    held = gate();
  t.after(() => held.release());
  f.control.resolve = async () => {
    entered.release();
    await held.promise;
  };
  const pending = f.call(f.select('/api/query'), { table: 'item' }, context);
  await entered.promise;
  let retired = false;
  const first = f.owner.retire();
  void first.then(() => {
    retired = true;
  });
  try {
    assert.equal(f.owner.retire(), first);
    assert.equal(retired, false);
    assert.equal((await f.strong(account.cookie))?.identity.id, account.accountId, 'auth must remain open until accepted work settles');
  } finally {
    held.release();
  }
  const answer = await pending;
  denied(answer);
  // Only now is the formerly active HTTP connection idle: do not make this
  // lifetime assertion wait for the production keep-alive timeout to reap it.
  f.owner.server.closeIdleConnections();
  await first;
  await assert.rejects(f.strong(account.cookie));
  assert.equal(f.owner.retire(), first);
  await f.owner.retire();
  assert.doesNotThrow(() => f.auth.close());
  const db = new DatabaseSync(f.authStore, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT email FROM user WHERE id=?').get(account.accountId)!.email, account.email);
  } finally {
    db.close();
  }
});

test('native bodyless signout needs no JSON content type and invalidates the actual session', async (t) => {
  const f = await fixture(t),
    account = await f.signup();
  const result = await f.call('/api/auth/sign-out', undefined, f.authHeaders(account), 'POST');
  assert.equal(result.status, 200, result.text);
  assert.equal(result.body.success, true);
  noTenantHeaders(result);
  assert.ok(result.headers.getSetCookie().length);
  assert.equal(await f.strong(account.cookie), null);
});

test('form-encoded unknown OAuth callback reaches native local redirect and state validation', async (t) => {
  const f = await fixture(t);
  // No provider is configured, and redirects are followed only after checking
  // their local origin. No authorization code or external exchange is used.
  const response = await fetch(f.origin + '/api/auth/callback/not-configured', {
    method: 'POST',
    headers: { origin: 'https://provider.invalid', 'sec-fetch-site': 'cross-site', 'content-type': 'application/x-www-form-urlencoded' },
    body: 'error=access_denied',
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 302);
  await response.arrayBuffer();
  for (const name of ['tenant', 'tab', 'context']) assert.equal(response.headers.get(`x-mistri-${name}`), null);
  const target = new URL(response.headers.get('location')!);
  assert.equal(target.origin, f.origin);
  assert.equal(target.pathname, '/api/auth/callback/not-configured');
  assert.equal(target.searchParams.get('error'), 'access_denied');
  const validation = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  assert.equal(validation.status, 302);
  await validation.arrayBuffer();
  const failure = new URL(validation.headers.get('location')!);
  assert.equal(failure.origin, f.origin);
  assert.equal(failure.searchParams.get('error'), 'state_not_found');
  assert.equal(await f.strong(), null);
});

for (const instant of [NaN, Infinity, -Infinity])
  test(`WHOAMI refuses shared enrollment clock ${instant} without an account header`, async (t) => {
    const f = await fixture(t),
      account = await f.signup();
    f.control.now = () => instant;
    const result = await f.call(`/api/whoami?app=${appId}`, undefined, f.authHeaders(account));
    denied(result);
    assert.equal(result.headers.get('x-mistri-account'), null);
    assert.notEqual(result.body.signedIn, true);
  });

test('WHOAMI uses the enrollment clock for session expiry, not a separate transport clock', async (t) => {
  const f = await fixture(t),
    account = await f.signup(),
    proof = await f.strong(account.cookie);
  assert.ok(proof);
  f.control.now = () => proof.expiresAt;
  const result = await f.call(`/api/whoami?app=${appId}`, undefined, f.authHeaders(account));
  denied(result);
  assert.equal(result.headers.get('x-mistri-account'), null);
});

test('WHOAMI clock-triggered retirement cannot release a verified account', async (t) => {
  const f = await fixture(t),
    account = await f.signup();
  let retirement: Promise<void> | undefined;
  f.control.now = () => {
    retirement = f.owner.retire();
    return Date.now();
  };
  const result = await f.call(`/api/whoami?app=${appId}`, undefined, f.authHeaders(account));
  denied(result);
  assert.equal(result.headers.get('x-mistri-account'), null);
  assert.ok(retirement);
  f.owner.server.closeIdleConnections();
  await retirement;
  await assert.rejects(f.strong(account.cookie));
});

for (const operation of ['native signout', 'profile save'] as const)
  test(`retirement inside accepted ${operation} storage drains its native handler before auth close`, async (t) => {
    const f = await fixture(t),
      account = await f.signup();
    const prepare = DatabaseSync.prototype.prepare,
      close = DatabaseSync.prototype.close;
    const storage = new Set<DatabaseSync>();
    let retirement: Promise<void> | undefined,
      closes = 0,
      entered = 0;
    const closeWatch = t.mock.method(DatabaseSync.prototype, 'close', function (this: DatabaseSync) {
      if (storage.has(this)) {
        closes++;
        if (operation === 'native signout') assert.equal(prepare.call(this, 'SELECT count(*) AS n FROM session').get()!.n, 0);
        else assert.equal(prepare.call(this, 'SELECT name FROM user WHERE id=?').get(account.accountId)!.name, 'Completed before close');
      }
      return close.call(this);
    });
    const interception = t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
      const matches =
        operation === 'native signout' ? /^delete\s+from\s+["`]?session["`]?\s/i.test(sql) : /^update\s+["`]?user["`]?\s/i.test(sql);
      if (matches && !retirement) {
        entered++;
        storage.add(this);
        retirement = f.owner.retire();
        assert.equal(closes, 0, 'retirement must not close auth beneath an accepted storage operation');
        assert.equal(prepare.call(this, 'SELECT name FROM user WHERE id=?').get(account.accountId)!.name, 'Ada');
      }
      return prepare.call(this, sql);
    });
    try {
      const result =
        operation === 'native signout'
          ? await f.call('/api/auth/sign-out', undefined, f.authHeaders(account), 'POST')
          : await f.call(`/api/auth/profile?app=${appId}`, { name: 'Completed before close' }, f.authHeaders(account));
      assert.equal(entered, 1);
      assert.ok(retirement);
      assert.equal(result.status, 200, result.text);
      noTenantHeaders(result);
      if (operation === 'profile save') {
        assert.equal(result.body.outcome, 'applied');
        assert.equal(object(result.body.profile).name, 'Completed before close');
      } else assert.equal(result.body.success, true);
      f.owner.server.closeIdleConnections();
      await retirement;
      assert.equal(closes, 1);
      await assert.rejects(f.strong(account.cookie));
    } finally {
      interception.mock.restore();
      closeWatch.mock.restore();
    }
  });

for (const operation of ['native signout', 'profile save'] as const)
  test(`retirement destroys accepted incomplete ${operation} without mutating auth`, async (t) => {
    const f = await fixture(t),
      account = await f.signup(),
      accepted = gate();
    const path = operation === 'native signout' ? '/api/auth/sign-out' : `/api/auth/profile?app=${appId}`;
    let incoming: IncomingMessage | undefined;
    f.owner.server.on('request', (req) => {
      incoming = req;
      accepted.release();
    });
    const req = httpRequest(f.origin + path, {
      method: 'POST',
      headers: { ...f.authHeaders(account), origin: f.origin, 'content-type': 'application/json', 'content-length': '100' },
    });
    const disconnected = new Promise<void>((resolve) => {
      req.on('error', () => resolve());
      req.on('close', resolve);
    });
    req.on('response', (response) => response.resume());
    req.write('{');
    try {
      await accepted.promise;
      assert.ok(incoming);
      assert.equal(incoming.complete, false);
      assert.equal((await f.strong(account.cookie))?.identity.id, account.accountId);
      const retirement = f.owner.retire();
      assert.equal(f.owner.retire(), retirement);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([disconnected, retirement]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('retirement did not drain the incomplete native body')), 2000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        // A failed shutdown assertion must not strand the disposable fixture.
        // Better Call listens for error/end, not the aborted/close pair.
        if (incoming.destroyed && incoming.listenerCount('error')) incoming.emit('error', new Error('fixture body cleanup'));
      }
      assert.equal(incoming.destroyed, true);
      await assert.rejects(f.strong(account.cookie));
      const db = new DatabaseSync(f.authStore, { readOnly: true });
      try {
        assert.equal(db.prepare('SELECT name FROM user WHERE id=?').get(account.accountId)!.name, 'Ada');
        assert.equal(db.prepare('SELECT count(*) AS n FROM session WHERE userId=?').get(account.accountId)!.n, 1);
      } finally {
        db.close();
      }
    } finally {
      req.destroy();
    }
  });

test("a page's loader on the tenant host reads the member's own tenant through its lease, never writes, and runs only for a page it serves", async (t) => {
  const f = await fixture(t, true, true);
  const ada = await f.signup('Ada'),
    bob = await f.signup('Bob');
  await f.grant(ada, 'north');
  await f.grant(bob, 'south');
  const north = await f.open(ada, 'north'),
    south = await f.open(bob, 'south');
  const load = (headers: Record<string, string>, tenant: string, body: unknown) =>
    f.call(f.select('/api/pages/load', tenant), body, headers);
  const before = f.db.prepare('SELECT id, name FROM physical_item ORDER BY id').all();
  // The lease's reader: this tenant's rows only — not the other's, and not the one that differs from it by case.
  assert.deepEqual((await load(north, 'north', { page: 'board' })).body, { data: { items: ['North item'], roles: ['member'] } });
  assert.deepEqual((await load(south, 'south', { page: 'board' })).body, { data: { items: ['South item'], roles: ['member'] } });
  // Read-only: a write on its handle is refused, and the row is what it was.
  const wrote = await load(north, 'north', { page: 'scribble' });
  assert.equal(wrote.status, 403, wrote.text);
  assert.equal(wrote.body.code, 'loader_refused');
  assert.deepEqual(f.db.prepare('SELECT id, name FROM physical_item ORDER BY id').all(), before);
  // Only a page this realm serves, with only what the route takes, and only on a lease.
  assert.equal((await load(north, 'north', { page: 'item' })).status, 404, 'a view that is not a page has no loader');
  assert.equal((await load(north, 'north', { page: 'nowhere' })).status, 404);
  denied(await load(north, 'north', { page: 'board', extra: true }));
  denied(await load(f.authHeaders(ada), 'north', { page: 'board' }));
  denied(await load({ ...south, ...f.authHeaders(ada) }, 'south', { page: 'board' }));
});
