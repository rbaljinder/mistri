/**
 * A tenant's decisions are the platform owner's to turn on, one model provider
 * at a time (tenantDecisionSwitch.ts): journaled with the customer's consent
 * reference, turned off but never on by the tenant's own admin, forgotten
 * with a closed tenant while its usage stays for the bill. SQLite always;
 * PostgreSQL when TABLEWALK_TEST_PG names a server.
 */
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { describe, test, type TestContext } from 'node:test';
import { DECISION_TABLES } from '../packages/mistri/src/adapters/decide/decisionStore.js';
import { providerOf, TENANT_SWITCH_TABLES } from '../packages/mistri/src/adapters/switch/tenantSwitch.js';
import { openPostgresDecisions, provisionPostgresDecisions } from '../packages/mistri/src/adapters/decide/postgresDecisions.js';
import { openSqliteDecisions, provisionSqliteDecisions } from '../packages/mistri/src/adapters/decide/sqliteDecisions.js';
import {
  openSqliteTenantAdministration,
  openTenantAdministration,
  TenantAdministrationFailure,
  type TenantAdministration,
  type TenantAdministrationOptions,
} from '../packages/mistri/src/server/tenant/tenantAdministration.js';
import { ADMINISTRATION_JOURNAL_TABLES as journal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { migratePostgresTenantAdministrationJournal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournalPostgres.js';
import type { AdministrationPolicy } from '../packages/mistri/src/server/tenant/tenantAdministrationModel.js';
import { TENANT_TABLES as tables } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { migratePostgresTenantStore } from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import type { AdministrationIntent } from '../packages/mistri/src/shared/tenantAdministration.js';
import { tenantAdministrationFixture } from './support/tenantAdministrationFixture.js';
import { pgClient, TENANT_DIALECTS, uuidPostgresDatabase, type TenantDialect } from './support/tenantDialects.js';
import { postgresRuntimeSql } from './support/runtimeSql.js';

const HOUR = 3_600_000;
// Captured data has no prototype; deepEqual compares prototypes.
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const refused = (error: unknown) => error instanceof TenantAdministrationFailure && error.outcome === 'not_applied';
const policy = (accountId: string): AdministrationPolicy => ({
  id: 'decision-operators',
  version: '1',
  maxMembershipLifetimeMs: 600_000,
  operators: [{ accountId, tenants: ['north', 'south'], operations: ['setTenantDecisions', 'setTenantStatus'], roles: [] }],
  delegates: [{ role: 'dealer_admin', operations: ['setTenantDecisions'], roles: [] }],
});

async function fixture(
  t: TestContext,
  dialect: TenantDialect,
  providers: TenantAdministrationOptions['decisions'] | null = ['anthropic', 'jev'],
) {
  const f = await tenantAdministrationFixture(t);
  let exec: (sql: string, ...params: unknown[]) => Promise<void>,
    all: (sql: string, ...params: unknown[]) => Promise<Record<string, unknown>[]>;
  let where: { path: string } | { url: string };
  if (dialect === 'sqlite') {
    provisionSqliteDecisions(f.path);
    where = { path: f.path };
    exec = async (sql, ...params) => {
      f.db.prepare(sql).run(...(params as never[]));
    };
    all = async (sql, ...params) =>
      f.db
        .prepare(sql)
        .all(...(params as never[]))
        .map((row) => ({ ...row }));
  } else {
    const { url, drop } = await uuidPostgresDatabase('tenant_decisions');
    const control = await pgClient(url);
    t.after(async () => {
      await control.end().catch(() => {});
      await drop();
    });
    await migratePostgresTenantStore(url, f.binding);
    await migratePostgresTenantAdministrationJournal(url, f.binding);
    await provisionPostgresDecisions(url);
    where = { url };
    const numbered = (sql: string) => {
      let n = 0;
      return sql.replace(/\?/g, () => `$${++n}`);
    };
    exec = async (sql, ...params) => {
      await control.query(postgresRuntimeSql(numbered(sql)), params);
    };
    all = async (sql, ...params) => (await control.query(postgresRuntimeSql(numbered(sql)), params)).rows;
  }
  const { operator, target } = f.users;
  await exec(
    `INSERT INTO "${tables.tenant}" (id, status, version, kind) VALUES ('north', 'active', '1', 'tenant'), ('south', 'active', '1', 'tenant')`,
  );
  // The target is north's own admin: a delegate, never an operator.
  await exec(
    `INSERT INTO "${tables.membership}" (id, tenant_id, account_id, status, version, roles_json, valid_until, kind)
    VALUES ('north-target', 'north', ?, 'active', '1', ?, ?, 'member')`,
    target.accountId,
    JSON.stringify(['dealer_admin']),
    Date.now() + HOUR,
  );
  const open = async (options: Partial<TenantAdministrationOptions> = {}) => {
    const common = {
      binding: f.binding,
      auth: f.auth,
      deployment: 'decision-tests',
      policy: policy(operator.accountId),
      ...(providers ? { decisions: providers } : {}),
      ...options,
    };
    const owner: TenantAdministration =
      'path' in where
        ? await openSqliteTenantAdministration({ ...common, path: where.path })
        : await openTenantAdministration({ ...common, url: where.url });
    f.addCleanup(owner.retire);
    return owner;
  };
  /** An account's session on an owner: the intent runner and the reads. */
  const as = async (owner: TenantAdministration, who: { accountId: string; request: IncomingMessage }) => {
    const session = (await owner.open(who.request, { expectedAccount: who.accountId }))!;
    assert.ok(session);
    const context = { expectedAccount: who.accountId, context: session.context };
    return {
      tenants: () => owner.tenants(who.request, context),
      usage: (since?: string) => owner.decisionUsage(who.request, { ...context, ...(since ? { since } : {}) }),
      run: (intent: AdministrationIntent) => owner.execute(who.request, { ...context, idempotencyKey: crypto.randomUUID(), intent }),
    };
  };
  const decisions = async () =>
    dialect === 'sqlite' ? openSqliteDecisions(f.path) : openPostgresDecisions((where as { url: string }).url);
  return { ...f, exec, all, open, as, decisions };
}
const set = (
  tenantId: string,
  provider: string,
  enabled: boolean,
  consent = enabled ? `DPA-${tenantId}-2026` : '',
  version = '1',
): AdministrationIntent => ({
  operation: 'setTenantDecisions',
  tenantId,
  expectedTenantVersion: version,
  provider,
  enabled,
  consent,
});

for (const { dialect, skip } of TENANT_DIALECTS) {
  describe(`tenant decisions on ${dialect}`, { skip }, () => {
    test('the operator turns a provider on with its consent: journaled, stored, and listed per provider', async (t) => {
      const f = await fixture(t, dialect);
      const admin = await f.as(await f.open(), f.users.operator);
      const listed = (await admin.tenants()).items.find((item) => item.tenantId === 'north')!;
      assert.deepEqual(plain(listed.decisions), [
        { provider: 'anthropic', enabled: false, consent: '' },
        { provider: 'jev', enabled: false, consent: '' },
      ]);
      assert.ok(listed.capabilities.some((capability) => capability.operation === 'setTenantDecisions'));
      const result = await admin.run(set('north', 'jev', true, 'DPA-north-2026'));
      assert.deepEqual(plain(result.change.before!.decisions), { provider: 'jev', enabled: false, consent: '' });
      assert.deepEqual(plain(result.change.after.decisions), { provider: 'jev', enabled: true, consent: 'DPA-north-2026' });
      // The tenant row is read, not written: no open tab's lease ends.
      assert.deepEqual(plain(result.change.after.tenant), plain(result.change.before!.tenant));
      const [row] = await f.all(`SELECT feature, enabled, consent FROM "${TENANT_SWITCH_TABLES.tenant}" WHERE tenant = ?`, 'north');
      assert.deepEqual(
        { provider: providerOf(String(row.feature)), enabled: Number(row.enabled), consent: row.consent },
        { provider: 'jev', enabled: 1, consent: 'DPA-north-2026' },
      );
      assert.deepEqual(plain((await admin.tenants()).items.find((item) => item.tenantId === 'north')!.decisions), [
        { provider: 'anthropic', enabled: false, consent: '' },
        { provider: 'jev', enabled: true, consent: 'DPA-north-2026' },
      ]);
      const [receipt] = await f.all(`SELECT r.operation, r.change_json FROM "${journal.receipt}" r`);
      assert.equal(receipt.operation, 'setTenantDecisions');
      assert.deepEqual(JSON.parse(String(receipt.change_json)).after.decisions, {
        provider: 'jev',
        enabled: true,
        consent: 'DPA-north-2026',
      });
    });

    test('turning on needs a consent reference, a provider the App names, and an active tenant', async (t) => {
      const f = await fixture(t, dialect);
      const admin = await f.as(await f.open(), f.users.operator);
      await assert.rejects(admin.run(set('north', 'jev', true, '')), refused);
      await assert.rejects(admin.run(set('north', 'jev', true, '  padded ')), refused);
      await assert.rejects(admin.run(set('north', 'openai', true)), refused);
      await assert.rejects(admin.run(set('north', 'Jev', true)), refused);
      await assert.rejects(admin.run(set('north', 'jev', false, '', '2')), refused);
      await admin.run({ operation: 'setTenantStatus', tenantId: 'south', expectedTenantVersion: '1', status: 'suspended' });
      await assert.rejects(admin.run(set('south', 'jev', true, 'DPA-south', '2')), refused);
      assert.equal((await f.all(`SELECT 1 FROM "${TENANT_SWITCH_TABLES.tenant}"`)).length, 0);
      // Off needs no reason, and may be said before it was ever on.
      await admin.run(set('north', 'jev', false));
    });

    test('an owner opened without decisions offers no such operation', async (t) => {
      const f = await fixture(t, dialect, null);
      const admin = await f.as(await f.open(), f.users.operator);
      const page = await admin.tenants();
      assert.equal(page.decisionUsage, undefined);
      assert.ok(page.items.every((item) => item.decisions === undefined));
      assert.ok(page.items.every((item) => item.capabilities.every((capability) => capability.operation !== 'setTenantDecisions')));
      await assert.rejects(admin.run(set('north', 'jev', true)), refused);
      await assert.rejects(admin.usage(), refused);
    });

    test('the options are strict: one to eight unique plain provider ids', async (t) => {
      const f = await fixture(t, dialect);
      for (const bad of [
        [],
        ['jev', 'jev'],
        ['Jev'],
        ['jev-2'],
        [''],
        ['a'.repeat(33)],
        Array.from({ length: 9 }, (_, i) => 'p'.repeat(i + 1)),
        'jev',
        [1],
      ])
        await assert.rejects(f.open({ decisions: bad as never }), refused, JSON.stringify(bad));
    });

    test("a tenant's own admin may turn a provider off, never on", async (t) => {
      const f = await fixture(t, dialect);
      const owner = await f.open();
      const operator = await f.as(owner, f.users.operator);
      const delegate = await f.as(owner, f.users.target);
      await operator.run(set('north', 'jev', true));
      const page = await delegate.tenants();
      assert.deepEqual(
        page.items.map((item) => item.tenantId),
        ['north'],
      );
      assert.equal(page.decisionUsage, undefined);
      await assert.rejects(delegate.run(set('north', 'anthropic', true, 'DPA-north-2026', '1')), refused);
      const off = await delegate.run(set('north', 'jev', false, 'Asked by the dealer'));
      assert.deepEqual(plain(off.change.before!.decisions), { provider: 'jev', enabled: true, consent: 'DPA-north-2026' });
      assert.deepEqual(plain(off.change.after.decisions), { provider: 'jev', enabled: false, consent: 'Asked by the dealer' });
      // Not its own tenant, and no counts: the bill is the operator's.
      await assert.rejects(delegate.run(set('south', 'jev', false)), refused);
      await assert.rejects(delegate.usage(), refused);
    });

    test('closing a tenant forgets its decision records and switches; the usage stays for the bill', async (t) => {
      const f = await fixture(t, dialect);
      const admin = await f.as(await f.open(), f.users.operator);
      await admin.run(set('north', 'jev', true));
      await admin.run(set('south', 'jev', true));
      const store = await f.decisions();
      t.after(() => store.close());
      for (const tenant of ['north', 'south']) {
        await store.begin(
          { app: f.binding.appId, tenant },
          {
            id: `decision-${tenant}`,
            decision: 'triage',
            contractVersion: 1,
            resource: 'lead',
            recordKey: '1',
            field: 'priority',
            trigger: 'manual',
            inputFields: [],
            createdAt: new Date().toISOString(),
          },
        );
        await store.spend({ app: f.binding.appId, tenant }, '2026-10-20', 40, 1500);
      }
      const count = async (table: string, tenant: string) =>
        Number((await f.all(`SELECT count(*) AS n FROM "${table}" WHERE tenant = ?`, tenant))[0].n);
      await admin.run({ operation: 'setTenantStatus', tenantId: 'south', expectedTenantVersion: '1', status: 'closed' });
      assert.equal(await count(DECISION_TABLES.record, 'south'), 0);
      assert.equal(await count(TENANT_SWITCH_TABLES.tenant, 'south'), 0);
      assert.equal(await count(DECISION_TABLES.usage, 'south'), 1);
      assert.equal(await count(DECISION_TABLES.record, 'north'), 1);
      assert.equal(await count(TENANT_SWITCH_TABLES.tenant, 'north'), 1);
    });

    test('decision usage is the operator alone, by tenant and day, newest first', async (t) => {
      const f = await fixture(t, dialect);
      const owner = await f.open();
      const operator = await f.as(owner, f.users.operator);
      const delegate = await f.as(owner, f.users.target);
      const store = await f.decisions();
      t.after(() => store.close());
      const app = f.binding.appId;
      await store.spend({ app, tenant: 'north' }, '2026-10-20', 40, 1500);
      await store.spend({ app, tenant: 'north' }, '2026-10-20', 10, 500);
      await store.spend({ app, tenant: 'south' }, '2026-10-20', 5, 100);
      await store.spend({ app, tenant: 'north' }, '2026-10-21', 7, 250);
      await store.spend({ app, tenant: 'elsewhere' }, '2026-10-21', 7, 250);
      assert.equal((await operator.tenants()).decisionUsage, true);
      const page = await operator.usage();
      assert.equal(page.truncated, false);
      assert.deepEqual(plain(page.rows), [
        { tenantId: 'north', day: '2026-10-21', calls: 1, units: 7, costMicros: 250 },
        { tenantId: 'north', day: '2026-10-20', calls: 2, units: 50, costMicros: 2000 },
        { tenantId: 'south', day: '2026-10-20', calls: 1, units: 5, costMicros: 100 },
      ]);
      assert.deepEqual(
        (await operator.usage('2026-10-21')).rows.map((row) => row.day),
        ['2026-10-21'],
      );
      await assert.rejects(operator.usage('yesterday'), refused);
      await assert.rejects(delegate.usage(), refused);
    });
  });
}
