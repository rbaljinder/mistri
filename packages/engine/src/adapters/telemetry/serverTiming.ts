/**
 * Where one request's time went, as a `Server-Timing` header and one log line:
 * opt-in diagnostics for a deployment whose pages are slower than the same
 * code on a laptop, where guessing at the network, the pools or the CPU had
 * stopped converging. `MISTRI_SERVER_TIMING=1` switches it on; off, every
 * entry point below is one boolean check and the work itself. For load tests
 * only: the `proc` entry hands the process's heap, GC and pool use to any
 * requester, so it stays off in production (SECURITY.md) — or is held back
 * behind `MISTRI_SERVER_TIMING_TOKEN`: with that set, `proc` is added only to
 * a request that sends the token as `x-mistri-timing`, and every other entry
 * (each describes that request's own time) goes to anyone.
 *
 * What it counts, per request:
 *
 * - `total`: wall time from the request's arrival to its headers.
 * - `db-<label>`: per database by its role (`app`, `auth`), never its URL —
 *   the flights sent (a pipelined batch leaves together and counts once), the
 *   time a connection spent awaiting the server, summed over connections, and
 *   the most connections awaiting at once. Counted at the leased client's
 *   `query`, the one place every statement and batch of either pool crosses.
 * - `pool-<label>`: time spent waiting for a connection, which includes
 *   dialling one when the pool had none idle.
 * - `auth`: time resolving the session.
 * - `cpu`: the process's CPU over the request. Approximate: under concurrency
 *   it includes whatever else the process ran meanwhile.
 * - `read.<route>`: the planned reads of a composed first page, by route.
 * - `proc`: the process itself, not the request (see below).
 *
 * Nothing in a header or a log line comes from a request, a row or a
 * statement: names are the code's own, values are durations and counts.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants as perfConstants, monitorEventLoopDelay, performance as perf, PerformanceObserver } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';

let on = process.env.MISTRI_SERVER_TIMING?.trim() === '1';
/** Whether requests are timed: read once from the environment; tests set it. */
export function setServerTiming(value: boolean): void {
  on = value;
  if (on) startProcessSampler();
}

/* Development's own timing (`--dev`): on without MISTRI_SERVER_TIMING, so every response says its cost in a
   Server-Timing header and the terminal gets one line a request that touched the database. It is the request's own
   time and goes to anyone who can reach the dev server; the process entry never does, so the sampler is not started,
   and the JSON log line is replaced by the line a person reads. An operator who set the variable keeps theirs. */
let developing = false;
/** Time requests as development does (see above). Nothing changes where the environment already switched timing on. */
export function setServerTimingDev(): void {
  if (on) return;
  on = true;
  developing = true;
}

/**
 * The most database round trips a request should make (a flight: one message sent and awaited, a pipelined batch
 * counted once). The numbers the platform's own tests hold: a read, a command with the reads that settle after it,
 * and the first page of an App, which composes its reads. Past them the dev log says so.
 */
export const ROUND_TRIP_BUDGETS = { read: 3, command: 6, entry: 16 } as const;
type Budget = keyof typeof ROUND_TRIP_BUDGETS;

/** Which budget a request answers to, or none for one that is not the App's (an asset). */
export function budgetOf(method: string | undefined, route: string): Budget | undefined {
  if (route === '/assets') return undefined;
  const read = method === 'GET' || method === 'HEAD';
  if (route === 'page') return read ? 'entry' : 'command';
  return read ? 'read' : 'command';
}

const PERFORMANCE_PAGE = 'https://mistriwork.dev/docs/performance-by-default/';

/** What a developer is told of one request: its cost, and a warning line when it made more round trips than its budget. */
export function costLines(cost: {
  method?: string;
  route: string;
  status: unknown;
  roundTrips: number;
  dbMs: number;
  cpuMs: number;
}): string[] {
  const what = `${cost.method ?? 'GET'} ${cost.route === 'page' ? 'page' : cost.route}`;
  const lines = [
    `mistri: ${what} ${cost.status}: ${cost.roundTrips} round trip${cost.roundTrips === 1 ? '' : 's'}, db ${round(cost.dbMs)} ms, cpu ${round(cost.cpuMs)} ms`,
  ];
  const budget = budgetOf(cost.method, cost.route);
  if (budget && cost.roundTrips > ROUND_TRIP_BUDGETS[budget])
    lines.push(
      `mistri: warning: ${what} made ${cost.roundTrips} round trips; ${
        { read: 'a read', command: 'a command', entry: "an App's first page" }[budget]
      } should make at most ${ROUND_TRIP_BUDGETS[budget]}. ${PERFORMANCE_PAGE}`,
    );
  return lines;
}

