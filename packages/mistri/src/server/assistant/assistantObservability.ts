/**
 * Trace observability analytics and live declarative App evaluation runner (Wave 3A).
 *
 * - `summarizeTrace(events, run?)` converts persisted conversation events into structured
 *   execution spans (`reasoning`, `tool`, `block`, `proposal`, `delegation`, `answer`) and
 *   aggregate step/tool/token/citation metrics.
 * - `runAppEvalSuite(...)` executes declarative `assistant.evals` cases under the acting
 *   person's verified loopback session using an ephemeral in-memory store (zero conversation
 *   history pollution, zero unapproved record mutations) and returns a graded scorecard.
 */
import { canWriteSharedMemory, resolveAgentAssistant, type AppAssistant } from '../../shared/appAssistant.js';
import { estimateModelCostUsd, parseModelTarget, type AssistantProvider } from '../../shared/appAssistantRouting.js';
import type { AssistantOwner, AssistantStore, ConversationState, StoredEvent, StoredRun } from '../../adapters/assistant/assistantStore.js';
import type { AppDef } from '../../shared/appModel.js';
import type { AppPayloadApp } from '../../shared/appPayload.js';
import type { Loop } from '@mistriwork/engine/server/http/firstPaint.js';
import { catalogFromPayload, nowLine, systemPrompt, toolSpecs } from './assistantCatalog.js';
import { resolveExternalToolsWithMcp } from './assistantExternal.js';
import { assistantModel, resolveAssistantModel, type ModelBlock } from './assistantModel.js';
import { continueTurn, type ReviewOutcomes } from './assistantTurn.js';
import type { DisplayItem, ToolSession } from './assistantTools.js';

interface TraceSpan {
  readonly index: number;
  readonly kind: 'reasoning' | 'tool' | 'block' | 'proposal' | 'delegation' | 'answer';
  readonly name: string;
  readonly status: 'ok' | 'error' | 'awaiting' | 'declined';
  readonly durationMs?: number;
  readonly summary?: string;
  readonly input?: unknown;
  readonly outputPreview?: string;
  readonly citations?: number;
  readonly agent?: string;
}

interface TraceSummary {
  readonly totalSteps: number;
  readonly toolCalls: number;
  readonly failedTools: number;
  readonly blocksEmitted: number;
  readonly citationsCount: number;
  readonly proposalsCount: number;
  readonly reasoningChars: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly estimatedCostUsd: number;
  readonly model?: string;
  readonly provider?: AssistantProvider;
  readonly durationMs: number;
  readonly toolBreakdown: Record<string, number>;
  readonly spans: readonly TraceSpan[];
}

interface AppEvalCaseReport {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly agent?: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly answer: string;
  readonly durationMs: number;
  readonly trace: TraceSummary;
}

interface AppEvalSuiteReport {
  readonly appId: string;
  readonly ranAt: string;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly passRate: number;
  readonly meanTokens: number;
  readonly meanDurationMs: number;
  readonly totalCostUsd: number;
  readonly cases: readonly AppEvalCaseReport[];
}

