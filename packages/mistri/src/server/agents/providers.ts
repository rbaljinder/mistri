/**
 * Multi-provider model registry, fetch-only Gemini & OpenAI-compatible adapters,
 * and transient-failure fallback wrapper for Mistri's agent harness.
 *
 * Every adapter speaks Mistri's single `AssistantModel` interface over plain `fetch`
 * (zero external SDK dependencies), including live reasoning / thinking streams.
 */
import type { AssistantModel, ModelBlock, ModelMessage, ModelRequest, ModelUsage } from '../assistant/assistantModel.js';
import { ModelUnavailable, modelRefused, streamCallbacks, type ModelStreamSink } from '../assistant/assistantModelRefusal.js';
import { openaiModel } from '../assistant/assistantOpenAI.js';

type ModelReply = Awaited<ReturnType<AssistantModel['stream']>>;

/** Provider factory registered via `registerAssistantProvider`. */
export type AssistantProviderFactory = (options: { apiKey?: string; baseUrl?: string; model?: string }) => AssistantModel | undefined;

const customProviders = new Map<string, AssistantProviderFactory>();

/** Register a custom model provider factory by name (e.g. `'bedrock'`, `'vertex'`, `'local'`). */
export function registerAssistantProvider(name: string, factory: AssistantProviderFactory): void {
  const key = name.trim().toLowerCase();
  if (!key) throw new Error('Provider name must be a non-empty string.');
  customProviders.set(key, factory);
}

/** Look up a registered custom model provider factory. */
export function getAssistantProvider(name: string): AssistantProviderFactory | undefined {
  return customProviders.get(name.trim().toLowerCase());
}

/** Names of all built-in and custom-registered assistant providers. */
export function listAssistantProviders(): string[] {
  return [...new Set(['anthropic', 'openai', 'google', 'openai-compatible', ...customProviders.keys()])];
}

/* ============================================================================
 * OpenAI-Compatible Provider (Ollama, vLLM, LiteLLM, Azure, Proxies)
 * ========================================================================== */

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey?: string;
  headers?: Readonly<Record<string, string>>;
  fetchImpl?: typeof fetch;
  deadlineMs?: number;
}

/** Create a fetch-only model adapter targeting any OpenAI-compatible Chat Completions endpoint. */
export function openaiCompatibleModel(options: OpenAICompatibleOptions): AssistantModel {
  if (!options.baseUrl?.trim()) throw new Error('openaiCompatibleModel requires a baseUrl.');
  return openaiModel(options.apiKey ?? '', options.fetchImpl ?? fetch, options.deadlineMs, {
    baseUrl: options.baseUrl,
    headers: options.headers,
    keyEnv: 'OPENAI_API_KEY',
  });
}

/* ============================================================================
 * Google Gemini Provider (Fetch-only SSE with Thinking & Function Calling)
 * ========================================================================== */

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_DEADLINE_MS = 180_000;

const GEMINI_THINKING_BUDGETS: Record<'low' | 'medium' | 'high', number> = {
  low: 1024,
  medium: 4096,
  high: 16384,
};

function geminiContents(messages: readonly ModelMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const callNames = new Map<string, string>();
  for (const msg of messages) {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    if (typeof msg.content === 'string') {
      out.push({ role, parts: [{ text: msg.content }] });
      continue;
    }
    const parts: Array<Record<string, unknown>> = [];
    for (const block of msg.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        parts.push({ text: block.text });
      } else if (block.type === 'tool_use') {
        const id = String(block.id ?? '');
        const name = String(block.name ?? '');
        if (id && name) callNames.set(id, name);
        parts.push({ functionCall: { name, args: (block.input as Record<string, unknown>) ?? {} } });
      } else if (block.type === 'tool_result') {
        const id = String(block.tool_use_id ?? '');
        const name = callNames.get(id) ?? 'tool';
        let parsed: Record<string, unknown>;
        try {
          const raw = JSON.parse(String(block.content ?? '{}')) as unknown;
          parsed = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : { result: raw };
        } catch {
          parsed = { result: String(block.content ?? '') };
        }
        parts.push({ functionResponse: { name, response: parsed } });
      }
    }
    if (parts.length) out.push({ role, parts });
  }
  return out;
}

/** Build a Gemini `streamGenerateContent` request body from a Mistri `ModelRequest`. */
export function geminiBody(request: ModelRequest): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: request.maxTokens,
  };
  if (request.effort) {
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingBudget: GEMINI_THINKING_BUDGETS[request.effort],
    };
  }
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: request.system }] },
    contents: geminiContents(request.messages),
    generationConfig,
  };
  if (request.tools.length && !request.answerOnly) {
    body.tools = [
      {
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        })),
      },
    ];
  } else if (request.answerOnly) {
    body.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
  }
  return body;
}

