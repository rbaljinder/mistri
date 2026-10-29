/** A suite's grants, preferences and authority history behave the same on SQLite and PostgreSQL: each test runs on
 * both, and on PostgreSQL in a database of its own. The SQLite-only refusals (attached databases, temp shadows, a
 * caller's transaction) stay in the per-store files; PostgreSQL's own refusals are at the end. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { openSuiteGrantStore, provisionSuiteGrantStore, SuiteGrantConflict } from '../packages/mistri/src/server/auth/suiteGrantStore.js';
import {
  openSuitePreferencesStore,
  provisionSuitePreferencesStore,
  SuitePreferencesConflict,
} from '../packages/mistri/src/server/auth/suitePreferences.js';
import { openSuiteAuthorityStore, provisionSuiteAuthorityStore } from '../packages/mistri/src/server/auth/suiteAuthority.js';
import {
  openPostgresSuiteGrantStore,
  openPostgresSuiteStores,
  postgresSuiteStoresPresent,
  provisionPostgresSuiteStore,
  provisionPostgresSuiteStores,
} from '../packages/mistri/src/server/auth/suiteStoresPostgres.js';
import type { SuiteAuthority, SuiteGrants, SuitePreferences } from '../packages/mistri/src/server/auth/suiteStores.js';
import { openPostgresFlagStore, provisionPostgresFlagStore } from '../packages/mistri/src/server/flags/storePostgres.js';
import { normalizeFlagCatalog } from '../packages/mistri/src/shared/appFlags.js';
import { readSuiteConfiguration, type SuiteConfiguration } from '../packages/mistri/src/server/cli/suiteConfig.js';
import { openSuiteIdentity } from '../packages/mistri/src/server/auth/suiteIdentity.js';
import { captureAppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import { migratePostgresAuthStore } from '../packages/mistri/src/adapters/auth/postgresAuthStore.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { liveSkip } from './live.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';

const LIVE = process.env.TABLEWALK_TEST_PG;

interface Opened {
  readonly grants: SuiteGrants;
  readonly preferences: SuitePreferences;
  readonly authority: SuiteAuthority;
  close(): Promise<void>;
}
interface Backend {
  readonly name: 'sqlite' | 'postgres';
  readonly skip: false | string;
  /** A provisioned suite of stores, and a way to open another handle on it; everything is removed after the test. */
  make(t: TestContext, suiteId?: string): Promise<(suiteId?: string) => Promise<Opened>>;
}

