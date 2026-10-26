import { namedCommands } from './support/commandCatalog.js';
/* A tenant App that has a platform-only source still serves its own data
   through the App API. The lending App below reads `item` and runs `touch`
   under a token bound to one membership, over `--api-reads` HTTP and
   `--app-mcp` stdio, while its lender-only `applicants` source is reachable
   by nothing: not a read, not the document, not a tool listing. Exposing that
   source is refused by name — at parse for a resource or a view, and again in
   the checked tenant catalog, which walks what an operation resolves to.
   SQLite always, PostgreSQL live, on databases this suite owns. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { migratePostgresAuthStore } from '../packages/mistri/src/adapters/auth/postgresAuthStore.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { readSqliteReadCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { checkApiTenantReadCatalog } from '../packages/mistri/src/server/api/apiTenantReadCatalog.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import {
  createSqliteTenantAdministration,
  provisionSqliteTenantStore,
  type TenantStoreAdministration,
} from '../packages/mistri/src/server/tenant/tenantStore.js';
import {
  createPostgresTenantAdministration,
  migratePostgresTenantStore,
} from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import { ROOT, SESSION_SECRET, mcpEnv, serveApi, startAppMcp, tokenCli, within } from './appApiCli.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
interface Client extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
const STORE = 'lending-api-store';
const ITEM = (physical: string) =>
  `CREATE TABLE ${physical}(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, ` +
  'name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0)';
const ITEM_ROWS = (physical: string) =>
  `INSERT INTO ${physical}(id, tenant_id, name) VALUES ('north-1','north','North one'),` +
  `('north-2','north','North two'),('south-1','south','South one')`;
const APPLICANT = (physical: string) => `CREATE TABLE ${physical}(id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, ssn TEXT)`;
const APPLICANT_ROWS = (physical: string) => `INSERT INTO ${physical}(id, name, ssn) VALUES ('a1','Ada','111-11-1111')`;

/** The lending App: its own `item` resource exposed through the API, and the
 * lender-only `applicants` source beside it, exposed to nothing. */
function writeLendingApp(
  directory: string,
  options: {
    business: string;
    applicants: string;
    authStore: string;
    physicalItem: string;
    physicalApplicant: string;
    api?: Record<string, unknown>;
  },
) {
  const appDir = join(directory, 'lending');
  mkdirSync(appDir);
  const config = join(directory, 'lending.json'),
    policy = join(directory, 'policy.mjs'),
    commands = join(appDir, 'commands.mjs');
  writeFileSync(
    join(appDir, 'app.json'),
    JSON.stringify(
      namedCommands({
        id: 'lending',
        name: 'Lending',
        auth: {
          providers: ['email'],
          store: options.authStore,
          rows: 'tenant',
          tenancy: { label: 'Dealer', platform: { label: 'Lender' } },
          roles: { member: { realm: 'tenant', read: true, commands: ['touch'] }, lender: { realm: 'platform', read: true } },
        },
        sources: { business: { connection: 'data', default: true }, applicants: { connection: 'refdata', realm: 'platform' } },
        resources: {
          item: { physical: options.physicalItem, owner: 'tenant', access: 'write' },
          'applicants.applicant': { physical: options.physicalApplicant, owner: 'platform' },
        },
        views: { items: { kind: 'list', from: 'item' }, applicants: { kind: 'list', from: 'applicants.applicant' } },
        nav: [
          { id: 'work', label: 'Work', realm: 'tenant', children: ['items'] },
          { id: 'lender', label: 'Lender', realm: 'platform', children: ['applicants'] },
        ],
        home: 'items',
        api: options.api ?? {
          version: 1,
          roles: ['member'],
          resources: { item: { fields: ['id', 'version', 'name'], sorts: ['id'] } },
          commands: [{ id: 'touch', version: 1, target: 'item', input: {} }],
        },
      }).app,
    ),
  );
  // The platform-only source's connection is never writable.
  writeFileSync(
    config,
    JSON.stringify({
      connections: [
        { id: 'data', name: 'data', url: options.business, writable: true },
        { id: 'refdata', name: 'refdata', url: options.applicants },
      ],
    }),
  );
  const source = (path: string) => pathToFileURL(join(ROOT, path)).href;
  writeFileSync(
    policy,
    `import { defineAppTenantPolicy } from '${source('packages/mistri/src/server/policy/appTenantPolicy.ts')}';
export default defineAppTenantPolicy({ kind: 'tenant', appId: 'lending', storeId: '${STORE}',
  ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
  resolveMembershipRows: () => ({ item: true }), resolveRows: () => ({ item: true }),
  resolvePlatformRows: () => ({ item: true, 'applicants.applicant': true }),
  resultReferences: { touch: () => [] } });
`,
  );
  writeFileSync(
    commands,
    `import { defineCommand, defineCommands } from '${source('packages/mistri/src/server/commands/businessCommands.ts')}';
import { shape, bool } from '${source('packages/mistri/src/server/commands/commandShapes.ts')}';
export default defineCommands({ touch: defineCommand({ source: 'business', target: 'item', 
  input: {}, output: shape({ ok: bool() }), async handle(context) {
    await context.tx.update({ table: 'item', key: { id: String(context.record.id) }, values: { version: Number(context.record.version) + 1 } });
    return { ok: true };
  } }) });
`,
  );
  return { appDir, config, policy, commands };
}

