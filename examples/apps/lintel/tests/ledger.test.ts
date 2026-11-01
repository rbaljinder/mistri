/**
 * The ledger, through the App's API: the month's rent posted once however
 * often it is asked, a payment the desk takes, a one-off charge, and the
 * late-fee workflow on a clock the test moves. Money is whole cents from the
 * database to the result.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createWorkflowDriver } from '@mistriwork/mistri/testing';
import { rentPosted } from '../events.ts';
import { graceEnds, lateFees } from '../late-fees.ts';
import { day, period as periodOf } from '../source.ts';
import { startLintel, type Lintel } from './start.ts';

let lintel: Lintel;
before(async () => {
  lintel = await startLintel();
});
after(() => lintel?.close());

/** The month after this one, as the ledger names a month. */
function nextMonth() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return next.toISOString().slice(0, 7);
}

test('rent is posted once for a month, however often it is asked', async () => {
  const manager = await lintel.as('manager');
  const period = nextMonth();
  const first = await manager.command('postRent', {}, { period });
  assert.ok(first.ok, JSON.stringify(first));
  const said = first.value.result as { posted: number; period: string; dueOn: string };
  assert.equal(said.period, period);
  assert.equal(said.dueOn, `${period}-01`);
  assert.ok(said.posted > 0, 'some lease runs into next month');

  const again = await manager.command('postRent', {}, { period });
  assert.ok(again.ok);
  assert.equal((again.value.result as { posted: number }).posted, 0);

  const rows = lintel.rows<{ n: number; leases: number; cents: number }>(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT lease_id) AS leases, SUM(amount) AS cents FROM charge WHERE kind = 'rent' AND period = ?`,
    period,
  )[0];
  assert.equal(rows.n, said.posted);
  assert.equal(rows.leases, said.posted, 'one rent a lease');
  // Each is the lease's rent, to the cent.
  const off = lintel.rows(
    `SELECT c.id FROM charge c JOIN lease l ON l.id = c.lease_id WHERE c.kind = 'rent' AND c.period = ? AND c.amount != l.rent`,
    period,
  );
  assert.deepEqual(off, []);
});

test('the rent poster posts this month at its slot, as its service, and a second run posts none', async () => {
  const run = await lintel.host.runJob('postRent');
  assert.equal(run.state, 'succeeded', JSON.stringify(run));
  const again = await lintel.host.runJob('postRent');
  assert.equal(again.state, 'succeeded', JSON.stringify(again));
  // The poster reads "this month" on Denver's wall clock (its job's zone), which is still the old month for
  // the first hours of a UTC month; the test must read it the same way.
  const period = periodOf(day(() => new Date()));
  const [{ n, leases }] = lintel.rows<{ n: number; leases: number }>(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT lease_id) AS leases FROM charge WHERE kind = 'rent' AND period = ?`,
    period,
  );
  assert.ok(n > 0 && n === leases, `one rent a lease for ${period}: ${n} for ${leases}`);
  await assert.rejects(lintel.host.runJob('lateFees'), /not one of this App's jobs at times \("postRent", "decide-routeRepair"\)/);
});

test('the accountant records a payment, which pays the charge in full', async () => {
  const accountant = await lintel.as('accountant');
  const charge = lintel.rows<{ id: number; amount: number; lease_id: number }>(
    `SELECT id, amount, lease_id FROM charge WHERE status = 'open' ORDER BY id LIMIT 1`,
  )[0];
  const paid = await accountant.command('recordPayment', { id: charge.id }, { method: 'check', reference: '1042' });
  assert.ok(paid.ok, JSON.stringify(paid));
  assert.equal(lintel.rows<{ status: string }>(`SELECT status FROM charge WHERE id = ?`, charge.id)[0].status, 'paid');
  const payment = lintel.rows<{ amount: number; reference: string; lease_id: number }>(
    `SELECT amount, reference, lease_id FROM payment WHERE charge_id = ?`,
    charge.id,
  );
  assert.deepEqual(payment, [{ amount: charge.amount, reference: 'CHECK-1042', lease_id: charge.lease_id }]);
  // Paid is final: a second payment on it is refused by the charge's machine.
  const twice = await accountant.command('recordPayment', { id: charge.id }, { method: 'cash' });
  assert.equal(twice.ok, false);
  assert.equal(lintel.rows(`SELECT id FROM payment WHERE charge_id = ?`, charge.id).length, 1);
});

test('a one-off charge goes on a current lease in cents, and never on an ended one', async () => {
  const accountant = await lintel.as('accountant');
  const lease = lintel.rows<{ id: number }>(`SELECT id FROM lease WHERE status = 'active' ORDER BY id LIMIT 1`)[0];
  const charged = await accountant.command(
    'addCharge',
    { id: lease.id },
    { kind: 'repair', description: 'Replaced a lost key fob', amount: 45.5, due_on: '2030-01-15' },
  );
  assert.ok(charged.ok, JSON.stringify(charged));
  const row = lintel.rows<{ amount: number; status: string }>(
    `SELECT amount, status FROM charge WHERE lease_id = ? AND description = 'Replaced a lost key fob'`,
    lease.id,
  );
  assert.deepEqual(row, [{ amount: 4550, status: 'open' }]);

  const ended = lintel.rows<{ id: number }>(`SELECT id FROM lease WHERE status = 'ended' ORDER BY id LIMIT 1`)[0];
  const refused = await accountant.command(
    'addCharge',
    { id: ended.id },
    { kind: 'other', description: 'Too late', amount: 10, due_on: '2030-01-15' },
  );
  assert.equal(refused.ok, false);
});

test('late fees are assessed once, after the grace days, for each month posted', async () => {
  const assessed: unknown[] = [];
  const period = '2026-11';
  const dueOn = `${period}-01`;
  const driver = await createWorkflowDriver({
    workflow: { lateFees },
    commands: {
      assessLateFees: ({ input }) => {
        assessed.push(input);
        return { message: 'Assessed.' };
      },
    },
    start: '2026-11-01T13:00:00.000Z',
  });
  try {
    await driver.emit(rentPosted, { period, dueOn, posted: 40 });
    // The job retried, or the desk pressed Post rent after it: the same month is one sequence.
    await driver.emit(rentPosted, { period, dueOn, posted: 0 });
    assert.equal((await driver.instances()).length, 1);

    const wait = graceEnds(dueOn).getTime() - driver.now();
    await driver.advance(wait - 60_000);
    assert.equal(driver.executed('assessLateFees'), 0, 'not a minute early');
    await driver.advance(120_000);
    assert.equal(driver.executed('assessLateFees'), 1);
    assert.deepEqual(assessed, [{ period }]);
  } finally {
    await driver.close();
  }
});

test('no person runs the late-fee step: it is the rent poster’s', async () => {
  const manager = await lintel.as('manager');
  // The workflow's command is a service's: no person is granted it.
  const asked = await manager.command('assessLateFees', {}, { period: nextMonth() });
  assert.equal(asked.ok, false);
  assert.equal(asked.status, 403);
});
