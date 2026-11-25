/**
 * A tenant App whose jobs module lists integrations and runs a job at times, under the two starts that are not a
 * deployment's: the suite `mistri test init` writes for it, and a look (`mistri shot`, `mistri grade`), which serves
 * with MISTRI_JOBS=off.
 *
 * A field report's App texted from a command, and every test of its generated suite failed at the start: the module
 * that provides the channel seals its secrets under MISTRI_SECRETS_KEY, which the harness did not name, and
 * `migrate stores up --jobs` made the jobs' deliveries and left the effects' unprovisioned. The same App's database
 * changed under `mistri shot`: the tenant host started its jobs whatever MISTRI_JOBS said.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createTestWorkspace, startTestApp } from '../packages/mistri/src/server/testing.ts';

const ROOT = resolve('.');
const ENTRY = join(ROOT, 'packages', 'mistri', 'src', 'server', 'index.ts');
/* Inside the checkout, as deep as test/fixtures/apps/clinic, so the App's `@mistriwork/mistri/*` imports resolve to src/. */
const work = mkdtempSync(join(ROOT, 'test', '.test-kit-'));
after(() => rmSync(work, { recursive: true, force: true }));

const KEYS = { MISTRI_AUDIT_KEY: 'k'.repeat(40), MISTRI_SECRETS_KEY: 's'.repeat(40) };
const edit = (file: string, from: string, to: string) => {
  const text = readFileSync(file, 'utf8');
  assert.ok(text.includes(from), `${file} holds ${from}`);
  writeFileSync(file, text.replace(from, to));
};

/** The clinic fixture with a reminder texted after commit, a sweep each minute per clinic, and FakePay's channel. */
let made = 0;
async function textingClinic() {
  const dir = join(work, 'apps', `clinic-${++made}`);
  cpSync(join(ROOT, 'test', 'fixtures', 'apps', 'clinic'), dir, { recursive: true });
  const { seedSqlite } = (await import(join(ROOT, 'test', 'fixtures', 'databases', 'clinic', 'seed.mjs'))) as {
    seedSqlite(file: string): void;
  };
  seedSqlite(join(dir, 'clinic.db'));
  edit(join(dir, 'commands.ts'), '  refuse,\n', '  refuse,\n  send,\n');
  edit(
    join(dir, 'commands.ts'),
    'export default defineCommands({ recordPayment, postNotice, requestVisit });',
    `export const remindPatient = defineCommand({
  source,
  target: 'appointment',
  read: ['appointment'],
  write: ['appointment'],
  output: shape({ message: literal('Reminder queued.') }),
  effects: { text: send('sms', () => ({ to: '+15550100', text: 'See you soon.', consent: true })) },
  async handle() {
    return { message: 'Reminder queued.' as const };
  },
});
export const sweep = defineCommand({
  source,
  target: 'notice',
  targets: 'none',
  write: ['notice'],
  output: shape({ message: literal('Swept.') }),
  async handle({ db }) {
    await db.notice.insert({ id: \`nt-\${randomUUID()}\`, body: 'swept' });
    return { message: 'Swept.' as const };
  },
});
export default defineCommands({ recordPayment, postNotice, requestVisit, remindPatient, sweep });`,
  );
  edit(
    join(dir, 'app.ts'),
    "reception: { label: 'Reception', realm: 'tenant', read: clinicReads, write: ['patient'], commands: ['recordPayment'] },",
    `reception: { label: 'Reception', realm: 'tenant', read: clinicReads, write: ['patient'], commands: ['recordPayment', 'remindPatient'] },
      sweeper: { label: 'Sweeper', realm: 'tenant', service: true, read: clinicReads, commands: ['sweep'] },`,
  );
  edit(
    join(dir, 'server', 'tenant-policy.ts'),
    '    requestVisit: () => [],',
    '    requestVisit: () => [],\n    remindPatient: () => [],\n    sweep: () => [],',
  );
  writeFileSync(
    join(dir, 'jobs.ts'),
    `import { defineJob, defineJobs } from '@mistriwork/mistri/jobs';
import { fakepay } from '../../../fixtures/integrations/fakepay/index.ts';

export default defineJobs(
  { everyMinute: defineJob({ every: '* * * * *', realm: 'tenant', runAs: 'sweeper', command: 'sweep' }) },
  { principals: { sweeper: { roles: ['sweeper'] } }, integrations: { use: [fakepay()] } },
);
`,
  );
  writeFileSync(join(dir, 'mistri.json'), JSON.stringify({ connections: [{ name: 'clinic-db', url: './clinic.db', writable: true }] }));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_TEST_CONTEXT')),
    ...KEYS,
    XDG_CONFIG_HOME: join(dir, '.config'),
    TSX_TSCONFIG_PATH: join(ROOT, 'tsconfig.json'),
  };
  const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', ENTRY, ...args], { encoding: 'utf8', env, cwd: dir });
  // The stores, made with the flags the App is started with, as the docs say.
  const up = run([
    'migrate',
    'stores',
    'up',
    '--app',
    dir,
    '--policy',
    'server/tenant-policy.ts',
    '--jobs',
    'jobs.ts',
    '--config',
    'mistri.json',
  ]);
  assert.equal(up.status, 0, up.stdout + up.stderr);
  return { dir, env, run, up };
}

