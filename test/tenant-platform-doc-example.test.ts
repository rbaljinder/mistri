/**
 * The tenant docs' `seedDesk` example (site/src/content/docs/docs/tenant-apps.md,
 * "The platform realm"), built as written and driven end to end through the
 * production CLI: `mistri check`, then the served App, a platform operator
 * signed in natively, the platform lease opened, the form's command prepared
 * and submitted over HTTP. A field report found the documented shape passing
 * check and rendering, then refused at prepare; this is the proof it runs.
 *
 * Negative proofs beside it: a tenant's member cannot run it, in their tenant
 * or by asking for the platform realm; and the command writes only the tenant
 * its input names.
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { TENANT_HTTP_HEADERS as tenantHeaders } from '../packages/mistri/src/shared/tenantContext.js';
import { scratch } from './support/scratch.js';
import { VALIDATE, validating } from './support/validation.js';

const entry = resolve('packages/mistri/src/server/index.ts');
const appId = 'desk';
const binding = { appId, source: { id: 'business', connection: 'business-db' }, storeId: 'desk-tenants' };

/* The checkout's own modules by URL, where an App imports `@mistriwork/mistri/commands` and `@mistriwork/mistri/policy`: a temporary
   directory resolves no package. `.mts` and `.mjs`, since it has no package.json either. */
const source = (path: string) => pathToFileURL(resolve(path)).href;
/** The docs' command, character for character but for its module's imports. `read` is what the first version of the
    example left out: the row it inserts points at its customer, which a scoped write proves readable. */
const COMMANDS = (
  read = "\n    read: ['customer'],",
) => `import { defineCommand, defineCommands } from '${source('packages/mistri/src/server/commands/businessCommands.ts')}';

export default defineCommands({
  seedDesk: defineCommand({
    realm: 'platform',
    tenant: 'customer_id',
    source: 'business',
    target: 'desk_setting',
    targets: 'none',${read}
    input: { customer_id: { label: 'Customer', type: 'text' } },
    async handle({ db }) {
      await db.desk_setting.insert({ id: 'default', timezone: 'UTC' });
    },
  }),
});
`;
const POLICY = `import { defineAppTenantPolicy } from '${source('packages/mistri/src/server/policy/appTenantPolicy.ts')}';

export default defineAppTenantPolicy({
  kind: 'tenant',
  appId: ${JSON.stringify(appId)},
  storeId: ${JSON.stringify(binding.storeId)},
  ownership: { customer: { kind: 'platform' }, desk_setting: { kind: 'tenant', column: 'tenant_id' } },
  resolveMembershipRows: () => ({ desk_setting: true }),
  resolveRows: () => ({ desk_setting: true }),
  resolvePlatformRows: () => ({ customer: true, desk_setting: true }),
  resultReferences: { seedDesk: () => [] },
});
`;

