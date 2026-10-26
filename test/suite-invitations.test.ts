/** App-owned invitations bind a single subject and grant revision, never email. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import {
  openSuiteGrantStore,
  provisionSuiteGrantStore,
  SuiteGrantConflict,
  SuiteInvitationRefused,
} from '../packages/mistri/src/server/auth/suiteGrantStore.js';

const now = 1000,
  week = 7 * 24 * 60 * 60 * 1000;
const authority = { administratorRevision: 1 };
const admin = {
  appId: 'leads',
  subjectId: 'administrator',
  actorId: 'operator',
  expectedRevision: 0,
  declaredRoles: ['reader', 'admin'],
  roles: ['admin'],
};
const invitation = { ...admin, subjectId: 'target', actorId: 'administrator', roles: ['reader'], expiresAt: now + week };
const acceptance = (token: string) => ({ appId: 'leads', subjectId: 'target', token, declaredRoles: ['reader', 'admin'] });
function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  provisionSuiteGrantStore(db, 'keystone');
  const store = openSuiteGrantStore(db, 'keystone');
  store.change(admin);
  return { db, store };
}
function snapshot(db: DatabaseSync) {
  return ['suite_grant', 'suite_grant_audit', 'suite_invitation', 'suite_invitation_audit'].map((table) =>
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  );
}

test('invitation persists across a real reopen with only a token hash and immutable audit', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-suite-invitations-')),
    path = join(dir, 'grants.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let db = new DatabaseSync(path);
  t.after(() => db.close());
  provisionSuiteGrantStore(db, 'keystone');
  let store = openSuiteGrantStore(db, 'keystone');
  store.change(admin);
  const roles = ['reader'];
  const issued = store.issueInvitation({ ...invitation, roles }, authority, now);
  roles[0] = 'admin';
  assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(issued.token, 'base64url').length, 32);
  assert.ok(Object.isFrozen(issued.roles));
  const hash = createHash('sha256').update(issued.token).digest('hex');
  assert.equal(db.prepare('SELECT token_hash FROM suite_invitation').get()?.token_hash, hash);
  assert.equal(db.prepare('SELECT version FROM suite_binding').get()?.version, 1);
  assert.equal(JSON.stringify(snapshot(db)).includes(issued.token), false);
  db.close();
  assert.equal(readFileSync(path).includes(issued.token), false);
  db = new DatabaseSync(path);
  store = openSuiteGrantStore(db, 'keystone');
  const otherDb = new DatabaseSync(path);
  t.after(() => otherDb.close());
  const other = openSuiteGrantStore(otherDb, 'keystone');
  assert.throws(() => db.exec('UPDATE suite_invitation SET roles = \'["admin"]\''), /immutable/);
  assert.deepEqual(store.acceptInvitation(acceptance(issued.token), now + 1), { revision: 1, roles: ['reader'] });
  assert.throws(() => other.acceptInvitation(acceptance(issued.token), now + 2), SuiteInvitationRefused);
  assert.deepEqual(other.read('target', 'leads'), { revision: 1, roles: ['reader'] });
  const audit = db.prepare("SELECT actor_id, at FROM suite_grant_audit WHERE subject_id = 'target'").get();
  assert.equal(audit?.actor_id, 'administrator');
  assert.equal(audit?.at, now + 1);
  assert.deepEqual(
    db
      .prepare('SELECT event FROM suite_invitation_audit ORDER BY rowid')
      .all()
      .map((row) => row.event),
    ['issue', 'accept'],
  );
  assert.throws(() => db.exec('DELETE FROM suite_invitation_audit'), /append-only/);
  assert.throws(() => db.exec("UPDATE suite_invitation_audit SET actor_id = 'forged'"), /append-only/);
  assert.throws(() => db.exec('UPDATE suite_invitation SET consumed_at = NULL'), /terminal/);
  assert.throws(() => db.exec('DELETE FROM suite_invitation'), /permanent/);
});

test('acceptance binds App, subject, and token without consuming on refusal', (t) => {
  const { db, store } = fixture(t),
    issued = store.issueInvitation(invitation, authority, now);
  const before = snapshot(db);
  for (const input of [
    { ...acceptance(issued.token), appId: 'dealer' },
    { ...acceptance(issued.token), subjectId: 'other' },
    acceptance('A'.repeat(43)),
  ]) {
    assert.throws(() => store.acceptInvitation(input, now), SuiteInvitationRefused);
    assert.deepEqual(snapshot(db), before);
  }
  assert.equal(store.acceptInvitation(acceptance(issued.token), now).revision, 1);
});

test('a changed role declaration that invalidates the issuer also refuses outstanding invitations', (t) => {
  const { store } = fixture(t);
  store.change({ ...admin, roles: ['admin', 'retired'], declaredRoles: ['admin', 'reader', 'retired'], expectedRevision: 1 });
  const issued = store.issueInvitation({ ...invitation, declaredRoles: ['admin', 'reader', 'retired'] }, { administratorRevision: 2 }, now);
  assert.throws(() => store.acceptInvitation(acceptance(issued.token), now + 1), SuiteInvitationRefused);
  assert.equal(store.read('target', 'leads').revision, 0);
});

test('expiry is exclusive, lifetime is at most seven days, and roles must be declared and nonempty', (t) => {
  const { db, store } = fixture(t);
  for (const expiresAt of [now, now - 1, now + week + 1, Infinity, 1.5]) {
    assert.throws(() => store.issueInvitation({ ...invitation, expiresAt }, authority, now));
  }
  for (const roles of [[], ['foreign'], ['reader', 'reader']]) {
    assert.throws(() => store.issueInvitation({ ...invitation, roles }, authority, now));
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM suite_invitation').get()?.n, 0);
  const expired = store.issueInvitation(invitation, authority, now);
  const before = snapshot(db);
  assert.throws(() => store.acceptInvitation(acceptance(expired.token), now + week), SuiteInvitationRefused);
  assert.throws(() => store.acceptInvitation(acceptance(expired.token), now + week + 1), SuiteInvitationRefused);
  assert.throws(() => store.acceptInvitation(acceptance(expired.token), now - 1), SuiteInvitationRefused);
  assert.deepEqual(snapshot(db), before);
  const valid = store.issueInvitation(invitation, authority, now);
  assert.equal(store.acceptInvitation(acceptance(valid.token), now + week - 1).revision, 1);
});

test('issue and revoke require current same-App administrator authority, and revoked invitations stay terminal', (t) => {
  const { db, store } = fixture(t);
  assert.throws(() => store.issueInvitation({ ...invitation, appId: 'dealer' }, authority, now), SuiteInvitationRefused);
  assert.throws(() => store.issueInvitation(invitation, { administratorRevision: 2 }, now), SuiteInvitationRefused);
  const issued = store.issueInvitation(invitation, authority, now);
  const revoke = { appId: 'leads', id: issued.id, actorId: 'administrator' };
  store.change({ ...admin, appId: 'dealer', subjectId: 'dealer-admin' });
  const before = snapshot(db);
  assert.throws(() => store.revokeInvitation({ ...revoke, actorId: 'dealer-admin' }, authority, now), SuiteInvitationRefused);
  assert.throws(
    () => store.revokeInvitation({ ...revoke, appId: 'dealer', actorId: 'dealer-admin' }, authority, now),
    SuiteInvitationRefused,
  );
  assert.throws(() => store.revokeInvitation(revoke, { administratorRevision: 2 }, now), SuiteInvitationRefused);
  assert.deepEqual(snapshot(db), before);
  store.revokeInvitation(revoke, authority, now + 1);
  const revoked = snapshot(db);
  assert.throws(() => store.acceptInvitation(acceptance(issued.token), now + 2), SuiteInvitationRefused);
  assert.throws(() => store.revokeInvitation(revoke, authority, now + 2), SuiteInvitationRefused);
  assert.throws(() => db.exec('UPDATE suite_invitation SET revoked_at = NULL'), /terminal/);
  assert.deepEqual(snapshot(db), revoked);
  assert.deepEqual(
    db
      .prepare('SELECT event FROM suite_invitation_audit ORDER BY rowid')
      .all()
      .map((row) => row.event),
    ['issue', 'revoke'],
  );
});

test('issuer revocation and restoration never revive invitations issued under the old admin revision', (t) => {
  const { db, store } = fixture(t),
    issued = store.issueInvitation(invitation, authority, now);
  store.change({ ...admin, roles: [], expectedRevision: 1 });
  let before = snapshot(db);
  assert.throws(() => store.acceptInvitation(acceptance(issued.token), now), SuiteInvitationRefused);
  assert.throws(() => store.issueInvitation(invitation, authority, now), SuiteInvitationRefused);
  assert.deepEqual(snapshot(db), before);
  store.change({ ...admin, expectedRevision: 2 });
  before = snapshot(db);
  assert.throws(() => store.acceptInvitation(acceptance(issued.token), now), SuiteInvitationRefused);
  assert.throws(() => store.issueInvitation(invitation, authority, now), SuiteInvitationRefused);
  assert.deepEqual(snapshot(db), before);
  const fresh = store.issueInvitation(invitation, { administratorRevision: 3 }, now);
  assert.equal(store.acceptInvitation(acceptance(fresh.token), now).revision, 1);
});

test('target CAS and revocation tombstones fence both issuance and acceptance without writes', (t) => {
  const { db, store } = fixture(t),
    issued = store.issueInvitation(invitation, authority, now);
  const { expiresAt: _expiresAt, ...target } = invitation;
  store.change(target);
  store.change({ ...target, roles: [], expectedRevision: 1 });
  const before = snapshot(db);
  assert.throws(() => store.issueInvitation(invitation, authority, now), SuiteGrantConflict);
  assert.throws(() => store.acceptInvitation(acceptance(issued.token), now), SuiteGrantConflict);
  assert.deepEqual(snapshot(db), before);
  assert.equal(db.prepare('SELECT consumed_at FROM suite_invitation').get()?.consumed_at, null);
  const fresh = store.issueInvitation({ ...invitation, expectedRevision: 2 }, authority, now);
  assert.equal(store.acceptInvitation(acceptance(fresh.token), now).revision, 3);
});

test('removing a declared role refuses acceptance without consuming or partially applying roles', (t) => {
  const { db, store } = fixture(t),
    issued = store.issueInvitation({ ...invitation, roles: ['reader', 'admin'] }, authority, now);
  const before = snapshot(db);
  assert.throws(() => store.acceptInvitation({ ...acceptance(issued.token), declaredRoles: ['reader'] }, now), SuiteInvitationRefused);
  assert.deepEqual(snapshot(db), before);
  assert.deepEqual(store.acceptInvitation(acceptance(issued.token), now).roles, ['reader', 'admin']);
});

test('grant and invitation audit failures roll back grant, consumption, and both audits together', (t) => {
  const { db, store } = fixture(t);
  const { expiresAt: _expiresAt, ...target } = invitation;
  store.change({ ...target, roles: ['admin'] });
  const issued = store.issueInvitation({ ...invitation, expectedRevision: 1 }, authority, now);
  const before = snapshot(db);
  for (const table of ['suite_grant_audit', 'suite_invitation_audit']) {
    db.exec(`CREATE TRIGGER fail_audit BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'audit failed'); END`);
    assert.throws(() => store.acceptInvitation(acceptance(issued.token), now), /audit failed/);
    assert.deepEqual(snapshot(db), before);
    assert.equal(db.isTransaction, false);
    db.exec('DROP TRIGGER fail_audit');
  }
  assert.deepEqual(store.acceptInvitation(acceptance(issued.token), now), { revision: 2, roles: ['reader'] });
});

test('issue and revoke audit failures roll back their invitation state', (t) => {
  const { db, store } = fixture(t);
  const issued = store.issueInvitation(invitation, authority, now),
    before = snapshot(db);
  db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON suite_invitation_audit BEGIN SELECT RAISE(ABORT, 'audit failed'); END");
  assert.throws(() => store.issueInvitation(invitation, authority, now), /audit failed/);
  assert.throws(() => store.revokeInvitation({ appId: 'leads', id: issued.id, actorId: 'administrator' }, authority, now), /audit failed/);
  assert.deepEqual(snapshot(db), before);
  db.exec('DROP TRIGGER fail_audit');
  assert.equal(store.acceptInvitation(acceptance(issued.token), now).revision, 1);
});

test('inputs and authority are captured without accessors, and caller transactions remain owned by the caller', (t) => {
  const { db, store } = fixture(t),
    issued = store.issueInvitation(invitation, authority, now);
  let invoked = false;
  const badAuthority = {
    get administratorRevision() {
      invoked = true;
      return 1;
    },
  };
  const revoke = { appId: 'leads', id: issued.id, actorId: 'administrator' };
  const before = snapshot(db);
  assert.throws(() =>
    store.issueInvitation(
      {
        ...invitation,
        get subjectId() {
          invoked = true;
          return 'other';
        },
      },
      authority,
      now,
    ),
  );
  assert.throws(() => store.issueInvitation(invitation, badAuthority, now));
  assert.throws(() =>
    store.acceptInvitation(
      {
        ...acceptance(issued.token),
        get token() {
          invoked = true;
          return issued.token;
        },
      },
      now,
    ),
  );
  assert.throws(() => store.revokeInvitation(revoke, badAuthority, now));
  assert.throws(() =>
    store.issueInvitation(
      {
        ...invitation,
        roles: new Proxy(['reader'], {
          get() {
            invoked = true;
            return 'admin';
          },
        }),
      },
      authority,
      now,
    ),
  );
  assert.equal(invoked, false);
  db.exec('BEGIN');
  assert.throws(() => store.issueInvitation(invitation, authority, now), /unavailable/);
  assert.throws(() => store.acceptInvitation(acceptance(issued.token), now), /unavailable/);
  assert.throws(() => store.revokeInvitation(revoke, authority, now), /unavailable/);
  assert.equal(db.isTransaction, true);
  db.exec('ROLLBACK');
  assert.deepEqual(snapshot(db), before);
});

test('a newer and a modified invitation layout refuse without migration or repair', (t) => {
  const old = new DatabaseSync(':memory:');
  t.after(() => old.close());
  old.exec('CREATE TABLE suite_binding (suite_id TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL CHECK(version = 2))');
  old.exec("INSERT INTO suite_binding VALUES ('keystone', 2)");
  const before = old.prepare('SELECT * FROM sqlite_schema').all();
  assert.throws(() => openSuiteGrantStore(old, 'keystone'), /layout version 2, newer than the version 1/);
  assert.deepEqual(old.prepare('SELECT * FROM sqlite_schema').all(), before);
  const { db } = fixture(t);
  db.exec('DROP TRIGGER suite_invitation_audit_no_delete');
  assert.throws(() => openSuiteGrantStore(db, 'keystone'), /unavailable/);
});
