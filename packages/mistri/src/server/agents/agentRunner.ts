/**
 * Programmable agent harness runner, durable workflow bridge, and multi-channel ingress binding.
 *
 * Implements Mistri's Flue/Eve-class agent execution loop:
 * - Role & principal authority propagation across tools, skills, custom blocks, and subagents
 * - Harness lifecycle hooks (`beforeTurn`, `beforeTool`, `afterTool`, `onProposal`, `onCompact`)
 * - Progressive skill disclosure (`load_skill`)
 * - Author-defined typed Generative UI blocks (`render_block`)
 * - Artifact offloading for oversized tool outputs (`read_artifact`)
 * - Isolated-context subagent delegation (`delegate`)
 * - Durable workflow-step execution (`createDurableAgentWorkflow`)
 * - Multi-channel ingress (`bindAgentChannel`) for schedules, email, and webhooks
 */
import type { AssistantModel, ModelBlock, ModelMessage, ModelTool, ModelUsage } from '../assistant/assistantModel.js';
import type { AssistantBlock } from '../assistant/assistantTools.js';
import {
  AgentValidationError,
  createMemoryArtifactStore,
  toolDefinitionToSpec,
  validateInput,
  type AgentDefinition,
  type AgentPrincipal,
  type AgentToolContext,
  type ArtifactStore,
  type BlockDefinition,
  type SandboxAdapter,
  type SkillDefinition,
  type ToolDefinition,
  type ToolRunResult,
} from './agentPrimitives.js';
import { withModelFallback, type FallbackEntry } from './providers.js';

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_MAX_OUTPUT = 4096;
const DEFAULT_MAX_INLINE_CHARS = 6_000;
const MAX_DELEGATION_DEPTH = 3;

export interface AgentEvent {
  readonly event: 'reasoning' | 'text' | 'running' | 'step' | 'block' | 'artifact' | 'delegated' | 'done' | 'error';
  readonly data: Record<string, unknown>;
}

export interface AgentTurnStep {
  readonly id: string;
  readonly tool: string;
  readonly label: string;
  readonly failed?: boolean;
  readonly offloadedArtifactId?: string;
}

export interface AgentReasoningRecord {
  readonly id: string;
  readonly text: string;
  readonly redacted?: boolean;
  readonly durationMs?: number;
}

export interface AgentTurnResult {
  readonly agentId: string;
  readonly text: string;
  readonly reasoning: readonly AgentReasoningRecord[];
  readonly steps: readonly AgentTurnStep[];
  readonly blocks: readonly AssistantBlock[];
  readonly artifacts: readonly string[];
  readonly usage: ModelUsage;
  readonly totalTokens: number;
  readonly modelSteps: number;
  readonly stopReason: string;
}

export interface RunAgentOptions {
  readonly model: AssistantModel;
  readonly fallbacks?: readonly FallbackEntry[];
  readonly principal: AgentPrincipal;
  readonly history?: readonly ModelMessage[];
  readonly effort?: 'low' | 'medium' | 'high';
  readonly signal?: AbortSignal;
  readonly artifacts?: ArtifactStore;
  readonly sandbox?: SandboxAdapter;
  readonly query?: AgentToolContext['query'];
  readonly readRecord?: AgentToolContext['readRecord'];
  readonly emit?: (event: AgentEvent) => void;
  /** Internal recursion guard for subagent delegation. */
  readonly depth?: number;
}

function hasRoleAccess(requiredRoles: readonly string[] | undefined, principal: AgentPrincipal): boolean {
  if (!requiredRoles || requiredRoles.length === 0) return true;
  return requiredRoles.some((role) => principal.roles.includes(role));
}

function isToolRunResult(value: unknown): value is ToolRunResult {
  return Boolean(value && typeof value === 'object' && 'summary' in value);
}

/**
 * Execute one full programmable agent turn with hooks, progressive skill disclosure,
 * custom tools, custom Generative UI blocks, artifact offloading, and subagent delegation.
 */
