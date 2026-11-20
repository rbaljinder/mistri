/**
 * A tenant command's lookup reads a kept file (`sources.<source>.<file>.readFile`, a field report: a vendor asked
 * about a document the record keeps, before the command's transaction opened). The row is read through the lookup's
 * own reader, so the person's tenant, row filter and column rule hold as they hold for every other lookup read: a row
 * of another tenant's is not found, a role that does not read the file's column is refused in the handler's words,
 * and the read is audited under the command. The bytes it takes count into the one budget the handler's `readFile`
 * then continues.
 * SQLite always, PostgreSQL live-gated (support/tenantDialects.ts).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test, type TestContext } from 'node:test';
import { provisionPostgresReadAudit } from '../packages/mistri/src/adapters/readAudit/postgresReadAudit.js';
import { provisionSqliteReadAudit } from '../packages/mistri/src/adapters/readAudit/sqliteReadAudit.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { forgetReadAuditCoalescing } from '../packages/mistri/src/server/readAudit.js';
import { createTenantEnrollment, type TenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { refusalReasons } from '../packages/engine/src/shared/refusal.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { parseTestApp } from './support/commandCatalog.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';

const DATABASE = `lookup_file_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

const MIB = 1024 * 1024;
/* Big enough that three in the lookup and three in the handler pass the one 50 MB budget, small enough for the
   tenant's 10 MB file cap. */
const LARGE = 9 * MIB;
const binding = { appId: 'claims', source: { id: 'business', connection: 'claims-db' }, storeId: 'lookup-file-store' };
const SCHEMA = {
  tables: ['doc'],
  sqlite: `PRAGMA journal_mode=WAL; PRAGMA busy_timeout = 0;
    CREATE TABLE doc (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, file_name TEXT NOT NULL, content_type TEXT,
      byte_size INTEGER, data BLOB);`,
  postgres: `
    CREATE TABLE public.doc (id text PRIMARY KEY, tenant_id text NOT NULL, file_name text NOT NULL, content_type text,
      byte_size integer, data bytea);`,
};
const ROWS = {
  sqlite: `
    INSERT INTO doc VALUES ('d1', 'north', 'policy.pdf', 'application/pdf', 4, X'25504446'),
      ('s1', 'south', 'theirs.pdf', 'application/pdf', 4, X'25504447'),
      ('big', 'north', 'scan.tif', 'image/tiff', ${LARGE}, zeroblob(${LARGE}));`,
  postgres: `
    INSERT INTO doc VALUES ('d1', 'north', 'policy.pdf', 'application/pdf', 4, '\\x25504446'::bytea),
      ('s1', 'south', 'theirs.pdf', 'application/pdf', 4, '\\x25504447'::bytea),
      ('big', 'north', 'scan.tif', 'image/tiff', ${LARGE}, decode(repeat('00', ${LARGE}), 'hex'));`,
};

const read = { output: { parse: (value: unknown) => value } } as const;
const registry = defineCommands({
  // Reads the file the input names, before the transaction, and hands back what it saw.
  fetch: defineCommand({
    source: 'business',
    target: 'doc',
    targets: 'none',
    input: { which: field.text() },
    sources: { business: ['doc'] },
    ...read,
    async lookup({ sources }, value) {
      const file = await sources.business.doc.readFile(value.which);
      return { name: file.name, type: file.type, size: file.size, first: Array.from(file.data.subarray(0, 4)) };
    },
    async handle({ lookup }) {
      return lookup;
    },
  }),
  // Three reads in the lookup and three in the handler: the last passes 50 MB only if the handler continues the lookup's count.
  heavy: defineCommand({
    source: 'business',
    target: 'doc',
    targets: 'none',
    read: ['doc'],
    input: {},
    sources: { business: ['doc'] },
    ...read,
    async lookup({ sources }) {
      let size = 0;
      for (let n = 0; n < 3; n++) size += (await sources.business.doc.readFile('big')).size;
      return { size };
    },
    async handle({ db }) {
      const doc = db.doc as unknown as { readFile(given: unknown): Promise<{ size: number }> };
      for (let n = 0; n < 3; n++) await doc.readFile('big');
      return {};
    },
  }),
});

const ROWS_ALL: RowScope = { doc: true };
const policy = defineAppTenantPolicy({
  kind: 'tenant',
  appId: binding.appId,
  storeId: binding.storeId,
  ownership: { doc: { kind: 'tenant', column: 'tenant_id' } },
  resolveMembershipRows: () => ROWS_ALL,
  resolveRows: () => ROWS_ALL,
  resultReferences: { fetch: () => [], heavy: () => [] },
});
const manifest = () => ({
  id: binding.appId,
  name: 'Claims',
  sources: { business: { connection: binding.source.connection } },
  resources: {
    doc: {
      owner: 'tenant',
      access: 'write',
      audit: { reads: true },
      file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size', maxBytes: 10 * MIB },
    },
  },
  auth: {
    rows: 'tenant',
    roles: {
      clerk: { read: ['doc'], commands: ['fetch', 'heavy'] },
      // Reads a document's name, never its file.
      viewer: { read: ['doc'], fields: { doc: { read: ['id', 'file_name'] } }, commands: ['fetch'] },
    },
  },
  views: { docs: { kind: 'list', from: 'doc' } },
  nav: ['docs'],
  home: 'docs',
});

