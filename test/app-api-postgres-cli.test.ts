/** The App API through the real CLI on PostgreSQL: UUID-owned business and
 * native auth databases on the live server, the token store provisioned and
 * tokens issued and revoked with the real `api-token` CLI, served over
 * loopback HTTP (`--api-reads`) and over stdio (`--app-mcp`). Skipped unless
 * TABLEWALK_TEST_PG is set; each case drops the databases it creates and
 * kills the processes it starts. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { migratePostgresAuthStore } from '../packages/mistri/src/adapters/auth/postgresAuthStore.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import {
  LEDGER_ROW,
  LEDGER_TABLE,
  RANKS,
  allPages,
  byBytes,
  byRank,
  mcpEnv,
  runCli,
  serveApi,
  startAppMcp,
  tokenCli,
  writeLedgerApp,
} from './appApiCli.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
interface Client extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}

/** The ledger App on PostgreSQL: its own business and auth databases, one
 * eligible native account, the token store provisioned through the CLI. */
async function pgLedger(t: TestContext, extra: { rank?: boolean } = {}) {
  const module = 'pg';
  const pg = (await import(module)) as { default: { Client: new (options: unknown) => Client } };
  const control = new pg.default.Client({ connectionString: LIVE, statement_timeout: 10000 });
  await control.connect();
  const names = ['auth', 'business'].map((kind) => `tw_app_api_${kind}_${randomUUID().replaceAll('-', '')}`);
  const owned: string[] = [];
  const directory = mkdtempSync(join(tmpdir(), 'tw-app-api-pg-'));
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
  await business.query(`${LEDGER_TABLE}; ${LEDGER_ROW}${extra.rank ? '; ALTER TABLE item ADD COLUMN rank INTEGER' : ''}`);
  await migratePostgresCommandJournal(businessUrl);
  await migratePostgresAuthStore(authUrl);
  const accounts = new pg.default.Client({ connectionString: authUrl, statement_timeout: 10000 });
  await accounts.connect();
  try {
    await accounts.query(`INSERT INTO mistri.auth_user(id,name,email,"emailVerified","createdAt","updatedAt",role,banned)
      VALUES('operator','Operator','operator@example.test',true,now(),now(),'operator',false)`);
  } finally {
    await accounts.end();
  }
  const { appDir, config, commands } = writeLedgerApp(directory, {
    business: businessUrl,
    authStore: authUrl,
    physical: 'public.item',
    ...extra,
  });
  writeFileSync(join(appDir, 'authority.lock'), (await loadApp(appDir)).authority!.report);
  const common = ['--app', appDir, '--config', config, '--store-id', randomUUID()];
  const provisioned = await tokenCli(['provision', ...common]);
  assert.equal(provisioned.code, 0, provisioned.err);
  const connection = business;
  return {
    appDir,
    config,
    commands,
    issue: async (extra: readonly string[] = []) => {
      const issued = await tokenCli([
        'issue',
        ...common,
        '--commands',
        commands,
        '--subject',
        'operator',
        '--actor',
        'operator',
        '--role',
        'operator',
        '--label',
        'PG CLI',
        '--expires-at',
        new Date(Date.now() + 600000).toISOString(),
        ...extra,
      ]);
      assert.equal(issued.code, 0, issued.err);
      return (JSON.parse(issued.out) as { result: { token: string; tokenId: string } }).result;
    },
    revoke: async (tokenId: string) => {
      const revoked = await tokenCli(['revoke', ...common, '--token-id', tokenId, '--expected-version', '1', '--actor', 'operator']);
      assert.equal(revoked.code, 0, revoked.err);
    },
    version: async () => (await connection.query('SELECT version FROM item WHERE id = 1')).rows[0].version,
    /** The auth database alone stops answering: new connections refused and its
     * backends ended, while the business database keeps serving. */
    authOutage: async (down: boolean) => {
      await control.query(`ALTER DATABASE "${names[0]}" ALLOW_CONNECTIONS ${down ? 'false' : 'true'}`);
      if (down) await control.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [names[0]]);
    },
    sql: (text: string, params: unknown[] = []) => connection.query(text, params),
  };
}