export async function runAgentTurn(agent: AgentDefinition, userText: string, options: RunAgentOptions): Promise<AgentTurnResult> {
  if (!hasRoleAccess(agent.roles, options.principal)) {
    throw new AgentValidationError(`Principal "${options.principal.accountId}" is not authorized to run agent "${agent.id}".`);
  }

  const depth = options.depth ?? 0;
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const artifacts = options.artifacts ?? createMemoryArtifactStore();
  const emit = options.emit ?? (() => undefined);

  const toolCtx: AgentToolContext = {
    principal: options.principal,
    signal,
    artifacts,
    sandbox: options.sandbox,
    query: options.query,
    readRecord: options.readRecord,
    emitStep: (label) => emit({ event: 'running', data: { label } }),
  };

  /* Filter capabilities to those the principal's roles permit. */
  const availableSkills = (agent.skills ?? []).filter((skill) => hasRoleAccess(skill.roles, options.principal));
  const activeSkills = new Map<string, SkillDefinition>();
  const toolMap = new Map<string, ToolDefinition>();
  for (const tool of agent.tools ?? []) {
    if (hasRoleAccess(tool.roles, options.principal)) toolMap.set(tool.name, tool);
  }
  const blockMap = new Map<string, BlockDefinition>();
  for (const block of agent.blocks ?? []) {
    if (hasRoleAccess(block.roles, options.principal)) blockMap.set(block.name, block);
  }
  const subagentMap = new Map<string, AgentDefinition>();
  if (depth < MAX_DELEGATION_DEPTH) {
    for (const child of agent.subagents ?? []) {
      if (hasRoleAccess(child.roles, options.principal)) subagentMap.set(child.id, child);
    }
  }

  const buildSystem = (extraSystem?: string): string => {
    const parts = [agent.instructions.trim()];
    if (extraSystem?.trim()) parts.push(extraSystem.trim());
    if (availableSkills.length) {
      const skillLines = availableSkills.map((s) => `- ${s.name}: ${s.description}`);
      parts.push(`Available skills (call load_skill to load full playbook and tools):\n${skillLines.join('\n')}`);
    }
    if (activeSkills.size) {
      for (const skill of activeSkills.values()) {
        parts.push(`[Skill: ${skill.name}]\n${skill.instructions.trim()}`);
      }
    }
    if (blockMap.size) {
      const blockLines = [...blockMap.values()].map((b) => `- ${b.name}: ${b.description}`);
      parts.push(`Available UI blocks (call render_block to display):\n${blockLines.join('\n')}`);
    }
    if (subagentMap.size) {
      const subLines = [...subagentMap.values()].map((s) => `- ${s.id}: ${s.description ?? s.instructions.slice(0, 100)}`);
      parts.push(`Available subagents (call delegate to run an isolated subtask):\n${subLines.join('\n')}`);
    }
    return parts.join('\n\n');
  };

  let baseSystem = buildSystem();
  const beforeTurnResult = await agent.hooks?.beforeTurn?.({ ...toolCtx, userText, system: baseSystem });
  const extraSystem = beforeTurnResult?.extraSystem;
  if (extraSystem) baseSystem = buildSystem(extraSystem);

  const buildTools = (): ModelTool[] => {
    const specs: ModelTool[] = [...toolMap.values()].map(toolDefinitionToSpec);
    if (availableSkills.length) {
      specs.push({
        name: 'load_skill',
        description: 'Load a skill playbook and unlock its scoped tools and UI blocks.',
        input_schema: {
          type: 'object',
          properties: { name: { type: 'string', enum: availableSkills.map((s) => s.name) } },
          required: ['name'],
          additionalProperties: false,
        },
      });
    }
    if (blockMap.size) {
      specs.push({
        name: 'render_block',
        description: 'Resolve and render a typed author-defined Generative UI block.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', enum: [...blockMap.keys()] },
            title: { type: 'string' },
            input: { type: 'object' },
          },
          required: ['name'],
          additionalProperties: false,
        },
      });
    }
    if (subagentMap.size) {
      specs.push({
        name: 'delegate',
        description: 'Delegate a focused subtask to a specialized subagent in an isolated context window.',
        input_schema: {
          type: 'object',
          properties: {
            agent: { type: 'string', enum: [...subagentMap.keys()] },
            task: { type: 'string' },
          },
          required: ['agent', 'task'],
          additionalProperties: false,
        },
      });
    }
    specs.push({
      name: 'read_artifact',
      description: 'Read a slice of an offloaded tool output artifact by id.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          offset: { type: 'integer' },
          length: { type: 'integer' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    });
    return specs;
  };

  const fallbackEntries: FallbackEntry[] = [...(options.fallbacks ?? []), ...(agent.fallbackModels ?? []).map((model) => ({ model }))];
  const activeModel = fallbackEntries.length ? withModelFallback(options.model, fallbackEntries) : options.model;

  const messages: ModelMessage[] = [...(options.history ?? []), { role: 'user', content: userText }];
  const maxSteps = agent.limits?.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxTokens = agent.limits?.maxTokens;
  const maxOutputTokens = agent.limits?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT;
  const defaultInlineCap = agent.limits?.maxInlineToolChars ?? DEFAULT_MAX_INLINE_CHARS;

  const usage: ModelUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const textParts: string[] = [];
  const reasoningRecords: AgentReasoningRecord[] = [];
  const steps: AgentTurnStep[] = [];
  const blocks: AssistantBlock[] = [];
  const artifactIds: string[] = [];
  let modelSteps = 0;
  let stopReason = 'end_turn';

  for (let stepIndex = 0; stepIndex <= maxSteps; stepIndex++) {
    const answerOnly = stepIndex === maxSteps;
    const totalUsed = usage.input + usage.output + Math.ceil(usage.cacheRead / 10) + usage.cacheWrite;
    if (maxTokens !== undefined && totalUsed >= maxTokens) {
      stopReason = 'token_limit';
      break;
    }

    modelSteps += 1;
    const reasoningDrafts = new Map<string, { text: string; redacted?: boolean; durationMs?: number }>();
    const reply = await activeModel.stream(
      {
        model: agent.model ?? 'claude-sonnet-5-5',
        system: buildSystem(extraSystem),
        tools: buildTools(),
        messages,
        maxTokens: maxOutputTokens,
        ...((options.effort ?? agent.effort) ? { effort: options.effort ?? agent.effort } : {}),
        ...(answerOnly ? { answerOnly: true as const } : {}),
      },
      {
        onText: (delta) => {
          textParts.push(delta);
          emit({ event: 'text', data: { delta } });
        },
        onReasoning: (ev) => {
          const entry = reasoningDrafts.get(ev.id) ?? { text: '' };
          if (ev.delta) entry.text += ev.delta;
          if (ev.redacted) entry.redacted = true;
          if (ev.durationMs !== undefined) entry.durationMs = ev.durationMs;
          reasoningDrafts.set(ev.id, entry);
          if (agent.reasoning !== 'hidden') {
            emit({ event: 'reasoning', data: { ...ev } });
          }
        },
      },
      signal,
    );

    usage.input += reply.usage.input;
    usage.output += reply.usage.output;
    usage.cacheRead += reply.usage.cacheRead;
    usage.cacheWrite += reply.usage.cacheWrite;
    stopReason = reply.stopReason;

    for (const [id, entry] of reasoningDrafts) {
      reasoningRecords.push({
        id,
        text: entry.text,
        ...(entry.redacted ? { redacted: true } : {}),
        ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
      });
    }

    messages.push({ role: 'assistant', content: reply.content });

    const calls = reply.content.filter((b) => b.type === 'tool_use');
    if (!calls.length || answerOnly) break;

    const toolResults: ModelBlock[] = [];

    for (const call of calls) {
      const id = String(call.id ?? `call_${stepIndex}_${toolResults.length}`);
      const name = String(call.name ?? '');
      let input = (call.input && typeof call.input === 'object' && !Array.isArray(call.input) ? call.input : {}) as Record<string, unknown>;

      const hookDecision = await agent.hooks?.beforeTool?.({ id, name, input }, toolCtx);
      if (hookDecision?.allow === false) {
        const reason = hookDecision.reason ?? `Tool "${name}" was blocked by policy hook.`;
        const step: AgentTurnStep = { id, tool: name, label: `${name}: ${reason}`, failed: true };
        steps.push(step);
        emit({ event: 'step', data: { ...step } });
        toolResults.push({ type: 'tool_result', tool_use_id: id, content: JSON.stringify({ error: reason }), is_error: true });
        continue;
      }
      if (hookDecision?.input) input = hookDecision.input;

      emit({ event: 'running', data: { id, tool: name, label: `Running ${name}…` } });

      let resultText = '';
      let isError = false;
      let stepLabel = `Ran ${name}`;
      let emittedBlock: AssistantBlock | undefined;
      let offloadedId: string | undefined;

      try {
        if (name === 'load_skill') {
          const skillName = String(input.name ?? '');
          const skill = availableSkills.find((s) => s.name === skillName);
          if (!skill) throw new AgentValidationError(`Skill "${skillName}" is not available to this principal.`);
          activeSkills.set(skill.name, skill);
          for (const t of skill.tools ?? []) {
            if (hasRoleAccess(t.roles, options.principal)) toolMap.set(t.name, t);
          }
          for (const b of skill.blocks ?? []) {
            if (hasRoleAccess(b.roles, options.principal)) blockMap.set(b.name, b);
          }
          stepLabel = `Loaded skill ${skill.name}`;
          resultText = JSON.stringify({
            loaded: skill.name,
            unlockedTools: (skill.tools ?? []).map((t) => t.name),
            unlockedBlocks: (skill.blocks ?? []).map((b) => b.name),
          });
        } else if (name === 'render_block') {
          const blockName = String(input.name ?? '');
          const blockDef = blockMap.get(blockName);
          if (!blockDef) throw new AgentValidationError(`Block "${blockName}" is not available.`);
          const validated = validateInput(blockDef.input, input.input ?? {}, `block "${blockName}"`);
          const resolvedProps = await blockDef.resolve(validated, toolCtx);
          if (!resolvedProps) {
            stepLabel = `Skipped ${blockName} (no visible data)`;
            resultText = JSON.stringify({ shown: 'nothing', reason: 'Block suppressed because no authorized data matched.' });
          } else {
            const blockTitle = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 120) : blockDef.title;
            emittedBlock = {
              kind: 'custom',
              name: blockDef.name,
              ...(blockTitle ? { title: blockTitle } : {}),
              props: resolvedProps,
            };
            stepLabel = `Rendered ${blockTitle ?? blockDef.name}`;
            resultText = JSON.stringify({ shown: blockDef.name, props: resolvedProps });
          }
        } else if (name === 'delegate') {
          const targetId = String(input.agent ?? '');
          const task = String(input.task ?? '').trim();
          const child = subagentMap.get(targetId);
          if (!child) throw new AgentValidationError(`Subagent "${targetId}" is not available.`);
          if (!task) throw new AgentValidationError('delegate requires a non-empty task.');
          const childResult = await runAgentTurn(child, task, {
            model: options.model,
            fallbacks: options.fallbacks,
            principal: options.principal,
            effort: options.effort,
            signal,
            artifacts,
            sandbox: options.sandbox,
            query: options.query,
            readRecord: options.readRecord,
            depth: depth + 1,
            emit: (childEvent) => {
              if (childEvent.event === 'running') {
                emit({
                  event: 'running',
                  data: { id, tool: `delegate:${child.id}`, label: `[${child.id}] ${String(childEvent.data.label ?? '')}` },
                });
              }
            },
          });
          usage.input += childResult.usage.input;
          usage.output += childResult.usage.output;
          usage.cacheRead += childResult.usage.cacheRead;
          usage.cacheWrite += childResult.usage.cacheWrite;
          for (const b of childResult.blocks) {
            blocks.push(b);
            emit({ event: 'block', data: { id: `${id}_${blocks.length}`, block: b } });
          }
          stepLabel = `Delegated to ${child.id} (${childResult.steps.length} steps)`;
          emit({ event: 'delegated', data: { id, agent: child.id, steps: childResult.steps.length } });
          resultText = JSON.stringify({
            agent: child.id,
            answer: childResult.text,
            steps: childResult.steps.map((s) => s.label),
          });
        } else if (name === 'read_artifact') {
          const artId = String(input.id ?? '');
          const artifact = await artifacts.get(artId);
          if (!artifact) throw new AgentValidationError(`Artifact "${artId}" was not found.`);
          const offset = typeof input.offset === 'number' && input.offset >= 0 ? Math.floor(input.offset) : 0;
          const length =
            typeof input.length === 'number' && input.length > 0 ? Math.min(defaultInlineCap, Math.floor(input.length)) : defaultInlineCap;
          const slice = artifact.content.slice(offset, offset + length);
          stepLabel = `Read artifact ${artId}`;
          resultText = JSON.stringify({
            id: artifact.id,
            offset,
            totalChars: artifact.content.length,
            hasMore: offset + slice.length < artifact.content.length,
            content: slice,
          });
        } else {
          const toolDef = toolMap.get(name);
          if (!toolDef) throw new AgentValidationError(`Tool "${name}" is not available to this principal.`);
          const validated = validateInput(toolDef.input, input, `tool "${name}"`);
          const raw = await toolDef.run(validated, toolCtx);
          const structured: ToolRunResult = isToolRunResult(raw) ? raw : { summary: raw };
          stepLabel = structured.label ?? `Ran ${toolDef.name}`;
          if (structured.block) emittedBlock = structured.block;
          const serialized = JSON.stringify(structured.summary ?? {});
          const cap = toolDef.maxInlineChars ?? defaultInlineCap;
          if (serialized.length > cap) {
            const stored = await artifacts.put({ tool: toolDef.name, content: serialized });
            offloadedId = stored.id;
            artifactIds.push(stored.id);
            emit({ event: 'artifact', data: { id: stored.id, tool: toolDef.name, bytes: stored.bytes } });
            resultText = JSON.stringify({
              offloaded: true,
              artifactId: stored.id,
              bytes: stored.bytes,
              preview: serialized.slice(0, Math.min(800, cap)),
              note: `Full output (${serialized.length} chars) offloaded to artifact "${stored.id}". Call read_artifact to inspect slices.`,
            });
          } else {
            resultText = serialized;
          }
        }
      } catch (error) {
        isError = true;
        const message = error instanceof AgentValidationError ? error.message : error instanceof Error ? error.message : String(error);
        stepLabel = `${name}: ${message}`;
        resultText = JSON.stringify({ error: message });
      }

      const afterDecision = await agent.hooks?.afterTool?.(
        { id, name, input },
        { result: resultText, isError, block: emittedBlock },
        toolCtx,
      );
      if (afterDecision?.result !== undefined) resultText = afterDecision.result;

      const stepRecord: AgentTurnStep = {
        id,
        tool: name,
        label: stepLabel,
        ...(isError ? { failed: true } : {}),
        ...(offloadedId ? { offloadedArtifactId: offloadedId } : {}),
      };
      steps.push(stepRecord);
      emit({ event: 'step', data: { ...stepRecord } });

      if (emittedBlock) {
        blocks.push(emittedBlock);
        emit({ event: 'block', data: { id, block: emittedBlock } });
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: id,
        content: resultText,
        ...(isError ? { is_error: true } : {}),
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  const totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  const result: AgentTurnResult = {
    agentId: agent.id,
    text: textParts.join(''),
    reasoning: reasoningRecords,
    steps,
    blocks,
    artifacts: artifactIds,
    usage,
    totalTokens,
    modelSteps,
    stopReason,
  };
  emit({ event: 'done', data: { stopReason, tokens: totalTokens } });
  return result;
}

/* ============================================================================
 * Durable Workflow Bridge (Phase 4.1)
 * ========================================================================== */

/** Minimal durable workflow step interface compatible with Mistri's `WorkflowApi`. */
export interface DurableStepApi {
  run<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
  waitForEvent?<T = unknown>(eventName: string, options?: { timeout?: string }): Promise<T | null>;
}

/**
 * Bridge a `defineAgent` onto durable workflow step checkpoints (`step.run` + optional `waitForEvent`),
 * enabling restart-safe background research and human-in-the-loop approval workflows.
 */
export function createDurableAgentWorkflow(
  agent: AgentDefinition,
  options: Omit<RunAgentOptions, 'signal' | 'history'>,
): {
  readonly id: string;
  execute(
    step: DurableStepApi,
    input: { prompt: string; approvalEvent?: string; approvalTimeout?: string },
  ): Promise<{ turn: AgentTurnResult; approval?: unknown }>;
} {
  return {
    id: `agent-workflow:${agent.id}`,
    async execute(step, input) {
      const turn = await step.run(`agent:${agent.id}:turn`, () => runAgentTurn(agent, input.prompt, options));
      if (input.approvalEvent && step.waitForEvent) {
        const approval = await step.waitForEvent(input.approvalEvent, {
          ...(input.approvalTimeout ? { timeout: input.approvalTimeout } : {}),
        });
        return { turn, approval };
      }
      return { turn };
    },
  };
}

/* ============================================================================
 * Multi-Channel Ingress Binding (Phase 4.2 — Schedule, Email, Webhook/Slack)
 * ========================================================================== */

export type ChannelIngressKind = 'schedule' | 'email' | 'webhook' | 'slack';

export interface ChannelMessage {
  readonly channel: ChannelIngressKind;
  readonly sender?: string;
  readonly subject?: string;
  readonly text: string;
  readonly threadId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ChannelBindingOptions {
  readonly channel: ChannelIngressKind;
  readonly runAs: AgentPrincipal;
  readonly model: AssistantModel;
  readonly fallbacks?: readonly FallbackEntry[];
  readonly query?: AgentToolContext['query'];
  readonly readRecord?: AgentToolContext['readRecord'];
  readonly sandbox?: SandboxAdapter;
  readonly onReply?: (reply: AgentTurnResult, incoming: ChannelMessage) => Promise<void> | void;
}

/** Bind a `defineAgent` to an inbound channel (schedule, email, webhook, or Slack) under an explicit `runAs` principal. */
export function bindAgentChannel(
  agent: AgentDefinition,
  options: ChannelBindingOptions,
): {
  readonly channel: ChannelIngressKind;
  readonly agentId: string;
  handle(incoming: ChannelMessage, signal?: AbortSignal): Promise<AgentTurnResult>;
} {
  return {
    channel: options.channel,
    agentId: agent.id,
    async handle(incoming, signal) {
      const prompt = [
        `[Channel: ${incoming.channel}${incoming.sender ? ` | From: ${incoming.sender}` : ''}${incoming.subject ? ` | Subject: ${incoming.subject}` : ''}]`,
        incoming.text,
      ].join('\n');
      const result = await runAgentTurn(agent, prompt, {
        model: options.model,
        fallbacks: options.fallbacks,
        principal: options.runAs,
        signal,
        query: options.query,
        readRecord: options.readRecord,
        sandbox: options.sandbox,
      });
      await options.onReply?.(result, incoming);
      return result;
    },
  };
}
