/**
 * A first page with its data in it (shared/firstPaint.ts says why).
 *
 * When the shell is served for an address, the server asks itself what the
 * page will ask first — who is here, the runtime, the App, its schema, its
 * pages and saved views, then the first room's own reads — and writes each
 * answer into the page, in a `<script type="application/json">` block the
 * client reads instead of fetching. Nothing here decides what anyone may
 * read: every answer is the reply of the route a fetch would reach, asked
 * through the whole dispatcher (`Loop`, handler.ts) with the page request's
 * own headers — its cookie, its proxy identity, its host — so the gate, the
 * App's grants, a row policy and a public visitor's grant all apply exactly
 * as they would to the fetch. A read that route refuses, fails, or answers
 * with anything but JSON is left out, and the client asks it itself and is
 * told in its own words.
 *
 * Nothing is read from the request but its address: the path and the query
 * parameters say which room; the headers only ride along to the routes, as
 * a fetch's would. An answer that sets a cookie (a public form's claim) is
 * never carried — a cookie is the client's to receive from its own request
 * — nor one whose reply says something only its headers can
 * (`x-mistri-search`).
 *
 * The block is bounded (MOST): answers are written in the order the page
 * needs them, and one that would take the page past the bound is left for
 * the client to ask. A page that carries any answer is one person's: it is
 * sent `private` and never stored by a shared cache (clientHttp.ts).
 */
import { Readable } from 'node:stream';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { itemKey, readKey, type FirstPaintRead, type FirstPaintItemKind } from '../../shared/firstPaint.js';
import { BREAKDOWN_BATCH } from '../resourceReadHttp.js';
import { COUNT_EACH_MAX } from '../../shared/reads.js';

/** The most JSON a page carries, in bytes before compression: a wide catalog's schema is a third of it. */
const MOST = 1024 * 1024;

/**
 * How long a page waits for its answers, in ms. The page's head and scripts
 * are already on their way (clientHttp.ts streams it), so this is only how
 * long the block holds the end of the page: a read that takes longer is left
 * for the client to ask, and a slow room costs its own read, never the page.
 */
let BUDGET = 1500;

/** For tests on a busy machine: how long a page waits for its answers. */
export function setFirstPaintBudget(ms: number): void {
  BUDGET = ms;
}

/** One route's reply, as the dispatcher answered a request the server asked itself. */
export interface LoopAnswer {
  status: number;
  body: unknown;
  /** `x-mistri-account`: who the reply said it was for. */
  account?: string;
  /** Whether it may be carried: no cookie set, no header the client reads from a reply. */
  carriable: boolean;
}

