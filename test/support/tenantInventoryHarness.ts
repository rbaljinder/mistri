/** The inventory proof's shared harness: a live fixture, native sign-in, and one SQLite snapshot of every resource.
    Split out of tenant-inventory.test.ts so its test groups run as files side by side. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { startTenantInventory } from '../../e2e/support/tenantProofServer.js';
import { COMMAND_JOURNAL_TABLES } from '../../packages/mistri/src/adapters/commands/commandJournal.js';
import { sqliteAuditRows } from './commandTargets.js';
import { inventoryResult } from './tenantInventoryFixture.js';

export type Fixture = Awaited<ReturnType<typeof startTenantInventory>>;
export type ObjectValue = Record<string, unknown>;
export type Reply = { status: number; headers: Headers; body: ObjectValue };
export type Context = {
  appId: string;
  accountId: string;
  tenantId: string;
  tabId: string;
  context: string;
  revision: number;
  expiresAt: number;
};
export type Role = keyof Fixture['accounts'];
export type Attempt = {
  command: string;
  commandVersion: number;
  key: { id: string };
  expectedVersion: number;
  idempotencyKey: string;
  input: { reason: string; lead?: string };
};
export const ownerNames = ['app', 'account', 'tenant', 'tab', 'context', 'lease-revision'];
export const assertion = (c: Context) => ({ tabId: c.tabId, expectedContext: c.context, expectedRevision: c.revision });
export const filter = (column: string, value: string) => ({ groups: [[{ column, op: '=', value }]] });
export function object(value: unknown): ObjectValue {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as ObjectValue;
}
export function objects(value: unknown): ObjectValue[] {
  assert.ok(Array.isArray(value));
  return value.map(object);
}
export function noPrivate(reply: Reply) {
  assert.ok(
    !/tenant_id|physical_|__mistri_|approxRows|"(?:sql|params|stack|sessionId|password|token)"/.test(JSON.stringify(reply.body)),
    'response disclosed managed ownership or private implementation data',
  );
}
export function denied(reply: Reply) {
  assert.ok(reply.status >= 400 || (Array.isArray(reply.body.errors) && reply.body.errors.length > 0), 'request must be refused');
  noPrivate(reply);
  for (const name of ownerNames) assert.ok(reply.headers.get(`x-mistri-${name}`) === null, `refusal attested ${name}`);
  for (const key of ['rows', 'result', 'receiptId', 'references', 'plans', 'expectedVersion'])
    assert.equal(key in reply.body, false, `refusal disclosed ${key}`);
  assert.equal(reply.headers.get('cache-control'), 'no-store');
}
export function owned(reply: Reply, c: Context) {
  assert.equal(reply.status, 200);
  assert.ok(reply.body.errors === undefined || (Array.isArray(reply.body.errors) && reply.body.errors.length === 0));
  const values = [c.appId, c.accountId, c.tenantId, c.tabId, c.context, String(c.revision)];
  ownerNames.forEach((name, i) => assert.ok(reply.headers.get(`x-mistri-${name}`) === values[i], `incorrect ${name} ownership`));
  assert.equal(reply.headers.get('cache-control'), 'no-store');
}
export function rows(reply: Reply) {
  assert.equal(reply.status, 200);
  return objects(reply.body.rows);
}
export const ids = (reply: Reply) =>
  rows(reply)
    .map((row) => row.id)
    .sort();
export async function fixture(t: TestContext) {
  const f = await startTenantInventory();
  t.after(() => f.stop());
  assert.equal(f.appId, 'tenant-ignition-inventory');
  return f;
}
export async function login(f: Fixture, role: Role = 'manager') {
  const account = f.accounts[role];
  const response = await fetch(`${f.origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { origin: f.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: account.password }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, 'native sign-in failed');
  assert.ok(object(object(await response.json()).user).id === account.id, 'native sign-in returned another account');
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  assert.ok(cookie.length > 0, 'native sign-in must issue session cookies');
  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> => {
    const reply = await fetch(f.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, origin: f.origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    return { status: reply.status, headers: reply.headers, body: object(await reply.json()) };
  };
  const select = (path: string, tenant: string) => `${path}?app=${f.appId}&tenant=${tenant}`;
  const headers = (c: Context) => ({
    'x-mistri-account': c.accountId,
    'x-mistri-tab': c.tabId,
    'x-mistri-context': c.context,
    'x-mistri-lease-revision': String(c.revision),
  });
  const bootstrap = async () => {
    const reply = await call(`/api/tenant/bootstrap?app=${f.appId}`);
    assert.equal(reply.status, 200);
    noPrivate(reply);
    return reply.body;
  };
  const open = async (tenant = 'northstar') => {
    const reply = await call(select('/api/tenant/context/open', tenant), {});
    assert.equal(reply.status, 200, 'context open failed');
    for (const name of ['appId', 'accountId', 'tenantId', 'tabId', 'context']) assert.equal(typeof reply.body[name], 'string');
    const c = reply.body as Context;
    assert.ok(c.appId === f.appId && c.accountId === account.id && c.tenantId === tenant, 'incorrect context identity');
    assert.equal(c.revision, 1);
    assert.ok(c.expiresAt > Date.now());
    owned(reply, c);
    return c;
  };
  const data = async (path: string, c: Context, body?: unknown) => {
    const reply = await call(select(path, c.tenantId), body, headers(c));
    noPrivate(reply);
    if (reply.status < 400 && (reply.body.errors === undefined || (Array.isArray(reply.body.errors) && reply.body.errors.length === 0)))
      owned(reply, c);
    else denied(reply);
    return reply;
  };
  return { call, select, headers, bootstrap, open, data };
}

// Observe one SQLite snapshot of every business resource and the journal. The
// live fixture is mutated exclusively through real HTTP or its private IPC.
export function evidence(f: Fixture) {
  const db = new DatabaseSync(f.database, { readOnly: true });
  try {
    db.exec('BEGIN');
    const read = (table: string, order = 'id') =>
      db
        .prepare(`SELECT * FROM ${table.startsWith('(') ? `${table} a` : `"${table}"`} ORDER BY "${order}"`)
        .all()
        .map((row) => ({ ...row }));
    return {
      units: read(`physical_${f.model.unit}`),
      work: read(`physical_${f.model.work}`),
      targets: read(`physical_${f.model.target}`),
      events: read(`physical_${f.model.event}`),
      staff: read(`physical_${f.assignment.staff}`),
      applications: read(`physical_${f.assignment.application}`),
      assignments: read(`physical_${f.assignment.history}`),
      vehicles: read(`physical_${f.inventory.vehicle}`),
      reservations: read(`physical_${f.inventory.reservation}`),
      history: read(`physical_${f.inventory.history}`),
      receipts: read(COMMAND_JOURNAL_TABLES.receipt),
      audits: read(sqliteAuditRows, 'receipt_id'),
      journal: read(COMMAND_JOURNAL_TABLES.meta, 'singleton'),
    };
  } finally {
    db.close();
  }
}
export function reserve(
  f: Fixture,
  vehicle: string = f.inventoryRows.north.vehicle,
  lead: string = f.rows.north.work,
  idempotencyKey = 'inventory-reserve-attempt-0001',
  expectedVersion = 0,
): Attempt {
  return {
    command: f.inventory.reserve,
    commandVersion: 1,
    key: { id: vehicle },
    expectedVersion,
    idempotencyKey,
    input: { lead, reason: '  Reserve for the selected lead.  ' },
  };
}
export function release(
  f: Fixture,
  reservation: string = f.inventoryRows.north.reservation,
  idempotencyKey = 'inventory-release-attempt-0001',
  expectedVersion = 0,
): Attempt {
  return {
    command: f.inventory.release,
    commandVersion: 1,
    key: { id: reservation },
    expectedVersion,
    idempotencyKey,
    input: { reason: '  Release this exact reservation.  ' },
  };
}
export const prepare = (input: Attempt) => ({ command: input.command, commandVersion: input.commandVersion, key: input.key });
export const sorted = <T extends ObjectValue>(values: T[], key = 'id') =>
  values.slice().sort((a, b) => String(a[key]).localeCompare(String(b[key])));

export function committed(
  f: Fixture,
  before: ReturnType<typeof evidence>,
  reply: Reply,
  input: Attempt,
  tenant = 'northstar',
  manager: string = f.assignmentRows.north.manager,
) {
  assert.equal(reply.status, 200);
  assert.equal(reply.body.status, 'applied');
  assert.equal(typeof reply.body.receiptId, 'string');
  const reserving = input.command === f.inventory.reserve,
    result = inventoryResult(reserving ? 'reserve' : 'release', reply.body.result);
  assert.deepEqual(
    Object.keys(object(reply.body.result)).sort(),
    ['vehicleId', 'reservationId', 'historyId', 'leadId', 'managerId', 'vehicleVersion', 'reservationVersion', 'status', 'message'].sort(),
  );
  const oldReservation = reserving ? undefined : before.reservations.find((row) => row.id === input.key.id);
  if (!reserving) assert.ok(oldReservation);
  const vehicleId = reserving ? input.key.id : oldReservation!.vehicle_id;
  const vehicle = before.vehicles.find((row) => row.id === vehicleId);
  assert.ok(vehicle);
  assert.deepEqual(result, {
    vehicleId,
    reservationId: reserving ? result.reservationId : input.key.id,
    historyId: result.historyId,
    leadId: reserving ? input.input.lead : oldReservation!.lead_id,
    managerId: manager,
    vehicleVersion: Number(vehicle.version) + 1,
    reservationVersion: reserving ? 0 : input.expectedVersion + 1,
    status: reserving ? 'reserved' : 'available',
    message: reserving ? 'Vehicle reserved.' : 'Reservation released.',
  });
  if (reserving) assert.equal(vehicle.version, input.expectedVersion);
  assert.match(result.historyId, /^[0-9a-f]{32}$/);
  const after = evidence(f),
    reservation = after.reservations.find((row) => row.id === result.reservationId);
  const history = after.history.find((row) => row.id === result.historyId);
  assert.ok(reservation);
  assert.ok(history);
  assert.equal(new Date(String(history.recorded_on)).toISOString(), history.recorded_on);
  assert.deepEqual(history, {
    id: result.historyId,
    tenant_id: tenant,
    location_id: vehicle.location_id,
    vehicle_id: vehicleId,
    reservation_id: result.reservationId,
    actor_id: manager,
    name: reserving ? 'Vehicle reserved' : 'Reservation released',
    from_status: reserving ? 'available' : 'reserved',
    to_status: result.status,
    reason: input.input.reason.trim(),
    recorded_on: history.recorded_on,
  });
  if (reserving) {
    assert.match(result.reservationId, /^[0-9a-f]{32}$/);
    assert.equal(typeof reservation.reference, 'string');
    assert.ok(String(reservation.reference).length > 0);
    assert.deepEqual(reservation, {
      id: result.reservationId,
      tenant_id: tenant,
      location_id: vehicle.location_id,
      vehicle_id: vehicleId,
      lead_id: result.leadId,
      reserved_by: manager,
      released_by: null,
      reference: reservation.reference,
      name: 'Vehicle reservation',
      status: 'active',
      version: 0,
      reason: input.input.reason.trim(),
      reserved_on: history.recorded_on,
      released_on: null,
    });
  } else
    assert.deepEqual(reservation, {
      ...oldReservation,
      status: 'released',
      version: result.reservationVersion,
      released_by: manager,
      released_on: history.recorded_on,
    });
  const receipt = after.receipts.find((row) => row.id === reply.body.receiptId);
  assert.ok(receipt);
  assert.deepEqual(JSON.parse(String(receipt.result_json)), result);
  assert.equal(receipt.app_id, f.appId);
  assert.equal(receipt.tenant_id, tenant);
  assert.equal(receipt.source_id, 'business');
  assert.equal(receipt.actor_id, f.accounts.manager.id);
  assert.equal(receipt.command_id, input.command);
  assert.equal(receipt.command_version, 1);
  assert.equal(receipt.idempotency_key, input.idempotencyKey);
  const audit = after.audits.find((row) => row.receipt_id === receipt.id);
  assert.ok(audit);
  for (const column of ['app_id', 'store_id', 'source_id', 'tenant_id', 'actor_id']) assert.equal(audit[column], receipt[column]);
  assert.equal(audit.membership_version, '1');
  assert.equal(audit.target, reserving ? f.inventory.vehicle : f.inventory.reservation);
  assert.deepEqual(JSON.parse(String(audit.key_json)), input.key);
  assert.deepEqual(JSON.parse(String(audit.roles_json)), ['manager']);
  const changes = objects(JSON.parse(String(audit.changes_json)));
  assert.deepEqual(
    changes.map((change) => [change.operation, change.resource, change.key]),
    [
      ['update', f.inventory.vehicle, { id: vehicleId }],
      [reserving ? 'insert' : 'update', f.inventory.reservation, { id: result.reservationId }],
      ['insert', f.inventory.history, { id: result.historyId }],
    ],
  );
  assert.deepEqual(changes[0].before, { version: vehicle.version, status: vehicle.status });
  assert.deepEqual(changes[0].after, { version: result.vehicleVersion, status: result.status });
  if (!reserving) {
    assert.deepEqual(changes[1].before, { version: oldReservation!.version, status: 'active', released_by: null, released_on: null });
    assert.deepEqual(changes[1].after, {
      version: result.reservationVersion,
      status: 'released',
      released_by: manager,
      released_on: history.recorded_on,
    });
  }
  assert.deepEqual(after, {
    ...before,
    vehicles: before.vehicles.map((row) =>
      row.id === vehicleId ? { ...row, version: result.vehicleVersion, status: result.status } : row,
    ),
    reservations: reserving
      ? sorted([...before.reservations, reservation])
      : before.reservations.map((row) => (row.id === result.reservationId ? reservation : row)),
    history: sorted([...before.history, history]),
    receipts: sorted([...before.receipts, receipt]),
    audits: sorted([...before.audits, audit], 'receipt_id'),
  });
  return { after, result };
}
