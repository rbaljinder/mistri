// test-package: mistri — create-mistri is the App framework's scaffolder (packages/create-mistri).
/**
 * `npm create mistri <args>` is `mistri new <args>`: the bin finds the mistri it was installed beside, runs its command
 * with `new` in front of the arguments as they were typed, and returns its exit code. Run here against a stand-in
 * mistri laid out the way an install lays it out, so the delegation is held without building the real one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = fileURLToPath(new URL('../packages/create-mistri/', import.meta.url));
const MISTRI = fileURLToPath(new URL('../packages/mistri/package.json', import.meta.url));

/** An install: create-mistri beside a mistri whose command prints what it was run with. */
function install() {
  const root = mkdtempSync(join(tmpdir(), 'tablewalk-create-mistri-'));
  const modules = join(root, 'node_modules');
  mkdirSync(join(modules, 'create-mistri'), { recursive: true });
  mkdirSync(join(modules, '@mistriwork', 'mistri', 'dist'), { recursive: true });
  copyFileSync(join(PACKAGE, 'bin.js'), join(modules, 'create-mistri', 'bin.js'));
  writeFileSync(join(modules, 'create-mistri', 'package.json'), JSON.stringify({ name: 'create-mistri', type: 'module' }));
  writeFileSync(
    join(modules, '@mistriwork', 'mistri', 'package.json'),
    JSON.stringify({ name: '@mistriwork/mistri', type: 'module', bin: { mistri: 'dist/cli.js' } }),
  );
  writeFileSync(
    join(modules, '@mistriwork', 'mistri', 'dist', 'cli.js'),
    "console.log(JSON.stringify(process.argv.slice(2))); process.exit(process.argv.includes('--fail') ? 3 : 0);\n",
  );
  return { root, bin: join(modules, 'create-mistri', 'bin.js') };
}

const run = (bin: string, args: string[]) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });

test('create-mistri runs `mistri new` with the arguments as they were typed', () => {
  const { root, bin } = install();
  try {
    const ran = run(bin, ['my-app', '--brief', 'BRIEF.md']);
    assert.equal(ran.status, 0, ran.stderr);
    assert.deepEqual(JSON.parse(ran.stdout), ['new', 'my-app', '--brief', 'BRIEF.md']);
    assert.deepEqual(JSON.parse(run(bin, []).stdout), ['new']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("create-mistri returns mistri's exit code", () => {
  const { root, bin } = install();
  try {
    assert.equal(run(bin, ['my-app', '--fail']).status, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('create-mistri is versioned with mistri and depends on exactly that version', () => {
  const own = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'));
  const mistri = JSON.parse(readFileSync(MISTRI, 'utf8'));
  assert.equal(own.name, 'create-mistri');
  assert.equal(own.version, mistri.version);
  assert.deepEqual(own.dependencies, { '@mistriwork/mistri': mistri.version });
  assert.deepEqual(own.bin, { 'create-mistri': 'bin.js' });
  assert.equal(own.engines.node, mistri.engines.node);
});
