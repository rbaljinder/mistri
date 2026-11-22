/**
 * What a tenant App's command handler is told beside its input, through the tenant HTTP command path:
 * `ctx.tenant.<shared column>` (the tenant profile columns `auth.tenancy.shared` lists, read once per request) and
 * `ctx.actor.name` (the signed-in account's display name, off the verified session; absent where there is none).
 * And what its author is told when the handler sets a reference to a table the command does not read.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { describe, test, type TestContext } from 'node:test';
import type { VerifiedSessionInstance } from '../packages/mistri/src/server/auth/auth.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { createTenantHttpServer } from '../packages/mistri/src/server/tenant/tenantHttp.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { parseTestApp } from './support/commandCatalog.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';

type Answer = { status: number; text: string; body: Record<string, unknown> };
type Context = { tabId: string; context: string; accountId: string; tenantId: string; revision: number };
const appId = 'desk';
const binding = { appId, source: { id: 'business', connection: 'business-db' }, storeId: 'desk-actor-tenant-store' };

const app = parseTestApp(
  {
    id: appId,
    name: 'Desk',
    auth: {
      rows: 'tenant',
      tenancy: { label: 'Customer', profile: 'customer', shared: ['plan', 'country'], platform: { label: 'Operator' } },
      roles: { agent: { realm: 'tenant', read: ['ticket', 'shelf'], commands: ['noteWho'] }, operator: { realm: 'platform', read: true } },
    },
    sources: { business: { connection: binding.source.connection } },
    resources: { customer: { owner: 'platform' }, ticket: { owner: 'tenant', access: 'write' }, shelf: { owner: 'tenant' } },
    views: { tickets: { kind: 'list', from: 'ticket', realm: 'tenant' } },
    home: 'tickets',
    nav: [{ id: 'desk', label: 'Desk', realm: 'tenant', children: ['tickets'] }],
  },
  'desk actor tenant fixture',
);

const seen: Array<{ tenant: unknown; name: unknown; hasName: boolean }> = [];
const registry = defineCommands({
  noteWho: defineCommand({
    source: 'business',
    target: 'ticket',
    targets: 'none',
    read: ['ticket'],
    write: ['ticket'],
    input: {
      id: { type: 'text' },
      // A reference to a table the command does not read: its run is the author's mistake, said as one.
      shelf: { type: 'text', optional: true },
      // Offered only where the tenant's profile holds the option's `when`: a run elsewhere is refused it.
      reach: {
        type: 'choice',
        optional: true,
        options: [
          { value: 'email', label: 'Email' },
          { value: 'text', label: 'Text', when: "tenant.country = 'US'" },
        ],
      },
    },
    output: { parse: (value: unknown) => value as { id: string } },
    async handle({ db, tenant, actor }, input) {
      seen.push({ tenant: { ...tenant }, name: actor.name, hasName: 'name' in actor });
      await db.ticket.insert({ id: String(input.id), opened_on: '2026-01-01', ...(input.shelf ? { shelf_id: input.shelf } : {}) });
      return { id: String(input.id) };
    },
  }),
});
const rows: RowScope = { ticket: true, shelf: true };
const policy = defineAppTenantPolicy({
  kind: 'tenant',
  appId,
  storeId: binding.storeId,
  ownership: {
    customer: { kind: 'platform' },
    ticket: { kind: 'tenant', column: 'tenant_id' },
    shelf: { kind: 'tenant', column: 'tenant_id' },
  },
  resolveMembershipRows: () => rows,
  resolveRows: () => rows,
  resultReferences: { noteWho: () => [] },
  resolvePlatformRows: () => ({ ...rows, customer: true }),
});

async function fixture(t: TestContext, dialect: TenantDialect, readerName?: () => string | undefined) {
  const suffix = `actor_${randomUUID().replaceAll('-', '')}`;
  const tables = `
    CREATE TABLE customer (id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL, plan TEXT, country TEXT);
    CREATE TABLE shelf (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE ticket (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, opened_on DATE NOT NULL, shelf_id TEXT REFERENCES shelf(id));
    INSERT INTO shelf (id, tenant_id, name) VALUES ('s1', 'north', 'Front');
    INSERT INTO customer (id, name, plan, country) VALUES ('north', 'North', 'pro', 'US'), ('bare', 'Bare', NULL, NULL);`;
  const engine = await openTenantEngine(dialect, {
    tables: ['customer', 'ticket', 'shelf'],
    sqlite: `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;${tables}`,
    postgres: tables,
    database: suffix,
  });
  t.after(async () => {
    await engine.close().catch(() => {});
    if (dialect === 'postgres') await dropDedicatedPostgresDatabase(suffix);
  });
  await engine.provisionStore(binding);
  await engine.migrateCommandJournal();
  await engine.maintenance(binding, async (admin) => {
    for (const tenantId of ['north', 'bare']) {
      await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
      await admin.putMembership({
        tenantId,
        accountId: 'eve',
        membershipId: `${tenantId}-eve`,
        status: 'active',
        roles: ['agent'],
        validUntil: Date.now() + 3_600_000,
        expectedVersion: null,
      });
    }
  });
  const enrollment = await createTenantEnrollment<IncomingMessage>({
    app,
    pages: [],
    policy,
    source: { ...binding.source, ...(dialect === 'postgres' ? { url: engine.url } : { existingPath: engine.path }) },
    deployment: 'desk-actor-tenant-deployment',
    roles: ['agent'],
    commands: { registry },
    maxLifetimeMs: 300_000,
    verifySession: async () => ({ id: 'eve', who: 'eve@example.invalid' }),
  });
  const session: VerifiedSessionInstance = {
    identity: { id: 'eve', who: 'eve@example.invalid' },
    sessionId: 'session-eve',
    expiresAt: Date.now() + 3_600_000,
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const owner = createTenantHttpServer({
    app,
    enrollment,
    bound,
    verifySessionInstance: () => session,
    ...(readerName ? { readerName } : {}),
  });
  t.after(async () => {
    const stopped = new Promise<void>((resolve) => owner.server.close(() => resolve()));
    owner.server.closeAllConnections();
    await stopped;
    await owner.retire();
    await enrollment.retire();
  });
  owner.server.listen(0, bound.host);
  await once(owner.server, 'listening');
  const address = owner.server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const call = async (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Answer> => {
    const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> };
  };
  const leased = async (tenant: string) => {
    const opened = await call(`/api/tenant/context/open?app=${appId}&tenant=${tenant}`, {});
    assert.equal(opened.status, 200, opened.text);
    const lease = opened.body as unknown as Context;
    return {
      'x-mistri-tab': lease.tabId,
      'x-mistri-context': lease.context,
      'x-mistri-lease-revision': String(lease.revision),
      'x-mistri-account': lease.accountId,
    };
  };
  const execute = async (tenant: string, input: Record<string, unknown>) =>
    call(
      `/api/commands/execute?app=${appId}&tenant=${tenant}`,
      {
        command: 'noteWho',
        commandVersion: 1,
        key: {},
        expectedVersion: 0,
        idempotencyKey: `note-${String(input.id)}-attempt-${randomUUID()}`,
        input,
      },
      await leased(tenant),
    );
  const run = async (tenant: string, id: string) => {
    const reply = await execute(tenant, { id });
    assert.equal(reply.status, 200, reply.text);
  };
  const check = async (tenant: string, input: Record<string, unknown>) =>
    call(
      `/api/commands/check?app=${appId}&tenant=${tenant}`,
      { command: 'noteWho', commandVersion: 1, input, fields: ['reach'] },
      await leased(tenant),
    );
  return { run, execute, check };
}

for (const { dialect, skip } of TENANT_DIALECTS) {
  describe(`a tenant command's context (${dialect})`, { skip }, () => {
    test('ctx.tenant reads the shared profile columns of the tenant it runs in', async (t) => {
      seen.length = 0;
      const { run } = await fixture(t, dialect);
      await run('north', 'a');
      await run('bare', 'b');
      assert.deepEqual(seen[0].tenant, { plan: 'pro', country: 'US' });
      assert.deepEqual(seen[1].tenant, { plan: null, country: null });
    });

    test('ctx.actor.name is the session account name, and absent where the store keeps none', async (t) => {
      seen.length = 0;
      const named = await fixture(t, dialect, () => 'Eve Example');
      await named.run('north', 'c');
      assert.equal(seen[0].name, 'Eve Example');
    });

    test("a signed-in run and a step's check refuse an option the tenant's profile does not offer", async (t) => {
      seen.length = 0;
      const { execute, check } = await fixture(t, dialect);
      const offered = await execute('north', { id: 'e', reach: 'text' });
      assert.equal(offered.status, 200, offered.text);
      const withheld = await execute('bare', { id: 'f', reach: 'text' });
      assert.equal(withheld.status, 400, withheld.text);
      assert.equal(withheld.body.field, 'reach');
      assert.equal(withheld.body.error, '"text" is not one of the choices.');
      assert.equal(seen.length, 1, 'the refused run reached no handler');
      assert.equal((await execute('bare', { id: 'g', reach: 'email' })).status, 200);
      // A multistep form's step is checked on the same profile before it is left, and nothing runs.
      const stepped = await check('bare', { reach: 'text' });
      assert.equal(stepped.status, 200, stepped.text);
      assert.deepEqual(stepped.body, { problems: { reach: '"text" is not one of the choices.' } });
      assert.deepEqual((await check('north', { reach: 'text' })).body, { problems: {} });
      assert.equal(seen.length, 2, 'a check ran no handler');
    });

    test('ctx.actor has no name key when the name is unknown', async (t) => {
      seen.length = 0;
      const anon = await fixture(t, dialect);
      await anon.run('north', 'd');
      assert.equal(seen[0].hasName, false);
    });

    /* A field report: a command that set a reference to a table missing from its `read` answered 500 invalid_result,
       and what lay beneath was "This operation is not available in the current row scope". The terminal leads with
       the table, the column and the fix; the caller's sentence is unchanged, and the next run goes through. */
    test('a reference to a table the command does not read names the table, the column and the fix', async (t) => {
      const said: string[] = [];
      t.mock.method(console, 'error', (...args: unknown[]) => said.push(args.map(String).join(' ')));
      const { execute } = await fixture(t, dialect);
      const refused = await execute('north', { id: 'h', shelf: 's1' });
      assert.equal(refused.status, 500, refused.text);
      assert.equal(refused.body.code, 'invalid_result', refused.text);
      const log = said.join('\n');
      assert.match(
        log,
        /refused \(500 invalid_result\): Command "noteWho" writes ticket\.shelf_id, which references "shelf", and does not read "shelf": add "shelf" to the command's read/,
        log,
      );
      assert.doesNotMatch(log, /row scope/, log);
      assert.equal((await execute('north', { id: 'i' })).status, 200);
    });
  });
}
