/** Disposable production CLI processes with explicit readiness and teardown. */
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestWorkspace } from './workspace.js';
import { createTestClient, type TestClient } from './client.js';
import { runTestMaintenance } from './worker.js';
import type { TestRow } from './appRequests.js';
import type { AssistantScript } from '../assistant/assistantScripted.js';
import type { DecisionScript } from '../decide/providers/scriptedDecisions.js';
import { TEST_CONTROL_HEADER, TEST_CONTROL_PATHS } from './control.js';
import { tenantTestClient, type TestTenantAccount, type TestTenantClient } from './tenant.js';
import { PLATFORM_TENANT_ID } from '../../shared/tenantContext.js';
import { serverEntry } from '../serverEntry.js';

interface HostOptions {
  workspace: TestWorkspace;
  /** Explicit endpoint injection and test secrets. Parent secrets are not inherited. */
  environment?: Record<string, string>;
  timeoutMs?: number;
  /** Explicit opt-in for real contract/database hosts; isolated tests default to loopback. */
  allowedHosts?: readonly string[];
}
export interface TestAppOptions extends HostOptions {
  directory: string;
  /** The App's database without a config: writable when the App writes, and a SQLite file outside the workspace
      served as a copy in it. */
  database?: string;
  config?: string;
  /** Production CLI options, e.g. --policy, --commands or --jobs. A relative path given to --policy, --commands or
      --jobs is the App directory's, as `--jobs jobs.ts` beside app.ts reads. */
  args?: readonly string[];
  /** The in-App assistant's model, scripted: each turn answers the person's words a pattern matches with text and
      tool calls, offline and the same every run. Without it the assistant has no model in a test. */
  assistant?: TestAssistantScript;
  /** The decision providers, scripted (decide/providers/scriptedDecisions.ts): each decision's answers by name, a
      `when` matching the inputs sent, offline and the same every run. Without it a test App's decisions have no provider. */
  decisions?: TestDecisionScript;
}
/** The turns a scripted assistant model replays (`startTestApp({ assistant })`). `$record` in a tool's input is the
    open record's key. */
