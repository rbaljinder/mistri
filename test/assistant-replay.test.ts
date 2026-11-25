/**
 * Replay (server/assistant/assistantCassette.ts, `replay` in the test kit): a turn answered from a cassette of
 * recorded requests and replies. A request the cassette holds is answered as recorded; one it does not hold fails,
 * naming its key and the person's words; a recording keeps no key and no auth header; recording without the
 * operator's key is refused before anything starts; and through a test host an Ask from a cassette shows the query
 * it ran and the records it read, offline.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  readCassette,
  recordingModel,
  redact,
  replayModel,
  requestKey,
  type Cassette,
} from '../packages/mistri/src/server/assistant/assistantCassette.js';
import { assistantModel, type AssistantModel, type ModelRequest } from '../packages/mistri/src/server/assistant/assistantModel.js';
import { createTestWorkspace, replay, startTestApp } from '../packages/mistri/src/server/testing.js';

const scratch = mkdtempSync(join(tmpdir(), 'mistri-replay-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
const request = (text: string): ModelRequest => ({
  model: 'claude-test',
  system: 'You answer from the records.',
  tools: [{ name: 'query', description: 'Read records.', input_schema: { type: 'object' } }],
  messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  maxTokens: 1024,
});
const never = new AbortController().signal;

const put = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};
/** Runs `run` with the environment changed, and puts it back. */
async function withEnv(change: Record<string, string | undefined>, run: () => Promise<void> | void) {
  const was = Object.fromEntries(Object.keys(change).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(change)) put(name, value);
  try {
    await run();
  } finally {
    for (const [name, value] of Object.entries(was)) put(name, value);
  }
}

test('a hit is answered as recorded, its text streamed; the key is what the model is asked, not how much it may say', async () => {
  const file = join(scratch, 'hit.json');
  const asked = request('which leads are new?');
  const reply = { content: [{ type: 'text', text: 'Two are new.' }], stopReason: 'end_turn', usage };
  writeFileSync(
    file,
    JSON.stringify({ version: 1, entries: [{ key: requestKey(asked), request: { model: asked.model, messages: [] }, reply }] }),
  );
  const streamed: string[] = [];
  const answered = await replayModel(file).stream({ ...asked, maxTokens: 64, effort: 'high' }, (delta) => streamed.push(delta), never);
  assert.deepEqual(answered, reply);
  assert.deepEqual(streamed, ['Two are new.']);
  // Object key order is not part of a request's key.
  const reordered = { messages: asked.messages, tools: asked.tools, system: asked.system, model: asked.model, maxTokens: 1 };
  assert.equal(requestKey(reordered), requestKey(asked));
  // Nor is the moment the person asked, which the turn says with their words: a cassette answers on another day.
  const at = (now: string) => request(`which leads are new?\n\nNow: ${now}`);
  assert.equal(requestKey(at('Tuesday 2026-03-03, 09:15 (America/Chicago).')), requestKey(at('Friday 2026-03-06, 17:40 (UTC).')));
  assert.notEqual(requestKey(at('Tuesday 2026-03-03, 09:15.')), requestKey(asked));
});

test('a miss fails the turn clearly: the cassette, the request key and the words, and how to record it', async () => {
  const file = join(scratch, 'miss.json');
  writeFileSync(file, JSON.stringify({ version: 1, entries: [] }));
  const asked = request('which leads are lost?');
  await assert.rejects(
    replayModel(file).stream(asked, () => {}, never),
    (error: Error) => {
      assert.equal(error.name, 'ModelUnavailable');
      assert.ok(error.message.includes(file));
      assert.ok(error.message.includes(requestKey(asked)));
      assert.match(error.message, /after "which leads are lost\?"/);
      assert.match(error.message, /MISTRI_REPLAY=record/);
      return true;
    },
  );
  assert.deepEqual(readCassette(join(scratch, 'nope.json')), { version: 1, entries: [] });
  const wrong = join(scratch, 'wrong.json');
  writeFileSync(wrong, JSON.stringify({ version: 2, entries: [] }));
  assert.throws(() => readCassette(wrong), /not a cassette/);
});

test('a recording keeps no key and no auth header, and a replay of it answers the same request', async () => {
  const key = 'sk-ant-api03-THISISNOTAREALKEY000000';
  await withEnv({ ANTHROPIC_API_KEY: key }, async () => {
    const file = join(scratch, 'recorded.json');
    const leaky: AssistantModel = {
      async stream() {
        return {
          content: [{ type: 'text', text: `Called with ${key}.`, headers: { Authorization: `Bearer ${key}`, 'x-api-key': key } }],
          stopReason: 'end_turn',
          usage,
        };
      },
    };
    const asked: ModelRequest = {
      ...request('who rang?'),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'who rang? cookie: session=abc', cookie: 'session=abc' }] }],
    };
    await recordingModel(file, leaky).stream(asked, () => {}, never);
    const written = readFileSync(file, 'utf8');
    assert.doesNotMatch(written, /THISISNOTAREALKEY|Bearer sk-|"cookie": "session/);
    const cassette = JSON.parse(written) as Cassette;
    assert.equal(cassette.entries.length, 1);
    assert.equal(cassette.entries[0].said, 'who rang? cookie: session=abc');
    assert.equal((cassette.entries[0].request.messages[0].content[0] as unknown as { cookie: string }).cookie, '[redacted]');
    assert.equal(
      (cassette.entries[0].reply.content[0] as unknown as { headers: Record<string, string> }).headers.Authorization,
      '[redacted]',
    );
    // Recorded again, the entry is replaced, not repeated; and the replay answers it, offline.
    await recordingModel(file, leaky).stream(asked, () => {}, never);
    assert.equal(readCassette(file).entries.length, 1);
    const replayed = await replayModel(file).stream(asked, () => {}, never);
    assert.equal(replayed.content[0].text, 'Called with [redacted].');
  });
  assert.deepEqual(redact({ api_key: 'x', nested: ['Bearer abcdefghijkl'] }, []), { api_key: '[redacted]', nested: ['[redacted]'] });
});

