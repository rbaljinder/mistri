/**
 * A tenant command's lookup reads the tenant's own tables (a field report: consent kept in a table of its own,
 * checked before a model is called), read only, as the person running the command could read them: a table their
 * role reads is read through their row filter and their column rule, inside their tenant; a table their role does
 * not read is refused in words that name it, and the refusal fails that command, not the next; a lookup has no
 * writes, in its type or at runtime; and what it reads of an audited resource is written under the command.
 * SQLite always, PostgreSQL live-gated (support/tenantDialects.ts).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test, type TestContext } from 'node:test';
import { refusalReasons } from '../packages/engine/src/shared/refusal.js';
import { provisionPostgresReadAudit } from '../packages/mistri/src/adapters/readAudit/postgresReadAudit.js';
import { provisionSqliteReadAudit } from '../packages/mistri/src/adapters/readAudit/sqliteReadAudit.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { forgetReadAuditCoalescing } from '../packages/mistri/src/server/readAudit.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantEnrollment, type TenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { parseTestApp } from './support/commandCatalog.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';

const DATABASE = `lookup_tenant_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

const binding = { appId: 'consent', source: { id: 'business', connection: 'consent-db' }, storeId: 'lookup-tenant-store' };
const SCHEMA = {
  tables: ['parcel', 'consent', 'vault'],
  sqlite: `PRAGMA journal_mode=WAL; PRAGMA busy_timeout = 0;
    CREATE TABLE parcel (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, subject TEXT NOT NULL);
    CREATE TABLE consent (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, subject TEXT NOT NULL, owner_id TEXT NOT NULL,
      granted INTEGER NOT NULL, memo TEXT);
    CREATE TABLE vault (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, body TEXT NOT NULL);`,
  postgres: `
    CREATE TABLE public.parcel (id text PRIMARY KEY, tenant_id text NOT NULL, subject text NOT NULL);
    CREATE TABLE public.consent (id text PRIMARY KEY, tenant_id text NOT NULL, subject text NOT NULL, owner_id text NOT NULL,
      granted integer NOT NULL, memo text);
    CREATE TABLE public.vault (id text PRIMARY KEY, tenant_id text NOT NULL, body text NOT NULL);`,
};
/* c1 is Alice's and in her tenant; c2 is in her tenant but another owner's, outside her row filter; c3 is the
   other tenant's, under her own name, so only the tenant scope keeps it out. */
const ROWS = `
    INSERT INTO parcel VALUES ('p1', 'north', 'ada'), ('p2', 'south', 'ada');
    INSERT INTO consent VALUES ('c1', 'north', 'ada', 'alice', 1, 'north note'), ('c2', 'north', 'ada', 'bob', 1, 'bob note'),
      ('c3', 'south', 'ada', 'alice', 1, 'south note');
    INSERT INTO vault VALUES ('v1', 'north', 'sealed');`;
const OWNERSHIP = {
  parcel: { kind: 'tenant', column: 'tenant_id' },
  consent: { kind: 'tenant', column: 'tenant_id' },
  vault: { kind: 'tenant', column: 'tenant_id' },
} as const;

