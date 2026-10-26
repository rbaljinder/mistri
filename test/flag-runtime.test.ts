import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test, type TestContext } from 'node:test';
import { createAppAuth, captureAppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import { createFlagRequestRuntime, type FlagRequestLifetime } from '../packages/mistri/src/server/flags/requestRuntime.js';
import { captureAppFlagCatalog } from '../packages/mistri/src/server/flags/appCatalog.js';
import { createFlagDeployment } from '../packages/mistri/src/server/flags/deployment.js';
import { FlagRevisionConflict, type FlagStore, type FlagHistoryEntry } from '../packages/mistri/src/server/flags/store.js';
import { normalizeFlagSnapshot } from '../packages/mistri/src/shared/appFlags.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { openBusinessCommandCalls } from '../packages/mistri/src/server/commands/businessCommandHttp.js';
import { commandFlagEnabled } from '../packages/mistri/src/server/commands/commandFlags.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { registryJobBinding } from '../packages/mistri/src/server/jobs/jobHost.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { parseTestApp } from './support/commandCatalog.js';

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
function lifetime() {
  let active = true;
  return {
    generation: Object.freeze({}),
    assertCurrent() {
      if (!active) throw new Error('retired');
    },
    async current() {
      this.assertCurrent();
    },
    retire() {
      active = false;
    },
  } satisfies FlagRequestLifetime & { retire(): void };
}
async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-flag-runtime-')),
    secret = 'flag-runtime-test-secret-at-least-thirty-two-characters';
  const app = parseTestApp(
    {
      id: 'desk',
      name: 'Desk',
      sources: { data: { connection: 'business' } },
      resources: {
        item: { access: 'write', actions: { change: { label: 'Change', command: { id: 'change', target: 'item', input: {} } } } },
      },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
      flags: { enabled: { type: 'boolean', default: false, owner: 'team' } },
      auth: {
        store: 'auth.db',
        signUp: 'open',
        roles: {
          staff: {
            read: true,
            commands: ['change'],
            flags: [{ actions: ['view', 'manage'], environments: ['production'], owners: ['team'] }],
          },
        },
      },
    },
    'runtime',
  );
  const auth = await createAppAuth(
    { path: join(dir, 'app.ts'), dir, sources: {}, pages: [], app },
    { baseURL: 'http://localhost:4111', trustedOrigins: ['http://localhost:4111'], environment: { BETTER_AUTH_SECRET: secret } },
  );
  const db = new DatabaseSync(auth.store),
    now = new Date().toISOString();
  db.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES(?,?,?,?,?,?,?,?)').run(
    'subject',
    'Reader',
    'reader@example.test',
    1,
    now,
    now,
    'staff',
    0,
  );
  db.prepare('INSERT INTO session(id,token,userId,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)').run(
    'session',
    'token',
    'subject',
    new Date(Date.now() + 600_000).toISOString(),
    now,
    now,
  );
  const signature = createHmac('sha256', secret).update('token').digest('base64');
  const request = () =>
    ({
      method: 'GET',
      url: '/api/flags/evaluate?app=desk',
      aborted: false,
      headers: {
        host: 'localhost:4111',
        origin: 'http://localhost:4111',
        cookie: `mistri-desk.session_token=${encodeURIComponent(`token.${signature}`)}`,
      },
    }) as IncomingMessage;
  const graph = captureAppFlagCatalog(app),
    scope = { appId: 'desk', environment: 'production', tenantId: null };
  let snapshot = normalizeFlagSnapshot({ ...scope, revision: 0, overrides: {} }, graph.catalog),
    reads = 0;
  const history: FlagHistoryEntry[] = [];
  let wait: ReturnType<typeof gate> | undefined,
    entered = gate();
  const store: FlagStore = {
    binding: { suiteId: 'suite', deploymentId: 'deployment' },
    read: async () => snapshot,
    readRequestScopes: async () => {
      reads++;
      const pair = Object.freeze({ global: snapshot, tenant: null });
      entered.release();
      if (wait) await wait.promise;
      return pair;
    },
    history: async () => ({ entries: history, nextBeforeRevision: null }),
    async mutate(input, guard) {
      if (input.expectedRevision !== snapshot.revision) throw new FlagRevisionConflict();
      const before = snapshot;
      const after = normalizeFlagSnapshot(
        {
          ...snapshot,
          revision: snapshot.revision + 1,
          overrides: { enabled: input.operation === 'set' ? input.override : { disabled: true } },
        },
        graph.catalog,
      );
      await guard();
      snapshot = after;
      const entry: FlagHistoryEntry = {
        scope,
        revision: after.revision,
        flagId: 'enabled',
        operation: input.operation,
        actorId: input.actorId,
        reason: input.reason,
        at: now,
        before,
        after,
        revertRevision: null,
      };
      history.push(entry);
      return entry;
    },
    close: async () => {},
  };
  const deployment = await createFlagDeployment(
    {
      suiteId: 'suite',
      deploymentId: 'deployment',
      environment: 'production',
      storeUrl: 'postgresql://operator@control/flags',
      targets: [{ appId: 'desk', auth, catalog: graph.authorityCatalog, roles: graph.roles, tenantApp: false, assertCurrent() {} }],
    },
    store,
  );
  const target = deployment.target('desk');
  const runtime = createFlagRequestRuntime({ app, auth, environment: 'production', readPort: target.readPort, assertCurrent() {} });
  const proof = async (req: IncomingMessage) => {
    const p = await captureAppAuthRuntime(auth).sessionInstance(req);
    assert.ok(p);
    return p;
  };
  const change = async (value: boolean) => {
    await target.withRequest(
      request(),
      'subject',
      () => {},
      (session) =>
        session.change({
          operation: 'set',
          flagId: 'enabled',
          tenantId: null,
          expectedRevision: snapshot.revision,
          reason: 'Test release',
          override: { value },
        }),
    );
  };
  t.after(async () => {
    await deployment.close();
    auth.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    app,
    auth,
    db,
    dir,
    request,
    proof,
    runtime,
    target,
    change,
    reads: () => reads,
    history,
    hold() {
      wait = gate();
      entered = gate();
      return { release: wait.release, entered: entered.promise };
    },
  };
}

