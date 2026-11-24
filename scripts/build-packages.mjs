#!/usr/bin/env node
/**
 * Build every package under packages/ into its own dist/.
 *
 * The server, shared and adapter modules of every package compile as one tsc program (config/tsconfig.build.json), because
 * a declaration graph crosses packages — `@mistriwork/mistri/commands`'s types reach the engine's — and one program emits that
 * graph whole. The declarations come from config/tsconfig.commands.json: mistri's public entries, and the engine and the kit's
 * server modules whole, since tsc does not emit a file it reached through node_modules (a workspace link included) and
 * mistri's declarations import the engine by its package name. tsc writes the program under a stage, laid out as
 * packages/ is, and each package's share (`<stage>/<dir>/src/…`)
 * moves to `packages/<dir>/dist/…`. The kit's client is a third program (config/tsconfig.kit-client.json): its modules
 * one by one, with their declarations, and beside them the stylesheets, fonts and index.html they name, for a product
 * outside this repository to bundle with `@mistriwork/kit/vite` (an install names those on the host list,
 * scripts/pack-manifest.mjs). Then the files tsc does not make: ui's stylesheets, the
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
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { untypedExports } from './export-types.mjs';
import { published } from './pack-manifest.mjs';
import { sanitizeUiDistDts } from './self-contained-ui-dts.mjs';
import { PACKAGES } from './workspace.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STAGE = join(ROOT, 'node_modules/.cache/build-stage');
const KIT_STAGE = join(ROOT, 'node_modules/.cache/kit-client-stage');
const bin = (name) => join(ROOT, 'node_modules/.bin', name);
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
const node = (...args) => run(process.execPath, args);

rmSync(STAGE, { recursive: true, force: true });
rmSync(KIT_STAGE, { recursive: true, force: true });
for (const { dir } of PACKAGES) rmSync(join(ROOT, dir, 'dist'), { recursive: true, force: true });

/* The first program is checked: a build from a tag or a tarball has not run `npm test` first, and an emit that
   ignores a type error ships it. The second is the same sources again, emitting only declarations, so it is not
   checked twice (a declaration the checker could not name is still an emit error). */
