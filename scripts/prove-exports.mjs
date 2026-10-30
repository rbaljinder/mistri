#!/usr/bin/env node
/**
 * Every published package's `exports`, proven against what it ships: each package is packed, the tarballs are
 * installed into a fresh project as a person installs them, and every subpath each installed manifest names is
 * resolved to a file that is there and imported.
 *
 * The kit once named its client modules at dist paths a published kit never carried (`@mistriwork/kit/client/…`), and
 * the browser package its `tablewalk/*` twins at files outside its `files` list: both installed, and both failed
 * at the first import. A pattern (`./*`) names no file of its own, so it is listed, not proven. An import that
 * fails only for a peer the package declares (React for a component module, the Containers class for the Cloudflare
 * glue) is said as such: the project that uses that subpath installs the peer. Each JavaScript subpath must also be typed by a declaration file the package
 * ships (scripts/export-types.mjs).
 *
 *   node scripts/prove-exports.mjs                 pack every workspace package (run `npm run build` first)
 *   node scripts/prove-exports.mjs <tarball>…      prove those tarballs instead
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { targetsOf, untypedExports } from './export-types.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'mistri-prove-exports-'));
const environment = { ...process.env };
for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'TSX_TSCONFIG_PATH']) delete environment[key];

try {
  let tarballs = process.argv.slice(2).map((tarball) => resolve(tarball));
  if (!tarballs.length) {
    const packed = join(scratch, 'packed');
    execFileSync('mkdir', ['-p', packed]);
    execFileSync('npm', ['pack', '--workspaces', '--pack-destination', packed, '--silent'], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    tarballs = readdirSync(packed).map((name) => join(packed, name));
  }
  const project = join(scratch, 'project');
  execFileSync('mkdir', ['-p', project]);
  writeFileSync(join(project, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  execFileSync(
    'npm',
    ['install', '--ignore-scripts', '--omit=optional', '--omit=peer', '--no-audit', '--no-fund', '--silent', ...tarballs],
    { cwd: project, env: environment, stdio: ['ignore', 'ignore', 'inherit'] },
  );

  const problems = [];
  let proven = 0;
  const patterns = [];
  const peerOnly = [];
  for (const tarball of tarballs) {
    /* The name is the tarball's manifest's, read back from the install. */
    const name = JSON.parse(execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' })).name;
    const dir = join(project, 'node_modules', name);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    /* Any peer the package declares: the install omits peers, and the project that uses the subpath installs them. */
    const peers = new Set([...Object.keys(manifest.peerDependencies ?? {}), ...Object.keys(manifest.peerDependenciesMeta ?? {})]);
    for (const missing of untypedExports(dir, manifest.exports)) problems.push(`${name} export ${missing}: no declarations in the package`);
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      if (subpath.includes('*')) {
        patterns.push(`${name}/${subpath.slice(2)}`);
        continue;
      }
      const specifier = subpath === '.' ? name : `${name}/${subpath.slice(2)}`;
      for (const [condition, path] of targetsOf(target)) {
        if (!existsSync(join(dir, path))) problems.push(`${specifier} (${condition}) names ${path}, which the package does not ship`);
      }
      const runtime = targetsOf(target).find(([condition]) => !condition.split('.').includes('types'));
      if (!runtime || !/\.(m?js)$/.test(runtime[1])) {
        proven += 1;
        continue;
      }
      const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(specifier)});`], {
        cwd: project,
        env: environment,
        encoding: 'utf8',
        timeout: 60_000,
      });
      if (imported.status === 0) {
        proven += 1;
        continue;
      }
      const missing = /Cannot find (?:package|module) '([^']+)'/.exec(imported.stderr)?.[1];
      const missingPackage =
        missing && !missing.startsWith('.') && !missing.startsWith('/')
          ? missing
              .split('/')
              .slice(0, missing.startsWith('@') ? 2 : 1)
              .join('/')
          : undefined;
      if (missingPackage && (peers.has(missingPackage) || isOptionalPeerOfInstalled(project, missingPackage))) {
        peerOnly.push(`${specifier} (needs the peer ${missingPackage})`);
        proven += 1;
      } else problems.push(`${specifier} does not import: ${imported.stderr.trim().split('\n').slice(0, 3).join(' ')}`);
    }
  }
  console.log(`prove-exports: ${proven} subpaths of ${tarballs.length} packages resolve to files they ship and import.`);
  for (const line of peerOnly) console.log(`  ${line}`);
  if (patterns.length) console.log(`  patterns, listed not proven: ${patterns.join(', ')}`);
  if (problems.length) {
    console.error(`prove-exports:\n${problems.map((problem) => `  ${problem}`).join('\n')}`);
    process.exitCode = 1;
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

/** Whether `name` is an optional peer of some installed workspace package: a subpath reached through another one. */
function isOptionalPeerOfInstalled(project, name) {
  for (const scope of ['', '@mistriwork']) {
    const base = join(project, 'node_modules', scope);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const file = join(base, entry, 'package.json');
      if (!existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      if (!['tablewalk', '@mistriwork/mistri'].includes(manifest.name) && !manifest.name?.startsWith('@mistriwork/')) continue;
      if (manifest.peerDependenciesMeta?.[name]?.optional) return true;
    }
  }
  return false;
}
