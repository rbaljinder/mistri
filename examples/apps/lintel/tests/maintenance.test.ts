/**
 * A repair's road through the App's API: the desk books a visit with a
 * technician, the technician starts it, the parts used come off the
 * storeroom's shelf (and a take past zero is refused whole), and completing it
 * mails the resident — account or not — only while they agreed to mail.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { assertApplied } from '@mistriwork/mistri/testing';
import { emailOf, startLintel, type Lintel } from './start.ts';

let lintel: Lintel;
before(async () => {
  lintel = await startLintel();
});
after(() => lintel?.close());

const statusOf = (id: number) => lintel.rows<{ status: string }>(`SELECT status FROM maintenance_request WHERE id = ?`, id)[0].status;

test('the desk books a visit, the technician starts and completes it, and the resident hears by email', async () => {
  const manager = await lintel.as('manager');
  const technician = await lintel.as('technician');
  /* A new repair from a resident who agreed to mail and who has no account: the mail goes to the address on their
     record. */
  const repair = lintel.rows<{ id: number; email: string }>(
    `SELECT m.id AS id, r.email AS email FROM maintenance_request m JOIN resident r ON r.id = m.resident_id
      WHERE m.status = 'new' AND r.email_ok = 1 AND r.email != 'resident@example.test' ORDER BY m.id LIMIT 1`,
  )[0];
  const tech = lintel.rows<{ id: number }>(`SELECT id FROM staff WHERE email = ?`, emailOf('technician'))[0];
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

  const mailedBefore = (await lintel.mail()).length;
  const booked = await manager.command('scheduleVisit', { id: repair.id }, { technician: tech.id, visit_on: today });
  assert.ok(booked.ok, JSON.stringify(booked));
  /* The technician hears by email, linked to the repair at the address their own browser says: the office's
     Repairs list, not the residents' My repairs that comes first in the menu. */
  const visit = await lintel.mailed((line) => line.includes(emailOf('technician')) && line.includes('Visit booked'), mailedBefore);
  assert.ok(visit, `mailed the technician: ${(await lintel.mail()).slice(mailedBefore).join('\n').slice(0, 800)}`);
  assert.match(visit, new RegExp(`/repairs/${repair.id}(?![0-9])`));
  assert.doesNotMatch(visit, /\/my-requests\//);
  assert.equal(statusOf(repair.id), 'scheduled');
  assert.equal(
    lintel.rows<{ assigned_to: number }>(`SELECT assigned_to FROM maintenance_request WHERE id = ?`, repair.id)[0].assigned_to,
    tech.id,
  );

  assertApplied(await technician.act('maintenance_request', 'start', { where: `id = ${repair.id}` }));
  assert.equal(statusOf(repair.id), 'in_progress');

  const before = (await lintel.mail()).length;
  const done = await technician.command(
    'completeRequest',
    { id: repair.id },
    { resolution: 'Replaced the cartridge and tested the flow.' },
  );
  assert.ok(done.ok, JSON.stringify(done));
  assert.equal(statusOf(repair.id), 'completed');
  const sent = await lintel.mailed((line) => line.includes(repair.email) && line.includes('Your repair is done'), before);
  assert.ok(sent, `mailed ${repair.email}: ${(await lintel.mail()).slice(before).join('\n').slice(0, 800)}`);
});

test('a resident who said no to mail is not mailed when their repair is done', async () => {
  const leasing = await lintel.as('leasing');
  const technician = await lintel.as('technician');
  const repair = lintel.rows<{ id: number; resident: number; email: string }>(
    `SELECT m.id AS id, r.id AS resident, r.email AS email FROM maintenance_request m JOIN resident r ON r.id = m.resident_id
      WHERE m.status = 'in_progress' AND r.email != 'resident@example.test' ORDER BY m.id LIMIT 1`,
  )[0];
  // They say so to the office, which unticks it on their record.
  const unticked = await leasing.update('resident', { id: repair.resident }, { email_ok: false });
  assert.ok(unticked.ok, JSON.stringify(unticked));
  const before = (await lintel.mail()).length;
  const done = await technician.command('completeRequest', { id: repair.id }, { resolution: 'Reset the breaker; all outlets live.' });
  assert.ok(done.ok, JSON.stringify(done));
  assert.equal(statusOf(repair.id), 'completed');
  // Given the time a mail that was sent takes to arrive, none does.
  assert.equal(await lintel.mailed((line) => line.includes(repair.email), before, 10_000), undefined);
});

