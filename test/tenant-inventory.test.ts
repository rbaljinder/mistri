import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inventoryResult } from './support/tenantInventoryFixture.js';
import { DatabaseSync } from 'node:sqlite';
import {
  filter,
  object,
  objects,
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
  type ObjectValue,
} from './support/tenantInventoryHarness.js';

test('inventory: result validators enforce the exact nine-key version and message contract', () => {
  for (const mode of ['reserve', 'release'] as const) {
    const valid = {
      vehicleId: 'opaque-vehicle',
      reservationId: 'opaque-reservation',
      historyId: 'a'.repeat(32),
      leadId: 'opaque-lead',
      managerId: 'opaque-manager',
      vehicleVersion: 1,
      reservationVersion: mode === 'reserve' ? 0 : 1,
      status: mode === 'reserve' ? 'reserved' : 'available',
      message: mode === 'reserve' ? 'Vehicle reserved.' : 'Reservation released.',
    };
    assert.deepEqual(inventoryResult(mode, valid), valid);
    for (const field of Object.keys(valid)) {
      const missing: ObjectValue = { ...valid };
      delete missing[field];
      assert.throws(() => inventoryResult(mode, missing));
    }
    for (const invalid of [
      { ...valid, tenant_id: 'northstar' },
      { ...valid, actorId: 'native-account' },
      { ...valid, vehicleVersion: 0 },
      { ...valid, vehicleVersion: 1.5 },
      { ...valid, reservationVersion: mode === 'reserve' ? 1 : 0 },
      { ...valid, historyId: 'A'.repeat(32) },
      { ...valid, message: 'Done.' },
      { ...valid, status: 'unavailable' },
    ]) {
      assert.throws(() => inventoryResult(mode, invalid));
    }
  }
});