/** `provisioned: false` leaves the stores to `mistri migrate stores up`, which finds the commands beside the App. */
function fixture(t: TestContext, commands = COMMANDS(), { provisioned = true } = {}) {
  const { directory, stopping } = scratch(t, 'tablewalk-tenant-platform-doc-');
  const appDir = join(directory, 'app');
  mkdirSync(appDir);
  const data = join(directory, 'data.db'),
    auth = join(directory, 'auth.db'),
    config = join(directory, 'config.json');
  const db = new DatabaseSync(data);
  // One opaque text id per tenant's row would also do; here the key includes the ownership column (tenant-apps.md).
  db.exec(`CREATE TABLE customer (id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE desk_setting (id TEXT NOT NULL, tenant_id TEXT NOT NULL REFERENCES customer(id), timezone TEXT NOT NULL,
      PRIMARY KEY (tenant_id, id));
    INSERT INTO customer VALUES ('acme', 'Acme'), ('globex', 'Globex');`);
  db.close();
  if (provisioned) {
    provisionSqliteTenantStore(data, binding);
    migrateSqliteCommandJournal(data);
  }
  writeFileSync(
    join(appDir, 'app.json'),
    JSON.stringify({
      id: appId,
      name: 'Desk',
      auth: {
        store: auth,
        signUp: 'open',
        rows: 'tenant',
        tenancy: { label: 'Customer', profile: 'customer', platform: { label: 'Operator' } },
        roles: {
          agent: { realm: 'tenant', read: true },
          operator: { realm: 'platform', read: true, commands: ['seedDesk'] },
        },
      },
      sources: { business: { connection: binding.source.connection } },
      resources: { customer: { owner: 'platform' }, desk_setting: { owner: 'tenant', access: 'write' } },
      views: {
        settings: { kind: 'list', from: 'desk_setting', label: 'Settings' },
        customers: { kind: 'list', from: 'customer', label: 'Customers', realm: 'platform' },
        seed: { kind: 'form', label: 'Seed a desk', command: 'seedDesk', realm: 'platform' },
      },
      home: 'settings',
      nav: [
        { id: 'desk', label: 'Desk', realm: 'tenant', children: ['settings'] },
        { id: 'operations', label: 'Operations', realm: 'platform', children: ['customers', 'seed'] },
      ],
    }),
  );
  writeFileSync(provisioned ? join(directory, 'commands.mts') : join(appDir, 'commands.mjs'), commands);
  writeFileSync(join(directory, 'tenant-policy.mjs'), POLICY);
  writeFileSync(config, JSON.stringify({ connections: [{ name: binding.source.connection, url: data, writable: true }] }));
  const env = {
    ...process.env,
    DATABASE_URL: '',
    MISTRI_OPEN: '0',
    MISTRI_PUBLIC_URL: '',
    BETTER_AUTH_SECRET: 'synthetic-tenant-platform-doc-secret-at-least-thirty-two',
    MISTRI_AUTH_ADMIN_EMAIL: '',
    MISTRI_AUTH_ADMIN_PASSWORD: '',
    MISTRI_DIAGNOSTICS: '',
    MISTRI_TEST_AUTH_LIMITS: 'off',
    XDG_CONFIG_HOME: join(directory, 'xdg'),
  };
  const args = [
    '--import',
    'tsx',
    entry,
    '--config',
    config,
    '--app',
    appDir,
    '--policy',
    join(directory, 'tenant-policy.mjs'),
    ...(provisioned ? ['--commands', join(directory, 'commands.mts')] : []),
  ];
  return { directory, appDir, data, config, env, args, stopping };
}
type Fixture = ReturnType<typeof fixture>;

function check(f: Fixture) {
  const child = validating([VALIDATE], f.env);
  return new Promise<{ code: number; stdout: string; stderr: string }>((done) =>
    execFile(process.execPath, f.args, { env: child.env, timeout: 30000 }, (error, stdout, stderr) =>
      done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }),
    ),
  );
}
async function port() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
  return address.port;
}
async function launch(f: Fixture) {
  const number = await port(),
    origin = `http://127.0.0.1:${number}`;
  const child = spawn(process.execPath, [...f.args, '--port', String(number)], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => (output += String(chunk)));
  const ended = once(child, 'exit');
  f.stopping(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await ended;
  });
  for (let tries = 0; tries < 600; tries++) {
    if (output.includes('Listening on')) return { origin, output: () => output };
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(output);
    await delay(50);
  }
  child.kill('SIGKILL');
  throw new Error(`The doc example never listened: ${output}`);
}

