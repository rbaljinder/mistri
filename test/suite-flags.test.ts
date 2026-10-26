/** Real configured suite, genuine native grants/memberships and an explicitly
 * provisioned UUID-owned PostgreSQL flag database. No preview service is used. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { pathToFileURL } from 'node:url';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createNativeAccount } from '../packages/mistri/src/server/auth/authAccounts.js';
import { createSuiteAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { openSuiteIdentity } from '../packages/mistri/src/server/auth/suiteIdentity.js';
import { openSuiteGrantStore } from '../packages/mistri/src/server/auth/suiteGrantStore.js';
import { readSuiteConfiguration } from '../packages/mistri/src/server/cli/suiteConfig.js';
import { startConfiguredSuite } from '../packages/mistri/src/server/cli/suiteCommand.js';
import { runFlagsCommand } from '../packages/mistri/src/server/cli/flagsCommand.js';
import { changeSuiteGrant } from '../packages/mistri/src/server/cli/suiteGrant.js';
import { loadConfig, Registry } from '../packages/engine/src/server/connections.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { openSuiteApp } from '../packages/mistri/src/server/http/suiteApp.js';
import { createComposedFlagEvaluator } from '../packages/mistri/src/server/flags/request.js';
import { FlagStoreUnavailable } from '../packages/mistri/src/server/flags/store.js';
import { signInOf } from '../packages/mistri/src/shared/app.js';
import { liveSkip } from './live.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';
import { CONFIG_SECTIONS } from '../packages/mistri/src/server/serviceConnections.js';

const powers = (actions: readonly string[]) => [{ actions, environments: ['production'], owners: ['product'] }];
const flags = {
  feature: { type: 'boolean', default: false, owner: 'product', tenantManaged: true },
  hidden: { type: 'string', default: 'PRIVATE_OTHER_OWNER', owner: 'security' },
};
const flagBinding = { suiteId: 'flag-suite', deploymentId: 'production-deployment' };
const tenantBinding = { appId: 'dealer', source: { id: 'data', connection: 'data' }, storeId: 'dealer-memberships' };

test(
  'configured suite owns flags once, routes native/tenant authority and refuses public hosts even with staff cookies',
  {
    skip: liveSkip('postgres', process.env.TABLEWALK_TEST_PG),
    timeout: 120_000,
  },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-suite-flags-'));
    const owned = await uuidPostgresDatabase('suite_flags'),
      pg = await pgClient(owned.url);
    let suite: Awaited<ReturnType<typeof startConfiguredSuite>> | undefined;
    let grantsDb: DatabaseSync | undefined, tenantDb: DatabaseSync | undefined;
    t.after(async () => {
      try {
        await suite?.close();
      } finally {
        grantsDb?.close();
        tenantDb?.close();
        await pg.end();
        await owned.drop();
        rmSync(directory, { recursive: true, force: true });
      }
    });
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    assert.notEqual(port, 4880);
    assert.notEqual(new URL(owned.url).port, '57693');
    const environment = { SECRET: 'suite-flag-test-secret-longer-than-thirty-two-characters' };
    const manifests = {
      staff: {
        id: 'staff',
        name: 'Staff',
        track: 'receipts',
        flags,
        sources: { data: { connection: 'data', default: true } },
        resources: { note: { access: 'write', actions: { rename: { label: 'Rename', command: 'rename' } } } },
        auth: {
          signUp: 'open',
          providers: ['email'],
          roles: {
            reader: { read: true, commands: ['rename'], flags: powers(['view']) },
            manager: { read: false, flags: powers(['manage']) },
            oncall: { read: false, flags: powers(['killswitch']) },
            admin: { read: true },
          },
          public: { read: ['note'] },
        },
        views: { notes: { kind: 'list', from: 'note' } },
        home: 'notes',
      },
      dealer: {
        id: 'dealer',
        name: 'Dealer',
        flags,
        sources: { data: { connection: 'data' } },
        resources: { note: { owner: 'tenant', fields: { read: ['id', 'name'] } } },
        auth: {
          signUp: 'open',
          providers: ['email'],
          rows: 'tenant',
          tenancy: { label: 'Tenant', platform: { label: 'Platform' } },
          roles: {
            member: { realm: 'tenant', read: true, flags: powers(['view', 'manage']) },
            operator: { realm: 'platform', read: true, flags: powers(['view', 'manage', 'killswitch']) },
          },
        },
        views: {
          notes: { kind: 'list', from: 'note' },
          welcome: { kind: 'landing', hero: { heading: 'Public dealer', actions: [{ label: 'Staff', signIn: true }] } },
        },
        home: [{ view: 'welcome', signedOut: true }, { view: 'notes' }],
      },
    };
    for (const id of ['staff', 'dealer'] as const) {
      const home = join(directory, id);
      mkdirSync(home);
      const file = join(home, 'business.db'),
        db = new DatabaseSync(file);
      db.exec(
        id === 'staff'
          ? "CREATE TABLE note(id INTEGER PRIMARY KEY, version INTEGER NOT NULL, name TEXT); INSERT INTO note VALUES(1,0,'staff');"
          : "PRAGMA journal_mode=WAL; CREATE TABLE note(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT); INSERT INTO note VALUES('one','north','member');",
      );
      db.close();
      if (id === 'staff') {
        migrateSqliteCommandJournal(file);
        writeFileSync(
          join(home, 'commands.mjs'),
          `import { defineCommand, defineCommands } from ${JSON.stringify(new URL('../packages/mistri/src/server/commands/businessCommands.ts', import.meta.url).href)};
        export const control = {};
        export default defineCommands({ rename: defineCommand({ source: 'data', target: 'note', 
          enabledBy: { flag: 'feature', is: true }, input: { name: { type: 'text' } }, read: ['note'], write: ['note'],
          output: { parse(value) { return { name: value.name }; } },
          async handle({ db, record, flags }, input) {
            control.reader = flags; control.before = flags.get('feature');
            if (control.wait) { control.entered(); await control.wait; }
            control.after = flags.get('feature'); await db.note.update(record, { name: input.name });
            return { name: input.name };
          } }) });`,
        );
      }
      writeFileSync(join(home, 'app.json'), JSON.stringify(manifests[id]));
      writeFileSync(join(home, 'connections.json'), JSON.stringify({ connections: [{ name: 'data', url: file, writable: true }] }));
    }
    const tenantFile = join(directory, 'dealer', 'business.db');
    provisionSqliteTenantStore(tenantFile, tenantBinding);
    tenantDb = new DatabaseSync(tenantFile);
    const maintain = async (work: (admin: ReturnType<typeof createSqliteTenantAdministration>) => Promise<void>) => {
      const operations = new TransactionOperations();
      tenantDb!.exec('BEGIN IMMEDIATE');
      try {
        await work(createSqliteTenantAdministration(tenantDb!, operations, tenantBinding));
        await operations.finish();
        tenantDb!.exec('COMMIT');
      } catch (error) {
        await operations.finish().catch(() => {});
        tenantDb!.exec('ROLLBACK');
        throw error;
      }
    };
    writeFileSync(
      join(directory, 'dealer', 'policy.mjs'),
      `export default { kind:'tenant',appId:'dealer',storeId:'dealer-memberships',
    ownership:{note:{kind:'tenant',column:'tenant_id'}},resolveMembershipRows:()=>({note:true}),resolveRows:()=>({note:true}),resolvePlatformRows:()=>({note:true}) };`,
    );
    const file = join(directory, 'suite.json');
    const configuration = {
      port,
      publicOrigin: 'https://staff.example',
      console: { enabled: true },
      identity: { id: flagBinding.suiteId, store: './identity.db', grants: './grants.db', environment: { BETTER_AUTH_SECRET: 'SECRET' } },
      flags: { store: owned.url, environment: 'production', deploymentId: flagBinding.deploymentId },
      hosts: [
        { host: 'shop.example', app: 'staff', tenant: 'north' },
        { host: 'dealer.example', app: 'dealer', tenant: 'north' },
      ],
      apps: ['staff', 'dealer'].map((id) => ({
        id,
        directory: `./${id}`,
        config: `./${id}/connections.json`,
        mount: id === 'staff' ? '/' : '/dealer',
        ...(id === 'dealer' ? { policy: './dealer/policy.mjs' } : {}),
      })),
    };
    writeFileSync(file, JSON.stringify(configuration));
    const config = await readSuiteConfiguration(file, environment);
    const deployments = await Promise.all(
      config.apps.map(async (deployment) => ({
        app: await loadApp(deployment.directory),
        basePath: deployment.mount,
        environment: deployment.environment,
        connections: (await loadConfig(deployment.config, CONFIG_SECTIONS))!.connections,
      })),
    );
    const identity = await openSuiteIdentity(config, deployments),
      password = 'suite-flags-test-password-123';
    const subject = await createNativeAccount(
      identity.native,
      { name: 'Operator', email: 'operator@example.test', password },
      { by: 'maintenance' },
    );
    const consoleOnly = await createNativeAccount(
      identity.native,
      { name: 'Console only', email: 'console@example.test', password },
      { by: 'maintenance' },
    );
    identity.close();
    grantsDb = new DatabaseSync(config.identity!.grants);
    const grants = openSuiteGrantStore(grantsDb, flagBinding.suiteId);
    const grant = (appId: string, roles: string[], expectedRevision: number) =>
      grants.change({
        appId,
        subjectId: subject,
        roles,
        expectedRevision,
        actorId: 'maintenance',
        declaredRoles: appId === 'staff' ? ['reader', 'manager', 'oncall', 'admin'] : ['member', 'operator'],
      });
    grant('staff', ['reader', 'manager'], 0);
    grant('dealer', ['member'], 0);
    await maintain(async (admin) => {
      await admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null });
      await admin.putTenant({ tenantId: 'south', status: 'active', expectedVersion: null });
      await admin.putPlatform({ status: 'active', expectedVersion: null });
      await admin.putMembership({
        tenantId: 'north',
        accountId: subject,
        membershipId: 'north-member',
        roles: ['member'],
        status: 'active',
        expectedVersion: null,
        validUntil: Date.now() + 600_000,
      });
    });
    await t.test('serving refuses an unprovisioned store without installing the control tables', async () => {
      await assert.rejects(
        startConfiguredSuite(file, environment),
        (error) => error instanceof FlagStoreUnavailable || (error instanceof Error && (error as { code?: string }).code === '3F000'),
      );
      assert.equal((await pg.query("SELECT to_regclass('mistri.flag_binding') AS relation")).rows[0].relation, null);
      await runFlagsCommand(['provision', '--suite', file], environment);
      suite = await startConfiguredSuite(file, environment);
      assert.ok(suite.flags);
    });
    assert.ok(suite, 'the configured suite must have opened after explicit provisioning');
    const call = (
      path: string,
      options: {
        cookie?: string;
        account?: string;
        host?: string;
        method?: string;
        body?: unknown;
        origin?: string;
        headers?: Record<string, string>;
      } = {},
    ) =>
      new Promise<{ status: number; body: any; text: string; cookie: string; headers: import('node:http').IncomingHttpHeaders }>(
        (resolve, reject) => {
          const body = options.body === undefined ? undefined : JSON.stringify(options.body),
            host = options.host ?? 'staff.example';
          const req = httpRequest(
            {
              hostname: '127.0.0.1',
              port,
              path,
              method: options.method ?? (body === undefined ? 'GET' : 'POST'),
              headers: {
                host,
                origin: options.origin ?? `https://${host}`,
                'content-type': 'application/json',
                ...(options.cookie ? { cookie: options.cookie } : {}),
                ...(options.account ? { 'x-mistri-account': options.account } : {}),
                ...options.headers,
              },
            },
            (res) => {
              let text = '';
              res.setEncoding('utf8');
              res.on('data', (chunk) => {
                text += chunk;
              });
              res.on('error', reject);
              res.on('end', () => {
                let body;
                try {
                  body = JSON.parse(text);
                } catch {
                  body = undefined;
                }
                resolve({
                  status: res.statusCode!,
                  body,
                  text,
                  headers: res.headers,
                  cookie: (res.headers['set-cookie'] ?? []).map((value) => value.split(';')[0]).join('; '),
                });
              });
            },
          );
          req.setTimeout(10_000, () => req.destroy(new Error('Flag fixture HTTP timeout.')));
          req.on('error', reject);
          req.end(body);
        },
      );
    const login = await call('/api/auth/sign-in/email', { body: { email: 'operator@example.test', password } });
    assert.equal(login.status, 200, login.text);
    const session = { cookie: login.cookie, account: subject };
    const waitForLock = async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        await pg.query('SELECT pg_stat_clear_snapshot()');
        const waiting = await pg.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name='mistri-flags' AND wait_event_type='Lock'",
        );
        if (waiting.rows.length) return;
        await delay(10);
      }
      throw new Error('The owned flag mutation did not reach its control-row lock.');
    };
    const consoleBase = '/_mistri/console';
    await t.test('real Console mount and chooser require explicit admission independently of target grants', async () => {
      assert.equal((await call(`${consoleBase}/`, session)).status, 403);
      assert.equal(
        (await call('/api/suite/apps', session)).body.apps.some((app: { id: string }) => app.id === 'mistri-console'),
        false,
      );
      await assert.rejects(
        changeSuiteGrant(file, { appId: 'mistri-console', subjectId: subject, roles: ['admin'], expectedRevision: 0 }, environment),
      );
      await changeSuiteGrant(file, { appId: 'mistri-console', subjectId: subject, roles: ['admitted'], expectedRevision: 0 }, environment);
      const page = await call(`${consoleBase}/`, session);
      assert.equal(page.status, 200, page.text);
      assert.match(page.text, /mistri-console/);
      assert.doesNotMatch(page.text, /PRIVATE_OTHER_OWNER|postgres:\/\//);
      const chooser = await call('/api/suite/apps', session);
      assert.equal(chooser.body.apps.find((app: { id: string }) => app.id === 'mistri-console').href, `${consoleBase}/`);
      const rows = await call(`${consoleBase}/api/query?targetApp=staff`, { ...session, body: { table: 'flags', limit: 25, offset: 0 } });
      assert.equal(rows.status, 200, rows.text);
      assert.deepEqual(
        rows.body.rows.map((row: { flagId: string }) => row.flagId),
        ['feature'],
      );
      const tenants = await call(`${consoleBase}/api/query?targetApp=dealer&tenant=north`, {
        ...session,
        body: { table: 'flags', limit: 25, offset: 0 },
      });
      assert.equal(tenants.status, 200, tenants.text);
      assert.equal(tenants.body.rows[0].flagId, 'feature');
      const controls = await call(`${consoleBase}/api/console/catalog`, session);
      assert.equal(controls.status, 200, controls.text);
      const dealer = controls.body.targets.find((target: { name: string }) => target.name === 'Dealer');
      assert.ok(dealer, controls.text);
      assert.deepEqual(
        dealer.scopes.map((scope: { label: string }) => scope.label),
        ['north'],
      );
      const ownFlags = await call(`${consoleBase}/api/console/scopes/${dealer.scopes[0].id}/flags`, session);
      assert.equal(ownFlags.status, 200, ownFlags.text);
      assert.deepEqual(
        ownFlags.body.items.map((flag: { flagId: string }) => flag.flagId),
        ['feature'],
      );
      for (const selection of ['targetApp=dealer&tenant=south', 'targetApp=dealer', 'targetApp=staff&tenant=north']) {
        assert.equal(
          (await call(`${consoleBase}/api/query?${selection}`, { ...session, body: { table: 'flags', limit: 25, offset: 0 } })).status,
          403,
        );
      }
      for (const host of ['shop.example', 'dealer.example'])
        assert.equal((await call(`${consoleBase}/`, { ...session, host })).status, 403);
      // A stale/corrupt historical admin grant is not Console admission, even in
      // the chooser or root-App switcher's shared authorized-App list.
      grants.change({
        subjectId: subject,
        appId: 'mistri-console',
        roles: ['admin'],
        expectedRevision: 1,
        actorId: 'fixture-maintenance',
        declaredRoles: ['admitted', 'admin'],
      });
      assert.equal((await call(`${consoleBase}/`, session)).status, 403);
      assert.equal(
        (await call('/api/suite/apps', session)).body.apps.some((app: { id: string }) => app.id === 'mistri-console'),
        false,
      );
      await changeSuiteGrant(file, { appId: 'mistri-console', subjectId: subject, roles: ['admitted'], expectedRevision: 2 }, environment);
      await changeSuiteGrant(
        file,
        { appId: 'mistri-console', subjectId: consoleOnly, roles: ['admitted'], expectedRevision: 0 },
        environment,
      );
      const alone = await call('/api/auth/sign-in/email', { body: { email: 'console@example.test', password } });
      assert.equal(alone.status, 200, alone.text);
      const empty = await call(`${consoleBase}/api/query`, {
        cookie: alone.cookie,
        account: consoleOnly,
        body: { table: 'targets', limit: 25, offset: 0 },
      });
      assert.equal(empty.status, 200, empty.text);
      assert.deepEqual(empty.body.rows, []);
      const values = await call('/api/flags/evaluate', session);
      assert.equal(values.status, 200, values.text);
      assert.equal(values.body.values.feature, false);
      assert.equal(values.headers['x-mistri-account'], subject);
      assert.equal(values.headers['x-mistri-app'], 'staff');
      assert.equal((await call('/api/flags/evaluate', { ...session, account: 'wrong' })).status, 409);
    });
    const change = { tenantId: null, operation: 'set', expectedRevision: 0, reason: 'Release', override: { value: true } };
    await t.test('native App permissions, minimal mutation/CAS, filtered history and same-store atomic read port', async () => {
      const list = await call('/api/flags', session);
      assert.equal(list.status, 200, list.text);
      assert.deepEqual(
        list.body.items.map((item: { flagId: string }) => item.flagId),
        ['feature'],
      );
      const result = await call('/api/flags/feature/changes', { ...session, body: change });
      assert.equal(result.status, 200, result.text);
      assert.deepEqual(result.body, { flagId: 'feature', revision: 1, operation: 'set' });
      assert.equal((await call('/api/flags/feature/changes', { ...session, body: change })).status, 409);
      const history = await call('/api/flags/feature/history', session);
      assert.equal(history.status, 200);
      assert.equal(history.text.includes('PRIVATE_OTHER_OWNER'), false);
      assert.equal((await call('/api/flags/feature?environment=development', session)).status, 400);
      const port = suite!.flags!.readPort('staff');
      const pair = await port.readRequestScopes({ appId: 'staff', environment: 'production', tenantId: null });
      assert.equal(pair.global.overrides.feature.value, true);
      assert.equal(pair.global.revision, 1);
      const values = await call('/api/flags/evaluate?app=staff', session);
      assert.equal(values.status, 200, values.text);
      assert.equal(values.body.values.feature, true);
      assert.deepEqual(values.body.version, { global: 1, tenant: null });
      await assert.rejects(port.readRequestScopes({ appId: 'dealer', environment: 'production', tenantId: null }));
      assert.ok(Object.isFrozen(port.catalog.flags));
      assert.equal('mutate' in port, false);
      assert.equal('close' in port, false);
    });
    await t.test('tenant membership is independent of suite admission and platform authority is separate', async () => {
      assert.equal((await call('/dealer/api/flags/feature?tenant=north', session)).status, 200);
      assert.equal((await call('/dealer/api/flags/feature?tenant=south', session)).status, 403);
      assert.equal((await call('/dealer/api/flags/feature', session)).status, 403);
      const tenant = await call('/dealer/api/flags/feature/changes', { ...session, body: { ...change, tenantId: 'north' } });
      assert.equal(tenant.status, 200, tenant.text);
      await maintain(async (admin) => {
        await admin.putPlatformMembership({
          accountId: subject,
          membershipId: 'platform-member',
          roles: ['operator'],
          status: 'active',
          expectedVersion: null,
          validUntil: Date.now() + 600_000,
        });
      });
      const kill = await call('/dealer/api/flags/feature/kill', {
        ...session,
        body: { tenantId: null, expectedRevision: 0, reason: 'Global kill' },
      });
      assert.equal(kill.status, 200, kill.text);
      const port = suite!.flags!.readPort('dealer');
      const pair = await port.readRequestScopes({ appId: 'dealer', environment: 'production', tenantId: 'north' });
      assert.equal(pair.global.overrides.feature.disabled, true);
      assert.equal(pair.tenant!.overrides.feature.value, true);
      const request = createComposedFlagEvaluator({
        catalog: port.catalog,
        scope: { appId: 'dealer', environment: 'production', tenantId: 'north' },
        context: {},
        snapshots: pair,
      });
      assert.equal(request.evaluate('feature').value, false);
      const opened = await call('/dealer/api/tenant/context/open?app=dealer&tenant=north', { ...session, body: {} });
      assert.equal(opened.status, 200, opened.text);
      const lease = {
        'x-mistri-tab': opened.body.tabId,
        'x-mistri-context': opened.body.context,
        'x-mistri-lease-revision': String(opened.body.revision),
      };
      const values = await call('/dealer/api/flags/evaluate?app=dealer&tenant=north', { ...session, headers: lease });
      assert.equal(values.status, 200, values.text);
      assert.equal(values.body.values.feature, false);
      assert.equal(values.headers['x-mistri-context'], opened.body.context);
      assert.equal(values.headers['x-mistri-tenant'], 'north');
      assert.notEqual((await call('/dealer/api/flags/evaluate?app=dealer&tenant=south', { ...session, headers: lease })).status, 200);
      await maintain(async (admin) => {
        await admin.putMembership({
          tenantId: 'north',
          accountId: subject,
          membershipId: 'north-member',
          roles: ['member'],
          status: 'revoked',
          expectedVersion: '1',
          validUntil: Date.now() + 600_000,
        });
      });
      assert.equal((await call('/dealer/api/flags/feature?tenant=north', session)).status, 403);
      assert.notEqual((await call('/dealer/api/flags/evaluate?app=dealer&tenant=north', { ...session, headers: lease })).status, 200);
    });
    await t.test('mapped public hosts cannot use flags with a valid staff cookie or forwarded host hint', async () => {
      const anonymous = await call('/api/flags/evaluate', { ...session, host: 'shop.example' });
      assert.equal(anonymous.status, 200, anonymous.text);
      assert.equal(anonymous.headers['x-mistri-account'], undefined);
      assert.equal(anonymous.body.values.feature, true);
      for (const [host, base] of [
        ['shop.example', ''],
        ['dealer.example', '/dealer'],
      ]) {
        for (const path of [
          `${base}/api/flags`,
          `${base}/api/flags/feature`,
          `${base}/api/flags/feature/history`,
          `${base}/api/flags/feature/capabilities`,
        ])
          assert.equal((await call(path, { ...session, host })).status, 403, path);
        assert.equal(
          (
            await call(`${base}/api/flags/feature/kill`, {
              ...session,
              host,
              body: { tenantId: null, expectedRevision: 1, reason: 'Forged' },
            })
          ).status,
          403,
        );
      }
      assert.equal(
        (
          await call('/api/flags/feature/kill', {
            ...session,
            origin: 'http://evil.example',
            body: { tenantId: null, expectedRevision: 1, reason: 'Forged' },
          })
        ).status,
        403,
      );
      assert.equal((await call('/api/flags', { ...session, account: 'another-subject' })).status, 409);
    });
    await t.test('kill-only does not imply view, admin has no shortcut, current target grant revocation denies', async () => {
      grant('staff', ['oncall'], 1);
      assert.equal((await call('/api/flags/feature', session)).status, 403);
      const caps = await call('/api/flags/feature/capabilities', session);
      assert.equal(caps.status, 200);
      assert.deepEqual(caps.body.actions, ['kill']);
      assert.equal(
        (await call('/api/flags/feature/kill', { ...session, body: { tenantId: null, expectedRevision: 1, reason: 'Incident' } })).status,
        200,
      );
      grant('staff', ['admin'], 2);
      assert.equal((await call('/api/flags/feature', session)).status, 403);
      grant('staff', [], 3);
      assert.equal((await call('/api/flags/feature', session)).status, 401);
    });
    await t.test('real control-row lock waits reobserve native App grants and target memberships before committing', async () => {
      grant('staff', ['reader', 'manager'], 4);
      await pg.query('BEGIN');
      await pg.query("SELECT revision FROM mistri.flag_state WHERE app_id='staff' AND tenant_key='' FOR UPDATE");
      const native = call('/api/flags/feature/changes', { ...session, body: { ...change, expectedRevision: 2 } });
      try {
        await waitForLock();
        grant('staff', [], 5);
      } finally {
        await pg.query('COMMIT');
      }
      assert.equal((await native).status, 403);
      assert.equal(
        (await pg.query("SELECT revision::int AS revision FROM mistri.flag_state WHERE app_id='staff' AND tenant_key='' ")).rows[0]
          .revision,
        2,
      );
      await maintain(async (admin) => {
        await admin.putMembership({
          tenantId: 'north',
          accountId: subject,
          membershipId: 'north-member-new',
          roles: ['member'],
          status: 'active',
          expectedVersion: null,
          validUntil: Date.now() + 600_000,
        });
      });
      await pg.query('BEGIN');
      await pg.query("SELECT revision FROM mistri.flag_state WHERE app_id='dealer' AND tenant_key='north' FOR UPDATE");
      const tenant = call('/dealer/api/flags/feature/changes', { ...session, body: { ...change, tenantId: 'north', expectedRevision: 1 } });
      try {
        await waitForLock();
        await maintain(async (admin) => {
          await admin.putMembership({
            tenantId: 'north',
            accountId: subject,
            membershipId: 'north-member-new',
            roles: ['member'],
            status: 'revoked',
            expectedVersion: '1',
            validUntil: Date.now() + 600_000,
          });
        });
      } finally {
        await pg.query('COMMIT');
      }
      assert.equal((await tenant).status, 403);
      assert.equal(
        (await pg.query("SELECT revision::int AS revision FROM mistri.flag_state WHERE app_id='dealer' AND tenant_key='north'")).rows[0]
          .revision,
        1,
      );
    });
    const consoleGrant = (roles: string[]) =>
      grants.change({
        subjectId: subject,
        appId: 'mistri-console',
        roles,
        expectedRevision: grants.read(subject, 'mistri-console').revision,
        actorId: 'maintenance',
        declaredRoles: ['admitted'],
      });
    const selectConsoleFlag = async () => {
      const catalog = await call(`${consoleBase}/api/console/catalog`, session);
      assert.equal(catalog.status, 200, catalog.text);
      const target = catalog.body.targets.find((item: { name: string }) => item.name === 'Staff');
      assert.ok(target, catalog.text);
      const flags = await call(`${consoleBase}/api/console/scopes/${target.scopes[0].id}/flags`, session);
      assert.equal(flags.status, 200, flags.text);
      const flag = flags.body.items.find((item: { flagId: string }) => item.flagId === 'feature');
      assert.ok(flag, flags.text);
      return `${consoleBase}/api/console/flags/${flag.id}`;
    };
    await t.test('Console HTTP mutations roll back after Console or target revocation during a real store lock wait', async () => {
      for (const revoked of ['console', 'target']) {
        consoleGrant(['admitted']);
        grant('staff', ['reader', 'manager'], grants.read(subject, 'staff').revision);
        const route = await selectConsoleFlag();
        const before = (await pg.query("SELECT revision::int AS revision FROM mistri.flag_state WHERE app_id='staff' AND tenant_key=''"))
          .rows[0].revision;
        await pg.query('BEGIN');
        await pg.query("SELECT revision FROM mistri.flag_state WHERE app_id='staff' AND tenant_key='' FOR UPDATE");
        const pending = call(`${route}/set`, {
          ...session,
          body: { expectedRevision: before, reason: 'Console release', override: { value: true } },
        });
        try {
          await waitForLock();
          if (revoked === 'console') consoleGrant([]);
          else grant('staff', [], grants.read(subject, 'staff').revision);
        } finally {
          await pg.query('COMMIT');
        }
        const result = await pending;
        assert.equal(result.status, 403, result.text);
        assert.equal(
          (await pg.query("SELECT revision::int AS revision FROM mistri.flag_state WHERE app_id='staff' AND tenant_key=''")).rows[0]
            .revision,
          before,
        );
        if (revoked === 'console') {
          assert.equal((await call(`${consoleBase}/`, session)).status, 403);
          assert.equal(
            (await call('/api/suite/apps', session)).body.apps.some((app: { id: string }) => app.id === 'mistri-console'),
            false,
          );
        } else {
          assert.equal(
            (await call(`${consoleBase}/api/query?targetApp=staff`, { ...session, body: { table: 'flags', limit: 25, offset: 0 } })).status,
            403,
          );
        }
      }
    });
    await t.test('mounted Console forms support guarded set, kill and revert with CAS and strict bodies', async () => {
      consoleGrant(['admitted']);
      grant('staff', ['reader', 'manager', 'oncall'], grants.read(subject, 'staff').revision);
      const route = await selectConsoleFlag(),
        detail = await call(route, session);
      assert.equal(detail.status, 200, detail.text);
      assert.equal(detail.body.type, 'boolean');
      assert.deepEqual(detail.body.actions, ['view', 'manage', 'kill']);
      const revision = detail.body.revision,
        body = { expectedRevision: revision, reason: 'Console edit', override: { value: true } };
      assert.equal((await call(`${route}/set`, { ...session, body: { ...body, tenantId: 'north' } })).status, 403);
      assert.equal((await call(`${route}/set`, { ...session, origin: 'https://evil.example', body })).status, 403);
      assert.equal((await call(`${route}/set`, { ...session, account: 'wrong-account', body })).status, 409);
      const set = await call(`${route}/set`, { ...session, body });
      assert.equal(set.status, 200, set.text);
      assert.equal(set.body.revision, revision + 1);
      assert.equal(set.body.outcome, 'applied');
      assert.equal((await call(`${route}/set`, { ...session, body })).status, 409);
      const kill = await call(`${route}/kill`, { ...session, body: { expectedRevision: revision + 1, reason: 'Console kill' } });
      assert.equal(kill.status, 200, kill.text);
      const revert = await call(`${route}/revert`, {
        ...session,
        body: { expectedRevision: revision + 2, revertRevision: revision + 1, reason: 'Console restore' },
      });
      assert.equal(revert.status, 200, revert.text);
      assert.equal(revert.body.revision, revision + 3);
      const history = await call(`${route}/history`, session);
      assert.equal(history.status, 200, history.text);
      assert.equal(history.body.entries[0].operation, 'revert');
    });
    await t.test(
      'mounted values and command execution hold one pair across a live control update, and disabled flags preserve receipts',
      async () => {
        const set = async (value: boolean) => {
          const revision = (await call('/api/flags/feature', session)).body.revision;
          const changed = await call('/api/flags/feature/changes', {
            ...session,
            body: { ...change, expectedRevision: revision, override: { value } },
          });
          assert.equal(changed.status, 200, changed.text);
        };
        await set(true);
        const module = await import(pathToFileURL(join(directory, 'staff', 'commands.mjs')).href);
        let release!: () => void, entered!: () => void;
        const reached = new Promise<void>((resolve) => {
          entered = resolve;
        });
        module.control.entered = entered;
        module.control.wait = new Promise<void>((resolve) => {
          release = resolve;
        });
        const prepare = { command: 'rename', commandVersion: 1, key: { id: 1 } };
        const prepared = await call('/api/commands/prepare', { ...session, body: prepare });
        assert.equal(prepared.status, 200, prepared.text);
        const envelope = {
          ...prepare,
          expectedVersion: prepared.body.expectedVersion,
          idempotencyKey: 'suite-flags-thread-0001',
          input: { name: 'Changed' },
        };
        const pending = call('/api/commands/execute', { ...session, body: envelope });
        try {
          await reached;
          await set(false);
        } finally {
          release();
        }
        const executed = await pending;
        assert.equal(executed.status, 200, executed.text);
        assert.equal(module.control.before, true);
        assert.equal(module.control.after, true);
        assert.throws(() => module.control.reader.get('feature'));
        const values = await call('/api/flags/evaluate', session);
        assert.equal(values.status, 200, values.text);
        assert.equal(values.body.values.feature, false);
        assert.notEqual((await call('/api/commands/prepare', { ...session, body: prepare })).status, 200);
        const receipt = await call('/api/commands/status', { ...session, body: envelope });
        assert.equal(receipt.status, 200, receipt.text);
        assert.equal(receipt.body.replayed, true);
      },
    );
    await t.test('private factory captures authority independently of mutable App metadata', async () => {
      const loaded = await loadApp(join(directory, 'staff'));
      const identity = await openSuiteIdentity(config, deployments);
      const registry = new Registry({ environment: {} });
      registry.add({ name: 'data', url: join(directory, 'staff', 'business.db'), source: 'config' });
      const auth = createSuiteAppAuth(identity.native, {
        appId: 'staff',
        spec: signInOf(loaded.app.auth)!,
        roles: ['reader', 'manager', 'oncall', 'admin'],
        basePath: '',
        suiteBase: '',
        grant: grants.read,
      });
      const child = await openSuiteApp({
        app: loaded,
        registry,
        suiteAuth: auth,
        basePath: '',
        publicURL: 'https://staff.example',
        environment: {},
        bound: { host: '127.0.0.1', port, allowedHosts: ['staff.example'] },
      });
      try {
        const before = child.flagTargetFactory!();
        loaded.app.flags = {};
        loaded.app.auth!.roles = { admin: { read: true, write: false } };
        const after = child.flagTargetFactory!();
        assert.deepEqual(after.catalog, before.catalog);
        assert.ok(after.roles.reader.flags?.length);
        assert.equal(after.auth, auth);
        assert.equal(after.appId, 'staff');
        await child.stop();
        assert.throws(after.assertCurrent);
      } finally {
        await child.close();
        identity.close();
      }
    });
    await t.test('shutdown retires retained read ports and mounted Console', async () => {
      const route = await selectConsoleFlag(),
        detail = await call(route, session);
      const body = JSON.stringify({ expectedRevision: detail.body.revision, reason: 'Held Console body', override: { value: false } });
      let entered!: () => void;
      const written = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        const request = httpRequest(
          {
            hostname: '127.0.0.1',
            port,
            path: `${route}/set`,
            method: 'POST',
            headers: {
              host: 'staff.example',
              origin: 'https://staff.example',
              cookie: session.cookie,
              'x-mistri-account': subject,
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(body),
            },
          },
          (response) => {
            response.resume();
            response.on('end', resolve);
            response.on('error', () => resolve());
          },
        );
        request.on('error', () => {
          entered();
          resolve();
        });
        request.write(body.slice(0, 1), () => entered());
      });
      await written;
      await delay(30);
      const readPort = suite!.flags!.readPort('dealer');
      await suite!.close();
      await suite!.close();
      suite = undefined;
      await held;
      assert.equal(
        (await pg.query("SELECT revision::int AS revision FROM mistri.flag_state WHERE app_id='staff' AND tenant_key=''")).rows[0].revision,
        detail.body.revision,
      );
      assert.throws(() => readPort.readRequestScopes({ appId: 'dealer', environment: 'production', tenantId: null }));
    });
  },
);
