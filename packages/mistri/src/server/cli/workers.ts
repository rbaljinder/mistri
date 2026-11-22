/**
 * `--workers <n|auto>`: one start served by several processes, so a host's cores all answer requests.
 *
 * A Node process runs its JavaScript on one core. Replicas behind a balancer were the only way to use more, and on one
 * host that is a balancer to run for nothing (a field report: a four-core host, three cores idle). Here the process
 * the person started becomes a primary that serves nothing itself: it holds the port, forks the workers (node:cluster),
 * starts one again that dies, and stops them all on SIGTERM or SIGINT. Each worker is a whole start, as a replica is:
 * whatever keeps two replicas correct (jobs leased in the database, live sync over LISTEN, a cache named in the config)
 * keeps two workers correct, and what replicas lack, workers have through the primary: the process bus
 * (processBus.ts) and one secret for the keys each process would otherwise make up (processKey.ts).
 *
 * The primary hands each connection to a worker itself rather than letting cluster share the port, because a tenant
 * App's contexts live in the process that made them (tenant/tenantContexts.ts): a person's requests must reach the
 * worker that knows their context. So it reads the head of a connection's first request, takes the session cookie,
 * and sends the socket to the worker that cookie hashes to; a connection with none goes round the workers in turn. As
 * the dev parent does (devSupervisor.ts), handing the socket keeps the peer address, Host and every byte untouched,
 * and a stream or an upgrade works with nothing more. The bytes the primary read go with the socket and are given to
 * the worker's HTTP server before anything else it reads.
 *
 * A connection is kept alive across requests, and the cookie can change on it: a sign-in sets one. A response that
 * sets the session cookie closes the connection, so the next request is routed by the new one; a request that still
 * arrives on a connection routed by another cookie is sent to the same address again (307, closed), which a browser
 * follows on a new connection. A worker that is down has its sessions served by the next one until it is back.
 *
 * The first worker starts alone and the rest once it serves, so startup work (a validation record, a store's first
 * file, a cache warmed in the database) is done once and the others find it done; a first worker that cannot start
 * is the start failing, with its exit code, as a single process would have. Only the first worker's first start
 * prints its lines and opens the browser; the others say nothing until they serve.
 */
import cluster, { type Worker } from 'node:cluster';
import { randomBytes } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { writeSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { format } from 'node:util';
import { answer, publish, relay, subscribe } from '../processBus.js';
import { answerCounters } from './primaryCounters.js';
import type { CacheStore } from '@mistriwork/engine/adapters/cache/cacheStore.js';

/** Which worker this is, from 0, and how many there are. Not flags, not documented. */
const WORKER_INDEX_ENV = 'MISTRI_WORKER_INDEX';
const WORKER_COUNT_ENV = 'MISTRI_WORKER_COUNT';
/** The port the primary holds; a worker's addresses are made with it. */
const WORKER_PORT_ENV = 'MISTRI_WORKER_PORT';
/** Set for the one start whose lines are printed: the first worker's first. */
const WORKER_SPEAKS_ENV = 'MISTRI_WORKER_SPEAKS';
/** Set when nobody asked for workers: a start that cannot run several then serves as one process instead of refusing. */
const WORKERS_DEFAULTED_ENV = 'MISTRI_WORKERS_DEFAULTED';

/** What the primary and a worker say to each other over the IPC channel. */
type WorkerMessage =
  | { mistriWorker: 'ready' }
  | { mistriWorker: 'retiring' }
  | { mistriWorker: 'released' }
  | { mistriWorker: 'alone'; say?: string }
  | { mistriWorker: 'connection'; head: string; key: string };

function workerMessage(message: unknown): WorkerMessage | undefined {
  if (typeof message !== 'object' || message === null || !('mistriWorker' in message)) return undefined;
  return message as WorkerMessage;
}

/** In a worker of a `--workers` start: its index from 0; undefined in any other process. */
export function workerIndex(): number | undefined {
  if (!cluster.isWorker) return undefined;
  const index = Number(process.env[WORKER_INDEX_ENV]);
  return Number.isInteger(index) && index >= 0 ? index : undefined;
}

/** In a worker: how many workers the start runs. */
export function workerTotal(): number {
  const count = Number(process.env[WORKER_COUNT_ENV]);
  return Number.isInteger(count) && count >= 1 ? count : 1;
}

/** In a worker: the public port its primary holds. */
export function workerPort(): number | undefined {
  if (workerIndex() === undefined) return undefined;
  const port = Number(process.env[WORKER_PORT_ENV]);
  return Number.isInteger(port) && port >= 0 ? port : undefined;
}

/** In a worker: whether this start prints its startup lines (the first worker's first start). */
function workerSpeaks(): boolean {
  return process.env[WORKER_SPEAKS_ENV] === '1';
}

/** In a worker: whether the count was the default rather than asked for (`--workers` or its variable). */
export function workersDefaulted(): boolean {
  return workerIndex() !== undefined && process.env[WORKERS_DEFAULTED_ENV] === '1';
}

/* ---------- which worker a request belongs to ---------- */

/** Better Auth names its session cookie `<prefix>.session_token`, `__Secure-` in front over https (auth/auth.ts cookiePrefix). */
const SESSION_COOKIE = /\.session_token$/;

/** The session cookies a Cookie header carries, as one key: every `name=value` whose name is a session token's, sorted. */
export function sessionKey(cookie: string | undefined): string {
  if (!cookie) return '';
  const found: string[] = [];
  for (const part of cookie.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    if (SESSION_COOKIE.test(name)) found.push(`${name}=${part.slice(at + 1).trim()}`);
  }
  return found.sort().join('; ');
}

/** FNV-1a, 32 bits: a key's worker must be the same in every process, and needs no more than that. */
export function slotOf(key: string, count: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % count;
}

/** The Cookie header of a request head read off the wire, or undefined; the head's other lines are not looked at. */
export function cookieOfHead(head: Buffer): string | undefined {
  const end = head.indexOf('\r\n\r\n');
  const text = head.subarray(0, end < 0 ? head.length : end).toString('latin1');
  const cookies: string[] = [];
  for (const line of text.split('\r\n').slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === 'cookie') cookies.push(line.slice(colon + 1).trim());
  }
  return cookies.length ? cookies.join('; ') : undefined;
}

