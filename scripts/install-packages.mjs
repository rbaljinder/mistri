/**
 * The workspace's packages as `npm install` leaves them in a project's node_modules, for a check that types or runs a
 * project outside this repository: each package's folder under its name, holding its published manifest
 * (scripts/pack-manifest.mjs: no scripts, every export naming dist/), the files a pack carries in, and a dist/.
 *
 * Copied, never linked: a link resolves to the checkout, where one package's import of another (`@mistriwork/engine/…`)
 * answers from the workspace's source rather than from this install. src/ is left out; nothing an install resolves
 * reads it.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARRIED, published } from './pack-manifest.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** What a package folder holds that an install does not take as it is. */
const OWN = new Set(['dist', 'node_modules', 'package.json', 'src']);
/** A sample's local database and an App's own install are the checkout's, never a package's. */
const LOCAL = /(?:^|\/)node_modules(?:\/|$)|\.db(?:-wal|-shm|\.json)?$/;

/**
 * Installs every package under packages/ into `nodeModules`, or those `only` names.
 *
 * @param {string} nodeModules
 * @param {object} [options]
 * @param {Set<string>} [options.only] the packages to install, by name (every one by default)
 * @param {(dir: string) => string} [options.distOf] the folder whose files become a package's dist/ (its own dist/ by default)
 * @param {(file: string) => boolean} [options.filter] which of those files are copied (all by default)
 */
export function installPackages(
  nodeModules,
  { distOf = (dir) => join(ROOT, 'packages', dir, 'dist'), filter = () => true, only = undefined } = {},
) {
  for (const dir of readdirSync(join(ROOT, 'packages'))) {
    const source = join(ROOT, 'packages', dir);
    if (!existsSync(join(source, 'package.json'))) continue;
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    if (only && !only.has(manifest.name)) continue;
    const into = join(nodeModules, manifest.name);
    mkdirSync(into, { recursive: true });
    for (const entry of readdirSync(source)) if (!OWN.has(entry)) cpSync(join(source, entry), join(into, entry), { recursive: true });
    writeFileSync(join(into, 'package.json'), `${JSON.stringify(published(manifest), null, 2)}\n`);
    for (const [path, from] of Object.entries(CARRIED[dir] ?? {})) {
      mkdirSync(dirname(join(into, path)), { recursive: true });
      cpSync(join(ROOT, from), join(into, path), { recursive: true, filter: (file) => !LOCAL.test(file) });
    }
    const dist = distOf(dir);
    if (existsSync(dist)) cpSync(dist, join(into, 'dist'), { recursive: true, filter });
  }
}

/** `name` and every workspace package it depends on, as an install of it brings them: `dependencies` and
    `optionalDependencies`, never a peer, which the project that wants it installs. */
export function installedWith(name) {
  const manifests = new Map(
    readdirSync(join(ROOT, 'packages'))
      .filter((dir) => existsSync(join(ROOT, 'packages', dir, 'package.json')))
      .map((dir) => JSON.parse(readFileSync(join(ROOT, 'packages', dir, 'package.json'), 'utf8')))
      .map((manifest) => [manifest.name, manifest]),
  );
  const found = new Set();
  const visit = (at) => {
    if (found.has(at) || !manifests.has(at)) return;
    found.add(at);
    const { dependencies = {}, optionalDependencies = {} } = manifests.get(at);
    for (const next of Object.keys({ ...dependencies, ...optionalDependencies })) visit(next);
  };
  visit(name);
  return found;
}
