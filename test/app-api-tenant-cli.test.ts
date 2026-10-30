/** A tenant App's API through the real CLI, on both engines: the depot App
 * with two tenants — alice in north, bob in south — its tokens issued by the
 * real `api-token issue --tenant --policy --commands`, served by the tenant
 * host under `--policy --api-reads` over loopback HTTP and spoken by
 * `--app-mcp --policy` over stdio. No token reads or runs the other tenant's
 * rows — not by a guessed key, a forged cursor, the document or the tool
 * listing. A new membership version, a suspended tenant and a revoked
 * membership refuse the next request and the next call, and a business
 * database that cannot answer is 503, never 403. Every spawned process is
 * killed at the end; the PostgreSQL case skips unless TABLEWALK_TEST_PG is
 * set, and drops the databases it creates. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { migratePostgresAuthStore } from '../packages/mistri/src/adapters/auth/postgresAuthStore.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { buildApp } from '../packages/mistri/src/server/build/build.js';
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
import { spawn } from 'node:child_process';
import {
  allPages,
  childEnv,
  cliArgs,
  DEPOT_ROWS,
  DEPOT_STORE,
  DEPOT_TABLE,
  freePort,
  ROOT,
  runCli,
  SESSION_SECRET,
  mcpEnv,
  serveApi,
  startAppMcp,
  tokenCli,
  writeDepotApp,
} from './appApiCli.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
interface Client extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}

/** The depot deployment on one engine, provisioned as an operator would: its
 * tenant store, journal, native accounts and token store, and a way to change
 * memberships and to make the business database stop answering. */
async function depot(t: TestContext, dialect: 'sqlite' | 'postgres', options: { tokens?: boolean; commands?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), `tw-tenant-cli-${dialect}-`));
  const cleanup: Array<() => unknown> = [() => rmSync(directory, { recursive: true, force: true })];
  t.after(async () => {
    for (const step of cleanup.reverse())
      await Promise.resolve()
        .then(step)
        .catch(() => {});
  });
  const store = { appId: 'depot', source: { id: 'business', connection: 'data' }, storeId: DEPOT_STORE };
  let business: string, authStore: string, physical: string;
  let maintenance: (run: (admin: TenantStoreAdministration) => Promise<void>) => Promise<void>;
  let accounts: (ids: string[]) => Promise<void>;
  let outage: (down: boolean) => Promise<void>;
  let version: (id: string) => Promise<number>;
  if (dialect === 'sqlite') {
    business = join(directory, 'business.db');
    authStore = join(directory, 'auth.db');
    physical = 'physical_item';
    const db = new DatabaseSync(business);
    cleanup.push(() => db.close());
    // Beside two serving processes: wait for their locks rather than fail.
    db.exec(`PRAGMA busy_timeout = 10000; ${DEPOT_TABLE(physical)}; ${DEPOT_ROWS(physical)}`);
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
    version = async (id) => Number(db.prepare(`SELECT version FROM ${physical} WHERE id = ?`).get(id)!.version);
    // An exclusive lock from another connection: every reader is busy past its timeout.
    let blocker: DatabaseSync | undefined;
    cleanup.push(() => blocker?.close());
    outage = async (down) => {
      if (down) {
        blocker = new DatabaseSync(business);
        blocker.exec('BEGIN EXCLUSIVE');
        return;
      }
      blocker?.exec('ROLLBACK');
      blocker?.close();
      blocker = undefined;
    };
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
    const names = ['auth', 'business'].map((kind) => `tw_tenant_cli_${kind}_${randomUUID().replaceAll('-', '')}`);
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
    physical = 'public.physical_item';
    const client = new pg.default.Client({ connectionString: business, statement_timeout: 10000 });
    await client.connect();
    cleanup.push(() => client.end());
    await client.query(`${DEPOT_TABLE('physical_item')}; ${DEPOT_ROWS('physical_item')}`);
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
    version = async (id) => Number((await client.query('SELECT version FROM physical_item WHERE id = $1', [id])).rows[0].version);
    // The business database refuses new connections and its backends are
    // terminated — the serving processes' — all but this maintenance client.
    const businessName = names[1],
      spared = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    cleanup.unshift(() => control.query(`ALTER DATABASE "${businessName}" ALLOW_CONNECTIONS true`));
    outage = async (down) => {
      await control.query(`ALTER DATABASE "${businessName}" ALLOW_CONNECTIONS ${down ? 'false' : 'true'}`);
      if (down)
        await control.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> $2', [
          businessName,
          spared,
        ]);
    };
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
  const written = writeDepotApp(directory, { business, authStore, physical, commands: options.commands !== false });
  writeFileSync(join(written.appDir, 'authority.lock'), (await loadApp(written.appDir, { lock: 'report' })).authority!.report);
  if (dialect === 'sqlite') {
    // The native auth store as the tenant host creates it, then the accounts.
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
  await accounts(['alice', 'bob', 'operator']);
  const common = ['--app', written.appDir, '--config', written.config, '--store-id', randomUUID()];
  if (options.tokens !== false) {
    const provisioned = await tokenCli(['provision', ...common]);
    assert.equal(provisioned.code, 0, provisioned.err);
  }
  const issue = async (subject: string, tenant: string) => {
    const issued = await tokenCli([
      'issue',
      ...common,
      '--tenant',
      tenant,
      '--policy',
      written.policy,
      '--commands',
      written.commands!,
      '--subject',
      subject,
      '--actor',
      'operator',
      '--role',
      'member',
      '--label',
      'Tenant CLI',
      '--expires-at',
      new Date(Date.now() + 600000).toISOString(),
    ]);
    assert.equal(issued.code, 0, issued.err);
    return (JSON.parse(issued.out) as { result: { token: string; tokenId: string } }).result;
  };
  return { ...written, commands: written.commands!, issue, maintenance, outage, version };
}

