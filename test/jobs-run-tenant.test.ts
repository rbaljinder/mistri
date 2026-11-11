/**
 * `mistri jobs run <name> --policy <file> [--tenant <id>]` on a tenant App, through the command as a shell runs it,
 * on SQLite. The deployment is read as its start reads it; a job per tenant is enqueued as a manual run in the tenant
 * named, or in each tenant active now, each carrying its tenant as the server's slots do; a job on the platform is
 * enqueued once and with no tenant. What it refuses: a tenant App without its policy, --tenant on a platform job, a
 * tenant that is not active, and --policy on an App that is not a tenant App. That the server's runner runs a manual
 * run is jobs-run.test.ts's, and that it admits a tenant job only in an active tenant is tenant-jobs.test.ts's.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import * as maintenance from '@mistriwork/mistri/maintenance';
import { JOB_TABLES } from '../packages/mistri/src/adapters/jobs/jobStoreSchema.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { runJobsCommand } from '../packages/mistri/src/server/cli/jobsCommand.js';
import { runTenantCommand } from '../packages/mistri/src/server/cli/tenantCommand.js';
import { mistri } from './support/bootstrapApp.js';
import { scratch } from './support/scratch.js';

const binding = { appId: 'desk', source: { id: 'business', connection: 'business-db' }, storeId: 'desk-store' };
const src = (path: string) => JSON.stringify(pathToFileURL(join(process.cwd(), path)).href);

process.env.MISTRI_SECRETS_KEY ??= 'a-secrets-key-for-tests-that-is-long-enough';

/** With `integrations`, a command calls FakePay, which only a jobs module wires: an App a step must load the jobs module of. */
async function fixture(t: TestContext, { integrations = false } = {}) {
  const { directory } = scratch(t, 'mistri-jobs-run-tenant-');
  const appDir = join(directory, 'app');
  mkdirSync(appDir);
  const data = join(directory, 'business.db'),
    config = join(directory, 'config.json'),
    policy = join(directory, 'policy.mjs'),
    commands = join(appDir, 'commands.mjs'),
    jobs = join(directory, 'jobs.mjs');
  const db = new DatabaseSync(data);
  db.exec(`CREATE TABLE dealer (id TEXT PRIMARY KEY);
    CREATE TABLE tick (id TEXT NOT NULL PRIMARY KEY DEFAULT(lower(hex(randomblob(16)))), tenant_id TEXT NOT NULL, at TEXT NOT NULL)`);
  db.close();
  writeFileSync(
    join(appDir, 'app.json'),
    JSON.stringify({
      id: 'desk',
      name: 'Desk',
      sources: { business: { connection: 'business-db' } },
      resources: { dealer: { access: 'write', owner: 'platform' }, tick: { access: 'write', owner: 'tenant' } },
      auth: {
        store: join(directory, 'auth.db'),
        signUp: 'invite',
        rows: 'tenant',
        tenancy: { label: 'Dealer', platform: { label: 'Lender' } },
        roles: {
          staff: { realm: 'tenant', read: true },
          clock: { realm: 'tenant', read: true, commands: ['stamp'] },
          desk: { realm: 'platform', read: true, commands: ['tally'] },
        },
      },
      views: { ticks: { kind: 'list', from: 'tick' }, dealers: { kind: 'list', from: 'dealer', realm: 'platform' } },
      nav: [
        { id: 'dealership', label: 'Dealership', realm: 'tenant', children: ['ticks'] },
        { id: 'lender', label: 'Lender', realm: 'platform', children: ['dealers'] },
      ],
      home: 'ticks',
    }),
  );
  writeFileSync(
    commands,
    `import { defineCommand, defineCommands } from ${src('packages/mistri/src/server/commands.ts')};
export default defineCommands({
  stamp: defineCommand({ source: 'business', target: 'tick', targets: 'none',
    async handle({ db, now }) { await db.tick.insert({ at: now().toISOString() }); } }),
  tally: defineCommand({ realm: 'platform', source: 'business', target: 'dealer', targets: 'none', async handle() {} }),${
    integrations
      ? `
  charge: defineCommand({ source: 'business', target: 'tick', targets: 'none', integrations: { fakepay: ['charge'] },
    lookup: ({ integrations }) => integrations.fakepay.charge({ amount: 1, customer: 'c' }), async handle() {} }),`
      : ''
  }
});
`,
  );
  writeFileSync(
    jobs,
    `import { defineJob, defineJobs } from ${src('packages/mistri/src/server/jobs.ts')};
${integrations ? `import { fakepay } from ${src('test/fixtures/integrations/fakepay/index.ts')};` : ''}
export default defineJobs({
  nightly: defineJob({ every: '0 2 * * *', realm: 'tenant', runAs: 'clock', command: 'stamp' }),
  yearly: defineJob({ every: '0 0 1 1 *', realm: 'platform', runAs: 'desk', command: 'tally' }),
}, { principals: { clock: { roles: ['clock'] }, desk: { roles: ['desk'] } }, store: { namespace: 'desk' }${
      integrations ? ', integrations: { use: [fakepay()] }' : ''
    } });
`,
  );
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'business-db', url: data, writable: true }] }));
  writeFileSync(
    policy,
    `const rows = () => ({ dealer: true, tick: true });
    export default { kind: 'tenant', appId: 'desk', storeId: 'desk-store',
      ownership: { dealer: { kind: 'platform' }, tick: { kind: 'tenant', column: 'tenant_id' } },
      resolveMembershipRows: rows, resolveRows: rows, resolvePlatformRows: rows,
      resultReferences: { stamp: () => [], tally: () => []${integrations ? ', charge: () => []' : ''} } };`,
  );
  // As `mistri migrate stores up --policy --jobs` does before a first start.
  await maintenance.provisionStores({ sqlite: data }, { app: { tenant: binding }, only: ['tenant-store', 'tenant-administration'] });
  migrateSqliteCommandJournal(data);
  const loaded = await loadApp(appDir);
  await maintenance.provisionStores(
    { sqlite: data },
    {
      app: { tenant: binding, commands: loaded.commands!.registry, definition: loaded.app },
      jobs: (await import(pathToFileURL(jobs).href)).default,
    },
  );
  /** A command as a shell runs it: its exit code, what it printed and what it refused. */
  const shell = async (run: typeof runJobsCommand, argv: string[]) => {
    const lines: string[] = [];
    const errors: string[] = [];
    const error = console.error;
    console.error = (line: unknown) => errors.push(String(line));
    try {
      const code = await run(argv, (line) => lines.push(line));
      return { code, out: lines.join('\n'), err: errors.join('\n') };
    } finally {
      console.error = error;
    }
  };
  const flags = ['--app', appDir, '--jobs', jobs, '--config', config];
  // A tenant step is given what its server is given, the jobs module included.
  const tenant = (...argv: string[]) =>
    shell(runTenantCommand, [...argv, ...flags.slice(0, 4), '--policy', policy, '--config', config, '--operator', 'ops-ada']);
  const tenantWithoutJobs = (...argv: string[]) =>
    shell(runTenantCommand, [...argv, ...flags.slice(0, 2), '--policy', policy, '--config', config, '--operator', 'ops-ada']);
  const run = (name: string, ...argv: string[]) => shell(runJobsCommand, ['run', name, ...flags, '--wait', '0', ...argv]);
  const rows = () => {
    const handle = new DatabaseSync(data, { readOnly: true });
    try {
      return (
        handle
          .prepare(`SELECT job, idempotency_key AS key, provenance_json AS provenance FROM "${JOB_TABLES.job}" ORDER BY seq`)
          .all() as Array<{
          job: string;
          key: string;
          provenance: string;
        }>
      ).map((row) => ({ job: row.job, key: row.key, tenantId: JSON.parse(row.provenance).tenantId as string | undefined }));
    } finally {
      handle.close();
    }
  };
  return { directory, appDir, data, config, jobs, policy, tenant, tenantWithoutJobs, run, rows };
}

