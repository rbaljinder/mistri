/**
 * Work larger than one command, in a real server (the CLI, over SQLite): a
 * command queues a row per item, and a timer at the instant each row keeps
 * (`at`, with `failed`) runs one command per row through the jobs, each its
 * own transaction and receipt under the jobs module's principal.
 *
 * 1. One command queues more rows than a sweep's page; `host.runJob` on the
 *    timer runs every one, page after page, and says how many.
 * 2. A row whose command is refused keeps the refusal — the code and the
 *    handler's own sentence — written by the timer's `failed` command, and
 *    its job is done: nothing is left failed for an operator.
 * 3. Progress is the rows: a person reads waiting, done and failed off them.
 * 4. A person retries a failed row by giving it a new instant; it runs once
 *    more, and a row that already ran is never run again.
 * 5. Startup refuses a `failed` command that does not take what it is told.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createTestWorkspace, startTestApp } from '../packages/mistri/src/server/testing.js';
import { COMMAND_JOURNAL_TABLES as journal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { JOB_TABLES } from '../packages/mistri/src/adapters/jobs/jobStoreSchema.js';
import { ROOT, childEnv, runCli } from './appApiCli.js';

const src = (path: string) => JSON.stringify(pathToFileURL(join(ROOT, path)).href);
/** More than the hundred rows one sweep reads, so the run needs the sweeps that follow. */
const LINES = 230;

async function lab(t: { after(fn: () => unknown): void }, failed: string) {
  const workspace = await createTestWorkspace();
  t.after(() => workspace.close());
  const database = await workspace.database('billing.db', (db) =>
    db.exec(`
      CREATE TABLE advice (id INTEGER PRIMARY KEY, payer TEXT NOT NULL, lines INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE advice_line (id INTEGER PRIMARY KEY, advice_id INTEGER NOT NULL REFERENCES advice(id), claim TEXT NOT NULL,
        amount INTEGER NOT NULL, queued_at TIMESTAMP NOT NULL, state TEXT NOT NULL DEFAULT 'waiting', refusal TEXT,
        UNIQUE (advice_id, claim));
      CREATE INDEX advice_line_waiting ON advice_line (state, queued_at);
      CREATE TABLE ledger (id INTEGER PRIMARY KEY, claim TEXT NOT NULL, amount INTEGER NOT NULL);
      INSERT INTO advice (id, payer) VALUES (1, 'Northwind Mutual');
    `),
  );
  await workspace.write('app/app.json', {
    id: 'billing',
    name: 'Billing',
    sources: { billing: { connection: 'billing' } },
    resources: {
      advice: {
        access: 'write',
        actions: { post: { label: 'Post', command: 'postAdvice' } },
      },
      advice_line: {
        access: 'write',
        actions: { retry: { label: 'Retry', command: 'retryLine' } },
        at: {
          queued_at: {
            command: 'postLine',
            when: "state = 'waiting'",
            failed: 'failLine',
          },
        },
      },
      ledger: { access: 'write' },
    },
    auth: {
      providers: ['email'],
      store: workspace.path('auth.db'),
      roles: {
        automation: {
          read: true,
          service: true,
          commands: ['postLine', 'failLine', 'tidy'],
        },
        biller: { read: true, commands: ['postAdvice', 'retryLine'] },
      },
    },
    views: {
      advices: { kind: 'list', from: 'advice' },
      lines: { kind: 'list', from: 'advice_line' },
    },
    home: 'advices',
  });
  writeFileSync(
    workspace.path('app/commands.mjs'),
    `import { defineCommand, defineCommands, field, refuse } from ${src('packages/mistri/src/server/commands.ts')};
export default defineCommands({
  // One command, one transaction: the advice's lines, each a row queued for its own run.
  postAdvice: defineCommand({ source: 'billing', target: 'advice', write: ['advice_line'], input: { lines: field.number({ min: 1, max: 5000, step: 1 }) },
    async handle({ db, record }, input) {
      await db.advice_line.insertMany(Array.from({ length: input.lines }, (_, index) => ({
        advice_id: record.id, claim: 'C-' + String(index + 1).padStart(4, '0'),
        // Every fiftieth line pays a claim that is not there.
        amount: (index + 1) % 50 === 0 ? -1 : 100 + index, queued_at: { auto: 'now' } })));
      await db.advice.update(record, { lines: input.lines });
    } }),
  postLine: defineCommand({ source: 'billing', target: 'advice_line', write: ['ledger'], input: {},
    async handle({ db, record }) {
      if (Number(record.amount) < 0) refuse('No claim ' + record.claim + ' is open with this payer.');
      await db.ledger.insert({ claim: record.claim, amount: record.amount });
      await db.advice_line.update(record, { state: 'done' });
    } }),
  failLine: defineCommand({ source: 'billing', target: 'advice_line', input: ${failed},
    async handle({ db, record }, input) {
      await db.advice_line.update(record, { state: 'failed', refusal: input.code + ': ' + input.message });
    } }),
  tidy: defineCommand({ source: 'billing', target: 'advice', targets: 'none', input: {}, async handle() {} }),
  retryLine: defineCommand({ source: 'billing', target: 'advice_line', input: { amount: field.number({ min: 0, step: 1 }) },
    async handle({ db, record }, input) {
      await db.advice_line.update(record, { state: 'waiting', refusal: null, amount: input.amount, queued_at: { auto: 'now' } });
    } }),
});
`,
  );
  writeFileSync(
    workspace.path('app/jobs.mjs'),
    `import { defineJob, defineJobs } from ${src('packages/mistri/src/server/jobs.ts')};
// A module declares a job of its own; the App's timers join it.
export default defineJobs({ yearly: defineJob({ every: '0 0 1 1 *', runAs: 'poster', command: 'tidy' }) },
  { principals: { poster: { roles: ['automation'] } } });
`,
  );
  const config = workspace.path('mistri.json');
  writeFileSync(
    config,
    JSON.stringify({
      connections: [{ name: 'billing', url: database, writable: true }],
    }),
  );
  const jobsFile = workspace.path('app/jobs.mjs');
  const env = childEnv({ XDG_CONFIG_HOME: workspace.path('config') });
  const args = ['--commands', workspace.path('app/commands.mjs'), '--jobs', jobsFile];
  return { workspace, database, config, jobsFile, env, args };
}