test('inventory: native identity, tenant-local stock and reservation references, scoped joins/counts and actual lead picker', async (t) => {
  const f = await fixture(t),
    client = await login(f),
    north = await client.open(),
    south = await client.open('riverview');
  const before = evidence(f),
    i = f.inventory,
    n = f.inventoryRows.north;
  assert.ok(north.context !== south.context && north.tabId !== south.tabId, 'tenant contexts must be independent');
  assert.deepEqual((await client.bootstrap()).memberships, [{ tenantId: 'northstar' }, { tenantId: 'riverview' }]);
  for (const [c, expected, base, prefix] of [
    [north, n, f.rows.north, 'Northstar'],
    [south, f.inventoryRows.south, f.rows.south, 'Riverview'],
  ] as const) {
    assert.deepEqual(
      rows(
        await client.data('/api/query', c, {
          table: i.vehicle,
          columns: ['id', 'stock_reference', 'version'],
          filter: filter('stock_reference', 'STOCK-001'),
        }),
      ),
      [{ id: expected.vehicle, stock_reference: 'STOCK-001', version: 0 }],
    );
    assert.deepEqual(
      rows(
        await client.data('/api/query', c, { table: i.reservation, columns: ['id', 'reference'], filter: filter('reference', 'RS-001') }),
      ),
      [{ id: expected.reservation, reference: 'RS-001' }],
    );
    assert.deepEqual(
      rows(
        await client.data('/api/view/run', c, {
          view: {
            base: i.reservation,
            columns: ['id', 'vehicle_id.stock_reference', 'lead_id.name', 'reserved_by.name', 'location_id.name'],
            filter: { groups: [[{ path: 'reference', op: '=', value: 'RS-001' }]] },
          },
        }),
      ),
      [
        {
          id: expected.reservation,
          'vehicle_id.stock_reference': 'STOCK-008',
          'lead_id.name': `${prefix} work`,
          'reserved_by.name': `${prefix} manager`,
          'location_id.name': `${prefix} main unit`,
        },
      ],
    );
    const visibleVehicles = before.vehicles.filter((row) => row.tenant_id === c.tenantId);
    assert.deepEqual(ids(await client.data('/api/query', c, { table: i.vehicle })), visibleVehicles.map((row) => row.id).sort());
    assert.equal((await client.data('/api/count', c, { table: i.vehicle })).body.count, visibleVehicles.length);
    const picker = `${f.model.work} status = open show id, name sort name`;
    assert.deepEqual(
      rows(await client.data('/api/run', c, { q: picker, limit: 20, offset: 0 }))
        .map((row) => row.id)
        .sort(),
      (c === north ? [base.work, f.rows.north.otherWork] : [base.work]).sort(),
    );
    for (const name of [prefix === 'Northstar' ? 'Riverview' : 'Northstar', 'private']) {
      assert.deepEqual(
        rows(
          await client.data('/api/run', c, { q: `${f.model.work} status = open and name contains ${JSON.stringify(name)} show id, name` }),
        ),
        [],
      );
    }
  }
  const schema = objects((await client.data('/api/schema', north)).body.tables);
  assert.deepEqual(
    schema.map((table) => table.id).sort(),
    [
      f.model.unit,
      f.model.work,
      f.model.target,
      f.model.event,
      f.assignment.staff,
      f.assignment.application,
      f.assignment.history,
      i.vehicle,
      i.reservation,
      i.history,
    ].sort(),
  );
  for (const [table, relations] of [
    [i.vehicle, { location_id: f.model.unit }],
    [
      i.reservation,
      {
        location_id: f.model.unit,
        vehicle_id: i.vehicle,
        lead_id: f.model.work,
        reserved_by: f.assignment.staff,
        released_by: f.assignment.staff,
      },
    ],
    [i.history, { location_id: f.model.unit, vehicle_id: i.vehicle, reservation_id: i.reservation, actor_id: f.assignment.staff }],
  ] as const) {
    const columns = objects(schema.find((entry) => entry.id === table)?.columns);
    for (const [column, parent] of Object.entries(relations))
      assert.deepEqual(columns.find((entry) => entry.name === column)?.references, { table: parent, column: 'id' });
    denied(await client.data('/api/query', north, { table, columns: ['tenant_id'] }));
    denied(await client.data('/api/query', north, { table, filter: filter('tenant_id', 'riverview') }));
  }
  const app = object((await client.data('/api/app', north)).body.app);
  assert.deepEqual(app.writableTables, [f.model.work]);
  assert.deepEqual((app.grantedCommands as string[]).slice().sort(), [f.model.command, f.assignment.command, i.reserve, i.release].sort());
  for (const [table, command, names] of [
    [i.vehicle, i.reserve, ['lead', 'reason']],
    [i.reservation, i.release, ['reason']],
  ] as const) {
    const nav = object(object(app.resources)[table]);
    const reference = object(objects(nav.actions)[0].command),
      fields = objects(reference.input);
    assert.equal(reference.id, command);
    assert.equal(reference.version, 1);
    assert.equal('versionField' in reference, false);
    assert.deepEqual(
      fields.map((field) => field.name),
      names,
    );
    assert.equal(fields.find((field) => field.name === 'reason')?.maxLength, 500);
    assert.ok(fields.every((field) => field.required === true));
    if (table === i.vehicle) {
      const lead = fields[0];
      assert.equal(lead.from, f.model.work);
      assert.equal(lead.by, 'id');
      assert.equal(lead.labelColumn, 'name');
      assert.equal(lead.query, 'status = open');
    }
  }
  const pages = objects((await client.data('/api/pages', north)).body.pages);
  for (const [table, keys] of [
    [i.vehicle, ['location_id']],
    [i.reservation, ['location_id', 'vehicle_id', 'lead_id', 'reserved_by', 'released_by']],
    [i.history, ['location_id', 'vehicle_id', 'reservation_id', 'actor_id']],
  ] as const) {
    const page = pages.find((page) => page.id === table);
    assert.ok(page);
    const fields = objects(page.sections).find((section) => section.kind === 'fields');
    assert.ok(fields);
    // A reference shows the record it names unless a page says `names: false`.
    assert.notEqual(fields.names, false);
    for (const key of keys)
      assert.ok(Array.isArray(fields.paths) && fields.paths.includes(key), 'detail must retain a direct FK navigation path');
  }
  // Global native role remains member; tenant membership supplies manager rights.
  const session = await client.call('/api/auth/get-session');
  assert.equal(object(session.body.user).role, 'member');
  for (const forged of [
    { ...north, accountId: f.accounts.member.id },
    { ...north, tenantId: 'riverview' },
    { ...north, revision: north.revision + 1 },
    { ...north, context: south.context },
  ]) {
    denied(await client.data('/api/query', forged, { table: i.vehicle }));
  }
  assert.deepEqual(evidence(f), before);
});

