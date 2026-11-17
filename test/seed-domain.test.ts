/**
 * `tablewalk seed` on a clinic: the first picture of someone's own App has to
 * look like their domain. Lookup tables are a handful of named rows, the words
 * follow the table and column names, text is filled, money declared in minor
 * units is in cents, every parent has children, and the schedule has a today.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { connect } from '../packages/engine/src/adapters/connect.js';
import { seedDatabase } from '../packages/engine/src/server/seed/seed.js';
import { detectDomain, lookupList, wordsFor } from '../packages/engine/src/server/seed/lexicon.js';

const CLINIC = `
CREATE TABLE departments (id INTEGER PRIMARY KEY, name TEXT NOT NULL, floor TEXT, phone TEXT);
CREATE TABLE specialties (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE payment_methods (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE doctors (id INTEGER PRIMARY KEY, name TEXT NOT NULL, title TEXT, email TEXT NOT NULL UNIQUE, department_id INTEGER NOT NULL REFERENCES departments(id), specialty_id INTEGER REFERENCES specialties(id));
CREATE TABLE patients (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, phone TEXT, city TEXT, occupation TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE appointments (id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patients(id), doctor_id INTEGER NOT NULL REFERENCES doctors(id), scheduled_at TEXT NOT NULL, reason TEXT, diagnosis TEXT, notes TEXT);
CREATE TABLE lab_tests (id INTEGER PRIMARY KEY, name TEXT NOT NULL, code TEXT, price INTEGER NOT NULL);
CREATE TABLE lab_orders (id INTEGER PRIMARY KEY, appointment_id INTEGER NOT NULL REFERENCES appointments(id), lab_test_id INTEGER NOT NULL REFERENCES lab_tests(id), summary TEXT, notes TEXT);
CREATE TABLE invoices (id INTEGER PRIMARY KEY, appointment_id INTEGER NOT NULL REFERENCES appointments(id), payment_method_id INTEGER REFERENCES payment_methods(id), total INTEGER NOT NULL);
`;

const TODAY = new Date('2026-10-10T15:00:00Z');
const dir = mkdtempSync(join(tmpdir(), 'tw-seed-domain-'));
after(() => rmSync(dir, { recursive: true, force: true }));

async function seeded(rows: number, minor?: string[]) {
  const file = join(dir, `clinic-${Math.random().toString(36).slice(2)}.db`);
  const db = new DatabaseSync(file);
  db.exec(CLINIC);
  db.close();
  const adapter = connect(file, { schemas: [] });
  try {
    const schema = await adapter.introspect();
    const resources = Object.fromEntries(schema.tables.map((t) => [t.name, t.name === 'invoices' && minor ? { minor } : {}]));
    await seedDatabase(adapter, schema, { rows, seed: 11, today: TODAY, resources });
  } finally {
    await adapter.close();
  }
  const read = new DatabaseSync(file, { readOnly: true });
  const all = (sql: string) => read.prepare(sql).all() as Array<Record<string, any>>;
  return { all, close: () => read.close() };
}

describe('seed reads the domain off the schema', async () => {
  const clinic = await seeded(40, ['total']);
  after(() => clinic.close());

  test('the schema is recognized as a clinic', () => {
    assert.equal(detectDomain(['patients', 'appointments', 'lab_orders'], ['reason', 'diagnosis']), 'clinical');
    assert.equal(detectDomain(['things'], ['id']), 'general');
  });

  test('lookup tables are a handful of named, unique rows in the domain’s words', () => {
    for (const table of ['departments', 'specialties', 'payment_methods']) {
      const names = clinic.all(`SELECT name FROM ${table} ORDER BY id`).map((r) => String(r.name));
      assert.ok(names.length >= 4 && names.length <= 8, `${table}: ${names.length} rows`);
      assert.equal(new Set(names).size, names.length, `${table} repeats a name`);
    }
    const departments = clinic.all('SELECT name FROM departments').map((r) => r.name);
    assert.ok(
      departments.every((name) => wordsFor('clinical', 'department').includes(name)),
      departments.join(),
    );
    assert.ok(departments.includes('Cardiology'));
    assert.deepEqual(lookupList('clinical', 'specialties')!.slice(0, 2), ['Family medicine', 'Cardiology']);
  });

  test('text follows the table and column: titles are jobs, tests are tests, reasons are visits', () => {
    const jobs = wordsFor('clinical', 'job');
    for (const { title } of clinic.all('SELECT title FROM doctors WHERE title IS NOT NULL')) assert.ok(jobs.includes(title), title);
    const tests = clinic.all('SELECT name FROM lab_tests').map((r) => String(r.name));
    assert.ok(tests.includes('Complete blood count'));
    const visits = wordsFor('clinical', 'subject');
    for (const { reason } of clinic.all('SELECT reason FROM appointments WHERE reason IS NOT NULL'))
      assert.ok(visits.includes(reason), reason);
    const everything = JSON.stringify([
      clinic.all('SELECT * FROM departments'),
      clinic.all('SELECT * FROM doctors'),
      clinic.all('SELECT * FROM lab_tests'),
      clinic.all('SELECT * FROM lab_orders'),
      clinic.all('SELECT * FROM appointments'),
    ]);
    assert.doesNotMatch(everything, /Classic|grip|Leaking at the seal|Lab order|bracket|Bright widget/);
  });

  test('people are not named twice in a table', () => {
    for (const table of ['patients', 'doctors']) {
      const names = clinic.all(`SELECT name FROM ${table}`).map((r) => r.name);
      assert.equal(new Set(names).size, names.length, `${table} repeats a name`);
    }
  });

  test('nullable text is filled nearly always; a note may be blank', () => {
    const rate = (table: string, column: string) => {
      const [{ n, filled }] = clinic.all(`SELECT count(*) AS n, count(NULLIF(trim(${column}), '')) AS filled FROM ${table}`);
      return filled / n;
    };
    for (const [table, column] of [
      ['patients', 'phone'],
      ['patients', 'city'],
      ['patients', 'occupation'],
      ['doctors', 'title'],
      ['appointments', 'reason'],
      ['appointments', 'diagnosis'],
      ['lab_orders', 'summary'],
      ['departments', 'floor'],
    ])
      assert.ok(rate(table, column) >= 0.8, `${table}.${column} is ${Math.round(rate(table, column) * 100)}% filled`);
  });

  test('money declared in minor units is stored in cents; undeclared stays in dollars', async () => {
    const totals = clinic.all('SELECT total FROM invoices').map((r) => Number(r.total));
    assert.ok(totals.length > 0);
    assert.ok(totals.every((t) => Number.isInteger(t)));
    assert.ok(totals.filter((t) => t >= 2000).length > totals.length / 2, `cents: ${totals.slice(0, 5)}`);
    const plain = await seeded(40);
    try {
      const dollars = plain.all('SELECT total FROM invoices').map((r) => Number(r.total));
      assert.ok(Math.max(...dollars) <= 2500, `dollars: ${Math.max(...dollars)}`);
    } finally {
      plain.close();
    }
  });

  test('every parent has children, and not evenly', () => {
    for (const [parent, child, column] of [
      ['patients', 'appointments', 'patient_id'],
      ['doctors', 'appointments', 'doctor_id'],
      ['departments', 'doctors', 'department_id'],
      ['appointments', 'lab_orders', 'appointment_id'],
      ['lab_tests', 'lab_orders', 'lab_test_id'],
    ] as const) {
      const rows = clinic.all(`SELECT p.id, count(c.id) AS n FROM ${parent} p LEFT JOIN ${child} c ON c.${column} = p.id GROUP BY p.id`);
      assert.ok(
        rows.every((r) => r.n > 0),
        `${parent} without ${child}`,
      );
      const counts = rows.map((r) => r.n);
      assert.ok(Math.max(...counts) > Math.min(...counts), `${child} per ${parent} is flat`);
    }
  });

  test('the schedule spans a fortnight either side of today', () => {
    const days = clinic.all('SELECT substr(scheduled_at, 1, 10) AS day FROM appointments').map((r) => String(r.day));
    const today = TODAY.toISOString().slice(0, 10);
    const ahead = days.filter((d) => d > today);
    const behind = days.filter((d) => d < today);
    assert.ok(days.includes(today), 'nothing today');
    assert.ok(ahead.length >= 3, 'nothing ahead');
    assert.ok(behind.length >= 3, 'nothing behind');
    const fortnight = new Date(TODAY.getTime() - 14 * 86_400_000).toISOString().slice(0, 10);
    assert.ok(behind.every((d) => d >= fortnight));
    assert.ok(Math.max(...ahead.map((d) => Date.parse(d))) - Date.parse(today) <= 15 * 86_400_000);
  });
});

test('a table of things that happen at a time dates its plain date around today, and keeps when it was written behind', async () => {
  const file = join(dir, 'bookings.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE bookings (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id),
      date TEXT NOT NULL, created_at TEXT NOT NULL);`);
  db.close();
  const adapter = connect(file, { schemas: [] });
  try {
    const schema = await adapter.introspect();
    await seedDatabase(adapter, schema, { rows: 40, seed: 11, today: TODAY, resources: { customers: {}, bookings: {} } });
  } finally {
    await adapter.close();
  }
  const read = new DatabaseSync(file, { readOnly: true });
  try {
    const today = TODAY.toISOString().slice(0, 10);
    const rows = read.prepare('SELECT substr(date, 1, 10) AS day, substr(created_at, 1, 10) AS written FROM bookings').all() as Array<{
      day: string;
      written: string;
    }>;
    // An upcoming list over the bookings has rows to show, and so does the past.
    assert.ok(rows.filter((r) => r.day > today).length >= 3, 'no booking ahead');
    assert.ok(rows.filter((r) => r.day < today).length >= 3, 'no booking behind');
    // When the booking was written is never in the future.
    assert.ok(
      rows.every((r) => r.written <= today),
      'a booking written after today',
    );
  } finally {
    read.close();
  }
});

test('planned-time columns (at, remind_at) on a schedule-like table spread across a fortnight, deterministically; audit columns stay behind', async () => {
  const run = async (name: string) => {
    const file = join(dir, name);
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE slots (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id),
        at TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE reminders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id),
        remind_at TEXT NOT NULL, created_at TEXT NOT NULL);`);
    db.close();
    const adapter = connect(file, { schemas: [] });
    try {
      await seedDatabase(adapter, await adapter.introspect(), {
        rows: 40,
        seed: 5,
        today: TODAY,
        resources: { customers: {}, slots: {}, reminders: {} },
      });
    } finally {
      await adapter.close();
    }
    const read = new DatabaseSync(file, { readOnly: true });
    try {
      return {
        slots: read.prepare('SELECT at, created_at FROM slots ORDER BY id').all() as Array<{ at: string; created_at: string }>,
        reminders: read.prepare('SELECT remind_at, created_at FROM reminders ORDER BY id').all() as Array<{
          remind_at: string;
          created_at: string;
        }>,
      };
    } finally {
      read.close();
    }
  };
  const first = await run('window-a.db');
  assert.deepEqual(await run('window-b.db'), first);
  const today = TODAY.toISOString().slice(0, 10);
  const edge = (offset: number) => new Date(TODAY.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  for (const days of [first.slots.map((r) => r.at.slice(0, 10)), first.reminders.map((r) => r.remind_at.slice(0, 10))]) {
    assert.ok(days.some((d) => d > today) && days.some((d) => d < today), 'not spread around today');
    assert.ok(
      days.every((d) => d >= edge(-14) && d <= edge(14)),
      'outside the fortnight',
    );
  }
  for (const row of [...first.slots, ...first.reminders]) assert.ok(row.created_at.slice(0, 10) <= today, 'created_at after today');
});