export type TestAssistantScript = AssistantScript;
/** The answers scripted decision providers give (`startTestApp({ decisions })`), by decision name. */
export type TestDecisionScript = DecisionScript;
/** How a job run now ended (`host.runJob`): `succeeded`, or the state its first attempt left it in and why. */
export interface TestJobRun {
  state: string;
  code: string | null;
}
type TestValue = string | number | boolean | null;
export interface TestSuiteOptions extends HostOptions {
  /** Paths are relative to the test workspace; port is assigned automatically. */
  configuration: Record<string, unknown>;
}
async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  timer.unref();
  try {
    await done;
  } finally {
    clearTimeout(timer);
  }
}
async function startHost(options: HostOptions, argumentsFor: (port: number) => Promise<string[]>) {
  const timeout = options.timeoutMs ?? 30000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Test host timeout must be positive.');
  for (let attempt = 0; attempt < 4; attempt++) {
    const port = await unusedPort(),
      url = `http://127.0.0.1:${port}`;
    /* The server an App runs on is the `mistri` bin until the App framework has one of its own: this module built
       starts the built bin, and run from source starts the bin's source under tsx. */
    const built = import.meta.url.endsWith('.js');
    const entry = built ? [serverEntry()] : ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, serverEntry()];
    const guard = fileURLToPath(new URL(built ? './networkGuard.js' : './networkGuard.ts', import.meta.url));
    const args = await argumentsFor(port);
    entry.splice(entry.length - 1, 0, '--import', pathToFileURL(guard).href);
    const child = spawn(process.execPath, [...entry, ...args], {
      cwd: options.workspace.directory,
      env: {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        NODE_ENV: 'test',
        ...(!built ? { TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../../../tsconfig.json', import.meta.url)) } : {}),
        BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
        /* A suite signs in many times a second from this one machine, which Better Auth's per-address limits refuse
           with 429 past the third in ten seconds. The host listens on loopback only, where the server honours this
           (auth/requestRules.ts); the per-account lockout stays. A test of the limits passes "on" in `environment`. */
        MISTRI_TEST_AUTH_LIMITS: 'off',
        ...options.environment,
        XDG_CONFIG_HOME: options.workspace.path('config'),
        HOME: options.workspace.directory,
        MISTRI_TEST_ALLOWED_HOSTS: JSON.stringify(options.allowedHosts ?? []),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '',
      denied = false,
      failure: Error | undefined;
    child.on('error', (error) => {
      failure = error;
    });
    for (const stream of [child.stdout, child.stderr]) {
      let markerTail = '';
      stream.on('data', (chunk) => {
        const text = String(chunk);
        denied ||= (markerTail + text).includes('[mistri-test-network-denied]');
        markerTail = (markerTail + text).slice(-40);
        logs = (logs + text).slice(-64000);
      });
    }
    let verified = false;
    const close = async () => {
      await stop(child);
      if (verified) return;
      verified = true;
      if (denied) throw new Error(`Isolated App attempted an unexpected outbound connection.\n${logs}`);
    };
    options.workspace.own(close);
    const deadline = Date.now() + timeout;
    let ready = false;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null && !failure) {
      if (/Listening on |Suite listening on /.test(logs)) {
        // Startup emits this only after the listener and App owners are ready.
        ready = true;
        break;
      }
      await delay(25);
    }
    /* And /readyz says so: what an orchestrator waits on is what a test waits on, so a test's first request never
       meets an App still coming up. */
    while (ready && Date.now() < deadline && child.exitCode === null) {
      const answer = await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(2000) }).catch(() => undefined);
      if (answer?.status === 200) break;
      await delay(25);
    }
    if (ready) return { url, port, logs: () => logs, client: () => createTestClient(url), close, [Symbol.asyncDispose]: close };
    await close();
    if (/EADDRINUSE|port .*already in use/.test(logs) && attempt < 3) continue;
    const exited = child.exitCode ?? child.signalCode;
    throw new Error(
      exited !== null
        ? `Test host stopped (exit ${exited}) before it was ready.\n${logs}`
        : `Test host failed to become ready within ${timeout}ms.\n${logs}`,
      { cause: failure },
    );
  }
  throw new Error('Could not allocate a test host port.');
}
/**
 * Signed-in sessions by role, made the way an administrator makes accounts: the account a first start makes
 * (MISTRI_AUTH_ADMIN_EMAIL, which holds `admin`) adds one account per role through the App's own accounts API,
 * once, and each `as(role)` is a new session signed in to it.
 */
function roleSessions(host: { client: () => TestClient }, admin: { email: string; password: string }) {
  const accounts = new Map<string, Promise<{ email: string; password: string }>>();
  let administrator: Promise<TestClient> | undefined;
  const signedIn = async (account: { email: string; password: string }, role: string) => {
    const client = host.client();
    const answer = await client.request('/api/auth/sign-in/email', { method: 'POST', json: account });
    if (answer.status !== 200)
      throw new Error(
        answer.status === 404
          ? `as("${role}") signs in, and this App has no sign-in: give it auth, or use host.client() for a signed-out visitor.`
          : `Signing in as "${role}" answered ${answer.status}: ${(await answer.text()).slice(0, 500)}`,
      );
    client.reset();
    return client;
  };
  return async function as(role: string): Promise<TestClient> {
    if (role === 'admin') return signedIn(admin, role);
    let made = accounts.get(role);
    if (!made) {
      made = (async () => {
        administrator ??= signedIn(admin, 'admin');
        const by = await administrator;
        const account = {
          email: `${role.toLowerCase().replace(/[^a-z0-9]+/g, '-')}@example.test`,
          password: randomBytes(18).toString('base64url'),
        };
        const answer = await by.request('/api/accounts', {
          method: 'POST',
          json: {
            app: await by.appId(),
            operation: 'create',
            name: `Test ${role}`,
            email: account.email,
            roles: [role],
            password: account.password,
          },
        });
        if (answer.status !== 200)
          throw new Error(`Making an account for "${role}" answered ${answer.status}: ${(await answer.text()).slice(0, 500)}`);
        return account;
      })();
      accounts.set(role, made);
      made.catch(() => accounts.delete(role));
    }
    return signedIn(await made, role);
  };
}

/** A SQLite file inside the workspace as it is; one outside it, copied in with its -wal beside it; a URL as written. */
async function workspaceDatabase(workspace: TestWorkspace, database: string): Promise<string> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(database) && !/^file:/i.test(database)) return database;
  const file = resolve(database.replace(/^file:/i, ''));
  const inside = relative(workspace.directory, file);
  if (inside && !inside.startsWith('..') && !isAbsolute(inside)) return file;
  if (!existsSync(file)) return file;
  const target = workspace.path(`databases/${basename(file)}`);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(file, target);
  for (const suffix of ['-wal', '-shm']) if (existsSync(file + suffix)) await copyFile(file + suffix, target + suffix);
  return target;
}
/** The flags whose value is a module of the App's: a relative one is read from the App's directory, not the
    workspace the process runs in. */
