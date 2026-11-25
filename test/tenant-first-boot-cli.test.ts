/**
 * `mistri tenant init|grant`: a tenant App's first boot from the operator's
 * shell or a deployment's one-off job. The steps are the public
 * maintenance steps (tenant-maintenance-public.test.ts proves them on either
 * dialect); this proves the command reaches them as a start validates the
 * deployment, runs again after a stop part-way, and never takes a password on
 * its command line.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import * as maintenance from '@mistriwork/mistri/maintenance';
import { BRANDING_TABLES } from '../packages/mistri/src/adapters/branding/branding.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { appAuthStore } from '../packages/mistri/src/server/auth/auth.js';
import { prepareDev } from '../packages/mistri/src/server/cli/devMode.js';
import { runTenantCommand } from '../packages/mistri/src/server/cli/tenantCommand.js';
import { ADMINISTRATION_JOURNAL_TABLES as journal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { TENANT_TABLES as tables } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { scratch } from './support/scratch.js';

const binding = { appId: 'lending', source: { id: 'business', connection: 'business-db' }, storeId: 'lending-store' };
const PASSWORD = 'first-boot-password-123';

async function fixture(t: TestContext, platform = true, named = true, branded = false) {
  const { directory } = scratch(t, 'mistri-tenant-first-boot-');
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
  if (branded) await maintenance.provisionStores({ sqlite: data }, { only: ['branding'] });
  writeFileSync(
    join(appDir, 'app.json'),
    JSON.stringify({
      id: 'lending',
      name: 'Lending',
      ...(branded ? { branding: { allow: ['name', 'accent'], editors: ['staff'] } } : {}),
      sources: { business: { connection: 'business-db' } },
      resources: { ...(platform ? { dealer: { owner: 'platform' } } : {}), lead: { owner: 'tenant' } },
      auth: {
        ...(named ? { store: join(directory, 'auth.db') } : {}),
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
  const receipts = () => read(`SELECT actor_id AS actor, operation FROM "${journal.receipt}" ORDER BY completed_at, rowid`);
  const branding = () => read(`SELECT tenant, value_json AS value, saved_by AS by FROM "${BRANDING_TABLES.value}" ORDER BY tenant`);
  return { directory, appDir, run, anchors, memberships, receipts, branding };
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
    /^lee@lender\.example: an account was made in the store lending names \(\S+auth\.db\)\.\nlee@lender\.example: manager of the platform realm until \d{4}-\d\d-\d\d\. Receipt \S+\.$/,
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

  // The account a first run made is found again by its address, and a membership it already holds is left as it is.
  const rerun = await f.run('grant', 'lee@lender.example', '--roles', 'manager');
  assert.equal(rerun.code, 0, rerun.err);
  assert.doesNotMatch(rerun.out, /an account was made/);
  assert.match(rerun.out, /lee@lender\.example: already holds a membership of the platform realm, left as it is\./);
  assert.equal(f.memberships().length, 2);
  assert.equal(f.memberships()[0].account, leeId);
  for (const text of [lee.out, lee.err, sam.out, rerun.out, rerun.err]) assert.doesNotMatch(text, /first-boot-password/);

  // A realm's roles are its own: a tenant role is not a platform grant.
  const wrong = await f.run('grant', 'kim@lender.example', '--roles', 'staff');
  assert.equal(wrong.code, 1);
  assert.equal(f.memberships().length, 2);
});

/* grant made its account in the store a plain start keeps, `mistri dev` signed in against its own under the App's
   .mistri/, and the sign-in failed with the grant reported done (a field report). grant now keeps accounts by the
   rule shot --as reads by, and says which store it wrote. */
test('grant makes the account where mistri dev signs in once dev has started the App, and says which store', async (t) => {
  const f = await fixture(t, true, false);
  const xdg = process.env.XDG_CONFIG_HOME;
  t.after(() => {
    if (xdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = xdg;
  });
  // The person's own config directory, as ~/.config is.
  const own = join(f.directory, 'home-config');
  process.env.XDG_CONFIG_HOME = own;
  const emails = (file: string) => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return db
        .prepare('SELECT email FROM "user" ORDER BY email')
        .all()
        .map((row) => String(row.email));
    } finally {
      db.close();
    }
  };
  assert.equal((await f.run('init', 'north')).code, 0);
  process.env.MISTRI_ACCOUNT_PASSWORD = PASSWORD;
  const loaded = await loadApp(f.appDir);
  const start = appAuthStore(loaded);

  // Before dev has started the App here: a plain start's store, said so, and that dev keeps its own.
  const ada = await f.run('grant', 'ada@north.example', '--roles', 'staff', '--tenant', 'north');
  assert.equal(ada.code, 0, ada.err);
  assert.ok(
    ada.out.startsWith(`ada@north.example: an account was made in the store a start of lending keeps (${start}); mistri dev keeps its own`),
    ada.out,
  );
  assert.deepEqual(emails(start), ['ada@north.example']);

  // mistri dev's start: the folder it keeps, and the environment it serves under. Its sign-in reads this store.
  const dev: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: own };
  prepareDev(['--app', f.appDir], dev);
  const signsIn = appAuthStore(loaded, dev);
  assert.notEqual(signsIn, start);
  const north = await f.run('grant', 'north@example.test', '--roles', 'staff', '--tenant', 'north');
  assert.equal(north.code, 0, north.err);
  assert.ok(
    north.out.startsWith(`north@example.test: an account was made in the store mistri dev keeps for lending (${signsIn}).\n`),
    north.out,
  );
  assert.deepEqual(emails(signsIn), ['north@example.test']);
  assert.deepEqual(emails(start), ['ada@north.example']);
  assert.equal(process.env.XDG_CONFIG_HOME, own, 'the step leaves the environment as it found it');
});

