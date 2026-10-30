#!/usr/bin/env node
/**
 * What a tenant App costs the server per request, measured the way it is
 * deployed: one small container, a fraction of a CPU, PostgreSQL a network
 * away, and a few dozen people each working through the screens.
 *
 * Why: a 75-minute load test of a real multi-tenant App on one container with a
 * fraction of a vCPU found no leak but found the server's own CPU setting the
 * ceiling — about 20 ms of CPU per request, GC near a third of it, the event
 * loop saturated by 50 people, and a tenant's first page (`/api/tenant/enter`)
 * spending up to a second of CPU. The database was not the limit; this
 * process was. This harness puts the same shape on one machine, so a change
 * to the server can be measured before and after instead of argued about.
 *
 *   node scripts/capacity-harness.mjs [--mode docker|local] [--cpus 0.5] [--users 25]
 *        [--warmup 60] [--steady 180] [--profile 60] [--delay-ms 10] [--think 3000 | 3000-10000]
 *        [--live 1|0] [--locale es] [--enters 12] [--edit commandId] [--create commandId]
 *        [--pool-query 'table:filter;...'] [--label name] [--out dir]
 *
 * And for an App that is not in this repository, served by the ordinary CLI
 * (`--app` replaces Ignition; every path is the App checkout's own):
 *
 *        --app <dir> --accounts <file> [--cwd <dir>] [--config f] [--commands f] [--jobs f]
 *        [--policy f] [--mount id=/path] [--serve-args '...'] [--env-file f] [--env NAME=value ...]
 *        [--volume <dir> ...] [--pg <container>] [--setup '<shell command>'] [--server-root <checkout>]
 *        [--app-id id]
 *
 * - `--accounts`: a JSON list of { email, password, tenant? } (a file of mode
 *   0600; nothing in it is printed). Person i signs in as account i mod N, each
 *   with a session of their own, as the field load test did.
 * - `--env-file` / `--env`: the server's environment. A value's `{pg}` is the
 *   host:port the server reaches PostgreSQL by — the delay proxy — so the App's
 *   config can name `${ITS_DATABASE_URL}` and be routed through it.
 * - `--pg`: a PostgreSQL container that is already seeded (password
 *   `capacity`, 5432 published for `--setup`): the harness joins it to the
 *   run's network instead of starting one, and leaves it running. `--setup`
 *   runs on this machine before the server starts, with CAPACITY_PG_URL (that
 *   server, reachable from here) — to restore the App's databases from a
 *   template, so every run starts from the same rows.
 * - `--volume`: a directory the served App writes (its config home, a cache),
 *   mounted at the same path. In docker mode every path is mounted where it is
 *   on this machine, so an App's `node_modules` may link into a checkout.
 * - `--server-root`: the mistri checkout that serves (this one by default), to
 *   measure another commit with this harness: its CLI serves an `--app`, which
 *   must resolve `@mistriwork/*` to the same checkout, and without `--app` its
 *   `test/support/capacityServer.ts` serves Ignition.
 *
 * What it starts, and removes after (all named mistri-capacity-<id>):
 *
 * - a disposable PostgreSQL container (postgres:17-alpine) on its own Docker
 *   network — never a database anyone else uses;
 * - `scripts/delay-proxy.mjs` in front of it, `--delay-ms` each way (10: a
 *   20 ms round trip, a database in the next zone). The proxy rather than
 *   `tc netem`: neither image carries iproute2, and netem needs NET_ADMIN; the
 *   proxy holds each chunk the same way and is the tool docs/performance.md
 *   already measures with. Its CPU is its own container's, not the server's.
 * - the server, `test/support/capacityServer.ts`: Ignition served as a tenant
 *   App (prepareTenantStartup, native auth, the authenticated tenant host)
 *   over that database, `--users` people across its four dealerships. In
 *   `docker` mode it runs in node:24-bookworm-slim with `--cpus` (CFS quota:
 *   0.5 is half of one core) over this checkout mounted read-only; the native
 *   binaries it loads (tsx's esbuild, rolldown) are this machine's, so their
 *   Linux builds are fetched once (`npm pack`) into
 *   node_modules/.cache/capacity and named by their loaders' variables. In `local`
 *   mode it is a child process with no CPU cap: CPU, allocation and GC per
 *   request are the same numbers, only the latencies stop meaning "on half a
 *   CPU". Docker is still used for PostgreSQL and the proxy. `local` is the
 *   fallback where a CPU cap is impractical (a Docker without CFS quotas, or
 *   a quick look during an edit): compare its runs only with its own runs.
 *   Both run the source under tsx, so a profile shows esbuild's `__name`
 *   wrappers and "set filename" frames a built server does not have, a few
 *   percent; the same in every run, so before and after still compare.
 *
 * What it drives (from the host, outside the cap): each person signs in, enters
 * their tenant (`whoami`, then `/api/tenant/enter`, discovery and lease and
 * the page's boot in one), holds the live-sync stream an open tab holds,
 * renews the lease halfway through as the page does, and works with `--think`
 * of thought between interactions: open a list with its tab counts 30%,
 * search 15%, open a record (and the bell's count) 30%, edit and save
 * (prepare + execute) 15%, create 5%, switch tab 5% — the mix the field load
 * test ran, read from the App payload rather than named.
 *
 * What it reports, in <out>/report.json and on stdout:
 *
 * - steady window (no profiler attached): CPU ms per request, bytes allocated
 *   per request, GC pause as a share of CPU, event-loop utilization, requests
 *   per second, and client-side p50/p95/p99 overall and per endpoint;
 * - tenant enter: the CPU of one `/api/tenant/enter`, measured alone — a
 *   dealership's first, a second person's into a warm dealership, a person
 *   entering again — before the load and after it;
 * - a profile window: the same counts with a CPU profile and a sampling
 *   allocation profile (collected objects kept) attached, written as
 *   <out>/profile.cpuprofile and <out>/profile.heapprofile (open either in
 *   Chrome DevTools) and summarized as the top functions by self time and by
 *   bytes allocated. The profilers cost CPU themselves, so the steady window
 *   is the number to compare, the profile window the one to read.
 *
 * Heavy: run it alone (not beside the test gates), and expect about
 * warmup + steady + profile + two minutes of setup.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : fallback;
};
const MODE = opt('mode', 'docker');
const CPUS = opt('cpus', '0.5');
const USERS = Number(opt('users', '25'));
const WARMUP = Number(opt('warmup', '60')) * 1000;
const STEADY = Number(opt('steady', '180')) * 1000;
const PROFILE = Number(opt('profile', '60')) * 1000;
const DELAY = Number(opt('delay-ms', '10'));
/* 3 s between interactions by default: the pace the field report's people worked at. A range draws from it. */
const [THINK_MIN, THINK_MAX = THINK_MIN] = opt('think', '3000').split('-').map(Number);
const LIVE = opt('live', '1') !== '0';
/* The language every person reads in (their picked locale and Accept-Language); absent, the App's own. */
const LOCALE = opt('locale');
const many = (name) => argv.flatMap((arg, i) => (arg === `--${name}` ? [argv[i + 1]] : []));
const APP_DIR = opt('app') && resolve(opt('app'));
const SERVER_ROOT = resolve(opt('server-root', ROOT));
const CWD = resolve(opt('cwd', APP_DIR ? dirname(APP_DIR) : ROOT));
const PG_CONTAINER = opt('pg');
const SETUP = opt('setup');
const ENV_FILE = opt('env-file') && resolve(opt('env-file'));
const PREFER = { edit: opt('edit'), create: opt('create') };
const POOL_QUERY = Object.fromEntries(
  (opt('pool-query') ?? '')
    .split(';')
    .filter(Boolean)
    .map((part) => [part.slice(0, part.indexOf(':')), part.slice(part.indexOf(':') + 1)]),
);
const ENTERS = Number(opt('enters', '12'));
const LABEL = opt('label', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
const OUT = resolve(opt('out', join(ROOT, '.capacity', LABEL)));
if (!['docker', 'local'].includes(MODE)) throw new Error('--mode is docker or local');
if (APP_DIR && !opt('accounts')) throw new Error('--app needs --accounts');
mkdirSync(OUT, { recursive: true });

const id = `mistri-capacity-${process.pid}`;
const say = (line) => console.error(`[capacity] ${line}`);
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const started = [];
let child;

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

/* The served process runs this checkout's node_modules on Linux; the native pieces in it are this machine's.
   Each is fetched once for the container's platform (`npm pack`) into node_modules/.cache/capacity and named by
   the variable its loader reads: tsx's esbuild always, and rolldown, which an App with components bundles. */
function linuxNatives() {
  const arch = docker('version', '--format', '{{.Server.Arch}}') === 'amd64' ? 'x64' : 'arm64';
  const fetched = (name, version, inside) => {
    const dir = join(ROOT, 'node_modules/.cache/capacity', `${name.replace(/[@/]/g, '_')}-${version}`);
    const file = join(dir, 'package', inside);
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true });
      say(`fetching ${name}@${version}`);
      const tarball = execFileSync('npm', ['pack', `${name}@${version}`, '--silent'], { cwd: dir, encoding: 'utf8' }).trim();
      execFileSync('tar', ['xzf', tarball], { cwd: dir });
    }
    return file;
  };
  const version = (pkg) => {
    const file = join(ROOT, 'node_modules', pkg, 'package.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).version : undefined;
  };
  const natives = [{ env: 'ESBUILD_BINARY_PATH', file: fetched(`@esbuild/linux-${arch}`, version('esbuild'), 'bin/esbuild') }];
  const rolldown = version('rolldown');
  if (rolldown)
    natives.push({
      env: 'NAPI_RS_NATIVE_LIBRARY_PATH',
      file: fetched(`@rolldown/binding-linux-${arch}-gnu`, rolldown, `rolldown-binding.linux-${arch}-gnu.node`),
    });
  return natives.map((native, i) => ({ ...native, at: `/opt/native-${i}${native.file.endsWith('.node') ? '.node' : ''}` }));
}

