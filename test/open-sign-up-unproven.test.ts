/**
 * Where anyone may sign up, an email is only what someone typed until its
 * link is followed: it is nobody's `me` and nobody's inbox. Once proven, it is.
 * The session's flag comes from the sign-in store itself (auth.ts), and
 * `mistri check` says when nothing could ever prove an address.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth, type Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { provisionSqliteInbox } from '../packages/mistri/src/adapters/inbox/sqliteInbox.js';
import { appSignUpProblems } from '../packages/mistri/src/shared/appWarnings.js';
import { validationCode } from '../packages/mistri/src/server/build/checkProblems.js';
import { codeRows } from '../packages/mistri/src/server/build/checkCodes.js';

const connection = 'unproven-connection';
const appId = 'unproven-app';
const DESK = {
  id: appId,
  name: 'Desk',
  connection,
  resources: {
    employee: {},
    ticket: { access: 'write', notify: [{ on: 'insert', to: 'filed_by', title: 'Filed' }] },
  },
  auth: {
    providers: ['email'],
    signUp: 'open',
    defaultRole: 'agent',
    me: { from: 'employee', column: 'email' },
    roles: { agent: { read: true, write: ['ticket'] } },
  },
  views: { tickets: { kind: 'list', from: 'ticket', label: 'Tickets' } },
  home: 'tickets',
  nav: ['tickets'],
};

test('an unproven address under open sign-up has no `me` and no inbox; a proven one has both', { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-unproven-'));
  const previous = process.env.XDG_CONFIG_HOME;
  const path = join(directory, 'desk.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE employee (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL);
    CREATE TABLE ticket (id INTEGER PRIMARY KEY, subject TEXT NOT NULL, owner_id INTEGER REFERENCES employee(id), filed_by TEXT);
    INSERT INTO employee VALUES (1, 'Bo', 'bo@example.test'), (2, 'Ada', 'ada@example.test');
    INSERT INTO ticket VALUES (1, 'Printer', 2, NULL), (2, 'VPN', 1, NULL), (3, 'Laptop', 2, NULL);
  `);
  db.close();
  provisionSqliteInbox(path);
  clearJournal(connection);
  const registry = new Registry();
  registry.add({ id: connection, name: 'Desk', url: path, source: 'config', writable: true });
  const manifest = parseAppConfig(DESK, 'unproven fixture');
  const proven: Identity = { id: 'account-ada', who: 'ada@example.test', role: 'agent', emailVerified: true };
  const typed: Identity = { id: 'account-mallory', who: 'ada@example.test', role: 'agent', emailUnproven: true };
  let who: Identity = typed;
  const host: AppHost = {
    app: { path: '/desk/app.ts', app: manifest, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: manifest.auth!,
      store: join(directory, 'sessions.db'),
      handler: async () => {},
      close: async () => {},
      session: async () => who,
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages: [] });
  process.env.XDG_CONFIG_HOME = directory;
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const post = async (route: string, body: Record<string, unknown>) => {
      const response = await fetch(`http://${bound.host}:${address.port}${route}`, {
        signal: AbortSignal.timeout(5_000),
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app: appId, ...body }),
      });
      return { status: response.status, body: await response.json() };
    };
    const mine = async () => {
      const { body } = await post('/api/run', { q: 'ticket owner_id = me', exactCount: true });
      assert.deepEqual(body.errors, [], JSON.stringify(body));
      return (body.rows as Array<{ id: number }>).map((row) => row.id).sort();
    };

    // Typed, not proven: the address matches nobody, and the inbox kept for it is not theirs.
    assert.deepEqual(await mine(), []);
    assert.equal((await post('/api/inbox', {})).status, 403);

    // Proven: the same address is Ada's row and Ada's inbox.
    who = proven;
    assert.deepEqual(await mine(), [1, 3]);
    assert.equal((await post('/api/inbox', {})).status, 200);
  } finally {
    server.close();
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "the sign-in store marks an open sign-up unproven until its email is verified; the operator's admin is proven",
  { timeout: 30_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-unproven-auth-'));
    const path = join(directory, 'desk.db');
    const store = join(directory, 'sessions.db');
    const environment = {
      BETTER_AUTH_SECRET: 'isolated-unproven-test-secret-at-least-thirty-two-characters',
      MISTRI_AUTH_ADMIN_EMAIL: 'admin@example.test',
      MISTRI_AUTH_ADMIN_PASSWORD: 'admin-unproven-password-1',
      XDG_CONFIG_HOME: directory,
    };
    const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
    const db = new DatabaseSync(path);
    db.exec(`
    CREATE TABLE employee (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL);
    CREATE TABLE ticket (id INTEGER PRIMARY KEY, subject TEXT NOT NULL, owner_id INTEGER REFERENCES employee(id), filed_by TEXT);
  `);
    db.close();
    provisionSqliteInbox(path);
    clearJournal(connection);
    const registry = new Registry();
    registry.add({ id: connection, name: 'Desk', url: path, source: 'config', writable: true });
    const app = parseAppConfig({ ...DESK, auth: { ...DESK.auth, store } }, 'unproven fixture');
    const host: AppHost = { app: { path: join(directory, 'app.ts'), app, pages: [], sources: {} }, pages: [] };
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
      const call = async (endpoint: string, body?: Record<string, unknown>, cookie?: string) => {
        const response = await fetch(`${origin}${endpoint}`, {
          signal: AbortSignal.timeout(5_000),
          headers: { origin, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
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
      const signup = await call('/api/auth/sign-up/email', { name: 'Ada', email: 'ada@example.test', password: 'ada-unproven-password-1' });
      assert.equal(signup.status, 200, JSON.stringify(signup.body));
      const cookie = signup.cookie;
      assert.equal((await call(`/api/whoami?app=${appId}`, undefined, cookie)).body.inbox, undefined);
      {
        const r = await call('/api/inbox', { app: appId }, cookie);
        assert.equal(r.status, 403, JSON.stringify(r.body));
      }

      const sessions = new DatabaseSync(store);
      sessions.prepare('UPDATE user SET emailVerified = 1 WHERE email = ?').run('ada@example.test');
      const admin = sessions.prepare('SELECT emailVerified FROM user WHERE email = ?').get('admin@example.test');
      sessions.close();
      assert.equal(admin?.emailVerified, 1);
      assert.equal((await call(`/api/whoami?app=${appId}`, undefined, cookie)).body.inbox, true);
      assert.equal((await call('/api/inbox', { app: appId }, cookie)).status, 200);
    } finally {
      server.close();
      await host.auth?.close();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test('check fails where anyone may sign up and nothing could prove an address, under a code it documents', () => {
  const app = parseAppConfig(DESK, 'unproven fixture');
  const problems = appSignUpProblems(app, false);
  assert.equal(problems.length, 1);
  // A problem, not advice: no `warning:` lead, and a code of its own the page has a row for.
  assert.doesNotMatch(problems[0], /^warning:/);
  assert.equal(validationCode(problems[0]), 'open-sign-up-unproven');
  assert.ok(
    codeRows().some((row) => row.code === 'open-sign-up-unproven'),
    'check-codes.md has its row',
  );
  assert.deepEqual(appSignUpProblems(app, true), []);
  const invite = parseAppConfig({ ...DESK, auth: { ...DESK.auth, signUp: 'invite' } }, 'unproven fixture');
  assert.deepEqual(appSignUpProblems(invite, false), []);
});
