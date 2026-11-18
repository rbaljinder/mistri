/**
 * Proposals over the App's own command door on SQLite: the scenario in support/proposalsOverHttp.ts, over a database
 * of its own. command-proposals-http-postgres.test.ts runs the same scenario on PostgreSQL.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { proposalsOverHttp } from './support/proposalsOverHttp.js';

test(
  'a proposal is approved as its approver, refused without the grant, decided once, failed, dismissed and gone',
  { timeout: 30_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mistri-command-proposals-http-'));
    const file = join(directory, 'lending.db');
    const db = new DatabaseSync(file);
    try {
      db.exec(`CREATE TABLE loan (id INTEGER PRIMARY KEY, title TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE assignment (id INTEGER PRIMARY KEY, loan_id INTEGER NOT NULL REFERENCES loan(id), reviewer TEXT NOT NULL);
      INSERT INTO loan VALUES (1, 'Corner shop', 0), (2, 'Bakery', 0);`);
      migrateSqliteCommandJournal(file);
      await proposalsOverHttp({
        url: file,
        directory,
        table: (name) => `"${name}"`,
        all: async (sql, params = []) =>
          db
            .prepare(sql)
            .all(...(params as never[]))
            .map((row) => ({ ...row })),
      });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
