/**
 * Who may do what, in two halves.
 *
 * The matrix: every person's role × resource and command, allowed or refused
 * as authority.lock says — the server refuses to start an App whose grants
 * differ from it, so the lock is read here rather than copied. An allowed read
 * answers rows, an allowed write saves a record's own value back, an allowed
 * command prepares, which changes nothing; a refused write or command answers
 * 403. A table a role may not read is not in its catalog at all: a query
 * naming it is answered as one naming no table, which is how the matrix reads
 * a refused read.
 *
 * The rows: what the policy (policy.ts) lets each reader reach inside a table
 * the role may read — a resident their own household and nothing else, a
 * technician no money, a signed-out visitor the listings.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { assertPermissions, type PermissionCase } from '@mistriwork/mistri/testing';
import { appSource, ROLES, startLintel, type Lintel } from './start.ts';

let lintel: Lintel;
before(async () => {
  lintel = await startLintel();
});
after(() => lintel?.close());

const COMMANDS: Record<string, string | undefined> = {
  signLease: 'lease',
  giveNotice: 'lease',
  endLease: 'lease',
  addCharge: 'lease',
  recordPayment: 'charge',
  scheduleVisit: 'maintenance_request',
  completeRequest: 'maintenance_request',
  cancelRequest: 'maintenance_request',
  replyToResident: 'maintenance_request',
  addNote: 'maintenance_request',
  messageOffice: 'maintenance_request',
  postRent: undefined,
  reportIssue: undefined,
};
/* The column a write saves back: one the role's grant leaves it where it writes. */
const WRITTEN: Record<string, string> = {
  property: 'name',
  property_photo: 'position',
  unit: 'market_rent',
  resident: 'phone',
  staff: 'phone',
  lease: 'end_on',
  charge: 'description',
  payment: 'reference',
  maintenance_request: 'title',
  request_part: 'quantity',
  request_note: 'body',
  part: 'name',
  part_receipt: 'vendor',
  viewing: 'preferred_on',
};

const lock = () => readFileSync(new URL('authority.lock', `file://${appSource.endsWith('/') ? appSource : `${appSource}/`}`), 'utf8');
const holds = (role: string, kind: string, what: string) => lock().includes(`\nrole ${role} ${kind} ${what} —`);
const tables = () => [...new Set([...lock().matchAll(/^resource (\w+) access/gm)].map((match) => match[1]))].concat('staff');

function matrix(): PermissionCase[] {
  const cases: PermissionCase[] = [];
  for (const role of ROLES) {
    for (const table of tables()) cases.push({ role, read: table, allowed: holds(role, 'read', table) });
    for (const table of tables()) {
      const allowed = holds(role, 'write', table);
      /* A technician moves a repair only along its machine's verbs, and a part used is logged only on a repair still
         open (resources.ts): maintenance.test.ts writes both on records in that state. */
      if (allowed && ((role === 'technician' && table === 'maintenance_request') || table === 'request_part')) continue;
      cases.push({ role, write: table, allowed, column: WRITTEN[table] });
    }
    for (const [command, on] of Object.entries(COMMANDS)) {
      const allowed = holds(role, 'command', command);
      // A resident's command runs on their own repair, which the matrix's sample is not: portal.test.ts runs it.
      if (allowed && role === 'resident' && on) continue;
      cases.push({ role, command, allowed, ...(on ? { on } : {}) });
    }
  }
  return cases;
}

test('each role may do what authority.lock grants it, and is refused the rest', async () => {
  await assertPermissions({ as: lintel.as, client: lintel.anonymous }, matrix());
});

test('a matrix row that is wrong fails it: a technician granted the ledger', async () => {
  await assert.rejects(
    assertPermissions({ as: lintel.as, client: lintel.anonymous }, [{ role: 'technician', read: 'charge', allowed: true }]),
    /technician may read charge: refused/,
  );
});