test(
  '--api-reads on PostgreSQL answers 503 temporarily_unavailable while the token store is unreachable, and 401 once it is readable again',
  { skip: liveSkip('postgres', LIVE), timeout: 300000 },
  async (t) => {
    const f = await pgLedger(t);
    const token = await f.issue();
    const s = await serveApi(t, f);
    await s.started;
    const bearer = { authorization: `Bearer ${token.token}` };
    assert.equal((await fetch(`${s.base}/item/1`, { headers: bearer })).status, 200);
    // The App's own sign-in database is unreachable: authority was never
    // decided, so neither transport may call the token bad.
    await f.authOutage(true);
    try {
      const down = await fetch(`${s.base}/item/1`, { headers: bearer });
      assert.equal(down.status, 503);
      assert.deepEqual(await down.json(), {
        error: { code: 'temporarily_unavailable', message: 'The API request could not be completed.' },
      });
      const command = await fetch(`${s.base}/item/1/commands/change/v1`, {
        method: 'POST',
        headers: { ...bearer, 'if-match': '"0"', 'idempotency-key': 'pg-store-outage-0001' },
        body: '{}',
      });
      assert.equal(command.status, 503);
      const problem = await command.json();
      assert.deepEqual([problem.code, problem.outcome], ['temporarily_unavailable', 'unknown']);
      assert.equal(await f.version(), 0, 'no command ran while the token store could not be read');
    } finally {
      await f.authOutage(false);
    }
    const recovers = async () => {
      for (let tries = 0; tries < 20; tries++) {
        const again = await fetch(`${s.base}/item/1`, { headers: bearer });
        const ok = again.status === 200;
        await again.body?.cancel();
        if (ok) return;
        await new Promise((done) => setTimeout(done, 250));
      }
      assert.fail('the API did not answer again after the token store did');
    };
    await recovers();
    // A token the store can read and has revoked is the token's own fault again.
    await f.revoke(token.tokenId);
    const revoked = await fetch(`${s.base}/item/1`, { headers: bearer });
    assert.equal(revoked.status, 401);
    await revoked.body?.cancel();
    s.child.kill('SIGTERM');
    assert.equal(await s.closed, 0);
  },
);

test(
  '--api-reads on PostgreSQL pages a text sort by bytes, whatever the column collation says',
  { skip: liveSkip('postgres', LIVE), timeout: 300000 },
  async (t) => {
    const f = await pgLedger(t);
    const names = ['One', 'b', 'B', 'a', 'Z', 'Ab', 'ab', 'b '];
    for (const [index, name] of names.slice(1).entries()) await f.sql('INSERT INTO item VALUES($1,0,$2,NULL)', [index + 2, name]);
    // Where the server has ICU, the column compares case-insensitively and
    // calls 'b' and 'B' equal: an API order or boundary that fell back to the
    // column's collation would repeat or skip rows here. Without ICU, the
    // database's own locale still differs from byte order for mixed case.
    const icu = (await f.sql(`SELECT 1 FROM pg_collation WHERE collprovider = 'i' LIMIT 1`)).rows.length > 0;
    if (icu) {
      await f.sql(`CREATE COLLATION tw_case_insensitive (provider = icu, locale = 'und-u-ks-level2', deterministic = false)`);
      await f.sql('ALTER TABLE item ALTER COLUMN name TYPE text COLLATE tw_case_insensitive');
    }
    const token = await f.issue();
    const s = await serveApi(t, f);
    await s.started;
    const bearer = { authorization: `Bearer ${token.token}` };
    const served = async (query: string) => (await allPages(s.base, bearer, query)).map((row) => row.name);
    const ascending = [...names].sort(byBytes);
    assert.deepEqual(await served('limit=2&sort=name'), ascending);
    assert.deepEqual(await served('limit=3&sort=-name'), [...ascending].reverse());
    s.child.kill('SIGTERM');
    assert.equal(await s.closed, 0);
  },
);