test("init and grant refuse each other's options and a malformed address before anything opens", async (t) => {
  const f = await fixture(t);
  for (const [argv, refused] of [
    [['grant', 'not-an-address', '--roles', 'manager'], /grant names an email address/],
    [['grant', 'lee@lender.example'], /grant needs --roles/],
    [['init', 'north', '--roles', 'manager'], /--roles, --tenant, --days, --account and --from are grant's/],
    [['init', 'north', '--name', 'North'], /--name is grant's and brand's/],
    [['grant', 'lee@lender.example', '--roles', 'manager', '--preset', 'mono'], /--preset and --file are brand's/],
    [['brand', 'north'], /brand needs --name, --preset or --file/],
    [['grant', 'lee@lender.example', '--roles', 'manager', '--days', '400'], /--days is a whole number of days, 1 to 366/],
    [['grant', 'lee@lender.example', '--roles', 'manager', '--tenant', 'North!'], /is not a tenant id/],
    [['init', 'North!'], /init names its tenants by id/],
  ] as const) {
    const result = await f.run(...argv);
    assert.equal(result.code, 1, argv.join(' '));
    assert.match(result.err, refused, argv.join(' '));
  }
  assert.deepEqual(f.anchors(), []);
});

test("brand saves a tenant's branding through the checks a tenant admin's save meets, and keeps what it does not name (field report)", async (t) => {
  const f = await fixture(t, false, true, true);
  assert.equal((await f.run('init', 'north')).code, 0);
  const named = await f.run('brand', 'north', '--name', 'North Motors');
  assert.equal(named.code, 0, named.err);
  assert.equal(named.out, 'north: branding saved, revision 1.');
  const file = join(f.directory, 'branding.json');
  writeFileSync(file, JSON.stringify({ accent: '#1d4ed8' }));
  // The file is the whole value; --name is laid over it.
  const whole = await f.run('brand', 'north', '--file', file, '--name', 'North');
  assert.equal(whole.code, 0, whole.err);
  assert.equal(whole.out, 'north: branding saved, revision 2.');
  // Without --file the saved value is the base: the accent stays.
  assert.equal((await f.run('brand', 'north', '--name', 'North Motors')).out, 'north: branding saved, revision 3.');
  const saved = f.branding();
  assert.deepEqual(
    saved.map((row) => [row.tenant, JSON.parse(String(row.value)), row.by]),
    [['north', { accent: { light: '#1d4ed8', dark: '#7997ee' }, name: 'North Motors' }, 'maintenance:ops-ada']],
  );
  // A field the App does not let a tenant brand is refused by name, and nothing is written.
  const refused = await f.run('brand', 'north', '--preset', 'mono');
  assert.equal(refused.code, 1);
  assert.match(refused.err, /north's branding was not saved:\n {2}This App does not let a customer change "preset"\./);
  assert.match((await f.run('brand', 'south', '--name', 'South')).err, /"south" is not a tenant of lending/);
  assert.equal(f.branding().length, 1);
});

test('grant takes several accounts and tenants, or a CSV: every row is checked first, one transaction per tenant, a rerun changes nothing', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run('init', 'north', 'south')).code, 0);
  process.env.MISTRI_ACCOUNT_PASSWORD = PASSWORD;
  // Cross product: two accounts in two tenants, and one bad tenant in the list refuses all of them, in words.
  const bad = await f.run(
    'grant',
    '--account',
    'a@x.example',
    '--account',
    'b@x.example',
    '--tenant',
    'north',
    '--tenant',
    'west',
    '--roles',
    'staff',
  );
  assert.equal(bad.code, 1);
  assert.match(bad.err, /nothing was granted; 2 things are wrong/);
  assert.match(bad.err, /a@x\.example in west: west is not an active tenant\./);
  assert.match(bad.err, /b@x\.example in west: west is not an active tenant\./);
  assert.deepEqual(f.memberships(), []);
  assert.doesNotMatch(bad.out, /an account was made/);

  const ok = await f.run(
    'grant',
    '--account',
    'a@x.example',
    '--account',
    'b@x.example',
    '--tenant',
    'north',
    '--tenant',
    'south',
    '--roles',
    'staff',
  );
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /north: granted 2, already held 0\./);
  assert.match(ok.out, /south: granted 2, already held 0\./);
  assert.equal(f.memberships().length, 4);

  // A CSV with a header; a third account, the platform realm (empty tenant), and the two already held.
  const csv = join(f.directory, 'grants.csv');
  writeFileSync(
    csv,
    '\uFEFFaccount,tenant,role\r\na@x.example,north,staff\r\n"c@x.example",north,staff\r\nlee@lender.example,,manager\r\nb@x.example,south,staff\r\n',
  );
  const first = await f.run('grant', '--from', csv);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /north: granted 1, already held 1\./);
  assert.match(first.out, /the platform realm: granted 1, already held 0\./);
  assert.match(first.out, /south: granted 0, already held 1\./);
  assert.equal(f.memberships().length, 6);
  const again = await f.run('grant', '--from', csv);
  assert.equal(again.code, 0, again.err);
  assert.doesNotMatch(again.out, /granted [1-9]/);
  assert.equal(f.memberships().length, 6);

  // Every wrong row is listed, line numbers of the file, and nothing is applied.
  const wrong = join(f.directory, 'wrong.csv');
  writeFileSync(
    wrong,
    'account,tenant,role\nnew@x.example,north,staff\nnot-an-address,north,staff\nd@x.example,North!,staff\ne@x.example,south,\n',
  );
  const refused = await f.run('grant', '--from', wrong);
  assert.equal(refused.code, 1);
  for (const line of [/row 3: "not-an-address" is not an email address/, /row 4: "North!" is not a tenant id/, /row 5: no role/])
    assert.match(refused.err, line);
  assert.equal(f.memberships().length, 6);
  // What only the store can say is said whole too: a role of the other realm, a tenant that is not there.
  const store = join(f.directory, 'store.csv');
  writeFileSync(store, 'account,tenant,role\nnew@x.example,north,staff\nf@x.example,south,manager\ng@x.example,west,staff\n');
  const stored = await f.run('grant', '--from', store);
  assert.equal(stored.code, 1);
  assert.match(stored.err, /row 3: "manager" is not a tenant-realm role/);
  assert.match(stored.err, /row 4: west is not an active tenant/);
  assert.equal(f.memberships().length, 6);
  const header = join(f.directory, 'noheader.csv');
  writeFileSync(header, 'a@x.example,north,staff\n');
  assert.match((await f.run('grant', '--from', header)).err, /has no tenant, role column|has no account, tenant, role column/);
  assert.match((await f.run('grant', '--from', csv, '--roles', 'staff')).err, /--from carries the accounts/);
});

