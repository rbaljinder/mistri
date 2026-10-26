import assert from 'node:assert/strict';
import { computed, me, now, today } from '@mistriwork/mistri/app';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Refusal, type UpdateRequest } from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { authorizeTransaction } from '../packages/mistri/src/server/app/appAccess.js';
import { personKey } from '../packages/mistri/src/server/app/appMe.js';
import { compileAppStamps, signedInAs, stampUpdate } from '../packages/mistri/src/server/app/appStamps.js';
import { AppTransitionDenied, compileAppTransitions } from '../packages/mistri/src/server/app/appTransitions.js';
import { parseAppConfig, resolveResources, type AppDef } from '../packages/mistri/src/shared/app.js';
import { parseMachine } from '../packages/mistri/src/shared/appMachine.js';
import { calendarDay, stampColumn } from '../packages/mistri/src/shared/appStamps.js';
import type { ColumnMeta } from '../packages/engine/src/shared/schema.js';

/* Resolve stamps the moment and the person; the stamp columns move only through it. */
const resource = (actions: unknown[], extra: Record<string, unknown> = {}) => ({ task: { access: 'write', actions, ...extra } });
const RESOLVE = {
  id: 'resolve',
  label: 'Resolve',
  set: { state: 'resolved', resolved_at: 'now', resolved_on: 'now', resolved_by: 'me' },
  when: 'state = open',
};
const APP = {
  id: 'stamps',
  name: 'Stamps',
  ui: { timezone: 'America/Los_Angeles' },
  views: {},
  resources: resource([RESOLVE], {
    machine: parseMachine(
      {
        column: 'state',
        states: {
          open: { on: { resolve: { to: 'resolved', set: { resolved_at: now, resolved_on: now, resolved_by: me } } } },
          resolved: { final: true },
        },
      },
      'stamp machine',
      () => false,
    ),
  }),
} as unknown as AppDef;

/* 02:30 UTC on 8 September is still the 7th in Los Angeles. */
const NOW = new Date('2026-09-08T02:30:00Z');

