/**
 * An input asked only while the record says so: `when` on a
 * field, a condition over the target in the query language. What the
 * declaration accepts, which commands may carry it, what prepare tells the
 * form, and what execution refuses — the server, not the form, is the bound.
 * Also a richText field's mention groups narrowed `through` a membership
 * table (G113), as the declaration reads it.
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
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { catalogOf } from './support/commandCatalog.js';
import type { WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineSource, type CommandCatalog } from '../packages/mistri/src/server/commands/commandDb.js';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import { readPreparedRecord } from '../packages/mistri/src/server/commands/commandPrepare.js';
import { preparesInitial } from '../packages/mistri/src/server/commands/commandPrepareNeeds.js';
import { bool } from '../packages/mistri/src/server/commands/commandShapes.js';
import { parseCommandInput } from '../packages/mistri/src/shared/commandInputParse.js';
import { readCommandInput } from '../packages/mistri/src/shared/commandInput.js';

const agent: Identity = { id: 'account-agent', who: 'agent@example.test', role: 'agent' };
const source = defineSource<{ ticket: { id: number; version: number; state: string; note: string | null } }>('desk');
const base = { source, target: 'ticket' as const, output: bool(), handle: () => true };

test('a field asked when the record says so is a single top-level field of a one-record, signed-in command', () => {
  const [reason] = parseCommandInput({ reason: field.text({ when: "record.state = 'closed'" }) }, 'input');
  assert.equal(reason.type !== 'group' && reason.when, "record.state = 'closed'");
  const refused = (input: Record<string, unknown>, options = {}, pattern: RegExp = /./) =>
    assert.throws(() => parseCommandInput(input, 'input', options), pattern);
  refused({ reason: { type: 'text', when: '' } }, {}, /is a condition over the draft/);
  refused({ reason: { type: 'text', when: 3 } });
  refused({ lines: { type: 'group', fields: { qty: { type: 'number' } }, when: "record.state = 'open'" } }, {}, /a group is asked whole/);
  refused({ lines: { type: 'group', fields: { qty: { type: 'number', when: "record.state = 'open'" } } } }, {}, /not one inside a group/);
  refused({ reason: { type: 'text', when: "record.state = 'open'" } }, { publicForm: true }, /a public form has no record/);

  assert.throws(
    () => defineCommand({ ...base, targets: 'none', input: { reason: field.text({ when: "record.state = 'closed'" }) } }),
    /targets one record/,
  );
  assert.throws(
    () => defineCommand({ ...base, targets: 'many', input: { reason: field.text({ when: "record.state = 'closed'" }) } }),
    /targets one record/,
  );
  assert.ok(defineCommand({ ...base, input: { reason: field.text({ when: "record.state = 'closed'" }) } }));
});

test('a field with when is not required by the shape alone: the record decides', () => {
  const fields = parseCommandInput(
    { reason: field.text({ when: "record.state = 'closed'" }), agreed: field.bool({ accept: true, when: "record.state = 'closed'" }) },
    'input',
  );
  assert.deepEqual(readCommandInput(fields, {}), {});
  assert.deepEqual(readCommandInput(fields, { reason: 'Customer asked' }), { reason: 'Customer asked' });
});

test('mention groups may be narrowed through a membership table, named as a resource', () => {
  const [body] = parseCommandInput(
    { body: field.richText({ mentions: { from: 'person', by: 'name', groups: { from: 'team', by: 'name', through: 'team_member' } } }) },
    'input',
  );
  assert.equal(body.type === 'richText' && body.mentions?.groups?.through, 'team_member');
  assert.throws(() =>
    parseCommandInput(
      { body: { type: 'richText', mentions: { from: 'person', by: 'name', groups: { from: 'team', by: 'name', through: 7 } } } },
      'input',
    ),
  );
});

const catalog: CommandCatalog = {
  ticket: {
    name: 'ticket',
    key: ['id'],
    kinds: { id: 'number', version: 'number', state: 'text', note: 'text' },
    meta: {
      id: 'ticket',
      name: 'ticket',
      schema: '',
      isView: false,
      columns: ['id', 'version', 'state', 'note'].map((name) => ({
        name,
        type: name === 'id' || name === 'version' ? 'INTEGER' : 'TEXT',
        nullable: true,
        primaryKey: name === 'id',
      })),
    },
  },
};

test('prepare names the fields the record does not ask, and starts none of them', async () => {
  const close = defineCommand({
    ...base,
    input: {
      reason: field.text({ when: "record.state = 'closed'", default: { record: 'note' } }),
      note: field.text({ optional: true }),
    },
  });
  assert.equal(preparesInitial(close), true);
  let state = 'open';
  const counted: unknown[] = [];
  const reader = {
    query: async () => ({ rows: [{ id: 4, version: 2, state, note: 'Duplicate' }] }),
    count: async (_table: string, filter: unknown) => {
      counted.push(filter);
      return JSON.stringify(filter).includes(`"value":"${state}"`) ? 1 : 0;
    },
  } as unknown as WriteTransaction;
  const prepare = () =>
    readPreparedRecord(reader, {
      command: close,
      commandId: 'close',
      actor: { id: 'account', appId: 'desk', roles: ['agent'] },
      key: { id: 4 },
      catalog,
    });
  const open = await prepare();
  assert.deepEqual(open.withheld, ['reason']);
  assert.equal(open.initial, undefined, 'a withheld field is not started from the record');
  assert.equal(counted.length, 1, 'the condition is read with the key, once');
  state = 'closed';
  const closed = await prepare();
  assert.equal(closed.withheld, undefined);
  assert.deepEqual(closed.initial, { reason: 'Duplicate' });
});

test('the run refuses an input the record does not ask, and asks for one it does, through a rollup too', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-input-when-'));
  const file = join(directory, 'shop.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE job (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', note TEXT);
    CREATE TABLE part (id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES job(id), status TEXT NOT NULL DEFAULT 'pending');
    INSERT INTO job (id, title) VALUES (1, 'Kitchen'), (2, 'Porch');
    INSERT INTO part (id, job_id) VALUES (1, 1);`);
  migrateSqliteCommandJournal(file);
  clearJournal('shop-db');
  const connections = new Registry();
  connections.add({ id: 'shop-db', name: 'Shop', url: file, writable: true, source: 'config' });
  const manifest = parseAppConfig(
    {
      id: 'shop',
      name: 'Shop',
      sources: { shop: { connection: 'shop-db', default: true } },
      resources: {
        job: {
          access: 'write',
          rollups: { open_parts: { fn: 'count', from: 'part', query: 'status = pending' } },
          actions: { finish: { label: 'Finish', command: 'finish' } },
        },
        part: { access: 'write' },
      },
      auth: { providers: ['email'], roles: { agent: { read: true, commands: ['finish'] } } },
      views: { jobs: { kind: 'list', from: 'job' } },
      home: 'jobs',
      nav: ['jobs'],
    },
    'input when',
    { commands: catalogOf({ finish: { target: 'job' } }) },
  );
  const pages = parsePagesConfig({ pages: [] }, 'input when pages');
  const host: AppHost = {
    app: { app: manifest, path: '/private/shop/app.ts', pages, sources: {} },
    pages,
    auth: { spec: manifest.auth!, store: '/private/shop/auth.db', close() {}, handler: async () => {}, session: async () => agent },
  };
  const finish = defineCommand({
    source: 'shop',
    target: 'job',
    read: ['part'],
    // Finishing over a part still on order says why.
    input: { reason: field.text({ when: 'record.open_parts > 0' }) },
    async handle({ db, record }, input: { reason?: string }) {
      await db.job.update(record, { status: 'done', note: input.reason ?? null });
    },
  } as Parameters<typeof defineCommand>[0]);
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({
    registry: connections,
    bound,
    apps: [host],
    pages,
    commands: { appId: 'shop', registry: defineCommands({ finish }) },
  });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  const post = async (path: string, body: object) => {
    const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', 'x-mistri-account': agent.id },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  let requests = 0;
  const run = async (id: number, input: object) => {
    const prepared = await post('/api/commands/prepare', { command: 'finish', commandVersion: 1, key: { id } });
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    const sent = await post('/api/commands/execute', {
      command: 'finish',
      commandVersion: 1,
      key: { id },
      expectedVersion: prepared.body.expectedVersion,
      idempotencyKey: `input-when-request-${String(++requests).padStart(4, '0')}`,
      input,
    });
    return { prepared: prepared.body, sent };
  };
  const job = (id: number) => ({
    ...(db.prepare('SELECT status, note FROM job WHERE id = ?').get(id) as { status: string; note: string | null }),
  });
  try {
    const asked = await run(1, {});
    assert.equal(asked.prepared.withheld, undefined, 'job 1 waits on a part: the reason is asked');
    assert.equal(asked.sent.status, 400, JSON.stringify(asked.sent.body));
    assert.equal(asked.sent.body.field, 'reason');
    const unasked = await run(2, { reason: 'Because' });
    assert.deepEqual(unasked.prepared.withheld, ['reason']);
    assert.equal(unasked.sent.status, 400, JSON.stringify(unasked.sent.body));
    assert.equal(unasked.sent.body.field, 'reason');
    assert.deepEqual(job(2), { status: 'open', note: null });
    assert.equal((await run(2, {})).sent.status, 200);
    assert.equal((await run(1, { reason: 'Part on back order' })).sent.status, 200);
    assert.deepEqual(
      [job(1), job(2)],
      [
        { status: 'done', note: 'Part on back order' },
        { status: 'done', note: null },
      ],
    );
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    db.close();
    await connections.closeAll();
    clearJournal();
    rmSync(directory, { recursive: true, force: true });
  }
});
