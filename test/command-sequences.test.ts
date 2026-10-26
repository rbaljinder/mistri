/**
 * The numbers a command hands out (commandSequences.ts): one row per
 * sequence in a reserved table the journal migration provisions, advanced in
 * the command's transaction. Each App, tenant and `per` value counts on its
 * own; a transaction that rolls back takes no number; a foreign layout, or
 * none at all, refuses rather than being altered.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { createSqliteCommandJournal, migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { CommandJournal, CommandJournalTenant } from '../packages/mistri/src/adapters/commands/commandJournalTypes.js';
import {
  COMMAND_SEQUENCE_META_TABLE,
  COMMAND_SEQUENCE_TABLE,
  CommandSequenceUnavailable,
  handlerNextNumber,
} from '../packages/mistri/src/adapters/commands/commandSequences.js';

function database(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-command-sequences-'));
  const path = join(directory, 'sequences.db');
  new DatabaseSync(path).close();
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { path, db };
}

const tenant = (tenantId: string): CommandJournalTenant => ({
  appId: 'desk',
  storeId: 'store',
  sourceId: 'business',
  tenantId,
  actorId: 'alice',
  membershipId: `${tenantId}-alice`,
  membershipVersion: '1',
  tenantVersion: '1',
  roles: ['sales'],
  deployment: 'one',
});

/** Run `work` in one transaction with a journal of `owner`, committing unless it throws. */
async function inTransaction<T>(
  db: DatabaseSync,
  owner: CommandJournalTenant | undefined,
  work: (journal: CommandJournal) => Promise<T>,
): Promise<T> {
  const operations = new TransactionOperations();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = await work(createSqliteCommandJournal(db, operations, owner));
    await operations.finish();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    await operations.finish().catch(() => {});
    db.exec('ROLLBACK');
    throw error;
  }
}

test('the journal migration provisions the sequence store, and adds it to a journal that predates it', (t) => {
  const { path, db } = database(t);
  assert.deepEqual(migrateSqliteCommandJournal(path), { version: 1, migrated: true });
  assert.ok(db.prepare('SELECT 1 FROM sqlite_schema WHERE name = ?').get(COMMAND_SEQUENCE_TABLE));
  assert.deepEqual(migrateSqliteCommandJournal(path), { version: 1, migrated: false });
  db.exec(`DROP TABLE "${COMMAND_SEQUENCE_META_TABLE}"; DROP TABLE "${COMMAND_SEQUENCE_TABLE}"`);
  assert.deepEqual(migrateSqliteCommandJournal(path), { version: 1, migrated: true });
  assert.ok(db.prepare('SELECT 1 FROM sqlite_schema WHERE name = ?').get(COMMAND_SEQUENCE_TABLE));
});

test('numbers count per App, per value and per tenant, from where they start', async (t) => {
  const { path, db } = database(t);
  migrateSqliteCommandJournal(path);
  const take = (
    owner: CommandJournalTenant | undefined,
    appId: string,
    name: string,
    options?: { per?: string | number; start?: number },
  ) => inTransaction(db, owner, async (journal) => handlerNextNumber(journal, appId)(name, options));
  assert.deepEqual(
    [
      await take(undefined, 'desk', 'lead', { per: 7, start: 1001 }),
      await take(undefined, 'desk', 'lead', { per: 7, start: 1001 }),
      await take(undefined, 'desk', 'lead', { per: '7' }),
    ],
    [1001, 1002, 1003],
    '7 and "7" are one dealer, read back through two drivers',
  );
  assert.equal(await take(undefined, 'desk', 'lead', { per: 8, start: 1001 }), 1001);
  assert.equal(await take(undefined, 'desk', 'payment'), 1);
  assert.equal(await take(undefined, 'other-app', 'lead', { per: 7 }), 1);
  // A tenant's numbers never show how many another has taken.
  assert.equal(await take(tenant('north'), 'desk', 'lead', { per: 7 }), 1);
  assert.equal(await take(tenant('north'), 'desk', 'lead', { per: 7 }), 2);
  assert.equal(await take(tenant('south'), 'desk', 'lead', { per: 7 }), 1);
  // A bound journal numbers only for its own App.
  await assert.rejects(take(tenant('north'), 'other-app', 'lead'));
});

