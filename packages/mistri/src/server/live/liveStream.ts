/**
 * One `/api/live` stream: a reader's subscription to the databases an App
 * reads, written as server-sent events.
 *
 *   hello  {cursor}                      once, first; a replay follows it as one change or a reset
 *   change {cursor, tables, self?, primary?}
 *   reset  {cursor}                      refetch everything once
 *   end    {reason}                      the server closed it; reconnect with the cursor
 *   : (a comment)                        every 25 s while nothing else is said
 *
 * `tables` is `{<table id>: {keys: [...] | "many", kinds: [...]}}`, each key
 * the record's key columns as the reader reads them. The cursor is opaque to
 * the client: a change row id per database, joined with `.` where the App
 * reads several.
 *
 * Changes are coalesced over 250 ms. A stream lives ten minutes and then
 * ends, so a reconnect re-reads everything about the reader; its authority is
 * resolved again every 30 s meanwhile, and a resolution that fails (a session
 * that expired, a lease released, a membership revoked) ends it. A stream
 * that cannot keep up — 64 KiB unread for ten seconds — is dropped; the client
 * reconnects with its cursor and replays. There are at most 2,000 streams in
 * a process and eight per account; past either the answer is 503 with
 * Retry-After, and the page keeps its focus refresh.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LiveKey } from '../../adapters/live/liveChange.js';
import type { LiveAuthority, LiveDelivery } from './liveFilter.js';
import { guard, type LiveHub, type LiveTap } from './liveHub.js';
import type { LivePosition } from './liveStore.js';

const LIVE_LIMITS = Object.freeze({
  streams: 2_000,
  perAccount: 8,
  coalesceMs: 250,
  heartbeatMs: 25_000,
  lifetimeMs: 10 * 60_000,
  authorityMs: 30_000,
  backlogBytes: 64 * 1024,
  stalledMs: 10_000,
  retryAfterSeconds: 30,
});
type LiveLimits = { readonly [K in keyof typeof LIVE_LIMITS]: number };

interface LiveStreamOptions {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  /** Who the per-account cap counts this stream against: the verified account, or the visitor's address. */
  readonly account: string;
  readonly hubs: readonly LiveHub[];
  /** The cursor the client asked to resume from, as `hello` gave it. */
  readonly cursor?: string;
  /** The authority on each hub, in `hubs` order, resolved now. */
  readonly authority: readonly LiveAuthority[];
  /** Resolve the authority again, the session and every scope with it; a throw ends the stream. */
  readonly resolve: () => Promise<readonly LiveAuthority[]>;
  /** Headers a stream answer carries beside its own (the tenant lease's). */
  readonly headers?: Readonly<Record<string, string>>;
  /** The App's resources kept out of live sync (`live: false`), said in `hello` so the page never treats them as followed. */
  readonly off?: readonly string[];
  readonly now?: () => number;
  readonly limits?: Partial<LiveLimits>;
}

/* Every open stream, for the caps and the server's close. */
const streams = new Set<LiveStream>();
const byAccount = new Map<string, number>();
let heartbeat: ReturnType<typeof setInterval> | undefined;

/** End every stream: the server is stopping. */
export function closeLiveStreams(): void {
  for (const stream of [...streams]) stream.end('stopping');
}

/** End the streams written to these responses (one server's, as it retires). */
export function endLiveStreams(responses: Iterable<ServerResponse>, reason: 'stopping'): void {
  const ending = new Set(responses);
  for (const stream of [...streams]) if (ending.has(stream.response)) stream.end(reason);
}

class LiveStream {
  private readonly taps: LiveTap[] = [];
  private readonly positions: Array<LivePosition | undefined>;
  private authority: readonly LiveAuthority[];
  private resolvedAt: number;
  private resolving?: Promise<readonly LiveAuthority[]>;
  private opened = false;
  private ended = false;
  private wantsReset = false;
  private pending?: { tables: LiveDelivery['tables']; self: boolean; primary: boolean };
  private flushTimer?: ReturnType<typeof setTimeout>;
  private lifetime?: ReturnType<typeof setTimeout>;
  private refresher?: ReturnType<typeof setInterval>;
  private stalledSince?: number;
  private readonly limits: LiveLimits;
  private readonly now: () => number;

  get response(): ServerResponse {
    return this.options.res;
  }