/* ---------- the primary ---------- */

/** How long the primary waits for a request's head before routing a connection on what it has. */
const HEAD_MS = 10_000;
/** The most of a head the primary reads; a longer one is routed on what was read. */
const HEAD_BYTES = 64 * 1024;
/** How long a connection waits for a worker that serves, while none does (starting, or all restarting). */
const HOLD_MS = 30_000;
/** A worker that dies is started again after this, doubled for each death in a row, up to RESTART_MAX_MS. */
const RESTART_MS = 500;
const RESTART_MAX_MS = 30_000;
/** More deaths than this within CRASH_WINDOW_MS is a crash loop: the primary stops everything and says so. */
const CRASH_LIMIT = 5;
const CRASH_WINDOW_MS = 60_000;

interface WorkerSupervision {
  count: number;
  port: number;
  host: string;
  /** Said when the port is taken: whether the person named it. */
  portGiven?: boolean;
  /** Where the count came from, said on the serving line: "4 cores", "the container's CPU quota", "as asked". */
  reason?: string;
  /** Nobody asked for workers: a first worker that finds the start cannot run several hands it back (`'alone'`). */
  defaulted?: boolean;
}

interface Slot {
  worker?: Worker;
  ready: boolean;
  /** Its first start has not served yet. */
  starting: boolean;
  deaths: number[];
  streak: number;
  timer?: NodeJS.Timeout;
}

/**
 * Runs the workers until a signal stops them; resolves to the exit code the primary should leave with: 0 when every
 * worker stopped cleanly, the first worker's own code when it could not start, 1 on a crash loop. Resolves to
 * `{ alone }`, with the port let go, when a defaulted start's first worker found it cannot run several (serveAlone):
 * the caller then serves as one process, and says `alone` (why) when the worker gave a reason.
 */
