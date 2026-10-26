import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { loadHttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

/* A help desk under a row policy: each account works its own desk's tickets.
   An import is that account's insert, row by row: a row placed on another
   desk is refused by the policy's own writer, not by anything the file or
   the browser says. */
const appId = 'desks';
const owner = 'desk-db';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-import-policy-'));
  const file = join(directory, 'desks.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE ticket(id INTEGER PRIMARY KEY, desk INTEGER NOT NULL DEFAULT 1, name TEXT NOT NULL UNIQUE, status TEXT DEFAULT 'open');
    INSERT INTO ticket(desk, name) VALUES (1, 'Existing');`);
  const registry = new Registry();
  registry.add({ id: owner, name: owner, url: file, source: 'config', writable: true });
  const app = parseAppConfig(
    {
      id: appId,
      name: 'Desks',
      sources: { main: { connection: owner, default: true } },
      resources: { ticket: { access: 'write', import: true } },
      auth: { rows: 'policy', roles: { editor: { read: true, write: ['ticket'] }, viewer: { read: true } } },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      home: 'tickets',
      nav: ['tickets'],
    },
    'policy import fixture',
  );
  const control = { identity: { id: 'desk-one', who: 'one@example.test', role: 'editor' } as Identity };
  const host: AppHost = {
    app: { app, path: join(directory, 'app.ts'), pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: join(directory, 'auth.db'),
      close() {},
      handler: async () => {},
      session: async () => control.identity,
    },
  };
  const policyFile = join(directory, 'policy.mjs');
  writeFileSync(
    policyFile,
    `export default { appId: ${JSON.stringify(appId)},
    resolveRows(principal) { return { ticket: { groups: [[{ column: 'desk', op: '=', value: principal.id === 'desk-two' ? 2 : 1 }]] } }; } };`,
  );
  const policy = await loadHttpAppPolicy({ app, registry, file: policyFile, verifySession: async () => control.identity });
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], policy });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  t.after(async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await policy.retire();
    await registry.closeAll();
    clearJournal();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const post = async (path: string, body: object) => {
    const response = await fetch(`http://${bound.host}:${address.port}${path}?app=${appId}`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', 'x-mistri-account': control.identity.id },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const names = () =>
    db
      .prepare('SELECT desk, name FROM ticket ORDER BY id')
      .all()
      .map((row) => ({ ...row }));
  return { post, control, names };
}

const file = (lines: string[], mode = 'check', extra: object = {}) => ({
  table: 'ticket',
  csv: ['Desk,Name', ...lines].join('\n'),
  mapping: ['desk', 'name'],
  mode,
  ...extra,
});

test('under a row policy a row the reader could not insert is refused, and the rest are written', async (t) => {
  const { post, names } = await fixture(t);
  const checked = await post('/api/import', file(['1,Printer jam', "2,Someone else's desk", '1,Existing']));
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  assert.equal(checked.body.ready, 1);
  assert.deepEqual(
    checked.body.refused.map((r: any) => r.row),
    [2, 3],
  );
  assert.deepEqual(names(), [{ desk: 1, name: 'Existing' }], 'a check writes nothing');

  const written = await post('/api/import', file(['1,Printer jam', "2,Someone else's desk"], 'commit', { skipRefused: true }));
  assert.equal(written.body.outcome, 'applied', JSON.stringify(written.body));
  // An App has no Undo: the report offers none, and says nothing of one.
  assert.equal(written.body.undoId, undefined);
  assert.equal(written.body.undo, undefined);
  assert.deepEqual(names(), [
    { desk: 1, name: 'Existing' },
    { desk: 1, name: 'Printer jam' },
  ]);
});

test('under a row policy a reader without the write is refused before any row is read', async (t) => {
  const { post, control, names } = await fixture(t);
  control.identity = { id: 'desk-one', who: 'one@example.test', role: 'viewer' };
  const refused = await post('/api/import', file(['1,Printer jam'], 'commit'));
  assert.equal(refused.status, 403);
  assert.deepEqual(names(), [{ desk: 1, name: 'Existing' }]);
});
