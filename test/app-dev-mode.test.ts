/**
 * `mistri dev`: an App with sign-in served with nothing set up first. Its secret and accounts live in the App's
 * `.mistri/`, so a restart keeps sessions and passwords; each declared role gets a printed sign-in; a busy port
 * is one line naming it and --port; and it will not run under NODE_ENV=production.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

const ROOT = resolve('.');
/* An App's starts are mistri's (test/support/bins.ts). */
const ENTRY = join(ROOT, 'packages', 'mistri', 'src', 'server', 'index.ts');
/* Inside the checkout, so Payday's `@mistriwork/mistri/commands` resolves to src/ as the fixture's does, and as deep as
   test/fixtures/apps/payday, so its tsconfig's relative paths still reach src/. */
const work = mkdtempSync(join(ROOT, 'test', '.dev-mode-'));
after(() => rmSync(work, { recursive: true, force: true }));

const app = join(work, 'apps', 'payday');
cpSync(join(ROOT, 'test', 'fixtures', 'apps', 'payday'), app, { recursive: true });
const { seed } = (await import(join(ROOT, 'test', 'fixtures', 'databases', 'payday', 'seed.mjs'))) as {
  seed(file: string): Promise<unknown>;
};
await seed(join(app, 'payday.db'));
cpSync(join(app, 'payday.db.json'), join(app, 'mistri.json'));

/* Without the session secret or admin of whoever runs the suite: dev mode is to supply them. */
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^(BETTER_AUTH_SECRET|MISTRI_AUTH_ADMIN_|NODE_ENV$|NODE_TEST_CONTEXT$)/.test(name)),
);

async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  server.close();
  await once(server, 'close');
  return port;
}

/** A dev start, read until it has printed every role's sign-in. */
async function start(
  port: number,
): Promise<{ child: ChildProcess; out: string; signIns: Map<string, { email: string; password: string }> }> {
  const child = spawn(process.execPath, ['--import', 'tsx', ENTRY, 'dev', app, '--port', String(port)], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout!.on('data', (chunk) => (out += chunk));
  child.stderr!.on('data', (chunk) => (out += chunk));
  const deadline = Date.now() + 60_000;
  while (!/Kept in /.test(out)) {
    if (child.exitCode !== null) throw new Error(`dev exited ${child.exitCode}:\n${out}`);
    if (Date.now() > deadline) throw new Error(`dev printed no sign-ins:\n${out}`);
    await new Promise((done) => setTimeout(done, 100));
  }
  const signIns = new Map<string, { email: string; password: string }>();
  for (const [, role, email, password] of out.matchAll(/^ {2}(\S+) +(\S+@example\.test) {2}(\S+)$/gm))
    signIns.set(role, { email, password });
  return { child, out, signIns };
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
}

async function signIn(port: number, account: { email: string; password: string }): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify(account),
  });
  assert.equal(response.status, 200, await response.text());
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}

const whoami = async (port: number, cookie: string) =>
  (await (await fetch(`http://127.0.0.1:${port}/api/whoami`, { headers: { cookie } })).json()) as { signedIn: boolean };

test('dev serves the App with a kept secret and a sign-in per role', async (t) => {
  const port = await freePort();
  const first = await start(port);
  t.after(() => stop(first.child));
  assert.deepEqual([...first.signIns.keys()].sort(), ['admin', 'payroll_manager']);
  assert.match(first.out, /throwaway accounts, local and for development only/);
  assert.match(first.out, /dev observer at/);
  assert.ok(existsSync(join(app, '.mistri', 'config', 'mistri', 'auth', 'payday.db')), 'the auth store is in .mistri/');
  assert.equal(readFileSync(join(app, '.mistri', '.gitignore'), 'utf8'), '*\n');
  const kept = JSON.parse(readFileSync(join(app, '.mistri', 'dev.json'), 'utf8')) as { secret: string };
  assert.ok(kept.secret.length >= 32);

  const cookie = await signIn(port, first.signIns.get('payroll_manager')!);
  assert.equal((await whoami(port, cookie)).signedIn, true);
  await stop(first.child);

  /* Again: the same secret, so the session from before still stands, and the same passwords. */
  const second = await start(port);
  t.after(() => stop(second.child));
  assert.deepEqual(second.signIns, first.signIns);
  assert.equal((JSON.parse(readFileSync(join(app, '.mistri', 'dev.json'), 'utf8')) as { secret: string }).secret, kept.secret);
  assert.equal((await whoami(port, cookie)).signedIn, true);
  await signIn(port, second.signIns.get('admin')!);
  await stop(second.child);
});

test('a busy port is one line naming it and --port', async (t) => {
  const busy: Server = createServer().listen(0, '127.0.0.1');
  await once(busy, 'listening');
  t.after(() => busy.close());
  const { port } = busy.address() as { port: number };
  const run = spawnSync(process.execPath, ['--import', 'tsx', ENTRY, 'dev', app, '--port', String(port)], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, new RegExp(`port ${port} is already in use.*--port <n>`));
  assert.doesNotMatch(run.stderr, /^\s+at /m);
});

test('dev refuses NODE_ENV=production and a directory with no App', () => {
  const production = spawnSync(process.execPath, ['--import', 'tsx', ENTRY, 'dev', app], {
    env: { ...env, NODE_ENV: 'production' },
    encoding: 'utf8',
  });
  assert.equal(production.status, 2);
  assert.match(production.stderr, /NODE_ENV is production/);
  const none = spawnSync(process.execPath, ['--import', 'tsx', ENTRY, 'dev', work], { env, encoding: 'utf8' });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /has no app\.ts/);
});

test('there is no serve command: `tablewalk serve`, with --app or bare, says how a start serves', () => {
  for (const args of [['serve', '--app', app], ['serve']]) {
    // In the scratch folder, where no file is called serve: a bare `serve` opened one, and said it could not.
    const run = spawnSync(process.execPath, ['--import', 'tsx', ENTRY, ...args], { env, encoding: 'utf8', cwd: work });
    assert.equal(run.status, 2, `${args.join(' ')}: ${run.stderr}`);
    assert.match(run.stderr, /there is no serve command: a start serves\. Run mistri --app <dir>/);
    assert.doesNotMatch(run.stderr, /unable to open database file/);
  }
});
