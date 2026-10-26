/**
 * An app that signs people in, end to end through a real Better Auth
 * instance: the store in a temp SQLite, the routes mounted under /api/auth,
 * the gate on everything else, the identity in the journal and the role in
 * the write scope. Nothing is mocked; the package is what ships.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from './support/createApp.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadApp, type AppHost } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { makeDemoDatabase, seedDemoDatabase } from './make-demo-db.js';

process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-thirty-two-characters-long';
process.env.MISTRI_AUTH_ADMIN_EMAIL = 'admin@example.org';
process.env.MISTRI_AUTH_ADMIN_PASSWORD = 'admin-password-1';

describe('an app that signs people in', () => {
  let tmp: string;
  let server: Server;
  let origin = '';
  let host: AppHost;

  const serve = async (auth: Record<string, unknown>): Promise<void> => {
    const db = join(tmp, 'app.db');
    makeDemoDatabase(db);
    seedDemoDatabase(db, { scale: 3 });
    const dir = join(tmp, 'secured');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify({
        name: 'Secured',
        // Signed in, a role grants within the ceilings: the two tables the roles write.
        resources: { work_order: { access: 'write' }, customer: { access: 'write' } },
        auth: { ...auth, store: join(tmp, 'auth.db') },
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
    host.auth = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin] });
  };

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'tablewalk-auth-'));
    await serve({
      providers: ['email'],
      signUp: 'open',
      roles: { user: { read: true, write: ['work_order'] }, admin: { read: true, write: true } },
    });
  });
  after(() => {
    server?.close();
    server?.closeAllConnections();
    host.auth?.close();
    assert.doesNotThrow(() => host.auth?.close(), 'auth store cleanup is idempotent');
    rmSync(tmp, { recursive: true, force: true });
  });

  const call = async (path: string, init: RequestInit & { cookie?: string } = {}) => {
    const headers: Record<string, string> = { origin, ...((init.headers as Record<string, string>) ?? {}) };
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

  const storedRole = (accountId: unknown) => {
    assert.equal(typeof accountId, 'string');
    const store = new DatabaseSync(host.auth!.store, { readOnly: true });
    try {
      return store.prepare('SELECT role FROM user WHERE id = ?').get(accountId as string)?.role;
    } finally {
      store.close();
    }
  };

  test('signed out, the API is a door with the sign-in screen described on it', async () => {
    const res = await call('/api/schema');
    assert.equal(res.status, 401);
    // `look` travels with the door so the sign-in screen is drawn in the
    // App's own colours; it says nothing about the App's content.
    assert.deepEqual(res.json.signIn, { app: 'Secured', providers: ['email'], signUp: 'open', look: { id: 'secured', name: 'Secured' } });
    const me = await call('/api/whoami');
    assert.equal(me.status, 200);
    assert.equal(me.json.who, null);
    assert.ok(me.json.signIn, 'whoami still answers, with what to draw');
    assert.equal(Object.hasOwn(me.json, 'accountProfile'), false);
    // Static files are served: the sign-in screen is one of them.
    assert.equal((await call('/')).status, 200);
  });

  test('server-only session instances distinguish same-account logins and observe revocation without exposing tokens', async () => {
    const binding = host.auth!.sessionInstance!;
    const request = (cookie = '') => ({ headers: { cookie } }) as IncomingMessage;
    assert.equal(await binding(request()), null);
    const body = JSON.stringify({ name: 'Context User', email: 'context@example.org', password: 'context-password-1' });
    const first = await call('/api/auth/sign-up/email', { method: 'POST', body });
    assert.equal(first.status, 200);
    const a = await binding(request(first.cookie));
    assert.ok(a && Object.isFrozen(a) && Object.isFrozen(a.identity));
    assert.deepEqual(Object.keys(a).sort(), ['expiresAt', 'identity', 'sessionId']);
    assert.ok(a.expiresAt > Date.now());
    assert.equal(first.cookie.includes(a.sessionId), false);
    assert.equal((await binding(request(first.cookie)))!.sessionId, a.sessionId);
    const second = await call('/api/auth/sign-in/email', { method: 'POST', body });
    assert.equal(second.status, 200);
    const b = await binding(request(second.cookie));
    assert.ok(b);
    assert.equal(b.identity.id, a.identity.id);
    assert.notEqual(b.sessionId, a.sessionId);
    const store = new DatabaseSync(host.auth!.store);
    try {
      store.prepare('DELETE FROM session WHERE id = ?').run(a.sessionId);
    } finally {
      store.close();
    }
    assert.equal(await binding(request(first.cookie)), null);
    assert.equal((await binding(request(second.cookie)))!.sessionId, b.sessionId);
    await call('/api/auth/sign-out', { method: 'POST', cookie: second.cookie });
    assert.equal(await binding(request(second.cookie)), null);
  });

  test('sign up opens the door; authenticated App writes have no Workbench Undo', async () => {
    const up = await call('/api/auth/sign-up/email', {
      method: 'POST',
      body: JSON.stringify({ name: 'Ada', email: 'ada@example.org', password: 'ada-password-1' }),
    });
    assert.equal(up.status, 200, up.text);
    // Named for the App (auth.ts), so another App on the host never reads it.
    assert.match(up.cookie, /mistri-[A-Za-z0-9_-]+\.session_token=/, 'a session cookie came back, named for the App');
    const cookie = up.cookie;
    const me = await call('/api/whoami', { cookie });
    assert.equal(me.json.who, 'ada@example.org');
    assert.equal(me.json.accountProfile, true);
    assert.equal(me.json.role, undefined);
    assert.equal(storedRole(me.json.accountId), 'user');
    assert.equal((await call('/api/schema', { cookie })).status, 200);
    // App writes succeed without exposing the Workbench's Undo journal.
    const wrote = await call('/api/update', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ table: 'work_order', key: { id: 1 }, values: { status: 'open' } }),
    });
    assert.equal(wrote.status, 200, wrote.text);
    const listed = await call('/api/revert', { method: 'POST', cookie, body: '{}' });
    assert.equal(listed.status, 404, listed.text);
  });

  test('a role carries its own write scope, and a reader cannot touch the connections', async () => {
    const ada = (
      await call('/api/auth/sign-in/email', {
        method: 'POST',
        body: JSON.stringify({ email: 'ada@example.org', password: 'ada-password-1' }),
      })
    ).cookie;
    const out = await call('/api/update', {
      method: 'POST',
      cookie: ada,
      body: JSON.stringify({ table: 'customer', key: { id: 1 }, values: { name: 'x' } }),
    });
    assert.equal(out.status, 403);
    // The role's grant is the access policy: a write outside it is the guard's plain denial.
    assert.match(String(out.json.error), /Access to this resource is denied\./);
    const conn = await call('/api/connections/update', {
      method: 'POST',
      cookie: ada,
      body: JSON.stringify({ id: 'rw', name: 'renamed' }),
    });
    assert.equal(conn.status, 403);
    assert.match(String(conn.json.error), /Connection management is not available on this application server/);
  });

  test('the admin from the environment exists, signs in, and has the admin scope', async () => {
    const admin = await call('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@example.org', password: 'admin-password-1' }),
    });
    assert.equal(admin.status, 200, admin.text);
    const me = await call('/api/whoami', { cookie: admin.cookie });
    assert.equal(me.json.role, undefined);
    assert.equal(storedRole(me.json.accountId), 'admin');
    const connections = await call('/api/connections', { cookie: admin.cookie });
    assert.equal(connections.status, 403);
    const wrote = await call('/api/update', {
      method: 'POST',
      cookie: admin.cookie,
      body: JSON.stringify({ table: 'customer', key: { id: 1 }, values: { name: 'Admin edited' } }),
    });
    assert.equal(wrote.status, 200, wrote.text);
  });

  test('signing out closes the door again', async () => {
    const ada = (
      await call('/api/auth/sign-in/email', {
        method: 'POST',
        body: JSON.stringify({ email: 'ada@example.org', password: 'ada-password-1' }),
      })
    ).cookie;
    const out = await call('/api/auth/sign-out', { method: 'POST', cookie: ada, body: '{}' });
    assert.equal(out.status, 200, out.text);
    assert.equal((await call('/api/schema', { cookie: ada })).status, 401);
  });
});

describe('invite-only sign-up', () => {
  test("is refused at the door, in Better Auth's own words", async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tablewalk-auth-invite-'));
    const db = join(tmp, 'app.db');
    makeDemoDatabase(db);
    const dir = join(tmp, 'invite');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify({
        name: 'Invite',
        auth: { store: join(tmp, 'auth.db') },
        resources: { customer: {} },
        views: { customers: { kind: 'list', from: 'customer' } },
        home: 'customers',
        nav: ['customers'],
      }),
    );
    const loaded = await loadApp(dir);
    assert.equal(loaded.app.auth?.signUp, 'invite', 'the default');
    const registry = new Registry();
    registry.add({ name: 'ro', url: db, source: 'config' });
    registry.setActive('ro');
    await registry.open('ro');
    const host: AppHost = { app: loaded, pages: [] };
    const server = createApp({ registry, apps: [host], bound: { host: '127.0.0.1', port: 0 } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      host.auth = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin] });
      const res = await fetch(`${origin}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Nobody', email: 'nobody@example.org', password: 'nobody-password-1' }),
      });
      assert.equal(res.status, 400);
      assert.match(await res.text(), /sign up is not enabled/i);
    } finally {
      server.close();
      server.closeAllConnections();
      host.auth?.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
