import { DatabaseSync } from 'node:sqlite';
import { defineCommand, defineCommands } from '../../packages/mistri/src/server/commands/businessCommands.js';
import { refuse } from '../../packages/mistri/src/server/commands/businessCommandExecution.js';
import { proofKey, captureProofStaffAccounts } from './tenantProofStaff.js';
import { releaseReservationInput, reserveVehicleInput } from '../fixtures/apps/tenant-ignition/inventory/inputs.js';

export const inventoryResources = ['vehicle', 'vehicle_reservation', 'availability_history'] as const;

/** Fresh disposable stores only; seed snapshots are not executed workflows. */
export function seedTenantInventory(db: DatabaseSync) {
  db.exec(`CREATE TABLE physical_vehicle (id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT COLLATE BINARY NOT NULL, location_id TEXT NOT NULL REFERENCES physical_location(id),
    stock_reference TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'available'
      CHECK(status IN ('available','reserved','unavailable')), version INTEGER NOT NULL DEFAULT 0,
    UNIQUE(tenant_id,stock_reference));
  CREATE TABLE physical_vehicle_reservation (id TEXT PRIMARY KEY NOT NULL DEFAULT(lower(hex(randomblob(16)))),
    tenant_id TEXT COLLATE BINARY NOT NULL, location_id TEXT NOT NULL REFERENCES physical_location(id),
    vehicle_id TEXT NOT NULL REFERENCES physical_vehicle(id), lead_id TEXT NOT NULL REFERENCES physical_lead(id),
    reserved_by TEXT NOT NULL REFERENCES physical_review_staff(id), released_by TEXT REFERENCES physical_review_staff(id),
    reference TEXT NOT NULL DEFAULT('RS-' || lower(hex(randomblob(6)))), name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','released')), version INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL, reserved_on TEXT NOT NULL, released_on TEXT, UNIQUE(tenant_id,reference));
  CREATE UNIQUE INDEX physical_one_active_reservation ON physical_vehicle_reservation(tenant_id,vehicle_id) WHERE status='active';
  CREATE TABLE physical_availability_history (id TEXT PRIMARY KEY NOT NULL DEFAULT(lower(hex(randomblob(16)))),
    tenant_id TEXT COLLATE BINARY NOT NULL, location_id TEXT NOT NULL REFERENCES physical_location(id),
    vehicle_id TEXT NOT NULL REFERENCES physical_vehicle(id), reservation_id TEXT NOT NULL REFERENCES physical_vehicle_reservation(id),
    actor_id TEXT NOT NULL REFERENCES physical_review_staff(id), name TEXT NOT NULL, from_status TEXT NOT NULL,
    to_status TEXT NOT NULL, reason TEXT NOT NULL, recorded_on TEXT NOT NULL);`);
  const vehicle = db.prepare('INSERT INTO physical_vehicle VALUES (?,?,?,?,?,?,?)');
  const reservation = db.prepare('INSERT INTO physical_vehicle_reservation VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const tenant of ['northstar', 'riverview']) {
    const name = tenant === 'northstar' ? 'Northstar' : 'Riverview';
    vehicle.run(`${tenant}-vehicle`, tenant, `${tenant}-main`, 'STOCK-001', `${name} vehicle`, 'available', 0);
    vehicle.run(`${tenant}-reserved-vehicle`, tenant, `${tenant}-main`, 'STOCK-008', `${name} reserved vehicle`, 'reserved', 1);
    reservation.run(
      `${tenant}-reservation`,
      tenant,
      `${tenant}-main`,
      `${tenant}-reserved-vehicle`,
      `${tenant}-work`,
      `${tenant}-manager`,
      null,
      'RS-001',
      `${name} reservation`,
      'active',
      0,
      'Synthetic reserved snapshot',
      '2026-09-01T10:00:00.000Z',
      null,
    );
  }
  for (const [suffix, location, stock, status, version] of [
    ['other', 'other', 'STOCK-002', 'available', 0],
    ['unavailable', 'main', 'STOCK-003', 'unavailable', 0],
    ['stale', 'main', 'STOCK-004', 'available', 3],
    ['missing-reservation', 'main', 'STOCK-005', 'reserved', 1],
    ['inconsistent', 'main', 'STOCK-006', 'available', 0],
    ['hidden-reservation', 'main', 'STOCK-007', 'available', 0],
    ['stale-reserved', 'main', 'STOCK-009', 'reserved', 4],
  ] as const)
    vehicle.run(`northstar-${suffix}-vehicle`, 'northstar', `northstar-${location}`, stock, `Northstar ${suffix} vehicle`, status, version);
  // A manager cannot see this third location. A malformed legacy reservation
  // there still conflicts with the visible vehicle's database uniqueness rule.
  db.prepare('INSERT INTO physical_location VALUES (?,?,?,?)').run('northstar-private', 'northstar', 'UNIT-003', 'Northstar private unit');
  db.prepare('INSERT INTO physical_lead VALUES (?,?,?,?,?,?)').run(
    'northstar-private-work',
    'northstar',
    'northstar-private',
    'WORK-003',
    'Northstar private work',
    'open',
  );
  db.prepare('INSERT INTO physical_review_staff VALUES (?,?,?,?,?,?,?)').run(
    'northstar-private-manager',
    'northstar',
    'northstar-private',
    'STAFF-PRIVATE',
    'Northstar private manager',
    'manager',
    1,
  );
  for (const [id, vehicleId, unit, lead, staff, reference, status, version] of [
    ['inconsistent', 'inconsistent-vehicle', 'main', 'work', 'manager', 'RS-002', 'active', 0],
    ['hidden', 'hidden-reservation-vehicle', 'private', 'private-work', 'private-manager', 'RS-003', 'active', 0],
    ['stale', 'stale-reserved-vehicle', 'main', 'work', 'manager', 'RS-004', 'active', 2],
    ['released', 'vehicle', 'main', 'work', 'manager', 'RS-005', 'released', 1],
  ] as const)
    reservation.run(
      `northstar-${id}-reservation`,
      'northstar',
      `northstar-${unit}`,
      `northstar-${vehicleId}`,
      `northstar-${lead}`,
      `northstar-${staff}`,
      status === 'released' ? `northstar-${staff}` : null,
      reference,
      `Northstar ${id} reservation`,
      status,
      version,
      'Synthetic reservation snapshot',
      '2026-09-01T10:00:00.000Z',
      status === 'released' ? '2026-09-02T10:00:00.000Z' : null,
    );
}