/* A seed, an import or the rows before the App wrote SR-1 to SR-40 without
   taking numbers; the handler says the highest as `after`. */
test('numbers start past the rows a seed wrote, and stay past them as the count catches up', async (t) => {
  const { path, db } = database(t);
  migrateSqliteCommandJournal(path);
  const take = (options: { per?: string | number; start?: number; after?: number | null }) =>
    inTransaction(db, undefined, async (journal) => handlerNextNumber(journal, 'desk')('service_review', options));
  // First use, rows already there: past them, not at start.
  assert.equal(await take({ start: 3, after: 40 }), 41);
  // The count is ahead of the rows now; a stale highest changes nothing.
  assert.equal(await take({ start: 3, after: 40 }), 42);
  // A row written outside commands since: past it again.
  assert.equal(await take({ start: 3, after: 60 }), 61);
  // No rows yet (a max over an empty table is null): from start.
  assert.equal(await take({ per: 'empty', start: 3, after: null }), 3);
  assert.equal(await take({ per: 'empty', start: 3, after: 0 }), 4);
  // Two commands that read the same highest take two numbers: the floor never pulls the count back.
  assert.deepEqual([await take({ per: 'pair', after: 9 }), await take({ per: 'pair', after: 9 })], [10, 11]);
});

test('a transaction that rolls back takes no number', async (t) => {
  const { path, db } = database(t);
  migrateSqliteCommandJournal(path);
  const next = (journal: CommandJournal) => handlerNextNumber(journal, 'desk')('lead', { per: 1 });
  assert.equal(await inTransaction(db, undefined, next), 1);
  await assert.rejects(
    inTransaction(db, undefined, async (journal) => {
      await next(journal);
      throw new Error('refused');
    }),
    /refused/,
  );
  assert.equal(await inTransaction(db, undefined, next), 2);
});

test('a request the store cannot keep is refused before it is taken', async (t) => {
  const { path, db } = database(t);
  migrateSqliteCommandJournal(path);
  for (const [name, options, reason] of [
    ['Lead', undefined, /lower case/],
    ['', undefined, /lower case/],
    ['lead', { per: null }, /never null/],
    ['lead', { per: {} }, /text or a number/],
    ['lead', { start: 0 }, /1 or more/],
    ['lead', { start: 1.5 }, /whole number/],
    ['lead', { every: 'dealer' }, /"every" is not an option/],
    ['lead', { after: -1 }, /0 or more/],
    ['lead', { after: '12' }, /whole number/],
    ['lead', { after: Number.MAX_SAFE_INTEGER }, /whole number/],
  ] as const) {
    await assert.rejects(
      inTransaction(db, undefined, (journal) => handlerNextNumber(journal, 'desk')(name, options as never)),
      reason,
    );
  }
  assert.equal(db.prepare(`SELECT count(*) AS n FROM "${COMMAND_SEQUENCE_TABLE}"`).get()!.n, 0);
});

test('a missing or foreign sequence store refuses, and is never altered', async (t) => {
  const { path, db } = database(t);
  migrateSqliteCommandJournal(path);
  db.exec(`DROP TABLE "${COMMAND_SEQUENCE_TABLE}"`);
  await assert.rejects(
    inTransaction(db, undefined, (journal) => handlerNextNumber(journal, 'desk')('lead')),
    CommandSequenceUnavailable,
  );
  db.exec(`CREATE TABLE "${COMMAND_SEQUENCE_TABLE}" (app_id TEXT, name TEXT, per TEXT, value INTEGER)`);
  await assert.rejects(
    inTransaction(db, undefined, (journal) => handlerNextNumber(journal, 'desk')('lead')),
    CommandSequenceUnavailable,
  );
  assert.throws(() => migrateSqliteCommandJournal(path), CommandSequenceUnavailable);
  assert.deepEqual(
    db
      .prepare(`SELECT name FROM pragma_table_info('${COMMAND_SEQUENCE_TABLE}')`)
      .all()
      .map((row) => row.name),
    ['app_id', 'name', 'per', 'value'],
  );
});