test('a job per tenant is enqueued once in each active tenant, or in the one named, each carrying its tenant', async (t) => {
  const f = await fixture(t);
  const opened = await f.tenant('init', 'north', 'south');
  assert.equal(opened.code, 0, opened.err);

  const each = await f.run('nightly', '--policy', f.policy);
  assert.equal(each.code, 0, each.err);
  assert.match(
    each.out,
    /^nightly \(north\): a manual run enqueued in desk's job store\.\nnightly \(south\): a manual run enqueued in desk's job store\.\nA server started with --jobs runs them, one at a time,/,
  );
  const named = await f.run('nightly', '--policy', f.policy, '--tenant', 'south');
  assert.equal(named.code, 0, named.err);
  assert.match(named.out, /^nightly \(south\): a manual run enqueued in desk's job store\.\nA server started with --jobs runs it,/);
  const rows = f.rows();
  assert.deepEqual(
    rows.map((row) => [row.job, row.tenantId]),
    [
      ['nightly', 'north'],
      ['nightly', 'south'],
      ['nightly', 'south'],
    ],
  );
  for (const row of rows) assert.match(row.key, /^manual-\d{16}-/);
});

test("a tenant step loads the App's jobs module as its server does, so an App whose commands call an integration opens", async (t) => {
  // A field report: `tenant init` did not take --jobs, so it refused an App whose commands call an integration.
  const f = await fixture(t, { integrations: true });
  const refused = await f.tenantWithoutJobs('init', 'north');
  assert.equal(refused.code, 1);
  assert.match(refused.err, /charge.*fakepay/);
  const opened = await f.tenant('init', 'north');
  assert.equal(opened.code, 0, opened.err);
  const ran = await f.run('nightly', '--policy', f.policy);
  assert.equal(ran.code, 0, ran.err);
  assert.deepEqual(
    f.rows().map((row) => [row.job, row.tenantId]),
    [['nightly', 'north']],
  );
});

test('`tenant grant` loads the jobs module as `tenant init` does, so it runs on an App whose commands call an integration', async (t) => {
  const f = await fixture(t, { integrations: true });
  assert.equal((await f.tenant('init', 'north')).code, 0);
  const password = process.env.MISTRI_ACCOUNT_PASSWORD;
  t.after(() => {
    if (password === undefined) delete process.env.MISTRI_ACCOUNT_PASSWORD;
    else process.env.MISTRI_ACCOUNT_PASSWORD = password;
  });
  process.env.MISTRI_ACCOUNT_PASSWORD = 'correct horse battery staple';
  const refused = await f.tenantWithoutJobs('grant', 'sam@north.example', '--roles', 'staff', '--tenant', 'north');
  assert.equal(refused.code, 1);
  assert.match(refused.err, /charge.*fakepay/);
  const granted = await f.tenant('grant', 'sam@north.example', '--roles', 'staff', '--tenant', 'north');
  assert.equal(granted.code, 0, granted.err);
  assert.match(granted.out, /sam@north\.example: staff of north until/);
});

test("from the App's directory, `tenant init` and `jobs run` read the policy and the jobs module from mistri.json", async (t) => {
  // A field report: `jobs run` did not read --policy from mistri.json, and `tenant init` read no jobs module from it.
  const f = await fixture(t, { integrations: true });
  writeFileSync(
    join(f.appDir, 'mistri.json'),
    JSON.stringify({
      app: { dir: '.', policy: f.policy, jobs: f.jobs },
      connections: [{ name: 'business-db', url: f.data, writable: true }],
    }),
  );
  const env = { XDG_CONFIG_HOME: join(f.directory, '.config') };
  const opened = mistri(['tenant', 'init', 'north', '--operator', 'ops-ada'], f.appDir, env);
  assert.equal(opened.code, 0, opened.said);
  const ran = mistri(['jobs', 'run', 'nightly', '--wait', '0'], f.appDir, env);
  assert.equal(ran.code, 0, ran.said);
  assert.match(ran.stdout, /nightly \(north\): a manual run enqueued in desk's job store\./);
  assert.deepEqual(
    f.rows().map((row) => [row.job, row.tenantId]),
    [['nightly', 'north']],
  );
});

test('a job on the platform is enqueued once, with no tenant', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.tenant('init', 'north')).code, 0);
  const ran = await f.run('yearly', '--policy', f.policy);
  assert.equal(ran.code, 0, ran.err);
  assert.match(ran.out, /^yearly: a manual run enqueued in desk's job store\./);
  assert.deepEqual(
    f.rows().map((row) => [row.job, row.tenantId]),
    [['yearly', undefined]],
  );
});

