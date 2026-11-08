/**
 * The saved forms' retention job (forms/draftRetention.ts): an abandoned draft past its expiry is removed with the rows
 * of its own footprint, on a schedule. It never cascades and never takes what another row refers to: a draft something
 * outside its footprint points at stays, whole, and is named. A draft within its period, a submitted one, and a form
 * that keeps its drafts are not touched. The job is wired where the files sweep is (cli/commandHost.ts).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { DRAFT_RETENTION_JOB, keepsDrafts, sweepDrafts } from '../packages/mistri/src/server/forms/draftRetention.js';

const NOW = new Date('2026-11-08T12:00:00.000Z');
const PAST = '2026-11-01T00:00:00.000Z';
const FUTURE = '2026-11-20T00:00:00.000Z';

const form = (abandoned: 'purge' | 'keep') => ({
  kind: 'form',
  command: 'submit',
  steps: [{ command: { id: 'start' } }],
  save: {
    resume: { token: 'tok', expires: 'exp', progress: 'prog', days: 14 },
    draft: { column: 'status', value: 'draft' },
    abandoned,
  },
});
const app = (abandoned: 'purge' | 'keep' = 'purge') =>
  ({ id: 'intake', sources: { main: { default: true } }, views: { apply: form(abandoned) } }) as never;
const registry = { start: { read: ['application', 'contact'], write: ['application', 'contact'], source: 'main' } } as never;

async function world(
  run: (w: { db: DatabaseSync; sweep: (kept?: string[], form?: 'purge' | 'keep') => Promise<number> }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-drafts-'));
  const file = join(directory, 'data.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE application(id INTEGER PRIMARY KEY, status TEXT NOT NULL, tok TEXT, exp TEXT, prog TEXT);
    CREATE TABLE contact(id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES application(id), label TEXT);
    CREATE TABLE outbox(id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES application(id));`);
  const adapter = new SqliteAdapter(file, 'drafts');
  try {
    const schema = await adapter.introspect();
    await run({
      db,
      sweep: (kept = [], which = 'purge') =>
        sweepDrafts(
          app(which),
          registry,
          schema,
          () => adapter,
          NOW,
          (table, key) => kept.push(`${table}:${key}`),
        ),
    });
  } finally {
    await adapter.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const insert = (db: DatabaseSync, id: number, status: string, exp: string | null) =>
  db.prepare('INSERT INTO application VALUES (?, ?, ?, ?, ?)').run(id, status, `hash${id}`, exp, 'start');

test('the job is named for the platform and only an App that purges has one', () => {
  assert.match(DRAFT_RETENTION_JOB, /^mistri-/);
  assert.equal(keepsDrafts(app('purge')), true);
  assert.equal(keepsDrafts(app('keep')), false);
});

test('an expired draft goes with its own rows; a live, a submitted and an unexpiring one stay', async () => {
  await world(async ({ db, sweep }) => {
    insert(db, 1, 'draft', PAST);
    insert(db, 2, 'draft', FUTURE);
    insert(db, 3, 'submitted', PAST);
    insert(db, 4, 'draft', null);
    db.exec(`INSERT INTO contact VALUES (1, 1, 'a'), (2, 1, 'b'), (3, 2, 'c')`);
    assert.equal(await sweep(), 1);
    assert.deepEqual(
      (db.prepare('SELECT id FROM application ORDER BY id').all() as Array<{ id: number }>).map((row) => row.id),
      [2, 3, 4],
    );
    assert.equal(count(db, 'contact'), 1, "only the live draft's contact is left");
    assert.equal(await sweep(), 0, 'and a second run finds nothing');
  });
});

test('a draft something outside its footprint refers to is kept whole and named; nothing cascades', async () => {
  await world(async ({ db, sweep }) => {
    insert(db, 1, 'draft', PAST);
    insert(db, 2, 'draft', PAST);
    db.exec(`INSERT INTO contact VALUES (1, 1, 'a'), (2, 2, 'b'); INSERT INTO outbox VALUES (1, 1)`);
    const kept: string[] = [];
    assert.equal(await sweep(kept), 1, 'the unreferenced one goes');
    assert.deepEqual(kept, ['application:1']);
    assert.equal(count(db, 'application'), 1);
    assert.equal(count(db, 'contact'), 1, "the kept draft's own rows stay with it");
    assert.equal(count(db, 'outbox'), 1);
    db.exec('DELETE FROM outbox');
    assert.equal(await sweep(), 1, 'once nothing refers to it, the next run takes it');
    assert.equal(count(db, 'application'), 0);
    assert.equal(count(db, 'contact'), 0);
  });
});

test('a form that keeps its abandoned drafts loses none', async () => {
  await world(async ({ db, sweep }) => {
    insert(db, 1, 'draft', PAST);
    assert.equal(await sweep([], 'keep'), 0);
    assert.equal(count(db, 'application'), 1);
  });
});

test('drafts not yet due and drafts kept whole never hide an expired one behind them', async () => {
  await world(async ({ db, sweep }) => {
    /* Thirty drafts not yet due come first in table order, then thirty expired ones something refers to, then the one
       that can go: more than a page of each, so a window read in table order would never reach it. */
    for (let id = 1; id <= 30; id++) insert(db, id, 'draft', FUTURE);
    for (let id = 31; id <= 60; id++) {
      insert(db, id, 'draft', '2026-10-01T00:00:00.000Z');
      db.prepare('INSERT INTO outbox VALUES (?, ?)').run(id, id);
    }
    insert(db, 61, 'draft', PAST);
    const kept: string[] = [];
    assert.equal(await sweep(kept), 1, 'the one that can go is reached past the others');
    assert.equal(kept.length, 30, 'every referred-to draft is named once');
    assert.equal(count(db, 'application'), 60);
    assert.equal(db.prepare('SELECT 1 FROM application WHERE id = 61').get(), undefined);
  });
});
