/**
 * Scheduled (cron) and event-triggered (record create/update) background agent runs.
 *
 * Security & authority model:
 * - Every automated run executes strictly under a verified owner's detached loopback session,
 *   preserving row policies, column visibility, hidden columns, and action grants identically
 *   to interactive turns and manual background runs.
 * - Schedules track `last_slot` per `(app, tenant, account, schedule_id)` in `__mistri_assistant_automation`,
 *   guaranteeing idempotent at-most-once execution per cron minute slot.
 * - Record-change triggers fire asynchronously after `/api/insert` or `/api/update` commits,
 *   respect per-owner enablement toggles, role gates, field filters, concurrency caps, and
 *   per-record cooldown windows, and never block or fail the originating record write.
 */
import { canWriteSharedMemory, resolveAgentAssistant, type AppAssistant } from '../../shared/appAssistant.js';
import type { AssistantOwner, AssistantStore, StoredRun } from '../../adapters/assistant/assistantStore.js';
import type { AppDef } from '../../shared/appModel.js';
import type { AppPayloadApp } from '../../shared/appPayload.js';
import type { AppHost } from '../app/apps.js';
import { appForConnection } from '../app/apps.js';
import { latestSlot, nextSlot, parseEvery } from '../jobs/jobSchedule.js';
import { catalogFromPayload, nowLine, systemPrompt, toolSpecs } from './assistantCatalog.js';
import { resolveExternalToolsWithMcp } from './assistantExternal.js';
import { assistantModel, resolveAssistantModel } from './assistantModel.js';
import { launchBackgroundRun } from './assistantRuns.js';
import { assistantStoreFor } from './assistantStores.js';
import type { ToolSession } from './assistantTools.js';
import type { CommandProposalRow } from '../../adapters/commands/commandJournalTypes.js';
import type { ProposalDraft } from '../commands/proposals.js';
import { createAssistantProposal } from '../http/assistantProposal.js';
import type { ServerResponse } from 'node:http';
import type { PostContext, RequestContext } from '@mistriwork/engine/server/http/context.js';
import type { Loop } from '@mistriwork/engine/server/http/firstPaint.js';
import { findTable } from '@mistriwork/engine/shared/schema.js';

