/** An App's `choose` at the machine doors: the App API (REST reads and commands), App MCP and the published OpenAPI,
 * through the real CLI over SQLite. A call names its picks itself (`chosen.site=` on a read, `chosen` in a command's
 * body or the `x-mistri-chosen` header), each is read again under the token's own reach, and none is ever stored.
 * Run plain and under a row policy, where a site the token cannot read is null and matches no row. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { loadBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandLoader.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { provisionSqliteApiTokenStore } from '../packages/mistri/src/server/auth/provisionSqliteApiTokenStore.js';
import { issueSqliteApiCommandToken } from '../packages/mistri/src/server/auth/sqliteApiTokenMaintenance.js';
import { captureAuthStoreExclusion } from '../packages/mistri/src/server/auth/authStoreSeparation.js';
import { renderApiClient } from '../packages/mistri/src/server/api/apiClientGen.js';
import { ROOT, SESSION_SECRET, serveApi } from './appApiCli.js';

const storeId = '5b0c8f0e-2a4d-4c55-9e1a-3f6f0d6c2b77';

type Options = { policy?: boolean; choose?: boolean };

async function desk(t: TestContext, options: Options = {}) {
  const choose = options.choose !== false;
  const directory = mkdtempSync(join(tmpdir(), 'tw-api-choose-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const business = join(directory, 'business.db'),
    authPath = join(directory, 'auth.db');
  const db = new DatabaseSync(business);
  try {
    db.exec(
      'CREATE TABLE site(id INTEGER PRIMARY KEY, name TEXT NOT NULL); ' +
        'CREATE TABLE visit(id INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, site_id INTEGER NOT NULL, owner TEXT NOT NULL, tag TEXT); ' +
        "INSERT INTO site VALUES (1, 'North'), (2, 'South'); " +
        "INSERT INTO visit(id, site_id, owner) VALUES (10, 1, 'ann'), (11, 2, 'bob'), (12, 1, 'bob')",
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
      resources: { site: {}, visit: { access: 'write' } },
      ...(choose ? { choose: { site: { from: 'site', label: 'name' } } } : {}),
      auth: {
        store: authPath,
        ...(options.policy ? { rows: 'policy' } : {}),
        roles: { agent: { read: true, commands: ['annotate'] } },
      },
      views: { visits: { kind: 'list', from: 'visit', ...(choose ? { query: 'site_id = chosen.site' } : {}) } },
      home: 'visits',
      api: {
        version: 1,
        roles: ['agent'],
        resources: {
          site: { fields: ['id', 'name'], sorts: ['id'] },
          visit: { fields: ['id', 'version', 'site_id', 'owner', 'tag'], sorts: ['id'] },
        },
        views: ['visits'],
        commands: ['annotate'],
      },
    }),
  );
  writeFileSync(config, JSON.stringify({ connections: [{ id: 'data', name: 'data', url: business, writable: true }] }));
  const source = (path: string) => pathToFileURL(join(ROOT, path)).href;
  // The handler writes what it was told it works at, so the row says what ctx.chosen held.
  writeFileSync(
    commands,
    `import { defineCommand, defineCommands } from '${source('packages/mistri/src/server/commands/businessCommands.ts')}';
import { shape, bool } from '${source('packages/mistri/src/server/commands/commandShapes.ts')}';
export default defineCommands({
  annotate: defineCommand({ source: 'business', target: 'visit', input: {}, output: shape({ ok: bool() }),
    async handle({ db, record, chosen }) {
      const site = chosen.site;
      await db.visit.update(record, { tag: site === undefined ? 'none' : 'site ' + site });
      return { ok: true };
    } }),
});
`,
  );
  // A policy: an agent's own visits, and the one site each is placed at (ann North, bob South).
  writeFileSync(
    policy,
    `export default { appId: 'desk',
  resolveRows(principal) {
    return {
      site: { groups: [[{ column: 'id', op: '=', value: principal.id === 'ann' ? 1 : 2 }]] },
      visit: { groups: [[{ column: 'owner', op: '=', value: principal.id }]] },
    };
  },
  resultReferences: { annotate: () => [] },
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
  const tokens: Record<string, string> = {};
  try {
    const resources = await loadAppRuntimeResources(registry, loaded.app, 'data');
    const evidence = { connectionFor: resources.connectionFor, writableConnection: () => true, transactionalConnection: () => true };
    const declared = await loadBusinessCommands(commands);
    for (const id of ['ann', 'bob'])
      tokens[id] = issueSqliteApiCommandToken(
        authPath,
        loaded.app,
        resources.schema,
        declared,
        evidence,
        { storeId, exclusions, subjectId: id, actorId: id, roles: ['agent'], label: id, expiresAt: Date.now() + 600000 },
        Date.now(),
      ).token;
  } finally {
    await registry.closeAll();
  }
  const note = (id: number) => {
    const check = new DatabaseSync(business, { readOnly: true });
    try {
      return (check.prepare('SELECT tag FROM visit WHERE id = ?').get(id) as { tag: string | null }).tag;
    } finally {
      check.close();
    }
  };
  return { appDir, config, commands, policy, tokens, note };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function serve(t: TestContext, f: Awaited<ReturnType<typeof desk>>, options: Options) {
  const served = await serveApi(t, f, 'desk', options.policy ? ['--policy', f.policy] : []);
  await served.started;
  const get = async (token: string, path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${served.base}${path}`, { headers: { ...bearer(token), ...headers } });
    return { status: res.status, body: await res.json() };
  };
  const ids = (body: { items: { id: string }[] }) => body.items.map((row) => row.id);
  let rpcId = 0;
  const rpc = async (token: string, method: string, params: object = {}) => {
    const res = await fetch(`${served.base}/$mcp`, {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
    return { status: res.status, body: await res.json() };
  };
  const run = async (token: string, id: number, key: string, body: unknown, headers: Record<string, string> = {}) => {
    const prepared = await fetch(`${served.base}/visit/${id}/commands/annotate/v1/prepare`, { headers: bearer(token) });
    const res = await fetch(`${served.base}/visit/${id}/commands/annotate/v1`, {
      method: 'POST',
      headers: {
        ...bearer(token),
        ...headers,
        'content-type': 'application/json',
        'if-match': prepared.headers.get('etag') ?? '"0"',
        'idempotency-key': key,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.text() };
  };
  return { served, get, ids, rpc, run };
}

for (const options of [{}, { policy: true }] as Options[]) {
  const kind = options.policy ? 'under a row policy' : 'plain';

  test(`a REST read names its pick, and the same read without one is refused (${kind})`, { timeout: 180000 }, async (t) => {
    const f = await desk(t, options);
    const s = await serve(t, f, options);
    const tokens = f.tokens;
    // Without a pick the standing question has no site to mean, in the words a job gets.
    const none = await s.get(tokens.ann, '/views/visits');
    assert.equal(none.status, 422, JSON.stringify(none.body));
    assert.equal(none.body.error.code, 'chosen_required');
    assert.match(JSON.stringify(none.body), /nothing here runs for a person at a desk/);
    // The same pick as a parameter and as the browser's header narrows it alike.
    const asked = await s.get(tokens.ann, '/views/visits?chosen.site=1&sort=id');
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.deepEqual(s.ids(asked.body), options.policy ? ['10'] : ['10', '12']);
    const header = await s.get(tokens.ann, '/views/visits?sort=id', { 'x-mistri-chosen': 'site=1' });
    assert.deepEqual(s.ids(header.body), s.ids(asked.body));
    // A site no row has, or a key the token's reach does not hold, is null and matches no row; never an error.
    const missing = await s.get(tokens.ann, '/views/visits?chosen.site=99');
    assert.equal(missing.status, 200, JSON.stringify(missing.body));
    assert.deepEqual(s.ids(missing.body), []);
    if (options.policy) {
      // Ann may read North only: South is null for her token, though bob reads it.
      assert.deepEqual(s.ids((await s.get(tokens.ann, '/views/visits?chosen.site=2')).body), []);
      assert.deepEqual(s.ids((await s.get(tokens.bob, '/views/visits?chosen.site=2')).body), ['11']);
      assert.deepEqual(s.ids((await s.get(tokens.bob, '/views/visits?chosen.site=1')).body), []);
    } else assert.deepEqual(s.ids((await s.get(tokens.bob, '/views/visits?chosen.site=2')).body), ['11']);
    // A key the table cannot hold, and a name the App does not declare, are the caller's mistake.
    const bad = await s.get(tokens.ann, '/views/visits?chosen.site=north');
    assert.equal(bad.status, 422, JSON.stringify(bad.body));
    assert.equal(bad.body.error.code, 'chosen_invalid');
    assert.match(bad.body.error.message, /chosen\.site/);
    const undeclared = await s.get(tokens.ann, '/views/visits?chosen.site=1&chosen.region=3');
    assert.equal(undeclared.status, 422, JSON.stringify(undeclared.body));
    assert.equal(undeclared.body.error.code, 'chosen_invalid');
    assert.match(JSON.stringify(undeclared.body), /names no choice/);
  });

  test(`a command's body or header picks reach ctx.chosen, read again under the token (${kind})`, { timeout: 180000 }, async (t) => {
    const f = await desk(t, options);
    const s = await serve(t, f, options);
    const first = await s.run(f.tokens.ann, 10, 'choose-note-body-0001', { chosen: { site: '1' } });
    assert.equal(first.status, 200, first.body + s.served.output());
    assert.equal(f.note(10), 'site 1');
    // The header form, as the browser sends it, for one client library on every door.
    const second = await s.run(f.tokens.ann, 10, 'choose-note-header-0002', {}, { 'x-mistri-chosen': 'site=1' });
    assert.equal(second.status, 200, second.body);
    assert.equal(f.note(10), 'site 1');
    // No pick at all: nothing is chosen for a token, not what someone stored.
    const nothing = await s.run(f.tokens.ann, 10, 'choose-note-none-00003', {});
    assert.equal(nothing.status, 200, nothing.body);
    assert.equal(f.note(10), 'none');
    // A pick the token cannot read is null, which a handler sees as nothing chosen.
    if (options.policy) {
      const hidden = await s.run(f.tokens.ann, 10, 'choose-note-hidden-0004', { chosen: { site: '2' } });
      assert.equal(hidden.status, 200, hidden.body);
      assert.equal(f.note(10), 'none');
    }
    const bad = await s.run(f.tokens.ann, 10, 'choose-note-bad-000005', { chosen: { site: 'north' } });
    assert.equal(bad.status, 422, bad.body);
    assert.match(bad.body, /chosen_invalid/);
    const undeclared = await s.run(f.tokens.ann, 10, 'choose-note-region-0006', { chosen: { region: '3' } });
    assert.equal(undeclared.status, 422, undeclared.body);
    assert.match(undeclared.body, /chosen_invalid/);
  });

  test(`App MCP lists chosen and a call with it narrows (${kind})`, { timeout: 180000 }, async (t) => {
    const f = await desk(t, options);
    const s = await serve(t, f, options);
    assert.equal(
      (
        await s.rpc(f.tokens.ann, 'initialize', {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'x', version: '0' },
        })
      ).status,
      200,
    );
    const tools = (await s.rpc(f.tokens.ann, 'tools/list')).body.result.tools as {
      name: string;
      inputSchema: { properties: Record<string, unknown> };
    }[];
    const list = tools.find((tool) => tool.name.startsWith('view_visits')) ?? assert.fail(JSON.stringify(tools.map((tool) => tool.name)));
    assert.ok(list.inputSchema.properties.chosen, JSON.stringify(list.inputSchema));
    assert.match(JSON.stringify(list.inputSchema.properties.chosen), /site/);
    const command = tools.find((tool) => /run_annotate/.test(tool.name)) ?? assert.fail(JSON.stringify(tools.map((tool) => tool.name)));
    assert.ok(command.inputSchema.properties.chosen, JSON.stringify(command.inputSchema));
    const call = async (args: object) =>
      (await s.rpc(f.tokens.ann, 'tools/call', { name: list.name, arguments: args })).body.result as {
        isError?: boolean;
        structuredContent?: { items: { id: string }[] };
      };
    const without = await call({});
    assert.equal(without.isError, true, JSON.stringify(without));
    const narrowed = await call({ chosen: { site: '1' } });
    assert.ok(!narrowed.isError, JSON.stringify(narrowed));
    assert.deepEqual(narrowed.structuredContent!.items.map((row) => row.id).sort(), options.policy ? ['10'] : ['10', '12']);
    assert.equal((await call({ chosen: { site: 'north' } })).isError, true);
  });

  test(`the published OpenAPI names chosen for an App that declares choose (${kind})`, { timeout: 180000 }, async (t) => {
    const f = await desk(t, options);
    const s = await serve(t, f, options);
    const served = await s.get(f.tokens.ann, '/$openapi');
    assert.equal(served.status, 200);
    const document = JSON.stringify(served.body);
    assert.match(document, /chosen\.site/);
    assert.match(document, /CommandBody_/);
    assert.match(document, /x-mistri-chosen/);
    assert.match(document, /chosen_invalid/);
  });
}

test('an App that declares no choose lists no chosen anywhere in its API', { timeout: 180000 }, async (t) => {
  const f = await desk(t, { choose: false });
  const s = await serve(t, f, {});
  const served = await s.get(f.tokens.ann, '/$openapi');
  assert.equal(served.status, 200);
  const document = JSON.stringify(served.body);
  assert.doesNotMatch(document, /chosen|CommandBody_/);
  await s.rpc(f.tokens.ann, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '0' } });
  const tools = (await s.rpc(f.tokens.ann, 'tools/list')).body.result.tools;
  assert.doesNotMatch(JSON.stringify(tools), /chosen/);
  // A read that names one is refused: there is no choice for it to mean.
  const refused = await s.get(f.tokens.ann, '/views/visits?chosen.site=1');
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, 'chosen_invalid');
});

test(
  'the generated client types a choose App: chosen.<name> is a read parameter and a command body field',
  { timeout: 180000 },
  async (t) => {
    const f = await desk(t, {});
    const s = await serve(t, f, {});
    const served = await s.get(f.tokens.ann, '/$openapi');
    assert.equal(served.status, 200);
    const source = renderApiClient(served.body);
    assert.match(source, /export type CommandBody\w* = \{[^}]*chosen\?:/s);
    assert.match(source, /chosen\.site/);
    // The names it wrote are valid TypeScript: the file typechecks, strictly.
    const file = join(tmpdir(), `tw-choose-client-${process.pid}.ts`);
    writeFileSync(file, source);
    t.after(() => rmSync(file, { force: true }));
    const checked = await new Promise<{ code: number; out: string }>((done) =>
      execFile(
        process.execPath,
        [
          resolve(ROOT, 'node_modules/typescript/bin/tsc'),
          '--ignoreConfig',
          '--noEmit',
          '--strict',
          '--target',
          'es2022',
          '--module',
          'esnext',
          '--moduleResolution',
          'bundler',
          '--lib',
          'es2022,dom',
          '--types',
          '',
          file,
        ],
        { timeout: 120000 },
        (error, out, err) => done({ code: Number(error?.code ?? 0), out: out + err }),
      ),
    );
    assert.equal(checked.code, 0, checked.out);
  },
);