/** The server's environment for an App served by the CLI: the env file's, then each --env, `{pg}` routed. */
function appEnv(route) {
  const env = {};
  if (ENV_FILE)
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  for (const pair of many('env')) {
    const eq = pair.indexOf('=');
    env[pair.slice(0, eq)] = pair.slice(eq + 1).replaceAll('{pg}', route);
  }
  return env;
}

/** What starts the served process: Ignition's fixture, or the CLI over the given App with the probe preloaded. */
function serverCommand(port) {
  if (!APP_DIR) return { cwd: SERVER_ROOT, args: ['--import', 'tsx', join(SERVER_ROOT, 'test/support/capacityServer.ts')] };
  const path = (name) => (opt(name) ? ['--' + name, resolve(opt(name))] : []);
  return {
    cwd: CWD,
    args: [
      '--import',
      'tsx',
      '--import',
      join(ROOT, 'test/support/capacityPreload.ts'),
      join(SERVER_ROOT, 'packages/mistri/src/server/index.ts'),
      '--app',
      APP_DIR,
      ...path('config'),
      ...path('commands'),
      ...path('jobs'),
      ...path('policy'),
      ...(opt('mount') ? ['--mount', opt('mount')] : []),
      '--port',
      String(port),
      '--host',
      MODE === 'docker' ? '0.0.0.0' : '127.0.0.1',
      ...(opt('serve-args') ?? '').split(/\s+/).filter(Boolean),
    ],
  };
}

