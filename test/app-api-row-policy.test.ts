/** A row-policy App's API and App MCP, through the real CLI over SQLite: each
 * token reads and acts through its own account's rows, by the same policy the
 * App's pages use. Two accounts with one role each own one ticket; neither
 * sees, reads or closes the other's, over HTTP, `…/$mcp` or `--app-mcp`.
 * Without --policy the API never starts. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
import { ROOT, SESSION_SECRET, childEnv, freePort, mcpEnv, runCli, serveApi, startAppMcp } from './appApiCli.js';

const storeId = '5b0c8f0e-2a4d-4c55-9e1a-3f6f0d6c2b11';

async function desk(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tw-api-row-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const business = join(directory, 'business.db'),
    authPath = join(directory, 'auth.db');
  const db = new DatabaseSync(business);
  try {
    db.exec(
      'CREATE TABLE ticket(id INTEGER PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, owner TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL); ' +
        "INSERT INTO ticket(id, owner, title, status) VALUES (1, 'ann', 'Printer', 'open'), (2, 'bob', 'Laptop', 'open')",
    );
  } finally {
    db.close();
  }
  migrateSqliteCommandJournal(business);
  const appDir = join(directory, 'app');
  mkdirSync(appDir);
  const config = join(directory, 'mistri.json'),
    commands = join(appDir, 'commands.mjs'),
    policy = join(directory, 'policy.mjs');
  writeFileSync(
    join(appDir, 'app.json'),
    JSON.stringify({
      id: 'desk',
      name: 'Desk',
      sources: { business: { connection: 'data', default: true } },
      resources: { ticket: { access: 'write' } },
      auth: {
        store: authPath,
        rows: 'policy',
        roles: { agent: { read: ['ticket'], write: false, commands: ['close'] } },
      },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      home: 'tickets',
      api: {
        version: 1,
        roles: ['agent'],
        resources: { ticket: { fields: ['id', 'revision', 'owner', 'title', 'status'], sorts: ['id'] } },
        commands: ['close'],
      },
    }),
  );
  writeFileSync(config, JSON.stringify({ connections: [{ id: 'data', name: 'data', url: business, writable: true }] }));
  const source = (path: string) => pathToFileURL(join(ROOT, path)).href;
  writeFileSync(
    commands,
    `import { defineCommand, defineCommands } from '${source('packages/mistri/src/server/commands/businessCommands.ts')}';
import { shape, int } from '${source('packages/mistri/src/server/commands/commandShapes.ts')}';
export default defineCommands({
  close: defineCommand({ source: 'business', target: 'ticket', input: {}, output: shape({ id: int() }),
    async handle({ db, record }) {
      await db.ticket.update(record, { status: 'closed' });
      return { id: Number(record.id) };
    } }),
});
`,
  );
  // The pages' policy: an agent's own tickets, by the verified account's id.
  writeFileSync(
    policy,
    `export default { appId: 'desk',
  resolveRows(principal) {
    return { ticket: { groups: [[{ column: 'owner', op: '=', value: principal.id }]] } };
  },
  resultReferences: { close: () => [] },
};
`,
  );
  const loaded = await loadApp(appDir);
  writeFileSync(join(appDir, 'authority.lock'), loaded.authority!.report);
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
    for (const id of ['ann', 'bob'])
      accounts
        .prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES (?,?,?,1,?,?,?,0)')
        .run(id, id, `${id}@example.test`, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'agent');
  } finally {
    accounts.close();
  }
  const exclusions = [captureAuthStoreExclusion(business)];
  provisionSqliteApiTokenStore(authPath, { appId: 'desk', storeId, exclusions });
  const registry = new Registry();
  registry.add({ id: 'data', name: 'data', url: business, writable: true, source: 'config' });
  const tokens: Record<string, string> = {},
    tokenIds: Record<string, string> = {};
  try {
    const resources = await loadAppRuntimeResources(registry, loaded.app, 'data');
    const evidence = { connectionFor: resources.connectionFor, writableConnection: () => true, transactionalConnection: () => true };
    const declared = await loadBusinessCommands(commands);
    for (const id of ['ann', 'bob']) {
      const issued = issueSqliteApiCommandToken(
        authPath,
        loaded.app,
        resources.schema,
        declared,
        evidence,
        {
          storeId,
          exclusions,
          subjectId: id,
          actorId: id,
          roles: ['agent'],
          label: id,
          expiresAt: Date.now() + 600000,
        },
        Date.now(),
      );
      tokens[id] = issued.token;
      tokenIds[id] = issued.tokenId;
    }
  } finally {
    await registry.closeAll();
  }
  const status = (id: number) => {
    const check = new DatabaseSync(business, { readOnly: true });
    try {
      return (check.prepare('SELECT status FROM ticket WHERE id = ?').get(id) as { status: string }).status;
    } finally {
      check.close();
    }
  };
  const revoke = (id: string) =>
    revokeSqliteApiToken(
      authPath,
      { appId: 'desk', storeId, exclusions, tokenId: tokenIds[id], expectedVersion: '1', actorId: id },
      Date.now(),
    );
  return { appDir, config, commands, policy, tokens, status, revoke };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test('a row-policy App API is served only under its --policy', { timeout: 120000 }, async (t) => {
  const f = await desk(t);
  const refused = await runCli(
    [
      ...['--config', f.config, '--app', f.appDir, '--commands', f.commands, '--port', String(await freePort())],
      ...['--api-reads', '--api-integers', 'decimal-string', '--api-requests-per-minute', '60'],
    ],
    childEnv(),
  );
  assert.equal(refused.code, 1);
  assert.match(refused.err, /row-policy App under its --policy/);
  assert.doesNotMatch(refused.out, /Listening on/);
});

test('each token reads and closes only the rows its account’s policy reaches, on HTTP and on $mcp', { timeout: 180000 }, async (t) => {
  const f = await desk(t);
  const served = await serveApi(t, f, 'desk', ['--policy', f.policy]);
  await served.started;
  const get = async (token: string, path: string) => {
    const res = await fetch(`${served.base}${path}`, { headers: bearer(token) });
    return { status: res.status, body: await res.json() };
  };

  // Lists: each account's own ticket, never the other's.
  const ann = await get(f.tokens.ann, '/ticket?sort=id');
  assert.equal(ann.status, 200, JSON.stringify(ann.body));
  assert.deepEqual(
    ann.body.items.map((row: { id: string }) => row.id),
    ['1'],
  );
  const bob = await get(f.tokens.bob, '/ticket?sort=id');
  assert.deepEqual(
    bob.body.items.map((row: { id: string }) => row.id),
    ['2'],
  );
  // An item outside the policy is not found, exactly as a row that does not exist.
  assert.equal((await get(f.tokens.ann, '/ticket/1')).status, 200);
  const hidden = await get(f.tokens.ann, '/ticket/2');
  assert.equal(hidden.status, 404, JSON.stringify(hidden.body));
  assert.equal((await get(f.tokens.ann, '/ticket/999')).status, 404);

  // A command on a hidden row is refused, and nothing is applied; on its own row it runs.
  const close = async (token: string, id: number, key: string) => {
    const prepared = await fetch(`${served.base}/ticket/${id}/commands/close/v1/prepare`, { headers: bearer(token) });
    const etag = prepared.headers.get('etag') ?? '"0"';
    const res = await fetch(`${served.base}/ticket/${id}/commands/close/v1`, {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'application/json', 'if-match': etag, 'idempotency-key': key },
      body: '{}',
    });
    return { prepared: prepared.status, status: res.status, body: await res.text() };
  };
  const foreign = await close(f.tokens.ann, 2, 'row-policy-attempt-0001');
  assert.equal(foreign.prepared, 404);
  // The deployment's executor refuses it, in its own words; the row is untouched.
  assert.equal(foreign.status, 403, foreign.body);
  assert.match(foreign.body, /"code":"forbidden"/);
  assert.equal(f.status(2), 'open');
  const own = await close(f.tokens.ann, 1, 'row-policy-attempt-0002');
  assert.equal(own.prepared, 200);
  assert.equal(own.status, 200, own.body);
  assert.equal(f.status(1), 'closed');
  assert.equal(f.status(2), 'open');

  // The narrowed document, and the same rows over MCP.
  assert.equal((await get(f.tokens.bob, '/$openapi')).status, 200);
  let id = 0;
  const rpc = async (token: string, method: string, params: object = {}) => {
    const res = await fetch(`${served.base}/$mcp`, {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    return { status: res.status, body: await res.json() };
  };
  assert.equal(
    (await rpc(f.tokens.bob, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '0' } }))
      .status,
    200,
  );
  const tools = await rpc(f.tokens.bob, 'tools/list');
  assert.equal(tools.status, 200, JSON.stringify(tools.body));
  const list = tools.body.result.tools.find((tool: { name: string }) => /list/.test(tool.name) && /ticket/.test(tool.name));
  assert.ok(list, JSON.stringify(tools.body));
  const listed = await rpc(f.tokens.bob, 'tools/call', { name: list.name, arguments: {} });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const text = JSON.stringify(listed.body.result);
  assert.match(text, /Laptop/);
  assert.doesNotMatch(text, /Printer/);

  // A revoked token reaches nothing, through the policy or around it.
  f.revoke('bob');
  assert.equal((await get(f.tokens.bob, '/ticket/2')).status, 401);
  assert.equal((await get(f.tokens.ann, '/ticket/1')).status, 200);
});

test('--app-mcp serves a row-policy App under its --policy: the token account’s rows alone', { timeout: 180000 }, async (t) => {
  const f = await desk(t);
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
      '--commands',
      f.commands,
      '--policy',
      f.policy,
    ],
    mcpEnv(f.tokens.bob),
  );
  const tools = (await mcp.request('tools/list')).result.tools as { name: string }[];
  const named = (prefix: string) =>
    tools.find((tool) => tool.name.startsWith(prefix))?.name ?? assert.fail(`${prefix} is not listed: ${JSON.stringify(tools)}`);
  const listed = await mcp.request('tools/call', { name: named('list_'), arguments: {} });
  assert.deepEqual(
    listed.result.structuredContent.items.map((row: { title: string }) => row.title),
    ['Laptop'],
  );
  const hidden = await mcp.request('tools/call', { name: named('get_'), arguments: { id: '1' } });
  assert.equal(hidden.result.isError, true);
  const closed = await mcp.request('tools/call', {
    name: named('run_close_'),
    arguments: { key: { id: '1' }, version: 0, idempotencyKey: 'row-policy-mcp-0001', input: {} },
  });
  assert.equal(closed.result.isError, true);
  assert.equal(f.status(1), 'open');
  mcp.end();
  assert.equal(await mcp.closed, 0);
});