/** Ask the dispatcher one request, as this page's reader (handler.ts). */
export type Loop = (
  method: 'GET' | 'POST',
  target: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<LoopAnswer | undefined>;

/* A page request's headers that describe the navigation rather than who is
   asking: a fetch from the page carries its own. */
const NAVIGATION = new Set([
  'if-none-match',
  'if-modified-since',
  'if-match',
  'if-unmodified-since',
  'if-range',
  'range',
  'accept',
  'accept-encoding',
  'content-type',
  'content-length',
  'transfer-encoding',
  'origin',
  'referer',
  'upgrade-insecure-requests',
  'purpose',
  'sec-purpose',
  'cache-control',
  'pragma',
  'expect',
  'x-mistri-account',
]);

/**
 * The request a fetch from this page would make: the page's own headers —
 * its cookie, its proxy identity, its host — for the page's own origin, as
 * `fetch` sends them (same-origin, JSON), and the body, if any. Enough of
 * IncomingMessage for the gate, the auth store and the body reader.
 */
export function loopbackRequest(
  page: IncomingMessage,
  method: 'GET' | 'POST',
  target: string,
  body?: Record<string, unknown>,
): IncomingMessage {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
  const headers: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(page.headers)) {
    if (value !== undefined && !NAVIGATION.has(name) && !name.startsWith('sec-fetch-')) headers[name] = value;
  }
  Object.assign(
    headers,
    { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
    payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {},
  );
  const stream = Readable.from(payload ? [payload] : []);
  const socket = page.socket;
  return Object.assign(stream, {
    method,
    url: target,
    headers,
    httpVersion: page.httpVersion,
    httpVersionMajor: page.httpVersionMajor,
    httpVersionMinor: page.httpVersionMinor,
    complete: true,
    aborted: false,
    socket: {
      remoteAddress: socket?.remoteAddress,
      remotePort: socket?.remotePort,
      remoteFamily: socket?.remoteFamily,
      localAddress: socket?.localAddress,
      localPort: socket?.localPort,
      encrypted: (socket as { encrypted?: boolean } | undefined)?.encrypted,
    },
  }) as unknown as IncomingMessage;
}

/** The answers a page carries, in the order it needs them. */
class Carried {
  readonly reads: Array<[key: string, read: { body: unknown; account?: string }]> = [];
  readonly items: Array<[key: string, read: FirstPaintRead]> = [];

  read(method: 'GET' | 'POST', target: string, body: Record<string, unknown> | undefined, answer: LoopAnswer | undefined): unknown {
    if (!answer) return undefined;
    if (!ok(answer)) return undefined;
    // A placed form owns a fresh operation token. Never inline it even if a
    // caller accidentally marks the response as carriable.
    if (answer.body && typeof answer.body === 'object' && Object.hasOwn(answer.body, 'placement')) return undefined;
    if (answer.carriable)
      this.reads.push([readKey(method, target, body), { body: answer.body, ...(answer.account ? { account: answer.account } : {}) }]);
    return answer.body;
  }

  item(kind: FirstPaintItemKind, owner: string, item: unknown, body: unknown, account?: string): void {
    if (body && typeof body === 'object' && Object.hasOwn(body, 'placement')) return;
    this.items.push([itemKey(kind, owner, item), { body, ...(account ? { account } : {}) }]);
  }

  /**
   * The block's JSON, within the bound: whatever would pass it is left for the
   * client to ask. Each answer is serialized once, and the block is joined from
   * those pieces: it used to be serialized to be measured and again to be sent,
   * which was the most expensive thing a page load did on a busy server.
   */
  json(most: number): string | undefined {
    let size = 32;
    const take = (entries: ReadonlyArray<[string, unknown]>): Map<string, string> => {
      const kept = new Map<string, string>();
      for (const [key, value] of entries) {
        const name = JSON.stringify(key);
        const body = JSON.stringify(value);
        const cost = Buffer.byteLength(escapeData(name)) + Buffer.byteLength(escapeData(body)) + 2;
        if (size + cost > most) continue;
        kept.set(name, body);
        size += cost;
      }
      return kept;
    };
    const reads = take(this.reads);
    const items = take(this.items);
    if (!reads.size && !items.size) return undefined;
    const object = (kept: Map<string, string>) => `{${[...kept].map(([name, body]) => `${name}:${body}`).join(',')}}`;
    return `{"reads":${object(reads)},"items":${object(items)}}`;
  }
}

/** A reply the client would take as an answer: a success, in JSON, that says no error. */
function ok(answer: LoopAnswer): boolean {
  if (answer.status < 200 || answer.status >= 300 || answer.body === null || typeof answer.body !== 'object') return false;
  return !('error' in answer.body);
}

/* The most items each batch route takes at once (resourceReadHttp.ts BREAKDOWN_BATCH, shared/reads.ts COUNT_EACH_MAX). */
const BATCH_MOST = { '/api/breakdowns': BREAKDOWN_BATCH, '/api/counts': COUNT_EACH_MAX } as const;

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
};

/** What the page's data block holds for one address. */
interface FirstPaintPage {
  json?: string;
}

/** One request a room makes, exactly as the client sends it. */
export interface RoomRead {
  method: 'GET' | 'POST';
  target: string;
  body?: Record<string, unknown>;
}

/** Reads the client carries in a batch, asked here in one; each item is answered under its own key. */
export interface RoomBatch {
  path: keyof typeof BATCH_MOST;
  kind: FirstPaintItemKind;
  /** What the batch carries beside its items (`countLimit`). */
  body?: Record<string, unknown>;
  /** Each item: the key it is answered under, what the batch sends for it, and its kind where not the batch's (a list's rows among breakdowns). */
  items: Array<{ key: unknown; sent: unknown; kind?: FirstPaintItemKind }>;
  /** A batch result as the client takes it for one item, or undefined for none. */
  unwrap?: (result: unknown) => unknown;
}

/** What a room asks first: its reads, and its batches. */
export interface RoomPlan {
  reads: RoomRead[];
  batches: RoomBatch[];
}

/** Ask one request as the page's reader, and carry its answer where it may be carried; the answer, or none. */
type PaintAsk = (method: 'GET' | 'POST', target: string, body?: Record<string, unknown>) => Promise<unknown>;

/**
 * What a product's first page asks past who-am-I and the runtime: an App's
 * public pages, its App and its first room (the App framework's
 * firstPaintRooms.ts). Without one — the database browser — a page carries
 * who-am-I and the runtime, and its rooms ask for the rest.
 */