test('the live deployment control port supplies one memoized pair to values and commands; next request sees a management change', async (t) => {
  const f = await fixture(t),
    req = f.request(),
    proof = await f.proof(req),
    owner = lifetime();
  await f.change(true);
  const first = f.runtime.native(req, proof, owner),
    second = f.runtime.native(req, proof, owner);
  assert.equal(first, second);
  const capture = await first;
  const retained = capture.commandFlags;
  assert.equal(capture.commandFlags.get('enabled'), true);
  assert.equal(f.reads(), 1);
  await f.change(false);
  await capture.current();
  assert.equal(capture.evaluation.evaluate('enabled').value, true);
  assert.equal(commandFlagEnabled({ enabledBy: { flag: 'enabled', is: true } }, capture.commandFlags), true);
  assert.equal(f.reads(), 1);
  assert.equal(f.history.length, 2);
  const next = f.request(),
    newer = await f.runtime.native(next, await f.proof(next), lifetime());
  assert.equal(newer.commandFlags.get('enabled'), false);
  assert.equal(f.reads(), 2);
  owner.retire();
  assert.throws(() => capture.commandFlags);
  assert.throws(() => capture.evaluation.evaluate('enabled'));
  assert.throws(() => retained.get('enabled'));
});

test('grant revocation, request mutation and generation replacement discard awaited captures without turning denial into defaults', async (t) => {
  for (const mode of ['grant', 'cookie', 'retire'] as const) {
    const f = await fixture(t),
      req = f.request(),
      proof = await f.proof(req),
      owner = lifetime(),
      held = f.hold();
    const pending = f.runtime.native(req, proof, owner);
    await held.entered;
    if (mode === 'grant') f.db.prepare('UPDATE user SET role=? WHERE id=?').run('', 'subject');
    else if (mode === 'cookie') req.headers.cookie = 'another-session';
    else owner.retire();
    held.release();
    await assert.rejects(pending);
  }
  const f = await fixture(t),
    req = f.request(),
    proof = await f.proof(req);
  const first = await f.runtime.native(req, proof, lifetime());
  const second = await f.runtime.native(req, proof, lifetime());
  assert.throws(() => first.evaluation.evaluate('enabled'));
  assert.equal(second.commandFlags.get('enabled'), false);
  f.db.prepare('UPDATE user SET role=? WHERE id=?').run('', 'subject');
  await assert.rejects(second.current());
  assert.throws(() => second.commandFlags);
  assert.throws(() => second.evaluation.evaluate('enabled'));
});