for (const { dialect, skip } of [
  { dialect: 'sqlite' as const, skip: false as const },
  { dialect: 'postgres' as const, skip: liveSkip('postgres', LIVE) },
]) {
  test(
    `a tenant App's API on ${dialect}, through the real CLI: two tenants, each token its own membership's rows only, over HTTP and App MCP`,
    { skip, timeout: 600000 },
    async (t) => {
      const f = await depot(t, dialect);
      const alice = await f.issue('alice', 'north'),
        bob = await f.issue('bob', 'south');
      const s = await serveApi(t, { config: f.config, appDir: f.appDir, commands: f.commands }, 'depot', ['--policy', f.policy]);
      await s.started;
      const as = (token: string) => ({ authorization: `Bearer ${token}` });
      const get = async (token: string, path: string) => {
        const response = await fetch(`${s.base}${path}`, { headers: as(token) });
        return { status: response.status, body: (await response.json()) as Record<string, unknown> };
      };
      let counter = 0;
      const touch = async (
        token: string,
        key: string,
        version: number,
        idempotencyKey = `tenant-cli-${dialect}-${String(++counter).padStart(8, '0')}`,
      ) => {
        const response = await fetch(`${s.base}/item/${key}/commands/touch/v1`, {
          method: 'POST',
          headers: { ...as(token), 'if-match': `"${version}"`, 'idempotency-key': idempotencyKey, 'content-type': 'application/json' },
          body: '{}',
        });
        return {
          status: response.status,
          replayed: response.headers.get('idempotent-replayed') === 'true',
          body: (await response.json()) as Record<string, unknown>,
        };
      };

      // Reads: one's own rows, and another tenant's guessed key is not found.
      assert.deepEqual(await get(alice.token, '/item/north-1'), { status: 200, body: { id: 'north-1', version: '0', name: 'North one' } });
      assert.equal((await get(alice.token, '/item/south-1')).status, 404);
      assert.deepEqual(
        (await allPages(s.base, as(alice.token), 'limit=1&sort=id')).map((row) => row.id),
        ['north-1', 'north-2'],
      );
      assert.deepEqual(
        (await allPages(s.base, as(bob.token), 'limit=1&sort=-id')).map((row) => row.id),
        ['south-2', 'south-1'],
      );
      // A cursor is its membership's: alice's, under bob's token, is refused.
      const page = await get(alice.token, '/item?limit=1&sort=id');
      assert.equal(typeof page.body.next, 'string');
      const forged = await fetch(`${s.base}/item?limit=1&sort=id&cursor=${encodeURIComponent(page.body.next as string)}`, {
        headers: as(bob.token),
      });
      assert.equal(forged.status, 400);
      await forged.body?.cancel();
      // The document offers the command and no recovery.
      const paths = Object.keys((await get(alice.token, '/$openapi')).body.paths as object);
      assert.ok(
        paths.includes('/item/{id}/commands/touch/v1') && !paths.some((path) => path.includes('/receipts/')),
        JSON.stringify(paths),
      );

      // Commands: applied once, replayed under its key; another tenant's key
      // is refused and its row unchanged; recovery is not a tenant token's.
      const applied = await touch(alice.token, 'north-1', 0, `tenant-cli-${dialect}-applied-1`);
      assert.equal(applied.status, 200, JSON.stringify(applied.body));
      assert.equal((await touch(alice.token, 'north-1', 0, `tenant-cli-${dialect}-applied-1`)).replayed, true);
      assert.equal(await f.version('north-1'), 1);
      const crossed = await touch(alice.token, 'south-1', 0);
      assert.equal(crossed.status, 403, JSON.stringify(crossed.body));
      assert.equal(await f.version('south-1'), 0);
      const recovery = await get(alice.token, `/commands/touch/v1/receipts/tenant-cli-${dialect}-applied-1`);
      assert.deepEqual([recovery.status, recovery.body.code, recovery.body.outcome], [422, 'invalid_input', 'unknown']);
      // A signed-in form's command names no record: it adds one in the token's own tenant.
      const stocked = await fetch(`${s.base}/item/commands/stock/v1`, {
        method: 'POST',
        headers: { ...as(alice.token), 'idempotency-key': `tenant-cli-${dialect}-stock-1`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'north-3', name: 'North three' }),
      });
      assert.equal(stocked.status, 200, await stocked.text());
      assert.equal((await get(alice.token, '/item/north-3')).status, 200);
      assert.equal((await get(bob.token, '/item/north-3')).status, 404);

      // App MCP, beside the HTTP host: the same token, the same membership.
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
        mcpEnv(alice.token),
      );
      await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
      mcp.notify('notifications/initialized');
      const tools = (await mcp.request('tools/list')).result.tools as { name: string }[];
      assert.deepEqual(tools.map((tool) => tool.name.split('_')[0]).sort(), ['get', 'list', 'prepare', 'run']);
      const tool = (prefix: string) => tools.find((value) => value.name.startsWith(prefix))!.name;
      const call = (name: string, args: object) => mcp.request('tools/call', { name, arguments: args });
      const code = (reply: { result: { content: { text: string }[] } }) => {
        const body = JSON.parse(reply.result.content[0].text) as { error?: { code: string }; code?: string };
        return body.error?.code ?? body.code;
      };
      const first = await call(tool('get_'), { id: 'north-1' });
      assert.deepEqual(first.result?.structuredContent, { id: 'north-1', version: '1', name: 'North one' }, JSON.stringify(first));
      const hidden = await call(tool('get_'), { id: 'south-1' });
      assert.equal(hidden.result.isError, true);
      const listed = await call(tool('list_'), {});
      assert.deepEqual((listed.result.structuredContent.items as { id: string }[]).map((row) => row.id).sort(), [
        'north-1',
        'north-2',
        'north-3',
      ]);
      const ran = await call(tool('run_'), {
        key: { id: 'north-2' },
        version: 0,
        idempotencyKey: `tenant-mcp-${dialect}-00000001`,
        input: {},
      });
      assert.equal(ran.result.isError, false, JSON.stringify(ran));
      assert.equal(await f.version('north-2'), 1);

      // The business database stops answering: 503 over HTTP, the same
      // temporarily_unavailable over MCP — never forbidden — and both answer
      // again once it does.
      await f.outage(true);
      try {
        const down = await get(alice.token, '/item/north-1');
        assert.deepEqual([down.status, (down.body.error as { code: string }).code], [503, 'temporarily_unavailable']);
        const unknown = await touch(bob.token, 'south-2', 0, `tenant-cli-${dialect}-outage-1`);
        assert.deepEqual([unknown.status, unknown.body.code, unknown.body.outcome], [503, 'temporarily_unavailable', 'unknown']);
        assert.equal(code(await call(tool('get_'), { id: 'north-1' })), 'temporarily_unavailable');
      } finally {
        await f.outage(false);
      }
      const recovers = async (attempt: () => Promise<boolean>) => {
        for (let tries = 0; tries < 8; tries++) {
          if (await attempt()) return;
          await new Promise((done) => setTimeout(done, 250));
        }
        assert.fail('The API did not answer again after the database did.');
      };
      await recovers(async () => (await get(alice.token, '/item/north-1')).status === 200);
      await recovers(async () => (await call(tool('get_'), { id: 'north-1' })).result.isError === false);
      // Retried under the same key, the command applies once.
      await recovers(async () => (await touch(bob.token, 'south-2', 0, `tenant-cli-${dialect}-outage-1`)).status === 200);
      assert.equal(await f.version('south-2'), 1);

      // A new membership version ends alice's tokens on the next request and call.
      await f.maintenance((admin) =>
        admin.putMembership({
          tenantId: 'north',
          accountId: 'alice',
          membershipId: 'm-alice-north',
          status: 'active',
          roles: ['member'],
          validUntil: Date.now() + 3600000,
          expectedVersion: '1',
        }),
      );
      assert.equal((await get(alice.token, '/item/north-1')).status, 403);
      const refused = await touch(alice.token, 'north-1', 1);
      assert.deepEqual([refused.status, refused.body.code, refused.body.outcome], [403, 'forbidden', 'not_applied']);
      assert.equal(code(await call(tool('get_'), { id: 'north-1' })), 'forbidden');
      // A suspended tenant, then a revoked membership: refused, nothing changed.
      await f.maintenance((admin) => admin.putTenant({ tenantId: 'south', status: 'suspended', expectedVersion: '1' }));
      assert.equal((await get(bob.token, '/item/south-1')).status, 403);
      await f.maintenance((admin) => admin.putTenant({ tenantId: 'south', status: 'active', expectedVersion: '2' }));
      assert.equal((await get(bob.token, '/item/south-1')).status, 200);
      await f.maintenance((admin) =>
        admin.putMembership({
          tenantId: 'south',
          accountId: 'bob',
          membershipId: 'm-bob-south',
          status: 'revoked',
          roles: ['member'],
          validUntil: Date.now() + 3600000,
          expectedVersion: '1',
        }),
      );
      assert.equal((await get(bob.token, '/item/south-1')).status, 403);
      const revoked = await touch(bob.token, 'south-1', 0);
      assert.deepEqual([revoked.status, revoked.body.outcome], [403, 'not_applied']);
      assert.equal(await f.version('south-1'), 0);

      mcp.end();
      assert.equal(await mcp.closed, 0);
      s.child.kill('SIGTERM');
      assert.equal(await s.closed, 0);
      // stdout is the protocol alone, and no token is in any stream.
      for (const line of mcp.lines) assert.equal(JSON.parse(line).jsonrpc, '2.0');
      for (const token of [alice.token, bob.token]) {
        assert.equal([s.output(), ...mcp.lines, mcp.stderr()].join('\n').includes(token), false);
      }
    },
  );
}

