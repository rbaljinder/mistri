/**
 * `mistri dev` on a tenant App: a thin parent that runs the host as a child process.
 *
 * A tenant host captures its App, policy and pages by value at startup, so what a save changed cannot be swapped into
 * it without skipping the checks startup makes (tenant/tenantLook.ts says why). Under dev the way to wear a save is to
 * start again, and starting again must not need a person at the terminal: the child retires cleanly and exits with
 * DEV_CHANGED_EXIT where the watcher already notices the save (cli/tenant.ts), and this parent starts it again once it
 * has gone, so the port is free. A save of only the look never gets here: the host wears it in place.
 *
 * A child that fails to start (a page that does not load, a policy that refuses) printed why; this parent keeps
 * watching the App's files and starts it again on the next save instead of leaving the terminal.
 * A child stopped from outside by a signal (the machine, under load) did not fail: it is started again at once, with a
 * line saying so, since a browser walk against a host waiting for a save saw only refused connections (a field
 * report). Once: a host stopped again within a minute of that start waits for the next save, so nothing loops.
 * Sessions live in the auth store and the cookies, which the dev folder keeps (cli/devMode.ts), so a restart signs
 * nobody out.
 *
 * The port is the parent's, not the child's (field report #30). A child that bound it itself left a gap on every save,
 * from the old host letting it go to the new one taking it, and a browser or a test that asked in that gap was refused.
 * So the parent listens on the port for as long as the session lasts, accepts each connection without reading it, and
 * hands the socket itself to the host that is ready (Node's handle passing over the IPC channel); while none is, it
 * holds the connection, and a host that becomes ready is handed what waited. A connection that waits HOLD_MS is
 * answered 503 with a Retry-After. A proxy would have done the same for HTTP, but handing over the socket keeps the
 * real peer address (loopback-only answers and rate limits read it), passes Host and every byte untouched, and makes a
 * stream (SSE) or an upgrade work with nothing more: they end when their host goes, and a client that reconnects is
 * handed to the next. The child listens on an ephemeral loopback port only so its listening and closing work as
 * they did; nothing connects to it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { basename, dirname, resolve } from 'node:path';
import { GENERATED_TYPE_FILES } from '../formatterConfig.js';

/** Marks the child: it retires with DEV_CHANGED_EXIT instead of leaving the terminal to restart. Not a flag, not documented. */
export const DEV_SUPERVISED_ENV = 'MISTRI_DEV_SUPERVISED';
/** The child's "a save changed what I serve" (EX_TEMPFAIL): the parent starts it again. */
export const DEV_CHANGED_EXIT = 75;
/** The port the parent holds for the child, which serves it through the sockets it is handed. Not a flag, not documented. */
const DEV_PORT_ENV = 'MISTRI_DEV_PORT';
/** How long a connection waits for a host to be ready before it is told the App is starting again. */
const HOLD_MS = 30_000;

/** What parent and child say over the IPC channel; anything else on it is not ours. */
type DevMessage = { mistriDev: 'ready' | 'retiring' | 'released' | 'connection' };
const devMessage = (message: unknown): DevMessage['mistriDev'] | undefined =>
  typeof message === 'object' && message !== null && 'mistriDev' in message ? (message as DevMessage).mistriDev : undefined;

const SKIPPED = new Set(['.mistri', 'node_modules', '.git']);

