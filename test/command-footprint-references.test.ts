/**
 * A command under a row policy that names no record and only updates rows
 * (field report R10) was refused at startup for not reading every table its
 * target's references point at, in words about "a new row" it never made.
 * Startup cannot tell a command that creates rows from one that updates them,
 * so the footprint is judged on what a write sets, when it is refused, and
 * said by name: the reference, the table, and that it belongs in `read`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readResult } from '../packages/mistri/src/server/testing/appRequests.js';
import { authorFault, isAuthorFault, recordRefusalCause } from '../packages/engine/src/shared/refusal.js';
import { policyServer, sourceUrl } from './support/policyServer.js';

const APP = {
  id: 'spoke',
  name: 'Spoke',
  track: 'receipts',
  auth: {
    signUp: 'open',
    defaultRole: 'mechanic',
    rows: 'policy',
    roles: { admin: { read: true, commands: ['openJob'] }, mechanic: { read: true, commands: ['closeDay', 'openJob', 'assign'] } },
  },
  resources: { job: { access: 'write', actions: { assign: { label: 'Assign', command: 'assign' } } }, bench: {}, staff: {} },
  views: { jobs: { kind: 'list', from: 'job' } },
  home: 'jobs',
  nav: ['jobs'],
};
const POLICY = `export default { appId: 'spoke', resultReferences: { closeDay: () => [], openJob: () => [], assign: () => [] },
  resolveRows() { return { job: { groups: [[{ column: 'bench_id', op: '=', value: 1 }]] }, bench: true, staff: true }; } };`;
const COMMANDS = `import { defineCommand, defineCommands } from ${sourceUrl('packages/mistri/src/server/commands/businessCommands.ts')};
export default defineCommands({
  // Names no record and only updates: the jobs it closes already point at their bench.
  closeDay: defineCommand({ source: 'main', target: 'job', targets: 'none', read: ['job'], write: ['job'],
    async handle(context) {
      for (const job of (await context.tx.query({ table: 'job', limit: 100, offset: 0 })).rows)
        await context.tx.update({ table: 'job', key: { id: job.id }, values: { status: 'closed' } });
      return {};
    } }),
  // Creates a job on a bench it does not read: nothing proves the bench, and the refusal says so.
  openJob: defineCommand({ source: 'main', target: 'job', targets: 'none', read: ['job'], write: ['job'],
    async handle(context) { await context.tx.insert({ table: 'job', values: { title: 'Walk-in', bench_id: 1 } }); return {}; } }),
  // Points a job at staff it does not read.
  assign: defineCommand({ source: 'main', target: 'job', read: ['job'], write: ['job'],
    async handle(context) { await context.tx.update({ table: 'job', key: { id: context.record.id }, values: { staff_id: 1 } }); return {}; } }),
});`;
const SQL = `CREATE TABLE bench(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE staff(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE job(id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
    bench_id INTEGER NOT NULL REFERENCES bench(id), staff_id INTEGER REFERENCES staff(id));
  INSERT INTO bench VALUES (1, 'Front');
  INSERT INTO staff VALUES (1, 'Mo');
  INSERT INTO job VALUES (1, 'Tune', 'open', 1, NULL), (2, 'Brakes', 'open', 1, NULL);`;

test(
  'a command under a row policy is judged on the references it sets, not on every one its target has',
  { timeout: 60_000 },
  async (t) => {
    const server = await policyServer(t, { app: APP, policy: POLICY, sql: SQL, commands: COMMANDS });
    const mechanic = await server.signUp('mechanic');
    let attempt = 0;
    const run = async (command: string, key?: Record<string, number>) => {
      // A command that names no record has no revision to prepare.
      const prepared = key ? await server.api('commands/prepare', { command, commandVersion: 1, key }, mechanic) : undefined;
      if (prepared) assert.equal(prepared.status, 200, JSON.stringify(prepared.body) + server.log());
      return server.api(
        'commands/execute',
        {
          command,
          commandVersion: 1,
          ...(key ? { key, expectedVersion: prepared!.body.expectedVersion } : { key: {}, expectedVersion: 0 }),
          idempotencyKey: `footprint-attempt-${String(++attempt).padStart(6, '0')}`,
          input: {},
        },
        mechanic,
      );
    };

    const closed = await run('closeDay');
    assert.equal(closed.status, 200, JSON.stringify(closed.body) + server.log());
    assert.equal(closed.body.status, 'applied');

    const opened = await run('openJob');
    assert.equal(opened.body.code, 'invalid_result', JSON.stringify(opened.body));
    assert.match(
      server.log(),
      /Command "openJob" set job\.bench_id, which points at a "bench" row, and "bench" is not in the command's footprint: add "bench" to its read/,
    );

    const assigned = await run('assign', { id: 2 });
    assert.equal(assigned.body.code, 'invalid_result', JSON.stringify(assigned.body));
    assert.match(
      server.log(),
      /Command "assign" set job\.staff_id, which points at a "staff" row, and "staff" is not in the command's footprint/,
    );
  },
);

/* The footprint failure is the author's own mistake, and was said under the caller's fixed sentence: "refused (500
   invalid_result): The command did not produce a valid result." on the terminal, the same as `message` in a test, with
   what to fix only beneath it or in `body.cause` (a field report). It now leads; the caller's answer is unchanged. */
