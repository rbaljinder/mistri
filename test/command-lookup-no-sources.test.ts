/**
 * A lookup that reads no source declares none: it computes from the input and the record, or calls an integration, and
 * `sources` is for what it reads. The reverse stays refused, since only a lookup reads a source.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { BusinessCommandDefinitionError, defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const stamp = defineCommand({
  source: 'shop',
  target: 'vehicle',
  input: {},
  output: { parse: (value: unknown) => value as { label: string } },
  lookup: ({ record }) => ({ label: `vehicle-${String(record!.id)}` }),
  async handle({ db, record, lookup }) {
    const { label } = lookup as { label: string };
    await db.vehicle.update(record!, { note: label });
    return { label };
  },
});

test('a lookup with no sources and no integrations is a command, and runs', async () => {
  assert.equal(typeof stamp, 'object');
  const directory = mkdtempSync(join(tmpdir(), 'mistri-command-lookup-none-'));
  const path = join(directory, 'shop.db');
  const db = new DatabaseSync(path);
  const registry = new Registry();
  try {
    db.exec(
      'CREATE TABLE vehicle (id INTEGER PRIMARY KEY, note TEXT, version INTEGER NOT NULL DEFAULT 0); INSERT INTO vehicle VALUES (1, NULL, 0);',
    );
    migrateSqliteCommandJournal(path);
    registry.add({ id: 'private-db', name: 'Shop', url: path, writable: true, source: 'config' });
    const app = parseAppConfig(
      {
        id: 'shop',
        name: 'Shop',
        home: 'vehicles',
        sources: { shop: { connection: 'private-db', default: true } },
        resources: { vehicle: { access: 'write' } },
        auth: { roles: { staff: { read: true, commands: ['stamp'] } } },
        views: { vehicles: { kind: 'list', from: 'vehicle' } },
      },
      'lookup fixture',
    );
    const resources = await loadAppRuntimeResources(registry, app, 'private-db');
    const binding = bindBusinessCommands({
      app,
      registry: defineCommands({ stamp }),
      resources,
      writableConnection: (id) => id === 'private-db',
    });
    const answer = await executeBusinessCommand(
      binding,
      { id: 'account-a', appId: 'shop', roles: ['staff'] },
      { command: 'stamp', commandVersion: 1, key: { id: 1 }, expectedVersion: 0, idempotencyKey: 'lookup-none-0001', input: {} },
    );
    assert.deepEqual(answer.result, { label: 'vehicle-1' });
    assert.equal(db.prepare('SELECT note FROM vehicle WHERE id = 1').get()!.note, 'vehicle-1');
  } finally {
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('sources without a lookup are still refused, and say so', () => {
  assert.throws(
    () =>
      defineCommand({
        source: 'shop',
        target: 'vehicle',
        input: {},
        sources: { desk: ['contacts'] },
        output: { parse: (value: unknown) => value },
        handle: () => ({}),
      } as never),
    (error: unknown) =>
      error instanceof BusinessCommandDefinitionError && /declare a lookup beside them, or drop sources/.test(error.message),
  );
});