/* --dev on a tenant App was once silently ignored, and the App kept /{app}
   while every other single App moved to the root (KS-OBSERVE #2, #3). */
test(
  "a tenant App under --dev and --base-path: the observer answers, the App is at the base's root, and mistri observe finds it",
  { timeout: 300000 },
  async (t) => {
    const f = await depot(t, 'sqlite');
    const xdg = mkdtempSync(join(tmpdir(), 'tw-tenant-dev-xdg-'));
    t.after(() => rmSync(xdg, { recursive: true, force: true }));
    const port = await freePort(),
      origin = `http://127.0.0.1:${port}`;
    const child = spawn(
      process.execPath,
      cliArgs([
        '--config',
        f.config,
        '--app',
        f.appDir,
        '--policy',
        f.policy,
        '--commands',
        f.commands,
        '--dev',
        '--base-path',
        '/tools',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
      ]),
      { cwd: ROOT, env: childEnv({ XDG_CONFIG_HOME: xdg }), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    const closed = new Promise<void>((done) => child.once('close', () => done()));
    t.after(async () => {
      if (child.exitCode === null) child.kill('SIGTERM');
      await closed;
    });
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`not listening: ${output}`)), 120000);
      const read = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('dev observer at')) {
          clearTimeout(timer);
          done();
        }
      };
      child.stdout.on('data', read);
      child.stderr.on('data', read);
      child.once('close', () => {
        clearTimeout(timer);
        fail(new Error(`closed: ${output}`));
      });
    });
    assert.match(output, /dev observer at http:\/\/localhost:\d+\/tools\/_mistri\/observe\//);
    const status = await fetch(`${origin}/tools/_mistri/observe/api/status`);
    assert.equal(status.status, 200);
    assert.deepEqual(
      ((await status.json()) as { apps: Array<{ id: string }> }).apps.map((app) => app.id),
      ['depot'],
    );
    // One App: at the root of the base, its page carrying its mount, its name and the observer's address.
    const home = await fetch(`${origin}/tools/`, { redirect: 'manual' });
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(
      html,
      /<meta name="mistri-mount" content="\{&quot;base&quot;:&quot;\/tools&quot;,&quot;apps&quot;:\{&quot;depot&quot;:&quot;&quot;\}\}">/,
    );
    assert.match(html, /<meta name="mistri-observe" content="\/tools\/_mistri\/observe\/">/);
    assert.match(html, /<title>[^<]+<\/title>/);
    assert.doesNotMatch(html, /<title>tablewalk<\/title>/);
    assert.equal((await fetch(`${origin}/tools/item`)).status, 200, 'a view is read at the root, not as an App id');
    assert.equal((await fetch(`${origin}/`)).status, 404, 'outside the base names nothing');
    const whoami = await fetch(`${origin}/tools/api/whoami?app=depot`);
    assert.equal(whoami.status, 200, await whoami.clone().text());
    // The request was traced, and is listed under the App it served.
    const traces = (await (await fetch(`${origin}/tools/_mistri/observe/api/traces?app=depot`)).json()) as {
      traces: Array<{ path?: string }>;
    };
    assert.ok(
      traces.traces.some((trace) => trace.path === '/api/whoami?app=depot'),
      JSON.stringify(traces),
    );
    // `mistri observe` finds it from the file a --dev start writes.
    const found = await runCli(['observe'], childEnv({ XDG_CONFIG_HOME: xdg }));
    assert.equal(found.code, 0, found.err);
    assert.equal(found.out.trim(), `http://localhost:${port}/tools/_mistri/observe/`);
  },
);

