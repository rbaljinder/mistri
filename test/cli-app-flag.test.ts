/** `--app <dir>` names the App on every command that takes one: left out, it is the working directory when that holds
 * an App; and a directory typed where a database or route goes is refused with the --app spelling, never read as the App. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { applyProfile } from '@mistriwork/engine/server/config/profile.js';
import { childEnv } from './appApiCli.js';

/* tsx is found from the checkout, since the scratch folder the command runs in has no node_modules. */
const ENTRY = fileURLToPath(new URL('../packages/mistri/src/server/index.ts', import.meta.url));
const run = (args: string[], cwd: string) => {
  const done = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), ENTRY, ...args], {
    cwd,
    encoding: 'utf8',
    env: childEnv(),
    timeout: 120_000,
  });
  return { code: done.status, out: done.stdout, err: done.stderr };
};

const scratch = (t: { after(fn: () => void): void }) => {
  const root = mkdtempSync(join(tmpdir(), 'mistri-app-flag-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, 'shop');
  mkdirSync(app);
  writeFileSync(join(app, 'app.json'), '{}');
  return { root, app };
};

test('a directory holding an App, typed as a positional, is refused with the --app spelling', (t) => {
  const { root } = scratch(t);
  for (const [args, said] of [
    [['dev', 'shop'], /mistri dev --app shop/],
    [['grade', 'shop'], /mistri grade --app shop/],
    [['test', 'init', 'shop'], /mistri test init --app shop/],
    [['shot', 'shop'], /mistri shot --app shop/],
    [['check', 'shop'], /mistri check --app shop/],
  ] as const) {
    const refused = run([...args], root);
    assert.equal(refused.code, 2, `${args.join(' ')}: ${refused.err}`);
    assert.match(refused.err, said);
  }
});

test('the working directory is the App when it holds one, and a command that needs one names --app when it does not', (t) => {
  const { root, app } = scratch(t);
  const none = run(['shot'], root);
  assert.notEqual(none.code, 0);
  assert.match(none.err, /--app <dir> names the App to shoot/);
  const here = run(['shot'], app);
  assert.doesNotMatch(here.err, /names the App to shoot/, 'the App in the working directory is the one shot');
  const test = run(['test', 'init'], root);
  assert.match(test.err, /--app <dir> names the App/);
});

test('the profile adds the working directory App only where the command takes it', (t) => {
  const { app } = scratch(t);
  const here = process.cwd();
  process.chdir(app);
  t.after(() => process.chdir(here));
  assert.deepEqual(applyProfile(['--port', '0'], { entries: [], cwdApp: true }, {}), ['--port', '0', '--app', '.']);
  /* seed, migrate, messages extract and theme show keep reading no --app as no App. */
  assert.deepEqual(applyProfile(['--rows', '3'], { entries: ['entry'] }, {}), ['--rows', '3']);
  assert.deepEqual(applyProfile(['--app', resolve('.')], { entries: [], cwdApp: true }, {}), ['--app', resolve('.')]);
});