test(
  '--api-reads on PostgreSQL pages a nullable sort with its nulls last, both ways, each row once',
  { skip: liveSkip('postgres', LIVE), timeout: 300000 },
  async (t) => {
    const f = await pgLedger(t, { rank: true });
    await f.sql('UPDATE item SET rank = $1 WHERE id = 1', [RANKS[0]]);
    for (const [index, rank] of RANKS.slice(1).entries())
      await f.sql('INSERT INTO item VALUES($1,0,$2,NULL,$3)', [index + 2, `n${index + 2}`, rank]);
    const token = await f.issue();
    const s = await serveApi(t, f);
    await s.started;
    const bearer = { authorization: `Bearer ${token.token}` };
    const rows = RANKS.map((rank, index) => ({ id: index + 1, rank }));
    const served = async (query: string) => (await allPages(s.base, bearer, query)).map((row) => Number(row.id));
    // PostgreSQL alone would put nulls first under DESC: the order says otherwise on every dialect.
    for (const limit of [1, 2, 4]) {
      assert.deepEqual(
        await served(`limit=${limit}&sort=rank`),
        [...rows].sort(byRank(false)).map((row) => row.id),
      );
      assert.deepEqual(
        await served(`limit=${limit}&sort=-rank`),
        [...rows].sort(byRank(true)).map((row) => row.id),
      );
    }
    s.child.kill('SIGTERM');
    assert.equal(await s.closed, 0);
  },
);

test(
  '--api-reads on PostgreSQL serves reads and commands, the composed $openapi, and revocation',
  { skip: liveSkip('postgres', LIVE), timeout: 300000 },
  async (t) => {
    const f = await pgLedger(t);
    const token = await f.issue(),
      reader = await f.issue(['--operation', 'item:item', '--operation', 'list:item']);
    const s = await serveApi(t, f);
    await s.started;
    const bearer = { authorization: `Bearer ${token.token}` };
    const item = await fetch(`${s.base}/item/1`, { headers: bearer });
    assert.equal(item.status, 200);
    assert.deepEqual(await item.json(), { id: '1', version: '0', name: 'One' });
    const list = await fetch(`${s.base}/item?limit=1&sort=id`, { headers: bearer });
    assert.equal(list.status, 200);
    assert.equal((await list.json()).items.length, 1);
    const key = 'pg-http-attempt-000001';
    const run = () =>
      fetch(`${s.base}/item/1/commands/change/v1`, {
        method: 'POST',
        headers: { ...bearer, 'if-match': '"0"', 'idempotency-key': key },
        body: '{}',
      });
    const applied = await run(),
      receipt = await applied.json();
    assert.equal(applied.status, 200, JSON.stringify(receipt));
    const replay = await run();
    assert.equal(replay.headers.get('idempotent-replayed'), 'true');
    assert.equal((await replay.json()).receipt.id, receipt.receipt.id);
    const recovered = await fetch(`${s.base}/commands/change/v1/receipts/${key}`, { headers: bearer });
    assert.deepEqual(await recovered.json(), {
      receipt: { id: receipt.receipt.id, status: 'applied', recovered: true },
      targets: [{ id: '1' }],
      result: { ok: true },
    });
    assert.equal(await f.version(), 1);
    const stale = await fetch(`${s.base}/item/1/commands/change/v1`, {
      method: 'POST',
      headers: { ...bearer, 'if-match': '"0"', 'idempotency-key': 'pg-http-attempt-000002' },
      body: '{}',
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).outcome, 'not_applied');
    const paths = Object.keys((await (await fetch(`${s.base}/$openapi`, { headers: bearer })).json()).paths);
    assert.ok(paths.includes('/item/{id}') && paths.includes('/item/{id}/commands/change/v1'), JSON.stringify(paths));
    const narrowed = Object.keys(
      (await (await fetch(`${s.base}/$openapi`, { headers: { authorization: `Bearer ${reader.token}` } })).json()).paths,
    );
    assert.ok(narrowed.length && narrowed.every((path) => !path.includes('/commands/')), JSON.stringify(narrowed));
    const forbidden = await fetch(`${s.base}/item/1/commands/change/v1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${reader.token}`, 'if-match': '"1"', 'idempotency-key': 'pg-http-attempt-000003' },
      body: '{}',
    });
    assert.equal(forbidden.status, 403);
    await forbidden.body?.cancel();
    const anonymous = await fetch(`${s.base}/item/1`);
    assert.equal(anonymous.status, 401);
    await anonymous.body?.cancel();
    await f.revoke(token.tokenId);
    assert.equal((await fetch(`${s.base}/item/1`, { headers: bearer })).status, 401);
    const revoked = await fetch(`${s.base}/item/1/commands/change/v1`, {
      method: 'POST',
      headers: { ...bearer, 'if-match': '"1"', 'idempotency-key': 'pg-http-attempt-000004' },
      body: '{}',
    });
    assert.equal(revoked.status, 401);
    await revoked.body?.cancel();
    assert.equal(await f.version(), 1);
    s.child.kill('SIGTERM');
    assert.equal(await s.closed, 0);
    assert.equal(s.output().includes(token.token), false);
  },
);

