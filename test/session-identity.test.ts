import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal, history } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const appId = 'customer-portal';
const account: Identity = { id: 'account-stable-123', who: 'person@example.test', role: 'admin' };

async function fixture(
  options: { standalone?: boolean; proxy?: boolean; database?: string },
  run: (base: string, session: { current: Identity | null; authCalls: number }, opens: () => number) => Promise<void>,
) {
  const registry = new Registry();
  registry.add({
    id: 'private-db-id',
    name: 'Private database',
    url: options.database ?? '/private/operator/private.db',
    writable: Boolean(options.database),
    source: 'config',
  });
  let opened = 0;
  const open = registry.open.bind(registry);
  registry.open = async (id) => {
    opened++;
    if (options.database) return open(id);
    throw new Error('Identity must not open a database');
  };
  const session = { current: account as Identity | null, authCalls: 0 };
  const app = parseAppConfig(
    {
      id: appId,
      name: 'Customer Portal',
      connection: 'private-db-id',
      auth: {
        providers: ['email'],
        store: '/private/operator/auth.db',
        signUp: 'invite',
        ...(options.database ? { roles: { viewer: { read: true }, admin: { read: true, write: true } } } : {}),
      },
      resources: options.database ? { ticket: { access: 'write' } } : { ticket: {} },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      home: 'tickets',
    },
    'identity fixture',
  );
  const host: AppHost = {
    app: { path: '/private/operator/app.ts', app, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: '/private/operator/auth.db',
      close: () => {},
      handler: async (_req, res) => {
        session.authCalls++;
        session.current = null;
        res.writeHead(204);
        res.end();
      },
      session: async () => session.current,
    },
  };
  const bound = { host: '127.0.0.1', port: 0, ...(options.proxy ? { identityHeader: 'X-Forwarded-User' } : {}) };
  const server = createApp({ registry, bound, ...(!options.standalone ? { apps: [host] } : {}) });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    await run(`http://${bound.host}:${bound.port}`, session, () => opened);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    host.auth?.close();
    await registry.closeAll();
  }
}

async function get(base: string, path: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(2_000) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test(
  'authenticated identity returns stable account and authored app IDs without roles or database ownership',
  { timeout: 5_000 },
  async () => {
    await fixture({ proxy: true }, async (base, session, opens) => {
      const result = await get(base, '/api/whoami?app=forged-app&accountId=forged-account', {
        'x-forwarded-user': 'spoofed@example.test',
        'x-role': 'superuser',
      });
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, { signedIn: true, accountId: account.id, appId, who: account.who, header: null });
      assert.equal(result.headers.get('x-mistri-account'), account.id);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      assert.equal(result.headers.get('x-mistri-connection'), null);
      assert.doesNotMatch(JSON.stringify(result.body), /private-db-id|Private database|operator|admin|superuser/);
      session.current = { ...account, id: 'different-account-same-email' };
      const other = await get(base, '/api/whoami');
      assert.equal(other.body.who, account.who);
      assert.equal(other.body.accountId, 'different-account-same-email');
      assert.equal(other.headers.get('x-mistri-account'), 'different-account-same-email');
      assert.equal(opens(), 0);
    });
  },
);

test('authenticated API replies carry only the verified account marker, including refused requests', { timeout: 5_000 }, async () => {
  await fixture({}, async (base, _session, opens) => {
    for (const [path, status] of [
      ['/api/runtime', 200],
      ['/api/connections', 403],
    ] as const) {
      const result = await get(base, path, { 'x-mistri-account': account.id });
      assert.equal(result.status, status);
      assert.equal(result.headers.get('x-mistri-account'), account.id);
      assert.equal(result.headers.get('x-mistri-connection'), null);
    }
    const signOut = await fetch(`${base}/api/auth/sign-out`, { method: 'POST', signal: AbortSignal.timeout(2_000) });
    assert.equal(signOut.status, 204);
    assert.equal(signOut.headers.get('x-mistri-account'), null);
    assert.equal(opens(), 0);
  });
});

