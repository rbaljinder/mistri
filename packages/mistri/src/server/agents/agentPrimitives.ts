/**
 * Programmable agent harness primitives for Mistri (`@mistriwork/mistri/agents`):
 * - `defineBlock`: Author-defined typed Generative UI blocks with server-side authority-checked `resolve`.
 * - `defineTool`: Typed domain tools with authority mode (`user` | `readOnly` | `proposal`), role gating, and artifact offloading.
 * - `defineSkill`: Progressive-disclosure playbooks loaded on demand so starting context stays compact.
 * - `defineAgent`: Composable agent declarations with hooks, skills, custom tools, blocks, subagents, fallback models, and optional sandbox seam.
 * - `SandboxAdapter` & `ArtifactStore`: Clean opt-in seams for isolated compute and oversized tool output offloading.
 */
import type { AssistantBlock } from '../assistant/assistantTools.js';
import type { ModelTool } from '../assistant/assistantModel.js';

/* ============================================================================
 * 1. Lightweight Schema Definition (Zero External Dependencies)
 * ========================================================================== */

export type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';

export interface FieldSchema {
  readonly type: FieldType;
  readonly description?: string;
  readonly required?: boolean;
  readonly enum?: readonly (string | number)[];
}

export type InputSchema = Readonly<Record<string, FieldSchema>>;

/** Compile a Mistri `InputSchema` into standard JSON Schema for model tool specs. */
function compileInputSchema(schema: InputSchema | undefined): Record<string, unknown> {
  if (!schema) return { type: 'object', properties: {}, additionalProperties: false };
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(schema)) {
    properties[key] = {
      type: field.type,
      ...(field.description ? { description: field.description } : {}),
      ...(field.enum ? { enum: [...field.enum] } : {}),
    };
    if (field.required) required.push(key);
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

/** Validate runtime tool/block arguments against a compiled `InputSchema`. */
export function validateInput(schema: InputSchema | undefined, raw: unknown, label: string): Record<string, unknown> {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (!schema) return input;
  for (const [key, field] of Object.entries(schema)) {
    const val = input[key];
    if (val === undefined || val === null) {
      if (field.required) throw new AgentValidationError(`${label}: missing required field "${key}".`);
      continue;
    }
    if (field.type === 'string' && typeof val !== 'string') throw new AgentValidationError(`${label}: "${key}" must be a string.`);
    if (field.type === 'number' && (typeof val !== 'number' || !Number.isFinite(val)))
      throw new AgentValidationError(`${label}: "${key}" must be a number.`);
    if (field.type === 'integer' && (typeof val !== 'number' || !Number.isInteger(val)))
      throw new AgentValidationError(`${label}: "${key}" must be an integer.`);
    if (field.type === 'boolean' && typeof val !== 'boolean') throw new AgentValidationError(`${label}: "${key}" must be a boolean.`);
    if (field.type === 'array' && !Array.isArray(val)) throw new AgentValidationError(`${label}: "${key}" must be an array.`);
    if (field.type === 'object' && (typeof val !== 'object' || Array.isArray(val)))
      throw new AgentValidationError(`${label}: "${key}" must be an object.`);
    if (field.enum && !field.enum.includes(val as string | number))
      throw new AgentValidationError(`${label}: "${key}" must be one of ${field.enum.join(', ')}.`);
  }
  return input;
}

export class AgentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentValidationError';
  }
}

/* ============================================================================
 * 2. Optional Sandbox Adapter & Artifact Offloading Seam
 * ========================================================================== */

