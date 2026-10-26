/**
 * A workflow through the real host: a signed delivery applies for a loan, the
 * fact it records starts an instance through the event store's delivery, the
 * runner's wake-up jobs carry it through a timer, and its step runs the
 * App's own command as its principal under a receipt. The engine's cases
 * (waits, retries, divergence) are workflow-engine.test.ts.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { openSqliteWorkflowStore } from '../packages/mistri/src/adapters/workflows/workflowStore.js';
import { provisionStores } from '../packages/mistri/src/server/maintenance.js';

const FIXTURE = resolve('test/fixtures/apps/loan-flow');
const ROOT = resolve('.');
/* An App's starts are mistri's (test/support/bins.ts). */
const ENTRY = join(ROOT, 'packages', 'mistri', 'src', 'server', 'index.ts');
const SECRET = 'loan-flow-test-secret-value';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

async function until(check: () => boolean | Promise<boolean>, what: string) {
  const deadline = Date.now() + 20_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `${what} did not happen`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('a delivery starts a workflow that sleeps, then approves the loan once, as its principal', { timeout: 60_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-workflow-host-'));
  const children: ChildProcess[] = [];
  t.after(async () => {
    for (const child of children)
      if (child.exitCode === null) {
        const closed = once(child, 'close');
        child.kill('SIGTERM');
        await closed;
      }
    rmSync(directory, { recursive: true, force: true });
  });

  const home = join(directory, 'loans');
  mkdirSync(home);
  const database = join(home, 'business.db');
  const db = new DatabaseSync(database);
  db.exec('CREATE TABLE loan(id INTEGER PRIMARY KEY, ref TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0)');
  db.close();
  migrateSqliteCommandJournal(database);
  writeFileSync(
    join(home, 'app.json'),
    JSON.stringify({
      id: 'loans',
      name: 'Loans',
      sources: { data: { connection: 'data', default: true } },
      resources: { loan: { access: 'write' } },
      auth: {
        store: join(directory, 'auth.db'),
        providers: ['email'],
        roles: { intake: { read: true, service: true, commands: ['applyLoan'] }, automation: { read: true, commands: ['approveLoan'] } },
      },
      views: { loans: { kind: 'list', from: 'loan' } },
      home: 'loans',
    }),
  );
  // The suite reads an App's modules from its own directory; these hand it the fixture's.
  for (const name of ['commands', 'jobs']) {
    writeFileSync(
      join(home, `${name}.mjs`),
      `export { default } from ${JSON.stringify(pathToFileURL(join(FIXTURE, name === 'jobs' ? 'workflows.mjs' : 'commands.mjs')).href)};\n`,
    );
  }
  const commands = (await import(pathToFileURL(join(home, 'commands.mjs')).href)).default;
  const jobs = (await import(pathToFileURL(join(home, 'jobs.mjs')).href)).default;
  const provisioned = await provisionStores({ sqlite: database }, { app: { id: 'loans', commands }, jobs });
  assert.equal(provisioned.stores.workflows?.provisioned, true, 'the workflow store is provisioned with the jobs');
  assert.deepEqual(
    provisioned.destinations.map((destination) => destination.id),
    ['workflow:loan@1'],
  );

  const config = join(directory, 'mistri.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'data', url: database, writable: true }] }));
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      ENTRY,
      '--config',
      config,
      '--app',
      home,
      '--jobs',
      join(home, 'jobs.mjs'),
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MISTRI_OPEN: '0',
        XDG_CONFIG_HOME: join(directory, 'config'),
        LOAN_FLOW_SECRET: SECRET,
        BETTER_AUTH_SECRET: 'synthetic-workflow-secret-at-least-thirty-two-characters',
      },
    },
  );
  children.push(child);
  let log = '';
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`did not start: ${log}`)), 120_000);
    const read = (chunk: unknown) => {
      log += String(chunk);
      if (log.includes('Listening on')) {
        clearTimeout(timer);
        done();
      }
    };
    child.stdout!.on('data', read);
    child.stderr!.on('data', read);
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(`exited: ${log}`));
    });
  });

  const body = JSON.stringify({ key: 'apply-1', ref: 'L-100' });
  const send = (at = String(Date.now())) =>
    fetch(`http://127.0.0.1:${port}/api/inbound/apply`, {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-timestamp': at,
        'x-signature': createHmac('sha256', SECRET).update(`${at}.${body}`).digest('hex'),
      },
    });
  assert.equal((await send()).status, 204);

  const workflows = openSqliteWorkflowStore(database);
  t.after(() => workflows.close());
  await until(async () => (await workflows.inspect()).length === 1, 'the instance to start');
  const loans = () => {
    const read = new DatabaseSync(database, { readOnly: true });
    read.exec('PRAGMA busy_timeout = 5000');
    try {
      return read.prepare('SELECT status, version FROM loan').all();
    } finally {
      read.close();
    }
  };
  assert.deepEqual(
    loans().map((row) => row.status),
    ['applied'],
    'asleep, not yet approved',
  );

  await until(async () => (await workflows.inspect())[0]?.state === 'completed', 'the instance to complete');
  assert.deepEqual(
    loans().map((row) => ({ ...row })),
    [{ status: 'approved', version: 1 }],
  );
  const [instance] = await workflows.inspect();
  assert.deepEqual(
    (await workflows.steps(instance.id)).map((step) => [step.name, step.kind, step.status]),
    [
      ['cooling-off', 'sleep', 'completed'],
      ['approve[1]', 'run', 'completed'],
    ],
  );

  // The same delivery again is the same application: no second loan, no second instance.
  assert.ok([204, 200].includes((await send()).status));
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(loans().length, 1);
  assert.equal((await workflows.inspect()).length, 1);
});