test('a part used comes off the shelf, and a take past what is there is refused whole', async () => {
  const technician = await lintel.as('technician');
  const line = lintel.rows<{ id: number; part_id: number; quantity: number; on_hand: number }>(
    `SELECT rp.id AS id, rp.part_id AS part_id, rp.quantity AS quantity, p.on_hand AS on_hand
       FROM request_part rp JOIN maintenance_request m ON m.id = rp.request_id JOIN part p ON p.id = rp.part_id
      WHERE m.status IN ('scheduled', 'in_progress', 'on_hold') AND p.on_hand > 0 ORDER BY rp.id LIMIT 1`,
  )[0];
  assert.ok(line, 'the seed logs a part on a repair still on site');
  const shelf = () => lintel.rows<{ on_hand: number }>(`SELECT on_hand FROM part WHERE id = ?`, line.part_id)[0].on_hand;

  const one = await technician.update('request_part', { id: line.id }, { quantity: line.quantity + 1 });
  assert.ok(one.ok, JSON.stringify(one));
  assert.equal(shelf(), line.on_hand - 1);

  const greedy = await technician.update('request_part', { id: line.id }, { quantity: line.quantity + line.on_hand + 5 });
  assert.equal(greedy.ok, false);
  assert.match(greedy.ok ? '' : greedy.message, /left in the storeroom/);
  assert.equal(shelf(), line.on_hand - 1, 'nothing moved');
  assert.equal(lintel.rows<{ quantity: number }>(`SELECT quantity FROM request_part WHERE id = ?`, line.id)[0].quantity, line.quantity + 1);
});

test('a part is logged only on a repair still on site', async () => {
  const technician = await lintel.as('technician');
  const line = lintel.rows<{ id: number; quantity: number }>(
    `SELECT rp.id AS id, rp.quantity AS quantity FROM request_part rp JOIN maintenance_request m ON m.id = rp.request_id
      WHERE m.status IN ('completed', 'closed') ORDER BY rp.id LIMIT 1`,
  )[0];
  const late = await technician.update('request_part', { id: line.id }, { quantity: line.quantity + 1 });
  assert.equal(late.ok, false);
  assert.match(late.ok ? '' : JSON.stringify(late.body), /while the repair is scheduled or in progress/);
});

test('an internal note stays with the office', async () => {
  const technician = await lintel.as('technician');
  const resident = await lintel.as('resident');
  const repair = lintel.rows<{ id: number }>(
    `SELECT id FROM maintenance_request WHERE resident_id = ? AND status NOT IN ('closed', 'cancelled') ORDER BY id LIMIT 1`,
    lintel.resident.id,
  )[0];
  assert.ok(repair, 'the resident has a repair still open');
  const noted = await technician.command('addNote', { id: repair.id }, { body: 'Check the shutoff under the sink first.' });
  assert.ok(noted.ok, JSON.stringify(noted));
  const theirs = await resident.rows('request_note', { where: `request_id = ${repair.id}`, limit: 100 });
  assert.ok(theirs.ok);
  assert.ok(!theirs.value.some((note) => String(note.body).includes('shutoff under the sink')));
  const office = await technician.rows('request_note', { where: `request_id = ${repair.id}`, limit: 100 });
  assert.ok(office.ok && office.value.some((note) => note.kind === 'internal'));
});

test('the manager and the admin cancel a repair by command, its reason written to its resolution', async () => {
  /* Cancel request is the command cancelRequest, granted to the desk alone: a technician, who moves a repair by its
     status, is neither offered it nor let run it (permissions.test.ts). */
  const open = lintel.rows<{ id: number }>(`SELECT id FROM maintenance_request WHERE status IN ('new', 'triaged') ORDER BY id LIMIT 2`);
  assert.equal(open.length, 2, 'the seed has two repairs not yet booked');
  for (const [role, repair] of [
    ['manager', open[0]],
    ['admin', open[1]],
  ] as const) {
    const desk = await lintel.as(role);
    const reason = `Withdrawn by the resident (${role}).`;
    const done = await desk.command('cancelRequest', { id: repair.id }, { resolution: reason });
    assert.ok(done.ok, JSON.stringify(done));
    assert.equal(statusOf(repair.id), 'cancelled');
    assert.equal(
      lintel.rows<{ resolution: string }>(`SELECT resolution FROM maintenance_request WHERE id = ?`, repair.id)[0].resolution,
      reason,
    );
  }
});
