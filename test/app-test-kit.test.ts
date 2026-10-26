/**
 * The kit an App's own tests stand on (@mistriwork/mistri/testing): the request shapes it sends agree with what the server
 * parses, results come back as values — a refusal with its status and code, never a throw — `as(role)` signs a
 * seeded account in, and `mistri test init` writes a suite that passes on Tick and on Payday as they ship.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { INBOX_TABLES } from '../packages/mistri/src/adapters/inbox/inboxTables.ts';
import { parseCommandRequest } from '../packages/mistri/src/server/commands/commandPayload.ts';
import { commandEnvelope, commandPath, updateBody } from '../packages/mistri/src/server/testing/appRequests.ts';
import { assertApplied, createTestWorkspace, startTestApp } from '../packages/mistri/src/server/testing.ts';
import { scopeApiRequest, setAppRequestScope } from '../packages/kit/src/client/requestIdentity.ts';
import { COMMAND_ROUTE_PATHS } from '../packages/mistri/src/shared/commandRoutes.ts';

const ROOT = resolve('.');
/* An App's starts are mistri's (test/support/bins.ts). */
const ENTRY = join(ROOT, 'packages', 'mistri', 'src', 'server', 'index.ts');
/* Inside the checkout, so an App's `@mistriwork/mistri/commands` and the tests' `@mistriwork/mistri/testing` resolve to src/ through
   the root tsconfig, as they do for the fixtures; a project resolves them from its installed package instead. */
const work = mkdtempSync(join(ROOT, 'test', '.test-kit-'));
after(() => rmSync(work, { recursive: true, force: true }));

/** A copy of an App — Tick, the public starter, Lintel, or a fixture — beside a fresh database and the
 * mistri.json that names it, as deep as test/fixtures/apps/payday so its tsconfig's relative paths reach src/. */
let made = 0;
async function exampleApp(name: 'tick' | 'payday' | 'depot' | 'lintel'): Promise<string> {
  const dir = join(work, 'apps', `${name}-${++made}`);
  const home = name === 'tick' || name === 'lintel' ? join(ROOT, 'examples') : join(ROOT, 'test', 'fixtures');
  cpSync(join(home, 'apps', name), dir, { recursive: true });
  const { seed } = (await import(join(home, 'databases', name, 'seed.mjs'))) as { seed(file: string): unknown };
  await seed(join(dir, `${name}.db`));
  cpSync(join(dir, `${name}.db.json`), join(dir, 'mistri.json'));
  return dir;
}

const cli = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', ENTRY, ...args], { encoding: 'utf8' });

test('the request shapes are the ones the server parses and the browser scopes', () => {
  const envelope = commandEnvelope({
    command: 'approveTimeOff',
    commandVersion: 1,
    key: { id: 3 },
    expectedVersion: 2,
    input: { note: 'ok' },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(parseCommandRequest(structuredClone(envelope)))), envelope);
  assert.notEqual(
    commandEnvelope({ command: 'a', commandVersion: 1, key: { id: 1 }, expectedVersion: 1, input: {} }).idempotencyKey,
    envelope.idempotencyKey,
  );
  /* As the browser on an App server scopes them: a command's App selector rides in the query and its body is left as
     it is; an update's goes in the body. */
  setAppRequestScope(true);
  const execute = scopeApiRequest(commandPath('execute', 'payday'), { ...envelope }, 'payday');
  assert.equal(execute.url, commandPath('execute', 'payday'));
  assert.deepEqual(execute.payload, envelope);
  const { app: _app, ...bare } = updateBody('payday', 'employee', { id: 1 }, { title: 'Lead' });
  assert.deepEqual(scopeApiRequest('/api/update', bare, 'payday').payload, updateBody('payday', 'employee', { id: 1 }, { title: 'Lead' }));
  assert.ok(COMMAND_ROUTE_PATHS.includes(commandPath('prepare', 'x').split('?')[0]));
});