/** Calls `changed` (debounced) when anything under `root` or one of `files` is saved; returns what stops watching. */
export function watchForSave(root: string, files: readonly (string | undefined)[], changed: () => void, debounceMs = 200): () => void {
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ping = () => {
    clearTimeout(timer);
    timer = setTimeout(changed, debounceMs);
  };
  try {
    watchers.push(
      watch(resolve(root), { recursive: true }, (_event, filename) => {
        if (filename !== null && SKIPPED.has(filename.split(/[\\/]/)[0])) return;
        // The types `mistri check` writes are not a save (formatterConfig.ts).
        if (filename !== null && GENERATED_TYPE_FILES.has(basename(filename))) return;
        ping();
      }),
    );
  } catch {
    /* A directory that cannot be watched is one the child will say so about. */
  }
  for (const file of files) {
    if (!file) continue;
    const path = resolve(file);
    try {
      watchers.push(watch(dirname(path), (_event, filename) => (filename === null || filename === basename(path) ? ping() : undefined)));
    } catch {
      /* As above. */
    }
  }
  for (const watcher of watchers) watcher.on('error', () => {});
  return () => {
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}

interface DevSupervision {
  /** The arguments and environment the person's own command had, before dev settled anything: the child settles it again. */
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  /** Starts watching; calls back on a save; returns the stop. */
  readonly watch: (changed: () => void) => () => void;
  /**
   * An ordinary App's dev (not a tenant's): the child retires only for a change a reload cannot wear, and a first start
   * that fails is the person's to see, as it was before there was a parent. A start this parent made for a save that
   * fails waits for the next save instead: a half-typed commands module must not end the session.
   */
  readonly onlyOnChange?: boolean;
  /** What is run, before `argv`: this process's own command unless a test names another. */
  readonly entry?: readonly string[];
  /**
   * The address the person asked for, which the parent holds across restarts and hands each connection on to the host
   * that is ready. A port the parent cannot take is left to the child, which says why as it did before.
   */
  readonly listen?: { readonly port: number; readonly host: string };
  /** How long a connection is held for a host before the 503; HOLD_MS unless a test names less. */
  readonly holdMs?: number;
}

const STARTING_AGAIN = 'mistri dev: the App is starting again; try again in a moment.\n';

/** The connection that waited too long: read what it sent (closing over unread bytes resets it) and answer 503. */
function startingAgain(socket: Socket): void {
  socket.on('data', () => {});
  socket.resume();
  socket.end(
    'HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain; charset=utf-8\r\nRetry-After: 1\r\nCache-Control: no-store\r\n' +
      `Connection: close\r\nContent-Length: ${Buffer.byteLength(STARTING_AGAIN)}\r\n\r\n${STARTING_AGAIN}`,
  );
  setTimeout(() => socket.destroy(), 5000).unref();
}

/** The parent's listener: holds connections while no host is ready and hands them to the one that is. */
interface FrontDoor {
  readonly port: number;
  /** Follows a child: it is handed connections from its ready to its retiring or exit. */
  attach(child: ChildProcess): void;
  close(): void;
}

async function frontDoor(listen: { port: number; host: string }, holdMs: number): Promise<FrontDoor | undefined> {
  const waiting = new Set<{ socket: Socket; timer: ReturnType<typeof setTimeout> }>();
  let ready: ChildProcess | undefined;
  const hold = (socket: Socket) => {
    if (socket.destroyed) return;
    const entry = {
      socket,
      timer: setTimeout(() => {
        waiting.delete(entry);
        startingAgain(socket);
      }, holdMs),
    };
    waiting.add(entry);
  };
  const hand = (socket: Socket) => {
    const to = ready;
    if (!to?.connected) return hold(socket);
    to.send({ mistriDev: 'connection' } satisfies DevMessage, socket, (error) => {
      // Not sent (the host went as it was handed): it waits for the next.
      if (error && !socket.destroyed) hold(socket);
    });
  };
  const flush = () => {
    const held = [...waiting];
    waiting.clear();
    for (const { socket, timer } of held) {
      clearTimeout(timer);
      hand(socket);
    }
  };
  const server: Server = createServer({ pauseOnConnect: true }, (socket) => {
    socket.on('error', () => {});
    hand(socket);
  });
  const bound = await new Promise<boolean>((done) => {
    server.once('error', () => done(false));
    server.listen(listen.port, listen.host, () => done(true));
  });
  if (!bound) {
    server.close();
    return undefined;
  }
  server.on('error', () => {});
  const address = server.address();
  return {
    port: address && typeof address !== 'string' ? address.port : listen.port,
    attach(child) {
      const gone = () => {
        if (ready === child) ready = undefined;
      };
      child.on('message', (message) => {
        const said = devMessage(message);
        if (said === 'ready') {
          ready = child;
          flush();
        } else if (said === 'retiring') {
          /* Nothing more is handed to it; what was already sent arrives before this answer (one ordered channel), so
             once the child reads it, it knows it has every connection it will get. */
          gone();
          if (child.connected) child.send({ mistriDev: 'released' } satisfies DevMessage, () => {});
        }
      });
      child.once('exit', gone);
      child.once('disconnect', gone);
    },
    close() {
      ready = undefined;
      for (const { socket, timer } of waiting) {
        clearTimeout(timer);
        socket.destroy();
      }
      waiting.clear();
      server.close();
    },
  };
}

/** In the child: the public port its parent holds, when this host is served through handed sockets. */
export function handedOffPort(): number | undefined {
  if (process.env[DEV_SUPERVISED_ENV] !== '1' || typeof process.send !== 'function') return undefined;
  const port = Number(process.env[DEV_PORT_ENV]);
  return Number.isInteger(port) && port >= 0 ? port : undefined;
}

let releasing: Promise<void> | undefined;
let released: (() => void) | undefined;

/**
 * In the child, where a host would `server.listen(port, host)`: under a parent that holds the port it listens on an
 * ephemeral loopback port instead, says it is ready once listening, and serves the sockets it is handed.
 */
export function listenForDev(server: Server, port: number, host: string): void {
  if (handedOffPort() === undefined) {
    server.listen(port, host);
    return;
  }
  server.once('listening', () => process.send?.({ mistriDev: 'ready' } satisfies DevMessage, () => {}));
  process.on('message', (message, socket?: unknown) => {
    const said = devMessage(message);
    if (said === 'connection' && socket instanceof Object && 'resume' in socket) {
      server.emit('connection', socket);
      (socket as Socket).resume();
    } else if (said === 'released') released?.();
  });
  // The channel must not keep a host alive that would otherwise have exited.
  process.channel?.unref();
  server.listen(0, '127.0.0.1');
}

/**
 * In the child, before it retires: asks the parent to stop handing it connections and resolves once every one already
 * sent has arrived, so none reaches a host that is closing. Undefined where there is no parent holding the port.
 */
export function releaseForDev(): Promise<void> | undefined {
  if (handedOffPort() === undefined || !process.connected) return undefined;
  return (releasing ??= new Promise<void>((done) => {
    // A parent that does not answer (stopping too) does not hold the host up.
    const timer = setTimeout(done, 1000);
    released = () => {
      clearTimeout(timer);
      done();
    };
    process.send?.({ mistriDev: 'retiring' } satisfies DevMessage, (error: Error | null) => {
      if (error) released?.();
    });
  }));
}

/** How long a host started again after an outside stop must run for another outside stop to start it again at once. */
const OUTSIDE_STOP_SETTLED_MS = 60_000;

/** Runs the child until the person stops it; resolves to the exit code the parent should leave with. */
export async function superviseDev(options: DevSupervision): Promise<number> {
  let child: ChildProcess | undefined;
  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = () => {
    stopping = true;
    child?.kill('SIGTERM');
    wake?.();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const entry = options.entry ?? [...process.execArgv, process.argv[1]];
  const front = options.listen ? await frontDoor(options.listen, options.holdMs ?? HOLD_MS) : undefined;
  /* Whether this start was made for an outside stop: a second stop soon after it waits for a save instead. */
  let afterOutsideStop = false;
  try {
    for (let start = 0; ; start++) {
      const env = {
        ...options.env,
        [DEV_SUPERVISED_ENV]: '1',
        ...(front ? { [DEV_PORT_ENV]: String(front.port) } : {}),
        ...(start ? { MISTRI_OPEN: '0' } : {}),
      };
      const startedAt = Date.now();
      const running = spawn(process.execPath, [...entry, ...options.argv], {
        env,
        stdio: front ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit',
      });
      child = running;
      front?.attach(running);
      if (stopping) running.kill('SIGTERM');
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
        running.once('error', () => done({ code: 1, signal: null }));
        running.once('exit', (code, signal) => done({ code, signal }));
      });
      child = undefined;
      if (stopping) return exit.code ?? 0;
      if (exit.code === 0) return 0;
      if (exit.code === DEV_CHANGED_EXIT) {
        console.error('mistri dev: the App changed; starting it again…');
        afterOutsideStop = false;
        continue;
      }
      const again = afterOutsideStop && Date.now() - startedAt < OUTSIDE_STOP_SETTLED_MS;
      afterOutsideStop = false;
      if (exit.signal && !again) {
        console.error(`mistri dev: the host was stopped from outside (${exit.signal}); starting it again…`);
        afterOutsideStop = true;
        continue;
      }
      if (options.onlyOnChange && start === 0) return exit.code ?? 1;
      console.error(
        `mistri dev: the host ${exit.signal ? `was stopped by ${exit.signal}` : `exited with code ${exit.code}`}; waiting for the next save to start it again.`,
      );
      await new Promise<void>((done) => {
        let off: (() => void) | undefined;
        wake = () => {
          off?.();
          wake = undefined;
          done();
        };
        off = options.watch(wake);
        if (stopping) wake();
      });
      if (stopping) return 0;
    }
  } finally {
    front?.close();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
