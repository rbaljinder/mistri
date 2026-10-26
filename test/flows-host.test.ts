/**
 * Row-driven flows through the real host (ticket-flow fixture): a ticket's
 * creation, read from its history, starts the flow its rows describe; the
 * flow sets a field, waits, runs the App's own step kind as its principal,
 * waits for the fact that the ticket was answered, branches on the answer,
 * and tells its owner in their inbox (a notify step). The rows'
 * own rules are flows.test.ts.
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
import { provisionSqliteRecordHistory } from '../packages/mistri/src/adapters/history/sqliteRecordHistory.js';
import { provisionSqliteInbox } from '../packages/mistri/src/adapters/inbox/sqliteInbox.js';
import { openSqliteWorkflowStore } from '../packages/mistri/src/adapters/workflows/workflowStore.js';
import { provisionStores } from '../packages/mistri/src/server/maintenance.js';

const FIXTURE = resolve('test/fixtures/apps/ticket-flow');
const ROOT = resolve('.');
/* An App's starts are mistri's (test/support/bins.ts). */
const ENTRY = join(ROOT, 'packages', 'mistri', 'src', 'server', 'index.ts');
const SECRET = 'ticket-flow-test-secret-value';

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

test('a created ticket runs its flow: set, wait, ask the team, wait for the answer, branch, close', { timeout: 90_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-flows-host-'));
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
  db.exec(`
    CREATE TABLE ticket(id INTEGER PRIMARY KEY, title TEXT NOT NULL, priority TEXT NOT NULL, stage TEXT, asked TEXT, answer TEXT,
      owner_email TEXT NOT NULL DEFAULT 'ana@example.test', version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE ticket_flow(id INTEGER PRIMARY KEY, name TEXT NOT NULL, start TEXT NOT NULL, condition TEXT, changes TEXT,
      active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE ticket_flow_step(id INTEGER PRIMARY KEY, flow_id INTEGER NOT NULL REFERENCES ticket_flow(id), position INTEGER NOT NULL,
      kind TEXT NOT NULL, title TEXT, duration TEXT, field TEXT, value TEXT, condition TEXT, "goto" INTEGER, event TEXT, team TEXT,
      audience TEXT, message TEXT);
    INSERT INTO ticket_flow(id, name, start, condition) VALUES (1, 'High priority', 'created', 'priority = high');
    INSERT INTO ticket_flow_step(flow_id, position, kind, field, value, duration, team, condition) VALUES
      (1, 1, 'set', 'stage', 'triage', NULL, NULL, NULL),
      (1, 2, 'wait', NULL, NULL, '1 second', NULL, NULL),
      (1, 3, 'ask', NULL, NULL, NULL, 'ops', NULL),
      (1, 4, 'branch', NULL, NULL, NULL, NULL, 'answer = yes'),
      (1, 5, 'set', 'stage', 'closed', NULL, NULL, NULL);
    INSERT INTO ticket_flow_step(flow_id, position, kind, audience, message) VALUES (1, 6, 'notify', 'requester', 'it is closed, thanks.');
    -- Written past the App's validation, as a row from before a rule changed: its run must fail visibly, not crash.
    INSERT INTO ticket_flow(id, name, start, condition) VALUES (2, 'Low priority', 'created', 'priority = low');
    INSERT INTO ticket_flow_step(flow_id, position, kind, duration) VALUES (2, 1, 'wait', 'soon');
  `);
  db.close();
  migrateSqliteCommandJournal(database);
  provisionSqliteRecordHistory(database);
  provisionSqliteInbox(database);
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
          // Whom a flow's notify step tells, and how: the step says only the audience and its words.
          notify: [{ on: { flow: 'requester' }, to: 'owner_email', title: 'Ticket {id}: {message}' }],
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
  const jobs = (await import(pathToFileURL(join(home, 'jobs.mjs')).href)).default;
  const provisioned = await provisionStores({ sqlite: database }, { app: { id: 'tickets', commands }, jobs });
  assert.equal(provisioned.stores.workflows?.provisioned, true);
  assert.deepEqual(
    provisioned.destinations.map((destination) => destination.id),
    ['workflow:tickets@1'],
    'the runner hears the event its rows may wait for',
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
        TICKET_FLOW_SECRET: SECRET,
        BETTER_AUTH_SECRET: 'synthetic-flows-secret-at-least-thirty-two-characters',
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

  const send = async (endpoint: string, payload: Record<string, unknown>) => {
    const body = JSON.stringify(payload);
    const at = String(Date.now());
    const response = await fetch(`http://127.0.0.1:${port}/api/inbound/${endpoint}`, {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-timestamp': at,
        'x-signature': createHmac('sha256', SECRET).update(`${at}.${body}`).digest('hex'),
      },
    });
    assert.ok([200, 204].includes(response.status), `${endpoint}: ${response.status} ${await response.text()} ${log}`);
  };
  const tickets = () => {
    const read = new DatabaseSync(database, { readOnly: true, timeout: 5000 });
    read.exec('PRAGMA busy_timeout = 5000');
    try {
      return read
        .prepare('SELECT id, priority, stage, asked, answer FROM ticket ORDER BY id')
        .all()
        .map((row) => ({ ...row }));
    } finally {
      read.close();
    }
  };

  await send('open', { key: 'open-ticket-one', title: 'Printer on fire', priority: 'high' });
  await send('open', { key: 'open-ticket-two', title: 'Mouse squeaks', priority: 'low' });
  const workflows = openSqliteWorkflowStore(database);
  t.after(() => workflows.close());
  const run = async (key: string) => (await workflows.inspect()).find((instance) => instance.key === key);
  await until(async () => (await run('{"id":"1"}|1')) !== undefined, `the flow to start (${log})`);
  // The low-priority ticket matched only the broken flow: its run stopped on the row, saying why, and nothing ran.
  await until(async () => (await run('{"id":"2"}|2'))?.state === 'failed', 'the broken flow to fail');
  const broken = (await run('{"id":"2"}|2'))!;
  assert.equal(broken.problem, "Step 1: duration: Enter a duration, like '2 hours' or '3 days', at most a year.");
  assert.equal(broken.problemStep, 'load');
  await until(() => tickets()[0].asked === 'ops', 'the team to be asked');
  assert.equal(tickets()[0].stage, 'triage');
  assert.equal(tickets()[1].stage, 'new', 'the broken flow wrote nothing');

  await send('answer', { key: 'answer-ticket-one', ticket: 1, answer: 'yes' });
  await until(async () => {
    const state = await run('{"id":"1"}|1');
    if (state?.state === 'failed') assert.fail(`${state.problem} at ${state.problemStep}`);
    return state?.state === 'completed';
  }, `the flow to complete (${log})`);
  assert.deepEqual(tickets()[0], { id: 1, priority: 'high', stage: 'closed', asked: 'ops', answer: 'yes' });
  const instance = (await run('{"id":"1"}|1'))!;
  assert.deepEqual(
    (await workflows.steps(instance.id)).map((step) => [step.name, step.status]),
    [
      ['load', 'completed'],
      ['set[1]', 'completed'],
      ['wait[2]', 'completed'],
      ['run[3]', 'completed'],
      ['event[3]', 'completed'],
      ['check[4]', 'completed'],
      ['set[5]', 'completed'],
      ['tell[6]', 'completed'],
    ],
  );
  const inbox = new DatabaseSync(database, { readOnly: true, timeout: 5000 });
  try {
    assert.deepEqual(
      inbox
        .prepare('SELECT recipient, resource, key_json, title FROM __mistri_inbox_notice')
        .all()
        .map((row) => ({ ...row })),
      [{ recipient: 'ana@example.test', resource: 'ticket', key_json: '{"id":1}', title: 'Ticket 1: it is closed, thanks.' }],
      'told once, in the step, by the rule its audience names',
    );
  } finally {
    inbox.close();
  }
  // The flow's own writes, and the answer (an update no flow starts on), start nothing: still two runs.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal((await workflows.inspect()).length, 2);
});