export async function superviseWorkers(options: WorkerSupervision): Promise<number | { alone: string | undefined }> {
  const { count } = options;
  /* One secret for every worker, so the keys each would make up alone (a public form's ticket, a sealed field) are the
     same in all of them (processKey.ts). Made here and passed in the environment, never written anywhere. */
  const secret = randomBytes(32).toString('base64');
  const slots: Slot[] = Array.from({ length: count }, () => ({ ready: false, starting: true, deaths: [], streak: 0 }));
  const waiting = new Set<{ socket: Socket; head: Buffer; key: string; timer: NodeJS.Timeout }>();
  let stopping = false;
  let turn = 0;
  let firstStart = true;
  let settle: ((code: number) => void) | undefined;
  const done = new Promise<number>((resolve) => (settle = resolve));
  let exitCode: number | undefined;
  let alone = false;
  let aloneSay: string | undefined;

  const server: Server = createServer({ pauseOnConnect: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, options.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.error(
      code === 'EADDRINUSE'
        ? `mistri: port ${options.port} is already in use.` +
            (options.portGiven ? ' Pick another with --port <n>.' : ' Give it a free one with --port <n>.')
        : `mistri: could not listen on ${options.host}:${options.port}: ${(error as Error).message}`,
    );
    return 1;
  }
  const address = server.address();
  const port = address && typeof address !== 'string' ? address.port : options.port;

  const readyIndexes = () => slots.flatMap((slot, index) => (slot.ready && slot.worker?.isConnected() ? [index] : []));
  /** The worker a key belongs to, or the next that serves when that one does not; round in turn without a key. */
  const route = (key: string): Slot | undefined => {
    const ready = readyIndexes();
    if (!ready.length) return undefined;
    if (!key) return slots[ready[turn++ % ready.length]];
    const home = slotOf(key, count);
    for (let step = 0; step < count; step++) {
      const slot = slots[(home + step) % count];
      if (slot.ready && slot.worker?.isConnected()) return slot;
    }
    return undefined;
  };
  const hand = (socket: Socket, head: Buffer, key: string): boolean => {
    const slot = route(key);
    if (!slot?.worker) return false;
    slot.worker.send({ mistriWorker: 'connection', head: head.toString('base64'), key } satisfies WorkerMessage, socket, (error) => {
      if (error) socket.destroy();
    });
    return true;
  };
  const hold = (socket: Socket, head: Buffer, key: string) => {
    if (hand(socket, head, key)) return;
    const held = {
      socket,
      head,
      key,
      timer: setTimeout(() => {
        waiting.delete(held);
        // Nobody to serve it in time: said plainly, as the dev parent says it, rather than left hanging.
        socket.end('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      }, HOLD_MS),
    };
    held.timer.unref();
    waiting.add(held);
    socket.once('close', () => {
      clearTimeout(held.timer);
      waiting.delete(held);
    });
  };
  const flush = () => {
    for (const held of [...waiting]) {
      if (!hand(held.socket, held.head, held.key)) return;
      clearTimeout(held.timer);
      waiting.delete(held);
    }
  };

  server.on('connection', (socket: Socket) => {
    socket.on('error', () => socket.destroy());
    const chunks: Buffer[] = [];
    let size = 0;
    let routed = false;
    const finish = () => {
      if (routed) return;
      routed = true;
      clearTimeout(timer);
      socket.off('data', onData);
      /* No more is read here: what the kernel holds past this point is the worker's to read. The handle is stopped in
         this same turn, before it can hand the stream another chunk the send would then drop. */
      const handle = (socket as unknown as { _handle?: { reading?: boolean; readStop?: () => number } })._handle;
      if (handle) {
        handle.reading = false;
        handle.readStop?.();
      }
      socket.pause();
      for (let more: Buffer | null; socket.readableLength > 0 && (more = socket.read() as Buffer | null) !== null;) chunks.push(more);
      const head = Buffer.concat(chunks);
      if (stopping) {
        socket.destroy();
        return;
      }
      hold(socket, head, sessionKey(cookieOfHead(head)));
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= HEAD_BYTES || Buffer.concat(chunks).includes('\r\n\r\n')) finish();
    };
    const timer = setTimeout(finish, HEAD_MS);
    timer.unref();
    socket.on('data', onData);
    // A client that closes before saying anything is gone; nothing to route.
    socket.once('end', () => {
      if (!routed && size === 0) {
        routed = true;
        clearTimeout(timer);
        socket.destroy();
      } else finish();
    });
    socket.resume();
  });

  const stopAll = (signal: NodeJS.Signals) => {
    for (const slot of slots) {
      clearTimeout(slot.timer);
      if (slot.worker && !slot.worker.isDead()) slot.worker.process.kill(signal);
    }
  };
  const finishIfDone = () => {
    if (slots.every((slot) => !slot.worker || slot.worker.isDead())) settle?.(exitCode ?? 0);
  };
  const stop = (code?: number) => {
    if (stopping) {
      // A second signal: the person wants it gone now.
      stopAll('SIGKILL');
      return;
    }
    stopping = true;
    if (code !== undefined) exitCode = code;
    server.close();
    for (const held of waiting) {
      clearTimeout(held.timer);
      held.socket.destroy();
    }
    waiting.clear();
    stopAll('SIGTERM');
    finishIfDone();
  };
  const onSignal = () => stop();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const fork = (index: number) => {
    const slot = slots[index];
    const speaks = index === 0 && firstStart;
    const worker = cluster.fork({
      [WORKER_INDEX_ENV]: String(index),
      [WORKER_COUNT_ENV]: String(count),
      [WORKER_PORT_ENV]: String(port),
      MISTRI_WORKER_SECRET: secret,
      [WORKERS_DEFAULTED_ENV]: options.defaulted ? '1' : '',
      ...(speaks ? { [WORKER_SPEAKS_ENV]: '1' } : { [WORKER_SPEAKS_ENV]: '', MISTRI_OPEN: '' }),
    });
    slot.worker = worker;
    slot.ready = false;
    worker.on('message', (message: unknown) => {
      if (
        relay(
          message,
          worker,
          slots.map((s) => s.worker),
        ) ||
        answer(message, worker, answerCounters)
      )
        return;
      const said = workerMessage(message);
      if (said?.mistriWorker === 'ready') {
        slot.ready = true;
        slot.streak = 0;
        if (index === 0 && firstStart) {
          firstStart = false;
          // The first worker serves: startup work is done, and the rest start beside it.
          for (let next = 1; next < count; next++) fork(next);
        }
        if (slot.starting) {
          slot.starting = false;
          if (slots.every((each) => !each.starting))
            console.log(
              `mistri: serving with ${count} workers${options.reason ? `: ${options.reason}` : ''} ` +
                `(pids ${slots.map((each) => each.worker?.process.pid ?? '-').join(', ')}); stop with Ctrl-C.`,
            );
        } else console.log(`mistri: worker ${index + 1} serves again (pid ${worker.process.pid}).`);
        flush();
      } else if (said?.mistriWorker === 'alone' && index === 0 && firstStart && options.defaulted) {
        /* Its exit is then the start going on as one process, not the start failing. Answered, so the worker exits
           only once this is known here: its exit could otherwise be seen before its message. */
        alone = true;
        aloneSay = said.say;
        worker.send({ mistriWorker: 'released' } satisfies WorkerMessage, undefined, () => {});
      } else if (said?.mistriWorker === 'retiring') {
        // Stop handing it connections; the answer arrives after every one already sent, so none reaches it closing.
        slot.ready = false;
        worker.send({ mistriWorker: 'released' } satisfies WorkerMessage, undefined, () => {});
      }
    });
    worker.on('exit', (code, signal) => {
      slot.ready = false;
      if (slot.worker === worker) slot.worker = undefined;
      if (stopping) {
        if (code !== 0 && exitCode === undefined) exitCode = code ?? 1;
        finishIfDone();
        return;
      }
      // The first worker's first start failing is the start failing: its code, and what it printed, are the answer.
      if (index === 0 && firstStart) {
        exitCode = alone ? 0 : (code ?? 1);
        stop(exitCode);
        return;
      }
      const now = Date.now();
      slot.deaths = [...slot.deaths.filter((at) => now - at < CRASH_WINDOW_MS), now];
      const how = `(pid ${worker.process.pid}) ${signal ? `was stopped by ${signal}` : `exited with code ${code}`}`;
      if (slot.deaths.length > CRASH_LIMIT) {
        console.error(
          `mistri: worker ${index + 1} ${how}, its ${slot.deaths.length}th death within a minute: it is crash-looping, so every worker is stopped. ` +
            'Run with --workers 1 to see why it fails.',
        );
        stop(1);
        return;
      }
      const wait = Math.min(RESTART_MAX_MS, RESTART_MS * 2 ** slot.streak);
      slot.streak += 1;
      console.error(`mistri: worker ${index + 1} ${how}; starting it again in ${wait} ms.`);
      slot.timer = setTimeout(() => {
        if (!stopping) fork(index);
      }, wait);
    });
  };
  fork(0);
  const code = await done;
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  // The port is let go before this resolves: a start that goes on alone listens on it next.
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return alone ? { alone: aloneSay } : code;
}

/* ---------- a worker ---------- */

/** The key each connection was routed by, so a request whose session belongs elsewhere is sent there. */
const routedBy = new WeakMap<Socket, string>();

let released: (() => void) | undefined;
let releasing: Promise<void> | undefined;

/**
 * In a worker, where a host would `server.listen(port, host)`: it serves the sockets the primary hands it, and listens
 * on an ephemeral loopback port only so its listening and closing work as they do alone; nothing connects to it.
 */
export function listenAsWorker(server: HttpServer): void {
  const index = workerIndex()!;
  const count = workerTotal();
  /* A request on a connection routed by another session (a cookie set on it since, or one the client sent along a
     kept-alive connection) belongs to another worker while that one serves: sent there again, the connection closed. */
  const listeners = server.listeners('request') as ((req: IncomingMessage, res: ServerResponse) => void)[];
  server.removeAllListeners('request');
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const key = sessionKey(req.headers.cookie);
    const routed = routedBy.get(req.socket);
    if (key && routed !== undefined && key !== routed && slotOf(key, count) !== index) {
      res.writeHead(307, { Location: req.url ?? '/', Connection: 'close', 'Content-Length': '0' });
      res.end();
      return;
    }
    closeOnSessionChange(res);
    // Which worker answered (its number, not its pid): what a person reading a response, or a test, tells them apart by.
    res.setHeader('X-Mistri-Worker', String(index + 1));
    for (const listener of listeners) listener.call(server, req, res);
  });
  server.once('listening', () => {
    speakAgain();
    process.send?.({ mistriWorker: 'ready' } satisfies WorkerMessage, undefined, undefined, () => {});
  });
  process.on('message', (message: unknown, socket?: unknown) => {
    const said = workerMessage(message);
    if (said?.mistriWorker === 'connection' && socket instanceof Object && 'resume' in socket) {
      const handed = socket as Socket;
      routedBy.set(handed, said.key);
      server.emit('connection', handed);
      // What the primary read to route it: given to the HTTP server before anything the socket reads from here on.
      const head = Buffer.from(said.head, 'base64');
      if (head.length) handed.emit('data', head);
      handed.resume();
    } else if (said?.mistriWorker === 'released') released?.();
  });
  // The channel must not keep a worker alive that would otherwise have exited.
  process.channel?.unref();
  server.listen({ port: 0, host: '127.0.0.1', exclusive: true });
}

/** A response that sets the session cookie ends its connection, so the next request is routed by the new cookie. */
function closeOnSessionChange(res: ServerResponse): void {
  const setsSession = (set: unknown) =>
    (Array.isArray(set) ? set : set === undefined ? [] : [set]).some((value) => SESSION_COOKIE.test(String(value).split('=')[0].trim()));
  const writeHead = res.writeHead;
  res.writeHead = function (this: ServerResponse, ...args: unknown[]) {
    // Headers given to writeHead itself are not on the response until it runs; either place counts.
    const given = args.slice(1).find((arg) => typeof arg === 'object' && arg !== null && !Array.isArray(arg)) as
      | Record<string, unknown>
      | undefined;
    const fromArgs = given && Object.entries(given).find(([name]) => name.toLowerCase() === 'set-cookie')?.[1];
    if (setsSession(fromArgs) || setsSession(res.getHeader('set-cookie'))) res.shouldKeepAlive = false;
    return (writeHead as (...a: unknown[]) => ServerResponse).apply(this, args);
  } as ServerResponse['writeHead'];
}

/**
 * In a worker, before it retires: asks the primary to stop handing it connections and resolves once every one already
 * sent has arrived. Undefined outside a worker.
 */
export function releaseWorker(): Promise<void> | undefined {
  if (workerIndex() === undefined || !process.connected) return undefined;
  return (releasing ??= new Promise<void>((resolve) => {
    // A primary that does not answer (stopping too) does not hold the worker up.
    const timer = setTimeout(resolve, 1000);
    released = () => {
      clearTimeout(timer);
      resolve();
    };
    process.send?.({ mistriWorker: 'retiring' } satisfies WorkerMessage, undefined, undefined, (error: Error | null) => {
      if (error) released?.();
    });
  }));
}

/* A worker that does not speak keeps its startup lines to itself until it serves: n copies of the same banner say
   nothing the first did not. What it says after that (a request's error, a job's line) is its own and printed. The
   one that speaks holds its lines when nobody asked for workers: if it hands the start back (serveAlone), the
   process that serves alone says them, and they are not to be said twice. */
const quiet: { log?: typeof console.log; error?: typeof console.error; held?: [1 | 2, string][] } = {};
/** In a worker: quiet until it serves, unless it is the one that speaks. */
export function quietUntilServing(): void {
  if (quiet.log) return;
  if (workerSpeaks()) {
    if (!workersDefaulted()) return;
    const held: [1 | 2, string][] = (quiet.held = []);
    Object.assign(quiet, { log: console.log, error: console.error });
    console.log = (...args: unknown[]) => void held.push([1, `${format(...args)}\n`]);
    console.error = (...args: unknown[]) => void held.push([2, `${format(...args)}\n`]);
    // A start that fails before it serves says what it held, as it would have alone; synchronous, as an exit must be.
    process.once('exit', () => sayHeld((fd, text) => writeSync(fd, text)));
    return;
  }
  quiet.log = console.log;
  console.log = () => {};
}

function speakAgain(): void {
  if (quiet.log) console.log = quiet.log;
  if (quiet.error) console.error = quiet.error;
  sayHeld((fd, text) => (fd === 1 ? process.stdout : process.stderr).write(text));
}

function sayHeld(say: (fd: 1 | 2, text: string) => void): void {
  const held = quiet.held;
  quiet.held = undefined;
  for (const [fd, text] of held ?? []) {
    try {
      say(fd, text);
    } catch {
      // A closed stream at exit: nothing left to say it to.
    }
  }
}

/**
 * In the first worker of a start whose count was the default, when the start cannot run several processes or will not
 * serve at all (a refusal): tells the primary, which then takes the start as one process, and exits without a word.
 * What it held is the primary's to say: `say`, the reason one process serves, or nothing when the primary will reach
 * the same refusal itself and say it once.
 */
export function serveAlone(say?: string): Promise<never> {
  quiet.held = undefined;
  return new Promise<never>(() => {
    const leave = () => process.exit(0);
    if (!process.send) return leave();
    // The primary answers once it has taken the start back; one that does not (stopping too) does not hold this up.
    setTimeout(leave, 2000);
    process.on('message', (message: unknown) => {
      if (workerMessage(message)?.mistriWorker === 'released') leave();
    });
    process.send({ mistriWorker: 'alone', say } satisfies WorkerMessage, undefined, undefined, (error: Error | null) => {
      if (error) leave();
    });
  });
}

/**
 * When a worker's start returns: the IPC channel must not keep it alive. A worker that serves let it go as it listened
 * (listenAsWorker); one that returned before serving (a refusal, which sets the exit code and returns) would otherwise
 * wait on the channel forever, and so would its primary, waiting for the first worker's exit.
 */
export function leaveWhenDone(): void {
  if (workerIndex() !== undefined) process.channel?.unref();
}

/* ---------- a cache whose deletions reach every worker ---------- */

/**
 * The Registry's in-process cache (engine connections.ts `cache()`), for a worker: a key deleted in one worker is
 * deleted in the others, so a change one of them saved (a tenant's branding) is not served stale by the rest until
 * it expires. Only a delete is told: a write is each process's own fill of the same answer, and telling it would
 * have the workers evict each other's on every read. The counters a request can be refused by are not kept here but in
 * the primary (primaryCounters.ts), so the workers of one start spend one budget.
 */
export function busEvictingCache(inner: CacheStore): CacheStore {
  const self = process.pid;
  subscribe('cache.evict', (payload) => {
    const said = payload as { key?: unknown; from?: unknown } | undefined;
    if (said && said.from !== self && typeof said.key === 'string') void inner.delete(said.key).catch(() => {});
  });
  return new Proxy(inner, {
    get(target, name, receiver) {
      if (name === 'delete')
        return async (key: string) => {
          await target.delete(key);
          publish('cache.evict', { key, from: self });
        };
      const value = Reflect.get(target, name, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
