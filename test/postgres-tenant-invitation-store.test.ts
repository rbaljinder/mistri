/** Private storage only. Requires CREATEDB; never resets the configured database.
 * Native catalog spellings are pinned against this fixture's code-owned DDL.
 * No enrollment, authentication, or public capability is activated by this test. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import type { PgQuery, PgResult } from '../packages/engine/src/adapters/postgresPool.js';
import { describePostgresRelations } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { migratePostgresTenantStore } from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import { migratePostgresTenantAdministrationJournal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournalPostgres.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';
import { INVITATION_TABLES } from '../packages/mistri/src/server/tenant/tenantInvitationStore.js';
import { captureStoredTenantInvitation } from '../packages/mistri/src/server/tenant/tenantInvitationStoreContract.js';
import {
  assertPostgresTenantInvitations,
  createPostgresTenantInvitations,
  migratePostgresTenantInvitations,
  postgresInvitationDefinitions,
  postgresInvitationLayout,
} from '../packages/mistri/src/server/tenant/tenantInvitationStorePostgres.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
interface Client extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
const owner = { appId: 'app', source: { id: 'business', connection: 'owned-business' }, storeId: 'store' };
const row = () =>
  captureStoredTenantInvitation({
    invitationId: randomUUID(),
    version: '1',
    tenantId: 'north',
    membershipId: randomUUID(),
    accountId: 'recipient',
    inviterId: 'operator',
    issuanceOperation: 'issueInvitation',
    roles: ['writer', 'reader'],
    expectedTenantVersion: '1',
    policyId: 'operators',
    policyVersion: 'v1',
    createdAt: 100,
    redeemUntil: 200,
    validUntil: Number.MAX_SAFE_INTEGER,
    status: 'pending',
    digest: 'ab'.repeat(32),
  });
async function transaction<T>(client: PgQuery, work: (operations: TransactionOperations) => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  const operations = new TransactionOperations();
  try {
    const result = await work(operations);
    await operations.finish();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await operations.finish().catch(() => {});
    await client.query('ROLLBACK');
    throw error;
  }
}

test(
  'private PostgreSQL invitation storage: owned catalog, binding, CAS and retirement fences',
  { skip: liveSkip('postgres', LIVE), timeout: 120_000 },
  async (t) => {
    const database = `tw_invitation_${randomUUID().replaceAll('-', '')}`;
    assert.match(database, /^tw_invitation_[0-9a-f]{32}$/);
    const specifier = 'pg';
    const pg = (await import(specifier)) as {
      default?: { Client: new (options: unknown) => Client };
      Client?: new (options: unknown) => Client;
    };
    const Constructor = (pg.Client ?? pg.default?.Client)!;
    const admin = new Constructor({ connectionString: LIVE, statement_timeout: 10_000 });
    let owned = false,
      client: Client | undefined;
    try {
      // Connection failures must not echo a URL or credentials.
      try {
        await admin.connect();
      } catch {
        throw new Error('PostgreSQL invitation fixture control connection failed');
      }
      await admin.query(`CREATE DATABASE "${database}"`);
      owned = true;
      let url: URL;
      try {
        url = new URL(LIVE!);
        url.pathname = `/${database}`;
      } catch {
        throw new Error('Invalid PostgreSQL invitation fixture URL');
      }
      client = new Constructor({ connectionString: url.href, statement_timeout: 10_000 });
      try {
        await client.connect();
      } catch {
        throw new Error('PostgreSQL invitation fixture connection failed');
      }
      assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name, database);
      const c = client;
      await t.test('fixed catalog agrees with native DDL; never adopts observed existing tables', async () => {
        await c.query('BEGIN');
        try {
          await c.query('CREATE SCHEMA IF NOT EXISTS mistri');
          for (const ddl of postgresInvitationDefinitions) await c.query(ddl);
          assert.deepEqual(
            await describePostgresRelations(c, '__mistri_invitation_'),
            postgresInvitationLayout,
            'Catalog drift: review the native diff against code-owned DDL, never adopt deployment tables',
          );
        } finally {
          await c.query('ROLLBACK');
        }
      });
      await migratePostgresTenantStore(url.href, owner);
      await migratePostgresTenantAdministrationJournal(url.href, owner);
      await t.test('migration is explicit/idempotent; wrong binding and autocommit refuse', async () => {
        assert.deepEqual(await migratePostgresTenantInvitations(url.href, owner), { version: 1, migrated: true });
        assert.deepEqual(await migratePostgresTenantInvitations(url.href, owner), { version: 1, migrated: false });
        await assert.rejects(migratePostgresTenantInvitations(url.href, { ...owner, storeId: 'other' }), TenantContextError);
        await assert.rejects(assertPostgresTenantInvitations(c, owner), TenantContextError);
      });
      const issued = row();
      await t.test('canonical immutable rows preserve maximum safe time and exact identity', async () => {
        await transaction(c, async (operations) => {
          const store = createPostgresTenantInvitations(c, operations, owner);
          await store.insert(issued);
          assert.deepEqual(await store.read(issued.invitationId), issued);
          const linked = await store.forMembership(issued.membershipId);
          assert.deepEqual(linked, issued);
          assert.ok(Object.isFrozen(linked));
          assert.ok(Object.isFrozen(linked?.roles));
          assert.equal(await store.read(randomUUID()), null);
        });
        await assert.rejects(
          transaction(c, (operations) =>
            createPostgresTenantInvitations(c, operations, owner).insert({ ...row(), membershipId: issued.membershipId }),
          ),
          TenantContextError,
        );
      });
      await t.test('terminal transitions use exact revision CAS and cannot transition twice', async () => {
        await transaction(c, (operations) =>
          createPostgresTenantInvitations(c, operations, owner).transition({
            invitationId: issued.invitationId,
            expectedVersion: '1',
            status: 'accepted',
          }),
        );
        await assert.rejects(
          transaction(c, (operations) =>
            createPostgresTenantInvitations(c, operations, owner).transition({
              invitationId: issued.invitationId,
              expectedVersion: '1',
              status: 'revoked',
            }),
          ),
          TenantContextError,
        );
        await assert.rejects(
          transaction(c, (operations) =>
            createPostgresTenantInvitations(c, operations, owner).transition({
              invitationId: issued.invitationId,
              expectedVersion: '2',
              status: 'revoked',
            }),
          ),
          TenantContextError,
        );
        await transaction(c, async (operations) => {
          const value = await createPostgresTenantInvitations(c, operations, owner).read(issued.invitationId);
          assert.equal(value?.version, '2');
          assert.equal(value?.status, 'accepted');
        });
      });
      await t.test('retirement after INSERT rejects and owner rolls back the write', async () => {
        const pending = row();
        let retired = false;
        function query(sql: string, values?: unknown[]): Promise<PgResult<Record<string, unknown>>>;
        function query(sql: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult<unknown[]>>;
        async function query(sql: string | { text: string; values?: unknown[]; rowMode?: string }, values?: unknown[]) {
          const result = typeof sql === 'string' ? await c.query(sql, values) : await c.query(sql);
          if (
            (typeof sql === 'string' ? sql : sql.text).startsWith(`INSERT INTO ${runtimeTable('postgres', INVITATION_TABLES.invitation)}`)
          )
            retired = true;
          return result;
        }
        const borrowed: PgQuery = { query };
        await assert.rejects(
          transaction(c, (operations) =>
            createPostgresTenantInvitations(borrowed, operations, owner, () => {
              if (retired) throw new Error('retired');
            }).insert(pending),
          ),
          TenantContextError,
        );
        await transaction(c, async (operations) =>
          assert.equal(await createPostgresTenantInvitations(c, operations, owner).read(pending.invitationId), null),
        );
      });
      await t.test('foreign PUBLIC table/column grants refuse until explicitly revoked', async () => {
        const table = runtimeTable('postgres', INVITATION_TABLES.invitation);
        for (const privilege of ['SELECT', 'SELECT (digest)']) {
          await c.query(`GRANT ${privilege} ON ${table} TO PUBLIC`);
          try {
            await assert.rejects(
              transaction(c, (operations) => createPostgresTenantInvitations(c, operations, owner).read(issued.invitationId)),
              TenantContextError,
            );
            await assert.rejects(migratePostgresTenantInvitations(url.href, owner), TenantContextError);
          } finally {
            await c.query(`REVOKE ${privilege} ON ${table} FROM PUBLIC`);
          }
        }
        await transaction(c, () => assertPostgresTenantInvitations(c, owner));
      });
      await t.test('a differently cased look-alike in the runtime schema is not trusted; one outside it no longer matters', async () => {
        // Attestation reads the runtime schema alone: a temporary or App-schema table with the old prefix
        // is the App's own (and the App catalog refuses the name), so only a look-alike inside `mistri` refuses.
        for (const [definition, name, refused] of [
          ['CREATE TEMP TABLE "__mistri_invitation_shadow" (id integer)', 'pg_temp."__mistri_invitation_shadow"', false],
          ['CREATE TABLE public."__MISTRI_INVITATION_shadow" (id integer)', 'public."__MISTRI_INVITATION_shadow"', false],
          ['CREATE TABLE mistri."INVITATION_shadow" (id integer)', 'mistri."INVITATION_shadow"', true],
        ] as const) {
          await c.query(definition);
          try {
            const read = transaction(c, (operations) => createPostgresTenantInvitations(c, operations, owner).read(issued.invitationId));
            if (refused) await assert.rejects(read, TenantContextError);
            else await read;
          } finally {
            await c.query(`DROP TABLE ${name}`);
          }
        }
        await transaction(c, () => assertPostgresTenantInvitations(c, owner));
      });
      await t.test('two owner transactions cannot both win a pending invitation CAS', async () => {
        const pending = row();
        await transaction(c, (operations) => createPostgresTenantInvitations(c, operations, owner).insert(pending));
        const contender = new Constructor({ connectionString: url.href, statement_timeout: 10_000 });
        let second: Promise<void> | undefined;
        try {
          try {
            await contender.connect();
          } catch {
            throw new Error('PostgreSQL invitation contender connection failed');
          }
          await c.query('BEGIN');
          const first = new TransactionOperations();
          await createPostgresTenantInvitations(c, first, owner).transition({
            invitationId: pending.invitationId,
            expectedVersion: '1',
            status: 'accepted',
          });
          let settled = false;
          second = transaction(contender, (operations) =>
            createPostgresTenantInvitations(contender, operations, owner).transition({
              invitationId: pending.invitationId,
              expectedVersion: '1',
              status: 'revoked',
            }),
          );
          void second.then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            },
          );
          await new Promise((resolve) => setTimeout(resolve, 150));
          assert.equal(settled, false, 'contender must wait for the first owner transaction');
          await first.finish();
          await c.query('COMMIT');
          await assert.rejects(second, TenantContextError);
          await transaction(c, async (operations) => {
            const value = await createPostgresTenantInvitations(c, operations, owner).read(pending.invitationId);
            assert.equal(value?.status, 'accepted');
            assert.equal(value?.version, '2');
          });
        } finally {
          await c.query('ROLLBACK');
          await second?.catch(() => {});
          await contender.end();
        }
      });
      await t.test('layout drift refuses without adopting or repairing the changed table', async () => {
        await c.query(`ALTER TABLE ${runtimeTable('postgres', INVITATION_TABLES.invitation)} ADD COLUMN foreign_column text`);
        await assert.rejects(
          transaction(c, (operations) => createPostgresTenantInvitations(c, operations, owner).read(issued.invitationId)),
          TenantContextError,
        );
        await assert.rejects(migratePostgresTenantInvitations(url.href, owner), TenantContextError);
        assert.ok(
          (await describePostgresRelations(c, '__mistri_invitation_')).some((table) =>
            table.columns.some((column) => column.name === 'foreign_column'),
          ),
        );
      });
    } finally {
      try {
        await client?.end();
      } finally {
        try {
          if (owned) await admin.query(`DROP DATABASE "${database}"`);
        } finally {
          await admin.end();
        }
      }
    }
  },
);
