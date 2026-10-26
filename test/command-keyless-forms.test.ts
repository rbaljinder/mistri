/**
 * A command that names no record, as a signed-in reader reaches it: its form prepares its starting values over no record (`initial()`,
 * `default: me`), and a granted one that no form runs is served by name for
 * a component's `useCommand`, prepared and sent with an empty key. Through
 * the real HTTP routes of a single App.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { appCommandCatalog } from '../packages/mistri/src/server/commands/commandContracts.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import { bool } from '../packages/mistri/src/server/commands/commandShapes.js';

const me = { auto: 'me' } as const;

test("a keyless command's form prepares over no record, and a granted one no form runs is served by name", async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-keyless-'));
  const file = join(directory, 'desk.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE change_request (id INTEGER PRIMARY KEY, title TEXT NOT NULL, risk TEXT NOT NULL, window TEXT, raised_by TEXT);
    CREATE TABLE desk_setting (id INTEGER PRIMARY KEY, change_window TEXT NOT NULL);
    CREATE TABLE notice (id INTEGER PRIMARY KEY, read INTEGER NOT NULL DEFAULT 0);
    INSERT INTO desk_setting VALUES (1, 'evening');
    INSERT INTO notice (id) VALUES (1), (2);`);
  migrateSqliteCommandJournal(file);
  clearJournal('desk-db');
  const connections = new Registry();
  connections.add({ id: 'desk-db', name: 'Desk', url: file, writable: true, source: 'config' });
  const registry = defineCommands({
    // Request a change: a normal, moderate change in the desk's window, raised by whoever asks.
    requestChange: defineCommand({
      source: 'desk',
      target: 'change_request',
      targets: 'none',
      read: ['desk_setting'],
      input: {
        title: field.text(),
        risk: field.choice(['low', 'moderate', 'high']),
        window: field.text({ optional: true }),
        raised_by: field.email({ default: me }),
      },
      output: bool(),
      async initial({ db: records }) {
        const setting = await records.desk_setting.where().first();
        return { risk: 'moderate' as const, window: String(setting?.change_window) };
      },
      async handle({ db: records }, input) {
        await records.change_request.insert({
          title: input.title,
          risk: input.risk,
          window: input.window ?? null,
          raised_by: input.raised_by,
        });
        return true;
      },
    }),
    // Mark all read: a button, with no form of its own.
    markAllRead: defineCommand({
      source: 'desk',
      target: 'notice',
      targets: 'none',
      write: ['notice'],
      output: bool(),
      async handle({ db: records }) {
        for (const row of await records.notice.where('read = 0')) await records.notice.update(row, { read: 1 });
        return true;
      },
    }),
  });
  const manifest = parseAppConfig(
    {
      id: 'desk',
      name: 'Desk',
      sources: { desk: { connection: 'desk-db', default: true } },
      resources: { change_request: { access: 'write' }, desk_setting: {}, notice: { access: 'write' } },
      auth: {
        providers: ['email'],
        roles: { agent: { read: true, commands: ['requestChange', 'markAllRead'] }, viewer: { read: true } },
      },
      views: {
        changes: { kind: 'list', from: 'change_request' },
        'request-change': { kind: 'form', label: 'Request a change', command: 'requestChange' },
      },
      home: 'changes',
      nav: ['changes', 'request-change'],
    },
    'keyless forms',
    { commands: appCommandCatalog(registry, { sources: { desk: { connection: 'desk-db', default: true } } }) },
  );
  const pages = parsePagesConfig({ pages: [] }, 'keyless pages');
  let who: Identity = { id: 'account-agent', who: 'agent@example.test', role: 'agent' };
  const host: AppHost = {
    app: { app: manifest, path: '/private/desk/app.ts', pages, sources: {} },
    pages,
    auth: { spec: manifest.auth!, store: '/private/desk/auth.db', close() {}, handler: async () => {}, session: async () => who },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry: connections, bound, apps: [host], pages, commands: { appId: 'desk', registry } });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  const call = async (path: string, body?: object) => {
    const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
      method: body ? 'POST' : 'GET',
      signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', 'x-mistri-account': who.id },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  let requests = 0;
  const execute = (command: string, input: object) =>
    call('/api/commands/execute', {
      command,
      commandVersion: 1,
      key: {},
      expectedVersion: 0,
      idempotencyKey: `keyless-request-${String(++requests).padStart(4, '0')}`,
      input,
    });
  try {
    const app = (await call('/api/app?app=desk')).body.app;
    // The form says it prepares; the button's command is served by name, beside the form's, and granted.
    assert.equal(app.views['request-change'].command.prepares, true);
    assert.deepEqual(Object.keys(app.formCommands), ['markAllRead']);
    assert.deepEqual(app.formCommands.markAllRead, { id: 'markAllRead', version: 1, input: [] });
    assert.ok(app.grantedCommands.includes('markAllRead') && app.grantedCommands.includes('requestChange'));

    const prepared = await call('/api/commands/prepare', { command: 'requestChange', commandVersion: 1, key: {} });
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    assert.deepEqual(prepared.body, {
      expectedVersion: 0,
      initial: { raised_by: 'agent@example.test', risk: 'moderate', window: 'evening' },
    });
    // A command that starts nothing prepares nothing, and a key names no record it has.
    assert.deepEqual((await call('/api/commands/prepare', { command: 'markAllRead', commandVersion: 1, key: {} })).body, {
      expectedVersion: 0,
    });
    assert.equal((await call('/api/commands/prepare', { command: 'requestChange', commandVersion: 1, key: { id: 1 } })).status, 400);

    const sent = await execute('requestChange', { ...prepared.body.initial, title: 'Patch the router' });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.deepEqual(
      { ...db.prepare('SELECT title, risk, window, raised_by FROM change_request').get() },
      {
        title: 'Patch the router',
        risk: 'moderate',
        window: 'evening',
        raised_by: 'agent@example.test',
      },
    );
    assert.equal((await execute('markAllRead', {})).status, 200);
    assert.deepEqual(
      db
        .prepare('SELECT read FROM notice ORDER BY id')
        .all()
        .map((row) => row.read),
      [1, 1],
    );

    // A role not granted either is served neither, and preparing one is refused.
    who = { id: 'account-viewer', who: 'viewer@example.test', role: 'viewer' };
    const seen = (await call('/api/app?app=desk')).body.app;
    assert.equal(seen.formCommands, undefined);
    assert.equal(seen.grantedCommands.includes('markAllRead'), false);
    assert.equal((await call('/api/commands/prepare', { command: 'requestChange', commandVersion: 1, key: {} })).status, 403);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    db.close();
    await connections.closeAll();
    clearJournal();
    rmSync(directory, { recursive: true, force: true });
  }
});
