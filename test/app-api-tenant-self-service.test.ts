/** G54: a tenant App's API served the way a service desk is deployed — its data
 * on PostgreSQL named by `${…}` in the config, its sign-ins in the default
 * local SQLite store — with tokens its own members make on their tenant's
 * lease, and MCP over HTTP beside the routes.
 *
 * Three people sign up through the real host: alice (north, member), carol
 * (north, member and lead) and bob (south, member and lead). What is proved:
 * a token is never wider than the member who made it; it reads and runs only
 * its own tenant's rows, by a guessed key, a list, the document and MCP; a
 * lead, who administers their tenant's members, may see and revoke a member's
 * token in their own tenant, never the other way and never across tenants; a revoked token is refused on the next
 * request. Live and opt-in: TABLEWALK_TEST_PG names a server, and this file
 * makes and drops its own database there. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { migratePostgresTenantAdministrationJournal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournalPostgres.js';
import {
  createPostgresTenantAdministration,
  migratePostgresTenantStore,
} from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import type { TenantStoreAdministration } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { DEPOT_ROWS, DEPOT_STORE, DEPOT_TABLE, ROOT, SESSION_SECRET, serveApi, tokenCli } from './appApiCli.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
interface Client extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}

test(
  'G54: a tenant App on PostgreSQL with local sign-ins serves its API and MCP to tokens its members make, each no wider than its maker',
  { skip: liveSkip('postgres', LIVE), timeout: 600000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'tw-tenant-self-service-'));
    const cleanup: Array<() => unknown> = [() => rmSync(directory, { recursive: true, force: true })];
    t.after(async () => {
      for (const step of cleanup.reverse())
        await Promise.resolve()
          .then(step)
          .catch(() => {});
    });
    const pg = (await import('pg' as string)) as { default: { Client: new (options: unknown) => Client } };
    const control = new pg.default.Client({ connectionString: LIVE, statement_timeout: 10000 });
    await control.connect();
    const name = `tw_self_service_${randomUUID().replaceAll('-', '')}`;
    await control.query(`CREATE DATABASE "${name}"`);
    cleanup.push(async () => {
      await control.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await control.end();
    });
    const url = new URL(LIVE!);
    url.pathname = `/${name}`;
    const business = url.href;
    const client = new pg.default.Client({ connectionString: business, statement_timeout: 10000 });
    await client.connect();
    cleanup.push(() => client.end());
    await client.query(`${DEPOT_TABLE('physical_item')}; ${DEPOT_ROWS('physical_item')}`);
    const store = { appId: 'depot', source: { id: 'business', connection: 'data' }, storeId: DEPOT_STORE };
    await migratePostgresCommandJournal(business);
    await migratePostgresTenantStore(business, store);
    // The policy below names an administration (a lead revokes a member), so its journal is provisioned too.
    await migratePostgresTenantAdministrationJournal(business, store);
    const administer = async (run: (admin: TenantStoreAdministration) => Promise<void>) => {
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
    await administer(async (admin) => {
      for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    });
    const version = async (id: string) =>
      Number((await client.query('SELECT version FROM physical_item WHERE id = $1', [id])).rows[0].version);

    // The App: members read, leads also touch; the API offers both roles.
    const appDir = join(directory, 'depot');
    mkdirSync(appDir);
    const authStore = join(directory, 'auth.db');
    writeFileSync(
      join(appDir, 'app.json'),
      JSON.stringify({
        id: 'depot',
        name: 'Depot',
        auth: {
          providers: ['email'],
          signUp: 'open',
          store: authStore,
          rows: 'tenant',
          roles: { member: { read: true }, lead: { read: true, commands: ['touch'] } },
        },
        sources: { business: { connection: 'data' } },
        resources: { item: { physical: 'public.physical_item', owner: 'tenant', access: 'write' } },
        views: { items: { kind: 'list', from: 'item' } },
        home: 'items',
        api: {
          version: 1,
          roles: ['member', 'lead'],
          resources: { item: { fields: ['id', 'version', 'name'], sorts: ['id'] } },
          commands: ['touch'],
        },
      }),
    );
    // The data named by reference, as a deployment names it: G54's third blocker.
    process.env.TW_SELF_SERVICE_URL = business;
    cleanup.push(() => delete process.env.TW_SELF_SERVICE_URL);
    const config = join(directory, 'depot.json');
    writeFileSync(config, JSON.stringify({ connections: [{ id: 'data', name: 'data', url: '${TW_SELF_SERVICE_URL}', writable: true }] }));
    const source = (path: string) => pathToFileURL(join(ROOT, path)).href;
    const policy = join(directory, 'policy.mjs'),
      commands = join(appDir, 'commands.mjs');
    writeFileSync(
      policy,
      `import { defineAppTenantPolicy } from '${source('packages/mistri/src/server/policy/appTenantPolicy.ts')}';
export default defineAppTenantPolicy({ kind: 'tenant', appId: 'depot', storeId: '${DEPOT_STORE}',
  ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
  resolveMembershipRows: () => ({ item: true }), resolveRows: () => ({ item: true }),
  // A lead administers their tenant's members, and so their API tokens.
  administration: { id: 'depot-admin', version: 'v1', maxMembershipLifetimeMs: 86400000, operators: [],
    delegates: [{ role: 'lead', operations: ['revokeMembership'], roles: ['member'] }] },
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
    writeFileSync(join(appDir, 'authority.lock'), (await loadApp(appDir, { lock: 'report' })).authority!.report);
    // The local sign-in store as the host makes it, and its token store, provisioned by the operator once.
    const saved = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = SESSION_SECRET;
    try {
      (await createAppAuth(await loadApp(appDir), { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'] })).close();
    } finally {
      if (saved === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = saved;
    }
    const provisioned = await tokenCli(['provision', '--app', appDir, '--config', config, '--store-id', randomUUID()]);
    assert.equal(provisioned.code, 0, provisioned.err);

    // Mixed engines and a referenced URL start: G54's first and third blockers.
    const s = await serveApi(t, { config, appDir, commands }, 'depot', ['--policy', policy]);
    await s.started;
    const origin = s.base.slice(0, s.base.indexOf('/api/apps/'));
    type Reply = { status: number; body: Record<string, unknown>; headers: Headers };
    const call = async (path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> => {
      const response = await fetch(origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'manual',
      });
      const text = await response.text();
      return { status: response.status, headers: response.headers, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
    };
    const password = 'Disposable-local-password-123!';
    type Person = { id: string; cookie: string };
    const signUp = async (who: string): Promise<Person> => {
      const answer = await call('/api/auth/sign-up/email', { name: who, email: `${who}@example.test`, password });
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      const cookie = answer.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      return { id: String((answer.body.user as { id: string }).id), cookie };
    };
    const alice = await signUp('alice'),
      carol = await signUp('carol'),
      bob = await signUp('bob');
    await administer(async (admin) => {
      for (const [person, tenantId, roles] of [
        [alice, 'north', ['member']],
        [carol, 'north', ['member', 'lead']],
        [bob, 'south', ['member', 'lead']],
      ] as const)
        await admin.putMembership({
          tenantId,
          accountId: person.id,
          membershipId: `m-${person.id}`,
          status: 'active',
          roles: [...roles],
          validUntil: Date.now() + 3600000,
          expectedVersion: null,
        });
    });
    // A member's own lease, then their token routes on it.
    const lease = async (person: Person, tenant: string) => {
      const signed = { cookie: person.cookie, 'x-mistri-account': person.id };
      const opened = await call(`/api/tenant/context/open?app=depot&tenant=${tenant}`, {}, signed);
      assert.equal(opened.status, 200, JSON.stringify(opened.body));
      const headers = {
        ...signed,
        'x-mistri-tab': String(opened.body.tabId),
        'x-mistri-context': String(opened.body.context),
        'x-mistri-lease-revision': String(opened.body.revision),
      };
      return (path: string, body: unknown = {}) => call(`${path}?app=depot&tenant=${tenant}`, body, headers);
    };
    const asAlice = await lease(alice, 'north'),
      asCarol = await lease(carol, 'north'),
      asBob = await lease(bob, 'south');

    // Role narrowing: alice is offered member alone, and asking for lead is refused.
    const offered = await asAlice('/api/tokens');
    assert.equal(offered.status, 200, JSON.stringify(offered.body));
    assert.deepEqual((offered.body.choices as { roles: string[] }).roles, ['member']);
    const wider = await asAlice('/api/tokens/issue', { label: 'Wider', roles: ['lead'] });
    assert.deepEqual([wider.status, wider.body.code], [403, 'role_not_held']);
    const issue = async (as: typeof asAlice, body: Record<string, unknown>) => {
      const answer = await as('/api/tokens/issue', body);
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      return answer.body as { token: string; id: string };
    };
    const aliceToken = await issue(asAlice, { label: 'Alice reads', days: 7 });
    const carolToken = await issue(asCarol, { label: 'Carol runs', roles: ['lead'] });
    const bobToken = await issue(asBob, { label: 'Bob runs' });

    const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
    const get = async (token: string, path: string) => {
      const response = await fetch(`${s.base}${path}`, { headers: bearer(token) });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    let counter = 0;
    const touch = async (token: string, key: string, at: number) => {
      const response = await fetch(`${s.base}/item/${key}/commands/touch/v1`, {
        method: 'POST',
        headers: {
          ...bearer(token),
          'if-match': `"${at}"`,
          'idempotency-key': `self-service-${String(++counter).padStart(8, '0')}`,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    // Isolation: each token reads its own tenant's rows; a guessed key from the other is not found.
    assert.deepEqual(await get(aliceToken.token, '/item/north-1'), {
      status: 200,
      body: { id: 'north-1', version: '0', name: 'North one' },
    });
    assert.equal((await get(aliceToken.token, '/item/south-1')).status, 404);
    assert.equal((await get(bobToken.token, '/item/north-2')).status, 404);
    assert.deepEqual(
      ((await get(bobToken.token, '/item?sort=id')).body.items as { id: string }[]).map((row) => row.id),
      ['south-1', 'south-2'],
    );
    // Writes: a member's token runs nothing; a lead's runs on its tenant's row and never on the other's.
    assert.equal((await touch(aliceToken.token, 'north-1', 0)).status, 403);
    assert.equal((await touch(carolToken.token, 'north-1', 0)).status, 200);
    assert.equal((await touch(carolToken.token, 'south-1', 0)).status, 403);
    assert.equal((await touch(bobToken.token, 'north-2', 0)).status, 403);
    assert.deepEqual([await version('north-1'), await version('south-1'), await version('north-2')], [1, 0, 0]);
    // The document per App, narrowed to the token: the member's offers no command.
    const paths = async (token: string) => Object.keys((await get(token, '/$openapi')).body.paths as object);
    assert.equal(
      (await paths(aliceToken.token)).some((path) => path.includes('/commands/')),
      false,
    );
    assert.ok((await paths(carolToken.token)).includes('/item/{id}/commands/touch/v1'));

    // MCP over HTTP, with the same token.
    const mcp = async (token: string | undefined, message: Record<string, unknown>) => {
      const response = await fetch(`${s.base}/$mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? bearer(token) : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', ...message }),
      });
      const text = await response.text();
      return { status: response.status, body: text ? (JSON.parse(text) as Record<string, any>) : undefined };
    };
    assert.equal((await mcp(undefined, { id: 1, method: 'tools/list' })).status, 401);
    const hello = await mcp(aliceToken.token, {
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    });
    assert.equal(hello.body?.result.serverInfo.name, 'mistri-app');
    assert.equal((await mcp(aliceToken.token, { method: 'notifications/initialized' })).status, 202);
    const listed = (await mcp(aliceToken.token, { id: 2, method: 'tools/list' })).body?.result.tools as { name: string }[];
    assert.deepEqual(listed.map((tool) => tool.name.split('_')[0]).sort(), ['get', 'list'], 'a member is offered no command tool');
    const getTool = listed.find((tool) => tool.name.startsWith('get_'))!.name;
    const own = await mcp(aliceToken.token, { id: 3, method: 'tools/call', params: { name: getTool, arguments: { id: 'north-2' } } });
    assert.deepEqual(own.body?.result.structuredContent, { id: 'north-2', version: '0', name: 'North two' });
    const other = await mcp(aliceToken.token, { id: 4, method: 'tools/call', params: { name: getTool, arguments: { id: 'south-2' } } });
    assert.equal(other.body?.result.isError, true);
    const leadTools = (await mcp(carolToken.token, { id: 5, method: 'tools/list' })).body?.result.tools as { name: string }[];
    const run = leadTools.find((tool) => tool.name.startsWith('run_'))!.name;
    const ran = await mcp(carolToken.token, {
      id: 6,
      method: 'tools/call',
      params: { name: run, arguments: { key: { id: 'north-2' }, version: 0, idempotencyKey: 'self-service-mcp-0001', input: {} } },
    });
    assert.equal(ran.body?.result.isError, false, JSON.stringify(ran.body));
    assert.equal(await version('north-2'), 1);

    // Who sees what: alice her own; carol (a lead) alice's and her own; bob none of north's.
    const ids = async (as: typeof asAlice) => ((await as('/api/tokens')).body.tokens as { id: string }[]).map((token) => token.id).sort();
    assert.deepEqual(await ids(asAlice), [aliceToken.id]);
    assert.deepEqual(await ids(asCarol), [aliceToken.id, carolToken.id].sort());
    assert.deepEqual(await ids(asBob), [bobToken.id]);
    // A member cannot end a lead's token, nor a lead another tenant's: both are no token at all.
    assert.equal((await asAlice('/api/tokens/revoke', { id: carolToken.id })).status, 404);
    assert.equal((await asBob('/api/tokens/revoke', { id: aliceToken.id })).status, 404);
    assert.equal((await get(aliceToken.token, '/item/north-1')).status, 200);
    // Revocation: carol ends alice's token, and its next request and call are refused.
    assert.equal((await asCarol('/api/tokens/revoke', { id: aliceToken.id })).status, 200);
    assert.equal((await get(aliceToken.token, '/item/north-1')).status, 401);
    assert.notEqual((await mcp(aliceToken.token, { id: 7, method: 'tools/list' })).body?.error, undefined);
    assert.equal((await get(carolToken.token, '/item/north-1')).status, 200);

    s.child.kill('SIGTERM');
    assert.equal(await s.closed, 0);
    for (const token of [aliceToken.token, carolToken.token, bobToken.token]) assert.equal(s.output().includes(token), false);
  },
);
