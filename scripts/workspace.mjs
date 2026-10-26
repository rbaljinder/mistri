/**
 * The workspace's packages, for the checks and scripts that read the sources.
 *
 * Each package under packages/ owns its sources, laid out as the one tree was: `packages/<dir>/src/client/…`,
 * `packages/<dir>/src/server/…`, `packages/<dir>/src/shared/…`. A check that used to walk `src/client` walks the
 * same folder in every package, and keeps reading paths as the one tree spelled them (`components/Grid.tsx`), because
 * the folders inside a package are the folders the tree had. The packages are the ones scripts/boundary/entries.json
 * names, in the order the layers stand on each other.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** `{ name, dir, layer }` for each package, `dir` relative to the root (`packages/kit`). */
export const PACKAGES = Object.entries(JSON.parse(readFileSync(join(ROOT, 'scripts/boundary/entries.json'), 'utf8')).packages).map(
  ([name, { dir, layer }]) => ({ name, dir, layer }),
);

/** The package a repository path is in, or undefined. */
export const packageOf = (file) => PACKAGES.find(({ dir }) => file === dir || file.startsWith(`${dir}/`));

/** The folders `packages/<dir>/<sub>` that exist, as absolute paths. */
export function packageFolders(sub, root = ROOT) {
  return PACKAGES.map(({ dir }) => join(root, dir, sub)).filter((path) => existsSync(path));
}

/**
 * Every file under `packages/<dir>/<sub>`, in every package: `path` absolute, `rel` relative to its own `<sub>` (the
 * path the one tree gave it under `<sub>`), `repo` relative to the root, and the package it is in.
 */
export function treeFiles(sub, { recursive = true, root = ROOT } = {}) {
  const out = [];
  for (const pkg of PACKAGES) {
    const base = join(root, pkg.dir, sub);
    if (!existsSync(base)) continue;
    const walk = (dir) => {
      for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (recursive) walk(path);
        } else out.push({ path, rel: relative(base, path).split('\\').join('/'), repo: relative(root, path).split('\\').join('/'), pkg });
      }
    };
    walk(base);
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}
