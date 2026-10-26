/**
 * A column that holds no zone (Postgres `timestamp`, MySQL `DATETIME`, SQLite's
 * text datetimes) holds the wall clock of the App's `ui.timezone`, UTC when the
 * App names none. An action's `now`, a machine's `since`, a `Date` a command
 * writes and a New form's `now` all say the same digits for one moment; a
 * column with a zone is told the instant itself and is not moved.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import type { UpdateRequest } from '../packages/engine/src/adapters/adapter.js';
import { authorizeTransaction } from '../packages/mistri/src/server/app/appAccess.js';
import { compileAppStamps, nowStamp, stampUpdate } from '../packages/mistri/src/server/app/appStamps.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { wallClockText, withWallClock } from '../packages/mistri/src/server/app/wallClock.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { createTestClock } from '../packages/mistri/src/server/testing/index.js';
import { clockDefault } from '../packages/kit/src/client/components/newRecordModel.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { servedUi } from '../packages/mistri/src/shared/appPayload.js';
import type { ColumnMeta } from '../packages/engine/src/shared/schema.js';
import { catalogOf } from './support/commandCatalog.js';

/* 03:04:05 UTC in July is 23:04:05 the evening before in New York (EDT), and in January 22:04:05 (EST). */
const SUMMER = '2026-07-15T03:04:05.000Z';
const WINTER = '2026-01-15T03:04:05.000Z';
const NEW_YORK = 'America/New_York';

const TABLES = `CREATE TABLE ticket (id INTEGER PRIMARY KEY, title TEXT, status TEXT NOT NULL DEFAULT 'open',
  moved_at TIMESTAMP, opened_at DATETIME, resolved_at TIMESTAMP, seen_at TIMESTAMPTZ, version INTEGER NOT NULL DEFAULT 0);
  INSERT INTO ticket (id, title) VALUES (1, 'Printer jam');`;

function app(timezone?: string) {
  return parseAppConfig(
    {
      id: 'desk',
      name: 'Desk',
      ...(timezone ? { ui: { timezone } } : {}),
      sources: { desk: { connection: 'desk-db', default: true } },
      resources: {
        ticket: {
          access: 'write',
          machine: {
            column: 'status',
            since: 'moved_at',
            states: { open: { on: { start: 'working' } }, working: { final: true } },
          },
          actions: { resolve: { label: 'Resolve', set: { resolved_at: { auto: 'now' } }, when: 'status = open' } },
        },
      },
      auth: { providers: ['email'], roles: { agent: { read: true, commands: ['advance'] } } },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      home: 'tickets',
      nav: ['tickets'],
    },
    'wall clock app',
    { commands: catalogOf({ advance: { target: 'ticket' } }) },
  );
}

