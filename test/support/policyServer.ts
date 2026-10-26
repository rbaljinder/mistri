/**
 * A real `mistri --app` server over a small row-policy App, for the cases
 * a field report found only where the whole runtime meets: sign-up, the
 * policy module, the scoped catalog, the refusal a person and the operator
 * each read. SQLite always; PostgreSQL in a database the case owns
 * (`uuidPostgresDatabase`) when `TABLEWALK_TEST_PG` names a server.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { migrateSqliteCommandJournal } from '../../packages/mistri/src/adapters/commands/commandJournal.js';
import { provisionSqliteInbox } from '../../packages/mistri/src/adapters/inbox/sqliteInbox.js';
import { provisionPostgresLiveChange } from '../../packages/mistri/src/adapters/live/postgresLiveChange.js';
import { provisionSqliteLiveChange } from '../../packages/mistri/src/adapters/live/sqliteLiveChange.js';
import { scratch } from './scratch.js';
import { pgClient, uuidPostgresDatabase } from './tenantDialects.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface PolicyServerOptions {
  /** The App's manifest (app.json); `sources` names the one connection, `ops`. */
  app: Record<string, unknown>;
  /** Write the manifest as a module (app.mjs, one key a line), as an author does: what a refusal is placed in. */
  module?: boolean;
  /** The policy module's source (policy.mjs), or none for an App without one. */
  policy?: string;
  /** The business schema and rows, in the engine's own SQL. */
  sql: string;
  /** PostgreSQL instead of SQLite. */
  postgres?: boolean;
  env?: Record<string, string>;
  /** Provision the notification store (SQLite), for an App whose resources notify. */
  inbox?: boolean;
  /** The commands module's source (commands.mjs, `--commands`); its journal is provisioned (SQLite). */
  commands?: string;
  /** The start is expected to be refused: wait for the process to stop. */
  refused?: boolean;
  /** Provision live sync's change store, as `migrate stores up` would. */
  live?: boolean;
  /** Serve this database instead of creating one (`sql` is then not run): a second process on the first's. */
  url?: string;
  /** More flags for the server. */
  args?: readonly string[];
}

export interface Reply {
  status: number;
  body: any;
  cookie: string;
}

export async function policyServer(t: TestContext, options: PolicyServerOptions) {
  const { directory, stopping } = scratch(t, 'tablewalk-policy-server-');
  const appDir = join(directory, 'app');
  mkdirSync(appDir);
  let url: string;
  if (options.url !== undefined) url = options.url;
  else if (options.postgres) {
    const owned = await uuidPostgresDatabase('tw_policy_server');
    stopping(() => owned.drop());
    const client = await pgClient(owned.url);
    try {
      await client.query(options.sql);
    } finally {
      await client.end();
    }
    url = owned.url;
    if (options.live) await provisionPostgresLiveChange(url);
  } else {
    url = join(directory, 'business.db');
    const db = new DatabaseSync(url);
    db.exec(options.sql);
    db.close();
    if (options.inbox) provisionSqliteInbox(url);
    if (options.commands !== undefined) migrateSqliteCommandJournal(url);
    if (options.live) provisionSqliteLiveChange(url);
  }
  const config = join(directory, 'mistri.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'ops', url, writable: true }] }));
  const manifest = { sources: { main: { connection: 'ops' } }, ...options.app };
  if (options.module) writeFileSync(join(appDir, 'app.mjs'), `export default ${JSON.stringify(manifest, null, 2)};\n`);
  else writeFileSync(join(appDir, 'app.json'), JSON.stringify(manifest));
  const policy = join(directory, 'policy.mjs');
  if (options.policy !== undefined) writeFileSync(policy, options.policy);
  const commands = join(directory, 'commands.mjs');
  if (options.commands !== undefined) writeFileSync(commands, options.commands);
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done, reject) => reservation.close((error) => (error ? reject(error) : done())));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      join(root, 'packages/mistri/src/server/index.ts'),
      '--config',
      config,
      '--app',
      appDir,
      ...(options.policy !== undefined ? ['--policy', policy] : []),
      ...(options.commands !== undefined ? ['--commands', commands] : []),
      '--port',
      String(port),
      ...(options.args ?? []),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        DATABASE_URL: '',
        MISTRI_OPEN: '0',
        MISTRI_PUBLIC_URL: origin,
        BETTER_AUTH_SECRET: 'policy-server-fixture-secret-at-least-32-characters',
        MISTRI_AUTH_ADMIN_EMAIL: 'owner@example.org',
        MISTRI_AUTH_ADMIN_PASSWORD: 'owner-fixture-password-1',
        MISTRI_DIAGNOSTICS: '',
        XDG_CONFIG_HOME: join(directory, 'xdg'),
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  stopping(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(force);
  });
  const deadline = Date.now() + 20_000;
  if (options.refused) {
    await exited;
    return { refused: output } as never;
  }
  while (!output.includes('Listening on') && Date.now() < deadline) {
    assert.equal(child.exitCode, null, output);
    await delay(40);
  }
  assert.match(output, /Listening on/, output);

  const call = async (path: string, body?: unknown, cookie?: string): Promise<Reply> => {
    const response = await fetch(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return {
      status: response.status,
      body: parsed,
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; '),
    };
  };
  const appId = String(options.app.id);
  return {
    origin,
    url,
    call,
    /** An App route, as the App's own client asks it. */
    api: (route: string, body?: unknown, cookie?: string) =>
      call(`/api/${route}${route.includes('?') ? '&' : '?'}app=${encodeURIComponent(appId)}`, body, cookie),
    /** Anyone's own account, under open sign-up. */
    signUp: async (name: string) => {
      const reply = await call('/api/auth/sign-up/email', { name, email: `${name}@example.org`, password: 'fixture-password-123' });
      assert.equal(reply.status, 200, JSON.stringify(reply.body) + output);
      return reply.cookie;
    },
    signIn: async (email: string, password: string) => {
      const reply = await call('/api/auth/sign-in/email', { email, password });
      assert.equal(reply.status, 200, JSON.stringify(reply.body) + output);
      return reply.cookie;
    },
    owner: () =>
      call('/api/auth/sign-in/email', { email: 'owner@example.org', password: 'owner-fixture-password-1' }).then((r) => r.cookie),
    /** What the server has said on its terminal so far. */
    log: () => output,
  };
}

export const LIVE_PG = process.env.TABLEWALK_TEST_PG;

/** A source module's URL, for a commands or policy module written as text that imports tablewalk's own. */
export const sourceUrl = (file: string) => JSON.stringify(pathToFileURL(join(root, file)).href);

/** A start the server refuses: what it said on its terminal before it stopped. */
export async function refusedStart(t: TestContext, options: PolicyServerOptions): Promise<string> {
  return ((await policyServer(t, { ...options, refused: true })) as unknown as { refused: string }).refused;
}
