import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  assertPlacementEnrollment,
  enrollPlacement,
  inspectPlacementSource,
  placementSecretEnv,
} from '../test/fixtures/apps/keystone/placement-launcher.mjs';
import { runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';
import { PUBLIC_PLACEMENT_TABLES } from '../packages/mistri/src/adapters/commands/publicPlacementSchema.js';
import { readSuiteConfiguration } from '../packages/mistri/src/server/cli/suiteConfig.js';
import { createSuitePublicPlacement } from '../packages/mistri/src/server/cli/suitePublicPlacement.js';
import { captureHttpPublicPlacement } from '../packages/mistri/src/server/http/publicPlacement.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { liveSkip } from './live.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';

const home = resolve('test/fixtures/apps/keystone'),
  launcher = join(home, 'start-suite.mjs');
const secret = () => randomBytes(32).toString('base64url');
const legacy = (database = 'postgres://operator@localhost/keystone') => ({
  version: 1,
  ready: true,
  database,
  identitySecret: secret(),
  auditSecret: secret(),
});
const deployment = () => ({
  port: 4880,
  identity: { id: 'keystone', store: './identity.db', grants: './grants.db', environment: { BETTER_AUTH_SECRET: 'SECRET' } },
  apps: [
    {
      id: 'site',
      directory: join(home, 'site'),
      config: './connections.json',
      mount: '/site',
      environment: { KEYSTONE_DATABASE_URL: 'DATABASE' },
    },
  ],
});
const enrollment = {
  publicOrigin: 'https://keystone.localhost',
  siteHost: 'liberty-ford.localhost',
  policy: join(home, 'site/policy.ts'),
  tenant: 'liberty-ford',
  sourceIdentity: 'physical-keystone-source',
};

test('launcher enrollment persists a dedicated issuer and Site policy; startup renews only the epoch', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'keystone-placement-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const original = legacy(),
    input = deployment();
  const enrolled = enrollPlacement(original, input, enrollment);
  assert.equal('publicPlacement' in original, false);
  assert.equal('policy' in input.apps[0], false);
  assert.equal(enrolled.state.identitySecret, original.identitySecret);
  assert.equal(enrolled.state.auditSecret, original.auditSecret);
  assert.equal(enrolled.state.database, original.database);
  assert.equal(Buffer.from(enrolled.state.publicPlacement.secret, 'base64url').length, 32);
  assert.notEqual(enrolled.state.publicPlacement.secret, original.identitySecret);
  assert.equal(enrolled.deployment.apps[0].policy, enrollment.policy);
  assert.deepEqual(enrolled.deployment.hosts, [{ host: enrollment.siteHost, app: 'site', tenant: enrollment.tenant }]);
  const retried = enrollPlacement(enrolled.state, enrolled.deployment, enrollment);
  assert.deepEqual(retried, enrolled);
  assert.throws(() => assertPlacementEnrollment(enrolled.state, enrolled.deployment, 'another-physical-db'), /enrollment/);
  assert.throws(
    () => enrollPlacement(enrolled.state, enrolled.deployment, { ...enrollment, sourceIdentity: 'another-physical-db' }),
    /enrollment/,
  );
  for (const siteHost of ['localhost', '127.0.0.1', 'keystone.localhost', '*.localhost']) {
    assert.throws(() => enrollPlacement(original, input, { ...enrollment, siteHost }));
  }
  assert.throws(() => enrollPlacement(original, input, { ...enrollment, publicOrigin: 'http://localhost:4880' }), /HTTPS|https/);
  const file = join(directory, 'suite.json');
  writeFileSync(file, JSON.stringify(enrolled.deployment));
  const config = await readSuiteConfiguration(file, {
    SECRET: original.identitySecret,
    DATABASE: original.database,
    [placementSecretEnv]: enrolled.state.publicPlacement.secret,
  });
  const app = parseAppConfig(
    {
      id: 'site',
      name: 'Site',
      sources: { keystone: { connection: 'keystone' } },
      resources: { inbox: {} },
      auth: { rows: 'policy', roles: { staff: { read: true } } },
      views: { inbox: { kind: 'list', from: 'inbox' } },
      home: 'inbox',
    },
    'Keystone launcher',
  );
  const first = (await createSuitePublicPlacement(config)!.forApp(app, enrollment.policy, '/site'))!;
  const second = (await createSuitePublicPlacement(config)!.forApp(app, enrollment.policy, '/site'))!;
  assert.notEqual(first.epoch, second.epoch);
  assert.equal(first.policyRevision, second.policyRevision);
  assert.match(first.policyRevision, /^[a-f0-9]{64}$/);
  assert.equal(first.sourceIdentities.get('keystone'), enrollment.sourceIdentity);
  assert.deepEqual(captureHttpPublicPlacement(first).origins, ['https://liberty-ford.localhost']);
  const token = first.issuer.issue({
    appId: 'site',
    form: 'ask',
    commandId: 'ask',
    commandVersion: 1,
    sourceIdentity: enrollment.sourceIdentity,
    tenant: enrollment.tenant,
    host: enrollment.siteHost,
    origin: first.origins[0],
    epoch: first.epoch,
    formRevision: first.policyRevision,
  });
  assert.equal(second.issuer.verifyRecovery(token.binding, token.submission, { appId: 'site', form: 'ask' }).epoch, first.epoch);
});

