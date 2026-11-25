/**
 * `currentZone()` in an App without tenants: the App's `ui.timezone`, read by a helper the handler calls and by its
 * lookup, though neither is handed `ctx.timezone`; UTC where the App names none, and outside any run. (A tenant's own
 * zone, through the same call: tenant-profile-zone.test.ts.)
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
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { currentZone } from '../packages/mistri/src/server/commands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

/* A helper the App keeps beside its commands: it is handed nothing, and asks. */
const dayStartsIn = () => currentZone();

const stamp = defineCommand({
  source: 'shop',
  target: 'vehicle',
  input: {},
  output: { parse: (value: unknown) => value as { lookup: string; helper: string } },
  lookup: () => ({ zone: currentZone() }),
  async handle({ db, record, lookup }) {
    const seen = { lookup: (lookup as { zone: string }).zone, helper: dayStartsIn() };
    await db.vehicle.update(record!, { note: seen.helper });
    return seen;
  },
});

async function run(timezone: string | undefined) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-current-zone-'));
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
        ...(timezone ? { ui: { timezone } } : {}),
      },
      'zone fixture',
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
      { command: 'stamp', commandVersion: 1, key: { id: 1 }, expectedVersion: 0, idempotencyKey: 'current-zone-attempt-0001', input: {} },
    );
    return answer.result;
  } finally {
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a helper and a lookup read the App's zone, and UTC where it names none or nothing runs", async () => {
  assert.deepEqual(await run('Pacific/Kiritimati'), { lookup: 'Pacific/Kiritimati', helper: 'Pacific/Kiritimati' });
  assert.deepEqual(await run(undefined), { lookup: 'UTC', helper: 'UTC' });
  assert.equal(currentZone(), 'UTC');
});