async function setUp() {
  docker('network', 'create', id);
  started.push(() => docker('network', 'rm', id));
  const pg = PG_CONTAINER ?? `${id}-pg`;
  let pgPort = MODE === 'local' ? await freePort() : 5432;
  if (PG_CONTAINER) {
    /* Joined to this run's network and left as it was found: it is the caller's, seeded once. */
    docker('network', 'connect', id, pg);
    started.push(() => docker('network', 'disconnect', id, pg));
    if (MODE === 'local') pgPort = Number(docker('port', pg, '5432/tcp').split('\n')[0].split(':').pop());
  } else {
    docker(
      'run',
      '-d',
      '--rm',
      '--name',
      pg,
      '--network',
      id,
      ...(MODE === 'local' ? ['-p', `127.0.0.1:${pgPort}:5432`] : []),
      '-e',
      'POSTGRES_PASSWORD=capacity',
      'postgres:17-alpine',
      '-c',
      'max_connections=200',
    );
    started.push(() => docker('rm', '-f', pg));
  }
  const port = await freePort();
  const controlPort = await freePort();
  const admin =
    MODE === 'local' ? `postgres://postgres:capacity@127.0.0.1:${pgPort}/postgres` : `postgres://postgres:capacity@${pg}:5432/postgres`;
  for (let tries = 0; ; tries += 1) {
    try {
      docker('exec', pg, 'pg_isready', '-U', 'postgres', '-h', '127.0.0.1');
      break;
    } catch {
      if (tries > 60) throw new Error('PostgreSQL did not start');
      await sleep(500);
    }
  }
  if (SETUP) {
    const published = PG_CONTAINER ? docker('port', pg, '5432/tcp').split('\n')[0].split(':').pop() : pgPort;
    say(`setup: ${SETUP}`);
    execFileSync('sh', ['-c', SETUP], {
      cwd: CWD,
      stdio: ['ignore', process.stderr, process.stderr],
      env: { ...process.env, CAPACITY_PG_URL: `postgres://postgres:capacity@127.0.0.1:${published}` },
    });
  }
  const origin = `http://127.0.0.1:${port}`;
  const ignitionEnv = {
    TABLEWALK_TEST_PG: admin,
    CAPACITY_PORT: port,
    CAPACITY_ORIGIN: origin,
    CAPACITY_USERS: USERS,
  };
  let route;
  if (MODE === 'docker') {
    docker(
      'run',
      '-d',
      '--rm',
      '--name',
      `${id}-delay`,
      '--network',
      id,
      '-v',
      `${ROOT}/scripts:/scripts:ro`,
      'node:24-bookworm-slim',
      'node',
      '/scripts/delay-proxy.mjs',
      '--host',
      '0.0.0.0',
      '--listen',
      '5432',
      '--to',
      `${pg}:5432`,
      '--ms',
      String(DELAY),
    );
    started.push(() => docker('rm', '-f', `${id}-delay`));
    route = `${id}-delay:5432`;
    const natives = linuxNatives();
    const env = {
      ...(APP_DIR ? appEnv(route) : { ...ignitionEnv, CAPACITY_ROUTE: route }),
      CAPACITY_CONTROL_PORT: controlPort,
      CAPACITY_OUT: '/out',
      MISTRI_SERVER_TIMING: '1',
      ...Object.fromEntries(natives.map((native) => [native.env, native.at])),
      NODE_ENV: 'production',
    };
    /* Every checkout at the path it has here, so a symlinked node_modules resolves inside as it does outside. */
    const readOnly = [...new Set([ROOT, SERVER_ROOT, ...(APP_DIR ? [CWD, APP_DIR] : [])])];
    const command = serverCommand(port);
    docker(
      'run',
      '-d',
      '--name',
      `${id}-server`,
      '--network',
      id,
      `--cpus=${CPUS}`,
      '--memory=1g',
      '-p',
      `127.0.0.1:${port}:${port}`,
      '-p',
      `127.0.0.1:${controlPort}:${controlPort}`,
      ...readOnly.flatMap((dir) => ['-v', `${dir}:${dir}:ro`]),
      ...many('volume').flatMap((dir) => ['-v', `${resolve(dir)}:${resolve(dir)}`]),
      '-v',
      `${OUT}:/out`,
      ...natives.flatMap((native) => ['-v', `${native.file}:${native.at}:ro`]),
      '-w',
      command.cwd,
      ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      'node:24-bookworm-slim',
      'node',
      ...command.args,
    );
    started.push(() => {
      try {
        docker('stop', '-t', '30', `${id}-server`);
      } finally {
        // The container's stderr comes back on docker's stderr.
        const logs = spawnSync('docker', ['logs', `${id}-server`], { encoding: 'utf8' });
        writeFileSync(join(OUT, 'server.log'), logs.stdout + logs.stderr);
        docker('rm', '-f', `${id}-server`);
      }
    });
  } else {
    const proxyPort = await freePort();
    const proxy = spawn(
      process.execPath,
      [join(ROOT, 'scripts/delay-proxy.mjs'), '--listen', String(proxyPort), '--to', `127.0.0.1:${pgPort}`, '--ms', String(DELAY)],
      { stdio: 'ignore' },
    );
    started.push(() => proxy.kill());
    route = `127.0.0.1:${proxyPort}`;
    const command = serverCommand(port);
    child = spawn(process.execPath, command.args, {
      cwd: command.cwd,
      env: {
        ...process.env,
        ...(APP_DIR ? appEnv(route) : { ...ignitionEnv, CAPACITY_ROUTE: route }),
        CAPACITY_CONTROL_PORT: String(controlPort),
        CAPACITY_OUT: OUT,
        MISTRI_SERVER_TIMING: '1',
        NODE_ENV: 'production',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (chunk) => (log += chunk));
    child.stderr.on('data', (chunk) => (log += chunk));
    started.push(async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await Promise.race([new Promise((done) => child.once('exit', done)), sleep(30000)]);
      }
      writeFileSync(join(OUT, 'server.log'), log);
    });
  }
  return { base: origin, control: `http://127.0.0.1:${controlPort}` };
}

async function tearDown() {
  for (const step of started.reverse()) {
    try {
      await step();
    } catch (error) {
      say(`cleanup: ${String(error?.message ?? error).split('\n')[0]}`);
    }
  }
}

