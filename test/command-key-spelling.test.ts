/**
 * A record page reached by its address spells an integer key as its digits
 * (`{"id":"3"}`); one reached from a list's card spells it as a number
 * (`{"id":3}`). Both name the same row, and a command prepares and runs on it
 * either way, in each realm: a plain App's, a tenant's and the platform's.
 * The tenant command transaction once compared the row it read with the key
 * as given, strictly, so `"3"` was not `3` and the platform's prepare was
 * refused as if the record were not the account's to touch.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { TENANT_HTTP_HEADERS as tenantHeaders } from '../packages/mistri/src/shared/tenantContext.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { catalogOf } from './support/commandCatalog.js';
import { createApp } from './support/createApp.js';
import { scratch } from './support/scratch.js';

const SPELLINGS = [
  ['a number', 3],
  ['its digits', '3'],
] as const;

test('a plain App prepares and runs a command on an integer key spelled either way', { timeout: 30_000 }, async (t) => {
  const { directory, stopping } = scratch(t, 'tablewalk-key-spelling-app-');
  const file = join(directory, 'desk.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE account (id INTEGER PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
    INSERT INTO account (id, name) VALUES (3, 'Acme');`);
  migrateSqliteCommandJournal(file);
  clearJournal('key-db');
  const agent: Identity = { id: 'account-agent', who: 'agent@example.test', role: 'agent' };
  const registry = new Registry();
  registry.add({ id: 'key-db', name: 'Desk', url: file, writable: true, source: 'config' });
  const app = parseAppConfig(
    {
      id: 'desk',
      name: 'Desk',
      sources: { desk: { connection: 'key-db', default: true } },
      resources: { account: { access: 'write', actions: { rename: { label: 'Rename', command: 'rename' } } } },
      auth: { providers: ['email'], roles: { agent: { read: true, commands: ['rename'] } } },
      views: { accounts: { kind: 'list', from: 'account' } },
      home: 'accounts',
      nav: ['accounts'],
    },
    'key spelling',
    { commands: catalogOf({ rename: { target: 'account' } }) },
  );
  const pages = parsePagesConfig({ pages: [] }, 'key spelling pages');
  const host: AppHost = {
    app: { app, path: '/private/desk/app.ts', pages, sources: {} },
    pages,
    auth: { spec: app.auth!, store: join(directory, 'auth.db'), close() {}, handler: async () => {}, session: async () => agent },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({
    registry,
    bound,
    apps: [host],
    pages,
    commands: {
      appId: 'desk',
      registry: defineCommands({
        rename: defineCommand({
          source: 'desk',
          target: 'account',
          input: { name: { label: 'Name', type: 'text' } },
          initial: ({ record }) => ({ name: String(record.name) }),
          async handle({ db, record }, input) {
            await db.account.update(record, { name: input.name, version: Number(record.version) + 1 });
          },
        }),
      }),
    },
  });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  stopping(async () => {
    const closed = new Promise<void>((done) => server.close(() => done()));
    server.closeAllConnections();
    await closed;
    db.close();
    await registry.closeAll();
    clearJournal();
  });
  const post = async (path: string, body: object) => {
    const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', 'x-mistri-account': agent.id },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as Record<string, any> };
  };
  for (const [how, id] of SPELLINGS) {
    const prepared = await post('/api/commands/prepare', { command: 'rename', commandVersion: 1, key: { id } });
    assert.equal(prepared.status, 200, `${how}: ${prepared.text}`);
    const ran = await post('/api/commands/execute', {
      command: 'rename',
      commandVersion: 1,
      key: { id },
      expectedVersion: prepared.body.expectedVersion,
      idempotencyKey: `rename-${typeof id}-0000000001`,
      input: { name: `Renamed by ${how}` },
    });
    assert.equal(ran.status, 200, `${how}: ${ran.text}`);
    assert.equal((db.prepare('SELECT name FROM account WHERE id = 3').get() as { name: string }).name, `Renamed by ${how}`);
  }
});

/* A tenant App on SQLite, served as `tablewalk` serves it: a platform-owned `account` keyed by an integer, a
   tenant-owned `ticket` keyed by its tenant and an integer (a tenant's key holds its ownership column), and one
   command on each. The commands module imports the checkout by URL, as the
   tenant docs' example does (tenant-platform-doc-example.test.ts). */
