/**
 * The assistant told what the person is on, and what a record's worked-out figures are.
 *
 * A page hands the panel a record (`useAssistant().open({ about })`, `/api/assistant/about`, and the turn's
 * `context`): it is read as the reader, under their grants and their row policy, and named by the resource's
 * `recordLabel`. A record they could not open is refused, never answered as if the turn were about nothing.
 *
 * A rollup or computed column is a column to the assistant: `describe` names it, a plain read and a record block
 * carry it, a condition compares it, and every figure says what it is in (money kept in cents, a unit), a breakdown's
 * too. One a role's field grant hides is none of these. The model is a script: nothing here reaches a provider.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { loadHttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { provisionSqliteAssistant } from '../packages/mistri/src/adapters/assistant/sqliteAssistant.js';
import { setAssistantModel, type ModelRequest } from '../packages/mistri/src/server/assistant/assistantModel.js';
import { scriptedModel, type AssistantScript } from '../packages/mistri/src/server/assistant/assistantScripted.js';
import { lintComponents } from '../packages/mistri/src/server/app/componentLint.js';
import { componentCode } from '../packages/mistri/src/server/build/checkProblems.js';
import { createApp } from './support/createApp.js';

const appId = 'assistant-about';
const owner = 'assistant-about-db';

type Person = 'ada' | 'ben' | 'clerk' | 'outsider';
const people: Record<Person, Identity> = {
  ada: { id: 'desk-one', who: 'ada@example.test', role: 'desk' } as Identity,
  ben: { id: 'desk-two', who: 'ben@example.test', role: 'desk' } as Identity,
  clerk: { id: 'desk-one-clerk', who: 'cal@example.test', role: 'clerk' } as Identity,
  outsider: { id: 'desk-one-out', who: 'out@example.test', role: 'outsider' } as Identity,
};

interface Event {
  event: string;
  data: any;
}

after(() => setAssistantModel(undefined));

async function fixture(script: AssistantScript, run: (f: any) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-assistant-about-'));
  const file = join(directory, 'clinic.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE patient (id INTEGER PRIMARY KEY, name TEXT NOT NULL, desk INTEGER NOT NULL);
    INSERT INTO patient VALUES (1, 'Ada Park', 1), (2, 'Ben Ode', 1), (3, 'Cy Other', 2);
    CREATE TABLE visit (id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patient(id), fee INTEGER NOT NULL, status TEXT NOT NULL, desk INTEGER NOT NULL);
    INSERT INTO visit VALUES (1, 1, 12500, 'open', 1), (2, 1, 4000, 'paid', 1), (3, 2, 900, 'open', 1), (4, 3, 7000, 'open', 2);`);
  provisionSqliteAssistant(file);
  const registry = new Registry();
  registry.add({ id: owner, name: owner, url: file, source: 'config', writable: true });
  const app = parseAppConfig(
    {
      id: appId,
      name: 'Clinic',
      sources: { main: { connection: owner, default: true } },
      resources: {
        patient: {
          recordLabel: '{name} (#{id})',
          rollups: { owed: { fn: 'sum', from: 'visit', column: 'fee', whose: 'patient_id', query: 'status = open' } },
          computed: { owed_twice: { type: 'number', value: 'owed * 2' } },
          display: { owed: { format: 'money', minor: true }, owed_twice: { format: 'money', minor: true } },
        },
        visit: { display: { fee: { format: 'money', minor: true } } },
      },
      auth: {
        rows: 'policy',
        roles: {
          desk: { read: true },
          clerk: { read: true, fields: { patient: { read: ['id', 'name', 'desk'] } } },
          outsider: { read: ['visit'] },
        },
      },
      views: { patients: { kind: 'list', from: 'patient' }, visits: { kind: 'list', from: 'visit' } },
      home: 'patients',
      nav: ['patients', 'visits'],
      assistant: {},
    },
    'about fixture',
  );
  let current: Identity = people.ada;
  const host: AppHost = {
    app: { app, path: join(directory, 'app.ts'), pages: [], sources: {} },
    pages: [],
    auth: { spec: app.auth!, store: join(directory, 'auth.db'), close() {}, handler: async () => {}, session: async () => current },
  };
  const policyFile = join(directory, 'policy.mjs');
  writeFileSync(
    policyFile,
    `export default { appId: ${JSON.stringify(appId)},
    resolveRows(principal) { const desk = principal.id.startsWith('desk-two') ? 2 : 1;
      return { patient: { groups: [[{ column: 'desk', op: '=', value: desk }]] }, visit: { groups: [[{ column: 'desk', op: '=', value: desk }]] } }; } };`,
  );
  const policy = await loadHttpAppPolicy({ app, registry, file: policyFile, verifySession: async () => current });
  const requests: ModelRequest[] = [];
  const model = scriptedModel(script);
  setAssistantModel(() => ({
    async stream(request, onText, signal) {
      requests.push(request);
      return model.stream(request, onText, signal);
    },
  }));
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], policy });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const post = async (path: string, body: Record<string, unknown>) => {
    const response = await fetch(`http://${bound.host}:${address.port}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', 'x-mistri-account': current.id! },
      body: JSON.stringify({ app: appId, ...body }),
    });
    const text = await response.text();
    if (!response.headers.get('content-type')?.startsWith('text/event-stream'))
      return { status: response.status, events: [] as Event[], body: JSON.parse(text) };
    const events = text
      .split('\n\n')
      .filter(Boolean)
      .map((chunk) => ({ event: /^event: (.*)$/m.exec(chunk)![1], data: JSON.parse(/^data: (.*)$/m.exec(chunk)![1]) }));
    return { status: response.status, events, body: undefined as any };
  };
  try {
    await run({ db, requests, post, as: (person: Person) => (current = people[person]) });
  } finally {
    setAssistantModel(undefined);
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await policy.retire();
    await registry.closeAll();
    clearJournal(owner);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

/** What each tool call of the turn told the model, in order: the last request carries them all. */
const told = (requests: ModelRequest[]) =>
  requests
    .at(-1)!
    .messages.flatMap((message) =>
      typeof message.content === 'string'
        ? []
        : message.content.filter((block: any) => block.type === 'tool_result').map((block: any) => JSON.parse(String(block.content))),
    );