async function catalog(t: import('node:test').TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-app-stamps-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'stamps.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE person (id INTEGER PRIMARY KEY, email TEXT);
    CREATE TABLE task (id INTEGER PRIMARY KEY, name TEXT, state TEXT DEFAULT 'open', note TEXT, count INTEGER, blob_id TEXT,
      resolved_at TIMESTAMP, resolved_zoned TIMESTAMPTZ, resolved_on DATE, resolved_time TIME, opened_text TEXT,
      resolved_by TEXT, owner_id INTEGER REFERENCES person(id), token UUID, closed_at TEXT);
    INSERT INTO task (name) VALUES ('first');
    INSERT INTO person (id, email) VALUES (7, 'ada@example.test');`);
  db.close();
  const adapter = new SqliteAdapter(file, 'stamps');
  t.after(() => adapter.close());
  const check = new DatabaseSync(file);
  t.after(() => check.close());
  return { adapter, schema: await adapter.introspect(), check };
}

test("Resolve writes the moment and the person, in each column's own kind, inside the write", async (t) => {
  const { adapter, schema, check } = await catalog(t);
  const stamps = compileAppStamps(schema, APP)!;
  const transitions = compileAppTransitions(schema, APP);
  const as = (who?: string) => ({
    readable: new Set(['task']),
    writable: new Set(['task']),
    transitions,
    stamp: (request: UpdateRequest) => stampUpdate(stamps, request, { now: NOW, ...(who ? { who } : {}) }),
  });
  const update = (values: Record<string, string | null>, who?: string) =>
    adapter.transaction!((tx) => authorizeTransaction(schema, as(who), tx).update({ table: 'task', key: { id: 1 }, values }));
  const row = () => ({ ...check.prepare('SELECT state, resolved_at, resolved_on, resolved_by FROM task WHERE id = 1').get() });

  // Nobody signed in has no 'me' to write, and nothing is written.
  await assert.rejects(
    () => update(RESOLVE.set),
    (error) => error instanceof Refusal && /no proven account is signed in/.test(error.message),
  );
  // A person or a moment the caller chose is no action's: the stamp columns move only through Resolve.
  await assert.rejects(() => update({ ...RESOLVE.set, resolved_by: 'mallory@example.test' }, 'ada@example.test'), AppTransitionDenied);
  await assert.rejects(() => update({ ...RESOLVE.set, resolved_at: '1999-01-01 00:00:00' }, 'ada@example.test'), AppTransitionDenied);
  assert.deepEqual(row(), { state: 'open', resolved_at: null, resolved_on: null, resolved_by: null });

  const result = await update(RESOLVE.set, 'ada@example.test');
  assert.deepEqual(row(), {
    state: 'resolved',
    // A zone-less column holds the App's wall clock (wallClock.ts): 7:30 pm on the 7th in Los Angeles, beside the day.
    resolved_at: '2026-09-07 19:30:00',
    resolved_on: '2026-09-07',
    resolved_by: 'ada@example.test',
  });
  // What was applied is what was written, never the words.
  assert.equal(result.applied.resolved_by, 'ada@example.test');
});

test("me on a reference to people is the person's row, and now on a text moment its digits, through one path", async (t) => {
  const { adapter, schema, check } = await catalog(t);
  const set = { owner_id: 'me', closed_at: 'now' };
  const app = {
    ...APP,
    auth: { me: { from: 'person', column: 'email' }, roles: { staff: { read: true, write: true } } },
    resources: { ...resource([{ id: 'take', label: 'Take', set }]), person: {} },
  } as unknown as AppDef;
  assert.deepEqual(resolveResources(app, schema).problems, []);
  const stamps = compileAppStamps(schema, app)!;
  const as = (who: string) => ({
    readable: new Set(['task', 'person']),
    writable: new Set(['task']),
    stamp: (request: UpdateRequest, reader: Parameters<typeof personKey>[3]) =>
      stampUpdate(stamps, request, { now: NOW, who, person: () => personKey(app, schema, who, reader) }),
  });
  const take = (who: string) =>
    adapter.transaction!((tx) => authorizeTransaction(schema, as(who), tx).update({ table: 'task', key: { id: 1 }, values: set }));
  // An account that is nobody's row of person has no row to write, and nothing is written.
  await assert.rejects(
    () => take('mallory@example.test'),
    (error) => error instanceof Refusal && /nobody's row/.test(error.message),
  );
  await take('ada@example.test');
  // The App's wall clock (Los Angeles), as a zone-less DATETIME would hold it.
  assert.deepEqual(
    { ...check.prepare('SELECT owner_id, closed_at FROM task WHERE id = 1').get() },
    {
      owner_id: 7,
      closed_at: '2026-09-07 19:30:00',
    },
  );
});

test("a stamp is written in its column's kind, and the day is UTC without a zone", async (t) => {
  const { schema } = await catalog(t);
  const set = { resolved_at: 'now', resolved_zoned: 'now', resolved_on: 'now', resolved_by: 'me' };
  const app = (ui: Record<string, unknown>) =>
    ({ ...APP, ui, resources: resource([{ id: 'stamp', label: 'Stamp', set }]) }) as unknown as AppDef;
  // The same words on a column no action stamps are the literals they always were.
  const request = { table: 'task', key: { id: 1 }, values: { ...set, note: 'now', name: 'me', count: 3 } };
  const moment = { now: NOW, who: 'ada@example.test' };
  const zoned = await stampUpdate(compileAppStamps(schema, app({ timezone: 'America/Los_Angeles' })), request, moment);
  assert.deepEqual(zoned.values, {
    resolved_at: '2026-09-07 19:30:00',
    resolved_zoned: '2026-09-08T02:30:00Z',
    resolved_on: '2026-09-07',
    resolved_by: 'ada@example.test',
    note: 'now',
    name: 'me',
    count: 3,
  });
  // Without ui.timezone a DATE is the UTC day, not the server's own zone's.
  const bare = (await stampUpdate(compileAppStamps(schema, app({})), request, moment)).values;
  assert.equal(bare.resolved_on, '2026-09-08');
  assert.equal(bare.resolved_at, '2026-09-08 02:30:00', 'and a zone-less moment is its UTC digits');
  // A column no action stamps keeps the word as the literal it always was, and the request is not copied.
  const plain = { table: 'task', key: { id: 1 }, values: { name: 'now' } };
  assert.equal(await stampUpdate(compileAppStamps(schema, app({})), plain, moment), plain);
});

test('a stamp a column cannot hold is refused before the App starts', async (t) => {
  const { schema } = await catalog(t);
  const problem = (set: Record<string, unknown>) => {
    const app = { ...APP, resources: resource([{ id: 'stamp', label: 'Stamp', set }]) } as unknown as AppDef;
    const said = resolveResources(app, schema).problems[0];
    assert.throws(
      () => compileAppStamps(schema, app),
      (error: Error) => error.message === said,
    );
    return said;
  };
  assert.match(problem({ note: 'now' }), /"note" is TEXT, and the constant now is written only to a DATE, TIMESTAMP or DATETIME column/);
  assert.match(problem({ opened_text: 'now' }), /opened_text/);
  assert.match(problem({ resolved_time: 'now' }), /TIME, and the constant now/);
  assert.match(problem({ count: 'me' }), /"count" is INTEGER, and the constant me is the signed-in account's email/);
  assert.match(problem({ token: 'me' }), /"token" is UUID/);
  assert.match(
    problem({ owner_id: 'me' }),
    /"owner_id" references \w+, and the constant me is the signed-in person: their row of the table auth.me names, which this App does not name/,
  );
  assert.match(problem({ id: 'now' }), /part of the key/);
});

test("'me' needs sign-in", () => {
  const app = (extra: Record<string, unknown>, set: Record<string, unknown>) =>
    parseAppConfig(
      {
        name: 'Stamps',
        connection: 'stamps',
        resources: { task: { access: 'write', actions: { resolve: { label: 'Resolve', set } } } },
        views: { tasks: { kind: 'list', from: 'task', label: 'Tasks' } },
        home: 'tasks',
        ...extra,
      },
      'stamps.ts',
    );
  assert.throws(() => app({}, { resolved_by: me }), /sets "resolved_by" to me, the signed-in person, and this App has no sign-in/);
  assert.doesNotThrow(() => app({}, { resolved_at: now }));
  assert.doesNotThrow(() => app({ auth: { providers: ['email'], roles: { agent: { read: true, write: true } } } }, { resolved_by: me }));
  // The words are the stamps' own: a literal that spells one would be read as it, so it is refused, never stored.
  assert.throws(
    () => app({}, { note: 'now' }),
    /sets "note", which is the text 'now', which reads as the value filled in: write the constant now/,
  );
  assert.throws(() => app({}, { resolved_at: { auto: 'soon' } }), /this place fills in now \(\{ auto: 'now' \}\), today/);
});

test("a constant expression in a set is worked out as the write runs, in its column's kind", async (t) => {
  const { adapter, schema, check } = await catalog(t);
  const set = {
    state: 'snoozed',
    resolved_on: '=today + 14 days',
    resolved_at: '=now + 1 week',
    resolved_zoned: '=now',
    count: '=3 * 7',
    resolved_by: 'me',
  };
  const app = { ...APP, resources: resource([{ id: 'snooze', label: 'Snooze', set }]) } as unknown as AppDef;
  const stamps = compileAppStamps(schema, app)!;
  const moment = { now: NOW, who: 'ada@example.test' };
  // The App's day (the 7th in Los Angeles) moves by fourteen; the instant by a week.
  assert.deepEqual((await stampUpdate(stamps, { table: 'task', key: { id: 1 }, values: set }, moment)).values, {
    state: 'snoozed',
    resolved_on: '2026-09-21',
    resolved_at: '2026-09-14 19:30:00',
    resolved_zoned: '2026-09-08T02:30:00Z',
    count: 21,
    resolved_by: 'ada@example.test',
  });
  // Two actions may set one column two ways; each word is its own.
  const two = {
    ...APP,
    resources: resource([
      { id: 'soon', label: 'Soon', set: { resolved_on: '=today + 1 day' } },
      { id: 'later', label: 'Later', set: { resolved_on: '=today + 1 month' }, when: 'state = open' },
      { id: 'today', label: 'Today', set: { resolved_on: 'today' } },
    ]),
  } as unknown as AppDef;
  const words = compileAppStamps(schema, two)!;
  const day = async (word: string) =>
    (await stampUpdate(words, { table: 'task', key: { id: 1 }, values: { resolved_on: word } }, moment)).values.resolved_on;
  assert.deepEqual(await Promise.all(['=today + 1 day', '=today + 1 month', 'today'].map(day)), ['2026-09-08', '2026-10-07', '2026-09-07']);
  // Through the write itself: the transaction writes the value, never the word.
  const transitions = compileAppTransitions(schema, app);
  const scope = {
    readable: new Set(['task']),
    writable: new Set(['task']),
    transitions,
    stamp: (request: UpdateRequest) => stampUpdate(stamps, request, moment),
  };
  await adapter.transaction!((tx) => authorizeTransaction(schema, scope, tx).update({ table: 'task', key: { id: 1 }, values: set }));
  assert.deepEqual(
    { ...check.prepare('SELECT resolved_on, count FROM task WHERE id = 1').get() },
    { resolved_on: '2026-09-21', count: 21 },
  );
});

test('a set expression that does not parse, reads a column or misfits its column is refused', async (t) => {
  const { schema } = await catalog(t);
  const problem = (set: Record<string, unknown>) => {
    const app = { ...APP, resources: resource([{ id: 'stamp', label: 'Stamp', set }]) } as unknown as AppDef;
    return resolveResources(app, schema).problems[0] ?? '';
  };
  assert.match(problem({ resolved_on: '=today +' }), /"today \+" is not an expression/);
  assert.match(problem({ resolved_on: '=resolved_on + 7 days' }), /reads "resolved_on"\. A set expression reads no column/);
  assert.match(problem({ resolved_at: '=today + 14 days' }), /is a day, written only to a DATE column \(a moment is said from now/);
  assert.match(problem({ resolved_on: '=now + 1 day' }), /is a moment, written only to a TIMESTAMP or DATETIME column/);
  assert.match(problem({ note: '=3 * 7' }), /is a number, written only to a numeric column/);
  assert.match(problem({ resolved_on: 'today' }), /^$/);
  assert.match(problem({ note: 'today' }), /the constant today is a day, written only to a DATE column/);
  // As authored: computed.date('…'), its kind matching its constructor's; a literal that reads as one is refused.
  const authored = (set: Record<string, unknown>) =>
    parseAppConfig(
      {
        name: 'Stamps',
        connection: 'stamps',
        resources: { task: { access: 'write', actions: { snooze: { label: 'Snooze', set } } } },
        views: { tasks: { kind: 'list', from: 'task', label: 'Tasks' } },
        home: 'tasks',
      },
      'stamps.ts',
    );
  const parsed = authored({ resolved_on: computed.date('today + 14 days'), resolved_at: today });
  assert.deepEqual(parsed.resources!.task.actions![0].set, { resolved_on: '=today + 14 days', resolved_at: 'today' });
  assert.throws(
    () => authored({ count: computed.date('3 * 7') }),
    /computed\.date\('3 \* 7'\), which comes to a number: write computed\.number/,
  );
  assert.throws(() => authored({ count: computed.number('count + 1') }), /reads "count"/);
  assert.throws(() => authored({ note: '=today' }), /the text '=today', which reads as an expression/);
});

test('the stamp words are judged on the column alone', () => {
  const column = (type: string, name = 'c'): ColumnMeta => ({ name, type, nullable: true, primaryKey: false });
  assert.deepEqual(stampColumn('now', column('date'), false), { column: { word: 'now', as: 'date' } });
  assert.deepEqual(stampColumn('now', column('DATETIME'), false), { column: { word: 'now', as: 'instant' } });
  assert.deepEqual(stampColumn('now', column('timestamp without time zone'), false), { column: { word: 'now', as: 'instant' } });
  assert.deepEqual(stampColumn('now', column('timestamp with time zone'), false), { column: { word: 'now', as: 'instant-zoned' } });
  assert.deepEqual(stampColumn('me', column('varchar(255)'), false), { column: { word: 'me' } });
  assert.ok('problem' in stampColumn('me', column('jsonb'), false));
  assert.ok('problem' in stampColumn('me', column('text'), 'account'));
  // A reference to the people table (auth.me) is the person's row, as a form's `me` is.
  assert.deepEqual(stampColumn('me', column('integer'), 'staff', 'staff'), { column: { word: 'me', person: true } });
  // SQLite keeps moments as text: a name ending _at is an instant, _on a day; any other text is refused.
  assert.deepEqual(stampColumn('now', column('TEXT', 'collected_at'), false), { column: { word: 'now', as: 'instant' } });
  assert.deepEqual(stampColumn('now', column('text', 'due_on'), false), { column: { word: 'now', as: 'date' } });
  assert.ok('problem' in stampColumn('now', column('TEXT', 'note'), false));
  assert.ok('problem' in stampColumn('now', column('uuid', 'made_at'), false));
  assert.equal(signedInAs({ id: 'acct_1', who: 'ada@example.test' }), 'ada@example.test');
  assert.equal(signedInAs({ who: 'ada@example.test' }), undefined);
});

test('a calendar day is a DATE by its type alone, so a timer on an instant is never cut at midnight', () => {
  for (const type of ['date', 'DATE', ' date ']) assert.equal(calendarDay(type), true, type);
  for (const type of ['timestamp', 'timestamp with time zone', 'timestamptz', 'datetime', 'time', 'TIMESTAMP', undefined])
    assert.equal(calendarDay(type), false, String(type));
});
