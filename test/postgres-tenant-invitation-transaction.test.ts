/** Borrowed transaction facts only; no PG enrollment/auth activation. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import type { PgQuery, PgResult } from '../packages/engine/src/adapters/postgresPool.js';
import { createPostgresInvitationTransaction } from '../packages/mistri/src/server/tenant/tenantInvitationTransactionPostgres.js';
import { migratePostgresTenantStore } from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import { migratePostgresTenantAdministrationJournal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournalPostgres.js';
import {
  assertPostgresTenantInvitations,
  migratePostgresTenantInvitations,
} from '../packages/mistri/src/server/tenant/tenantInvitationStorePostgres.js';
import { captureStoredTenantInvitation } from '../packages/mistri/src/server/tenant/tenantInvitationStoreContract.js';
import {
  assertLinkedPostgresTenantInvitations,
  postgresInvitationStoragePresent,
} from '../packages/mistri/src/server/tenant/tenantInvitationLinksPostgres.js';
import { runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';
import { INVITATION_TABLES } from '../packages/mistri/src/server/tenant/tenantInvitationStore.js';
import { TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { liveSkip } from './live.js';

const binding = { appId: 'app', source: { id: 'business', connection: 'owned-business' }, storeId: 'store' };
const row = () =>
  captureStoredTenantInvitation({
    invitationId: randomUUID(),
    version: '1',
    tenantId: 'north',
    membershipId: randomUUID(),
    accountId: `recipient-${randomUUID()}`,
    inviterId: 'operator',
    issuanceOperation: 'issueInvitation',
    roles: ['reader'],
    expectedTenantVersion: '1',
    policyId: 'operators',
    policyVersion: 'v1',
    createdAt: 100,
    redeemUntil: 200,
    validUntil: Number.MAX_SAFE_INTEGER,
    status: 'pending',
    digest: 'ab'.repeat(32),
  });

test('pure: PG fact construction is inert and invalid synchronous fences poison drain before SQL', async () => {
  for (const outcome of [true, Promise.resolve(), Promise.reject(new Error('private'))]) {
    let calls = 0;
    const client = {
      query: async () => {
        calls++;
        throw new Error('must not query');
      },
    } as PgQuery;
    const operations = new TransactionOperations();
    const transaction = createPostgresInvitationTransaction(
      client,
      operations,
      binding,
      () => outcome,
      () => {},
    );
    assert.equal(calls, 0);
    void transaction.pendingCount('north');
    await assert.rejects(operations.finish(), TenantContextError);
    assert.equal(calls, 0);
  }
});

const LIVE = process.env.TABLEWALK_TEST_PG;
interface Client extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
test(
  'native PG invitation facts preserve linked rows, reservation locks and owner rollback/drain',
  { skip: liveSkip('postgres', LIVE), timeout: 120_000 },
  async (t) => {
    const database = `tw_invitation_facts_${randomUUID().replaceAll('-', '')}`;
    assert.match(database, /^tw_invitation_facts_[0-9a-f]{32}$/);
    const specifier = 'pg';
    const pg = (await import(specifier)) as {
      default?: { Client: new (options: unknown) => Client };
      Client?: new (options: unknown) => Client;
    };
    const Constructor = (pg.Client ?? pg.default?.Client)!;
    const admin = new Constructor({ connectionString: LIVE, statement_timeout: 10_000 });
    let owned = false,
      writer: PostgresAdapter | undefined,
      competitor: PostgresAdapter | undefined;
    try {
      try {
        await admin.connect();
      } catch {
        throw new Error('Invitation facts control connection failed');
      }
      await admin.query(`CREATE DATABASE "${database}"`);
      owned = true;
      const url = new URL(LIVE!);
      url.pathname = `/${database}`;
      await migratePostgresTenantStore(url.href, binding);
      await migratePostgresTenantAdministrationJournal(url.href, binding);
      await t.test('READ ONLY snapshot refuses missing invitation storage without provisioning', async () => {
        const inspector = new PostgresAdapter(url.href, 'Read-only invitation prerequisite');
        try {
          await assert.rejects(
            inspector.readSnapshot(async (snapshot) => {
              assert.equal((await snapshot.client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
              assert.equal((await snapshot.client.query('SHOW transaction_isolation')).rows[0].transaction_isolation, 'repeatable read');
              await snapshot.describe();
              await assertLinkedPostgresTenantInvitations(snapshot.client, binding);
            }),
            TenantContextError,
          );
          await inspector.readSnapshot(async (snapshot) => {
            assert.equal(await postgresInvitationStoragePresent(snapshot.client), false);
          });
        } finally {
          await inspector.close();
        }
        await assert.rejects(inspector.readSnapshot(async () => {}));
      });
      await migratePostgresTenantInvitations(url.href, binding);
      writer = new PostgresAdapter(url.href, 'Invitation facts');
      competitor = new PostgresAdapter(url.href, 'Competing invitation facts');
      const verify = (client: PgQuery) => assertPostgresTenantInvitations(client, binding);
      const run = <T>(
        adapter: PostgresAdapter,
        work: (port: ReturnType<typeof createPostgresInvitationTransaction>, client: PgQuery) => Promise<T>,
      ) =>
        adapter.runtimeMaintenanceTransaction(verify, async (client, operations, current) =>
          work(
            createPostgresInvitationTransaction(client, operations, binding, () => {}, current),
            client,
          ),
        );
      const reserve = async (port: ReturnType<typeof createPostgresInvitationTransaction>, invitation: ReturnType<typeof row>) => {
        await port.administration.putMembership({
          membershipId: invitation.membershipId,
          tenantId: invitation.tenantId,
          accountId: invitation.accountId,
          status: 'invited',
          expectedVersion: null,
          roles: invitation.roles,
          validUntil: invitation.validUntil,
        });
        await port.invitations.insert(invitation);
      };
      const first = row();
      await run(writer, async (port) => {
        await port.administration.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null });
        await reserve(port, first);
      });
      await t.test('actual READ ONLY enrollment snapshot attests links and rejects wrong binding unchanged', async () => {
        const inspector = new PostgresAdapter(url.href, 'Read-only invitation prerequisite');
        try {
          const inspect = () =>
            inspector.readSnapshot(async (snapshot) => {
              assert.equal((await snapshot.client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
              assert.equal((await snapshot.client.query('SHOW transaction_isolation')).rows[0].transaction_isolation, 'repeatable read');
              const { readAt: _readAt, ...schema } = await snapshot.describe();
              await assertLinkedPostgresTenantInvitations(snapshot.client, binding);
              const rows = (
                await snapshot.client.query(
                  `SELECT * FROM ${runtimeTable('postgres', INVITATION_TABLES.invitation)} ORDER BY invitation_id`,
                )
              ).rows;
              return { schema, rows };
            });
          const before = await inspect();
          await assert.rejects(
            inspector.readSnapshot(async (snapshot) => {
              await snapshot.describe();
              await assertLinkedPostgresTenantInvitations(snapshot.client, { ...binding, storeId: 'wrong-store' });
            }),
            TenantContextError,
          );
          assert.deepEqual(await inspect(), before);
        } finally {
          await inspector.close();
        }
      });
      await t.test('linked attestor rejects orphan, identity, status, expiry and typed role mismatches', async () => {
        const mutations = [
          `UPDATE ${runtimeTable('postgres', INVITATION_TABLES.invitation)} SET tenant_id='missing'`,
          `UPDATE ${runtimeTable('postgres', INVITATION_TABLES.invitation)} SET membership_id='00000000-0000-4000-8000-000000000000'`,
          `UPDATE ${runtimeTable('postgres', INVITATION_TABLES.invitation)} SET account_id='other'`,
          `UPDATE ${runtimeTable('postgres', TENANT_TABLES.membership)} SET status='active' WHERE kind='member'`,
          `UPDATE ${runtimeTable('postgres', TENANT_TABLES.membership)} SET valid_until=9007199254740990 WHERE kind='member'`,
          `UPDATE ${runtimeTable('postgres', TENANT_TABLES.membership)} SET roles_json='["other"]' WHERE kind='member'`,
        ];
        for (const sql of mutations) {
          await assert.rejects(
            writer!.runtimeMaintenanceTransaction(verify, async (client) => {
              assert.equal(await postgresInvitationStoragePresent(client), true);
              await assertLinkedPostgresTenantInvitations(client, binding);
              await client.query(sql);
              await assertLinkedPostgresTenantInvitations(client, binding);
            }),
            TenantContextError,
          );
        }
        await assert.rejects(
          writer!.runtimeMaintenanceTransaction(verify, async (client) => {
            await client.query(`UPDATE ${runtimeTable('postgres', INVITATION_TABLES.invitation)} SET roles_json='["1"]'`);
            await client.query(`UPDATE ${runtimeTable('postgres', TENANT_TABLES.membership)} SET roles_json='[1]' WHERE kind='member'`);
            await assertLinkedPostgresTenantInvitations(client, binding);
          }),
          TenantContextError,
        );
        await writer!.runtimeMaintenanceTransaction(verify, async (client) => {
          await assertLinkedPostgresTenantInvitations(client, binding);
        });
      });
      await t.test('accepted history permits evolved membership but revoked links still require parity', async () => {
        const rollback = new Error('owned test rollback');
        for (const status of ['active', 'revoked']) {
          await assert.rejects(
            writer!.runtimeMaintenanceTransaction(verify, async (client) => {
              await client.query(`UPDATE ${runtimeTable('postgres', INVITATION_TABLES.invitation)} SET status='accepted'`);
              await client.query(
                `UPDATE ${runtimeTable('postgres', TENANT_TABLES.membership)} SET status=$1,roles_json='["other"]',valid_until=1000 WHERE kind='member'`,
                [status],
              );
              await assertLinkedPostgresTenantInvitations(client, binding);
              throw rollback;
            }),
            (error) => error === rollback,
          );
        }
        await assert.rejects(
          writer!.runtimeMaintenanceTransaction(verify, async (client) => {
            await client.query(`UPDATE ${runtimeTable('postgres', INVITATION_TABLES.invitation)} SET status='revoked'`);
            await client.query(`UPDATE ${runtimeTable('postgres', TENANT_TABLES.membership)} SET status='revoked' WHERE kind='member'`);
            await assertLinkedPostgresTenantInvitations(client, binding);
            await client.query(
              `UPDATE ${runtimeTable('postgres', TENANT_TABLES.membership)} SET roles_json='["other"]' WHERE kind='member'`,
            );
            await assertLinkedPostgresTenantInvitations(client, binding);
          }),
          TenantContextError,
        );
      });
      await t.test('actual facts retain safe times, exact counts and tenant-before-membership order', async () => {
        const sql: string[] = [];
        await writer!.runtimeMaintenanceTransaction(verify, async (client, operations, current) => {
          function query(text: string, args?: unknown[]): Promise<PgResult<Record<string, unknown>>>;
          function query(config: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult<unknown[]>>;
          function query(input: string | { text: string; values?: unknown[]; rowMode?: string }, args?: unknown[]) {
            sql.push(typeof input === 'string' ? input : input.text);
            return typeof input === 'string' ? client.query(input, args) : client.query(input);
          }
          const observed: PgQuery = { query };
          const port = createPostgresInvitationTransaction(observed, operations, binding, () => {}, current);
          const pair = await port.pair(first);
          assert.equal(pair.membership.validUntil, Number.MAX_SAFE_INTEGER);
          assert.equal(Object.hasOwn(pair.invitation, 'digest'), false);
          assert.equal(await port.pendingCount('north'), 1);
          assert.deepEqual(await port.pendingIds('north', '', ['reader'], 10), [first.invitationId]);
          assert.deepEqual(await port.pendingIds('north', '', ['other'], 10), []);
          assert.equal(await port.optionalTenant('missing'), null);
        });
        const locks = sql.filter((text) => text.includes('FOR UPDATE'));
        assert.ok(locks[0].includes('AS "tenantId",status,version,kind'));
        assert.ok(locks[1].includes('AS "membershipId"'));
      });
      await t.test('mismatched linked membership and unawaited failure roll back owner writes', async () => {
        await assert.rejects(
          run(writer!, async (port) => {
            await reserve(port, row());
            void port.pair({ ...first, accountId: 'wrong' });
          }),
          TenantContextError,
        );
        assert.equal(await run(writer!, async (port) => await port.pendingCount('north')), 1);
      });
      await t.test('tenant count lock serializes competing reservation decisions', async () => {
        const attempt = (adapter: PostgresAdapter) =>
          run(adapter, async (port) => {
            if ((await port.pendingCount('north')) !== 1) throw new TenantContextError();
            await reserve(port, row());
            return true;
          });
        const results = await Promise.allSettled([attempt(writer!), attempt(competitor!)]);
        assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
        assert.equal(await run(writer!, async (port) => await port.pendingCount('north')), 2);
      });
      await t.test('borrowed facts expire with transaction and owner final verifier can roll back', async () => {
        let retained: ReturnType<typeof createPostgresInvitationTransaction> | undefined;
        let checks = 0;
        await assert.rejects(
          writer!.runtimeMaintenanceTransaction(
            async (client) => {
              await verify(client);
              if (++checks === 2) throw new TenantContextError();
            },
            async (client, operations, current) => {
              retained = createPostgresInvitationTransaction(client, operations, binding, () => {}, current);
              await reserve(retained, row());
            },
          ),
          TenantContextError,
        );
        assert.equal(checks, 2, 'scheduling proof only: this verifier is not native authentication');
        await assert.rejects(async () => await retained!.pendingCount('north'));
        assert.equal(await run(writer!, async (port) => await port.pendingCount('north')), 2);
      });
    } finally {
      await competitor?.close();
      await writer?.close();
      if (owned) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      await admin.end();
    }
  },
);