let token = process.env.MISTRI_SERVER_TIMING_TOKEN?.trim() || undefined;
/** The operator token that gates the `proc` entry: read once from the environment; tests set it. */
export function setServerTimingToken(value: string | undefined): void {
  token = value?.trim() || undefined;
}

/** Whether `header` is the operator token, compared over digests so neither length nor content shows in the time taken. */
function holdsToken(header: string | string[] | undefined): boolean {
  if (!token || typeof header !== 'string') return false;
  const digest = (text: string) => createHash('sha256').update(text).digest();
  return timingSafeEqual(digest(header), digest(token));
}

/* The process entry. A load test needs the process's own state beside each
   request's: which replica answered, whether its heap is climbing after
   collections, whether the loop is saturated. It is sampled on a 5 s unref'd
   timer into one cached string, so a request formats nothing. Only when the
   flag is on does any of it run. */
const WINDOW_MS = 5_000;
const instance = randomBytes(4).toString('hex');
const bootedAt = Date.now();
const MB = 1024 * 1024;
const mb = (bytes: number) => Math.round((bytes / MB) * 10) / 10;

/** A count the process keeps elsewhere (a pool's leases, open streams), read at each sample; same-named gauges add.
 * Returns its removal: a gauge's reader keeps what it reads alive, so an owner that closes (a pool) takes it out. */
const gauges: Array<{ name: string; read: () => number }> = [];
export function registerGauge(name: string, read: () => number): () => void {
  const gauge = { name, read };
  gauges.push(gauge);
  return () => {
    const at = gauges.indexOf(gauge);
    if (at >= 0) gauges.splice(at, 1);
  };
}
/** Whether timing is on, for an owner that registers many gauges (a pool per manager) only when it matters. */
export const serverTimingOn = (): boolean => on;

type GcKind = 'minor' | 'major' | 'incremental' | 'weak';
const gcKinds: Array<[number, GcKind]> = [
  [perfConstants.NODE_PERFORMANCE_GC_MINOR, 'minor'],
  [perfConstants.NODE_PERFORMANCE_GC_MAJOR, 'major'],
  [perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL, 'incremental'],
  [perfConstants.NODE_PERFORMANCE_GC_WEAKCB, 'weak'],
];
const gc: Record<GcKind, { n: number; ms: number }> = {
  minor: { n: 0, ms: 0 },
  major: { n: 0, ms: 0 },
  incremental: { n: 0, ms: 0 },
  weak: { n: 0, ms: 0 },
};
let heapAfterMajor = 0;
let procHeader = '';
let sampler: ReturnType<typeof setInterval> | undefined;
let resample = () => {};
/** Take the process sample now instead of at the next tick (tests; the header is otherwise up to 5 s old). */
export const sampleProcessNow = (): void => resample();

