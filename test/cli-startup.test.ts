// test-package: shared — each binary's start, measured the same way (scripts/test-owners.mjs).
/**
 * What a start loads, counted.
 *
 * `main` imports each mode where it reaches it (packages/tablewalk/src/server/cli/browserMain.ts, cli/mistriMain.ts), and the bin
 * entry re-exports nothing. Both were once otherwise, and every start —
 * `--help`, and the `--mcp` an agent's client spawns every session — loaded the
 * whole server, some 480 modules, before a flag was read. Milliseconds are the
 * wrong thing to hold on a shared machine; the modules a start loads are
 * deterministic, so the ceilings are counts, and the named modules are the ones
 * a mode has no business loading.
 *
 * And what a start says before it has anything to say: nothing from Node
 * about `node:sqlite`, which tablewalk uses for its own stores whatever the
 * connections are (packages/engine/src/server/startupWarnings.ts).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  insecureCookieWarning,
  NODE_FLOOR,
  oldNodeRefusal,
  quietSqliteExperimentalWarning,
  SHARED_RATE_LIMIT_WARNING,
  warnOnce,
} from '../packages/engine/src/server/startupWarnings.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/* A module of any package, named as the one tree did: `packages/<name>/src/server/x.ts` is `server/x.ts`. */
const SRC = new RegExp(`^${new URL('../packages/', import.meta.url).href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^/]+/src/`);

/** Each binary's entry: the database browser's and the App framework's. */
const BIN = {
  tablewalk: join(ROOT, 'packages/tablewalk/src/server/index.ts'),
  mistri: join(ROOT, 'packages/mistri/src/server/index.ts'),
};

/** Every module under a package's src/ a start of `bin` loads, as paths relative to that src/. */
function startup(args: string[], input = '', cwd = ROOT, bin: keyof typeof BIN = 'tablewalk') {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-startup-'));
  const list = join(directory, 'modules.txt');
  /* A synchronous load hook in the process itself: it sees every module,
     whichever loader (tsx here, Node's own for the build) resolved it. */
  const hook = `data:text/javascript,${encodeURIComponent(`
    import { registerHooks } from 'node:module'; import { writeFileSync } from 'node:fs';
    const seen = new Set();
    registerHooks({ load(url, context, next) { seen.add(url); return next(url, context); } });
    process.on('exit', () => writeFileSync(${JSON.stringify(list)}, [...seen].join('\\n')));`)}`;
  try {
    const result = spawnSync(process.execPath, ['--import', hook, '--import', import.meta.resolve('tsx'), BIN[bin], ...args], {
      cwd,
      input,
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, TABLEWALK_OPEN: '0', MISTRI_OPEN: '0' },
    });
    assert.ifError(result.error);
    const modules = readFileSync(list, 'utf8')
      .split('\n')
      .filter((url) => SRC.test(url))
      .map((url) => url.replace(SRC, ''));
    return { ...result, modules };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function loaded(args: string[], input = '', bin: keyof typeof BIN = 'tablewalk'): string[] {
  const result = startup(args, input, ROOT, bin);
  assert.equal(result.status, 0, result.stderr);
  return result.modules;
}

test('help lists flags and experiment provisioning', () => {
  const result = startup(['--help'], '', ROOT, 'mistri');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\bflags\b.*\bexperiments\b/);
  const all = startup(['--help', 'all'], '', ROOT, 'mistri');
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /mistri flags --help/);
  assert.match(all.stdout, /mistri experiments/);
});

test('experiments help is lazy and invalid operations never become database filenames', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-experiments-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'tablewalk.json'), 'invalid config must not be read');
  for (const args of [[], ['--help'], ['-h'], ['invalid']]) {
    const result = startup(['experiments', ...args], '', directory, 'mistri');
    const help = args[0] === '--help' || args[0] === '-h';
    assert.equal(result.status, help ? 0 : 1, result.stderr);
    assert.equal(result.signal, null);
    assert.match(help ? result.stdout : result.stderr, /mistri experiments <provision\|provision-sources> --suite/);
    for (const absent of [
      'server/experiments/storePostgres.ts',
      'server/cli/suiteConfig.ts',
      'server/connections.ts',
      'server/http/server.ts',
    ]) {
      assert.ok(!result.modules.includes(absent), `experiments help loaded ${absent}`);
    }
    assert.deepEqual(readdirSync(directory), ['tablewalk.json']);
  }
});

