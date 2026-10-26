/**
 * The Command desk fixture's database: two desks, four staff, three
 * applications, and the documents and reviews one of them carries.
 *
 *   node --import tsx test/fixtures/apps/command-desk/seed.mjs <new-file.db>
 *
 * Writes the database and `<file>.json`, a writable connection named
 * `reviews`. The command journal assignReviewer needs is migrated into the new
 * file at once, and `loan_application.version` is created with the table
 * rather than added afterwards, so there is no migration to keep in step.
 * Refuses an existing file: every run of the gate gets a fresh one.
 *
 * Deterministic on purpose, and small on purpose — the specs name rows by id
 * (application 1 is the one assigned, application 3 the one with tabs) and
 * reviewer 3 by name. Read e2e/support/commandDeskServer.ts before changing a
 * row.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrateSqliteCommandJournal } from '@mistriwork/mistri/maintenance';

const SCHEMA = `PRAGMA foreign_keys=ON; BEGIN;
  CREATE TABLE review_team (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE reviewer (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, team_id INTEGER NOT NULL REFERENCES review_team(id),
    role TEXT NOT NULL CHECK(role IN ('reviewer','manager')), active BOOLEAN NOT NULL
  );
  CREATE TABLE loan_application (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, reference TEXT NOT NULL UNIQUE,
    team_id INTEGER NOT NULL REFERENCES review_team(id), reviewer_id INTEGER REFERENCES reviewer(id),
    status TEXT NOT NULL CHECK(status IN ('submitted','in_review','decided')),
    version INTEGER NOT NULL DEFAULT 0 CHECK (typeof(version) = 'integer' AND version >= 0)
  );
  CREATE TABLE application_document (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, application_id INTEGER NOT NULL REFERENCES loan_application(id),
    status TEXT NOT NULL CHECK(status IN ('requested','received','reviewed')), received_on DATE
  );
  CREATE TABLE application_review (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, application_id INTEGER NOT NULL REFERENCES loan_application(id),
    reviewer_id INTEGER NOT NULL REFERENCES reviewer(id),
    status TEXT NOT NULL CHECK(status IN ('queued','in_progress','complete')), opened_on DATE NOT NULL, summary TEXT NOT NULL
  );
  CREATE TABLE loan_decision (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, application_id INTEGER NOT NULL UNIQUE REFERENCES loan_application(id),
    decided_by INTEGER NOT NULL REFERENCES reviewer(id), outcome TEXT NOT NULL CHECK(outcome IN ('approved','declined')),
    recorded_on DATE NOT NULL, record_note TEXT NOT NULL
  );
  CREATE TABLE assignment_history (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, application_id INTEGER NOT NULL REFERENCES loan_application(id),
    assigned_to INTEGER NOT NULL REFERENCES reviewer(id), assigned_by INTEGER NOT NULL REFERENCES reviewer(id),
    assigned_on DATE NOT NULL, reason TEXT NOT NULL
  );
  CREATE INDEX document_application ON application_document(application_id);
  CREATE INDEX review_application ON application_review(application_id);
  CREATE INDEX decision_application ON loan_decision(application_id);
  CREATE INDEX assignment_application ON assignment_history(application_id);`;

function insert(db, table, rows) {
  const columns = Object.keys(rows[0]);
  const statement = db.prepare(
    `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
  );
  for (const row of rows) statement.run(...columns.map((column) => row[column]));
}

export function seed(path) {
  const file = resolve(path);
  if (existsSync(file) || existsSync(`${file}.json`)) throw new Error(`Refusing to replace ${file}. Choose a new file.`);
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(SCHEMA);
    insert(db, 'review_team', [
      { id: 1, name: 'North desk' },
      { id: 2, name: 'Central desk' },
    ]);
    /* Two managers, one per desk, and a reviewer on each. The specs sign in as
       the two managers and assign Robin Bell; Avery Shaw is the reviewer on
       the other desk that the row policy must hide and the handler must
       refuse. */
    insert(db, 'reviewer', [
      { id: 1, name: 'Morgan Lee', team_id: 1, role: 'manager', active: 1 },
      { id: 2, name: 'Casey Ellis', team_id: 2, role: 'manager', active: 1 },
      { id: 3, name: 'Robin Bell', team_id: 1, role: 'reviewer', active: 1 },
      { id: 4, name: 'Avery Shaw', team_id: 2, role: 'reviewer', active: 1 },
    ]);
    insert(db, 'loan_application', [
      // 1: the North desk's unassigned application — every assignment the specs run is on this one.
      { id: 1, name: 'AL-1001 / North', reference: 'AL-1001', team_id: 1, reviewer_id: null, status: 'submitted', version: 0 },
      // 2: the other desk's, so "unassigned" is never the same thing as "mine".
      { id: 2, name: 'AL-1002 / Central', reference: 'AL-1002', team_id: 2, reviewer_id: null, status: 'submitted', version: 0 },
      // 3: the one the related tabs are read on — three documents, one review, no decision.
      { id: 3, name: 'AL-1003 / North', reference: 'AL-1003', team_id: 1, reviewer_id: 3, status: 'in_review', version: 0 },
    ]);
    insert(db, 'application_document', [
      { id: 1, name: 'Identity record', application_id: 3, status: 'reviewed', received_on: '2026-08-04' },
      { id: 2, name: 'Income record', application_id: 3, status: 'received', received_on: '2026-08-05' },
      { id: 3, name: 'Vehicle quotation', application_id: 3, status: 'requested', received_on: null },
    ]);
    insert(db, 'application_review', [
      {
        id: 1,
        name: 'Initial review',
        application_id: 3,
        reviewer_id: 3,
        status: 'in_progress',
        opened_on: '2026-08-05',
        summary: 'Synthetic review notes; no assessment is performed.',
      },
    ]);
    insert(db, 'assignment_history', [
      {
        id: 1,
        name: 'Reviewer assigned',
        application_id: 3,
        assigned_to: 3,
        assigned_by: 1,
        assigned_on: '2026-08-04',
        reason: 'Seeded North desk allocation.',
      },
    ]);
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Invalid fixture relationships.');
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  migrateSqliteCommandJournal(file);
  writeFileSync(`${file}.json`, `${JSON.stringify({ connections: [{ name: 'reviews', url: file, writable: true }] }, null, 2)}\n`, {
    flag: 'wx',
  });
  return file;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw new Error('Usage: node --import tsx test/fixtures/apps/command-desk/seed.mjs <new-file.db>');
  console.log(seed(process.argv[2]));
}