function previewText(raw: string | null | undefined, max = 220): string | undefined {
  if (!raw) return undefined;
  const clean = raw.replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Build a structured step-by-step observability summary from persisted conversation events. */
export function summarizeTrace(
  events: readonly StoredEvent[],
  options?: { run?: StoredRun; reviewed?: ReviewOutcomes; durationMs?: number },
): TraceSummary {
  const spans: TraceSpan[] = [];
  const toolBreakdown: Record<string, number> = {};
  const outcomes = new Map<string, { status: 'done' | 'declined' | 'failed'; detail?: string }>();
  for (const ev of events) {
    if (ev.kind === 'outcome') {
      const b = ev.body as { id: string; status: 'done' | 'declined' | 'failed'; detail?: string };
      outcomes.set(b.id, { status: b.status, ...(b.detail ? { detail: b.detail } : {}) });
    }
  }

  const pendingUses = new Map<string, { name: string; input: unknown }>();
  let totalSteps = 0;
  let toolCalls = 0;
  let failedTools = 0;
  let blocksEmitted = 0;
  let citationsCount = 0;
  let proposalsCount = 0;
  let reasoningChars = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let estimatedCostUsd = 0;
  let lastModelSpec: string | undefined;

  for (const ev of events) {
    const body = ev.body as Record<string, unknown>;
    if (ev.kind === 'assistant') {
      const blocks = Array.isArray(body.content) ? (body.content as ModelBlock[]) : [];
      const durations = Array.isArray(body.reasoningDurations) ? (body.reasoningDurations as Array<number | undefined>) : undefined;
      const evModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined;
      if (evModel) lastModelSpec = evModel;
      const usage = body.usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined;
      if (usage) {
        const inp = usage.input ?? 0;
        const out = usage.output ?? 0;
        const cRead = usage.cacheRead ?? 0;
        const cWrite = usage.cacheWrite ?? 0;
        tokensIn += inp + cRead + cWrite;
        tokensOut += out;
        cacheReadTokens += cRead;
        cacheWriteTokens += cWrite;
        estimatedCostUsd += estimateModelCostUsd(evModel ?? lastModelSpec, {
          input: inp,
          output: out,
          cacheRead: cRead,
          cacheWrite: cWrite,
        });
      }
      let rIdx = 0;
      let textBuf = '';
      let hadToolUse = false;
      for (const block of blocks) {
        if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
          reasoningChars += block.thinking.trim().length;
          const dur = durations?.[rIdx++];
          spans.push({
            index: spans.length + 1,
            kind: 'reasoning',
            name: 'Reasoning',
            status: 'ok',
            ...(typeof dur === 'number' ? { durationMs: dur } : {}),
            summary: previewText(block.thinking, 180),
          });
        } else if (block.type === 'redacted_thinking') {
          const dur = durations?.[rIdx++];
          spans.push({
            index: spans.length + 1,
            kind: 'reasoning',
            name: 'Reasoning (redacted)',
            status: 'ok',
            ...(typeof dur === 'number' ? { durationMs: dur } : {}),
          });
        } else if (block.type === 'tool_use') {
          hadToolUse = true;
          pendingUses.set(String(block.id), { name: String(block.name), input: block.input });
        } else if (block.type === 'text' && typeof block.text === 'string') {
          textBuf += block.text;
        }
      }
      if (hadToolUse) totalSteps++;
      if (textBuf.trim()) {
        spans.push({
          index: spans.length + 1,
          kind: 'answer',
          name: 'Assistant response',
          status: 'ok',
          summary: previewText(textBuf, 220),
        });
      }
    } else if (ev.kind === 'tool') {
      const results = Array.isArray(body.results) ? (body.results as Array<{ id: string; content: string | null; isError?: true }>) : [];
      const display = Array.isArray(body.display) ? (body.display as DisplayItem[]) : [];

      for (const result of results) {
        const use = pendingUses.get(result.id);
        const name = use?.name ?? 'tool';
        toolCalls++;
        toolBreakdown[name] = (toolBreakdown[name] ?? 0) + 1;
        if (result.isError) failedTools++;
        const outcome = outcomes.get(result.id);
        const status: TraceSpan['status'] = result.isError
          ? 'error'
          : result.content === null
            ? outcome?.status === 'done'
              ? 'ok'
              : outcome?.status === 'declined'
                ? 'declined'
                : outcome?.status === 'failed'
                  ? 'error'
                  : 'awaiting'
            : 'ok';
        spans.push({
          index: spans.length + 1,
          kind: 'tool',
          name,
          status,
          ...(use?.input !== undefined ? { input: use.input } : {}),
          ...(result.content ? { outputPreview: previewText(result.content, 200) } : {}),
        });
      }

      for (const item of display) {
        if (item.type === 'block') {
          blocksEmitted++;
          const blockKind = item.block.kind === 'custom' ? `custom:${item.block.name}` : item.block.kind;
          spans.push({
            index: spans.length + 1,
            kind: 'block',
            name: blockKind,
            status: 'ok',
          });
        } else if (item.type === 'citations') {
          const count = item.items.length;
          citationsCount += count;
          const prevTool = [...spans].reverse().find((s) => s.kind === 'tool' && s.name === 'search_knowledge');
          if (prevTool) {
            (prevTool as { citations?: number }).citations = (prevTool.citations ?? 0) + count;
          }
        } else if (item.type === 'delegation') {
          spans.push({
            index: spans.length + 1,
            kind: 'delegation',
            name: item.agentName,
            agent: item.agent,
            status: item.status === 'error' ? 'error' : 'ok',
            ...(item.summary ? { summary: previewText(item.summary, 180) } : {}),
          });
        } else if (item.type === 'proposal') {
          proposalsCount++;
          const outcome = outcomes.get(item.id) ?? (item.proposal.review ? options?.reviewed?.get(item.proposal.review) : undefined);
          const status: TraceSpan['status'] = !outcome
            ? 'awaiting'
            : outcome.status === 'done'
              ? 'ok'
              : outcome.status === 'declined'
                ? 'declined'
                : 'error';
          spans.push({
            index: spans.length + 1,
            kind: 'proposal',
            name: item.proposal.label,
            status,
            ...(item.proposal.why ? { summary: previewText(item.proposal.why, 180) } : {}),
          });
        }
      }
    }
  }

  const run = options?.run;
  const computedDuration =
    options?.durationMs ??
    (run?.createdAt && (run.finishedAt || run.updatedAt)
      ? Math.max(0, Date.parse(run.finishedAt || run.updatedAt) - Date.parse(run.createdAt))
      : events.length >= 2
        ? Math.max(0, Date.parse(events[events.length - 1]!.at) - Date.parse(events[0]!.at))
        : 0);

  const totalTokens = tokensIn + tokensOut || (run?.tokens ?? 0);
  const parsedModel = lastModelSpec ? parseModelTarget(lastModelSpec) : undefined;
  return {
    totalSteps: Math.max(totalSteps, run?.steps ?? 0),
    toolCalls,
    failedTools,
    blocksEmitted,
    citationsCount,
    proposalsCount,
    reasoningChars,
    tokensIn,
    tokensOut,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    estimatedCostUsd: Math.round(estimatedCostUsd * 1_000_000) / 1_000_000,
    ...(parsedModel ? { model: parsedModel.model, provider: parsedModel.provider } : {}),
    durationMs: computedDuration,
    toolBreakdown,
    spans,
  };
}

