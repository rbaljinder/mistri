/** S1 of the API tenant bridge on PostgreSQL, through the real CLI: UUID-owned
 * business and native auth databases, two tenants, and `api-token issue
 * --tenant` issued only for an active membership of the named tenant, bound to
 * its version. Skipped unless TABLEWALK_TEST_PG is set; drops what it creates. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { migratePostgresAuthStore } from '../packages/mistri/src/adapters/auth/postgresAuthStore.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import {
  createPostgresTenantAdministration,
  migratePostgresTenantStore,
} from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import type { TenantStoreAdministration } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { DEPOT_ROWS, DEPOT_STORE, DEPOT_TABLE, tokenCli, writeDepotApp } from './appApiCli.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
interface Client extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}

test(
  'api-token issue --tenant on PostgreSQL binds an active membership of the named tenant, and nothing else',
  { skip: liveSkip('postgres', LIVE), timeout: 300000 },
  async (t) => {
    const module = 'pg';
    const pg = (await import(module)) as { default: { Client: new (options: unknown) => Client } };
    const control = new pg.default.Client({ connectionString: LIVE, statement_timeout: 10000 });
    await control.connect();
    const names = ['auth', 'business'].map((kind) => `tw_token_tenant_${kind}_${randomUUID().replaceAll('-', '')}`);
    const owned: string[] = [],
      directory = mkdtempSync(join(tmpdir(), 'tw-token-tenant-pg-'));
    let business: Client | undefined;
    t.after(async () => {
      await business?.end().catch(() => {});
      for (const name of owned) await control.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await control.end();
      rmSync(directory, { recursive: true, force: true });
    });
    for (const name of names) {
      await control.query(`CREATE DATABASE "${name}"`);
      owned.push(name);
    }
    const [authUrl, businessUrl] = names.map((name) => {
      const url = new URL(LIVE!);
      url.pathname = `/${name}`;
      return url.href;
    });
    business = new pg.default.Client({ connectionString: businessUrl, statement_timeout: 10000 });
    await business.connect();
    await business.query(`${DEPOT_TABLE('physical_item')}; ${DEPOT_ROWS('physical_item')}`);
    const store = { appId: 'depot', source: { id: 'business', connection: 'data' }, storeId: DEPOT_STORE };
    await migratePostgresTenantStore(businessUrl, store);
    const client = business;
    const maintenance = async (run: (admin: TenantStoreAdministration) => Promise<void>) => {
      const operations = new TransactionOperations();
      await client.query('BEGIN');
      try {
        await run(createPostgresTenantAdministration(client, operations, store));
        await operations.finish();
        await client.query('COMMIT');
      } catch (error) {
        await operations.finish().catch(() => {});
        await client.query('ROLLBACK');
        throw error;
      }
    };
    await maintenance(async (admin) => {
      for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
      for (const [account, tenantId] of [
        ['alice', 'north'],
        ['bob', 'south'],
      ]) {
        await admin.putMembership({
          tenantId,
          accountId: account,
          membershipId: `m-${account}-${tenantId}`,
          status: 'active',
          roles: ['member'],
          validUntil: Date.now() + 3600000,
          expectedVersion: null,
        });
      }
    });
    await migratePostgresAuthStore(authUrl);
    const accounts = new pg.default.Client({ connectionString: authUrl, statement_timeout: 10000 });
    await accounts.connect();
    try {
      for (const id of ['alice', 'bob', 'operator']) {
        await accounts.query(
          `INSERT INTO mistri.auth_user(id,name,email,"emailVerified","createdAt","updatedAt",role,banned)
          VALUES($1,$1,$2,true,now(),now(),NULL,false)`,
          [id, `${id}@example.test`],
        );
      }
    } finally {
      await accounts.end();
    }
    const { appDir, config, policy } = writeDepotApp(directory, {
      business: businessUrl,
      authStore: authUrl,
      physical: 'public.physical_item',
    });
    writeFileSync(join(appDir, 'authority.lock'), (await loadApp(appDir)).authority!.report);
    const common = ['--app', appDir, '--config', config, '--store-id', randomUUID()];
    const provisioned = await tokenCli(['provision', ...common]);
    assert.equal(provisioned.code, 0, provisioned.err);
    const issue = (subject: string, extra: readonly string[]) =>
      tokenCli([
        'issue',
        ...common,
        '--subject',
        subject,
        '--actor',
        'operator',
        '--role',
        'member',
        '--label',
        'Depot',
        '--expires-at',
        new Date(Date.now() + 600000).toISOString(),
        ...extra,
      ]);
    const tenant = (id: string) => ['--tenant', id, '--policy', policy];

    const issued = await issue('alice', tenant('north'));
    assert.equal(issued.code, 0, issued.err);
    const { result } = JSON.parse(issued.out) as { result: { token: string; tokenId: string } };
    const inspected = await tokenCli(['inspect', ...common, '--token-id', result.tokenId]);
    assert.equal(inspected.code, 0, inspected.err);
    assert.deepEqual(JSON.parse(inspected.out).result.record.tenant, {
      tenantId: 'north',
      membershipId: 'm-alice-north',
      membershipVersion: '1',
    });
    assert.equal(inspected.out.includes(result.token), false);
    for (const extra of [tenant('south'), tenant('west'), []]) {
      const refused = await issue('alice', extra);
      assert.equal(refused.code, 2, extra.join(' '));
      assert.equal(refused.out, '');
    }
    assert.equal((await issue('bob', tenant('south'))).code, 0);
    await maintenance((admin) =>
      admin.putMembership({
        tenantId: 'north',
        accountId: 'alice',
        membershipId: 'm-alice-north',
        status: 'revoked',
        roles: ['member'],
        validUntil: Date.now() + 3600000,
        expectedVersion: '1',
      }),
    );
    assert.equal((await issue('alice', tenant('north'))).code, 2);
  },
);
