/**
 * `mistri flows start`: records that were there before their
 * flows, started as though just created.
 *
 * 1. The start itself (workflows/flowStarts.ts) on a real SQLite job store:
 *    it reads the table a page at a time past its last key, enqueues one
 *    keyed dispatch per record, and a second run replays every key; a tenant's
 *    run reads only its own rows and carries its tenant.
 * 2. The command (cli/flowsCommand.ts) on a real App directory, then the
 *    server started with --jobs: the flow runs on the records --where chose
 *    whose condition holds, and on no other.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { connect } from '../packages/engine/src/adapters/connect.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { provisionSqliteRecordHistory } from '../packages/mistri/src/adapters/history/sqliteRecordHistory.js';
import { openSqliteJobStore } from '../packages/mistri/src/adapters/jobs/jobStore.js';
import { provisionSqliteJobStore } from '../packages/mistri/src/adapters/jobs/jobStoreSchema.js';
import { openSqliteWorkflowStore } from '../packages/mistri/src/adapters/workflows/workflowStore.js';
import { runFlowsCommand } from '../packages/mistri/src/server/cli/flowsCommand.js';
import { provisionStores } from '../packages/mistri/src/server/maintenance.js';
import { startFlows } from '../packages/mistri/src/server/workflows/flowStarts.js';

const FIXTURE = resolve('test/fixtures/apps/ticket-flow');
const ROOT = resolve('.');
/* An App's starts are mistri's (test/support/bins.ts). */
const ENTRY = join(ROOT, 'packages', 'mistri', 'src', 'server', 'index.ts');

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