type InventoryResult = {
  vehicleId: string;
  reservationId: string;
  historyId: string;
  leadId: string;
  managerId: string;
  vehicleVersion: number;
  reservationVersion: number;
  status: 'reserved' | 'available';
  message: string;
};
type Mode = 'reserve' | 'release';
export function inventoryResult(mode: Mode, value: unknown): InventoryResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid inventory result');
  const data = value as Record<string, unknown>,
    reserved = mode === 'reserve';
  if (
    Object.keys(data).length !== 9 ||
    !proofKey(data.vehicleId) ||
    !proofKey(data.reservationId) ||
    !proofKey(data.leadId) ||
    !proofKey(data.managerId) ||
    typeof data.historyId !== 'string' ||
    !/^[a-f0-9]{32}$/.test(data.historyId) ||
    !Number.isSafeInteger(data.vehicleVersion) ||
    (data.vehicleVersion as number) < 1 ||
    !Number.isSafeInteger(data.reservationVersion) ||
    (reserved ? data.reservationVersion !== 0 : (data.reservationVersion as number) < 1) ||
    data.status !== (reserved ? 'reserved' : 'available') ||
    data.message !== (reserved ? 'Vehicle reserved.' : 'Reservation released.')
  ) {
    throw new Error('Invalid inventory result');
  }
  return {
    vehicleId: data.vehicleId,
    reservationId: data.reservationId,
    historyId: data.historyId,
    leadId: data.leadId,
    managerId: data.managerId,
    vehicleVersion: data.vehicleVersion as number,
    reservationVersion: data.reservationVersion as number,
    status: data.status as InventoryResult['status'],
    message: data.message as string,
  };
}

const reads = ['location', 'lead', 'review_staff'] as const;

