import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { provisionSqlitePreferences } from '../packages/mistri/src/adapters/preferences/sqlitePreferences.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { provisionSqliteAssistant } from '../packages/mistri/src/adapters/assistant/sqliteAssistant.js';
import { setAssistantModel, type ModelRequest } from '../packages/mistri/src/server/assistant/assistantModel.js';
import { scriptedModel, type AssistantScript } from '../packages/mistri/src/server/assistant/assistantScripted.js';

/**
 * The assistant and an App's `choose`: it acts for the person at the desk, so each tool it calls reads under the picks
 * the chat request carries (the shell's `x-mistri-chosen`), else the person's stored pick, exactly as a browser read
 * does. A pick the person's grants cannot read matches no row, and the assistant has no tool that changes a pick.
 * The model is the scripted double: no real model call.
 */
const appId = 'assistant-chosen';
const owner = 'assistant-chosen-db';

after(() => setAssistantModel(undefined));

const people = {
  ann: { id: 'account-ann', who: 'ann@example.test', role: 'rep' },
  // A clerk reads visits but no site: no site is theirs to pick.
  cal: { id: 'account-cal', who: 'cal@example.test', role: 'clerk' },
};

/** Ask the one question the person's words make, and read what the tool answered from the next request to the model. */
const script: AssistantScript = {
  turns: [
    {
      when: 'which visits',
      steps: [{ tools: [{ name: 'query', input: { q: 'visit site_id = chosen.site show note sort id' } }] }, { text: 'Done.' }],
    },
  ],
};

async function fixture(
  run: (f: {
    ask(headers?: Record<string, string>): Promise<string>;
    post(path: string, body: object): Promise<number>;
    as(who: keyof typeof people): void;
    tools(): string[];
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-assistant-chosen-'));
  const file = join(directory, 'fixture.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE person (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT);
    INSERT INTO person VALUES (1, 'Ann', 'ann@example.test'), (2, 'Cal', 'cal@example.test');
    CREATE TABLE site (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO site VALUES (1, 'North'), (2, 'South');
    CREATE TABLE visit (id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, note TEXT NOT NULL);
    INSERT INTO visit VALUES (10, 1, 'north-one'), (11, 2, 'south-one'), (12, 1, 'north-two');`);
  provisionSqliteAssistant(file);
  provisionSqlitePreferences(file);
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = directory;
  const registry = new Registry();
  registry.add({ id: owner, name: 'Assistant', url: file, source: 'config', writable: true });
  const definition = parseAppConfig(
    {
      id: appId,
      name: 'Visits',
      connection: owner,
      resources: { person: {}, site: {}, visit: {} },
      choose: { site: { from: 'site', label: 'name' } },
      auth: {
        me: { from: 'person', column: 'email' },
        roles: { rep: { read: true }, clerk: { read: ['person', 'visit'] } },
      },
      views: { visits: { kind: 'list', from: 'visit', query: 'site_id = chosen.site' } },
      home: 'visits',
      nav: ['visits'],
      assistant: {},
    },
    'assistant choose fixture',
  );
  const requests: ModelRequest[] = [];
  const model = scriptedModel(script);
  setAssistantModel(() => ({
    async stream(request, onText, signal) {
      requests.push(request);
      return model.stream(request, onText, signal);
    },
  }));
  let current: keyof typeof people = 'ann';
  const host: AppHost = {
    app: { path: 'assistant-fixture.ts', app: definition, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: definition.auth!,
      store: 'not-used',
      handler: async () => {},
      close: async () => {},
      session: async () => ({ ...people[current] }),
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages: [] });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const url = (path: string) => `http://${bound.host}:${bound.port}${path}`;
  try {
    await run({
      as: (who) => {
        current = who;
      },
      post: async (path, body) =>
        (
          await fetch(url(path), {
            method: 'POST',
            signal: AbortSignal.timeout(5000),
            headers: { 'Content-Type': 'application/json', origin: url('') },
            body: JSON.stringify({ app: appId, ...body }),
          })
        ).status,
      tools: () => requests[0].tools.map((tool) => tool.name),
      // What the query tool answered: the text of the request the model was sent after it ran.
      ask: async (headers = {}) => {
        requests.length = 0;
        const response = await fetch(url('/api/assistant/turn'), {
          method: 'POST',
          signal: AbortSignal.timeout(10_000),
          headers: { 'Content-Type': 'application/json', origin: url(''), ...headers },
          body: JSON.stringify({ app: appId, text: 'which visits are there' }),
        });
        assert.equal(response.status, 200);
        await response.text();
        assert.ok(requests.length >= 2, 'the model was asked again with the tool result');
        return JSON.stringify(requests[1].messages);
      },
    });
  } finally {
    setAssistantModel(undefined);
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    clearJournal(owner);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('a tool call reads under the pick the chat request carries, read again under the person’s grants', async () => {
  await fixture(async ({ ask, as }) => {
    const north = await ask({ 'x-mistri-chosen': 'site=1' });
    assert.match(north, /north-one/);
    assert.match(north, /north-two/);
    assert.doesNotMatch(north, /south-one/);
    const south = await ask({ 'x-mistri-chosen': 'site=2' });
    assert.match(south, /south-one/);
    assert.doesNotMatch(south, /north-/);
    // A pick that names no row, or one the person's grants cannot read, matches no row; never every row.
    assert.doesNotMatch(await ask({ 'x-mistri-chosen': 'site=99' }), /north-|south-/);
    as('cal');
    assert.doesNotMatch(await ask({ 'x-mistri-chosen': 'site=1' }), /north-|south-/);
  });
});

test('with no header the person’s stored pick is the default, and a header beats it', async () => {
  await fixture(async ({ ask, post }) => {
    // Nothing chosen: the question has no site to mean, so nothing is answered with a visit.
    assert.doesNotMatch(await ask(), /north-|south-/);
    assert.equal(await post('/api/choose', { name: 'site', value: '2' }), 200);
    const stored = await ask();
    assert.match(stored, /south-one/);
    assert.doesNotMatch(stored, /north-/);
    const header = await ask({ 'x-mistri-chosen': 'site=1' });
    assert.match(header, /north-one/);
    assert.doesNotMatch(header, /south-/);
  });
});

test('the assistant has no tool that changes a pick', async () => {
  await fixture(async ({ ask, tools }) => {
    await ask({ 'x-mistri-chosen': 'site=1' });
    // The App's own five, as for every App: choosing stays the person's act in the shell (POST /api/choose).
    assert.deepEqual(tools(), ['find', 'describe', 'query', 'show', 'run']);
  });
});
