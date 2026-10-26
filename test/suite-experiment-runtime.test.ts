/** Mounted request-owner integration without an external control database.
 * The configured PostgreSQL control/mutation path is in suite-flags.test.ts. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createSuite } from '../packages/mistri/src/server/http/suite.js';
import { openSuiteApp } from '../packages/mistri/src/server/http/suiteApp.js';
import { openSuiteTenant } from '../packages/mistri/src/server/http/suiteTenant.js';
import { provisionSqliteTenantStore, TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { captureAppFlagCatalog } from '../packages/mistri/src/server/flags/appCatalog.js';
import { normalizeFlagSnapshot } from '../packages/mistri/src/shared/appFlags.js';
import { experimentDeclaration, experimentFlag, experimentOverride, experimentRuntimeFixture } from './support/experimentRuntimeFixture.js';

for (const policy of [false, true])
  test(
    `mounted ${policy ? 'policy' : 'native'} experiment receipts and actual-use exposure use the mounted native owner`,
    { timeout: 15000 },
    async (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'tablewalk-mounted-flags-')),
        path = join(dir, 'business.db');
      const db = new DatabaseSync(path);
      db.exec("CREATE TABLE item(id INTEGER PRIMARY KEY, version INTEGER NOT NULL, name TEXT); INSERT INTO item VALUES(1,0,'Before')");
      db.close();
      migrateSqliteCommandJournal(path);
      const net = createServer();
      await new Promise<void>((resolve) => net.listen(0, '127.0.0.1', resolve));
      const port = (net.address() as { port: number }).port;
      await new Promise<void>((resolve) => net.close(() => resolve()));
      const origin = `http://127.0.0.1:${port}`;
      writeFileSync(
        join(dir, 'app.json'),
        JSON.stringify({
          id: 'desk',
          name: 'Desk',
          track: 'receipts',
          sources: { data: { connection: 'data' } },
          flags: { enabled: { type: 'boolean', default: false, owner: 'team' }, copy: experimentFlag },
          experiments: { copy: experimentDeclaration() },
          auth: {
            store: join(dir, 'auth.db'),
            signUp: 'open',
            ...(policy ? { rows: 'policy' } : {}),
            roles: { user: { read: true, commands: ['change'] } },
          },
          resources: { item: { access: 'write', actions: { change: { label: 'Change', command: 'change' } } } },
          views: { items: { kind: 'list', from: 'item' } },
          home: 'items',
        }),
      );
      writeFileSync(
        join(dir, 'commands.mjs'),
        `import { defineCommand, defineCommands } from ${JSON.stringify(new URL('../packages/mistri/src/server/commands/businessCommands.ts', import.meta.url).href)};
    export const control = {};
    export default defineCommands({ change: defineCommand({ source: 'data', target: 'item', 
      read: ['item'], write: ['item'], enabledBy: { flag: 'enabled', is: true }, input: { name: { type: 'text' } },
      output: { parse(value) { return { name: value.name }; } },
      async handle({ flags, db, record }, input) { control.reader = flags; control.before = flags.get('enabled');
        if (control.wait) { control.entered(); await control.wait; } control.after = flags.get('enabled');
        await db.item.update(record, { name: input.name }); return { name: input.name }; } }) });`,
      );
      const policyFile = join(dir, 'policy.mjs');
      if (policy)
        writeFileSync(policyFile, `export default { appId:'desk', resolveRows:()=>({item:true}), resultReferences:{change:()=>[]} };`);
      const app = await loadApp(dir),
        registry = new Registry();
      registry.add({ id: 'data', name: 'data', url: path, writable: true, source: 'config' });
      const catalog = captureAppFlagCatalog(app.app, app.commands!.registry).catalog;
      const experiment = await experimentRuntimeFixture(app.app);
      const scope = { appId: 'desk', environment: 'production', tenantId: null };
      let revision = 0,
        enabled = false,
        reads = 0,
        experimentDisabled = false;
      const suite = await createSuite(
        [
          {
            id: 'desk',
            async open(basePath) {
              const host = await openSuiteApp({
                app,
                registry,
                commands: { appId: 'desk', registry: app.commands!.registry },
                ...(policy ? { policyFile } : {}),
                basePath,
                publicURL: origin,
                bound: { host: '127.0.0.1', port },
                environment: { BETTER_AUTH_SECRET: 'mounted-flags-secret-at-least-thirty-two-characters' },
              });
              host.attachFlagRuntime!({
                ...scope,
                catalog,
                experiments: experiment.port,
                async readRequestScopes(selected) {
                  reads++;
                  assert.deepEqual(selected, scope);
                  return {
                    global: normalizeFlagSnapshot(
                      {
                        ...scope,
                        revision,
                        overrides: {
                          enabled: { value: enabled },
                          copy: { ...experimentOverride, ...(experimentDisabled ? { disabled: true } : {}) },
                        },
                      },
                      catalog,
                    ),
                    tenant: null,
                  };
                },
              });
              return host;
            },
          },
        ],
        { mounts: { desk: '/desk' } },
      );
      t.after(async () => {
        await suite.close();
        rmSync(dir, { recursive: true, force: true });
      });
      await new Promise<void>((resolve) => suite.server.listen(port, '127.0.0.1', resolve));
      await suite.start();
      let cookie = '',
        account = '';
      const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
        const result = await fetch(origin + '/desk' + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            origin,
            cookie,
            'content-type': 'application/json',
            ...(account ? { 'x-mistri-account': account } : {}),
            ...headers,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await result.text();
        return { status: result.status, text, body: JSON.parse(text), headers: result.headers };
      };
      assert.notEqual((await call('/api/flags/evaluate')).status, 200);
      assert.equal(reads, 0);
      const signup = await call('/api/auth/sign-up/email', {
        name: 'Reader',
        email: 'reader@example.test',
        password: 'mounted-flags-test-password',
      });
      assert.equal(signup.status, 200, signup.text);
      cookie = signup.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      account = signup.body.user.id;
      const first = await call('/api/flags/evaluate?app=desk');
      assert.equal(first.status, 200, first.text);
      assert.equal(experiment.exposures.size, 0, 'evaluation is not actual use');
      assert.equal(experiment.obligations.size, 1, 'receipt delivery is durably obligated');
      const assignmentReceipt = first.body.assignmentReceipts.copy;
      assert.equal(typeof assignmentReceipt, 'string');
      const exposure = () => call('/api/experiments/exposures?app=desk', { receipts: [assignmentReceipt] }, { 'x-mistri-app': 'desk' });
      const consumed = await exposure();
      assert.equal(consumed.status, 200, consumed.text);
      assert.deepEqual(consumed.body.outcomes, ['recorded']);
      assert.equal(experiment.exposures.size, 1);
      assert.deepEqual((await exposure()).body.outcomes, ['duplicate']);
      experiment.beforeExposure(() => {
        experimentDisabled = true;
      });
      const killedAtCommit = await exposure();
      assert.equal(killedAtCommit.status, 503, killedAtCommit.text);
      assert.deepEqual(killedAtCommit.body.outcomes, ['unknown']);
      experiment.beforeExposure();
      experimentDisabled = false;
      assert.equal(first.body.values.enabled, false);
      assert.equal(first.headers.get('x-mistri-account'), account);
      const prepare = { command: 'change', commandVersion: 1, key: { id: 1 } };
      assert.notEqual((await call('/api/commands/prepare', prepare)).status, 200);
      enabled = true;
      revision++;
      const prepared = await call('/api/commands/prepare', prepare);
      assert.equal(prepared.status, 200, prepared.text);
      const module = await import(pathToFileURL(join(dir, 'commands.mjs')).href);
      let entered!: () => void, release!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      module.control.entered = entered;
      module.control.wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const envelope = {
        ...prepare,
        expectedVersion: prepared.body.expectedVersion,
        input: { name: 'After' },
        idempotencyKey: 'mounted-flags-0001',
      };
      const before = reads,
        pending = call('/api/commands/execute', envelope);
      try {
        await reached;
        enabled = false;
        revision++;
      } finally {
        release();
      }
      const executed = await pending;
      assert.equal(executed.status, 200, executed.text);
      assert.equal(reads, before + 1);
      assert.equal(module.control.before, true);
      assert.equal(module.control.after, true);
      assert.throws(() => module.control.reader.get('enabled'));
      const next = await call('/api/flags/evaluate');
      assert.equal(next.status, 200, next.text);
      assert.equal(next.body.values.enabled, false);
      assert.deepEqual(next.body.version, { global: 2, tenant: null });
      const receipt = await call('/api/commands/status', envelope);
      assert.equal(receipt.status, 200, receipt.text);
      assert.equal(receipt.body.replayed, true);
      assert.notEqual((await call('/api/flags/evaluate', undefined, { 'x-mistri-account': 'wrong' })).status, 200);
      const auth = new DatabaseSync(join(dir, 'auth.db'));
      auth.prepare('UPDATE user SET banned=1 WHERE id=?').run(account);
      auth.close();
      assert.notEqual((await call('/api/flags/evaluate')).status, 200);
      assert.notEqual((await exposure()).status, 200);
      assert.equal(experiment.exposures.size, 1);
    },
  );

test('mounted tenant experiment receipts require canonical lease and reject revoked membership', { timeout: 15000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-mounted-tenant-flags-')),
    path = join(dir, 'business.db');
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE item(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT); INSERT INTO item VALUES('one','north','Before')",
  );
  db.close();
  provisionSqliteTenantStore(path, { appId: 'desk', source: { id: 'data', connection: 'data' }, storeId: 'store' });
  const net = createServer();
  await new Promise<void>((resolve) => net.listen(0, '127.0.0.1', resolve));
  const port = (net.address() as { port: number }).port;
  await new Promise<void>((resolve) => net.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  writeFileSync(
    join(dir, 'app.json'),
    JSON.stringify({
      id: 'desk',
      name: 'Desk',
      sources: { data: { connection: 'data' } },
      flags: { enabled: { type: 'boolean', default: false, owner: 'team', tenantManaged: true }, copy: experimentFlag },
      experiments: { copy: experimentDeclaration() },
      auth: {
        store: join(dir, 'auth.db'),
        signUp: 'open',
        rows: 'tenant',
        tenancy: { platform: { label: 'Platform' } },
        roles: { member: { realm: 'tenant', read: true }, operator: { realm: 'platform', read: true } },
      },
      resources: { item: { owner: 'tenant', fields: { read: ['id', 'name'] } } },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
    }),
  );
  const policyFile = join(dir, 'policy.mjs');
  writeFileSync(
    policyFile,
    `export default { kind:'tenant', appId:'desk',storeId:'store',
    ownership:{item:{kind:'tenant',column:'tenant_id'}},resolveMembershipRows:()=>({item:true}),resolveRows:()=>({item:true}),resolvePlatformRows:()=>({item:true}) };`,
  );
  const app = await loadApp(dir),
    catalog = captureAppFlagCatalog(app.app).catalog;
  const experiment = await experimentRuntimeFixture(app.app, 'north');
  let count = 0;
  const suite = await createSuite(
    [
      {
        id: 'desk',
        async open(basePath) {
          const host = await openSuiteTenant({
            app,
            connections: [{ id: 'data', name: 'data', url: path, source: 'config' }],
            policyFile,
            basePath,
            publicURL: origin,
            port,
            environment: { BETTER_AUTH_SECRET: 'mounted-tenant-flags-secret-at-least-thirty-two-characters' },
          });
          host.attachFlagRuntime!({
            appId: 'desk',
            environment: 'production',
            catalog,
            experiments: experiment.port,
            async readRequestScopes(scope) {
              count++;
              return {
                global: normalizeFlagSnapshot({ ...scope, tenantId: null, revision: 1, overrides: {} }, catalog),
                tenant:
                  scope.tenantId === null
                    ? null
                    : normalizeFlagSnapshot(
                        {
                          ...scope,
                          revision: 2,
                          overrides: { enabled: { value: true }, ...(scope.tenantId === 'north' ? { copy: experimentOverride } : {}) },
                        },
                        catalog,
                      ),
              };
            },
          });
          return host;
        },
      },
    ],
    { mounts: { desk: '/desk' } },
  );
  t.after(async () => {
    await suite.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => suite.server.listen(port, '127.0.0.1', resolve));
  await suite.start();
  const call = async (path: string, headers: Record<string, string> = {}, body?: unknown) => {
    const response = await fetch(origin + '/desk' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text), headers: response.headers };
  };
  const signup = await call(
    '/api/auth/sign-up/email',
    {},
    { name: 'Reader', email: 'tenant@example.test', password: 'mounted-tenant-test-password' },
  );
  assert.equal(signup.status, 200, signup.text);
  const headers = {
    cookie: signup.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; '),
    'x-mistri-account': signup.body.user.id,
  };
  const seed = new DatabaseSync(path);
  seed.exec(
    `INSERT INTO "${TENANT_TABLES.tenant}" VALUES('north','active','1','tenant'),('south','active','1','tenant'),('@platform','active','1','platform')`,
  );
  seed
    .prepare(`INSERT INTO "${TENANT_TABLES.membership}" VALUES(?, 'north', ?, 'active', '1', '["member"]', ?, 'member', NULL, NULL, NULL)`)
    .run('member', signup.body.user.id, Date.now() + 120000);
  const opened = await call('/api/tenant/context/open?app=desk&tenant=north', headers, {});
  assert.equal(opened.status, 200, opened.text);
  const lease = {
    ...headers,
    'x-mistri-tab': opened.body.tabId,
    'x-mistri-context': opened.body.context,
    'x-mistri-lease-revision': String(opened.body.revision),
  };
  const values = await call('/api/flags/evaluate?app=desk&tenant=north', lease);
  assert.equal(values.status, 200, values.text);
  assert.equal(values.body.values.enabled, true);
  assert.deepEqual(values.body.version, { global: 1, tenant: 2 });
  assert.equal(count, 1);
  assert.equal(values.headers.get('x-mistri-context'), opened.body.context);
  assert.equal(values.headers.get('x-mistri-account'), signup.body.user.id);
  const receipt = values.body.assignmentReceipts.copy;
  assert.equal(typeof receipt, 'string');
  assert.equal(experiment.exposures.size, 0);
  const exposure = (headers: Record<string, string>) =>
    call('/api/experiments/exposures?app=desk&tenant=north', { ...headers, 'x-mistri-app': 'desk' }, { receipts: [receipt] });
  assert.notEqual((await exposure(headers)).status, 200, 'missing lease never records use');
  const consumed = await exposure(lease);
  assert.equal(consumed.status, 200, consumed.text);
  assert.deepEqual(consumed.body.outcomes, ['recorded']);
  assert.equal(experiment.exposures.size, 1);
  assert.notEqual((await call('/api/flags/evaluate?app=desk&tenant=south', lease)).status, 200);
  assert.notEqual((await call('/api/flags/evaluate?app=desk&realm=platform', lease)).status, 200);
  assert.notEqual((await call('/api/flags/evaluate?app=desk&tenant=north', headers)).status, 200);
  seed.prepare(`UPDATE "${TENANT_TABLES.membership}" SET status='revoked',version='2' WHERE id='member'`).run();
  seed.close();
  assert.notEqual((await call('/api/flags/evaluate?app=desk&tenant=north', lease)).status, 200);
  assert.notEqual((await exposure(lease)).status, 200);
  assert.equal(experiment.exposures.size, 1);
});
