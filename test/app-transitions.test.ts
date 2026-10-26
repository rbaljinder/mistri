import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { refusalSaid } from '../packages/engine/src/shared/refusal.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { authorizeTransaction } from '../packages/mistri/src/server/app/appAccess.js';
import { AppTransitionDenied, compileAppTransitions } from '../packages/mistri/src/server/app/appTransitions.js';
import { parseAppConfig, type AppDef } from '../packages/mistri/src/shared/app.js';

/* A task moves new → working → done, or is canceled from new or working with a note. */
const cancel = { to: 'canceled', label: 'Cancel', reason: 'note' } as const;
const APP = parseAppConfig(
  {
    id: 'transitions',
    name: 'Transitions',
    resources: {
      task: {
        access: 'write',
        machine: {
          column: 'state',
          states: {
            new: { on: { start: 'working', cancel } },
            working: { on: { finish: 'done', cancel } },
            done: { final: true },
            canceled: { final: true },
          },
        },
      },
    },
    views: { tasks: { kind: 'list', from: 'task' } },
    home: 'tasks',
  },
  'transitions',
);

async function fixture(t: import('node:test').TestContext, app: AppDef = APP) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-app-transitions-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'transitions.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE task (id INTEGER PRIMARY KEY, name TEXT, state TEXT DEFAULT 'new', note TEXT);
    INSERT INTO task (name) VALUES ('first');`);
  db.close();
  const adapter = new SqliteAdapter(file, 'transitions');
  t.after(() => adapter.close());
  const schema = await adapter.introspect();
  const transitions = compileAppTransitions(schema, app);
  const access = { readable: new Set(['task']), writable: new Set(['task']), transitions };
  const update = (values: Record<string, string | null>, restore?: true) =>
    adapter.transaction!((tx) =>
      authorizeTransaction(schema, access, tx).update({
        table: 'task',
        key: { id: 1 },
        values,
        ...(restore ? { restore } : {}),
      }),
    );
  const insert = (values: Record<string, string>) =>
    adapter.transaction!((tx) => authorizeTransaction(schema, access, tx).insert({ table: 'task', values }));
  const check = new DatabaseSync(file);
  t.after(() => check.close());
  const row = () => ({ ...check.prepare('SELECT state, note FROM task WHERE id = 1').get() });
  return { update, insert, row };
}

test("a machine's column moves along an edge whose verb holds, and any other move is refused and rolled back", async (t) => {
  const { update, row } = await fixture(t);
  await assert.rejects(
    () => update({ state: 'done' }),
    (error) =>
      error instanceof AppTransitionDenied &&
      error.message === '"state" moves only by its machine\'s verbs, and none takes it from "new" to "done" now.' &&
      // What the person is told names the move they asked for, not the state the record is stored in (that column may not be theirs to read).
      refusalSaid(error) ===
        'The record\'s current state does not allow this change: "state" cannot move to "done" by any action this account can run on it now.',
  );
  assert.equal(row().state, 'new');
  await update({ state: 'working' });
  assert.equal(row().state, 'working');
  // The same value is not a change, and other columns are not the machine's to judge.
  await update({ state: 'working', note: 'still going' });
  assert.deepEqual(row(), { state: 'working', note: 'still going' });
});

test('a verb from a state that does not list it does not move the record', async (t) => {
  const { update, row } = await fixture(t);
  // Start leaves only new; Finish only working.
  await assert.rejects(() => update({ state: 'done' }), AppTransitionDenied);
  await update({ state: 'working' });
  // Back to new is no verb's move.
  await assert.rejects(() => update({ state: 'new' }), AppTransitionDenied);
  await update({ state: 'done' });
  assert.equal(row().state, 'done');
});

test('a verb that asks a reason needs one in the same write', async (t) => {
  const { update, row } = await fixture(t);
  await assert.rejects(
    () => update({ state: 'canceled' }),
    (error) => error instanceof AppTransitionDenied && error.message === '"Cancel" needs a reason.',
  );
  await assert.rejects(() => update({ state: 'canceled', note: '   ' }), AppTransitionDenied);
  assert.equal(row().state, 'new');
  await update({ state: 'canceled', note: 'Duplicate of #4' });
  assert.deepEqual(row(), { state: 'canceled', note: 'Duplicate of #4' });
});

test("history's revert returns a record to its before-image without being a new transition", async (t) => {
  const { update, row } = await fixture(t);
  await update({ state: 'working' });
  await assert.rejects(() => update({ state: 'new' }), AppTransitionDenied);
  await update({ state: 'new' }, true);
  assert.equal(row().state, 'new');
});

test("a new record starts in the machine's first state", async (t) => {
  const { insert } = await fixture(t);
  await assert.rejects(() => insert({ name: 'skipped ahead', state: 'done' }), AppTransitionDenied);
  assert.equal((await insert({ name: 'from the form', state: 'new' })).row?.state, 'new');
  assert.equal((await insert({ name: 'defaulted' })).row?.state, 'new');
});

test('a machine the server could not enforce fails to compile, never becomes an unchecked write', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-app-transitions-schema-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'schema.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE task (id INTEGER PRIMARY KEY, state TEXT, note TEXT);');
  db.close();
  const adapter = new SqliteAdapter(file, 'schema');
  t.after(() => adapter.close());
  const schema = await adapter.introspect();
  const machineOn = (machine: Record<string, unknown>) =>
    parseAppConfig(
      { name: 'T', resources: { task: { access: 'write', machine } }, views: { tasks: { kind: 'list', from: 'task' } }, home: 'tasks' },
      't',
    );
  const states = { a: { on: { go: { to: 'b', reason: 'why' } } }, b: { final: true } };
  assert.throws(
    () => compileAppTransitions(schema, machineOn({ column: 'ghost', states: { a: { on: { go: 'b' } }, b: { final: true } } })),
    /the machine's column "ghost" is not a column of task/,
  );
  assert.throws(
    () => compileAppTransitions(schema, machineOn({ column: 'id', states: { a: { on: { go: 'b' } }, b: { final: true } } })),
    /is part of the key, and a key does not move/,
  );
  assert.throws(
    () => compileAppTransitions(schema, machineOn({ column: 'state', states })),
    /asks its reason into "why", which is not a column of task/,
  );
  assert.throws(
    () =>
      compileAppTransitions(schema, machineOn({ column: 'state', since: 'when', states: { a: { on: { go: 'b' } }, b: { final: true } } })),
    /"since" names "when", which is not a column of task/,
  );
  assert.equal(
    compileAppTransitions(
      schema,
      parseAppConfig(
        {
          name: 'T',
          resources: { task: { access: 'write', actions: { go: { label: 'Go', set: { state: 'x' } } } } },
          views: { tasks: { kind: 'list', from: 'task' } },
          home: 'tasks',
        },
        't',
      ),
    ),
    undefined,
  );
});

test("a machine's clocks are its own: no write sets its since or a state's stamp, and a move always restamps them", async (t) => {
  /* Every writer of the table may write them (appAccess withMachineColumns), so a verb can; an `after` timer counts
     from `since`, and a write that set it back fired the timer early. */
  const app = parseAppConfig(
    {
      id: 'clocks',
      name: 'Clocks',
      resources: {
        task: {
          access: 'write',
          machine: {
            column: 'state',
            since: 'state_since',
            states: { new: { on: { start: 'working' } }, working: { on: { finish: 'done' } }, done: { final: true } },
          },
        },
      },
      views: { tasks: { kind: 'list', from: 'task' } },
      home: 'tasks',
    },
    'clocks',
  );
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-app-clocks-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'clocks.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE task (id INTEGER PRIMARY KEY, name TEXT, state TEXT DEFAULT 'new', state_since TIMESTAMP, working_at TIMESTAMP);
    INSERT INTO task (name, state_since) VALUES ('first', '2026-10-18T09:00:00.000Z');`);
  db.close();
  const adapter = new SqliteAdapter(file, 'clocks');
  t.after(() => adapter.close());
  const schema = await adapter.introspect();
  const access = { readable: new Set(['task']), writable: new Set(['task']), transitions: compileAppTransitions(schema, app) };
  const update = (values: Record<string, string | null>) =>
    adapter.transaction!((tx) => authorizeTransaction(schema, access, tx).update({ table: 'task', key: { id: 1 }, values }));
  const insert = (values: Record<string, string>) =>
    adapter.transaction!((tx) => authorizeTransaction(schema, access, tx).insert({ table: 'task', values }));
  const check = new DatabaseSync(file);
  t.after(() => check.close());
  const row = () => ({ ...check.prepare('SELECT state, state_since, working_at FROM task WHERE id = 1').get() });

  // Set back on its own, or beside a move: refused, nothing written.
  await assert.rejects(() => update({ state_since: '2000-01-01T00:00:00.000Z' }), AppTransitionDenied);
  await assert.rejects(() => update({ state: 'working', state_since: '2000-01-01T00:00:00.000Z' }), AppTransitionDenied);
  await assert.rejects(() => update({ state: 'working', working_at: '2000-01-01T00:00:00.000Z' }), AppTransitionDenied);
  assert.deepEqual(row(), { state: 'new', state_since: '2026-10-18T09:00:00.000Z', working_at: null });
  // Repeated unchanged, as a form may send it, it is no write of the clock; the move stamps it anew.
  await update({ state: 'working', state_since: '2026-10-18T09:00:00.000Z' });
  const moved = row();
  assert.equal(moved.state, 'working');
  assert.notEqual(moved.state_since, '2026-10-18T09:00:00.000Z');
  assert.ok(moved.working_at, "the state's own stamp is the machine's");
  // A move as its button sends it, `since` as the verb's word `now`: the verb's, and stamped with the server's moment.
  await update({ state: 'done', state_since: 'now' });
  const finished = row();
  assert.equal(finished.state, 'done');
  assert.notEqual(finished.state_since, 'now');
  assert.ok(finished.state_since);
  // A new record's clocks are not the writer's either.
  await assert.rejects(() => insert({ name: 'backdated', state_since: '2000-01-01T00:00:00.000Z' }), AppTransitionDenied);
  assert.ok((await insert({ name: 'stamped' })).row?.state_since);
});
