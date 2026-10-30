#!/usr/bin/env node
/**
 * The package.json a person who installed a package reads: the checkout's, without what only a checkout can run, and
 * with its `exports` answering from dist/.
 *
 * npm ships package.json as it is on disk when it packs, and each one under packages/ is the checkout's: its `build`
 * script runs the workspace's build, and its `exports` answer from src/ unless Node is started with
 * `--conditions=mistri-built` (the dev form, `{ "mistri-built": <dist>, "default": <src> }`), so the packages
 * import each other's sources under tsx. None of src/ is in the package (`files`), so in node_modules each was an
 * instruction that fails. Each package's `prepack` runs this with `strip`, from the package's own folder, and its
 * `postpack` with `restore`, so the tarball's manifest has no `scripts`, every export names dist/, and the checkout's
 * is back as it was. A pack that dies between the two leaves the original beside it (BACKUP); the next strip
 * restores it before anything else, and it is gitignored, so it is never committed in place of the original.
 *
 * `strip` builds nothing: it refuses a package whose dist/ is missing, so run `npm run build` at the root first (one
 * build makes every package's dist; scripts/build-packages.mjs). Every package carries the repository's LICENSE, and
 * some carry files that live elsewhere in the checkout (`CARRIED`): the agent skill and the sample Apps in `mistri`
 * (packages/mistri/src/server/shipped.ts). `strip` copies them into the package for the tarball and `restore` removes
 * them.
 *
 * Only the tarball's copy changes. npm publish sends the registry the manifest it re-reads after `postpack`, so the
 * registry's metadata still lists the scripts; what an install unpacks, and what `npm test` there reads, does not.
 */
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** Fields that describe the checkout, not the package. */
export const CHECKOUT_ONLY = ['scripts', 'workspaces'];
/** The condition a checkout's exports name dist/ under. */
export const BUILT = 'mistri-built';

/* The license is the repository's, one file for every package. */
const EVERY = { LICENSE: 'LICENSE' };

/** What each package carries from elsewhere in the checkout: `path in the package → path in the checkout`. The App
    framework carries the agent skill and the sample Apps (packages/mistri/src/server/shipped.ts). Each package's
    README is its own file. */
export const CARRIED = {
  engine: EVERY,
  ui: EVERY,
  kit: EVERY,
  mistri: { ...EVERY, skills: 'skills', examples: 'examples' },
  'create-mistri': EVERY,
  cloudflare: EVERY,
  tablewalk: EVERY,
};

/** An export target as an install reads it: the dev form's built target in place of its source. */
export function builtTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return target;
  if (!(BUILT in target)) return Object.fromEntries(Object.entries(target).map(([key, value]) => [key, builtTarget(value)]));
  const { [BUILT]: built, default: _source, ...rest } = target;
  if (!Object.keys(rest).length) return built;
  return typeof built === 'string' ? { ...rest, default: built } : { ...rest, ...built };
}

/* Exports only a product's client build reads, in this checkout: the kit's client modules (`@mistriwork/kit`,
   `@mistriwork/kit/client/…`) are bundled into each product's dist/client by Vite from the kit's sources, and the
   kit's own dist holds none of them, so an install of the kit names only what it ships. */
const CLIENT_SOURCES = {
  '@mistriwork/kit': (subpath) => subpath === '.' || subpath.startsWith('./client/'),
  /* Each product's main, which the kit's page entry starts by name (`tablewalk/client/workbenchShell.js`,
     `@mistriwork/mistri/client/appShell.js`, shellStart.js) and Vite bundles into that product's dist/client. */
  '@mistriwork/mistri': (subpath) => subpath.startsWith('./client/'),
  tablewalk: (subpath) => subpath.startsWith('./client/'),
};

/**
 * @param {Record<string, any>} manifest
 * @returns {Record<string, any>}
 */
export function published(manifest) {
  const kept = Object.fromEntries(Object.entries(manifest).filter(([key]) => !CHECKOUT_ONLY.includes(key)));
  if (kept.exports) {
    kept.exports = builtTarget(kept.exports);
    const sourceOnly = CLIENT_SOURCES[manifest.name];
    if (sourceOnly) kept.exports = Object.fromEntries(Object.entries(kept.exports).filter(([subpath]) => !sourceOnly(subpath)));
  }
  return kept;
}

const files = (dir) => {
  const manifest = join(dir, 'package.json');
  return { manifest, backup: `${manifest}.pack-original`, carried: CARRIED[basename(dir)] ?? {} };
};

function restore(dir) {
  const { manifest, backup, carried } = files(dir);
  if (existsSync(backup)) renameSync(backup, manifest);
  for (const path of Object.keys(carried)) {
    rmSync(join(dir, path), { recursive: true, force: true });
    /* The folder a carried file went into (schema/) is the pack's too. */
    const parent = dirname(join(dir, path));
    if (parent !== dir && existsSync(parent) && !readdirSync(parent).length) rmdirSync(parent);
  }
}

function strip(dir) {
  restore(dir);
  const { manifest, backup, carried } = files(dir);
  const text = readFileSync(manifest, 'utf8');
  /* A package with no `exports` (create-mistri: a bin and nothing to import) has no dist/ to be missing. */
  if (JSON.parse(text).exports !== undefined && !existsSync(join(dir, 'dist')))
    throw new Error(`${dir} has no dist/: run \`npm run build\` at the workspace root first.`);
  for (const [path, from] of Object.entries(carried))
    cpSync(join(ROOT, from), join(dir, path), {
      recursive: true,
      /* A sample's local database and an App's own install are the checkout's, never the package's. */
      filter: (source) => !/(?:^|\/)node_modules(?:\/|$)|\.db(?:-wal|-shm|\.json)?$/.test(source),
    });
  writeFileSync(backup, text);
  writeFileSync(manifest, `${JSON.stringify(published(JSON.parse(text)), null, 2)}\n`);
}

const run = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const mode = run ? process.argv[2] : undefined;
if (mode === 'strip') strip(process.cwd());
else if (mode === 'restore') restore(process.cwd());
else if (run) {
  console.error('usage: node scripts/pack-manifest.mjs strip|restore (from a package folder, as its prepack and postpack)');
  process.exitCode = 1;
}
