/**
 * `/api/assistant…`: the signed-in person's conversations with an App's
 * assistant (docs/assistant.md).
 *
 *   GET  /api/assistant?app=               their conversations, newest first
 *   GET  /api/assistant/conversation?app=&id=   one, as the panel draws it
 *   POST /api/assistant/turn               say something (or edit, or retry): a stream
 *   POST /api/assistant/resolve            a proposal's outcome, and the turn continues: a stream
 *   POST /api/assistant/acted              a verb the person ran from a card or a row the conversation drew
 *   GET  /api/assistant/search?app=&q=     their conversations whose words hold q, each with a line of them
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
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AssistantOwner, AssistantStore } from '../../adapters/assistant/assistantStore.js';
import type { AppDef } from '../../shared/appModel.js';
import type { AppPayloadApp } from '../../shared/appPayload.js';
import type { AppHost } from '../app/apps.js';
import { catalogFromPayload, mayRunAction, systemPrompt, toolSpecs } from '../assistant/assistantCatalog.js';
import { assistantModel } from '../assistant/assistantModel.js';
import { assistantStoreFor, storeUnavailableReply } from '../assistant/assistantStores.js';
import { recordContext, type ToolSession } from '../assistant/assistantTools.js';
import { actedNote, continueTurn, itemsOf, pendingProposal, type Acted, type Emit } from '../assistant/assistantTurn.js';
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
]);
const SAID: Record<string, readonly string[]> = {
  '/api/assistant/turn': ['app', 'conversation', 'text', 'context', 'edit', 'retry'],
  '/api/assistant/resolve': ['app', 'conversation', 'proposal', 'outcome', 'detail'],
  '/api/assistant/delete': ['app', 'conversation'],
  '/api/assistant/rename': ['app', 'conversation', 'title'],
  '/api/assistant/acted': ['app', 'conversation', 'resource', 'action', 'key', 'record', 'outcome', 'detail'],
};
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

/** Who is asking, where their conversations are kept, and how their reads go: everything a route needs that
 * differs between an ordinary App (below) and a tenant App's host (tenant/tenantAssistant.ts). */
interface AssistantScope {
  readonly app: AppDef;
  readonly owner: AssistantOwner;
  readonly store: AssistantStore;
  /** A request back through the App's own routes, as this person: each read is gated and row-scoped there. */
  readonly loop: () => Loop;
  /** A tenant App's: the platform owner's daily cap for one tenant. */
  readonly tokensPerTenantPerDay?: number;
  /** A tenant App's: asked before every model call; a reason ends the turn (the switch was turned off). */
  readonly withdrawn?: () => Promise<string | undefined>;
}

export async function assistantRoutes(ctx: Base, loop: () => Loop): Promise<boolean> {
  const { req, res, url, path, appHosts, registry } = ctx;
  if (!ASSISTANT_PATHS.has(path)) return false;
  await answerAssistant(req, res, url, path, async (appId) => {
    const host = (appHosts ?? []).find((each) => each.app.app.id === appId);
    if (!host?.app.app.assistant) throw new HttpError(404, 'This App has no assistant.');
    const owner = personOf(ctx, host);
    let store: AssistantStore;
    try {
      store = await assistantStoreFor(registry, host);
    } catch (error) {
      throw storeUnavailableReply(error);
    }
    return { app: host.app.app, owner, store, loop };
  });
  return true;
}

/* What this process answers at once — a turn, or a proposal's outcome and the turn it continues: one at a time on a
   conversation, and two at a time for a person. Two turns on one conversation interleaved their events, and a person's
   turns in parallel each passed the daily cap before any of them was charged. Counted per process. */
const TURNS_PER_PERSON = 2;
const answering = new Set<string>();
const turnsOf = new Map<string, number>();

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
      send(res, 200, { conversation, items: itemsOf(events), ...(pendingProposal(events) ? { awaiting: true } : {}) });
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
    let context = body.context as { resource?: unknown; key?: unknown } | undefined;
    if (path === '/api/assistant/turn') {
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
      /* A retry or an edit continues from the prefix the model already saw:
         the person's words there, and everything after them, are cut. */
      if (from) {
        if (body.retry === true) context = undefined;
        await store.truncate(owner, conversation!.id, from.seq, at);
      }
      if (!conversation) {
        conversation = await store.create(owner, text, at);
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
    const catalog = catalogFromPayload(payload, assistant, await tablesOf(loop(), app.id, controller.signal));
    const session: ToolSession = { loop: loop(), app: app.id, payload, assistant, catalog, signal: controller.signal };
    if (text !== undefined) {
      const line =
        context && assistant.placement.includes('record') ? await recordContext(session, context.resource, context.key) : undefined;
      // A fresh conversation's first words, or an edited or retried turn's again (the cut above removed them).
      await store.append(owner, conversation!.id, [{ kind: 'person', body: { text, ...(line ? { context: line } : {}) } }], 'idle', at);
    }
    const emit = stream(res);
    const after = await store.events(owner, conversation!.id);
    emit('conversation', {
      id: conversation!.id,
      title: conversation!.title,
      ...(text !== undefined ? { person: after[after.length - 1].seq } : {}),
    });
    await continueTurn({
      store,
      owner,
      conversation: conversation!.id,
      model,
      assistant,
      system: systemPrompt(catalog),
      tools: toolSpecs(assistant),
      session,
      emit,
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
