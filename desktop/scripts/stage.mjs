/**
 * Assemble the server half of the bundle.
 *
 * electron-builder packs this directory; it cannot pack the root project,
 * because the root's node_modules holds tsx, typescript and esbuild — a build
 * toolchain that has no business in a shipped app and is larger than the app.
 *
 * So the runtime half is staged here first, laid out as `npm install tablewalk`
 * leaves it: the database browser and the workspace packages it depends on —
 * never the App framework, `mistri`, which the app does not run — under
 * node_modules as each tarball would unpack (scripts/install-packages.mjs: published manifest, dist/), and a
 * production-only install of what those packages need from the registry,
 * resolved from their own version ranges. Listing pg's dependency tree by
 * hand in electron-builder's config was the alternative, and it is wrong the
 * first time pg gains a dependency.
 *
 * One quirk this pairs with, since package.json cannot hold a comment:
 * `extraResources` in that file has *two* entries pointing into this
 * directory, and the second is not redundant. electron-builder excludes
 * node_modules from an extraResources copy no matter what filter you give it,
 * and naming node_modules as its own `from` is what gets it in. Without the
 * second entry the build succeeds and ships an app where SQLite works and
 * Postgres fails at the first connection — which is why it was worth finding
 * before shipping rather than after.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedWith, installPackages } from '../../scripts/install-packages.mjs';
import { PACKAGES } from '../../scripts/workspace.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(HERE, '..');
const ROOT = join(DESKTOP, '..');
const STAGE = join(DESKTOP, 'build', 'server');

const root = JSON.parse(readFileSync(join(ROOT, 'packages', 'tablewalk', 'package.json'), 'utf8'));

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

// The app version is the package's version. electron-builder reads this
// dir's package.json, not the root's, so without syncing it a 0.0.2 release
// would ship a desktop app that still calls itself whatever was hardcoded
// here. One source of truth: the tablewalk package's manifest.
const desktopPkgPath = join(DESKTOP, 'package.json');
const desktopPkg = JSON.parse(readFileSync(desktopPkgPath, 'utf8'));
if (desktopPkg.version !== root.version) {
  desktopPkg.version = root.version;
  writeFileSync(desktopPkgPath, `${JSON.stringify(desktopPkg, null, 2)}\n`);
  console.log(`stage: synced desktop version to ${root.version}`);
}

console.log('stage: building the server');
run('npm', ['run', 'build'], ROOT);

console.log(`stage: ${STAGE}`);
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

/* What the workspace packages need from the registry, from their own
   manifests, so there is one place that decides which pg is shipped. The
   packages themselves are copied in after the install, which would prune
   them as extraneous. */
const ours = new Set(PACKAGES.map(({ name }) => name));
/** The desktop app is the database browser: tablewalk and what an install of it brings. */
const shipped = installedWith('tablewalk');
const dependencies = {};
for (const { name, dir } of PACKAGES) {
  if (!shipped.has(name)) continue;
  const manifest = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
  for (const [name, range] of Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies }))
    if (!ours.has(name)) dependencies[name] = range;
}
writeFileSync(
  join(STAGE, 'package.json'),
  `${JSON.stringify(
    {
      name: 'tablewalk-server',
      version: root.version,
      private: true,
      type: 'module',
      dependencies,
    },
    null,
    2,
  )}\n`,
);

console.log('stage: installing runtime dependencies');
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'], STAGE);
installPackages(join(STAGE, 'node_modules'), { only: shipped });

console.log('stage: done');
