/**
 * The assistant panel's model, without React: the items a conversation is
 * drawn as, the server-sent events a turn streams, and how each event
 * changes the items. The server rebuilds the same items from what it stored
 * (assistantTurn.ts `itemsOf`), so a conversation reopened reads as it did
 * live; the one difference is that live text arrives a word at a time.
 *
 * Nothing here trusts the stream's shape: an event that does not read as its
 * kind is dropped rather than drawn.
 */
import { assistantHeaders } from './assistantRequest.js';
import { scopeApiRequest } from '@mistriwork/kit/client/requestIdentity.js';
import { state } from '@mistriwork/kit/client/core.js';
import { fetchServer } from '@mistriwork/kit/client/transport.js';

export type ProposalOutcome = { status: 'done' | 'declined' | 'failed'; detail?: string };
export interface Proposal {
  id: string;
  kind: 'set' | 'command' | 'new';
  resource: string;
  action: string;
  label: string;
  key?: Record<string, unknown>;
  record?: string;
  address?: string;
  values: Record<string, unknown>;
  why?: string;
  /** A command kept for review: the stored proposal's id (commands/proposals.ts). The turn went on without it. */
  review?: string;
}
export type AssistantBlock =
  | { kind: 'section'; section: Record<string, unknown> }
  | { kind: 'metrics'; title?: string; sections: Array<Record<string, unknown>> }
  | {
      kind: 'timeline';
      title?: string;
      table: string;
      items: Array<{ label: string; when: string; detail?: string; badge?: string; address?: string }>;
    }
  | { kind: 'callout'; tone: 'info' | 'good' | 'warning' | 'critical'; title?: string; body: string }
  | { kind: 'tabs'; title?: string; tabs: Array<{ id: string; label: string; block: AssistantBlock }> }
  | { kind: 'record'; table: string; key: Record<string, unknown>; title: string; values: Record<string, unknown>; address?: string }
  | { kind: 'custom'; name: string; title?: string; props: Record<string, unknown>; componentId?: string };

export interface DelegationItem {
  type: 'delegation';
  id: string;
  fromAgent?: string;
  fromAgentName?: string;
  agent: string;
  agentName: string;
  task: string;
  status: 'running' | 'done' | 'error';
  reasoning?: string;
  summary?: string;
  blocks?: AssistantBlock[];
  durationMs?: number;
}

export interface Citation {
  ref: number;
  source: string;
  sourceLabel: string;
  resource: string;
  title: string;
  snippet: string;
  address?: string;
}

export interface CitationsItem {
  type: 'citations';
  id: string;
  query: string;
  items: Citation[];
}

export interface MemoryEventItem {
  type: 'memory';
  id: string;
  action: 'remembered' | 'updated' | 'forgot';
  memoryId: string;
  scope: 'person' | 'app';
  content?: string;
}

export type PanelItem =
  /** `seq` is the stored event's, once the server has said it; edit names it. */
  | { type: 'person'; seq?: number; text: string }
  /** Model reasoning / thinking trace; `open` while still streaming. */
  | { type: 'reasoning'; id: string; text: string; open?: true; redacted?: true; durationMs?: number }
  /** `open` while the model is still writing it. */
  | { type: 'text'; text: string; open?: true }
  | { type: 'note'; text: string }
  | { type: 'step'; id: string; tool: string; label: string; failed?: true }
  | { type: 'block'; id: string; block: AssistantBlock; streaming?: true }
  | DelegationItem
  | CitationsItem
  | MemoryEventItem
  | { type: 'proposal'; id: string; proposal: Proposal; outcome?: ProposalOutcome }
  /** An Ask's read: the line it ran and the rows it read there. */
  | { type: 'query'; id: string; q: string; resource?: string; total: number; evidence: AskEvidence[] };

/** A row an Ask read, in a proposal's evidence shape, with the address it opens at. */
interface AskEvidence {
  kind: string;
  ref: string;
  label: string;
  address?: string;
}