async function until(check: () => boolean | Promise<boolean>, what: string) {
  const deadline = Date.now() + 30_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `${what} did not happen`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('a start pages past its last key, keys each dispatch, and a tenant reads its own rows alone', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-flows-start-'));
  const path = join(directory, 'data.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE ticket(id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, priority TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO ticket(id, tenant_id, priority) VALUES (?, ?, ?)');
  // More than two pages: the read goes on past the key each page ended on.
  for (let id = 1; id <= 450; id++) insert.run(id, id % 3 === 0 ? 'south' : 'north', id % 2 ? 'high' : 'low');
  db.close();
  provisionSqliteJobStore(path, { namespace: 'tickets' });
  const adapter = connect(path, { schemas: [] });
  const jobs = openSqliteJobStore(path, { namespace: 'tickets' });
  t.after(async () => {
    await jobs.close();
    await adapter.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const base = { adapter, table: 'ticket', keyColumn: 'id', jobs, appId: 'tickets', runner: { workflow: 'tickets', runAs: 'automation' } };
  const high = { groups: [[{ column: 'priority', op: '=' as const, value: 'high' }]] };

  assert.deepEqual(await startFlows({ ...base, filter: high, now: Date.now, dryRun: true }), {
    records: 225,
    enqueued: 0,
    already: 0,
    skipped: 0,
  });
  assert.equal((await jobs.inspect({}, 1)).length, 0, 'a dry run enqueues nothing');

  assert.deepEqual(await startFlows({ ...base, filter: high, now: Date.now }), { records: 225, enqueued: 225, already: 0, skipped: 0 });
  // Run again, and with a wider choice: what the first run enqueued is replayed by its key, the rest is new.
  assert.deepEqual(await startFlows({ ...base, now: Date.now }), { records: 450, enqueued: 225, already: 225, skipped: 0 });
  assert.deepEqual([...new Set((await jobs.inspect({}, 100)).map((job) => job.job))], ['wf-tickets']);

  // A tenant's run: its rows alone, each keyed with its owner as the history keys it, and the tenant on the job.
  const tenantJobs = openSqliteJobStore(path, { namespace: 'tickets' });
  t.after(() => tenantJobs.close());
  const enqueued: Array<{ record: string; tenant: unknown }> = [];
  const spy = {
    enqueue: async (input: Parameters<typeof tenantJobs.enqueue>[0], now: number) => {
      enqueued.push({
        record: (input.input as { dispatch: { record: string } }).dispatch.record,
        tenant: input.provenance.tenantId,
      });
      return tenantJobs.enqueue(input, now);
    },
  };
  const south = await startFlows({ ...base, jobs: spy, owner: { column: 'tenant_id', tenant: 'south' }, flow: '7', now: Date.now });
  assert.deepEqual(south, { records: 150, enqueued: 150, already: 0, skipped: 0 });
  assert.deepEqual(enqueued[0], { record: '{"id":"3","tenant_id":"south"}', tenant: 'south' });
  assert.ok(enqueued.every((each) => each.tenant === 'south' && each.record.endsWith('"tenant_id":"south"}')));
});

test(
  'flows start on an App: the server runs the created flow on the records chosen, where its condition holds',
  { timeout: 90_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-flows-start-cli-'));
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
    const home = join(directory, 'tickets');
    mkdirSync(home);
    const database = join(home, 'business.db');
    const db = new DatabaseSync(database);
    // Four tickets from before the flows: no history names them, so nothing would ever start on them.
    db.exec(`
    CREATE TABLE ticket(id INTEGER PRIMARY KEY, title TEXT NOT NULL, priority TEXT NOT NULL, stage TEXT, asked TEXT, answer TEXT,
      version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE ticket_flow(id INTEGER PRIMARY KEY, name TEXT NOT NULL, start TEXT NOT NULL, condition TEXT, changes TEXT,
      active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE ticket_flow_step(id INTEGER PRIMARY KEY, flow_id INTEGER NOT NULL REFERENCES ticket_flow(id), position INTEGER NOT NULL,
      kind TEXT NOT NULL, title TEXT, duration TEXT, field TEXT, value TEXT, condition TEXT, "goto" INTEGER, event TEXT, team TEXT);
    INSERT INTO ticket(id, title, priority, stage) VALUES (1, 'Printer', 'high', 'new'), (2, 'Mouse', 'low', 'new'),
      (3, 'Screen', 'high', 'new'), (4, 'Server', 'high', 'new');
    INSERT INTO ticket_flow(id, name, start, condition) VALUES (1, 'High priority', 'created', 'priority = high'),
      (2, 'By hand', 'manual', NULL);
    INSERT INTO ticket_flow_step(flow_id, position, kind, field, value) VALUES (1, 1, 'set', 'stage', 'triage'),
      (2, 1, 'set', 'stage', 'escalated');
  `);
    db.close();
    migrateSqliteCommandJournal(database);
    provisionSqliteRecordHistory(database);
    writeFileSync(
      join(home, 'app.json'),
      JSON.stringify({
        id: 'tickets',
        name: 'Tickets',
        sources: { data: { connection: 'data', default: true } },
        resources: {
          ticket: {
            access: 'write',
            flows: {
              from: 'ticket_flow',
              steps: 'ticket_flow_step',
              set: ['stage'],
              events: { 'ticket.answered': 'ticket' },
              kinds: { ask: { command: 'askTeam', input: ['team'], waitFor: 'ticket.answered' } },
            },
          },
          ticket_flow: { access: 'write' },
          ticket_flow_step: { access: 'write' },
        },
        auth: {
          store: join(directory, 'auth.db'),
          providers: ['email'],
          roles: {
            intake: { read: true, service: true, commands: ['openTicket', 'answerTicket'] },
            automation: { read: true, commands: ['askTeam'] },
          },
        },
        views: { tickets: { kind: 'list', from: 'ticket' } },
        home: 'tickets',
      }),
    );
    for (const name of ['commands', 'jobs'])
      writeFileSync(
        join(home, `${name}.mjs`),
        `export { default } from ${JSON.stringify(pathToFileURL(join(FIXTURE, `${name}.mjs`)).href)};\n`,
      );
    const commands = (await import(pathToFileURL(join(home, 'commands.mjs')).href)).default;
    const jobsModule = (await import(pathToFileURL(join(home, 'jobs.mjs')).href)).default;
    await provisionStores({ sqlite: database }, { app: { id: 'tickets', commands }, jobs: jobsModule });
    const config = join(directory, 'mistri.json');
    writeFileSync(config, JSON.stringify({ connections: [{ name: 'data', url: database, writable: true }] }));

    const flows = async (...args: string[]) => {
      const said: string[] = [];
      const errors: string[] = [];
      const error = console.error;
      console.error = (line: unknown) => void errors.push(String(line));
      try {
        const code = await runFlowsCommand(
          ['start', 'ticket', '--app', home, '--jobs', join(home, 'jobs.mjs'), '--config', config, ...args],
          (line) => void said.push(line),
        );
        return { code, said: said.join('\n'), errors: errors.join('\n') };
      } finally {
        console.error = error;
      }
    };
    // What is refused, before anything is enqueued.
    const manual = await flows('--flow', '2');
    assert.equal(manual.code, 1);
    assert.match(manual.errors, /flow 2 starts manual; flows start runs the flows that start on created/);
    assert.match((await flows('--flow', '9')).errors, /there is no flow 9 in ticket_flow/);
    assert.match((await flows('--tenant', 'north')).errors, /--tenant and --policy are for a tenant App; tickets is not one/);
    assert.match((await flows('--where', 'title.length > 2')).errors, /--where/);

    const dry = await flows('--where', 'id >= 2', '--dry-run');
    assert.equal(dry.code, 0, dry.errors);
    assert.match(dry.said, /3 ticket records would start the created flows; nothing was enqueued/);
    const started = await flows('--where', 'id >= 2', '--flow', '1');
    assert.equal(started.code, 0, started.errors);
    assert.match(started.said, /3 ticket records: 3 enqueued for flow 1\./);
    const again = await flows('--where', 'id >= 2', '--flow', '1');
    assert.match(again.said, /3 ticket records: 0 enqueued for flow 1, 3 already enqueued by an earlier run\./);

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
          TICKET_FLOW_SECRET: 'ticket-flow-test-secret-value',
          BETTER_AUTH_SECRET: 'synthetic-flows-secret-at-least-thirty-two-characters',
        },
      },
    );
    children.push(child);
    let log = '';
    child.stdout!.on('data', (chunk) => (log += String(chunk)));
    child.stderr!.on('data', (chunk) => (log += String(chunk)));
    const stages = () => {
      const read = new DatabaseSync(database, { readOnly: true });
      read.exec('PRAGMA busy_timeout = 5000');
      try {
        return read
          .prepare('SELECT id, stage FROM ticket ORDER BY id')
          .all()
          .map((row) => [row.id, row.stage]);
      } finally {
        read.close();
      }
    };
    // A server that refused to start says why at once, rather than as an empty log when the wait runs out.
    await until(() => {
      assert.equal(child.exitCode, null, `the server exited before running the flows:\n${log}`);
      return stages()[2][1] === 'triage' && stages()[3][1] === 'triage';
    }, `the started flows to run (${log})`);
    const workflows = openSqliteWorkflowStore(database);
    t.after(() => workflows.close());
    await until(async () => (await workflows.inspect()).every((run) => run.state === 'completed'), 'the runs to complete');
    assert.deepEqual(
      (await workflows.inspect()).map((run) => run.key).sort(),
      ['{"id":"3"}|1', '{"id":"4"}|1'],
      "ticket 1 was not chosen, and ticket 2's priority does not meet the flow's condition",
    );
    assert.deepEqual(stages(), [
      [1, 'new'],
      [2, 'new'],
      [3, 'triage'],
      [4, 'triage'],
    ]);
  },
);
