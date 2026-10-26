import assert from 'node:assert/strict';
import { test } from 'node:test';
import { denied, fixture, login, evidence, reserve, release, prepare, committed } from './support/tenantInventoryHarness.js';

for (const mode of ['reserve', 'release'] as const) {
  test(`inventory: concurrent ${mode} duplicate delivery and distinct attempts have exactly one effect`, async (t) => {
    const f = await fixture(t),
      client = await login(f),
      north = await client.open(),
      south = await client.open('riverview');
    const input = mode === 'reserve' ? reserve(f) : release(f),
      before = evidence(f);
    const deliveries = await Promise.all([
      client.data('/api/commands/execute', north, input),
      client.data('/api/commands/execute', north, input),
    ]);
    assert.deepEqual(deliveries.map((reply) => reply.body.replayed).sort(), [false, true]);
    assert.equal(deliveries[0].body.receiptId, deliveries[1].body.receiptId);
    assert.deepEqual(deliveries[0].body.result, deliveries[1].body.result);
    const { after } = committed(f, before, deliveries[0], input);
    const base =
      mode === 'reserve' ? reserve(f, f.inventoryRows.south.vehicle, f.rows.south.work) : release(f, f.inventoryRows.south.reservation);
    const attempts = ['first', 'second'].map((name) => ({ ...base, idempotencyKey: `inventory-${mode}-race-${name}` }));
    for (const attempt of attempts)
      assert.equal((await client.data('/api/commands/prepare', south, prepare(attempt))).body.expectedVersion, 0);
    const replies = await Promise.all(attempts.map((attempt) => client.data('/api/commands/execute', south, attempt)));
    const winners = replies.map((reply, index) => ({ reply, index })).filter(({ reply }) => reply.body.status === 'applied');
    assert.equal(winners.length, 1);
    const winner = winners[0],
      loser = 1 - winner.index;
    denied(replies[loser]);
    assert.equal(replies[loser].body.code, 'stale_record');
    assert.equal(replies[loser].body.outcome, 'not_applied');
    const saved = committed(f, after, winner.reply, attempts[winner.index], 'riverview', f.assignmentRows.south.manager).after;
    assert.equal((await client.data('/api/commands/status', south, attempts[loser])).body.status, 'not_found');
    const recovered = await client.data('/api/commands/status', south, attempts[winner.index]);
    assert.equal(recovered.body.receiptId, winner.reply.body.receiptId);
    assert.deepEqual(evidence(f), saved);
  });

  test(`inventory: ${mode} rejects strict input/envelope forgeries and accepts the exact 500-character reason bound`, async (t) => {
    const f = await fixture(t),
      client = await login(f),
      c = await client.open(),
      input = mode === 'reserve' ? reserve(f) : release(f),
      before = evidence(f);
    const forged = [
      ...['', '   ', 'x'.repeat(501), null, 7].map((reason) => ({ ...input, input: { ...input.input, reason } })),
      ...[
        'actorId',
        'managerId',
        'staffId',
        'reserved_by',
        'released_by',
        'tenantId',
        'tenant_id',
        'vehicleVersion',
        'reservationVersion',
      ].map((field) => ({ ...input, input: { ...input.input, [field]: f.assignmentRows.south.manager } })),
      ...['actorId', 'accountId', 'tenantId', 'tenant_id', 'source'].map((field) => ({ ...input, [field]: f.accounts.manager.id })),
      { ...input, commandVersion: 2 },
      { ...input, expectedVersion: -1 },
      { ...input, expectedVersion: '0' },
      { ...input, key: { id: input.key.id, tenant_id: 'northstar' } },
      { ...input, key: { stock_reference: 'STOCK-001' } },
      { ...input, input: mode === 'reserve' ? { lead: input.input.lead } : {} },
      ...(mode === 'reserve'
        ? ['', ' ', 7, null, { id: f.rows.north.work }].map((lead) => ({ ...input, input: { ...input.input, lead } }))
        : [
            { ...input, input: { ...input.input, lead: f.rows.north.work } },
            { ...input, input: { ...input.input, reservation: input.key.id } },
          ]),
    ];
    for (const value of forged) {
      denied(await client.data('/api/commands/execute', c, value));
      assert.deepEqual(evidence(f), before);
    }
    const bounded = { ...input, input: { ...input.input, reason: 'x'.repeat(500) } };
    committed(f, before, await client.data('/api/commands/execute', c, bounded), bounded);
  });

  test(`inventory: ${mode} rechecks lead coherence after prepare and restoration permits the original attempt`, async (t) => {
    const f = await fixture(t),
      client = await login(f),
      c = await client.open(),
      input = mode === 'reserve' ? reserve(f) : release(f);
    const before = evidence(f);
    assert.equal((await client.data('/api/commands/prepare', c, prepare(input))).body.expectedVersion, 0);
    const move = async (from: string, to: string) => {
      const reply = await client.data('/api/update', c, {
        table: f.model.work,
        key: { id: f.rows.north.work },
        expected: { location_id: from },
        values: { location_id: to },
      });
      assert.equal(reply.body.affected, 1);
    };
    await move(f.rows.north.unit, f.rows.north.otherUnit);
    const changed = evidence(f);
    assert.deepEqual(changed, {
      ...before,
      work: before.work.map((row) => (row.id === f.rows.north.work ? { ...row, location_id: f.rows.north.otherUnit } : row)),
    });
    const refused = await client.data('/api/commands/execute', c, input);
    denied(refused);
    assert.deepEqual({ code: refused.body.code, outcome: refused.body.outcome }, { code: 'forbidden', outcome: 'not_applied' });
    assert.deepEqual(evidence(f), changed);
    await move(f.rows.north.otherUnit, f.rows.north.unit);
    assert.deepEqual(evidence(f), before);
    committed(f, before, await client.data('/api/commands/execute', c, input), input);
  });

  test(`inventory: ${mode} checks current manager activity and business role after prepare on the writer`, async (t) => {
    const f = await fixture(t),
      client = await login(f),
      c = await client.open(),
      input = mode === 'reserve' ? reserve(f) : release(f);
    const before = evidence(f),
      manager = f.assignmentRows.north.manager;
    for (const state of [{ active: 0 as const }, { role: 'clerk' as const }, { role: 'reviewer' as const }]) {
      assert.equal((await client.data('/api/commands/prepare', c, prepare(input))).body.expectedVersion, 0);
      await f.setStaffState(manager, state);
      const changed = evidence(f);
      assert.deepEqual(changed, { ...before, staff: before.staff.map((row) => (row.id === manager ? { ...row, ...state } : row)) });
      const reply = await client.data('/api/commands/execute', c, input);
      denied(reply);
      assert.equal(reply.body.code, 'forbidden');
      assert.equal(reply.body.outcome, 'not_applied');
      assert.deepEqual(evidence(f), changed);
      await f.setStaffState(manager, { active: 1, role: 'manager' });
      assert.deepEqual(evidence(f), before);
    }
    committed(f, before, await client.data('/api/commands/execute', c, input), input);
  });

  test(`inventory: historical ${mode} manager deactivation denies exact receipt and replay until visible again`, async (t) => {
    const f = await fixture(t),
      client = await login(f),
      c = await client.open(),
      input = mode === 'reserve' ? reserve(f) : release(f);
    const first = await client.data('/api/commands/execute', c, input);
    assert.equal(first.body.status, 'applied');
    await f.setStaffState(f.assignmentRows.north.manager, { active: 0 });
    const changed = evidence(f),
      fresh = await client.open();
    for (const context of [c, fresh])
      for (const path of ['/api/commands/status', '/api/commands/execute']) {
        denied(await client.data(path, context, input));
        assert.deepEqual(evidence(f), changed);
      }
    await f.setStaffState(f.assignmentRows.north.manager, { active: 1 });
    const restored = evidence(f);
    for (const path of ['/api/commands/status', '/api/commands/execute']) {
      const reply = await client.data(path, fresh, input);
      assert.equal(reply.body.replayed, true);
      assert.equal(reply.body.receiptId, first.body.receiptId);
      assert.deepEqual(reply.body.result, first.body.result);
      assert.deepEqual(evidence(f), restored);
    }
  });
}