/** The served App, an operator on the platform and an agent of acme, each signed in. */
async function served(t: TestContext) {
  const f = fixture(t);
  const live = await launch(f);
  const call = (path: string, init: RequestInit = {}) => fetch(live.origin + path, { ...init, signal: AbortSignal.timeout(10000) });
  const signUp = async (name: string) => {
    const reply = await call('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { origin: live.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name, email: `${name}@desk.example.test`, password: `Disposable-${name}-password-123!` }),
    });
    assert.equal(reply.status, 200, await reply.clone().text());
    const body = (await reply.json()) as { user: { id: string } };
    return { cookie: reply.headers.get('set-cookie')!.split(';')[0], accountId: body.user.id };
  };
  const operator = await signUp('operator'),
    agent = await signUp('agent');
  const db = new DatabaseSync(f.data);
  const operations = new TransactionOperations();
  db.exec('BEGIN IMMEDIATE');
  try {
    const admin = createSqliteTenantAdministration(db, operations, binding);
    const grant = { status: 'active' as const, validUntil: Date.now() + 3_600_000, expectedVersion: null };
    for (const tenantId of ['acme', 'globex']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putMembership({ ...grant, tenantId: 'acme', accountId: agent.accountId, membershipId: 'acme-agent', roles: ['agent'] });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
    await admin.putPlatformMembership({ ...grant, accountId: operator.accountId, membershipId: 'platform-operator', roles: ['operator'] });
    await operations.finish();
    db.exec('COMMIT');
  } catch (error) {
    await operations.finish().catch(() => {});
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
  type Who = typeof operator;
  /** A lease, opened as the browser opens it: `realm=platform`, or one tenant. */
  const lease = async (who: Who, where: { realm: 'platform' } | { tenant: string }) => {
    const query = new URLSearchParams({ app: appId, ...where });
    const headers = { cookie: who.cookie, origin: live.origin, 'content-type': 'application/json', [tenantHeaders.account]: who.accountId };
    const opened = await call(`/api/tenant/context/open?${query}`, { method: 'POST', headers, body: '{}' });
    const reply = (await opened.json()) as Record<string, unknown>;
    return {
      status: opened.status,
      post: async (path: string, body: unknown) => {
        const answer = await call(`${path}?${query}`, {
          method: 'POST',
          headers: {
            ...headers,
            [tenantHeaders.app]: String(reply.appId),
            [tenantHeaders.tab]: String(reply.tabId),
            [tenantHeaders.context]: String(reply.context),
            [tenantHeaders.revision]: String(reply.revision),
          },
          body: JSON.stringify(body),
        });
        const text = await answer.text();
        return { status: answer.status, text, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
      },
    };
  };
  const rows = () => {
    const reader = new DatabaseSync(f.data, { readOnly: true });
    try {
      return reader
        .prepare('SELECT tenant_id, id, timezone FROM desk_setting ORDER BY tenant_id, id')
        .all()
        .map((row) => ({ ...row }));
    } finally {
      reader.close();
    }
  };
  return { f, live, operator, agent, lease, rows };
}

const submit = (customer: string, key: string) => ({
  command: 'seedDesk',
  commandVersion: 1,
  key: {},
  expectedVersion: 0,
  idempotencyKey: `${key}-${'0'.repeat(16)}`,
  input: { customer_id: customer },
});

test('mistri check accepts the docs’ seedDesk example as written', { timeout: 60000 }, async (t) => {
  const result = await check(fixture(t));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Desk: ok/);
});

test('mistri check names the read a tenant-named platform command is missing, and the fix', { timeout: 60000 }, async (t) => {
  const result = await check(fixture(t, COMMANDS('')));
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /Command "seedDesk" writes "desk_setting" in the tenant its "customer_id" input names, and "desk_setting".tenant_id references "customer", which the command does not read: .* Add read: \['customer'\] to "seedDesk"\./,
  );
});

/* The ritual the tenant docs give: check names the absent stores and the one command that makes them, that command
   makes them, a second run finds them, and check then passes. */
test('migrate stores up --policy provisions what a tenant App needs, and check names it when absent', { timeout: 90000 }, async (t) => {
  const f = fixture(t, COMMANDS(), { provisioned: false });
  const before = await check(f);
  assert.equal(before.code, 1, before.stdout + before.stderr);
  assert.match(before.stderr, /Stores this App needs are absent: tenant-store, command-journal\./);
  const command = /Make them with: (mistri migrate stores up .*)/.exec(before.stderr)?.[1] ?? '';
  assert.match(command, /--app \S+ --policy \S+tenant-policy\.mjs --config \S+config\.json$/);
  const up = () =>
    new Promise<{ code: number; stdout: string; stderr: string }>((done) =>
      execFile(
        process.execPath,
        ['--import', 'tsx', entry, ...command.split(' ').slice(1)],
        { env: f.env, timeout: 30000 },
        (error, stdout, stderr) => done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }),
      ),
    );
  const made = await up();
  assert.equal(made.code, 0, made.stdout + made.stderr);
  assert.match(made.stdout, /business-db: tenant-store v\d+ provisioned/);
  assert.match(made.stdout, /business-db: command journal v\d+ provisioned/);
  const again = await up();
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /tenant-store v\d+ present/);
  assert.match(again.stdout, /command journal v\d+ present/);
  const after = await check(f);
  assert.equal(after.code, 0, after.stdout + after.stderr);
});