type Request = { readonly cookie?: string };
const people: Record<string, Request> = { alice: { cookie: 'alice' }, bob: { cookie: 'bob' } };

async function enrolled(t: TestContext, dialect: TenantDialect) {
  const engine = await openTenantEngine(dialect, {
    tables: SCHEMA.tables,
    sqlite: SCHEMA.sqlite + ROWS.sqlite,
    postgres: SCHEMA.postgres + ROWS.postgres,
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
  await engine.maintenance(binding, async (admin) => {
    await admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null });
    await admin.putTenant({ tenantId: 'south', status: 'active', expectedVersion: null });
    for (const [accountId, role] of [
      ['alice', 'clerk'],
      ['bob', 'viewer'],
    ])
      await admin.putMembership({
        tenantId: 'north',
        accountId,
        membershipId: `north-${accountId}`,
        status: 'active',
        validUntil: 1_000_000,
        expectedVersion: null,
        roles: [role],
      });
  });
  service = await createTenantEnrollment<Request>({
    app: parseTestApp(manifest(), 'claims.ts'),
    policy,
    source: { ...binding.source, ...(dialect === 'postgres' ? { url: engine.url } : { existingPath: engine.path }) },
    deployment: 'generation',
    roles: ['clerk', 'viewer'],
    maxLifetimeMs: 60_000,
    now: () => 100,
    commands: { registry },
    verifySession: (request) => (request.cookie && people[request.cookie] ? { id: request.cookie, who: request.cookie } : null),
  });
  const deployment = service.deployment;
  let attempt = 0;
  const audit = dialect === 'postgres' ? 'mistri.read_audit_row' : '"__mistri_read_audit_row"';
  return {
    run: (who: string, command: string, input: object = {}) =>
      deployment.execute(people[who]!, ['north'], {
        command,
        commandVersion: 1,
        key: {},
        expectedVersion: 0,
        idempotencyKey: `${command}-attempt-${String(++attempt).padStart(4, '0')}`,
        input,
      }),
    audited: async () =>
      (await engine.all(`SELECT route, command, resource, actor, tenant, record_key FROM ${audit} ORDER BY id`)).map((row) => ({ ...row })),
  };
}

const outcome = (run: Promise<unknown>) =>
  run.then(
    (done) => ({ done }),
    // The person hears the code; the reason is recorded for the owner (shared/refusal.ts).
    (error: { code?: string }) => ({ code: error.code, reasons: refusalReasons(error) }),
  );

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`a tenant command's lookup reads a kept file on ${dialect}`, { skip }, () => {
    test("its tenant's file, byte for byte, audited under the command", async (t) => {
      const f = await enrolled(t, dialect);
      forgetReadAuditCoalescing();
      const done = await f.run('alice', 'fetch', { which: 'd1' });
      assert.equal(done.status, 'applied', JSON.stringify(done));
      assert.deepEqual(JSON.parse(JSON.stringify(done.result)), {
        name: 'policy.pdf',
        type: 'application/pdf',
        size: 4,
        first: [0x25, 0x50, 0x44, 0x46],
      });
      assert.deepEqual(
        (await f.audited()).map((row) => [row.route, row.command, row.resource, row.actor, row.tenant, row.record_key]),
        [['command', 'fetch', 'doc', 'alice', 'north', 'd1']],
      );
    });

    test("another tenant's key is not found, and its bytes are never handed over", async (t) => {
      const f = await enrolled(t, dialect);
      const refused = await outcome(f.run('alice', 'fetch', { which: 's1' }));
      assert.equal((refused as { code?: string }).code, 'not_found', JSON.stringify(refused));
      assert.doesNotMatch(JSON.stringify(refused), /theirs\.pdf/);
    });

    test("a role that does not read the file's column is refused, as the handler's readFile refuses it", async (t) => {
      const f = await enrolled(t, dialect);
      const refused = await outcome(f.run('bob', 'fetch', { which: 'd1' }));
      assert.equal((refused as { code?: string }).code, 'forbidden', JSON.stringify(refused));
    });

    test("the handler's readFile continues the lookup's budget, so one command reads at most 50 MB in all", async (t) => {
      const f = await enrolled(t, dialect);
      const refused = await outcome(f.run('alice', 'heavy'));
      // 27 MB in the lookup and 18 in the handler: the handler alone would have read 27 MB in all.
      assert.match(
        String((refused as { reasons?: unknown }).reasons),
        /doc: one command reads at most 50 MB of files; this one has read 45 MB and this file is 9 MB/,
      );
    });
  });
