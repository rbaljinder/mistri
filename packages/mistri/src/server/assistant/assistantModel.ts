/**
 * The model behind the assistant, as one small interface: a request in, its
 * text streamed out as it is written, and the whole reply — the content
 * exactly as the provider returned it, why it stopped, what it cost.
 *
 * Two providers behind this one interface, each over plain `fetch`,
 * streaming, no SDK, so the image carries nothing new: Anthropic's
 * Messages API (assistantModel.ts here) and OpenAI's Chat Completions API
 * (assistantOpenAI.ts). The operator's key comes from the server's
 * environment (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`), never from an App
 * and never to a browser.
 *
 * The stable prefix — tools, then the system prompt — carries a cache
 * breakpoint, and the conversation's last block another, so each step of a
 * turn reads what the step before it wrote (docs/assistant.md).
 */
import { readFileSync } from 'node:fs';
import { scriptedModel, type AssistantScript } from './assistantScripted.js';
import { openaiModel } from './assistantOpenAI.js';

export interface ModelUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
/** A content block as the provider returned it; kept verbatim (thinking and its signature included). */
export type ModelBlock = { type: string; [key: string]: unknown };
export interface ModelMessage {
  role: 'user' | 'assistant';
  content: string | ModelBlock[];
}
export interface ModelTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
export interface ModelRequest {
  model: string;
  system: string;
  tools: readonly ModelTool[];
  messages: readonly ModelMessage[];
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high';
}
interface ModelReply {
  content: ModelBlock[];
  /** `end_turn`, `tool_use`, `max_tokens`, `refusal`… as the provider says it. */
  stopReason: string;
  usage: ModelUsage;
}
export interface AssistantModel {
  stream(request: ModelRequest, onText: (delta: string) => void, signal: AbortSignal): Promise<ModelReply>;
}

/** A provider's refusal of the call itself (a bad key, an overloaded service), said without its internals. */
class ModelUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelUnavailable';
  }
}

const API = 'https://api.anthropic.com/v1/messages';
const ephemeral = { type: 'ephemeral' } as const;

/** The request body: the cache breakpoints on the last tool, the system prompt and the conversation's last block. */
export function anthropicBody(request: ModelRequest): Record<string, unknown> {
  const tools = request.tools.map((tool, i) => (i === request.tools.length - 1 ? { ...tool, cache_control: ephemeral } : tool));
  const messages = request.messages.map((message, i) => {
    if (i !== request.messages.length - 1) return message;
    const blocks: ModelBlock[] = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : [...message.content];
    if (blocks.length) blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: ephemeral };
    return { role: message.role, content: blocks };
  });
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    stream: true,
    system: [{ type: 'text', text: request.system, cache_control: ephemeral }],
    tools,
    messages,
    ...(request.effort ? { output_config: { effort: request.effort } } : {}),
  };
}

const total = (usage: ModelUsage) => usage.input + usage.output + usage.cacheRead + usage.cacheWrite;

interface Building {
  block: ModelBlock;
  json?: string;
}

