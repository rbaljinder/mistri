#!/usr/bin/env node
/**
 * One command for everything a release bump touches, and the check that they agree.
 *
 *   node scripts/bump-version.mjs 1.0.0-rc.16     rewrite the version everywhere
 *   node scripts/bump-version.mjs --check         verify nothing disagrees (test/bump-version.test.ts runs it)
 *
 * What a bump touches (the record is the rc.13 and rc.14 bump commits): the root and every workspace package's
 * `version`, each package's pin on the others (they are exact: the release workflow refuses a mismatch), the version
 * lines in packages/mistri/README.md and the site's status page, package-lock.json (by npm, never by hand), and the
 * changelog, where `## Unreleased` becomes the release's heading (a release's tree has no `## Unreleased` above it, as rc.15's has none).
 *
 * The tag is the maintainer's to push: `npm version patch` is not how a release starts here, because it bumps only
 * the root and leaves the six packages behind.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies'];
/** The sentences that name the version, each with the one capture that is it. */
const PROSE = [
  { file: 'packages/mistri/README.md', pattern: /These App features ship in mistri (\S+?);/ },
  { file: 'site/src/content/docs/docs/status.md', pattern: /^description: The (\S+) scope/m },
  { file: 'site/src/content/docs/docs/status.md', pattern: /This site describes \*\*mistri (\S+?)\*\*/ },
];

const readJSON = (root, file) => JSON.parse(readFileSync(join(root, file), 'utf8'));
const writeJSON = (root, file, value) => writeFileSync(join(root, file), `${JSON.stringify(value, null, 2)}\n`);

/** The root manifest and each workspace package's, by path. */
function manifests(root) {
  const files = ['package.json', ...readJSON(root, 'package.json').workspaces.map((dir) => `${dir}/package.json`)];
  return files.map((file) => [file, readJSON(root, file)]);
}

/** Every way the tree disagrees with the root's version; empty when it agrees. */
export function checkVersions(root = ROOT) {
  const found = [];
  const all = manifests(root);
  const version = all[0][1].version;
  const names = new Set(all.slice(1).map(([, manifest]) => manifest.name));
  for (const [file, manifest] of all) {
    if (manifest.version !== version) found.push(`${file} is ${manifest.version}, the root is ${version}`);
    for (const field of DEPENDENCY_FIELDS)
      for (const [name, range] of Object.entries(manifest[field] ?? {}))
        if (names.has(name) && range !== version) found.push(`${file} ${field} pins ${name} at ${range}, not ${version}`);
  }
  for (const { file, pattern } of PROSE) {
    const said = pattern.exec(readFileSync(join(root, file), 'utf8'))?.[1];
    if (said !== version) found.push(`${file} says ${said ?? '(no version line)'}, the root is ${version}`);
  }
  if (existsSync(join(root, 'package-lock.json'))) {
    const lock = readJSON(root, 'package-lock.json');
    if (lock.version !== version) found.push(`package-lock.json is ${lock.version}, the root is ${version}`);
    for (const [file, manifest] of all) {
      const entry = lock.packages?.[file === 'package.json' ? '' : file.replace(/\/package\.json$/, '')];
      if (entry?.version !== version) found.push(`package-lock.json has ${manifest.name} at ${entry?.version}, not ${version}`);
    }
  }
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  if (!changelog.split('\n').includes(`## ${version}`)) found.push(`CHANGELOG.md has no "## ${version}" section`);
  return found;
}

/** Rewrite the tree to `version`; `lock` runs npm to bring package-lock.json along. */
export function bump(version, { root = ROOT, lock = true } = {}) {
  if (!VERSION.test(version)) throw new Error(`"${version}" is not a version (1.2.3 or 1.2.3-rc.4)`);
  const changelogFile = join(root, 'CHANGELOG.md');
  const changelog = readFileSync(changelogFile, 'utf8');
  if (!changelog.split('\n').includes('## Unreleased')) throw new Error('CHANGELOG.md has no "## Unreleased" section to release');
  if (changelog.split('\n').includes(`## ${version}`)) throw new Error(`CHANGELOG.md already has a "## ${version}" section`);

  const all = manifests(root);
  const names = new Set(all.slice(1).map(([, manifest]) => manifest.name));
  for (const [file, manifest] of all) {
    manifest.version = version;
    for (const field of DEPENDENCY_FIELDS)
      for (const name of Object.keys(manifest[field] ?? {})) if (names.has(name)) manifest[field][name] = version;
    writeJSON(root, file, manifest);
  }
  for (const { file, pattern } of PROSE) {
    const path = join(root, file);
    const text = readFileSync(path, 'utf8');
    const said = pattern.exec(text);
    if (!said) throw new Error(`${file} has no version line matching ${pattern}`);
    writeFileSync(path, text.replace(said[0], said[0].replace(said[1], version)));
  }
  writeFileSync(changelogFile, changelog.replace('## Unreleased\n', `## ${version}\n`));
  if (lock) execFileSync('npm', ['install', '--package-lock-only', '--silent'], { cwd: root, stdio: 'inherit' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [arg] = process.argv.slice(2);
  if (arg === '--check') {
    const found = checkVersions();
    for (const line of found) console.error(line);
    if (found.length) process.exit(1);
    console.log(`every version agrees at ${readJSON(ROOT, 'package.json').version}`);
  } else if (arg && !arg.startsWith('-')) {
    try {
      bump(arg);
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
    const found = checkVersions();
    for (const line of found) console.error(line);
    if (found.length) process.exit(1);
    console.log(`bumped to ${arg}: review the diff, then commit`);
  } else {
    console.error('Usage: node scripts/bump-version.mjs <version> | --check');
    process.exit(2);
  }
}
