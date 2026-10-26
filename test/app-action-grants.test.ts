/**
 * A fixed action granted without write (`roles.<role>.actions`), end to end:
 * refused at load where it names nothing real, reported in the authority
 * lock, offered to the role in `/api/app`, and admitted by the server only as
 * that action — its `set` word for word, its reason, its `when` on the stored
 * row — with the stamps resolved inside the write. Nothing the browser
 * sends widens it into an edit.
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
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { authorizeTransaction, AppAccessDenied } from '../packages/mistri/src/server/app/appAccess.js';
import { AppActionNotGranted } from '../packages/mistri/src/server/app/appTransitions.js';
import { compileAppStamps, stampUpdate } from '../packages/mistri/src/server/app/appStamps.js';
import { appActionGrants } from '../packages/mistri/src/shared/app.js';
import { authorityReport } from '../packages/mistri/src/shared/appAuthority.js';
import { parseTestApp } from './support/commandCatalog.js';

const connection = 'grants-connection';
const appId = 'grants-app';
const SUBMIT = { label: 'Submit for review', set: { status: 'review' }, when: 'status = draft' };
const APPROVE = {
  label: 'Approve payroll',
  set: { status: 'approved', approved_by: { auto: 'me' }, approved_at: { auto: 'now' } },
  reason: 'note',
  when: 'status = review',
};
const REOPEN = { label: 'Reopen', set: { status: 'draft' }, when: 'status = review' };
const manifest = (roles: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: appId,
  name: 'Grants',
  connection,
  resources: {
    run: {
      access: 'write',
      actions: {
        submit: SUBMIT,
        approve: APPROVE,
        reopen: REOPEN,
        pay: { label: 'Pay', command: { id: 'payRun', version: 1, target: 'run', input: {} } },
      },
    },
    line: {},
  },
  auth: { providers: ['email'], defaultRole: 'manager', roles, ...extra },
  views: { runs: { kind: 'list', from: 'run', label: 'Runs' } },
  home: 'runs',
  nav: ['runs'],
});
const MANAGER = { manager: { read: true, actions: { run: ['submit', 'approve'] } }, clerk: { read: true } };

test('a grant names a fixed action of a resource the role reads and does not write', () => {
  const load = (roles: Record<string, unknown>, extra?: Record<string, unknown>) => () => parseTestApp(manifest(roles, extra), 'grants.ts');
  assert.doesNotThrow(load(MANAGER));
  assert.throws(
    load({ manager: { read: true, actions: { run: ['send'] } } }),
    /"actions", "run" names "send", which is not an action of "run". Its fixed actions: "submit", "approve", "reopen"/,
  );
  assert.throws(
    load({ manager: { read: true, actions: { run: ['pay'] } } }),
    /runs the command "payRun"; grant a command through "commands"/,
  );
  assert.throws(load({ manager: { read: true, actions: { ledger: ['pay'] } } }), /the role does not read "ledger"/);
  assert.throws(load({ manager: { read: ['line'], actions: { run: ['reopen'] } } }), /the role does not read "run"/);
  assert.throws(load({ manager: { read: true, actions: { line: ['reopen'] } } }), /"line" is outside the write ceiling/);
  assert.throws(load({ manager: { read: true, write: ['run'], actions: { run: ['reopen'] } } }), /the role already writes "run"/);
  assert.throws(load({ manager: { read: true, actions: { run: [] } } }), /must be a nonempty list/);
  assert.throws(load({ manager: { read: true, actions: { run: ['reopen', 'reopen'] } } }), /names an action twice/);
  assert.throws(load({ manager: { read: true, actions: [] } }), /must be an object of resource → action ids/);
  // A row policy judges the grant in its own writer (app-action-grants-policy.test.ts); a tenant's owner holds none yet.
  assert.doesNotThrow(() =>
    parseTestApp(
      { ...manifest(MANAGER, { rows: 'policy' }), connection: undefined, sources: { main: { connection, default: true } } },
      'grants.ts',
    ),
  );
});

test('features add granted actions by resource and id, and a settings record is words', () => {
  const app = parseTestApp(
    {
      ...manifest({ manager: { read: true, actions: { run: ['submit'] } }, clerk: { read: true } }),
      features: [{ id: 'approvals', auth: { roles: { manager: { actions: { run: ['approve', 'submit'] } } } } }],
    },
    'grants.ts',
  );
  assert.deepEqual(app.auth!.roles!.manager.actions, { run: ['submit', 'approve'] });
  const settings = (value: unknown) => () =>
    parseTestApp({ ...manifest(MANAGER), resources: { ...manifest(MANAGER).resources, line: { settings: value } } }, 'grants.ts');
  assert.equal(settings('Company profile')().resources!.line.settings, 'Company profile');
  assert.throws(settings(''), /"settings" that is not the words the settings menu says/);
  assert.throws(settings(true), /"settings" that is not the words/);
});

test('the authority lock says each granted action', () => {
  const report = authorityReport(parseTestApp(manifest(MANAGER), 'grants.ts'));
  assert.match(report, /role manager action run "approve"/);
  assert.match(report, /role manager action run "submit"/);
  assert.doesNotMatch(report, /role clerk action/);
});

async function fixture(t: import('node:test').TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-action-grants-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'grants.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE run (id INTEGER PRIMARY KEY, title TEXT NOT NULL, gross INTEGER NOT NULL, status TEXT NOT NULL,
      approved_by TEXT, approved_at TIMESTAMP, note TEXT, version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE line (id INTEGER PRIMARY KEY, run_id INTEGER REFERENCES run(id), amount INTEGER);
    INSERT INTO run (title, gross, status) VALUES ('September', 1000, 'draft'), ('August', 900, 'review'), ('July', 800, 'approved');`);
  db.close();
  return { directory, path, check: () => new DatabaseSync(path) };
}

test('the facade admits a granted action exactly, and nothing near it', async (t) => {
  const { path, check } = await fixture(t);
  const adapter = new SqliteAdapter(path, 'grants');
  t.after(() => adapter.close());
  const schema = await adapter.introspect();
  const app = parseTestApp(manifest(MANAGER), 'grants.ts');
  const granted = appActionGrants(app, schema, ['manager']);
  assert.deepEqual(
    [...granted.get('run')!].map((action) => action.id),
    ['submit', 'approve'],
  );
  assert.equal(appActionGrants(app, schema, ['clerk']).size, 0);
  const stamps = compileAppStamps(schema, app)!;
  const now = new Date('2026-09-20T12:00:00Z');
  const access = {
    readable: new Set(['run', 'line']),
    writable: new Set<string>(),
    actions: granted,
    stamp: (request: Parameters<typeof stampUpdate>[1]) => stampUpdate(stamps, request, { now, who: 'ada@example.test' }),
  };
  const update = (id: number, values: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    adapter.transaction!((tx) => authorizeTransaction(schema, access, tx).update({ table: 'run', key: { id }, values, ...extra } as never));
  const row = (id: number) => {
    const db = check();
    try {
      return { ...db.prepare('SELECT * FROM run WHERE id = ?').get(id) };
    } finally {
      db.close();
    }
  };

  // Forged bodies: another column beside the action's, another value, a key move, an action not granted.
  await assert.rejects(update(1, { status: 'review', gross: 1 }), AppActionNotGranted);
  await assert.rejects(update(1, { status: 'approved' }), AppActionNotGranted);
  await assert.rejects(update(1, { gross: 1 }), AppActionNotGranted);
  await assert.rejects(update(1, { id: 9, status: 'review' }), AppAccessDenied);
  await assert.rejects(update(2, { status: 'draft' }), AppActionNotGranted, "Reopen is the resource's, not the role's");
  // The stamp words are the action's; a person or a moment the caller chose is not.
  await assert.rejects(
    update(2, { status: 'approved', approved_by: 'mallory@example.test', approved_at: 'now', note: 'ok' }),
    AppActionNotGranted,
  );
  // A reason the action asks for is required, and the action's `when` is judged on the stored row.
  await assert.rejects(update(2, { status: 'approved', approved_by: 'me', approved_at: 'now' }), AppActionNotGranted);
  await assert.rejects(update(2, { status: 'approved', approved_by: 'me', approved_at: 'now', note: '  ' }), AppActionNotGranted);
  await assert.rejects(
    update(1, { status: 'approved', approved_by: 'me', approved_at: 'now', note: 'ok' }),
    AppActionNotGranted,
    'September is a draft',
  );
  // `restore` is the journal's alone, and only over the action's own columns.
  await assert.rejects(update(1, { gross: 5 }, { restore: true }), AppAccessDenied);
  assert.deepEqual([row(1).status, row(1).gross, row(2).status], ['draft', 1000, 'review']);

  await update(1, { status: 'review' });
  await update(2, { status: 'approved', approved_by: 'me', approved_at: 'now', note: 'Checked every line.' });
  assert.equal(row(1).status, 'review');
  assert.deepEqual(
    { ...row(2), id: undefined },
    {
      id: undefined,
      title: 'August',
      gross: 900,
      status: 'approved',
      approved_by: 'ada@example.test',
      approved_at: '2026-09-20 12:00:00',
      note: 'Checked every line.',
      version: 0,
    },
  );

  // A role with no grant writes nothing here.
  const clerk = { readable: new Set(['run', 'line']), writable: new Set<string>() };
  await assert.rejects(
    adapter.transaction!((tx) =>
      authorizeTransaction(schema, clerk, tx).update({ table: 'run', key: { id: 1 }, values: { status: 'draft' } }),
    ),
    AppAccessDenied,
  );
});

test('over HTTP: offered to the granted role and refused to others', { timeout: 20_000 }, async (t) => {
  const { directory, path, check } = await fixture(t);
  const previous = process.env.XDG_CONFIG_HOME;
  clearJournal(connection);
  const registry = new Registry();
  registry.add({ id: connection, name: 'Grants', url: path, source: 'config', writable: true });
  const app = parseTestApp(manifest(MANAGER), 'grants.ts');
  let who: Identity = { id: 'account-ada', who: 'ada@example.test', role: 'manager' };
  const host: AppHost = {
    app: { path: '/grants/app.ts', app, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: join(directory, 'sessions.db'),
      handler: async () => {},
      close: async () => {},
      session: async () => who,
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages: [] });
  process.env.XDG_CONFIG_HOME = directory;
  t.after(async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    clearJournal(connection);
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const call = async (method: 'GET' | 'POST', route: string, body?: Record<string, unknown>) => {
    const response = await fetch(
      `http://${bound.host}:${address.port}${route}${method === 'GET' ? `${route.includes('?') ? '&' : '?'}app=${appId}` : ''}`,
      {
        signal: AbortSignal.timeout(5_000),
        method,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app: appId, ...body }) } : {}),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  const status = (id: number) => {
    const db = check();
    try {
      return db.prepare('SELECT status, gross FROM run WHERE id = ?').get(id);
    } finally {
      db.close();
    }
  };

  const served = await call('GET', '/api/app');
  assert.deepEqual(served.body.app.grantedActions, { run: ['submit', 'approve'] });
  assert.deepEqual(served.body.app.writableTables, [], 'the role writes no table');

  // A generic edit and a forged action body are refused as not granted, 403 like any other, never as a bad request;
  // the granted action is admitted.
  const generic = await call('POST', '/api/update', { table: 'run', key: { id: 1 }, values: { gross: 1 } });
  assert.deepEqual([generic.status, generic.body.code], [403, 'forbidden'], JSON.stringify(generic.body));
  const forged = await call('POST', '/api/update', { table: 'run', key: { id: 1 }, values: { status: 'review', title: 'Hijacked' } });
  assert.deepEqual([forged.status, forged.body.code], [403, 'forbidden']);
  assert.equal((await call('POST', '/api/insert', { table: 'run', values: { title: 'New', gross: 1, status: 'draft' } })).status, 403);
  assert.equal((await call('POST', '/api/delete', { table: 'run', key: { id: 1 }, confirm: true })).status, 403);
  const submitted = await call('POST', '/api/update', { table: 'run', key: { id: 1 }, values: { status: 'review' } });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.deepEqual({ ...status(1) }, { status: 'review', gross: 1000 });

  // A role without the grant is offered nothing and refused the same body.
  who = { id: 'account-bo', who: 'bo@example.test', role: 'clerk' };
  assert.equal((await call('GET', '/api/app')).body.app.grantedActions, undefined);
  assert.equal((await call('POST', '/api/update', { table: 'run', key: { id: 1 }, values: { status: 'review' } })).status, 403);
  // A forged role list is not the verified one: the session says who, and it says clerk.
  assert.equal(
    (await call('POST', '/api/update', { table: 'run', key: { id: 1 }, values: { status: 'review' }, role: 'manager', roles: ['manager'] }))
      .status,
    403,
  );
  assert.deepEqual({ ...status(1) }, { status: 'review', gross: 1000 });
});
