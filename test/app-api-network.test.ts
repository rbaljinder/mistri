/** The App API and App MCP beyond loopback, through the real CLI over SQLite:
 * the two-sided opt-in (the App's `api.network`, the operator's listener),
 * scope enforced per operation on HTTP and on `…/$mcp`, the per-token and
 * per-address budgets (429 with Retry-After), `api.publicSpec` on and off,
 * and a composite primary key read and written. The listener stays on
 * 127.0.0.1 — `--allowed-host` is what makes it a network exposure — so no
 * test ever answers another machine. Each case builds its own App directory,
 * native auth store and issued tokens, and kills what it starts. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { loadBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandLoader.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { provisionStores } from '../packages/mistri/src/server/maintenance.js';
import { provisionSqliteApiTokenStore } from '../packages/mistri/src/server/auth/provisionSqliteApiTokenStore.js';
import { issueSqliteApiCommandToken } from '../packages/mistri/src/server/auth/sqliteApiTokenMaintenance.js';
import { captureAuthStoreExclusion } from '../packages/mistri/src/server/auth/authStoreSeparation.js';
import { ROOT, SESSION_SECRET, childEnv, cliArgs, freePort, runCli } from './appApiCli.js';
import { SHOP_TABLES, writeShopApp } from './appApiShop.js';

const storeId = '7d3f2e74-9e3a-4e77-9a2c-6c5a5a2e4f33';
const HOST = 'api.example.test';
const PART =
  'CREATE TABLE part(order_id INTEGER NOT NULL, line INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL, PRIMARY KEY(order_id, line)); ' +
  "INSERT INTO part(order_id, line, name) VALUES (1, 1, 'Bolt'), (1, 2, 'Nut')";

/** The shop App with a composite-key `part` the operator may read and update,
 * and `api` widened by `api` (network, publicSpec). */
async function shop(t: TestContext, api: Record<string, unknown>) {
  const directory = mkdtempSync(join(tmpdir(), 'tw-api-network-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const business = join(directory, 'business.db'),
    authPath = join(directory, 'auth.db');
  const db = new DatabaseSync(business);
  try {
    db.exec(`${SHOP_TABLES}; ${PART}`);
  } finally {
    db.close();
  }
  migrateSqliteCommandJournal(business);
  await provisionStores({ sqlite: business }, { app: { id: 'shop', source: 'business' } });
  const { appDir, config, commands } = writeShopApp(directory, { business, authStore: authPath });
  const file = join(appDir, 'app.json');
  const app = JSON.parse(readFileSync(file, 'utf8'));
  app.resources.part = { access: 'write' };
  app.auth.roles.operator.read.push('part');
  app.auth.roles.operator.write.push('part');
  app.auth.roles.operator.fields.part = { read: ['order_id', 'line', 'revision', 'name'], write: ['name'] };
  app.api = {
    ...app.api,
    ...api,
    resources: { ...app.api.resources, part: { fields: ['order_id', 'line', 'revision', 'name'], sorts: ['order_id'], update: true } },
  };
  writeFileSync(file, JSON.stringify(app));
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
    accounts
      .prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES (?,?,?,1,?,?,?,0)')
      .run('operator', 'operator', 'operator@example.test', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'operator');
  } finally {
    accounts.close();
  }
  const exclusions = [captureAuthStoreExclusion(business)];
  provisionSqliteApiTokenStore(authPath, { appId: 'shop', storeId, exclusions });
  const registry = new Registry();
  registry.add({ id: 'data', name: 'data', url: business, writable: true, source: 'config' });
  const tokens: Record<string, string> = {};
  try {
    const resources = await loadAppRuntimeResources(registry, loaded.app, 'data');
    const evidence = { connectionFor: resources.connectionFor, writableConnection: () => true, transactionalConnection: () => true };
    const declared = await loadBusinessCommands(commands);
    const issue = (operations?: readonly string[]) =>
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
          label: 'network',
          expiresAt: Date.now() + 600000,
          ...(operations ? { operations } : {}),
        },
        Date.now(),
      ).token;
    tokens.operator = issue();
    tokens.readsOnly = issue(['item:part', 'list:part']);
    tokens.burst = issue(['list:part']);
  } finally {
    await registry.closeAll();
  }
  const row = (sql: string) => {
    const check = new DatabaseSync(business, { readOnly: true });
    try {
      return { ...check.prepare(sql).get() };
    } finally {
      check.close();
    }
  };
  return { appDir, config, commands, tokens, row };
}

/** The real CLI with the App API on, at `rate` requests a minute; `extra`
 * are the listener flags. Resolves once listening, with its startup output. */
async function serve(t: TestContext, f: { config: string; appDir: string; commands: string }, rate: number, extra: readonly string[]) {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    cliArgs([
      '--config',
      f.config,
      '--app',
      f.appDir,
      '--commands',
      f.commands,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      ...extra,
      '--api-reads',
      '--api-integers',
      'decimal-string',
      '--api-requests-per-minute',
      String(rate),
    ]),
    { cwd: ROOT, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  const closed = new Promise<void>((done) => child.once('close', () => done()));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    await closed;
    clearTimeout(timer);
  });
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`readiness timeout: ${output}`)), 60000);
    const inspect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-16000);
      // The API line follows the address lines, on the same tick.
      if (output.includes('Listening on http://') && output.includes(' API at ')) {
        clearTimeout(timer);
        done();
      }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('close', () => {
      clearTimeout(timer);
      fail(new Error(`closed before listening: ${output}`));
    });
  });
  return { port, output: () => output };
}

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; text: string; json(): any };