test('results are values: an applied step, and a refusal with its status and code', async (t) => {
  const directory = await exampleApp('payday');
  const workspace = await createTestWorkspace();
  t.after(() => workspace.close());
  const config = await workspace.copyConfig(join(directory, 'mistri.json'));
  const host = await startTestApp({ workspace, directory, config });
  /* Resolved means ready: the probe answers without a retry. */
  assert.equal((await fetch(`${host.url}/readyz`)).status, 200);

  const manager = await host.as('payroll_manager');
  assert.equal((await (await manager.request('/api/whoami')).json()).signedIn, true);

  const refused = await manager.update('employee', { id: 1 }, { title: 'Chief' });
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && refused.status === 403 && refused.code === 'forbidden', JSON.stringify(refused));

  const approved = await manager.act('time_off', 'approveTimeOff');
  assertApplied(approved);
  /* A command's write tells the people a rule names as a Save's does: the teammate hears the decision. */
  const told = new DatabaseSync(JSON.parse(readFileSync(config, 'utf8')).connections[0].url, { readOnly: true });
  try {
    const notices = told.prepare(`SELECT recipient, title, action FROM ${INBOX_TABLES.notice} WHERE resource = 'time_off'`).all();
    assert.equal(notices.length, 1, JSON.stringify(notices));
    assert.match(String(notices[0].title), /^Your time off from .+ was approved$/);
    // Said as the verb the person pressed.
    assert.equal(notices[0].action, 'Approve request');
  } finally {
    told.close();
  }
  /* The same command on the same record again is the record's state refusing it, as a value. */
  const again = await manager.command('approveTimeOff', approved.value.key);
  assert.ok(!again.ok && again.status === 409, JSON.stringify(again));
  assert.equal(typeof (!again.ok && again.code), 'string');

  const admin = await host.as('admin');
  const saved = await admin.update('employee', { id: 1 }, { title: 'Chief' });
  assert.ok(saved.ok, JSON.stringify(saved));
  const row = await admin.rows('employee', { where: 'id = 1' });
  assert.ok(row.ok && row.value[0].title === 'Chief');

  const page = await manager.open({ table: 'employee', key: { id: 1 } });
  assert.ok(page.ok && page.value.address === '/people/1', JSON.stringify(page.ok ? page.value.address : page));

  const missing = await manager.act('time_off', 'noSuchAction');
  assert.ok(!missing.ok && missing.code === 'no_action');
});

/* Depot's receiving is a machine verb on the order whose command runs on one of its lines. */
for (const name of ['tick', 'payday', 'depot'] as const) {
  test(`test init writes a suite that passes on ${name}`, async () => {
    const dir = await exampleApp(name);
    const init = cli(['test', 'init', dir]);
    assert.equal(init.status, 0, init.stderr);
    for (const file of ['start.ts', 'journeys.test.ts', 'permissions.test.ts']) {
      assert.ok(existsSync(join(dir, 'tests', file)), file);
      assert.match(init.stdout, new RegExp(`wrote .*tests/${file.replace('.', '\\.')}`));
    }
    /* Only the public kit: a generated suite never reaches into tablewalk's source. */
    for (const file of ['journeys.test.ts', 'permissions.test.ts'])
      assert.doesNotMatch(readFileSync(join(dir, 'tests', file), 'utf8'), /from '(?!@mistriwork\/mistri\/testing'|node:|\.\/start\.ts')/);

    writeFileSync(join(dir, 'tests', 'journeys.test.ts'), '// mine\n');
    const refused = cli(['test', 'init', dir]);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /already exist.*--force/s);
    assert.equal(readFileSync(join(dir, 'tests', 'journeys.test.ts'), 'utf8'), '// mine\n');
    assert.equal(cli(['test', 'init', dir, '--force']).status, 0);

    const run = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'tests/*.test.ts'], {
      cwd: dir,
      encoding: 'utf8',
      /* Its own run, reporting to its own stdout rather than to this runner (NODE_TEST_CONTEXT). */
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_TEST_CONTEXT')),
        TSX_TSCONFIG_PATH: join(ROOT, 'tsconfig.json'),
      },
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const passed = Number(/^ℹ pass (\d+)/m.exec(run.stdout)?.[1]);
    assert.ok(passed >= 2, run.stdout);
    assert.match(run.stdout, /^ℹ fail 0/m);
  });
}