/** Parse a Gemini SSE stream into a Mistri `ModelReply`, forwarding text and reasoning deltas live. */
export async function readGeminiStream(body: ReadableStream<Uint8Array>, sink: ModelStreamSink): Promise<ModelReply> {
  const { onText, onReasoning } = streamCallbacks(sink);
  const decoder = new TextDecoder();
  let buffer = '';
  const textParts: string[] = [];
  const thoughtParts: string[] = [];
  const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
  const usage: ModelUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let stopReason = 'end_turn';
  let reasoningStartedAt: number | undefined;
  let reasoningClosed = false;
  const reasoningId = 'r_gemini_0';

  const closeReasoning = () => {
    if (reasoningStartedAt !== undefined && !reasoningClosed) {
      reasoningClosed = true;
      onReasoning({ id: reasoningId, done: true, durationMs: Math.max(0, Date.now() - reasoningStartedAt) });
    }
  };

  const take = (payload: Record<string, unknown>) => {
    const meta = payload.usageMetadata as Record<string, number> | undefined;
    if (meta) {
      usage.input = meta.promptTokenCount ?? usage.input;
      usage.output = meta.candidatesTokenCount ?? usage.output;
      usage.cacheRead = meta.cachedContentTokenCount ?? usage.cacheRead;
    }
    const candidates = payload.candidates as Array<Record<string, unknown>> | undefined;
    const candidate = candidates?.[0];
    if (!candidate) return;
    const content = candidate.content as { parts?: Array<Record<string, unknown>> } | undefined;
    for (const part of content?.parts ?? []) {
      if (part.thought === true && typeof part.text === 'string' && part.text) {
        if (reasoningStartedAt === undefined) reasoningStartedAt = Date.now();
        thoughtParts.push(part.text);
        onReasoning({ id: reasoningId, delta: part.text });
      } else if (typeof part.text === 'string' && part.text) {
        closeReasoning();
        textParts.push(part.text);
        onText(part.text);
      } else if (part.functionCall && typeof part.functionCall === 'object') {
        closeReasoning();
        const call = part.functionCall as { name?: string; args?: unknown };
        if (call.name) {
          toolCalls.push({
            id: `call_gemini_${toolCalls.length}`,
            name: call.name,
            input: call.args ?? {},
          });
        }
      }
    }
    const finish = candidate.finishReason;
    if (finish === 'MAX_TOKENS') stopReason = 'max_tokens';
    else if (finish === 'SAFETY' || finish === 'RECITATION') stopReason = 'refusal';
  };

  const parseLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try {
      take(JSON.parse(data) as Record<string, unknown>);
    } catch {
      /* Skip malformed keepalive lines. */
    }
  };

  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      parseLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
    if (done) {
      if (buffer.trim()) parseLine(buffer);
      break;
    }
  }
  closeReasoning();

  const content: ModelBlock[] = [];
  if (thoughtParts.length) content.push({ type: 'thinking', thinking: thoughtParts.join('') });
  if (textParts.length) content.push({ type: 'text', text: textParts.join('') });
  for (const call of toolCalls) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
  if (toolCalls.length) stopReason = 'tool_use';
  return { content, stopReason, usage };
}

/** Create a fetch-only Google Gemini adapter speaking Mistri's `AssistantModel` interface. */
export function geminiModel(
  key: string,
  fetchImpl: typeof fetch = fetch,
  deadlineMs = GEMINI_DEADLINE_MS,
  baseUrl = GEMINI_API_BASE,
): AssistantModel {
  return {
    async stream(request, sink, signal) {
      const deadline = AbortSignal.timeout(deadlineMs);
      try {
        const endpoint = `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`;
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(geminiBody(request)),
          signal: AbortSignal.any([signal, deadline]),
        });
        if (!response.ok || !response.body) throw await modelRefused(response, 'GEMINI_API_KEY');
        return await readGeminiStream(response.body, sink);
      } catch (error) {
        if (deadline.aborted && !signal.aborted) throw new ModelUnavailable('The model took too long to answer. Ask again.');
        throw error;
      }
    },
  };
}

/* ============================================================================
 * Fallback Model Wrapper (Retries across fallback models/providers on 429/5xx)
 * ========================================================================== */

export interface FallbackEntry {
  model: string;
  provider?: AssistantModel;
}

/**
 * Wrap a primary `AssistantModel` with ordered fallback models/providers.
 * When the primary throws `ModelUnavailable` (rate limit, 5xx, timeout) and the caller has not
 * aborted, tries each fallback entry in order until one succeeds.
 */
export function withModelFallback(primary: AssistantModel, fallbacks: readonly FallbackEntry[]): AssistantModel {
  if (!fallbacks.length) return primary;
  return {
    async stream(request, sink, signal) {
      const attempts: Array<{ modelId: string; provider: AssistantModel }> = [
        { modelId: request.model, provider: primary },
        ...fallbacks.map((fb) => ({ modelId: fb.model, provider: fb.provider ?? primary })),
      ];
      let lastError: unknown;
      for (const attempt of attempts) {
        if (signal.aborted) throw lastError ?? Object.assign(new Error('aborted'), { name: 'AbortError' });
        try {
          return await attempt.provider.stream({ ...request, model: attempt.modelId }, sink, signal);
        } catch (error) {
          lastError = error;
          const retryable = error instanceof ModelUnavailable || (error instanceof Error && error.name === 'ModelUnavailable');
          if (!retryable || signal.aborted) throw error;
        }
      }
      throw lastError;
    },
  };
}