test('a resident reads their own household and nothing else', async () => {
  const resident = await lintel.as('resident');
  const { id, lease } = lintel.resident;
  const own = (rows: Array<Record<string, unknown>>, column: string, ids: number[]) =>
    assert.ok(
      rows.length && rows.every((row) => ids.includes(Number(row[column]))),
      `${column}: ${rows.map((row) => row[column]).join(', ')}`,
    );

  const people = await resident.rows('resident', { limit: 50 });
  assert.ok(people.ok);
  assert.deepEqual(
    people.value.map((row) => Number(row.id)),
    [id],
  );
  const leases = await resident.rows('lease', { limit: 50 });
  assert.ok(leases.ok);
  own(leases.value, 'resident_id', [id]);
  const leaseIds = leases.value.map((row) => Number(row.id));
  assert.ok(leaseIds.includes(lease));
  const charges = await resident.rows('charge', { limit: 200 });
  assert.ok(charges.ok);
  own(charges.value, 'lease_id', leaseIds);
  const repairs = await resident.rows('maintenance_request', { limit: 200 });
  assert.ok(repairs.ok);
  own(repairs.value, 'resident_id', [id]);
  // Every message on their repairs but the office's internal notes.
  const notes = await resident.rows('request_note', { limit: 500 });
  assert.ok(notes.ok);
  assert.ok(notes.value.length, 'their repairs have a conversation');
  assert.ok(notes.value.every((note) => note.kind !== 'internal'));
  const internal = lintel.rows<{ n: number }>(
    `SELECT COUNT(*) AS n FROM request_note n JOIN maintenance_request m ON m.id = n.request_id WHERE m.resident_id = ? AND n.kind = 'internal'`,
    id,
  )[0].n;
  assert.ok(internal > 0, 'the seed gives them an internal note to leave out');

  // Another household's lease is not found, read by its id.
  const other = lintel.rows<{ id: number }>(`SELECT id FROM lease WHERE resident_id != ? LIMIT 1`, id)[0];
  const theirs = await resident.rows('lease', { where: `id = ${other.id}` });
  assert.ok(theirs.ok);
  assert.equal(theirs.value.length, 0);
});

test('a technician reads who lives where and never what it costs', async () => {
  const technician = await lintel.as('technician');
  const leases = await technician.rows('lease', { limit: 5 });
  assert.ok(leases.ok && leases.value.length);
  for (const column of ['rent', 'deposit']) assert.ok(!(column in leases.value[0]), `a technician reads lease.${column}`);
  assert.ok('resident_id' in leases.value[0]);
  for (const table of ['charge', 'payment']) assert.equal((await technician.rows(table, { limit: 1 })).ok, false, table);
});

test('signed out, a visitor reads the listings and no one who lives there', async () => {
  const visitor = lintel.anonymous();
  const homes = await visitor.rows('unit', { where: 'listed = true', limit: 50 });
  assert.ok(homes.ok && homes.value.length, 'some homes are listed');
  assert.ok(!('status' in homes.value[0]), 'a visitor reads a listing, not the rent roll');
  for (const table of ['resident', 'lease', 'maintenance_request']) {
    const read = await visitor.rows(table, { limit: 1 });
    assert.ok(!read.ok, `a visitor reads ${table}`);
  }
});

test('only the desk may call a repair off: a technician is refused, and nothing moves', async () => {
  const repair = lintel.rows<{ id: number }>(`SELECT id FROM maintenance_request WHERE status = 'new' ORDER BY id LIMIT 1`)[0];
  // Granted by the command alone: a technician moves a repair by its status and never writes its resolution.
  const technician = await lintel.as('technician');
  const refused = await technician.command('cancelRequest', { id: repair.id }, { resolution: 'Not mine to cancel.' });
  assert.equal(refused.ok, false);
  assert.equal(lintel.rows<{ status: string }>(`SELECT status FROM maintenance_request WHERE id = ?`, repair.id)[0].status, 'new');
});
test('New is offered for what a role creates: a technician logs parts and deliveries, never a repair', async () => {
  const schema = async (role: 'technician' | 'manager') => {
    const answer = await (await lintel.as(role)).request('/api/schema');
    const tables = ((await answer.json()) as { tables: Array<{ id: string; insertable?: boolean }> }).tables;
    return (id: string) => tables.find((table) => table.id === id)?.insertable;
  };
  const technician = await schema('technician');
  assert.equal(technician('maintenance_request'), false);
  assert.notEqual(technician('request_part'), false);
  assert.notEqual(technician('part_receipt'), false);
  assert.notEqual((await schema('manager'))('maintenance_request'), false);
});

test("Export is the office's: the accountant is offered the ledger, a resident and a visitor are offered none and are refused", async () => {
  const served = async (client: { request: (path: string) => Promise<Response> }) => {
    const reply = await client.request('/api/app');
    assert.equal(reply.status, 200);
    return ((await reply.json()) as { app: { ui: { export?: boolean }; exportableTables?: string[] } }).app;
  };
  const accountant = await served(await lintel.as('accountant'));
  assert.ok(
    accountant.exportableTables?.includes('charge') && accountant.exportableTables.includes('payment'),
    'the books export the ledger',
  );
  assert.ok(!accountant.exportableTables?.includes('resident'), 'and not what they only read');
  for (const [who, client] of [
    ['a resident', await lintel.as('resident')],
    ['a visitor', lintel.anonymous()],
  ] as const) {
    const app = await served(client);
    assert.equal(app.ui.export, false, `${who} is offered no Export`);
    assert.deepEqual(app.exportableTables, [], who);
    const refused = await client.request('/api/export', { method: 'POST', json: { q: 'charge', format: 'csv' } });
    // A visitor is stopped at the sign-in gate (401) before the grant is asked; a resident is signed in and refused it (403).
    assert.equal(refused.status, who === 'a visitor' ? 401 : 403, `${who} is refused the file`);
  }
});