/** One request over node:http, which, unlike fetch, may name the Host a proxy would forward. */
function call(
  port: number,
  path: string,
  options: { method?: string; host?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<Reply> {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((done, fail) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/apps/shop/v1${path}`,
        method: options.method ?? 'GET',
        headers: {
          host: options.host ?? `127.0.0.1:${port}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          done({ status: res.statusCode!, headers: res.headers, text, json: () => JSON.parse(text) });
        });
      },
    );
    req.on('error', fail);
    req.end(body);
  });
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
let rpc = 0;
const mcp = (port: number, token: string | undefined, method: string, params: object = {}) =>
  call(port, '/$mcp', {
    method: 'POST',
    host: HOST,
    headers: token === undefined ? {} : bearer(token),
    body: { jsonrpc: '2.0', id: ++rpc, method, params },
  });

test('beyond loopback needs the App to declare api.network: the operator alone is refused at startup', { timeout: 120000 }, async (t) => {
  const f = await shop(t, {});
  const port = await freePort();
  const refused = await runCli(
    [
      '--config',
      f.config,
      '--app',
      f.appDir,
      '--commands',
      f.commands,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--allowed-host',
      HOST,
      '--api-reads',
      '--api-integers',
      'decimal-string',
      '--api-requests-per-minute',
      '60',
    ],
    childEnv(),
  );
  assert.equal(refused.code, 1);
  assert.match(refused.err, /beyond loopback .* only for an App whose api declares network: true/);
  assert.doesNotMatch(refused.out, /Listening on/);
});

test(
  'without publicSpec the document needs a token; on loopback a foreign Host is refused before any credential is read',
  { timeout: 120000 },
  async (t) => {
    const f = await shop(t, {});
    const s = await serve(t, f, 60, []);
    assert.match(
      s.output(),
      /"Shop" API at \/api\/apps\/shop\/v1 \(MCP at \/api\/apps\/shop\/v1\/\$mcp\) on loopback: scoped bearer tokens only/,
    );
    const anonymous = await call(s.port, '/$openapi');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers['www-authenticate'], 'Bearer');
    assert.equal((await call(s.port, '/$openapi', { headers: bearer(f.tokens.operator) })).status, 200);
    assert.equal((await call(s.port, '/part', { host: HOST, headers: bearer(f.tokens.operator) })).status, 403);
    assert.equal((await mcp(s.port, f.tokens.operator, 'ping')).status, 403);
  },
);