test('flows help loads neither the App definition nor the server', () => {
  const help = loaded(['flows', '--help'], '', 'mistri');
  assert.ok(help.includes('server/cli/flowsCommand.ts'));
  for (const absent of ['server/http/server.ts', 'server/connections.ts', 'shared/app.ts', 'server/jobs/jobLoader.ts'])
    assert.ok(!help.includes(absent), `flows --help loaded ${absent}`);
  assert.ok(help.length <= 30, `flows --help loaded ${help.length} modules:\n${help.join('\n')}`);
});

test('--help and --version load the flag parser, not the server, from either binary', () => {
  const starts = (['tablewalk', 'mistri'] as const).flatMap((bin) => {
    const help = loaded(['--help'], '', bin);
    /* Measured at 15 when this was written; the ceiling leaves room for a helper or two. 31 once the two binaries
       shared their entry's preamble (cli/bin.ts) rather than one bin carrying it. 33 once each main said which
       product it is (server/product.ts), so a shared flag is read in the binary's own name. 34 once the pools said
       what they may hold (adapters/connectionBudget.ts, a leaf postgresPool.ts loads for its manager's constructor). */
    assert.ok(help.length <= 34, `${bin} --help loaded ${help.length} modules:\n${help.join('\n')}`);
    assert.ok(help.includes('server/cli/args.ts'));
    const version = loaded(['--version'], '', bin);
    assert.ok(version.length <= 70, `${bin} --version loaded ${version.length} modules`);
    return [help, version];
  });
  for (const modules of starts) {
    assert.ok(!modules.includes('server/connections.ts'), 'a print-and-exit flag opened the connection registry');
    assert.ok(!modules.includes('server/http/server.ts'), 'a print-and-exit flag loaded the HTTP server');
  }
});