function startProcessSampler(): void {
  if (sampler) return;
  if (!token)
    console.error(
      'mistri: warning: MISTRI_SERVER_TIMING=1 puts the process entry (heap, garbage collection, pool use) in every response to any requester. Set MISTRI_SERVER_TIMING_TOKEN to require an x-mistri-timing header for it, or turn timing off in production.',
    );
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const kind = gcKinds.find(([flag]) => flag === (entry as unknown as { detail?: { kind?: number } }).detail?.kind)?.[1];
        if (!kind) continue;
        gc[kind].n += 1;
        gc[kind].ms += entry.duration;
        // Delivery is queued, so this reads the heap a moment after the collection: close enough for a floor.
        if (kind === 'major') heapAfterMajor = getHeapStatistics().used_heap_size;
      }
    }).observe({ entryTypes: ['gc'] });
  } catch {
    // A runtime without gc entries leaves the gc fields at zero.
  }
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  let elu = perf.eventLoopUtilization();
  let seq = 0;
  const sample = () => {
    const now = perf.eventLoopUtilization();
    const window = perf.eventLoopUtilization(now, elu);
    elu = now;
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    const sums = new Map<string, number>();
    for (const gauge of gauges) {
      try {
        sums.set(gauge.name, (sums.get(gauge.name) ?? 0) + gauge.read());
      } catch {
        // A gauge whose owner is gone reads as nothing.
      }
    }
    const ms = (ns: number) => Math.round((ns / 1e6) * 10) / 10;
    const kinds = (pick: (k: { n: number; ms: number }) => number) => gcKinds.map(([, kind]) => pick(gc[kind])).join('/');
    const fields = [
      `i=${instance}`,
      `n=${(seq += 1)}`,
      `up=${Math.round((Date.now() - bootedAt) / 1000)}`,
      `rss=${mb(mem.rss)}`,
      `hu=${mb(mem.heapUsed)}`,
      `ht=${mb(mem.heapTotal)}`,
      `ext=${mb(mem.external)}`,
      `ab=${mb(mem.arrayBuffers)}`,
      `gch=${mb(heapAfterMajor)}`,
      // minor/major/incremental/weak
      `gcn=${kinds((k) => k.n)}`,
      `gcms=${kinds((k) => Math.round(k.ms * 10) / 10)}`,
      `el=${ms(delay.percentile(50))}/${ms(delay.percentile(99))}/${ms(delay.max)}`,
      `elu=${Math.round(window.utilization * 1000) / 1000}`,
      `cpu=${Math.round(cpu.user / 1000)}/${Math.round(cpu.system / 1000)}`,
      ...[...sums].map(([name, value]) => `${name}=${value}`),
    ];
    delay.reset();
    procHeader = `proc;desc="${fields.join(' ')}"`;
  };
  resample = sample;
  sample();
  sampler = setInterval(sample, WINDOW_MS);
  sampler.unref();
}

interface DbCount {
  flights: number;
  waitMs: number;
  busy: number;
  maxBusy: number;
}

class RequestTiming {
  readonly start = performance.now();
  readonly cpu = process.cpuUsage();
  readonly db = new Map<string, DbCount>();
  readonly pools = new Map<string, { ms: number; n: number }>();
  readonly sums = new Map<string, number>();
  readonly parts: Array<[string, number]> = [];
  sent = false;

  dbOf(label: string): DbCount {
    let count = this.db.get(label);
    if (!count) this.db.set(label, (count = { flights: 0, waitMs: 0, busy: 0, maxBusy: 0 }));
    return count;
  }

  fields(): Record<string, unknown> {
    const cpu = process.cpuUsage(this.cpu);
    return {
      total: round(performance.now() - this.start),
      cpu: round((cpu.user + cpu.system) / 1000),
      ...Object.fromEntries([...this.sums].map(([name, ms]) => [name, round(ms)])),
      db: Object.fromEntries([...this.db].map(([label, c]) => [label, { flights: c.flights, wait: round(c.waitMs), max: c.maxBusy }])),
      pool: Object.fromEntries([...this.pools].map(([label, p]) => [label, { wait: round(p.ms), n: p.n }])),
      ...(this.parts.length ? { parts: this.parts.map(([name, ms]) => [name, round(ms)]) } : {}),
    };
  }

  header(fields: Record<string, unknown>, withProc: boolean): string {
    const metrics = [`total;dur=${fields.total}`, `cpu;dur=${fields.cpu}`];
    if (procHeader && withProc) metrics.push(procHeader);
    for (const [name, ms] of this.sums) metrics.push(`${name};dur=${round(ms)}`);
    for (const [label, c] of this.db) metrics.push(`db-${label};dur=${round(c.waitMs)};desc="flights=${c.flights} max=${c.maxBusy}"`);
    for (const [label, p] of this.pools) metrics.push(`pool-${label};dur=${round(p.ms)};desc="n=${p.n}"`);
    for (const [name, ms] of this.parts) metrics.push(`${name};dur=${round(ms)}`);
    return metrics.join(', ');
  }
}

const round = (ms: number) => Math.round(ms * 10) / 10;
const storage = new AsyncLocalStorage<RequestTiming>();

/* What a log line may name a request by: an API route as the code spells it,
   with any segment that could be a key replaced; anything else by its kind. */
function routeOf(url: string | undefined): string {
  const path = (url ?? '').split('?')[0];
  if (path.startsWith('/assets/')) return '/assets';
  if (!path.startsWith('/api/')) return 'page';
  return path
    .split('/')
    .map((part) => (/\d|[^a-z-]/i.test(part) && part !== '' ? ':' : part))
    .join('/');
}

/**
 * `listener`, timing each request it is handed — or `listener` itself when
 * timing is off. A request already timed (the tenant server hands its data
 * requests to an inner listener in the same call) is not timed twice.
 */
