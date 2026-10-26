/**
 * A machine's graph holds on every door (appMachine.ts): Save and a list's
 * cell (the update route), New (insert), a CSV import, a fixed verb, and a
 * command — the App API's and MCP's commands run through the same executor.
 * A move along an edge is taken and stamps `since`; anything else is refused
 * and leaves the row as it was.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import type { BusinessCommandActor } from '../packages/mistri/src/server/commands/businessCommands.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { catalogOf } from './support/commandCatalog.js';

const agent: Identity = { id: 'account-agent', who: 'agent@example.test', role: 'agent' };
const close = { to: 'closed', label: 'Close', reason: 'note' } as const;
const APP = {
  id: 'desk',
  name: 'Desk',
  sources: { desk: { connection: 'desk-db', default: true } },
  resources: {
    ticket: {
      access: 'write',
      import: true,
      machine: {
        column: 'status',
        since: 'moved_at',
        states: {
          open: { on: { start: 'working', review: 'review', close } },
          working: { on: { finish: 'done', close }, by: { automation: 'escalated' } },
          review: { on: { finish: 'closed' } },
          done: { final: true },
          closed: { final: true },
          escalated: { final: true },
        },
      },
      at: { due_at: { command: 'escalate', when: "status = 'working'" } },
      actions: { reopen: { label: 'Reopen', command: 'reopen' }, escalate: { label: 'Escalate', command: 'escalate' } },
    },
  },
  auth: {
    providers: ['email'],
    roles: {
      agent: { read: true, write: ['ticket'], commands: ['finish', 'reopen', 'escalate'] },
      automation: { read: true, commands: ['finish', 'escalate'], service: true },
      intake: { read: true, commands: ['escalate'], service: true },
    },
  },
  views: { tickets: { kind: 'list', from: 'ticket' } },
  home: 'tickets',
  nav: ['tickets'],
};

async function fixture(
  run: (f: {
    db: DatabaseSync;
    control: { finishTo: string };
    runTimer: (since: string) => Promise<unknown>;
    runAs: (command: string, actor: BusinessCommandActor, timer?: { since: string; enteredAt: string; when?: string }) => Promise<unknown>;
    post: (path: string, body: object) => Promise<{ status: number; body: any }>;
    state: (id: number) => { status: string; moved_at: string | null; note: string | null };
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-machine-doors-'));
  const file = join(directory, 'desk.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE ticket (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', note TEXT, moved_at TIMESTAMP, due_at TIMESTAMP, attachment BLOB, working_at TIMESTAMP, done_on TEXT);
    INSERT INTO ticket (id, title) VALUES (1, 'Printer jam'), (2, 'Broken chair');
    INSERT INTO ticket (id, title, status) VALUES (3, 'Old request', 'done');`);
  migrateSqliteCommandJournal(file);
  clearJournal('desk-db');
  const registry = new Registry();
  registry.add({ id: 'desk-db', name: 'Desk', url: file, writable: true, source: 'config' });
  const control = { finishTo: 'done' };
  const commands = defineCommands({
    // A verb of the machine: it runs from working, and must leave the ticket done.
    finish: defineCommand({
      source: 'desk',
      target: 'ticket',
      async handle({ db: tables, record }) {
        await tables.ticket.update(record, { status: control.finishTo });
      },
    }),
    // Not a verb: whatever it writes to the status must still be an edge — and done → open is none.
    reopen: defineCommand({
      source: 'desk',
      target: 'ticket',
      when: 'status = done',
      async handle({ db: tables, record }) {
        await tables.ticket.update(record, { status: 'open' });
      },
    }),
    // Not a verb either: working → escalated is a move only the automation service makes.
    escalate: defineCommand({
      source: 'desk',
      target: 'ticket',
      async handle({ db: tables, record }) {
        await tables.ticket.update(record, { status: 'escalated' });
      },
    }),
  });
  const app = parseAppConfig(APP, 'machine doors', {
    commands: catalogOf({ finish: { target: 'ticket' }, reopen: { target: 'ticket' }, escalate: { target: 'ticket' } }),
  });
  const pages = parsePagesConfig({ pages: [] }, 'machine pages');
  const host: AppHost = {
    app: { app, path: '/private/desk/app.ts', pages, sources: {} },
    pages,
    auth: {
      spec: app.auth!,
      store: '/private/desk/auth.db',
      close() {},
      handler: async () => {},
      session: async () => agent,
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages, commands: { appId: 'desk', registry: commands } });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const base = `http://${bound.host}:${bound.port}`;
  const check = new DatabaseSync(file, { readOnly: true });
  try {
    await run({
      db,
      control,
      runTimer: async (since) => {
        const resources = await loadAppRuntimeResources(registry, app, 'desk-db');
        const binding = bindBusinessCommands({ app, registry: commands, resources, writableConnection: () => true });
        return executeBusinessCommand(
          binding,
          { id: 'service:clock', kind: 'service', appId: 'desk', roles: ['automation'] },
          {
            command: 'finish',
            commandVersion: 1,
            key: { id: 1 },
            expectedVersion: 0,
            idempotencyKey: 'machine-timer-stay-0001',
            input: {},
          },
          { door: 'job', timer: { column: 'status', state: 'working', since: 'moved_at', enteredAt: since } },
        );
      },
      runAs: async (command, actor, timer) => {
        const resources = await loadAppRuntimeResources(registry, app, 'desk-db');
        const binding = bindBusinessCommands({ app, registry: commands, resources, writableConnection: () => true });
        return executeBusinessCommand(
          binding,
          actor,
          {
            command,
            commandVersion: 1,
            key: { id: 1 },
            expectedVersion: 0,
            idempotencyKey: `machine-run-as-${actor.id.replace(/\W/g, '-')}-${timer?.enteredAt.replace(/\W/g, '') ?? 'now'}`,
            input: {},
          },
          timer ? { door: 'job', timer } : { door: 'job' },
        );
      },
      post: async (path, body) => {
        const response = await fetch(`${base}${path}`, {
          method: 'POST',
          signal: AbortSignal.timeout(10_000),
          headers: { 'content-type': 'application/json', 'x-mistri-account': agent.id },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      },
      state: (id) => ({ ...check.prepare('SELECT status, moved_at, note FROM ticket WHERE id = ?').get(id) }) as never,
    });
  } finally {
    check.close();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    db.close();
    await registry.closeAll();
    clearJournal();
    rmSync(directory, { recursive: true, force: true });
  }
}

const refusedBody = (body: unknown) => JSON.stringify(body);

test('Save, a cell and a fixed verb move the state only along an edge, and a move stamps since', async () => {
  await fixture(async ({ post, state, db }) => {
    const update = (id: number, values: Record<string, unknown>) =>
      post('/api/update', { app: 'desk', table: 'ticket', key: { id }, values });
    // open → done is no edge.
    const skipped = await update(1, { status: 'done' });
    assert.notEqual(skipped.status, 200, refusedBody(skipped.body));
    assert.equal(skipped.body.error, '"status" moves only by its machine\'s verbs, and none takes it from "open" to "done" now.');
    assert.deepEqual(state(1), { status: 'open', moved_at: null, note: null });
    // open → working is Start's edge: taken, and the moment it moved is kept.
    const started = await update(1, { status: 'working' });
    assert.equal(started.status, 200, refusedBody(started.body));
    assert.equal(state(1).status, 'working');
    assert.match(String(state(1).moved_at), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // `working_at` beside a `working` state is stamped as the record enters it, with no `set` to say so.
    assert.match(
      String(db.prepare('SELECT working_at FROM ticket WHERE id = 1').get()!.working_at),
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    );
    // Close asks its reason in the same write.
    assert.equal((await update(2, { status: 'closed' })).body.error, '"Close" needs a reason.');
    assert.equal(state(2).status, 'open');
    assert.equal((await update(2, { status: 'closed', note: 'Duplicate' })).status, 200);
    assert.deepEqual({ ...state(2), moved_at: typeof state(2).moved_at }, { status: 'closed', note: 'Duplicate', moved_at: 'string' });
    // A final state has no way out; other columns still edit.
    assert.notEqual((await update(2, { status: 'open' })).status, 200);
    assert.equal((await update(2, { note: 'Duplicate of #1' })).status, 200);
    assert.equal(state(2).status, 'closed');
  });
});

test('New starts in the first state, and an import says the same row by row', async () => {
  await fixture(async ({ post, db }) => {
    const insert = (values: Record<string, unknown>) => post('/api/insert', { app: 'desk', table: 'ticket', values });
    const ahead = await insert({ title: 'Skipped ahead', status: 'done' });
    assert.notEqual(ahead.status, 200, refusedBody(ahead.body));
    assert.equal(ahead.body.error, '"status" starts in "open", its machine\'s first state, and then moves only by its verbs.');
    assert.equal((await insert({ title: 'Fresh' })).status, 200);
    assert.match(String(db.prepare("SELECT moved_at FROM ticket WHERE title = 'Fresh'").get()!.moved_at), /^\d{4}-\d{2}-\d{2} /);
    assert.equal((await insert({ title: 'Said so', status: 'open' })).status, 200);
    // An import never fills the state: a mapping naming it is refused whole, and its rows start in the first state.
    const csv = ['Title,Status', 'Imported,open', 'Imported done,done'].join('\r\n');
    const named = await post('/api/import?app=desk', { table: 'ticket', csv, mapping: ['title', 'status'], mode: 'commit' });
    assert.equal(named.body.error, '"status" is not a field this import fills.', refusedBody(named.body));
    const written = await post('/api/import?app=desk', { table: 'ticket', csv, mapping: ['title', null], mode: 'commit' });
    assert.equal(written.status, 200, refusedBody(written.body));
    assert.deepEqual(
      db
        .prepare("SELECT status FROM ticket WHERE title LIKE 'Imported%'")
        .all()
        .map((row) => row.status),
      ['open', 'open'],
    );
    const count = () => Number((db.prepare("SELECT count(*) AS n FROM ticket WHERE status = 'done'").get() as { n: number }).n);
    assert.equal(count(), 1, 'only the seeded done ticket');
  });
});

test('a command verb runs only from its states and must leave the record in its own; any other command writes only along an edge', async () => {
  await fixture(async ({ post, state, control, db }) => {
    let requests = 0;
    const run = async (command: string, id: number) => {
      const prepared = await post('/api/commands/prepare', { command, commandVersion: 1, key: { id } });
      assert.equal(prepared.status, 200, refusedBody(prepared.body));
      return post('/api/commands/execute', {
        command,
        commandVersion: 1,
        key: { id },
        expectedVersion: prepared.body.expectedVersion,
        idempotencyKey: `machine-door-request-${String(++requests).padStart(4, '0')}`,
        input: {},
      });
    };
    // Finish is working's verb; ticket 1 is open.
    const early = await run('finish', 1);
    assert.equal(early.body.code, 'ineligible_state', refusedBody(early.body));
    assert.equal(state(1).status, 'open');
    await post('/api/update', { app: 'desk', table: 'ticket', key: { id: 1 }, values: { status: 'working' } });
    // Closed is Finish's destination from review, and Close's from working,
    // but Finish from working must go to done. Destinations cannot be unioned across states.
    control.finishTo = 'closed';
    const astray = await run('finish', 1);
    assert.equal(astray.body.code, 'ineligible_state', refusedBody(astray.body));
    assert.equal(state(1).status, 'working');
    control.finishTo = 'done';
    const finished = await run('finish', 1);
    assert.equal(finished.status, 200, refusedBody(finished.body));
    assert.equal(state(1).status, 'done');
    assert.equal(typeof state(1).moved_at, 'string');
    // A command's move stamps the state's own column too, in that column's spelling: `done_on` is a day.
    assert.match(String(db.prepare('SELECT done_on FROM ticket WHERE id = 1').get()!.done_on), /^\d{4}-\d{2}-\d{2}$/);
    // Reopen is no verb, and done → open is no edge: refused, whatever its own `when` says.
    const reopened = await run('reopen', 3);
    assert.equal(reopened.body.code, 'ineligible_state', refusedBody(reopened.body));
    assert.equal(state(3).status, 'done');
  });
});

test('a versionless command refuses a same-length binary replacement after prepare', async () => {
  await fixture(async ({ post, db, state }) => {
    db.prepare("UPDATE ticket SET status = 'working', attachment = ? WHERE id = 1").run(Buffer.from('old'));
    const request = { command: 'finish', commandVersion: 1, key: { id: 1 } };
    const before = await post('/api/commands/prepare', request);
    assert.equal(before.status, 200, refusedBody(before.body));
    db.prepare('UPDATE ticket SET attachment = ? WHERE id = 1').run(Buffer.from('new'));
    const after = await post('/api/commands/prepare', request);
    assert.equal(after.status, 200, refusedBody(after.body));
    assert.notEqual(after.body.expectedVersion, before.body.expectedVersion);
    const stale = await post('/api/commands/execute', {
      ...request,
      expectedVersion: before.body.expectedVersion,
      idempotencyKey: 'binary-revision-stale-0001',
      input: {},
    });
    assert.equal(stale.body.code, 'stale_record', refusedBody(stale.body));
    assert.equal(state(1).status, 'working');
    const fresh = await post('/api/commands/execute', {
      ...request,
      expectedVersion: after.body.expectedVersion,
      idempotencyKey: 'binary-revision-fresh-0001',
      input: {},
    });
    assert.equal(fresh.status, 200, refusedBody(fresh.body));
    assert.equal(state(1).status, 'done');
  });
});

test('a queued timer refuses a record that left and reentered its state', async () => {
  await fixture(async ({ db, runTimer, state }) => {
    const entered = '2026-01-02 00:00:00';
    db.prepare("UPDATE ticket SET status = 'working', moved_at = ? WHERE id = 1").run(entered);
    await assert.rejects(
      runTimer('2026-01-01 00:00:00'),
      (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === 'ineligible_state',
    );
    assert.equal(state(1).status, 'working');
    await runTimer(entered);
    assert.equal(state(1).status, 'done');
  });
});

test("a state's move no verb makes is taken by a service holding its role, and refused to anyone else (G100)", async () => {
  await fixture(async ({ db, post, runAs, state }) => {
    db.prepare("UPDATE ticket SET status = 'working' WHERE id = 1").run();
    const request = { command: 'escalate', commandVersion: 1, key: { id: 1 } };
    const prepared = await post('/api/commands/prepare', request);
    assert.equal(prepared.status, 200, refusedBody(prepared.body));
    const person = await post('/api/commands/execute', {
      ...request,
      expectedVersion: prepared.body.expectedVersion,
      idempotencyKey: 'machine-by-person-0001',
      input: {},
    });
    assert.equal(person.body.code, 'ineligible_state', `a person granted the command: ${refusedBody(person.body)}`);
    const refused = (error: unknown) => (error as { code?: string }).code === 'ineligible_state';
    await assert.rejects(
      runAs('escalate', { id: 'service:intake', kind: 'service', appId: 'desk', roles: ['intake'] }),
      refused,
      'a service granted the command, not the move',
    );
    assert.equal(state(1).status, 'working');
    await runAs('escalate', { id: 'service:clock', kind: 'service', appId: 'desk', roles: ['automation'] });
    assert.equal(state(1).status, 'escalated');
    assert.equal(typeof state(1).moved_at, 'string', 'the move stamps since like any other');
  });
});

test('a timer at an instant the record keeps runs only while that instant is the one it was found at, and its when still holds (G70, G127)', async () => {
  await fixture(async ({ db, runAs, state }) => {
    db.prepare("UPDATE ticket SET status = 'working', due_at = '2026-01-03 09:00:00' WHERE id = 1").run();
    const clock = { id: 'service:clock', kind: 'service', appId: 'desk', roles: ['automation'] } as const;
    const when = "status = 'working'";
    const ineligible = (error: unknown) => (error as { code?: string }).code === 'ineligible_state';
    // Found due at nine; the due time has since moved to noon: this run is stale, and noon's will be its own.
    db.prepare("UPDATE ticket SET due_at = '2026-01-03 12:00:00' WHERE id = 1").run();
    await assert.rejects(runAs('escalate', clock, { since: 'due_at', enteredAt: '2026-01-03 09:00:00', when }), ineligible);
    assert.equal(state(1).status, 'working');
    // Found while working, run once the record is back to open: its when no longer holds.
    db.prepare("UPDATE ticket SET status = 'open' WHERE id = 1").run();
    await assert.rejects(runAs('escalate', clock, { since: 'due_at', enteredAt: '2026-01-03 12:00:00', when }), ineligible);
    db.prepare("UPDATE ticket SET status = 'working' WHERE id = 1").run();
    await runAs('escalate', clock, { since: 'due_at', enteredAt: '2026-01-03 12:00:00', when });
    assert.equal(state(1).status, 'escalated');
  });
});

test('availability offers a machine verb only from a state that lists it, and leaves a non-verb command to its own when', async () => {
  await fixture(async ({ db, post }) => {
    db.exec(`UPDATE ticket SET status = 'working' WHERE id = 2`);
    const ask = async (command: string) => {
      const answer = await post('/api/commands/availability', {
        checks: [{ command, commandVersion: 1, keys: [{ id: 1 }, { id: 2 }, { id: 3 }] }],
      });
      assert.equal(answer.status, 200, refusedBody(answer.body));
      return answer.body.checks[0].available;
    };
    // Finish is listed under working and review: open (1) and done (3) are not its states.
    assert.deepEqual(await ask('finish'), [false, true, false]);
    // Reopen is no verb: only its own `when` (done) decides.
    assert.deepEqual(await ask('reopen'), [false, false, true]);
  });
});
