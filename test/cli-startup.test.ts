/**
 * What a start loads, counted.
 *
 * `main` imports each mode where it reaches it (packages/mistri/src/server/cli/mistriMain.ts), and the bin
 * entry re-exports nothing. Both were once otherwise, and every start —
 * `--help`, and the `--mcp` an agent's client spawns every session — loaded the
 * whole server, some 480 modules, before a flag was read. Milliseconds are the
 * wrong thing to hold on a shared machine; the modules a start loads are
 * deterministic, so the ceilings are counts, and the named modules are the ones
 * a mode has no business loading.
 *
 * And what a start says before it has anything to say: nothing from Node
 * about `node:sqlite`, which mistri uses for its own stores whatever the
 * connections are (packages/engine/src/server/startupWarnings.ts).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/** The binary's entry. The database browser's starts are measured in its own repository. */
const BIN = {
  mistri: join(ROOT, 'packages/mistri/src/server/index.ts'),
};

/** Every module under a package's src/ a start of `bin` loads, as paths relative to that src/. */
function startup(args: string[], input = '', cwd = ROOT, bin: keyof typeof BIN = 'mistri') {
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

function loaded(args: string[], input = '', bin: keyof typeof BIN = 'mistri'): string[] {
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

test('--help and --version load the flag parser, not the server', () => {
  const starts = (['mistri'] as const).flatMap((bin) => {
    const help = loaded(['--help'], '', bin);
    /* Measured at 15 when this was written; the ceiling leaves room for a helper or two. 31 once the two binaries
       shared their entry's preamble (cli/bin.ts) rather than one bin carrying it. 33 once each main said which
       product it is (server/product.ts), so a shared flag is read in the binary's own name. 34 once the pools said
       what they may hold (adapters/connectionBudget.ts, a leaf postgresPool.ts loads for its manager's constructor). 35 for the wait a development flight is given
       (adapters/dbLatency.ts, a leaf postgresPool.ts loads for its flights). 36 for the line a checkout waits in
       (adapters/poolAdmission.ts, a leaf postgresPool.ts loads to take turns across accounts). */
    assert.ok(help.length <= 36, `${bin} --help loaded ${help.length} modules:\n${help.join('\n')}`);
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
