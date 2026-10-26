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

const USAGE = `mistri observe [--mcp] [--url <base>]
  Print the running --dev server's observer address, or with --mcp speak its
  telemetry to a coding agent on stdio, with a check tool that runs
  mistri check --json and needs no running server. --url names the server
  (http://localhost:4111, with its --base-path if it has one); by default, the one this machine started last.`;

export async function runObserve(argv: string[], version: string): Promise<number> {
  let url: string | undefined,
    mcp = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      return 0;
    } else if (arg === '--mcp') mcp = true;
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
  console.log(`${named}/`);
  return 0;
}
