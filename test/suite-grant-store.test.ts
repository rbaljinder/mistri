/** Persistence and revocation of App grants never rely on email or native roles. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openSuiteGrantStore, provisionSuiteGrantStore, SuiteGrantConflict } from '../packages/mistri/src/server/auth/suiteGrantStore.js';

test('persisted grants retain App scope and tombstone revisions across handles and restarts', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-suite-grants-'));
  const path = join(dir, 'grants.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let db = new DatabaseSync(path);
  t.after(() => db.close());
  provisionSuiteGrantStore(db, 'keystone');
  let store = openSuiteGrantStore(db, 'keystone');
  const input = {
    appId: 'lender',
    subjectId: 'subject-1',
    actorId: 'operator-1',
    expectedRevision: 0,
    declaredRoles: ['reviewer', 'seller', 'admin'],
    roles: ['reviewer'],
  };
  assert.equal(store.change(input).revision, 1);
  store.change({ ...input, appId: 'dealer', roles: ['seller'] });
  assert.deepEqual(await store.lookup('subject-1', 'lender'), ['reviewer']);
  assert.deepEqual(await store.lookup('subject-1', 'dealer'), ['seller']);
  assert.equal(await store.lookup('subject-1', 'leads'), null);
  assert.equal(await store.lookup('subject-2', 'lender'), null);
  db.close();
  db = new DatabaseSync(path);
  store = openSuiteGrantStore(db, 'keystone');
  assert.deepEqual(await store.lookup('subject-1', 'lender'), ['reviewer']);
  const otherDb = new DatabaseSync(path);
  try {
    const other = openSuiteGrantStore(otherDb, 'keystone');
    const observed = other.read('subject-1', 'lender');
    store.change({ ...input, expectedRevision: 1, roles: [] });
    assert.equal(await other.lookup('subject-1', 'lender'), null);
    assert.throws(() => other.change({ ...input, expectedRevision: observed.revision, roles: ['admin'] }), SuiteGrantConflict);
    assert.throws(() => other.change(input), SuiteGrantConflict);
    assert.equal(store.read('subject-1', 'lender').revision, 2);
    assert.equal(store.change({ ...input, expectedRevision: 2, roles: ['admin'] }).revision, 3);
    assert.deepEqual(await other.lookup('subject-1', 'dealer'), ['seller']);
  } finally {
    otherDb.close();
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM suite_grant_audit').get()?.n, 4);
  assert.throws(() => db.exec('DELETE FROM suite_grant_audit'), /append-only/);
  assert.throws(() => db.exec("UPDATE suite_grant_audit SET actor_id='forged'"), /append-only/);
  assert.throws(() => openSuiteGrantStore(db, 'foreign'), /unavailable/);
});

test('invalid grant input never writes, and a failed audit rolls back the grant', () => {
  const db = new DatabaseSync(':memory:');
  try {
    provisionSuiteGrantStore(db, 'keystone');
    const store = openSuiteGrantStore(db, 'keystone');
    const input = {
      appId: 'lender',
      subjectId: 'subject-1',
      actorId: 'operator-1',
      expectedRevision: 0,
      declaredRoles: ['reader', 'admin'],
      roles: ['reader'],
    };
    const sparse = Array<string>(2);
    sparse[0] = 'reader';
    for (const roles of [['foreign'], ['reader', 'reader'], ['reader,admin'], sparse]) {
      assert.throws(() => store.change({ ...input, roles }));
    }
    let called = false;
    assert.throws(() =>
      store.change({
        ...input,
        get actorId() {
          called = true;
          return 'forged';
        },
      }),
    );
    assert.equal(called, false);
    assert.equal(store.read('subject-1', 'lender').revision, 0);
    db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON suite_grant_audit BEGIN SELECT RAISE(ABORT, 'audit failed'); END");
    assert.throws(() => store.change(input), /audit failed/);
    assert.equal(store.read('subject-1', 'lender').revision, 0, 'audit and grant commit together');
    assert.equal(db.prepare('SELECT count(*) AS n FROM suite_grant_audit').get()?.n, 0);
  } finally {
    db.close();
  }
});

test('opening never installs or repairs storage, and malformed stored roles refuse', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.throws(() => openSuiteGrantStore(db, 'keystone'), /unavailable/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM sqlite_schema').get()?.n, 0);
    provisionSuiteGrantStore(db, 'keystone');
    assert.throws(() => provisionSuiteGrantStore(db, 'keystone'), /unavailable/);
    const store = openSuiteGrantStore(db, 'keystone');
    db.prepare('INSERT INTO suite_grant VALUES (?, ?, ?, ?)').run('lender', 'subject-1', 1, '["reader",null]');
    await assert.rejects(store.lookup('subject-1', 'lender'), /unavailable/);
    db.exec('CREATE TABLE unexpected(id TEXT)');
    assert.throws(() => openSuiteGrantStore(db, 'keystone'), /unavailable/);
  } finally {
    db.close();
  }
});

test('ledger ownership refuses foreign layouts and leaves caller transactions alone', () => {
  for (const sql of [
    "ATTACH DATABASE ':memory:' AS other",
    'CREATE TEMP TABLE stray(id TEXT)',
    'DROP TRIGGER suite_grant_audit_no_update',
    'DELETE FROM suite_binding',
  ]) {
    const db = new DatabaseSync(':memory:');
    try {
      provisionSuiteGrantStore(db, 'keystone');
      db.exec(sql);
      assert.throws(() => openSuiteGrantStore(db, 'keystone'), /unavailable/);
    } finally {
      db.close();
    }
  }
  const db = new DatabaseSync(':memory:');
  try {
    provisionSuiteGrantStore(db, 'keystone');
    const store = openSuiteGrantStore(db, 'keystone');
    db.exec('BEGIN');
    assert.throws(
      () =>
        store.change({
          appId: 'leads',
          subjectId: 's',
          actorId: 'operator',
          roles: ['reader'],
          declaredRoles: ['reader'],
          expectedRevision: 0,
        }),
      /unavailable/,
    );
    assert.equal(db.isTransaction, true);
    assert.equal(store.read('s', 'leads').revision, 0);
    db.exec('ROLLBACK');
  } finally {
    db.close();
  }
});

test('audit failures preserve an existing grant, and App administrator revisions are fenced in the change transaction', () => {
  const db = new DatabaseSync(':memory:');
  try {
    provisionSuiteGrantStore(db, 'keystone');
    const store = openSuiteGrantStore(db, 'keystone');
    const grant = {
      appId: 'leads',
      subjectId: 'administrator',
      actorId: 'operator',
      roles: ['admin'],
      declaredRoles: ['reader', 'admin'],
      expectedRevision: 0,
    };
    store.change(grant);
    const target = { ...grant, subjectId: 'reader', actorId: 'administrator', roles: ['reader'] };
    store.change(target, { administratorRevision: 1 });
    assert.throws(() => store.change({ ...target, appId: 'lender' }, { administratorRevision: 1 }), /administrator grant/);
    store.change({ ...grant, roles: [], expectedRevision: 1 });
    assert.throws(() => store.change({ ...target, roles: [], expectedRevision: 1 }, { administratorRevision: 1 }), /administrator grant/);
    store.change({ ...grant, expectedRevision: 2 });
    assert.throws(() => store.change({ ...target, roles: [], expectedRevision: 1 }, { administratorRevision: 1 }), /administrator grant/);
    const before = db.prepare('SELECT * FROM suite_grant_audit ORDER BY rowid').all();
    db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON suite_grant_audit BEGIN SELECT RAISE(ABORT, 'audit failed'); END");
    assert.throws(() => store.change({ ...target, roles: [], expectedRevision: 1 }, { administratorRevision: 3 }), /audit failed/);
    assert.deepEqual(store.read('reader', 'leads'), { revision: 1, roles: ['reader'] });
    assert.deepEqual(db.prepare('SELECT * FROM suite_grant_audit ORDER BY rowid').all(), before);
    let invoked = false;
    const roles = ['reader'];
    Object.defineProperty(roles, '0', {
      get() {
        invoked = true;
        return 'admin';
      },
      enumerable: true,
    });
    assert.throws(() => store.change({ ...target, roles }));
    assert.throws(() =>
      store.change({
        ...target,
        roles: new Proxy(['reader'], {
          get() {
            invoked = true;
            return 'admin';
          },
        }),
      }),
    );
    assert.equal(invoked, false);
  } finally {
    db.close();
  }
});

test("an App's grant changes page newest first for its administrator, by who made them and when", () => {
  const db = new DatabaseSync(':memory:');
  try {
    provisionSuiteGrantStore(db, 'keystone');
    const store = openSuiteGrantStore(db, 'keystone');
    const declaredRoles = ['reviewer', 'admin'];
    const grant = (subjectId: string, actorId: string, roles: string[], expectedRevision = 0) =>
      store.change({ appId: 'lender', subjectId, actorId, expectedRevision, declaredRoles, roles });
    grant('admin-1', 'bootstrap', ['admin']);
    grant('subject-1', 'admin-1', ['reviewer']);
    grant('subject-2', 'admin-1', ['reviewer']);
    grant('subject-1', 'admin-1', [], 1);
    store.change({ appId: 'dealer', subjectId: 'subject-9', actorId: 'admin-1', expectedRevision: 0, declaredRoles, roles: ['reviewer'] });
    const reader = { appId: 'lender', actorId: 'admin-1', declaredRoles };
    const authority = { administratorRevision: store.read('admin-1', 'lender').revision };
    const all = store.listAccessChanges(reader, authority, { limit: 10 });
    // Changes in one millisecond are ordered by id, as the Console's cursor resumes them.
    assert.deepEqual(
      all.map((change) => JSON.stringify([change.subjectId, change.actorId, change.before, change.after])).sort(),
      [
        ['admin-1', 'bootstrap', [], ['admin']],
        ['subject-1', 'admin-1', ['reviewer'], []],
        ['subject-1', 'admin-1', [], ['reviewer']],
        ['subject-2', 'admin-1', [], ['reviewer']],
      ].map((row) => JSON.stringify(row)),
      'another App never appears',
    );
    for (const [index, change] of all.slice(1).entries())
      assert.ok(change.at < all[index].at || (change.at === all[index].at && change.id < all[index].id), 'newest first');
    const first = store.listAccessChanges(reader, authority, { limit: 2 });
    const rest = store.listAccessChanges(reader, authority, { limit: 10, before: { at: first[1].at, id: first[1].id } });
    assert.deepEqual(
      [...first, ...rest].map((change) => change.id),
      all.map((change) => change.id),
      'a cursor resumes where a page ended',
    );
    assert.deepEqual(
      store.listAccessChanges(reader, authority, { actor: 'bootstrap', limit: 10 }).map((change) => change.subjectId),
      ['admin-1'],
    );
    assert.deepEqual(store.listAccessChanges(reader, authority, { from: Math.max(...all.map((change) => change.at)) + 1, limit: 10 }), []);
    assert.throws(() => store.listAccessChanges({ ...reader, actorId: 'subject-2' }, { administratorRevision: 1 }, { limit: 10 }));
    assert.throws(() => store.listAccessChanges(reader, authority, { limit: 0 }), /Invalid/);
  } finally {
    db.close();
  }
});
