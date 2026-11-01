/**
 * The administrator's accounts screen, through a real Better Auth instance:
 * `/api/accounts` lists and changes accounts for an account holding `admin`
 * and for nobody else, whatever a body says; it hands out only the App's
 * roles, never lets an administrator lock themself out, ends a deactivated
 * account's sessions, and leaves a row of the trail in the auth store (in
 * the change's own transaction) and a line in the log for every change.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from './support/createApp.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadApp, type AppHost } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { provisionSqliteApiTokenStore } from '../packages/mistri/src/server/auth/provisionSqliteApiTokenStore.js';
import { captureAuthStoreExclusion } from '../packages/mistri/src/server/auth/sqliteStoreIdentity.js';
import { accountCredentials } from './support/accountCredentials.js';
import { makeDemoDatabase, seedDemoDatabase } from './make-demo-db.js';

process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-thirty-two-characters-long';
process.env.MISTRI_AUTH_ADMIN_EMAIL = 'root@example.org';
process.env.MISTRI_AUTH_ADMIN_PASSWORD = 'root-password-1';

describe('the accounts screen', () => {
  let tmp: string;
  let server: Server;
  let origin = '';
  let host: AppHost;
  const logged: string[] = [];
  const log = console.log;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'tablewalk-accounts-'));
    const db = join(tmp, 'app.db');
    makeDemoDatabase(db);
    seedDemoDatabase(db, { scale: 1 });
    const dir = join(tmp, 'accounts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify({
        id: 'desk',
        name: 'Desk',
        resources: { work_order: { access: 'write' }, customer: {} },
        auth: {
          store: join(tmp, 'auth.db'),
          defaultRole: 'agent',
          roles: { agent: { read: true, write: ['work_order'] }, manager: { read: true, write: true }, admin: { read: true, write: true } },
        },
        views: { 'work-orders': { kind: 'list', from: 'work_order' } },
        home: 'work-orders',
        nav: ['work-orders'],
      }),
    );
    const loaded = await loadApp(dir);
    const registry = new Registry();
    registry.add({ name: 'rw', url: db, writable: true, source: 'config' });
    registry.setActive('rw');
    await registry.open('rw');
    host = { app: loaded, pages: [] };
    server = createApp({ registry, apps: [host], bound: { host: '127.0.0.1', port: 0 } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    // The auth file first, then its API token store beside the accounts, then the server on both.
    (await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin] })).close();
    provisionSqliteApiTokenStore(join(tmp, 'auth.db'), {
      appId: 'desk',
      storeId: randomUUID(),
      exclusions: [captureAuthStoreExclusion(db)],
    });
    host.auth = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin] });
    console.log = (...args: unknown[]) => {
      logged.push(args.join(' '));
    };
  });
  after(() => {
    console.log = log;
    server?.close();
    server?.closeAllConnections();
    host.auth?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const call = async (path: string, init: RequestInit & { cookie?: string; origin?: string } = {}) => {
    const headers: Record<string, string> = { origin: init.origin ?? origin, ...((init.headers as Record<string, string>) ?? {}) };
    if (init.cookie) headers.cookie = init.cookie;
    if (init.body) headers['content-type'] = 'application/json';
    const res = await fetch(`${origin}${path}`, { ...init, headers });
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
      cookie: res.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; '),
    };
  };
  const signIn = async (email: string, password: string) =>
    call('/api/auth/sign-in/email', { method: 'POST', body: JSON.stringify({ email, password }) });
  const change = (cookie: string, body: Record<string, unknown>, init: { origin?: string } = {}) =>
    call('/api/accounts', { method: 'POST', cookie, body: JSON.stringify({ app: 'desk', ...body }), ...init });
  const stored = (email: string) => {
    const store = new DatabaseSync(host.auth!.store, { readOnly: true });
    try {
      return store.prepare('SELECT id, role, banned, banReason FROM user WHERE email = ?').get(email);
    } finally {
      store.close();
    }
  };

  test('an administrator lists, adds, assigns, deactivates and reactivates', async () => {
    const root = (await signIn('root@example.org', 'root-password-1')).cookie;
    assert.equal((await call('/api/whoami', { cookie: root })).json.accountAdministration, true);
    const listed = await call('/api/accounts?app=desk', { cookie: root });
    assert.equal(listed.status, 200, listed.text);
    assert.deepEqual(listed.json.roles, ['agent', 'manager', 'admin']);
    assert.equal(listed.json.passwords, true);
    const first = (listed.json.accounts as Array<Record<string, unknown>>)[0];
    assert.deepEqual(Object.keys(first).sort(), ['active', 'createdAt', 'email', 'id', 'name', 'roles']);
    assert.deepEqual(first.roles, ['admin']);

    const made = await change(root, {
      operation: 'create',
      email: 'Pat@Example.org',
      name: 'Pat Lee',
      roles: ['agent'],
      password: 'pat-password-1',
    });
    assert.equal(made.status, 200, made.text);
    const pat = made.json.account as { id: string; email: string; roles: string[] };
    assert.deepEqual([pat.email, pat.roles], ['pat@example.org', ['agent']]);
    assert.equal(
      (await change(root, { operation: 'create', email: 'pat@example.org', name: 'Pat', roles: ['agent'], password: 'pat-password-1' }))
        .status,
      409,
    );
    // Only this App's roles are handed out, and at least one.
    assert.equal((await change(root, { operation: 'setRoles', accountId: pat.id, roles: ['superuser'] })).status, 400);
    assert.equal((await change(root, { operation: 'setRoles', accountId: pat.id, roles: [] })).status, 400);
    assert.equal(
      (await change(root, { operation: 'create', email: 'x@example.org', name: 'X', roles: ['agent'], password: 'short' })).status,
      400,
    );
    const promoted = await change(root, { operation: 'setRoles', accountId: pat.id, roles: ['agent', 'manager'] });
    assert.equal(promoted.status, 200, promoted.text);
    assert.equal(stored('pat@example.org')!.role, 'agent,manager');

    // The account signs in with what it was given, and holds what it was assigned.
    const patCookie = (await signIn('pat@example.org', 'pat-password-1')).cookie;
    assert.ok(patCookie);
    assert.equal((await call('/api/schema', { cookie: patCookie })).status, 200);

    // Deactivated: its session ends, it cannot sign in, and the store says who did it.
    const madeBefore = accountCredentials(host.auth!.store, 'desk', pat.id);
    assert.equal((await change(root, { operation: 'deactivate', accountId: pat.id })).status, 200);
    // Its tokens and grants are revoked, so a reactivation brings none of them back.
    assert.deepEqual(madeBefore(), { token: true, grant: true });
    assert.equal((await call('/api/schema', { cookie: patCookie })).status, 401);
    assert.notEqual((await signIn('pat@example.org', 'pat-password-1')).status, 200);
    assert.equal(stored('pat@example.org')!.banReason, 'Deactivated by root@example.org');
    assert.equal((await change(root, { operation: 'reactivate', accountId: pat.id })).status, 200);
    assert.equal((await signIn('pat@example.org', 'pat-password-1')).status, 200);

    // A new password, set by the administrator, ends the old sessions.
    const before = (await signIn('pat@example.org', 'pat-password-1')).cookie;
    const heldBefore = accountCredentials(host.auth!.store, 'desk', pat.id);
    assert.equal((await change(root, { operation: 'setPassword', accountId: pat.id, password: 'pat-password-2' })).status, 200);
    assert.deepEqual(heldBefore(), { token: true, grant: true }, 'and the tokens and grants made under the old one');
    assert.equal((await call('/api/schema', { cookie: before })).status, 401);
    assert.equal((await signIn('pat@example.org', 'pat-password-2')).status, 200);

    // Every change is a line in the log, naming who changed whom.
    for (const line of [
      'created pat@example.org with agent',
      'set the roles of pat@example.org to agent, manager (were agent)',
      'deactivated pat@example.org',
      'reactivated pat@example.org',
      'set a new password for pat@example.org',
    ]) {
      assert.ok(
        logged.some((entry) => entry === `mistri: accounts: root@example.org ${line}`),
        line,
      );
    }
    assert.equal(
      logged.some((entry) => entry.includes('pat-password')),
      false,
      'a password never reaches the log',
    );
  });

  test('an administrator cannot lock themself out', async () => {
    const root = (await signIn('root@example.org', 'root-password-1')).cookie;
    const me = String((await call('/api/whoami', { cookie: root })).json.accountId);
    const demoted = await change(root, { operation: 'setRoles', accountId: me, roles: ['manager'] });
    assert.equal(demoted.status, 409);
    assert.match(String(demoted.json.error), /cannot remove your own administrator role/);
    assert.equal((await change(root, { operation: 'deactivate', accountId: me })).status, 409);
    assert.equal(stored('root@example.org')!.role, 'admin');
  });

  test('an administrator can demote or deactivate another while an active one remains', async () => {
    const root = (await signIn('root@example.org', 'root-password-1')).cookie;
    const second = await change(root, {
      operation: 'create',
      email: 'second@example.org',
      name: 'Second',
      roles: ['admin'],
      password: 'second-password-1',
    });
    assert.equal(second.status, 200, second.text);
    const third = await change(root, {
      operation: 'create',
      email: 'third@example.org',
      name: 'Third',
      roles: ['admin', 'agent'],
      password: 'third-password-1',
    });
    const secondId = (second.json.account as { id: string }).id;
    const thirdId = (third.json.account as { id: string }).id;
    assert.equal((await change(root, { operation: 'setRoles', accountId: secondId, roles: ['manager'] })).status, 200);
    assert.equal(stored('second@example.org')!.role, 'manager');
    assert.equal((await change(root, { operation: 'deactivate', accountId: thirdId })).status, 200);
    assert.equal(stored('third@example.org')!.banned, 1);
  });

  test('nobody else reaches it, whatever the request says', async () => {
    const root = (await signIn('root@example.org', 'root-password-1')).cookie;
    await change(root, { operation: 'create', email: 'mo@example.org', name: 'Mo', roles: ['manager'], password: 'mo-password-1' });
    const mo = (await signIn('mo@example.org', 'mo-password-1')).cookie;
    assert.equal((await call('/api/whoami', { cookie: mo })).json.accountAdministration, undefined);
    assert.equal((await call('/api/accounts?app=desk', { cookie: mo })).status, 403);
    // A forged role or actor in the body is not the session's.
    const forged = await change(mo, {
      operation: 'setRoles',
      accountId: String(stored('mo@example.org')!.id),
      roles: ['admin'],
      role: 'admin',
    } as never);
    assert.ok([400, 403].includes(forged.status), forged.text);
    assert.equal(
      (await change(mo, { operation: 'setRoles', accountId: String(stored('mo@example.org')!.id), roles: ['admin'] })).status,
      403,
    );
    assert.equal(stored('mo@example.org')!.role, 'manager');
    // Signed out, the door; from another origin, the cross-origin refusal; naming another App, refused.
    assert.equal((await call('/api/accounts?app=desk')).status, 401);
    assert.equal((await change(root, { operation: 'deactivate', accountId: 'x' }, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await change(root, { app: 'other', operation: 'deactivate', accountId: 'x' })).status, 400);
    assert.equal((await change(root, { operation: 'deactivate', accountId: 'no-such-account' })).status, 404);
    assert.equal((await change(root, { operation: 'impersonate', accountId: 'x' })).status, 400);
  });

  test("Better Auth's own doors that change an account, or sign in as one, are closed even to an administrator", async () => {
    const root = (await signIn('root@example.org', 'root-password-1')).cookie;
    await change(root, { operation: 'create', email: 'jo@example.org', name: 'Jo', roles: ['manager'], password: 'jo-password-1' });
    const jo = String(stored('jo@example.org')!.id);
    for (const path of [
      '/api/auth/admin/set-role',
      '/api/auth/admin/ban-user',
      '/api/auth/admin/unban-user',
      '/api/auth/admin/set-user-password',
      '/api/auth/admin/update-user',
      '/api/auth/admin/remove-user',
      '/api/auth/admin/impersonate-user',
      '/api/auth/%61dmin/set-role',
      '/api/auth//admin/IMPERSONATE-USER',
      '/api/auth/admin/ban-user/',
    ]) {
      const body = JSON.stringify({ userId: jo, role: 'admin', newPassword: 'taken-over-1', data: { role: 'admin' } });
      assert.equal((await call(path, { method: 'POST', cookie: root, body })).status, 404, path);
    }
    assert.equal(stored('jo@example.org')!.role, 'manager');
    assert.equal(stored('jo@example.org')!.banned, 0);
    assert.equal((await signIn('jo@example.org', 'jo-password-1')).status, 200);
    // The accounts screen in front of them still makes every change.
    assert.equal((await change(root, { operation: 'setRoles', accountId: jo, roles: ['admin'] })).status, 200);
    assert.equal((await change(root, { operation: 'deactivate', accountId: jo })).status, 200);
    assert.equal(stored('jo@example.org')!.banned, 1);
  });

  const trail = (store = host.auth!.store) => {
    const db = new DatabaseSync(store, { readOnly: true });
    try {
      return db.prepare('SELECT * FROM "accountAudit" ORDER BY createdAt').all() as Record<string, unknown>[];
    } finally {
      db.close();
    }
  };

  test('every change is a row of the trail, in the store, and the trail is read through the screen', async () => {
    const root = (await signIn('root@example.org', 'root-password-1')).cookie;
    const rootId = String((await call('/api/whoami', { cookie: root })).json.accountId);
    const made = await change(root, {
      operation: 'create',
      email: 'ada@example.org',
      name: 'Ada',
      roles: ['agent'],
      password: 'ada-password-1',
    });
    const ada = (made.json.account as { id: string }).id;
    await change(root, { operation: 'setRoles', accountId: ada, roles: ['manager'] });
    await change(root, { operation: 'deactivate', accountId: ada });
    await change(root, { operation: 'reactivate', accountId: ada });
    await change(root, { operation: 'setPassword', accountId: ada, password: 'ada-password-2' });
    // A refused change leaves no row.
    assert.equal((await change(root, { operation: 'setRoles', accountId: ada, roles: ['superuser'] })).status, 400);

    const rows = trail().filter((row) => row.targetId === ada);
    assert.deepEqual(
      rows.map((row) => row.action),
      ['create', 'setRoles', 'deactivate', 'reactivate', 'setPassword'],
    );
    for (const row of rows) {
      assert.deepEqual(
        [row.actorId, row.actorEmail, row.principal, row.targetEmail],
        [rootId, 'root@example.org', 'session', 'ada@example.org'],
      );
      assert.ok(!Number.isNaN(Date.parse(String(row.createdAt))));
    }
    assert.deepEqual(
      rows.map((row) => [
        row.before === null ? null : JSON.parse(String(row.before)),
        row.after === null ? null : JSON.parse(String(row.after)),
      ]),
      [
        [null, { email: 'ada@example.org', name: 'Ada', roles: ['agent'], active: true }],
        [{ roles: ['agent'] }, { roles: ['manager'] }],
        [{ active: true }, { active: false }],
        [{ active: false }, { active: true }],
        [null, { password: 'changed', sessionsEnded: true }],
      ],
    );

    const page = await call('/api/accounts?app=desk&trail=1', { cookie: root });
    assert.equal(page.status, 200, page.text);
    const entries = page.json.entries as Array<Record<string, unknown>>;
    assert.equal(page.json.total, trail().length);
    assert.equal(entries[0].action, 'setPassword', 'newest first');
    assert.deepEqual(Object.keys(entries[0]).sort(), [
      'action',
      'actorEmail',
      'actorId',
      'after',
      'at',
      'before',
      'id',
      'principal',
      'targetEmail',
      'targetId',
    ]);
    const one = await call(`/api/accounts?app=desk&trail=1&account=${encodeURIComponent(ada)}`, { cookie: root });
    assert.deepEqual(
      (one.json.entries as Array<{ targetId: string }>).map((entry) => entry.targetId),
      Array(5).fill(ada),
    );
    assert.equal(one.json.total, 5);
  });

  test('no row holds a password, a hash, a session token or the signing secret', () => {
    const store = new DatabaseSync(host.auth!.store, { readOnly: true });
    const secrets = [process.env.BETTER_AUTH_SECRET!, 'root-password-1'];
    try {
      for (const row of store.prepare('SELECT token FROM session').all()) secrets.push(String(row.token));
      for (const row of store.prepare('SELECT password FROM account WHERE password IS NOT NULL').all()) secrets.push(String(row.password));
    } finally {
      store.close();
    }
    const rows = trail();
    assert.ok(rows.length >= 5);
    const text = JSON.stringify(rows);
    for (const secret of secrets) assert.equal(text.includes(secret), false);
    assert.equal(/-password-\d/.test(text), false, 'no password given to the screen is in the trail');
  });

  test('the trail is append-only, and a change whose row cannot be written is not made', async () => {
    const root = (await signIn('root@example.org', 'root-password-1')).cookie;
    const made = await change(root, {
      operation: 'create',
      email: 'lee@example.org',
      name: 'Lee',
      roles: ['agent'],
      password: 'lee-password-1',
    });
    const lee = (made.json.account as { id: string }).id;
    const count = trail().length;
    const store = new DatabaseSync(host.auth!.store);
    try {
      assert.throws(() => store.exec('UPDATE "accountAudit" SET action = \'x\''), /append-only/);
      assert.throws(() => store.exec('DELETE FROM "accountAudit"'), /append-only/);
      // The row's insert fails from here on: the role change it would record must not survive it.
      store.exec('CREATE TRIGGER audit_refused BEFORE INSERT ON "accountAudit" BEGIN SELECT RAISE(ABORT, \'refused\'); END');
      const refused = await change(root, { operation: 'setRoles', accountId: lee, roles: ['manager'] });
      assert.equal(refused.status, 503, refused.text);
      assert.equal(refused.json.outcome, 'unknown');
      assert.equal(stored('lee@example.org')!.role, 'agent');
      assert.equal((await change(root, { operation: 'deactivate', accountId: lee })).status, 503);
      assert.equal(stored('lee@example.org')!.banned, 0);
      assert.equal(
        (await change(root, { operation: 'create', email: 'kit@example.org', name: 'Kit', roles: ['agent'], password: 'kit-password-1' }))
          .status,
        503,
      );
      assert.equal(stored('kit@example.org'), undefined);
      const held = (await signIn('lee@example.org', 'lee-password-1')).cookie;
      assert.equal((await change(root, { operation: 'setPassword', accountId: lee, password: 'lee-password-2' })).status, 503);
      assert.equal((await call('/api/schema', { cookie: held })).status, 200, 'the sessions it would have ended are still there');
      store.exec('DROP TRIGGER audit_refused');
      assert.equal((await signIn('lee@example.org', 'lee-password-1')).status, 200, 'and the old password still signs in');
      assert.equal(
        logged.some((entry) => entry.includes('lee@example.org to manager') || entry.includes('created kit@')),
        false,
      );
    } finally {
      store.exec('DROP TRIGGER IF EXISTS audit_refused');
      store.close();
    }
    assert.equal(trail().length, count);
    assert.equal((await change(root, { operation: 'setRoles', accountId: lee, roles: ['manager'] })).status, 200);
    assert.equal(stored('lee@example.org')!.role, 'manager');
  });

  test('only an administrator reads the trail', async () => {
    const root = (await signIn('root@example.org', 'root-password-1')).cookie;
    await change(root, { operation: 'create', email: 'sam@example.org', name: 'Sam', roles: ['manager'], password: 'sam-password-1' });
    const sam = (await signIn('sam@example.org', 'sam-password-1')).cookie;
    assert.equal((await call('/api/accounts?app=desk&trail=1', { cookie: sam })).status, 403);
    assert.equal((await call('/api/accounts?app=desk&trail=1')).status, 401);
    assert.equal((await call('/api/accounts?app=other&trail=1', { cookie: root })).status, 400);
  });
});