test('test init writes a cross-table verb as the action on the record its command runs on', async () => {
  /* Depot's "Receive line" moves a purchase order, and its command runs on one of the order's lines: written as the
     order's action it found none and was skipped as pending, testing nothing. */
  const dir = join(work, 'apps', `depot-${++made}`);
  cpSync(join(ROOT, 'test', 'fixtures', 'apps', 'depot'), dir, { recursive: true });
  assert.equal(cli(['test', 'init', dir]).status, 0);
  const journeys = readFileSync(join(dir, 'tests', 'journeys.test.ts'), 'utf8');
  assert.match(journeys, /Receive line \(receiveLine\): moves its purchase_order, run on a po_line record/);
  assert.match(journeys, /person\.act\('po_line', 'receive'\)/);
  assert.doesNotMatch(journeys, /person\.act\('purchase_order', 'receiveLine'/);
  assert.match(readFileSync(join(dir, 'tests', 'permissions.test.ts'), 'utf8'), /command: 'receiveLine', on: 'po_line'/);
});

test('test init seeds a record a matrix row needs that the database has none of', async () => {
  const dir = join(work, 'apps', `ledger-${++made}`);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, '..', `ledger-${made}.db`));
  db.exec(`CREATE TABLE account(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE entry(id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES account(id), memo TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('debit', 'credit')), cents INTEGER NOT NULL, note TEXT, posted INTEGER NOT NULL DEFAULT 0);
    INSERT INTO account VALUES (1, 'Cash');`);
  db.close();
  writeFileSync(
    join(dir, '..', `ledger-${made}.json`),
    JSON.stringify({ connections: [{ name: 'ledger', url: join(dir, '..', `ledger-${made}.db`), writable: true }] }),
  );
  cpSync(join(dir, '..', `ledger-${made}.json`), join(dir, 'mistri.json'), { recursive: true });
  writeFileSync(
    join(dir, 'app.json'),
    JSON.stringify({
      id: 'ledger',
      name: 'Ledger',
      connection: 'ledger',
      resources: { account: {}, entry: { access: 'write' } },
      auth: { roles: { clerk: { read: ['account', 'entry'], write: ['entry'] }, viewer: { read: ['account'] } } },
      views: { entries: { kind: 'list', from: 'entry' } },
      home: 'entries',
      nav: ['entries'],
    }),
  );
  // A tsconfig that names no types: TypeScript 7 then loads no @types package, and the tests' node: imports are missing.
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));
  const init = cli(['test', 'init', dir]);
  assert.equal(init.status, 0, init.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'tsconfig.json'), 'utf8')).compilerOptions, { strict: true, types: ['node'] });
  assert.match(init.stdout, /added "types": \["node"\] to .*tsconfig\.json/);
  const matrix = readFileSync(join(dir, 'tests', 'permissions.test.ts'), 'utf8');
  /* What the database must be given, and nothing it fills itself: the reference its first row, the check its first
     allowed value. */
  assert.match(matrix, /await host\.seed\('entry', \{ account_id: 1, memo: '[^']+', kind: 'debit', cents: 1 \}\);/);
  assert.doesNotMatch(matrix, /host\.seed\('account'/);
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'tests/permissions.test.ts'], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_TEST_CONTEXT')),
      TSX_TSCONFIG_PATH: join(ROOT, 'tsconfig.json'),
    },
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});