export function tenantInventoryCommands(staffByAccount: Readonly<Record<string, readonly string[]>>) {
  const staff = captureProofStaffAccounts(staffByAccount);
  return defineCommands({
    reserveVehicle: defineCommand({
      // The fixture App's references: a required lead and a reason of at most
      // 500 characters, parsed by the platform. A lead is also opaque text.
      source: 'business',
      target: 'vehicle',
      input: reserveVehicleInput,
      read: reads,
      write: ['vehicle_reservation', 'availability_history'],
      when: 'status = available',
      validate(input) {
        if (!proofKey(input.lead)) throw new Error('Invalid inventory input');
        return { lead: input.lead, reason: input.reason };
      },
      output: { parse: (value) => inventoryResult('reserve', value) },
      async handle(context, input) {
        const { db, record: vehicle, actor, now } = context;
        if (!staff.has(actor.id)) refuse('forbidden');
        const locationId = vehicle.location_id;
        if (!proofKey(locationId)) refuse('forbidden');
        const managerId = await staff.manager(context, locationId);
        const lead = await db.lead.find({ id: input.lead });
        if (!lead || lead.location_id !== locationId) refuse('forbidden');
        if (lead.status !== 'open' || (await db.vehicle_reservation.count({ vehicle_id: vehicle.id, status: 'active' })))
          refuse('ineligible_state');
        const { version } = await db.vehicle.update(vehicle, { status: 'reserved' });
        const at = now().toISOString();
        // The tenant-qualified unique index is the final guard when a conflicting
        // malformed reservation is outside row visibility. A failure rolls back
        // the preceding availability update with the journal transaction.
        const reservation = await db.vehicle_reservation.insert({
          location_id: locationId,
          vehicle_id: vehicle.id,
          lead_id: input.lead,
          reserved_by: managerId,
          name: 'Vehicle reservation',
          status: 'active',
          version: 0,
          reason: input.reason,
          reserved_on: at,
        });
        if (!proofKey(reservation.id)) throw new Error('Invalid generated reservation');
        const history = await db.availability_history.insert({
          location_id: locationId,
          vehicle_id: vehicle.id,
          reservation_id: reservation.id,
          actor_id: managerId,
          name: 'Vehicle reserved',
          from_status: 'available',
          to_status: 'reserved',
          reason: input.reason,
          recorded_on: at,
        });
        return inventoryResult('reserve', {
          vehicleId: vehicle.id,
          reservationId: reservation.id,
          historyId: history.id,
          leadId: input.lead,
          managerId,
          vehicleVersion: version,
          reservationVersion: 0,
          status: 'reserved',
          message: 'Vehicle reserved.',
        });
      },
    }),
    releaseReservation: defineCommand({
      source: 'business',
      target: 'vehicle_reservation',
      input: releaseReservationInput,
      read: reads,
      write: ['vehicle', 'availability_history'],
      when: 'status = active and released_by is empty and released_on is empty',
      output: { parse: (value) => inventoryResult('release', value) },
      async handle(context, input) {
        const { db, record: reservation, actor, now } = context;
        if (!staff.has(actor.id)) refuse('forbidden');
        const locationId = reservation.location_id,
          vehicleId = reservation.vehicle_id,
          leadId = reservation.lead_id;
        if (!proofKey(locationId) || !proofKey(vehicleId) || !proofKey(leadId)) refuse('forbidden');
        const managerId = await staff.manager(context, locationId);
        const vehicle = await db.vehicle.find({ id: vehicleId });
        const lead = await db.lead.find({ id: leadId });
        if (!vehicle || !lead || vehicle.location_id !== locationId || lead.location_id !== locationId) refuse('forbidden');
        const current = await db.vehicle_reservation.where({ vehicle_id: vehicleId, status: 'active' }).limit(2);
        if (vehicle.status !== 'reserved' || current.length !== 1 || current[0].id !== reservation.id) refuse('ineligible_state');
        const { version: vehicleVersion } = await db.vehicle.update(vehicle, { status: 'available' });
        const at = now().toISOString();
        const { version: reservationVersion } = await db.vehicle_reservation.update(reservation, {
          status: 'released',
          released_by: managerId,
          released_on: at,
        });
        const history = await db.availability_history.insert({
          location_id: locationId,
          vehicle_id: vehicleId,
          reservation_id: reservation.id,
          actor_id: managerId,
          name: 'Reservation released',
          from_status: 'reserved',
          to_status: 'available',
          reason: input.reason,
          recorded_on: at,
        });
        return inventoryResult('release', {
          vehicleId,
          reservationId: reservation.id,
          historyId: history.id,
          leadId,
          managerId,
          vehicleVersion,
          reservationVersion,
          status: 'available',
          message: 'Reservation released.',
        });
      },
    }),
  });
}