test('test init writes a suite that starts for a tenant App whose command sends on an integration channel', async () => {
  const { dir, env, run, up } = await textingClinic();
  // With a jobs module, the effects' deliveries are provisioned beside the jobs': the start attests both.
  assert.match(up.stdout, /effects: 1 destination\(s\), 1 added/);
  const init = run(['test', 'init', '--app', dir]);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const start = readFileSync(join(dir, 'tests', 'start.ts'), 'utf8');
  assert.match(start, /args: \['--policy', 'server\/tenant-policy\.ts', '--commands', 'commands\.ts', '--jobs', 'jobs\.ts'\]/);
  // The key the listed integrations' secrets are sealed under: without it the server refuses to start.
  assert.match(start, /MISTRI_SECRETS_KEY: process\.env\.MISTRI_SECRETS_KEY \?\? randomBytes/);
  /* The suite's own environment, without the secrets key: the start it wrote supplies one. */
  const { MISTRI_SECRETS_KEY: _unset, ...bare } = env;
  const tests = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'tests/tenants.test.ts'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...bare, MISTRI_TEST_TENANTS: 'north,south' },
  });
  assert.equal(tests.status, 0, `${tests.stdout}\n${tests.stderr}`);
  assert.match(tests.stdout, /^ℹ fail 0/m);
  assert.match(tests.stdout, /✔ remindPatient: refused on another clinic's appointment/);
});

test('MISTRI_JOBS=off: a tenant host schedules nothing, so a look leaves the database as it found it', async (t) => {
  const { dir } = await textingClinic();
  const workspace = await createTestWorkspace();
  t.after(() => workspace.close());
  const config = await workspace.copyConfig(join(dir, 'mistri.json'));
  const database = (JSON.parse(readFileSync(config, 'utf8')) as { connections: { url: string }[] }).connections[0].url;
  const swept = () => {
    const db = new DatabaseSync(resolve(workspace.directory, database), { readOnly: true });
    try {
      return (db.prepare("SELECT count(*) AS n FROM notice WHERE body = 'swept'").get() as { n: number }).n;
    } finally {
      db.close();
    }
  };
  const serve = (environment: Record<string, string> = {}) =>
    startTestApp({
      workspace,
      directory: dir,
      config,
      args: ['--policy', 'server/tenant-policy.ts', '--commands', 'commands.ts', '--jobs', 'jobs.ts'],
      environment: { ...KEYS, ...environment },
    });
  /* A run in the store: a host that finds one catches up the slot it missed at its next start, so the two starts
     below differ at once rather than at the next minute. */
  const first = await serve();
  await first.tenant('north', { roles: ['reception'] });
  // A tenant's job is admitted while its tenant and the platform are both active.
  await first.platform({ roles: ['operator'] });
  const ran = await first.runJob('everyMinute', { tenant: 'north' });
  assert.equal(ran.state, 'succeeded', `${ran.code}\n${first.logs()}`);
  await first.close();
  const before = swept();
  assert.ok(before >= 1, 'the job run now swept');

  const looking = await serve({ MISTRI_JOBS: 'off' });
  assert.match(looking.logs(), /jobs and effects are off \(MISTRI_JOBS=off\): nothing is scheduled/);
  assert.doesNotMatch(looking.logs(), /jobs: everyMinute@/);
  await delay(2500);
  await looking.close();
  assert.equal(swept(), before, 'nothing ran while the host was looked at');

  // The same start without it does run the slot: what the wait above would have seen.
  const serving = await serve();
  for (let waited = 0; swept() === before && waited < 15_000; waited += 250) await delay(250);
  await serving.close();
  assert.ok(swept() > before, 'a serving host runs its job at times');
});
