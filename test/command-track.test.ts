/*
 * What a command keeps, by the door it came through (V2): a browser's own
 * request keeps nothing unless it sends an Idempotency-Key or the App or the
 * command asks; a door that retries — the App API, MCP, a job — keeps at
 * least a receipt; `audit` keeps every change too. For each tier, a response
 * lost on the way back and the request sent again gets the documented
 * outcome: without a receipt the retry runs against the record as it now is
 * (here refused as moved: "check the record"); with one it is the first run's
 * replay, and the handler does not run again.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal, COMMAND_JOURNAL_TABLES } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { sqliteAuditRows } from './support/commandTargets.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import {
  effectiveTrack,
  executeBusinessCommand,
  lookupBusinessCommandStatus,
  type CommandDoor,
} from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands, type BusinessCommandActor } from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { parseTestApp } from './support/commandCatalog.js';

const actor: BusinessCommandActor = { id: 'account-a', appId: 'desk', roles: ['clerk'] };
const request = (idempotencyKey = 'track-request-000001', overrides: Record<string, unknown> = {}) => ({
  command: 'close',
  commandVersion: 1,
  key: { id: 1 },
  expectedVersion: 0,
  input: { note: 'done' },
  idempotencyKey,
  ...overrides,
});

async function fixture(
  options: { appTrack?: 'none' | 'receipts' | 'audit'; commandTrack?: 'none' | 'receipts' | 'audit' },
  run: (f: {
    db: DatabaseSync;
    calls: () => number;
    doors: () => readonly string[];
    execute: (door: CommandDoor | undefined, body?: unknown, entry?: 'api' | 'mcp') => Promise<unknown>;
    status: (body?: unknown) => Promise<unknown>;
    kept: () => { receipts: number; changes: unknown[] };
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-command-track-'));
  const path = join(directory, 'desk.db');
  const db = new DatabaseSync(path);
  const registry = new Registry();
  try {
    db.exec(`CREATE TABLE ticket (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, status TEXT NOT NULL, note TEXT);
      INSERT INTO ticket VALUES (1, 0, 'open', NULL), (2, 0, 'open', NULL);`);
    migrateSqliteCommandJournal(path);
    registry.add({ id: 'desk-db', name: 'desk', url: path, writable: true, source: 'config' });
    const app = parseTestApp(
      {
        id: 'desk',
        name: 'Desk',
        ...(options.appTrack ? { track: options.appTrack } : {}),
        sources: { desk: { connection: 'desk-db' } },
        resources: { ticket: { access: 'write' } },
        auth: { roles: { clerk: { read: true, commands: ['close'] } } },
        views: { tickets: { kind: 'list', from: 'ticket' } },
        home: 'tickets',
      },
      'track fixture',
    );
    let calls = 0;
    const doors: string[] = [];
    const commands = defineCommands({
      close: defineCommand({
        source: 'desk',
        target: 'ticket',
        when: 'status = open',
        ...(options.commandTrack ? { track: options.commandTrack } : {}),
        input: { note: { label: 'Note', type: 'text' } },
        output: { parse: (value: unknown) => value as { closed: number } },
        async handle({ db: tx, record, door }, input) {
          calls++;
          doors.push(door);
          await tx.ticket.update(record!, { status: 'closed', note: String((input as { note: string }).note) });
          return { closed: Number(record!.id) };
        },
      }),
    });
    const resources = await loadAppRuntimeResources(registry, app, 'desk-db');
    const binding = bindBusinessCommands({ app, resources, registry: commands, writableConnection: () => true });
    await run({
      db,
      calls: () => calls,
      doors: () => doors,
      execute: (door, body = request(), entry) =>
        executeBusinessCommand(binding, actor, body, { ...(door ? { door } : {}), ...(entry ? { entry } : {}) }),
      status: (body = request()) => lookupBusinessCommandStatus(binding, actor, body),
      kept: () => ({
        receipts: Number(db.prepare(`SELECT count(*) AS n FROM "${COMMAND_JOURNAL_TABLES.receipt}"`).get()!.n),
        changes: db
          .prepare(`SELECT changes_json FROM ${sqliteAuditRows} a ORDER BY receipt_id`)
          .all()
          .map((row) => JSON.parse(String(row.changes_json))),
      }),
    });
  } finally {
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const refusal = (code: string, outcome?: string) => (error: unknown) => {
  const refused = error as { code?: string; outcome?: string };
  assert.equal(refused.code, code);
  if (outcome) assert.equal(refused.outcome, outcome);
  return true;
};

test('the track a door gets: none for the browser, receipts where a retry can happen, never below the door', () => {
  assert.equal(effectiveTrack(undefined, 'ui'), 'none');
  assert.equal(effectiveTrack(undefined, 'ui-idempotent'), 'receipts');
  for (const door of ['api', 'mcp', 'job', 'workflow'] as const) {
    assert.equal(effectiveTrack(undefined, door), 'receipts');
    assert.equal(effectiveTrack('none', door), 'receipts', `${door} keeps a receipt whatever is declared`);
    assert.equal(effectiveTrack('audit', door), 'audit');
  }
  assert.equal(effectiveTrack('audit', 'ui'), 'audit');
  assert.equal(effectiveTrack('receipts', 'ui'), 'receipts');
});

test('a handler is told its door by the server: the keeping door, else the entry its host says, else the screen', async () => {
  await fixture({}, async (f) => {
    await f.execute('ui-idempotent', request('door-request-000001', { key: { id: 1 } }));
    await f.execute('workflow', request('door-request-000002', { key: { id: 2 } }));
    f.db.exec("UPDATE ticket SET status = 'open', version = 0");
    // A tenant's realm keeps its full journal (no door) and still says its door: the tenant API's here.
    await f.execute(undefined, request('door-request-000003', { key: { id: 1 } }), 'api');
    // A public form or an import names neither: the screen.
    await f.execute(undefined, request('door-request-000004', { key: { id: 2 } }));
    assert.deepEqual(f.doors(), ['ui', 'workflow', 'api', 'ui']);
  });
});

test('track none (a browser request): nothing is kept, and a retry after a lost answer meets the record as it is now', async () => {
  await fixture({}, async (f) => {
    const applied = (await f.execute('ui')) as { status: string; replayed: boolean };
    assert.equal(applied.status, 'applied');
    assert.equal(applied.replayed, false);
    assert.deepEqual(f.kept(), { receipts: 0, changes: [] });
    // The answer was lost; the page sends the same request again. There is no
    // receipt to replay, so it runs against the record, which has moved.
    await assert.rejects(f.execute('ui'), refusal('stale_record', 'not_applied'));
    assert.equal(f.calls(), 1, 'the handler ran once');
    assert.deepEqual(await f.status(), { status: 'not_found', outcome: 'unknown' });
    assert.deepEqual({ ...f.db.prepare('SELECT status, version FROM ticket WHERE id = 1').get() }, { status: 'closed', version: 1 });
  });
});

test("track receipts (a request with an Idempotency-Key, or the API): a retry is the first run's replay, and no change is kept", async () => {
  for (const door of ['ui-idempotent', 'api', 'job'] as const) {
    await fixture({}, async (f) => {
      const applied = (await f.execute(door)) as { receiptId: string; replayed: boolean; result: unknown };
      assert.equal(applied.replayed, false);
      const replay = (await f.execute(door)) as { receiptId: string; replayed: boolean; result: unknown };
      assert.deepEqual(replay, { ...applied, replayed: true }, `${door}: the lost answer is replayed`);
      assert.equal(f.calls(), 1, `${door}: the handler did not run again`);
      assert.deepEqual(await f.status(), { ...applied, replayed: true });
      const kept = f.kept();
      assert.equal(kept.receipts, 1);
      assert.deepEqual(kept.changes, [[]], 'a receipt keeps its target, not the changes');
      // The same key for a different request is refused, and the handler does not run.
      await assert.rejects(f.execute(door, request(undefined, { input: { note: 'other' } })), refusal('idempotency_conflict'));
      assert.equal(f.calls(), 1);
    });
  }
});

test('track audit, from the App or the command: the receipt and every change, before and after', async () => {
  for (const options of [
    { appTrack: 'audit' as const },
    { commandTrack: 'audit' as const },
    { appTrack: 'none' as const, commandTrack: 'audit' as const },
  ]) {
    await fixture(options, async (f) => {
      const applied = (await f.execute('ui')) as { replayed: boolean };
      assert.equal(applied.replayed, false);
      assert.deepEqual(await f.execute('ui'), { ...applied, replayed: true });
      assert.equal(f.calls(), 1);
      const [changes] = f.kept().changes as Array<Array<Record<string, unknown>>>;
      assert.equal(changes.length, 1);
      assert.equal(changes[0].operation, 'update');
      assert.deepEqual(changes[0].before, { status: 'open', note: null, version: 0 });
      assert.deepEqual(changes[0].after, { status: 'closed', note: 'done', version: 1 });
    });
  }
});

test("a declared track below the door is raised to it; a command's own track wins over the App's", async () => {
  await fixture({ appTrack: 'audit', commandTrack: 'none' }, async (f) => {
    await f.execute('ui');
    assert.deepEqual(f.kept(), { receipts: 0, changes: [] }, "the command said none, over the App's audit");
    await f.execute('api', request('track-request-000002', { key: { id: 2 } }));
    assert.equal(f.kept().receipts, 1, 'the API keeps a receipt whatever the command says');
  });
});

test("a refusal on the receipts path is this request's own when no receipt exists, and changes nothing", async () => {
  await fixture({}, async (f) => {
    await assert.rejects(f.execute('api', request(undefined, { expectedVersion: 3 })), refusal('stale_record', 'not_applied'));
    assert.deepEqual(f.kept(), { receipts: 0, changes: [] });
    assert.equal(f.calls(), 0);
    // And the corrected request runs.
    assert.equal(((await f.execute('api', request('track-request-000009'))) as { replayed: boolean }).replayed, false);
  });
});

test(
  'PostgreSQL, track receipts: two deliveries of one request at once apply once, and both are told so',
  { skip: !process.env.TABLEWALK_TEST_PG, timeout: 120_000 },
  async () => {
    const { pgClient, uuidPostgresDatabase } = await import('./support/tenantDialects.js');
    const { migratePostgresCommandJournal } = await import('../packages/mistri/src/adapters/commands/postgresCommandJournal.js');
    const database = await uuidPostgresDatabase('speed_track');
    const control = await pgClient(database.url);
    const registry = new Registry();
    try {
      await control.query(`CREATE TABLE ticket (id integer PRIMARY KEY, version integer NOT NULL, status text NOT NULL, note text);
      CREATE TABLE ticket_log (id serial PRIMARY KEY, ticket_id integer NOT NULL, note text NOT NULL);
      INSERT INTO ticket VALUES (1, 0, 'open', NULL)`);
      await migratePostgresCommandJournal(database.url);
      registry.add({ id: 'desk-db', name: 'desk', url: database.url, writable: true, source: 'config' });
      const app = parseTestApp(
        {
          id: 'desk',
          name: 'Desk',
          sources: { desk: { connection: 'desk-db' } },
          resources: { ticket: { access: 'write' }, ticket_log: { access: 'write' } },
          auth: { roles: { clerk: { read: true, commands: ['log'] } } },
          views: { tickets: { kind: 'list', from: 'ticket' } },
          home: 'tickets',
        },
        'race fixture',
      );
      let calls = 0;
      // The target stays unchanged, so both deliveries reach the receipt: its unique index decides.
      const commands = defineCommands({
        log: defineCommand({
          source: 'desk',
          target: 'ticket',
          write: ['ticket_log'],
          input: { note: { label: 'Note', type: 'text' } },
          output: { parse: (value: unknown) => value as { logged: boolean } },
          async handle({ db: tx }, input) {
            calls++;
            await tx.ticket_log.insert({ ticket_id: 1, note: String((input as { note: string }).note) });
            await new Promise((resolve) => setTimeout(resolve, 150));
            return { logged: true };
          },
        }),
      });
      /* Two registries, as two server processes would be: each its own pool
       and write queue, so the deliveries really do run at once. */
      const second = new Registry();
      second.add({ id: 'desk-db', name: 'desk', url: database.url, writable: true, source: 'config' });
      const bind = async (each: Registry) =>
        bindBusinessCommands({
          app,
          resources: await loadAppRuntimeResources(each, app, 'desk-db'),
          registry: commands,
          writableConnection: () => true,
        });
      const bindings = [await bind(registry), await bind(second)];
      const body = {
        command: 'log',
        commandVersion: 1,
        key: { id: 1 },
        expectedVersion: 0,
        input: { note: 'once' },
        idempotencyKey: 'race-request-000001',
      };
      const answers = (await Promise.all(bindings.map((binding) => executeBusinessCommand(binding, actor, body, { door: 'api' }))).finally(
        () => second.closeAll(),
      )) as Array<{ receiptId: string; replayed: boolean }>;
      assert.deepEqual(answers.map((answer) => answer.replayed).sort(), [false, true]);
      assert.equal(answers[0].receiptId, answers[1].receiptId, 'both are told the one receipt');
      assert.equal(Number((await control.query('SELECT count(*) AS n FROM ticket_log')).rows[0].n), 1, 'applied once');
      assert.ok(calls <= 2, 'a delivery racing its original may run, and is rolled back');
    } finally {
      await registry.closeAll();
      await control.end();
      await database.drop();
    }
  },
);

