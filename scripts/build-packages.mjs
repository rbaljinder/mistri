#!/usr/bin/env node
/**
 * Build every package under packages/ into its own dist/.
 *
 * The server, shared and adapter modules of every package compile as one tsc program (tsconfig.build.json), because
 * a declaration graph crosses packages — `@mistriwork/mistri/commands`'s types reach the engine's — and one program emits that
 * graph whole. The declarations come from tsconfig.commands.json: mistri's public entries, and the engine and the kit's
 * server modules whole, since tsc does not emit a file it reached through node_modules (a workspace link included) and
 * mistri's declarations import the engine by its package name. tsc writes the program under a stage, laid out as
 * packages/ is, and each package's share (`<stage>/<dir>/src/…`)
 * moves to `packages/<dir>/dist/…`. Then the files tsc does not make: ui's stylesheets, the
 * docs and the Console rooms mistri ships, the kit's page as each product serves it (`vite build -c vite.<product>.config.ts`, into that product's
 * dist/client), and
 * mistri's bundles (@mistriwork/mistri/ui, @mistriwork/mistri/react, the observability page, the server renderer).
 *
 * The built modules import each other by package name (`@mistriwork/engine/shared/page.js`). An install resolves those
 * to the package's dist; in this checkout each package's `exports` answers from source unless Node is started with
 * `--conditions=mistri-built`, which is how anything here runs what this writes (package-console below, the built
 * browser checks). A package's own `npm run build` runs this whole build: the program is one, so a package's dist is
 * only right beside the others'.
 *
 *   node scripts/build-packages.mjs
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { published } from './pack-manifest.mjs';
import { PACKAGES } from './workspace.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STAGE = join(ROOT, 'node_modules/.cache/build-stage');
const bin = (name) => join(ROOT, 'node_modules/.bin', name);
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
const node = (...args) => run(process.execPath, args);

rmSync(STAGE, { recursive: true, force: true });
for (const { dir } of PACKAGES) rmSync(join(ROOT, dir, 'dist'), { recursive: true, force: true });

run(bin('tsc'), ['-p', 'tsconfig.build.json', '--noCheck']);
run(bin('tsc'), ['-p', 'tsconfig.commands.json', '--noCheck']);
for (const { dir } of PACKAGES) {
  const emitted = join(STAGE, dir.replace(/^packages\//, ''), 'src');
  if (!existsSync(emitted)) continue;
  mkdirSync(join(ROOT, dir, 'dist'), { recursive: true });
  for (const name of readdirSync(emitted)) cpSync(join(emitted, name), join(ROOT, dir, 'dist', name), { recursive: true });
}
rmSync(STAGE, { recursive: true, force: true });
/* @mistriwork/ui's stylesheets are its own files, which tsc does not carry: copied as they are. */
for (const name of readdirSync(join(ROOT, 'packages/ui/src')))
  if (name.endsWith('.css')) cpSync(join(ROOT, 'packages/ui/src', name), join(ROOT, 'packages/ui/dist', name));

node('scripts/package-docs.mjs');
node('--conditions=mistri-built', 'scripts/package-console.mjs');
for (const config of [
  'vite.tablewalk.config.ts',
  'vite.mistri.config.ts',
  'vite.ui.config.ts',
  'vite.observe.config.ts',
  'vite.embed.config.ts',
  'vite.ssr.config.ts',
])
  run(bin('vite'), ['build', '-c', config]);

const expected = [
  'packages/ui/dist/index.js',
  'packages/ui/dist/index.d.ts',
  'packages/ui/dist/style.css',
  'packages/cloudflare/dist/index.js',
  'packages/cloudflare/dist/index.d.ts',
  'packages/tablewalk/dist/client/index.workbench.html',
  'packages/mistri/dist/client/index.html',
  'packages/mistri/dist/client/index.public.html',
  'packages/mistri/dist/ssr/render.js',
  'packages/mistri/dist/ui/index.js',
  'packages/mistri/dist/observe/observe/index.html',
  'packages/mistri/dist/embed/react/index.js',
  'packages/mistri/dist/server/index.js',
  'packages/tablewalk/dist/server/index.js',
];
const missing = expected.filter((file) => !existsSync(join(ROOT, file)));
if (missing.length) {
  console.error(`build-packages: the build did not write ${missing.join(', ')}.`);
  process.exit(1);
}
/* Every module an install can import has its types: an export with no `types` condition is typed by the .d.ts beside
   its .js, and without one a consumer's tsc reads the module as `any` and refuses every declaration that imports it
   (TS7016). The engine shipped that way once, its declarations never emitted, and only an installed typecheck saw it. */
const untyped = PACKAGES.flatMap(({ dir }) => {
  const { exports = {} } = published(JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')));
  const targets = (target) =>
    typeof target === 'string'
      ? [target]
      : target && typeof target === 'object' && !('types' in target)
        ? Object.values(target).flatMap(targets)
        : [];
  return Object.values(exports)
    .flatMap(targets)
    .filter((target) => target.endsWith('.js') && !existsSync(join(ROOT, dir, target.replace(/\.js$/, '.d.ts'))))
    .map((target) => `${dir}/${target.slice(2)}`);
});
if (untyped.length) {
  console.error(`build-packages: these exports have no declarations: ${untyped.join(', ')}.`);
  process.exit(1);
}
