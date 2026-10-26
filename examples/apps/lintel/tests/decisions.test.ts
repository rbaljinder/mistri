/**
 * The routing decision (jobs.ts `routeRepair`) on a scripted model: its clock
 * asks about each new repair nobody has picked up, as the repair-triage
 * service and through the row policy's rows for it. It only suggests, so the
 * office sees the technician on the repair's field and nothing is written; a
 * resident asking about a neighbor's repair is refused, as its history is.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startLintel, type Lintel } from './start.ts';

let lintel: Lintel;
let technician = 0;
before(async () => {
  lintel = await startLintel({
    decisions: (staff) => {
      technician = staff.technician;
      return {
        model: 'scripted-router',
        modelVersion: 'scripted-router-1',
        decisions: { routeRepair: [{ answer: staff.technician, probability: 0.8 }] },
      };
    },
  });
});
after(() => lintel?.close());

type Waiting = { id: number; resident_id: number };
const waiting = () =>
  lintel.rows<Waiting>(`SELECT id, resident_id FROM maintenance_request WHERE status = 'new' AND assigned_to IS NULL ORDER BY id`);
type Decided = { record_key: string; outcome: string; outcome_reason: string; answer: string };
const decided = () =>
  lintel.rows<Decided>(`SELECT record_key, outcome, outcome_reason, answer FROM "__mistri_decision_record" WHERE decision = 'routeRepair'`);

test('the clock suggests a technician for each new repair; the office sees it, nothing is written, a neighbor is refused', async () => {
  // One the test makes too, so the clock always has a repair to ask about, whatever the seed's day left new.
  const resident = await lintel.as('resident');
  const reported = await resident.command(
    'reportIssue',
    {},
    { title: 'Kitchen tap drips', category: 'plumbing', description: 'A steady drip from the cold tap.', urgent: false, entry_ok: true },
  );
  assert.ok(reported.ok, JSON.stringify(reported));
  const due = waiting();
  assert.ok(due.length > 0);

  const run = await lintel.host.runJob('decide-routeRepair', { timeoutMs: 60_000 });
  assert.equal(run.state, 'succeeded', JSON.stringify(run));
  const deadline = Date.now() + 30_000;
  while (decided().filter((row) => row.outcome_reason !== 'pending').length < due.length) {
    assert.ok(Date.now() < deadline, `the clock did not settle: ${JSON.stringify(decided())}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  for (const repair of due) {
    const row = decided().find((each) => JSON.parse(each.record_key).id === repair.id);
    assert.equal(row?.outcome, 'suggested', JSON.stringify(row));
  }

  const manager = await lintel.as('manager');
  const [first] = due;
  const asked = await manager.request('/api/record-decisions', {
    method: 'POST',
    json: { table: 'maintenance_request', key: { id: first.id } },
  });
  assert.equal(asked.status, 200, await asked.clone().text());
  const { suggestions } = (await asked.json()) as { suggestions: Array<{ field: string; answer: unknown; filled: boolean }> };
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].field, 'assigned_to');
  assert.equal(suggestions[0].answer, technician);
  assert.equal(suggestions[0].filled, false);

  // Suggest-only: the field is still the office's to fill.
  assert.deepEqual(
    due.map(
      (repair) => lintel.rows<{ assigned_to: number | null }>(`SELECT assigned_to FROM maintenance_request WHERE id = ?`, repair.id)[0],
    ),
    due.map(() => ({ assigned_to: null })),
  );

  // A neighbor's repair, a suggestion waiting on it or not: a resident reads no record outside their household.
  const neighbor =
    due.find((repair) => repair.resident_id !== lintel.resident.id) ??
    lintel.rows<Waiting>(
      `SELECT id, resident_id FROM maintenance_request WHERE resident_id != ? ORDER BY id LIMIT 1`,
      lintel.resident.id,
    )[0];
  const refused = await resident.request('/api/record-decisions', {
    method: 'POST',
    json: { table: 'maintenance_request', key: { id: neighbor.id } },
  });
  assert.equal(refused.status, 403, await refused.clone().text());
});