const appId = 'desk';
const binding = { appId, source: { id: 'business', connection: 'business-db' }, storeId: 'desk-tenants' };
const source = (path: string) => pathToFileURL(resolve(path)).href;
const COMMANDS = `import { defineCommand, defineCommands } from '${source('packages/mistri/src/server/commands/businessCommands.ts')}';

const rename = (target, realm) =>
  defineCommand({
    ...(realm ? { realm } : {}),
    source: 'business',
    target,
    input: { name: { label: 'Name', type: 'text' } },
    initial: ({ record }) => ({ name: String(record.name) }),
    async handle({ db, record }, input) {
      await db[target].update(record, { name: input.name, version: Number(record.version) + 1 });
    },
  });
export default defineCommands({ renameAccount: rename('account', 'platform'), renameTicket: rename('ticket') });
`;
const POLICY = `import { defineAppTenantPolicy } from '${source('packages/mistri/src/server/policy/appTenantPolicy.ts')}';

export default defineAppTenantPolicy({
  kind: 'tenant',
  appId: ${JSON.stringify(appId)},
  storeId: ${JSON.stringify(binding.storeId)},
  ownership: { customer: { kind: 'platform' }, account: { kind: 'platform' }, ticket: { kind: 'tenant', column: 'tenant_id' } },
  resolveMembershipRows: () => ({ ticket: true }),
  resolveRows: () => ({ ticket: true }),
  resolvePlatformRows: () => ({ customer: true, account: true, ticket: true }),
  resultReferences: { renameAccount: () => [], renameTicket: () => [] },
});
`;

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
  return address.port;
}

async function servedTenantApp(t: TestContext) {
  const { directory, stopping } = scratch(t, 'tablewalk-key-spelling-tenant-');
  const appDir = join(directory, 'app');
  mkdirSync(appDir);
  const data = join(directory, 'data.db'),
    config = join(directory, 'config.json');
  const db = new DatabaseSync(data);
  db.exec(`CREATE TABLE customer (id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE account (id INTEGER PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE ticket (id INTEGER NOT NULL, tenant_id TEXT NOT NULL REFERENCES customer(id), name TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id, id));
    INSERT INTO customer VALUES ('acme', 'Acme');
    INSERT INTO account (id, name) VALUES (3, 'Acme account');
    INSERT INTO ticket (id, tenant_id, name) VALUES (3, 'acme', 'Printer jam');`);
  db.close();
  provisionSqliteTenantStore(data, binding);
  migrateSqliteCommandJournal(data);
  writeFileSync(
    join(appDir, 'app.json'),
    JSON.stringify({
      id: appId,
      name: 'Desk',
      auth: {
        store: join(directory, 'auth.db'),
        signUp: 'open',
        rows: 'tenant',
        tenancy: { label: 'Customer', profile: 'customer', platform: { label: 'Operator' } },
        roles: {
          agent: { realm: 'tenant', read: true, commands: ['renameTicket'] },
          operator: { realm: 'platform', read: true, commands: ['renameAccount'] },
        },
      },
      sources: { business: { connection: binding.source.connection } },
      resources: {
        customer: { owner: 'platform' },
        account: { owner: 'platform', access: 'write', actions: { rename: { label: 'Rename', command: 'renameAccount' } } },
        ticket: { owner: 'tenant', access: 'write', actions: { rename: { label: 'Rename', command: 'renameTicket' } } },
      },
      views: {
        tickets: { kind: 'list', from: 'ticket', label: 'Tickets' },
        accounts: { kind: 'list', from: 'account', label: 'Accounts', realm: 'platform' },
      },
      home: 'tickets',
      nav: [
        { id: 'desk', label: 'Desk', realm: 'tenant', children: ['tickets'] },
        { id: 'operations', label: 'Operations', realm: 'platform', children: ['accounts'] },
      ],
    }),
  );
  writeFileSync(join(directory, 'commands.mts'), COMMANDS);
  writeFileSync(join(directory, 'tenant-policy.mjs'), POLICY);
  writeFileSync(config, JSON.stringify({ connections: [{ name: binding.source.connection, url: data, writable: true }] }));
  const env = {
    ...process.env,
    DATABASE_URL: '',
    MISTRI_OPEN: '0',
    MISTRI_PUBLIC_URL: '',
    BETTER_AUTH_SECRET: 'synthetic-key-spelling-secret-at-least-thirty-two-characters',
    MISTRI_AUTH_ADMIN_EMAIL: '',
    MISTRI_AUTH_ADMIN_PASSWORD: '',
    MISTRI_DIAGNOSTICS: '',
    MISTRI_TEST_AUTH_LIMITS: 'off',
    XDG_CONFIG_HOME: join(directory, 'xdg'),
  };
  const port = await freePort(),
    origin = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      resolve('packages/mistri/src/server/index.ts'),
      '--config',
      config,
      '--app',
      appDir,
      '--policy',
      join(directory, 'tenant-policy.mjs'),
      '--commands',
      join(directory, 'commands.mts'),
      '--port',
      String(port),
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => (output += String(chunk)));
  const ended = once(child, 'exit');
  stopping(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await ended;
  });
  for (let tries = 0; !output.includes('Listening on'); tries++) {
    if (tries > 1200 || child.exitCode !== null || child.signalCode !== null) throw new Error(`The App never listened: ${output}`);
    await delay(50);
  }
  const call = (path: string, init: RequestInit = {}) => fetch(origin + path, { ...init, signal: AbortSignal.timeout(15000) });
  const signUp = async (name: string) => {
    const reply = await call('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name, email: `${name}@desk.example.test`, password: `Disposable-${name}-password-123!` }),
    });
    assert.equal(reply.status, 200, await reply.clone().text());
    const body = (await reply.json()) as { user: { id: string } };
    return { cookie: reply.headers.get('set-cookie')!.split(';')[0], accountId: body.user.id };
  };
  const operator = await signUp('operator'),
    agent = await signUp('agent');
  const admin = new DatabaseSync(data);
  const operations = new TransactionOperations();
  admin.exec('BEGIN IMMEDIATE');
  try {
    const tenants = createSqliteTenantAdministration(admin, operations, binding);
    const grant = { status: 'active' as const, validUntil: Date.now() + 3_600_000, expectedVersion: null };
    await tenants.putTenant({ tenantId: 'acme', status: 'active', expectedVersion: null });
    await tenants.putMembership({ ...grant, tenantId: 'acme', accountId: agent.accountId, membershipId: 'acme-agent', roles: ['agent'] });
    await tenants.putPlatform({ status: 'active', expectedVersion: null });
    await tenants.putPlatformMembership({
      ...grant,
      accountId: operator.accountId,
      membershipId: 'platform-operator',
      roles: ['operator'],
    });
    await operations.finish();
    admin.exec('COMMIT');
  } catch (error) {
    await operations.finish().catch(() => {});
    if (admin.isTransaction) admin.exec('ROLLBACK');
    throw error;
  } finally {
    admin.close();
  }
  type Who = typeof operator;
  /** A lease, opened as the browser opens it: `realm=platform`, or one tenant. */
  const lease = async (who: Who, where: { realm: 'platform' } | { tenant: string }) => {
    const query = new URLSearchParams({ app: appId, ...where });
    const headers = { cookie: who.cookie, origin, 'content-type': 'application/json', [tenantHeaders.account]: who.accountId };
    const opened = await call(`/api/tenant/context/open?${query}`, { method: 'POST', headers, body: '{}' });
    const reply = (await opened.json()) as Record<string, unknown>;
    assert.equal(opened.status, 200, JSON.stringify(reply));
    return async (path: string, body: unknown) => {
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
    };
  };
  const name = (table: 'account' | 'ticket') => {
    const reader = new DatabaseSync(data, { readOnly: true });
    try {
      return (reader.prepare(`SELECT name FROM ${table} WHERE id = 3`).get() as { name: string }).name;
    } finally {
      reader.close();
    }
  };
  return { operator, agent, lease, name, output: () => output };
}