test(
  '--app-mcp over PostgreSQL: a CLI-issued token lists, reads, runs, replays and recovers; a revoked one never starts',
  { skip: liveSkip('postgres', LIVE), timeout: 300000 },
  async (t) => {
    const f = await pgLedger(t);
    const token = (await f.issue()).token;
    const args = ['--app-mcp', '--api-integers', 'decimal-string', '--config', f.config, '--app', f.appDir, '--commands', f.commands];
    const mcp = startAppMcp(t, args, mcpEnv(token));
    const init = await mcp.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    assert.equal(init.result.serverInfo.name, 'mistri-app');
    mcp.notify('notifications/initialized');
    const tools = (await mcp.request('tools/list')).result.tools as { name: string }[];
    const named = (prefix: string) =>
      tools.find((tool) => tool.name.startsWith(prefix))?.name ?? assert.fail(`${prefix} is not listed: ${JSON.stringify(tools)}`);
    const read = await mcp.request('tools/call', { name: named('get_'), arguments: { id: '1' } });
    assert.deepEqual(read.result.structuredContent, { id: '1', version: '0', name: 'One' });
    const call = {
      name: named('run_change_'),
      arguments: { key: { id: '1' }, version: 0, idempotencyKey: 'pg-mcp-cli-attempt-01', input: {} },
    };
    const applied = await mcp.request('tools/call', call);
    assert.equal(applied.result.isError, false, JSON.stringify(applied));
    const replayed = await mcp.request('tools/call', call);
    assert.equal(replayed.result.structuredContent.receipt.replayed, true);
    const recovered = await mcp.request('tools/call', {
      name: named('recover_change_'),
      arguments: { idempotencyKey: 'pg-mcp-cli-attempt-01' },
    });
    assert.deepEqual(recovered.result.structuredContent.receipt, {
      id: applied.result.structuredContent.receipt.id,
      status: 'applied',
      recovered: true,
    });
    assert.deepEqual(recovered.result.structuredContent.targets, [{ id: '1' }]);
    const listed = await mcp.request('tools/call', { name: named('list_'), arguments: {} });
    assert.equal(listed.result.structuredContent.items[0].version, '1');
    assert.equal(await f.version(), 1);
    mcp.end();
    assert.equal(await mcp.closed, 0);
    for (const line of mcp.lines) assert.equal(JSON.parse(line).jsonrpc, '2.0');
    assert.equal([...mcp.lines, mcp.stderr()].join('\n').includes(token), false);
    // Checked once at startup: a revoked token stops the process before any tool.
    const revoked = await f.issue();
    await f.revoke(revoked.tokenId);
    const refused = await runCli(args, mcpEnv(revoked.token));
    assert.equal(refused.code, 1, refused.err);
    assert.equal(refused.out, '');
    assert.match(refused.err, /not a current API token for this App/);
    assert.equal(refused.err.includes(revoked.token), false);
  },
);