export function timedListener<L extends (req: IncomingMessage, res: ServerResponse) => unknown>(listener: L): L {
  if (!on) return listener;
  if (!developing) startProcessSampler();
  return ((req: IncomingMessage, res: ServerResponse) => {
    if (storage.getStore()) return listener(req, res);
    const timing = new RequestTiming();
    /* Node writes every response's headers through writeHead, an implicit
       one included: the last moment the header can still be set. */
    const writeHead = res.writeHead as (...args: unknown[]) => ServerResponse;
    res.writeHead = function (this: ServerResponse, ...args: unknown[]) {
      if (!timing.sent) {
        timing.sent = true;
        const fields = timing.fields();
        if (!this.headersSent)
          this.setHeader('Server-Timing', timing.header(fields, !developing && (!token || holdsToken(req.headers['x-mistri-timing']))));
        if (developing) {
          const dbs = [...timing.db.values()];
          const roundTrips = dbs.reduce((sum, c) => sum + c.flights, 0);
          if (roundTrips > 0)
            for (const line of costLines({
              method: req.method,
              route: routeOf(req.url),
              status: args[0],
              roundTrips,
              dbMs: dbs.reduce((sum, c) => sum + c.waitMs, 0),
              cpuMs: Number(fields.cpu),
            }))
              console.error(line);
        } else
          process.stderr.write(
            `${JSON.stringify({ msg: 'server-timing', method: req.method, route: routeOf(req.url), status: args[0], ...fields })}\n`,
          );
      }
      return writeHead.apply(this, args);
    } as ServerResponse['writeHead'];
    return storage.run(timing, () => listener(req, res));
  }) as L;
}

/** Time every request `server` answers: its request listeners, each wrapped by timedListener. */
export function timeRequests(server: Server): Server {
  if (!on) return server;
  const listeners = server.listeners('request') as Array<(req: IncomingMessage, res: ServerResponse) => unknown>;
  server.removeAllListeners('request');
  for (const listener of listeners) server.on('request', timedListener(listener));
  return server;
}

/** `work`, its duration added to the request's `name` (`auth`). */
export async function timedSum<T>(name: string, work: () => Promise<T>): Promise<T> {
  const timing = on ? storage.getStore() : undefined;
  if (!timing) return work();
  const start = performance.now();
  try {
    return await work();
  } finally {
    timing.sums.set(name, (timing.sums.get(name) ?? 0) + performance.now() - start);
  }
}

/** `work`, its duration listed as one part of the request (`read.run`). */
export async function timedPart<T>(name: string, work: () => Promise<T>): Promise<T> {
  const timing = on ? storage.getStore() : undefined;
  if (!timing) return work();
  const start = performance.now();
  try {
    return await work();
  } finally {
    timing.parts.push([name, performance.now() - start]);
  }
}

/**
 * `work`, outside whatever request it was asked from: for a process's own work that one request only set off. A
 * timer or promise begun inside a request carries the request's timing to everything it runs, so a live sync pass a
 * save woke had its reads counted as that save's round trips whenever the save was still answering 50 ms later.
 */
export function untimed<T>(work: () => T): T {
  return on ? storage.exit(work) : work();
}

/** A connection checkout begun: call the result once it is had (or refused). */
export function poolWait(label: string): () => void {
  const timing = on ? storage.getStore() : undefined;
  if (!timing) return () => {};
  const start = performance.now();
  return () => {
    const pool = timing.pools.get(label) ?? { ms: 0, n: 0 };
    pool.ms += performance.now() - start;
    pool.n += 1;
    timing.pools.set(label, pool);
  };
}

/** A pool whose own `query` checks out through `connect` (pg-pool's), its checkouts timed as `label`. */
export function timePoolCheckouts(pool: { connect: (...args: never[]) => unknown }, label: string): void {
  if (!on) return;
  const connect = pool.connect.bind(pool) as (callback?: (...results: unknown[]) => void) => unknown;
  (pool as { connect: unknown }).connect = (callback?: (...results: unknown[]) => void) => {
    const had = poolWait(label);
    if (typeof callback === 'function')
      return connect((...results) => {
        had();
        callback(...results);
      });
    return (connect() as Promise<unknown>).then(
      (client) => {
        had();
        return client;
      },
      (error: unknown) => {
        had();
        throw error;
      },
    );
  };
}

interface ClientState {
  inFlight: number;
  since: number;
  timing?: RequestTiming;
}
const timed = new WeakSet<object>();