test('recording without the model key fails before anything runs, and the server says the same', async () => {
  await withEnv(
    { MISTRI_REPLAY: 'record', ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, MISTRI_ASSISTANT_CASSETTE: undefined },
    async () => {
      assert.throws(() => replay(join(scratch, 'any.json')), /replay: MISTRI_REPLAY=record asks the real model, and no model key is set/);
      process.env.MISTRI_ASSISTANT_CASSETTE = join(scratch, 'any.json');
      await assert.rejects(
        assistantModel()!.stream(request('hello'), () => {}, never),
        /no model key is set: set ANTHROPIC_API_KEY or OPENAI_API_KEY/,
      );
    },
  );
  // Replay is the default: no key needed, the path made absolute.
  await withEnv({ MISTRI_REPLAY: undefined }, () => {
    assert.deepEqual(replay('ask.json'), { cassette: join(process.cwd(), 'ask.json'), recording: false });
  });
});

test('through a test host, an Ask from a cassette shows the query it ran and the records it read, offline', async (t) => {
  const { provisionSqliteAssistant } = await import('../packages/mistri/src/adapters/assistant/sqliteAssistant.js');
  const workspace = await createTestWorkspace();
  t.after(() => workspace.close());
  const database = await workspace.database('business.db', (db) =>
    db.exec("CREATE TABLE lead(id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO lead VALUES (1, 'Acme'), (2, 'Globex');"),
  );
  provisionSqliteAssistant(database);
  await workspace.write('app/app.json', {
    id: 'replayed-assistant',
    name: 'Replayed assistant',
    resources: { lead: {} },
    auth: { roles: { rep: { read: true } } },
    views: { leads: { kind: 'list', from: 'lead' } },
    home: 'leads',
    nav: ['leads'],
    assistant: {},
  });
  const cassette = workspace.path('ask.cassette.json');
  /* The model's two replies, in order: read the leads, then answer. Each request's key is learnt from the miss the
     replay reports, as a reader of a failed run would, and the reply recorded under it. */
  const replies = [
    {
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'query', input: { q: 'lead show id, name sort id' } }],
      stopReason: 'tool_use',
      usage,
    },
    { content: [{ type: 'text', text: 'You have two leads.' }], stopReason: 'end_turn', usage },
  ];
  const entries: Cassette['entries'] = [];
  writeFileSync(cassette, JSON.stringify({ version: 1, entries }));
  const host = await startTestApp({ workspace, directory: workspace.path('app'), database, assistant: replay(cassette) });
  const rep = await host.as('rep');
  const ask = async () => {
    const answer = await rep.request('/api/assistant/turn', {
      method: 'POST',
      json: { app: 'replayed-assistant', text: 'Which leads?', mode: 'ask' },
    });
    const stream = await answer.text();
    assert.equal(answer.status, 200, stream);
    return [...stream.matchAll(/event: (.*)\ndata: (.*)/g)].map(([, event, data]) => ({ event, data: JSON.parse(data) }));
  };
  for (const reply of replies) {
    const events = await ask();
    const missed = events.find((each) => each.event === 'error')?.data.message as string | undefined;
    assert.match(missed ?? '', /^Replay: .* has no answer for request ([0-9a-f]{24})/, JSON.stringify(events));
    entries.push({ key: /request ([0-9a-f]{24})/.exec(missed!)![1], request: { model: '', messages: [] }, reply });
    writeFileSync(cassette, JSON.stringify({ version: 1, entries }));
  }
  const events = await ask();
  assert.equal(events.filter((each) => each.event === 'error').length, 0, JSON.stringify(events.filter((each) => each.event === 'error')));
  const [read] = events.filter((each) => each.event === 'query').map((each) => each.data);
  assert.equal(read.q, 'lead show id, name sort id');
  assert.equal(read.total, 2);
  assert.deepEqual(
    read.evidence.map((row: { ref: string; label: string }) => [row.ref, row.label]),
    [
      ['lead/{"id":1}', 'Acme'],
      ['lead/{"id":2}', 'Globex'],
    ],
  );
  const said = events
    .filter((each) => each.event === 'text')
    .map((each) => each.data.delta)
    .join('');
  assert.equal(said, 'You have two leads.');
});