const SUITE = 'keystone';
const BACKENDS: readonly Backend[] = [
  {
    name: 'sqlite',
    skip: false,
    async make(t, suiteId = SUITE) {
      const dir = mkdtempSync(join(tmpdir(), 'tw-suite-stores-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const files = { grants: join(dir, 'grants.db'), preferences: join(dir, 'preferences.db'), authority: join(dir, 'authority.db') };
      const provision = (path: string, run: (db: DatabaseSync) => void) => {
        const db = new DatabaseSync(path);
        try {
          run(db);
        } finally {
          db.close();
        }
      };
      provision(files.grants, (db) => provisionSuiteGrantStore(db, suiteId));
      provision(files.preferences, (db) => provisionSuitePreferencesStore(db, suiteId));
      provision(files.authority, (db) => provisionSuiteAuthorityStore(db, suiteId));
      return async (id = suiteId) => {
        const handles = [new DatabaseSync(files.grants), new DatabaseSync(files.preferences), new DatabaseSync(files.authority)];
        const close = async () => handles.forEach((db) => db.isOpen && db.close());
        t.after(close);
        try {
          return {
            grants: openSuiteGrantStore(handles[0], id),
            preferences: openSuitePreferencesStore(handles[1], id),
            authority: openSuiteAuthorityStore(handles[2], id),
            close,
          };
        } catch (error) {
          await close();
          throw error;
        }
      };
    },
  },
  {
    name: 'postgres',
    skip: liveSkip('postgres', LIVE),
    async make(t, suiteId = SUITE) {
      const database = await uuidPostgresDatabase('suite_stores');
      t.after(() => database.drop());
      await provisionPostgresSuiteStores(database.url, suiteId);
      return async (id = suiteId) => {
        const stores = await openPostgresSuiteStores(database.url, id);
        t.after(() => stores.close());
        return stores;
      };
    },
  },
];

const change = {
  appId: 'lender',
  subjectId: 'subject-1',
  actorId: 'operator-1',
  expectedRevision: 0,
  declaredRoles: ['reviewer', 'seller', 'admin'],
  roles: ['reviewer'],
};
const declared = ['reviewer', 'seller', 'admin'];

for (const backend of BACKENDS) {
  const on = (title: string) => `${title} (${backend.name})`;

  test(
    on('grants keep their App scope and revisions across handles, and a stale revision conflicts'),
    { skip: backend.skip },
    async (t) => {
      const open = await backend.make(t);
      const one = await open();
      assert.equal((await one.grants.change(change)).revision, 1);
      await one.grants.change({ ...change, appId: 'dealer', roles: ['seller'] });
      const other = await open();
      assert.deepEqual(await other.grants.lookup('subject-1', 'lender'), ['reviewer']);
      assert.deepEqual(await other.grants.lookup('subject-1', 'dealer'), ['seller']);
      assert.equal(await other.grants.lookup('subject-1', 'leads'), null);
      const observed = await other.grants.read('subject-1', 'lender');
      await one.grants.change({ ...change, expectedRevision: 1, roles: [] });
      assert.equal(await other.grants.lookup('subject-1', 'lender'), null);
      await assert.rejects(
        async () => other.grants.change({ ...change, expectedRevision: observed.revision, roles: ['admin'] }),
        SuiteGrantConflict,
      );
      assert.deepEqual(await other.grants.read('subject-1', 'lender'), { revision: 2, roles: [] });
      await assert.rejects(async () => one.grants.change({ ...change, actorId: 'provider:okta' }), /Invalid suite grant/);
      await assert.rejects(async () => one.grants.read('subject-1', 'not an app'), /Invalid suite grant/);
      await assert.rejects(open('foreign'), /unavailable/);
    },
  );

  test(on('of changes racing on one revision, exactly one is written'), { skip: backend.skip }, async (t) => {
    const open = await backend.make(t);
    const handles = await Promise.all([open(), open(), open()]);
    const outcomes = await Promise.allSettled(
      handles.flatMap((each) => [0, 1].map(async () => each.grants.change({ ...change, roles: ['seller'] }))),
    );
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    for (const outcome of outcomes) if (outcome.status === 'rejected') assert.ok(outcome.reason instanceof SuiteGrantConflict);
    assert.equal((await handles[0].grants.read('subject-1', 'lender')).revision, 1);
  });

  test(on("an App administrator's revision fences a change and a read, under the change's own lock"), { skip: backend.skip }, async (t) => {
    const { grants } = await (await backend.make(t))();
    const admin = await grants.change({ ...change, subjectId: 'admin-1', roles: ['admin'] });
    const authority = { administratorRevision: admin.revision };
    const asAdmin = { ...change, actorId: 'admin-1' };
    assert.equal((await grants.change(asAdmin, authority)).revision, 1);
    const view = await grants.readAdministration(
      { appId: 'lender', subjectId: 'subject-1', actorId: 'admin-1', declaredRoles: declared },
      authority,
    );
    assert.deepEqual(view.roles, ['reviewer']);
    assert.deepEqual(view.assignableRoles, declared);
    await assert.rejects(
      async () => grants.change({ ...asAdmin, expectedRevision: 1 }, { administratorRevision: 2 }),
      /administrator grant changed/,
    );
    await assert.rejects(async () =>
      grants.readAdministration({ appId: 'lender', subjectId: 'subject-1', actorId: 'subject-1', declaredRoles: declared }, authority),
    );
    // The administrator's own grant moves on: the authority it was given no longer counts.
    await grants.change({ ...change, subjectId: 'admin-1', expectedRevision: 1, roles: ['admin', 'seller'] });
    await assert.rejects(async () => grants.change({ ...asAdmin, expectedRevision: 1 }, authority), /administrator grant changed/);
    assert.equal((await grants.read('subject-1', 'lender')).revision, 1);
  });

  test(
    on('an invitation is issued once, accepted once, listed with its status, and a revoked one stays refused'),
    { skip: backend.skip },
    async (t) => {
      const { grants } = await (await backend.make(t))();
      const admin = await grants.change({ ...change, subjectId: 'admin-1', roles: ['admin'] });
      const authority = { administratorRevision: admin.revision };
      const now = Date.now();
      const issue = { ...change, subjectId: 'invitee', actorId: 'admin-1', roles: ['seller'], expiresAt: now + 60_000 };
      const first = await grants.issueInvitation(issue, authority, now - 1);
      assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
      const accept = { appId: 'lender', subjectId: 'invitee', token: first.token, declaredRoles: declared };
      await assert.rejects(async () => grants.acceptInvitation({ ...accept, subjectId: 'someone-else' }));
      assert.deepEqual(await grants.acceptInvitation(accept), { revision: 1, roles: ['seller'] });
      await assert.rejects(async () => grants.acceptInvitation(accept));
      const second = await grants.issueInvitation({ ...issue, expectedRevision: 1 }, authority, now - 1);
      await grants.revokeInvitation({ appId: 'lender', id: second.id, actorId: 'admin-1' }, authority);
      await assert.rejects(async () => grants.acceptInvitation({ ...accept, token: second.token }));
      await assert.rejects(async () => grants.revokeInvitation({ appId: 'lender', id: second.id, actorId: 'admin-1' }, authority));
      const listed = await grants.listInvitations(
        { appId: 'lender', subjectId: 'invitee', actorId: 'admin-1', declaredRoles: declared, offset: 0 },
        authority,
      );
      assert.equal(listed.total, 2);
      // Issued at one instant, the two are in id order; what matters is each one's status.
      assert.deepEqual(
        new Map(listed.invitations.map((each) => [each.id, [each.status, each.canRevoke]])),
        new Map([
          [first.id, ['consumed', false]],
          [second.id, ['revoked', false]],
        ]),
      );
      // An outstanding invitation outlives no change to its issuer's grant.
      const third = await grants.issueInvitation({ ...issue, expectedRevision: 1, roles: ['reviewer'] }, authority, now - 1);
      await grants.change({ ...change, subjectId: 'admin-1', expectedRevision: 1, roles: ['admin', 'reviewer'] });
      const after = await grants.listInvitations(
        { appId: 'lender', subjectId: 'invitee', actorId: 'admin-1', declaredRoles: declared, offset: 0 },
        { administratorRevision: 2 },
      );
      assert.equal(after.invitations.find((each) => each.id === third.id)?.status, 'issuer-changed');
      await assert.rejects(async () => grants.acceptInvitation({ ...accept, token: third.token }));
      assert.deepEqual(await grants.read('invitee', 'lender'), { revision: 1, roles: ['seller'] });
    },
  );

  test(
    on("a grant derived from a provider's claims counts only for its sessions, and never replaces a hand-set one"),
    { skip: backend.skip },
    async (t) => {
      const { grants } = await (await backend.make(t))();
      const derive = { appId: 'lender', subjectId: 'federated', provider: 'okta', declaredRoles: declared, roles: ['reviewer'] };
      assert.deepEqual(await grants.deriveFromClaims(derive), { revision: 1, roles: ['reviewer'] });
      assert.deepEqual(await grants.deriveFromClaims(derive), { revision: 1, roles: ['reviewer'] });
      assert.deepEqual(await grants.readForSession('federated', 'lender', { provider: 'okta' }), { revision: 1, roles: ['reviewer'] });
      assert.deepEqual(await grants.readForSession('federated', 'lender', { provider: undefined }), { revision: 1, roles: [] });
      assert.deepEqual(await grants.readForSession('federated', 'lender', { provider: 'azure' }), { revision: 1, roles: [] });
      assert.deepEqual(await grants.deriveFromClaims({ ...derive, roles: [] }), { revision: 2, roles: [] });
      await grants.change({ ...change, subjectId: 'federated', expectedRevision: 2, roles: ['seller'] });
      assert.deepEqual(await grants.deriveFromClaims(derive), { revision: 3, roles: ['seller'] });
      assert.deepEqual(await grants.readForSession('federated', 'lender', { provider: undefined }), { revision: 3, roles: ['seller'] });
    },
  );

  test(on("an App's holders and changes page newest first, by who made them and when"), { skip: backend.skip }, async (t) => {
    const { grants } = await (await backend.make(t))();
    const admin = await grants.change({ ...change, subjectId: 'admin-1', roles: ['admin'] });
    const authority = { administratorRevision: admin.revision };
    await grants.change({ ...change, actorId: 'admin-1' }, authority);
    await grants.change({ ...change, subjectId: 'subject-2', actorId: 'operator-2', roles: ['seller'] });
    await grants.change({ ...change, appId: 'dealer', roles: ['seller'] });
    const caller = { appId: 'lender', actorId: 'admin-1', declaredRoles: declared };
    const access = await grants.listAccess(caller, authority);
    assert.deepEqual(
      access.grants.map((each) => each.subjectId),
      ['admin-1', 'subject-1', 'subject-2'],
    );
    assert.equal(access.changes.length, 3);
    assert.equal(access.more, false);
    const byAdmin = await grants.listAccessChanges(caller, authority, { actor: 'admin-1', limit: 10 });
    assert.deepEqual(
      byAdmin.map((each) => each.subjectId),
      ['subject-1'],
    );
    const all = await grants.listAccessChanges(caller, authority, { limit: 10 });
    const page = await grants.listAccessChanges(caller, authority, { limit: 10, before: { at: all[0].at, id: all[0].id } });
    assert.deepEqual(
      page.map((each) => each.id),
      all.slice(1).map((each) => each.id),
    );
    assert.deepEqual(await grants.listAccessChanges(caller, authority, { limit: 10, from: Date.now() + 60_000 }), []);
    await assert.rejects(async () => grants.listAccessChanges(caller, authority, { limit: 0 }), /Invalid suite grant/);
  });

  test(on('an account preference is compared and set, and Ask each time keeps its revision'), { skip: backend.skip }, async (t) => {
    const open = await backend.make(t);
    const one = await open();
    assert.deepEqual(await one.preferences.read('subject-1'), { defaultApp: null, revision: 0 });
    assert.equal(await one.preferences.change({ subjectId: 'subject-1', defaultApp: 'lender', expectedRevision: 0 }), 1);
    assert.equal(await one.preferences.change({ subjectId: 'subject-1', defaultApp: null, expectedRevision: 1 }), 2);
    const other = await open();
    assert.deepEqual(await other.preferences.read('subject-1'), { defaultApp: null, revision: 2 });
    await assert.rejects(
      async () => other.preferences.change({ subjectId: 'subject-1', defaultApp: 'dealer', expectedRevision: 1 }),
      SuitePreferencesConflict,
    );
    await assert.rejects(
      async () => other.preferences.change({ subjectId: 'subject-1', defaultApp: ' dealer', expectedRevision: 2 }),
      /Invalid/,
    );
  });

  test(
    on('a start records only a changed authority, and reads the one before with when the current began'),
    { skip: backend.skip },
    async (t) => {
      const open = await backend.make(t);
      const { authority } = await open();
      assert.equal(await authority.previous('lender'), undefined);
      await authority.record('lender', 'Anyone signed in may read items.', 1_000);
      await authority.record('lender', 'Anyone signed in may read items.', 2_000);
      assert.equal(await authority.previous('lender'), undefined);
      await authority.record('lender', 'Anyone signed in may read and change items.', 3_000);
      await authority.record('dealer', 'Dealers only.', 4_000);
      assert.deepEqual(await (await open()).authority.previous('lender'), { report: 'Anyone signed in may read items.', at: 3_000 });
      await assert.rejects(async () => authority.record('not an app', 'x'), /Invalid suite authority/);
    },
  );
}

/* ---------- PostgreSQL's own refusals ---------- */

const pg = { skip: liveSkip('postgres', LIVE) };

async function owned(t: TestContext): Promise<string> {
  const database = await uuidPostgresDatabase('suite_stores');
  t.after(() => database.drop());
  return database.url;
}
async function sql(url: string, ...statements: string[]): Promise<void> {
  const client = await pgClient(url);
  try {
    for (const statement of statements) await client.query(statement);
  } finally {
    await client.end();
  }
}

test('postgres: the stores keep a database of their own, which their flag control alone may share', pg, async (t) => {
  const url = await owned(t);
  await provisionPostgresSuiteStores(url, SUITE);
  await sql(url, 'CREATE TABLE mistri.flag_binding (id integer)');
  await (await openPostgresSuiteStores(url, SUITE)).close();
  await sql(url, 'CREATE TABLE public.business (id integer)');
  await assert.rejects(openPostgresSuiteStores(url, SUITE), /database of their own/);
  // Sign-in's tables beside them in the runtime schema are the identity database's, whatever schema they share.
  await sql(url, 'DROP TABLE public.business', 'CREATE TABLE mistri.auth_user (id integer)');
  await assert.rejects(openPostgresSuiteStores(url, SUITE), /never the identity database/);
  await sql(
    url,
    'DROP TABLE mistri.auth_user',
    'CREATE FUNCTION mistri.experiment_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL; END$$',
  );
  await assert.rejects(openPostgresSuiteStores(url, SUITE), /database of their own/);
  const other = await owned(t);
  await sql(other, 'CREATE SCHEMA mistri', 'CREATE TABLE mistri.auth_user (id integer)');
  await assert.rejects(provisionPostgresSuiteStores(other, SUITE), /database of their own/);
});

test('postgres: provisioning is all or nothing and never adopts a table, and a part of the set is refused', pg, async (t) => {
  const url = await owned(t);
  assert.equal(await postgresSuiteStoresPresent(url), false);
  await provisionPostgresSuiteStore(url, 'suite_grant', SUITE);
  await assert.rejects(postgresSuiteStoresPresent(url), /some of its grant, preference and authority stores but not all/);
  await assert.rejects(provisionPostgresSuiteStores(url, SUITE), /already exists/);
  await assert.rejects(openPostgresSuiteStores(url, SUITE), /layout|unavailable/);
  const whole = await owned(t);
  await provisionPostgresSuiteStores(whole, SUITE);
  assert.equal(await postgresSuiteStoresPresent(whole), true);
  await assert.rejects(provisionPostgresSuiteStores(whole, SUITE), /already exists/);
});

test('postgres: another suite, an altered layout and a dropped rule are refused, never repaired', pg, async (t) => {
  const url = await owned(t);
  await provisionPostgresSuiteStores(url, SUITE);
  await assert.rejects(openPostgresSuiteStores(url, 'other-suite'), /unavailable/);
  await sql(url, 'ALTER TABLE mistri.suite_grant ADD COLUMN note text');
  await assert.rejects(openPostgresSuiteStores(url, SUITE), /unavailable/);
  await sql(url, 'ALTER TABLE mistri.suite_grant DROP COLUMN note');
  await (await openPostgresSuiteStores(url, SUITE)).close();
  await sql(url, 'DROP RULE suite_grant_audit_no_delete ON mistri.suite_grant_audit');
  await assert.rejects(openPostgresSuiteGrantStore(url, SUITE), /unavailable/);
});

test('postgres: the audit and the authority history are append-only, and an invitation is immutable once ended', pg, async (t) => {
  const url = await owned(t);
  await provisionPostgresSuiteStores(url, SUITE);
  const stores = await openPostgresSuiteStores(url, SUITE);
  t.after(() => stores.close());
  const admin = await stores.grants.change({ ...change, subjectId: 'admin-1', roles: ['admin'] });
  const issued = await stores.grants.issueInvitation(
    { ...change, subjectId: 'invitee', actorId: 'admin-1', roles: ['seller'], expiresAt: Date.now() + 60_000 },
    { administratorRevision: admin.revision },
    Date.now() - 1,
  );
  await stores.grants.revokeInvitation({ appId: 'lender', id: issued.id, actorId: 'admin-1' }, { administratorRevision: admin.revision });
  await stores.authority.record('lender', 'first', 1);
  await stores.authority.record('lender', 'second', 2);
  await sql(
    url,
    "UPDATE mistri.suite_grant_audit SET actor_id = 'forged'",
    'DELETE FROM mistri.suite_grant_audit',
    'UPDATE mistri.suite_grant_invitation SET revoked_at = NULL',
    'DELETE FROM mistri.suite_grant_invitation',
    "UPDATE mistri.suite_authority SET report = 'forged'",
    'DELETE FROM mistri.suite_authority',
  );
  const client = await pgClient(url);
  try {
    const audit = (await client.query('SELECT actor_id FROM mistri.suite_grant_audit')).rows;
    assert.deepEqual(audit, [{ actor_id: 'operator-1' }]);
    const invitation = (await client.query('SELECT revoked_at FROM mistri.suite_grant_invitation')).rows;
    assert.equal(invitation.length, 1);
    assert.notEqual(invitation[0].revoked_at, null);
  } finally {
    await client.end();
  }
  assert.deepEqual(await stores.authority.previous('lender'), { report: 'first', at: 2 });
});

test('postgres: a flag control running as a role of its own shares the stores database once granted the runtime schema', pg, async (t) => {
  const admin = await pgClient(LIVE!);
  const suffix = randomUUID().replaceAll('-', ''),
    password = randomUUID();
  const owner = `tw_suite_owner_${suffix}`,
    control = `tw_suite_control_${suffix}`,
    database = `tw_suite_shared_${suffix}`;
  const roles: string[] = [];
  let created = false;
  t.after(async () => {
    try {
      if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      for (const role of roles) await admin.query(`DROP ROLE "${role}"`);
    } finally {
      await admin.end();
    }
  });
  for (const role of [owner, control]) {
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
    roles.push(role);
  }
  // The flag control owns the database, as a dedicated control database requires; the suite's role may make the schema.
  await admin.query(`CREATE DATABASE "${database}" OWNER "${control}" TEMPLATE template0`);
  created = true;
  await admin.query(`GRANT CREATE ON DATABASE "${database}" TO "${owner}"`);
  const as = (role: string) => {
    const url = new URL(LIVE!);
    url.pathname = `/${database}`;
    url.username = role;
    url.password = password;
    for (const key of ['user', 'password', 'dbname', 'database']) url.searchParams.delete(key);
    return url.href;
  };
  const flags = { url: as(control), binding: { suiteId: SUITE, deploymentId: 'deployment' } };
  const catalog = normalizeFlagCatalog({
    flags: { feature: { type: 'boolean', default: false, owner: 'product', tenantManaged: true } },
    roles: [],
    audiences: {},
  });

  await provisionPostgresSuiteStores(as(owner), SUITE);
  // Without the owner's grant the control role cannot place its tables in the suite's runtime schema.
  await assert.rejects(provisionPostgresFlagStore(flags), /permission denied/);
  await sql(as(owner), `GRANT USAGE, CREATE ON SCHEMA mistri TO "${control}"`);
  await provisionPostgresFlagStore(flags);
  const store = await openPostgresFlagStore(flags);
  try {
    assert.equal((await store.read({ appId: 'lender', environment: 'production', tenantId: null }, catalog)).revision, 0);
  } finally {
    await store.close();
  }
  const stores = await openPostgresSuiteStores(as(owner), SUITE);
  try {
    assert.deepEqual(await stores.grants.change({ ...change, roles: ['seller'] }), { revision: 1, roles: ['seller'] });
  } finally {
    await stores.close();
  }
  // The grant is the delegation only while the grantee holds the control's tables: another grantee is foreign.
  await admin.query(`CREATE ROLE "tw_suite_stranger_${suffix}"`);
  roles.push(`tw_suite_stranger_${suffix}`);
  await sql(as(owner), `GRANT USAGE ON SCHEMA mistri TO "tw_suite_stranger_${suffix}"`);
  await assert.rejects(openPostgresSuiteStores(as(owner), SUITE), /not solely this role's/);
  await sql(as(owner), `REVOKE USAGE ON SCHEMA mistri FROM "tw_suite_stranger_${suffix}"`);
});

/* ---------- a suite's configuration and start ---------- */

test('identity.store and identity.grants are both PostgreSQL or both SQLite, and a ${NAME} is read from the environment', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tw-suite-stores-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'suite.json');
  const environment = {
    SUITE_SECRET: 'test-only-suite-secret-at-least-thirty-two-characters',
    GRANTS_URL: 'postgres://suite:secret@db.internal/grants',
  };
  const read = (identity: Record<string, unknown>) => {
    writeFileSync(
      file,
      JSON.stringify({
        identity: { id: 'suite', environment: { BETTER_AUTH_SECRET: 'SUITE_SECRET' }, ...identity },
        apps: [{ id: 'main', directory: './main', config: './connections.json', mount: '/' }],
      }),
    );
    return readSuiteConfiguration(file, environment);
  };
  const files = await read({ store: './identity.db', grants: './grants.db' });
  assert.equal(files.identity?.grants, join(directory, 'grants.db'));
  const postgres = await read({ store: 'postgres://suite:secret@db.internal/identity', grants: '${GRANTS_URL}' });
  assert.equal(postgres.identity?.store, 'postgres://suite:secret@db.internal/identity');
  assert.equal(postgres.identity?.grants, 'postgres://suite:secret@db.internal/grants');
  const mixed = /identity\.store and identity\.grants must both be PostgreSQL URLs or both SQLite files/;
  await assert.rejects(read({ store: './identity.db', grants: '${GRANTS_URL}' }), mixed);
  await assert.rejects(read({ store: 'postgres://suite@db.internal/identity', grants: './grants.db' }), mixed);
  await assert.rejects(read({ store: '${MISSING_URL}', grants: '${GRANTS_URL}' }), /identity\.store: .*MISSING_URL/);
  await assert.rejects(
    read({ store: 'mongodb://db.internal/identity', grants: './grants.db' }),
    /must be a SQLite file path or a postgres:\/\/ URL/,
  );
  await assert.rejects(read({ store: '${GRANTS_URL}', grants: '${GRANTS_URL}' }), /separate PostgreSQL databases/);
});

const alpha = () =>
  parseAppConfig(
    {
      id: 'alpha',
      name: 'alpha',
      resources: { note: {} },
      auth: { providers: ['email'], roles: { reader: { read: true } } },
      views: { notes: { kind: 'list', from: 'note' } },
      home: 'notes',
    },
    'suite stores fixture',
  );

/** A suite whose identity and grants are the given databases, with one App on `business`. */
function suiteOn(store: string, grants: string, business: string) {
  const config: SuiteConfiguration = {
    port: 0,
    basePath: '/',
    apps: [],
    identity: {
      id: 'shared',
      name: 'Suite',
      store,
      grants,
      environment: { BETTER_AUTH_SECRET: 'test-suite-stores-backends-secret-longer-than-thirty-two-characters' },
    },
  };
  return openSuiteIdentity(config, [
    {
      app: { path: '/alpha', pages: [], sources: {}, app: alpha() },
      basePath: '/',
      environment: {},
      connections: [{ name: 'data', url: business }],
    },
  ]);
}

test(
  'postgres: a suite on PostgreSQL refuses a SQLite App, and keeps its ledger apart from the identity and business databases',
  pg,
  async (t) => {
    const [identity, grants, business] = await Promise.all(['suite_identity', 'suite_grants', 'suite_business'].map(uuidPostgresDatabase));
    for (const database of [identity, grants, business]) t.after(() => database.drop());
    await migratePostgresAuthStore(identity.url);
    const directory = mkdtempSync(join(tmpdir(), 'tw-suite-stores-start-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    new DatabaseSync(join(directory, 'business.db')).close();
    await assert.rejects(suiteOn(identity.url, grants.url, join(directory, 'business.db')), /connection "data" of App "alpha" is not/);
    await assert.rejects(suiteOn(identity.url, business.url, business.url), /must remain separate/);
    await assert.rejects(suiteOn(identity.url, identity.url, business.url), /must remain separate|database of their own/);
    // Nothing was provisioned by the refusals: the ledger's database is still empty.
    assert.equal(await postgresSuiteStoresPresent(grants.url), false);
    const suite = await suiteOn(identity.url, grants.url, business.url);
    try {
      assert.equal(await postgresSuiteStoresPresent(grants.url), true);
      const changed = await suite.grants.change({ ...change, appId: 'alpha', declaredRoles: ['reader'], roles: ['reader'] });
      assert.deepEqual(changed, { revision: 1, roles: ['reader'] });
      const child = suite.forApp({ path: '/alpha', pages: [], sources: {}, app: alpha() }, '/');
      assert.equal(captureAppAuthRuntime(child).synchronous, false, 'a projection over PostgreSQL grants is asynchronous');
    } finally {
      suite.close();
    }
    // A business database whose role can use a runtime schema holding the ledger's tables is refused, as one reaching
    // sign-in's is.
    await sql(business.url, 'CREATE SCHEMA mistri', 'CREATE TABLE mistri.suite_grant_binding (id integer)');
    await assert.rejects(suiteOn(identity.url, grants.url, business.url), /can use/);
  },
);
