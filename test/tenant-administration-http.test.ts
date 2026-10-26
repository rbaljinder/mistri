import assert from 'node:assert/strict';
import { once } from 'node:events';
import { ServerResponse, request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { captureAppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { createTenantAuthenticatedHttpServer } from '../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { ADMINISTRATION_JOURNAL_TABLES } from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStore.js';
import {
  ADMINISTRATION_HTTP_HEADER as contextHeader,
  ADMINISTRATION_HTTP_ROOT as root,
  ADMINISTRATION_OPERATIONS,
  type AdministrationAttempt,
  type AdministrationSession,
} from '../packages/mistri/src/shared/tenantAdministration.js';
import { TENANT_HTTP_HEADERS as headers } from '../packages/mistri/src/shared/tenantContext.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { tenantAdministrationFixture } from './support/tenantAdministrationFixture.js';

type Answer = { status: number; headers: Headers; body: any; text: string };
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fixture(t: TestContext, enabled = true, launch = true) {
  const f = await tenantAdministrationFixture(t);
  f.db.exec(`CREATE TABLE tenant_item(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL);
    INSERT INTO tenant_item VALUES ('one', 'north', 'Original')`);
  const loaded: LoadedApp = {
    path: join(f.directory, 'app.ts'),
    dir: f.directory,
    pages: [],
    sources: {},
    app: parseAppConfig(
      {
        id: f.binding.appId,
        name: 'Administration HTTP',
        sources: { business: { connection: f.binding.source.connection } },
        resources: {
          item: { physical: 'tenant_item', owner: 'tenant', access: 'write', fields: { read: ['id', 'name'], write: ['name'] } },
          business_record: { physical: 'business_record', owner: 'global' },
        },
        views: { items: { kind: 'list', from: 'item' } },
        home: 'items',
        auth: { ...f.auth.spec, rows: 'tenant', roles: { reader: { read: true, write: true }, manager: { read: true, write: true } } },
      },
      'administration HTTP fixture',
    ),
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const options = {
    loaded,
    auth: f.auth,
    bound,
    enrollment: {
      policy: {
        kind: 'tenant' as const,
        appId: f.binding.appId,
        storeId: f.binding.storeId,
        ownership: {
          item: { kind: 'tenant' as const, column: 'tenant_id' },
          business_record: { kind: 'global' as const, access: 'read-only' as const },
        },
        resolveMembershipRows: () => ({ item: true as const }),
        resolveRows: () => ({ item: true as const }),
        ...(enabled
          ? {
              administration: {
                id: 'PRIVATE_OPERATOR_POLICY',
                version: 'private-v1',
                maxMembershipLifetimeMs: 120_000,
                operators: [
                  {
                    accountId: f.users.operator.accountId,
                    tenants: ['north', 'south'],
                    operations: ADMINISTRATION_OPERATIONS.filter((operation) => operation !== 'revokeMembership'),
                    roles: ['reader'],
                  },
                  {
                    accountId: f.users.operator.accountId,
                    tenants: ['north'],
                    operations: ['revokeMembership' as const],
                    roles: ['manager'],
                  },
                ],
              },
            }
          : {}),
      },
      source: { ...f.binding.source, existingPath: f.path },
      deployment: 'PRIVATE_HTTP_DEPLOYMENT',
      roles: ['reader', 'manager'],
      maxLifetimeMs: 60_000,
    },
  };
  let owner: Awaited<ReturnType<typeof createTenantAuthenticatedHttpServer>>;
  const start = async () => {
    owner = await createTenantAuthenticatedHttpServer(options);
    f.addCleanup(async () => {
      owner.server.closeAllConnections();
      await owner.retire();
    });
    owner.server.listen(0, bound.host);
    await once(owner.server, 'listening');
    const address = owner.server.address();
    assert.ok(address && typeof address !== 'string');
    bound.port = address.port;
    return owner;
  };
  if (launch) await start();
  const url = (operation: string, query = '') => `${root}/${operation}?app=${f.binding.appId}${query}`;
  const identity = (user = f.users.operator) => ({
    cookie: user.cookie,
    [headers.app]: f.binding.appId,
    [headers.account]: user.accountId,
  });
  const call = async (
    path: string,
    body?: unknown,
    extra: Record<string, string> = identity(),
    method = body === undefined ? 'GET' : 'POST',
  ): Promise<Answer> => {
    const origin = `http://${bound.host}:${bound.port}`;
    const response = await fetch(origin + path, {
      method,
      headers: { origin, 'content-type': 'application/json', ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) : {} };
  };
  const raw = (path: string, extra: string[] = [], method = 'POST', body = '{}'): Promise<Answer> =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: bound.host,
          port: bound.port,
          path,
          method,
          headers: [
            'Host',
            `${bound.host}:${bound.port}`,
            'Content-Type',
            'application/json',
            'Content-Length',
            String(Buffer.byteLength(body)),
            ...Object.entries(identity()).flat(),
            ...extra,
          ],
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => {
            try {
              const text = Buffer.concat(chunks).toString('utf8'),
                responseHeaders = new Headers();
              for (let index = 0; index < res.rawHeaders.length; index += 2)
                responseHeaders.append(res.rawHeaders[index], res.rawHeaders[index + 1]);
              resolve({ status: res.statusCode!, headers: responseHeaders, body: text ? JSON.parse(text) : {}, text });
            } catch (error) {
              reject(error);
            }
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.setTimeout(15_000, () => req.destroy(new Error('Administration HTTP test timed out')));
      req.end(body);
    });
  const open = async (user = f.users.operator) => {
    const answer = await call(url('open'), {}, identity(user));
    assert.equal(answer.status, 200, answer.text);
    return {
      answer,
      session: answer.body.session as AdministrationSession | null,
      owned: { ...identity(user), [contextHeader]: answer.body.session?.context ?? '' },
    };
  };
  return {
    ...f,
    options,
    start,
    bound,
    url,
    identity,
    call,
    raw,
    open,
    get owner() {
      return owner;
    },
  };
}
function denied(answer: Answer, outcome?: string) {
  assert.ok(answer.status >= 400, answer.text);
  assert.equal(answer.headers.get('cache-control'), 'no-store');
  for (const name of [...Object.values(headers), contextHeader]) assert.equal(answer.headers.get(name), null);
  assert.equal(answer.body.code, 'tenant_administration_unavailable');
  assert.doesNotMatch(answer.text, /PRIVATE_|tenant_item|tenant_id|sessionId|password|stack|cause|sqlite/i);
  if (outcome) assert.equal(answer.body.outcome, outcome);
}
function owned(answer: Answer, f: Awaited<ReturnType<typeof fixture>>, context?: string) {
  assert.equal(answer.status, 200, answer.text);
  assert.equal(answer.headers.get('cache-control'), 'no-store');
  assert.equal(answer.headers.get(headers.app), f.binding.appId);
  assert.equal(answer.headers.get(headers.account), f.users.operator.accountId);
  assert.equal(answer.headers.get(contextHeader), context ?? null);
  for (const name of [headers.tenant, headers.tab, headers.context, headers.revision]) assert.equal(answer.headers.get(name), null);
}

test('configured WHOAMI is availability, while native open admits a zero-membership operator and returns captured metadata', async (t) => {
  const f = await fixture(t);
  for (const user of [f.users.operator, f.users.outsider]) {
    const who = await f.call(`/api/whoami?app=${f.binding.appId}`, undefined, f.identity(user));
    assert.equal(who.status, 200, who.text);
    assert.equal(who.body.tenantAdministration, true);
  }
  const signedOut = await f.call(`/api/whoami?app=${f.binding.appId}`, undefined, { ...f.identity(), cookie: '' });
  assert.equal(signedOut.body.signedIn, false);
  assert.equal(Object.hasOwn(signedOut.body, 'tenantAdministration'), false);
  const { answer, session } = await f.open();
  assert.ok(session);
  owned(answer, f, session.context);
  assert.deepEqual(Object.keys(session).sort(), ['accountId', 'appId', 'context', 'expiresAt', 'maxMembershipLifetimeMs']);
  assert.equal(session.maxMembershipLifetimeMs, 120_000);
  assert.ok(session.expiresAt > Date.now());
  assert.ok(session.expiresAt <= Date.now() + 60_000);
  assert.equal(f.db.prepare(`SELECT count(*) AS n FROM "${TENANT_TABLES.membership}"`).get()!.n, 0);
  const outsider = await f.open(f.users.outsider);
  assert.equal(outsider.session, null);
  assert.equal(outsider.answer.headers.get(contextHeader), null);
  assert.equal(outsider.answer.headers.get(headers.account), f.users.outsider.accountId);
  denied(await f.call(f.url('open'), {}, { ...f.identity(), cookie: '' }), 'not_applied');
  denied(await f.call(f.url('open'), {}, { ...f.identity(), cookie: f.users.outsider.cookie }), 'not_applied');
});

test('administration tenant/member pages, versioned execution and exact-intent status preserve independent ceilings', async (t) => {
  const f = await fixture(t),
    a = await f.open();
  assert.ok(a.session);
  const targets = await f.call(f.url('tenants', '&limit=1'), undefined, a.owned);
  owned(targets, f, a.session.context);
  assert.equal(targets.body.page.items[0].tenantId, 'north');
  assert.equal(targets.body.page.items[0].tenant, null);
  assert.equal(targets.body.page.next, 'north');
  const capabilities = targets.body.page.items[0].capabilities;
  assert.deepEqual(capabilities.find((c: any) => c.operation === 'replaceMembership').roles, ['reader']);
  assert.deepEqual(capabilities.find((c: any) => c.operation === 'revokeMembership').roles, ['manager']);
  const second = await f.call(f.url('tenants', '&after=north&limit=1'), undefined, a.owned);
  assert.deepEqual(
    second.body.page.items.map((item: any) => item.tenantId),
    ['south'],
  );
  assert.equal(second.body.page.next, null);
  const create: AdministrationAttempt = { idempotencyKey: 'create-north', intent: { operation: 'createTenant', tenantId: 'north' } };
  const absent = await f.call(f.url('status'), create, a.owned);
  owned(absent, f, a.session.context);
  assert.deepEqual(absent.body, { status: 'not_found', outcome: 'unknown', result: null });
  const created = await f.call(f.url('execute'), create, a.owned);
  owned(created, f, a.session.context);
  assert.equal(created.body.outcome, 'applied');
  assert.equal(created.body.result.change.after.tenant.version, '1');
  const repeated = await f.call(f.url('execute'), create, a.owned);
  assert.equal(repeated.body.result.receiptId, created.body.result.receiptId);
  assert.equal(repeated.body.result.replayed, true);
  const status = await f.call(f.url('status'), create, a.owned);
  assert.equal(status.body.status, 'completed');
  assert.equal(status.body.outcome, 'applied');
  assert.equal(status.body.result.receiptId, created.body.result.receiptId);
  const grant: AdministrationAttempt = {
    idempotencyKey: 'grant-reader',
    intent: {
      operation: 'grantMembership',
      tenantId: 'north',
      expectedTenantVersion: '1',
      accountId: f.users.target.accountId,
      roles: ['reader'],
      validUntil: Date.now() + 90_000,
    },
  };
  const granted = await f.call(f.url('execute'), grant, a.owned);
  owned(granted, f, a.session.context);
  const member = granted.body.result.change.after.membership;
  const members = await f.call(f.url('memberships', '&tenantId=north&operation=replaceMembership&limit=1'), undefined, a.owned);
  owned(members, f, a.session.context);
  assert.deepEqual(members.body.page.items, [member]);
  const hidden = await f.call(f.url('memberships', '&tenantId=north&operation=revokeMembership'), undefined, a.owned);
  assert.deepEqual(hidden.body.page.items, []);
  assert.deepEqual(hidden.body.page.roles, ['manager']);
  const beyond = await f.call(
    f.url('memberships', `&tenantId=north&operation=replaceMembership&after=${member.membershipId}`),
    undefined,
    a.owned,
  );
  assert.deepEqual(beyond.body.page.items, []);
  denied(await f.call(f.url('memberships', '&tenantId=private&operation=replaceMembership'), undefined, a.owned), 'not_applied');
  denied(
    await f.call(
      f.url('execute'),
      {
        idempotencyKey: 'revoke-reader',
        intent: {
          operation: 'revokeMembership',
          tenantId: 'north',
          expectedTenantVersion: '1',
          membershipId: member.membershipId,
          expectedMembershipVersion: member.version,
        },
      },
      a.owned,
    ),
    'not_applied',
  );
  assert.equal(f.db.prepare(`SELECT count(*) AS n FROM "${ADMINISTRATION_JOURNAL_TABLES.receipt}"`).get()!.n, 2);
});

test('strict administration routing, scope headers, selectors, duplicates and JSON envelopes fail closed', async (t) => {
  const f = await fixture(t),
    a = await f.open();
  for (const name of [headers.tenant, headers.tab, headers.context, headers.revision, 'x-mistri-conn', 'x-mistri-unrecognized']) {
    await t.test(`forbidden header ${name}`, async () =>
      denied(await f.call(f.url('open'), {}, { ...f.identity(), [name]: 'north' }), 'not_applied'),
    );
  }
  for (const extra of ['&tenant=north', '&conn=business', '&app=admin-app', '&unexpected=1', '&limit=1']) {
    await t.test(`extra selector ${extra}`, async () => denied(await f.call(f.url('open', extra), {}), 'not_applied'));
  }
  for (const name of [headers.account, headers.app, 'cookie', 'host', 'content-type']) {
    await t.test(`duplicate ${name}`, async () =>
      denied(await f.raw(f.url('open'), [name, name === headers.app ? f.binding.appId : 'duplicate']), 'not_applied'),
    );
  }
  denied(
    await f.raw(f.url('tenants'), [contextHeader, a.session!.context, contextHeader.toUpperCase(), a.session!.context], 'GET', ''),
    'not_applied',
  );
  for (const route of [
    `${root}/open/`,
    `${root}//open`,
    `${root}/%6fpen`,
    '/api//tenant/administration/open',
    '/API/tenant/administration/open',
    `${root}/../administration/open`,
    `${root}/unknown`,
  ]) {
    await t.test(`noncanonical ${route}`, async () => denied(await f.raw(`${route}?app=${f.binding.appId}`), 'not_applied'));
  }
  for (const body of [[], null, { context: 'x' }, { expectedAccount: f.users.operator.accountId }, { app: f.binding.appId }]) {
    denied(await f.call(f.url('open'), body), 'not_applied');
  }
  for (const body of ['{', '', 'true']) denied(await f.raw(f.url('open'), [], 'POST', body), 'not_applied');
  for (const identity of [
    { ...f.identity(), [headers.account]: '' },
    { ...f.identity(), [headers.app]: '' },
    { ...f.identity(), [headers.app]: 'other' },
    { ...f.identity(), [contextHeader]: a.session!.context },
  ]) {
    denied(await f.call(f.url('open'), {}, identity), 'not_applied');
  }
  denied(await f.call(f.url('tenants')), 'not_applied');
  denied(await f.call(f.url('tenants'), {}, a.owned), 'not_applied');
  for (const query of ['&limit=0', '&limit=01', '&limit=101', '&limit=1.0', '&limit=1&limit=2', '&after=', '&after=a&after=b']) {
    denied(await f.call(f.url('tenants', query), undefined, a.owned), 'not_applied');
  }
  for (const query of [
    '',
    '&tenantId=north',
    '&tenantId=north&operation=grantMembership',
    '&tenantId=north&operation=replaceMembership&tenantId=south',
  ]) {
    denied(await f.call(f.url('memberships', query), undefined, a.owned), 'not_applied');
  }
  const attempt = { idempotencyKey: 'strict-body', intent: { operation: 'createTenant', tenantId: 'north' } };
  for (const body of [
    {},
    { ...attempt, context: a.session!.context },
    { ...attempt, expectedAccount: f.users.operator.accountId },
    { ...attempt, intent: { ...attempt.intent, conn: 'business' } },
  ]) {
    denied(await f.call(f.url('execute'), body, a.owned), 'not_applied');
    denied(await f.call(f.url('status'), body, a.owned), 'unknown');
  }
  assert.equal(f.db.prepare(`SELECT count(*) AS n FROM "${TENANT_TABLES.tenant}"`).get()!.n, 0);
});

test('origin/host protection, bounded bodies and all status refusals retain conservative outcomes', async (t) => {
  const f = await fixture(t),
    a = await f.open();
  for (const operation of ['open', 'status', 'execute']) {
    const expected = operation === 'status' ? 'unknown' : 'not_applied';
    const hostile: Record<string, string>[] = [
      { origin: 'https://hostile.example' },
      { host: 'hostile.example' },
      { 'sec-fetch-site': 'cross-site' },
      { 'content-type': 'text/plain' },
      { 'content-encoding': 'gzip' },
    ];
    for (const extra of hostile) {
      denied(await f.call(f.url(operation), {}, { ...a.owned, ...extra }), expected);
    }
    const large = await f.raw(
      f.url(operation),
      operation === 'open' ? [] : [contextHeader, a.session!.context],
      'POST',
      JSON.stringify({ padding: 'a'.repeat(65_536) }),
    );
    denied(large, expected);
    assert.equal(large.status, 413);
  }
  denied(await f.call(f.url('tenants'), undefined, { ...a.owned, origin: 'https://hostile.example' }), 'not_applied');
  denied(await f.call(f.url('status'), undefined, a.owned), 'unknown');
  denied(await f.raw(`${root}/status/?app=${f.binding.appId}`), 'unknown');
  denied(await f.call(f.url('status', '&conn=private'), {}, a.owned), 'unknown');
  denied(await f.call(f.url('status'), {}, { ...a.owned, [contextHeader]: 'unknown-context' }), 'unknown');
  const business = await f.call(`/api/tenant/bootstrap?app=${f.binding.appId}`, undefined, a.owned);
  assert.ok(business.status >= 400);
  assert.equal(business.headers.get(contextHeader), null);
});

test('omitted administration denies its prefix and never advertises availability', async (t) => {
  const f = await fixture(t, false);
  const who = await f.call(`/api/whoami?app=${f.binding.appId}`);
  assert.equal(who.status, 200, who.text);
  assert.equal(Object.hasOwn(who.body, 'tenantAdministration'), false);
  denied(await f.call(f.url('open'), {}), 'not_applied');
  denied(await f.call(f.url('status'), {}, { ...f.identity(), [contextHeader]: 'fake-context' }), 'unknown');
  denied(await f.raw(`${root}/%6fpen?app=${f.binding.appId}`), 'not_applied');
});

test('administration contexts cannot cross accounts or same-account native login instances', async (t) => {
  const f = await fixture(t),
    a = await f.open();
  const attempt = { idempotencyKey: 'old-login', intent: { operation: 'createTenant', tenantId: 'north' } };
  denied(await f.call(f.url('execute'), attempt, { ...a.owned, cookie: f.users.outsider.cookie }), 'not_applied');
  denied(await f.call(f.url('tenants'), undefined, { ...a.owned, ...f.identity(f.users.outsider) }), 'not_applied');
  const signedIn = await f.callNative('/api/auth/sign-in/email', {
    method: 'POST',
    body: JSON.stringify({
      email: 'operator@example.test',
      password: 'tenant-administration-operator-password-123',
    }),
  });
  assert.equal(signedIn.response.status, 200);
  const cookie = signedIn.response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  denied(await f.call(f.url('execute'), attempt, { ...a.owned, cookie }), 'not_applied');
  denied(await f.call(f.url('status'), attempt, { ...a.owned, cookie }), 'unknown');
  const fresh = await f.open({ ...f.users.operator, cookie });
  assert.ok(fresh.session);
  assert.equal((await f.call(f.url('execute'), attempt, fresh.owned)).body.outcome, 'applied');
});

test('retirement interrupts accepted partial JSON readers and closes auth after draining', async (t) => {
  const f = await fixture(t),
    a = await f.open(),
    accepted = gate();
  f.owner.server.once('request', () => accepted.release());
  const req = httpRequest({
    hostname: f.bound.host,
    port: f.bound.port,
    path: f.url('execute'),
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '200', ...a.owned },
  });
  const closed = new Promise<void>((resolve) => {
    req.on('error', () => resolve());
    req.on('close', () => resolve());
  });
  req.write('{"idempotencyKey":');
  await accepted.promise;
  const retiring = f.owner.retire();
  assert.equal(retiring, f.owner.retire());
  await retiring;
  await closed;
  assert.throws(() => captureAppAuthRuntime(f.auth), TenantContextError);
  assert.equal(f.db.prepare(`SELECT count(*) AS n FROM "${TENANT_TABLES.tenant}"`).get()!.n, 0);
});

test('retirement holds native auth while an admitted administration writer is pending', async (t) => {
  const f = await fixture(t),
    a = await f.open(),
    entered = gate(),
    release = gate();
  const method = SqliteAdapter.prototype.runtimeMaintenanceTransaction;
  const mocked = t.mock.method(
    SqliteAdapter.prototype,
    'runtimeMaintenanceTransaction',
    async function (this: SqliteAdapter, ...args: Parameters<typeof method>) {
      entered.release();
      await release.promise;
      return Reflect.apply(method, this, args);
    },
  );
  const pending = f.call(f.url('execute'), { idempotencyKey: 'retire', intent: { operation: 'createTenant', tenantId: 'north' } }, a.owned);
  try {
    await entered.promise;
    const retiring = f.owner.retire();
    let drained = false;
    void retiring.then(() => {
      drained = true;
    });
    await Promise.resolve();
    assert.equal(drained, false);
    captureAppAuthRuntime(f.auth).assertCurrent();
    release.release();
    denied(await pending);
    // The response is consumed and the held writer has settled. Reap sockets
    // that became idle after server.close(), not the active work under test.
    f.owner.server.closeIdleConnections();
    await retiring;
    assert.throws(() => captureAppAuthRuntime(f.auth), TenantContextError);
  } finally {
    release.release();
    mocked.mock.restore();
  }
});

test('late data-host acquisition failure retires the administration owner and releases the native binding for retry', async (t) => {
  const f = await fixture(t, true, false),
    original = SqliteAdapter.prototype.runtimeMaintenanceTransaction;
  let opened = 0,
    adminCloses = 0;
  const administrationAdapters = new WeakSet<SqliteAdapter>();
  const close = SqliteAdapter.prototype.close;
  const closeMock = t.mock.method(SqliteAdapter.prototype, 'close', function (this: SqliteAdapter) {
    if (administrationAdapters.has(this)) adminCloses++;
    return close.call(this);
  });
  const mocked = t.mock.method(
    SqliteAdapter.prototype,
    'runtimeMaintenanceTransaction',
    async function (this: SqliteAdapter, ...args: Parameters<typeof original>) {
      const result = await Reflect.apply(original, this, args);
      if (++opened === 1) {
        administrationAdapters.add(this);
        f.bound.port = -1;
      }
      return result;
    },
  );
  try {
    await assert.rejects(f.start(), TenantContextError);
  } finally {
    mocked.mock.restore();
    closeMock.mock.restore();
    f.bound.port = 0;
  }
  assert.ok(opened > 0);
  assert.equal(adminCloses, 1);
  captureAppAuthRuntime(f.auth).assertCurrent();
  await f.start();
  assert.ok((await f.open()).session);
});

test('chunked JSON bodies are bounded without trusting Content-Length', async (t) => {
  const f = await fixture(t),
    a = await f.open();
  const answer = await new Promise<Answer>((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: f.bound.host,
        port: f.bound.port,
        path: f.url('status'),
        method: 'POST',
        headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked', ...a.owned },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode!, headers: new Headers(res.headers as Record<string, string>), text, body: JSON.parse(text) });
          } catch (error) {
            reject(error);
          }
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Chunked body timeout')));
    req.write('{"idempotencyKey":"');
    req.write('x'.repeat(65_536));
    req.end('"}');
  });
  denied(answer, 'unknown');
  assert.equal(answer.status, 413);
  assert.equal(f.db.prepare(`SELECT count(*) AS n FROM "${ADMINISTRATION_JOURNAL_TABLES.receipt}"`).get()!.n, 0);
});

test('a transport failure after service commit reports unknown and exact status recovers the receipt', async (t) => {
  const f = await fixture(t),
    a = await f.open(),
    writeHead = ServerResponse.prototype.writeHead;
  let failed = false;
  const mocked = t.mock.method(
    ServerResponse.prototype,
    'writeHead',
    function (this: ServerResponse, ...args: Parameters<typeof writeHead>) {
      if (!failed && args[0] === 200) {
        failed = true;
        throw new Error('PRIVATE_ACK_FAILURE');
      }
      return Reflect.apply(writeHead, this, args);
    },
  );
  const attempt: AdministrationAttempt = { idempotencyKey: 'lost-ack', intent: { operation: 'createTenant', tenantId: 'north' } };
  try {
    denied(await f.call(f.url('execute'), attempt, a.owned), 'unknown');
  } finally {
    mocked.mock.restore();
  }
  assert.equal(failed, true);
  const recovered = await f.call(f.url('status'), attempt, a.owned);
  assert.equal(recovered.body.status, 'completed');
  assert.equal(recovered.body.outcome, 'applied');
  assert.equal(recovered.body.result.change.after.tenant.version, '1');
  const conflict = { ...attempt, intent: { operation: 'createTenant', tenantId: 'north', unexpected: true } };
  denied(await f.call(f.url('status'), conflict, a.owned), 'unknown');
});

test('held business write and concurrent suspension share the file queue without blocking the event loop or poisoning either owner', async (t) => {
  const f = await fixture(t),
    a = await f.open();
  const administer = async (idempotencyKey: string, intent: AdministrationAttempt['intent']) => {
    const answer = await f.call(f.url('execute'), { idempotencyKey, intent }, a.owned);
    assert.equal(answer.status, 200, answer.text);
    assert.equal(answer.body.outcome, 'applied');
    return answer;
  };
  await administer('create-concurrent', { operation: 'createTenant', tenantId: 'north' });
  await administer('grant-concurrent', {
    operation: 'grantMembership',
    tenantId: 'north',
    expectedTenantVersion: '1',
    accountId: f.users.target.accountId,
    roles: ['reader'],
    validUntil: Date.now() + 90_000,
  });
  const select = await f.call(`/api/tenant/context/open?app=${f.binding.appId}&tenant=north`, {}, f.identity(f.users.target));
  assert.equal(select.status, 200, select.text);
  const businessHeaders = {
    ...f.identity(f.users.target),
    [headers.tab]: select.body.tabId,
    [headers.context]: select.body.context,
    [headers.revision]: String(select.body.revision),
  };
  const method = SqliteAdapter.prototype.scopeVerifiedTransaction,
    entered = gate(),
    release = gate(),
    adminQueued = gate();
  const maintenance = SqliteAdapter.prototype.runtimeMaintenanceTransaction;
  const adminMock = t.mock.method(
    SqliteAdapter.prototype,
    'runtimeMaintenanceTransaction',
    function (this: SqliteAdapter, ...args: Parameters<typeof maintenance>) {
      adminQueued.release();
      return Reflect.apply(maintenance, this, args);
    },
  );
  let holds = 0;
  const mocked = t.mock.method(
    SqliteAdapter.prototype,
    'scopeVerifiedTransaction',
    function (
      this: SqliteAdapter,
      input: Parameters<typeof method>[0],
      verify: Parameters<typeof method>[1],
      run: Parameters<typeof method>[2],
    ) {
      return method.call(this, input, verify, async (tx, catalog) => {
        // This callback starts after BEGIN IMMEDIATE on the enrolled business writer.
        if (++holds === 1) {
          entered.release();
          await release.promise;
        }
        return run(tx, catalog);
      });
    },
  );
  const started = performance.now();
  const update = f.call(
    `/api/update?app=${f.binding.appId}&tenant=north`,
    { table: 'item', key: { id: 'one' }, values: { name: 'Committed before suspension' } },
    businessHeaders,
  );
  try {
    await entered.promise;
    const suspension = administer('suspend-concurrent', {
      operation: 'setTenantStatus',
      tenantId: 'north',
      expectedTenantVersion: '1',
      status: 'suspended',
    });
    await adminQueued.promise;
    // A synchronous SQLite busy wait delays this timer by five seconds and
    // falsely refuses the administration operation while the first owns BEGIN.
    await new Promise((resolve) => setTimeout(resolve, 50));
    release.release();
    const [updated, suspended] = await Promise.all([update, suspension]);
    assert.ok(performance.now() - started < 3000, 'same-file writers must yield instead of entering SQLite busy_timeout');
    assert.equal(updated.status, 200, updated.text);
    assert.equal(suspended.body.result.change.after.tenant.status, 'suspended');
    assert.equal(f.db.prepare('SELECT name FROM tenant_item WHERE id = ?').get('one')!.name, 'Committed before suspension');
  } finally {
    release.release();
    mocked.mock.restore();
    adminMock.mock.restore();
  }
  const blocked = await f.call(
    `/api/update?app=${f.binding.appId}&tenant=north`,
    { table: 'item', key: { id: 'one' }, values: { name: 'Must be denied' } },
    businessHeaders,
  );
  assert.ok(blocked.status >= 400, blocked.text);
  await administer('reactivate-concurrent', {
    operation: 'setTenantStatus',
    tenantId: 'north',
    expectedTenantVersion: '2',
    status: 'active',
  });
  const reopened = await f.call(`/api/tenant/context/open?app=${f.binding.appId}&tenant=north`, {}, f.identity(f.users.target));
  assert.equal(reopened.status, 200, reopened.text);
  const updatedAgain = await f.call(
    `/api/update?app=${f.binding.appId}&tenant=north`,
    { table: 'item', key: { id: 'one' }, values: { name: 'Both owners still usable' } },
    {
      ...f.identity(f.users.target),
      [headers.tab]: reopened.body.tabId,
      [headers.context]: reopened.body.context,
      [headers.revision]: String(reopened.body.revision),
    },
  );
  assert.equal(updatedAgain.status, 200, updatedAgain.text);
  assert.equal(f.db.prepare('SELECT name FROM tenant_item WHERE id = ?').get('one')!.name, 'Both owners still usable');
});
