/**
 * `mistri tenant init|grant`: a tenant App's first boot from the operator's
 * shell or a deployment's one-off job. The steps are the public
 * maintenance steps (tenant-maintenance-public.test.ts proves them on either
 * dialect); this proves the command reaches them as a start validates the
 * deployment, runs again after a stop part-way, and never takes a password on
 * its command line.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import * as maintenance from '@mistriwork/mistri/maintenance';
import { runTenantCommand } from '../packages/mistri/src/server/cli/tenantCommand.js';
import { ADMINISTRATION_JOURNAL_TABLES as journal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { TENANT_TABLES as tables } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { scratch } from './support/scratch.js';

const binding = { appId: 'lending', source: { id: 'business', connection: 'business-db' }, storeId: 'lending-store' };
const PASSWORD = 'first-boot-password-123';

async function fixture(t: TestContext, platform = true) {
  const { directory } = scratch(t, 'tablewalk-tenant-first-boot-');
  const appDir = join(directory, 'app');
  mkdirSync(appDir);
  const data = join(directory, 'business.db'),
    config = join(directory, 'config.json'),
    policy = join(directory, 'policy.mjs');
  const db = new DatabaseSync(data);
  db.exec(
    `${platform ? 'CREATE TABLE dealer (id TEXT PRIMARY KEY); ' : ''}CREATE TABLE lead (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL)`,
  );
  db.close();
  // As `mistri migrate stores up --policy` does before a first start.
  await maintenance.provisionStores({ sqlite: data }, { app: { tenant: binding }, only: ['tenant-store', 'tenant-administration'] });
  writeFileSync(
    join(appDir, 'app.json'),
    JSON.stringify({
      id: 'lending',
      name: 'Lending',
      sources: { business: { connection: 'business-db' } },
      resources: { ...(platform ? { dealer: { owner: 'platform' } } : {}), lead: { owner: 'tenant' } },
      auth: {
        store: join(directory, 'auth.db'),
        signUp: 'invite',
        rows: 'tenant',
        tenancy: { label: 'Dealer', ...(platform ? { platform: { label: 'Lender' } } : {}) },
        roles: {
          staff: { ...(platform ? { realm: 'tenant' } : {}), read: true },
          ...(platform ? { manager: { realm: 'platform', read: true } } : {}),
        },
      },
      views: {
        leads: { kind: 'list', from: 'lead' },
        ...(platform ? { dealers: { kind: 'list', from: 'dealer', realm: 'platform' } } : {}),
      },
      nav: platform
        ? [
            { id: 'dealership', label: 'Dealership', realm: 'tenant', children: ['leads'] },
            { id: 'lender', label: 'Lender', realm: 'platform', children: ['dealers'] },
          ]
        : ['leads'],
      home: 'leads',
    }),
  );
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'business-db', url: data }] }));
  writeFileSync(
    policy,
    `const rows = () => ({ ${platform ? 'dealer: true, ' : ''}lead: true });
    export default { kind: 'tenant', appId: 'lending', storeId: 'lending-store',
      ownership: { ${platform ? "dealer: { kind: 'platform' }, " : ''}lead: { kind: 'tenant', column: 'tenant_id' } },
      resolveMembershipRows: rows, resolveRows: rows${platform ? ', resolvePlatformRows: rows' : ''} };`,
  );
  const password = process.env.MISTRI_ACCOUNT_PASSWORD;
  t.after(() => {
    if (password === undefined) delete process.env.MISTRI_ACCOUNT_PASSWORD;
    else process.env.MISTRI_ACCOUNT_PASSWORD = password;
  });
  /** The command as a shell runs it: its exit code, what it printed and what it refused. */
  const run = async (...argv: string[]) => {
    const lines: string[] = [];
    const errors: string[] = [];
    const error = console.error;
    console.error = (line: unknown) => errors.push(String(line));
    try {
      const code = await runTenantCommand(
        [...argv, '--app', appDir, '--policy', policy, '--config', config, '--operator', 'ops-ada'],
        (line) => lines.push(line),
      );
      return { code, out: lines.join('\n'), err: errors.join('\n') };
    } finally {
      console.error = error;
    }
  };
  const read = (sql: string) => {
    const handle = new DatabaseSync(data, { readOnly: true });
    try {
      return handle
        .prepare(sql)
        .all()
        .map((row) => ({ ...row }));
    } finally {
      handle.close();
    }
  };
  const anchors = () => read(`SELECT id, status, kind FROM "${tables.tenant}" ORDER BY id`);
  const memberships = () =>
    read(`SELECT tenant_id AS tenant, account_id AS account, status, roles_json AS roles FROM "${tables.membership}" ORDER BY tenant_id`);
  const receipts = () => read(`SELECT actor_id AS actor, operation FROM "${journal.receipt}" ORDER BY completed_at, id`);
  return { appDir, run, anchors, memberships, receipts };
}