export interface PaintRooms {
  /** The reads of a page that is all its own reads (an App's public form, its landing), asked before who-am-I; none for any other. */
  alone(path: string): readonly RoomRead[] | undefined;
  /**
   * Once who-am-I and the runtime have answered: what the shell asks next,
   * through `ask`, and then the App the page is for and its room's plan, or
   * none where the page draws no room of an App.
   */
  room(page: {
    path: string;
    search: string;
    /** The page's first segment, decoded: the App its address names, where it names one. */
    requested: string | null;
    me: Record<string, unknown>;
    runtime: Record<string, unknown>;
    ask: PaintAsk;
  }): Promise<{ app: string; plan: RoomPlan } | undefined>;
}

/**
 * The answers for the page at `path` (its inside form, shared/mount.ts)
 * with `search`: what boot.js asks, in its order, and then what the first
 * room asks (`rooms`, an App's: firstPaintRooms.ts). Each round's requests
 * are asked together.
 */
export async function firstPaint({
  path,
  search,
  loop: asked,
  most = MOST,
  budget = BUDGET,
  rooms,
}: {
  path: string;
  search: string;
  loop: Loop;
  most?: number;
  budget?: number;
  /** What the product's page asks past who-am-I and the runtime (PaintRooms), or nothing more. */
  rooms?: PaintRooms;
}): Promise<FirstPaintPage> {
  const carried = new Carried();
  /* Past the budget every answer still out is none: the client asks it. */
  const controller = new AbortController();
  const deadline = performance.now() + Math.max(0, budget);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(
      () => {
        controller.abort();
        resolve(undefined);
      },
      Math.max(0, budget),
    );
  });
  const loop: Loop = (method, target, body) => {
    // A completed earlier stage must not launch more work after the deadline.
    if (controller.signal.aborted || performance.now() >= deadline) return Promise.resolve(undefined);
    const answer = asked(method, target, body, controller.signal).then(
      (value) => (performance.now() < deadline ? value : undefined),
      () => undefined,
    );
    return Promise.race([answer, late]);
  };
  try {
    return await answered(carried, path, search, loop, most, rooms);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function answered(
  carried: Carried,
  path: string,
  search: string,
  loop: Loop,
  most: number,
  rooms: PaintRooms | undefined,
): Promise<FirstPaintPage> {
  const ask: PaintAsk = async (method, target, body) => carried.read(method, target, body, await loop(method, target, body));
  const done = (): FirstPaintPage => ({ json: carried.json(most) });

  /* A page that is all its own reads is asked for before who-am-I (boot.js). */
  const alone = rooms?.alone(path);
  if (alone) {
    for (const read of alone) await ask(read.method, read.target, read.body);
    return done();
  }

  const first = path.split('/').filter(Boolean)[0];
  let requested: string | null = null;
  try {
    requested = first ? decodeURIComponent(first) : null;
  } catch {
    return done();
  }
  const [me, runtime] = (await Promise.all([
    ask('GET', requested ? `/api/whoami?${new URLSearchParams({ app: requested })}` : '/api/whoami'),
    ask('GET', '/api/runtime'),
  ])) as [Record<string, unknown> | undefined, Record<string, unknown> | undefined];
  if (!me || !runtime || !rooms) return done();
  const room = await rooms.room({ path, search, requested, me, runtime, ask });
  if (!room) return done();
  const { app: selected, plan } = room;
  await Promise.all([
    ...plan.reads.map((read) => ask(read.method, read.target, read.body)),
    ...plan.batches.flatMap((batch) =>
      chunks(batch.items, BATCH_MOST[batch.path]).map(async (items) => {
        const answer = await loop('POST', batch.path, { ...batch.body, items: items.map((item) => item.sent), app: selected });
        // Individual batch items have no response headers for the client to check.
        // Keep them only when the batch belongs to the identity boot established.
        const account = typeof me.accountId === 'string' ? me.accountId : undefined;
        const results =
          answer && ok(answer) && answer.carriable && answer.account === account
            ? (answer.body as { results?: unknown }).results
            : undefined;
        if (!Array.isArray(results) || results.length !== items.length) return;
        items.forEach((item, index) => {
          const body = batch.unwrap ? batch.unwrap(results[index]) : results[index];
          if (body !== undefined) carried.item(item.kind ?? batch.kind, selected, item.key, body, answer?.account);
        });
      }),
    ),
  ]);
  return done();
}

/**
 * The data block, as the page carries it: JSON with every `<`, `>` and `&`
 * written as its escape, and the two line separators JavaScript once took
 * for line ends, so no value — a row's text is anybody's — can close the
 * script element, open a comment inside it, or be read as markup.
 */
export function firstPaintBlock(id: string, json: string): string {
  return `<script type="application/json" id="${id}">${escapeData(json)}</script>`;
}

/** Count the same escaped UTF-8 bytes that will be sent, including hostile text. */
const escapeData = (json: string): string =>
  json.replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
