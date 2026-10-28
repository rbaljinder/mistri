/**
 * One turn of a conversation: the model is asked, its text streams to the
 * panel as it is written, the tools it calls are answered as the person, and
 * it is asked again with their results — until it answers, proposes a change,
 * reaches a cap, or the person stops it.
 *
 * Every step is appended to the conversation's events as it happens, so a
 * restart, a second device or a reload resumes where the turn was: a
 * proposal waiting for the person is the conversation's `awaiting` state, and
 * its outcome (resolveProposal) continues the same turn. The model's content
 * is kept exactly as it came, thinking and its signatures too, so every call
 * after the first is the previous one's prefix.
 */
import type { AppAssistant } from '../../shared/appAssistant.js';
import type { AssistantOwner, AssistantStore, ConversationState, StoredEvent } from '../../adapters/assistant/assistantStore.js';
import type { AssistantModel, ModelBlock, ModelMessage, ModelTool, ModelUsage } from './assistantModel.js';
import { answerTool, runningLabel, type DisplayItem, type Proposal, type ToolSession } from './assistantTools.js';
import { estimateTokens } from './assistantCatalog.js';

/** Steps (model calls) one turn may take before it stops and says so. */
const MAX_STEPS = 8;
const MAX_OUTPUT = 4096;
/** Past this many tokens of history, the earlier part is summarised before the next call. */
const COMPACT_AT = 100_000;

export type Emit = (event: string, data: unknown) => void;

interface ToolResultRecord {
  id: string;
  /** Null while the proposal it answers waits for the person. */
  content: string | null;
  isError?: true;
}
type Outcome = { id: string; status: 'done' | 'declined' | 'failed'; detail?: string };

/** What the panel draws, rebuilt from the events: the same items a live turn streams. */
export type PanelItem =
  | { type: 'person'; seq: number; text: string }
  | { type: 'text'; text: string }
  | { type: 'note'; text: string }
  | DisplayItem
  | { type: 'proposal'; id: string; proposal: Proposal; outcome?: Omit<Outcome, 'id'> };

const OUTCOME_WORDS: Record<Outcome['status'], string> = {
  done: 'The person confirmed it, and it was applied.',
  declined: 'The person declined it; it was not applied.',
  failed: 'The person confirmed it, and the application refused it.',
};
const outcomeText = (outcome: Outcome) => `${OUTCOME_WORDS[outcome.status]}${outcome.detail ? ` ${outcome.detail}` : ''}`;

/** A verb the person ran themselves from what the conversation drew — a record's card, a table's row — and what came of it. */
export interface Acted {
  resource: string;
  action: string;
  label: string;
  key: Record<string, unknown>;
  record?: string;
  status: 'done' | 'failed';
  detail?: string;
}
/** The person's words for it, in the conversation. */
export const actedNote = (acted: Acted): string =>
  `${acted.label}${acted.record ? ` on ${acted.record}` : ''}: ${acted.status === 'done' ? 'applied' : `not applied${acted.detail ? ` (${acted.detail})` : ''}`}.`;
/* The model's: what the person did, said as a fact it reads, never as words it was asked to act on. */
export const ACTED_MARK = '(From the App, not typed:';
const actedText = (acted: Acted): string =>
  `${ACTED_MARK} the person ran ${acted.resource}.${acted.action} ("${acted.label}") on ${acted.resource}${acted.record ? ` ${JSON.stringify(acted.record)}` : ''} ${JSON.stringify(acted.key)}` +
  ` themselves, from what this conversation showed. ${acted.status === 'done' ? 'It was applied.' : `It was not applied.${acted.detail ? ` ${acted.detail}` : ''}`})`;

function outcomesOf(events: readonly StoredEvent[]): Map<string, Outcome> {
  const outcomes = new Map<string, Outcome>();
  for (const event of events) if (event.kind === 'outcome') outcomes.set((event.body as Outcome).id, event.body as Outcome);
  return outcomes;
}