test(
  'expected-account preconditions refuse stale writes before opening adapters and never grant authority',
  { timeout: 10_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-session-owner-'));
    const database = join(directory, 'data.db');
    const db = new DatabaseSync(database);
    db.exec("CREATE TABLE ticket (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO ticket VALUES (1, 'Original');");
    clearJournal('private-db-id');
    try {
      await fixture({ database }, async (base, session, opens) => {
        const write = async (expected: string, name: string) => {
          const response = await fetch(`${base}/api/update?role=admin`, {
            method: 'POST',
            signal: AbortSignal.timeout(3_000),
            headers: { origin: base, 'content-type': 'application/json', 'x-mistri-account': expected, 'x-role': 'admin' },
            body: JSON.stringify({ app: appId, table: 'ticket', key: { id: 1 }, values: { name }, role: 'admin', writable: true }),
          });
          return { status: response.status, headers: response.headers, body: await response.json() };
        };
        const stale = await write('previous-account', 'Stale tab write');
        assert.equal(stale.status, 409, JSON.stringify(stale.body));
        assert.equal(stale.headers.get('x-mistri-account'), account.id);
        assert.equal(stale.headers.get('cache-control'), 'no-store');
        assert.equal(opens(), 0, 'stale owner must be refused before opening the database');
        assert.equal(db.prepare('SELECT name FROM ticket WHERE id = 1').get()?.name, 'Original');
        assert.deepEqual(history('private-db-id'), []);

        const saved = await write(account.id, 'Admin save');
        assert.equal(saved.status, 200, JSON.stringify(saved.body));
        assert.equal(saved.headers.get('x-mistri-account'), account.id);
        assert.equal(saved.body.affected, 1);
        assert.equal(db.prepare('SELECT name FROM ticket WHERE id = 1').get()?.name, 'Admin save');
        const journalCount = history('private-db-id').length;
        assert.equal(journalCount, 0, 'App writes do not enter the Workbench Undo journal');

        session.current = { id: 'verified-viewer', who: 'viewer@example.test', role: 'viewer' };
        const openedBeforeForgery = opens();
        const forged = await write(account.id, 'Forged admin identity');
        assert.equal(forged.status, 409);
        assert.equal(forged.headers.get('x-mistri-account'), 'verified-viewer');
        assert.equal(opens(), openedBeforeForgery);
        const viewer = await write('verified-viewer', 'Forged admin grants');
        assert.equal(viewer.status, 403, JSON.stringify(viewer.body));
        assert.equal(viewer.headers.get('x-mistri-account'), 'verified-viewer');
        assert.equal(db.prepare('SELECT name FROM ticket WHERE id = 1').get()?.name, 'Admin save');
        assert.equal(history('private-db-id').length, journalCount);
      });
    } finally {
      clearJournal('private-db-id');
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test('a stale account cannot sign out the newer verified session', { timeout: 5_000 }, async () => {
  await fixture({}, async (base, session, opens) => {
    const newer = { ...account, id: 'newer-account' };
    session.current = newer;
    const signOut = (expected?: string) =>
      fetch(`${base}/api/auth/sign-out`, {
        method: 'POST',
        signal: AbortSignal.timeout(2_000),
        headers: { origin: base, ...(expected ? { 'x-mistri-account': expected } : {}) },
      });
    const stale = await signOut(account.id);
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).error, /account changed/);
    assert.equal(stale.headers.get('cache-control'), 'no-store');
    assert.equal(stale.headers.get('set-cookie'), null);
    assert.equal(session.authCalls, 0, 'mismatched ownership must not invoke the auth handler');
    assert.equal(session.current, newer);
    assert.equal((await signOut(newer.id)).status, 204);
    assert.equal(session.authCalls, 1);
    assert.equal(session.current, null);
    assert.equal((await signOut(newer.id)).status, 204, 'already signed-out requests remain idempotent');
    assert.equal(session.authCalls, 2);
    session.current = account;
    assert.equal((await signOut()).status, 204, 'auth clients without an expected-owner header keep working');
    assert.equal(session.authCalls, 3);
    assert.equal(session.current, null);
    assert.equal(opens(), 0);
  });
});

test('anonymous identity returns explicit signed-out state without an account header', { timeout: 5_000 }, async () => {
  await fixture({}, async (base, session, opens) => {
    session.current = null;
    const result = await get(base, '/api/whoami', { 'x-mistri-account': account.id });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
      signedIn: false,
      accountId: null,
      appId,
      who: null,
      header: null,
      // The door carries the App's look, and nothing about its content.
      signIn: { app: 'Customer Portal', providers: ['email'], signUp: 'invite', look: { id: appId, name: 'Customer Portal' } },
    });
    assert.equal(result.headers.get('x-mistri-account'), null);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    const forbidden = await get(base, '/api/schema');
    assert.equal(forbidden.status, 401);
    assert.equal(forbidden.headers.get('x-mistri-account'), null);
    assert.equal(opens(), 0);
  });
});

test('malformed verified session IDs fail closed on every API before opening databases', { timeout: 5_000 }, async () => {
  await fixture({}, async (base, session, opens) => {
    for (const id of [undefined, null, '', '   ', 123, 'unsafe\r\nheader']) {
      session.current = { ...account, id } as unknown as Identity;
      for (const path of ['/api/whoami', '/api/runtime', '/api/schema']) {
        const result = await get(base, path);
        assert.equal(result.status, 401, `${path}: ${JSON.stringify(result.body)}`);
        assert.equal(result.body.signedIn, false);
        assert.equal(result.body.accountId, null);
        assert.equal(result.body.appId, appId);
        assert.equal(result.body.who, null);
        assert.equal(result.headers.get('x-mistri-account'), null);
        assert.equal(result.headers.get('cache-control'), 'no-store');
      }
    }
    assert.equal(opens(), 0);
  });
});

test('standalone proxy display identities never become authenticated account ownership', { timeout: 5_000 }, async () => {
  await fixture({ standalone: true, proxy: true }, async (base, _session, opens) => {
    const result = await get(base, '/api/whoami', { 'x-forwarded-user': account.who, 'x-mistri-account': account.id });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { who: account.who, header: 'X-Forwarded-User', signedIn: false });
    assert.equal(result.headers.get('x-mistri-account'), null);
    const local = await get(base, '/api/whoami');
    assert.deepEqual(local.body, { who: 'local', header: 'X-Forwarded-User', signedIn: false });
    assert.equal(opens(), 0);
  });
  await fixture({ standalone: true }, async (base, _session, opens) => {
    const result = await get(base, '/api/whoami');
    assert.deepEqual(result.body, { who: null, header: null, signedIn: false });
    assert.equal(opens(), 0);
  });
});