type Consent = { id: string; subject: string; owner_id: string; granted: number; memo: string | null };
const said: { write?: string } = {};
const registry = defineCommands({
  check: defineCommand({
    source: 'business',
    target: 'parcel',
    targets: 'none',
    read: ['parcel'],
    input: {},
    sources: { business: ['consent'] },
    output: { parse: (value: unknown) => value as { listed: string[]; got: string[]; columns: string[] } },
    async lookup({ sources }) {
      const listed = (await sources.business.consent.where({ subject: 'ada' }).orderBy('id').limit(10)) as Consent[];
      const got: string[] = [];
      for (const id of ['c1', 'c2', 'c3'])
        try {
          if ((await sources.business.consent.get(id)) !== undefined) got.push(id);
        } catch {
          // Not found, hidden or another tenant's: a lookup cannot tell which, and needs not.
        }
      return { listed: listed.map((row) => row.id), got, columns: Object.keys(listed[0] ?? {}).sort() };
    },
    async handle({ lookup }) {
      return lookup as { listed: string[]; got: string[]; columns: string[] };
    },
  }),
  peek: defineCommand({
    source: 'business',
    target: 'parcel',
    targets: 'none',
    read: ['parcel'],
    input: {},
    sources: { business: ['vault'] },
    output: { parse: (value: unknown) => value },
    async lookup({ sources }) {
      return { body: (await sources.business.vault.get('v1')).body };
    },
    async handle({ lookup }) {
      return lookup;
    },
  }),
  scribble: defineCommand({
    source: 'business',
    target: 'parcel',
    targets: 'none',
    read: ['parcel'],
    input: {},
    sources: { business: ['consent'] },
    output: { parse: (value: unknown) => value },
    async lookup({ sources }) {
      const consent = sources.business.consent;
      try {
        // @ts-expect-error A lookup only reads: its tables have no insert.
        await consent.insert({ id: 'c9', subject: 'ada', owner_id: 'alice', granted: 1 });
      } catch (error) {
        said.write = (error as Error).message;
        throw error;
      }
      return {};
    },
    async handle() {
      return {};
    },
  }),
});

/* Alice's row policy: her own consent records only, every parcel and vault row of her tenant. */
const ROWS_OF_ALICE: RowScope = {
  parcel: true,
  consent: { groups: [[{ column: 'owner_id', op: '=' as const, value: 'alice' }]] },
  vault: true,
};
const policy = defineAppTenantPolicy({
  kind: 'tenant',
  appId: binding.appId,
  storeId: binding.storeId,
  ownership: OWNERSHIP,
  resolveMembershipRows: () => ROWS_OF_ALICE,
  resolveRows: () => ROWS_OF_ALICE,
  resultReferences: { check: () => [], peek: () => [], scribble: () => [] },
});
const manifest = () => ({
  id: binding.appId,
  name: 'Consent',
  sources: { business: { connection: binding.source.connection } },
  resources: {
    parcel: { owner: 'tenant', access: 'write' },
    consent: { owner: 'tenant', audit: { reads: true } },
    vault: { owner: 'tenant' },
  },
  auth: {
    rows: 'tenant',
    roles: {
      // Reads parcels and consent, never the memo; not the vault.
      clerk: {
        read: ['parcel', 'consent'],
        fields: { consent: { read: ['id', 'subject', 'owner_id', 'granted'] } },
        commands: ['check', 'peek', 'scribble'],
      },
      keeper: { read: true, commands: ['peek'] },
    },
  },
  views: { parcels: { kind: 'list', from: 'parcel' } },
  nav: ['parcels'],
  home: 'parcels',
});

type Request = { readonly cookie?: string };
const alice: Request = { cookie: 'alice' };