test('with no tenant active, a job per tenant enqueues nothing and says so', async (t) => {
  const f = await fixture(t);
  const ran = await f.run('nightly', '--policy', f.policy);
  assert.equal(ran.code, 0, ran.err);
  assert.match(ran.out, /no tenant of desk is active, so there is no one to run it for\. Nothing was enqueued\./);
  assert.deepEqual(f.rows(), []);
});

test('refuses a tenant App without its policy, --tenant on a platform job, and a tenant that is not active', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.tenant('init', 'north')).code, 0);
  const cases: Array<[string[], RegExp]> = [
    [['nightly'], /desk is a tenant App: name its policy with --policy <file>, as its server is started\./],
    [['yearly', '--policy', f.policy, '--tenant', 'north'], /"yearly" runs once on the platform, not per tenant: leave out --tenant\./],
    [['nightly', '--policy', f.policy, '--tenant', 'east'], /"east" is not an active tenant of desk\./],
    [['weekly', '--policy', f.policy], /"weekly" is not one of this App's jobs at times \("nightly", "yearly"\)/],
  ];
  for (const [argv, refusal] of cases) {
    const [name, ...rest] = argv;
    const refused = await f.run(name, ...rest);
    assert.equal(refused.code, 1, `${argv.join(' ')}: ${refused.out}`);
    assert.match(refused.err, refusal);
  }
  assert.deepEqual(f.rows(), []);
});

