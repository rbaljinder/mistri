/**
 * Skill run: on SQLite, a resource declaring `types: { created_at: 'datetime' }` over a TEXT column — the declaration
 * choices.md and recipes.md recommend — together with `rows: 'policy'` and any write grant or command refused to
 * start with only "The scoped catalog could not be verified". The App's catalog said `TEXT as datetime` and the
 * database TEXT; the declaration is the App's word, so it no longer counts against the proof. The App starts, its
 * generic write lands and a command runs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandEnvelope } from '../packages/mistri/src/server/testing/appRequests.js';
import { policyServer, sourceUrl } from './support/policyServer.js';

const SQL = `CREATE TABLE job(id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, closed_at TEXT);
  INSERT INTO job VALUES (1, 'Leak', 'open', '2026-10-01 09:00:00', NULL);`;
const POLICY = `export default { appId: 'spoke', resultReferences: { close: () => [] }, resolveRows() { return { job: true }; } };`;
const COMMANDS = `import { defineCommand, defineCommands } from ${sourceUrl('packages/mistri/src/server/commands/businessCommands.ts')};
export default defineCommands({
  close: defineCommand({ source: 'main', target: 'job', read: ['job'], write: ['job'],
    async handle({ db, record }) { await db.job.update(record, { status: 'done', closed_at: '2026-10-02 17:00:00' }); return {}; } }),
});`;

test('a row-policy App on SQLite with declared TEXT dates starts, writes and runs its command', { timeout: 60_000 }, async (t) => {
  const server = await policyServer(t, {
    app: {
      id: 'spoke',
      name: 'Spoke',
      auth: {
        signUp: 'open',
        defaultRole: 'rider',
        rows: 'policy',
        roles: {
          rider: {
            read: true,
            write: true,
            commands: ['close'],
            fields: { job: { read: ['id', 'title', 'status', 'created_at', 'closed_at'], write: ['title', 'created_at'] } },
          },
        },
      },
      resources: {
        job: {
          access: 'write',
          types: { created_at: 'datetime', closed_at: 'datetime' },
          actions: { close: { label: 'Close', command: 'close' } },
        },
      },
      views: { jobs: { kind: 'list', from: 'job' } },
      home: 'jobs',
      nav: ['jobs'],
    },
    policy: POLICY,
    sql: SQL,
    commands: COMMANDS,
  });
  assert.doesNotMatch(server.log(), /scoped catalog could not be verified/);
  const rider = await server.signUp('rider');
  const inserted = await server.api('insert', { table: 'job', values: { title: 'Door', created_at: '2026-10-02 10:00:00' } }, rider);
  assert.equal(inserted.status, 200, JSON.stringify(inserted.body));
  const prepared = await server.api('commands/prepare', { command: 'close', commandVersion: 1, key: { id: 1 } }, rider);
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  const ran = await server.api(
    'commands/execute',
    commandEnvelope({ command: 'close', commandVersion: 1, key: { id: 1 }, expectedVersion: prepared.body.expectedVersion, input: {} }),
    rider,
  );
  assert.equal(ran.status, 200, JSON.stringify(ran.body));
  const read = await server.api('query', { table: 'job', filter: { groups: [[{ column: 'id', op: '=', value: 1 }]] } }, rider);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.rows[0].status, 'done');
});