test('inventory: same native actor and attempt key in two tenants retain independent stock, receipts and recovery', async (t) => {
  const f = await fixture(t),
    client = await login(f),
    north = await client.open(),
    south = await client.open('riverview');
  const receipts: unknown[] = [];
  for (const [c, stock, base, staff] of [
    [north, f.inventoryRows.north, f.rows.north, f.assignmentRows.north],
    [south, f.inventoryRows.south, f.rows.south, f.assignmentRows.south],
  ] as const) {
    const input = reserve(f, stock.vehicle, base.work),
      before = evidence(f);
    const first = await client.data('/api/commands/execute', c, input);
    const { after } = committed(f, before, first, input, c.tenantId, staff.manager);
    receipts.push(first.body.receiptId);
    for (const path of ['/api/commands/status', '/api/commands/execute']) {
      const recovered = await client.data(path, c, input);
      assert.equal(recovered.body.replayed, true);
      assert.equal(recovered.body.receiptId, first.body.receiptId);
      assert.deepEqual(recovered.body.result, first.body.result);
      assert.deepEqual(evidence(f), after);
      const wrongTenant = await client.data(path, c === north ? south : north, input);
      denied(wrongTenant);
      assert.equal(wrongTenant.body.code, 'forbidden');
      assert.equal(wrongTenant.body.outcome, 'unknown');
      assert.deepEqual(evidence(f), after);
    }
  }
  assert.notEqual(receipts[0], receipts[1]);
  assert.deepEqual(
    evidence(f)
      .receipts.map((row) => [row.tenant_id, row.actor_id, row.idempotency_key])
      .sort(),
    ['northstar', 'riverview'].map((tenant) => [tenant, f.accounts.manager.id, reserve(f).idempotencyKey]),
  );
});

test('inventory: closing a reserved lead does not trap its stock; release uses actual vehicle and reservation versions', async (t) => {
  const f = await fixture(t),
    client = await login(f),
    c = await client.open(),
    input = reserve(f);
  const first = await client.data('/api/commands/execute', c, input);
  assert.equal(first.body.status, 'applied');
  const closed = await client.data('/api/update', c, {
    table: f.model.work,
    key: { id: f.rows.north.work },
    expected: { status: 'open' },
    values: { status: 'closed' },
  });
  assert.equal(closed.body.affected, 1);
  const releaseInput = release(f, String(object(first.body.result).reservationId));
  committed(f, evidence(f), await client.data('/api/commands/execute', c, releaseInput), releaseInput);
  const stale = release(f, f.inventoryRows.north.staleReservation, 'inventory-release-current-writer-version', 2);
  const before = evidence(f),
    reply = await client.data('/api/commands/execute', c, stale);
  const { result } = committed(f, before, reply, stale);
  assert.equal(result.vehicleVersion, 5);
  assert.equal(result.reservationVersion, 3);
});