run(bin('tsc'), ['-p', 'config/tsconfig.build.json']);
run(bin('tsc'), ['-p', 'config/tsconfig.commands.json', '--noCheck']);
for (const { dir } of PACKAGES) {
  const emitted = join(STAGE, dir.replace(/^packages\//, ''), 'src');
  if (!existsSync(emitted)) continue;
  mkdirSync(join(ROOT, dir, 'dist'), { recursive: true });
  for (const name of readdirSync(emitted)) cpSync(join(emitted, name), join(ROOT, dir, 'dist', name), { recursive: true });
}
rmSync(STAGE, { recursive: true, force: true });
/* The kit's client, emitted unchecked: the build program above does not hold it, and `npm test` checks it
   (test/check-client-types.mjs, tsconfig.json). Only the client moves: the stage's shared modules are the build's. */
run(bin('tsc'), ['-p', 'config/tsconfig.kit-client.json', '--noCheck']);
cpSync(join(KIT_STAGE, 'client'), join(ROOT, 'packages/kit/dist/client'), { recursive: true });
rmSync(KIT_STAGE, { recursive: true, force: true });
/* What the client's modules name that tsc does not write: stylesheets, fonts and their licenses, the page, and the
   declarations written by hand (a stylesheet import, the product's main). */
cpSync(join(ROOT, 'packages/kit/src/client'), join(ROOT, 'packages/kit/dist/client'), {
  recursive: true,
  filter: (source) => !/\.(?:[jt]sx?)$/.test(source) || source.endsWith('.d.ts'),
});
/* @mistriwork/ui's stylesheets are its own files, which tsc does not carry: copied as they are, with the sheets its
   entry points import beside them (styles/). */
for (const name of readdirSync(join(ROOT, 'packages/ui/src')))
  if (name.endsWith('.css')) cpSync(join(ROOT, 'packages/ui/src', name), join(ROOT, 'packages/ui/dist', name));
cpSync(join(ROOT, 'packages/ui/src/styles'), join(ROOT, 'packages/ui/dist/styles'), { recursive: true });
/* The behaviors' declarations are written by hand. UI SDK does not export the type a primitive's slots are inferred
   as, so tsc cannot write a primitive's declaration in a form another package can read (TS2883), and the parts are
   typed from the primitives. The parts are declared once, for an App's components
   (packages/mistri/schema/behaviors.d.ts, held to the source by packages/mistri's SDK tests); @mistriwork/ui's own
   entry adds what only it exports: the primitives, as UI SDK's own `Primitive`, their option types, which are the
   roots' props without the element's own, `createParts` and the zoom helper. */
const BEHAVIOR_PRIMITIVES = ['days', 'editable', 'pick', 'scrub', 'sortable', 'spans', 'transfer', 'turns', 'widths'];
const titled = (name) => name[0].toUpperCase() + name.slice(1);
writeFileSync(
  join(ROOT, 'packages/ui/dist/behaviors/index.d.ts'),
  `${readFileSync(join(ROOT, 'packages/mistri/schema/behaviors.d.ts'), 'utf8')}
import type { Primitive } from '@ui-sdk/core';
export { createParts } from '@ui-sdk/react/primitive';
/** How much the page is zoomed where an element stands. */
export declare function zoomOf(el: HTMLElement): number;
export type SortableOrientation = 'vertical' | 'horizontal' | 'grid';
export type SpansChange = Change<SpansReason, { id: string; action: SpanAction }>;
${BEHAVIOR_PRIMITIVES.map(
  (name) => `export declare const ${name}: Primitive;\nexport type ${titled(name)}Options = Record<string, unknown>;`,
).join('\n')}
`,
);
sanitizeUiDistDts(join(ROOT, 'packages/ui/dist'));

node('scripts/package-docs.mjs');
node('--conditions=mistri-built', 'scripts/package-console.mjs');
for (const args of [
  ['-c', 'config/vite.mistri.config.ts'],
  ['-c', 'config/vite.ui.config.ts'],
  ['-c', 'config/vite.observe.config.ts'],
  ['-c', 'config/vite.embed.config.ts'],
  /* After the embed build, which empties dist/embed: @mistriwork/mistri/react/headless is built apart (the config says why). */
  ['-c', 'config/vite.embed.config.ts', '--mode', 'headless'],
  ['-c', 'config/vite.ssr.config.ts'],
])
  run(bin('vite'), ['build', ...args]);

const expected = [
  'packages/ui/dist/index.js',
  'packages/ui/dist/index.d.ts',
  'packages/ui/dist/style.css',
  'packages/kit/dist/client/app.js',
  'packages/kit/dist/client/app.d.ts',
  'packages/kit/dist/client/boot.js',
  'packages/kit/dist/client/index.html',
  'packages/kit/dist/client/style.css',
  'packages/kit/dist/client/shellMain.d.ts',
  'packages/kit/dist/vite.js',
  'packages/cloudflare/dist/index.js',
  'packages/cloudflare/dist/index.d.ts',
  'packages/cloudflare/dist/hostCertificates.js',
  'packages/cloudflare/dist/hostCertificates.d.ts',
  'packages/mistri/dist/client/index.html',
  'packages/mistri/dist/client/index.public.html',
  'packages/mistri/dist/ssr/render.js',
  'packages/mistri/dist/ui/index.js',
  'packages/mistri/dist/observe/observe/index.html',
  'packages/mistri/dist/embed/react/index.js',
  'packages/mistri/dist/embed/react/headless.js',
  'packages/mistri/dist/server/index.js',
];
const missing = expected.filter((file) => !existsSync(join(ROOT, file)));
if (missing.length) {
  console.error(`build-packages: the build did not write ${missing.join(', ')}.`);
  process.exit(1);
}
/* Every module an install can import has its types (scripts/export-types.mjs says the rule, and why). */
const untyped = PACKAGES.flatMap(({ dir }) =>
  untypedExports(join(ROOT, dir), published(JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'))).exports).map(
    (missing) => `${dir}: ${missing}`,
  ),
);
if (untyped.length) {
  console.error(`build-packages: these exports have no declarations:\n  ${untyped.join('\n  ')}`);
  process.exit(1);
}