/** The proposal still waiting for the person, if there is one. */
export function pendingProposal(events: readonly StoredEvent[]): Proposal | undefined {
  const outcomes = outcomesOf(events);
  for (const event of [...events].reverse()) {
    if (event.kind !== 'tool') continue;
    const { results, display } = event.body as { results: ToolResultRecord[]; display: DisplayItem[] };
    const waiting = results.find((result) => result.content === null && !outcomes.has(result.id));
    if (!waiting) return undefined;
    const item = display.find((each) => each.type === 'proposal' && each.id === waiting.id);
    return item?.type === 'proposal' ? item.proposal : undefined;
  }
  return undefined;
}

/* Thinking is the model's own, signed by it: another model is not handed it. A reply kept before the model was
   recorded (0.9.8 and earlier) is taken to be the current model's, as it almost always was. */
const THINKING = new Set(['thinking', 'redacted_thinking']);
const replyFor = (body: Record<string, unknown>, model: string): ModelBlock[] => {
  const content = body.content as ModelBlock[];
  return typeof body.model === 'string' && body.model !== model ? content.filter((block) => !THINKING.has(block.type)) : content;
};

/** The conversation as `model` reads it: alternating messages, a summary in place of what it covers. */
function messagesOf(events: readonly StoredEvent[], model: string): ModelMessage[] {
  const outcomes = outcomesOf(events);
  const summary = [...events].reverse().find((event) => event.kind === 'summary')?.body as { text: string; through: number } | undefined;
  const messages: ModelMessage[] = [];
  const user = (blocks: ModelBlock[]) => {
    const last = messages[messages.length - 1];
    if (last?.role === 'user') last.content = [...(last.content as ModelBlock[]), ...blocks];
    else messages.push({ role: 'user', content: blocks });
  };
  if (summary) user([{ type: 'text', text: `Earlier in this conversation, summarised:\n${summary.text}` }]);
  for (const event of events) {
    if (summary && event.seq <= summary.through) continue;
    const body = event.body as Record<string, unknown>;
    if (event.kind === 'person') {
      user([{ type: 'text', text: [body.text, body.context].filter(Boolean).join('\n\n') }]);
    } else if (event.kind === 'acted') {
      user([{ type: 'text', text: actedText(body as unknown as Acted) }]);
    } else if (event.kind === 'assistant') {
      const content = replyFor(body, model);
      if (content.length) messages.push({ role: 'assistant', content });
    } else if (event.kind === 'tool') {
      user(
        (body.results as ToolResultRecord[]).map((result) => {
          const outcome = outcomes.get(result.id);
          return {
            type: 'tool_result',
            tool_use_id: result.id,
            content: result.content ?? (outcome ? outcomeText(outcome) : 'Still waiting for the person.'),
            ...(result.isError ? { is_error: true } : {}),
          };
        }),
      );
    }
  }
  return answered(messages);
}

/* Every call the model made is answered, first in the message after it: a call with no result makes the provider
   refuse every later request, so a conversation whose results were never kept (a restart between the two writes, a
   store that refused them) could not be continued at all. What the events do not answer is answered here. */
const UNANSWERED = 'Not answered: the step was interrupted before its result was kept.';
function answered(messages: ModelMessage[]): ModelMessage[] {
  for (let at = 0; at < messages.length; at++) {
    const message = messages[at];
    if (message.role !== 'assistant' || typeof message.content === 'string') continue;
    const asked = message.content.filter((block) => block.type === 'tool_use').map((block) => String(block.id));
    if (!asked.length) continue;
    const next = messages[at + 1];
    const blocks = next?.role === 'user' ? (typeof next.content === 'string' ? [{ type: 'text', text: next.content }] : next.content) : [];
    const results = new Map(blocks.filter((block) => block.type === 'tool_result').map((block) => [String(block.tool_use_id), block]));
    if (asked.every((id) => results.has(id)) && blocks.slice(0, asked.length).every((block) => block.type === 'tool_result')) continue;
    const ordered: ModelBlock[] = asked.map(
      (id) => results.get(id) ?? { type: 'tool_result', tool_use_id: id, content: UNANSWERED, is_error: true },
    );
    const rest = blocks.filter((block) => block.type !== 'tool_result' || !asked.includes(String(block.tool_use_id)));
    const reply: ModelMessage = { role: 'user', content: [...ordered, ...rest] };
    if (next?.role === 'user') messages[at + 1] = reply;
    else messages.splice(at + 1, 0, reply);
  }
  return messages;
}