/** Opt-in isolated compute adapter (e.g., container, E2B, Cloudflare Sandbox). Zero default dependency. */
export interface SandboxAdapter {
  exec(
    command: string,
    options?: { cwd?: string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

/** Stored artifact record created when an oversized tool output is offloaded out of the context window. */
export interface StoredArtifact {
  readonly id: string;
  readonly tool: string;
  readonly bytes: number;
  readonly content: string;
  readonly createdAt: string;
}

/** Pluggable store for offloaded oversized tool outputs, scoped per run/tenant/account. */
export interface ArtifactStore {
  put(entry: { tool: string; content: string }): Promise<StoredArtifact>;
  get(id: string): Promise<StoredArtifact | undefined>;
  list(): Promise<readonly StoredArtifact[]>;
}

/** Default in-memory artifact store for a single agent run or test session. */
export function createMemoryArtifactStore(): ArtifactStore {
  const items = new Map<string, StoredArtifact>();
  let seq = 0;
  return {
    async put({ tool, content }) {
      seq += 1;
      const artifact: StoredArtifact = {
        id: `art_${seq}`,
        tool,
        bytes: Buffer.byteLength(content, 'utf8'),
        content,
        createdAt: new Date().toISOString(),
      };
      items.set(artifact.id, artifact);
      return artifact;
    },
    async get(id) {
      return items.get(id);
    },
    async list() {
      return [...items.values()];
    },
  };
}

/* ============================================================================
 * 3. Execution Context Handed to Tools, Blocks & Hooks
 * ========================================================================== */

/** Principal executing the turn — carries role & tenant authority into every tool and subagent. */
export interface AgentPrincipal {
  readonly accountId: string;
  readonly roles: readonly string[];
  readonly tenantId?: string;
}

/** Runtime context passed to custom tools, custom blocks, and harness hooks. */
export interface AgentToolContext {
  readonly principal: AgentPrincipal;
  readonly signal: AbortSignal;
  readonly artifacts: ArtifactStore;
  readonly sandbox?: SandboxAdapter;
  /** Run a query under the signed-in principal's authority. */
  query?: (q: string, limit?: number) => Promise<{ rows: Array<Record<string, unknown>>; total: number }>;
  /** Read a single record by key under the signed-in principal's authority. */
  readRecord?: (resource: string, id: string | number) => Promise<Record<string, unknown> | null>;
  /** Emit a live progress label to the parent stream. */
  emitStep?: (label: string) => void;
}

/* ============================================================================
 * 4. defineBlock — Author-Defined Typed Generative UI Blocks
 * ========================================================================== */

export interface BlockDefinition<TInput extends Record<string, unknown> = Record<string, unknown>> {
  readonly kind: 'agent-block';
  readonly name: string;
  readonly description: string;
  readonly title?: string;
  readonly input?: InputSchema;
  readonly component?: string;
  readonly roles?: readonly string[];
  /** Executes server-side under user authority; returns plain JSON props or `null` to suppress the block. */
  resolve(input: TInput, ctx: AgentToolContext): Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
}

const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

/** Declare a typed author-defined Generative UI block resolved server-side under user authority. */
export function defineBlock<TInput extends Record<string, unknown> = Record<string, unknown>>(
  spec: Omit<BlockDefinition<TInput>, 'kind'>,
): BlockDefinition<TInput> {
  if (!NAME_RE.test(spec.name))
    throw new AgentValidationError(`defineBlock: invalid name "${spec.name}" (use lowercase letters, digits, _ or -).`);
  if (!spec.description?.trim()) throw new AgentValidationError(`defineBlock("${spec.name}"): description is required.`);
  if (typeof spec.resolve !== 'function') throw new AgentValidationError(`defineBlock("${spec.name}"): resolve function is required.`);
  return { kind: 'agent-block', ...spec };
}

/* ============================================================================
 * 5. defineTool — Typed Authority-Aware Custom Tools
 * ========================================================================== */

export type ToolAuthority = 'user' | 'readOnly' | 'proposal';

export interface ToolRunResult {
  /** Compact JSON-serializable summary returned to the model. */
  readonly summary: unknown;
  /** Optional validated UI block emitted directly into the conversation stream. */
  readonly block?: AssistantBlock;
  /** Optional custom step label shown in the UI trace. */
  readonly label?: string;
}

export interface ToolDefinition<TInput extends Record<string, unknown> = Record<string, unknown>> {
  readonly kind: 'agent-tool';
  readonly name: string;
  readonly description: string;
  readonly input?: InputSchema;
  readonly authority?: ToolAuthority;
  /** Roles allowed to invoke this tool; omitted means any role allowed to run the agent. */
  readonly roles?: readonly string[];
  /** Optional custom block name to pair with `blockProps`. */
  readonly block?: string;
  /** Maximum characters kept inline before offloading to `ArtifactStore` (default 6000). */
  readonly maxInlineChars?: number;
  run(input: TInput, ctx: AgentToolContext): Promise<ToolRunResult | unknown> | ToolRunResult | unknown;
}

/** Declare a typed, authority-aware custom tool for an agent or skill. */
export function defineTool<TInput extends Record<string, unknown> = Record<string, unknown>>(
  spec: Omit<ToolDefinition<TInput>, 'kind'>,
): ToolDefinition<TInput> {
  if (!NAME_RE.test(spec.name)) throw new AgentValidationError(`defineTool: invalid name "${spec.name}".`);
  if (!spec.description?.trim()) throw new AgentValidationError(`defineTool("${spec.name}"): description is required.`);
  if (typeof spec.run !== 'function') throw new AgentValidationError(`defineTool("${spec.name}"): run function is required.`);
  return { kind: 'agent-tool', authority: 'user', ...spec };
}

/** Convert a `ToolDefinition` into a model-ready `ModelTool`. */
export function toolDefinitionToSpec(tool: ToolDefinition): ModelTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: compileInputSchema(tool.input),
  };
}

/* ============================================================================
 * 6. defineSkill — Progressive-Disclosure Playbooks
 * ========================================================================== */

export interface SkillDefinition {
  readonly kind: 'agent-skill';
  readonly name: string;
  readonly description: string;
  /** Roles allowed to discover and activate this skill. */
  readonly roles?: readonly string[];
  /** Playbook instructions injected only when the skill is loaded on demand. */
  readonly instructions: string;
  /** Additional tools unlocked when this skill is activated. */
  readonly tools?: readonly ToolDefinition[];
  /** Additional custom blocks unlocked when this skill is activated. */
  readonly blocks?: readonly BlockDefinition[];
}

/** Declare a progressive-disclosure skill loaded on demand via `load_skill`. */
export function defineSkill(spec: Omit<SkillDefinition, 'kind'>): SkillDefinition {
  if (!NAME_RE.test(spec.name)) throw new AgentValidationError(`defineSkill: invalid name "${spec.name}".`);
  if (!spec.description?.trim()) throw new AgentValidationError(`defineSkill("${spec.name}"): description is required.`);
  if (!spec.instructions?.trim()) throw new AgentValidationError(`defineSkill("${spec.name}"): instructions are required.`);
  return { kind: 'agent-skill', ...spec };
}

/* ============================================================================
 * 7. defineAgent — Composable Programmable Agent & Harness Hooks
 * ========================================================================== */

export interface AgentToolCallInfo {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export interface AgentHooks {
  /** Runs before the first model call; may append extra system context or reject the turn. */
  beforeTurn?: (
    ctx: AgentToolContext & { userText: string; system: string },
  ) => Promise<{ extraSystem?: string } | void> | { extraSystem?: string } | void;
  /** Runs before every tool call; may inspect, mutate input, or refuse (`{ allow: false, reason }`). */
  beforeTool?: (
    call: AgentToolCallInfo,
    ctx: AgentToolContext,
  ) =>
    | Promise<{ allow?: boolean; reason?: string; input?: Record<string, unknown> } | void>
    | { allow?: boolean; reason?: string; input?: Record<string, unknown> }
    | void;
  /** Runs after every tool call for telemetry, auditing, or redaction. */
  afterTool?: (
    call: AgentToolCallInfo,
    outcome: { result: string; isError?: boolean; block?: AssistantBlock },
    ctx: AgentToolContext,
  ) => Promise<{ result?: string } | void> | { result?: string } | void;
  /** Runs when a proposal is created so Apps can apply custom routing or auditing. */
  onProposal?: (proposal: Record<string, unknown>, ctx: AgentToolContext) => Promise<void> | void;
  /** Runs when history compaction triggers. */
  onCompact?: (info: { tokensBefore: number; messageCount: number }, ctx: AgentToolContext) => Promise<void> | void;
}

export interface AgentLimits {
  readonly maxSteps?: number;
  readonly maxTokens?: number;
  readonly maxOutputTokens?: number;
  readonly maxInlineToolChars?: number;
}

export interface AgentDefinition {
  readonly kind: 'agent';
  readonly id: string;
  readonly description?: string;
  readonly model?: string;
  readonly fallbackModels?: readonly string[];
  readonly reasoning?: 'collapsed' | 'expanded' | 'hidden';
  readonly effort?: 'low' | 'medium' | 'high';
  readonly instructions: string;
  readonly roles?: readonly string[];
  readonly tools?: readonly ToolDefinition[];
  readonly skills?: readonly SkillDefinition[];
  readonly blocks?: readonly BlockDefinition[];
  readonly subagents?: readonly AgentDefinition[];
  readonly hooks?: AgentHooks;
  readonly limits?: AgentLimits;
  readonly execution?: 'interactive' | 'durable';
}

/** Declare a programmable, authority-aware Mistri agent with custom tools, skills, blocks, hooks, and subagents. */
export function defineAgent(spec: Omit<AgentDefinition, 'kind'>): AgentDefinition {
  if (!NAME_RE.test(spec.id)) throw new AgentValidationError(`defineAgent: invalid id "${spec.id}".`);
  if (!spec.instructions?.trim()) throw new AgentValidationError(`defineAgent("${spec.id}"): instructions are required.`);
  return {
    kind: 'agent',
    model: 'claude-sonnet-5-5',
    reasoning: 'collapsed',
    execution: 'interactive',
    ...spec,
  };
}
