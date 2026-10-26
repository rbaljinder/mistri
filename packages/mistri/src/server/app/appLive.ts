/**
 * The authoring loop's last step: the page follows the save.
 *
 * The server already reloads an App's source in place (apps.ts `reloadApp`,
 * cli/serve.ts's watcher). What it did not do was tell anyone: the browser
 * kept the App it had and found out about the save on the author's next
 * reload. This is the telling — one event stream per open page, saying
 * `reload` after each save the watcher settled, good or broken, and the page
 * asks `/api/app` again (client appLive.ts). The stream carries no App: what
 * a reader is served, and whether they are told a load error, stays the
 * route's decision per reader (http/appProjection.ts).
 *
 * A save that did not load is placed here as `mistri check` places a
 * finding (build/checkProblems.ts): the code its words name, the file and
 * line — from the error's own stack when it threw or did not parse, from the
 * definition path or the quoted words when it was refused — and the lines
 * around that one. The same is said on the terminal under the server's
 * `App error:` line, so the overlay and the log never disagree.
 *
 * Only a watched App has one, which is the line between authoring and
 * serving: a `mistri build` output is never watched (a production server
 * watches no files), a tenant platform restarts on a change rather than
 * reloading (tenant/tenantStartup.ts) and so has no save to tell, and a
 * handler mounted in someone else's server (`opts.embedded`) is not given
 * one, because a stream that never ends is the host server's socket to
 * spend, not ours.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppLoadProblem } from '../../shared/appPayload.js';
import type { AppHost } from './apps.js';

export interface AppLive {
  /** Tell every open page the App moved on: placed first when the save did not load. */
  announce(host: AppHost): Promise<void>;
  /** Answer `/api/app/live`. */
  stream(req: IncomingMessage, res: ServerResponse): void;
  /** End every stream: the server is stopping, and an open stream would hold its close. */
  close(): void;
}

/* A page per tab. A few dozen tabs on one App is already unusual; the cap is
   for a source server reachable by more people than its author, so a crowd
   of readers cannot hold sockets without bound. Past it a page simply does
   not follow saves. */
const MAX_STREAMS = 64;
/* Under every proxy's idle timeout we know of (nginx's 60s default), so a
   stream nobody writes to between saves is not cut and reopened. */
const HEARTBEAT_MS = 25_000;

export function appLive(): AppLive {
  const streams = new Set<ServerResponse>();
  let version = 0;
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const send = (res: ServerResponse, text: string) => {
    if (!res.writableEnded && !res.destroyed) res.write(text);
  };
  return {
    async announce(host) {
      if (host.loadError) {
        const failure = host.loadFailure && host.loadError.startsWith(host.loadFailure.of) ? host.loadFailure.error : undefined;
        const problem = await placeLoadFailure(host.loadError, host.app.dir ?? host.app.path, failure).catch((): AppLoadProblem => ({
          code: 'invalid-app',
          message: host.loadError!,
          docs: 'https://mistriwork.dev/docs/check-codes/#invalid-app',
        }));
        host.loadProblem = { of: host.loadError, problem };
        for (const line of sayPlace(problem)) console.error(line);
      } else host.loadProblem = undefined;
      version += 1;
      for (const res of streams) send(res, `event: reload\ndata: ${JSON.stringify({ version })}\n\n`);
    },
    stream(req, res) {
      if (closed || streams.size >= MAX_STREAMS) {
        res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: closed ? 'The server is stopping.' : 'Too many pages are following this App.' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      /* `retry`: a restarted server is back within a second or two, and the
         page asks /api/app again on reconnecting (client appLive.ts). */
      res.write(`retry: 1000\nevent: hello\ndata: ${JSON.stringify({ version })}\n\n`);
      streams.add(res);
      heartbeat ??= setInterval(() => {
        for (const open of streams) send(open, ': \n\n');
      }, HEARTBEAT_MS).unref();
      const done = () => {
        streams.delete(res);
        if (!streams.size && heartbeat) {
          clearInterval(heartbeat);
          heartbeat = undefined;
        }
      };
      req.once('close', done);
      res.once('close', done);
    },
    close() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      for (const res of streams) res.end();
      streams.clear();
    },
  };
}

/* A place written into a message or a stack: an absolute path or a file URL,
   then a line and maybe a column — `/app/b.ts:4`, `file:///app/c.ts:2:7`. */
