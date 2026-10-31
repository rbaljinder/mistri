import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openaiBody, openaiModel, readOpenAIStream } from '../packages/mistri/src/server/assistant/assistantOpenAI.js';
import type { ModelRequest } from '../packages/mistri/src/server/assistant/assistantModel.js';

const request: ModelRequest = {
  model: 'gpt-test',
  system: 'You are helpful.',
  tools: [{ name: 'getTime', description: 'Current time', input_schema: { type: 'object', properties: {} } }],
  messages: [
    { role: 'user', content: 'What time is it?' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Checking.' },
        { type: 'tool_use', id: 'call_1', name: 'getTime', input: {} },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '12:00' }] },
  ],
  maxTokens: 512,
};

test('the OpenAI body carries the system prompt, the tool calls and the tool result as tool messages', () => {
  const body = openaiBody(request);
  const messages = body.messages as Array<Record<string, unknown>>;
  assert.equal(messages[0]?.role, 'system');
  assert.equal(messages[0]?.content, 'You are helpful.');
  const assistant = messages[2] as Record<string, unknown>;
  assert.ok(Array.isArray(assistant.tool_calls), 'assistant tool_use becomes tool_calls');
  const result = messages[3] as Record<string, unknown>;
  assert.equal(result.role, 'tool');
  assert.equal(result.tool_call_id, 'call_1');
  const tools = body.tools as Array<Record<string, unknown>>;
  assert.equal(tools.length, 1);
  const tool = tools[0] as Record<string, unknown>;
  assert.equal((tool.function as Record<string, unknown>).name, 'getTime');
});

test('the OpenAI stream reads text deltas and a tool call, and maps finish_reason tool_calls to tool_use', async () => {
  const sse = [
    'data: {"id":"x","choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}',
    'data: {"id":"x","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"getTime","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
    'data: {"id":"x","usage":{"prompt_tokens":10,"completion_tokens":5}}',
    'data: [DONE]',
  ].join('\n\n');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse));
      controller.close();
    },
  });
  const deltas: string[] = [];
  const reply = await readOpenAIStream(stream, (delta) => deltas.push(delta));
  assert.equal(reply.stopReason, 'tool_use');
  assert.deepEqual(deltas, ['Hi']);
  assert.equal(reply.content[1]?.type, 'tool_use');
  assert.equal((reply.content[1] as Record<string, unknown>).name, 'getTime');
  assert.equal(reply.usage.input, 10);
  assert.equal(reply.usage.output, 5);
});

test('a refused OpenAI key names the OpenAI key, not Anthropic\u2019s', async () => {
  const stub = async () => ({ ok: false, status: 401, body: null }) as unknown as Response;
  const model = openaiModel('k', stub as typeof fetch);
  await assert.rejects(() => model.stream(request, () => {}, new AbortController().signal), /OPENAI_API_KEY/);
});