test(
  'api.network with an allowed host: scoped tokens on HTTP and $mcp, a public document, composite keys, and both budgets',
  { timeout: 180000 },
  async (t) => {
    const f = await shop(t, { network: true, publicSpec: true });
    const rate = 20;
    const s = await serve(t, f, rate, ['--allowed-host', HOST]);
    assert.match(
      s.output(),
      /"Shop" API at \/api\/apps\/shop\/v1 .* beyond loopback: scoped bearer tokens only; 20 requests a minute per token, counted in this process\. Terminate TLS in front of it\./,
    );
    const operator = { host: HOST, headers: bearer(f.tokens.operator) };

    // The published document: every operation, the composite key as one parameter, nothing of who may call it.
    const published = await call(s.port, '/$openapi', { host: HOST });
    assert.equal(published.status, 200, published.text);
    const document = published.json();
    assert.ok(
      Object.keys(document.paths).some((path) => path.includes('/part/{key}/commands/update-part/v1')),
      published.text,
    );
    assert.doesNotMatch(published.text, /x-mistri-eligible-roles|x-mistri-standing-contract/);
    // A credential presented is a credential checked: a bad one is never quietly given the public copy.
    const forged = await call(s.port, '/$openapi', { host: HOST, headers: bearer('twa1.00000000-0000-4000-8000-000000000000.forged') });
    assert.equal(forged.status, 401);
    // A Host the operator did not allow is refused, however good the token.
    assert.equal((await call(s.port, '/part', { host: 'evil.example.test', headers: bearer(f.tokens.operator) })).status, 403);

    // A composite key, read and written by its column=value pairs.
    const read = await call(s.port, '/part/order_id=1,line=2', operator);
    assert.equal(read.status, 200, read.text);
    assert.equal(read.json().name, 'Nut');
    const prepared = await call(s.port, '/part/order_id=1,line=2/commands/update-part/v1/prepare', operator);
    assert.equal(prepared.status, 200, prepared.text);
    const updated = await call(s.port, '/part/order_id=1,line=2/commands/update-part/v1', {
      method: 'POST',
      host: HOST,
      headers: { ...bearer(f.tokens.operator), 'if-match': String(prepared.headers.etag), 'idempotency-key': 'network-attempt-0001' },
      body: { name: 'Lock nut' },
    });
    assert.equal(updated.status, 200, updated.text);
    assert.deepEqual(f.row('SELECT name FROM part WHERE order_id = 1 AND line = 2'), { name: 'Lock nut' });
    assert.deepEqual(f.row('SELECT name FROM part WHERE order_id = 1 AND line = 1'), { name: 'Bolt' });

    // Scope, per operation: a reads-only token reads, and its write is refused before anything runs.
    assert.equal((await call(s.port, '/part/order_id=1,line=1', { host: HOST, headers: bearer(f.tokens.readsOnly) })).status, 200);
    const outOfScope = await call(s.port, '/part/order_id=1,line=1/commands/update-part/v1', {
      method: 'POST',
      host: HOST,
      headers: { ...bearer(f.tokens.readsOnly), 'if-match': '"0"', 'idempotency-key': 'network-attempt-0002' },
      body: { name: 'Washer' },
    });
    assert.equal(outOfScope.status, 403, outOfScope.text);
    assert.deepEqual(f.row('SELECT name FROM part WHERE order_id = 1 AND line = 1'), { name: 'Bolt' });

    // The same scope on $mcp: the handshake needs a token the owner observes, and each call is the owner's to authorize.
    const handshake = await mcp(s.port, undefined, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'x', version: '0' },
    });
    assert.equal(handshake.status, 401);
    assert.equal(handshake.headers['www-authenticate'], 'Bearer');
    const unknownToken = await mcp(s.port, 'twa1.00000000-0000-4000-8000-000000000000.forged', 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'x', version: '0' },
    });
    assert.equal(unknownToken.status, 401, unknownToken.text);
    const init = await mcp(s.port, f.tokens.readsOnly, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'x', version: '0' },
    });
    assert.equal(init.status, 200, init.text);
    assert.equal(init.json().result.serverInfo.name, 'mistri-app');
    const narrow = (await mcp(s.port, f.tokens.readsOnly, 'tools/list')).json().result.tools as { name: string }[];
    const wide = (await mcp(s.port, f.tokens.operator, 'tools/list')).json().result.tools as { name: string }[];
    const update = wide.find((tool) => tool.name.includes('update') && tool.name.includes('part'))?.name;
    assert.ok(update, JSON.stringify(wide));
    assert.ok(!narrow.some((tool) => tool.name === update), JSON.stringify(narrow));
    const get = narrow.find((tool) => tool.name.startsWith('get_'))!.name;
    const got = (
      await mcp(s.port, f.tokens.readsOnly, 'tools/call', { name: get, arguments: { key: { order_id: '1', line: '1' } } })
    ).json();
    assert.equal(got.result.isError, false, JSON.stringify(got));
    const refused = (
      await mcp(s.port, f.tokens.readsOnly, 'tools/call', {
        name: update,
        arguments: { key: { order_id: '1', line: '1' }, version: 0, idempotencyKey: 'network-attempt-0003', input: { name: 'Washer' } },
      })
    ).json();
    assert.equal(refused.result.isError, true, JSON.stringify(refused));
    assert.deepEqual(f.row('SELECT name FROM part WHERE order_id = 1 AND line = 1'), { name: 'Bolt' });

    // The token's own budget: `rate` a minute, then 429 with Retry-After; another token is unaffected.
    const burst = { host: HOST, headers: bearer(f.tokens.burst) };
    for (let n = 0; n < rate; n++) assert.equal((await call(s.port, '/part', burst)).status, 200, `request ${n + 1}`);
    const over = await call(s.port, '/part', burst);
    assert.equal(over.status, 429);
    assert.ok(Number(over.headers['retry-after']) > 0, String(over.headers['retry-after']));
    assert.equal((await call(s.port, '/part', operator)).status, 200);

    // The address's budget for what it does unauthenticated, spent last: once it
    // is gone, no-token requests and refused tokens wait; a valid token from the
    // same address — a shared NAT or proxy — is judged by its own budget alone.
    let limited: Reply | undefined;
    for (let n = 0; n <= rate && !limited; n++) {
      const reply = await call(s.port, '/part', { host: HOST });
      if (reply.status === 429) limited = reply;
      else assert.equal(reply.status, 401);
    }
    assert.ok(limited, 'unauthenticated requests from one address are budgeted');
    assert.ok(Number(limited.headers['retry-after']) > 0);
    assert.equal((await call(s.port, '/part', operator)).status, 200);
    assert.equal((await mcp(s.port, f.tokens.operator, 'ping')).status, 200);
    // A well-formed secret under a real token ID (one character of its middle
    // changed; a malformed one counts as no credential): the owner refuses it.
    const at = 60,
      tampered = f.tokens.operator.slice(0, at) + (f.tokens.operator[at] === 'A' ? 'B' : 'A') + f.tokens.operator.slice(at + 1);
    const refusedLater = await call(s.port, '/part', { host: HOST, headers: bearer(tampered) });
    assert.equal(refusedLater.status, 401, 'a presented credential is still checked, and still refused');
    assert.equal((await mcp(s.port, undefined, 'ping')).status, 429);
  },
);
