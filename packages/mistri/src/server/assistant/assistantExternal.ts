/**
 * Server-side outbound HTTP / MCP tool bridge and HMAC-SHA256 inbound webhook verification (Wave 3B).
 *
 * Security invariants:
 * - Every outbound request routes through Mistri's SSRF-protected `egress.request` (no redirects,
 *   no link-local / cloud metadata, bounded timeout and response size).
 * - `${ENV_VAR}` references in `url` and `authValue` expand only inside this module right before
 *   the request is sent, and are never echoed to the model, logs, or browser.
 * - `access: 'write'` external tools never auto-execute from a model tool call: they pause at an
 *   explicit approval checkpoint and execute only via `POST /api/assistant/external/execute` after
 *   a signed-in viewer confirms.
 * - Inbound webhooks verify constant-time HMAC-SHA256 signatures over raw request bytes.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DEFAULT_POLICY, request, type EgressPolicy } from '@mistriwork/engine/adapters/http/egress.js';
import { expandEnvReferences } from '@mistriwork/engine/server/auth/credentials.js';
import { validateExternalEndpointUrl, type AppAssistantExternalTool } from '../../shared/appAssistantExternal.js';

const MAX_EXTERNAL_OUTPUT = 8_000;
const EXTERNAL_TIMEOUT_MS = 10_000;

/** Validate and coerce arguments against an external tool's declared `input` schema. */
export function validateExternalToolInput(tool: AppAssistantExternalTool, raw: unknown): Record<string, string | number | boolean> {
  const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const schema = tool.input;
  if (!schema) {
    const out: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    }
    return out;
  }
  const out: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(schema, key)) {
      throw new Error(`External tool "${tool.id}" does not accept parameter "${key}".`);
    }
  }
  for (const [key, field] of Object.entries(schema)) {
    const value = args[key];
    if (value === undefined || value === null || value === '') {
      if (field.required) throw new Error(`External tool "${tool.id}" requires parameter "${key}".`);
      continue;
    }
    if (field.type === 'string') {
      if (typeof value !== 'string') throw new Error(`Parameter "${key}" must be a string.`);
      out[key] = value;
    } else if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Parameter "${key}" must be a number.`);
      out[key] = value;
    } else if (field.type === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`Parameter "${key}" must be a boolean.`);
      out[key] = value;
    }
  }
  return out;
}

function truncateExternal(text: string): string {
  const clean = text.trim();
  return clean.length > MAX_EXTERNAL_OUTPUT ? `${clean.slice(0, MAX_EXTERNAL_OUTPUT - 1)}…` : clean;
}

function extractMcpText(payload: unknown): { isError: boolean; text: string } {
  if (!payload || typeof payload !== 'object') return { isError: false, text: String(payload ?? '') };
  const rpc = payload as {
    error?: { message?: unknown; code?: unknown };
    result?: { isError?: boolean; content?: Array<{ type?: string; text?: string }> } | unknown;
  };
  if (rpc.error) {
    return { isError: true, text: `MCP error: ${String(rpc.error.message ?? 'unknown error')}` };
  }
  const res = rpc.result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> } | undefined;
  if (res && typeof res === 'object' && Array.isArray(res.content)) {
    const joined = res.content
      .map((part) => (typeof part?.text === 'string' ? part.text : JSON.stringify(part)))
      .filter(Boolean)
      .join('\n');
    return { isError: Boolean(res.isError), text: joined || JSON.stringify(res) };
  }
  return { isError: false, text: JSON.stringify(rpc.result ?? payload) };
}

/** Invoke a declarative external HTTP or MCP (Streamable HTTP JSON-RPC 2.0) tool through Mistri egress. */
export async function invokeExternalTool(
  tool: AppAssistantExternalTool,
  rawArgs: unknown,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; output: string }> {
  const args = validateExternalToolInput(tool, rawArgs);
  const expandedUrl = expandEnvReferences(tool.url);
  const target = validateExternalEndpointUrl(expandedUrl, `externalTools.${tool.id}.url`);

  const headers: Record<string, string> = { accept: 'application/json' };
  if (tool.authHeader && tool.authValue) {
    headers[tool.authHeader.toLowerCase()] = expandEnvReferences(tool.authValue);
  }

  const policy: EgressPolicy = {
    ...DEFAULT_POLICY,
    insecure: target.protocol === 'http:',
    allowLinkLocal: false,
    timeoutMs: EXTERNAL_TIMEOUT_MS,
    maxBytes: 256 * 1024,
  };

  let method: 'GET' | 'POST' = tool.kind === 'mcp' ? 'POST' : tool.method;
  let body: Record<string, unknown> | undefined;
  if (tool.kind === 'mcp') {
    body = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: tool.mcpTool!, arguments: args },
    };
  } else if (method === 'GET') {
    for (const [k, v] of Object.entries(args)) {
      target.searchParams.set(k, String(v));
    }
  } else {
    body = args;
  }

  const reply = await request(
    target,
    {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      kind: 'webhook',
      ...(signal ? { signal } : {}),
    },
    policy,
  );

  const okHttp = reply.status >= 200 && reply.status < 300;
  if (tool.kind === 'mcp') {
    const parsed = extractMcpText(reply.json);
    return {
      ok: okHttp && !parsed.isError,
      status: reply.status,
      output: truncateExternal(parsed.text || `HTTP ${reply.status}`),
    };
  }
  const serialized = reply.json !== undefined ? JSON.stringify(reply.json) : `HTTP ${reply.status}`;
  return {
    ok: okHttp,
    status: reply.status,
    output: truncateExternal(serialized),
  };
}

/** Verify an HMAC-SHA256 webhook signature (`sha256=<hex>` or `<hex>`) in constant time. */
export function verifyWebhookSignature(rawBody: Buffer, secret: string, headerValue: string | undefined): boolean {
  if (!secret || !headerValue) return false;
  const trimmed = headerValue.trim();
  const hex = trimmed.toLowerCase().startsWith('sha256=') ? trimmed.slice(7).trim() : trimmed;
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
  const given = Buffer.from(hex, 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}
