/** The six real Keystone Apps, one listener and a database owned by this test. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { enrollPlacement, inspectPlacementSource, placementSecretEnv } from '../test/fixtures/apps/keystone/placement-launcher.mjs';
import { DEALER } from '../test/fixtures/apps/keystone/site/dealer.ts';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { provisionPostgresPublicPlacementJournal } from '../packages/mistri/src/adapters/commands/publicPlacementSchema.js';
import { assignableRoles } from '../packages/mistri/src/shared/accountAdministration.js';
import { isFormView } from '../packages/mistri/src/shared/app.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createNativeAccount } from '../packages/mistri/src/server/auth/authAccounts.js';
import { openSuiteIdentity } from '../packages/mistri/src/server/auth/suiteIdentity.js';
import { startConfiguredSuite } from '../packages/mistri/src/server/cli/suiteCommand.js';
import { readSuiteConfiguration } from '../packages/mistri/src/server/cli/suiteConfig.js';
import { changeSuiteGrant } from '../packages/mistri/src/server/cli/suiteGrant.js';
import { loadConfig } from '../packages/engine/src/server/connections.js';
import { refusalReasons } from '../packages/engine/src/server/evidence.js';
import { provisionStores } from '../packages/mistri/src/server/maintenance.js';
import { migratePostgresTenantAdministrationJournal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournalPostgres.js';
import { migratePostgresTenantInvitations } from '../packages/mistri/src/server/tenant/tenantInvitationStorePostgres.js';
import {
  createPostgresTenantAdministration,
  migratePostgresTenantStore,
} from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import { supportAuditKey } from '../packages/mistri/src/server/tenant/tenantSupportAuditContract.js';
import { migratePostgresSupportAudit } from '../packages/mistri/src/server/tenant/tenantSupportAuditPostgres.js';
import { liveSkip } from './live.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';
import { CONFIG_SECTIONS } from '../packages/mistri/src/server/serviceConnections.js';

test(
  'six Keystone Apps share login, explicit grants and logout without sharing dealer authority',
  {
    skip: liveSkip('postgres', process.env.TABLEWALK_TEST_PG),
    timeout: 180_000,
  },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-suite-keystone-'));
    let suite: Awaited<ReturnType<typeof startConfiguredSuite>> | undefined;
    let owned: Awaited<ReturnType<typeof uuidPostgresDatabase>> | undefined;
    let control: Awaited<ReturnType<typeof pgClient>> | undefined;
    t.after(async () => {
      try {
        await suite?.close();
      } finally {
        try {
          await control?.end();
        } finally {
          try {
            await owned?.drop();
          } finally {
            rmSync(directory, { recursive: true, force: true });
          }
        }
      }
    });
    owned = await uuidPostgresDatabase('suite_keystone');
    const root = fileURLToPath(new URL('..', import.meta.url));
    const appsHome = join(root, 'test/fixtures/apps/keystone');
    const businessConfig = join(directory, 'connections.json');
    await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', 'test/fixtures/databases/keystone/seed-postgres.mjs', owned.url, businessConfig, '--photos', 'none'],
      {
        cwd: root,
        env: { ...process.env, KEYSTONE_TODAY: '2026-09-15' },
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      },
    );
    // Use the same business config for every App, resolved only through captured deployment environment.
    writeFileSync(businessConfig, JSON.stringify({ connections: [{ name: 'keystone', url: '${KEYSTONE_DATABASE_URL}', writable: true }] }));
    const socket = createServer();
    await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
    const port = (socket.address() as { port: number }).port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    const ids = ['lender', 'leads', 'dealer', 'site', 'marketplace', 'customer'];
    const state = {
      identitySecret: 'keystone-suite-test-secret-longer-than-thirty-two-characters',
      auditSecret: 'keystone-suite-test-audit-key-longer-than-thirty-two-characters',
    };
    const publicOrigin = 'https://keystone.example.test',
      siteHost = 'liberty-ford.example.test';
    const file = join(directory, 'suite.json');
    const enrolled = enrollPlacement(
      state,
      {
        port,
        identity: {
          id: 'keystone',
          name: 'Keystone',
          store: './identity.db',
          grants: './grants.db',
          environment: { BETTER_AUTH_SECRET: 'SECRET' },
        },
        apps: ids.map((id) => {
          const home = join(appsHome, id),
            policy = join(home, id === 'leads' ? 'server/tenant-policy.ts' : 'policy.ts');
          return {
            id,
            directory: home,
            mount: id === 'lender' ? '/' : `/${id}`,
            config: businessConfig,
            ...(existsSync(policy) ? { policy } : {}),
            ...(id === 'leads' ? { jobs: join(home, 'server/jobs.ts') } : {}),
            environment: { KEYSTONE_DATABASE_URL: 'DATABASE', ...(id === 'leads' ? { MISTRI_AUDIT_KEY: 'AUDIT' } : {}) },
          };
        }),
      },
      {
        publicOrigin,
        siteHost,
        policy: join(appsHome, 'site/policy.ts'),
        tenant: DEALER.id,
        sourceIdentity: await inspectPlacementSource(owned.url),
      },
    );
    const environment = {
      DATABASE: owned.url,
      SECRET: state.identitySecret,
      AUDIT: state.auditSecret,
      [placementSecretEnv]: enrolled.state.publicPlacement.secret,
    };
    writeFileSync(file, JSON.stringify(enrolled.deployment));
    const config = await readSuiteConfiguration(file, environment);
    const deployments = await Promise.all(
      config.apps.map(async (deployment) => ({
        app: await loadApp(deployment.directory, { lock: 'enforce' }),
        basePath: deployment.mount,
        environment: deployment.environment,
        connections: (await loadConfig(deployment.config, CONFIG_SECTIONS))!.connections,
      })),
    );
    const leads = deployments.find((item) => item.app.app.id === 'leads')!.app;
    assert.ok(leads.commands);
    const jobsPath = pathToFileURL(join(appsHome, 'leads/server/jobs.ts')).href;
    const { default: jobs } = await import(jobsPath);
    const binding = { appId: 'leads', source: { id: 'keystone', connection: 'keystone' }, storeId: 'keystone-dealers' };
    // Seed already owns command/history/inbox DDL. All remaining DDL precedes opening any App host.
    await provisionPostgresPublicPlacementJournal(owned.url);
    await migratePostgresTenantStore(owned.url, binding);
    await migratePostgresTenantAdministrationJournal(owned.url, binding);
    await migratePostgresTenantInvitations(owned.url, binding);
    await provisionStores({ postgres: owned.url }, { app: { tenant: binding } });
    await provisionStores({ postgres: owned.url }, { app: { tenant: binding, commands: leads.commands.registry }, jobs });
    await migratePostgresSupportAudit(owned.url, binding, supportAuditKey(environment.AUDIT));

    const identity = await openSuiteIdentity(config, deployments);
    const password = 'keystone-suite-test-password-123';
    const accounts: Record<string, string> = {};
    try {
      for (const name of ['owner', 'root', 'support'])
        accounts[name] = await createNativeAccount(
          identity.native,
          { name, email: `${name}@suite.example.test`, password },
          { by: 'maintenance' },
        );
      for (const [name, appId, role] of [
        ['owner', 'leads', 'owner'],
        ['owner', 'dealer', 'manager'],
        ['root', 'lender', 'admin'],
        ['support', 'leads', 'dealer_support'],
      ]) {
        identity.grants.change({
          subjectId: accounts[name],
          appId,
          roles: [role],
          expectedRevision: 0,
          declaredRoles: assignableRoles(deployments.find((item) => item.app.app.id === appId)!.app.app.auth),
          actorId: 'test-operator',
        });
      }
    } finally {
      identity.close();
    }
    control = await pgClient(owned.url);
    const dealers = (await control.query("SELECT id FROM dealer WHERE status = 'active' ORDER BY id LIMIT 2")).rows;
    assert.equal(dealers.length, 2);
    const [own, other] = dealers.map((row) => String(row.id));
    const seat = (
      await control.query("SELECT id FROM dealer_user WHERE dealer_id = $1 AND role = 'owner' AND status = 'active' LIMIT 1", [own])
    ).rows[0];
    assert.ok(seat);
    // Deliberately unrelated login email: both Apps resolve an explicitly linked business seat.
    await control.query('UPDATE dealer_user SET account_id = $1, dealer_account_id = $1 WHERE id = $2', [accounts.owner, seat.id]);
    const intakeAddress = randomUUID().replaceAll('-', '');
    await control.query('UPDATE dealer SET intake_address = $1 WHERE id = $2', [intakeAddress, own]);
    const operations = new TransactionOperations();
    await control.query('BEGIN');
    try {
      const admin = createPostgresTenantAdministration(control, operations, binding);
      await admin.putPlatform({ status: 'active', expectedVersion: null });
      for (const tenantId of [own, other]) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
      await admin.putMembership({
        tenantId: own,
        accountId: accounts.owner,
        membershipId: 'suite-owner',
        roles: ['owner'],
        status: 'active',
        expectedVersion: null,
        validUntil: Date.now() + 600_000,
      });
      await admin.putPlatformMembership({
        accountId: accounts.support,
        membershipId: 'suite-support',
        roles: ['dealer_support'],
        status: 'active',
        expectedVersion: null,
        validUntil: Date.now() + 600_000,
      });
      await operations.finish();
      await control.query('COMMIT');
    } catch (error) {
      await operations.finish().catch(() => {});
      await control.query('ROLLBACK');
      throw error;
    }
    const expected = (await control.query('SELECT id FROM lead WHERE dealer_id = $1', [own])).rows.map((row) => String(row.id)).sort();
    assert.ok(expected.length > 0);
    assert.ok((await control.query('SELECT id FROM lead WHERE dealer_id = $1 LIMIT 1', [other])).rows.length);

    try {
      suite = await startConfiguredSuite(file, environment);
    } catch (error) {
      t.diagnostic(JSON.stringify(refusalReasons(error)));
      throw error;
    }
    assert.equal(suite.server.listening, true);
    // Exercise the launcher's HTTPS host routing through its loopback upstream.
    const call = (path: string, headers: Record<string, string> = {}, body?: unknown) =>
      new Promise<{ status: number; text: string; body: any; cookie: string }>((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const req = request(
          {
            hostname: '127.0.0.1',
            port,
            path,
            method: payload === undefined ? 'GET' : 'POST',
            headers: {
              host: new URL(publicOrigin).host,
              origin: publicOrigin,
              'content-type': 'application/json',
              ...(payload === undefined ? {} : { 'content-length': Buffer.byteLength(payload) }),
              ...headers,
            },
            signal: AbortSignal.timeout(10_000),
          },
          (response) => {
            let text = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
              text += chunk;
            });
            response.on('error', reject);
            response.on('end', () => {
              try {
                resolve({
                  status: response.statusCode!,
                  text,
                  body: text ? JSON.parse(text) : {},
                  cookie: (response.headers['set-cookie'] ?? []).map((value) => value.split(';')[0]).join('; '),
                });
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        req.on('error', reject);
        req.end(payload);
      });
    type Answer = Awaited<ReturnType<typeof call>>;
    const ok = (answer: Answer) => {
      assert.equal(answer.status, 200, answer.text);
      return answer.body;
    };
    const denied = (answer: Answer) => {
      assert.ok(answer.status >= 400 && answer.status < 500, answer.text);
    };
    for (const id of ids) {
      const who = ok(await call(`${id === 'lender' ? '' : `/${id}`}/api/whoami${id === 'leads' ? '?app=leads' : ''}`));
      assert.equal(who.appId, id);
      assert.equal(who.signedIn, false);
    }
    const login = async (name: string, mount = '') => {
      const answer = await call(`${mount}/api/auth/sign-in/email`, {}, { email: `${name}@suite.example.test`, password });
      assert.equal(ok(answer).user.id, accounts[name]);
      return { cookie: answer.cookie, 'x-mistri-account': accounts[name] };
    };
    const owner = await login('owner', '/dealer');
    assert.match(owner.cookie, /mistri-keystone.session_token=/);
    const chooser = (headers: Record<string, string>) => call('/api/suite/apps', headers);
    assert.deepEqual(
      ok(await chooser(owner)).apps.map((app: { id: string }) => app.id),
      ['leads', 'dealer'],
    );
    for (const mount of ['/leads', '/dealer'])
      assert.equal(ok(await call(`${mount}/api/whoami${mount === '/leads' ? '?app=leads' : ''}`, owner)).accountId, accounts.owner);
    ok(await call('/dealer/api/schema', owner));
    const dealerRows = ok(await call('/dealer/api/query', owner, { table: 'dealer', columns: ['id'] })).rows;
    assert.deepEqual(dealerRows, [{ id: own }]);
    denied(await call('/customer/api/schema', owner));
    denied(await call('/api/schema', owner));

    const selector = `?app=leads&tenant=${encodeURIComponent(own)}`;
    const opened = ok(await call(`/leads/api/tenant/context/open${selector}`, owner, {}));
    const context = {
      ...owner,
      'x-mistri-tab': opened.tabId as string,
      'x-mistri-context': opened.context as string,
      'x-mistri-lease-revision': String(opened.revision),
    };
    const query = { table: 'lead', columns: ['id'], limit: 1000 };
    const rows = ok(await call(`/leads/api/query${selector}`, context, query)).rows as Array<{ id: string }>;
    assert.deepEqual(rows.map((row) => row.id).sort(), expected);
    denied(await call(`/leads/api/tenant/context/open?app=leads&tenant=${encodeURIComponent(other)}`, owner, {}));
    denied(await call(`/leads/api/query?app=leads&tenant=${encodeURIComponent(other)}`, context, query));
    const featureHeaders = { ...owner, 'x-mistri-app': 'leads' };
    assert.ok(ok(await call('/leads/api/tenant/administration/open?app=leads', featureHeaders, {})).session.context);

    const rootAdmin = await login('root');
    ok(await call('/api/schema', rootAdmin));
    assert.deepEqual(
      ok(await chooser(rootAdmin)).apps.map((app: { id: string }) => app.id),
      ['lender'],
    );
    denied(await call(`/leads/api/query${selector}`, { ...context, ...rootAdmin }, query));
    denied(await call(`/leads/api/tenant/context/open${selector}`, rootAdmin, {}));
    denied(await call('/leads/api/tenant/administration/open?app=leads', { ...rootAdmin, 'x-mistri-app': 'leads' }, {}));
    denied(await call('/leads/api/suite/grants', rootAdmin, { subjectId: accounts.root, roles: ['owner'], expectedRevision: 0 }));
    denied(await call('/leads/api/apps/leads/v1/lead', { authorization: 'Bearer no-suite-transport' }));
    // A real cross-App workflow: the dealer submits a selected structure, and
    // the lender reads the exact application the tenant command committed.
    const ready = (
      await control.query(
        `SELECT d.id FROM deal d
    JOIN deal_scenario s ON s.deal_id = d.id AND s.selected
    JOIN applicant a ON a.id = d.applicant_id
    WHERE d.dealer_id = $1 AND d.status = 'structuring' AND d.program_id IS NOT NULL AND a.monthly_income > 0
      AND NOT EXISTS (SELECT 1 FROM loan_application l WHERE l.deal_id = d.id)
    ORDER BY d.id LIMIT 1`,
        [own],
      )
    ).rows[0];
    assert.ok(ready, 'the seeded dealer has a structured deal ready for submission');
    const prepare = { command: 'submitToLender', commandVersion: 1, key: { id: ready.id } };
    const prepared = ok(await call(`/leads/api/commands/prepare${selector}`, context, prepare));
    const submit = {
      ...prepare,
      expectedVersion: prepared.expectedVersion,
      idempotencyKey: randomUUID(),
      input: { dealer_note: 'Suite acceptance workflow' },
    };
    denied(await call(`/leads/api/commands/execute${selector}`, { ...context, ...rootAdmin }, submit));
    const submitted = ok(await call(`/leads/api/commands/execute${selector}`, context, submit));
    assert.equal(submitted.result.message, 'Submitted to Keystone.');
    const applicationId = submitted.result.applicationId;
    const lenderRead = ok(
      await call('/api/query', rootAdmin, {
        table: 'loan_application',
        columns: ['id', 'dealer_id', 'status'],
        filter: { groups: [[{ column: 'id', op: '=', value: applicationId }]] },
      }),
    );
    assert.deepEqual(lenderRead.rows, [{ id: applicationId, dealer_id: own, status: 'submitted' }]);
    const recovered = ok(await call(`/leads/api/commands/status${selector}`, context, submit));
    assert.equal(recovered.result.applicationId, applicationId);
    assert.equal((await control.query('SELECT id FROM loan_application WHERE deal_id = $1', [ready.id])).rows.length, 1);

    // Reobserve operator grants with the same native login: source membership
    // grants no lender access, and no source tenant context crosses the link.
    const lenderLink = {
      sourceApp: 'leads',
      target: { app: 'lender', kind: 'record', resource: 'loan_application', key: { id: applicationId } },
    };
    const unavailable = await call('/api/suite/links/resolve', owner, lenderLink);
    assert.equal(unavailable.status, 404, unavailable.text);
    assert.equal(unavailable.body.href, undefined);
    await changeSuiteGrant(file, { subjectId: accounts.owner, appId: 'lender', roles: ['admin'], expectedRevision: 0 }, environment);
    const resolved = ok(await call('/api/suite/links/resolve', owner, lenderLink));
    assert.deepEqual(resolved, { accountId: accounts.owner, href: `/applications/${encodeURIComponent(applicationId)}` });
    assert.equal(ok(await call('/api/whoami', owner)).accountId, accounts.owner);
    assert.deepEqual(
      ok(await chooser(owner)).apps.map((app: { id: string }) => app.id),
      ['lender', 'leads', 'dealer'],
    );
    const applicationQuery = {
      table: 'loan_application',
      columns: ['id', 'dealer_id', 'status'],
      filter: { groups: [[{ column: 'id', op: '=', value: applicationId }]] },
    };
    assert.deepEqual(ok(await call('/api/query', owner, applicationQuery)).rows, lenderRead.rows);
    const document = await fetch(`http://127.0.0.1:${port}${resolved.href}`, {
      headers: owner,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(document.status, 200, await document.text());

    await changeSuiteGrant(file, { subjectId: accounts.owner, appId: 'lender', roles: [], expectedRevision: 1 }, environment);
    const revoked = await call('/api/suite/links/resolve', owner, lenderLink);
    assert.equal(revoked.status, 404, revoked.text);
    assert.equal(revoked.body.href, undefined);
    denied(await call('/api/query', owner, applicationQuery));
    assert.deepEqual(
      ok(await chooser(owner)).apps.map((app: { id: string }) => app.id),
      ['leads', 'dealer'],
    );
    assert.deepEqual(
      ok(await call(`/leads/api/query${selector}`, context, query))
        .rows.map((row: { id: string }) => row.id)
        .sort(),
      expected,
    );
    assert.deepEqual(ok(await call('/dealer/api/query', owner, { table: 'dealer', columns: ['id'] })).rows, dealerRows);
    ok(await call(`/leads/api/tenant/context/open${selector}`, owner, {}));
    assert.deepEqual(ok(await call('/api/query', rootAdmin, applicationQuery)).rows, lenderRead.rows);
    const rootSource = await call('/api/suite/links/resolve', rootAdmin, lenderLink);
    assert.equal(rootSource.status, 404, rootSource.text);
    assert.equal(rootSource.body.href, undefined);

    const support = await login('support', '/leads');
    const supported = ok(
      await call(
        '/leads/api/tenant/support/open?app=leads',
        { ...support, 'x-mistri-app': 'leads' },
        {
          idempotencyKey: randomUUID(),
          intent: { operation: 'openSupport', tenantId: own, dealerRole: 'viewer', reason: 'Test dealer assistance' },
        },
      ),
    );
    assert.equal(supported.receipt.session.operatorName, 'support');

    const catalogQuery = { table: 'vehicle', columns: ['id'], limit: 1000 };
    assert.ok(ok(await call('/marketplace/api/query', {}, catalogQuery)).rows.length > 0);
    assert.deepEqual(ok(await call('/site/api/query', {}, catalogQuery)).rows, []);
    const siteHeaders = { host: siteHost, origin: `https://${siteHost}` };
    const siteVehicles = (await control.query('SELECT id FROM vehicle WHERE dealer_id = $1', [DEALER.id])).rows;
    assert.ok(siteVehicles.length > 0);
    assert.ok((await control.query('SELECT id FROM vehicle WHERE dealer_id <> $1 LIMIT 1', [DEALER.id])).rows.length);
    assert.deepEqual(
      ok(await call('/site/api/query', siteHeaders, catalogQuery))
        .rows.map((row: { id: string }) => row.id)
        .sort(),
      siteVehicles.map((row) => String(row.id)).sort(),
    );
    assert.deepEqual(ok(await call('/site/api/query', siteHeaders, { table: 'dealer', columns: ['id'] })).rows, [{ id: DEALER.id }]);
    const apply = leads.app.views.apply;
    assert.ok(isFormView(apply));
    const step = apply.steps![0].id;
    const draft = await call(
      `/leads/api/forms/apply/steps/${step}?via=${intakeAddress}`,
      {},
      {
        submission: randomUUID(),
        input: { first_name: 'Suite', last_name: 'Applicant', email: 'intake@suite.example.test', phone: '2155550123' },
      },
    );
    ok(draft);
    assert.match(draft.cookie, /tw_form_apply=/);
    assert.deepEqual((await control.query("SELECT dealer_id, status FROM lead WHERE email = 'intake@suite.example.test'")).rows, [
      { dealer_id: own, status: 'draft' },
    ]);
    assert.equal((await control.query("SELECT id FROM intake_submission WHERE email = 'intake@suite.example.test'")).rows.length, 0);

    ok(await call('/dealer/api/auth/sign-out', owner, {}));
    denied(await chooser(owner));
    denied(await call('/dealer/api/schema', owner));
    denied(await call(`/leads/api/query${selector}`, context, query));
    ok(await call('/api/schema', rootAdmin)); // A different person's login is still live.
  },
);
