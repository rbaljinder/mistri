/*
 * What an App request compiles is kept, and never wrong (U2): the runtime
 * resources (every source's catalog bound, every resource named) per App and
 * opened connection, and the command binding (grants, footprints, validation)
 * per App, registry, resources and writability. Each is kept under exactly
 * what it was derived from, compared by identity, so a changed schema (the
 * connection refreshed), a reloaded App or a connection made read-only is a
 * miss, and the next request reads the new truth.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindHttpBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandLoader.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';

test('runtime resources and command bindings are kept per App and connection, and a schema, App or writability change is a miss', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-plan-cache-'));
  const path = join(directory, 'desk.db');
  const db = new DatabaseSync(path);
  const registry = new Registry();
  try {
    db.exec('CREATE TABLE ticket (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, status TEXT NOT NULL)');
    migrateSqliteCommandJournal(path);
    registry.add({ id: 'desk-db', name: 'desk', url: path, writable: true, source: 'config' });
    const config = {
      id: 'desk',
      name: 'Desk',
      sources: { desk: { connection: 'desk-db' } },
      resources: { ticket: { access: 'write' } },
      auth: { roles: { clerk: { read: true, commands: ['close'] } } },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      home: 'tickets',
    };
    const app = parseAppConfig(config, 'plan cache');
    const commands = defineCommands({
      close: defineCommand({ source: 'desk', target: 'ticket', input: {}, handle: async () => undefined }),
    });
    const writable = (connection: string) => registry.configOf(connection)?.writable === true;

    const first = await loadAppRuntimeResources(registry, app, 'desk-db');
    assert.equal(await loadAppRuntimeResources(registry, app, 'desk-db'), first, 'the same App on the same open connection: kept');
    const bound = bindHttpBusinessCommands(app, commands, first, writable);
    assert.equal(bindHttpBusinessCommands(app, commands, first, writable), bound, 'the same inputs: the same binding');

    // The schema changes underneath; the connection is refreshed, as the server does on a schema change.
    db.exec('ALTER TABLE ticket ADD COLUMN note TEXT');
    await registry.refresh('desk-db');
    const refreshed = await loadAppRuntimeResources(registry, app, 'desk-db');
    assert.notEqual(refreshed, first, 'a refreshed connection is a new catalog');
    assert.ok(
      refreshed.schema.tables.find((table) => table.id === 'ticket')?.columns.some((column) => column.name === 'note'),
      'the next request reads the column added underneath',
    );
    assert.notEqual(bindHttpBusinessCommands(app, commands, refreshed, writable), bound);

    // A reloaded App is a new App.
    const reloaded = parseAppConfig(config, 'plan cache');
    assert.notEqual(await loadAppRuntimeResources(registry, reloaded, 'desk-db'), refreshed);

    // Writability is in the binding's key: read-only is judged again, and refused, not answered from the writable one.
    const writableBinding = bindHttpBusinessCommands(app, commands, refreshed, writable);
    assert.throws(() => bindHttpBusinessCommands(app, commands, refreshed, () => false), /writable source/);
    assert.equal(bindHttpBusinessCommands(app, commands, refreshed, writable), writableBinding, 'and back again is kept as it was');
  } finally {
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
