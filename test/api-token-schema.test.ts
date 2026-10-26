import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { loadSqliteTokenSchema } from '../packages/mistri/src/server/cli/apiTokenSchema.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';

function app(): LoadedApp {
  return {
    path: '/unused/app.json',
    pages: [],
    sources: {},
    app: parseAppConfig(
      {
        id: 'directory',
        name: 'Directory',
        connection: 'data',
        resources: { person: { physical: 'people' } },
        auth: { roles: { reader: { read: true } } },
        views: { people: { kind: 'list', from: 'person' } },
        home: 'people',
        api: { version: 1, roles: ['reader'], resources: { person: { fields: ['id', 'name'] } } },
      },
      'test',
    ),
  };
}

test('token schema selects the named SQLite source, maps logical resources and closes it', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-token-schema-'));
  const path = join(directory, 'data.db'),
    missing = join(directory, 'missing.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  db.close();
  const close = SqliteAdapter.prototype.close;
  let closes = 0;
  t.mock.method(SqliteAdapter.prototype, 'close', async function (this: SqliteAdapter) {
    closes++;
    await close.call(this);
  });
  try {
    const schema = await loadSqliteTokenSchema(app(), [
      { id: 'unrelated', name: 'unrelated', url: missing, source: 'config' },
      { id: 'data', name: 'data', url: path, source: 'config', writable: true },
    ]);
    assert.ok(schema.tables.some((table) => table.name === 'person'));
    assert.equal(closes, 1);
    assert.equal(existsSync(missing), false);
    const invalid = app();
    invalid.app.api!.resources.person.fields.push('missing');
    await assert.rejects(
      loadSqliteTokenSchema(invalid, [{ id: 'data', name: 'data', url: path, source: 'config' }]),
      /schema is unavailable/,
    );
    assert.equal(closes, 2, 'catalog validation failure closes its owned adapter');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('token schema refuses nonliteral paths and ambiguous selection before acquisition', async (t) => {
  let opens = 0;
  t.mock.method(SqliteAdapter.prototype, 'introspect', async () => {
    opens++;
    throw new Error('unexpected open');
  });
  for (const url of [
    ':memory:',
    'sqlite:/tmp/data.db',
    'file:/tmp/data.db',
    '${DATA}',
    '$DATA',
    '~/data.db',
    'postgres://user:secret@host/db',
  ]) {
    await assert.rejects(loadSqliteTokenSchema(app(), [{ id: 'data', name: 'data', url, source: 'config' }]), /schema is unavailable/);
  }
  await assert.rejects(
    loadSqliteTokenSchema(app(), [
      { id: 'data', name: 'first', url: '/missing.db', source: 'config' },
      { id: 'second', name: 'data', url: '/missing.db', source: 'config' },
    ]),
    /schema is unavailable/,
  );
  assert.equal(opens, 0);
});
