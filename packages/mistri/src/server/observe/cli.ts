/**
 * `mistri observe`: find the dev server this machine is running and say
 * where its observer is — or, with `--mcp`, speak its telemetry to a coding
 * agent on stdio.
 *
 * Why a subcommand rather than more tools on `tablewalk --mcp`: that process
 * opens the databases itself, so it has never seen a request the running App
 * answered. The telemetry lives in the dev server's memory, and the only
 * honest way to read it is to ask that server, over loopback. So this
 * attaches to the server rather than starting another, holds no credential
 * (the observer answers this machine only, and no token ever goes on a
 * command line), and leaves the database browser's tool list — and its
 * count in the README — as it is. The server is found from the small file a
 * `--dev` start writes (observer.ts), or named with `--url`.
 *
 * `--errors` reads the same error log the observer page shows, as a line
 * each, for a person or a script who has no browser open on it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { observerDirectory } from './discovery.js';
import { serveObserverMcp } from './mcp.js';

interface Found {
  url: string;
  base: string;
  pid: number;
  started: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The dev servers this machine is running, newest first. */
function runningObservers(): Found[] {
  let names: string[];
  try {
    names = readdirSync(observerDirectory()).filter((name) => /^\d+\.json$/.test(name));
  } catch {
    return [];
  }
  const found: Found[] = [];
  for (const name of names) {
    try {
      const entry = JSON.parse(readFileSync(join(observerDirectory(), name), 'utf8')) as Found;
      if (typeof entry.url === 'string' && Number.isInteger(entry.pid) && alive(entry.pid)) found.push(entry);
    } catch {
      /* a file being written, or not ours */
    }
  }
  return found.sort((a, b) => String(b.started).localeCompare(String(a.started)));
}

const USAGE = `mistri observe [--mcp | --errors [--json]] [--url <base>]
  Print the running --dev server's observer address, or with --mcp speak its
  telemetry to a coding agent on stdio, with a check tool that runs
  mistri check --json and needs no running server. With --errors, print its
  recent page and server errors, one line each (kind, path, message, trace id),
  or with --json the observer's own answer. --url names the server
  (http://localhost:4111, with its --base-path if it has one); by default, the one this machine started last.`;

interface ErrorEntry {
  kind?: string;
  path?: string;
  message?: string;
  error?: string;
  status?: number;
  traceId?: string;
  refusal?: { code?: unknown; message?: unknown };
  failure?: { error?: unknown };
}

/** One error as one line: what it was, where, what it said, and the trace to open. */
function errorLine(entry: ErrorEntry): string {
  const said =
    entry.message ??
    (typeof entry.refusal?.message === 'string' ? entry.refusal.message : undefined) ??
    entry.error ??
    (typeof entry.failure?.error === 'string' ? entry.failure.error : undefined) ??
    (entry.refusal?.code ? String(entry.refusal.code) : undefined) ??
    (entry.status ? `HTTP ${entry.status}` : '');
  const flat = said.replace(/\s+/g, ' ').trim();
  return [entry.kind ?? 'error', entry.path ?? '-', flat || '-', entry.traceId ?? '-'].join('\t');
}

export async function runObserve(argv: string[], version: string): Promise<number> {
  let url: string | undefined,
    mcp = false,
    errors = false,
    json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      return 0;
    } else if (arg === '--mcp') mcp = true;
    else if (arg === '--errors') errors = true;
    else if (arg === '--json') json = true;
    else if (arg === '--url') url = argv[++i];
    else {
      console.error(`mistri observe: unknown option ${arg}\n${USAGE}`);
      return 2;
    }
  }
  let named: string | undefined;
  if (url) {
    try {
      const parsed = new URL(url);
      if (!/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(parsed.hostname)) {
        console.error('mistri observe: the observer answers loopback only; name a localhost address.');
        return 2;
      }
      // A server under --base-path is named with it: http://localhost:4111/tools.
      named = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}/_mistri/observe`;
    } catch {
      console.error(`mistri observe: ${url} is not a URL.`);
      return 2;
    }
  }
  if (json && !errors) {
    console.error('mistri observe: --json goes with --errors.');
    return 2;
  }
  if (errors && mcp) {
    console.error('mistri observe: --errors and --mcp are two ways to read; pick one.');
    return 2;
  }
  /* Found again at each call under --mcp: an agent's session starts its MCP
     servers before any dev server, and `check` needs none. */
  const newest = () => runningObservers()[0]?.url.replace(/\/+$/, '');
  if (mcp) {
    await serveObserverMcp(() => named ?? newest(), version);
    return 0;
  }
  if (!named) {
    const [found, ...others] = runningObservers();
    if (!found) {
      console.error('mistri observe: no dev server is running. Start one with --dev (e.g. mistri --app ./myapp --dev).');
      return 1;
    }
    if (others.length)
      console.error(`mistri observe: ${others.length + 1} dev servers are running; this is the newest (pid ${found.pid}).`);
    named = found.url.replace(/\/+$/, '');
  }
  if (errors) {
    let body: { errors?: ErrorEntry[] };
    try {
      const response = await fetch(`${named}/api/errors?limit=50`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        console.error(`mistri observe: the dev server answered ${response.status} at ${named}/api/errors.`);
        return 1;
      }
      body = (await response.json()) as { errors?: ErrorEntry[] };
    } catch (error) {
      console.error(`mistri observe: could not read ${named}: ${(error as Error).message}`);
      return 1;
    }
    if (json) console.log(JSON.stringify(body, null, 2));
    else for (const entry of body.errors ?? []) console.log(errorLine(entry));
    return 0;
  }
  console.log(`${named}/`);
  return 0;
}
