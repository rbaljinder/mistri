/**
 * `mistri dev` on an ordinary App is a thin parent that runs the server as a child (cli/devSupervisor.ts), so a save
 * that changes what the App grants — which a reload cannot wear, and used to leave every request answering 503 until a
 * person restarted by hand (a field report) — starts the server again on the same port. A save that changes nothing
 * of the kind is still worn in place, with no restart.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = resolve('.');
const ENTRY = join(ROOT, 'packages', 'mistri', 'src', 'server', 'index.ts');

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

test(
  'mistri dev starts an App again when a save changes what it grants, and wears any other save in place',
  { timeout: 240000 },
  async (t) => {
    const work = mkdtempSync(join(ROOT, 'test', '.authority-dev-'));
    const dir = join(work, 'tick');
    mkdirSync(dir);
    cpSync(join(ROOT, 'examples', 'apps', 'tick', 'app.ts'), join(dir, 'app.ts'));
    writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
    const db = join(work, 'tick.db');
    const seeded = spawnSync(process.execPath, [join(ROOT, 'examples/databases/tick/seed.mjs'), db], { encoding: 'utf8' });
    assert.equal(seeded.status, 0, `the seed failed: ${seeded.stderr}`);
    writeFileSync(join(dir, 'mistri.json'), JSON.stringify({ connections: [{ name: 'tick', url: db, writable: true }] }));
    const env = {
      PATH: process.env.PATH,
      HOME: work,
      NODE_ENV: 'test',
      MISTRI_OPEN: '0',
      TSX_TSCONFIG_PATH: join(ROOT, 'tsconfig.json'),
    };
    const port = await freePort();
    const parent = spawn(
      process.execPath,
      ['--import', 'tsx', ENTRY, 'dev', '--app', dir, '--config', join(dir, 'mistri.json'), '--port', String(port)],
      { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    for (const stream of [parent.stdout, parent.stderr]) stream.on('data', (chunk) => (output += String(chunk)));
    t.after(() => {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
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
    const origin = `http://127.0.0.1:${port}`;
    const status = async () => (await fetch(`${origin}/`).catch(() => undefined))?.status;
    const save = (change: (text: string) => string) =>
      writeFileSync(join(dir, 'app.ts'), change(readFileSync(join(dir, 'app.ts'), 'utf8')));

    await until('the first server to listen', () => listening() === 1);
    // A caption is worn in place: no restart.
    save((text) => text.replace("listView('Tasks'", "listView('My tasks'"));
    await until('the reload', () => /reloaded from/.test(output));
    assert.equal(listening(), 1, 'a caption does not restart the server');
    // What the App grants changed: the server starts again where it used to say 503 until restarted by hand.
    save((text) => text.replace("access: 'write',", '').replace('delete: true,', ''));
    await until('the server to start again', () => listening() === 2);
    assert.match(output, /authority changed; starting it again/);
    await until('the new server to answer', async () => (await status()) === 200, 30000);
  },
);