test('an unavailable configured provider uses declared diagnostic defaults, but structural auth never admits', async (t) => {
  const f = await fixture(t),
    req = f.request(),
    proof = await f.proof(req);
  const runtime = createFlagRequestRuntime({ app: f.app, auth: f.auth, environment: 'production', assertCurrent() {} });
  const capture = await runtime.native(req, proof, lifetime());
  assert.equal(capture.commandFlags.get('enabled'), false);
  assert.deepEqual(capture.evaluation.evaluate('enabled').diagnostics, ['provider_error']);
  assert.throws(() => runtime.native(req, { ...proof }, lifetime()));
  assert.throws(() => createFlagRequestRuntime({ app: f.app, auth: { ...f.auth }, environment: 'production', assertCurrent() {} }));
  await assert.rejects(capture.captureFlags({ id: 'subject', appId: 'desk', roles: ['admin'] }));
});

test('a trusted service attempt memoizes independently of HTTP and the next attempt observes new controls', async (t) => {
  const f = await fixture(t),
    attempt = {},
    owner = lifetime();
  const admission = {
    ...owner,
    actor: { id: 'service:notify', appId: 'desk', kind: 'service' as const, roles: ['staff'] },
    realm: 'app' as const,
    tenantId: null,
  };
  await f.change(true);
  const first = f.runtime.attempt(attempt, admission);
  assert.equal(first, f.runtime.attempt(attempt, admission));
  const capture = await first;
  await f.change(false);
  assert.equal((await capture.captureFlags(admission.actor)).get('enabled'), true);
  assert.equal(f.reads(), 1);
  const next = await f.runtime.attempt({}, { ...admission, generation: {} });
  assert.equal(next.commandFlags.get('enabled'), false);
  assert.equal(f.reads(), 2);
  owner.retire();
  assert.throws(() => capture.commandFlags);
  assert.throws(() => f.runtime.attempt({}, { ...admission, generation: {}, realm: 'tenant', tenantId: 'north' }));
});

test('public captures ignore staff cookies and require a declared public grant; HTTP serializes no proof or catalog metadata', async (t) => {
  const f = await fixture(t),
    req = f.request();
  assert.throws(() => f.runtime.public(req, lifetime()));
  const app = { ...f.app, auth: { ...f.app.auth!, public: { read: ['item'] } } };
  const runtime = createFlagRequestRuntime({ app, environment: 'production', readPort: f.target.readPort, assertCurrent() {} });
  const owner = lifetime(),
    capture = await runtime.public(req, owner);
  assert.equal(capture.publicContext, true);
  const reader = await capture.captureFlags({ kind: 'public', id: 'public:form', form: 'form', appId: 'desk', roles: [] });
  assert.equal(reader.get('enabled'), false);
  await assert.rejects(capture.captureFlags({ id: 'subject', appId: 'desk', roles: ['staff'] }));
  const handler = runtime.valuesHttp({
    bound: { host: '127.0.0.1', port: 4111 },
    async withRequest(request, _res, guard, use) {
      guard();
      await use(await runtime.public(request, owner));
    },
  });
  const response = {
    status: 0,
    body: '',
    destroyed: false,
    writableEnded: false,
    setHeader() {},
    writeHead(status: number) {
      this.status = status;
    },
    end(body: string) {
      this.body = body;
      this.writableEnded = true;
    },
  };
  assert.equal(await handler(req, response as unknown as ServerResponse), true);
  assert.equal(response.status, 200);
  assert.equal(f.reads(), 1);
  assert.deepEqual(Object.keys(JSON.parse(response.body)).sort(), ['values', 'version']);
  assert.doesNotMatch(response.body, /subject|session|staff|team|cookie|scope|roles/);
});