  constructor(private readonly options: LiveStreamOptions) {
    this.limits = { ...LIVE_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    this.authority = options.authority;
    this.resolvedAt = this.now();
    this.positions = options.hubs.map(() => undefined);
  }

  async open(): Promise<void> {
    const { res, req, hubs } = this.options;
    res.writeHead(200, {
      ...this.options.headers,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    });
    /* `retry`: a restarted server is back within a second or two (the client's own backoff governs after that). */
    res.write('retry: 2000\n\n');
    const done = () => guard('stream', () => this.end(undefined));
    req.once('close', done);
    res.once('close', done);
    res.on('drain', () => guard('stream', () => this.flush()));
    const cursors = this.cursorParts();
    hubs.forEach((_hub, index) => {
      const tap: LiveTap = {
        ...(cursors ? { cursor: cursors[index] } : {}),
        authority: async () => (await this.current())[index],
        receive: (delivery, position, replay, primary) => {
          this.positions[index] = position;
          if (replay && delivery.unkeyed) this.wantsReset = true;
          this.add(delivery, primary);
        },
        placed: (position) => {
          this.positions[index] = position;
        },
        reset: (position) => {
          this.positions[index] = position;
          this.wantsReset = true;
          if (this.opened) this.schedule();
        },
        fail: () => this.end('unavailable'),
      };
      this.taps.push(tap);
    });
    /* A cursor that does not fit these databases is another App's, or older than a change of connections: start over. */
    if (this.options.cursor !== undefined && !cursors) this.wantsReset = true;
    try {
      await Promise.all(hubs.map((hub, index) => hub.attach(this.taps[index])));
    } catch {
      return this.end('unavailable');
    }
    if (this.ended) return;
    this.opened = true;
    /* Before a replay, hello holds the cursor asked for: a client that drops before the replay's change asks for it again. */
    const replaying = Boolean(this.pending || this.wantsReset) && this.cursorParts() !== undefined;
    const off = this.options.off ?? [];
    this.write('hello', { cursor: replaying ? this.options.cursor! : this.cursor(), ...(off.length ? { off } : {}) });
    this.lifetime = setTimeout(() => guard('stream', () => this.end('lifetime')), this.limits.lifetimeMs);
    this.lifetime.unref?.();
    this.refresher = setInterval(() => guard('stream', () => this.current().catch(() => {})), this.limits.authorityMs);
    this.refresher.unref?.();
    if (this.wantsReset || this.pending) this.flush();
  }

  private cursorParts(): string[] | undefined {
    const cursor = this.options.cursor;
    if (cursor === undefined) return undefined;
    const parts = cursor.split('.');
    return parts.length === this.options.hubs.length && parts.every((part) => /^(0|[1-9][0-9]{0,18})$/.test(part)) ? parts : undefined;
  }

  private cursor(): string {
    const parts = this.cursorParts();
    return this.positions.map((position, index) => position?.id ?? parts?.[index] ?? '0').join('.');
  }

  /** The authority, resolved again once stale; a failure ends the stream. */
  private current(): Promise<readonly LiveAuthority[]> {
    if (this.ended) return Promise.reject(new Error('ended'));
    if (this.now() - this.resolvedAt < this.limits.authorityMs) return Promise.resolve(this.authority);
    this.resolving ??= this.options
      .resolve()
      .then(
        (authority) => {
          if (authority.length !== this.options.hubs.length) throw new Error('The databases this reader reads changed.');
          this.authority = authority;
          this.resolvedAt = this.now();
          return authority;
        },
        (error: unknown) => {
          this.end('authority');
          throw error;
        },
      )
      .finally(() => {
        this.resolving = undefined;
      });
    return this.resolving;
  }

  private add(delivery: LiveDelivery, primary: boolean): void {
    if (!delivery.tables.size) return;
    const pending = (this.pending ??= { tables: new Map(), self: true, primary: false });
    for (const [id, table] of delivery.tables) {
      const known = pending.tables.get(id);
      if (!known) {
        pending.tables.set(id, { keys: table.keys === 'many' ? 'many' : new Map(table.keys), kinds: new Set(table.kinds) });
        continue;
      }
      for (const kind of table.kinds) known.kinds.add(kind);
      if (table.keys === 'many' || known.keys === 'many') known.keys = 'many';
      else for (const [text, key] of table.keys) known.keys.set(text, key);
    }
    pending.self &&= delivery.self;
    pending.primary ||= primary;
    if (this.opened) this.schedule();
  }

  private schedule(): void {
    if (this.flushTimer || this.ended) return;
    this.flushTimer = setTimeout(
      () =>
        guard('stream', () => {
          this.flushTimer = undefined;
          this.flush();
        }),
      this.limits.coalesceMs,
    );
    this.flushTimer.unref?.();
  }

  /** Write what is pending, unless the client has not read what it was sent. */
  private flush(): void {
    if (!this.opened || this.ended) return;
    const { res } = this.options;
    if (res.writableLength > this.limits.backlogBytes) {
      this.stalledSince ??= this.now();
      if (this.now() - this.stalledSince > this.limits.stalledMs) return this.drop();
      /* Asked again shortly, not left to a 'drain' that may never be emitted for this response or to the next
         heartbeat 25 s away: under load a reader that catches up is told what waited at once (G211), and one that
         never does is dropped once the stall limit passes. */
      if (this.pending || this.wantsReset) this.schedule();
      return;
    }
    this.stalledSince = undefined;
    if (this.wantsReset) {
      this.wantsReset = false;
      this.pending = undefined;
      this.write('reset', { cursor: this.cursor() });
      return;
    }
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    const tables: Record<string, { keys: LiveKey[] | 'many'; kinds: string[] }> = {};
    for (const [id, table] of pending.tables)
      tables[id] = { keys: table.keys === 'many' ? 'many' : [...table.keys.values()], kinds: [...table.kinds].sort() };
    this.write('change', {
      cursor: this.cursor(),
      tables,
      ...(pending.self ? { self: true } : {}),
      ...(pending.primary ? { primary: true } : {}),
    });
  }

  private write(event: string, data: unknown): void {
    const { res } = this.options;
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  heartbeat(): void {
    if (!this.opened || this.ended) return;
    const { res } = this.options;
    if (res.writableLength > this.limits.backlogBytes) return this.flush();
    if (!res.writableEnded && !res.destroyed) res.write(': \n\n');
  }

  /* A client that stopped reading: dropped without a word, since a word would wait behind the backlog too. */
  private drop(): void {
    const { res } = this.options;
    this.end(undefined);
    res.destroy();
  }

  end(reason: 'stopping' | 'lifetime' | 'authority' | 'unavailable' | undefined): void {
    if (this.ended) return;
    this.ended = true;
    streams.delete(this);
    const left = (byAccount.get(this.options.account) ?? 1) - 1;
    if (left > 0) byAccount.set(this.options.account, left);
    else byAccount.delete(this.options.account);
    if (!streams.size && heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.lifetime) clearTimeout(this.lifetime);
    if (this.refresher) clearInterval(this.refresher);
    this.options.hubs.forEach((hub, index) => this.taps[index] && hub.detach(this.taps[index]));
    const { res } = this.options;
    if (reason && !res.writableEnded && !res.destroyed) {
      if (this.opened) this.flush();
      res.write(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`);
    }
    if (!res.writableEnded) res.end();
  }

  /** Counted against the caps, or refused. */
  admit(): boolean {
    const limits = this.limits;
    if (streams.size >= limits.streams || (byAccount.get(this.options.account) ?? 0) >= limits.perAccount) return false;
    streams.add(this);
    byAccount.set(this.options.account, (byAccount.get(this.options.account) ?? 0) + 1);
    heartbeat ??= setInterval(() => {
      for (const stream of streams) guard('stream', () => stream.heartbeat());
    }, LIVE_LIMITS.heartbeatMs);
    heartbeat.unref?.();
    return true;
  }
}

/**
 * Answer `/api/live` for a reader whose authority is resolved: the stream, or
 * 503 past the caps. Returns once `hello` is written (or the answer is sent);
 * the stream goes on until it ends.
 */
export async function openLiveStream(options: LiveStreamOptions): Promise<void> {
  const stream = new LiveStream(options);
  if (!stream.admit()) {
    const { res } = options;
    res.writeHead(503, {
      ...options.headers,
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'retry-after': String(options.limits?.retryAfterSeconds ?? LIVE_LIMITS.retryAfterSeconds),
    });
    res.end(JSON.stringify({ error: 'Too many pages are following changes right now.' }));
    return;
  }
  await stream.open();
}
