import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal, history } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

test('real Better Auth sessions enforce access ceilings and revoked cookies cannot authorize requests', { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-auth-access-'));
  const path = join(directory, 'data.db');
  const store = join(directory, 'sessions.db');
  const connection = 'private-auth-database';
  const appId = 'secured-atlas';
  const environment = {
    BETTER_AUTH_SECRET: 'isolated-access-test-secret-at-least-thirty-two-characters',
    MISTRI_AUTH_ADMIN_EMAIL: 'admin@example.test',
    MISTRI_AUTH_ADMIN_PASSWORD: 'admin-access-password-1',
    XDG_CONFIG_HOME: directory,
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE incident (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE service (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE private_note (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO incident VALUES (1, 'Initial incident');
    INSERT INTO service VALUES (1, 'Identity service');
    INSERT INTO private_note VALUES (1, 'Confidential note');
  `);
  const registry = new Registry();
  registry.add({ id: connection, name: 'Private connection', url: path, writable: true, source: 'config' });
  clearJournal(connection);
  const host: AppHost = {
    app: {
      path: join(directory, 'app.ts'),
      pages: [],
      sources: {},
      app: parseAppConfig(
        {
          id: appId,
          name: 'Secured Atlas',
          connection,
          resources: { incident: { access: 'write' }, service: {}, private_note: {} },
          auth: {
            providers: ['email'],
            signUp: 'open',
            defaultRole: 'viewer',
            store,
            roles: { viewer: { read: ['incident', 'service'] }, admin: { read: ['incident', 'service'], write: true } },
          },
          views: {
            incident: { kind: 'list', from: 'incident' },
            service: { kind: 'list', from: 'service' },
            'private-note': { kind: 'list', from: 'private_note' },
          },
          home: 'incident',
          nav: ['incident', 'service', 'private-note'],
        },
        'real auth access fixture',
      ),
    },
    pages: [],
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, apps: [host], bound });
  try {
    Object.assign(process.env, environment);
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    const origin = `http://${bound.host}:${bound.port}`;
    host.auth = await createAppAuth(host.app, { baseURL: origin, trustedOrigins: [origin] });

    const call = async (endpoint: string, body?: Record<string, unknown>, cookie?: string, extraHeaders: Record<string, string> = {}) => {
      const response = await fetch(`${origin}${endpoint}`, {
        signal: AbortSignal.timeout(5_000),
        headers: { origin, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...extraHeaders },
        ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
      });
      return {
        status: response.status,
        body: await response.json(),
        cookie: response.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .join('; '),
      };
    };

    assert.equal((await call(`/api/schema?app=${appId}`)).status, 401);
    const privilegedSignup = await call('/api/auth/sign-up/email', {
      name: 'Reader',
      email: 'reader@example.test',
      password: 'reader-access-password-1',
      role: 'admin',
    });
    assert.equal(privilegedSignup.status, 400);
    assert.equal(privilegedSignup.body.code, 'FIELD_NOT_ALLOWED');
    const signup = await call('/api/auth/sign-up/email', {
      name: 'Reader',
      email: 'reader@example.test',
      password: 'reader-access-password-1',
    });
    assert.equal(signup.status, 200, JSON.stringify(signup.body));
    assert.match(signup.cookie, /mistri-[A-Za-z0-9_-]+\.session_token=/);
    const reader = signup.cookie;
    const who = await call('/api/whoami', undefined, reader);
    assert.equal(who.status, 200);
    assert.equal(who.body.role, undefined);
    assert.equal(typeof who.body.accountId, 'string');
    const sessions = new DatabaseSync(store, { readOnly: true });
    try {
      assert.equal(sessions.prepare('SELECT role FROM user WHERE email = ?').get('reader@example.test')?.role, 'viewer');
    } finally {
      sessions.close();
    }
    const schema = await call(`/api/schema?app=${appId}`, undefined, reader);
    assert.equal(schema.status, 200);
    assert.deepEqual(schema.body.tables.map((table: { id: string }) => table.id).sort(), ['incident', 'service']);
    const permitted = await call('/api/query', { app: appId, table: 'incident', columns: ['name'] }, reader);
    assert.equal(permitted.status, 200);
    assert.deepEqual(permitted.body.rows, [{ name: 'Initial incident' }]);
    const spoofed = await call(
      '/api/update?role=admin',
      {
        app: appId,
        table: 'incident',
        key: { id: 1 },
        values: { name: 'Spoofed' },
        role: 'admin',
        writable: true,
        permissions: { update: true },
        access: { write: true },
      },
      reader,
      { 'x-role': 'admin', 'x-mistri-role': 'admin' },
    );
    assert.equal(spoofed.status, 403, JSON.stringify(spoofed.body));
    assert.equal(spoofed.body.error, 'Access to this resource is denied.');
    assert.equal(db.prepare('SELECT name FROM incident').get()?.name, 'Initial incident');
    assert.deepEqual(history(connection), []);

    const login = await call('/api/auth/sign-in/email', {
      email: environment.MISTRI_AUTH_ADMIN_EMAIL,
      password: environment.MISTRI_AUTH_ADMIN_PASSWORD,
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.match(login.cookie, /mistri-[A-Za-z0-9_-]+\.session_token=/);
    const admin = login.cookie;
    const adminIdentity = await call('/api/whoami', undefined, admin);
    assert.equal(adminIdentity.body.role, undefined);
    const adminStore = new DatabaseSync(store, { readOnly: true });
    try {
      assert.equal(adminStore.prepare('SELECT role FROM user WHERE id = ?').get(adminIdentity.body.accountId)?.role, 'admin');
    } finally {
      adminStore.close();
    }
    const saved = await call('/api/update', { app: appId, table: 'incident', key: { id: 1 }, values: { name: 'Admin save' } }, admin);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.affected, 1);
    assert.equal(db.prepare('SELECT name FROM incident').get()?.name, 'Admin save');
    assert.deepEqual(history(connection), [], 'App writes do not enter Workbench Undo history');
    const ceiling = await call('/api/update', { app: appId, table: 'service', key: { id: 1 }, values: { name: 'Beyond ceiling' } }, admin);
    assert.equal(ceiling.status, 403, JSON.stringify(ceiling.body));
    const privateRead = await call('/api/query', { app: appId, table: 'private_note' }, admin);
    assert.equal(privateRead.status, 403, JSON.stringify(privateRead.body));
    assert.equal(db.prepare('SELECT name FROM service').get()?.name, 'Identity service');

    for (const cookie of [reader, admin]) {
      const logout = await call('/api/auth/sign-out', {}, cookie);
      assert.equal(logout.status, 200, JSON.stringify(logout.body));
      assert.equal((await call(`/api/schema?app=${appId}`, undefined, cookie)).status, 401);
      const staleWrite = await call(
        '/api/update',
        { app: appId, table: 'incident', key: { id: 1 }, values: { name: 'Revoked session write' }, role: 'admin' },
        cookie,
      );
      assert.equal(staleWrite.status, 401);
    }
    assert.equal(db.prepare('SELECT name FROM incident').get()?.name, 'Admin save');
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    host.auth?.close();
    await registry.closeAll();
    clearJournal(connection);
    db.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