test(
  'five concurrent mistri tenant grant processes over SQLite create the sign-in store, accounts and memberships without colliding',
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    assert.equal((await f.run('init', 'north', 'south', 'east', 'west')).code, 0);
    const entry = resolve('packages/mistri/src/server/index.ts');
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_TEST_CONTEXT')),
      MISTRI_ACCOUNT_PASSWORD: PASSWORD,
      XDG_CONFIG_HOME: join(f.directory, 'xdg'),
    };
    const spawnGrant = (email: string, tenant: string, index: number) =>
      new Promise<{ code: number; out: string; err: string }>((done) =>
        execFile(
          process.execPath,
          [
            '--import',
            'tsx',
            entry,
            'tenant',
            'grant',
            email,
            '--tenant',
            tenant,
            '--roles',
            'staff',
            '--app',
            f.appDir,
            '--policy',
            join(f.directory, 'policy.mjs'),
            '--config',
            join(f.directory, 'config.json'),
            '--operator',
            `ops-${index}`,
          ],
          { timeout: 45_000, env },
          (error, out, err) => done({ code: Number(error?.code ?? 0), out, err }),
        ),
      );
    const runs = await Promise.all([
      spawnGrant('one@dealer.example', 'north', 1),
      spawnGrant('two@dealer.example', 'south', 2),
      spawnGrant('three@dealer.example', 'east', 3),
      spawnGrant('shared@dealer.example', 'north', 4),
      spawnGrant('shared@dealer.example', 'west', 5),
    ]);
    for (const [index, result] of runs.entries()) {
      assert.equal(result.code, 0, `run ${index + 1}: ${result.out}\n${result.err}`);
    }
    assert.equal(f.memberships().length, 5);
  },
);