const said = (requests: ModelRequest[]) => {
  const first = requests[0].messages[0].content;
  return typeof first === 'string' ? first : first.map((block: any) => block.text ?? '').join('\n');
};

test('a page hands the assistant a record the reader may open: named by its recordLabel, and the model told which', async () => {
  await fixture({ turns: [], otherwise: 'Noted.' }, async ({ post, requests }) => {
    const about = await post('/api/assistant/about', { resource: 'patient', id: 1 });
    assert.equal(about.status, 200, JSON.stringify(about.body));
    assert.deepEqual(about.body, { resource: 'patient', key: { id: 1 }, label: 'Ada Park (#1)', address: '/assistant-about/patients/1' });
    const turn = await post('/api/assistant/turn', { text: 'what is owed?', context: { resource: 'patient', key: about.body.key } });
    assert.equal(turn.status, 200);
    assert.match(said(requests), /Open record: patient\/1 "Ada Park \(#1\)" at \/assistant-about\/patients\/1\./);
  });
});

test('a record outside the reader’s rows, or a table they are not granted, is refused, not read as nothing', async () => {
  await fixture({ turns: [], otherwise: 'Noted.' }, async ({ post, requests, as, db }) => {
    const conversations = () => Number((db.prepare('SELECT count(*) AS n FROM __mistri_assistant_conversation').get() as { n: number }).n);
    // Cy is the other desk's patient: Ada's row policy does not give her that row.
    const outside = await post('/api/assistant/about', { resource: 'patient', id: 3 });
    assert.equal(outside.status, 404);
    assert.match(outside.body.error, /not one you can open/);
    // Asked again by the turn itself (a page that skipped the panel's ask), it is refused before the model is called.
    const turn = await post('/api/assistant/turn', { text: 'what is owed?', context: { resource: 'patient', key: { id: 3 } } });
    assert.equal(turn.status, 404);
    assert.match(turn.body.error, /not one you can open/);
    assert.equal(requests.length, 0);
    // The conversation the refused turn began is not kept.
    assert.equal(conversations(), 0);
    // Not there at all answers the same: which of the two it was is not the page's to learn.
    assert.deepEqual((await post('/api/assistant/about', { resource: 'patient', id: 99 })).body, outside.body);
    // Ben, at the other desk, opens Cy and not Ada.
    as('ben');
    assert.equal((await post('/api/assistant/about', { resource: 'patient', id: 3 })).body.label, 'Cy Other (#3)');
    assert.equal((await post('/api/assistant/about', { resource: 'patient', id: 1 })).status, 404);
    // A role that reads visits and not patients cannot be pointed at a patient.
    as('outsider');
    assert.equal((await post('/api/assistant/about', { resource: 'patient', id: 1 })).status, 404);
    assert.equal((await post('/api/assistant/turn', { text: 'who?', context: { resource: 'patient', key: { id: 1 } } })).status, 404);
    // A malformed hand-off is a bad request, not a guess.
    assert.equal((await post('/api/assistant/about', { resource: 'patient', id: { id: 1 } })).status, 400);
    assert.equal((await post('/api/assistant/turn', { text: 'who?', context: { resource: 'patient', key: 1 } })).status, 400);
  });
});

