/**
 * The assistant's command, kept for review (commands/proposals.ts): on an ordinary App's host, a command verb the
 * model would run becomes a stored proposal (actor_kind assistant, the records the turn read as its evidence, the
 * model named) and the turn goes on; a set verb still waits in the chat for the person's confirm, as it always did; a
 * person not granted the command gets no proposal; and no route takes a client's `propose` step. The tenant host's
 * side is in tenant-assistant.test.ts and tenant-http.test.ts's fence.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { COMMAND_JOURNAL_TABLES as tables, migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { provisionSqliteAssistant } from '../packages/mistri/src/adapters/assistant/sqliteAssistant.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { setAssistantModel } from '../packages/mistri/src/server/assistant/assistantModel.js';
import { scriptedModel, type AssistantScript } from '../packages/mistri/src/server/assistant/assistantScripted.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseTestApp } from './support/commandCatalog.js';
import { createApp } from './support/createApp.js';

const appId = 'lending';
after(() => setAssistantModel(undefined));

interface Event {
  event: string;
  data: any;
}
const of = (events: Event[], kind: string) => events.filter((event) => event.event === kind).map((event) => event.data);

async function fixture(
  script: AssistantScript,
  run: (f: {
    turn(as: string, body: Record<string, unknown>): Promise<{ status: number; events: Event[]; body?: any }>;
    post(as: string, path: string, body: Record<string, unknown>): Promise<{ status: number; body: any }>;
    rows<T = Record<string, unknown>>(sql: string): T[];
    runs(): number;
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-assistant-proposals-'));
  const file = join(directory, 'lending.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE loan (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE assignment (id INTEGER PRIMARY KEY, loan_id INTEGER NOT NULL REFERENCES loan(id), reviewer TEXT NOT NULL);
    CREATE TABLE memo (id INTEGER PRIMARY KEY, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open');
    INSERT INTO loan VALUES (1, 'Corner shop', 'open', 0), (2, 'Bakery', 'open', 0);
    INSERT INTO memo VALUES (1, 'Call the bakery', 'open');`);
  migrateSqliteCommandJournal(file);
  provisionSqliteAssistant(file);
  const registry = new Registry();
  registry.add({ id: 'lending-db', name: 'Lending', url: file, writable: true, source: 'config' });
  const app = parseTestApp(
    {
      id: appId,
      name: 'Lending',
      sources: { lending: { connection: 'lending-db', default: true } },
      resources: {
        loan: {
          access: 'write',
          actions: {
            assign: { label: 'Assign', command: { id: 'assign', version: 1, target: 'loan', input: { reviewer: { type: 'text' } } } },
          },
        },
        assignment: { access: 'write' },
        memo: { access: 'write', actions: { close: { label: 'Close', set: { status: 'closed' } } } },
      },
      auth: { roles: { reviewer: { read: true, write: ['memo'], commands: ['assign'] }, viewer: { read: true } } },
      views: { loans: { kind: 'list', from: 'loan' } },
      home: 'loans',
      nav: ['loans'],
      assistant: {},
    },
    'assistant proposals fixture',
  );
  let runs = 0;
  const commands = defineCommands({
    assign: defineCommand({
      source: 'lending',
      target: 'loan',
      write: ['assignment'],
      track: 'receipts',
      input: { reviewer: { label: 'Reviewer', type: 'text' } },
      output: { parse: (value: unknown) => value as { assigned: string } },
      async handle({ db: rows, record }, input) {
        runs++;
        await rows.assignment.insert({ loan_id: record.id, reviewer: input.reviewer });
        return { assigned: input.reviewer };
      },
    }),
  });
  const people: Record<string, Identity> = {
    'account-ada': { id: 'account-ada', who: 'ada@example.test', role: 'reviewer' },
    'account-cy': { id: 'account-cy', who: 'cy@example.test', role: 'viewer' },
  };
  // The person asking: the assistant's own reads loop back through the server as them, so the session is not a header.
  let current = 'account-ada';
  const host: AppHost = {
    app: { app, path: join(directory, 'app.ts'), pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: join(directory, 'auth.db'),
      close() {},
      handler: async () => {},
      session: async () => people[current] ?? null,
    },
  };
  setAssistantModel(() => scriptedModel(script));
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], commands: { appId, registry: commands } });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://${bound.host}:${address.port}`;
  const request = (as: string, path: string, body: Record<string, unknown>) => {
    current = as;
    return fetch(`${base}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  };
  try {
    await run({
      async turn(as, body) {
        const response = await request(as, '/api/assistant/turn', { app: appId, ...body });
        const text = await response.text();
        if (!response.headers.get('content-type')?.startsWith('text/event-stream'))
          return { status: response.status, events: [], body: JSON.parse(text) };
        const events = text
          .split('\n\n')
          .filter(Boolean)
          .map((chunk) => ({ event: /^event: (.*)$/m.exec(chunk)![1], data: JSON.parse(/^data: (.*)$/m.exec(chunk)![1]) }));
        return { status: response.status, events };
      },
      async post(as, path, body) {
        const response = await request(as, path, body);
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : null };
      },
      rows: <T>(sql: string) =>
        db
          .prepare(sql)
          .all()
          .map((row) => ({ ...row })) as T[],
      runs: () => runs,
    });
  } finally {
    setAssistantModel(undefined);
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    clearJournal('lending-db');
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const script: AssistantScript = {
  turns: [
    {
      when: 'assign',
      steps: [
        { tools: [{ name: 'show', input: { kind: 'record', resource: 'loan', id: 1 } }] },
        { tools: [{ name: 'run', input: { action: 'loan.assign', id: 1, values: { reviewer: 'Dee' }, why: 'Dee reviews shop loans.' } }] },
        { text: 'Kept it for review.' },
      ],
    },
    {
      when: 'close',
      steps: [{ tools: [{ name: 'run', input: { action: 'memo.close', id: 1 } }] }, { text: 'Waiting on you.' }],
    },
  ],
  otherwise: 'Hi.',
};

test('a command verb is kept for review with its evidence and the turn goes on; a set verb still waits in the chat', async () => {
  await fixture(script, async ({ turn, post, rows, runs }) => {
    const first = await turn('account-ada', { text: 'assign the corner shop' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const [card] = of(first.events, 'proposal');
    assert.ok(card?.proposal.review, JSON.stringify(first.events));
    // Not awaited: the turn went on to its words, and the conversation is idle.
    assert.equal(of(first.events, 'done').at(-1).state, 'idle');
    assert.match(
      of(first.events, 'text')
        .map((each) => each.delta)
        .join(''),
      /Kept it for review/,
    );
    assert.equal(runs(), 0);
    const [stored] = rows<Record<string, string>>(
      `SELECT id, command, input, actor_kind, actor, model, evidence, reason, state FROM "${tables.proposal}"`,
    );
    assert.equal(stored.id, card.proposal.review);
    assert.deepEqual(
      { command: stored.command, input: JSON.parse(stored.input), actor_kind: stored.actor_kind, actor: stored.actor, state: stored.state },
      { command: 'assign', input: { reviewer: 'Dee' }, actor_kind: 'assistant', actor: 'assistant', state: 'proposed' },
    );
    assert.equal(stored.reason, 'Dee reviews shop loans.');
    assert.ok(stored.model, 'the model is named');
    assert.deepEqual(
      JSON.parse(stored.evidence).map((each: { ref: string }) => each.ref),
      ['loan/{"id":1}'],
    );
    // The queue's own verbs decide it: approved as the person, the run theirs.
    const approved = await post('account-ada', '/api/commands/proposals/approve', { id: stored.id, command: 'assign', expectedVersion: 0 });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(runs(), 1);

    // A set verb (on a table the role edits) is unchanged: a card in the chat the person confirms, the conversation awaiting it.
    const conversation = of(first.events, 'conversation')[0].id;
    const second = await turn('account-ada', { conversation, text: 'close the memo' });
    const [waiting] = of(second.events, 'proposal');
    assert.equal(waiting.proposal.action, 'close');
    assert.equal(waiting.proposal.review, undefined);
    assert.equal(of(second.events, 'done').at(-1).state, 'awaiting');
    assert.equal(rows(`SELECT id FROM "${tables.proposal}"`).length, 1);
  });
});

test('a person not granted the command gets no proposal: the assistant cannot propose what they could not run', async () => {
  await fixture(script, async ({ turn, rows, runs }) => {
    const answered = await turn('account-cy', { text: 'assign the corner shop' });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.deepEqual(of(answered.events, 'proposal'), []);
    // Refused as the run would be, and told to the model as a failed step: the turn goes on, nothing kept.
    const refused = of(answered.events, 'step').find((step) => step.tool === 'run');
    assert.equal(refused?.failed, true, JSON.stringify(answered.events));
    assert.match(refused.label, /not a change this person may propose/);
    assert.equal(of(answered.events, 'done').at(-1).state, 'idle');
    assert.deepEqual(rows(`SELECT id FROM "${tables.proposal}"`), []);
    assert.equal(runs(), 0);
  });
});

test('no route takes a client’s propose step: a body shaped like the host’s is refused or read as the route’s own', async () => {
  await fixture(script, async ({ post, rows }) => {
    const draft = {
      command: 'assign',
      key: { id: 1 },
      input: { reviewer: 'Mallory' },
      maker: 'assistant',
      makerActor: 'assistant',
      evidence: [],
      reason: 'Forged.',
    };
    for (const path of [
      '/api/commands/propose',
      '/api/commands/proposals',
      '/api/commands/proposals/approve',
      '/api/commands/proposals/dismiss',
      '/api/commands/proposals/confirm',
    ]) {
      const answer = await post('account-ada', path, { step: 'propose', draft, ...draft });
      assert.ok(answer.status !== 200 || !answer.body?.id, `${path}: ${answer.status} ${JSON.stringify(answer.body)}`);
    }
    assert.deepEqual(rows(`SELECT id FROM "${tables.proposal}"`), []);
  });
});
