import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertion,
  filter,
  object,
  denied,
  rows,
  ids,
  fixture,
  login,
  evidence,
  reserve,
  release,
  prepare,
  committed,
} from './support/tenantInventoryHarness.js';

for (const role of ['member', 'viewer'] as const) {
  test(`inventory: native ${role} has no inventory commands and cannot forge manager identity or recover its receipts`, async (t) => {
    const f = await fixture(t),
      client = await login(f, role),
      c = await client.open(),
      before = evidence(f);
    const app = object((await client.data('/api/app', c)).body.app);
    assert.deepEqual(app.grantedCommands, role === 'member' ? [f.model.command] : []);
    assert.deepEqual(app.writableTables, role === 'member' ? [f.model.work] : []);
    assert.deepEqual(
      rows(await client.data('/api/query', c, { table: f.inventory.vehicle, filter: filter('id', f.inventoryRows.north.otherVehicle) })),
      [],
    );
    for (const input of [reserve(f), release(f)]) {
      for (const path of ['/api/commands/prepare', '/api/commands/status', '/api/commands/execute']) {
        denied(await client.data(path, c, path.endsWith('prepare') ? prepare(input) : input));
        assert.deepEqual(evidence(f), before);
      }
      denied(await client.data('/api/commands/execute', { ...c, accountId: f.accounts.manager.id }, input));
      assert.deepEqual(evidence(f), before);
    }
    const manager = await login(f),
      managed = await manager.open();
    for (const input of [reserve(f), release(f)])
      assert.equal((await manager.data('/api/commands/execute', managed, input)).body.status, 'applied');
    const after = evidence(f);
    for (const input of [reserve(f), release(f)])
      for (const path of ['/api/commands/status', '/api/commands/execute']) {
        denied(await client.data(path, c, input));
        assert.deepEqual(evidence(f), after);
      }
    if (role === 'viewer') {
      assert.deepEqual((await client.bootstrap()).memberships, [{ tenantId: 'northstar' }]);
      denied(await client.call(client.select('/api/tenant/context/open', 'riverview'), {}));
    }
  });
}

for (const change of ['shift', 'revoke'] as const) {
  test(`inventory: membership ${change} invalidates prepared authority and both historical receipts, retaining the other tenant`, async (t) => {
    const f = await fixture(t),
      client = await login(f),
      old = await client.open(),
      south = await client.open('riverview');
    const inputs = [reserve(f), release(f)];
    for (const input of inputs) assert.equal((await client.data('/api/commands/execute', old, input)).body.status, 'applied');
    const pending = reserve(f, f.inventoryRows.north.staleVehicle, f.rows.north.work, 'inventory-before-membership-change', 3);
    assert.equal((await client.data('/api/commands/prepare', old, prepare(pending))).body.expectedVersion, 3);
    const before = evidence(f);
    await f[change](f.accounts.manager.id, 'northstar');
    denied(await client.data('/api/commands/execute', old, pending));
    denied(await client.call(client.select('/api/tenant/context/renew', 'northstar'), assertion(old)));
    for (const input of inputs)
      for (const path of ['/api/commands/status', '/api/commands/execute']) denied(await client.data(path, old, input));
    if (change === 'shift') {
      const fresh = await client.open();
      assert.deepEqual(ids(await client.data('/api/query', fresh, { table: f.inventory.vehicle })), [f.inventoryRows.north.otherVehicle]);
      for (const input of inputs)
        for (const path of ['/api/commands/status', '/api/commands/execute']) denied(await client.data(path, fresh, input));
      denied(await client.data('/api/commands/execute', fresh, pending));
      denied(await client.data('/api/commands/execute', fresh, reserve(f, f.inventoryRows.north.otherVehicle, f.rows.north.otherWork)));
    } else {
      denied(await client.call(client.select('/api/tenant/context/open', 'northstar'), {}));
      assert.deepEqual((await client.bootstrap()).memberships, [{ tenantId: 'riverview' }]);
    }
    assert.deepEqual(evidence(f), before);
    const southInput = reserve(f, f.inventoryRows.south.vehicle, f.rows.south.work);
    committed(
      f,
      before,
      await client.data('/api/commands/execute', south, southInput),
      southInput,
      'riverview',
      f.assignmentRows.south.manager,
    );
  });
}
