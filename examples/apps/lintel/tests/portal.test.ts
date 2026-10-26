/**
 * The resident portal through the App's API: a resident reports a problem on
 * their own home and reads it back, writes to the office on it, and cannot
 * write on a neighbor's. Their home is the portal dashboard.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startLintel, type Lintel } from './start.ts';

let lintel: Lintel;
before(async () => {
  lintel = await startLintel();
});
after(() => lintel?.close());

test('a resident starts on their portal', async () => {
  const resident = await lintel.as('resident');
  const { home } = await resident.views();
  assert.equal(home, 'portal');
});

test('a resident reports a problem on their own home, and the office hears it', async () => {
  const resident = await lintel.as('resident');
  const reported = await resident.command(
    'reportIssue',
    {},
    {
      title: 'Bathroom fan rattles',
      category: 'electrical',
      description: 'Loud rattle when it runs, since Tuesday.',
      urgent: false,
      entry_ok: true,
    },
  );
  assert.ok(reported.ok, JSON.stringify(reported));
  const { requestId } = reported.value.result as { requestId: string };
  const row = lintel.rows<{ unit_id: number; resident_id: number; status: string; entry_ok: number }>(
    `SELECT unit_id, resident_id, status, entry_ok FROM maintenance_request WHERE id = ?`,
    Number(requestId),
  );
  assert.deepEqual(row, [{ unit_id: lintel.resident.unit, resident_id: lintel.resident.id, status: 'new', entry_ok: 1 }]);
  const mine = await resident.rows('maintenance_request', { where: `id = ${requestId}` });
  assert.ok(mine.ok && mine.value.length === 1, 'they read what they reported');

  const messaged = await resident.command('messageOffice', { id: Number(requestId) }, { body: 'It is worse at night.' });
  assert.ok(messaged.ok, JSON.stringify(messaged));
  const said = lintel.rows<{ kind: string; author: string }>(
    `SELECT kind, author FROM request_note WHERE request_id = ? AND body = 'It is worse at night.'`,
    Number(requestId),
  );
  assert.equal(said.length, 1);
  assert.equal(said[0].kind, 'resident');
});

test('a resident who wants to be home for the visit says which day and part of it, and the office reads that first', async () => {
  const resident = await lintel.as('resident');
  const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const base = {
    title: 'Oven will not heat',
    category: 'appliance',
    description: 'Cold after ten minutes.',
    urgent: true,
    entry_ok: false,
  };
  const reported = await resident.command('reportIssue', {}, { ...base, visit_on: tomorrow, visit_window: 'afternoon' });
  assert.ok(reported.ok, JSON.stringify(reported));
  const { requestId } = reported.value.result as { requestId: string };
  const made = lintel.rows<{ priority: string; entry_ok: number }>(
    `SELECT priority, entry_ok FROM maintenance_request WHERE id = ?`,
    Number(requestId),
  );
  assert.deepEqual(made, [{ priority: 'urgent', entry_ok: 0 }]);
  const notes = lintel.rows<{ kind: string; body: string }>(`SELECT kind, body FROM request_note WHERE request_id = ?`, Number(requestId));
  assert.deepEqual(notes, [{ kind: 'resident', body: `I’d like to be home for the visit: ${tomorrow}, afternoon, noon to 5.` }]);

  // The window is asked when entry is not allowed, and only then: leaving it out is refused, and so is a window nobody asked for.
  const missing = await resident.command('reportIssue', {}, base);
  assert.equal(missing.ok, false);
  const unasked = await resident.command('reportIssue', {}, { ...base, entry_ok: true, visit_on: tomorrow, visit_window: 'morning' });
  assert.equal(unasked.ok, false);
  const gone = await resident.command('reportIssue', {}, { ...base, visit_on: '2020-01-01', visit_window: 'morning' });
  assert.equal(gone.ok, false);
});

test('a resident cannot write on a neighbor’s repair', async () => {
  const resident = await lintel.as('resident');
  const theirs = lintel.rows<{ id: number }>(
    `SELECT id FROM maintenance_request WHERE resident_id != ? AND status NOT IN ('closed', 'cancelled') ORDER BY id LIMIT 1`,
    lintel.resident.id,
  )[0];
  const refused = await resident.command('messageOffice', { id: theirs.id }, { body: 'Hello from next door.' });
  assert.equal(refused.ok, false);
  assert.deepEqual(lintel.rows(`SELECT id FROM request_note WHERE body = 'Hello from next door.'`), []);
});

test('the office does not report as a resident', async () => {
  // The leasing desk's account holds no resident row: reportIssue is not granted to it at all.
  const leasing = await lintel.as('leasing');
  const refused = await leasing.command('reportIssue', {}, { title: 'Test', category: 'general', description: 'Nothing.' });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 403);
});
