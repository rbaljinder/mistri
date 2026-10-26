/**
 * An App serves its declared resources and nothing else of the connection,
 * signed in or not, with or without roles: a table it does not declare
 * answers as a table that does not exist, on every endpoint, and the
 * Workbench's own tools — raw SQL, saved SQL, the layout and page builders,
 * connection management — are refused. The standalone browser keeps them.
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
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const connection = 'declared-resources';
const appId = 'atlas';
const secret = 'UNDECLARED-ROW-CONTENT';
const reader: Identity = { id: 'account-reader', who: 'reader@example.test', role: 'reader' };

type Mode = 'no sign-in' | 'signed in' | 'roles';
const MODES: Mode[] = ['no sign-in', 'signed in', 'roles'];

function definition(mode: Mode) {
  return parseAppConfig(
    {
      id: appId,
      name: 'Atlas',
      connection,
      // Signed in without roles an App grants nothing per resource: what it declares, it reads and writes.
      resources: mode === 'signed in' ? { incident: {}, service: {} } : { incident: { access: 'write' }, service: {} },
      ...(mode === 'signed in' ? { auth: { providers: ['email'] } } : {}),
      ...(mode === 'roles'
        ? { auth: { providers: ['email'], defaultRole: 'reader', roles: { reader: { read: true, write: true } } } }
        : {}),
      views: { incidents: { kind: 'list', from: 'incident', label: 'Incidents' } },
      home: 'incidents',
      nav: ['incidents'],
    },
    'declared resources fixture',
  );
}

async function serve(
  mode: Mode | 'browser',
  run: (call: (path: string, body?: Record<string, unknown>) => Promise<{ status: number; body: any }>) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-declared-'));
  const previousConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = directory;
  const path = join(directory, 'atlas.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE service (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE incident (id INTEGER PRIMARY KEY, name TEXT NOT NULL, service_id INTEGER REFERENCES service(id));
    CREATE TABLE audit_note (id INTEGER PRIMARY KEY, name TEXT NOT NULL, incident_id INTEGER REFERENCES incident(id));
    INSERT INTO service VALUES (1, 'Identity');
    INSERT INTO incident VALUES (1, 'Login outage', 1);
  `);
  db.prepare('INSERT INTO audit_note VALUES (1, ?, 1)').run(secret);
  db.close();
  clearJournal(connection);
  const registry = new Registry();
  registry.add({ id: connection, name: 'Atlas database', url: path, source: 'config', writable: true });
  const hosts: AppHost[] = [];
  if (mode !== 'browser') {
    const manifest = definition(mode);
    hosts.push({
      app: { path: join(directory, 'app.ts'), app: manifest, pages: [], sources: {} },
      pages: [],
      ...(manifest.auth
        ? {
            auth: {
              spec: manifest.auth,
              store: join(directory, 'sessions.db'),
              handler: async () => {},
              close: async () => {},
              session: async () => reader,
            },
          }
        : {}),
    });
  }
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: hosts, pages: [] });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    const scope: Record<string, string> = mode === 'browser' ? { conn: connection } : { app: appId };
    await run(async (route, body) => {
      const query = new URLSearchParams(scope).toString();
      const response = await fetch(
        `http://${bound.host}:${bound.port}${route}${body ? '' : `${route.includes('?') ? '&' : '?'}${query}`}`,
        {
          signal: AbortSignal.timeout(5_000),
          ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...scope, ...body }) } : {}),
        },
      );
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* an export streams text */
      }
      return { status: response.status, body: parsed };
    });
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    clearJournal(connection);
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfig;
    rmSync(directory, { recursive: true, force: true });
  }
}

/* Each request naming `table`, once for the undeclared table and once for one that does not exist. */
const reads: Array<[string, (table: string) => Record<string, unknown> | undefined]> = [
  ['/api/query', (table) => ({ table })],
  ['/api/count', (table) => ({ table, exactCount: true })],
  ['/api/counts', (table) => ({ items: [table] })],
  ['/api/references', (table) => ({ table, key: { id: 1 } })],
  ['/api/run', (table) => ({ q: `${table} show name` })],
  ['/api/breakdown', (table) => ({ text: `${table} count` })],
  ['/api/breakdowns', (table) => ({ items: [{ text: `${table} count` }] })],
  ['/api/view/run', (table) => ({ view: { id: 'v', name: 'V', base: table, columns: [{ path: 'name' }] } })],
  ['/api/export', (table) => ({ q: table, format: 'ndjson' })],
  ['/api/update', (table) => ({ table, key: { id: 1 }, values: { name: 'forged' } })],
  ['/api/insert', (table) => ({ table, values: { name: 'forged', incident_id: 1 } })],
  ['/api/delete', (table) => ({ table, key: { id: 1 }, confirm: true })],
  ['/api/pages/plan', (table) => ({ page: { id: 'p', name: 'P', base: table, sections: [] }, key: { id: 1 } })],
];