test('real prepare/execution reuse the admitted capture while a management update commits during the handler await', async (t) => {
  const f = await fixture(t),
    path = join(f.dir, 'business.db'),
    db = new DatabaseSync(path),
    registry = new Registry();
  db.exec('CREATE TABLE item(id INTEGER PRIMARY KEY, version INTEGER NOT NULL, note TEXT); INSERT INTO item VALUES(1,0,NULL)');
  migrateSqliteCommandJournal(path);
  registry.add({ id: 'business', name: 'Business', url: path, writable: true, source: 'config' });
  t.after(async () => {
    await registry.closeAll();
    db.close();
  });
  const held = gate(),
    entered = gate();
  const commands = defineCommands({
    change: defineCommand({
      source: 'data',
      target: 'item',
      enabledBy: { flag: 'enabled', is: true },
      initial({ flags }) {
        assert.equal(flags.get('enabled'), true);
        return {};
      },
      async handle({ flags, db, record }) {
        entered.release();
        await held.promise;
        assert.equal(flags.get('enabled'), true);
        await db.item.update(record, { note: 'changed' });
      },
    }),
  });
  await f.change(true);
  const req = f.request(),
    capture = await f.runtime.native(req, await f.proof(req), lifetime());
  const calls = await openBusinessCommandCalls({
    registry,
    app: f.app,
    commands,
    connection: 'business',
    actor: { id: 'subject', appId: 'desk', roles: ['staff'] },
    signal: new AbortController().signal,
    captureFlags: capture.captureFlags,
  });
  try {
    await calls.prepare({ command: 'change', commandVersion: 1, key: { id: 1 } });
    const execution = calls.execute({
      command: 'change',
      commandVersion: 1,
      key: { id: 1 },
      expectedVersion: 0,
      input: {},
      idempotencyKey: 'runtime-command-0001',
    });
    await entered.promise;
    await f.change(false);
    held.release();
    await execution;
    assert.equal(f.reads(), 1);
    assert.equal(db.prepare('SELECT note FROM item').get()?.note, 'changed');
  } finally {
    calls.release();
  }
});

test('registry job composition binds configured values to one attempt and revokes retained readers on release', async (t) => {
  const f = await fixture(t),
    path = join(f.dir, 'business.db'),
    db = new DatabaseSync(path),
    registry = new Registry();
  db.exec('CREATE TABLE item(id INTEGER PRIMARY KEY, version INTEGER NOT NULL, note TEXT)');
  db.close();
  migrateSqliteCommandJournal(path);
  registry.add({ id: 'business', name: 'Business', url: path, writable: true, source: 'config' });
  t.after(() => registry.closeAll());
  const commands = defineCommands({
    change: defineCommand({ source: 'data', target: 'item', enabledBy: { flag: 'enabled', is: true }, handle() {} }),
  });
  const bind = registryJobBinding({ registry, app: () => f.app, owner: 'business', commands, flagRuntime: () => f.runtime });
  const actor = { id: 'service:notify', appId: 'desk', roles: ['staff'], kind: 'service' as const };
  await f.change(true);
  const first = await bind();
  try {
    const reader = await first.captureFlags!(actor);
    assert.ok(reader);
    assert.equal(reader.get('enabled'), true);
    await f.change(false);
    assert.equal(await first.captureFlags!(actor), reader);
    assert.equal(f.reads(), 1);
    first.release();
    assert.throws(() => reader.get('enabled'));
  } finally {
    first.release();
  }
  const next = await bind();
  try {
    assert.equal((await next.captureFlags!(actor))!.get('enabled'), false);
    assert.equal(f.reads(), 2);
  } finally {
    next.release();
  }
});
