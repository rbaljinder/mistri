/**
 * Saved views over HTTP: the App list's saved filters, one store
 * (`filters.json`) with a section per signed-in account.
 *
 * In an App without sign-in the list is the connection's, shared by every
 * reader. In an App that signs people in each account keeps its own: the
 * owner is the verified session, never the body, so one account can neither
 * read, overwrite nor delete another's. Signed out there is nothing to read
 * or save. Row-policy and tenant Apps refuse the routes (their own suites:
 * app-row-policy-http, tenant-http).
 */
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
import { filtersPath, writeLayout } from '../packages/engine/src/server/layouts.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const connection = 'saved-views-db';
const appId = 'saved-views';
const sessions: Record<string, Identity> = {
  ada: { id: 'account-ada', who: 'ada@example.test', role: 'reader' },
  bo: { id: 'account-bo', who: 'bo@example.test', role: 'reader' },
  blank: { id: ' ', who: 'blank@example.test', role: 'reader' },
};
const shared = [{ name: 'Shared', query: 'name = shared' }];
const mine = [{ name: 'Mine', query: 'name contains ada' }];
const theirs = [{ name: 'Bo', query: 'name contains bo' }];
const roles = { providers: ['email'], defaultRole: 'reader', roles: { reader: { read: true } } };

type Reply = { status: number; body: { store?: string; filters?: Record<string, unknown>; error?: string } };
type Call = (route: string, session?: string, body?: Record<string, unknown>) => Promise<Reply>;

async function fixture(auth: Record<string, unknown> | undefined, run: (call: Call) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-saved-views-'));
  const previousConfig = process.env.XDG_CONFIG_HOME;
  const path = join(directory, 'app.db');
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE task (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO task VALUES (1, 'First');");
  db.close();
  const registry = new Registry();
  registry.add({ id: connection, name: 'Saved views database', url: path, source: 'config', writable: false });
  const app = parseAppConfig(
    {
      id: appId,
      name: 'Saved views',
      connection,
      ...(auth ? { auth } : {}),
      // A resource ceiling is granted through roles; an App that signs people in without roles declares none.
      resources: { task: auth && !('roles' in auth) ? {} : {} },
      views: { tasks: { kind: 'list', from: 'task' } },
      home: 'tasks',
    },
    'saved views fixture',
  );
  const host: AppHost = {
    app: { path: join(directory, 'app.ts'), app, pages: [], sources: {} },
    pages: [],
    ...(auth
      ? {
          auth: {
            spec: app.auth!,
            store: join(directory, 'auth.db'),
            handler: async () => {},
            close: async () => {},
            session: async (req: { headers: { cookie?: string } }) => sessions[req.headers.cookie?.replace(/^session=/, '') ?? ''] ?? null,
          },
        }
      : {}),
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host] });
  process.env.XDG_CONFIG_HOME = directory;
  try {
    // The connection's shared list, which no account's reply may carry.
    for (const scope of [connection, appId]) await writeLayout(scope, 'tasks', shared, filtersPath());
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    const base = `http://${bound.host}:${bound.port}`;
    await run(async (route, session, body) => {
      const response = await fetch(`${base}${route}${body ? '' : `?app=${appId}`}`, {
        signal: AbortSignal.timeout(3_000),
        headers: { ...(session ? { Cookie: `session=${session}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { method: 'POST', body: JSON.stringify({ app: appId, ...body }) } : {}),
      });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    });
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfig;
    rmSync(directory, { recursive: true, force: true });
  }
}

test('an App without sign-in keeps one list, shared by every reader', { timeout: 10_000 }, async () => {
  await fixture(undefined, async (call) => {
    const first = await call('/api/filters');
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.store, 'shared');
    assert.deepEqual(first.body.filters, { tasks: shared });
    const saved = await call('/api/filters/save', 'ada', { list: 'tasks', filters: mine });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    // Whoever asks next reads the same list: there is nobody to keep it apart for.
    for (const session of [undefined, 'bo']) assert.deepEqual((await call('/api/filters', session)).body.filters, { tasks: mine });
  });
});

/* An App that grants by role has resource access; one that only signs people
   in has none, and its accounts are kept apart all the same. */
for (const [kind, auth] of [
  ['granting by role', roles],
  ['signing in without roles', {}],
] as const) {
  test(`an App ${kind} keeps each account's views apart, owned by the session and never the body`, { timeout: 10_000 }, async () => {
    await fixture(auth, async (call) => {
      const empty = await call('/api/filters', 'ada');
      assert.equal(empty.status, 200, JSON.stringify(empty.body));
      assert.equal(empty.body.store, 'account');
      assert.deepEqual(empty.body.filters, {}, "the shared list is not an account's");

      const saved = await call('/api/filters/save', 'ada', { list: 'tasks', filters: mine });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.deepEqual((await call('/api/filters', 'ada')).body.filters, { tasks: mine });
      assert.deepEqual((await call('/api/filters', 'bo')).body.filters, {}, "Bo reads none of Ada's");

      // A body naming Ada's account still writes Bo's own list.
      const forged = await call('/api/filters/save', 'bo', {
        list: 'tasks',
        filters: theirs,
        account: 'account-ada',
        principal: 'account-ada',
      });
      assert.equal(forged.status, 200, JSON.stringify(forged.body));
      assert.deepEqual((await call('/api/filters', 'bo')).body.filters, { tasks: theirs });
      assert.deepEqual((await call('/api/filters', 'ada')).body.filters, { tasks: mine });

      // So is a removal: Bo's own list goes, Ada's stays.
      assert.equal((await call('/api/filters/save', 'bo', { list: 'tasks', filters: null })).status, 200);
      assert.deepEqual((await call('/api/filters', 'bo')).body.filters, {});
      assert.deepEqual((await call('/api/filters', 'ada')).body.filters, { tasks: mine });
    });
  });
}

test('signed out, or signed in with no account, nothing is read or saved', { timeout: 10_000 }, async () => {
  await fixture(roles, async (call) => {
    assert.equal((await call('/api/filters/save', 'ada', { list: 'tasks', filters: mine })).status, 200);
    for (const session of [undefined, 'stranger']) {
      const read = await call('/api/filters', session);
      assert.ok([401, 403].includes(read.status), `${session}: ${JSON.stringify(read.body)}`);
      assert.equal(read.body.filters, undefined);
      const write = await call('/api/filters/save', session, { list: 'tasks', filters: theirs });
      assert.ok([401, 403].includes(write.status), `${session}: ${JSON.stringify(write.body)}`);
    }
    const blank = await call('/api/filters/save', 'blank', { list: 'tasks', filters: theirs });
    assert.ok([401, 403].includes(blank.status), JSON.stringify(blank.body));
    assert.deepEqual((await call('/api/filters', 'ada')).body.filters, { tasks: mine });
  });
});