test('test init writes a suite for a row-policy App: its policy and jobs served, a matrix of what it can know', async () => {
  const dir = await exampleApp('lintel');
  rmSync(join(dir, 'tests'), { recursive: true, force: true });
  const init = cli(['test', 'init', dir]);
  assert.equal(init.status, 0, init.stderr);
  const start = readFileSync(join(dir, 'tests', 'start.ts'), 'utf8');
  assert.match(start, /args: \['--policy', 'policy\.ts', '--jobs', 'jobs\.ts'\]/);
  assert.match(start, /PAYMENT_CALLBACK_SECRET: process\.env\.PAYMENT_CALLBACK_SECRET \?\? randomBytes/);
  const journeys = readFileSync(join(dir, 'tests', 'journeys.test.ts'), 'utf8');
  // A person per role, never a service: the rent poster's work is its job's, run now.
  assert.match(journeys, /host\.as\('resident'\)/);
  assert.doesNotMatch(journeys, /host\.as\('rent_poster'\)/);
  assert.match(journeys, /host\.runJob\('postRent'\)/);
  assert.match(journeys, /the row policy gives this person no/);
  const matrix = readFileSync(join(dir, 'tests', 'permissions.test.ts'), 'utf8');
  // Where a grant lands is the policy's to say: no allowed write or command row, every refusal and read kept.
  assert.doesNotMatch(matrix, /(write|command): '[^']+'.*allowed: true/);
  assert.match(matrix, /\{ role: 'resident', write: 'staff'.*allowed: false \}/);
  const run = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--test',
      '--test-name-pattern=each job at times|each role may do',
      'tests/journeys.test.ts',
      'tests/permissions.test.ts',
    ],
    {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_TEST_CONTEXT')),
        TSX_TSCONFIG_PATH: join(ROOT, 'tsconfig.json'),
      },
    },
  );
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /^ℹ pass [1-9]/m);
});

