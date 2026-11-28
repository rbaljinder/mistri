/**
 * Durable background agent runner and live event fan-out hub.
 *
 * Each background run owns a real durable conversation in `__mistri_assistant_conversation`
 * (`__mistri_assistant_event`), so every reasoning trace, tool step, block, knowledge citation,
 * memory update, delegation, and approval proposal persists identically to interactive turns
 * and can be replayed or opened in chat at any time.
 *
 * Unlike interactive `/api/assistant/turn`, execution is decoupled from the originating HTTP
 * response via its own `AbortController`: `POST /api/assistant/runs` returns `202 Accepted`
 * immediately while `continueTurn()` runs asynchronously under the caller's verified loopback
 * authority (`loop`), broadcasting live events to any connected Run Monitor SSE subscribers.
 */
import type { AssistantOwner, AssistantStore, RunStatus, StoredRun } from '../../adapters/assistant/assistantStore.js';
import type { AppAssistant, AppAssistantAgent } from '../../shared/appAssistant.js';
import type { AssistantModel, ModelTool } from './assistantModel.js';
import type { ToolSession } from './assistantTools.js';
import { continueTurn, type Emit } from './assistantTurn.js';

interface ActiveEntry {
  controller: AbortController;
  subscribers: Set<Emit>;
}

const activeRuns = new Map<string, ActiveEntry>();

const runKey = (owner: AssistantOwner, runId: string) => JSON.stringify([owner.app, owner.tenant, owner.account, runId]);

interface LaunchRunParams {
  store: AssistantStore;
  owner: AssistantOwner;
  run: StoredRun;
  model: AssistantModel;
  assistant: AppAssistant;
  baseAssistant?: AppAssistant;
  activeAgent?: AppAssistantAgent;
  viewerRoles?: readonly string[];
  system: string;
  tools: readonly ModelTool[];
  createSession: (signal: AbortSignal) => ToolSession;
  effort?: AppAssistant['effort'];
  tokensPerTenantPerDay?: number;
  withdrawn?: () => Promise<string | undefined>;
}

/** Whether a background run is currently executing inside this process. */
export function isBackgroundRunLive(owner: AssistantOwner, runId: string): boolean {
  return activeRuns.has(runKey(owner, runId));
}

/** Attach an SSE listener to an active background run. Returns an unsubscribe handle, or `null` if not live. */
export function subscribeBackgroundRun(owner: AssistantOwner, runId: string, listener: Emit): (() => void) | null {
  const entry = activeRuns.get(runKey(owner, runId));
  if (!entry) return null;
  entry.subscribers.add(listener);
  return () => {
    entry.subscribers.delete(listener);
  };
}

/** Cancel a running or awaiting background run. Aborts in-flight model/tool calls and marks the run `cancelled`. */
export async function cancelBackgroundRun(store: AssistantStore, owner: AssistantOwner, runId: string): Promise<StoredRun | null> {
  const existing = await store.getRun(owner, runId);
  if (!existing) return null;
  const entry = activeRuns.get(runKey(owner, runId));
  if (entry) {
    entry.controller.abort();
  }
  if (existing.status === 'completed' || existing.status === 'failed' || existing.status === 'cancelled') {
    return existing;
  }
  const now = new Date().toISOString();
  const updated = await store.updateRun(
    owner,
    runId,
    { status: 'cancelled', summary: existing.summary || 'Cancelled.', finishedAt: now },
    now,
  );
  if (entry && updated) {
    for (const sub of entry.subscribers) {
      sub('run_status', { run: { ...updated, live: false } });
      sub('done', { state: 'cancelled' });
    }
  }
  return updated;
}

/**
 * Start or resume a durable background run asynchronously.
 * Returns immediately once the run is registered in `activeRuns`; execution continues in the background
 * until completion, approval checkpoint (`awaiting`), failure, or explicit cancellation.
 */
