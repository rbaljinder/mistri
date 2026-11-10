/**
 * Two `mistri dev` sessions on one App folder shared its auth store and its restarts and stopped each other's server
 * (a field report). The session that holds the folder writes `.mistri/dev.pid`; a second refuses, naming the pid, the
 * port and how to stop it; a pid that is gone is taken over silently; a clean stop removes the file.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DevRefusal, prepareDev } from '../packages/mistri/src/server/cli/devMode.js';

const ROOT = resolve('.');
const ENTRY = join(ROOT, 'packages', 'mistri', 'src', 'server', 'index.ts');

function appFolder(t: { after(run: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-dev-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'app.ts'), '');
  return dir;
}
const env = () => ({ PATH: process.env.PATH, NODE_ENV: 'test' }) as NodeJS.ProcessEnv;

test('a second session on a folder a live session holds refuses, naming its pid, its port and how to stop it', (t) => {
  const dir = appFolder(t);
  // A process that is certainly alive and is not this one: a sleeping child, killed by its exact pid.
  const holder = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
  t.after(() => holder.kill('SIGKILL'));
  mkdirSync(join(dir, '.mistri'));
  writeFileSync(join(dir, '.mistri', 'dev.pid'), JSON.stringify({ pid: holder.pid, port: 4321 }));
  assert.throws(
    () => prepareDev(['--app', dir, '--no-config'], env()),
    (error: unknown) =>
      error instanceof DevRefusal &&
      error.message.includes(`pid ${holder.pid}`) &&
      error.message.includes('port 4321') &&
      error.message.includes(`kill ${holder.pid}`),
  );
});

test("a pid that is gone is taken over silently, and the folder is the new session's", (t) => {
  const dir = appFolder(t);
  const gone = spawnSync(process.execPath, ['-e', '0']);
  assert.equal(gone.status, 0);
  // The finished child's pid is the dead one; it is read back from a file written for it.
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  mkdirSync(join(dir, '.mistri'));
  writeFileSync(join(dir, '.mistri', 'dev.pid'), JSON.stringify({ pid: Number(dead), port: 4321 }));
  assert.doesNotThrow(() => prepareDev(['--app', dir, '--no-config'], env()));
  assert.equal(JSON.parse(readFileSync(join(dir, '.mistri', 'dev.pid'), 'utf8')).pid, process.pid);
});

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

test(
  'a running session writes its pid and port, a second refuses at the terminal, and stopping removes the file',
  { timeout: 180000 },
  async (t) => {
    const work = mkdtempSync(join(ROOT, 'test', '.dev-lock-'));
    const dir = join(work, 'tick');
    mkdirSync(dir);
    cpSync(join(ROOT, 'examples', 'apps', 'tick', 'app.ts'), join(dir, 'app.ts'));
    writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
    const db = join(work, 'tick.db');
    const seeded = spawnSync(process.execPath, [join(ROOT, 'examples/databases/tick/seed.mjs'), db], { encoding: 'utf8' });
    assert.equal(seeded.status, 0, `the seed failed: ${seeded.stderr}`);
    writeFileSync(join(dir, 'mistri.json'), JSON.stringify({ connections: [{ name: 'tick', url: db, writable: true }] }));
    const childEnv = {
      PATH: process.env.PATH,
      HOME: work,
      NODE_ENV: 'test',
      MISTRI_OPEN: '0',
      TSX_TSCONFIG_PATH: join(ROOT, 'tsconfig.json'),
    };
    const port = await freePort();
    const args = ['--import', 'tsx', ENTRY, 'dev', '--app', dir, '--config', join(dir, 'mistri.json'), '--port', String(port)];
    // Its own process group, so the whole tree can be killed: an orphaned child keeping its pipes hung a runner for 44 minutes.
    const first = spawn(process.execPath, args, { cwd: dir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    for (const stream of [first.stdout, first.stderr]) stream.on('data', (chunk) => (output += String(chunk)));
    const exited = new Promise<void>((done) => first.once('exit', () => done()));
    t.after(() => {
      try {
        process.kill(-first.pid!, 'SIGKILL');
      } catch {
        /* Already gone. */
      }
      rmSync(work, { recursive: true, force: true });
    });
    const file = join(dir, '.mistri', 'dev.pid');
    const held = () => {
      try {
        return JSON.parse(readFileSync(file, 'utf8')) as { pid: number; port?: number };
      } catch {
        return undefined;
      }
    };
    for (let waited = 0; held()?.port === undefined || !/Listening on/.test(output); waited += 100) {
      assert.ok(waited < 90000 && first.exitCode === null, `the session never listened: ${output}`);
      await delay(100);
    }
    assert.deepEqual(held(), { pid: first.pid, port });

    const second = spawnSync(process.execPath, args, { cwd: dir, env: childEnv, encoding: 'utf8', timeout: 60000 });
    assert.equal(second.status, 2, `${second.stdout}${second.stderr}`);
    assert.match(second.stderr, new RegExp(`pid ${first.pid}, port ${port}`));
    assert.equal((await fetch(`http://127.0.0.1:${port}/readyz`)).ok, true, 'the first session still serves');

    process.kill(first.pid!, 'SIGTERM');
    await exited;
    assert.equal(existsSync(file), false, 'a clean stop removes the file');
  },
);