/* ---- measuring ---- */
const records = []; // { phase, endpoint, interaction, ms, status, st }
const liveEvents = {}; // events a live stream carried, by phase
const liveErrors = {};
let liveOff = 0; // streams the server answered 204: it follows no changes
let phase = 'setup';
const pct = (values, p) => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] * 10) / 10;
};
const summary = (values) => ({ n: values.length, p50: pct(values, 50), p95: pct(values, 95), p99: pct(values, 99), max: pct(values, 100) });

/** One person: a cookie jar, a lease, and what the App offers them. */
class Person {
  constructor(base, account) {
    this.base = base;
    this.account = account;
    this.cookies = new Map();
    this.state = {};
    this.stopped = false;
  }
  async http(endpoint, method, path, body, headers = {}, interaction = 'setup') {
    const start = performance.now();
    let status = 0,
      json,
      serverCpu,
      flights;
    try {
      const res = await fetch(this.base + path, {
        method,
        headers: {
          origin: this.base,
          accept: 'application/json',
          ...(LOCALE ? { 'accept-language': LOCALE } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(this.cookies.size ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60000),
      });
      for (const line of res.headers.getSetCookie?.() ?? []) {
        const [pair] = line.split(';');
        const eq = pair.indexOf('=');
        if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
      }
      status = res.status;
      const timing = res.headers.get('server-timing') ?? '';
      serverCpu = Number(/(?:^|, )cpu;dur=([\d.]+)/.exec(timing)?.[1]);
      /* The request's round trips, every database it touched (`db-app`, `db-auth`) summed, as a field load test reads them. */
      const each = [...timing.matchAll(/(?:^|, )db-[a-z-]+;[^,]*?desc="flights=(\d+)/g)].map((m) => Number(m[1]));
      if (each.length) flights = each.reduce((sum, n) => sum + n, 0);
      const text = await res.text();
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    } catch (error) {
      status = error?.name === 'TimeoutError' ? 599 : 0;
    }
    records.push({
      phase,
      endpoint,
      interaction,
      ms: performance.now() - start,
      status,
      serverCpu,
      ...(flights === undefined ? {} : { flights }),
      ...(status >= 400 ? { code: json?.code } : {}),
    });
    return { status, json };
  }
  lease() {
    const l = this.state.lease;
    return {
      'x-mistri-account': l.accountId,
      'x-mistri-app': l.appId,
      'x-mistri-tab': l.tabId,
      'x-mistri-context': l.context,
      'x-mistri-lease-revision': String(l.revision),
    };
  }
  query() {
    return `app=${encodeURIComponent(this.state.lease.appId)}&tenant=${encodeURIComponent(this.state.lease.tenantId)}`;
  }
  async post(endpoint, path, body, interaction) {
    let r = await this.http(endpoint, 'POST', `${path}?${this.query()}`, body, this.lease(), interaction);
    if ([401, 409, 410].includes(r.status) && (r.json?.code ?? '').startsWith('tenant_')) {
      await this.enter(interaction); // a lease the server let go: enter again, as the page does
      r = await this.http(endpoint, 'POST', `${path}?${this.query()}`, body, this.lease(), interaction);
    }
    return r;
  }
  /* A server beyond loopback keeps Better Auth's per-address sign-in limit (three in ten seconds), and every
     person here signs in from one address: a refused sign-in waits and tries again. */
  async signIn() {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const r = await this.http('auth/sign-in', 'POST', '/api/auth/sign-in/email', {
        email: this.account.email,
        password: this.account.password,
      });
      if (r.status === 200) return;
      if (r.status !== 429) throw new Error(`sign-in ${r.status}`);
      await sleep(11000);
    }
    throw new Error('sign-in 429');
  }
  async whoami(interaction) {
    const who = await this.http('whoami', 'GET', `/api/whoami?app=${encodeURIComponent(this.state.appId)}`, undefined, {}, interaction);
    if (who.json?.accountId) this.accountId = who.json.accountId;
    // The bell is drawn, and its count asked, only where the App keeps an inbox (appChrome.js `me.inbox`).
    this.inbox = who.json?.inbox === true;
    return who.json;
  }
  async enterOnly(interaction) {
    const r = await this.http(
      'tenant/enter',
      'POST',
      `/api/tenant/enter?app=${encodeURIComponent(this.state.appId)}`,
      { path: `/${this.state.appId}`, search: '' },
      { 'x-mistri-account': this.accountId ?? this.account.accountId, 'x-mistri-app': this.state.appId },
      interaction,
    );
    const entered = r.json?.entered;
    if (!entered?.context) throw new Error(`no lease (${r.status}): ${JSON.stringify(r.json)?.slice(0, 200)}`);
    this.state.lease = entered.context;
    this.state.boot = entered.boot;
    this.renewal();
    return r;
  }
  /** Renewed halfway through the lease, as the page does; a renewal is a request a tab makes. */
  renewal() {
    clearTimeout(this.renew);
    if (this.stopped || !this.working) return;
    const ms = Math.max(5000, (this.state.lease.expiresAt - Date.now()) / 2);
    this.renew = setTimeout(async () => {
      if (this.stopped) return;
      const l = this.state.lease;
      const r = await this.http(
        'tenant/context/renew',
        'POST',
        `/api/tenant/context/renew?${this.query()}`,
        { tabId: l.tabId, expectedContext: l.context, expectedRevision: l.revision },
        { 'x-mistri-account': l.accountId, 'x-mistri-app': l.appId },
        'renew',
      );
      if (r.status === 200 && r.json?.context) this.state.lease = r.json;
      this.renewal();
    }, ms);
    this.renew.unref?.();
  }
  /** The live-sync stream an open tab holds, reconnected with its cursor as the client does. */
  async live() {
    let cursor;
    let failures = 0;
    this.abort = new AbortController();
    while (!this.stopped) {
      try {
        const res = await fetch(`${this.base}/api/live?${this.query()}${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`, {
          headers: {
            origin: this.base,
            accept: 'text/event-stream',
            cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
            ...this.lease(),
          },
          signal: this.abort.signal,
        });
        /* 204: this server follows no changes (live sync off, or no change store), and the client stops asking. */
        if (res.status === 204) {
          liveOff++;
          return;
        }
        if (!res.ok || !res.body) throw new Error(`live ${res.status}`);
        failures = 0;
        const decoder = new TextDecoder();
        let tail = '';
        for await (const chunk of res.body) {
          tail += decoder.decode(chunk, { stream: true });
          let cut;
          while ((cut = tail.indexOf('\n\n')) >= 0) {
            const block = tail.slice(0, cut);
            tail = tail.slice(cut + 2);
            if (block.startsWith(':')) continue; // a heartbeat
            liveEvents[phase] = (liveEvents[phase] ?? 0) + 1;
            const at = block.split('\n').find((line) => line.startsWith('id:'));
            if (at) cursor = at.slice(3).trim();
          }
        }
      } catch (error) {
        if (this.stopped) return;
        failures += 1;
        liveErrors[String(error?.message ?? error).slice(0, 60)] = (liveErrors[String(error?.message ?? error).slice(0, 60)] ?? 0) + 1;
      }
      await sleep(Math.min(30000, 1000 * 2 ** Math.min(failures, 5)));
    }
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.renew);
    this.abort?.abort();
  }
  async enter(interaction) {
    await this.whoami(interaction);
    return this.enterOnly(interaction);
  }
}

/* ---- the App's offer, read from its payload ---- */
const SIMPLE = new Set(['email', 'text', 'textarea', 'choice', 'date', 'money', 'number', 'int', 'integer', 'boolean', 'checkbox']);
function fillInput(defs, tag) {
  const input = {};
  for (const d of defs ?? []) {
    if (!SIMPLE.has(d.type)) {
      if (d.required) return undefined;
      continue;
    }
    if (!d.required && (d.type === 'date' || /phone/i.test(d.name))) continue;
    let v;
    if (d.type === 'email' || /email/i.test(d.name)) v = `load-${Math.random().toString(36).slice(2, 10)}@load.test`;
    else if (d.type === 'text' || d.type === 'textarea') v = `[load] ${tag}`.slice(0, d.maxLength ?? 100);
    else if (d.type === 'choice') v = d.options?.[0]?.value;
    else if (d.type === 'date') v = new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 10);
    else if (d.type === 'boolean' || d.type === 'checkbox') v = false;
    else v = Math.max(d.min ?? 1, 1);
    if (v === undefined) return undefined;
    if (d.pattern && d.type === 'text') v = new Date().toISOString().slice(0, 7);
    input[d.name] = v;
  }
  return input;
}
function findApp(payload) {
  const seen = new Set();
  let found;
  const walk = (o) => {
    if (found || !o || typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    if (o.views && o.resources && typeof o.views === 'object') found = o;
    else for (const v of Object.values(o)) walk(v);
  };
  walk(payload);
  return found;
}
function discover(app) {
  const lists = Object.entries(app.views ?? {})
    .filter(([, v]) => v?.table)
    .map(([viewId, v]) => ({
      id: viewId,
      table: v.table,
      show: v.show ?? [],
      tabs: (v.tabs?.length ? v.tabs : [{ query: '' }]).map((t) => t.query ?? ''),
    }));
  const commands = [];
  for (const [table, r] of Object.entries(app.resources ?? {}))
    for (const a of r.actions ?? []) if (a.command?.id && a.command.version) commands.push({ table, ...a.command });
  for (const v of Object.values(app.views ?? {})) if (v?.command?.id && v.command.version) commands.push({ ...v.command });
  const fillable = (c) => fillInput(c.input, 'x') !== undefined;
  /* A command named with --edit or --create is used or skipped, never swapped for another that happens to fill. */
  const choose = (name, targeted) =>
    name ? commands.find((c) => c.id === name) : commands.find((c) => (targeted ? !!c.target : !c.target) && fillable(c));
  return { lists, edit: choose(PREFER.edit, true), create: choose(PREFER.create, false) };
}

/* ---- the mix ---- */
let seed = 20261028;
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(random() * list.length)];
const MIX = [
  ['list', 30],
  ['search', 15],
  ['record', 30],
  ['edit', 15],
  ['create', 5],
  ['view', 5],
];
const choose = () => {
  let r = random() * 100;
  for (const [name, w] of MIX) if ((r -= w) < 0) return name;
  return 'list';
};
const listQuery = (list, tab) =>
  `${list.table} ${list.tabs[tab] ?? ''}${list.show.length ? ` show ${list.show.join(', ')}, $label, id` : ''}`.replace(/\s+/g, ' ').trim();
const interactions = {
  async list(p, ix) {
    const list = pick(p.state.map.lists);
    p.state.last = list;
    await Promise.all([
      p.post('run', '/api/run', { q: listQuery(list, 0), limit: 20, offset: 0, exactCount: false }, ix),
      p.post('counts', '/api/counts', { items: list.tabs.map((_, i) => listQuery(list, i)) }, ix),
    ]);
  },
  async search(p, ix) {
    const list = p.state.last ?? pick(p.state.map.lists);
    const sample = await p.post('run', '/api/run', { q: listQuery(list, 0), limit: 20, offset: 0, exactCount: false }, ix);
    const row = sample.json?.rows?.[0];
    const col = (sample.json?.columns ?? []).find((c) => typeof row?.[c] === 'string' && c !== 'id' && !c.startsWith('$'));
    if (!col) return;
    const term = String(row[col])
      .split(/\s+/)[0]
      .replace(/[^\w-]/g, '')
      .slice(0, 12);
    if (term)
      await p.post('run search', '/api/run', { q: `${list.table} ${col} contains ${term}`, limit: 20, offset: 0, exactCount: false }, ix);
  },
  async record(p, ix) {
    const list = p.state.last ?? pick(p.state.map.lists);
    const ids = await pool(p, list.table, ix);
    if (!ids.length) return;
    const id = pick(ids);
    await Promise.all([
      p.post(
        'run record',
        '/api/run',
        {
          q: `${list.table} id = ${id}${list.show.length ? ` show ${list.show.join(', ')}, $label, id` : ''}`,
          limit: 1,
          offset: 0,
          exactCount: false,
        },
        ix,
      ),
      p.post('record-decisions', '/api/record-decisions', { table: list.table, key: { id: String(id) } }, ix),
    ]);
    /* The record page asks the bell's count after it paints, as the client does. */
    if (p.inbox) await p.post('inbox', '/api/inbox', { limit: 1 }, ix);
  },
  async edit(p, ix) {
    const cmd = p.state.map.edit;
    if (!cmd) return;
    const ids = await pool(p, cmd.table ?? cmd.target, ix);
    if (ids.length) await command(p, cmd, { id: String(pick(ids)) }, ix);
  },
  async create(p, ix) {
    const cmd = p.state.map.create;
    if (cmd) await command(p, cmd, {}, ix);
  },
  async view(p, ix) {
    const list = pick(p.state.map.lists);
    const tab = Math.floor(random() * list.tabs.length);
    await Promise.all([
      p.post('run', '/api/run', { q: listQuery(list, tab), limit: 20, offset: 0, exactCount: false }, ix),
      p.post('counts', '/api/counts', { items: list.tabs.map((_, i) => listQuery(list, i)) }, ix),
    ]);
  },
};
async function pool(p, table, ix) {
  const have = (p.state.pool ??= {});
  if (!have[table]) {
    const filter = POOL_QUERY[table] ? ` ${POOL_QUERY[table]}` : '';
    const r = await p.post('run pool', '/api/run', { q: `${table}${filter} show id`, limit: 100, offset: 0, count: 'none' }, ix);
    have[table] = (r.json?.rows ?? []).map((row) => row.id).filter((v) => v != null);
  }
  return have[table];
}
async function command(p, cmd, key, ix) {
  const input = fillInput(cmd.input, ix);
  if (!input) return;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prepared = await p.post('commands/prepare', '/api/commands/prepare', { command: cmd.id, commandVersion: cmd.version, key }, ix);
    const done = await p.post(
      'commands/execute',
      '/api/commands/execute',
      {
        command: cmd.id,
        commandVersion: cmd.version,
        key,
        expectedVersion: prepared.json?.expectedVersion ?? 0,
        idempotencyKey: crypto.randomUUID(),
        input,
      },
      ix,
    );
    if (done.status !== 409 || done.json?.code !== 'stale_record') return;
  }
}