/** Ephemeral in-memory AssistantStore used exclusively for isolated eval runs so user conversation history is untouched. */
function createEphemeralEvalStore(backing: AssistantStore): {
  store: AssistantStore;
  events: StoredEvent[];
  tokens: () => number;
} {
  const events: StoredEvent[] = [];
  let state: ConversationState = 'idle';
  let seq = 0;
  let spentTokens = 0;

  const store: AssistantStore = {
    list: async () => [],
    get: async (_owner, id) => ({ id, title: 'eval', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state }),
    create: async (_owner, title, at) => ({ id: 'eval-conv', title, createdAt: at, updatedAt: at, state: 'idle' }),
    events: async () => [...events],
    append: async (_owner, _conv, nextEvents, nextState, at) => {
      for (const item of nextEvents) {
        events.push({ seq: ++seq, kind: item.kind, body: item.body, at });
      }
      state = nextState;
      return true;
    },
    truncate: async () => true,
    rename: async () => false,
    remove: async () => false,
    search: async () => [],
    spent: async () => ({ person: spentTokens, tenant: spentTokens, app: spentTokens }),
    spend: async (_owner, _day, add) => {
      spentTokens += add;
    },
    purge: async () => 0,
    tenantEnabled: async () => true,
    memories: (o, q) => backing.memories(o, q),
    remember: async (_o, input, at) => ({
      memory: {
        id: 'eval-mem',
        scope: input.scope,
        content: input.content,
        source: input.source,
        agent: input.agent ?? '',
        createdAt: at,
        updatedAt: at,
      },
      updated: false,
    }),
    forget: async () => false,
    listRuns: async () => [],
    getRun: async () => null,
    countActiveRuns: async () => 0,
    createRun: async (_o, input, at) => ({
      id: 'eval-run',
      conversation: input.conversation,
      title: input.title,
      prompt: input.prompt,
      agent: input.agent ?? '',
      source: input.source ?? 'manual',
      status: 'queued',
      steps: 0,
      tokens: 0,
      summary: '',
      createdAt: at,
      updatedAt: at,
      finishedAt: '',
    }),
    updateRun: async () => null,
    deleteRun: async () => false,
    listAutomations: async () => [],
    getAutomation: async () => null,
    upsertAutomation: async (_o, input, at) => ({
      kind: input.kind,
      automationId: input.automationId,
      enabled: input.enabled ?? true,
      lastSlot: input.lastSlot ?? '',
      lastRunId: input.lastRunId ?? '',
      lastRunAt: input.lastRunAt ?? '',
      updatedAt: at,
    }),
    close: async () => {},
  };

  return {
    store,
    events,
    tokens: () => spentTokens,
  };
}

