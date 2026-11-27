/**
 * Declarative external HTTP/MCP tools and signed inbound webhooks for `assistant(...)` (Wave 3B).
 *
 * Security invariants:
 * - External tool URLs must be `https:` or loopback `http:` (re-checked after `${ENV}` expansion at call time).
 * - Credentials (`authHeader`, `authValue`), internal URLs, `roles`, and webhook `secretEnv` are NEVER served
 *   in `/api/app` browser payloads.
 * - External tools default to `access: 'write'`, requiring explicit human approval checkpoints before execution.
 */

const RESERVED_TOOL_NAMES = new Set(['find', 'describe', 'query', 'show', 'run', 'delegate', 'search_knowledge', 'remember', 'forget']);
const EXTERNAL_TOOL_NAME = /^[a-z][a-z0-9_-]{0,47}$/;
const MAX_EXTERNAL_TOOLS = 16;
const EXTERNAL_TOOL_KEYS = [
  'label',
  'description',
  'kind',
  'url',
  'method',
  'mcpTool',
  'authHeader',
  'authValue',
  'access',
  'roles',
  'input',
] as const;
const EXTERNAL_TOOL_KINDS = ['http', 'mcp'] as const;
const EXTERNAL_TOOL_METHODS = ['GET', 'POST'] as const;
const EXTERNAL_TOOL_ACCESS = ['read', 'write'] as const;
const EXTERNAL_INPUT_TYPES = ['string', 'number', 'boolean'] as const;
const EXTERNAL_INPUT_FIELD_KEYS = ['type', 'description', 'required'] as const;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const OWNED_HEADERS = new Set(['host', 'content-length', 'content-type', 'accept', 'connection', 'transfer-encoding', 'cookie']);

const MAX_WEBHOOKS = 12;
const WEBHOOK_KEYS = ['id', 'label', 'description', 'secretEnv', 'signatureHeader', 'prompt', 'agent', 'enabled'] as const;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

interface AppAssistantExternalInputField {
  type: (typeof EXTERNAL_INPUT_TYPES)[number];
  description?: string;
  required?: boolean;
}

export interface AppAssistantExternalTool {
  id: string;
  label: string;
  description: string;
  kind: (typeof EXTERNAL_TOOL_KINDS)[number];
  url: string;
  method: (typeof EXTERNAL_TOOL_METHODS)[number];
  mcpTool?: string;
  authHeader?: string;
  authValue?: string;
  access: (typeof EXTERNAL_TOOL_ACCESS)[number];
  roles?: string[];
  input?: Record<string, AppAssistantExternalInputField>;
}

/** Viewer-safe external tool summary served in `/api/app` (never leaks URL, auth, or roles). */
export interface ServedAssistantExternalTool {
  id: string;
  label: string;
  description: string;
  kind: (typeof EXTERNAL_TOOL_KINDS)[number];
  method: (typeof EXTERNAL_TOOL_METHODS)[number];
  mcpTool?: string;
  access: (typeof EXTERNAL_TOOL_ACCESS)[number];
}

export interface AppAssistantWebhook {
  id: string;
  label: string;
  description?: string;
  secretEnv: string;
  signatureHeader: string;
  prompt: string;
  agent?: string;
  enabled: boolean;
}

/** Viewer-safe webhook summary served in `/api/app` (never leaks `secretEnv`). */
export interface ServedAssistantWebhook {
  id: string;
  label: string;
  description?: string;
  signatureHeader: string;
  agent?: string;
  enabled: boolean;
}

const isLoopbackHost = (host: string) => host === 'localhost' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

/** Validate an external HTTP or MCP endpoint URL (`https:` or loopback `http:`, no embedded creds/fragment). */
export function validateExternalEndpointUrl(raw: string, where: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${where} is not a valid URL.`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new Error(`${where} must use https:// (plain http:// is allowed only for localhost / 127.0.0.1).`);
  }
  if (url.username || url.password) throw new Error(`${where} cannot embed credentials in the URL; use authHeader/authValue.`);
  if (url.hash) throw new Error(`${where} cannot include a URL fragment.`);
  return url;
}

function parseRoleSubset(raw: unknown, allowedRoles: readonly string[] | undefined, where: string): string[] {
  if (!allowedRoles) throw new Error(`${where} names roles, and the App declares no "auth" with roles.`);
  if (!Array.isArray(raw) || !raw.length || raw.some((r) => typeof r !== 'string' || !r)) {
    throw new Error(`${where} is a non-empty list of role names.`);
  }
  for (const r of raw as string[]) {
    if (!allowedRoles.includes(r)) throw new Error(`${where} names "${r}", which is not one of the App's roles.`);
  }
  return [...new Set(raw as string[])];
}