test('test init names a command action by its id, not its place in the list', () => {
  /* Commons' Edit profile is a record action running a command with inputs, on no machine edge: the journey's
     "one command" step. Named by its index, `act` found no such action and the step was skipped as pending. */
  const dir = join(work, 'apps', `commons-${++made}`);
  cpSync(join(ROOT, 'test', 'fixtures', 'apps', 'commons'), dir, { recursive: true });
  const init = cli(['test', 'init', dir]);
  assert.equal(init.status, 0, init.stderr);
  const journeys = readFileSync(join(dir, 'tests', 'journeys.test.ts'), 'utf8');
  assert.match(journeys, /person\.act\('member', 'editProfile'\)/);
  assert.doesNotMatch(journeys, /person\.act\('[^']+', '\d+'/);
});

test('test init refuses what it cannot write a suite for', () => {
  const unknown = cli(['test', 'frobnicate']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /init/);
  const missing = cli(['test', 'init', join(work, 'nowhere')]);
  assert.notEqual(missing.status, 0);
});

/* Skill run: generated journeys sent commands whose questions the kit could not answer and failed out of the box. A
   question only the test can answer comes back as `no_input`, naming it, and a journey's step is skipped and said. */
test('a step whose command asks what only the test can answer is skipped and said, not failed', () => {
  const skipped: string[] = [];
  assertApplied(
    { ok: false, status: 0, code: 'no_input', message: '"close" asks "code", which the kit cannot answer for you', body: undefined },
    {
      skip: (message?: string) => skipped.push(message ?? ''),
    },
  );
  assert.deepEqual(skipped, ['"close" asks "code", which the kit cannot answer for you']);
  assert.throws(() =>
    assertApplied({ ok: false, status: 400, code: 'invalid_input', message: 'The command input is invalid.', body: undefined }),
  );
});

test('test init writes a tenant App an isolation suite that passes: each resource, command and platform read', async () => {
  /* The clinic fixture: two clinics with rows, a payment command on an appointment, a platform role. Its stores are
     made as the docs say, under the audit key the suite then runs with. */
  const dir = join(work, 'apps', `clinic-${++made}`);
  cpSync(join(ROOT, 'test', 'fixtures', 'apps', 'clinic'), dir, { recursive: true });
  const { seedSqlite } = (await import(join(ROOT, 'test', 'fixtures', 'databases', 'clinic', 'seed.mjs'))) as {
    seedSqlite(file: string): void;
  };
  seedSqlite(join(dir, 'clinic.db'));
  // A row of each clinic-owned table in both clinics, so no isolation check is skipped for want of one.
  const db = new DatabaseSync(join(dir, 'clinic.db'));
  db.exec(`INSERT INTO payment VALUES ('pay-n', 'north', 'ap-north-2', 100, 'card'), ('pay-s', 'south', 'ap-south-1', 100, 'cash');
    INSERT INTO notice VALUES ('nt-n', 'north', 'North notice'), ('nt-s', 'south', 'South notice');
    INSERT INTO visit_request VALUES ('rq-n', 'north', 'Ada', '555-0100', NULL), ('rq-s', 'south', 'Cy', '555-0200', NULL);`);
  db.close();
  writeFileSync(join(dir, 'mistri.json'), JSON.stringify({ connections: [{ name: 'clinic-db', url: './clinic.db', writable: true }] }));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_TEST_CONTEXT')),
    MISTRI_AUDIT_KEY: 'k'.repeat(40),
    XDG_CONFIG_HOME: join(dir, '.config'),
    TSX_TSCONFIG_PATH: join(ROOT, 'tsconfig.json'),
  };
  const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', ENTRY, ...args], { encoding: 'utf8', env, cwd: dir });
  const up = run([
    'migrate',
    'stores',
    'up',
    '--app',
    dir,
    '--policy',
    join(dir, 'server', 'tenant-policy.ts'),
    '--config',
    join(dir, 'mistri.json'),
  ]);
  assert.equal(up.status, 0, up.stdout + up.stderr);
  const init = run(['test', 'init', dir]);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  assert.match(init.stdout, /wrote .*tests\/tenants\.test\.ts/);
  assert.doesNotMatch(init.stdout, /journeys|permissions/);
  const start = readFileSync(join(dir, 'tests', 'start.ts'), 'utf8');
  assert.match(start, /args: \['--policy', 'server\/tenant-policy\.ts', '--commands', 'commands\.ts'\]/);
  assert.match(start, /MISTRI_AUDIT_KEY: process\.env\.MISTRI_AUDIT_KEY \?\?/);
  const suite = readFileSync(join(dir, 'tests', 'tenants.test.ts'), 'utf8');
  // Two clinics of the database, each clinic-owned table, the command a clinic runs and the operator's reads.
  assert.match(suite, /\?\? 'east,north'/);
  for (const table of ['appointment', 'patient', 'payment', 'service', 'visit_request', 'notice'])
    assert.match(suite, new RegExp(`\\['${table}', '`));
  assert.match(suite, /\['recordPayment', 1, 'appointment', '\w+', '\w+', '\{"amount_cents":1,"method":"card"\}'\]/);
  assert.match(suite, /\['operator', \['appointment', 'clinic'/);
  assert.doesNotMatch(suite, /from '(?!@mistriwork\/mistri\/testing'|node:|\.\/start\.ts')/);

  const tests = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'tests/tenants.test.ts'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...env, MISTRI_TEST_TENANTS: 'north,south' },
  });
  assert.equal(tests.status, 0, `${tests.stdout}\n${tests.stderr}`);
  assert.match(tests.stdout, /^ℹ fail 0/m);
  // The membership check, six resources, one command and the operator, and the test around them: none skipped.
  assert.match(tests.stdout, /^ℹ pass 10/m);
  assert.match(tests.stdout, /^ℹ skipped 0/m);
});
