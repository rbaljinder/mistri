/**
 * `mistri shot --as <role> [--tenant <id>]` on a tenant App grants its
 * temporary account a membership through public maintenance, and `release`
 * revokes it through the same steps, journaled under the same operator: the
 * App's tenant store keeps no live grant for a shot that is over. Release is
 * safe to call twice, and says what it could not do rather than throwing.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import * as maintenance from '../packages/mistri/src/server/maintenance.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { runShot } from '../packages/mistri/src/server/build/shot.js';
import { tenantShotAccount } from '../packages/mistri/src/server/build/shotTenant.js';
import { ADMINISTRATION_JOURNAL_TABLES as journal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { TENANT_TABLES as tables } from '../packages/mistri/src/server/tenant/tenantStore.js';

const binding = { appId: 'lending', source: { id: 'business', connection: 'db' }, storeId: 'lending-store' };

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-shot-tenant-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(directory, 'config');
  t.after(() => {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  });
  const path = join(directory, 'business.db'),
    db = new DatabaseSync(path);
  t.after(() => db.close());
  db.exec('CREATE TABLE branch (id TEXT PRIMARY KEY); CREATE TABLE lead (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL)');
  await maintenance.provisionStores({ sqlite: path }, { app: { tenant: binding }, only: ['tenant-store', 'tenant-administration'] });
  const app = join(directory, 'app');
  mkdirSync(app);
  // No auth.store: shot makes its account in a store of its own, under its own config directory.
  writeFileSync(
    join(app, 'app.json'),
    JSON.stringify({
      id: 'lending',
      name: 'Lending',
      sources: { business: { connection: 'db' } },
      resources: { branch: { owner: 'platform' }, lead: { access: 'write', owner: 'tenant' } },
      auth: {
        signUp: 'invite',
        rows: 'tenant',
        tenancy: { label: 'Branch', profile: 'branch', platform: { label: 'Lender' } },
        roles: { staff: { realm: 'tenant', read: true, write: ['lead'] }, manager: { realm: 'platform', read: true } },
      },
      views: { leads: { kind: 'list', from: 'lead' }, branches: { kind: 'list', from: 'branch' } },
      nav: [
        { id: 'office', label: 'Office', realm: 'tenant', children: ['leads'] },
        { id: 'lender', label: 'Lender', realm: 'platform', children: ['branches'] },
      ],
      home: 'leads',
    }),
  );
  const policy = join(directory, 'tenant-policy.mjs');
  writeFileSync(
    policy,
    `export default { kind: 'tenant', appId: 'lending', storeId: 'lending-store',
    ownership: { branch: { kind: 'platform' }, lead: { kind: 'tenant', column: 'tenant_id' } },
    resolveMembershipRows() { return { lead: true }; }, resolveRows() { return { lead: true }; },
    resolvePlatformRows() { return { branch: true, lead: true }; } };`,
  );
  const operator = 'ops-ada',
    where = { sqlite: path };
  await maintenance.setPlatformStatus(where, binding, { status: 'active', expectedVersion: null, operator });
  await maintenance.putTenant(where, binding, { tenantId: 'north', status: 'active', expectedVersion: null, operator });
  const account = async (role: string, tenant?: string) => {
    const xdg = join(directory, `shot-${role}`);
    mkdirSync(xdg);
    return tenantShotAccount({
      loaded: await loadApp(app),
      appDir: app,
      role,
      tenant,
      policy,
      connection: { name: 'db', url: path },
      xdg,
      refuse: (why) => {
        throw new Error(why);
      },
    });
  };
  const memberships = () =>
    db
      .prepare(`SELECT tenant_id AS tenant, status, version FROM "${tables.membership}" ORDER BY tenant_id`)
      .all()
      .map((row) => ({ ...row }));
  const receipts = () =>
    db
      .prepare(`SELECT actor_id AS actor, tenant_id AS tenant, operation FROM "${journal.receipt}"
    WHERE actor_id = 'maintenance:mistri-shot' ORDER BY completed_at, id`)
      .all()
      .map((row) => ({ ...row }));
  writeFileSync(join(directory, 'mistri.json'), JSON.stringify({ connections: [{ name: 'db', url: path }] }));
  const shoot = async (args: string[]) => {
    const err: string[] = [];
    /* The browser's scratch goes in the fixture's directory, which the test removes, as shot-interaction.test.ts
       says: CI's Node legs run before Playwright installs its browser, and the runner's Chrome it falls back to
       leaves its profile in TMPDIR, which the lane's leak check fails. */
    const temp = mkdtempSync(join(directory, 'tmp-'));
    const was = process.env.TMPDIR;
    process.env.TMPDIR = temp;
    try {
      const code = await runShot(
        ['--app', app, '--config', join(directory, 'mistri.json'), '--policy', policy, ...args],
        () => {},
        (line) => err.push(line),
      );
      return { code, err: err.join('\n') };
    } finally {
      if (was === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = was;
    }
  };
  return { account, memberships, receipts, shoot };
}

test('a tenant shot revokes the membership it granted, journaled as its grant was, and a second release does nothing', async (t) => {
  const f = await fixture(t);
  const member = await f.account('staff', 'north');
  assert.deepEqual(f.memberships(), [{ tenant: 'north', status: 'active', version: '1' }]);
  assert.equal(await member.release(), undefined);
  assert.equal(await member.release(), undefined);
  assert.deepEqual(f.memberships(), [{ tenant: 'north', status: 'revoked', version: '2' }]);
  assert.deepEqual(f.receipts(), [
    { actor: 'maintenance:mistri-shot', tenant: 'north', operation: 'grantTenantMembership' },
    { actor: 'maintenance:mistri-shot', tenant: 'north', operation: 'revokeTenantMembership' },
  ]);
});

test('a platform shot revokes its platform membership the same way', async (t) => {
  const f = await fixture(t);
  const member = await f.account('manager');
  assert.equal(await member.release(), undefined);
  assert.deepEqual(f.memberships(), [{ tenant: '@platform', status: 'revoked', version: '2' }]);
  assert.deepEqual(
    f.receipts().map((row) => row.operation),
    ['grantPlatformMembership', 'revokePlatformMembership'],
  );
});

test('a shot that fails after the grant still revokes it, and says it writes a temporary membership', async (t) => {
  const f = await fixture(t);
  // An address the App does not answer to is refused after the account is made, before anything is served.
  const { code, err } = await f.shoot(['--as', 'staff', '--tenant', 'north', 'nowhere/1']);
  if (/install --only-shell chromium/i.test(err) && !f.memberships().length) {
    t.skip('no Chromium here: shot refuses before it grants');
    return;
  }
  assert.equal(code, 1, err);
  assert.match(err, /temporary membership to the App's tenant store and removes it after/);
  assert.deepEqual(f.memberships(), [{ tenant: 'north', status: 'revoked', version: '2' }]);
  assert.deepEqual(
    f.receipts().map((row) => row.operation),
    ['grantTenantMembership', 'revokeTenantMembership'],
  );
});
