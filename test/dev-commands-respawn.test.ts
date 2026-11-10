/**
 * `mistri dev` on an App with commands starts the server again when commands.ts is saved. Commands are imported once,
 * in the server's own process, and a reload re-evaluates only the definition: a field report saved a command and kept
 * running the old one, with nothing in the log to say so. The supervising parent (cli/devSupervisor.ts) restarts the
 * child and says why; a save that breaks the file leaves the parent waiting for the next save rather than ending it.
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
const LADLE = join(ROOT, 'examples', 'apps', 'ladle');

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

test(
  'mistri dev starts an App again when its commands are saved, and waits out a save that breaks them',
  { timeout: 240000 },
  async (t) => {
    const work = mkdtempSync(join(ROOT, 'test', '.commands-dev-'));
    const dir = join(work, 'ladle');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    for (const file of ['app.ts', 'commands.ts', 'authority.lock', 'mistri-schema.d.ts', 'mistri-commands.d.ts', 'mistri-components.d.ts'])
      cpSync(join(LADLE, file), join(dir, file));
    cpSync(join(LADLE, 'pages', 'check-in.page.tsx'), join(dir, 'pages', 'check-in.page.tsx'));
    const db = join(work, 'ladle.db');
    const env = {
      PATH: process.env.PATH,
      HOME: work,
      NODE_ENV: 'test',
      MISTRI_OPEN: '0',
      TSX_TSCONFIG_PATH: join(ROOT, 'tsconfig.json'),
    };
    t.after(() => rmSync(work, { recursive: true, force: true }));
    const seeded = spawnSync(process.execPath, [join(ROOT, 'examples/databases/ladle/seed.mjs'), db], {
      encoding: 'utf8',
      env: { ...env, LADLE_APP: dir },
    });
    assert.equal(seeded.status, 0, `the seed failed: ${seeded.stdout}${seeded.stderr}`);
    const port = await freePort();
    const parent = spawn(
      process.execPath,
      ['--import', 'tsx', ENTRY, 'dev', '--app', dir, '--config', `${db}.json`, '--port', String(port)],
      {
        cwd: dir,
        env,
        // Its own process group, so the cleanup reaches the child the supervisor starts: killing only the parent
        // leaves that child holding the pipes, and the runner never exits.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    for (const stream of [parent.stdout, parent.stderr]) stream.on('data', (chunk) => (output += String(chunk)));
    t.after(() => {
      try {
        process.kill(-parent.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
    });
    const until = async (what: string, ready: () => boolean, ms = 90000) => {
      for (let waited = 0; waited < ms; waited += 100) {
        if (ready()) return;
        assert.equal(parent.exitCode, null, `the parent left while waiting for ${what}: ${output}`);
        await delay(100);
      }
      assert.fail(`timed out waiting for ${what}: ${output}`);
    };
    const listening = () => output.split('Listening on').length - 1;
    const commands = join(dir, 'commands.ts');
    const save = (change: (text: string) => string) => writeFileSync(commands, change(readFileSync(commands, 'utf8')));

    await until('the first server to listen', () => listening() === 1);
    save((text) => text.replace('checked in to', 'is checked in to'));
    await until('the server to start again', () => listening() === 2);
    assert.match(output, /commands\.ts changed; starting it again/);

    // A save that breaks the file: the restarted child fails to start, and the parent stays for the next save.
    const broken = output.length;
    save((text) => `${text}\nexport const = ;\n`);
    await until(
      'the broken start to fail',
      () => /commands\.ts changed; starting it again/.test(output.slice(broken)) && /(error|Error)/.test(output.slice(broken)),
    );
    await delay(1500);
    assert.equal(parent.exitCode, null, `the parent ended on a broken save: ${output}`);
    save((text) => text.replace('\nexport const = ;\n', ''));
    await until('the fixed save to listen again', () => listening() === 3);
  },
);