/**
 * Count `client`'s round trips to the database `label` names. Its own `query`
 * is wrapped, once, so whatever leases it — a pool's own `query`, a pooler's
 * transaction wrapper, a snapshot — is counted where the statement leaves.
 *
 * A client that pipelines sends a statement asked while others are awaited
 * at once, behind them: those share one flight. One that does not queues it
 * until the one before is answered, so each statement is its own flight.
 */
export function timeClient(client: object, label: string): void {
  if (!on || timed.has(client)) return;
  timed.add(client);
  /* A query of the client's own is kept; one from its class is looked up at each call, so a wrapper installed on
     the class later (drivers.ts, a vendor's agent) still sees every statement. */
  type Query = (...args: unknown[]) => unknown;
  const own = Object.hasOwn(client, 'query') ? (client as { query: Query }).query : undefined;
  const proto = Object.getPrototypeOf(client) as { query: Query };
  const state: ClientState = { inFlight: 0, since: 0 };
  const pipelines = () => (client as { pipeline?: unknown }).pipeline === true;
  const sent = () => {
    if (state.inFlight === 0) {
      state.timing = storage.getStore();
      state.since = performance.now();
      const count = state.timing?.dbOf(label);
      if (count) {
        count.busy += 1;
        count.maxBusy = Math.max(count.maxBusy, count.busy);
      }
    }
    if (state.inFlight === 0 || !pipelines()) {
      const count = state.timing?.dbOf(label);
      if (count) count.flights += 1;
    }
    state.inFlight += 1;
  };
  const answered = () => {
    state.inFlight -= 1;
    if (state.inFlight > 0) return;
    const count = state.timing?.dbOf(label);
    if (count) {
      count.busy -= 1;
      count.waitMs += performance.now() - state.since;
    }
    state.timing = undefined;
  };
  (client as { query: unknown }).query = function (this: unknown, ...args: unknown[]) {
    sent();
    let once = false;
    const done = () => {
      if (once) return;
      once = true;
      answered();
    };
    const last = args.at(-1);
    if (typeof last === 'function')
      args[args.length - 1] = (...results: unknown[]) => {
        done();
        (last as (...given: unknown[]) => unknown)(...results);
      };
    let pending: unknown;
    try {
      pending = (own ?? proto.query).apply(this, args);
    } catch (error) {
      done();
      throw error;
    }
    if (typeof last !== 'function') {
      const request = args[0] as { once?: unknown } | undefined;
      if (pending && typeof (pending as Promise<unknown>).then === 'function') (pending as Promise<unknown>).then(done, done);
      // A submittable (a cursor, a stream) says it is done by its events.
      else if (request && typeof request.once === 'function') {
        (request as { once(event: string, listener: () => void): void }).once('end', done);
        (request as { once(event: string, listener: () => void): void }).once('error', done);
      } else done();
    }
    return pending;
  };
}

const probed = new Set<string>();

/** A connection of the probe's own, so it holds no pool's place and is closed when it is done. */
export interface ProbeClient {
  connect(): Promise<unknown>;
  query(text: string): Promise<unknown>;
  end(): Promise<unknown>;
  on?(event: 'error', listener: () => void): unknown;
}

/**
 * Ten `SELECT 1`s, one after another on a connection dialled for them, logged
 * as the round trip from this process to the database `label` names: measured
 * where the server runs, not from the laptop that deployed it. Once per label;
 * `dial` is not called when timing is off or the label was measured.
 */
export async function probeRoundTrips(
  label: string,
  dial: () => ProbeClient | undefined,
  say: (line: string) => void = (line) => console.error(line),
): Promise<void> {
  if (!on || developing || probed.has(label)) return;
  probed.add(label);
  let client: ProbeClient | undefined;
  try {
    client = dial();
    if (!client) return;
    client.on?.('error', () => {});
    const dialled = performance.now();
    await client.connect();
    const connectMs = performance.now() - dialled;
    const times: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const start = performance.now();
      await client.query('SELECT 1');
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    say(
      `mistri: server timing — ${label} database round trip min ${round(times[0])} ms, median ${round((times[4] + times[5]) / 2)} ms, ` +
        `max ${round(times[9])} ms over 10 (connect ${round(connectMs)} ms)`,
    );
  } catch (error) {
    say(`mistri: server timing — ${label} database round trip not measured: ${error instanceof Error ? error.name : 'failed'}`);
  } finally {
    await client?.end().catch(() => {});
  }
}