/** The panel's items, from the events. */
export function itemsOf(events: readonly StoredEvent[]): PanelItem[] {
  const outcomes = outcomesOf(events);
  const items: PanelItem[] = [];
  for (const event of events) {
    const body = event.body as Record<string, unknown>;
    if (event.kind === 'person') items.push({ type: 'person', seq: event.seq, text: String(body.text) });
    else if (event.kind === 'assistant') {
      const text = (body.content as ModelBlock[])
        .filter((block) => block.type === 'text')
        .map((block) => String(block.text))
        .join('');
      if (text) items.push({ type: 'text', text });
    } else if (event.kind === 'tool') {
      for (const item of body.display as DisplayItem[]) {
        if (item.type !== 'proposal') items.push(item);
        else {
          const outcome = outcomes.get(item.id);
          items.push({
            ...item,
            ...(outcome ? { outcome: { status: outcome.status, ...(outcome.detail ? { detail: outcome.detail } : {}) } } : {}),
          });
        }
      }
    } else if (event.kind === 'note') items.push({ type: 'note', text: String(body.text) });
    else if (event.kind === 'acted') items.push({ type: 'note', text: actedNote(body as unknown as Acted) });
  }
  return items;
}

interface TurnContext {
  store: AssistantStore;
  owner: AssistantOwner;
  conversation: string;
  model: AssistantModel;
  assistant: AppAssistant;
  system: string;
  tools: readonly ModelTool[];
  session: ToolSession;
  emit: Emit;
  /** For tests: summarise past this many tokens instead of the default. */
  compactAt?: number;
  /** A tenant App's: what one customer may spend in a day, all its people together (the platform owner's policy). */
  tokensPerTenantPerDay?: number;
  /** A tenant App's: why the assistant is no longer this customer's (the switch turned off), asked before every model
   * call so a switch turned off mid-answer stops the next call, not the next conversation. */
  withdrawn?: () => Promise<string | undefined>;
}

const total = (usage: ModelUsage) => usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
/* What a step weighs against `tokensPerTurn`: every step resends the turn so far, and its cached part is read at a
   tenth of the price. Counted whole, a five-step answer over a long catalog met a 60,000-token limit having said
   nothing (a field report). The day's spend is the bill and keeps counting it whole. */
const turnWeight = (usage: ModelUsage) => usage.input + usage.output + usage.cacheWrite + Math.ceil(usage.cacheRead / 10);
const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString();

/** Why the next model call may not be made, or nothing. */
async function capReached(context: TurnContext, spentThisTurn: number): Promise<string | undefined> {
  const { limits } = context.assistant;
  if (limits.tokensPerTurn !== undefined && spentThisTurn >= limits.tokensPerTurn)
    return 'This answer reached its length limit. Ask again to continue.';
  const withdrawn = await context.withdrawn?.();
  if (withdrawn) return withdrawn;
  const perTenant = context.tokensPerTenantPerDay;
  if (limits.tokensPerPersonPerDay === undefined && limits.tokensPerDay === undefined && perTenant === undefined) return undefined;
  const spent = await context.store.spent(context.owner, today());
  if (limits.tokensPerPersonPerDay !== undefined && spent.person >= limits.tokensPerPersonPerDay)
    return 'You have reached your assistant limit for today.';
  if (perTenant !== undefined && spent.tenant >= perTenant) return "This customer's assistant has reached its limit for today.";
  if (limits.tokensPerDay !== undefined && spent.app >= limits.tokensPerDay) return "The App's assistant has reached its limit for today.";
  return undefined;
}

