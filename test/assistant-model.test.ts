import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ASSISTANT_STORE_VERSION, ASSISTANT_TABLES } from '../packages/mistri/src/adapters/assistant/assistantStore.js';
import { provisionSqliteAssistant } from '../packages/mistri/src/adapters/assistant/sqliteAssistant.js';
import { assistantStoreAt } from '../packages/mistri/src/server/assistant/assistantStores.js';
import type { AppDef } from '../packages/mistri/src/shared/appModel.js';
import {
  anthropicBody,
  anthropicModel,
  assistantModel,
  readAnthropicStream,
  type ModelRequest,
} from '../packages/mistri/src/server/assistant/assistantModel.js';

/**
 * The thin harness's one wire: the Messages API body it sends — with the
 * cache breakpoints on the stable prefix — and the event stream it reads back,
 * tool calls and thinking kept verbatim so the next request continues the same
 * conversation. No network: a fetch double answers.
 */
const request: ModelRequest = {
  model: 'claude-sonnet-5-5',
  system: 'You are the assistant.',
  tools: [
    { name: 'find', description: 'Find.', input_schema: { type: 'object' } },
    { name: 'run', description: 'Run.', input_schema: { type: 'object' } },
  ],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Hi.' }] },
    { role: 'user', content: 'show stale deals' },
  ],
  maxTokens: 4096,
  effort: 'low',
};

const sse = (...events: Array<Record<string, unknown>>) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const text = events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join('');
      // Cut mid-frame, as a network does.
      const bytes = new TextEncoder().encode(text);
      controller.enqueue(bytes.slice(0, 37));
      controller.enqueue(bytes.slice(37));
      controller.close();
    },
  });

test('the prefix that does not change is cached: the last tool, the system prompt, and the conversation so far', () => {
  const body = anthropicBody(request) as any;
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.equal(body.stream, true);
  assert.deepEqual(body.output_config, { effort: 'low' });
  assert.equal(body.tools[0].cache_control, undefined);
  assert.deepEqual(body.tools[1].cache_control, { type: 'ephemeral' });
  assert.deepEqual(body.system, [{ type: 'text', text: 'You are the assistant.', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(body.messages[2], {
    role: 'user',
    content: [{ type: 'text', text: 'show stale deals', cache_control: { type: 'ephemeral' } }],
  });
  // Earlier messages go as they were stored: a changed byte would miss the cache.
  assert.deepEqual(body.messages[0], request.messages[0]);
  assert.equal('thinking' in body, false);
});

test('a streamed reply is read whole: text as it arrives, a tool call’s input, thinking with its signature, the usage', async () => {
  const said: string[] = [];
  const reply = await readAnthropicStream(
    sse(
      {
        type: 'message_start',
        message: { usage: { input_tokens: 12, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 1 } },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Stale means past due.' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Looking ' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'now.' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'show', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"kind":"ta' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'ble","resource":"opportunity"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } },
      { type: 'message_stop' },
    ),
    (delta) => said.push(delta),
  );
  assert.deepEqual(said, ['Looking ', 'now.']);
  assert.equal(reply.stopReason, 'tool_use');
  assert.deepEqual(reply.usage, { input: 12, output: 40, cacheRead: 900, cacheWrite: 0 });
  assert.deepEqual(reply.content, [
    { type: 'thinking', thinking: 'Stale means past due.', signature: 'sig' },
    { type: 'text', text: 'Looking now.' },
    { type: 'tool_use', id: 'toolu_1', name: 'show', input: { kind: 'table', resource: 'opportunity' } },
  ]);
});

test('the key goes in a header to the API alone, and a refused key or a busy model is said plainly', async () => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const answer = (status: number) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), headers: init!.headers as Record<string, string> });
      return new Response(status === 200 ? sse({ type: 'message_stop' }) : 'no', { status });
    }) as typeof fetch;
  const ok = await anthropicModel('sk-test', answer(200)).stream(request, () => {}, new AbortController().signal);
  assert.equal(ok.stopReason, 'end_turn');
  assert.equal(seen[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen[0].headers['x-api-key'], 'sk-test');
  await assert.rejects(
    anthropicModel('sk-bad', answer(401)).stream(request, () => {}, new AbortController().signal),
    /model key was refused/,
  );
  await assert.rejects(
    anthropicModel('sk-test', answer(529)).stream(request, () => {}, new AbortController().signal),
    /model is busy/,
  );
  await assert.rejects(
    readAnthropicStream(sse({ type: 'error', error: { type: 'overloaded_error' } }), () => {}),
    (error: Error) => error.name === 'ModelUnavailable' && /overloaded_error/.test(error.message),
  );
});