test('--mcp loads the MCP tools, not the HTTP server, the auth store or the tenant host', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-startup-db-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'one.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE thing (id INTEGER PRIMARY KEY, name TEXT)');
  db.close();
  const initialize = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'startup', version: '0' } },
  });
  const mcp = loaded(['--mcp', '--no-config', '--db', file], `${initialize}\n`);
  t.diagnostic(`plain MCP startup loaded ${mcp.length} source modules`);
  assert.ok(mcp.includes('server/mcp.ts'), 'the MCP server itself was not loaded; the probe is broken');
  for (const absent of [
    'server/http/server.ts',
    'server/http/handler.ts',
    'server/auth/auth.ts',
    'server/cli/serve.ts',
    'server/cli/tenant.ts',
    'server/cli/appMcpMode.ts',
    'server/devclient.ts',
    'server/commands/businessCommandLoader.ts',
    'server/jobs/jobHost.ts',
    'server/app/appValidation.ts',
    'server/app/appTransitions.ts',
    'shared/app.ts',
    // It refuses an App on its name alone (packages/tablewalk/src/server/cli/browserMain.ts), so it never loads one; and it has no App authoring tools.
    'server/cli/apps.ts',
    'server/app/apps.ts',
    'server/app/appBuild.ts',
    'server/scaffold.ts',
    // The App framework's config sections (email, identity, webhooks, search, analytics): read only with a config file.
    'server/serviceConnections.ts',
  ]) {
    assert.ok(!mcp.includes(absent), `--mcp loaded ${absent}`);
  }
  /* Measured at 193 when this was written, against 486 before the modes were
     split; 219 once it loaded every App module to refuse an App, and 194 when
     it stopped. 203 at 1.0: three leaves a connection now needs (adapters/replicas.ts for declared replicas,
     embed/issuerConfig.ts for the trust check's embed origins, app/appValidationDenied.ts so a refusing write
     no longer pulls in the App definition), and 206 with shared/appZone.ts, the command host's reading of
     `ui.timezone` kept apart from appUi.ts, which loads every look. 207 with auth/scimConfig.ts, which the
     config file's "scim" entries are read by, as embed/issuerConfig.ts reads "embed". 208 with
     adapters/integrations/integrationStore.ts: a write's channel notice is queued in the write's own transaction, so
     both adapters reach its queue. 209 at 0.9.1, net, with two leaves: adapters/sqliteDecimals.ts, so a SQLite
     decimal reads back at its declared scale as Postgres's does, and shared/unitWord.ts, which says "1 day" on
     both sides. 211 with app/appConsumes.ts, since a line that consumes a balance keeps it in step on
     every write path, MCP's too, and shared/stitchedPaths.ts, which reads the dotted parent paths cross-table
     filters name. 212 with app/appAccessDenied.ts, the access refusal as a leaf of its own so the transition rules
     raise it without a cycle through appAccess.ts. 213 at 0.9.2 with
     shared/pageAnatomy.ts, which page.ts's validatePage reads for an App record page's default aside. 214 at 0.9.4 with
     configPaths.ts, the one rule for a config's relative SQLite path, which connections.ts reads as it loads the config
     file, so MCP needs it to open the file beside the config; it is a leaf (node:path and node:url only). 215 at 0.9.5 with
     shared/pageLayouts.ts, the record-page archetype words (`layout: 'conversation' | 'showcase' | 'article'`), which
     shared/pageConfig.ts reads to validate a page's `layout`; MCP already loaded pageConfig, and the new module is a
     leaf (a type import of pageModel.ts only), so no lazy import can avoid it. 221 at 0.9.6 once the config's
     sections became a table a main hands to loadConfig (configSections.ts, cacheService.ts, and email/mailDns.ts, which
     carries the table), with adapters/net/untrustedDatabase.ts and adapters/writeAttribution.ts, two leaves the
     adapters and the MCP's write attribution need. 202 when the table was read only where a config file is
     (`readStartupConfig` takes its maker), the command host imported the App sections' webhook lookup only where an
     App hosts commands, and the agent console's tool list stopped registering itself through agentToolList.ts. 187
     when the App reference shelf (docs.ts and what it reads) and the App authoring tools left the database MCP for the
     App framework's agent server (observe/docShelf.ts, `mistri check`). 159 when the bin's two mains split: the
     database browser's main (cli/browserMain.ts) runs `--mcp`, and the one main it replaced hosted an App's commands
     on every start — the command host, its journals, event stores and public placement, and the command and flag
     model they read — before it looked at the mode, and read the App start's flags (cli/startupOptions.ts). 160
     when each binary got an entry of its own and the preamble they share became a module (cli/bin.ts). 161 when the
     main said which product it is (server/product.ts). 163 with two leaves of every write path:
     adapters/writeAhead.ts, the statements a write sends ahead of its BEGIN, which recordWriteOperations.ts and
     the PostgreSQL adapter read synchronously around each write (an AsyncLocalStorage, so it cannot arrive late), and
     adapters/scoped/keyRows.ts, the keyset reader the PostgreSQL adapter's scoped reads stand on. */
  assert.ok(mcp.length <= 163, `--mcp loaded ${mcp.length} modules:\n${mcp.join('\n')}`);
});

/** Every module under src/ a serving start loads by the time it listens, then stopped. */
async function served(args: string[]): Promise<string[]> {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-startup-'));
  const list = join(directory, 'modules.txt');
  const hook = `data:text/javascript,${encodeURIComponent(`
    import { registerHooks } from 'node:module'; import { writeFileSync } from 'node:fs';
    const seen = new Set();
    registerHooks({ load(url, context, next) { seen.add(url); return next(url, context); } });
    process.on('exit', () => writeFileSync(${JSON.stringify(list)}, [...seen].join('\\n')));
    process.on('SIGTERM', () => process.exit(0));`)}`;
  try {
    const child = spawn(process.execPath, ['--import', hook, '--import', import.meta.resolve('tsx'), BIN.tablewalk, ...args], {
      cwd: ROOT,
      env: { ...process.env, TABLEWALK_OPEN: '0', MISTRI_OPEN: '0' },
    });
    let said = '';
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stderr.on('data', (chunk) => (said += chunk));
    child.stdout.on('data', (chunk) => {
      said += chunk;
      if (/Listening/.test(said)) child.kill('SIGTERM');
    });
    await exited;
    clearTimeout(timer);
    assert.match(said, /Listening/, said);
    return readFileSync(list, 'utf8')
      .split('\n')
      .filter((url) => SRC.test(url))
      .map((url) => url.replace(SRC, ''));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('serving one database loads the database browser, not the App framework', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-startup-db-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'one.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE thing (id INTEGER PRIMARY KEY, name TEXT)');
  db.close();
  const serve = await served(['--no-config', '--db', file, '--port', '0']);
  t.diagnostic(`a database browser start loaded ${serve.length} source modules`);
  assert.ok(serve.includes('server/http/browserHandler.ts'), "the database browser's dispatcher was not loaded; the probe is broken");
  for (const absent of [
    // The App framework's dispatcher, its gate and server, and what they alone read.
    'server/http/server.ts',
    'server/http/handler.ts',
    'server/http/gate.ts',
    'server/auth/auth.ts',
    'shared/app.ts',
    'server/app/apps.ts',
  ]) {
    assert.ok(!serve.includes(absent), `a database browser start loaded ${absent}`);
  }
  for (const part of ['server/embed/', 'server/api/'])
    assert.ok(!serve.some((module) => module.startsWith(part)), `a database browser start loaded ${part}*`);
  /* Measured at 244 when the products' dispatchers split (http/browserHandler.ts beside http/handler.ts), against 704
     when one dispatcher served both and the browser's start loaded the App framework's gate, sign-in, embed and API
     to serve a database. The ceiling leaves a few leaves' room; a jump past it is an App module reached again. */
  assert.ok(serve.length <= 250, `a database browser start loaded ${serve.length} modules:\n${serve.join('\n')}`);
});