test('without --policy, migrate stores up says a tenant App needs it to provision', { timeout: 60000 }, async (t) => {
  const f = fixture(t, COMMANDS(), { provisioned: false });
  const result = await new Promise<{ code: number; stdout: string }>((done) =>
    execFile(
      process.execPath,
      ['--import', 'tsx', entry, 'migrate', 'stores', 'up', '--app', f.appDir, '--config', f.config],
      { env: f.env, timeout: 30000 },
      (error, stdout) => done({ code: error ? 1 : 0, stdout }),
    ),
  );
  assert.equal(result.code, 0);
  assert.match(result.stdout, /a tenant App's stores are bound to its policy: add --policy <file> to provision them\./);
});

test('a platform operator prepares and submits seedDesk, and it writes only the tenant it names', { timeout: 90000 }, async (t) => {
  const s = await served(t);
  const platform = await s.lease(s.operator, { realm: 'platform' });
  assert.equal(platform.status, 200);
  const prepared = await platform.post('/api/commands/prepare', { command: 'seedDesk', commandVersion: 1, key: {} });
  assert.equal(prepared.status, 200, prepared.text);
  const done = await platform.post('/api/commands/execute', submit('acme', 'seed-acme-0001'));
  assert.equal(done.status, 200, done.text + s.live.output());
  assert.equal(done.body.status, 'applied', done.text);
  // The other tenant is untouched, and a second tenant is seeded as its own.
  assert.deepEqual(s.rows(), [{ tenant_id: 'acme', id: 'default', timezone: 'UTC' }]);
  const globex = await platform.post('/api/commands/execute', submit('globex', 'seed-globex-0001'));
  assert.equal(globex.status, 200, globex.text);
  assert.deepEqual(s.rows(), [
    { tenant_id: 'acme', id: 'default', timezone: 'UTC' },
    { tenant_id: 'globex', id: 'default', timezone: 'UTC' },
  ]);
  // A tenant nobody provisioned, and the platform itself, are refused, and nothing lands.
  for (const customer of ['initech', '@platform']) {
    const refused = await platform.post('/api/commands/execute', submit(customer, `seed-${customer.replace('@', '')}-0001`));
    assert.ok(refused.status >= 400, refused.text);
  }
  assert.equal(s.rows().length, 2);
});

test("a tenant's member never runs the platform's seedDesk", { timeout: 90000 }, async (t) => {
  const s = await served(t);
  const acme = await s.lease(s.agent, { tenant: 'acme' });
  assert.equal(acme.status, 200);
  for (const path of ['/api/commands/prepare', '/api/commands/execute']) {
    const refused = await acme.post(path, submit('acme', 'agent-acme-0001'));
    assert.equal(refused.status, 403, refused.text);
  }
  // Nor by asking for the platform realm: a member of a tenant holds no platform membership.
  const platform = await s.lease(s.agent, { realm: 'platform' });
  assert.notEqual(platform.status, 200);
  const refused = await platform.post('/api/commands/execute', submit('globex', 'agent-globex-0001'));
  assert.ok(refused.status >= 400, refused.text);
  assert.deepEqual(s.rows(), []);
});

/* `mistri dev` keeps its record in the App's .mistri/ and rewrites it on every start; the tenant watcher took
   that for a deployment edit and restarted the App forever. */
test('mistri dev serves the tenant App and does not restart over its own state', { timeout: 90000 }, async (t) => {
  const f = fixture(t);
  const number = await port();
  const env = Object.fromEntries(Object.entries(f.env).filter(([name]) => !/^(BETTER_AUTH_SECRET|MISTRI_AUTH_ADMIN_)/.test(name)));
  const [, , , ...rest] = f.args;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', entry, 'dev', f.appDir, ...rest.filter((arg) => arg !== '--app' && arg !== f.appDir), '--port', String(number)],
    {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => (output += String(chunk)));
  const ended = once(child, 'exit');
  f.stopping(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await ended;
  });
  for (let tries = 0; tries < 600 && !output.includes('Listening on'); tries++) {
    if (child.exitCode !== null) break;
    await delay(50);
  }
  assert.match(output, /Listening on/);
  await delay(1500);
  assert.equal(child.exitCode, null, output);
  assert.doesNotMatch(output, /restart with the new configuration/);
});