export function parseExternalTools(
  raw: unknown,
  allowedRoles: readonly string[] | undefined,
  where: string,
): Record<string, AppAssistantExternalTool> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where} is an object keyed by external tool id.`);
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (!entries.length || entries.length > MAX_EXTERNAL_TOOLS) {
    throw new Error(`${where} declares 1 to ${MAX_EXTERNAL_TOOLS} external tools.`);
  }
  const out: Record<string, AppAssistantExternalTool> = {};
  for (const [id, spec] of entries) {
    const at = `${where}.${id}`;
    if (!EXTERNAL_TOOL_NAME.test(id)) {
      throw new Error(`${at} has an invalid tool id: use lowercase letters, digits, hyphens, underscores.`);
    }
    if (RESERVED_TOOL_NAMES.has(id)) {
      throw new Error(`${at} cannot reuse built-in tool name "${id}".`);
    }
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new Error(`${at} is an object: { label, description, kind, url, ... }.`);
    }
    const t = spec as Record<string, unknown>;
    for (const key of Object.keys(t)) {
      if (!(EXTERNAL_TOOL_KEYS as readonly string[]).includes(key)) {
        throw new Error(`${at} has an unknown key "${key}"; it takes ${EXTERNAL_TOOL_KEYS.join(', ')}.`);
      }
    }
    if (typeof t.label !== 'string' || !t.label.trim() || t.label.trim().length > 80) {
      throw new Error(`${at}.label is a non-empty string up to 80 characters.`);
    }
    if (typeof t.description !== 'string' || !t.description.trim() || t.description.trim().length > 240) {
      throw new Error(`${at}.description is a non-empty string up to 240 characters.`);
    }
    const kind = (t.kind ?? 'http') as (typeof EXTERNAL_TOOL_KINDS)[number];
    if (!(EXTERNAL_TOOL_KINDS as readonly unknown[]).includes(kind)) {
      throw new Error(`${at}.kind is "http" or "mcp".`);
    }
    if (typeof t.url !== 'string' || !t.url.trim()) {
      throw new Error(`${at}.url is a non-empty URL.`);
    }
    if (!t.url.includes('${')) validateExternalEndpointUrl(t.url.trim(), `${at}.url`);
    const method = (t.method ?? 'POST') as (typeof EXTERNAL_TOOL_METHODS)[number];
    if (!(EXTERNAL_TOOL_METHODS as readonly unknown[]).includes(method)) {
      throw new Error(`${at}.method is "GET" or "POST".`);
    }
    let mcpTool: string | undefined;
    if (kind === 'mcp') {
      if (typeof t.mcpTool !== 'string' || !t.mcpTool.trim() || t.mcpTool.trim().length > 80) {
        throw new Error(`${at}.mcpTool is required for kind: "mcp" (non-empty string up to 80 characters).`);
      }
      mcpTool = t.mcpTool.trim();
    } else if (t.mcpTool !== undefined) {
      throw new Error(`${at}.mcpTool is only valid when kind is "mcp".`);
    }
    let authHeader: string | undefined;
    let authValue: string | undefined;
    if (t.authHeader !== undefined || t.authValue !== undefined) {
      if (typeof t.authHeader !== 'string' || !HEADER_NAME.test(t.authHeader) || OWNED_HEADERS.has(t.authHeader.toLowerCase())) {
        throw new Error(`${at}.authHeader is a valid non-reserved HTTP header name.`);
      }
      if (typeof t.authValue !== 'string' || !t.authValue.trim()) {
        throw new Error(`${at}.authValue is a non-empty string (e.g. "Bearer \${API_TOKEN}").`);
      }
      authHeader = t.authHeader;
      authValue = t.authValue;
    }
    const access = (t.access ?? 'write') as (typeof EXTERNAL_TOOL_ACCESS)[number];
    if (!(EXTERNAL_TOOL_ACCESS as readonly unknown[]).includes(access)) {
      throw new Error(`${at}.access is "read" or "write".`);
    }
    const roles = t.roles === undefined ? undefined : parseRoleSubset(t.roles, allowedRoles, `${at}.roles`);
    let input: Record<string, AppAssistantExternalInputField> | undefined;
    if (t.input !== undefined) {
      if (!t.input || typeof t.input !== 'object' || Array.isArray(t.input)) {
        throw new Error(`${at}.input is an object mapping parameter names to { type, description?, required? }.`);
      }
      input = {};
      for (const [param, rawField] of Object.entries(t.input as Record<string, unknown>)) {
        const pf = `${at}.input.${param}`;
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,47}$/.test(param)) {
          throw new Error(`${pf} has an invalid parameter name.`);
        }
        if (!rawField || typeof rawField !== 'object' || Array.isArray(rawField)) {
          throw new Error(`${pf} is an object: { type, description?, required? }.`);
        }
        const f = rawField as Record<string, unknown>;
        for (const k of Object.keys(f)) {
          if (!(EXTERNAL_INPUT_FIELD_KEYS as readonly string[]).includes(k)) {
            throw new Error(`${pf} has an unknown key "${k}"; it takes ${EXTERNAL_INPUT_FIELD_KEYS.join(', ')}.`);
          }
        }
        if (!(EXTERNAL_INPUT_TYPES as readonly unknown[]).includes(f.type)) {
          throw new Error(`${pf}.type is "string", "number", or "boolean".`);
        }
        if (f.description !== undefined && (typeof f.description !== 'string' || !f.description.trim())) {
          throw new Error(`${pf}.description is a non-empty string.`);
        }
        if (f.required !== undefined && typeof f.required !== 'boolean') {
          throw new Error(`${pf}.required is true or false.`);
        }
        input[param] = {
          type: f.type as AppAssistantExternalInputField['type'],
          ...(f.description ? { description: (f.description as string).trim() } : {}),
          ...(f.required === true ? { required: true } : {}),
        };
      }
    }
    out[id] = {
      id,
      label: t.label.trim(),
      description: t.description.trim(),
      kind,
      url: t.url.trim(),
      method,
      ...(mcpTool ? { mcpTool } : {}),
      ...(authHeader && authValue ? { authHeader, authValue } : {}),
      access,
      ...(roles ? { roles } : {}),
      ...(input ? { input } : {}),
    };
  }
  return out;
}

export function parseAssistantWebhooks(
  raw: unknown,
  agentIds: ReadonlySet<string> | undefined,
  where: string,
): AppAssistantWebhook[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_WEBHOOKS) {
    throw new Error(`${where} is a list of 1 to ${MAX_WEBHOOKS} inbound webhooks.`);
  }
  const seen = new Set<string>();
  return raw.map((entry, idx) => {
    const at = `${where}[${idx}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${at} is an object: { id, label, secretEnv, prompt }.`);
    }
    const w = entry as Record<string, unknown>;
    for (const key of Object.keys(w)) {
      if (!(WEBHOOK_KEYS as readonly string[]).includes(key)) {
        throw new Error(`${at} has an unknown key "${key}"; a webhook takes ${WEBHOOK_KEYS.join(', ')}.`);
      }
    }
    if (typeof w.id !== 'string' || !EXTERNAL_TOOL_NAME.test(w.id)) {
      throw new Error(`${at}.id is a lowercase identifier (letters, digits, hyphens, underscores).`);
    }
    if (seen.has(w.id)) throw new Error(`${at}.id "${w.id}" is declared more than once.`);
    seen.add(w.id);
    if (typeof w.label !== 'string' || !w.label.trim() || w.label.trim().length > 80) {
      throw new Error(`${at}.label is a non-empty string up to 80 characters.`);
    }
    if (w.description !== undefined && (typeof w.description !== 'string' || !w.description.trim() || w.description.trim().length > 240)) {
      throw new Error(`${at}.description is a non-empty string up to 240 characters.`);
    }
    if (typeof w.secretEnv !== 'string' || !ENV_NAME.test(w.secretEnv)) {
      throw new Error(`${at}.secretEnv is an uppercase environment variable name (e.g. "GITHUB_WEBHOOK_SECRET").`);
    }
    const signatureHeader =
      w.signatureHeader === undefined
        ? 'x-mistri-signature'
        : typeof w.signatureHeader === 'string' && HEADER_NAME.test(w.signatureHeader)
          ? w.signatureHeader.toLowerCase()
          : (() => {
              throw new Error(`${at}.signatureHeader is a valid HTTP header name.`);
            })();
    if (typeof w.prompt !== 'string' || !w.prompt.trim() || w.prompt.trim().length > 2000) {
      throw new Error(`${at}.prompt is a non-empty string up to 2000 characters.`);
    }
    if (w.agent !== undefined) {
      if (!agentIds || typeof w.agent !== 'string' || !agentIds.has(w.agent)) {
        throw new Error(`${at}.agent names "${String(w.agent)}", which is not one of assistant.agents.`);
      }
    }
    if (w.enabled !== undefined && typeof w.enabled !== 'boolean') {
      throw new Error(`${at}.enabled is true or false.`);
    }
    return {
      id: w.id,
      label: w.label.trim(),
      ...(w.description === undefined ? {} : { description: (w.description as string).trim() }),
      secretEnv: w.secretEnv,
      signatureHeader,
      prompt: w.prompt.trim(),
      ...(w.agent === undefined ? {} : { agent: w.agent as string }),
      enabled: w.enabled !== false,
    };
  });
}

/** Viewer-safe external tools projection (filters by `roles` and strips `roles`). */
export function externalToolsFor(
  tools: ReadonlyArray<ServedAssistantExternalTool & { roles?: readonly string[] }> | undefined,
  roles: readonly string[],
): ServedAssistantExternalTool[] {
  if (!tools?.length) return [];
  return tools.filter((tool) => !tool.roles || tool.roles.some((r) => roles.includes(r))).map(({ roles: _roles, ...rest }) => rest);
}
