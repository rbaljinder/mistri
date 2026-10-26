/** The App API through the real CLI, over SQLite: a command declared in the
 * App file, served over loopback HTTP beside the reads (`--api-reads`), and
 * the same App as MCP tools on stdio (`--app-mcp`). Each case builds its own
 * App directory, native auth store and issued token, and kills what it starts.
 * The PostgreSQL App MCP case is app-mcp-postgres-cli.test.ts. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { loadBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandLoader.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { provisionSqliteApiTokenStore } from '../packages/mistri/src/server/auth/provisionSqliteApiTokenStore.js';
import { issueSqliteApiCommandToken, revokeSqliteApiToken } from '../packages/mistri/src/server/auth/sqliteApiTokenMaintenance.js';
import { captureAuthStoreExclusion } from '../packages/mistri/src/server/auth/authStoreSeparation.js';
import { provisionSqliteInbox } from '../packages/mistri/src/adapters/inbox/sqliteInbox.js';
import { INBOX_TABLES } from '../packages/mistri/src/adapters/inbox/inboxTables.js';
import {
  LEDGER_ROW,
  LEDGER_TABLE,
  RANKS,
  SESSION_SECRET,
  allPages,
  byBytes,
  byRank,
  childEnv,
  mcpEnv,
  runCli,
  serveApi,
  startAppMcp,
  tokenCli,
  writeLedgerApp,
} from './appApiCli.js';

const storeId = '5b1f0c52-7c1e-4c55-9e0a-4a7f3f0c2d11';

/** The ledger App on SQLite, with one eligible native account and a token
 * that may read and run its command. */