test(
  'a tenant App prepares and runs on an integer key spelled either way, in the tenant and the platform realm (G182)',
  { timeout: 120_000 },
  async (t) => {
    const s = await servedTenantApp(t);
    const realms = [
      { realm: 'platform', post: await s.lease(s.operator, { realm: 'platform' }), command: 'renameAccount', table: 'account', key: {} },
      {
        realm: 'tenant',
        post: await s.lease(s.agent, { tenant: 'acme' }),
        command: 'renameTicket',
        table: 'ticket',
        key: { tenant_id: 'acme' },
      },
    ] as const;
    for (const { realm, post, command, table, key: owner } of realms) {
      for (const [how, id] of SPELLINGS) {
        const said = `${realm}, ${how}`;
        const key = { ...owner, id };
        const prepared = await post('/api/commands/prepare', { command, commandVersion: 1, key });
        assert.equal(prepared.status, 200, `${said}: ${prepared.text}\n${s.output()}`);
        const ran = await post('/api/commands/execute', {
          command,
          commandVersion: 1,
          key,
          expectedVersion: prepared.body.expectedVersion,
          idempotencyKey: `${command}-${typeof id}-0000000001`,
          input: { name: `Renamed in ${said}` },
        });
        assert.equal(ran.status, 200, `${said}: ${ran.text}`);
        assert.equal(ran.body.status, 'applied', `${said}: ${ran.text}`);
        assert.equal(s.name(table), `Renamed in ${said}`);
      }
    }
    // A spelling that names no row is no spelling of 3: still refused, as before.
    for (const id of ['03', '3.0', ' 3', 3.5]) {
      const refused = await realms[0].post('/api/commands/prepare', { command: 'renameAccount', commandVersion: 1, key: { id } });
      assert.ok(refused.status >= 400, `${JSON.stringify(id)}: ${refused.text}`);
    }
  },
);