export interface StreamEvent {
  event: string;
  data: Record<string, unknown>;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** A run of the model's words: plain, bold, code, an inside link, or an inline numeric citation `[1]`. */
export type Run = { text: string; mark?: 'strong' | 'code' } | { text: string; link: string } | { text: string; cite: number };
export type Paragraph =
  | { list: false; lines: Run[][] }
  | { list: true; lines: Run[][] }
  /** A Markdown table, as the model writes one: its header's cells and each row's, each cell its runs. */
  | { list: false; lines: []; table: { head: Run[][]; rows: Run[][][] } };

/* An inside address only: a path, never a scheme or another host. */
export const inside = (href: string): boolean => /^\/(?!\/)[^\s\\]*$/.test(href);

/* A table's rows (`| a | b |`) and the line under its header (`| --- | :-: |`), as Markdown writes them. */
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const cellsOf = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));

/**
 * The model's words as paragraphs, lists and tables of runs, read with three
 * marks and nothing else. Text, never markup: a link to anywhere but a path in
 * the App is said as its words alone. When `citeRefs` is provided, numeric
 * markers like `[1]` that match a retrieved citation become clickable citation
 * runs. A table the model writes in words (it is told not to repeat a block,
 * and sometimes does) is drawn as a table, not as lines of pipes.
 */
export function wordsOf(text: string, citeRefs?: ReadonlySet<number>): Paragraph[] {
  const runs = (line: string): Run[] => {
    const found: Run[] = [];
    const pattern = /\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[(\d{1,2})\](?!\()/g;
    let from = 0;
    for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
      if (match.index > from) found.push({ text: line.slice(from, match.index) });
      if (match[1] !== undefined) found.push(inside(match[2]) ? { text: match[1], link: match[2] } : { text: match[1] });
      else if (match[3] !== undefined) found.push({ text: match[3], mark: 'strong' });
      else if (match[4] !== undefined) found.push({ text: match[4], mark: 'code' });
      else {
        const ref = Number(match[5]);
        if (citeRefs?.has(ref)) found.push({ text: match[0], cite: ref });
        else found.push({ text: match[0] });
      }
      from = match.index + match[0].length;
    }
    if (from < line.length) found.push({ text: line.slice(from) });
    return found;
  };
  const prose = (lines: string[]): Paragraph => {
    return lines.every((line) => /^\s*[-*] /.test(line))
      ? { list: true, lines: lines.map((line) => runs(line.replace(/^\s*[-*] /, ''))) }
      : { list: false, lines: lines.map((line) => runs(line)) };
  };
  return text
    .trim()
    .split(/\n{2,}/)
    .filter(Boolean)
    .flatMap((paragraph) => {
      const lines = paragraph.split('\n');
      /* A table may follow a line of words with no blank line between, and words may follow it. */
      const at = lines.findIndex((line, index) => index > 0 && TABLE_RULE.test(line) && TABLE_ROW.test(lines[index - 1]));
      if (at < 0) return [prose(lines)];
      let end = at + 1;
      while (end < lines.length && TABLE_ROW.test(lines[end])) end++;
      const head = cellsOf(lines[at - 1]);
      const table: Paragraph = {
        list: false,
        lines: [],
        table: {
          head: head.map((cell) => runs(cell)),
          rows: lines.slice(at + 1, end).map((line) => {
            const cells = cellsOf(line);
            return head.map((_, index) => runs(cells[index] ?? ''));
          }),
        },
      };
      const before = lines.slice(0, at - 1);
      const after = lines.slice(end);
      return [...(before.length ? [prose(before)] : []), table, ...(after.length ? wordsOf(after.join('\n')) : [])];
    });
}

/** The events of a `text/event-stream` body, each handed on as it completes. */
export async function readEvents(body: ReadableStream<Uint8Array>, onEvent: (event: StreamEvent) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      try {
        const parsed: unknown = JSON.parse(data.join('\n'));
        if (record(parsed)) onEvent({ event, data: parsed });
      } catch {
        /* Not an event this panel reads. */
      }
    }
    if (done) return;
  }
}

