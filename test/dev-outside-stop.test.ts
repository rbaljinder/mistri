/**
 * A `mistri dev` host stopped from outside (by the machine, under load) waited for the next save to start again, and a
 * browser walk against it saw only refused connections (a field report). The supervising parent (cli/devSupervisor.ts)
 * starts it again at once, saying so; a host stopped again straight after that start waits for a save, so nothing loops.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { superviseDev } from '../packages/mistri/src/server/cli/devSupervisor.js';

test(
  'a host stopped from outside is started again once, with a line; stopped again at once, it waits for a save',
  { timeout: 30000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'mistri-dev-stop-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const pids = join(dir, 'pids');
    const done = join(dir, 'done');
    // Each start writes its pid, and leaves with 0 (the person's own stop) once `done` exists; else it serves on.
    const host = join(dir, 'host.mjs');
    writeFileSync(
      host,
      `import { appendFileSync, existsSync } from 'node:fs';\n` +
        `if (existsSync(${JSON.stringify(done)})) process.exit(0);\n` +
        `appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n');\n` +
        `setInterval(() => {}, 1000);\n`,
    );
    const started = () => (existsSync(pids) ? readFileSync(pids, 'utf8').trim().split('\n').map(Number) : []);
    const until = async (count: number) => {
      for (let waited = 0; started().length < count; waited += 25) {
        assert.ok(waited < 10000, `start ${count} never came`);
        await delay(25);
      }
      return started()[count - 1];
    };
    const said: string[] = [];
    t.mock.method(console, 'error', (line: string) => said.push(line));
    let save: (() => void) | undefined;
    const supervised = superviseDev({
      argv: [],
      env: { PATH: process.env.PATH },
      entry: [host],
      watch: (changed) => {
        save = changed;
        return () => (save = undefined);
      },
    });

    process.kill(await until(1), 'SIGKILL');
    // Started again with no save.
    await until(2);
    assert.equal(save, undefined);
    assert.ok(
      said.some((line) => /stopped from outside \(SIGKILL\); starting it again/.test(line)),
      said.join('\n'),
    );

    process.kill(started()[1], 'SIGKILL');
    for (let waited = 0; !save; waited += 25) {
      assert.ok(waited < 10000, 'the second stop never waited for a save');
      await delay(25);
    }
    assert.equal(started().length, 2);
    assert.ok(
      said.some((line) => /waiting for the next save/.test(line)),
      said.join('\n'),
    );

    writeFileSync(done, '');
    (save as unknown as () => void)();
    assert.equal(await supervised, 0);
  },
);