const APP_PATH_FLAGS = new Set(['--policy', '--commands', '--jobs']);
function appArgs(directory: string, args: readonly string[]): string[] {
  return args.map((arg, i) => (i > 0 && APP_PATH_FLAGS.has(args[i - 1]) && !isAbsolute(arg) ? resolve(directory, arg) : arg));
}
/** Starts the actual App CLI in an isolated process, preserving production behavior. */
export async function startTestApp(options: TestAppOptions) {
  const directory = resolve(options.directory);
  /* What the test host alone may ask of its server: setup rows and a job run now (http/testControl.ts). */
  const control = randomBytes(32).toString('hex');
  const script = options.assistant
    ? await options.workspace.write(`assistant-${randomBytes(6).toString('hex')}.json`, options.assistant)
    : undefined;
  const decide = options.decisions
    ? await options.workspace.write(`decisions-${randomBytes(6).toString('hex')}.json`, options.decisions)
    : undefined;
  /* The first start's administrator, unless the test names its own: what `as(role)` makes accounts with. */
  const admin = {
    email: options.environment?.MISTRI_AUTH_ADMIN_EMAIL ?? 'admin@example.test',
    password: options.environment?.MISTRI_AUTH_ADMIN_PASSWORD ?? randomBytes(18).toString('base64url'),
  };
  /* A database given without a config is served writable when the App writes (cli/mistriMain.ts says when), so a SQLite file
     from outside the workspace is served as a copy in it: a test's writes never reach the file you develop on. One
     the test made in its workspace is served as it is, so the test can read back what was written. */
  const database = options.database && !options.config ? await workspaceDatabase(options.workspace, options.database) : options.database;
  options = {
    ...options,
    database,
    environment: {
      MISTRI_AUTH_ADMIN_EMAIL: admin.email,
      MISTRI_AUTH_ADMIN_PASSWORD: admin.password,
      ...(database && !options.config ? { MISTRI_TEST_DATABASE: 'app-writes' } : {}),
      ...(script ? { MISTRI_ASSISTANT_SCRIPT: script } : {}),
      ...(decide ? { MISTRI_DECIDE_SCRIPT: decide } : {}),
      ...options.environment,
      MISTRI_TEST_CONTROL: control,
    },
  };
  const host = startHost(options, async (port) => [
    '--app',
    directory,
    ...(options.config ? ['--config', options.config] : ['--no-config']),
    ...(options.database ? ['--db', options.database] : []),
    ...appArgs(directory, options.args ?? []),
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
  ]);
  /* A host that never became ready because the App binds a connection the host does not serve is said as that, with
     both names, before the log: the database is named after the App's connection only beside one App. */
  return host.then(
    (started) => ({ ...started, as: roleSessions(started, admin), ...setup(started.url, control) }),
    (error: Error) => {
      const log = error.message;
      /* A --commands, --jobs or --policy module that did not load is said first, in its own words: the server's line
         ("could not be loaded") sat in a page of startup log, and the test said only that the host was not ready. */
      const unloaded = /The (?:commands|jobs|policy) module "[^"]+" did not load: [^\n]+/.exec(log)?.[0];
      if (unloaded) throw new Error(`The App did not start: ${unloaded}\n${log}`, { cause: error });
      const wanted = /names connection "([^"]+)", which this server does not have/.exec(log)?.[1];
      if (!wanted) throw error;
      const served = [...log.matchAll(/^mistri: (.+) \((?:sqlite|postgres|mysql|http)\) — /gm)].map((m) => m[1]);
      throw new Error(
        `The App binds connection "${wanted}", which the test host does not serve` +
          (served.length
            ? `; it named ${served.length === 1 ? 'its database' : 'its databases'} ${served.map((n) => `"${n}"`).join(', ')}`
            : '') +
          `. Pass a config that names "${wanted}", or give startTestApp the database of an App whose connection is "${wanted}".\n${log}`,
        { cause: error },
      );
    },
  );
}
/** A test's own requests to its server: setup that no person's grant governs, said as setup. */
function setup(url: string, control: string) {
  async function ask<T>(path: string, body: unknown, timeoutMs = 30000): Promise<T> {
    const answer = await fetch(new URL(path, url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', [TEST_CONTROL_HEADER]: control },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs + 5000),
    });
    const reply = (await answer.json().catch(() => ({}))) as { value?: T; error?: string };
    if (answer.status !== 200) throw new Error(reply.error ?? `${path} answered ${answer.status}.`);
    return reply.value as T;
  }
  /**
   * Rows inserted as the test's setup, straight into the App's database in one transaction: no grant, row policy,
   * validation or command is asked, as a seed script inserts. What comes back is each row as stored, its id and
   * defaults filled. Arrange with this; assert through `as(role)`, which asks what a person is allowed.
   */
  function seed(table: string, row: Record<string, TestValue>): Promise<TestRow>;
  function seed(table: string, rows: readonly Record<string, TestValue>[]): Promise<TestRow[]>;
  async function seed(table: string, rows: Record<string, TestValue> | readonly Record<string, TestValue>[]) {
    const many = Array.isArray(rows);
    const inserted = await ask<TestRow[]>(TEST_CONTROL_PATHS.seed, { table, rows: many ? rows : [rows] });
    return many ? inserted : inserted[0];
  }
  /**
   * A tenant App's member: an account made for this test, given a membership of `tenantId` with `account.roles`
   * (the tenant made active if it is not there), signed in, and working in that tenant's lease. Each call is a new
   * person. Setup, as `seed` is; what the member then reads and runs is asked through the App's own doors.
   */
  async function tenant(tenantId: string, account: TestTenantAccount): Promise<TestTenantClient> {
    if (tenantId === PLATFORM_TENANT_ID) throw new Error('The platform realm is host.platform(account), not a tenant.');
    return member(tenantId, account);
  }
  async function member(tenantId: string, account: TestTenantAccount): Promise<TestTenantClient> {
    if (!account || !Array.isArray(account.roles) || !account.roles.length)
      throw new Error(`A member of "${tenantId}" holds one or more roles: { roles: ['…'] }.`);
    const { appId, ...made } = await ask<{ appId: string; accountId: string; email: string; password: string }>(
      TEST_CONTROL_PATHS.membership,
      {
        tenant: tenantId,
        roles: account.roles,
        ...(account.email ? { email: account.email } : {}),
        ...(account.name ? { name: account.name } : {}),
      },
    );
    return tenantTestClient(url, appId, made, tenantId);
  }
  return {
    seed,
    tenant,
    /** A platform member of a tenant App: as `tenant`, in the platform realm (`auth.tenancy.platform`). */
    platform: (account: TestTenantAccount): Promise<TestTenantClient> => member(PLATFORM_TENANT_ID, account),
    /**
     * A job at times (`every`) run once now, as its next slot would run it: the same principal, grants and command,
     * on the server's clock. Resolves when its first attempt ends, with how it ended.
     */
    runJob: (job: string, options: { timeoutMs?: number } = {}): Promise<TestJobRun> =>
      ask<TestJobRun>(TEST_CONTROL_PATHS.job, { job, timeoutMs: options.timeoutMs ?? 30000 }, options.timeoutMs ?? 30000),
  };
}
/** Starts the actual suite CLI, including shared login and App grants. */
export async function startTestSuite(options: TestSuiteOptions) {
  let file = '';
  const host = await startHost(options, async (port) => {
    file = await options.workspace.write(`suite-${port}.json`, { ...options.configuration, port });
    return ['suite', file];
  });
  return {
    ...host,
    account: (input: { name: string; email: string; password: string }) =>
      runTestMaintenance<string>({ kind: 'account', file, input }, options.environment, options.allowedHosts),
    grant: (input: { appId: string; subjectId: string; roles: readonly string[]; expectedRevision: number }) =>
      runTestMaintenance<void>({ kind: 'grant', file, input }, options.environment, options.allowedHosts),
  };
}
export type TestHost = Awaited<ReturnType<typeof startTestApp>>;