test('inventory: generic insert/update/delete cannot bypass any protected resource or command-owned state', async (t) => {
  const f = await fixture(t),
    client = await login(f),
    c = await client.open();
  assert.equal((await client.data('/api/commands/execute', c, reserve(f))).body.status, 'applied');
  const before = evidence(f);
  for (const [table, originals] of [
    [f.model.unit, before.units],
    [f.model.target, before.targets],
    [f.model.event, before.events],
    [f.assignment.staff, before.staff],
    [f.assignment.application, before.applications],
    [f.assignment.history, before.assignments],
    [f.inventory.vehicle, before.vehicles],
    [f.inventory.reservation, before.reservations],
    [f.inventory.history, before.history],
  ] as const) {
    // Assignment history is empty in this opt-in fixture; its generic authority
    // must still refuse insert even without a seeded target for update/delete.
    const original = originals.find((row) => row.tenant_id === 'northstar' && row.location_id !== f.inventoryRows.north.hiddenUnit);
    const { tenant_id: _owner, ...values } = original ?? { id: 'absent-assignment-history' };
    for (const [path, body] of [
      ['/api/insert', { table, values: { ...values, id: `inventory-bypass-${table}` } }],
      ['/api/update', { table, key: { id: values.id }, values: { name: 'Generic bypass' } }],
      ['/api/delete', { table, key: { id: values.id }, confirm: true }],
    ] as const) {
      denied(await client.data(path, c, body));
      assert.deepEqual(evidence(f), before);
    }
  }
  for (const [table, id, values] of [
    [f.inventory.vehicle, f.inventoryRows.north.vehicle, { status: 'available', version: 0 }],
    [
      f.inventory.reservation,
      f.inventoryRows.north.reservation,
      { status: 'released', version: 1, released_by: f.assignmentRows.north.manager },
    ],
  ] as const) {
    denied(await client.data('/api/update', c, { table, key: { id }, values }));
    assert.deepEqual(evidence(f), before);
  }
});

test('inventory: prepare is effect-free; hidden and missing roots refuse before receipt lookup without payload leaks', async (t) => {
  const f = await fixture(t),
    client = await login(f),
    c = await client.open(),
    n = f.inventoryRows.north,
    before = evidence(f);
  for (const input of [
    reserve(f),
    reserve(f, n.otherVehicle),
    reserve(f, n.unavailableVehicle),
    reserve(f, n.staleVehicle, f.rows.north.work, 'inventory-stale-prepare', 3),
    release(f),
    release(f, n.staleReservation, 'inventory-stale-release-prepare', 2),
    release(f, n.releasedReservation, 'inventory-released-prepare', 1),
  ]) {
    assert.deepEqual((await client.data('/api/commands/prepare', c, prepare(input))).body, { expectedVersion: input.expectedVersion });
    assert.equal((await client.data('/api/commands/status', c, input)).body.status, 'not_found');
    assert.deepEqual(evidence(f), before);
  }
  for (const [table, hidden] of [
    [f.inventory.vehicle, [f.inventoryRows.south.vehicle, 'missing-vehicle']],
    [f.inventory.reservation, [f.inventoryRows.south.reservation, n.hiddenReservation, 'missing-reservation']],
    [f.model.work, [n.hiddenLead]],
    [f.assignment.staff, [n.hiddenStaff]],
    [f.model.unit, [n.hiddenUnit]],
  ] as const) {
    for (const id of hidden) {
      assert.deepEqual(rows(await client.data('/api/query', c, { table, filter: filter('id', id) })), []);
      assert.equal((await client.data('/api/count', c, { table, filter: filter('id', id) })).body.count, 0);
      for (const path of ['/api/references', '/api/pages/plan'])
        denied(await client.data(path, c, path === '/api/references' ? { table, key: { id } } : { page: table, key: { id } }));
      if (table !== f.inventory.vehicle && table !== f.inventory.reservation) continue;
      const input = table === f.inventory.vehicle ? reserve(f, id) : release(f, id);
      for (const path of ['/api/commands/prepare', '/api/commands/execute', '/api/commands/status']) {
        const reply = await client.data(path, c, path.endsWith('prepare') ? prepare(input) : input);
        denied(reply);
        // Prepare has no delivery to reconcile. Execute/status must preserve
        // uncertainty because target admission precedes their receipt lookup.
        assert.deepEqual(
          { code: reply.body.code, outcome: reply.body.outcome },
          { code: 'forbidden', outcome: path.endsWith('prepare') ? 'not_applied' : 'unknown' },
        );
        for (const secret of [id, n.hiddenLead, n.hiddenStaff, n.hiddenUnit, 'Northstar private', 'Riverview']) {
          assert.ok(!JSON.stringify(reply.body).includes(secret), 'refusal leaked target or hidden dependency');
        }
        assert.deepEqual(evidence(f), before);
      }
    }
  }
});

