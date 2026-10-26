/**
 * Questions defined in rows, as a command asks them (`field.defined`): a catalog item's own questions and those every item has, served by
 * prepare for the form to draw, and judged again where the command runs —
 * a required one left empty, a choice outside the list, a key no question
 * asks — before the handler sees one object of answers. A signed-in form
 * that names no record asks every row. Through the real HTTP routes of a
 * single App.
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
import { appCommandCatalog } from '../packages/mistri/src/server/commands/commandContracts.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import { bool } from '../packages/mistri/src/server/commands/commandShapes.js';

test('a command asks the questions its rows define, and is held to them where it runs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-defined-input-'));
  const file = join(directory, 'catalog.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE catalog_item (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE item_variable (id INTEGER PRIMARY KEY, item_id INTEGER, key TEXT NOT NULL, label TEXT NOT NULL, type TEXT NOT NULL,
      options TEXT, required INTEGER NOT NULL DEFAULT 0, position INTEGER);
    CREATE TABLE survey_question (id INTEGER PRIMARY KEY, key TEXT NOT NULL, label TEXT NOT NULL, type TEXT NOT NULL);
    CREATE TABLE requested_item (id INTEGER PRIMARY KEY, item_id INTEGER, answers TEXT, note TEXT);
    INSERT INTO catalog_item VALUES (1, 'Laptop'), (2, 'Desk phone');
    INSERT INTO item_variable VALUES
      (1, 1, 'os', 'Operating system', 'choice', 'macOS' || char(10) || 'Windows', 1, 1),
      (2, 1, 'memory', 'Memory (GB)', 'number', NULL, 0, 2),
      (3, NULL, 'cost_center', 'Cost center', 'text', NULL, 0, 3),
      (4, 2, 'extension', 'Extension', 'text', NULL, 1, 1);
    INSERT INTO survey_question VALUES (1, 'mood', 'How are you?', 'text');`);
  migrateSqliteCommandJournal(file);
  clearJournal('catalog-db');
  const connections = new Registry();
  connections.add({ id: 'catalog-db', name: 'Catalog', url: file, writable: true, source: 'config' });
  const registry = defineCommands({
    // Order one item: its questions are the item's rows, and those every item has.
    orderItem: defineCommand({
      source: 'catalog',
      target: 'catalog_item',
      read: ['item_variable'],
      write: ['requested_item'],
      input: {
        answers: field.defined('item_variable', { whose: 'item_id' }),
        note: field.text({ optional: true }),
      },
      output: bool(),
      async handle({ db: records, record }, input) {
        await records.requested_item.insert({ item_id: record.id, answers: JSON.stringify(input.answers), note: input.note ?? null });
        return true;
      },
    }),
    // A survey, asked of nobody's record: every question row.
    answerSurvey: defineCommand({
      source: 'catalog',
      target: 'requested_item',
      targets: 'none',
      read: ['survey_question'],
      input: { survey: field.defined('survey_question') },
      output: bool(),
      async handle({ db: records }, input) {
        await records.requested_item.insert({ answers: JSON.stringify(input.survey) });
        return true;
      },
    }),
  });
  const manifest = parseAppConfig(
    {
      id: 'catalog',
      name: 'Catalog',
      sources: { catalog: { connection: 'catalog-db', default: true } },
      resources: {
        catalog_item: { access: 'write', actions: { orderItem: { label: 'Order', command: 'orderItem' } } },
        item_variable: {},
        survey_question: {},
        requested_item: { access: 'write' },
      },
      auth: { providers: ['email'], roles: { employee: { read: true, commands: ['orderItem', 'answerSurvey'] } } },
      views: {
        items: { kind: 'list', from: 'catalog_item' },
        survey: { kind: 'form', label: 'Survey', command: 'answerSurvey' },
      },
      home: 'items',
      nav: ['items', 'survey'],
    },
    'defined inputs',
    { commands: appCommandCatalog(registry, { sources: { catalog: { connection: 'catalog-db', default: true } } }) },
  );
  const pages = parsePagesConfig({ pages: [] }, 'defined pages');
  const who: Identity = { id: 'account-employee', who: 'employee@example.test', role: 'employee' };
  const host: AppHost = {
    app: { app: manifest, path: '/private/catalog/app.ts', pages, sources: {} },
    pages,
    auth: { spec: manifest.auth!, store: '/private/catalog/auth.db', close() {}, handler: async () => {}, session: async () => who },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry: connections, bound, apps: [host], pages, commands: { appId: 'catalog', registry } });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  const call = async (path: string, body: object) => {
    const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', 'x-mistri-account': who.id },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  let requests = 0;
  const execute = (command: string, key: object, expectedVersion: number, input: object) =>
    call('/api/commands/execute', {
      command,
      commandVersion: 1,
      key,
      expectedVersion,
      idempotencyKey: `defined-request-${String(++requests).padStart(4, '0')}`,
      input,
    });
  try {
    const laptop = await call('/api/commands/prepare', { command: 'orderItem', commandVersion: 1, key: { id: 1 } });
    assert.equal(laptop.status, 200, JSON.stringify(laptop.body));
    // The laptop's own questions, in their order, then the one every item has; never the phone's.
    assert.deepEqual(laptop.body.defined, {
      answers: [
        { key: 'os', label: 'Operating system', type: 'choice', options: ['macOS', 'Windows'], required: true },
        { key: 'memory', label: 'Memory (GB)', type: 'number', options: [], required: false },
        { key: 'cost_center', label: 'Cost center', type: 'text', options: [], required: false },
      ],
    });
    const version = laptop.body.expectedVersion as number;
    const refused = async (answers: object, path: string) => {
      const sent = await execute('orderItem', { id: 1 }, version, { answers });
      assert.equal(sent.status, 400, JSON.stringify(sent.body));
      assert.equal(sent.body.field, path, JSON.stringify(sent.body));
    };
    await refused({ memory: 16 }, 'answers.os');
    await refused({ os: 'Linux' }, 'answers.os');
    await refused({ os: 'macOS', memory: 'lots' }, 'answers.memory');
    // The phone's question is not the laptop's to answer.
    await refused({ os: 'macOS', extension: '204' }, 'answers.extension');
    assert.equal(db.prepare('SELECT count(*) AS n FROM requested_item').get()!.n, 0);

    const sent = await execute('orderItem', { id: 1 }, version, { answers: { os: 'macOS', memory: 16, cost_center: ' ' } });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.deepEqual(JSON.parse(String(db.prepare('SELECT answers FROM requested_item WHERE item_id = 1').get()!.answers)), {
      os: 'macOS',
      memory: 16,
    });

    // A form that names no record prepares every question row, and sends its answers with an empty key.
    const survey = await call('/api/commands/prepare', { command: 'answerSurvey', commandVersion: 1, key: {} });
    assert.deepEqual(survey.body, {
      expectedVersion: 0,
      defined: { survey: [{ key: 'mood', label: 'How are you?', type: 'text', options: [], required: false }] },
    });
    assert.equal((await execute('answerSurvey', {}, 0, { survey: { mood: 'Fine' } })).status, 200);
    assert.equal((await execute('answerSurvey', {}, 0, { survey: { weather: 'Rain' } })).body.field, 'survey.weather');
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

test('questions defined in rows are read as the reader reads, by one record, and never on a public form', () => {
  const base = { source: 'catalog', target: 'catalog_item', output: bool(), handle: async () => true };
  assert.throws(
    () => defineCommand({ ...base, input: { answers: field.defined('item_variable') } }),
    /asks the questions in "item_variable"; declare it among the command's read, not elevated/,
  );
  assert.throws(
    () =>
      defineCommand({
        ...base,
        read: ['item_variable', 'person'],
        elevate: { read: ['item_variable'] },
        input: { answers: field.defined('item_variable') },
      }),
    /not elevated/,
  );
  assert.throws(
    () =>
      defineCommand({
        ...base,
        targets: 'many',
        read: ['item_variable'],
        input: { answers: field.defined('item_variable', { whose: 'item_id' }) },
      }),
    /only a command that targets one record has/,
  );
  assert.throws(
    () => defineCommand({ ...base, public: true, read: ['item_variable'], input: { answers: field.defined('item_variable') } }),
    /a public form may not read them/,
  );
  assert.throws(
    () => defineCommand({ ...base, read: ['item_variable'], input: { rows: field.group({ answers: field.defined('item_variable') }) } }),
    /not one inside a group/,
  );
});
