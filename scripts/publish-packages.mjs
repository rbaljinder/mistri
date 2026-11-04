#!/usr/bin/env node
/**
 * Publish the workspace's packages one at a time, in dependency order, skipping any `name@version` the registry
 * already has, so a release that stopped halfway is finished by running it again.
 *
 *   node scripts/publish-packages.mjs --check      the preflight: report what is live; fail only if all of it is
 *   node scripts/publish-packages.mjs --dry-run    print what would be published, publish nothing
 *   node scripts/publish-packages.mjs              publish what is not yet live (release.yml's npm job)
 *
 * `npm publish --workspaces` is not atomic: it can publish engine and ui and then fail on kit, and the tag's next run
 * would refuse the whole release because engine@version "already exists". A version is permanent, so the right
 * answer to an interrupted release is to publish the rest, not to bump past a half-published one.
 *
 * Provenance is not flagged here: the job authenticates by OIDC trusted publishing, which attaches it
 * (release.yml). A prerelease goes out under `next`, never `latest`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (root, file) => JSON.parse(readFileSync(join(root, file), 'utf8'));

/** The packages in an order every package follows the ones it depends on at its own version. */
export function packagesInOrder(root = ROOT) {
  const listed = read(root, 'package.json').workspaces.map((dir) => ({ dir, ...read(root, `${dir}/package.json`) }));
  const names = new Set(listed.map((pkg) => pkg.name));
  const placed = [];
  const visit = (pkg, trail = []) => {
    if (placed.includes(pkg)) return;
    if (trail.includes(pkg)) throw new Error(`packages depend on each other in a circle at ${pkg.name}`);
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }))
      if (names.has(name))
        visit(
          listed.find((other) => other.name === name),
          [...trail, pkg],
        );
    placed.push(pkg);
  };
  for (const pkg of listed) visit(pkg);
  return placed.map(({ dir, name, version }) => ({ dir, name, version }));
}

/** Whether the registry has `name@version`: true, false, or an error for anything that is not a plain "no such version". */
export function onRegistry(name, version, npm = 'npm') {
  const answer = spawnSync(npm, ['view', `${name}@${version}`, 'version'], { encoding: 'utf8' });
  if (answer.error) throw answer.error;
  if (answer.status === 0) return answer.stdout.trim() === version;
  if (/E404|404 Not Found/.test(`${answer.stderr}${answer.stdout}`)) return false;
  throw new Error(`npm view ${name}@${version} failed (${answer.status}): ${answer.stderr.trim().split('\n')[0]}`);
}

/** What is live and what is left, in publish order. `exists` is the registry's answer, and the one a test replaces. */
export function plan(packages, exists) {
  const live = [];
  const pending = [];
  for (const pkg of packages) (exists(pkg.name, pkg.version) ? live : pending).push(pkg);
  return { live, pending };
}

export const tagFor = (version) => (version.includes('-') ? 'next' : 'latest');

function main(args) {
  const known = new Set(['--check', '--dry-run']);
  const unknown = args.filter((arg) => !known.has(arg));
  if (unknown.length || (args.includes('--check') && args.includes('--dry-run'))) {
    console.error('Usage: node scripts/publish-packages.mjs [--check | --dry-run]');
    return 2;
  }
  const npm = process.env.MISTRI_NPM || 'npm';
  const packages = packagesInOrder();
  const { live, pending } = plan(packages, (name, version) => onRegistry(name, version, npm));
  for (const pkg of live) console.log(`${pkg.name}@${pkg.version} is already on the registry`);
  if (!pending.length) {
    console.error(`::error::every package is already published at ${packages[0].version} — a version is permanent, so bump it`);
    return 1;
  }
  if (args.includes('--check')) {
    for (const pkg of pending) console.log(`${pkg.name}@${pkg.version} is unpublished`);
    if (live.length)
      console.log(
        `::warning::${live.map((pkg) => pkg.name).join(', ')} already published: a release that stopped halfway is being finished, ` +
          `so only ${pending.map((pkg) => pkg.name).join(', ')} will go out`,
      );
    return 0;
  }
  const tag = tagFor(packages[0].version);
  for (const pkg of pending) {
    const command = ['publish', '--workspace', pkg.dir, '--access', 'public', '--tag', tag];
    if (args.includes('--dry-run')) {
      console.log(`would run: npm ${command.join(' ')}   (${pkg.name}@${pkg.version})`);
      continue;
    }
    console.log(`publishing ${pkg.name}@${pkg.version} under ${tag}`);
    const done = spawnSync(npm, command, { stdio: 'inherit' });
    if (done.status !== 0) {
      // Stop here: what follows depends on this one. Running the job again publishes from this package on.
      console.error(`::error::npm publish of ${pkg.name}@${pkg.version} failed; run the release again to publish from here`);
      return done.status ?? 1;
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
