/**
 * `/api/assistant…`: the signed-in person's conversations with an App's
 * assistant (docs/assistant.md).
 *
 *   GET  /api/assistant?app=               their conversations, newest first
 *   GET  /api/assistant/conversation?app=&id=   one, as the panel draws it
 *   POST /api/assistant/turn               say something (or edit, or retry): a stream
 *   POST /api/assistant/resolve            a proposal's outcome, and the turn continues: a stream
 *   POST /api/assistant/acted              a verb the person ran from a card or a row the conversation drew
 *   POST /api/assistant/about              the record a page hands the panel: its key and label, if the person may open it
 *   GET  /api/assistant/search?app=&q=     their conversations whose words hold q, each with a line of them
 *   GET  /api/assistant/memories?app=      durable memories visible to this person (personal + shared)
 *   POST /api/assistant/memories           save or edit a memory (person or shared workspace)
 *   POST /api/assistant/memories/delete    forget one memory
 *   GET  /api/assistant/runs?app=          durable background runs for this person, newest first
 *   POST /api/assistant/runs               launch a background run (returns 202 Accepted)
 *   GET  /api/assistant/runs/detail?app=&id=  one run with its persisted conversation trace
 *   GET  /api/assistant/runs/stream?app=&id=  live SSE stream attached to a running background run
 *   POST /api/assistant/runs/cancel        cancel an active or awaiting background run
 *   POST /api/assistant/runs/resolve       record a proposal outcome and resume a paused background run
 *   POST /api/assistant/runs/resume        retry a failed, cancelled, or interrupted background run
 *   POST /api/assistant/runs/delete        cancel (if active) and delete a background run record
 *   POST /api/assistant/rename             name one again
 *   POST /api/assistant/delete             forget one
 *
 * Answered before the row policy wraps the request: these routes read no
 * rows. Everything the assistant reads is a request back through `handle`
 * with this request's own headers (the loop), so each of those is gated,
 * granted and row-scoped as the page's own fetch is. Whose conversations they
 * are comes from the verified session alone; no body names an account. A
 * tenant App's host answers the same routes through `answerAssistant`, on the
 * tab's context lease (tenant/tenantAssistant.ts).
 */
import { ASSISTANT_EFFORTS, canWriteSharedMemory, resolveAgentAssistant, type AppAssistant } from '../../shared/appAssistant.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AssistantOwner, AssistantStore } from '../../adapters/assistant/assistantStore.js';
import type { AppDef } from '../../shared/appModel.js';
import type { AppPayloadApp } from '../../shared/appPayload.js';
import type { AppHost } from '../app/apps.js';
import { catalogFromPayload, mayRunAction, nowLine, systemPrompt, toolSpecs } from '../assistant/assistantCatalog.js';
import { assistantModel } from '../assistant/assistantModel.js';
import { cancelBackgroundRun, isBackgroundRunLive, launchBackgroundRun, subscribeBackgroundRun } from '../assistant/assistantRuns.js';
import { assistantStoreFor, storeUnavailableReply } from '../assistant/assistantStores.js';
import { aboutRecord, recordContext, type ToolSession } from '../assistant/assistantTools.js';
import type { CommandProposalRow } from '../../adapters/commands/commandJournalTypes.js';
import type { ProposalDraft } from '../commands/proposals.js';
import { createAssistantProposal } from './assistantProposal.js';
import {
  actedNote,
  continueTurn,
  itemsOf,
  pendingProposal,
  reviewOutcome,
  undecidedReviews,
  type Acted,
  type Emit,
  type ReviewOutcomes,
} from '../assistant/assistantTurn.js';
import { COMMAND_ROUTES } from '../../shared/commandRoutes.js';
import type { RequestContext } from '@mistriwork/engine/server/http/context.js';
import type { Loop } from '@mistriwork/engine/server/http/firstPaint.js';
import { HttpError, readJson, send } from '@mistriwork/engine/server/http/reply.js';

export const ASSISTANT_PATHS: ReadonlySet<string> = new Set([
  '/api/assistant',
  '/api/assistant/conversation',
  '/api/assistant/turn',
  '/api/assistant/resolve',
  '/api/assistant/acted',
  '/api/assistant/delete',
  '/api/assistant/rename',
  '/api/assistant/search',
  '/api/assistant/about',
  '/api/assistant/memories',
  '/api/assistant/memories/delete',
  '/api/assistant/runs',
  '/api/assistant/runs/detail',
  '/api/assistant/runs/stream',
  '/api/assistant/runs/cancel',
  '/api/assistant/runs/resolve',
  '/api/assistant/runs/resume',
  '/api/assistant/runs/delete',
]);
const SAID: Record<string, readonly string[]> = {
  '/api/assistant/turn': ['app', 'conversation', 'text', 'context', 'edit', 'retry', 'mode', 'effort', 'agent'],
  '/api/assistant/resolve': ['app', 'conversation', 'proposal', 'outcome', 'detail'],
  '/api/assistant/delete': ['app', 'conversation'],
  '/api/assistant/rename': ['app', 'conversation', 'title'],
  '/api/assistant/acted': ['app', 'conversation', 'resource', 'action', 'key', 'record', 'outcome', 'detail'],
  '/api/assistant/about': ['app', 'resource', 'id'],
  '/api/assistant/memories': ['app', 'content', 'scope', 'id', 'agent'],
  '/api/assistant/memories/delete': ['app', 'id'],
  '/api/assistant/runs': ['app', 'prompt', 'preset', 'title', 'agent', 'effort'],
  '/api/assistant/runs/cancel': ['app', 'id'],
  '/api/assistant/runs/resolve': ['app', 'id', 'proposal', 'outcome', 'detail'],
  '/api/assistant/runs/resume': ['app', 'id'],
  '/api/assistant/runs/delete': ['app', 'id'],
};
/* Refused alike whether the table is not theirs, the row is outside their rows or it is not there: which of the three
   is not the page's to learn, as a record's own address answers. */