test('inventory: reserve → release → reserve preserves prior rows, exact replay and all five result dependencies', async (t) => {
  const f = await fixture(t),
    client = await login(f),
    c = await client.open();
  let before = evidence(f);
  const firstInput = reserve(f),
    first = await client.data('/api/commands/execute', c, firstInput);
  const initial = committed(f, before, first, firstInput);
  before = initial.after;
  const releaseInput = release(f, initial.result.reservationId),
    released = await client.data('/api/commands/execute', c, releaseInput);
  const second = committed(f, before, released, releaseInput);
  before = second.after;
  const nextInput = reserve(f, firstInput.key.id, f.rows.north.work, 'inventory-new-allocation-0002', 2);
  const next = await client.data('/api/commands/execute', c, nextInput),
    third = committed(f, before, next, nextInput);
  assert.notEqual(third.result.reservationId, initial.result.reservationId);
  assert.deepEqual(
    third.after.reservations.find((row) => row.id === initial.result.reservationId),
    before.reservations.find((row) => row.id === initial.result.reservationId),
  );
  for (const [input, reply, result] of [
    [firstInput, first, initial.result],
    [releaseInput, released, second.result],
    [nextInput, next, third.result],
  ] as const) {
    const dependencies = [
      [f.inventory.vehicle, result.vehicleId],
      [f.inventory.reservation, result.reservationId],
      [f.inventory.history, result.historyId],
      [f.model.work, result.leadId],
      [f.assignment.staff, result.managerId],
    ] as const;
    assert.equal(dependencies.length, 5);
    for (const [table, id] of dependencies) {
      assert.deepEqual(ids(await client.data('/api/query', c, { table, filter: filter('id', id) })), [id]);
      await client.data('/api/pages/plan', c, { page: table, key: { id } });
    }
    for (const path of ['/api/commands/status', '/api/commands/execute']) {
      const replay = await client.data(path, c, input);
      assert.equal(replay.body.replayed, true);
      assert.equal(replay.body.receiptId, reply.body.receiptId);
      assert.deepEqual(replay.body.result, reply.body.result);
      assert.deepEqual(evidence(f), third.after);
    }
    for (const altered of [
      { ...input, input: { ...input.input, reason: 'Different payload' } },
      { ...input, expectedVersion: input.expectedVersion + 1 },
    ]) {
      const conflict = await client.data('/api/commands/execute', c, altered);
      denied(conflict);
      assert.equal(conflict.body.code, 'idempotency_conflict');
      assert.deepEqual(evidence(f), third.after);
    }
  }
  for (const version of [0, 1]) {
    const reply = await client.data(
      '/api/commands/execute',
      c,
      release(f, initial.result.reservationId, `inventory-old-allocation-${version}`, version),
    );
    denied(reply);
    assert.equal(reply.body.code, version === 0 ? 'stale_record' : 'ineligible_state');
    assert.equal(reply.body.outcome, 'not_applied');
    assert.deepEqual(evidence(f), third.after);
  }
  const plan = await client.data('/api/pages/plan', c, { page: f.inventory.vehicle, key: firstInput.key });
  for (const [table, expected] of [
    [f.inventory.reservation, third.after.reservations.filter((row) => row.vehicle_id === firstInput.key.id)],
    [f.inventory.history, third.after.history.filter((row) => row.vehicle_id === firstInput.key.id)],
  ] as const) {
    const related = objects(plan.body.plans).find((value) => value.kind === 'list' && object(value.view).base === table);
    assert.ok(related);
    const relatedRows = rows(await client.data('/api/view/run', c, { view: related.view }));
    assert.equal(relatedRows.length, expected.length);
    assert.deepEqual(relatedRows.map((row) => row.name).sort(), expected.map((row) => row.name).sort());
    const refs = objects((await client.data('/api/references', c, { table: f.inventory.vehicle, key: firstInput.key })).body.references);
    assert.ok(refs.some((ref) => ref.table === table && ref.count === expected.length));
  }
  assert.deepEqual(evidence(f), third.after);
});