async function ledger(t: TestContext, extra: { rank?: boolean; form?: boolean; notify?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tw-app-api-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const business = join(directory, 'business.db'),
    authPath = join(directory, 'auth.db');
  const db = new DatabaseSync(business);
  try {
    db.exec(`${LEDGER_TABLE}; ${LEDGER_ROW}${extra.rank ? '; ALTER TABLE item ADD COLUMN rank INTEGER' : ''}`);
    if (extra.notify) db.exec("ALTER TABLE item ADD COLUMN owner TEXT; UPDATE item SET owner = 'owner@example.test'");
  } finally {
    db.close();
  }
  migrateSqliteCommandJournal(business);
  if (extra.notify) provisionSqliteInbox(business);
  const { appDir, config, commands } = writeLedgerApp(directory, { business, authStore: authPath, ...extra });
  const loaded = await loadApp(appDir);
  writeFileSync(join(appDir, 'authority.lock'), loaded.authority!.report);
  // The native auth store as serving creates it, then one eligible account.
  const names = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
  const saved = names.map((name) => [name, process.env[name]] as const);
  process.env.BETTER_AUTH_SECRET = SESSION_SECRET;
  delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
  delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
  try {
    (await createAppAuth(loaded, { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'] })).close();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const accounts = new DatabaseSync(authPath);
  try {
    accounts
      .prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES (?,?,?,1,?,?,?,0)')
      .run('operator', 'Operator', 'operator@example.test', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'operator');
  } finally {
    accounts.close();
  }
  const exclusions = [captureAuthStoreExclusion(business)];
  provisionSqliteApiTokenStore(authPath, { appId: 'ledger', storeId, exclusions });
  const registry = new Registry();
  registry.add({ id: 'data', name: 'data', url: business, writable: true, source: 'config' });
  let issue: (operations?: readonly string[], expiresAt?: number) => ReturnType<typeof issueSqliteApiCommandToken>;
  try {
    const resources = await loadAppRuntimeResources(registry, loaded.app, 'data');
    const evidence = { connectionFor: resources.connectionFor, writableConnection: () => true, transactionalConnection: () => true };
    const declared = await loadBusinessCommands(commands);
    issue = (operations, expiresAt = Date.now() + 600000) =>
      issueSqliteApiCommandToken(
        authPath,
        loaded.app,
        resources.schema,
        declared,
        evidence,
        {
          storeId,
          exclusions,
          subjectId: 'operator',
          actorId: 'operator',
          roles: ['operator'],
          label: 'CLI test',
          expiresAt,
          ...(operations ? { operations } : {}),
        },
        Date.now(),
      );
  } finally {
    await registry.closeAll();
  }
  const token = issue();
  return {
    directory,
    appDir,
    business,
    authPath,
    config,
    commands,
    token,
    issue,
    revoke: (tokenId: string) =>
      revokeSqliteApiToken(
        authPath,
        { appId: 'ledger', storeId, exclusions, tokenId, expectedVersion: '1', actorId: 'operator' },
        Date.now(),
      ),
    version: () => {
      const check = new DatabaseSync(business);
      try {
        return check.prepare('SELECT version FROM item WHERE id = 1').get()!.version;
      } finally {
        check.close();
      }
    },
    /** What the item's owner has been told, oldest first. */
    notices: () => {
      const check = new DatabaseSync(business, { readOnly: true });
      try {
        return check
          .prepare(`SELECT recipient, title FROM ${INBOX_TABLES.notice} ORDER BY id`)
          .all()
          .map((row) => ({ ...row }));
      } finally {
        check.close();
      }
    },
  };
}

const serve = (t: TestContext, f: Awaited<ReturnType<typeof ledger>>) => serveApi(t, f);

test("--api-reads runs a signed-in form's keyless command at its resource's command route", { timeout: 120000 }, async (t) => {
  const f = await ledger(t, { form: true });
  const s = await serve(t, f);
  await s.started;
  const bearer = { authorization: `Bearer ${f.token.token}` };
  // No record to address and no version to match: the idempotency key is the whole request's identity.
  const run = () =>
    fetch(`${s.base}/item/commands/log/v1`, {
      method: 'POST',
      headers: { ...bearer, 'idempotency-key': 'cli-log-0000000001', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Two' }),
    });
  const applied = await run(),
    receipt = await applied.json();
  assert.equal(applied.status, 200, JSON.stringify(receipt));
  assert.deepEqual(receipt.result, { ok: true });
  assert.equal((await run()).headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(await (await fetch(`${s.base}/item/2`, { headers: bearer })).json(), { id: '2', version: '0', name: 'Two' });
  const paths = Object.keys((await (await fetch(`${s.base}/$openapi`, { headers: bearer })).json()).paths);
  assert.ok(paths.includes('/item/commands/log/v1'), JSON.stringify(paths));
  // A record route does not reach it.
  const addressed = await fetch(`${s.base}/item/1/commands/log/v1`, {
    method: 'POST',
    headers: { ...bearer, 'if-match': '"0"', 'idempotency-key': 'cli-log-0000000002', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Three' }),
  });
  assert.equal(addressed.status, 404);
  await addressed.body?.cancel();
  s.child.kill('SIGTERM');
  assert.equal(await s.closed, 0);
});

test(
  '--api-reads serves a command declared in the App file beside its reads, with the composed $openapi',
  { timeout: 120000 },
  async (t) => {
    const f = await ledger(t);
    const s = await serve(t, f);
    await s.started;
    const bearer = { authorization: `Bearer ${f.token.token}` };
    const item = await fetch(`${s.base}/item/1`, { headers: bearer });
    assert.equal(item.status, 200);
    assert.deepEqual(await item.json(), { id: '1', version: '0', name: 'One' });
    const key = 'cli-attempt-0000000001';
    const run = () =>
      fetch(`${s.base}/item/1/commands/change/v1`, {
        method: 'POST',
        headers: { ...bearer, 'if-match': '"0"', 'idempotency-key': key, 'content-type': 'application/json' },
        body: '{}',
      });
    const applied = await run(),
      receipt = await applied.json();
    assert.equal(applied.status, 200, JSON.stringify(receipt));
    assert.equal(receipt.receipt.replayed, false);
    assert.deepEqual(receipt.result, { ok: true });
    // The same key and request replay the receipt; the handler ran once.
    const replay = await run();
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('idempotent-replayed'), 'true');
    assert.equal((await replay.json()).receipt.id, receipt.receipt.id);
    const recovered = await fetch(`${s.base}/commands/change/v1/receipts/${key}`, { headers: bearer });
    assert.deepEqual(await recovered.json(), {
      receipt: { id: receipt.receipt.id, status: 'applied', recovered: true },
      targets: [{ id: '1' }],
      result: { ok: true },
    });
    assert.equal(f.version(), 1);
    assert.deepEqual(await (await fetch(`${s.base}/item/1`, { headers: bearer })).json(), { id: '1', version: '1', name: 'One' });
    // A stale version is refused by the owner, and says nothing was applied.
    const stale = await fetch(`${s.base}/item/1/commands/change/v1`, {
      method: 'POST',
      headers: { ...bearer, 'if-match': '"0"', 'idempotency-key': 'cli-attempt-0000000002' },
      body: '{}',
    });
    const problem = await stale.json();
    assert.equal(stale.status, 409);
    assert.equal(problem.code, 'stale_record');
    assert.equal(problem.outcome, 'not_applied');
    const spec = await fetch(`${s.base}/$openapi`, { headers: bearer });
    const paths = Object.keys((await spec.json()).paths);
    assert.ok(paths.includes('/item/{id}') && paths.includes('/item/{id}/commands/change/v1'), JSON.stringify(paths));
    // A token scoped to the reads sees no command, and may not run one.
    const reader = f.issue(['item:item', 'list:item']).token;
    const narrowed = Object.keys(
      (await (await fetch(`${s.base}/$openapi`, { headers: { authorization: `Bearer ${reader}` } })).json()).paths,
    );
    assert.ok(narrowed.length && narrowed.every((path) => !path.includes('/commands/')), JSON.stringify(narrowed));
    const forbidden = await fetch(`${s.base}/item/1/commands/change/v1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${reader}`, 'if-match': '"1"', 'idempotency-key': 'cli-attempt-0000000003' },
      body: '{}',
    });
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).outcome, 'not_applied');
    const anonymous = await fetch(`${s.base}/item/1/commands/change/v1`, {
      method: 'POST',
      headers: { 'if-match': '"1"', 'idempotency-key': 'cli-attempt-0000000004' },
      body: '{}',
    });
    assert.equal(anonymous.status, 401);
    await anonymous.body?.cancel();
    // Revocation takes effect on the next request, on both transports.
    f.revoke(f.token.tokenId);
    assert.equal((await fetch(`${s.base}/item/1`, { headers: bearer })).status, 401);
    const revoked = await fetch(`${s.base}/item/1/commands/change/v1`, {
      method: 'POST',
      headers: { ...bearer, 'if-match': '"1"', 'idempotency-key': 'cli-attempt-0000000005' },
      body: '{}',
    });
    assert.equal(revoked.status, 401);
    await revoked.body?.cancel();
    assert.equal(f.version(), 1);
    s.child.kill('SIGTERM');
    assert.equal(await s.closed, 0);
    assert.equal(s.output().includes(f.token.token), false);
  },
);

test(
  'a token store that cannot be read is 503 temporarily_unavailable on every transport, and a revoked token is still 401',
  { timeout: 180000 },
  async (t) => {
    const f = await ledger(t);
    const s = await serve(t, f);
    await s.started;
    const bearer = { authorization: `Bearer ${f.token.token}` };
    assert.equal((await fetch(`${s.base}/item/1`, { headers: bearer })).status, 200);
    const mcp = startAppMcp(
      t,
      ['--app-mcp', '--api-integers', 'decimal-string', '--config', f.config, '--app', f.appDir, '--commands', f.commands],
      mcpEnv(f.token.token),
    );
    const tools = (await mcp.request('tools/list')).result.tools as { name: string }[];
    const get = tools.find((tool) => tool.name.startsWith('get_'))!.name;
    assert.equal((await mcp.request('tools/call', { name: get, arguments: { id: '1' } })).result.isError, false);
    // The App's own sign-in database stops answering: another connection holds
    // it. Nothing is known about the token, so nothing may be said about it.
    const blocker = new DatabaseSync(f.authPath);
    blocker.exec('BEGIN EXCLUSIVE');
    try {
      const down = await fetch(`${s.base}/item/1`, { headers: bearer });
      assert.equal(down.status, 503);
      assert.deepEqual(await down.json(), {
        error: { code: 'temporarily_unavailable', message: 'The API request could not be completed.' },
      });
      const command = await fetch(`${s.base}/item/1/commands/change/v1`, {
        method: 'POST',
        headers: { ...bearer, 'if-match': '"0"', 'idempotency-key': 'cli-store-outage-001', 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(command.status, 503);
      const problem = await command.json();
      assert.deepEqual([problem.code, problem.outcome], ['temporarily_unavailable', 'unknown']);
      const refused = await mcp.request('tools/call', { name: get, arguments: { id: '1' } });
      assert.equal(refused.result.isError, true);
      assert.deepEqual(JSON.parse(refused.result.content[0].text), { error: { code: 'temporarily_unavailable' } });
      assert.equal(f.version(), 0, 'no command ran while the token store could not be read');
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
    }
    // The store answers again, and so do both transports.
    assert.equal((await fetch(`${s.base}/item/1`, { headers: bearer })).status, 200);
    assert.equal((await mcp.request('tools/call', { name: get, arguments: { id: '1' } })).result.isError, false);
    // A token the store can read and has revoked is still the token's own fault.
    f.revoke(f.token.tokenId);
    const revoked = await fetch(`${s.base}/item/1`, { headers: bearer });
    assert.equal(revoked.status, 401);
    await revoked.body?.cancel();
    const after = await mcp.request('tools/call', { name: get, arguments: { id: '1' } });
    assert.deepEqual(JSON.parse(after.result.content[0].text), { error: { code: 'unauthenticated' } });
    mcp.end();
    assert.equal(await mcp.closed, 0);
    s.child.kill('SIGTERM');
    assert.equal(await s.closed, 0);
  },
);

test(
  '--app-mcp never calls the token stale when its store could not be read, and still says so when the token is',
  { timeout: 120000 },
  async (t) => {
    const f = await ledger(t);
    const args = ['--app-mcp', '--api-integers', 'decimal-string', '--config', f.config, '--app', f.appDir, '--commands', f.commands];
    // A store locked before the process starts never opens, so startup stops
    // there — earlier than the token check. What matters either way: it exits
    // non-zero, it never echoes the token, and it does not blame the token for
    // a check that never happened.
    const blocker = new DatabaseSync(f.authPath);
    blocker.exec('BEGIN EXCLUSIVE');
    let unreadable: Awaited<ReturnType<typeof runCli>>;
    try {
      unreadable = await runCli(args, mcpEnv(f.token.token));
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
    }
    assert.equal(unreadable.code, 1, unreadable.err);
    assert.equal(unreadable.out, '');
    assert.doesNotMatch(unreadable.err, /revoked, expired, unknown or issued for another App/);
    assert.equal(unreadable.err.includes(f.token.token), false);
    // A token the store can read, and has revoked, is the token's own fault.
    f.revoke(f.token.tokenId);
    const revoked = await runCli(args, mcpEnv(f.token.token));
    assert.equal(revoked.code, 1, revoked.err);
    assert.match(revoked.err, /is not a current API token for this App/);
    assert.equal(revoked.err.includes(f.token.token), false);
  },
);

test('--api-reads pages a text sort by bytes, both ways, and a cursor never crosses to another order', { timeout: 120000 }, async (t) => {
  const f = await ledger(t);
  const names = ['One', 'b', 'B', 'a', 'Z', 'Ab', 'ab', 'b '];
  const db = new DatabaseSync(f.business);
  try {
    const insert = db.prepare('INSERT INTO item VALUES(?,0,?,NULL)');
    names.slice(1).forEach((name, index) => insert.run(index + 2, name));
  } finally {
    db.close();
  }
  const s = await serve(t, f);
  await s.started;
  const bearer = { authorization: `Bearer ${f.token.token}` };
  const served = async (query: string) => (await allPages(s.base, bearer, query)).map((row) => row.name);
  const ascending = [...names].sort(byBytes);
  assert.deepEqual(await served('limit=2&sort=name'), ascending);
  assert.deepEqual(await served('limit=3&sort=-name'), [...ascending].reverse());
  // A cursor carries its order: presented under another, it is refused.
  const first = await (await fetch(`${s.base}/item?limit=2&sort=name`, { headers: bearer })).json();
  const crossed = await fetch(`${s.base}/item?limit=2&sort=-name&cursor=${encodeURIComponent(first.next)}`, { headers: bearer });
  assert.equal(crossed.status, 400);
  await crossed.body?.cancel();
  s.child.kill('SIGTERM');
  assert.equal(await s.closed, 0);
});

test('--api-reads pages a nullable sort with its nulls last, both ways, each row once', { timeout: 120000 }, async (t) => {
  const f = await ledger(t, { rank: true });
  const db = new DatabaseSync(f.business);
  try {
    db.prepare('UPDATE item SET rank = ? WHERE id = 1').run(RANKS[0]);
    const insert = db.prepare('INSERT INTO item VALUES(?,0,?,NULL,?)');
    RANKS.slice(1).forEach((rank, index) => insert.run(index + 2, `n${index + 2}`, rank));
  } finally {
    db.close();
  }
  const s = await serve(t, f);
  await s.started;
  const bearer = { authorization: `Bearer ${f.token.token}` };
  const rows = RANKS.map((rank, index) => ({ id: index + 1, rank }));
  const served = async (query: string) => (await allPages(s.base, bearer, query)).map((row) => Number(row.id));
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
});

test('api-token issue --commands issues a command-scoped token that the served API accepts', { timeout: 120000 }, async (t) => {
  const f = await ledger(t);
  const issue = [
    'issue',
    '--app',
    f.appDir,
    '--config',
    f.config,
    '--store-id',
    storeId,
    '--subject',
    'operator',
    '--actor',
    'operator',
    '--role',
    'operator',
    '--label',
    'Command token',
    '--expires-at',
    new Date(Date.now() + 600000).toISOString(),
    '--operation',
    'command:change',
  ];
  // The App exposes commands: without its registry, nothing is issued.
  renameSync(f.commands, `${f.commands}.held`);
  try {
    const refused = await tokenCli(issue);
    assert.equal(refused.code, 2);
    assert.equal(refused.out, '');
    assert.match(refused.err, /API token maintenance failed/);
  } finally {
    renameSync(`${f.commands}.held`, f.commands);
  }
  const issued = await tokenCli([...issue, '--commands', f.commands]);
  assert.equal(issued.code, 0, issued.err);
  const { result } = JSON.parse(issued.out) as { result: { token: string; tokenId: string } };
  const inspected = await tokenCli([
    'inspect',
    '--app',
    f.appDir,
    '--config',
    f.config,
    '--store-id',
    storeId,
    '--token-id',
    result.tokenId,
  ]);
  assert.equal(inspected.code, 0, inspected.err);
  assert.deepEqual(JSON.parse(inspected.out).result.record.operations, ['command:change']);
  assert.equal(inspected.out.includes(result.token), false);
  const s = await serve(t, f);
  await s.started;
  const bearer = { authorization: `Bearer ${result.token}` };
  const run = await fetch(`${s.base}/item/1/commands/change/v1`, {
    method: 'POST',
    headers: { ...bearer, 'if-match': '"0"', 'idempotency-key': 'cli-issued-00000001' },
    body: '{}',
  });
  assert.equal(run.status, 200, await run.clone().text());
  await run.body?.cancel();
  // Scoped to the command alone: the read is refused.
  const read = await fetch(`${s.base}/item/1`, { headers: bearer });
  assert.equal(read.status, 403);
  await read.body?.cancel();
  assert.equal(f.version(), 1);
});

test(
  '--api-reads refuses a command-exposing App without an explicit or discoverable registry, before listening',
  { timeout: 60000 },
  async (t) => {
    const f = await ledger(t);
    renameSync(f.commands, `${f.commands}.held`);
    const result = await runCli([
      '--config',
      f.config,
      '--app',
      f.appDir,
      '--port',
      '0',
      '--api-reads',
      '--api-integers',
      'decimal-string',
      '--api-requests-per-minute',
      '100',
    ]);
    assert.equal(result.code, 1);
    assert.match(result.err, /no commands module is loaded/);
    assert.doesNotMatch(result.err, /Listening/);
    assert.equal(f.version(), 0);
  },
);

test('--app-mcp answers the App API as MCP tools on stdio: reads, a command, its replay and recovery', { timeout: 180000 }, async (t) => {
  const f = await ledger(t);
  // No BETTER_AUTH_SECRET: App MCP serves no sign-in, so it needs none.
  const mcp = startAppMcp(
    t,
    ['--app-mcp', '--api-integers', 'decimal-string', '--config', f.config, '--app', f.appDir, '--commands', f.commands],
    mcpEnv(f.token.token),
  );
  const init = await mcp.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'mistri-app');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  mcp.notify('notifications/initialized');
  const tools = (await mcp.request('tools/list')).result.tools as { name: string; inputSchema: object }[];
  const named = (prefix: string) =>
    tools.find((tool) => tool.name.startsWith(prefix))?.name ?? assert.fail(`${prefix} is not listed: ${JSON.stringify(tools)}`);
  const get = named('get_'),
    list = named('list_'),
    run = named('run_change_'),
    recover = named('recover_change_');
  assert.ok(tools.every((tool) => tool.inputSchema && typeof tool.inputSchema === 'object'));
  const read = await mcp.request('tools/call', { name: get, arguments: { id: '1' } });
  assert.deepEqual(read.result.structuredContent, { id: '1', version: '0', name: 'One' });
  const key = 'mcp-cli-attempt-00001';
  const call = { name: run, arguments: { key: { id: '1' }, version: 0, idempotencyKey: key, input: {} } };
  const applied = await mcp.request('tools/call', call);
  assert.equal(applied.result.isError, false, JSON.stringify(applied));
  assert.equal(applied.result.structuredContent.receipt.replayed, false);
  // The same idempotency key replays the receipt: the handler ran once.
  const replayed = await mcp.request('tools/call', call);
  assert.equal(replayed.result.structuredContent.receipt.replayed, true);
  assert.equal(replayed.result.structuredContent.receipt.id, applied.result.structuredContent.receipt.id);
  const recovered = await mcp.request('tools/call', { name: recover, arguments: { idempotencyKey: key } });
  assert.deepEqual(recovered.result.structuredContent.targets, [{ id: '1' }]);
  const stale = await mcp.request('tools/call', { name: run, arguments: { ...call.arguments, idempotencyKey: 'mcp-cli-attempt-00002' } });
  assert.equal(stale.result.isError, true);
  assert.deepEqual(
    [JSON.parse(stale.result.content[0].text).code, JSON.parse(stale.result.content[0].text).outcome],
    ['stale_record', 'not_applied'],
  );
  const listed = await mcp.request('tools/call', { name: list, arguments: {} });
  assert.equal(listed.result.structuredContent.items[0].version, '1');
  assert.equal(f.version(), 1);
  // A listing is never permission: a revocation reaches the next call.
  f.revoke(f.token.tokenId);
  const refused = await mcp.request('tools/call', { name: get, arguments: { id: '1' } });
  assert.deepEqual(JSON.parse(refused.result.content[0].text), { error: { code: 'unauthenticated' } });
  mcp.end();
  assert.equal(await mcp.closed, 0);
  // stdout is the protocol alone, and the token is in neither stream.
  for (const line of mcp.lines) assert.equal(JSON.parse(line).jsonrpc, '2.0');
  assert.equal([...mcp.lines, mcp.stderr()].join('\n').includes(f.token.token), false);
});

test(
  '--app-mcp with a read-scoped token lists and runs only reads, and loads no command code without --commands',
  { timeout: 120000 },
  async (t) => {
    const f = await ledger(t);
    const token = f.issue(['item:item', 'list:item']).token;
    const mcp = startAppMcp(
      t,
      ['--app-mcp', '--api-integers', 'number', '--config', f.config, '--app', f.appDir, '--commands', f.commands],
      mcpEnv(token),
    );
    const names = ((await mcp.request('tools/list')).result.tools as { name: string }[]).map((tool) => tool.name);
    assert.ok(names.length === 2 && names.every((name) => /^(get|list)_/.test(name)), JSON.stringify(names));
    const read = await mcp.request('tools/call', { name: names.find((name) => name.startsWith('get_')), arguments: { id: 1 } });
    assert.deepEqual(read.result.structuredContent, { id: 1, version: 0, name: 'One' });
    mcp.end();
    assert.equal(await mcp.closed, 0);
  },
);

test(
  '--app-mcp checks its token once at startup: revoked, expired and unknown tokens stop it before any tool',
  { timeout: 180000 },
  async (t) => {
    const f = await ledger(t);
    const args = ['--app-mcp', '--api-integers', 'decimal-string', '--config', f.config, '--app', f.appDir, '--commands', f.commands];
    const revoked = f.issue();
    f.revoke(revoked.tokenId);
    const expired = f.issue(undefined, Date.now() + 1500);
    await new Promise((done) => setTimeout(done, 2000));
    // Well formed, but never issued here (as a token for another App would be).
    const unknown = `twa1.${randomUUID()}.${randomBytes(32).toString('base64url')}`;
    for (const token of [revoked.token, expired.token, unknown]) {
      const result = await runCli(args, mcpEnv(token));
      assert.equal(result.code, 1, result.err);
      assert.equal(result.out, '');
      assert.match(result.err, /MISTRI_API_TOKEN is not a current API token for this App/);
      assert.equal(result.err.includes(token), false);
    }
    assert.equal(f.version(), 0);
  },
);

test(
  '--app-mcp refuses without its token, beside other modes, and without the registry its App exposes',
  { timeout: 180000 },
  async (t) => {
    const f = await ledger(t);
    const base = ['--app-mcp', '--api-integers', 'decimal-string', '--config', f.config, '--app', f.appDir];
    const token = childEnv({ MISTRI_API_TOKEN: f.token.token });
    const cases: Array<[string[], NodeJS.ProcessEnv, RegExp]> = [
      [[...base, '--commands', f.commands], childEnv(), /MISTRI_API_TOKEN/],
      [[...base, '--commands', f.commands], childEnv({ MISTRI_API_TOKEN: '' }), /MISTRI_API_TOKEN/],
      [[...base, '--commands', f.commands], childEnv({ MISTRI_API_TOKEN: ` ${f.token.token}` }), /MISTRI_API_TOKEN/],
      [['--app-mcp', '--config', f.config, '--app', f.appDir], token, /--api-integers/],
      [[...base, '--api-reads', '--api-requests-per-minute', '10'], token, /cannot be combined/],
      // --mcp is the database browser's: mistri names that command, a usage error.
      [[...base, '--mcp'], token, /--mcp is the database browser's, a command of its own: npx tablewalk/],
      [[...base, '--port', '4999'], token, /cannot be combined/],
      [[...base, '--app-mcp'], token, /only once/],
    ];
    for (const [args, env, message] of cases) {
      const result = await runCli(args, env);
      assert.equal(result.code, args.includes('--mcp') ? 2 : 1, `${args.join(' ')}: ${result.err}`);
      assert.equal(result.out.includes('"jsonrpc"'), false);
      assert.match(result.err, message, args.join(' '));
      assert.equal(result.err.includes(f.token.token), false);
    }
    renameSync(f.commands, `${f.commands}.held`);
    const missing = await runCli(base, token);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /no commands module is loaded/);
    assert.equal(f.version(), 0);
  },
);

// A machine edge's notify is the write layer's, not the door's: a command run over the API or MCP tells the owner as a click would.
test('a command written through --api-reads and through --app-mcp tells whom its notify rule names', { timeout: 180000 }, async (t) => {
  const f = await ledger(t, { notify: true });
  const s = await serve(t, f);
  await s.started;
  const applied = await fetch(`${s.base}/item/1/commands/change/v1`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${f.token.token}`,
      'if-match': '"0"',
      'idempotency-key': 'cli-notify-00000001',
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(applied.status, 200, await applied.text());
  s.child.kill('SIGTERM');
  assert.equal(await s.closed, 0);
  assert.deepEqual(f.notices(), [{ recipient: 'owner@example.test', title: 'One changed' }]);
  const mcp = startAppMcp(
    t,
    ['--app-mcp', '--api-integers', 'decimal-string', '--config', f.config, '--app', f.appDir, '--commands', f.commands],
    mcpEnv(f.token.token),
  );
  await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  mcp.notify('notifications/initialized');
  const tools = (await mcp.request('tools/list')).result.tools as { name: string }[];
  const run = tools.find((tool) => tool.name.startsWith('run_change_'))?.name ?? assert.fail(JSON.stringify(tools));
  const ran = await mcp.request('tools/call', {
    name: run,
    arguments: { key: { id: '1' }, version: 1, idempotencyKey: 'mcp-notify-0000001', input: {} },
  });
  assert.equal(ran.result.isError, false, JSON.stringify(ran));
  mcp.end();
  assert.equal(await mcp.closed, 0);
  assert.equal(f.version(), 2);
  assert.deepEqual(f.notices(), [
    { recipient: 'owner@example.test', title: 'One changed' },
    { recipient: 'owner@example.test', title: 'One changed' },
  ]);
});