test('init opens the platform realm and the named tenants, and a second run leaves them as they are', async (t) => {
  const f = await fixture(t);
  const first = await f.run('init', 'north', 'south');
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /^the platform realm: opened\. Receipt \S+\.\nnorth: opened\. Receipt \S+\.\nsouth: opened\. Receipt \S+\.$/);
  assert.deepEqual(
    f.anchors().map((row) => [row.id, row.status]),
    [
      ['@platform', 'active'],
      ['north', 'active'],
      ['south', 'active'],
    ],
  );
  // A stop part-way, then the job runs again with one tenant more: what is there is left, the rest is opened.
  const again = await f.run('init', 'north', 'west');
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /^the platform realm: already there, left as it is\.\nnorth: already there, left as it is\.\nwest: opened\./);
  assert.deepEqual(
    f.receipts().map((row) => [row.actor, row.operation]),
    [
      ['maintenance:ops-ada', 'setPlatformStatus'],
      ['maintenance:ops-ada', 'putTenant'],
      ['maintenance:ops-ada', 'putTenant'],
      ['maintenance:ops-ada', 'putTenant'],
    ],
  );
});

test('an App with no platform realm opens only its tenants', async (t) => {
  const f = await fixture(t, false);
  assert.match((await f.run('init')).out, /declares no platform realm, and no tenant was named: nothing to open\./);
  assert.equal((await f.run('init', 'north')).out.split('\n')[0].startsWith('north: opened.'), true);
  assert.deepEqual(
    f.anchors().map((row) => row.id),
    ['north'],
  );
});

test('grant makes the first operator account from the environment and grants it, and reuses the account on a rerun', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run('init', 'north')).code, 0);
  delete process.env.MISTRI_ACCOUNT_PASSWORD;
  const unset = await f.run('grant', 'lee@lender.example', '--roles', 'manager');
  assert.equal(unset.code, 1);
  assert.match(unset.err, /lee@lender\.example has no account yet: set MISTRI_ACCOUNT_PASSWORD/);
  assert.deepEqual(f.memberships(), []);

  process.env.MISTRI_ACCOUNT_PASSWORD = PASSWORD;
  const lee = await f.run('grant', 'lee@lender.example', '--roles', 'manager', '--name', 'Lee');
  assert.equal(lee.code, 0, lee.err);
  assert.match(
    lee.out,
    /^lee@lender\.example: an account was made in lending's auth store\.\nlee@lender\.example: manager of the platform realm until \d{4}-\d\d-\d\d\. Receipt \S+\.$/,
  );
  const sam = await f.run('grant', 'sam@north.example', '--roles', 'staff', '--tenant', 'north', '--days', '30');
  assert.equal(sam.code, 0, sam.err);
  assert.match(sam.out, /sam@north\.example: staff of north until/);
  const accounts = f.memberships();
  assert.deepEqual(
    accounts.map((row) => [row.tenant, row.status, row.roles]),
    [
      ['@platform', 'active', '["manager"]'],
      ['north', 'active', '["staff"]'],
    ],
  );
  const leeId = accounts[0].account;

  // The account a first run made is found again by its address, and the step's own refusal is what is said.
  const rerun = await f.run('grant', 'lee@lender.example', '--roles', 'manager');
  assert.equal(rerun.code, 1);
  assert.doesNotMatch(rerun.out, /an account was made/);
  assert.match(rerun.err, /mistri tenant: /);
  assert.equal(f.memberships()[0].account, leeId);
  for (const text of [lee.out, lee.err, sam.out, rerun.out, rerun.err]) assert.doesNotMatch(text, /first-boot-password/);

  // A realm's roles are its own: a tenant role is not a platform grant.
  const wrong = await f.run('grant', 'kim@lender.example', '--roles', 'staff');
  assert.equal(wrong.code, 1);
  assert.equal(f.memberships().length, 2);
});

test("init and grant refuse each other's options and a malformed address before anything opens", async (t) => {
  const f = await fixture(t);
  for (const [argv, refused] of [
    [['grant', 'not-an-address', '--roles', 'manager'], /grant names an email address/],
    [['grant', 'lee@lender.example'], /grant needs --roles/],
    [['init', 'north', '--roles', 'manager'], /--roles, --tenant, --name and --days are grant's/],
    [['grant', 'lee@lender.example', '--roles', 'manager', '--days', '400'], /--days is a whole number of days, 1 to 366/],
    [['grant', 'lee@lender.example', '--roles', 'manager', '--tenant', 'North!'], /--tenant names a tenant by id/],
    [['init', 'North!'], /init names its tenants by id/],
  ] as const) {
    const result = await f.run(...argv);
    assert.equal(result.code, 1, argv.join(' '));
    assert.match(result.err, refused, argv.join(' '));
  }
  assert.deepEqual(f.anchors(), []);
});