test(
  'explicit legacy upgrade is additive and idempotent; ordinary resume never provisions a journal',
  {
    skip: liveSkip('postgres', process.env.TABLEWALK_TEST_PG),
    timeout: 60_000,
  },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'keystone-placement-upgrade-'));
    const owned = await uuidPostgresDatabase('keystone_placement');
    const db = await pgClient(owned.url);
    t.after(async () => {
      await db.end();
      await owned.drop();
      rmSync(directory, { recursive: true, force: true });
    });
    await db.query("CREATE TABLE retained_business (value text); INSERT INTO retained_business VALUES ('preserved')");
    const state = legacy(owned.url),
      originalSuite = deployment();
    const save = (name: string, data: unknown) => writeFileSync(join(directory, name), JSON.stringify(data));
    save('runtime.json', state);
    save('suite.json', originalSuite);
    save('connections.json', { connections: [{ name: 'keystone', url: '${KEYSTONE_DATABASE_URL}', writable: true }] });
    save('credentials.json', { accounts: [{ password: 'unchanged-password', accountId: 'unchanged-id' }] });
    // Upgrade checks that the stores exist but must never open/recreate auth stores.
    writeFileSync(join(directory, 'identity.db'), 'untouched identity');
    writeFileSync(join(directory, 'grants.db'), 'untouched grants');
    const retained = ['credentials.json', 'identity.db', 'grants.db', 'connections.json'];
    const bytes = retained.map((name) => readFileSync(join(directory, name)));
    const run = (...args: string[]) =>
      promisify(execFile)(process.execPath, ['--import', 'tsx', launcher, '--runtime', directory, ...args], { timeout: 20_000 });
    await assert.rejects(run(), /upgrade-placement/);
    assert.equal(
      (await db.query('SELECT to_regclass($1) AS table', [runtimeTable('postgres', PUBLIC_PLACEMENT_TABLES.meta)])).rows[0].table,
      null,
    );
    const args = ['--upgrade-placement', '--public-origin', enrollment.publicOrigin, '--site-host', enrollment.siteHost];
    const first = await run(...args);
    assert.match(first.stdout, /Placement enrolled/);
    assert.doesNotMatch(first.stdout, /Suite:|unchanged-password/);
    const enrolled = JSON.parse(readFileSync(join(directory, 'runtime.json'), 'utf8'));
    assert.deepEqual({ ...enrolled, publicPlacement: undefined }, { ...state, publicPlacement: undefined });
    assert.equal(enrolled.publicPlacement.sourceIdentity, await inspectPlacementSource(owned.url, true));
    // Rotate a disposable login's real password: local trust authentication used
    // to hide that merely changing the URL cannot authenticate on a CI server.
    const role = `tw_placement_${randomBytes(12).toString('hex')}`;
    const login = new URL(owned.url);
    login.username = role;
    login.password = secret();
    await db.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${login.password}'`);
    try {
      assert.equal(await inspectPlacementSource(login.href), enrolled.publicPlacement.sourceIdentity);
      login.password = secret();
      await db.query(`ALTER ROLE "${role}" PASSWORD '${login.password}'`);
      assert.equal(await inspectPlacementSource(login.href), enrolled.publicPlacement.sourceIdentity);
    } finally {
      await db.query(`DROP ROLE "${role}"`);
    }
    assert.notEqual(await inspectPlacementSource(process.env.TABLEWALK_TEST_PG), enrolled.publicPlacement.sourceIdentity);
    const config = JSON.parse(readFileSync(join(directory, 'suite.json'), 'utf8'));
    assert.equal(config.port, originalSuite.port);
    assert.equal(config.apps[0].policy, enrollment.policy);
    assert.equal(config.publicOrigin, enrollment.publicOrigin);
    await run(...args);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'runtime.json'), 'utf8')), enrolled);
    for (const [index, name] of retained.entries()) assert.deepEqual(readFileSync(join(directory, name)), bytes[index]);
    for (const name of ['runtime.json', 'suite.json', ...retained]) assert.equal(statSync(join(directory, name)).mode & 0o777, 0o600);
    assert.deepEqual((await db.query('SELECT * FROM retained_business')).rows, [{ value: 'preserved' }]);
    await db.query(
      `DROP TABLE ${runtimeTable('postgres', PUBLIC_PLACEMENT_TABLES.receipt)}, ${runtimeTable('postgres', PUBLIC_PLACEMENT_TABLES.meta)}`,
    );
    await assert.rejects(run());
    assert.equal(
      (await db.query('SELECT to_regclass($1) AS table', [runtimeTable('postgres', PUBLIC_PLACEMENT_TABLES.meta)])).rows[0].table,
      null,
    );
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'runtime.json'), 'utf8')), enrolled);
  },
);