/** The items after one event. Pure: the panel keeps the result as its state. */
export function applyEvent(items: readonly PanelItem[], { event, data }: StreamEvent): PanelItem[] {
  const next = items.map((item) => {
    if (item.type === 'text' && item.open && event !== 'text') return { type: 'text' as const, text: item.text };
    if (item.type === 'reasoning' && item.open && event !== 'reasoning') {
      const { open: _open, ...closed } = item;
      return closed;
    }
    return item;
  });
  const last = next[next.length - 1];
  switch (event) {
    case 'conversation':
      // The person's words as stored: the seq an edit names from now on.
      if (typeof data.person === 'number')
        for (let at = next.length - 1; at >= 0; at--) {
          const item = next[at];
          if (item.type === 'person') {
            next[at] = { ...item, seq: data.person };
            break;
          }
        }
      return next;
    case 'reasoning': {
      const id = typeof data.id === 'string' && data.id ? data.id : 'r_0';
      const delta = typeof data.delta === 'string' ? data.delta : '';
      const redacted = data.redacted === true;
      const done = data.done === true;
      const durationMs = typeof data.durationMs === 'number' && Number.isFinite(data.durationMs) ? data.durationMs : undefined;
      const at = next.findIndex((item) => item.type === 'reasoning' && item.id === id);
      if (at >= 0) {
        const existing = next[at] as Extract<PanelItem, { type: 'reasoning' }>;
        const updated: Extract<PanelItem, { type: 'reasoning' }> = {
          type: 'reasoning',
          id,
          text: existing.text + delta,
          ...(existing.redacted || redacted ? { redacted: true as const } : {}),
          ...(durationMs !== undefined ? { durationMs } : existing.durationMs !== undefined ? { durationMs: existing.durationMs } : {}),
          ...(!done ? { open: true as const } : {}),
        };
        next[at] = updated;
      } else if (delta || redacted || done) {
        next.push({
          type: 'reasoning',
          id,
          text: delta,
          ...(redacted ? { redacted: true as const } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(!done ? { open: true as const } : {}),
        });
      }
      return next;
    }
    case 'text':
      if (typeof data.delta !== 'string') return next;
      if (last?.type === 'text' && last.open) next[next.length - 1] = { type: 'text', text: last.text + data.delta, open: true };
      else next.push({ type: 'text', text: data.delta, open: true });
      return next;
    case 'step':
      if (typeof data.id === 'string' && typeof data.tool === 'string' && typeof data.label === 'string')
        next.push({
          type: 'step',
          id: data.id,
          tool: data.tool,
          label: data.label,
          ...(data.failed === true ? { failed: true as const } : {}),
        });
      return next;
    case 'block_delta':
      if (typeof data.id === 'string' && record(data.block)) {
        const at = next.findIndex((item) => item.type === 'block' && item.id === data.id);
        const updated: Extract<PanelItem, { type: 'block' }> = {
          type: 'block',
          id: data.id,
          block: data.block as AssistantBlock,
          streaming: true,
        };
        if (at >= 0) next[at] = updated;
        else next.push(updated);
      }
      return next;
    case 'block':
      if (typeof data.id === 'string' && record(data.block)) {
        const at = next.findIndex((item) => item.type === 'block' && item.id === data.id);
        const finalBlock: Extract<PanelItem, { type: 'block' }> = {
          type: 'block',
          id: data.id,
          block: data.block as AssistantBlock,
        };
        if (at >= 0) next[at] = finalBlock;
        else next.push(finalBlock);
      }
      return next;
    case 'delegation': {
      if (
        typeof data.id === 'string' &&
        typeof data.agent === 'string' &&
        typeof data.agentName === 'string' &&
        typeof data.task === 'string' &&
        (data.status === 'running' || data.status === 'done' || data.status === 'error')
      ) {
        const delegation: DelegationItem = {
          type: 'delegation',
          id: data.id,
          ...(typeof data.fromAgent === 'string' ? { fromAgent: data.fromAgent } : {}),
          ...(typeof data.fromAgentName === 'string' ? { fromAgentName: data.fromAgentName } : {}),
          agent: data.agent,
          agentName: data.agentName,
          task: data.task,
          status: data.status,
          ...(typeof data.reasoning === 'string' && data.reasoning ? { reasoning: data.reasoning } : {}),
          ...(typeof data.summary === 'string' && data.summary ? { summary: data.summary } : {}),
          ...(Array.isArray(data.blocks) ? { blocks: data.blocks.filter(record) as AssistantBlock[] } : {}),
          ...(typeof data.durationMs === 'number' && Number.isFinite(data.durationMs) ? { durationMs: data.durationMs } : {}),
        };
        const at = next.findIndex((item) => item.type === 'delegation' && item.id === data.id);
        if (at >= 0) next[at] = delegation;
        else next.push(delegation);
      }
      return next;
    }
    case 'proposal':
      if (typeof data.id === 'string' && record(data.proposal))
        next.push({ type: 'proposal', id: data.id, proposal: data.proposal as unknown as Proposal });
      return next;
    case 'query':
      if (typeof data.id === 'string' && typeof data.q === 'string' && Array.isArray(data.evidence))
        next.push({
          type: 'query',
          id: data.id,
          q: data.q,
          ...(typeof data.resource === 'string' ? { resource: data.resource } : {}),
          total: typeof data.total === 'number' ? data.total : data.evidence.length,
          evidence: data.evidence.filter(
            (entry): entry is AskEvidence => record(entry) && typeof entry.ref === 'string' && typeof entry.label === 'string',
          ),
        });
      return next;
    case 'citations': {
      if (typeof data.id === 'string' && typeof data.query === 'string' && Array.isArray(data.items)) {
        const items: Citation[] = data.items
          .filter(
            (entry): entry is Record<string, unknown> =>
              record(entry) &&
              typeof entry.ref === 'number' &&
              typeof entry.source === 'string' &&
              typeof entry.resource === 'string' &&
              typeof entry.title === 'string' &&
              typeof entry.snippet === 'string',
          )
          .map((entry) => ({
            ref: entry.ref as number,
            source: entry.source as string,
            sourceLabel: typeof entry.sourceLabel === 'string' && entry.sourceLabel ? entry.sourceLabel : (entry.source as string),
            resource: entry.resource as string,
            title: entry.title as string,
            snippet: entry.snippet as string,
            ...(typeof entry.address === 'string' && inside(entry.address) ? { address: entry.address } : {}),
          }));
        if (items.length) {
          next.push({ type: 'citations', id: data.id, query: data.query, items });
        }
      }
      return next;
    }
    case 'memory': {
      if (
        typeof data.id === 'string' &&
        typeof data.memoryId === 'string' &&
        (data.action === 'remembered' || data.action === 'updated' || data.action === 'forgot') &&
        (data.scope === 'person' || data.scope === 'app')
      ) {
        next.push({
          type: 'memory',
          id: data.id,
          action: data.action,
          memoryId: data.memoryId,
          scope: data.scope,
          ...(typeof data.content === 'string' && data.content ? { content: data.content } : {}),
        });
      }
      return next;
    }
    case 'note':
      if (typeof data.text === 'string') next.push({ type: 'note', text: data.text });
      return next;
    case 'done':
      return next.map((item) => {
        if (item.type === 'block' && item.streaming) {
          const { streaming: _streaming, ...settled } = item;
          return settled;
        }
        return item;
      });
    default:
      return next;
  }
}

/** The items cut back to before the person's words at `at`, for an edit or a retry. */
export function cutAt(items: readonly PanelItem[], at: number): PanelItem[] {
  return items.slice(0, at);
}

/** The proposal still waiting for the person: the last one, if it has no outcome. One kept for review holds nothing up:
 * the turn went on past it, and it waits in the queue as well as here. */
export function waitingProposal(items: readonly PanelItem[]): Proposal | undefined {
  for (let at = items.length - 1; at >= 0; at--) {
    const item = items[at];
    if (item.type === 'person') return undefined;
    if (item.type === 'proposal' && !item.proposal.review) return item.outcome ? undefined : item.proposal;
  }
  return undefined;
}

/** The items grouped for drawing: consecutive steps fold into one group, and a turn's
 * passive citation shelves and memory whispers settle neatly beneath the reply they support. */
type DrawnItem =
  | { type: 'steps'; steps: Extract<PanelItem, { type: 'step' }>[]; at: number }
  | { type: 'item'; item: PanelItem; at: number };
export function grouped(items: readonly PanelItem[]): DrawnItem[] {
  const drawn: DrawnItem[] = [];
  let footers: Array<{ type: 'item'; item: PanelItem; at: number }> = [];
  const flushFooters = () => {
    if (!footers.length) return;
    // Place cited sources before quiet memory whispers for a calm reading hierarchy.
    for (const entry of footers) if (entry.item.type === 'citations') drawn.push(entry);
    for (const entry of footers) if (entry.item.type === 'memory') drawn.push(entry);
    footers = [];
  };
  items.forEach((item, at) => {
    if (item.type === 'person') {
      flushFooters();
      drawn.push({ type: 'item', item, at });
      return;
    }
    if (item.type === 'citations' || item.type === 'memory') {
      footers.push({ type: 'item', item, at });
      return;
    }
    const last = drawn[drawn.length - 1];
    if (item.type === 'step' && last?.type === 'steps') last.steps.push(item);
    else if (item.type === 'step') drawn.push({ type: 'steps', steps: [item], at });
    else drawn.push({ type: 'item', item, at });
  });
  flushFooters();
  return drawn;
}

/**
 * A turn whose connection to the server dropped before the answer finished: the network went, the server restarted,
 * or a proxy answered in its place ("Container suddenly disconnected" as a bare 500, a field report). There is no
 * sentence of the server's to say, only that the turn can be tried again.
 */
class ConnectionLost extends Error {
  // The panel says it in its own words (connectionLost); there is no sentence here to show.
  readonly lost = true;
}

/**
 * A turn: POSTed as `api()` posts (the App named, the account said), read
 * as a stream. Resolves when the stream ends; a refusal before it starts
 * throws with the server's sentence, and a turn cut off on the way throws
 * ConnectionLost.
 */
export async function stream(
  path: '/api/assistant/turn' | '/api/assistant/resolve',
  body: Record<string, unknown>,
  onEvent: (event: StreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const { url, payload } = scopeApiRequest(path, body, state.activeConnection);
  // A stop is the person's own, never a lost connection.
  const cut = (error: unknown): never => {
    throw signal.aborted ? error : new ConnectionLost();
  };
  const res = await fetchServer(url, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    // The account, and in a tenant App the tab's lease, from which alone the server takes the tenant.
    headers: { 'content-type': 'application/json', ...assistantHeaders() },
    body: JSON.stringify(payload),
  }).catch(cut);
  if (!res.ok || !res.body) {
    let message: string | undefined;
    try {
      const said = (await res.json()) as { error?: unknown };
      if (typeof said.error === 'string') message = said.error;
    } catch {
      /* Not the server's own answer. */
    }
    // A server error without the server's sentence was said by whatever stood between: a gateway, a proxy.
    if (message === undefined && res.status >= 500) throw new ConnectionLost();
    throw Object.assign(new Error(message ?? `${res.status}`), { status: res.status });
  }
  // Every turn the server finishes ends in `done`; a stream that closes before it was cut off.
  let finished = false;
  await readEvents(res.body, (event) => {
    if (event.event === 'done') finished = true;
    onEvent(event);
  }).catch(cut);
  if (!finished && !signal.aborted) throw new ConnectionLost();
}