/** Read one Messages API event stream into the reply, handing text deltas on as they arrive. */
export async function readAnthropicStream(body: ReadableStream<Uint8Array>, onText: (delta: string) => void): Promise<ModelReply> {
  const blocks = new Map<number, Building>();
  const usage: ModelUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let stopReason = 'end_turn';
  // A stream that ends without its message_stop was cut (a proxy, a dropped connection): its text is not an answer.
  let ended = false;
  const decoder = new TextDecoder();
  let buffer = '';
  const take = (event: Record<string, unknown>) => {
    switch (event.type) {
      case 'message_start': {
        const u = ((event.message as Record<string, unknown>)?.usage ?? {}) as Record<string, number>;
        usage.input = u.input_tokens ?? 0;
        usage.cacheRead = u.cache_read_input_tokens ?? 0;
        usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
        usage.output = u.output_tokens ?? 0;
        break;
      }
      case 'content_block_start':
        blocks.set(event.index as number, {
          block: { ...(event.content_block as ModelBlock) },
          ...((event.content_block as ModelBlock).type === 'tool_use' ? { json: '' } : {}),
        });
        break;
      case 'content_block_delta': {
        const at = blocks.get(event.index as number);
        const delta = event.delta as Record<string, string>;
        if (!at) break;
        if (delta.type === 'text_delta') {
          at.block.text = String(at.block.text ?? '') + delta.text;
          onText(delta.text);
        } else if (delta.type === 'input_json_delta') at.json = (at.json ?? '') + delta.partial_json;
        else if (delta.type === 'thinking_delta') at.block.thinking = String(at.block.thinking ?? '') + delta.thinking;
        else if (delta.type === 'signature_delta') at.block.signature = delta.signature;
        break;
      }
      case 'content_block_stop': {
        const at = blocks.get(event.index as number);
        if (at?.json !== undefined) {
          try {
            at.block.input = at.json ? (JSON.parse(at.json) as unknown) : {};
          } catch {
            at.block.input = {};
          }
        }
        break;
      }
      case 'message_delta': {
        const delta = event.delta as Record<string, unknown>;
        if (typeof delta?.stop_reason === 'string') stopReason = delta.stop_reason;
        const u = (event.usage ?? {}) as Record<string, number>;
        if (typeof u.output_tokens === 'number') usage.output = u.output_tokens;
        break;
      }
      case 'message_stop':
        ended = true;
        break;
      case 'error':
        throw new ModelUnavailable(
          `The model answered with an error: ${String((event.error as Record<string, unknown>)?.type ?? 'unknown')}.`,
        );
      default:
        break;
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
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) take(JSON.parse(data) as Record<string, unknown>);
      }
    }
    if (!ended) throw new ModelUnavailable('The answer was cut off before it ended. Ask again.');
  } catch (error) {
    // What the provider counted before the answer stopped is spent all the same: the turn charges it (assistantTurn.ts).
    if (error && typeof error === 'object' && total(usage) > 0) Object.assign(error, { usage: { ...usage } });
    throw error;
  }
  const content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, { block }]) => block);
  return { content, stopReason, usage };
}

/* The most one model call may take, its stream read whole: a provider that stalls mid-answer held the turn, and the
   person's place in it, until their browser gave up. Far past any answer of MAX_OUTPUT tokens. */
const MODEL_DEADLINE_MS = 300_000;

export function anthropicModel(key: string, fetchImpl: typeof fetch = fetch, deadlineMs = MODEL_DEADLINE_MS): AssistantModel {
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
  async function call(request: ModelRequest, onText: (delta: string) => void, signal: AbortSignal): Promise<ModelReply> {
    const response = await fetchImpl(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(anthropicBody(request)),
      signal,
    });
    if (!response.ok || !response.body) {
      const status = response.status;
      throw new ModelUnavailable(
        status === 401 || status === 403
          ? "The assistant's model key was refused. The operator sets ANTHROPIC_API_KEY."
          : status === 429 || status === 529
            ? 'The model is busy. Try again in a moment.'
            : `The model could not be reached (${status}).`,
      );
    }
    return readAnthropicStream(response.body, onText);
  }
}

let chosen: (() => AssistantModel | undefined) | undefined;

/** For tests: answer every App's assistant with this model; `undefined` puts the environment's choice back. */
export function setAssistantModel(factory: (() => AssistantModel | undefined) | undefined): void {
  chosen = factory;
}

/**
 * The model this server reaches, or none: a test's, then a scripted one the
 * operator names (`MISTRI_ASSISTANT_SCRIPT`, a JSON file — for a demo or a
 * browser test, never a network call), then the provider the operator names
 * (`MISTRI_ASSISTANT_PROVIDER`, `anthropic` or `openai`; Anthropic unless the
 * operator says otherwise and only Anthropic's key is set), with that
 * provider's key. Under NODE_ENV=production a script is not read: a
 * deployment's assistant is the model, never a canned answer left in its
 * environment.
 */
export function assistantModel(): AssistantModel | undefined {
  if (chosen) return chosen();
  const script = process.env.NODE_ENV === 'production' ? undefined : process.env.MISTRI_ASSISTANT_SCRIPT;
  if (script) return scriptedModel(JSON.parse(readFileSync(script, 'utf8')) as AssistantScript);
  const provider = process.env.MISTRI_ASSISTANT_PROVIDER;
  if (provider === 'openai') {
    const key = process.env.OPENAI_API_KEY;
    return key ? openaiModel(key) : undefined;
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) return anthropicModel(key);
  const openaiKey = process.env.OPENAI_API_KEY;
  return openaiKey ? openaiModel(openaiKey) : undefined;
}
