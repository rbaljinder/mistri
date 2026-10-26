/**
 * The clinic fixture's business database (test/fixtures/apps/clinic): the same tables on SQLite and on PostgreSQL,
 * two clinics with patients, appointments and services, and a third clinic's profile row that Manage tenants
 * creates as a tenant. Business rows only: the tenant App's stores are made by `mistri migrate stores up --app
 * --policy`, and tenants and memberships by the operator steps, as a deployment makes them.
 *
 * Every tenant-owned table keys its rows by one opaque text id (docs/tenant-apps.md, "Keys in a tenant App") and
 * indexes its ownership column, which every tenant read compares.
 */
import { DatabaseSync } from 'node:sqlite';

/** Each clinic's addresses: routing addresses of at least 22 characters, as the platform would issue them. */
export const ADDRESSES = Object.freeze({
  north: { intake: 'north-intake-7cQ2mZp9LkX4vB1nR8sT', public: 'north-public-Hd3Kq8Wv2Lp6Xz9Rb4Ny' },
  south: { intake: 'south-intake-Pq7Lm2Xc9Vb4Nz1Rk8Wd', public: 'south-public-Ty5Gh2Jk8Lm3Np6Qr9Sv' },
  east: { intake: 'east-intake-Zx8Cv4Bn1Mq7Wp3Lk9Hj2', public: 'east-public-Rt6Yu2Io8Pa4Sd1Fg7Hk3' },
});

const TABLES = `
CREATE TABLE clinic (id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL, intake_address TEXT, public_address TEXT);
CREATE TABLE patient (id TEXT NOT NULL PRIMARY KEY, clinic_id TEXT NOT NULL REFERENCES clinic (id), name TEXT NOT NULL, phone TEXT);
CREATE TABLE appointment (
  id TEXT NOT NULL PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinic (id),
  patient_id TEXT NOT NULL REFERENCES patient (id),
  starts_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'paid', 'cancelled')),
  fee_cents INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE payment (
  id TEXT NOT NULL PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinic (id),
  appointment_id TEXT NOT NULL REFERENCES appointment (id),
  amount_cents INTEGER NOT NULL,
  method TEXT NOT NULL
);
CREATE TABLE service (
  id TEXT NOT NULL PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinic (id),
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  published INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE visit_request (id TEXT NOT NULL PRIMARY KEY, clinic_id TEXT NOT NULL REFERENCES clinic (id), name TEXT NOT NULL, phone TEXT NOT NULL, note TEXT);
CREATE TABLE notice (id TEXT NOT NULL PRIMARY KEY, clinic_id TEXT NOT NULL REFERENCES clinic (id), body TEXT NOT NULL);
CREATE TABLE triage (id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, note TEXT);
CREATE INDEX patient_clinic ON patient (clinic_id);
CREATE INDEX appointment_clinic ON appointment (clinic_id);
CREATE INDEX appointment_patient ON appointment (patient_id);
CREATE INDEX payment_clinic ON payment (clinic_id);
CREATE INDEX payment_appointment ON payment (appointment_id);
CREATE INDEX service_clinic ON service (clinic_id);
CREATE INDEX visit_request_clinic ON visit_request (clinic_id);
CREATE INDEX notice_clinic ON notice (clinic_id);
`;

const quote = (value) => (value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`);
const insert = (table, rows) =>
  rows
    .map((row) => `INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.values(row).map(quote).join(', ')});`)
    .join('\n');

function rows() {
  const clinics = [
    { id: 'north', name: 'North Family Clinic', intake_address: ADDRESSES.north.intake, public_address: ADDRESSES.north.public },
    { id: 'south', name: 'South Street Clinic', intake_address: ADDRESSES.south.intake, public_address: ADDRESSES.south.public },
    { id: 'east', name: 'East Side Clinic', intake_address: ADDRESSES.east.intake, public_address: ADDRESSES.east.public },
  ];
  const patients = [
    { id: 'pt-north-ada', clinic_id: 'north', name: 'Ada North', phone: '555-0101' },
    { id: 'pt-north-ben', clinic_id: 'north', name: 'Ben North', phone: '555-0102' },
    { id: 'pt-south-cy', clinic_id: 'south', name: 'Cy South', phone: '555-0201' },
  ];
  const appointments = [
    { id: 'ap-north-1', clinic_id: 'north', patient_id: 'pt-north-ada', starts_at: '2026-11-02T09:00', status: 'booked', fee_cents: 12000 },
    { id: 'ap-north-2', clinic_id: 'north', patient_id: 'pt-north-ben', starts_at: '2026-11-02T10:00', status: 'booked', fee_cents: 8000 },
    { id: 'ap-south-1', clinic_id: 'south', patient_id: 'pt-south-cy', starts_at: '2026-11-03T09:00', status: 'booked', fee_cents: 9000 },
  ];
  const services = [
    { id: 'sv-north-checkup', clinic_id: 'north', name: 'North check-up', price_cents: 12000, published: 1 },
    { id: 'sv-north-internal', clinic_id: 'north', name: 'North staff screening', price_cents: 0, published: 0 },
    { id: 'sv-south-checkup', clinic_id: 'south', name: 'South check-up', price_cents: 9000, published: 1 },
  ];
  return [insert('clinic', clinics), insert('patient', patients), insert('appointment', appointments), insert('service', services)].join(
    '\n',
  );
}

/** A new SQLite file with the clinic's tables and rows. */
export function seedSqlite(file) {
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;\n${TABLES}\n${rows()}`);
  } finally {
    db.close();
  }
}

/** The clinic's tables and rows in an empty PostgreSQL database, through a `pg` client the caller connected. */
export async function seedPostgres(client) {
  await client.query(`${TABLES}\n${rows()}`);
}
