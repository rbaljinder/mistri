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
}
export type AssistantBlock =
  | { kind: 'section'; section: Record<string, unknown> }
  | { kind: 'record'; table: string; key: Record<string, unknown>; title: string; values: Record<string, unknown>; address?: string };

export type PanelItem =
  /** `seq` is the stored event's, once the server has said it; edit names it. */
  | { type: 'person'; seq?: number; text: string }
  /** `open` while the model is still writing it. */
  | { type: 'text'; text: string; open?: true }
  | { type: 'note'; text: string }
  | { type: 'step'; id: string; tool: string; label: string; failed?: true }
  | { type: 'block'; id: string; block: AssistantBlock }
  | { type: 'proposal'; id: string; proposal: Proposal; outcome?: ProposalOutcome };

export interface StreamEvent {
  event: string;
  data: Record<string, unknown>;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** A run of the model's words: plain, bold, code, or a link to an address inside the App. */
export type Run = { text: string; mark?: 'strong' | 'code' } | { text: string; link: string };
export type Paragraph = { list: false; lines: Run[][] } | { list: true; lines: Run[][] };

/* An inside address only: a path, never a scheme or another host. */
export const inside = (href: string): boolean => /^\/(?!\/)[^\s\\]*$/.test(href);

/**
 * The model's words as paragraphs and lists of runs, read with three marks
 * and nothing else. Text, never markup: a link to anywhere but a path in the
 * App is said as its words alone.
 */
export function wordsOf(text: string): Paragraph[] {
  const runs = (line: string): Run[] => {
    const found: Run[] = [];
    const pattern = /\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;
    let from = 0;
    for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
      if (match.index > from) found.push({ text: line.slice(from, match.index) });
      if (match[1] !== undefined) found.push(inside(match[2]) ? { text: match[1], link: match[2] } : { text: match[1] });
      else if (match[3] !== undefined) found.push({ text: match[3], mark: 'strong' });
      else found.push({ text: match[4], mark: 'code' });
      from = match.index + match[0].length;
    }
    if (from < line.length) found.push({ text: line.slice(from) });
    return found;
  };
  return text
    .trim()
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((paragraph) => {
      const lines = paragraph.split('\n');
      const list = lines.every((line) => /^\s*[-*] /.test(line));
      return { list, lines: lines.map((line) => runs(list ? line.replace(/^\s*[-*] /, '') : line)) };
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
  const next = items.map((item) =>
    item.type === 'text' && item.open && event !== 'text' ? { type: 'text' as const, text: item.text } : item,
  );
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
    case 'block':
      if (typeof data.id === 'string' && record(data.block)) next.push({ type: 'block', id: data.id, block: data.block as AssistantBlock });
      return next;
    case 'proposal':
      if (typeof data.id === 'string' && record(data.proposal))
        next.push({ type: 'proposal', id: data.id, proposal: data.proposal as unknown as Proposal });
      return next;
    case 'note':
      if (typeof data.text === 'string') next.push({ type: 'note', text: data.text });
      return next;
    default:
      return next;
  }
}

/** The items cut back to before the person's words at `at`, for an edit or a retry. */
export function cutAt(items: readonly PanelItem[], at: number): PanelItem[] {
  return items.slice(0, at);
}

/** The proposal still waiting for the person: the last one, if it has no outcome. */
export function waitingProposal(items: readonly PanelItem[]): Proposal | undefined {
  for (let at = items.length - 1; at >= 0; at--) {
    const item = items[at];
    if (item.type === 'person') return undefined;
    if (item.type === 'proposal') return item.outcome ? undefined : item.proposal;
  }
  return undefined;
}

/** The items grouped for drawing: consecutive steps fold into one group. */
type DrawnItem =
  | { type: 'steps'; steps: Extract<PanelItem, { type: 'step' }>[]; at: number }
  | { type: 'item'; item: PanelItem; at: number };
export function grouped(items: readonly PanelItem[]): DrawnItem[] {
  const drawn: DrawnItem[] = [];
  items.forEach((item, at) => {
    const last = drawn[drawn.length - 1];
    if (item.type === 'step' && last?.type === 'steps') last.steps.push(item);
    else if (item.type === 'step') drawn.push({ type: 'steps', steps: [item], at });
    else drawn.push({ type: 'item', item, at });
  });
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