/** Current wall-clock time in ms, honoring MISTRI_CLOCK in deterministic tests and demos. */
export function automationNowMs(): number {
  const clock = process.env.MISTRI_CLOCK;
  if (clock) {
    const parsed = Date.parse(clock);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

/** Next matching cron instant ISO string strictly after `afterMs`, or null. */
export function nextScheduleRunIso(every: string, timezone: string, afterMs = automationNowMs()): string | null {
  try {
    const parsed = parseEvery(every, timezone);
    const slot = nextSlot(parsed, afterMs);
    return slot === undefined ? null : new Date(slot).toISOString();
  } catch {
    return null;
  }
}

/** Most recent matching cron minute slot ISO string at or before `nowMs`, or null. */
function latestScheduleSlotIso(every: string, timezone: string, nowMs = automationNowMs()): string | null {
  try {
    const parsed = parseEvery(every, timezone);
    const slot = latestSlot(parsed, nowMs);
    return slot === undefined ? null : new Date(slot).toISOString();
  } catch {
    return null;
  }
}

interface AutomatedDispatchParams {
  store: AssistantStore;
  owner: AssistantOwner;
  app: AppDef;
  bgLoop: Loop;
  viewerRoles?: readonly string[];
  title: string;
  prompt: string;
  source: string;
  agentId?: string;
  propose?: (draft: ProposalDraft) => Promise<CommandProposalRow>;
  tokensPerTenantPerDay?: number;
  withdrawn?: () => Promise<string | undefined>;
  automation?: { kind: 'schedule' | 'trigger'; id: string; slot?: string; enabled?: boolean };
  /** When true (signed inbound webhooks), fall back to a zero-resource read-only payload if no user session exists. */
  allowWebhookFallback?: boolean;
  nowMs?: number;
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
 * Dispatch a scheduled or event-triggered background run under the owner's detached loopback authority.
 * Returns the created `StoredRun`, or `null` if no model is configured, concurrency cap is full, or viewer access is refused.
 */
export async function dispatchAutomatedRun(params: AutomatedDispatchParams): Promise<StoredRun | null> {
  const model = assistantModel();
  const assistant = params.app.assistant;
  const bgCfg = assistant?.backgroundRuns;
  if (!model || !assistant || !bgCfg) return null;

  const active = await params.store.countActiveRuns(params.owner);
  if (active >= bgCfg.maxConcurrent) return null;

  const prepSignal = new AbortController().signal;
  let payload = await servedToLoop(params.bgLoop, params.app.id, prepSignal);
  let tables: string[] = [];
  let viewerRoles: readonly string[] | undefined;
  if (payload) {
    tables = await tablesOfLoop(params.bgLoop, params.app.id, prepSignal);
    viewerRoles = params.viewerRoles ?? payload.viewerRoles;
  } else if (params.allowWebhookFallback) {
    // Authenticated app receiving a signed webhook with no user session: zero DB rows exposed, empty role set.
    payload = {
      id: params.app.id,
      name: params.app.name,
      resources: {},
      views: {},
      ...(params.app.ui ? { ui: params.app.ui as AppPayloadApp['ui'] } : {}),
    } as AppPayloadApp;
    viewerRoles = [];
  } else {
    return null;
  }

  let resolvedAgent: ReturnType<typeof resolveAgentAssistant>;
  try {
    resolvedAgent = resolveAgentAssistant(assistant, params.agentId, viewerRoles);
  } catch {
    return null;
  }

  const mergedExternal = await resolveExternalToolsWithMcp(
    resolvedAgent.assistant.externalTools,
    resolvedAgent.assistant.mcpServers,
    prepSignal,
  );
  const runAssistant: AppAssistant = {
    ...resolvedAgent.assistant,
    ...(mergedExternal ? { externalTools: mergedExternal } : {}),
    limits: { ...resolvedAgent.assistant.limits, steps: bgCfg.maxSteps },
  };
  const activeAgent = resolvedAgent.agent;
  const canWriteShared = canWriteSharedMemory(runAssistant.memory, viewerRoles ?? []);
  const memories = runAssistant.memory
    ? await params.store.memories(params.owner, {
        scopes: runAssistant.memory.scopes,
        agent: activeAgent?.id,
        limit: 40,
      })
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
  const createSession = (signal: AbortSignal): ToolSession => ({
    loop: params.bgLoop,
    app: params.app.id,
    payload,
    assistant: runAssistant,
    catalog,
    signal,
    ...(runAssistant.memory
      ? { store: params.store, owner: params.owner, agentId: activeAgent?.id ?? '', canWriteSharedMemory: canWriteShared }
      : {}),
    ...(params.propose ? { propose: params.propose } : {}),
  });

  const at = new Date(params.nowMs ?? automationNowMs()).toISOString();
  const conv = await params.store.create(params.owner, params.title, at);
  await params.store.append(
    params.owner,
    conv.id,
    [
      {
        kind: 'person',
        body: {
          text: params.prompt,
          context: nowLine(payload.ui?.timezone),
          ...(activeAgent ? { agent: activeAgent.id } : {}),
        },
      },
    ],
    'idle',
    at,
  );
  const run = await params.store.createRun(
    params.owner,
    {
      conversation: conv.id,
      title: params.title,
      prompt: params.prompt,
      agent: activeAgent?.id ?? '',
      source: params.source,
    },
    at,
  );
  if (params.automation) {
    await params.store.upsertAutomation(
      params.owner,
      {
        kind: params.automation.kind,
        automationId: params.automation.id,
        ...(params.automation.enabled === undefined ? {} : { enabled: params.automation.enabled }),
        ...(params.automation.slot ? { lastSlot: params.automation.slot } : {}),
        lastRunId: run.id,
        lastRunAt: at,
      },
      at,
    );
  }
  launchBackgroundRun({
    store: params.store,
    owner: params.owner,
    run,
    model: resolveAssistantModel(runAssistant) ?? model,
    assistant: runAssistant,
    baseAssistant: assistant,
    ...(activeAgent ? { activeAgent } : {}),
    ...(viewerRoles ? { viewerRoles } : {}),
    system,
    tools,
    createSession,
    ...(params.tokensPerTenantPerDay === undefined ? {} : { tokensPerTenantPerDay: params.tokensPerTenantPerDay }),
    ...(params.withdrawn ? { withdrawn: params.withdrawn } : {}),
  });
  return run;
}

/** Check all enabled schedules for an owner at `nowMs` and fire any whose latest matching cron slot has not run yet. */
export async function tickSchedulesForOwner(params: {
  store: AssistantStore;
  owner: AssistantOwner;
  app: AppDef;
  bgLoop: () => Loop;
  viewerRoles?: readonly string[];
  propose?: (draft: ProposalDraft) => Promise<CommandProposalRow>;
  tokensPerTenantPerDay?: number;
  withdrawn?: () => Promise<string | undefined>;
  nowMs?: number;
  /** Maximum age of a missed slot in ms to catch up (default 15 minutes). */
  catchupWindowMs?: number;
}): Promise<StoredRun[]> {
  const schedules = params.app.assistant?.backgroundRuns?.schedules ?? [];
  if (!schedules.length || !assistantModel()) return [];
  const nowMs = params.nowMs ?? automationNowMs();
  const catchupMs = params.catchupWindowMs ?? 15 * 60_000;
  const states = await params.store.listAutomations(params.owner);
  const stateById = new Map(states.filter((s) => s.kind === 'schedule').map((s) => [s.automationId, s]));
  const fired: StoredRun[] = [];

  for (const schedule of schedules) {
    if (schedule.roles && params.viewerRoles && !params.viewerRoles.some((r) => schedule.roles!.includes(r))) continue;
    const saved = stateById.get(schedule.id);
    const enabled = saved ? saved.enabled : schedule.enabled;
    if (!enabled) continue;
    const appTz = typeof params.app.ui?.timezone === 'string' ? params.app.ui.timezone : 'UTC';
    const tz = schedule.timezone ?? appTz;
    const slotIso = latestScheduleSlotIso(schedule.every, tz, nowMs);
    if (!slotIso) continue;
    const slotMs = Date.parse(slotIso);
    if (nowMs - slotMs > catchupMs) continue;
    if (saved?.lastSlot && saved.lastSlot >= slotIso) continue;

    const run = await dispatchAutomatedRun({
      store: params.store,
      owner: params.owner,
      app: params.app,
      bgLoop: params.bgLoop(),
      ...(params.viewerRoles ? { viewerRoles: params.viewerRoles } : {}),
      title: schedule.label,
      prompt: schedule.prompt,
      source: `schedule:${schedule.id}`,
      ...(schedule.agent ? { agentId: schedule.agent } : {}),
      ...(params.propose ? { propose: params.propose } : {}),
      ...(params.tokensPerTenantPerDay === undefined ? {} : { tokensPerTenantPerDay: params.tokensPerTenantPerDay }),
      ...(params.withdrawn ? { withdrawn: params.withdrawn } : {}),
      automation: { kind: 'schedule', id: schedule.id, slot: slotIso, enabled: true },
      nowMs,
    });
    if (run) fired.push(run);
  }
  return fired;
}

/* Lightweight in-process background schedule ticker (unref'd so tests/CLI exit cleanly). */
interface RegisteredScheduleOwner {
  store: AssistantStore;
  owner: AssistantOwner;
  app: AppDef;
  bgLoop: () => Loop;
  viewerRoles?: readonly string[];
  propose?: (draft: ProposalDraft) => Promise<CommandProposalRow>;
  tokensPerTenantPerDay?: number;
  withdrawn?: () => Promise<string | undefined>;
}
const scheduleOwners = new Map<string, RegisteredScheduleOwner>();
let tickerTimer: ReturnType<typeof setInterval> | undefined;

export function registerScheduleOwner(entry: RegisteredScheduleOwner): void {
  if (!entry.app.assistant?.backgroundRuns?.schedules.length) return;
  const key = JSON.stringify([entry.owner.app, entry.owner.tenant, entry.owner.account]);
  scheduleOwners.set(key, entry);
  if (!tickerTimer) {
    tickerTimer = setInterval(() => {
      for (const item of scheduleOwners.values()) {
        void tickSchedulesForOwner(item).catch(() => {
          /* Background schedule tick errors are isolated per owner. */
        });
      }
    }, 30_000);
    tickerTimer.unref?.();
  }
}

/* Record-change trigger hook registered from handler.ts to avoid any module import cycle. */
type DetachedLoopFactory = (ctx: RequestContext) => Loop;
let recordLoopFactory: DetachedLoopFactory | undefined;
const writeRequestContexts = new WeakMap<ServerResponse, RequestContext>();

export function registerAssistantRecordLoopFactory(factory: DetachedLoopFactory): void {
  recordLoopFactory = factory;
}

/** Associate a `RequestContext` with its `ServerResponse` before `postData` runs so `APP_WRITES.after.write` has verified session identity. */
export function bindAssistantWriteContext(ctx: RequestContext): void {
  if (ctx.path === '/api/insert' || ctx.path === '/api/update') {
    writeRequestContexts.set(ctx.res, ctx);
  }
}

const triggerCooldowns = new Map<string, number>();

function hostForPost(post: PostContext): AppHost | undefined {
  if (!post.appHosts?.length) return undefined;
  return appForConnection(post.appHosts, post.connection, post.registry.configOf(post.connection)?.name);
}

function evaluateRecordTriggers(params: {
  ctx: RequestContext;
  host: AppHost | undefined;
  eventKind: 'create' | 'update';
  tableId: string;
  key: Record<string, unknown>;
  values: unknown;
}): void {
  if (!recordLoopFactory || !assistantModel()) return;
  const { ctx, host, eventKind, tableId, key, values } = params;
  const app = host?.app.app;
  const triggers = app?.assistant?.backgroundRuns?.triggers;
  if (!host || !app || !triggers?.length) return;

  if (app.auth && !ctx.identity.id) return;
  const viewerRoles = (ctx.identity.role ?? '')
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean);
  const offered = app.assistant!.roles;
  if (offered && !viewerRoles.some((role) => offered.includes(role))) return;

  const rawValues = values && typeof values === 'object' && !Array.isArray(values) ? (values as Record<string, unknown>) : {};
  const changedFields = Object.keys(rawValues);

  const matching = triggers.filter((trigger) => {
    if (trigger.resource !== tableId) return false;
    if (!trigger.on.includes(eventKind)) return false;
    if (trigger.roles && !viewerRoles.some((role) => trigger.roles!.includes(role))) return false;
    if (eventKind === 'update' && trigger.fields?.length) {
      if (!changedFields.some((field) => trigger.fields!.includes(field))) return false;
    }
    return true;
  });
  if (!matching.length) return;

  // Capture detached loopback synchronously before the HTTP response finishes.
  const bgLoop = recordLoopFactory(ctx);
  const owner: AssistantOwner = {
    app: app.id,
    tenant: '',
    account: ctx.identity.id ?? (ctx.identity.who?.trim() || 'local'),
  };
  const recordKeyJson = JSON.stringify(key);
  const nowMs = automationNowMs();

  void (async () => {
    let store: AssistantStore;
    try {
      store = await assistantStoreFor(ctx.registry, host);
    } catch {
      return;
    }
    for (const trigger of matching) {
      const saved = await store.getAutomation(owner, 'trigger', trigger.id);
      const enabled = saved ? saved.enabled : trigger.enabled;
      if (!enabled) continue;

      const cooldownKey = JSON.stringify([owner.app, owner.tenant, owner.account, trigger.id, recordKeyJson]);
      const lastFiredAt = triggerCooldowns.get(cooldownKey);
      if (trigger.cooldownSeconds > 0 && lastFiredAt !== undefined && nowMs - lastFiredAt < trigger.cooldownSeconds * 1000) {
        continue;
      }
      triggerCooldowns.set(cooldownKey, nowMs);

      const changeSummary = eventKind === 'update' && changedFields.length ? ` (updated fields: ${changedFields.join(', ')})` : '';
      const enrichedPrompt = `Triggered automatically on ${tableId} ${eventKind} ${recordKeyJson}${changeSummary}.\n\n${trigger.prompt}`;

      await dispatchAutomatedRun({
        store,
        owner,
        app,
        bgLoop,
        ...(app.auth ? { viewerRoles } : {}),
        title: trigger.label,
        prompt: enrichedPrompt,
        source: `trigger:${trigger.id}`,
        ...(trigger.agent ? { agentId: trigger.agent } : {}),
        propose: (draft) => createAssistantProposal(ctx, draft),
        automation: { kind: 'trigger', id: trigger.id, enabled: true },
        nowMs,
      });
    }
  })().catch(() => {
    /* Automatic trigger failures never disrupt the committed record write. */
  });
}

/**
 * Fire-and-forget hook invoked by `APP_WRITES.after.write` after `/api/insert` or `/api/update` commits.
 */
export function onAppRecordWritten(post: PostContext, table: string, key: Record<string, unknown>): void {
  const eventKind = post.path === '/api/insert' ? 'create' : post.path === '/api/update' ? 'update' : null;
  if (!eventKind) return;
  const ctx = writeRequestContexts.get(post.res);
  if (!ctx) return;
  const tableId = findTable(post.schema, table)?.id ?? table;
  evaluateRecordTriggers({
    ctx,
    host: hostForPost(post),
    eventKind,
    tableId,
    key,
    values: post.body.values,
  });
}

/**
 * Fire-and-forget hook invoked by `scopedWriteRoutes` after `/api/insert` or `/api/update` commits
 * on a row-policy (authenticated) App.
 */
export function onScopedRecordWritten(
  ctx: RequestContext,
  host: AppHost | undefined,
  eventKind: 'create' | 'update',
  table: string,
  key: Record<string, unknown>,
  values: unknown,
): void {
  const schema = ctx.policyContext?.schema;
  const tableId = (schema ? findTable(schema, table)?.id : undefined) ?? table;
  evaluateRecordTriggers({ ctx, host, eventKind, tableId, key, values });
}
