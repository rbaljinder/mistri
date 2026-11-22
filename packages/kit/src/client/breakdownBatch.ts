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
 *
 * A free-form page's reads ride it too (`batchedView`): its `useRows`, its
 * records and its pickers' choices are each a `/api/view/run`, and a page of
 * nineteen lists was nineteen requests at once, each its own admission and
 * person looked up (a field report: 45 ms to the database, so the requests
 * queued behind each other's sockets). They go with the page's name
 * (`x-mistri-page`), so only reads of one page share a request, and the server
 * holds the whole batch to that page's manifest as it would each read.
 */
import { api, pageApi } from './core.js';
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
  | { text: string; def?: never; run?: never; view?: never }
  | { def: HttpBreakdownDefinition; text?: never; run?: never; view?: never }
  /* A list's first page, as `/api/run` takes it. */
  | { run: RunAsk; text?: never; def?: never; view?: never }
  /* A view's rows, as `/api/view/run` takes them: a free-form page's read. */
  | { view: Record<string, unknown>; text?: never; def?: never; run?: never }
) & {
  limit?: number;
  owner?: Record<string, string>;
  /* The free-form page that asks (`x-mistri-page`): a request carries one page's name, so its reads ride alone. */
  page?: string;
};
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
  ask.view
    ? { view: ask.view }
    : ask.run
      ? { run: ask.run }
      : { ...(ask.def ? { def: ask.def } : { text: ask.text }), ...(ask.limit ? { limit: ask.limit } : {}) };
/* Sent as the page's own request when a page asks, so the server holds it to that page's manifest. */
const sendAs = (ask: BreakdownAsk, path: string, body: Record<string, unknown>): Promise<unknown> =>
  ask.page
    ? pageApi(ask.page, path, body)
    : (api as unknown as (path: string, body: Record<string, unknown>) => Promise<unknown>)(path, body);
const single = (ask: BreakdownAsk) =>
  ask.view
    ? sendAs(ask, '/api/view/run', { ...ask.view, ...ask.owner })
    : ask.run
      ? sendAs(ask, '/api/run', { ...ask.run, ...ask.owner })
      : sendAs(ask, '/api/breakdown', { ...item(ask), ...ask.owner });

/** A list's first page, answered as `/api/run` would answer it, asked with the breakdowns of the same moment. */
export function batchedRun<T = unknown>(run: RunAsk, owner?: Record<string, string>): Promise<T> {
  return batchedBreakdown<T>({ run, ...(owner ? { owner } : {}) });
}

/**
 * A view's rows, answered as `/api/view/run` would answer them (a refusal the
 * language says is `{ errors }`, as there), asked with the reads of the same
 * moment: a free-form page's `useRows`, records and choices (ui-sdk host.tsx).
 */
export async function batchedView<T = unknown>(view: Record<string, unknown>, page?: string): Promise<T> {
  /* A record page's custom section reads what the page's compose may have brought (composedReads.ts). */
  if (mayBeComposed('/api/view/run')) {
    const composed = await composedReply('/api/view/run', view);
    if (composed !== undefined) return composed as T;
  }
  return queued<T>({ view, ...(page ? { page } : {}) });
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
  return queued<T>(ask);
}

function queued<T>(ask: BreakdownAsk): Promise<T> {
  if (unsupported) return single(ask) as Promise<T>;
  return new Promise<T>((resolve, reject) => {
    queue.push({ ask, resolve: resolve as (value: unknown) => void, reject });
    if (scheduled) return;
    scheduled = true;
    /* A macrotask, not a microtask: the cards of one render mount their
       queries across several microtasks, and a timer is after all of them.
       So do a free-form page's sections: each `useRows` is a query whose
       fetch TanStack starts from its own effect after the commit, and sibling
       components' effects, and a refetch's invalidated queries, are spread
       over microtasks that one queued microtask would run between. A timer
       of 0 runs after every one of them, before the browser paints again. */
    setTimeout(flush, 0);
  });
}

async function flush() {
  scheduled = false;
  const waiting = queue;
  queue = [];
  const owners = new Map<string, Pending[]>();
  for (const pending of waiting) {
    const key = JSON.stringify([pending.ask.owner ?? {}, pending.ask.page ?? null]);
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
    reply = await sendAs(batch[0]!.ask, '/api/breakdowns', { items: batch.map(({ ask }) => item(ask)), ...batch[0]!.ask.owner });
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
  batch.forEach(({ ask, resolve, reject }, index) => {
    const { status, body } = results[index]!;
    if (status < 400) return resolve(sameReads(body, reply));
    /* A page's read the batch refused is asked again alone, so its failure is the one its own request meets — its
       code, its sign-in, the author's cause — wherever the host maps a refusal. A refused read is the rare case. */
    if (ask.view) return void single(ask).then(resolve, reject);
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
