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
import { policyServer, sourceUrl } from './support/policyServer.js';

const APP = {
  id: 'spoke',
  name: 'Spoke',
  track: 'receipts',
  auth: {
    signUp: 'open',
    defaultRole: 'mechanic',
    rows: 'policy',
    roles: { admin: { read: true }, mechanic: { read: true, commands: ['closeDay', 'openJob', 'assign'] } },
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