/** The deployment on one engine: business, platform-only and auth stores, the
 * tenant store, one native account and one active membership in north. */
async function lending(t: TestContext, dialect: 'sqlite' | 'postgres') {
  const directory = mkdtempSync(join(tmpdir(), `tw-platform-api-${dialect}-`));
  const cleanup: Array<() => unknown> = [() => rmSync(directory, { recursive: true, force: true })];
  t.after(async () => {
    for (const step of cleanup.reverse())
      await Promise.resolve()
        .then(step)
        .catch(() => {});
  });
  const store = { appId: 'lending', source: { id: 'business', connection: 'data' }, storeId: STORE };
  let business: string, applicants: string, authStore: string, physicalItem: string, physicalApplicant: string;
  let maintenance: (run: (admin: TenantStoreAdministration) => Promise<void>) => Promise<void>;
  let accounts: (ids: string[]) => Promise<void>;
  let version: (id: string) => Promise<number>;
  let applicantRows: () => Promise<unknown[]>;
  if (dialect === 'sqlite') {
    business = join(directory, 'business.db');
    applicants = join(directory, 'applicants.db');
    authStore = join(directory, 'auth.db');
    physicalItem = 'physical_item';
    physicalApplicant = 'applicant';
    const db = new DatabaseSync(business);
    cleanup.push(() => db.close());
    db.exec(`PRAGMA busy_timeout = 10000; ${ITEM(physicalItem)}; ${ITEM_ROWS(physicalItem)}`);
    migrateSqliteCommandJournal(business);
    provisionSqliteTenantStore(business, store);
    const reference = new DatabaseSync(applicants);
    cleanup.push(() => reference.close());
    reference.exec(`${APPLICANT(physicalApplicant)}; ${APPLICANT_ROWS(physicalApplicant)}`);
    applicantRows = async () =>
      reference
        .prepare('SELECT id, name, ssn FROM applicant ORDER BY id')
        .all()
        .map((row) => ({ ...row }));
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
    version = async (id) => Number(db.prepare(`SELECT version FROM ${physicalItem} WHERE id = ?`).get(id)!.version);
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
    const names = ['auth', 'business', 'refdata'].map((kind) => `tw_platform_api_${kind}_${randomUUID().replaceAll('-', '')}`);
    cleanup.unshift(async () => {
      for (const name of names) await control.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await control.end();
    });
    for (const name of names) await control.query(`CREATE DATABASE "${name}"`);
    [authStore, business, applicants] = names.map((name) => {
      const url = new URL(LIVE!);
      url.pathname = `/${name}`;
      return url.href;
    });
    physicalItem = 'public.physical_item';
    physicalApplicant = 'public.applicant';
    const client = new pg.default.Client({ connectionString: business, statement_timeout: 10000 });
    await client.connect();
    cleanup.push(() => client.end());
    await client.query(`${ITEM('physical_item')}; ${ITEM_ROWS('physical_item')}`);
    await migratePostgresCommandJournal(business);
    await migratePostgresTenantStore(business, store);
    const reference = new pg.default.Client({ connectionString: applicants, statement_timeout: 10000 });
    await reference.connect();
    cleanup.push(() => reference.end());
    await reference.query(`${APPLICANT('applicant')}; ${APPLICANT_ROWS('applicant')}`);
    applicantRows = async () => (await reference.query('SELECT id, name, ssn FROM applicant ORDER BY id')).rows.map((row) => ({ ...row }));
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
    version = async (id) => Number((await client.query('SELECT version FROM physical_item WHERE id = $1', [id])).rows[0].version);
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
    await admin.putMembership({
      tenantId: 'north',
      accountId: 'alice',
      membershipId: 'm-alice-north',
      status: 'active',
      roles: ['member'],
      validUntil: Date.now() + 3600000,
      expectedVersion: null,
    });
  });
  const written = writeLendingApp(directory, { business, applicants, authStore, physicalItem, physicalApplicant });
  writeFileSync(join(written.appDir, 'authority.lock'), (await loadApp(written.appDir, { lock: 'report' })).authority!.report);
  if (dialect === 'sqlite') {
    const saved = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = SESSION_SECRET;
    try {
      (
        await createAppAuth(await loadApp(written.appDir), { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'] })
      ).close();
    } finally {
      if (saved === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = saved;
    }
  }
  await accounts(['alice', 'operator']);
  const common = ['--app', written.appDir, '--config', written.config, '--store-id', randomUUID()];
  const provisioned = await tokenCli(['provision', ...common]);
  assert.equal(provisioned.code, 0, provisioned.err);
  const issued = await tokenCli([
    'issue',
    ...common,
    '--tenant',
    'north',
    '--policy',
    written.policy,
    '--commands',
    written.commands,
    '--subject',
    'alice',
    '--actor',
    'operator',
    '--role',
    'member',
    '--label',
    'Platform API',
    '--expires-at',
    new Date(Date.now() + 600000).toISOString(),
  ]);
  assert.equal(issued.code, 0, issued.err);
  const token = (JSON.parse(issued.out) as { result: { token: string } }).result.token;
  return { ...written, token, version, applicantRows };
}

/* ---------- the exposure refusals, without an engine ---------- */

const lendingManifest = (): Record<string, any> => ({
  id: 'lending',
  name: 'Lending',
  auth: {
    rows: 'tenant',
    tenancy: { label: 'Dealer', platform: { label: 'Lender' } },
    roles: { member: { realm: 'tenant', read: true }, lender: { realm: 'platform', read: true } },
  },
  sources: { business: { connection: 'data', default: true }, applicants: { connection: 'refdata', realm: 'platform' } },
  resources: { item: { owner: 'tenant' }, 'applicants.applicant': { owner: 'platform' } },
  views: { items: { kind: 'list', from: 'item' }, applicants: { kind: 'list', from: 'applicants.applicant' } },
  nav: [
    { id: 'work', label: 'Work', realm: 'tenant', children: ['items'] },
    { id: 'lender', label: 'Lender', realm: 'platform', children: ['applicants'] },
  ],
  home: 'items',
  api: { version: 1, roles: ['member'], resources: { item: { fields: ['id', 'name'], sorts: ['id'] } } },
});

test('the checked tenant catalog refuses an exposure that reaches a platform-only source, by name', (t) => {
  const app = parseAppConfig(lendingManifest(), 'lending.ts');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys = ON; ${ITEM('item')}`);
  db.exec('BEGIN');
  const physicalSchema = readSqliteReadCatalog(db).schema;
  db.exec('COMMIT');
  const catalog = appResourceCatalog(physicalSchema, { item: 'item' });
  const owned = captureTenantOwnership({
    appId: 'lending',
    source: { id: 'business', connection: 'data' },
    schema: catalog.schema,
    physicalSchema,
    resources: { item: 'item' },
    ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
  });
  // Its own resource is served: the source beside it is no bar.
  assert.ok(checkApiTenantReadCatalog(app, owned).operations.length);
  // An exposure of the source itself, as only a hand-built App could ask for:
  // the parser refuses it first, and the catalog refuses it again, by name.
  const exposed = {
    ...app,
    api: { ...app.api!, resources: { ...app.api!.resources, 'applicants.applicant': { fields: ['id'], filters: [], sorts: [] } } },
  };
  assert.throws(
    () => checkApiTenantReadCatalog(exposed, owned),
    /api\.resources\.applicants\.applicant.*belongs to the platform-only source "applicants"/,
  );
  const viewed = { ...app, api: { ...app.api!, views: [{ view: 'applicants' }] } };
  assert.throws(
    () => checkApiTenantReadCatalog(viewed, owned),
    /applicants.*platform-only source "applicants"|not a declared readable logical resource/,
  );
});

/* ---------- end to end through the real CLI ---------- */

for (const { dialect, skip } of [
  { dialect: 'sqlite' as const, skip: false as const },
  { dialect: 'postgres' as const, skip: liveSkip('postgres', LIVE) },
]) {
  test(
    `a tenant App with a platform-only source serves its own data through the App API on ${dialect}, and never that source`,
    { skip, timeout: 600000 },
    async (t) => {
      const f = await lending(t, dialect);
      const before = await f.applicantRows();
      const s = await serveApi(t, { config: f.config, appDir: f.appDir, commands: f.commands }, 'lending', ['--policy', f.policy]);
      await s.started;
      const headers = { authorization: `Bearer ${f.token}` };
      const get = async (path: string) => {
        const response = await fetch(`${s.base}${path}`, { headers, signal: AbortSignal.timeout(60000) });
        return { status: response.status, text: await response.text() };
      };
      const body = async (path: string) => JSON.parse((await get(path)).text) as Record<string, any>;

      // Its own rows, under the one membership the token binds.
      assert.deepEqual(await body('/item/north-1'), { id: 'north-1', version: '0', name: 'North one' });
      assert.equal((await get('/item/south-1')).status, 404, "another tenant's row is not this token's");
      assert.deepEqual(
        (await body('/item?sort=id')).items.map((row: { id: string }) => row.id),
        ['north-1', 'north-2'],
      );
      // The platform-only source is not a route it serves, and not in the document.
      // Unexposed is refused (403), not reported absent.
      assert.equal((await get('/applicants.applicant')).status, 403);
      const document = await get('/$openapi');
      assert.equal(document.status, 200);
      assert.equal(document.text.includes('applicant'), false, 'the document never mentions the platform-only source');
      assert.ok(Object.keys(JSON.parse(document.text).paths as object).includes('/item/{id}/commands/touch/v1'));

      // Its own command runs, once, under that membership.
      const applied = await fetch(`${s.base}/item/north-1/commands/touch/v1`, {
        method: 'POST',
        headers: { ...headers, 'if-match': '"0"', 'idempotency-key': `platform-api-${dialect}-1`, 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(60000),
      });
      assert.equal(applied.status, 200, await applied.text());
      assert.equal(await f.version('north-1'), 1);

      // App MCP: the same token, the same membership, and no tool of that source.
      const mcp = startAppMcp(
        t,
        [
          '--app-mcp',
          '--api-integers',
          'decimal-string',
          '--config',
          f.config,
          '--app',
          f.appDir,
          '--policy',
          f.policy,
          '--commands',
          f.commands,
        ],
        mcpEnv(f.token),
      );
      await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
      mcp.notify('notifications/initialized');
      const tools = (await mcp.request('tools/list')).result.tools as { name: string }[];
      assert.deepEqual(tools.map((tool) => tool.name.split('_')[0]).sort(), ['get', 'list', 'prepare', 'run']);
      assert.equal(JSON.stringify(tools).includes('applicant'), false, 'no tool names or describes the platform-only source');
      const read = await mcp.request('tools/call', {
        name: tools.find((tool) => tool.name.startsWith('get_'))!.name,
        arguments: { id: 'north-2' },
      });
      assert.deepEqual(read.result?.structuredContent, { id: 'north-2', version: '0', name: 'North two' }, JSON.stringify(read));

      /* Each child is asked to end and given a minute: one that never exits
         fails here with what it said, not at the runner's ten-minute timeout. */
      mcp.end();
      assert.equal(await within(mcp.closed, 60000, 'The App MCP child exiting at the end of its input', mcp.stderr), 0);
      s.child.kill('SIGTERM');
      assert.equal(await within(s.closed, 60000, 'The API server exiting on SIGTERM', s.output), 0);
      assert.deepEqual(await f.applicantRows(), before, 'the platform-only source is never written');
      assert.equal([s.output(), ...mcp.lines, mcp.stderr()].join('\n').includes(f.token), false);
    },
  );
}