/* --dev is mistri's and --mcp the database browser's, so neither binary serves the pair: mistri names the command
   that runs --mcp, rather than ignoring --dev. */
test('--dev beside --mcp is refused with a sentence, not ignored', async () => {
  const refused = await runCli(['--mcp', '--dev', ':memory:']);
  assert.equal(refused.code, 2, refused.err);
  assert.match(refused.err, /--mcp is the database browser's, a command of its own: npx tablewalk/);
});

/* The startup once said only "The API item read is unavailable." for every
   cause; the operator now reads which. */
test("a tenant App's API with no token store says to provision one, and does not start", { timeout: 300000 }, async (t) => {
  const f = await depot(t, 'sqlite', { tokens: false });
  const s = await serveApi(t, { config: f.config, appDir: f.appDir, commands: f.commands }, 'depot', ['--policy', f.policy]);
  await assert.rejects(s.started, /CLI closed before listening/);
  assert.match(
    s.output(),
    /(?:Cause|because): This App's API token store could not be read: it is not provisioned, or not reachable\. Provision it first: mistri api-token provision/,
  );
});

/* A deploy verifies a roll by the build id /readyz reports (build/fingerprint.ts), and the first deployment that
   needs it is a tenant App: its host answers the probe, so it has to be told the build it serves from. */
test("a tenant App served from a build reports that build's id on /readyz", { timeout: 300000 }, async (t) => {
  const f = await depot(t, 'sqlite', { commands: false });
  const here = process.cwd();
  const out = join(dirname(f.appDir), 'depot-build');
  const built = await buildApp({ app: f.appDir, out, policy: f.policy }, { typecheck: false });
  assert.match(built.manifest.id, /^[0-9a-f]{16}$/);
  assert.equal(process.cwd(), here);
  const s = await serveApi(t, { config: f.config, appDir: out }, 'depot', ['--policy', join(out, 'server', 'policy.mjs')]);
  await s.started;
  const probe = await fetch(`${new URL(s.base).origin}/readyz`);
  assert.equal(probe.status, 200);
  assert.deepEqual(await probe.json(), { status: 'ok', deploy: null, build: built.manifest.id });
});
