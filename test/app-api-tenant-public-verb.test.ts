/** A public form's command as a tenant App's API verb (api/apiPublicLane.ts through api/tenantApiReadOwner.ts), over
 * the tenant host's real HTTP: the lending App with two dealers, a token the real `api-token issue --tenant` mints
 * naming `command:apply`, served by the CLI under `--policy` and called over loopback. The call lands one row in the
 * token's own tenant (never triage, never another tenant's); a token whose scope does not name the command is
 * refused, and so is one for a tenant that is no longer active. SQLite always; PostgreSQL when TABLEWALK_TEST_PG is
 * set, in databases of its own that it drops. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { migratePostgresAuthStore } from '../packages/mistri/src/adapters/auth/postgresAuthStore.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import {
  createSqliteTenantAdministration,
  provisionSqliteTenantStore,
  type TenantStoreAdministration,
} from '../packages/mistri/src/server/tenant/tenantStore.js';
import {
  createPostgresTenantAdministration,
  migratePostgresTenantStore,
} from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import { resetPublicFormLimits } from '../packages/engine/src/server/http/rateLimit.js';
import { publicVerbPlatformWrite } from '../packages/mistri/src/server/api/apiTenantCommandCatalog.js';
import { ROOT, SESSION_SECRET, serveApi, tokenCli } from './appApiCli.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
interface Client extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}

const STORE = 'lending-store';
const TABLES = {
  sqlite: `CREATE TABLE dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, intake_address TEXT);
    CREATE TABLE lead (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), reference TEXT NOT NULL,
      name TEXT NOT NULL, UNIQUE (tenant_id, reference));
    CREATE TABLE intake_submission (id TEXT PRIMARY KEY NOT NULL, reference TEXT NOT NULL, name TEXT NOT NULL, dealer_hint TEXT);`,
  postgres: `CREATE TABLE public.dealer (id text PRIMARY KEY, name text NOT NULL, intake_address text);
    CREATE TABLE public.lead (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.dealer(id), reference text NOT NULL,
      name text NOT NULL, UNIQUE (tenant_id, reference));
    CREATE TABLE public.intake_submission (id text PRIMARY KEY, reference text NOT NULL, name text NOT NULL, dealer_hint text);`,
};
const DEALERS = `INSERT INTO dealer VALUES ('north', 'North Motors', 'north@intake.example.test'),
  ('south', 'South Auto', 'south@intake.example.test')`;

/** The lending deployment on one engine, provisioned as an operator would: its tenant store (north and south, one
 * staff member each, and the platform), journal, native accounts and token store; tokens by the real CLI. `variant` is
 * what the `apply` command does: `lead` (the default) places a lead in the token's tenant; `link` also mints a
 * capability link; `platform` writes the platform's triage table, which no tenant verb may. */
