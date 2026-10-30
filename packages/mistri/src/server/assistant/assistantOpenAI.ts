/**
 * A second provider behind the same AssistantModel interface
 * (assistantModel.ts): OpenAI's Chat Completions API over plain `fetch`,
 * streaming, no SDK — the same shape Anthropic's provider has, so the
 * turn (assistantTurn.ts) never knows which provider answered. The
 * mapping is the narrow one the turn needs: the request's system prompt
 * becomes the system message, its tools become function tools, an
 * assistant block of type `tool_use` becomes a `tool_call`, and a
 * `tool_result` block becomes a `tool` message; the reply maps back the
 * same way, with `finish_reason` `tool_calls` becoming the turn's
 * `tool_use` stop reason, `stop` becoming `end_turn`, `length`
 * becoming `max_tokens` and `content_filter` becoming `refusal`.
 * Cache breakpoints have no OpenAI equivalent and are dropped, not
 * emulated. The key comes from the server's environment
 * (`OPENAI_API_KEY`), never from an App and never to a browser, and the
 * model name is the App's own (`assistant.model`), as Anthropic's is.
 */
import type { AssistantModel, ModelBlock, ModelMessage, ModelUsage } from './assistantModel.js';

/** The reply, as AssistantModel's stream returns it. */
type ModelReply = Awaited<ReturnType<AssistantModel['stream']>>;

class ModelUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelUnavailable';
  }
}

const API = 'https://api.openai.com/v1/chat/completions';
const MODEL_DEADLINE_MS = 300_000;

/** One OpenAI chat message, as the request's blocks become it. */
function messageOf(message: ModelMessage): Record<string, unknown> {
  if (typeof message.content === 'string') return { role: message.role, content: message.content };
  const texts: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  const toolResults: Array<Record<string, unknown>> = [];
  for (const block of message.content) {
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block.type === 'tool_use')
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    else if (block.type === 'tool_result')
      toolResults.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
      });
  }
  if (message.role === 'user' && toolResults.length && !texts.length && !toolCalls.length) return toolResults[0]!;
  const base: Record<string, unknown> = { role: message.role, content: texts.join('') || null };
  if (toolCalls.length) base.tool_calls = toolCalls;
  return base;
}

/** The request body: system, tools and messages in OpenAI's shape. */
export function openaiBody(request: Parameters<AssistantModel['stream']>[0]): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [{ role: 'system', content: request.system }];
  for (const message of request.messages) {
    const converted = messageOf(message);
    if (message.role === 'user' && typeof message.content !== 'string') {
      const blocks = message.content as ModelBlock[];
      const results = blocks.filter((block) => block.type === 'tool_result');
      if (results.length) {
        const texts = blocks.filter((block) => block.type === 'text' && typeof block.text === 'string');
        if (texts.length) messages.push({ role: 'user', content: texts.map((block) => block.text).join('') });
        for (const block of results)
          messages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
          });
        continue;
      }
    }
    messages.push(converted);
  }
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    stream: true,
    messages,
    ...(request.tools.length
      ? {
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
          })),
        }
      : {}),
  };
}

/** Read one Chat Completions event stream into the reply, handing text deltas on as they arrive. */
export async function readOpenAIStream(body: ReadableStream<Uint8Array>, onText: (delta: string) => void): Promise<ModelReply> {
  const text: string[] = [];
  const calls = new Map<number, { id: string; name: string; args: string }>();
  const usage: ModelUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let stopReason = 'end_turn';
  let ended = false;
  const decoder = new TextDecoder();
  let buffer = '';
  const take = (event: Record<string, unknown>) => {
    const choice = (event.choices as Array<Record<string, unknown>> | undefined)?.[0];
    if (!choice) {
      const u = event.usage as Record<string, unknown> | undefined;
      if (u) {
        usage.input = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0;
        usage.output = typeof u.completion_tokens === 'number' ? u.completion_tokens : 0;
        const details = u.prompt_tokens_details as Record<string, number> | undefined;
        usage.cacheRead = details?.cached_tokens ?? 0;
      }
      return;
    }
    const delta = (choice.delta ?? {}) as Record<string, unknown>;
    if (typeof delta.content === 'string' && delta.content) {
      text.push(delta.content);
      onText(delta.content);
    }
    for (const call of (delta.tool_calls ?? []) as Array<Record<string, unknown>>) {
      const index = call.index as number;
      const at = calls.get(index) ?? { id: '', name: '', args: '' };
      if (typeof call.id === 'string') at.id = call.id;
      const fn = (call.function ?? {}) as Record<string, string>;
      if (typeof fn.name === 'string') at.name = fn.name;
      if (typeof fn.arguments === 'string') at.args += fn.arguments;
      calls.set(index, at);
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason !== 'null') {
      ended = true;
      stopReason =
        choice.finish_reason === 'tool_calls'
          ? 'tool_use'
          : choice.finish_reason === 'length'
            ? 'max_tokens'
            : choice.finish_reason === 'content_filter'
              ? 'refusal'
              : 'end_turn';
    }
  };
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') {
            if (data === '[DONE]') ended = true;
            continue;
          }
          take(JSON.parse(data) as Record<string, unknown>);
        }
      }
    }
    if (!ended) throw new ModelUnavailable('The answer was cut off before it ended. Ask again.');
  } catch (error) {
    if (error && typeof error === 'object' && usage.input + usage.output > 0) Object.assign(error, { usage: { ...usage } });
    throw error;
  }
  const content: ModelBlock[] = [];
  if (text.length) content.push({ type: 'text', text: text.join('') });
  for (const call of [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)) {
    let input: unknown = {};
    try {
      input = call.args ? (JSON.parse(call.args) as unknown) : {};
    } catch {
      input = {};
    }
    content.push({ type: 'tool_use', id: call.id, name: call.name, input });
  }
  return { content, stopReason, usage };
}

export function openaiModel(key: string, fetchImpl: typeof fetch = fetch, deadlineMs = MODEL_DEADLINE_MS): AssistantModel {
  return {
    async stream(request, onText, signal) {
      const deadline = AbortSignal.timeout(deadlineMs);
      try {
        return await call(request, onText, AbortSignal.any([signal, deadline]));
      } catch (error) {
        if (deadline.aborted && !signal.aborted) throw new ModelUnavailable('The model took too long to answer. Ask again.');
        throw error;
      }
    },
  };
  async function call(
    request: Parameters<AssistantModel['stream']>[0],
    onText: (delta: string) => void,
    signal: AbortSignal,
  ): Promise<ModelReply> {
    const response = await fetchImpl(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(openaiBody(request)),
      signal,
    });
    if (!response.ok || !response.body) {
      const status = response.status;
      throw new ModelUnavailable(
        status === 401 || status === 403
          ? "The assistant's model key was refused. The operator sets OPENAI_API_KEY."
          : status === 429
            ? 'The model is busy. Try again in a moment.'
            : `The model could not be reached (${status}).`,
      );
    }
    return readOpenAIStream(response.body, onText);
  }
}
