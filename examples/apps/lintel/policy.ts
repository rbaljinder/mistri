// Private deployment policy, loaded with --policy: which rows each reader
// reaches. Never import this module into the App.
import { defineAppRowPolicy, type PolicyDb, type RowScope } from '@mistriwork/mistri/policy';
import type { Rows } from './mistri-schema.d.ts';

/* One App, two audiences. The office — managers, leasing, technicians, the
   accountant — reads every building; what each may read *of* a row is the
   roles' business (app.ts: a technician never reads the ledger). A resident
   reads their own household and nothing else: their resident row, their
   leases and homes, the charges and payments on those leases, and the repairs
   they reported with the parts used and every message on them but the
   office's internal notes.

   The resident is found from the verified session only: the one resident row
   whose email is the account's. No match, or two, grants nothing. Nothing a
   request says is read. */

const OFFICE = ['manager', 'leasing', 'technician', 'accountant', 'admin'];
const TABLES = [
  'property',
  'property_photo',
  'unit',
  'resident',
  'staff',
  'lease',
  'charge',
  'payment',
  'maintenance_request',
  'request_part',
  'request_note',
  'part',
  'part_receipt',
  'viewing',
] as const;
const all = (value: boolean): RowScope => Object.fromEntries(TABLES.map((table) => [table, value]));

/* What each of the jobs module's services (jobs.ts) runs its commands in. */
const SERVICES: Readonly<Record<string, RowScope>> = {
  // Posts rent on current leases and assesses late fees: the leases and their charges.
  'service:rent-poster': { lease: true, charge: true },
  // Ends a lease whose notice ran out, and puts its home into turnover.
  'service:lease-clock': { lease: true, unit: true },
  // Settles the charge a callback names with a payment.
  'service:payment-processor': { lease: true, charge: true, payment: true },
  // Suggests a technician for a new repair: the repair, its home and building, and the staff it may name.
  'service:repair-triage': { maintenance_request: true, unit: true, property: true, staff: true },
};

const is = (column: string, value: number) => ({ groups: [[{ column, op: '=' as const, value }]] });
const among = (column: string, values: readonly number[]) =>
  values.length ? { groups: [[{ column, op: 'in' as const, value: [...values] }]] } : false;

async function household(db: PolicyDb<Rows>, email: string | undefined): Promise<RowScope> {
  if (!email) return all(false);
  const found = await db.resident.where({ email: email.toLowerCase() }).limit(2);
  if (found.length !== 1) return all(false);
  const resident = found[0];
  const leases = await db.lease.where({ resident_id: resident.id }).limit(100);
  const requests = await db.maintenance_request.where({ resident_id: resident.id }).limit(1000);
  const leaseIds = leases.map((lease) => lease.id);
  const requestIds = requests.map((request) => request.id);
  return {
    ...all(false),
    // The buildings and their photos are public anyway.
    property: true,
    property_photo: true,
    resident: is('id', resident.id),
    lease: is('resident_id', resident.id),
    unit: among('id', [...new Set(leases.map((lease) => lease.unit_id))]),
    charge: among('lease_id', leaseIds),
    payment: among('lease_id', leaseIds),
    maintenance_request: is('resident_id', resident.id),
    request_part: among('request_id', requestIds),
    // The parts' names: what the storeroom holds is the role's to leave out (app.ts).
    part: true,
    request_note: requestIds.length
      ? {
          groups: [
            [
              { column: 'request_id', op: 'in', value: requestIds },
              { column: 'kind', op: '!=', value: 'internal' },
            ],
          ],
        }
      : false,
    // Who is coming to fix it: the technician's name on the request.
    staff: true,
  };
}

export default defineAppRowPolicy<Rows>({
  appId: 'lintel',
  services: ['rent-poster', 'lease-clock', 'payment-processor', 'repair-triage'],
  async resolveRows(principal, { db }) {
    if (principal.kind === 'service') return { ...all(false), ...(SERVICES[principal.id] ?? {}) };
    if (principal.roles.some((role) => OFFICE.includes(role))) return all(true);
    if (principal.roles.includes('resident')) return household(db, principal.email);
    return all(false);
  },
  /* Every command's result, said as the records it names: a resident's report names the request it made, which is
     theirs to open. */
  resultReferences: {
    signLease: () => [],
    giveNotice: () => [],
    endLease: () => [],
    postRent: () => [],
    assessLateFees: () => [],
    recordPayment: () => [],
    settleCharge: () => [],
    addCharge: () => [],
    reportIssue: (result) => [{ table: 'maintenance_request', key: { id: (result as { requestId: string }).requestId } }],
    scheduleVisit: () => [],
    assignTechnician: () => [],
    completeRequest: () => [],
    cancelRequest: () => [],
    replyToResident: () => [],
    addNote: () => [],
    messageOffice: () => [],
  },
  publicForms: {
    // The viewing form's fixed intake writes a viewing and reads the home it names; it grants no reads back.
    'request-viewing': { rows: { viewing: true, unit: true }, resultReferences: () => [] },
  },
});