async function world(t: TestContext, timezone?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-wall-clock-'));
  const file = join(directory, 'desk.db');
  const db = new DatabaseSync(file);
  db.exec(TABLES);
  db.close();
  migrateSqliteCommandJournal(file);
  clearJournal('desk-db');
  const registry = new Registry();
  registry.add({ id: 'desk-db', name: 'Desk', url: file, writable: true, source: 'config' });
  const check = new DatabaseSync(file, { readOnly: true });
  t.after(async () => {
    check.close();
    await registry.closeAll();
    clearJournal();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    file,
    registry,
    app: app(timezone),
    row: () => ({ ...check.prepare('SELECT moved_at, opened_at, resolved_at FROM ticket WHERE id = 1').get() }),
  };
}

/** A command that moves the ticket and writes the clock's `Date` into a DATETIME column, as a handler would. */
async function advance(t: TestContext, timezone: string | undefined, at: string) {
  const w = await world(t, timezone);
  const clock = createTestClock(at);
  const commands = defineCommands({
    advance: defineCommand({
      source: 'desk',
      target: 'ticket',
      async handle({ db: tables, record, now: moment }) {
        await tables.ticket.update(record, { status: 'working', opened_at: moment() as unknown as string });
      },
    }),
  });
  const resources = await loadAppRuntimeResources(w.registry, w.app, 'desk-db');
  const binding = bindBusinessCommands({ app: w.app, registry: commands, resources, writableConnection: () => true });
  await executeBusinessCommand(
    binding,
    { id: 'account-agent', appId: 'desk', roles: ['agent'] },
    { command: 'advance', commandVersion: 1, key: { id: 1 }, expectedVersion: 0, idempotencyKey: 'wall-clock-advance-0001', input: {} },
    { now: clock.date },
  );
  return w.row();
}

test('a command that moves a machine and writes a Date leaves the App zone wall clock in both columns', async (t) => {
  const row = await advance(t, NEW_YORK, SUMMER);
  assert.equal(row.moved_at, '2026-07-14 23:04:05', "the machine's since");
  assert.equal(row.opened_at, '2026-07-14 23:04:05', "the handler's Date");
  const winter = await advance(t, NEW_YORK, WINTER);
  assert.equal(winter.moved_at, '2026-01-14 22:04:05');
  assert.equal(winter.opened_at, '2026-01-14 22:04:05');
});

test('an App that names no zone writes UTC digits everywhere', async (t) => {
  const row = await advance(t, undefined, SUMMER);
  assert.equal(row.moved_at, '2026-07-15 03:04:05');
  assert.equal(row.opened_at, '2026-07-15 03:04:05');
});

test("an action's now and a machine's since write the same digits as the command, and a form starts on them", async (t) => {
  for (const [timezone, expected] of [
    [NEW_YORK, '2026-07-14 23:04:05'],
    [undefined, '2026-07-15 03:04:05'],
  ] as const) {
    const w = await world(t, timezone);
    const adapter = new SqliteAdapter(w.file, 'desk');
    t.after(() => adapter.close());
    const schema = await adapter.introspect();
    const stamps = compileAppStamps(schema, w.app)!;
    const moment = new Date(SUMMER);
    const update = (request: UpdateRequest) =>
      adapter.transaction!((tx) =>
        authorizeTransaction(
          schema,
          {
            readable: new Set(['ticket']),
            writable: new Set(['ticket']),
            stamp: (r: UpdateRequest) => stampUpdate(stamps, r, { now: moment }),
          },
          tx,
        ).update(request),
      );
    await update({ table: 'ticket', key: { id: 1 }, values: { resolved_at: 'now' } });
    assert.equal(w.row().resolved_at, expected, `${timezone ?? 'no zone'}: an action's now`);

    const column = schema.tables.find((table) => table.id === 'ticket')!.columns.find((c) => c.name === 'moved_at') as ColumnMeta;
    assert.equal(nowStamp(column, moment, timezone), expected, 'a machine since stamped outside a command');

    /* The form's default is minutes, read from the zone the server serves: the same wall clock. */
    const clockZone = servedUi(w.app.ui).clockZone;
    assert.equal(clockDefault('now', column, moment, clockZone), expected.slice(0, 16));
  }
});

test('a column with a zone is not moved: its stamp stays the UTC instant and a Date stays a Date', async (t) => {
  const w = await world(t, NEW_YORK);
  const adapter = new SqliteAdapter(w.file, 'desk');
  t.after(() => adapter.close());
  const schema = await adapter.introspect();
  const columns = schema.tables.find((table) => table.id === 'ticket')!.columns;
  const zoned = columns.find((c) => c.name === 'seen_at') as ColumnMeta;
  assert.equal(nowStamp(zoned, new Date(SUMMER), NEW_YORK), '2026-07-15T03:04:05Z');
  const moment = new Date(SUMMER);
  const bound = withWallClock(columns, { seen_at: moment, opened_at: moment, title: 'x' }, NEW_YORK);
  assert.equal(bound.seen_at, moment);
  assert.equal(bound.opened_at, '2026-07-14 23:04:05');
  assert.equal(bound.title, 'x');
});

test('wall clock text keeps milliseconds only where the moment has them, and reads DST correctly', () => {
  assert.equal(wallClockText(new Date('2026-03-08T06:59:59.000Z'), NEW_YORK), '2026-03-08 01:59:59');
  assert.equal(wallClockText(new Date('2026-03-08T07:00:00.000Z'), NEW_YORK), '2026-03-08 03:00:00', 'the spring-forward hour is skipped');
  assert.equal(wallClockText(new Date('2026-07-15T03:04:05.678Z')), '2026-07-15 03:04:05.678');
  assert.equal(wallClockText(new Date('2026-07-15T03:04:05.678Z'), 'Asia/Kolkata'), '2026-07-15 08:34:05.678');
  assert.equal(wallClockText(new Date('2026-12-31T23:30:00.000Z'), 'Pacific/Auckland'), '2027-01-01 12:30:00');
});
