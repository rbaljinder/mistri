/**
 * What the assistant's tools answer with, on an ordinary App's host: a record is named by the resource's
 * `recordLabel` on a proposal's card, a record block and a query's rows; a table nobody chose columns for is the
 * list view's, led by that name, without a column that is empty in every row; a figure or chart over nothing is not
 * drawn; a condition follows a reference; the person's message says the day in their zone; and a turn takes the
 * steps the App allows, a refused read not among them, the last one always words.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { provisionSqliteAssistant } from '../packages/mistri/src/adapters/assistant/sqliteAssistant.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { setAssistantModel, type AssistantModel } from '../packages/mistri/src/server/assistant/assistantModel.js';
import { scriptedModel, type AssistantScript } from '../packages/mistri/src/server/assistant/assistantScripted.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseTestApp } from './support/commandCatalog.js';
import { createApp } from './support/createApp.js';

const appId = 'clinic';
after(() => setAssistantModel(undefined));

interface Event {
  event: string;
  data: any;
}
const of = (events: Event[], kind: string) => events.filter((event) => event.event === kind).map((event) => event.data);
const words = (events: Event[]) =>
  of(events, 'text')
    .map((each) => each.delta)
    .join('');

async function fixture(
  script: AssistantScript,
  run: (f: {
    turn(text: string): Promise<Event[]>;
    /** Every request the model was sent, in order. */
    asked: Array<Parameters<AssistantModel['stream']>[0]>;
  }) => Promise<void>,
  assistant: Record<string, unknown> = {},
  ui: Record<string, unknown> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-assistant-answers-'));
  const file = join(directory, 'clinic.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE patient (id INTEGER PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL);
    CREATE TABLE visit (id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patient(id), reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'booked', notes TEXT, fee INTEGER);
    INSERT INTO patient VALUES (1, 'Ada', 'Park'), (2, 'Ben', 'Stone');
    INSERT INTO visit VALUES (1, 1, 'Annual physical', 'booked', NULL, 120), (2, 2, 'Follow-up', 'booked', NULL, 60),
      (3, 1, 'Flu shot', 'done', NULL, 30);`);
  provisionSqliteAssistant(file);
  const registry = new Registry();
  registry.add({ id: 'clinic-db', name: 'Clinic', url: file, writable: true, source: 'config' });
  const app = parseTestApp(
    {
      id: appId,
      name: 'Clinic',
      sources: { clinic: { connection: 'clinic-db', default: true } },
      resources: {
        patient: { recordLabel: '{first_name} {last_name}', rollups: { visits: { fn: 'count', from: 'visit' } } },
        visit: {
          access: 'write',
          recordLabel: '{patient_id.first_name} · {reason}',
          actions: { finish: { label: 'Finish', set: { status: 'done' } } },
        },
      },
      auth: { roles: { nurse: { read: true, write: ['visit'] } } },
      views: {
        visits: { kind: 'list', from: 'visit', show: ['reason', 'status', 'notes'] },
        patients: { kind: 'list', from: 'patient' },
      },
      home: 'visits',
      nav: ['visits', 'patients'],
      ...(Object.keys(ui).length ? { ui } : {}),
      assistant,
    },
    'assistant answers fixture',
  );
  const nurse: Identity = { id: 'account-ada', who: 'ada@example.test', role: 'nurse' };
  const host: AppHost = {
    app: { app, path: join(directory, 'app.ts'), pages: [], sources: {} },
    pages: [],
    auth: { spec: app.auth!, store: join(directory, 'auth.db'), close() {}, handler: async () => {}, session: async () => nurse },
  };
  const asked: Array<Parameters<AssistantModel['stream']>[0]> = [];
  const scripted = scriptedModel(script);
  setAssistantModel(() => ({
    stream(request, onText, signal) {
      asked.push(structuredClone(request));
      return scripted.stream(request, onText, signal);
    },
  }));
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host] });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await run({
      asked,
      async turn(text) {
        const response = await fetch(`http://${bound.host}:${address.port}/api/assistant/turn`, {
          method: 'POST',
          signal: AbortSignal.timeout(10_000),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ app: appId, text }),
        });
        const body = await response.text();
        assert.equal(response.status, 200, body);
        return body
          .split('\n\n')
          .filter(Boolean)
          .map((chunk) => ({ event: /^event: (.*)$/m.exec(chunk)![1], data: JSON.parse(/^data: (.*)$/m.exec(chunk)![1]) }));
      },
    });
  } finally {
    setAssistantModel(undefined);
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    clearJournal('clinic-db');
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

/** What the model was told a tool call answered, by the tool's place in the turn. */
const results = (request: Parameters<AssistantModel['stream']>[0]) =>
  request.messages.flatMap((message) =>
    typeof message.content === 'string'
      ? []
      : message.content.filter((block) => block.type === 'tool_result').map((block) => JSON.parse(String(block.content))),
  );

test("a proposal's card, a record block and a query's rows name a record by the resource's recordLabel", async () => {
  await fixture(
    {
      turns: [
        {
          when: 'finish',
          steps: [
            { tools: [{ name: 'show', input: { kind: 'record', resource: 'visit', id: 1 } }] },
            { tools: [{ name: 'query', input: { q: 'visit status = booked show id, reason sort id' } }] },
            { tools: [{ name: 'run', input: { action: 'visit.finish', id: 1 } }] },
          ],
        },
      ],
    },
    async ({ turn, asked }) => {
      const events = await turn('finish the physical');
      const [block] = of(events, 'block');
      assert.equal(block.block.title, 'Ada · Annual physical');
      const [card] = of(events, 'proposal');
      assert.equal(card.proposal.record, 'Ada · Annual physical');
      // The model is given the names to say: the record's, and each row's beside its columns.
      const told = results(asked.at(-1)!);
      assert.equal(told[0].title, 'Ada · Annual physical');
      assert.deepEqual(
        told[1].rows.map((row: { label: string }) => row.label),
        ['Ada · Annual physical', 'Ben · Follow-up'],
      );
    },
  );
});

test("a table nobody chose columns for is the list view's, led by the record's name, without an all-empty column", async () => {
  await fixture(
    {
      turns: [
        {
          when: 'visits',
          steps: [{ tools: [{ name: 'show', input: { kind: 'table', resource: 'visit', sort: 'id asc' } }] }, { text: 'Here.' }],
        },
      ],
    },
    async ({ turn, asked }) => {
      const events = await turn('show visits');
      const [block] = of(events, 'block');
      // `notes` is in the list and empty in every row; `fee`, which the list does not show, is not offered.
      assert.deepEqual(block.block.section.show, ['$label', 'reason', 'status']);
      const [told] = results(asked.at(-1)!);
      assert.equal(told.first[0].$label, 'Ada · Annual physical');
      assert.match(told.empty, /notes/);
    },
  );
});

test('a figure, a chart or a breakdown over nothing is not drawn', async () => {
  await fixture(
    {
      turns: [
        {
          when: 'cancelled',
          steps: [
            { tools: [{ name: 'show', input: { kind: 'chart', resource: 'visit', query: 'status = cancelled', by: 'reason' } }] },
            { tools: [{ name: 'show', input: { kind: 'metric', resource: 'visit', query: 'status = cancelled', measure: 'sum fee' } }] },
            { tools: [{ name: 'show', input: { kind: 'metric', resource: 'visit', query: 'status = cancelled' } }] },
            { text: 'None were cancelled.' },
          ],
        },
      ],
    },
    async ({ turn, asked }) => {
      const events = await turn('cancelled visits by reason');
      const told = results(asked.at(-1)!);
      assert.deepEqual(
        told.map((each: { shown: string }) => each.shown),
        ['nothing', 'nothing', 'metric'],
      );
      // A count of none is an answer, and is the one block drawn.
      assert.deepEqual(
        of(events, 'block').map((each) => each.block.section.kind),
        ['metric'],
      );
    },
  );
});

test('a condition follows a reference to another table, alone and beside a rollup', async () => {
  await fixture(
    {
      turns: [
        {
          when: 'park',
          steps: [
            { tools: [{ name: 'query', input: { q: 'visit patient_id.last_name = Park show id, reason' } }] },
            { tools: [{ name: 'show', input: { kind: 'table', resource: 'visit', query: 'patient_id.last_name = Park' } }] },
            { tools: [{ name: 'query', input: { q: 'patient visits > 1 and last_name = Park' } }] },
            { tools: [{ name: 'query', input: { q: 'visit patient_id.visits > 1 and patient_id.last_name = Park show id' } }] },
            { text: 'Two.' },
          ],
        },
      ],
    },
    async ({ turn, asked }) => {
      await turn('visits of park');
      const told = results(asked.at(-1)!);
      assert.equal(told[0].total, 2, JSON.stringify(told[0]));
      assert.equal(told[1].total, 2, JSON.stringify(told[1]));
      // The rollup on its own table, and through the reference beside the path.
      assert.equal(told[2].total, 1, JSON.stringify(told[2]));
      assert.equal(told[3].total, 2, JSON.stringify(told[3]));
    },
  );
});

test("the person's message says the day and the hour in their zone, and the system prompt does not", async () => {
  const before = process.env.MISTRI_CLOCK;
  process.env.MISTRI_CLOCK = '2026-03-01T02:30:00Z';
  try {
    await fixture(
      { turns: [], otherwise: 'Hi.' },
      async ({ turn, asked }) => {
        await turn('what is due tomorrow?');
        const said = JSON.stringify(asked[0].messages.at(-1));
        // 02:30 UTC on the first is still the evening of the 28th in Chicago.
        assert.match(said, /Now: Saturday 2026-02-28, 20:30 \(America\/Chicago\)\./);
        assert.doesNotMatch(asked[0].system, /2026/);
      },
      {},
      { timezone: 'America/Chicago' },
    );
  } finally {
    if (before === undefined) delete process.env.MISTRI_CLOCK;
    else process.env.MISTRI_CLOCK = before;
  }
});

test('a turn takes the steps the App allows, a refused read is not one of them, and the last call only writes', async () => {
  const read = { tools: [{ name: 'query', input: { q: 'visit status = booked' } }] };
  const refused = { tools: [{ name: 'query', input: { q: 'visit no_such_column = 1' } }] };
  await fixture(
    { turns: [{ when: 'booked', steps: [refused, read, read, { text: 'Two are booked.' }] }] },
    async ({ turn, asked }) => {
      const events = await turn('which are booked?');
      // Three rounds of tools, the refused one uncounted, then the call that must write.
      assert.equal(asked.length, 4);
      assert.deepEqual(
        asked.map((request) => request.answerOnly === true),
        [false, false, false, true],
      );
      assert.match(words(events), /Two are booked/);
      assert.deepEqual(of(events, 'note'), []);
    },
    { limits: { steps: 2 } },
  );
  // A model that names a tool on its last call is not obeyed, and the person is told the turn stopped.
  await fixture(
    { turns: [{ when: 'booked', steps: [read, read, read] }] },
    async ({ turn, asked }) => {
      const events = await turn('which are booked?');
      assert.equal(asked.length, 2);
      assert.equal(of(events, 'step').length, 1);
      assert.match(of(events, 'note')[0].text, /Stopped after 1 steps?/);
      assert.equal(of(events, 'done').at(-1).state, 'idle');
    },
    { limits: { steps: 1 } },
  );
});