test('a command queues a row per item and a timer with failed runs each as its own command', { timeout: 240_000 }, async (t) => {
  const { workspace, database, config, jobsFile, env, args } = await lab(t, '{ code: field.text(), message: field.text() }');
  const up = await runCli(['migrate', 'stores', 'up', '--app', workspace.path('app'), '--jobs', jobsFile, '--config', config], env);
  assert.equal(up.code, 0, up.out + up.err);
  const host = await startTestApp({
    workspace,
    directory: workspace.path('app'),
    config,
    args,
    environment: { XDG_CONFIG_HOME: workspace.path('config') },
  });
  t.after(() => host.close());
  const db = new DatabaseSync(database, { readOnly: true, timeout: 10_000 });
  t.after(() => db.close());
  const states = () =>
    Object.fromEntries(
      db
        .prepare('SELECT state, COUNT(*) AS n FROM advice_line GROUP BY state')
        .all()
        .map((row) => [String(row.state), Number(row.n)]),
    );

  const biller = await host.as('biller');
  const posted = await biller.command('postAdvice', { id: 1 }, { lines: LINES });
  assert.ok(posted.ok, JSON.stringify(posted) + host.logs());
  assert.deepEqual(states(), { waiting: LINES });

  // The timer, run now: every waiting row, a page after a page, each a run of its own.
  const refused = Math.floor(LINES / 50);
  const run = await host.runJob('at-advice_line-queued_at');
  assert.deepEqual(run, { state: 'succeeded', code: null, ran: LINES }, host.logs());
  assert.deepEqual(states(), { done: LINES - refused, failed: refused });
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM ledger').get()!.n), LINES - refused);

  // Each run is one command of its own, journaled under the module's principal; a refused one left no receipt.
  const receipts = db
    .prepare(
      `SELECT command_id, actor_id, COUNT(*) AS n FROM "${journal.receipt}" WHERE command_id IN ('postLine', 'failLine') GROUP BY command_id, actor_id ORDER BY command_id`,
    )
    .all();
  assert.deepEqual(
    receipts.map((row) => [String(row.command_id), String(row.actor_id), Number(row.n)]),
    [
      ['failLine', 'service:poster', refused],
      ['postLine', 'service:poster', LINES - refused],
    ],
  );
  // The refusal is the row's: the code, and the handler's own sentence.
  assert.deepEqual(
    db
      .prepare("SELECT claim, refusal FROM advice_line WHERE state = 'failed' ORDER BY claim")
      .all()
      .map((row) => ({ ...row })),
    Array.from({ length: refused }, (_, index) => {
      const claim = `C-${String((index + 1) * 50).padStart(4, '0')}`;
      return {
        claim,
        refusal: `ineligible_state: No claim ${claim} is open with this payer.`,
      };
    }),
  );
  // Nothing is left failed in the job store: the refusals were the App's to keep.
  assert.deepEqual(
    db
      .prepare(`SELECT job, state, COUNT(*) AS n FROM "${JOB_TABLES.job}" GROUP BY job, state ORDER BY job`)
      .all()
      .map((row) => [String(row.job), String(row.state), Number(row.n)]),
    [
      ['at-advice_line-queued_at', 'succeeded', LINES],
      ['at-advice_line-queued_at-failed', 'succeeded', refused],
    ],
  );

  // A person reads progress off the rows, and retries a failed one: a new instant arms it once more.
  const line = db.prepare("SELECT id FROM advice_line WHERE claim = 'C-0050'").get()!;
  const retried = await biller.command('retryLine', { id: Number(line.id) }, { amount: 75 });
  assert.ok(retried.ok, JSON.stringify(retried) + host.logs());
  assert.deepEqual(states(), {
    done: LINES - refused,
    failed: refused - 1,
    waiting: 1,
  });
  // Its new instant is this second's: due once the second has passed.
  await new Promise((done) => setTimeout(done, 1200));
  const again = await host.runJob('at-advice_line-queued_at');
  assert.deepEqual([again.state, again.ran], ['succeeded', 1], host.logs());
  assert.deepEqual(states(), {
    done: LINES - refused + 1,
    failed: refused - 1,
  });
  // And a run with nothing waiting runs nothing: no row that ran is run again.
  const idle = await host.runJob('at-advice_line-queued_at');
  assert.equal(idle.ran, 0);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM ledger').get()!.n), LINES - refused + 1);
});

test(
  'a failed command that does not take the refusal is refused where the stores are made and at start',
  { timeout: 120_000 },
  async (t) => {
    const { workspace, config, jobsFile, env } = await lab(t, '{ message: field.text() }');
    const up = await runCli(['migrate', 'stores', 'up', '--app', workspace.path('app'), '--jobs', jobsFile, '--config', config], env);
    assert.notEqual(up.code, 0);
    // The journal alone, so check reaches the jobs module: it says the same, by its code.
    const journalUp = await runCli(['migrate', 'stores', 'up', '--app', workspace.path('app'), '--config', config], env);
    assert.equal(journalUp.code, 0, journalUp.out + journalUp.err);
    const check = await runCli(
      ['check', '--app', workspace.path('app'), '--commands', workspace.path('app/commands.mjs'), '--jobs', jobsFile, '--config', config],
      env,
    );
    assert.notEqual(check.code, 0, check.out + check.err);
    assert.match(check.out + check.err, /\[at-failed\]/);
    assert.match(
      up.out + up.err,
      /"advice_line" runs "failLine" at queued_at when state = 'waiting' once its timer is refused \(failed\), and "failLine" does not declare the text inputs "code" and "message" \[at-failed\]/,
    );
  },
);
