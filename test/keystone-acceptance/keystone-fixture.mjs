/** The actual Keystone lender and dealer Apps, using only public mistri helpers. */
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { createTestWorkspace, startTestSuite, startService } from '@mistriwork/mistri/testing';
import { createCreditService } from './credit-service.ts';

export async function createKeystoneFixture(adminURL) {
  const workspace = await createTestWorkspace();
  try {
    const name = `tw_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Client({ connectionString: adminURL });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
    } finally {
      await admin.end();
    }
    workspace.own(async () => {
      const admin = new pg.Client({ connectionString: adminURL });
      await admin.connect();
      try {
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    });
    const address = new URL(adminURL);
    address.pathname = `/${name}`;
    const databaseURL = address.href;
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const config = workspace.path('connections.json');
    await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', 'test/fixtures/databases/keystone/seed-postgres.mjs', databaseURL, config, '--photos', 'none'],
      {
        cwd: root,
        env: { ...process.env, KEYSTONE_TODAY: '2026-09-15' },
        timeout: 60000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    const database = new pg.Client({ connectionString: databaseURL });
    await database.connect();
    workspace.own(() => database.end());
    // The provider signs with the real clock: the lender's inbound endpoint refuses a stale delivery.
    const secret = 'keystone-credit-callback-test-key',
      now = Date.now();
    const appsHome = (await workspace.copy(fileURLToPath(new URL('../fixtures/apps/keystone/', import.meta.url)), 'apps')) + '/';
    let host;
    const provider = await startService(
      createCreditService({
        callbackUrl: () => `${host.url}/lender/api/inbound/creditResult`,
        secret,
        // A clear score: the credit decision approves it without an underwriter.
        score: () => 760,
      }),
      { now, seed: 42 },
    );
    workspace.own(() => provider.close());
    // The credit decision asks for the check through a declared webhook connection, not through code of the App's own.
    const connections = JSON.parse(await readFile(config, 'utf8'));
    connections.connections.push({ name: 'credit-provider', kind: 'webhook', url: provider.url });
    await writeFile(config, `${JSON.stringify(connections, null, 2)}\n`);
    // Select two actual Apps and narrow only their shared menu to this test deployment.
    await workspace.write(
      'apps/navigation.ts',
      "export const appSwitcher = { placement: 'navbar', label: 'Apps', apps: ['lender', 'dealer'] } as const;\n",
    );
    await mkdir(workspace.path('node_modules/@mistriwork'), { recursive: true });
    await symlink(
      dirname(createRequire(import.meta.url).resolve('@mistriwork/mistri/package.json')),
      workspace.path('node_modules/@mistriwork/mistri'),
      'dir',
    );
    host = await startTestSuite({
      workspace,
      timeoutMs: 90000,
      environment: {
        DATABASE: databaseURL,
        CREDIT_SECRET: secret,
        SECRET: 'keystone-suite-public-test-secret-longer-than-thirty-two-characters',
      },
      configuration: {
        identity: { id: 'keystone-test', store: './identity.db', grants: './grants.db', environment: { BETTER_AUTH_SECRET: 'SECRET' } },
        apps: ['lender', 'dealer'].map((id) => ({
          id,
          directory: `${appsHome}${id}`,
          mount: `/${id}`,
          config,
          ...(id === 'dealer' ? { policy: `${appsHome}${id}/policy.ts` } : { jobs: `${appsHome}${id}/server/jobs.ts` }),
          environment: { KEYSTONE_DATABASE_URL: 'DATABASE', ...(id === 'lender' ? { CREDIT_CALLBACK_SECRET: 'CREDIT_SECRET' } : {}) },
        })),
      },
    });
    const password = 'keystone-fixture-password-long-enough';
    const lenderEmail = (await database.query("SELECT email FROM lender_user WHERE role='credit_manager' AND active LIMIT 1")).rows[0]
      .email;
    const lenderId = await host.account({ name: 'Credit manager', email: lenderEmail, password });
    const dealerId = await host.account({ name: 'Dealer owner', email: 'fixture-dealer@example.test', password });
    await host.grant({ appId: 'lender', subjectId: lenderId, roles: ['credit_manager'], expectedRevision: 0 });
    await host.grant({ appId: 'dealer', subjectId: dealerId, roles: ['manager'], expectedRevision: 0 });
    const seat = (await database.query("SELECT id,dealer_id FROM dealer_user WHERE role='owner' AND status='active' ORDER BY id LIMIT 1"))
      .rows[0];
    await database.query('UPDATE dealer_user SET dealer_account_id=$1 WHERE id=$2', [dealerId, seat.id]);
    const lender = host.client(),
      dealer = host.client();
    await lender.signIn(lenderEmail, password);
    await dealer.signIn('fixture-dealer@example.test', password);
    // A file under review whose program can lend what was asked: the one a clear score approves on its own.
    const file = (
      await database.query(`SELECT f.id, f.application_id, f.score FROM underwriting_file f
      JOIN loan_application a ON a.id = f.application_id LEFT JOIN program p ON p.id = a.program_id
      WHERE a.status = 'in_review' AND (p.id IS NULL OR a.requested_amount <= p.max_amount) ORDER BY f.id LIMIT 1`)
    ).rows[0];
    /** An underwriter asks for the check on that file; the credit decision workflow requests it from the provider. Resolves with the provider's id for it. */
    async function checkCredit() {
      const headers = { 'x-mistri-account': lenderId };
      const key = { id: file.application_id };
      const prepared = await lender.request('/lender/api/commands/prepare', {
        method: 'POST',
        headers,
        json: { command: 'requestCreditCheck', commandVersion: 1, key },
      });
      if (prepared.status !== 200) throw new Error(`Preparing requestCreditCheck answered ${prepared.status}: ${await prepared.text()}`);
      const expectedVersion = (await prepared.json()).expectedVersion;
      const run = await lender.request('/lender/api/commands/execute', {
        method: 'POST',
        headers,
        json: {
          command: 'requestCreditCheck',
          commandVersion: 1,
          key,
          expectedVersion,
          idempotencyKey: `keystone-fixture-credit-${file.application_id}`,
          input: {},
        },
      });
      if (run.status !== 200) throw new Error(`requestCreditCheck answered ${run.status}: ${await run.text()}`);
      // The workflow's call is made by the host's job runner: wait for it to reach the provider.
      for (const deadline = Date.now() + 30_000; Date.now() < deadline; await new Promise((done) => setTimeout(done, 100))) {
        const asked = await fetch(`${provider.url}/checks/1`);
        if (asked.status === 200) return '1';
      }
      throw new Error('The credit decision did not request the check from the provider.');
    }
    return {
      workspace,
      host,
      lender,
      dealer,
      lenderId,
      dealerId,
      lenderEmail,
      password,
      dealerTenant: seat.dealer_id,
      database,
      file,
      provider,
      checkCredit,
      close: () => workspace.close(),
    };
  } catch (error) {
    await workspace.close();
    throw error;
  }
}