async function servedToLoop(loop: Loop, app: string, signal: AbortSignal): Promise<AppPayloadApp | null> {
  const answer = await loop('GET', `/api/app?app=${encodeURIComponent(app)}`, undefined, signal);
  const payload = (answer?.body as { app?: AppPayloadApp | null } | undefined)?.app;
  if (answer?.status !== 200 || !payload?.assistant) return null;
  return payload;
}

async function tablesOfLoop(loop: Loop, app: string, signal: AbortSignal): Promise<string[]> {
  const answer = await loop('GET', `/api/schema?app=${encodeURIComponent(app)}`, undefined, signal);
  const tables = (answer?.body as { tables?: Array<{ id: string }> } | undefined)?.tables;
  return answer?.status === 200 && Array.isArray(tables) ? tables.map((table) => table.id) : [];
}

/**
 * Execute one or all declared `assistant.evals` cases under the acting person's verified loopback authority.
 * Runs in an ephemeral in-memory store so conversation history is untouched and mutations only produce proposals.
 */
export async function runAppEvalSuite(params: {
  store: AssistantStore;
  owner: AssistantOwner;
  app: AppDef;
  loop: Loop;
  viewerRoles?: readonly string[];
  evalId?: string;
  signal: AbortSignal;
}): Promise<AppEvalSuiteReport> {
  const model = assistantModel();
  const baseAssistant = params.app.assistant;
  if (!model) throw new Error('The assistant has no model set up.');
  if (!baseAssistant?.evals?.length) throw new Error('This App declares no assistant eval cases.');

  const permitted = baseAssistant.evals.filter(
    (each) => !each.roles || !params.viewerRoles || params.viewerRoles.some((r) => each.roles!.includes(r)),
  );
  const selected = params.evalId ? permitted.filter((each) => each.id === params.evalId) : permitted;
  if (!selected.length) throw new Error(params.evalId ? `Eval case "${params.evalId}" was not found.` : 'No eval cases available.');

  const payload = await servedToLoop(params.loop, params.app.id, params.signal);
  if (!payload) throw new Error('Could not load viewer App payload for eval run.');
  const tables = await tablesOfLoop(params.loop, params.app.id, params.signal);
  const viewerRoles = params.viewerRoles ?? payload.viewerRoles;

  const caseReports: AppEvalCaseReport[] = [];

  for (const evalCase of selected) {
    const startMs = Date.now();
    const resolved = resolveAgentAssistant(baseAssistant, evalCase.agent, viewerRoles);
    const activeAgent = resolved.agent;
    const mergedExternal = await resolveExternalToolsWithMcp(
      resolved.assistant.externalTools,
      resolved.assistant.mcpServers,
      params.signal,
    );
    const runAssistant: AppAssistant = {
      ...resolved.assistant,
      ...(mergedExternal ? { externalTools: mergedExternal } : {}),
    };
    const canWriteShared = canWriteSharedMemory(runAssistant.memory, viewerRoles ?? []);
    const memories = runAssistant.memory
      ? await params.store.memories(params.owner, { scopes: runAssistant.memory.scopes, agent: activeAgent?.id, limit: 40 })
      : undefined;
    const catalog = catalogFromPayload(
      payload,
      runAssistant,
      tables,
      activeAgent,
      runAssistant.memory ? { memories, canWriteSharedMemory: canWriteShared } : undefined,
    );
    const system = systemPrompt(catalog);
    const tools = toolSpecs(runAssistant, activeAgent, { canWriteSharedMemory: canWriteShared });

    const ephemeral = createEphemeralEvalStore(params.store);
    const at = new Date().toISOString();
    await ephemeral.store.append(
      params.owner,
      'eval-conv',
      [
        {
          kind: 'person',
          body: {
            text: evalCase.prompt,
            context: nowLine(payload.ui?.timezone),
            ...(activeAgent ? { agent: activeAgent.id } : {}),
          },
        },
      ],
      'idle',
      at,
    );

    const session: ToolSession = {
      loop: params.loop,
      app: params.app.id,
      payload,
      assistant: runAssistant,
      catalog,
      signal: params.signal,
      ...(runAssistant.memory
        ? { store: ephemeral.store, owner: params.owner, agentId: activeAgent?.id ?? '', canWriteSharedMemory: canWriteShared }
        : {}),
    };

    let answerText = '';
    const emit = (event: string, data: unknown) => {
      if (event === 'text' && data && typeof data === 'object' && 'text' in data) {
        answerText += String((data as { text: unknown }).text ?? '');
      }
    };

    const caseModel = resolveAssistantModel(runAssistant) ?? model;
    await continueTurn({
      store: ephemeral.store,
      owner: params.owner,
      conversation: 'eval-conv',
      model: caseModel,
      resolveModel: resolveAssistantModel,
      assistant: runAssistant,
      baseAssistant,
      ...(activeAgent ? { activeAgent } : {}),
      ...(viewerRoles ? { viewerRoles } : {}),
      system,
      tools,
      session,
      emit,
    });

    const durationMs = Math.max(1, Date.now() - startMs);
    const trace = summarizeTrace(ephemeral.events, { durationMs });
    if (!answerText.trim()) {
      answerText = trace.spans
        .filter((s) => s.kind === 'answer' && s.summary)
        .map((s) => s.summary!)
        .join('\n');
    }

    const failures: string[] = [];
    const exp = evalCase.expect;
    if (exp.answerMatches !== undefined && !answerText.toLowerCase().includes(exp.answerMatches.toLowerCase())) {
      failures.push(`Answer did not include "${exp.answerMatches}".`);
    }
    const calledTools = new Set(trace.spans.filter((s) => s.kind === 'tool').map((s) => s.name));
    const succeededTools = new Set(trace.spans.filter((s) => s.kind === 'tool' && s.status === 'ok').map((s) => s.name));
    for (const expectedTool of exp.expectedTools ?? []) {
      if (!calledTools.has(expectedTool)) failures.push(`Expected tool "${expectedTool}" to be called.`);
    }
    for (const forbiddenTool of exp.forbiddenTools ?? []) {
      if (succeededTools.has(forbiddenTool)) failures.push(`Forbidden tool "${forbiddenTool}" succeeded.`);
    }
    const emittedBlocks = new Set(
      trace.spans.filter((s) => s.kind === 'block').map((s) => (s.name.startsWith('custom:') ? s.name.slice('custom:'.length) : s.name)),
    );
    for (const expectedBlock of exp.expectedBlocks ?? []) {
      if (!emittedBlocks.has(expectedBlock)) failures.push(`Expected block "${expectedBlock}" to be emitted.`);
    }
    if (exp.expectCitations && trace.citationsCount < 1) {
      failures.push('Expected at least one verified knowledge citation.');
    }
    if (exp.expectReasoning && trace.reasoningChars < 1 && !trace.spans.some((s) => s.kind === 'reasoning')) {
      failures.push('Expected model reasoning trace, but none was recorded.');
    }
    const totalTokens = trace.totalTokens || ephemeral.tokens();
    if (exp.maxTokens !== undefined && totalTokens > exp.maxTokens) {
      failures.push(`Consumed ${totalTokens} tokens, exceeding maxTokens=${exp.maxTokens}.`);
    }
    if (exp.maxSteps !== undefined && trace.totalSteps > exp.maxSteps) {
      failures.push(`Took ${trace.totalSteps} tool steps, exceeding maxSteps=${exp.maxSteps}.`);
    }

    caseReports.push({
      id: evalCase.id,
      label: evalCase.label,
      ...(evalCase.description ? { description: evalCase.description } : {}),
      ...(evalCase.agent ? { agent: evalCase.agent } : {}),
      passed: failures.length === 0,
      failures,
      answer: answerText.trim(),
      durationMs,
      trace: {
        ...trace,
        totalTokens,
      },
    });
  }

  const total = caseReports.length;
  const passed = caseReports.filter((c) => c.passed).length;
  const meanTokens = total ? Math.round(caseReports.reduce((sum, c) => sum + c.trace.totalTokens, 0) / total) : 0;
  const meanDurationMs = total ? Math.round(caseReports.reduce((sum, c) => sum + c.durationMs, 0) / total) : 0;
  const totalCostUsd = Math.round(caseReports.reduce((sum, c) => sum + c.trace.estimatedCostUsd, 0) * 1_000_000) / 1_000_000;

  return {
    appId: params.app.id,
    ranAt: new Date().toISOString(),
    total,
    passed,
    failed: total - passed,
    passRate: total ? Number((passed / total).toFixed(4)) : 0,
    meanTokens,
    meanDurationMs,
    totalCostUsd,
    cases: caseReports,
  };
}
