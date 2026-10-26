import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { TransactionOutcomeUnknown } from '../packages/engine/src/adapters/adapter.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { normalizeFlagCatalog, normalizeFlagSnapshot } from '../packages/mistri/src/shared/appFlags.js';
import { createAppAuth, createSuiteAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { createFlagDeployment, type FlagDeploymentOptions } from '../packages/mistri/src/server/flags/deployment.js';
import { createFlagHttp } from '../packages/mistri/src/server/flags/http.js';
import { FlagRevisionConflict, type FlagHistoryEntry, type FlagStore } from '../packages/mistri/src/server/flags/store.js';

const catalog = normalizeFlagCatalog({
  flags: {
    alpha: { type: 'boolean', default: false, owner: 'product', tenantManaged: true },
    hidden: { type: 'string', default: 'SECRET', owner: 'security' },
    zebra: { type: 'boolean', default: false, owner: 'product' },
  },
  roles: ['reader', 'manager', 'oncall'],
  audiences: { beta: { roles: ['reader'], rollout: 50 } },
});
const capability = { environments: ['production'], owners: ['product'] };
const roles = {
  reader: { flags: [{ ...capability, actions: ['view'] as const }] },
  manager: { flags: [{ ...capability, actions: ['manage'] as const }] },
  oncall: { flags: [{ ...capability, actions: ['killswitch'] as const }] },
};
const scope = { appId: 'target', environment: 'production', tenantId: null };
const change = { tenantId: null, expectedRevision: 1, reason: 'Release', override: { value: true } };

/** Native proof fixture plus in-memory HTTP streams: no listener or service. */
async function fixture(
  t: TestContext,
  configure?: (store: FlagStore) => FlagStore,
  configureTarget?: (target: FlagDeploymentOptions['targets'][number]) => FlagDeploymentOptions['targets'][number],
) {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-flag-http-')),
    secret = 'flag-http-fixture-secret-at-least-thirty-two-characters';
  const auth = await createAppAuth(
    {
      path: join(dir, 'app.ts'),
      dir,
      sources: {},
      pages: [],
      app: parseAppConfig(
        {
          id: 'target',
          name: 'Target',
          auth: { store: 'auth.db', signUp: 'open', roles: { reader: { read: true }, manager: { read: false }, oncall: { read: false } } },
          resources: { item: {} },
          views: { items: { kind: 'list', from: 'item' } },
          home: 'items',
        },
        'flags',
      ),
    },
    { baseURL: 'http://localhost:4111', trustedOrigins: ['http://localhost:4111'], environment: { BETTER_AUTH_SECRET: secret } },
  );
  const db = new DatabaseSync(auth.store),
    now = new Date().toISOString();
  t.after(() => {
    auth.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES(?,?,?,?,?,?,?,?)').run(
    'subject',
    'Flag User',
    'flags@example.test',
    1,
    now,
    now,
    'reader,manager',
    0,
  );
  db.prepare('INSERT INTO session(id,token,userId,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)').run(
    'session',
    'token',
    'subject',
    new Date(Date.now() + 60_000).toISOString(),
    now,
    now,
  );
  const signature = createHmac('sha256', secret).update('token').digest('base64');
  const cookie = `mistri-target.session_token=${encodeURIComponent(`token.${signature}`)}`;
  let writes = 0,
    closed = 0,
    reads = 0;
  const before = normalizeFlagSnapshot({ ...scope, revision: 0, overrides: { hidden: { value: 'PRIVATE_OTHER_OWNER' } } }, catalog);
  let snapshot = normalizeFlagSnapshot(
    {
      ...scope,
      revision: 1,
      overrides: {
        ...before.overrides,
        alpha: { value: true, rules: [{ audiences: ['beta'], value: false }] },
      },
    },
    catalog,
  );
  const entry: FlagHistoryEntry = {
    scope,
    revision: 1,
    flagId: 'alpha',
    operation: 'set',
    actorId: 'subject',
    reason: 'Release',
    at: now,
    revertRevision: null,
    before,
    after: snapshot,
  };
  const store: FlagStore = {
    binding: { suiteId: 'suite', deploymentId: 'deployment' },
    read: async () => {
      reads++;
      return snapshot;
    },
    history: async () => ({ entries: [entry], nextBeforeRevision: null }),
    mutate: async (input, guard) => {
      if (input.expectedRevision !== snapshot.revision) throw new FlagRevisionConflict();
      await guard();
      writes++;
      const previous = snapshot;
      snapshot = normalizeFlagSnapshot(
        {
          ...snapshot,
          revision: snapshot.revision + 1,
          overrides: {
            ...snapshot.overrides,
            [input.flagId]:
              input.operation === 'set'
                ? input.override
                : input.operation === 'kill'
                  ? { ...snapshot.overrides[input.flagId], disabled: true }
                  : {},
          },
        },
        catalog,
      );
      return { ...entry, flagId: input.flagId, operation: input.operation, revision: snapshot.revision, before: previous, after: snapshot };
    },
    close: async () => {
      closed++;
    },
  };
  let active = true;
  const base = {
    appId: 'target',
    catalog,
    roles,
    tenantApp: false,
    auth,
    assertCurrent() {
      if (!active) throw new Error('target retired');
    },
  };
  const target = configureTarget ? configureTarget(base) : base;
  if (target.auth !== auth) t.after(() => target.auth.close());
  const deployment = await createFlagDeployment(
    {
      suiteId: 'suite',
      deploymentId: 'deployment',
      environment: 'production',
      storeUrl: 'postgresql://operator@control/flags',
      targets: [target],
    },
    configure ? configure(store) : store,
  );
  t.after(() => deployment.close());
  const http = createFlagHttp({ target: deployment.target('target'), bound: { host: '127.0.0.1', port: 4111 }, mount: '/target' });
  function start(path: string, method = 'GET', headers: Record<string, string> = {}) {
    const stream = new PassThrough();
    const req = Object.assign(stream, {
      url: path,
      method,
      headers: {
        host: 'localhost:4111',
        origin: 'http://localhost:4111',
        cookie,
        'x-mistri-account': 'subject',
        'content-type': 'application/json',
        ...headers,
      },
      aborted: false,
    }) as unknown as IncomingMessage;
    const reply = {
      status: 0,
      headers: {} as Record<string, unknown>,
      text: '',
      destroyed: false,
      writableEnded: false,
      setHeader(key: string, value: unknown) {
        this.headers[key] = value;
      },
      writeHead(status: number, headers: Record<string, unknown>) {
        this.status = status;
        Object.assign(this.headers, headers);
        return this;
      },
      end(text: string) {
        this.text = text;
        this.writableEnded = true;
      },
    };
    const done = http(req, reply as unknown as ServerResponse);
    return { req, stream, reply, done };
  }
  async function call(path: string, method = 'GET', body?: unknown, headers?: Record<string, string>) {
    const result = start(path, method, headers);
    result.stream.end(body === undefined ? undefined : JSON.stringify(body));
    const handled = await result.done;
    return { ...result.reply, handled, body: result.reply.text ? JSON.parse(result.reply.text) : undefined };
  }
  return {
    db,
    deployment,
    start,
    call,
    writes: () => writes,
    reads: () => reads,
    closed: () => closed,
    setRole(role: string) {
      db.prepare('UPDATE user SET role=? WHERE id=?').run(role, 'subject');
    },
    retireTarget() {
      active = false;
    },
  };
}

test('bounded listing filters before pagination; detail/history expose only authorized sanitized flag DTOs', async (t) => {
  const f = await fixture(t),
    page = await f.call('/target/api/flags?limit=1');
  assert.equal(page.status, 200);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.deepEqual(
    page.body.items.map((row: { flagId: string }) => row.flagId),
    ['alpha'],
  );
  assert.equal(page.body.nextAfter, 'alpha');
  assert.equal('total' in page.body, false);
  const next = await f.call('/target/api/flags?limit=1&after=alpha');
  assert.deepEqual(
    next.body.items.map((row: { flagId: string }) => row.flagId),
    ['zebra'],
  );
  assert.equal(next.body.nextAfter, null);
  for (const path of ['/target/api/flags/alpha', '/target/api/flags/alpha/history']) {
    const reply = await f.call(path);
    assert.equal(reply.status, 200);
    for (const secret of ['PRIVATE_OTHER_OWNER', 'SECRET', 'reader', 'region', 'east', 'hidden'])
      assert.equal(reply.text.includes(secret), false);
  }
  assert.equal((await f.call('/target/api/flags/hidden')).status, 403);
  assert.equal((await f.call('/target/api/flags/missing')).status, 403);
  assert.equal((await f.call('/another/api/flags')).handled, false);
  assert.equal((await f.call('/target/api/flags/alpha?tenant=one')).status, 403);
});

test('kill-only capability summary has revision/actions but no values, and does not grant view/manage', async (t) => {
  const f = await fixture(t);
  f.setRole('oncall');
  const summary = await f.call('/target/api/flags/alpha/capabilities');
  assert.equal(summary.status, 200);
  assert.deepEqual(summary.body, { ...scope, flagId: 'alpha', revision: 1, actions: ['kill'] });
  assert.deepEqual((await f.call('/target/api/flags')).body.items, []);
  assert.equal((await f.call('/target/api/flags/alpha')).status, 403);
  assert.equal((await f.call('/target/api/flags/alpha/history')).status, 403);
  assert.equal((await f.call('/target/api/flags/alpha/override', 'PUT', change)).status, 403);
  assert.equal(
    (await f.call('/target/api/flags/alpha/revert', 'POST', { tenantId: null, expectedRevision: 1, revertRevision: 0, reason: 'Restore' }))
      .status,
    403,
  );
  const killed = await f.call('/target/api/flags/alpha/kill', 'POST', { tenantId: null, expectedRevision: 1, reason: 'Incident' });
  assert.equal(killed.status, 200);
  assert.deepEqual(killed.body, { flagId: 'alpha', revision: 2, operation: 'kill' });
});

test('methods, duplicate selectors, body authority fields and replacement kill payloads are refused', async (t) => {
  const f = await fixture(t);
  for (const path of [
    '/target/api/flags?environment=staging',
    '/target/api/flags?tenant=one&tenant=two',
    '/target/api/flags?limit=101',
    '/target/api/flags?limit=01',
    '/target/api/flags/alpha?roles=admin',
  ])
    assert.equal((await f.call(path)).status, 400);
  for (const field of ['appId', 'environment', 'actorId', 'owner', 'roles', 'requiredCapabilities', 'capabilities', 'flagId', 'operation'])
    assert.equal((await f.call('/target/api/flags/alpha/override', 'PUT', { ...change, [field]: 'injected' })).status, 400, field);
  assert.equal((await f.call('/target/api/flags/alpha/kill', 'POST', change)).status, 400);
  assert.equal((await f.call('/target/api/flags/alpha/override', 'POST', change)).status, 405);
  assert.equal((await f.call('/target/api/flags/alpha/kill', 'GET')).status, 405);
  assert.equal((await f.call('/target/api/flags/alpha/override?tenant=one', 'PUT', change)).status, 400);
  assert.equal(f.writes(), 0);
  const changed = await f.call('/target/api/flags/alpha/changes', 'POST', { ...change, operation: 'set' });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.operation, 'set');
});

test('origin/account checks precede body read and repeat after held body; no request identity substitution', async (t) => {
  const f = await fixture(t);
  const hostile = f.start('/target/api/flags/alpha/override', 'PUT', { origin: 'http://evil.test' });
  await hostile.done;
  assert.equal(hostile.reply.status, 403);
  hostile.stream.destroy();
  assert.equal((await f.call('/target/api/flags', 'GET', undefined, { 'x-mistri-account': 'other' })).status, 409);
  assert.equal((await f.call('/target/api/flags', 'GET', undefined, { cookie: '' })).status, 401);
  const held = f.start('/target/api/flags/alpha/override', 'PUT');
  await new Promise<void>((resolve) => setImmediate(resolve));
  held.req.headers['x-mistri-account'] = 'other';
  held.stream.end(JSON.stringify(change));
  await held.done;
  assert.equal(held.reply.status, 409);
  assert.equal(f.writes(), 0);
});

test('revocation while body is held and while control lock is pending prevents commits', async (t) => {
  const f = await fixture(t);
  const held = f.start('/target/api/flags/alpha/override', 'PUT');
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.setRole('reader');
  held.stream.end(JSON.stringify(change));
  await held.done;
  assert.equal(held.reply.status, 403);
  assert.equal(f.writes(), 0);
  let revoke = () => {};
  const locked = await fixture(t, (store) => ({
    ...store,
    mutate: async (input, guard) => {
      revoke();
      return store.mutate(input, guard);
    },
  }));
  revoke = () => locked.setRole('reader');
  assert.equal((await locked.call('/target/api/flags/alpha/override', 'PUT', change)).status, 403);
  assert.equal(locked.writes(), 0);
});

test('reads reobserve authority after the store await and unknown roles do not become subsets', async (t) => {
  let revoke = () => {};
  const f = await fixture(t, (store) => ({
    ...store,
    read: async (...args) => {
      const value = await store.read(...args);
      revoke();
      return value;
    },
  }));
  revoke = () => f.setRole('manager');
  assert.equal((await f.call('/target/api/flags/alpha')).status, 403);
  f.setRole('reader,unknown');
  assert.deepEqual((await f.call('/target/api/flags')).body.items, []);
});

test('shutdown drains held bodies, rejects new requests and closes store only after accepted work settles', async (t) => {
  const f = await fixture(t),
    held = f.start('/target/api/flags/alpha/override', 'PUT');
  await new Promise<void>((resolve) => setImmediate(resolve));
  const closing = f.deployment.close();
  assert.equal(f.closed(), 0);
  assert.equal((await f.call('/target/api/flags')).status, 503);
  held.stream.end(JSON.stringify(change));
  await held.done;
  await closing;
  assert.notEqual(held.reply.status, 200);
  assert.equal(f.writes(), 0);
  assert.equal(f.closed(), 1);
});

test('CAS conflicts and unknown durable outcomes are distinct, sanitized and never retried', async (t) => {
  const f = await fixture(t);
  const stale = await f.call('/target/api/flags/alpha/override', 'PUT', { ...change, expectedRevision: 0 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.outcome, 'not_applied');
  assert.equal(f.writes(), 0);
  let attempts = 0;
  const unknown = await fixture(t, (store) => ({
    ...store,
    mutate: async () => {
      attempts++;
      throw new TransactionOutcomeUnknown(new Error('PRIVATE_SQL_PASSWORD'));
    },
  }));
  const result = await unknown.call('/target/api/flags/alpha/override', 'PUT', change);
  assert.equal(result.status, 503);
  assert.equal(result.body.outcome, 'unknown');
  assert.equal(attempts, 1);
  assert.equal(result.text.includes('PRIVATE_SQL_PASSWORD'), false);
  assert.equal(result.headers['retry-after'], undefined);
});

test('suite target grant is required independently of native login and is fenced across a held body', async (t) => {
  let granted = false,
    revision = 1;
  const f = await fixture(t, undefined, (target) => ({
    ...target,
    auth: createSuiteAppAuth(target.auth, {
      appId: 'target',
      spec: target.auth.spec,
      roles: catalog.roles,
      basePath: '/target',
      suiteBase: '',
      grant: () => ({ revision, roles: granted ? ['reader', 'manager'] : [] }),
    }),
  }));
  assert.equal((await f.call('/target/api/flags/alpha')).status, 401, 'native admission supplies no target grant');
  granted = true;
  revision++;
  assert.equal((await f.call('/target/api/flags/alpha')).status, 200);
  const held = f.start('/target/api/flags/alpha/override', 'PUT');
  await new Promise<void>((resolve) => setImmediate(resolve));
  granted = false;
  revision++;
  held.stream.end(JSON.stringify(change));
  await held.done;
  assert.notEqual(held.reply.status, 200);
  assert.equal(f.writes(), 0);
});

test('tenant selector requires fresh target membership; global scope requires separate platform membership', async (t) => {
  let member = true,
    current = true;
  const f = await fixture(
    t,
    (store) => ({
      ...store,
      read: async (selected) => normalizeFlagSnapshot({ ...selected, revision: 1, overrides: { alpha: { value: true } } }, catalog),
    }),
    (target) => ({
      ...target,
      tenantApp: true,
      roles: {
        reader: { ...roles.reader, realm: 'tenant' },
        manager: { ...roles.manager, realm: 'tenant' },
        oncall: { ...roles.oncall, realm: 'platform' },
      },
      observeMembership: (selected, accountId) =>
        !member
          ? null
          : {
              record:
                selected.tenantId === null
                  ? {
                      realm: 'platform',
                      appId: 'target',
                      accountId,
                      platformStatus: 'active',
                      platformVersion: '1',
                      membershipId: 'platform',
                      membershipVersion: '1',
                      status: 'active',
                      roles: ['oncall'],
                      validUntil: Date.now() + 60_000,
                    }
                  : {
                      appId: 'target',
                      accountId,
                      tenantId: 'one',
                      tenantStatus: 'active',
                      tenantVersion: '1',
                      membershipId: 'tenant',
                      membershipVersion: '1',
                      status: 'active',
                      roles: ['reader'],
                      validUntil: Date.now() + 60_000,
                    },
              assertCurrent() {
                if (!current) throw new Error('membership revoked');
              },
            },
    }),
  );
  assert.equal((await f.call('/target/api/flags/alpha?tenant=one')).status, 200);
  assert.equal((await f.call('/target/api/flags/alpha?tenant=two')).status, 403);
  assert.equal((await f.call('/target/api/flags/zebra?tenant=one')).status, 403);
  assert.equal((await f.call('/target/api/flags/alpha')).status, 403, 'native reader role does not fill platform membership powers');
  assert.deepEqual((await f.call('/target/api/flags/alpha/capabilities')).body.actions, ['kill']);
  member = false;
  assert.equal((await f.call('/target/api/flags/alpha?tenant=one')).status, 403);
  member = true;
  current = false;
  assert.equal((await f.call('/target/api/flags/alpha?tenant=one')).status, 403);
});

test('oversized bodies, native session revocation and target retirement cannot reach mutations', async (t) => {
  const f = await fixture(t);
  const tooLarge = await f.call('/target/api/flags/alpha/override', 'PUT', { ...change, reason: 'x'.repeat(70_000) });
  assert.equal(tooLarge.status, 413);
  assert.equal(f.writes(), 0);
  const held = f.start('/target/api/flags/alpha/override', 'PUT');
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.db.prepare('DELETE FROM session').run();
  held.stream.end(JSON.stringify(change));
  await held.done;
  assert.notEqual(held.reply.status, 200);
  assert.equal(f.writes(), 0);
  const retired = await fixture(t);
  retired.retireTarget();
  assert.notEqual((await retired.call('/target/api/flags/alpha/override', 'PUT', change)).status, 200);
  assert.equal(retired.writes(), 0);
});

test('acknowledged commits remain success; lost commit acknowledgements are unknown even when writes landed', async (t) => {
  let afterCommit = () => {};
  const f = await fixture(t, (store) => ({
    ...store,
    mutate: async (...args) => {
      const result = await store.mutate(...args);
      afterCommit();
      return result;
    },
  }));
  afterCommit = () => f.setRole('');
  const committed = await f.call('/target/api/flags/alpha/override', 'PUT', change);
  assert.equal(committed.status, 200);
  assert.equal(committed.body.revision, 2);
  assert.equal(f.writes(), 1);
  let attempts = 0;
  const uncertain = await fixture(t, (store) => ({
    ...store,
    mutate: async (...args) => {
      attempts++;
      await store.mutate(...args);
      throw new Error('PRIVATE lost connection after COMMIT');
    },
  }));
  const reply = await uncertain.call('/target/api/flags/alpha/override', 'PUT', change);
  assert.equal(reply.status, 503);
  assert.equal(reply.body.outcome, 'unknown');
  assert.equal(uncertain.writes(), 1);
  assert.equal(attempts, 1);
  assert.equal(reply.text.includes('PRIVATE'), false);
});