test('inventory: stale versions, reserved/unavailable/inconsistent stock, incoherent and closed leads refuse atomically', async (t) => {
  const f = await fixture(t),
    client = await login(f),
    c = await client.open(),
    n = f.inventoryRows.north;
  const before = evidence(f);
  const attempts = [
    ['wrong vehicle version', { ...reserve(f), expectedVersion: 1 }, 'stale_record'],
    ['stale vehicle', reserve(f, n.staleVehicle), 'stale_record'],
    ['stale reservation', release(f, n.staleReservation), 'stale_record'],
    ['wrong reservation version', { ...release(f), expectedVersion: 1 }, 'stale_record'],
    ['reserved stock', reserve(f, n.reservedVehicle, f.rows.north.work, 'reserved-stock', 1), 'ineligible_state'],
    ['manual unavailable stock', reserve(f, n.unavailableVehicle), 'ineligible_state'],
    [
      'reserved without allocation',
      reserve(f, n.missingReservationVehicle, f.rows.north.work, 'missing-allocation', 1),
      'ineligible_state',
    ],
    ['visible active allocation on available stock', reserve(f, n.inconsistentVehicle), 'ineligible_state'],
    ['release inconsistent allocation', release(f, n.inconsistentReservation), 'ineligible_state'],
    ['released allocation', release(f, n.releasedReservation, 'already-released', 1), 'ineligible_state'],
    ['viewing another unit grants no manager authority', reserve(f, n.otherVehicle, f.rows.north.otherWork), 'forbidden'],
    ...[f.rows.north.otherWork, f.rows.south.work, n.hiddenLead, 'missing-lead'].map(
      (lead) => [`incoherent or hidden lead ${lead}`, reserve(f, n.vehicle, lead), 'forbidden'] as const,
    ),
  ] as const;
  for (const [index, [label, input, code]] of attempts.entries())
    await t.test(label, async () => {
      const reply = await client.data('/api/commands/execute', c, { ...input, idempotencyKey: `inventory-domain-refusal-${index}` });
      denied(reply);
      assert.deepEqual({ code: reply.body.code, outcome: reply.body.outcome }, { code, outcome: 'not_applied' });
      assert.deepEqual(evidence(f), before);
    });
  const closed = await client.data('/api/update', c, {
    table: f.model.work,
    key: { id: f.rows.north.work },
    expected: { status: 'open' },
    values: { status: 'closed' },
  });
  assert.equal(closed.body.affected, 1);
  const changed = evidence(f);
  assert.deepEqual(changed, {
    ...before,
    work: before.work.map((row) => (row.id === f.rows.north.work ? { ...row, status: 'closed' } : row)),
  });
  const reply = await client.data('/api/commands/execute', c, reserve(f));
  denied(reply);
  assert.deepEqual({ code: reply.body.code, outcome: reply.body.outcome }, { code: 'ineligible_state', outcome: 'not_applied' });
  assert.deepEqual(evidence(f), changed);
});

