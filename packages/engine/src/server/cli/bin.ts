/**
 * What each binary's entry does before its main, the one way: `tablewalk` (packages/tablewalk/src/server/index.ts)
 * and `mistri` (packages/mistri/src/server/index.ts) each call `runBin` with their own main, and nothing else.
 *
 * Two binaries, not one bin that hands a start across: a person types `npx tablewalk <db>` for the database browser
 * and `npx @mistriwork/mistri dev` for an App, and each refuses the other's start by the other's name. Neither entry imports the
 * other product, so installing one never loads, or installs, the other.
 *
 * An entry re-exports nothing. One used to re-export `createApp` and the trust checks for the tests, and an ES
 * module's re-exports are loaded whether or not anyone reads them: every start — `--help`, `--mcp` — paid for the whole
 * HTTP server before `main` could look at a flag. The tests import those from where they live.
 */
/* A namespace, not a named import: on a Node without enableCompileCache a named import fails as the module links,
   before the version check below could say why. */
import * as nodeModule from 'node:module';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { compileCacheDirectory } from '../compileCache.js';
import { oldNodeRefusal, quietSqliteExperimentalWarning } from '../startupWarnings.js';
import type { Main } from './startup.js';

/**
 * Whether `entry` (the entry's `import.meta.url`) is the script this process was started with.
 *
 * Matched by identity, not by name. The old test — does argv[1] *look like* server/index — held until npm ran it
 * through a bin shim, which is a symlink called `tablewalk`: the module loaded, matched nothing, and `npx tablewalk`
 * exited 0 having done exactly that. Resolving the symlink and comparing against the entry's own URL is the question
 * actually being asked, and it keeps the property the guard exists for: a test that imports an entry boots nothing.
 * The tests once imported one, and a module that starts a server as a side effect of being read cannot be tested —
 * it printed its usage and listened on 4111 in the middle of the suite.
 */
function invokedAs(entry: string): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return pathToFileURL(realpathSync(arg)).href === entry;
  } catch {
    return false;
  }
}

/** Runs the binary whose entry is `entry`: its main, loaded on demand, when the process was started with it. */
export function runBin(entry: string, load: () => Promise<{ main: Main }>): void {
  if (!invokedAs(entry)) return;
  const refusal = oldNodeRefusal();
  if (refusal) {
    process.stderr.write(`${refusal}\n`);
    process.exitCode = 1;
    return;
  }
  /* Before the first import of the server, which is what the cache is for: V8's compiled code for every module
     `main` loads is kept on disk, so the second start of the same version skips compiling them. An agent's client
     spawns `--mcp` every session, and that start is mostly compiling. From source (tsx) the cache would hold tsx's
     transforms, which are keyed by content anyway, so it is only enabled for the built package. */
  const directory = entry.endsWith('.js') ? compileCacheDirectory(process.env) : undefined;
  if (directory) {
    try {
      nodeModule.enableCompileCache(directory);
    } catch {
      /* a cache is an optimisation, never a reason not to start */
    }
  }
  quietSqliteExperimentalWarning();
  void load().then(({ main }) => main());
}
