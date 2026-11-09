/**
 * `mistri dev` on a tenant App is a thin parent that runs the host as a child and starts it again where a save
 * changed what it serves (cli/devSupervisor.ts; field report #30): the clinic fixture, a page saved while it serves.
 * The new view is served on the same port, the session a person signed in with still works, a page that does not load
 * leaves the parent watching until the next good save, and stopping the parent leaves no host behind.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { tenantTestClient } from '../packages/mistri/src/server/testing/tenant.ts';
import { seedSqlite } from './fixtures/databases/clinic/seed.mjs';

const ROOT = resolve('.');
const ENTRY = join(ROOT, 'packages', 'mistri', 'src', 'server', 'index.ts');

/* The port is chosen up front (the parent hands the same argv to every host it starts), so one is found free per test. */
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/* The hosts a parent runs: its children that are mistri (not a helper the shell or a package manager made for a moment). */
const childrenOf = (pid: number) =>
  spawnSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .stdout.split('\n')
    .flatMap((line) => {
      const [, child, parentPid, command] = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line) ?? [];
      return Number(parentPid) === pid && command.includes(ENTRY) ? [Number(child)] : [];
    });

test(
  'mistri dev starts a tenant host again on a save, keeps its sessions, and survives a page that does not load',
  { timeout: 420000 },
  async (t) => {
    const work = mkdtempSync(join(ROOT, 'test', '.respawn-dev-'));
    const dir = join(work, 'apps', 'clinic');
    cpSync(join(ROOT, 'test', 'fixtures', 'apps', 'clinic'), dir, { recursive: true });
    seedSqlite(join(dir, 'clinic.db'));
    writeFileSync(join(dir, 'mistri.json'), JSON.stringify({ connections: [{ name: 'clinic-db', url: './clinic.db', writable: true }] }));
    const policy = join(dir, 'server', 'tenant-policy.ts');
    const env = {
      PATH: process.env.PATH,
      HOME: work,
      MISTRI_AUDIT_KEY: 'k'.repeat(40),
      MISTRI_TEST_AUTH_LIMITS: 'off',
      NODE_ENV: 'test',
      MISTRI_OPEN: '0',
      TSX_TSCONFIG_PATH: join(ROOT, 'tsconfig.json'),
    };
    const up = spawnSync(
      process.execPath,
      ['--import', 'tsx', ENTRY, 'migrate', 'stores', 'up', '--app', dir, '--policy', policy, '--config', join(dir, 'mistri.json')],
      { encoding: 'utf8', cwd: dir, env },
    );
    assert.equal(up.status, 0, up.stdout + up.stderr);

    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const parent = spawn(
      process.execPath,
      ['--import', 'tsx', ENTRY, 'dev', '--app', dir, '--policy', policy, '--commands', join(dir, 'commands.ts'), '--port', String(port)],
      { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    for (const stream of [parent.stdout, parent.stderr]) stream.on('data', (chunk) => (output += String(chunk)));
    const ended = once(parent, 'exit');
    t.after(async () => {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
      for (const pid of childrenOf(parent.pid!)) if (alive(pid)) process.kill(pid, 'SIGKILL');
      rmSync(work, { recursive: true, force: true });
    });
    const until = async (what: string, ready: () => boolean | Promise<boolean>, ms = 90000) => {
      for (let waited = 0; waited < ms; waited += 100) {
        if (await ready()) return;
        assert.equal(parent.exitCode, null, `the parent left while waiting for ${what}: ${output}`);
        await delay(100);
      }
      assert.fail(`timed out waiting for ${what}: ${output}`);
    };
    const listening = () => output.split('Listening on').length - 1;
    const sayings = async () => (await fetch(`${origin}/`, { redirect: 'follow' })).text().catch(() => '');
    const save = (name: string, change: (text: string) => string) => {
      const file = join(dir, name);
      writeFileSync(file, change(readFileSync(file, 'utf8')));
    };

    await until('the first host to listen and make its accounts', () => listening() === 1 && /Kept in/.test(output));
    const signIns = new Map<string, { email: string; password: string }>();
    for (const [, role, email, password] of output.matchAll(/^ {2}(\w+) +(\S+@example\.test) +(\S+)$/gm))
      signIns.set(role, { email, password });
    const { email, password } = signIns.get('reception')!;
    const signed = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ email, password }),
    });
    const accountId = ((await signed.json()) as { user: { id: string } }).user.id;
    const person = await tenantTestClient(origin, 'clinic', { accountId, email, password }, 'north');
    assert.ok((await person.rows('appointment')).ok);
    const firstHost = childrenOf(parent.pid!);
    assert.equal(firstHost.length, 1, `one host under the parent`);

    // A page saved: the host is started again on the same port, once the old one has let it go.
    assert.doesNotMatch(await sayings(), /Ask for a visit/);
    save('views.ts', (text) => text.replace("'Request a visit'", "'Ask for a visit'"));
    await until('the host to start again', () => listening() === 2);
    assert.match(output, /the App changed; starting it again/);
    assert.equal(alive(firstHost[0]), false, 'the old host is gone');
    assert.equal(childrenOf(parent.pid!).length, 1);

    // The session is the auth store's and the cookie's: it signs in again with nothing but the cookie it held.
    const session = await person.request('/api/auth/get-session');
    assert.equal(session.status, 200);
    assert.equal(((await session.json()) as { user?: { email?: string } } | null)?.user?.email, email);
    assert.ok((await person.enter('north')).ok, 'a new lease is granted under the same session');
    const old = await person.rows('appointment');
    // What was in the process's memory: the lease the first host granted (reported, not redesigned).
    t.diagnostic(`the first host's lease after a restart: ${old.ok ? 'still answers' : `refused (${old.status} ${old.code ?? ''})`}`);

    // A page that does not load: the host says why and goes, and the parent waits for the next save.
    save('views.ts', (text) => `${text}\nexport const broken = ;\n`);
    await until('the refusal', () => /waiting for the next save/.test(output));
    assert.equal(parent.exitCode, null, 'the parent stays');
    assert.equal(childrenOf(parent.pid!).length, 0);
    save('views.ts', (text) => text.replace('\nexport const broken = ;\n', ''));
    await until('the fixed page to serve', () => listening() === 3);
    assert.equal((await person.request('/api/auth/get-session')).status, 200);

    // Stopping the parent stops its host and leaves nothing behind.
    const host = childrenOf(parent.pid!);
    assert.equal(host.length, 1);
    parent.kill('SIGTERM');
    const [code] = await ended;
    assert.equal(code, 0);
    await until('the host to be gone', () => !alive(host[0]), 15000).catch(() => {});
    assert.equal(alive(host[0]), false, 'no orphan host');
  },
);