test('inventory: invisible active reservation forces uniqueness rollback after the visible vehicle update', async (t) => {
  const f = await fixture(t),
    client = await login(f),
    c = await client.open(),
    n = f.inventoryRows.north,
    before = evidence(f);
  const vehicle = before.vehicles.find((row) => row.id === n.hiddenReservationVehicle),
    hidden = before.reservations.find((row) => row.id === n.hiddenReservation);
  assert.ok(vehicle);
  assert.ok(hidden);
  assert.equal(vehicle.status, 'available');
  assert.equal(vehicle.version, 0);
  assert.equal(hidden.status, 'active');
  assert.equal(hidden.vehicle_id, vehicle.id);
  assert.equal(hidden.location_id, n.hiddenUnit);
  assert.deepEqual(
    rows(await client.data('/api/query', c, { table: f.inventory.reservation, filter: filter('vehicle_id', n.hiddenReservationVehicle) })),
    [],
  );
  assert.equal(
    (await client.data('/api/count', c, { table: f.inventory.reservation, filter: filter('vehicle_id', n.hiddenReservationVehicle) })).body
      .count,
    0,
  );
  const planned = await client.data('/api/pages/plan', c, { page: f.inventory.vehicle, key: { id: n.hiddenReservationVehicle } });
  const related = objects(planned.body.plans).find((plan) => plan.kind === 'list' && object(plan.view).base === f.inventory.reservation);
  assert.ok(related);
  assert.deepEqual(rows(await client.data('/api/view/run', c, { view: related.view })), []);
  const references = objects(
    (await client.data('/api/references', c, { table: f.inventory.vehicle, key: { id: n.hiddenReservationVehicle } })).body.references,
  );
  assert.ok(references.filter((ref) => ref.table === f.inventory.reservation).every((ref) => ref.count === 0));
  const input = reserve(f, n.hiddenReservationVehicle);
  assert.equal((await client.data('/api/commands/prepare', c, prepare(input))).body.expectedVersion, 0);
  for (let delivery = 0; delivery < 2; delivery++) {
    const reply = await client.data('/api/commands/execute', c, input);
    denied(reply);
    assert.equal(reply.status, 503);
    assert.deepEqual({ code: reply.body.code, outcome: reply.body.outcome }, { code: 'temporarily_unavailable', outcome: 'not_applied' });
    for (const value of [n.hiddenReservation, n.hiddenLead, n.hiddenStaff, n.hiddenUnit, 'UNIQUE', 'constraint', 'Northstar private']) {
      assert.ok(!JSON.stringify(reply.body).includes(value), 'hidden conflict disclosed private information');
    }
    assert.equal((await client.data('/api/commands/status', c, input)).body.status, 'not_found');
    assert.deepEqual(evidence(f), before);
  }
  // Use the actual installed DDL on an independent primitive table. This proves
  // tenant qualification and partial uniqueness without writing the live store.
  const source = new DatabaseSync(f.database, { readOnly: true });
  let index: string;
  try {
    index = String(source.prepare("SELECT sql FROM sqlite_schema WHERE name = 'physical_one_active_reservation'").get()?.sql);
  } finally {
    source.close();
  }
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE physical_vehicle_reservation (tenant_id TEXT NOT NULL, vehicle_id TEXT NOT NULL, status TEXT NOT NULL)');
    db.exec(index);
    const insert = db.prepare('INSERT INTO physical_vehicle_reservation VALUES (?,?,?)');
    insert.run('northstar', 'same-opaque-vehicle', 'active');
    insert.run('riverview', 'same-opaque-vehicle', 'active');
    for (const tenant of ['northstar', 'riverview']) {
      assert.throws(() => insert.run(tenant, 'same-opaque-vehicle', 'active'), /UNIQUE constraint failed/);
      insert.run(tenant, 'same-opaque-vehicle', 'released');
      insert.run(tenant, 'same-opaque-vehicle', 'released');
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM physical_vehicle_reservation').get()?.count, 6);
  } finally {
    db.close();
  }
  assert.deepEqual(evidence(f), before);
});
