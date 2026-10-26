/** Preferences persist independently of authority and retain clear revisions. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  openSuitePreferencesStore,
  provisionSuitePreferencesStore,
  SuitePreferencesConflict,
} from '../packages/mistri/src/server/auth/suitePreferences.js';

test('account preference CAS and Ask each time revisions survive other handles and restart', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-suite-preferences-')),
    file = join(dir, 'identity.db.preferences');
  let db = new DatabaseSync(file);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  provisionSuitePreferencesStore(db, 'shared');
  let store = openSuitePreferencesStore(db, 'shared');
  const input = { subjectId: 'opaque-1', defaultApp: 'alpha', expectedRevision: 0 };
  assert.deepEqual(store.read(input.subjectId), { defaultApp: null, revision: 0 });
  assert.equal(store.change(input), 1);
  assert.equal(store.change({ ...input, subjectId: 'opaque-2', defaultApp: 'beta' }), 1);
  const otherDb = new DatabaseSync(file);
  try {
    const other = openSuitePreferencesStore(otherDb, 'shared');
    assert.deepEqual(other.read(input.subjectId), { defaultApp: 'alpha', revision: 1 });
    assert.equal(other.change({ ...input, defaultApp: null, expectedRevision: 1 }), 2);
    assert.throws(() => store.change({ ...input, expectedRevision: 1 }), SuitePreferencesConflict);
    assert.throws(() => store.change(input), SuitePreferencesConflict);
    assert.deepEqual(store.read(input.subjectId), { defaultApp: null, revision: 2 });
  } finally {
    otherDb.close();
  }
  db.close();
  db = new DatabaseSync(file);
  store = openSuitePreferencesStore(db, 'shared');
  assert.deepEqual(store.read(input.subjectId), { defaultApp: null, revision: 2 });
  assert.deepEqual(store.read('opaque-2'), { defaultApp: 'beta', revision: 1 });
  assert.equal(store.change({ ...input, expectedRevision: 2 }), 3);
  assert.throws(() => openSuitePreferencesStore(db, 'foreign'), /unavailable/);
  const separate = new DatabaseSync(':memory:');
  try {
    provisionSuitePreferencesStore(separate, 'foreign');
    assert.deepEqual(openSuitePreferencesStore(separate, 'foreign').read(input.subjectId), { defaultApp: null, revision: 0 });
  } finally {
    separate.close();
  }
});

test('recognition refuses foreign schemas, bindings, attached databases and temp shadows without repair', () => {
  for (const sql of [
    'CREATE TABLE unexpected(id TEXT)',
    "ATTACH DATABASE ':memory:' AS other",
    'CREATE TEMP TABLE suite_preference(subject_id TEXT)',
    'DELETE FROM suite_preferences_binding',
    "INSERT INTO suite_preferences_binding VALUES ('foreign', 1)",
    "UPDATE suite_preferences_binding SET suite_id = 'foreign'",
    'CREATE INDEX extra ON suite_preference(default_app)',
  ]) {
    const db = new DatabaseSync(':memory:');
    try {
      provisionSuitePreferencesStore(db, 'shared');
      const store = openSuitePreferencesStore(db, 'shared');
      db.exec(sql);
      assert.throws(() => openSuitePreferencesStore(db, 'shared'), /unavailable/, sql);
      assert.throws(() => store.read('opaque'), /unavailable/, sql);
      assert.throws(() => store.change({ subjectId: 'opaque', defaultApp: 'alpha', expectedRevision: 0 }), /unavailable/, sql);
      assert.equal(db.prepare('SELECT count(*) AS n FROM main.suite_preference').get()!.n, 0);
    } finally {
      db.close();
    }
  }
  for (const sql of ['CREATE TABLE user(id TEXT)', "ATTACH DATABASE ':memory:' AS other", 'CREATE TEMP TABLE shadow(id TEXT)']) {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(sql);
      assert.throws(() => provisionSuitePreferencesStore(db, 'shared'), /unavailable/);
      assert.equal(db.prepare("SELECT 1 FROM main.sqlite_schema WHERE name = 'suite_preference'").get(), undefined);
    } finally {
      db.close();
    }
  }
  const db = new DatabaseSync(':memory:');
  assert.throws(() => openSuitePreferencesStore(db, 'shared'), /unavailable/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sqlite_schema').get()!.n, 0);
  provisionSuitePreferencesStore(db, 'shared');
  const store = openSuitePreferencesStore(db, 'shared');
  assert.throws(() => provisionSuitePreferencesStore(db, 'shared'), /unavailable/);
  db.close();
  assert.throws(() => openSuitePreferencesStore(db, 'shared'), /unavailable/);
  assert.throws(() => store.read('opaque'), /unavailable/);
});

test('caller transactions remain owned by the caller on provision and CAS refusal', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('BEGIN');
    assert.throws(() => provisionSuitePreferencesStore(db, 'shared'), /unavailable/);
    assert.equal(db.isTransaction, true);
    db.exec('ROLLBACK');
    provisionSuitePreferencesStore(db, 'shared');
    const store = openSuitePreferencesStore(db, 'shared');
    db.exec('BEGIN');
    db.prepare('INSERT INTO suite_preference VALUES (?, ?, ?)').run('caller', 'alpha', 1);
    assert.throws(() => store.change({ subjectId: 'other', defaultApp: null, expectedRevision: 0 }), /unavailable/);
    assert.equal(db.isTransaction, true);
    assert.deepEqual(store.read('caller'), { defaultApp: 'alpha', revision: 1 });
    db.exec('ROLLBACK');
    assert.deepEqual(store.read('caller'), { defaultApp: null, revision: 0 });
  } finally {
    db.close();
  }
});

test('invalid inputs, getters and corrupt stored values fail closed', () => {
  const db = new DatabaseSync(':memory:');
  try {
    provisionSuitePreferencesStore(db, 'shared');
    const store = openSuitePreferencesStore(db, 'shared');
    const input = { subjectId: 'opaque', defaultApp: 'alpha', expectedRevision: 0 };
    for (const subjectId of ['', ' padded', 'bad\0id', '\ud800', 'x'.repeat(1025)]) {
      assert.throws(() => store.read(subjectId));
      assert.throws(() => store.change({ ...input, subjectId }));
    }
    for (const defaultApp of ['', '../alpha', 'alpha\n', 'x'.repeat(65), 1, undefined]) {
      assert.throws(() => store.change({ ...input, defaultApp: defaultApp as string }));
    }
    for (const expectedRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER, NaN, Infinity])
      assert.throws(() => store.change({ ...input, expectedRevision }));
    let invoked = false;
    assert.throws(() =>
      store.change({
        ...input,
        get subjectId() {
          invoked = true;
          return 'other';
        },
      }),
    );
    assert.equal(invoked, false);
    assert.throws(() => store.change({ ...input, email: 'user@example.test' } as typeof input));
    assert.deepEqual(store.read('opaque'), { defaultApp: null, revision: 0 });
    for (const [app, revision] of [
      ['../foreign', 1],
      ['alpha', 1.5],
      ['alpha', Number.MAX_SAFE_INTEGER + 1],
    ] as const) {
      db.prepare('INSERT OR REPLACE INTO suite_preference VALUES (?, ?, ?)').run('opaque', app, revision);
      assert.throws(() => store.read('opaque'), /unavailable/);
    }
  } finally {
    db.close();
  }
});