test('rollups and computed columns are columns to the assistant, said with what their figures are in', async () => {
  const script: AssistantScript = {
    turns: [
      {
        when: 'owe',
        steps: [
          { tools: [{ name: 'describe', input: { resource: 'patient' } }] },
          { tools: [{ name: 'query', input: { q: 'patient owed > 1000' } }] },
          { tools: [{ name: 'show', input: { kind: 'record', resource: 'patient', id: 1 } }] },
          { tools: [{ name: 'show', input: { kind: 'breakdown', resource: 'visit', measure: 'sum fee', by: 'status' } }] },
          { tools: [{ name: 'query', input: { q: 'visit sum fee by status' } }] },
          { text: 'Done.' },
        ],
      },
    ],
  };
  await fixture(script, async ({ post, requests, as }) => {
    const cents = 'money in USD, kept in minor units: 12500 is 125.00 USD';
    assert.equal((await post('/api/assistant/turn', { text: 'who owes?' })).status, 200);
    const [described, read, record, breakdown, counted] = told(requests);
    const fields = Object.fromEntries(described.fields.map((field: any) => [field.name, field]));
    assert.deepEqual(fields.owed, { name: 'owed', type: 'INTEGER', derived: 'rollup', figures: cents });
    assert.deepEqual(fields.owed_twice, { name: 'owed_twice', type: 'number', derived: 'computed', figures: cents });
    // A condition on a rollup reads, and the plain read carries the worked-out figures beside the row's own.
    assert.equal(read.total, 1);
    assert.deepEqual(read.columns, ['id', 'name', 'desk', 'owed', 'owed_twice']);
    assert.equal(read.rows[0].owed, 12500);
    assert.equal(read.rows[0].owed_twice, 25000);
    assert.deepEqual(read.formats, { owed: cents, owed_twice: cents });
    // A record block carries them too.
    assert.equal(record.values.owed, 12500);
    assert.equal(record.formats.owed_twice, cents);
    // A breakdown says what its measure is in: dollars kept in cents are not called cents, nor dollars by the hundred.
    assert.deepEqual(breakdown.formats, { 'sum(fee)': cents });
    assert.deepEqual(counted.formats, { 'sum(fee)': cents });

    // A clerk's field grant hides the balance: not described, not read, not comparable, not said.
    as('clerk');
    requests.length = 0;
    assert.equal((await post('/api/assistant/turn', { text: 'who owes?' })).status, 200);
    const [hiddenDescribed, hiddenRead, hiddenRecord] = told(requests);
    assert.deepEqual(
      hiddenDescribed.fields.map((field: any) => field.name),
      ['id', 'name', 'desk'],
    );
    assert.match(hiddenRead.error, /"owed" is not a column/);
    assert.deepEqual(Object.keys(hiddenRecord.values), ['id', 'name', 'desk']);
    assert.equal(hiddenRecord.formats, undefined);
    assert.doesNotMatch(JSON.stringify([hiddenDescribed, hiddenRecord]), /owed/);
  });
});

test('check warns of a page door to an assistant the App has not, or a record handed to one that reads none', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-assistant-door-'));
  try {
    mkdirSync(join(dir, 'pages'));
    writeFileSync(
      join(dir, 'pages', 'desk.page.tsx'),
      [
        "import { Button, useAssistant } from '@mistriwork/mistri/ui';",
        'export default function Desk({ visit }: { visit: { id: number } }) {',
        '  const assistant = useAssistant();',
        "  return assistant.offered ? <Button onClick={() => assistant.open({ about: { table: 'visit', id: visit.id }, text: 'Check out' })}>Ask</Button> : null;",
        '}',
      ].join('\n'),
    );
    const compiled = { entries: { desk: { sources: ['pages/desk.page.tsx'] } } } as never;
    const lint = (assistant: { placement: string[] } | null | undefined) =>
      lintComponents(dir, compiled, undefined, undefined, undefined, undefined, assistant).then(({ warnings }) =>
        warnings.map((warning) => warning.text).filter((text) => componentCode(text) === 'component-assistant'),
      );
    const none = await lint(null);
    assert.equal(none.length, 1);
    assert.match(none[0], /the App declares none/);
    const recordless = await lint({ placement: ['panel'] });
    assert.equal(recordless.length, 1);
    assert.match(recordless[0], /placement leaves out "record"/);
    assert.deepEqual(await lint({ placement: ['panel', 'record'] }), []);
    // A load, which passes no assistant, does not judge it.
    assert.deepEqual(await lint(undefined), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
