/**
 * scripts/publish-packages.mjs: a release that stopped halfway is finished by running it again. The registry is a
 * stub `npm` (MISTRI_NPM) that says which packages are live and records what is published.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packagesInOrder, plan, tagFor } from '../scripts/publish-packages.mjs';

const ROOT = join(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string;

test('packages come in dependency order, and a pending/live split keeps it', () => {
  const names = packagesInOrder().map((pkg: { name: string }) => pkg.name);
  assert.deepEqual(names, [
    '@mistriwork/engine',
    '@mistriwork/ui',
    '@mistriwork/kit',
    '@mistriwork/mistri',
    'create-mistri',
    '@mistriwork/cloudflare',
  ]);
  const { live, pending } = plan(packagesInOrder(), (name: string) => name === '@mistriwork/engine' || name === '@mistriwork/ui');
  assert.deepEqual(
    live.map((pkg: { name: string }) => pkg.name),
    ['@mistriwork/engine', '@mistriwork/ui'],
  );
  assert.equal(pending[0].name, '@mistriwork/kit');
});

test('a prerelease goes under next, a full release under latest', () => {
  assert.equal(tagFor('1.0.0-rc.16'), 'next');
  assert.equal(tagFor('1.0.0'), 'latest');
});

function run(live: string[], args: string[], failOn = '') {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-publish-'));
  const log = join(dir, 'published.log');
  const npm = join(dir, 'npm');
  writeFileSync(
    npm,
    `#!/bin/sh
if [ "$1" = view ]; then
  name="\${2%@*}"
  case " $LIVE " in *" $name "*) echo "\${2##*@}"; exit 0;; esac
  echo "npm error code E404" >&2; exit 1
fi
if [ "$1" = publish ]; then
  echo "$*" >> "$LOG"
  case "$*" in *"$FAIL_ON"*) [ -n "$FAIL_ON" ] && exit 7;; esac
  exit 0
fi
exit 9
`,
  );
  chmodSync(npm, 0o755);
  const done = spawnSync(process.execPath, [join(ROOT, 'scripts/publish-packages.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, MISTRI_NPM: npm, LIVE: live.join(' '), LOG: log, FAIL_ON: failOn },
  });
  const published = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  rmSync(dir, { recursive: true, force: true });
  return { ...done, published };
}

test('a half-published release publishes the rest, in order, under the right tag', () => {
  const done = run(['@mistriwork/engine', '@mistriwork/ui'], []);
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(
    done.published.map((line) => line.split(' ')[2]),
    ['packages/kit', 'packages/mistri', 'packages/create-mistri', 'packages/cloudflare'],
  );
  assert.ok(
    done.published.every((line) => line.endsWith(`--access public --tag ${tagFor(version)}`)),
    done.published.join('\n'),
  );
  assert.match(done.stdout, /@mistriwork\/engine@\S+ is already on the registry/);
});

test('a publish that fails stops there, and the next run starts from it', () => {
  const failed = run([], [], 'packages/kit');
  assert.equal(failed.status, 7);
  assert.equal(failed.published.length, 3, 'engine, ui, then kit, which failed');
  assert.match(failed.stderr, /@mistriwork\/kit@\S+ failed; run the release again/);
});

test('--dry-run publishes nothing; --check warns on a partial release and fails only when all of it is live', () => {
  const dry = run(['@mistriwork/engine'], ['--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(dry.published, []);
  assert.match(dry.stdout, /would run: npm publish --workspace packages\/ui /);
  const partial = run(['@mistriwork/engine'], ['--check']);
  assert.equal(partial.status, 0, partial.stderr);
  assert.match(partial.stdout, /::warning::@mistriwork\/engine already published/);
  const all = run(
    ['@mistriwork/engine', '@mistriwork/ui', '@mistriwork/kit', '@mistriwork/mistri', 'create-mistri', '@mistriwork/cloudflare'],
    ['--check'],
  );
  assert.equal(all.status, 1);
  assert.match(all.stderr, /every package is already published/);
  assert.equal(run([], ['--bogus']).status, 2);
});