async function append(context: TurnContext, kind: string, body: unknown, state: ConversationState = 'idle') {
  await context.store.append(context.owner, context.conversation, [{ kind, body }], state, now());
}

async function compactIfLong(context: TurnContext, events: StoredEvent[]): Promise<number> {
  const lastPerson = [...events].reverse().find((event) => event.kind === 'person');
  if (!lastPerson) return 0;
  const before = events.filter((event) => event.seq < lastPerson.seq);
  const model = context.assistant.model;
  if (!before.length || estimateTokens(JSON.stringify(messagesOf(events, model))) < (context.compactAt ?? COMPACT_AT)) return 0;
  const messages = messagesOf(before, model);
  const ask: ModelBlock = {
    type: 'text',
    text: 'Summarise this conversation so far for your own later use: what was asked, what was found (with ids and addresses), what was proposed and what came of it. Plain text, under 300 words.',
  };
  const last = messages[messages.length - 1];
  if (last?.role === 'user') last.content = [...(last.content as ModelBlock[]), ask];
  else messages.push({ role: 'user', content: [ask] });
  const reply = await context.model.stream(
    { model: context.assistant.model, system: context.system, tools: context.tools, messages, maxTokens: 1024 },
    () => undefined,
    context.session.signal,
  );
  const text = reply.content
    .filter((block) => block.type === 'text')
    .map((block) => String(block.text))
    .join('')
    .trim();
  if (text) await append(context, 'summary', { text, through: lastPerson.seq - 1 });
  await context.store.spend(context.owner, today(), total(reply.usage));
  return turnWeight(reply.usage);
}

/**
 * Continue the conversation from its events: called after the person's words
 * are appended, and after a proposal's outcome is. Ends `idle` or `awaiting`.
 */