test('the App the browser is served marks an action whose command keeps nothing, so its form checks the record', async () => {
  const { visibleBusinessCommandActions } = await import('../packages/mistri/src/server/commands/businessCommandLoader.js');
  const shaped = (track?: 'receipts') =>
    parseTestApp(
      {
        id: 'desk',
        name: 'Desk',
        ...(track ? { track } : {}),
        sources: { desk: { connection: 'desk-db' } },
        resources: {
          ticket: {
            access: 'write',
            actions: { close: { label: 'Close', command: { id: 'close', version: 1, target: 'ticket', input: {} } } },
          },
        },
        auth: { roles: { clerk: { read: true, commands: ['close'] } } },
        views: { tickets: { kind: 'list', from: 'ticket' } },
        home: 'tickets',
      },
      'payload fixture',
    );
  const commands = defineCommands({ close: defineCommand({ source: 'desk', target: 'ticket', input: {}, handle: async () => undefined }) });
  const schema = {
    label: 'desk',
    dialect: 'sqlite' as const,
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'ticket',
        name: 'ticket',
        schema: 'main',
        isView: false,
        columns: [
          { name: 'id', type: 'INTEGER', primaryKey: true, nullable: false },
          { name: 'version', type: 'INTEGER', primaryKey: false, nullable: false },
        ],
      },
    ],
  };
  const actionOf = (app: ReturnType<typeof shaped>) =>
    visibleBusinessCommandActions(app, commands, schema, ['clerk']).resources!.ticket.actions![0] as { untracked?: true };
  assert.equal(actionOf(shaped()).untracked, true);
  assert.equal(actionOf(shaped('receipts')).untracked, undefined, 'an App that keeps receipts offers recovery');
});