async function enrolled(t: TestContext, dialect: TenantDialect) {
  const engine = await openTenantEngine(dialect, {
    tables: SCHEMA.tables,
    sqlite: SCHEMA.sqlite + ROWS,
    postgres: SCHEMA.postgres + ROWS,
    database: DATABASE,
  });
  let service: TenantEnrollment<Request> | undefined;
  t.after(async () => {
    try {
      await service?.retire();
    } finally {
      await engine.close();
    }
  });
  await engine.provisionStore(binding);
  await engine.migrateCommandJournal();
  if (dialect === 'postgres') await provisionPostgresReadAudit(engine.url);
  else provisionSqliteReadAudit(engine.path);
  const grant = { status: 'active' as const, validUntil: 1_000_000, expectedVersion: null, roles: ['clerk'] };
  await engine.maintenance(binding, async (admin) => {
    for (const tenantId of ['north', 'south']) {
      await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
      await admin.putMembership({ ...grant, tenantId, accountId: 'alice', membershipId: `${tenantId}-alice` });
    }
  });
  service = await createTenantEnrollment<Request>({
    app: parseTestApp(manifest(), 'consent.ts'),
    policy,
    source: { ...binding.source, ...(dialect === 'postgres' ? { url: engine.url } : { existingPath: engine.path }) },
    deployment: 'generation',
    roles: ['clerk', 'keeper'],
    maxLifetimeMs: 60_000,
    now: () => 100,
    commands: { registry },
    verifySession: (request) => (request.cookie === 'alice' ? { id: 'alice', who: 'Alice' } : null),
  });
  const deployment = service.deployment;
  let attempt = 0;
  const run = (command: 'check' | 'peek' | 'scribble') =>
    deployment.execute(alice, ['north'], {
      command,
      commandVersion: 1,
      key: {},
      expectedVersion: 0,
      idempotencyKey: `${command}-attempt-${String(++attempt).padStart(4, '0')}`,
      input: {},
    });
  const audit = dialect === 'postgres' ? 'mistri.read_audit_row' : '"__mistri_read_audit_row"';
  const audited = async () =>
    (await engine.all(`SELECT route, command, resource, actor, tenant, record_key, ids_json FROM ${audit} ORDER BY id`)).map((row) => ({
      ...row,
    }));
  const consents = async () => (await engine.all('SELECT id FROM consent ORDER BY id')).map((row) => row.id);
  return { run, audited, consents };
}

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`a tenant command's lookup of its tenant's own tables on ${dialect}`, { skip }, () => {
    test("it reads a table the person's role reads, through their row filter, column rule and tenant", async (t) => {
      const f = await enrolled(t, dialect);
      const done = await f.run('check');
      assert.equal(done.status, 'applied');
      assert.deepEqual(JSON.parse(JSON.stringify(done.result)), {
        // c2 is outside Alice's row filter; c3 is the other tenant's, under her own name.
        listed: ['c1'],
        got: ['c1'],
        // The memo is not in her role's column rule.
        columns: ['granted', 'id', 'owner_id', 'subject'],
      });
    });

    test('what it reads of an audited resource is written under the command, in its tenant', async (t) => {
      const f = await enrolled(t, dialect);
      // The same reads in this process a moment ago are coalesced into the earlier row; this database has none yet.
      forgetReadAuditCoalescing();
      assert.equal((await f.run('check')).status, 'applied');
      const rows = await f.audited();
      assert.ok(rows.length > 0, 'the lookup wrote its reads');
      for (const row of rows)
        assert.deepEqual([row.route, row.command, row.resource, row.actor, row.tenant], ['command', 'check', 'consent', 'alice', 'north']);
      // The list, and each key it asked for: a key it could not read is recorded as asked, as a target's is, and
      // nothing it could not read is among what any read returned.
      assert.deepEqual(
        rows.map((row) => [row.record_key, row.ids_json]),
        [
          [null, '["c1"]'],
          ['c1', null],
          ['c2', null],
          ['c3', null],
        ],
      );
    });

    test('a table the role does not read is refused in words that name it, and the next command runs', async (t) => {
      const f = await enrolled(t, dialect);
      await assert.rejects(f.run('peek'), (error: unknown) => {
        assert.match([(error as Error).message, ...refusalReasons(error)].join(' | '), /vault/);
        return true;
      });
      assert.equal((await f.run('check')).status, 'applied');
    });

    test('a lookup cannot write: the attempt is refused in plain words and nothing lands', async (t) => {
      const f = await enrolled(t, dialect);
      await assert.rejects(f.run('scribble'));
      assert.match(said.write ?? '', /a lookup only reads, so "insert" is not there/);
      assert.deepEqual(await f.consents(), ['c1', 'c2', 'c3']);
      assert.equal((await f.run('check')).status, 'applied');
    });
  });
