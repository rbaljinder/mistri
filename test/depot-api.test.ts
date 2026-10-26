/** Depot's small API (test/fixtures/apps/depot/api.ts): the catalog and stock to
 * read, a supplier's contact details through a generic write, the dock's
 * `shipList` command, and `order.shipped` on the event feed. Seeds a fresh
 * SQLite Depot, ships a packed pick list through the real command binding
 * and reads the event back the way the feed does. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadBusinessCommands, validateBusinessCommandReferences } from '../packages/mistri/src/server/commands/businessCommandLoader.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { appCommandEventsFor } from '../packages/mistri/src/server/commands/appCommandEvents.js';
import { apiWriteProblems, withApiWrites } from '../packages/mistri/src/server/api/apiGenericWrites.js';
import { apiEventProblems, eventFeedAudience, readSqliteEventFeed } from '../packages/mistri/src/server/api/apiEventFeed.js';
import { renderApiAsyncApi } from '../packages/mistri/src/server/api/apiAsyncApi.js';
import { rowRevision } from '../packages/mistri/src/server/commands/commandRevision.js';
import { ROOT } from './appApiCli.js';
import { homeSourceOf } from '../packages/mistri/src/shared/app.js';

test('Depot exposes its catalog, a supplier write, shipList and order.shipped on the feed', { timeout: 180000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tw-depot-api-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'depot.db');
  execFileSync(process.execPath, ['--import', 'tsx', join(ROOT, 'test/fixtures/databases/depot/seed.mjs'), file], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  const loaded = await loadApp(join(ROOT, 'test/fixtures/apps/depot'));
  const app = loaded.app;
  const registry = new Registry();
  registry.add({ id: 'depot', name: 'depot', url: file, writable: true, source: 'config' });
  t.after(() => registry.closeAll());
  const resources = await loadAppRuntimeResources(registry, app, 'depot');
  const commands = await loadBusinessCommands(join(ROOT, 'test/fixtures/apps/depot/commands.ts'));
  /* A form's command is judged at startup against the catalog the App serves: releaseOrder's
     picker reads `released = 0 and lines > 0`, two of sales_order's rollups. */
  assert.doesNotThrow(() => validateBusinessCommandReferences(app, commands, resources));
  // The declaration is sound: its writes, its events.
  assert.deepEqual(apiWriteProblems(app, resources.schema, commands), []);
  assert.deepEqual(apiEventProblems(app, commands), []);
  const served = withApiWrites(app, resources.schema, commands);
  assert.deepEqual(served.app.api!.commands.map((entry) => entry.command.id).sort(), ['shipList', 'update-supplier']);
  const asyncapi = renderApiAsyncApi(app, commands, { integers: 'decimal-string' }) as Record<string, any>;
  assert.deepEqual(Object.keys(asyncapi.components.messages), ['event.order.shipped']);
  assert.deepEqual(asyncapi.components.schemas['EventPayload_order.shipped'].required, ['order', 'reference', 'carrier', 'tracking']);
  // Ship a packed pick list as a manager, through the binding startup makes.
  const events = await appCommandEventsFor(app, commands, resources, (id) => registry.configOf(id)?.url);
  const binding = bindBusinessCommands({
    app,
    registry: commands,
    resources,
    writableConnection: () => true,
    ...(events ? { events } : {}),
  });
  /* shipList runs from `packed` only. The seed's floor follows the clock, so a day can
     dawn with nothing packed (CI did); pack one list here rather than ship from a state
     the machine refuses. */
  const db = new DatabaseSync(file);
  const packed = (() => {
    try {
      db.exec(`UPDATE pick_list SET status = 'packed', picked_at = coalesce(picked_at, released_at),
      packed_at = coalesce(packed_at, picked_at, released_at), cartons = coalesce(cartons, 1)
      WHERE id = (SELECT id FROM pick_list WHERE status <> 'shipped' ORDER BY status = 'packed' DESC, id LIMIT 1)`);
      return db.prepare("SELECT * FROM pick_list WHERE status = 'packed' ORDER BY id LIMIT 1").get();
    } finally {
      db.close();
    }
  })();
  assert.ok(packed, 'the seed has a pick list on the floor');
  const result = await executeBusinessCommand(
    binding,
    { id: 'manager-1', appId: 'depot', roles: ['manager'], email: 'manager@example.test' },
    {
      command: 'shipList',
      commandVersion: 1,
      key: { id: Number(packed.id) },
      input: { carrier: 'UPS', tracking: '1Z999AA10123456784' },
      expectedVersion: rowRevision({ ...packed }, 'version')!,
      idempotencyKey: 'depot-ship-attempt-0001',
    },
  );
  assert.equal(result.status, 'applied');
  // The feed: the manager's token sees the shipment; a token without the event sees nothing.
  const page = readSqliteEventFeed(
    file,
    app,
    { limit: 50 },
    eventFeedAudience(app, resources.schema, { operations: ['event:order.shipped'], roles: ['manager'] }),
    'decimal-string',
    homeSourceOf(app)!,
  );
  assert.deepEqual(
    page.items.map((item) => [item.name, item.resource, item.payload]),
    [
      [
        'order.shipped',
        'pick_list',
        { order: Number(packed.sales_order_id), reference: packed.reference, carrier: 'UPS', tracking: '1Z999AA10123456784' },
      ],
    ],
  );
  const none = readSqliteEventFeed(
    file,
    app,
    { limit: 50 },
    eventFeedAudience(app, resources.schema, { operations: ['list:product'], roles: ['manager'] }),
    'decimal-string',
    homeSourceOf(app)!,
  );
  assert.deepEqual(none.items, []);
});