async function lending(t: TestContext, dialect: 'sqlite' | 'postgres', variant: 'lead' | 'link' | 'platform' = 'lead') {
  const directory = mkdtempSync(join(tmpdir(), `tw-tenant-public-verb-${dialect}-`));
  const cleanup: Array<() => unknown> = [() => rmSync(directory, { recursive: true, force: true })];
  t.after(async () => {
    for (const step of cleanup.reverse())
      await Promise.resolve()
        .then(step)
        .catch(() => {});
  });
  const store = { appId: 'lending', source: { id: 'business', connection: 'data' }, storeId: STORE };
  let business: string, authStore: string;
  let maintenance: (run: (admin: TenantStoreAdministration) => Promise<void>) => Promise<void>;
  let accounts: (ids: string[]) => Promise<void>;
  let rows: (sql: string) => Promise<Array<Record<string, unknown>>>;
  if (dialect === 'sqlite') {
    business = join(directory, 'business.db');
    authStore = join(directory, 'auth.db');
    const db = new DatabaseSync(business);
    cleanup.push(() => db.close());
    // Beside a serving process: wait for its locks rather than fail.
    db.exec(`PRAGMA busy_timeout = 10000; ${TABLES.sqlite}; ${DEALERS}`);
    migrateSqliteCommandJournal(business);
    provisionSqliteTenantStore(business, store);
    maintenance = async (run) => {
      const operations = new TransactionOperations();
      db.exec('BEGIN IMMEDIATE');
      try {
        await run(createSqliteTenantAdministration(db, operations, store));
        await operations.finish();
        db.exec('COMMIT');
      } catch (error) {
        await operations.finish().catch(() => {});
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    };
    rows = async (sql) =>
      db
        .prepare(sql)
        .all()
        .map((row) => ({ ...row }));
    accounts = async (ids) => {
      const native = new DatabaseSync(authStore);
      try {
        for (const id of ids)
          native
            .prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES (?,?,?,1,?,?,?,0)')
            .run(id, id, `${id}@example.test`, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', null);
      } finally {
        native.close();
      }
    };
  } else {
    const module = 'pg';
    const pg = (await import(module)) as { default: { Client: new (options: unknown) => Client } };
    const control = new pg.default.Client({ connectionString: LIVE, statement_timeout: 10000 });
    await control.connect();
    const names = ['auth', 'business'].map((kind) => `tw_tenant_verb_${kind}_${randomUUID().replaceAll('-', '')}`);
    cleanup.unshift(async () => {
      for (const name of names) await control.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await control.end();
    });
    for (const name of names) await control.query(`CREATE DATABASE "${name}"`);
    [authStore, business] = names.map((name) => {
      const url = new URL(LIVE!);
      url.pathname = `/${name}`;
      return url.href;
    });
    const client = new pg.default.Client({ connectionString: business, statement_timeout: 10000 });
    await client.connect();
    cleanup.push(() => client.end());
    await client.query(`${TABLES.postgres}; ${DEALERS.replaceAll('INTO dealer', 'INTO public.dealer')}`);
    await migratePostgresCommandJournal(business);
    await migratePostgresTenantStore(business, store);
    maintenance = async (run) => {
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
    rows = async (sql) => (await client.query(sql)).rows as Array<Record<string, unknown>>;
    await migratePostgresAuthStore(authStore);
    accounts = async (ids) => {
      const native = new pg.default.Client({ connectionString: authStore, statement_timeout: 10000 });
      await native.connect();
      try {
        for (const id of ids)
          await native.query(
            `INSERT INTO mistri.auth_user(id,name,email,"emailVerified","createdAt","updatedAt",role,banned)
          VALUES($1,$1,$2,true,now(),now(),NULL,false)`,
            [id, `${id}@example.test`],
          );
      } finally {
        await native.end();
      }
    };
  }
  await maintenance(async (admin) => {
    for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    for (const [account, tenantId] of [
      ['alice', 'north'],
      ['bob', 'south'],
    ])
      await admin.putMembership({
        tenantId,
        accountId: account,
        membershipId: `m-${account}-${tenantId}`,
        status: 'active',
        roles: ['staff'],
        validUntil: Date.now() + 3600000,
        expectedVersion: null,
      });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
  });

  // The App: a public `apply` form whose command is also an API verb; leads are a tenant's, submissions the platform's.
  const appDir = join(directory, 'lending');
  mkdirSync(appDir);
  const config = join(directory, 'lending.json'),
    policy = join(directory, 'policy.mjs'),
    commands = join(appDir, 'commands.mjs');
  writeFileSync(
    join(appDir, 'app.json'),
    JSON.stringify({
      id: 'lending',
      name: 'Lending',
      sources: { business: { connection: 'data' } },
      resources: {
        dealer: { owner: 'platform' },
        lead: { access: 'write', owner: 'tenant' },
        intake_submission: { access: 'write', owner: 'platform' },
      },
      auth: {
        providers: ['email'],
        store: authStore,
        rows: 'tenant',
        tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
        roles: { staff: { realm: 'tenant', read: true }, manager: { realm: 'platform', read: true } },
      },
      views: {
        leads: { kind: 'list', from: 'lead' },
        triage: { kind: 'list', from: 'intake_submission' },
        apply: { kind: 'form', label: 'Apply for financing', public: true, command: 'apply' },
      },
      nav: [
        { id: 'dealership', label: 'Dealership', realm: 'tenant', children: ['leads'] },
        { id: 'lender', label: 'Lender', realm: 'platform', children: ['triage'] },
      ],
      home: 'leads',
      api: {
        version: 1,
        roles: ['staff'],
        resources: { lead: { fields: ['id', 'reference', 'name'], sorts: ['id'] } },
        commands: ['apply'],
      },
    }),
  );
  writeFileSync(config, JSON.stringify({ connections: [{ id: 'data', name: 'data', url: business, writable: true }] }));
  const source = (path: string) => pathToFileURL(join(ROOT, path)).href;
  writeFileSync(
    policy,
    `import { defineAppTenantPolicy } from '${source('packages/mistri/src/server/policy/appTenantPolicy.ts')}';
export default defineAppTenantPolicy({ kind: 'tenant', appId: 'lending', storeId: '${STORE}',
  ownership: { dealer: { kind: 'platform' }, lead: { kind: 'tenant', column: 'tenant_id' }, intake_submission: { kind: 'platform' } },
  resolveMembershipRows: () => ({ dealer: true, lead: true, intake_submission: true }),
  resolveRows: () => ({ dealer: true, lead: true, intake_submission: true }),
  resolvePlatformRows: () => ({ dealer: true, lead: true, intake_submission: true }),
  resultReferences: { apply: () => [] }, intake: { address: 'intake_address' } });
`,
  );
  const body = {
    lead: `async handle({ db, intake }, input) {
    // The same reference in every dealer: equal business ids, and distinct rows by tenant. An API verb writes only
    // tenant-owned tables (apiTenantCommandCatalog.ts), so it has no triage to write: it places a lead or nothing.
    const reference = 'API-' + input.name;
    if (intake === 'tenant') await db.lead.insert({ id: randomUUID(), reference, name: input.name });
    return { reference, message: 'Application received.' };
  }`,
    link: `async handle({ db, intake, link }, input) {
    const reference = 'API-' + input.name;
    if (intake === 'tenant') await db.lead.insert({ id: randomUUID(), reference, name: input.name });
    await link('status');
    return { reference, message: 'Application received.' };
  }`,
    platform: `async handle({ db }, input) {
    const reference = 'API-' + input.name;
    await db.intake_submission.insert({ id: randomUUID(), reference, name: input.name });
    return { reference, message: 'Application received.' };
  }`,
  }[variant];
  writeFileSync(
    commands,
    `import { randomUUID } from 'node:crypto';
import { defineCommand, defineCommands } from '${source('packages/mistri/src/server/commands/businessCommands.ts')}';
import { literal, shape, text } from '${source('packages/mistri/src/server/commands/commandShapes.ts')}';
export default defineCommands({ apply: defineCommand({ source: 'business', target: '${variant === 'platform' ? 'intake_submission' : 'lead'}', targets: 'none',
  public: true, input: { name: { label: 'Name', type: 'text', max: 80 } },
  output: shape({ reference: text(), message: literal('Application received.') }),
  ${body} }) });
`,
  );
  const loaded = await loadApp(appDir, { commands, lock: 'report' });
  writeFileSync(join(appDir, 'authority.lock'), loaded.authority!.report);
  if (dialect === 'sqlite') {
    // The native auth store as the tenant host creates it, then the accounts.
    const saved = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = SESSION_SECRET;
    try {
      (
        await createAppAuth(await loadApp(appDir, { commands }), { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'] })
      ).close();
    } finally {
      if (saved === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = saved;
    }
  }
  await accounts(['alice', 'bob', 'operator']);
  const common = ['--app', appDir, '--config', config, '--store-id', randomUUID()];
  const provisioned = await tokenCli(['provision', ...common]);
  assert.equal(provisioned.code, 0, provisioned.err);
  /** A token for a member's own tenant, naming `operations` (all it may use, when none are named). */
  const issue = async (subject: string, tenant: string, operations: readonly string[] = []) => {
    const issued = await tokenCli([
      'issue',
      ...common,
      '--tenant',
      tenant,
      '--policy',
      policy,
      '--commands',
      commands,
      '--subject',
      subject,
      '--actor',
      'operator',
      '--role',
      'staff',
      '--label',
      'Tenant public verb',
      '--expires-at',
      new Date(Date.now() + 600000).toISOString(),
      ...operations.flatMap((operation) => ['--operation', operation]),
    ]);
    assert.equal(issued.code, 0, issued.err);
    return (JSON.parse(issued.out) as { result: { token: string; tokenId: string } }).result;
  };
  return { appDir, config, policy, commands, issue, maintenance, rows };
}

for (const { dialect, skip } of [
  { dialect: 'sqlite' as const, skip: false as const },
  { dialect: 'postgres' as const, skip: liveSkip('postgres', LIVE) },
])
  test(
    `a tenant App's public command is an API verb on ${dialect}, over HTTP: it writes into the token's own tenant, and only for a token that names it`,
    { skip, timeout: 600000 },
    async (t) => {
      resetPublicFormLimits();
      const f = await lending(t, dialect);
      const alice = await f.issue('alice', 'north', ['command:apply']);
      const bob = await f.issue('bob', 'south', ['command:apply']);
      // A token for the same tenant whose scope names a read alone: the verb is not among its operations.
      const reader = await f.issue('alice', 'north', ['list:lead']);
      const s = await serveApi(t, { config: f.config, appDir: f.appDir, commands: f.commands }, 'lending', ['--policy', f.policy]);
      await s.started;
      let counter = 0;
      const apply = async (
        token: string,
        name: string,
        key = `tenant-verb-${dialect}-${String(++counter).padStart(8, '0')}`,
        extra: Record<string, unknown> = {},
      ) => {
        const response = await fetch(`${s.base}/lead/commands/apply/v1`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'idempotency-key': key, 'content-type': 'application/json' },
          body: JSON.stringify({ name, ...extra }),
        });
        return {
          status: response.status,
          replayed: response.headers.get('idempotent-replayed') === 'true',
          body: (await response.json()) as Record<string, unknown>,
        };
      };
      const leads = (name: string) => f.rows(`SELECT tenant_id, reference FROM lead WHERE name = '${name}' ORDER BY tenant_id`);
      const submissions = async () => Number((await f.rows('SELECT CAST(count(*) AS INTEGER) AS n FROM intake_submission'))[0]!.n);

      // 200, and one row in north: the token's tenant, by its own reference, and never the platform's triage.
      const key = `tenant-verb-${dialect}-shared-key`;
      const applied = await apply(alice.token, 'Hedy', key);
      assert.equal(applied.status, 200, JSON.stringify(applied.body));
      assert.deepEqual(await leads('Hedy'), [{ tenant_id: 'north', reference: 'API-Hedy' }]);
      assert.equal(await submissions(), 0);
      // The same key replays its receipt and writes nothing more.
      assert.equal((await apply(alice.token, 'Hedy', key)).replayed, true);
      assert.equal((await leads('Hedy')).length, 1);

      // A token whose scope does not name the command is refused, and nothing is written.
      const refused = await apply(reader.token, 'Mallory');
      assert.equal(refused.status, 403, JSON.stringify(refused.body));
      assert.deepEqual(await leads('Mallory'), []);
      // No token at all is no caller.
      const anonymous = await fetch(`${s.base}/lead/commands/apply/v1`, {
        method: 'POST',
        headers: { 'idempotency-key': `tenant-verb-${dialect}-anonymous`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Mallory' }),
      });
      assert.equal(anonymous.status, 401);
      await anonymous.body?.cancel();

      // Another tenant's token reaches its own tenant alone. Under alice's key it is another caller: its own receipt
      // and its own row, with north's untouched.
      const other = await apply(bob.token, 'Hedy', key);
      assert.equal(other.status, 200, JSON.stringify(other.body));
      assert.equal(other.replayed, false);
      assert.deepEqual(await leads('Hedy'), [
        { tenant_id: 'north', reference: 'API-Hedy' },
        { tenant_id: 'south', reference: 'API-Hedy' },
      ]);
      // It cannot name the tenant it writes to: a field that would place the row is no input of the verb.
      const forged = await apply(bob.token, 'Mallory', undefined, { tenant_id: 'north', address: 'north@intake.example.test' });
      assert.ok([400, 422].includes(forged.status), JSON.stringify(forged.body));
      assert.deepEqual(await leads('Mallory'), []);
      const placed = await apply(bob.token, 'Ada');
      assert.equal(placed.status, 200, JSON.stringify(placed.body));
      assert.deepEqual(await leads('Ada'), [{ tenant_id: 'south', reference: 'API-Ada' }]);
      assert.equal(await submissions(), 0);

      // A tenant that is no longer active takes nothing from its token.
      await f.maintenance((admin) => admin.putTenant({ tenantId: 'south', status: 'suspended', expectedVersion: '1' }));
      const suspended = await apply(bob.token, 'Grace');
      assert.equal(suspended.status, 403, JSON.stringify(suspended.body));
      assert.deepEqual(await leads('Grace'), []);
      assert.equal(await submissions(), 0);
    },
  );

for (const { dialect, skip } of [
  { dialect: 'sqlite' as const, skip: false as const },
  { dialect: 'postgres' as const, skip: liveSkip('postgres', LIVE) },
]) {
  test(
    `a tenant App's public command that mints a link is refused when the deployment starts, by name, on ${dialect}`,
    { skip, timeout: 600000 },
    async (t) => {
      resetPublicFormLimits();
      const f = await lending(t, dialect, 'link');
      const s = await serveApi(t, { config: f.config, appDir: f.appDir, commands: f.commands }, 'lending', ['--policy', f.policy]);
      await assert.rejects(
        s.started,
        /Public form "apply" runs "apply", which mints a capability link .*tenant App only lets a member or a service/s,
      );
      assert.match(s.output(), /a tenant App cannot take that command's signed-out submissions/);
    },
  );

  test(
    `a public form that writes a platform table is refused as a tenant API verb, and named where the deployment starts, on ${dialect}`,
    { skip, timeout: 600000 },
    async (t) => {
      resetPublicFormLimits();
      const f = await lending(t, dialect, 'platform');
      const named =
        /public form "apply" \(command "apply"\) writes platform table "intake_submission", so it cannot be a tenant App API verb/;
      // No token is minted for it. The token CLI's refusal is opaque by design (the catalog's own sentence stays in the
      // runtime's record); the author hears the case by name where the deployment starts, which `mistri check` runs too.
      await assert.rejects(f.issue('alice', 'north', ['command:apply']));
      const s = await serveApi(t, { config: f.config, appDir: f.appDir, commands: f.commands }, 'lending', ['--policy', f.policy]);
      await assert.rejects(s.started, named);
    },
  );
}

test('check names a public command that writes a platform table as a tenant API verb, and leaves a tenant table and a non-public command alone', () => {
  const app = { views: { apply: { kind: 'form', public: true, command: { id: 'apply' } } } } as never;
  const owned = { ownership: { lead: { kind: 'tenant', column: 'tenant_id' }, intake_submission: { kind: 'platform' } } } as never;
  assert.match(
    publicVerbPlatformWrite(app, 'apply', { public: true, write: ['intake_submission'] }, owned)!,
    /^public form "apply" \(command "apply"\) writes platform table "intake_submission", so it cannot be a tenant App API verb/,
  );
  assert.equal(publicVerbPlatformWrite(app, 'apply', { public: true, write: ['lead'] }, owned), undefined);
  assert.equal(publicVerbPlatformWrite(app, 'apply', { public: false, write: ['intake_submission'] }, owned), undefined);
});