async function work(p) {
  await sleep(random() * THINK_MAX);
  while (!p.stopped) {
    const name = choose();
    const t0 = performance.now();
    try {
      await interactions[name](p, name);
      records.push({ phase, endpoint: `ix ${name}`, interaction: name, ms: performance.now() - t0, status: 200, ix: true });
    } catch (error) {
      records.push({
        phase,
        endpoint: `ix ${name}`,
        interaction: name,
        ms: performance.now() - t0,
        status: 0,
        ix: true,
        error: String(error?.message ?? error).slice(0, 120),
      });
    }
    await sleep(THINK_MIN + random() * (THINK_MAX - THINK_MIN));
  }
}

const control = async (base, path) => {
  const res = await fetch(base + path, { method: path.startsWith('/ready') ? 'GET' : 'POST' });
  const body = await res.json();
  if (!res.ok) throw new Error(`control ${path}: ${body.error}`);
  return body;
};

/** The CPU one enter costs, measured alone: a window around the one request. */
async function measureEnter(ctl, person, kind) {
  await person.whoami('probe');
  await control(ctl, '/begin');
  const t0 = performance.now();
  await person.enterOnly('probe');
  const ms = performance.now() - t0;
  const stats = await control(ctl, `/end?label=enter`);
  return { kind, cpuMs: Math.round(stats.cpuMs * 10) / 10, allocatedKB: Math.round(stats.allocatedBytes / 1024), ms: Math.round(ms) };
}