const NOT_OPEN = 'That record is not one you can open, so the assistant cannot be told about it.';
const NO_RECORD = 'The assistant here takes no record as its context: its placement leaves out "record".';
const MAX_TEXT = 4000;

/** A line of the words a search found, around where it found them. */
function snippetOf(text: string, words: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(words.replace(/\s+/g, ' ').trim().toLowerCase());
  if (at < 0) return flat.slice(0, 100);
  // On word edges, so the line never opens or closes mid-word.
  let start = Math.max(0, at - 24);
  if (start > 0) {
    const space = flat.indexOf(' ', start - 1);
    start = space >= 0 && space < at ? space + 1 : at;
  }
  let end = Math.min(flat.length, at + words.length + 72);
  if (end < flat.length) {
    const space = flat.lastIndexOf(' ', end);
    if (space > at + words.length) end = space;
  }
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`;
}

type Base = Omit<RequestContext, 'policyContext'>;

function personOf(ctx: Base, host: AppHost): AssistantOwner {
  const { identity } = ctx;
  const app = host.app.app;
  /* An App with sign-in is its people's; one without is the operator's local
     tool, whose one reader is whoever the proxy or the machine says. */
  if (app.auth && !identity.id) throw new HttpError(401, 'Sign in to use the assistant.');
  const roles = (identity.role ?? '').split(',').map((role) => role.trim());
  const offered = app.assistant!.roles;
  if (offered && !roles.some((role) => offered.includes(role))) throw new HttpError(403, 'The assistant is not offered to your role.');
  return { app: app.id, tenant: '', account: identity.id ?? (identity.who?.trim() || 'local') };
}

function stream(res: ServerResponse, open = true): Emit {
  if (open) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    res.flushHeaders();
  }
  return (event, data) => {
    if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

/** The App as this person is served it, asked as them. */
async function servedTo(loop: Loop, app: string, signal: AbortSignal): Promise<AppPayloadApp> {
  const answer = await loop('GET', `/api/app?app=${encodeURIComponent(app)}`, undefined, signal);
  const payload = (answer?.body as { app?: AppPayloadApp | null } | undefined)?.app;
  if (answer?.status !== 200 || !payload) throw new HttpError(403, 'This App is not open to you.');
  if (!payload.assistant) throw new HttpError(403, 'The assistant is not offered to you here.');
  return payload;
}

/** The tables this person's schema holds, asked as them: what the assistant may name. */
async function tablesOf(loop: Loop, app: string, signal: AbortSignal): Promise<string[]> {
  const answer = await loop('GET', `/api/schema?app=${encodeURIComponent(app)}`, undefined, signal);
  const tables = (answer?.body as { tables?: Array<{ id: string }> } | undefined)?.tables;
  return answer?.status === 200 && Array.isArray(tables) ? tables.map((table) => table.id) : [];
}

/**
 * What became of the stored proposals a conversation's cards name, asked as the person (so only those of commands
 * they are granted): approved or dismissed in the review queue, the conversation never heard, and a reload drew the
 * card live again. Nothing asked, or the ask refused, draws them as the events say.
 */
async function reviewsOf(loop: Loop, ids: readonly string[]): Promise<ReviewOutcomes | undefined> {
  if (!ids.length) return undefined;
  const answer = await loop('POST', COMMAND_ROUTES.proposals, { ids: [...new Set(ids)].slice(-50) });
  const rows = (answer?.body as { proposals?: Array<{ id: string; state: string }> } | undefined)?.proposals;
  if (answer?.status !== 200 || !Array.isArray(rows)) return undefined;
  const outcomes = new Map<string, NonNullable<ReturnType<typeof reviewOutcome>>>();
  for (const row of rows) {
    const outcome = reviewOutcome(row.state);
    if (outcome) outcomes.set(row.id, outcome);
  }
  return outcomes;
}

/** Who is asking, where their conversations are kept, and how their reads go: everything a route needs that
 * differs between an ordinary App (below) and a tenant App's host (tenant/tenantAssistant.ts). */
interface AssistantScope {
  readonly app: AppDef;
  readonly owner: AssistantOwner;
  readonly store: AssistantStore;
  /** Verified viewer roles, used to enforce role-scoped named agents and subagents. */
  readonly roles?: readonly string[];
  /** A request back through the App's own routes, as this person: each read is gated and row-scoped there. */
  readonly loop: () => Loop;
  /** Detached loopback factory for background runs that outlive the originating 202 HTTP response. */
  readonly backgroundLoop?: () => Loop;
  /** A tenant App's: the platform owner's daily cap for one tenant. */
  readonly tokensPerTenantPerDay?: number;
  /** A tenant App's: asked before every model call; a reason ends the turn (the switch was turned off). */
  readonly withdrawn?: () => Promise<string | undefined>;
  /** Keeps a command's proposal for review as this person, under their grant and rows (assistantProposal.ts; a
   * tenant App's, tenantHttp.ts `propose`). */
  readonly propose?: (draft: ProposalDraft) => Promise<CommandProposalRow>;
}

export async function assistantRoutes(ctx: Base, loop: () => Loop, backgroundLoop?: () => Loop): Promise<boolean> {
  const { req, res, url, path, appHosts, registry } = ctx;
  if (!ASSISTANT_PATHS.has(path)) return false;
  await answerAssistant(req, res, url, path, async (appId) => {
    const host = (appHosts ?? []).find((each) => each.app.app.id === appId);
    if (!host?.app.app.assistant) throw new HttpError(404, 'This App has no assistant.');
    const owner = personOf(ctx, host);
    const roles = (ctx.identity.role ?? '')
      .split(',')
      .map((role) => role.trim())
      .filter(Boolean);
    let store: AssistantStore;
    try {
      store = await assistantStoreFor(registry, host);
    } catch (error) {
      throw storeUnavailableReply(error);
    }
    return {
      app: host.app.app,
      owner,
      store,
      roles: host.app.app.auth ? roles : undefined,
      loop,
      ...(backgroundLoop ? { backgroundLoop } : {}),
      propose: (draft) => createAssistantProposal(ctx, draft),
    };
  });
  return true;
}

/* What this process answers at once — a turn, or a proposal's outcome and the turn it continues: one at a time on a
   conversation, and two at a time for a person. Two turns on one conversation interleaved their events, and a person's
   turns in parallel each passed the daily cap before any of them was charged. Counted per process. */
const TURNS_PER_PERSON = 2;
const answering = new Set<string>();
const turnsOf = new Map<string, number>();

/** The last named agent chosen in a conversation's events, if any. */
function lastAgentOf(events: ReadonlyArray<{ kind: string; body: unknown }>): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.kind !== 'person') continue;
    const agent = (events[i]?.body as { agent?: unknown } | undefined)?.agent;
    if (typeof agent === 'string' && agent) return agent;
  }
  return undefined;
}

/** One assistant request, answered whole: `scopeOf` says whose it is, from the App the request names. */
export async function answerAssistant(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  scopeOf: (appId: unknown) => Promise<AssistantScope>,
): Promise<void> {
  res.setHeader('cache-control', 'no-store');
  const held: string[] = [];
  let person: string | undefined;
  try {
    const get = req.method === 'GET';
    if (!get && req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    const body = get ? {} : await readJson(req, 16 * 1024);
    if (!get && Object.keys(body).some((key) => !SAID[path]?.includes(key))) throw new HttpError(400, 'Invalid assistant request.');
    const scope = await scopeOf(get ? url.searchParams.get('app') : body.app);
    const { app, owner, store, loop } = scope;
    const assistant = app.assistant!;
    if (path === '/api/assistant') {
      send(res, 200, { conversations: await store.list(owner, 30), ready: Boolean(assistantModel()) });
      return;
    }
    const id = get ? url.searchParams.get('id') : body.conversation;
    if (path === '/api/assistant/conversation') {
      const conversation = typeof id === 'string' ? await store.get(owner, id) : null;
      if (!conversation) throw new HttpError(404, 'No such conversation.');
      const events = await store.events(owner, conversation.id);
      const activeAgentId = lastAgentOf(events);
      send(res, 200, {
        conversation,
        items: itemsOf(events, await reviewsOf(loop(), undecidedReviews(events)), { showReasoning: assistant.reasoning !== 'hidden' }),
        ...(pendingProposal(events) ? { awaiting: true } : {}),
        ...(activeAgentId ? { agent: activeAgentId } : {}),
      });
      return;
    }
    if (path === '/api/assistant/search') {
      const words = (url.searchParams.get('q') ?? '').trim();
      if (words.length > 100) throw new HttpError(400, 'Search for at most 100 characters.');
      const found = words ? await store.search(owner, words, 20) : [];
      send(res, 200, {
        conversations: found.map(({ conversation, text }) => ({ ...conversation, snippet: snippetOf(text, words) })),
      });
      return;
    }
    if (path === '/api/assistant/rename') {
      const title = typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim() : '';
      // eslint-disable-next-line no-control-regex
      if (!title || title.length > 200 || /[\u0000-\u001f\u007f]/.test(title)) throw new HttpError(400, 'A title is 1 to 200 characters.');
      if (typeof id !== 'string' || !(await store.rename(owner, id, title))) throw new HttpError(404, 'No such conversation.');
      send(res, 200, { renamed: true, title });
      return;
    }
    if (path === '/api/assistant/delete') {
      if (typeof id !== 'string' || !(await store.remove(owner, id))) throw new HttpError(404, 'No such conversation.');
      send(res, 200, { deleted: true });
      return;
    }
    if (path === '/api/assistant/memories' || path === '/api/assistant/memories/delete') {
      const memCfg = assistant.memory;
      if (!memCfg) throw new HttpError(404, 'Memory is not enabled for this assistant.');
      const roles =
        scope.roles ?? (memCfg.sharedRoles ? (await servedTo(loop(), app.id, new AbortController().signal)).viewerRoles : undefined) ?? [];
      const canWriteShared = canWriteSharedMemory(memCfg, roles);
      if (path === '/api/assistant/memories' && get) {
        const agentFilter = url.searchParams.get('agent')?.trim() || undefined;
        const memories = await store.memories(owner, { scopes: memCfg.scopes, agent: agentFilter, limit: 100 });
        send(res, 200, {
          memories,
          scopes: memCfg.scopes,
          maxItems: memCfg.maxItems,
          canWriteShared,
        });
        return;
      }
      if (path === '/api/assistant/memories') {
        const content = typeof body.content === 'string' ? body.content.replace(/\s+/g, ' ').trim() : '';
        // eslint-disable-next-line no-control-regex
        if (!content || content.length > 500 || /[\u0000-\u001f\u007f]/.test(content))
          throw new HttpError(400, 'A memory is 1 to 500 characters.');
        const defaultScope: 'person' | 'app' = memCfg.scopes.includes('person') ? 'person' : 'app';
        const memScope = body.scope === undefined ? defaultScope : body.scope;
        if (memScope !== 'person' && memScope !== 'app') throw new HttpError(400, 'Scope must be "person" or "app".');
        if (!memCfg.scopes.includes(memScope)) throw new HttpError(400, `Scope "${memScope}" is not enabled here.`);
        if (memScope === 'app' && !canWriteShared) throw new HttpError(403, 'You may not save shared workspace memory.');
        const memId = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : undefined;
        const agent = typeof body.agent === 'string' ? body.agent.trim().slice(0, 64) : '';
        const { memory, updated } = await store.remember(
          owner,
          { ...(memId ? { id: memId } : {}), scope: memScope, agent, content, source: 'person', maxItems: memCfg.maxItems },
          new Date().toISOString(),
        );
        send(res, 200, { memory, updated });
        return;
      }
      const memId = typeof body.id === 'string' ? body.id.trim() : '';
      if (!memId || !(await store.forget(owner, memId, { allowAppScope: canWriteShared }))) {
        throw new HttpError(404, 'No such memory.');
      }
      send(res, 200, { deleted: true });
      return;
    }
    if (path === '/api/assistant/runs' || path.startsWith('/api/assistant/runs/')) {
      const bgCfg = assistant.backgroundRuns;
      if (!bgCfg) throw new HttpError(404, 'Background runs are not enabled for this assistant.');
      const runLoopFactory = scope.backgroundLoop ?? loop;

      const prepareRunContext = async (agentId: string | undefined) => {
        const bgLoop = runLoopFactory();
        const prepSignal = new AbortController().signal;
        const payload = await servedTo(bgLoop, app.id, prepSignal);
        const viewerRoles = scope.roles ?? payload.viewerRoles;
        let resolvedAgent: ReturnType<typeof resolveAgentAssistant>;
        try {
          resolvedAgent = resolveAgentAssistant(assistant, agentId, viewerRoles);
        } catch (error) {
          throw new HttpError(403, error instanceof Error ? error.message : 'That agent is not offered to your role.');
        }
        const runAssistant: AppAssistant = {
          ...resolvedAgent.assistant,
          limits: { ...resolvedAgent.assistant.limits, steps: bgCfg.maxSteps },
        };
        const activeAgent = resolvedAgent.agent;
        const canWriteShared = canWriteSharedMemory(runAssistant.memory, viewerRoles ?? []);
        const memories = runAssistant.memory
          ? await store.memories(owner, {
              scopes: runAssistant.memory.scopes,
              agent: activeAgent?.id,
              limit: 40,
            })
          : undefined;
        const catalog = catalogFromPayload(
          payload,
          runAssistant,
          await tablesOf(bgLoop, app.id, prepSignal),
          activeAgent,
          runAssistant.memory ? { memories, canWriteSharedMemory: canWriteShared } : undefined,
        );
        const system = systemPrompt(catalog);
        const tools = toolSpecs(runAssistant, activeAgent, { canWriteSharedMemory: canWriteShared });
        const createSession = (signal: AbortSignal): ToolSession => ({
          loop: bgLoop,
          app: app.id,
          payload,
          assistant: runAssistant,
          catalog,
          signal,
          ...(runAssistant.memory ? { store, owner, agentId: activeAgent?.id ?? '', canWriteSharedMemory: canWriteShared } : {}),
          ...(scope.propose ? { propose: scope.propose } : {}),
        });
        return { payload, viewerRoles, runAssistant, activeAgent, system, tools, createSession };
      };

      if (path === '/api/assistant/runs' && get) {
        const runs = await store.listRuns(owner, 40);
        send(res, 200, {
          runs: runs.map((run) => ({ ...run, live: isBackgroundRunLive(owner, run.id) })),
          ready: Boolean(assistantModel()),
        });
        return;
      }
      if (path === '/api/assistant/runs/detail') {
        if (!get) throw new HttpError(405, 'Method not allowed.');
        const runId = url.searchParams.get('id')?.trim() ?? '';
        const run = runId ? await store.getRun(owner, runId) : null;
        if (!run) throw new HttpError(404, 'No such run.');
        const convEvents = await store.events(owner, run.conversation);
        const items = itemsOf(convEvents, await reviewsOf(loop(), undecidedReviews(convEvents)), {
          showReasoning: assistant.reasoning !== 'hidden',
        });
        send(res, 200, {
          run: { ...run, live: isBackgroundRunLive(owner, run.id) },
          items,
          ...(pendingProposal(convEvents) ? { awaiting: true } : {}),
        });
        return;
      }
      if (path === '/api/assistant/runs/stream') {
        if (!get) throw new HttpError(405, 'Method not allowed.');
        const runId = url.searchParams.get('id')?.trim() ?? '';
        const run = runId ? await store.getRun(owner, runId) : null;
        if (!run) throw new HttpError(404, 'No such run.');
        const emit = stream(res);
        const live = isBackgroundRunLive(owner, run.id);
        emit('run_status', { run: { ...run, live } });
        let unsubscribe: (() => void) | null = null;
        unsubscribe = subscribeBackgroundRun(owner, run.id, (event, data) => {
          emit(event, data);
          if (event === 'done') {
            unsubscribe?.();
            unsubscribe = null;
            if (!res.writableEnded) res.end();
          }
        });
        if (!unsubscribe) {
          emit('done', { state: run.status, tokens: run.tokens });
          res.end();
          return;
        }
        res.once('close', () => {
          unsubscribe?.();
          unsubscribe = null;
        });
        return;
      }
      if (path === '/api/assistant/runs/cancel') {
        const runId = typeof body.id === 'string' ? body.id.trim() : '';
        const cancelled = runId ? await cancelBackgroundRun(store, owner, runId) : null;
        if (!cancelled) throw new HttpError(404, 'No such run.');
        send(res, 200, { run: { ...cancelled, live: false } });
        return;
      }
      if (path === '/api/assistant/runs/delete') {
        const runId = typeof body.id === 'string' ? body.id.trim() : '';
        if (!runId) throw new HttpError(404, 'No such run.');
        await cancelBackgroundRun(store, owner, runId);
        if (!(await store.deleteRun(owner, runId))) throw new HttpError(404, 'No such run.');
        send(res, 200, { deleted: true });
        return;
      }

      const model = assistantModel();
      if (!model) throw new HttpError(503, 'The assistant has no model set up. The operator sets ANTHROPIC_API_KEY.');
      const at = new Date().toISOString();

      if (path === '/api/assistant/runs') {
        const active = await store.countActiveRuns(owner);
        if (active >= bgCfg.maxConcurrent) {
          throw new HttpError(
            429,
            `At most ${bgCfg.maxConcurrent} background ${bgCfg.maxConcurrent === 1 ? 'run' : 'runs'} may run at once: wait for one to finish or cancel it.`,
          );
        }
        let runEffort: AppAssistant['effort'] | undefined;
        if (body.effort !== undefined) {
          if (!assistant.effortPicker) throw new HttpError(400, 'Reasoning effort is set by the App here.');
          if (!(ASSISTANT_EFFORTS as readonly unknown[]).includes(body.effort))
            throw new HttpError(400, 'Effort is "low", "medium" or "high".');
          runEffort = body.effort as AppAssistant['effort'];
        }
        let prompt = '';
        let title = '';
        let requestedAgent: string | undefined;
        if (body.preset !== undefined) {
          if (typeof body.preset !== 'string' || !body.preset.trim()) throw new HttpError(400, 'Preset must be a preset id.');
          const preset = (bgCfg.presets ?? []).find((each) => each.id === body.preset);
          if (!preset) throw new HttpError(404, `Unknown background run preset "${body.preset}".`);
          const roles =
            scope.roles ?? (preset.roles ? (await servedTo(loop(), app.id, new AbortController().signal)).viewerRoles : undefined) ?? [];
          if (preset.roles && !roles.some((role) => preset.roles!.includes(role))) {
            throw new HttpError(403, 'That background run preset is not offered to your role.');
          }
          prompt = preset.prompt;
          title = typeof body.title === 'string' && body.title.trim() ? body.title.replace(/\s+/g, ' ').trim().slice(0, 200) : preset.label;
          requestedAgent = preset.agent;
        } else {
          prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
          if (!prompt || prompt.length > MAX_TEXT) throw new HttpError(400, `Say something, in at most ${MAX_TEXT} characters.`);
          title =
            typeof body.title === 'string' && body.title.trim()
              ? body.title.replace(/\s+/g, ' ').trim().slice(0, 200)
              : prompt.replace(/\s+/g, ' ').trim().slice(0, 80);
          if (body.agent !== undefined) {
            if (typeof body.agent !== 'string' || !body.agent.trim()) throw new HttpError(400, 'Agent must be a named agent id.');
            requestedAgent = body.agent.trim();
            if (!assistant.agents || !Object.hasOwn(assistant.agents, requestedAgent))
              throw new HttpError(400, `Unknown agent "${requestedAgent}".`);
          }
        }
        const prepared = await prepareRunContext(requestedAgent);
        const conv = await store.create(owner, title, at);
        await store.append(
          owner,
          conv.id,
          [
            {
              kind: 'person',
              body: {
                text: prompt,
                context: nowLine(prepared.payload.ui?.timezone),
                ...(prepared.activeAgent ? { agent: prepared.activeAgent.id } : {}),
              },
            },
          ],
          'idle',
          at,
        );
        const run = await store.createRun(
          owner,
          {
            conversation: conv.id,
            title,
            prompt,
            agent: prepared.activeAgent?.id ?? '',
          },
          at,
        );
        launchBackgroundRun({
          store,
          owner,
          run,
          model,
          assistant: prepared.runAssistant,
          baseAssistant: assistant,
          ...(prepared.activeAgent ? { activeAgent: prepared.activeAgent } : {}),
          ...(prepared.viewerRoles ? { viewerRoles: prepared.viewerRoles } : {}),
          system: prepared.system,
          tools: prepared.tools,
          createSession: prepared.createSession,
          ...(runEffort ? { effort: runEffort } : {}),
          ...(scope.tokensPerTenantPerDay === undefined ? {} : { tokensPerTenantPerDay: scope.tokensPerTenantPerDay }),
          ...(scope.withdrawn ? { withdrawn: scope.withdrawn } : {}),
        });
        send(res, 202, { run: { ...run, live: true } });
        return;
      }

      if (path === '/api/assistant/runs/resolve') {
        const runId = typeof body.id === 'string' ? body.id.trim() : '';
        const run = runId ? await store.getRun(owner, runId) : null;
        if (!run) throw new HttpError(404, 'No such run.');
        if (isBackgroundRunLive(owner, run.id)) throw new HttpError(409, 'This run is already executing.');
        const convEvents = await store.events(owner, run.conversation);
        const waiting = pendingProposal(convEvents);
        if (!waiting || waiting.id !== body.proposal) throw new HttpError(409, 'That change is not waiting for you.');
        if (!['done', 'declined', 'failed'].includes(body.outcome as string))
          throw new HttpError(400, 'An outcome is done, declined or failed.');
        const active = await store.countActiveRuns(owner);
        if (active >= bgCfg.maxConcurrent) {
          throw new HttpError(
            429,
            `At most ${bgCfg.maxConcurrent} background ${bgCfg.maxConcurrent === 1 ? 'run' : 'runs'} may run at once: wait for one to finish or cancel it.`,
          );
        }
        const prepared = await prepareRunContext(run.agent || undefined);
        const detail = typeof body.detail === 'string' ? body.detail.slice(0, 500) : undefined;
        await store.append(
          owner,
          run.conversation,
          [{ kind: 'outcome', body: { id: waiting.id, status: body.outcome, ...(detail ? { detail } : {}) } }],
          'idle',
          at,
        );
        const queued = (await store.updateRun(owner, run.id, { status: 'queued', finishedAt: '' }, at)) ?? run;
        launchBackgroundRun({
          store,
          owner,
          run: queued,
          model,
          assistant: prepared.runAssistant,
          baseAssistant: assistant,
          ...(prepared.activeAgent ? { activeAgent: prepared.activeAgent } : {}),
          ...(prepared.viewerRoles ? { viewerRoles: prepared.viewerRoles } : {}),
          system: prepared.system,
          tools: prepared.tools,
          createSession: prepared.createSession,
          ...(scope.tokensPerTenantPerDay === undefined ? {} : { tokensPerTenantPerDay: scope.tokensPerTenantPerDay }),
          ...(scope.withdrawn ? { withdrawn: scope.withdrawn } : {}),
        });
        send(res, 202, { run: { ...queued, live: true } });
        return;
      }

      if (path === '/api/assistant/runs/resume') {
        const runId = typeof body.id === 'string' ? body.id.trim() : '';
        const run = runId ? await store.getRun(owner, runId) : null;
        if (!run) throw new HttpError(404, 'No such run.');
        if (isBackgroundRunLive(owner, run.id)) throw new HttpError(409, 'This run is already executing.');
        if (run.status === 'completed') throw new HttpError(409, 'This run already completed.');
        const convEvents = await store.events(owner, run.conversation);
        if (pendingProposal(convEvents)) throw new HttpError(409, 'Confirm or decline the proposed change first.');
        const active = await store.countActiveRuns(owner);
        const alreadyCounted = run.status === 'running' || run.status === 'queued';
        if (!alreadyCounted && active >= bgCfg.maxConcurrent) {
          throw new HttpError(
            429,
            `At most ${bgCfg.maxConcurrent} background ${bgCfg.maxConcurrent === 1 ? 'run' : 'runs'} may run at once: wait for one to finish or cancel it.`,
          );
        }
        const prepared = await prepareRunContext(run.agent || undefined);
        const queued = (await store.updateRun(owner, run.id, { status: 'queued', finishedAt: '' }, at)) ?? run;
        launchBackgroundRun({
          store,
          owner,
          run: queued,
          model,
          assistant: prepared.runAssistant,
          baseAssistant: assistant,
          ...(prepared.activeAgent ? { activeAgent: prepared.activeAgent } : {}),
          ...(prepared.viewerRoles ? { viewerRoles: prepared.viewerRoles } : {}),
          system: prepared.system,
          tools: prepared.tools,
          createSession: prepared.createSession,
          ...(scope.tokensPerTenantPerDay === undefined ? {} : { tokensPerTenantPerDay: scope.tokensPerTenantPerDay }),
          ...(scope.withdrawn ? { withdrawn: scope.withdrawn } : {}),
        });
        send(res, 202, { run: { ...queued, live: true } });
        return;
      }
      throw new HttpError(404, 'No such run route.');
    }
    if (path === '/api/assistant/about') {
      /* A page hands the panel what the person is on (useAssistant().open({ about })): the record is read here as them,
         through the App's own routes, and named as the panel will say it. Nothing is kept: the turn reads it again. */
      if (!assistant.placement.includes('record')) throw new HttpError(400, NO_RECORD);
      const resource = typeof body.resource === 'string' ? body.resource : '';
      const key = body.id;
      if (!resource || !((typeof key === 'string' && key && key.length <= 200) || (typeof key === 'number' && Number.isFinite(key))))
        throw new HttpError(400, 'Name the record by its table and id.');
      const signal = new AbortController().signal;
      const payload = await servedTo(loop(), app.id, signal);
      const session: ToolSession = {
        loop: loop(),
        app: app.id,
        payload,
        assistant,
        catalog: catalogFromPayload(payload, assistant, await tablesOf(loop(), app.id, signal)),
        signal,
      };
      const found = await aboutRecord(session, resource, key);
      if (!found) throw new HttpError(404, NOT_OPEN);
      send(res, 200, found);
      return;
    }
    if (path === '/api/assistant/acted') {
      /* Not a write: the person already ran the verb, through the App's own path and under its own checks
         (/api/update, the command's form). This tells the conversation what they did, so the model reads it
         next turn; it runs nothing, and the model cannot call it. */
      const conversation = typeof id === 'string' ? await store.get(owner, id) : null;
      if (!conversation) throw new HttpError(404, 'No such conversation.');
      const resource = typeof body.resource === 'string' ? body.resource : '';
      const payload = await servedTo(loop(), app.id, new AbortController().signal);
      const action = (payload.resources[resource]?.actions ?? []).find((each) => each.id === body.action);
      if (!action || !mayRunAction(payload, resource, action)) throw new HttpError(400, 'That is not one of your verbs here.');
      if (body.outcome !== 'done' && body.outcome !== 'failed') throw new HttpError(400, 'An outcome is done or failed.');
      const key = body.key;
      if (!key || typeof key !== 'object' || Array.isArray(key) || JSON.stringify(key).length > 500)
        throw new HttpError(400, 'Name the record by its key.');
      const acted: Acted = {
        resource,
        action: action.id,
        label: action.label,
        key: key as Record<string, unknown>,
        ...(typeof body.record === 'string' && body.record.trim() ? { record: body.record.trim().slice(0, 120) } : {}),
        status: body.outcome,
        ...(typeof body.detail === 'string' && body.detail.trim() ? { detail: body.detail.trim().slice(0, 500) } : {}),
      };
      const events = await store.events(owner, conversation.id);
      await store.append(
        owner,
        conversation.id,
        [{ kind: 'acted', body: acted }],
        pendingProposal(events) ? 'awaiting' : 'idle',
        new Date().toISOString(),
      );
      send(res, 200, { item: { type: 'note', text: actedNote(acted) } });
      return;
    }
    const model = assistantModel();
    if (!model) throw new HttpError(503, 'The assistant has no model set up. The operator sets ANTHROPIC_API_KEY.');
    const at = new Date().toISOString();
    let conversation = id === undefined ? null : typeof id === 'string' ? await store.get(owner, id) : null;
    if (id !== undefined && !conversation) throw new HttpError(404, 'No such conversation.');
    // Asked and taken with no wait between, so two requests cannot both pass.
    const whose = JSON.stringify([owner.app, owner.tenant, owner.account]);
    if (conversation && answering.has(`${whose}\n${conversation.id}`)) throw new HttpError(409, 'This conversation is still answering.');
    if ((turnsOf.get(whose) ?? 0) >= TURNS_PER_PERSON)
      throw new HttpError(429, `${TURNS_PER_PERSON} answers are already under way for you: wait for one to finish.`);
    person = whose;
    turnsOf.set(whose, (turnsOf.get(whose) ?? 0) + 1);
    const hold = (conversationId: string) => {
      held.push(`${whose}\n${conversationId}`);
      answering.add(held[held.length - 1]);
    };
    if (conversation) hold(conversation.id);
    const events = conversation ? await store.events(owner, conversation.id) : [];
    const waiting = pendingProposal(events);
    let text: string | undefined;
    let cutFrom: number | undefined;
    let context = body.context as { resource?: unknown; key?: unknown } | undefined;
    if (
      context !== undefined &&
      (!context ||
        typeof context !== 'object' ||
        typeof context.resource !== 'string' ||
        !context.key ||
        typeof context.key !== 'object' ||
        Array.isArray(context.key) ||
        JSON.stringify(context.key).length > 500)
    )
      throw new HttpError(400, 'A context names a record: { resource, key }.');
    if (context !== undefined && !assistant.placement.includes('record')) throw new HttpError(400, NO_RECORD);
    let turnEffort: AppAssistant['effort'] | undefined;
    let requestedAgent: string | undefined;
    let started: string | undefined;
    if (path === '/api/assistant/turn') {
      if (body.mode !== undefined && body.mode !== 'ask') throw new HttpError(400, 'A turn is asked with mode "ask", or none.');
      if (body.effort !== undefined) {
        if (!assistant.effortPicker) throw new HttpError(400, 'Reasoning effort is set by the App here.');
        if (!(ASSISTANT_EFFORTS as readonly unknown[]).includes(body.effort))
          throw new HttpError(400, 'Effort is "low", "medium" or "high".');
        turnEffort = body.effort as AppAssistant['effort'];
      }
      if (body.agent !== undefined) {
        if (typeof body.agent !== 'string' || !body.agent.trim()) throw new HttpError(400, 'Agent must be a named agent id.');
        requestedAgent = body.agent.trim();
        if (!assistant.agents || !Object.hasOwn(assistant.agents, requestedAgent))
          throw new HttpError(400, `Unknown agent "${requestedAgent}".`);
        if (scope.roles) {
          try {
            resolveAgentAssistant(assistant, requestedAgent, scope.roles);
          } catch (error) {
            throw new HttpError(403, error instanceof Error ? error.message : 'That agent is not offered to your role.');
          }
        }
      }
      if (waiting) throw new HttpError(409, 'Confirm or decline the proposed change first.');
      const people = events.filter((event) => event.kind === 'person');
      const from =
        body.retry === true
          ? people[people.length - 1]
          : body.edit !== undefined
            ? people.find((event) => event.seq === body.edit)
            : undefined;
      if ((body.retry === true || body.edit !== undefined) && !from) throw new HttpError(400, 'There is nothing to retry or edit there.');
      text = body.retry === true ? String((from!.body as { text: string }).text) : typeof body.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > MAX_TEXT) throw new HttpError(400, `Say something, in at most ${MAX_TEXT} characters.`);
      /* A retry or an edit continues from the prefix the model already saw: the person's words there, and
         everything after them, are cut. The cut itself waits (below) until the grants and the catalog have been
         read, the last things in this request that can refuse it: a refusal must not leave the old turn gone and no
         new one written. */
      if (from && body.retry === true) context = undefined;
      cutFrom = from?.seq;
      if (!conversation) {
        conversation = await store.create(owner, text, at);
        started = conversation.id;
        hold(conversation.id);
      }
    } else {
      if (!waiting || waiting.id !== body.proposal) throw new HttpError(409, 'That change is not waiting for you.');
      if (!['done', 'declined', 'failed'].includes(body.outcome as string))
        throw new HttpError(400, 'An outcome is done, declined or failed.');
      const detail = typeof body.detail === 'string' ? body.detail.slice(0, 500) : undefined;
      await store.append(
        owner,
        conversation!.id,
        [{ kind: 'outcome', body: { id: waiting.id, status: body.outcome, ...(detail ? { detail } : {}) } }],
        'idle',
        at,
      );
    }
    /* The stream is the request: closing it stops the model and every read it started. */
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    const payload = await servedTo(loop(), app.id, controller.signal);
    const viewerRoles = scope.roles ?? payload.viewerRoles;
    const chosenAgentId = requestedAgent ?? lastAgentOf(events);
    let resolvedAgent: ReturnType<typeof resolveAgentAssistant>;
    try {
      resolvedAgent = resolveAgentAssistant(assistant, chosenAgentId, viewerRoles);
    } catch (error) {
      if (started) await store.remove(owner, started);
      throw new HttpError(403, error instanceof Error ? error.message : 'That agent is not offered to your role.');
    }
    const effectiveAssistant = resolvedAgent.assistant;
    const activeAgent = resolvedAgent.agent;
    const canWriteShared = canWriteSharedMemory(effectiveAssistant.memory, viewerRoles ?? []);
    const memories = effectiveAssistant.memory
      ? await store.memories(owner, {
          scopes: effectiveAssistant.memory.scopes,
          agent: activeAgent?.id,
          limit: 40,
        })
      : undefined;
    const catalog = catalogFromPayload(
      payload,
      effectiveAssistant,
      await tablesOf(loop(), app.id, controller.signal),
      activeAgent,
      effectiveAssistant.memory ? { memories, canWriteSharedMemory: canWriteShared } : undefined,
    );
    const session: ToolSession = {
      loop: loop(),
      app: app.id,
      payload,
      assistant: effectiveAssistant,
      catalog,
      signal: controller.signal,
      ...(effectiveAssistant.memory ? { store, owner, agentId: activeAgent?.id ?? '', canWriteSharedMemory: canWriteShared } : {}),
      ...(scope.propose ? { propose: scope.propose } : {}),
      ...(body.mode === 'ask' ? { ask: true as const } : {}),
    };
    const line =
      text !== undefined && context
        ? await recordContext(session, context.resource as string, context.key as Record<string, unknown>)
        : undefined;
    if (text !== undefined && context && line === undefined) {
      /* A record this person cannot open is refused, not answered as if the turn were about nothing: a page that
         handed the panel another reader's record learns no more than that. The conversation this turn began goes too. */
      if (started) await store.remove(owner, started);
      throw new HttpError(404, NOT_OPEN);
    }
    if (cutFrom !== undefined) await store.truncate(owner, conversation!.id, cutFrom, at);
    if (text !== undefined) {
      /* When it is, for this person: said with their words, not in the system prompt, which is the same for every
         call of a conversation so its cached prefix holds. Without it "tomorrow" and "this month" were the model's guess. */
      const said = [nowLine(payload.ui?.timezone), line].filter(Boolean).join('\n');
      // A fresh conversation's first words, or an edited or retried turn's again (the cut above removed them).
      await store.append(
        owner,
        conversation!.id,
        [{ kind: 'person', body: { text, context: said, ...(activeAgent ? { agent: activeAgent.id } : {}) } }],
        'idle',
        at,
      );
    }
    const emit = stream(res);
    const after = await store.events(owner, conversation!.id);
    emit('conversation', {
      id: conversation!.id,
      title: conversation!.title,
      ...(activeAgent ? { agent: activeAgent.id } : {}),
      ...(text !== undefined ? { person: after[after.length - 1].seq } : {}),
    });
    await continueTurn({
      store,
      owner,
      conversation: conversation!.id,
      model,
      assistant: effectiveAssistant,
      baseAssistant: assistant,
      ...(activeAgent ? { activeAgent } : {}),
      ...(viewerRoles ? { viewerRoles } : {}),
      system: systemPrompt(catalog, session.ask ? 'ask' : undefined),
      tools: toolSpecs(effectiveAssistant, activeAgent, { canWriteSharedMemory: canWriteShared }),
      session,
      emit,
      ...(turnEffort ? { effort: turnEffort } : {}),
      ...(scope.tokensPerTenantPerDay === undefined ? {} : { tokensPerTenantPerDay: scope.tokensPerTenantPerDay }),
      ...(scope.withdrawn ? { withdrawn: scope.withdrawn } : {}),
    });
    res.end();
    return;
  } catch (error) {
    if (res.headersSent) {
      /* The stream is open, so the refusal rides on it: a stream that closes without `done` reads to the panel as a
         dropped connection, which this was not. */
      const emit = stream(res, false);
      emit('error', { message: 'The assistant could not answer just now.' });
      emit('done', { state: 'idle' });
      res.end();
      return;
    }
    if (error instanceof HttpError) send(res, error.status, { error: error.message });
    else send(res, 503, { error: 'The assistant could not answer just now.' });
    return;
  } finally {
    for (const key of held) answering.delete(key);
    if (person !== undefined) {
      const left = (turnsOf.get(person) ?? 1) - 1;
      if (left > 0) turnsOf.set(person, left);
      else turnsOf.delete(person);
    }
  }
}