test("Node's SQLite ExperimentalWarning is dropped; every other warning goes out", () => {
  const sent: unknown[][] = [];
  const target = {
    emitWarning: ((...args: unknown[]) => {
      sent.push(args);
    }) as typeof process.emitWarning,
  };
  quietSqliteExperimentalWarning(target);
  // The message Node's releases that call node:sqlite experimental send, as they send it.
  target.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
  target.emitWarning(Object.assign(new Error('SQLite is an experimental feature'), { name: 'ExperimentalWarning' }));
  target.emitWarning('WASI is an experimental feature and might change at any time', 'ExperimentalWarning');
  target.emitWarning('SQLite said something else', { type: 'DeprecationWarning' });
  assert.deepEqual(
    sent.map((args) => String(args[0])),
    ['WASI is an experimental feature and might change at any time', 'SQLite said something else'],
  );
});

test('a start on a Node older than the floor says so in one line; the floor is the one engines names', () => {
  assert.equal(oldNodeRefusal('24.0.0'), undefined);
  assert.equal(oldNodeRefusal(process.versions.node), undefined);
  assert.equal(
    oldNodeRefusal('22.12.0'),
    `mistri needs Node ${NODE_FLOOR} or newer; this is Node 22.12.0. Install Node ${NODE_FLOOR} (https://nodejs.org) and run it again.`,
  );
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { engines: { node: string } };
  assert.match(pkg.engines.node, new RegExp(`^>=${NODE_FLOOR}\\.\\d+\\.\\d+$`), 'the floor is the major engines names');
});

test('sign-in beyond this machine at an http public address is warned of, naming the https fix; loopback and https are not', () => {
  for (const [url, host] of [
    ['http://localhost:4000', 'localhost'],
    ['http://127.0.0.1:4000/desk', '127.0.0.1'],
    ['https://crm.example.com', '0.0.0.0'],
    ['https://crm.example.com', '127.0.0.1'],
  ])
    assert.equal(insecureCookieWarning(url, host), undefined, `${url} on ${host}`);
  for (const [url, host] of [
    ['http://localhost:4000', '0.0.0.0'],
    ['http://crm.example.com', '127.0.0.1'],
    ['http://crm.example.com/desk', '::'],
  ]) {
    const warning = insecureCookieWarning(url, host);
    assert.match(warning ?? '', /never marked Secure/, `${url} on ${host}`);
    assert.match(warning ?? '', /MISTRI_PUBLIC_URL\) to the proxy's https address/);
  }
});

test('a startup warning is said once per process, whatever reaches it again', () => {
  const lines: string[] = [];
  for (let i = 0; i < 3; i++) warnOnce('test-once', SHARED_RATE_LIMIT_WARNING, (line) => lines.push(line));
  assert.deepEqual(lines, [`mistri: warning: ${SHARED_RATE_LIMIT_WARNING}`]);
  assert.match(SHARED_RATE_LIMIT_WARNING, /every visitor shares one sign-in rate limit/);
  assert.match(SHARED_RATE_LIMIT_WARNING, /tw\.fetch\(request, \{ clientAddress \}\)/);
});
