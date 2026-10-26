// test-package: shared — each binary's defaults (scripts/test-owners.mjs).
/**
 * Two start-up flags by their effect, from the command line: `--open` hands the served address to the machine's
 * opener (a stand-in on the PATH records it), and `check --defaults` adds the step that prints what each column is
 * drawn by when the App says nothing, and each page's layout.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'tablewalk-cli-open-'));
const db = join(root, 'tick.db');
/* The test's environment without what would decide for it: TABLEWALK_OPEN (MISTRI_OPEN for an App) has the last word on opening. */
const env = () => {
  const { TABLEWALK_OPEN: _open, MISTRI_OPEN: _mistriOpen, NODE_TEST_CONTEXT: _context, ...rest } = process.env;
  return { ...rest, XDG_CONFIG_HOME: join(root, 'xdg'), DATABASE_URL: '' };
};
before(() => {
  const seeded = spawnSync(process.execPath, ['examples/databases/tick/seed.mjs', db], { encoding: 'utf8' });
  assert.equal(seeded.status, 0, seeded.stderr);
});
after(() => rmSync(root, { recursive: true, force: true }));

const freePort = async () => {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as { port: number };
  await new Promise((done) => probe.close(done));
  return port;
};

test('--open hands the served address to the machine opener', async () => {
  const bin = join(root, 'bin');
  const opened = join(root, 'opened.txt');
  mkdirSync(bin, { recursive: true });
  // `open` on macOS, `xdg-open` elsewhere: either one writes what it was asked to open.
  for (const name of ['open', 'xdg-open']) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s' "$1" > '${opened}'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'packages/tablewalk/src/server/index.ts',
      db,
      '--no-config',
      '--open',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    { env: { ...env(), PATH: `${bin}${delimiter}${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  child.stdout!.on('data', (chunk) => (log += String(chunk)));
  child.stderr!.on('data', (chunk) => (log += String(chunk)));
  try {
    const deadline = Date.now() + 60_000;
    while (!existsSync(opened) && Date.now() < deadline && child.exitCode === null) await delay(50);
    assert.ok(existsSync(opened), `nothing was opened:\n${log}`);
    assert.match(readFileSync(opened, 'utf8'), new RegExp(`^http://(localhost|127\\.0\\.0\\.1):${port}/?$`));
  } finally {
    child.kill();
  }
});

test('check --defaults prints what each column is drawn by when the App says nothing, and without it the step is not run', () => {
  const check = (...more: string[]) =>
    spawnSync(
      process.execPath,
      ['--import', 'tsx', 'packages/mistri/src/server/index.ts', 'check', '--app', 'examples/apps/tick', '--config', `${db}.json`, ...more],
      {
        encoding: 'utf8',
        env: env(),
      },
    );
  const asked = check('--defaults');
  assert.equal(asked.status, 0, `${asked.stdout}\n${asked.stderr}`);
  assert.match(asked.stdout, /defaults\s+passed\s+1 display rule, 0 form defaults and 0 page layouts inferred/);
  // Tick's one page says its layout; a page that said none would be told the one its sections make, and why.
  assert.match(asked.stdout, /page task\s+layout 'article'\s+the App says its own/);
  assert.match(asked.stdout, /task\.due_on\s+\{"format":"relative"\}\s+a date named like a due date/);
  const plain = check();
  assert.equal(plain.status, 0, `${plain.stdout}\n${plain.stderr}`);
  assert.doesNotMatch(plain.stdout, /^\s+defaults\s/m);
});
