/** A suite remembers what each App granted, start by start, so the Console can say what changed and since when. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openSuiteAuthorityStore, provisionSuiteAuthorityStore } from '../packages/mistri/src/server/auth/suiteAuthority.js';

test('a start records only a changed authority, and the earlier one is read with when the current took effect', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-suite-authority-')),
    file = join(dir, 'identity.db.authority');
  let db = new DatabaseSync(file);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  provisionSuiteAuthorityStore(db, 'shared');
  let store = openSuiteAuthorityStore(db, 'shared');
  store.record('alpha', 'one', 1000);
  assert.equal(store.previous('alpha'), undefined, 'one start has nothing earlier');
  store.record('alpha', 'one', 2000);
  assert.equal(store.previous('alpha'), undefined, 'a restart with the same lock adds nothing');
  store.record('alpha', 'two', 3000);
  store.record('beta', 'other', 3500);
  assert.deepEqual(store.previous('alpha'), { report: 'one', at: 3000 });
  db.close();
  db = new DatabaseSync(file);
  store = openSuiteAuthorityStore(db, 'shared');
  store.record('alpha', 'two', 4000);
  assert.deepEqual(store.previous('alpha'), { report: 'one', at: 3000 }, 'the history survives a restart');
  store.record('alpha', 'three', 5000);
  assert.deepEqual(store.previous('alpha'), { report: 'two', at: 5000 });
  assert.equal(store.previous('beta'), undefined);
  assert.throws(() => db.exec("DELETE FROM suite_authority WHERE app_id = 'alpha'"), /append-only/);
  assert.throws(() => store.record('../alpha', 'x'), /Invalid/);
  assert.throws(() => openSuiteAuthorityStore(db, 'foreign'));
});

test('recognition refuses foreign schemas, bindings, attached databases, temp shadows and altered rows', () => {
  for (const sql of [
    'CREATE TABLE unexpected(id TEXT)',
    "ATTACH DATABASE ':memory:' AS other",
    'CREATE TEMP TABLE suite_authority(id INTEGER)',
    "UPDATE suite_authority_binding SET suite_id = 'foreign'",
    'CREATE INDEX extra ON suite_authority(recorded_at)',
  ]) {
    const db = new DatabaseSync(':memory:');
    try {
      provisionSuiteAuthorityStore(db, 'shared');
      const store = openSuiteAuthorityStore(db, 'shared');
      db.exec(sql);
      assert.throws(() => openSuiteAuthorityStore(db, 'shared'), /Suite authority|store/, sql);
      assert.throws(() => store.previous('alpha'), /Suite authority|store/, sql);
      assert.throws(() => store.record('alpha', 'one'), /Suite authority|store/, sql);
    } finally {
      db.close();
    }
  }
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE user(id TEXT)');
    assert.throws(() => provisionSuiteAuthorityStore(db, 'shared'), /unavailable/, 'provisioning wants an empty database');
    db.exec('DROP TABLE user');
    provisionSuiteAuthorityStore(db, 'shared');
    const store = openSuiteAuthorityStore(db, 'shared');
    store.record('alpha', 'one', 1);
    store.record('alpha', 'two', 2);
    // A row whose text no longer matches its digest is not history the room repeats.
    db.exec('DROP TRIGGER suite_authority_no_update');
    db.exec("UPDATE suite_authority SET report = 'forged' WHERE report = 'one'");
    db.exec(
      "CREATE TRIGGER suite_authority_no_update BEFORE UPDATE ON suite_authority BEGIN SELECT RAISE(ABORT, 'Suite authority history is append-only.'); END",
    );
    assert.throws(() => store.previous('alpha'), /unavailable/);
  } finally {
    db.close();
  }
});