test('a footprint failure leads with what to fix, for its author, and stays opaque to everyone else', { timeout: 60_000 }, async (t) => {
  const server = await policyServer(t, { app: APP, policy: POLICY, sql: SQL, commands: COMMANDS });
  const execute = (cookie: string, attempt: number) =>
    server.api(
      'commands/execute',
      {
        command: 'openJob',
        commandVersion: 1,
        key: {},
        expectedVersion: 0,
        idempotencyKey: `footprint-author-${String(attempt).padStart(6, '0')}`,
        input: {},
      },
      cookie,
    );
  const cause =
    /^Command "openJob" set job\.bench_id, which points at a "bench" row, and "bench" is not in the command's footprint: add "bench" to its read/;

  // The App's administrator, on this machine, at an App served from its source: told why, as `cause`.
  const author = await execute(await server.owner(), 1);
  assert.equal(author.body.code, 'invalid_result', JSON.stringify(author.body));
  assert.equal(author.body.message, 'The command did not produce a valid result.');
  assert.match(author.body.cause, cause);
  // Anyone else hears the fixed sentence alone.
  const mechanic = await execute(await server.signUp('mechanic'), 2);
  assert.equal(mechanic.body.code, 'invalid_result', JSON.stringify(mechanic.body));
  assert.equal(Object.hasOwn(mechanic.body, 'cause'), false, JSON.stringify(mechanic.body));

  // The terminal leads with the cause; the caller's sentence follows, as what callers are told.
  const said = server.log();
  assert.match(
    said,
    /refused \(500 invalid_result\): Command "openJob" set job\.bench_id[^\n]*\n\s+callers are told: The command did not produce a valid result\./,
    said,
  );
  assert.doesNotMatch(said, /refused \(500 invalid_result\): The command did not produce a valid result\./, said);

  // A test reads the author's answer with the cause first, and keeps it as `cause`.
  const read = await readResult(new Response(JSON.stringify(author.body), { status: author.status }));
  assert.equal(read.ok, false);
  if (read.ok) return;
  assert.match(read.message, cause);
  assert.match(read.message, /\(callers are told: The command did not produce a valid result\.\)$/);
  assert.match(read.cause ?? '', cause);
});

test("a refusal rebuilt over an author's mistake is still the author's; a cause alone is not", () => {
  const fault = authorFault(new Error('The command did not produce a valid result.'), 'Add "bench" to its read.');
  assert.equal(isAuthorFault(recordRefusalCause(new Error('The command did not produce a valid result.'), fault)), true);
  assert.equal(isAuthorFault(recordRefusalCause(new Error('Try again.'), 'A driver said no.')), false);
});