export function launchBackgroundRun(params: LaunchRunParams): void {
  const { store, owner, run } = params;
  const key = runKey(owner, run.id);
  const controller = new AbortController();
  const entry: ActiveEntry = { controller, subscribers: new Set() };
  activeRuns.set(key, entry);

  const broadcast: Emit = (event, data) => {
    for (const sub of entry.subscribers) {
      try {
        sub(event, data);
      } catch {
        /* A closed subscriber never disrupts the background run. */
      }
    }
  };

  let steps = run.steps;
  let tokens = run.tokens;
  let textBuf = '';
  let errorMessage: string | undefined;
  let awaitingApproval = false;

  const emit: Emit = (event, raw) => {
    const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    if (event === 'step') steps += 1;
    else if (event === 'text' && typeof data.delta === 'string') textBuf += data.delta;
    else if (event === 'error' && typeof data.message === 'string') errorMessage = data.message;
    else if (event === 'done') {
      if (data.state === 'awaiting') awaitingApproval = true;
      if (typeof data.tokens === 'number' && Number.isFinite(data.tokens)) tokens += data.tokens;
      // Hold back the final `done` until `updateRun` has persisted the terminal/awaiting status below.
      return;
    }
    broadcast(event, raw);
  };

  void (async () => {
    try {
      const startedAt = new Date().toISOString();
      const runningRow = await store.updateRun(owner, run.id, { status: 'running', finishedAt: '' }, startedAt);
      if (runningRow) broadcast('run_status', { run: { ...runningRow, live: true } });

      const session = params.createSession(controller.signal);
      await continueTurn({
        store,
        owner,
        conversation: run.conversation,
        model: params.model,
        assistant: params.assistant,
        baseAssistant: params.baseAssistant,
        ...(params.activeAgent ? { activeAgent: params.activeAgent } : {}),
        ...(params.viewerRoles ? { viewerRoles: params.viewerRoles } : {}),
        system: params.system,
        tools: params.tools,
        session,
        emit,
        ...(params.effort ? { effort: params.effort } : {}),
        ...(params.tokensPerTenantPerDay === undefined ? {} : { tokensPerTenantPerDay: params.tokensPerTenantPerDay }),
        ...(params.withdrawn ? { withdrawn: params.withdrawn } : {}),
      });

      const endedAt = new Date().toISOString();
      const finalStatus: RunStatus = controller.signal.aborted
        ? 'cancelled'
        : errorMessage
          ? 'failed'
          : awaitingApproval
            ? 'awaiting'
            : 'completed';
      const cleanText = textBuf
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[\d+\]/g, '')
        .replace(/^\s*[-*]\s+/gm, '')
        .replace(/\s+/g, ' ')
        .replace(/\s+([.,;:!?])/g, '$1')
        .trim();
      const summary =
        finalStatus === 'failed'
          ? (errorMessage ?? 'The run could not complete.')
          : finalStatus === 'cancelled'
            ? cleanText.slice(0, 600) || 'Cancelled.'
            : finalStatus === 'awaiting'
              ? cleanText.slice(0, 600) || 'Waiting for your confirmation.'
              : cleanText.slice(0, 600) || 'Completed.';
      const finalRow = await store.updateRun(
        owner,
        run.id,
        {
          status: finalStatus,
          steps,
          tokens,
          summary,
          finishedAt: finalStatus === 'awaiting' ? '' : endedAt,
        },
        endedAt,
      );
      if (finalRow) broadcast('run_status', { run: { ...finalRow, live: false } });
      broadcast('done', { state: finalStatus, tokens });
    } catch (error) {
      const endedAt = new Date().toISOString();
      const finalStatus: RunStatus = controller.signal.aborted ? 'cancelled' : 'failed';
      const msg =
        finalStatus === 'cancelled'
          ? 'Cancelled.'
          : error instanceof Error && error.message
            ? error.message.slice(0, 500)
            : 'The background run failed.';
      const finalRow = await store
        .updateRun(owner, run.id, { status: finalStatus, steps, tokens, summary: msg, finishedAt: endedAt }, endedAt)
        .catch(() => null);
      if (finalRow) broadcast('run_status', { run: { ...finalRow, live: false } });
      broadcast('done', { state: finalStatus });
    } finally {
      activeRuns.delete(key);
    }
  })();
}