/** Top frames by self time (CPU) or by bytes (allocation), so a report names its hotspots without DevTools. */
function topCpu(file, n = 30) {
  const profile = JSON.parse(readFileSync(file, 'utf8'));
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const counts = new Map();
  for (const sample of profile.samples) counts.set(sample, (counts.get(sample) ?? 0) + 1);
  /* Shares of the time the process was not idle: an idle server is not a cost. */
  let total = 0;
  for (const [nodeId, count] of counts) if (byId.get(nodeId).callFrame.functionName !== '(idle)') total += count;
  const self = new Map();
  for (const [nodeId, count] of counts) {
    const f = byId.get(nodeId).callFrame;
    if (f.functionName === '(idle)') continue;
    const key = `${f.functionName || '(anonymous)'} ${f.url.replace(/^.*\/(packages|node_modules)\//, '$1/')}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + count);
  }
  /* And by total time: each sample counted once for every distinct frame on its stack. */
  const parent = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const keyOf = (f) => `${f.functionName || '(anonymous)'} ${f.url.replace(/^.*\/(packages|node_modules)\//, '$1/')}:${f.lineNumber + 1}`;
  const inclusive = new Map();
  for (const [nodeId, count] of counts) {
    if (byId.get(nodeId).callFrame.functionName === '(idle)') continue;
    const seen = new Set();
    for (let at = nodeId; at !== undefined; at = parent.get(at)) seen.add(keyOf(byId.get(at).callFrame));
    for (const key of seen) inclusive.set(key, (inclusive.get(key) ?? 0) + count);
  }
  const line = ([frame, c]) => `${((100 * c) / total).toFixed(1).padStart(5)}%  ${frame}`;
  return [
    'self',
    ...[...self]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(line),
    '',
    'total',
    ...[...inclusive]
      .sort((a, b) => b[1] - a[1])
      .filter(([frame]) => !/^\((root|program)\)/.test(frame))
      .slice(0, n * 2)
      .map(line),
  ];
}
function topAlloc(file, n = 30) {
  const profile = JSON.parse(readFileSync(file, 'utf8'));
  const self = new Map();
  let total = 0;
  const walk = (node) => {
    const bytes = node.selfSize ?? 0;
    total += bytes;
    const f = node.callFrame;
    const key = `${f.functionName || '(anonymous)'} ${f.url.replace(/^.*\/(packages|node_modules)\//, '$1/')}:${f.lineNumber + 1}`;
    if (bytes) self.set(key, (self.get(key) ?? 0) + bytes);
    for (const c of node.children ?? []) walk(c);
  };
  walk(profile.head);
  return [...self]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([frame, b]) => `${((100 * b) / (total || 1)).toFixed(1).padStart(5)}%  ${frame}`);
}

const rate = (stats) => ({
  requests: stats.requests,
  rps: Math.round((stats.requests / (stats.wallMs / 1000)) * 10) / 10,
  cpuMsPerRequest: Math.round((stats.cpuMs / Math.max(1, stats.requests)) * 100) / 100,
  allocatedKBPerRequest: Math.round(stats.allocatedBytes / 1024 / Math.max(1, stats.requests)),
  gcShareOfCpu: Math.round((stats.gcMs / Math.max(1, stats.cpuMs)) * 1000) / 1000,
  elu: Math.round(stats.elu * 1000) / 1000,
  cpuShareOfWall: Math.round((stats.cpuMs / stats.wallMs) * 1000) / 1000,
  heapUsedMB: Math.round(stats.heapUsedBytes / 1048576),
  byRoute: stats.byRoute,
});
const latencies = (name) => {
  const rows = records.filter((r) => r.phase === name && !r.ix);
  const byEndpoint = {};
  for (const r of rows) (byEndpoint[r.endpoint] ??= []).push(r.ms);
  const ixs = {};
  for (const r of records.filter((r) => r.phase === name && r.ix)) (ixs[r.interaction] ??= []).push(r.ms);
  const cpuBy = {};
  for (const r of rows) if (Number.isFinite(r.serverCpu)) (cpuBy[r.endpoint] ??= []).push(r.serverCpu);
  const flightsBy = {};
  for (const r of rows) if (Number.isFinite(r.flights)) (flightsBy[r.endpoint] ??= []).push(r.flights);
  return {
    overall: summary(rows.map((r) => r.ms)),
    errors: rows.filter((r) => r.status < 200 || r.status >= 400).length,
    errorCodes: rows
      .filter((r) => r.status >= 400 || r.status < 200)
      .reduce(
        (by, r) => ({
          ...by,
          [`${r.endpoint} ${r.status} ${r.code ?? ''}`.trim()]: (by[`${r.endpoint} ${r.status} ${r.code ?? ''}`.trim()] ?? 0) + 1,
        }),
        {},
      ),
    endpoints: Object.fromEntries(Object.entries(byEndpoint).map(([k, v]) => [k, summary(v)])),
    interactions: Object.fromEntries(Object.entries(ixs).map(([k, v]) => [k, summary(v)])),
    serverCpuByEndpoint: Object.fromEntries(Object.entries(cpuBy).map(([k, v]) => [k, summary(v)])),
    flightsByEndpoint: Object.fromEntries(Object.entries(flightsBy).map(([k, v]) => [k, summary(v)])),
  };
};

async function main() {
  say(`mode ${MODE}${MODE === 'docker' ? ` (--cpus=${CPUS})` : ''}, ${USERS} people, ${DELAY} ms each way to PostgreSQL, out ${OUT}`);
  const { base, control: ctl } = await setUp();
  let ready;
  for (let tries = 0; ; tries += 1) {
    try {
      ready = await control(ctl, '/ready');
      /* The CLI's own readiness: its stores attested and its database answering. */
      if (APP_DIR && !(await fetch(`${base}/readyz`)).ok) throw new Error('not ready');
      break;
    } catch {
      const exited = child
        ? child.exitCode !== null
        : MODE === 'docker' && docker('inspect', '-f', '{{.State.Running}}', `${id}-server`) !== 'true';
      if (tries > 600 || exited) throw new Error('the server did not start (see server.log)');
      await sleep(1000);
    }
  }
  say(APP_DIR ? 'server ready' : `server ready (${Math.round(ready.bootMs)} ms of setup)`);
  const accounts = APP_DIR ? JSON.parse(readFileSync(resolve(opt('accounts')), 'utf8')) : ready.accounts;
  const appId = APP_DIR ? opt('app-id', opt('mount')?.split('=')[0]) : ready.appId;
  if (!appId) throw new Error('--app needs --app-id (or a --mount that names it)');
  const person = (account) => {
    const p = Object.assign(new Person(base, account), { state: { appId } });
    /* A signed-in reader's language is their own pick, kept in their browser as this cookie (appLocale.ts
       localeCookieName); Accept-Language is asked only where nobody is known (readerLocale.ts requestLocale). */
    if (LOCALE) p.cookies.set(`mistri-locale-${encodeURIComponent(appId)}`, encodeURIComponent(LOCALE));
    return p;
  };
  const people = Array.from({ length: USERS }, (_, i) => person(accounts[i % accounts.length]));
  const extra = accounts.slice(0, 8).map(person);
  for (const p of [...people, ...extra]) await p.signIn();

  /* Enter, cold: each dealership's first, then a second person into a warm one, then the first again. */
  const enters = { before: [], after: [] };
  const byTenant = new Map();
  for (const p of extra) (byTenant.get(p.account.tenant) ?? byTenant.set(p.account.tenant, []).get(p.account.tenant)).push(p);
  for (const [, ps] of byTenant) {
    enters.before.push(await measureEnter(ctl, ps[0], 'first in its dealership'));
    if (ps[1]) enters.before.push(await measureEnter(ctl, ps[1], 'second person, warm dealership'));
    enters.before.push(await measureEnter(ctl, ps[0], 'same person again'));
  }
  say(`enter before load: ${enters.before.map((e) => `${e.kind}: ${e.cpuMs} ms`).join('; ')}`);

  /* People arrive over the first half of the warm-up, as the field load test ramped them, each entering as a page
     does before it works: twenty-five entering at once on half a CPU is a different test (and a tenant context
     that cannot be verified in time answers 503, which a page retries). */
  phase = 'warmup';
  const running = [];
  const t0 = Date.now();
  const arrive = async (p) => {
    p.working = true;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await p.enter('boot');
        break;
      } catch (error) {
        if (attempt >= 4 || p.stopped) throw error;
        await sleep(1000 * 2 ** attempt);
      }
    }
    let app = findApp(p.state.boot);
    if (!app) app = findApp((await p.http('app', 'GET', `/api/app?${p.query()}`, undefined, p.lease())).json);
    p.state.map = discover(app);
    if (!p.state.map.lists.length) throw new Error('the App offers no list');
    if (p === people[0])
      say(
        `the App offers ${p.state.map.lists.length} lists; edit ${p.state.map.edit?.id ?? 'none'}, create ${p.state.map.create?.id ?? 'none'}`,
      );
    await Promise.all([work(p), LIVE ? p.live() : undefined]);
  };
  for (const [i, p] of people.entries()) {
    running.push(
      arrive(p).catch((error) => {
        /* One person who never got in is a result, not the end of the run. */
        records.push({
          phase,
          endpoint: 'ix arrive',
          interaction: 'arrive',
          ms: 0,
          status: 0,
          ix: true,
          error: String(error?.message ?? error).slice(0, 120),
        });
        say(`a person could not enter: ${String(error?.message ?? error).slice(0, 160)}`);
      }),
    );
    await sleep(Math.max(0, t0 + (WARMUP * (i + 1)) / (people.length * 2) - Date.now()));
  }
  await sleep(Math.max(0, t0 + WARMUP - Date.now()));

  phase = 'steady';
  await control(ctl, '/begin');
  await sleep(STEADY);
  const steady = await control(ctl, '/end?label=steady');
  say(`steady: ${JSON.stringify(rate(steady)).slice(0, 300)}`);

  let profiled;
  if (PROFILE > 0) {
    phase = 'profile';
    await control(ctl, '/begin?profile=cpu,heap');
    await sleep(PROFILE);
    profiled = await control(ctl, '/end?label=profile');
  }
  phase = 'done';
  for (const p of people) p.stop();
  await Promise.race([Promise.all(running), sleep(THINK_MAX + 15000)]);

  for (let i = 0; i < ENTERS; i += 1) enters.after.push(await measureEnter(ctl, extra[i % extra.length], 'warm, after load'));
  /* And a CPU profile of enters alone (each with its who-am-I), which the mixed profile dilutes. */
  let enterProfile;
  if (ENTERS > 0) {
    await control(ctl, '/begin?profile=cpu');
    for (let i = 0; i < ENTERS * 2; i += 1) await extra[i % extra.length].enter('probe');
    enterProfile = await control(ctl, '/end?label=enter');
  }

  const pick = (k) => enters.before.filter((e) => e.kind === k).map((e) => e.cpuMs);
  const report = {
    label: LABEL,
    mode: MODE,
    cpus: MODE === 'docker' ? Number(CPUS) : undefined,
    users: USERS,
    delayMs: DELAY,
    think: [THINK_MIN, THINK_MAX],
    app: APP_DIR ? appId : 'ignition',
    live: LIVE ? { events: liveEvents, errors: liveErrors, ...(liveOff ? { off: liveOff } : {}) } : false,
    steady: { ...rate(steady), latency: latencies('steady') },
    enter: {
      firstInDealershipCpuMs: pick('first in its dealership'),
      secondPersonCpuMs: pick('second person, warm dealership'),
      samePersonAgainCpuMs: pick('same person again'),
      afterLoad: summary(enters.after.map((e) => e.cpuMs)),
      samples: enters,
    },
    ...(profiled ? { profile: { ...rate(profiled), latency: latencies('profile') } } : {}),
  };
  if (profiled) {
    const cpu = profiled.files.find((f) => f.endsWith('.cpuprofile'));
    const heap = profiled.files.find((f) => f.endsWith('.heapprofile'));
    const local = (f) => (MODE === 'docker' ? join(OUT, f.replace(/^\/out\//, '')) : f);
    if (cpu) writeFileSync(join(OUT, 'top-cpu.txt'), topCpu(local(cpu), 60).join('\n') + '\n');
    if (heap) writeFileSync(join(OUT, 'top-alloc.txt'), topAlloc(local(heap), 60).join('\n') + '\n');
  }
  const enterCpu = enterProfile?.files.find((f) => f.endsWith('.cpuprofile'));
  if (enterCpu)
    writeFileSync(
      join(OUT, 'top-enter-cpu.txt'),
      topCpu(MODE === 'docker' ? join(OUT, enterCpu.replace(/^\/out\//, '')) : enterCpu, 60).join('\n') + '\n',
    );
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  const s = report.steady;
  console.log(
    [
      `capacity ${LABEL}: ${MODE}${report.cpus ? ` ${report.cpus} CPU` : ''}, ${USERS} people, ${s.rps} req/s over ${s.requests} requests`,
      `  CPU ${s.cpuMsPerRequest} ms/request, ${s.allocatedKBPerRequest} KB allocated/request, GC ${(s.gcShareOfCpu * 100).toFixed(1)}% of CPU, ELU ${s.elu}`,
      `  latency p50 ${s.latency.overall.p50} ms, p95 ${s.latency.overall.p95} ms, p99 ${s.latency.overall.p99} ms, ${s.latency.errors} errors`,
      `  enter CPU: first ${report.enter.firstInDealershipCpuMs.join('/')} ms, second person ${report.enter.secondPersonCpuMs.join('/')} ms, again ${report.enter.samePersonAgainCpuMs.join('/')} ms, after load p50 ${report.enter.afterLoad.p50} ms`,
      `  report ${join(OUT, 'report.json')}`,
    ].join('\n'),
  );
}

let exiting = false;
const finish = async (code) => {
  if (exiting) return;
  exiting = true;
  await tearDown();
  process.exit(code);
};
process.on('SIGINT', () => void finish(130));
main().then(
  () => finish(0),
  async (error) => {
    console.error(error);
    await finish(1);
  },
);
