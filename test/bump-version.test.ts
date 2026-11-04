/**
 * scripts/bump-version.mjs: the tree agrees on its version (the check a release
 * relies on), and a bump rewrites every place a release touches.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bump, checkVersions, ROOT } from '../scripts/bump-version.mjs';

test('every version in the checkout agrees: manifests, pins, prose, lockfile and changelog', () => {
  assert.deepEqual(checkVersions(), []);
});

test('a bump moves every place at once, renames Unreleased to the release and leaves the tree agreeing', () => {
  const root = mkdtempSync(join(tmpdir(), 'mistri-bump-'));
  try {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const files = [
      'package.json',
      ...manifest.workspaces.map((dir: string) => `${dir}/package.json`),
      'packages/mistri/README.md',
      'site/src/content/docs/docs/status.md',
    ];
    for (const file of files) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      cpSync(join(ROOT, file), join(root, file));
    }
    const version = manifest.version;
    writeFileSync(join(root, 'CHANGELOG.md'), `# Changelog\n\n## Unreleased\n\n- A change.\n\n## ${version}\n\n- Older.\n`);
    assert.deepEqual(checkVersions(root), []);

    assert.throws(() => bump('one', { root, lock: false }), /not a version/);
    bump('9.8.7-rc.1', { root, lock: false });
    assert.deepEqual(checkVersions(root), []);
    const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    assert.match(changelog, /^# Changelog\n\n## 9\.8\.7-rc\.1\n\n- A change\./);
    assert.ok(!changelog.includes('## Unreleased'));
    assert.ok(changelog.includes(`## ${version}\n\n- Older.`));
    const mistri = JSON.parse(readFileSync(join(root, 'packages/mistri/package.json'), 'utf8'));
    assert.equal(mistri.version, '9.8.7-rc.1');
    assert.equal(mistri.dependencies['@mistriwork/kit'], '9.8.7-rc.1');
    assert.equal(
      JSON.parse(readFileSync(join(root, 'packages/create-mistri/package.json'), 'utf8')).dependencies['@mistriwork/mistri'],
      '9.8.7-rc.1',
    );

    // A manifest left behind, and a version line nobody moved, are each said.
    const stale = JSON.parse(readFileSync(join(root, 'packages/ui/package.json'), 'utf8'));
    stale.version = version;
    writeFileSync(join(root, 'packages/ui/package.json'), `${JSON.stringify(stale, null, 2)}\n`);
    assert.match(checkVersions(root).join('\n'), /packages\/ui\/package\.json is .*, the root is 9\.8\.7-rc\.1/);
    // Releasing needs an Unreleased section: a second bump with the same text has none to rename.
    writeFileSync(join(root, 'CHANGELOG.md'), `# Changelog\n\n## 9.8.7-rc.1\n`);
    assert.throws(() => bump('9.8.8', { root, lock: false }), /no "## Unreleased"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