for (const mode of MODES) {
  test(`${mode}: an undeclared table answers as a missing one on every endpoint`, { timeout: 30_000 }, async () => {
    await serve(mode, async (call) => {
      const schema = await call('/api/schema');
      assert.equal(schema.status, 200, JSON.stringify(schema.body));
      assert.deepEqual(schema.body.tables.map((table: { id: string }) => table.id).sort(), ['incident', 'service']);
      assert.ok(!JSON.stringify(schema.body).includes('audit_note'));
      for (const [path, body] of reads) {
        const undeclared = await call(path, body('audit_note'));
        const missing = await call(path, body('no_such_table'));
        assert.doesNotMatch(JSON.stringify(undeclared.body), new RegExp(secret), path);
        assert.deepEqual(
          { status: undeclared.status, body: JSON.stringify(undeclared.body).replaceAll('audit_note', 'T') },
          { status: missing.status, body: JSON.stringify(missing.body).replaceAll('no_such_table', 'T') },
          path,
        );
        assert.ok(
          undeclared.status >= 400 || /"errors":\[\{/.test(JSON.stringify(undeclared.body)),
          `${path}: ${JSON.stringify(undeclared.body)}`,
        );
      }
      const relations = await call('/api/pages/relations?table=audit_note');
      const noRelations = await call('/api/pages/relations?table=no_such_table');
      assert.equal(relations.status, noRelations.status);
      // A declared table still reads, and its incoming undeclared rows are not among its references.
      const declared = await call('/api/query', { table: 'incident' });
      assert.equal(declared.status, 200, JSON.stringify(declared.body));
      assert.equal(declared.body.rows.length, 1);
      const references = await call('/api/references', { table: 'incident', key: { id: 1 } });
      assert.doesNotMatch(JSON.stringify(references.body), /audit_note/);
    });
  });

  test(`${mode}: the Workbench's tools are refused`, { timeout: 30_000 }, async () => {
    await serve(mode, async (call) => {
      for (const [path, body] of [
        ['/api/sql', { text: 'SELECT * FROM audit_note' }],
        ['/api/view/compile', { view: { id: 'v', name: 'V', base: 'incident', columns: [{ path: 'name' }] } }],
        ['/api/ddl', { table: 'incident' }],
        ['/api/agent/call', { name: 'query', arguments: { table: 'audit_note' } }],
        ['/api/layouts', { table: 'incident', layout: { title: 'Mine' } }],
        ['/api/pages/save', { id: 'mine', page: { id: 'mine', name: 'Mine', base: 'incident', sections: [] } }],
        ['/api/connections/save', {}],
      ] as Array<[string, Record<string, unknown>]>) {
        const result = await call(path, body);
        assert.equal(result.status, 403, `${path}: ${JSON.stringify(result.body)}`);
        assert.doesNotMatch(JSON.stringify(result.body), new RegExp(secret));
      }
      for (const path of ['/api/queries', '/api/connections', '/api/agent/tools']) {
        assert.equal((await call(path)).status, 403, path);
      }
      // The builders' stores read empty: nothing of the browser's leaks into an App.
      assert.deepEqual((await call('/api/layouts')).body.layouts, {});
      assert.deepEqual((await call('/api/pages/saved')).body.pages, {});
    });
  });
}

test('the standalone browser keeps every table and its tools', { timeout: 30_000 }, async () => {
  await serve('browser', async (call) => {
    const schema = await call('/api/schema');
    assert.ok(schema.body.tables.some((table: { id: string }) => table.id === 'audit_note'));
    const rows = await call('/api/query', { table: 'audit_note' });
    assert.equal(rows.status, 200, JSON.stringify(rows.body));
    assert.equal(rows.body.rows[0].name, secret);
    const sql = await call('/api/sql', { text: 'SELECT name FROM audit_note' });
    assert.equal(sql.status, 200, JSON.stringify(sql.body));
  });
});