const WRITTEN_AT = /(file:\/\/\/?[^\s:'"()]+|(?:\/|[A-Za-z]:[\\/])[^\s:'"()]+?)\.(m?[tj]sx?|json|css):(\d+)(?::(\d+))?/g;

/** Every error in a cause chain, the outermost first: a load wraps what the worker threw. */
function chain(error: unknown): Array<{ message?: string; stack?: string }> {
  const seen: Array<{ message?: string; stack?: string }> = [];
  let at: unknown = error;
  while (at && typeof at === 'object' && seen.length < 5) {
    seen.push(at as { message?: string; stack?: string });
    at = (at as { cause?: unknown }).cause;
  }
  return seen;
}

/** The first place inside the App's directory a text names, that is a file there. */
async function writtenAt(texts: string[], dirs: readonly string[]): Promise<{ file: string; line: number; column?: number } | undefined> {
  for (const text of texts) {
    for (const match of text.matchAll(WRITTEN_AT)) {
      const named = `${match[1]}.${match[2]}`;
      let file: string;
      try {
        file = named.startsWith('file:') ? fileURLToPath(named) : named;
      } catch {
        continue;
      }
      if (!dirs.some((dir) => inside(file, dir)) || /[\\/]node_modules[\\/]/.test(file)) continue;
      if (
        !(await stat(file).then(
          (info) => info.isFile(),
          () => false,
        ))
      )
        continue;
      return { file, line: Number(match[3]), ...(match[4] ? { column: Number(match[4]) } : {}) };
    }
  }
  return undefined;
}

const inside = (file: string, dir: string) => {
  const said = relative(dir, file);
  return Boolean(said) && !said.startsWith('..') && !isAbsolute(said);
};

/**
 * A load error as the overlay says it. `target` is the App's directory (or
 * its one manifest file); `error` is the thrown error when the reload kept
 * it, whose stack knows where a throw or a syntax error was written.
 */
export async function placeLoadFailure(text: string, target: string, error?: unknown): Promise<AppLoadProblem> {
  const { docsFor, near, pathOfMessage, placeOf, sourceLocator, validationCode } = await import('../build/checkProblems.js');
  const dir = (await stat(target).then(
    (info) => info.isDirectory(),
    () => false,
  ))
    ? target
    : resolve(target, '..');
  /* The loader says the manifest first (`/app/app.ts: …`); the overlay says the file on a line of its own. */
  let message = text;
  for (let prefix = /^(?:\/|[A-Za-z]:[\\/])[^\s:]+\.(?:m?[tj]sx?|json): /.exec(message); prefix;) {
    message = message.slice(prefix[0].length);
    prefix = /^(?:\/|[A-Za-z]:[\\/])[^\s:]+\.(?:m?[tj]sx?|json): /.exec(message);
  }
  const code = validationCode(message);
  /* A module's stack names it by its real path (macOS's /var is /private/var), the App by the one it was given. */
  const dirs = [dir, await realpath(dir).catch(() => dir)];
  const within = (file: string) => dirs.find((at) => inside(file, at));
  let place: { file: string; line?: number; column?: number } | undefined = await writtenAt(
    [message, ...chain(error).flatMap((at) => [at.message ?? '', at.stack ?? ''])],
    dirs,
  );
  if (!place) {
    try {
      const locator = await sourceLocator(dir);
      const path = pathOfMessage(message);
      const walked = path ? await placeOf(locator.files, path, message, dir) : undefined;
      const found = walked ?? locator.at(message) ?? locator.last(message);
      if (found) place = { file: resolve(found.file), line: found.line };
    } catch {
      /* A place is a help, never a condition: the message stands without one. */
    }
  }
  /* Named but not placed: the manifest the loader read, which is where to start looking — at the
     line JSON.parse names, for an app.json that does not parse. */
  if (!place) {
    const named = /^((?:\/|[A-Za-z]:[\\/])[^\s:]+\.(?:m?[tj]sx?|json)): /.exec(text)?.[1];
    const json = /\(line (\d+) column (\d+)\)/.exec(message);
    if (named && within(named)) place = { file: named, ...(json ? { line: Number(json[1]), column: Number(json[2]) } : {}) };
  }
  const frame = place?.line ? await frameAround(place.file, place.line) : undefined;
  return {
    code,
    message: message.trim(),
    ...(place
      ? {
          file: within(place.file) ? relative(within(place.file)!, place.file) : near(place.file),
          ...(place.line ? { line: place.line } : {}),
          ...(place.column ? { column: place.column } : {}),
        }
      : {}),
    ...(frame?.length ? { frame } : {}),
    docs: docsFor(code, 'validation'),
  };
}

/** Two lines either side of `line`, each cut to a screen's width. */
async function frameAround(file: string, line: number): Promise<AppLoadProblem['frame']> {
  const lines = await readFile(file, 'utf8').then(
    (text) => text.split('\n'),
    () => undefined,
  );
  if (!lines || line < 1 || line > lines.length) return undefined;
  const from = Math.max(1, line - 2);
  const to = Math.min(lines.length, line + 2);
  return Array.from({ length: to - from + 1 }, (_, i) => ({
    line: from + i,
    text: lines[from + i - 1].replace(/\r$/, '').replace(/\t/g, '  ').slice(0, 160),
  }));
}

/** The place and its lines, for the terminal, under the server's own `App error:` line. */
export function sayPlace(problem: AppLoadProblem): string[] {
  if (!problem.file) return [`  [${problem.code}] ${problem.docs}`];
  const where = `${problem.file}${problem.line ? `:${problem.line}${problem.column ? `:${problem.column}` : ''}` : ''}`;
  const width = String(problem.frame?.at(-1)?.line ?? 0).length;
  return [
    `  at ${where} [${problem.code}]`,
    ...(problem.frame ?? []).map((row) =>
      `  ${row.line === problem.line ? '>' : ' '} ${String(row.line).padStart(width)} | ${row.text}`.trimEnd(),
    ),
  ];
}