test('an answer cut off before its end, or a model that stalls, is said as such and never kept as the answer', async () => {
  await assert.rejects(
    readAnthropicStream(
      sse(
        { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Half an ans' } },
      ),
      () => {},
    ),
    (error: Error) => error.name === 'ModelUnavailable' && /cut off/.test(error.message),
  );
  const stalled = (async (_url: string | URL | Request, init?: RequestInit) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'message_start', message: { usage: {} } })}\n\n`));
          init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason));
        },
      }),
    )) as typeof fetch;
  await assert.rejects(
    anthropicModel('sk-test', stalled, 50).stream(request, () => {}, new AbortController().signal),
    (error: Error) => error.name === 'ModelUnavailable' && /took too long/.test(error.message),
  );
  // The person's own stop is theirs, not the model's slowness.
  const stop = new AbortController();
  const asked = anthropicModel('sk-test', stalled, 60_000).stream(request, () => {}, stop.signal);
  stop.abort();
  await assert.rejects(asked, (error: Error) => error.name !== 'ModelUnavailable');
});

test('a scripted model is a test’s and a demo’s: under NODE_ENV=production the script is not read', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-script-'));
  const saved = { script: process.env.MISTRI_ASSISTANT_SCRIPT, env: process.env.NODE_ENV, key: process.env.ANTHROPIC_API_KEY };
  t.after(() => {
    for (const [name, value] of [
      ['MISTRI_ASSISTANT_SCRIPT', saved.script],
      ['NODE_ENV', saved.env],
      ['ANTHROPIC_API_KEY', saved.key],
    ] as const)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, 'script.json'), JSON.stringify({ turns: [] }));
  process.env.MISTRI_ASSISTANT_SCRIPT = join(dir, 'script.json');
  delete process.env.ANTHROPIC_API_KEY;
  process.env.NODE_ENV = 'test';
  assert.ok(assistantModel(), 'a test server answers from its script');
  process.env.NODE_ENV = 'production';
  assert.equal(assistantModel(), undefined, 'production, with no key, has no model at all');
});

test('a store of another layout version says which way to go, and only a missing one is told to provision', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-assistant-store-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const app = { name: 'Leads' } as AppDef;
  const missing = join(directory, 'missing.db');
  new DatabaseSync(missing).close();
  await assert.rejects(
    assistantStoreAt(app, { path: missing }),
    /Provision it once with `mistri migrate stores up --app .*provisionStores/,
  );
  const newer = join(directory, 'newer.db');
  new DatabaseSync(newer).close();
  provisionSqliteAssistant(newer);
  const db = new DatabaseSync(newer);
  db.exec(`DROP TABLE "${ASSISTANT_TABLES.meta}"; CREATE TABLE "${ASSISTANT_TABLES.meta}" (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL);
    INSERT INTO "${ASSISTANT_TABLES.meta}" VALUES (1, ${ASSISTANT_STORE_VERSION + 1});`);
  db.close();
  await assert.rejects(assistantStoreAt(app, { path: newer }), (error: Error) => {
    assert.match(error.message, /^Leads declares an assistant\. The assistant store is at layout version \d+, newer/);
    assert.doesNotMatch(error.message, /provisionStores/);
    return true;
  });
});

test('what the provider counted before an answer stopped rides on the error, for the turn to charge', async () => {
  await assert.rejects(
    readAnthropicStream(sse({ type: 'message_start', message: { usage: { input_tokens: 900, output_tokens: 2 } } }), () => {}),
    (error: Error & { usage?: unknown }) => {
      assert.deepEqual(error.usage, { input: 900, output: 2, cacheRead: 0, cacheWrite: 0 });
      return true;
    },
  );
});
