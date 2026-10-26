/**
 * A dashboard's breakdowns, and its lists, asked for together.
 *
 * Every card on a home asks for its number, a compare window's number and a
 * spark, and every chart and table once more: about thirty requests for eight
 * cards, queued behind one active connection and six browser sockets. The
 * cards still each ask for what they need (React Query keys, caches and
 * refetches each one); this only carries the questions that are asked in the
 * same moment in one request (`/api/breakdowns`) and hands each card its own
 * answer, or its own error. A dashboard's lists (its tables, the aside's
 * rows) are carried the same way (`batchedRun`): on a home, they were eight
 * requests of their own, each a round trip for a statement or two.
 *
 * A server that does not take a batch — a support session inside a tenant,
 * whose every read is ledgered as the one read it is, answers 404, and so does
 * an older server — is asked one at a time for the rest of the page's life.
 * A tenant or platform lease takes it: one admission for the cards, not one each.
 */
import { api } from './core.js';
import { sameReads } from './liveReads.js';
import { composedReply, mayBeComposed } from './composedReads.js';
import { composedConnection } from './composedHook.js';
import { firstPaintItem } from './firstPaint.js';
import type { HttpBreakdownDefinition } from '@mistriwork/engine/shared/resourceHttp.js';
import { say } from './copy/dashboards/breakdownBatch.js';

/** A line of the language, or the structured breakdown a page's plan built;
 * `owner` routes it as `ownedBy` would (a page's own connection), and only
 * asks that go to the same owner share a request. */
type BreakdownAsk = (
  | { text: string; def?: never; run?: never }
  | { def: HttpBreakdownDefinition; text?: never; run?: never }
  /* A list's first page, as `/api/run` takes it. */
  | { run: RunAsk; text?: never; def?: never }
) & { limit?: number; owner?: Record<string, string> };
interface RunAsk {
  q: string;
  limit: number;
  offset?: number;
  count?: 'none';
  exactCount?: boolean;
}

interface Pending {
  ask: BreakdownAsk;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

/* The server's own ceiling (resourceReadHttp.ts, BREAKDOWN_BATCH). */
const MOST = 48;
let queue: Pending[] = [];
let scheduled = false;
/* Set once a server says it has no such route; the rest of the page's life
   asks one at a time rather than being refused again. */
let unsupported = false;

const item = (ask: BreakdownAsk) =>
  ask.run ? { run: ask.run } : { ...(ask.def ? { def: ask.def } : { text: ask.text }), ...(ask.limit ? { limit: ask.limit } : {}) };
const single = (ask: BreakdownAsk) =>
  ask.run
    ? api('/api/run', { ...ask.run, ...ask.owner } as Parameters<typeof api<'/api/run'>>[1])
    : api('/api/breakdown', { ...item(ask), ...ask.owner } as Parameters<typeof api<'/api/breakdown'>>[1]);

/** A list's first page, answered as `/api/run` would answer it, asked with the breakdowns of the same moment. */
export function batchedRun<T = unknown>(run: RunAsk, owner?: Record<string, string>): Promise<T> {
  return batchedBreakdown<T>({ run, ...(owner ? { owner } : {}) });
}

/** One breakdown, answered as `/api/breakdown` would answer it. */
export async function batchedBreakdown<T = unknown>(ask: BreakdownAsk): Promise<T> {
  /* A record page's figures come with its compose (composedReads.ts). */
  if (mayBeComposed('/api/breakdown')) {
    const composed = await composedReply('/api/breakdown', { ...item(ask), ...ask.owner });
    if (composed !== undefined) return composed as T;
  }
  /* A first page's sections come with the page (firstPaint.ts), each by what it asks. */
  const carried = firstPaintItem(ask.run ? 'run' : 'breakdown', ask.owner?.app ?? ask.owner?.conn ?? composedConnection(), item(ask));
  if (carried !== undefined) return carried as T;
  if (unsupported) return single(ask) as Promise<T>;
  return new Promise<T>((resolve, reject) => {
    queue.push({ ask, resolve: resolve as (value: unknown) => void, reject });
    if (scheduled) return;
    scheduled = true;
    /* A macrotask, not a microtask: the cards of one render mount their
       queries across several microtasks, and a timer is after all of them. */
    setTimeout(flush, 0);
  });
}

async function flush() {
  scheduled = false;
  const waiting = queue;
  queue = [];
  const owners = new Map<string, Pending[]>();
  for (const pending of waiting) {
    const key = JSON.stringify(pending.ask.owner ?? {});
    owners.set(key, [...(owners.get(key) ?? []), pending]);
  }
  for (const group of owners.values()) {
    for (let start = 0; start < group.length; start += MOST) void send(group.slice(start, start + MOST));
  }
}

async function send(batch: Pending[]) {
  if (batch.length === 1) {
    const [only] = batch;
    return single(only!.ask).then(only!.resolve, only!.reject);
  }
  let results: Array<{ status: number; body: unknown }>;
  let reply: unknown;
  try {
    reply = await api('/api/breakdowns', { items: batch.map(({ ask }) => item(ask)), ...batch[0]!.ask.owner });
    const said = reply as { results?: typeof results } | undefined;
    results = Array.isArray(said?.results) && said.results.length === batch.length ? said.results : [];
    if (!results.length) throw Object.assign(new Error(say('theBreakdownBatchCame')), { status: 404 });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404 || status === 405) unsupported = true;
    /* Whatever refused the batch, each card is owed its own answer: asked
       alone, a card gets the error its own read would, not the batch's. */
    for (const { ask, resolve, reject } of batch) single(ask).then(resolve, reject);
    return;
  }
  batch.forEach(({ resolve, reject }, index) => {
    const { status, body } = results[index]!;
    if (status < 400) return resolve(sameReads(body, reply));
    const said = body as { error?: string; message?: string } | null;
    reject(Object.assign(new Error(said?.message ?? said?.error ?? say('common.requestFailed', { status })), { status }));
  });
}

/** For tests: forget that a server refused the batch. */
export function resetBreakdownBatch() {
  queue = [];
  scheduled = false;
  unsupported = false;
}