test('refuses --policy and --tenant on an App that is not a tenant App', async (t) => {
  const { directory } = scratch(t, 'mistri-jobs-run-plain-');
  const ran = await runJobsCommandQuietly([
    'run',
    'yearly',
    '--app',
    'examples/apps/tick',
    '--jobs',
    join(directory, 'jobs.mjs'),
    '--tenant',
    'north',
    join(directory, 'tick.db'),
  ]);
  assert.equal(ran.code, 1);
  assert.match(ran.err, /--policy and --tenant are a tenant App's, and tick is not one\./);
  // A policy the project profile names (a row policy, on an App like this one) is left out, not refused.
  writeFileSync(join(directory, 'policy.mjs'), 'export default {};');
  writeFileSync(
    join(directory, 'jobs.mjs'),
    `import { defineJobs } from ${src('packages/mistri/src/server/jobs.ts')};\nexport default defineJobs({});\n`,
  );
  writeFileSync(
    join(directory, 'mistri.json'),
    JSON.stringify({ app: { dir: resolve('examples/apps/tick'), policy: 'policy.mjs', jobs: 'jobs.mjs' }, connections: [] }),
  );
  const profiled = mistri(['jobs', 'run', 'yearly', join(directory, 'tick.db')], directory, {
    XDG_CONFIG_HOME: join(directory, '.config'),
  });
  assert.equal(profiled.code, 1, profiled.said);
  assert.doesNotMatch(profiled.stderr, /--policy and --tenant/);
  assert.match(profiled.stderr, /policy\s+policy\.mjs\s+mistri\.json/);
  assert.match(profiled.stderr, /a job runs one of the App's commands, and tick has none/);
});

async function runJobsCommandQuietly(argv: string[]) {
  const errors: string[] = [];
  const error = console.error;
  console.error = (line: unknown) => errors.push(String(line));
  try {
    return { code: await runJobsCommand(argv, () => {}), err: errors.join('\n') };
  } finally {
    console.error = error;
  }
}