export async function continueTurn(context: TurnContext): Promise<ConversationState> {
  const { emit, session } = context;
  let spent = 0;
  let streamed = '';
  let pendingTools: Array<{ id: string; name: string; input: unknown }> = [];
  const finish = async (state: ConversationState, note?: string) => {
    if (note) {
      await append(context, 'note', { text: note }, state);
      emit('note', { text: note });
    }
    emit('done', { state, tokens: spent });
    return state;
  };
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const refused = await capReached(context, spent);
      if (refused) return await finish('idle', refused);
      let events = await context.store.events(context.owner, context.conversation);
      if (step === 0 && (spent += await compactIfLong(context, events)))
        events = await context.store.events(context.owner, context.conversation);
      streamed = '';
      const reply = await context.model.stream(
        {
          model: context.assistant.model,
          system: context.system,
          tools: context.tools,
          messages: messagesOf(events, context.assistant.model),
          maxTokens: MAX_OUTPUT,
          ...(context.assistant.effort ? { effort: context.assistant.effort } : {}),
        },
        (delta) => {
          streamed += delta;
          emit('text', { delta });
        },
        session.signal,
      );
      spent += turnWeight(reply.usage);
      await context.store.spend(context.owner, today(), total(reply.usage));
      const uses = reply.content.filter((block) => block.type === 'tool_use') as Array<{
        type: string;
        id: string;
        name: string;
        input: unknown;
      }>;
      pendingTools = reply.stopReason === 'tool_use' ? uses.map(({ id, name, input }) => ({ id, name, input })) : [];
      /* A reply that stopped anywhere but at its tool calls keeps none of
         them: a tool_use with no result would make every later call invalid. */
      const kept = reply.stopReason === 'tool_use' ? reply.content : reply.content.filter((block) => block.type !== 'tool_use');
      // The model that made it is kept with it: its thinking goes back to that model only.
      await append(context, 'assistant', { content: kept, usage: reply.usage, model: context.assistant.model });
      streamed = '';
      if (reply.stopReason === 'refusal') return await finish('idle', 'The model declined to answer that.');
      if (reply.stopReason === 'max_tokens') return await finish('idle', 'The answer was cut short. Ask again to continue.');
      if (!pendingTools.length) return await finish('idle');
      const results: ToolResultRecord[] = [];
      const display: DisplayItem[] = [];
      let proposed = false;
      for (const use of pendingTools) {
        if (session.signal.aborted) break;
        emit('running', { id: use.id, tool: use.name, label: runningLabel(use.name, use.input) });
        if (use.name === 'run' && proposed) {
          const refusal = JSON.stringify({ error: 'One change at a time: wait for the outcome of the first.' });
          results.push({ id: use.id, content: refusal, isError: true });
          continue;
        }
        const answer = await answerTool(session, use.name, use.input, use.id);
        if (answer.proposal) proposed = true;
        results.push({
          id: use.id,
          content: answer.proposal ? null : answer.result,
          ...(answer.isError ? { isError: true as const } : {}),
        });
        for (const item of answer.display) emit(item.type, item);
        display.push(...answer.display);
      }
      if (session.signal.aborted) throw Object.assign(new Error('stopped'), { name: 'AbortError', results, display });
      // Still pending until kept: a store that refuses the results leaves the catch below to answer the calls.
      await append(context, 'tool', { results, display }, proposed ? 'awaiting' : 'idle');
      pendingTools = [];
      if (proposed) return await finish('awaiting');
    }
    return await finish('idle', `Stopped after ${MAX_STEPS} steps. Ask again to continue.`);
  } catch (error) {
    /* What was said stays said: a stopped stream keeps its text, and a stopped
       step answers its calls, so the conversation can always be continued. */
    const stopped = session.signal.aborted;
    /* A call stopped or cut off midway was still paid for: the usage it carries counts against the caps, or stopping
       answers over and over spent what the caps never saw. */
    const lost = (error as { usage?: ModelUsage } | null)?.usage;
    if (lost && total(lost) > 0) {
      spent += turnWeight(lost);
      await context.store.spend(context.owner, today(), total(lost)).catch(() => {});
    }
    if (streamed) await append(context, 'assistant', { content: [{ type: 'text', text: streamed }], model: context.assistant.model });
    if (pendingTools.length) {
      const partial = (error as { results?: ToolResultRecord[]; display?: DisplayItem[] }).results ?? [];
      const answered = new Set(partial.map((result) => result.id));
      const results = [
        ...partial.map((result) =>
          result.content === null ? { ...result, content: 'Stopped by the person before it was confirmed.' } : result,
        ),
        ...pendingTools
          .filter((use) => !answered.has(use.id))
          .map((use) => ({ id: use.id, content: stopped ? 'Stopped by the person.' : 'Failed.', isError: true as const })),
      ];
      await append(context, 'tool', {
        results,
        display: ((error as { display?: DisplayItem[] }).display ?? []).filter((item) => item.type !== 'proposal'),
      });
    }
    const note = stopped
      ? 'Stopped.'
      : error instanceof Error && error.name === 'ModelUnavailable'
        ? error.message
        : 'The assistant could not answer just now.';
    /* The operator's account of it: the error's name, or a provider's refusal in our own words — never its message,
       which may quote a row or a tool's answer. Unlogged, a refused key or a bug left the server's log empty. */
    if (!stopped)
      console.error(
        `mistri: an assistant answer failed (${error instanceof Error ? (error.name === 'ModelUnavailable' ? error.message : error.name) : 'error'})`,
      );
    await append(context, 'note', { text: note });
    if (!stopped) emit('error', { message: note });
    emit('done', { state: 'idle', tokens: spent });
    return 'idle';
  }
}
